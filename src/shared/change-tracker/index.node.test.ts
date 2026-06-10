/** biome-ignore-all lint/performance/noDelete: ignore */
import { describe, expect, test } from 'vitest';
import type { CustomTypeConfig, Patch } from './index';
import { createRecorder, recordTransaction, replay } from './index';

// ─── recordTransaction ──────────────────────────────────

describe('recordTransaction', () => {
  test('导出测试', () => {
    expect(recordTransaction).toBeTypeOf('function');
  });

  test('基础 set 操作', () => {
    const state = { name: 'init' };
    const patches = recordTransaction(state, (draft) => {
      draft.name = 'Alice';
    });

    expect(patches).toHaveLength(1);
    expect(patches[0].op).toBe('set');
    expect(patches[0].path).toEqual(['name']);
    expect(patches[0].value).toBe('Alice');
    expect(patches[0].timestamp).toBeTypeOf('number');
  });

  test('baseObject 不被修改', () => {
    const state = { user: { name: 'init' }, count: 0 };
    const original = JSON.parse(JSON.stringify(state));

    recordTransaction(state, (draft) => {
      draft.user.name = 'Bob';
      draft.count = 42;
    });

    expect(state).toEqual(original);
  });

  test('嵌套对象 set', () => {
    const state = { user: { profile: { age: 20 } } };
    const patches = recordTransaction(state, (draft) => {
      draft.user.profile.age = 30;
    });

    expect(patches).toHaveLength(1);
    expect(patches[0].path).toEqual(['user', 'profile', 'age']);
    expect(patches[0].value).toBe(30);
  });

  test('delete 操作', () => {
    const state = { name: 'Alice', age: 20 } as Record<string, unknown>;
    const patches = recordTransaction(state, (draft) => {
      delete draft.age;
    });

    expect(patches).toHaveLength(1);
    expect(patches[0].op).toBe('delete');
    expect(patches[0].path).toEqual(['age']);
  });

  test('数组 push 合并为 splice', () => {
    const state = { tags: ['a'] };
    const patches = recordTransaction(state, (draft) => {
      draft.tags.push('b', 'c');
    });

    expect(patches).toHaveLength(1);
    expect(patches[0].op).toBe('splice');
    expect(patches[0].path).toEqual(['tags']);
    expect(patches[0].index).toBe(1);
    expect(patches[0].deleteCount).toBe(0);
    expect(patches[0].items).toEqual(['b', 'c']);
  });

  test('数组 pop 合并为 splice', () => {
    const state = { tags: ['a', 'b', 'c'] };
    const patches = recordTransaction(state, (draft) => {
      draft.tags.pop();
    });

    expect(patches).toHaveLength(1);
    expect(patches[0].op).toBe('splice');
    expect(patches[0].index).toBe(2);
    expect(patches[0].deleteCount).toBe(1);
    expect(patches[0].items).toEqual([]);
  });

  test('数组 shift 合并为 splice', () => {
    const state = { tags: ['a', 'b'] };
    const patches = recordTransaction(state, (draft) => {
      draft.tags.shift();
    });

    expect(patches).toHaveLength(1);
    expect(patches[0].op).toBe('splice');
    expect(patches[0].index).toBe(0);
    expect(patches[0].deleteCount).toBe(1);
  });

  test('数组 unshift 合并为 splice', () => {
    const state = { tags: ['b'] };
    const patches = recordTransaction(state, (draft) => {
      draft.tags.unshift('a');
    });

    expect(patches).toHaveLength(1);
    expect(patches[0].op).toBe('splice');
    expect(patches[0].index).toBe(0);
    expect(patches[0].deleteCount).toBe(0);
    expect(patches[0].items).toEqual(['a']);
  });

  test('数组 splice 直接调用', () => {
    const state = { tags: ['a', 'b', 'c'] };
    const patches = recordTransaction(state, (draft) => {
      draft.tags.splice(1, 1, 'x', 'y');
    });

    expect(patches).toHaveLength(1);
    expect(patches[0].op).toBe('splice');
    expect(patches[0].index).toBe(1);
    expect(patches[0].deleteCount).toBe(1);
    expect(patches[0].items).toEqual(['x', 'y']);
  });

  test('空数组 pop 不产生 patch', () => {
    const state = { tags: [] as string[] };
    const patches = recordTransaction(state, (draft) => {
      draft.tags.pop();
    });

    expect(patches).toHaveLength(0);
  });

  test('空数组 shift 不产生 patch', () => {
    const state = { tags: [] as string[] };
    const patches = recordTransaction(state, (draft) => {
      draft.tags.shift();
    });

    expect(patches).toHaveLength(0);
  });

  test('自定义类型序列化', () => {
    const dateType: CustomTypeConfig<Date> = {
      type: 'Date',
      is: (value): value is Date => value instanceof Date,
      serialize: (value) => value.toISOString(),
      deserialize: (raw) => new Date(raw as string),
    };

    const state = { createdAt: new Date('2025-01-01') };
    const patches = recordTransaction(
      state,
      (draft) => {
        draft.createdAt = new Date('2026-06-10');
      },
      { types: [dateType] },
    );

    expect(patches).toHaveLength(1);
    expect(patches[0].type).toBe('Date');
    expect(patches[0].value).toBe('2026-06-10T00:00:00.000Z');
  });

  test('自定义类型在数组 push 中序列化', () => {
    const dateType: CustomTypeConfig<Date> = {
      type: 'Date',
      is: (value): value is Date => value instanceof Date,
      serialize: (value) => value.toISOString(),
      deserialize: (raw) => new Date(raw as string),
    };

    const state = { dates: [] as Date[] };
    const patches = recordTransaction(
      state,
      (draft) => {
        draft.dates.push(new Date('2026-01-01'));
      },
      { types: [dateType] },
    );

    expect(patches).toHaveLength(1);
    expect(patches[0].items).toEqual(['2026-01-01T00:00:00.000Z']);
  });

  test('多个操作产生多个 patch', () => {
    const state = { name: 'init', count: 0, tags: ['a'] };
    const patches = recordTransaction(state, (draft) => {
      draft.name = 'Alice';
      draft.count = 10;
      draft.tags.push('b');
    });

    expect(patches).toHaveLength(3);
    expect(patches[0].op).toBe('set');
    expect(patches[1].op).toBe('set');
    expect(patches[2].op).toBe('splice');
  });

  test('splice 负数索引处理', () => {
    const state = { tags: ['a', 'b', 'c'] };
    const patches = recordTransaction(state, (draft) => {
      draft.tags.splice(-1, 1);
    });

    expect(patches).toHaveLength(1);
    expect(patches[0].index).toBe(2);
    expect(patches[0].deleteCount).toBe(1);
  });
});

// ─── createRecorder ──────────────────────────────────────

describe('createRecorder', () => {
  test('导出测试', () => {
    expect(createRecorder).toBeTypeOf('function');
  });

  test('proxy 操作记录', () => {
    const recorder = createRecorder({ name: 'init', tags: ['a'] });

    recorder.proxy.name = 'Bob';
    recorder.proxy.tags.push('b');

    const patches = recorder.flush();
    expect(patches).toHaveLength(2);
    expect(patches[0].op).toBe('set');
    expect(patches[0].value).toBe('Bob');
    expect(patches[1].op).toBe('splice');

    recorder.dispose();
  });

  test('flush 清空缓冲区', () => {
    const recorder = createRecorder({ count: 0 });

    recorder.proxy.count = 1;
    const first = recorder.flush();
    expect(first).toHaveLength(1);

    const second = recorder.flush();
    expect(second).toHaveLength(0);

    recorder.dispose();
  });

  test('flush 后继续记录', () => {
    const recorder = createRecorder({ count: 0 });

    recorder.proxy.count = 1;
    recorder.flush();

    recorder.proxy.count = 2;
    const patches = recorder.flush();
    expect(patches).toHaveLength(1);
    expect(patches[0].value).toBe(2);

    recorder.dispose();
  });

  test('dispose 后操作 proxy 报错', () => {
    const recorder = createRecorder({ name: 'init' });
    recorder.dispose();

    expect(() => {
      recorder.proxy.name = 'fail';
    }).toThrow(/disposed/u);
  });

  test('dispose 后读取 proxy 报错', () => {
    const recorder = createRecorder({ name: 'init' });
    recorder.dispose();

    expect(() => {
      const _ = recorder.proxy.name;
    }).toThrow(/disposed/u);
  });

  test('dispose 后 flush 报错', () => {
    const recorder = createRecorder({ name: 'init' });
    recorder.dispose();

    expect(() => {
      recorder.flush();
    }).toThrow(/disposed/u);
  });

  test('createRecorder 直接修改 baseObject', () => {
    const state = { name: 'init' };
    const recorder = createRecorder(state);

    recorder.proxy.name = 'changed';
    expect(state.name).toBe('changed');

    recorder.dispose();
  });

  test('嵌套对象操作', () => {
    const recorder = createRecorder({ user: { profile: { age: 20 } } });

    recorder.proxy.user.profile.age = 30;

    const patches = recorder.flush();
    expect(patches).toHaveLength(1);
    expect(patches[0].path).toEqual(['user', 'profile', 'age']);
    expect(patches[0].value).toBe(30);

    recorder.dispose();
  });
});

// ─── replay ──────────────────────────────────────────────

describe('replay', () => {
  test('导出测试', () => {
    expect(replay).toBeTypeOf('function');
  });

  test('基础 set 重放', () => {
    const base = { name: 'init', count: 0 };
    const patches: Patch[] = [
      { path: ['name'], op: 'set', value: 'Alice', timestamp: 1 },
      { path: ['count'], op: 'set', value: 42, timestamp: 2 },
    ];

    const result = replay(base, patches);
    expect(result.name).toBe('Alice');
    expect(result.count).toBe(42);
  });

  test('mutate: false 不修改原对象', () => {
    const base = { name: 'init' };
    const patches: Patch[] = [{ path: ['name'], op: 'set', value: 'Alice', timestamp: 1 }];

    const result = replay(base, patches);
    expect(result.name).toBe('Alice');
    expect(base.name).toBe('init');
    expect(result).not.toBe(base);
  });

  test('mutate: true 原地修改', () => {
    const base = { name: 'init' };
    const patches: Patch[] = [{ path: ['name'], op: 'set', value: 'Alice', timestamp: 1 }];

    const result = replay(base, patches, { mutate: true });
    expect(result.name).toBe('Alice');
    expect(base.name).toBe('Alice');
    expect(result).toBe(base);
  });

  test('delete 重放', () => {
    const base = { name: 'Alice', age: 20 } as Record<string, unknown>;
    const patches: Patch[] = [{ path: ['age'], op: 'delete', timestamp: 1 }];

    const result = replay(base, patches);
    expect('age' in result).toBe(false);
    expect(result.name).toBe('Alice');
  });

  test('splice 重放（插入）', () => {
    const base = { tags: ['a'] };
    const patches: Patch[] = [
      { path: ['tags'], op: 'splice', index: 1, deleteCount: 0, items: ['b', 'c'], timestamp: 1 },
    ];

    const result = replay(base, patches);
    expect(result.tags).toEqual(['a', 'b', 'c']);
  });

  test('splice 重放（删除）', () => {
    const base = { tags: ['a', 'b', 'c'] };
    const patches: Patch[] = [{ path: ['tags'], op: 'splice', index: 1, deleteCount: 1, items: [], timestamp: 1 }];

    const result = replay(base, patches);
    expect(result.tags).toEqual(['a', 'c']);
  });

  test('splice 重放（替换）', () => {
    const base = { tags: ['a', 'b', 'c'] };
    const patches: Patch[] = [
      { path: ['tags'], op: 'splice', index: 1, deleteCount: 1, items: ['x', 'y'], timestamp: 1 },
    ];

    const result = replay(base, patches);
    expect(result.tags).toEqual(['a', 'x', 'y', 'c']);
  });

  test('嵌套路径重放', () => {
    const base = { user: { profile: { age: 20 } } };
    const patches: Patch[] = [{ path: ['user', 'profile', 'age'], op: 'set', value: 30, timestamp: 1 }];

    const result = replay(base, patches);
    expect(result.user.profile.age).toBe(30);
  });

  test('按 timestamp 升序应用', () => {
    const base = { name: 'init' };
    const patches: Patch[] = [
      { path: ['name'], op: 'set', value: 'second', timestamp: 20 },
      { path: ['name'], op: 'set', value: 'first', timestamp: 10 },
      { path: ['name'], op: 'set', value: 'third', timestamp: 30 },
    ];

    const result = replay(base, patches);
    expect(result.name).toBe('third');
  });

  test('相同 timestamp 保持数组顺序', () => {
    const base = { count: 0 };
    const patches: Patch[] = [
      { path: ['count'], op: 'set', value: 1, timestamp: 1 },
      { path: ['count'], op: 'set', value: 2, timestamp: 1 },
      { path: ['count'], op: 'set', value: 3, timestamp: 1 },
    ];

    const result = replay(base, patches);
    expect(result.count).toBe(3);
  });

  test('自定义类型反序列化', () => {
    const dateType: CustomTypeConfig<Date> = {
      type: 'Date',
      is: (value): value is Date => value instanceof Date,
      serialize: (value) => value.toISOString(),
      deserialize: (raw) => new Date(raw as string),
    };

    const base = { createdAt: new Date('2025-01-01') };
    const patches: Patch[] = [
      { path: ['createdAt'], op: 'set', value: '2026-06-10T00:00:00.000Z', type: 'Date', timestamp: 1 },
    ];

    const result = replay(base, patches, { types: [dateType] });
    expect(result.createdAt).toBeInstanceOf(Date);
    expect(result.createdAt.toISOString()).toBe('2026-06-10T00:00:00.000Z');
  });

  test('空 patch 列表返回拷贝', () => {
    const base = { name: 'init' };
    const result = replay(base, []);
    expect(result).toEqual(base);
    expect(result).not.toBe(base);
  });

  test('空路径 patch 报错', () => {
    const base = { name: 'init' };
    const patches: Patch[] = [{ path: [], op: 'set', value: 'fail', timestamp: 1 }];

    expect(() => replay(base, patches)).toThrow(/empty/u);
  });

  test('splice 到非数组目标报错', () => {
    const base = { name: 'init' };
    const patches: Patch[] = [{ path: ['name'], op: 'splice', index: 0, deleteCount: 0, items: ['x'], timestamp: 1 }];

    expect(() => replay(base, patches)).toThrow(/not an array/u);
  });
});

// ─── 防御分支覆盖 ────────────────────────────────────────

describe('防御分支', () => {
  // helpers.ts: serializeValue 有 types 但无匹配 config
  test('serializeValue — types 存在但无 config 命中时 value 透传', () => {
    const stringType: CustomTypeConfig<string> = {
      type: 'StringWrap',
      is: (v): v is string => typeof v === 'string',
      serialize: (v) => `wrapped:${v}`,
      deserialize: (raw) => (raw as string).replace('wrapped:', ''),
    };

    const state = { count: 42 };
    const patches = recordTransaction(
      state,
      (draft) => {
        // 数字不匹配 stringType，走 fallthrough
        draft.count = 100;
      },
      { types: [stringType] },
    );

    expect(patches[0].value).toBe(100);
    expect(patches[0].type).toBeUndefined();
  });

  // proxy-engine.ts: symbol prop 在 get/set/delete trap 中直接透传
  test('proxy — symbol 属性 get/set/delete 透传', () => {
    const sym = Symbol('test');
    const state = { [sym]: 'hello' } as Record<symbol | string, unknown>;

    const patches = recordTransaction(state, (draft) => {
      // symbol get — 不产生 patch
      const _ = draft[sym];
      // symbol set — 不产生 patch
      draft[sym] = 'world';
      // symbol delete — 不产生 patch
      delete draft[sym];
    });

    // symbol 操作不记录 patch
    expect(patches).toHaveLength(0);
  });

  // proxy-engine.ts: array length set 透传
  test('proxy — 数组 length 赋值透传', () => {
    const state = { items: [1, 2, 3] };
    const patches = recordTransaction(state, (draft) => {
      draft.items.length = 1;
    });

    // length 设置直接透传，不产生 set patch
    expect(patches.filter((p) => p.op === 'set')).toHaveLength(0);
  });

  // record.ts: disposed 后 deleteProperty 报错
  test('createRecorder — disposed 后 delete 操作报错', () => {
    const state = { name: 'init', age: 20 } as Record<string, unknown>;
    const recorder = createRecorder(state);
    recorder.dispose();

    expect(() => {
      delete recorder.proxy.age;
    }).toThrow(/disposed/u);
  });

  // replay.ts: resolvePathParent 路径中间值不是对象
  test('replay — 路径中间值非对象时报错', () => {
    const base = { name: 'hello' };
    const patches: Patch[] = [{ path: ['name', 'nested', 'deep'], op: 'set', value: 'fail', timestamp: 1 }];

    expect(() => replay(base, patches)).toThrow(/not an object/u);
  });

  // replay.ts: resolvePathParent parent 不是对象（单层 path 但 root 上某值非对象）
  test('replay — parent 不可达时报错', () => {
    const base = { a: 'string-value' } as Record<string, unknown>;
    const patches: Patch[] = [{ path: ['a', 'b'], op: 'set', value: 'fail', timestamp: 1 }];

    expect(() => replay(base, patches)).toThrow(/not an object/u);
  });

  // replay.ts: deserializeValue 中 typeName 存在但 typeMap 中无对应 config
  test('replay — 未知 type 名称时 value 透传不反序列化', () => {
    const base = { value: null as unknown };
    const patches: Patch[] = [{ path: ['value'], op: 'set', value: 'raw-data', type: 'UnknownType', timestamp: 1 }];

    const result = replay(base, patches);
    // 未知类型不反序列化，直接使用原始 value
    expect(result.value).toBe('raw-data');
  });

  // replay.ts: applyPatch switch default 分支（未知 op）
  test('replay — 未知 op 类型静默跳过', () => {
    const base = { name: 'init' };
    const patches: Patch[] = [{ path: ['name'], op: 'unknown-op' as Patch['op'], value: 'fail', timestamp: 1 }];

    // 不报错，静默忽略
    const result = replay(base, patches);
    expect(result.name).toBe('init');
  });

  // replay.ts: splice patch.items 为 undefined 时使用空数组
  test('replay — splice patch 无 items 字段时使用空数组', () => {
    const base = { tags: ['a', 'b', 'c'] };
    const patches: Patch[] = [{ path: ['tags'], op: 'splice', index: 1, deleteCount: 1, timestamp: 1 }];

    const result = replay(base, patches);
    expect(result.tags).toEqual(['a', 'c']);
  });

  // proxy-engine.ts: splice 不传 deleteCount（undefined 分支）
  test('proxy — splice 只传 start 不传 deleteCount', () => {
    const state = { items: ['a', 'b', 'c'] };
    const patches = recordTransaction(state, (draft) => {
      draft.items.splice(1);
    });

    expect(patches).toHaveLength(1);
    expect(patches[0].index).toBe(1);
  });

  // proxy-engine.ts: 数组元素按索引 set
  test('proxy — 数组元素按索引赋值记录 number path', () => {
    const state = { items: [10, 20, 30] };
    const patches = recordTransaction(state, (draft) => {
      draft.items[1] = 99;
    });

    expect(patches).toHaveLength(1);
    expect(patches[0].path).toEqual(['items', 1]);
    expect(patches[0].value).toBe(99);
  });

  // proxy-engine.ts: 数组元素按索引 delete
  test('proxy — 数组元素按索引 delete 记录 number path', () => {
    const state = { items: [10, 20, 30] };
    const patches = recordTransaction(state, (draft) => {
      delete (draft.items as unknown as Record<number, unknown>)[1];
    });

    expect(patches).toHaveLength(1);
    expect(patches[0].op).toBe('delete');
    expect(patches[0].path).toEqual(['items', 1]);
  });

  // proxy-engine.ts: 读取原始值属性（非对象、非数组变异方法）
  test('proxy — 读取原始值属性不创建子代理', () => {
    const state = { count: 42, flag: true, label: 'hello' };
    const patches = recordTransaction(state, (draft) => {
      // 读取原始值 — 不产生 patch
      const _ = draft.count;
      const __ = draft.flag;
      const ___ = draft.label;
    });

    expect(patches).toHaveLength(0);
  });

  // record.ts: createRecorder 正常 deleteProperty（非 disposed）
  test('createRecorder — 正常 delete 操作记录 patch', () => {
    const state = { name: 'init', age: 20 } as Record<string, unknown>;
    const recorder = createRecorder(state);

    delete recorder.proxy.age;

    const patches = recorder.flush();
    expect(patches).toHaveLength(1);
    expect(patches[0].op).toBe('delete');
    expect(patches[0].path).toEqual(['age']);

    recorder.dispose();
  });

  // proxy-engine.ts: 数组内嵌套对象的属性访问（get trap 中 Array.isArray childPath 分支）
  test('proxy — 数组内嵌套对象属性访问使用数字索引路径', () => {
    const state = { items: [{ name: 'a' }, { name: 'b' }] };
    const patches = recordTransaction(state, (draft) => {
      draft.items[0].name = 'changed';
    });

    expect(patches).toHaveLength(1);
    expect(patches[0].path).toEqual(['items', 0, 'name']);
    expect(patches[0].value).toBe('changed');
  });

  // helpers.ts: serializeItems 有 types 且 items 中有匹配 + 不匹配项混合
  test('serializeItems — types 存在时混合类型 items 序列化', () => {
    const dateType: CustomTypeConfig<Date> = {
      type: 'Date',
      is: (value): value is Date => value instanceof Date,
      serialize: (value) => value.toISOString(),
      deserialize: (raw) => new Date(raw as string),
    };

    const state = { mixed: [] as unknown[] };
    const patches = recordTransaction(
      state,
      (draft) => {
        draft.mixed.push(new Date('2026-01-01'), 'plain-string', 42);
      },
      { types: [dateType] },
    );

    expect(patches).toHaveLength(1);
    expect(patches[0].type).toBe('Date');
    // Date 被序列化，其他值透传
    expect(patches[0].items).toEqual(['2026-01-01T00:00:00.000Z', 'plain-string', 42]);
  });

  // replay.ts: splice patch 中 index 和 deleteCount 为 undefined 时走 ?? 0 分支
  test('replay — splice patch 缺少 index 和 deleteCount 时使用默认值 0', () => {
    const base = { tags: ['a', 'b', 'c'] };
    const patches: Patch[] = [{ path: ['tags'], op: 'splice', items: ['x'], timestamp: 1 }];

    const result = replay(base, patches);
    // index ?? 0 → 0, deleteCount ?? 0 → 0, 在位置0插入'x'
    expect(result.tags).toEqual(['x', 'a', 'b', 'c']);
  });

  // replay.ts: splice items 中包含自定义类型的反序列化
  test('replay — splice items 带自定义类型反序列化', () => {
    const dateType: CustomTypeConfig<Date> = {
      type: 'Date',
      is: (value): value is Date => value instanceof Date,
      serialize: (value) => value.toISOString(),
      deserialize: (raw) => new Date(raw as string),
    };

    const base = { dates: [new Date('2025-01-01')] };
    const patches: Patch[] = [
      {
        path: ['dates'],
        op: 'splice',
        index: 1,
        deleteCount: 0,
        items: ['2026-06-10T00:00:00.000Z', '2026-12-25T00:00:00.000Z'],
        type: 'Date',
        timestamp: 1,
      },
    ];

    const result = replay(base, patches, { types: [dateType] });
    expect(result.dates).toHaveLength(3);
    expect(result.dates[1]).toBeInstanceOf(Date);
    expect(result.dates[1].toISOString()).toBe('2026-06-10T00:00:00.000Z');
    expect(result.dates[2]).toBeInstanceOf(Date);
  });

  // replay.ts: delete on array element
  test('replay — delete 操作在数组元素上', () => {
    const base = { items: [10, 20, 30] };
    const patches: Patch[] = [{ path: ['items', 1], op: 'delete', timestamp: 1 }];

    const result = replay(base, patches);
    // delete array[1] 留一个 hole
    expect(result.items).toHaveLength(3);
    expect(1 in result.items).toBe(false);
  });

  // proxy-engine.ts: get 不代理原型链上的对象属性（使用 createRecorder 避免 deepClone 丢失原型链）
  test('proxy — get 不代理原型链上的对象属性', () => {
    const proto = { inherited: { nested: 'proto-value' } };
    const state = Object.create(proto) as Record<string, unknown>;
    state.own = 'my-value';

    const recorder = createRecorder(state);

    // 访问原型上的对象属性 — 应返回原始值，不创建子代理
    const inheritedRef = (recorder.proxy as Record<string, Record<string, string>>).inherited;
    expect(inheritedRef.nested).toBe('proto-value');

    // 修改原型属性的子属性 — 因为未被代理，不产生 patch
    inheritedRef.nested = 'modified';

    // 修改自身属性 — 产生 patch
    recorder.proxy.own = 'changed';

    const patches = recorder.flush();
    recorder.dispose();

    // 只有自身属性 set 产生 patch
    expect(patches).toHaveLength(1);
    expect(patches[0].path).toEqual(['own']);
    expect(patches[0].value).toBe('changed');
  });

  // proxy-engine.ts: set 对原型上已有同名属性仍在自身创建属性（使用 createRecorder）
  test('proxy — set 对原型同名属性仍在自身创建并产生 patch', () => {
    const proto = { shared: 'proto' };
    const state = Object.create(proto) as Record<string, unknown>;

    const recorder = createRecorder(state);
    recorder.proxy.shared = 'own-value';

    const patches = recorder.flush();
    recorder.dispose();

    expect(patches).toHaveLength(1);
    expect(patches[0].path).toEqual(['shared']);
    expect(patches[0].op).toBe('set');
    expect(patches[0].value).toBe('own-value');
  });

  // proxy-engine.ts: deleteProperty 对原型链属性不产生 patch（使用 createRecorder）
  test('proxy — delete 原型链属性不产生 patch', () => {
    const proto = { inherited: 'proto-value' };
    const state = Object.create(proto) as Record<string, unknown>;
    state.own = 'my-value';

    const recorder = createRecorder(state);

    // delete 原型属性 — 不应产生 patch
    delete recorder.proxy.inherited;
    // delete 自身属性 — 应产生 patch
    delete recorder.proxy.own;

    const patches = recorder.flush();
    recorder.dispose();

    // 只有自身属性的 delete 产生 patch
    expect(patches).toHaveLength(1);
    expect(patches[0].op).toBe('delete');
    expect(patches[0].path).toEqual(['own']);
  });
});

// ─── recorder + replay 联动 ──────────────────────────────

describe('recorder + replay 联动', () => {
  test('record → replay 后状态一致', () => {
    const initial = { user: { name: 'init', age: 20 }, tags: ['a'] };
    const recorder = createRecorder(structuredClone(initial));

    recorder.proxy.user.name = 'Alice';
    recorder.proxy.user.age = 30;
    recorder.proxy.tags.push('b', 'c');

    const patches = recorder.flush();
    recorder.dispose();

    const replayed = replay(initial, patches);

    expect(replayed.user.name).toBe('Alice');
    expect(replayed.user.age).toBe(30);
    expect(replayed.tags).toEqual(['a', 'b', 'c']);
  });

  test('recordTransaction → replay 联动', () => {
    const state = { count: 0, items: ['x'] };
    const patches = recordTransaction(state, (draft) => {
      draft.count = 99;
      draft.items.push('y');
    });

    const result = replay(state, patches);

    expect(result.count).toBe(99);
    expect(result.items).toEqual(['x', 'y']);
    expect(state.count).toBe(0);
    expect(state.items).toEqual(['x']);
  });

  test('自定义类型端到端：record → serialize → replay', () => {
    const dateType: CustomTypeConfig<Date> = {
      type: 'Date',
      is: (value): value is Date => value instanceof Date,
      serialize: (value) => value.toISOString(),
      deserialize: (raw) => new Date(raw as string),
    };
    const options = { types: [dateType] };

    const state = { createdAt: new Date('2025-01-01'), dates: [] as Date[] };
    const patches = recordTransaction(
      state,
      (draft) => {
        draft.createdAt = new Date('2026-06-10');
        draft.dates.push(new Date('2026-12-25'));
      },
      options,
    );

    const jsonString = JSON.stringify(patches);
    const receivedPatches = JSON.parse(jsonString) as Patch[];

    const result = replay(state, receivedPatches, options);

    expect(result.createdAt).toBeInstanceOf(Date);
    expect(result.createdAt.toISOString()).toBe('2026-06-10T00:00:00.000Z');
    expect(result.dates).toHaveLength(1);
    expect(result.dates[0]).toBeInstanceOf(Date);
    expect(result.dates[0].toISOString()).toBe('2026-12-25T00:00:00.000Z');
  });

  test('多次 flush → 多次 replay 累积', () => {
    const state = { count: 0 };
    const recorder = createRecorder(structuredClone(state));

    recorder.proxy.count = 1;
    const batch1 = recorder.flush();

    recorder.proxy.count = 2;
    const batch2 = recorder.flush();

    recorder.dispose();

    const allPatches = [...batch1, ...batch2];
    const result = replay(state, allPatches);

    expect(result.count).toBe(2);
  });
});
