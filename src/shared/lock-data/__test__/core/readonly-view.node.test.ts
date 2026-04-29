import { describe, expect, test } from 'vitest';
import { createReadonlyView } from '@/shared/lock-data/core/readonly-view';
import { ReadonlyMutationError } from '@/shared/lock-data/errors';

describe('createReadonlyView', () => {
  test('读取浅层属性与原对象一致', () => {
    const source = { name: 'cmt', age: 18 };
    const view = createReadonlyView(source);
    expect(view.name).toBe('cmt');
    expect(view.age).toBe(18);
  });

  test('写入根层属性抛 ReadonlyMutationError', () => {
    const view = createReadonlyView({ name: 'cmt' });
    expect(() => {
      view.name = 'x';
    }).toThrow(ReadonlyMutationError);
  });

  test('写入嵌套层属性同样抛错（深只读）', () => {
    const view = createReadonlyView({ profile: { age: 18 } });
    expect(() => {
      view.profile.age = 19;
    }).toThrow(ReadonlyMutationError);
  });

  test('删除属性抛错', () => {
    const view = createReadonlyView({ name: 'cmt' }) as { name?: string };
    expect(() => {
      view.name = undefined;
    }).toThrow(ReadonlyMutationError);
  });

  test('同一原对象多次包裹返回同一代理（引用稳定）', () => {
    const source = { nested: { value: 1 } };
    const viewA = createReadonlyView(source);
    const viewB = createReadonlyView(source);
    expect(viewA).toBe(viewB);
  });

  test('同一嵌套对象多次 get 返回同一代理', () => {
    const source = { nested: { value: 1 } };
    const view = createReadonlyView(source);
    expect(view.nested).toBe(view.nested);
  });

  test('原地修改底层对象后，只读视图能读到最新值', () => {
    const source = { count: 0 };
    const view = createReadonlyView(source);
    expect(view.count).toBe(0);
    source.count = 42;
    expect(view.count).toBe(42);
  });

  test('defineProperty 被拦截', () => {
    const view = createReadonlyView({});
    expect(() => Object.defineProperty(view, 'x', { value: 1 })).toThrow(ReadonlyMutationError);
  });

  test('非对象属性直接返回原值（不被包裹）', () => {
    const fn = (): number => 42;
    const source = { value: 1, flag: true, fn };
    const view = createReadonlyView(source);
    expect(view.value).toBe(1);
    expect(view.flag).toBe(true);
    // 函数是可访问对象，会被包裹为 Proxy，不应当是原引用
    expect(typeof view.fn).toBe('function');
    expect(view.fn).not.toBe(fn);
  });

  test('数组元素的深只读', () => {
    const view = createReadonlyView({ list: [{ id: 1 }] });
    expect(() => {
      view.list[0].id = 2;
    }).toThrow(ReadonlyMutationError);
    expect(() => {
      view.list.push({ id: 2 });
    }).toThrow(ReadonlyMutationError);
  });

  test('错误消息前缀包含 lockData 命名空间', () => {
    const view = createReadonlyView({ a: 1 });
    expect(() => {
      view.a = 2;
    }).toThrow(/\[@cmtlyt\/lingshu-toolkit#lockData\]: cannot mutate readonly view/u);
  });
});

describe('createReadonlyView - Set / Map 拦截', () => {
  test('Set.add 被拦截抛 ReadonlyMutationError', () => {
    const view = createReadonlyView({ tags: new Set<string>(['a']) });
    expect(() => view.tags.add('b')).toThrow(ReadonlyMutationError);
  });

  test('Set.delete 被拦截', () => {
    const view = createReadonlyView({ tags: new Set<string>(['a']) });
    expect(() => view.tags.delete('a')).toThrow(ReadonlyMutationError);
  });

  test('Set.clear 被拦截', () => {
    const view = createReadonlyView({ tags: new Set<string>(['a', 'b']) });
    expect(() => view.tags.clear()).toThrow(ReadonlyMutationError);
  });

  test('Set 非 mutation 方法（has / forEach / size）正常工作', () => {
    const tags = new Set<string>(['a', 'b']);
    const view = createReadonlyView({ tags });
    expect(view.tags.has('a')).toBe(true);
    expect(view.tags.has('z')).toBe(false);
    expect(view.tags.size).toBe(2);
    const collected: string[] = [];
    view.tags.forEach((item) => {
      collected.push(item);
    });
    // @ts-expect-error
    expect(collected.sort((a, b) => a - b)).toEqual(['a', 'b']);
  });

  test('Set 的迭代器（Symbol.iterator / values / keys / entries）正常工作', () => {
    const view = createReadonlyView({ tags: new Set<string>(['a', 'b']) });
    expect(Array.from(view.tags).sort()).toEqual(['a', 'b']);
    expect(Array.from(view.tags.values()).sort()).toEqual(['a', 'b']);
    expect(Array.from(view.tags.keys()).sort()).toEqual(['a', 'b']);
    expect(Array.from(view.tags.entries()).sort()).toEqual([
      ['a', 'a'],
      ['b', 'b'],
    ]);
  });

  test('Map.set 被拦截', () => {
    const view = createReadonlyView({ dict: new Map<string, number>([['a', 1]]) });
    expect(() => view.dict.set('b', 2)).toThrow(ReadonlyMutationError);
  });

  test('Map.delete / Map.clear 被拦截', () => {
    const view = createReadonlyView({ dict: new Map<string, number>([['a', 1]]) });
    expect(() => view.dict.delete('a')).toThrow(ReadonlyMutationError);
    expect(() => view.dict.clear()).toThrow(ReadonlyMutationError);
  });

  test('Map 非 mutation 方法（get / has / size / forEach）正常工作', () => {
    const view = createReadonlyView({ dict: new Map<string, number>([['a', 1]]) });
    expect(view.dict.get('a')).toBe(1);
    expect(view.dict.has('a')).toBe(true);
    expect(view.dict.size).toBe(1);
    const collected: [string, number][] = [];
    view.dict.forEach((value, key) => {
      collected.push([key, value]);
    });
    expect(collected).toEqual([['a', 1]]);
  });

  test('Map 迭代器正常工作', () => {
    const view = createReadonlyView({
      dict: new Map<string, number>([
        ['a', 1],
        ['b', 2],
      ]),
    });
    expect(Array.from(view.dict.entries()).sort()).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
    expect(Array.from(view.dict.keys()).sort()).toEqual(['a', 'b']);
    expect(Array.from(view.dict.values()).sort()).toEqual([1, 2]);
  });

  test('嵌套在对象里的 Set / Map 同样受保护', () => {
    const view = createReadonlyView({ user: { tags: new Set<string>(['admin']) } });
    expect(() => view.user.tags.add('guest')).toThrow(ReadonlyMutationError);
  });
});
