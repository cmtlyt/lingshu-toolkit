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
