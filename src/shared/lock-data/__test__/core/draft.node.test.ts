import { describe, expect, test } from 'vitest';
import { createDraftSession } from '@/shared/lock-data/core/draft';
import { LockRevokedError } from '@/shared/lock-data/errors';

describe('createDraftSession', () => {
  test('写入根层属性会原地修改 target 并记录 mutation', () => {
    const target = { name: 'cmt', age: 18 };
    const session = createDraftSession(target);

    session.draft.age = 19;

    expect(target.age).toBe(19);
    expect(session.mutations).toHaveLength(1);
    expect(session.mutations[0]).toMatchObject({ path: ['age'], op: 'set', value: 19 });
  });

  test('写入嵌套属性路径正确拼接', () => {
    const target = { user: { profile: { age: 18 } } };
    const session = createDraftSession(target);

    session.draft.user.profile.age = 20;

    expect(target.user.profile.age).toBe(20);
    expect(session.mutations[0]?.path).toEqual(['user', 'profile', 'age']);
  });

  test('删除属性记录 op=delete', () => {
    const target: { a?: number; b: number } = { a: 1, b: 2 };
    const session = createDraftSession(target);

    // 使用 Reflect.deleteProperty 触发 Proxy 的 deleteProperty trap；
    // 直接 `delete proxy.a` 在严格模式下由 TS 编译器降级处理，行为不稳定
    Reflect.deleteProperty(session.draft, 'a');

    expect(Object.hasOwn(target, 'a')).toBe(false);
    expect(session.mutations[0]).toMatchObject({ path: ['a'], op: 'delete' });
  });

  test('rollback 恢复所有已写入路径到原值', () => {
    const target: { a: number; b: number; c?: number } = { a: 1, b: 2 };
    const session = createDraftSession(target);

    session.draft.a = 100;
    session.draft.b = 200;
    session.draft.c = 300;

    session.rollback();

    expect(target.a).toBe(1);
    expect(target.b).toBe(2);
    expect(Object.hasOwn(target, 'c')).toBe(false);
  });

  test('rollback 恢复嵌套路径（最小深拷贝策略）', () => {
    const target = { user: { name: 'cmt', age: 18 } };
    const session = createDraftSession(target);

    session.draft.user.name = 'alice';
    session.draft.user.age = 99;

    session.rollback();

    expect(target.user.name).toBe('cmt');
    expect(target.user.age).toBe(18);
  });

  test('同一路径被多次覆写，rollback 只恢复到最初值', () => {
    const target = { count: 1 };
    const session = createDraftSession(target);

    session.draft.count = 2;
    session.draft.count = 3;
    session.draft.count = 4;

    session.rollback();
    expect(target.count).toBe(1);
  });

  test('rollback 被删除的属性恢复为"不存在"而非 undefined', () => {
    const target: { a?: number } = { a: 1 };
    const session = createDraftSession(target);

    session.draft.a = undefined;
    session.rollback();

    expect(Object.hasOwn(target, 'a')).toBe(true);
    expect(target.a).toBe(1);
  });

  test('commit 后再次写入抛 LockRevokedError', () => {
    const target = { a: 1 };
    const session = createDraftSession(target);

    session.draft.a = 2;
    session.commit();

    expect(() => {
      session.draft.a = 3;
    }).toThrow(LockRevokedError);
  });

  test('rollback 后再次写入抛 LockRevokedError', () => {
    const target = { a: 1 };
    const session = createDraftSession(target);

    session.draft.a = 2;
    session.rollback();

    expect(() => {
      session.draft.a = 3;
    }).toThrow(LockRevokedError);
  });

  test('dispose 后再次写入抛 LockRevokedError', () => {
    const target = { a: 1 };
    const session = createDraftSession(target);

    session.dispose();

    expect(() => {
      session.draft.a = 2;
    }).toThrow(LockRevokedError);
  });

  test('commit 返回冻结的 mutations 数组', () => {
    const target = { a: 1 };
    const session = createDraftSession(target);

    session.draft.a = 2;
    const frozen = session.commit();

    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen[0])).toBe(true);
    expect(Object.isFrozen(frozen[0]?.path)).toBe(true);
  });

  test('读取不触发 mutation log', () => {
    const target = { a: 1, b: { c: 2 } };
    const session = createDraftSession(target);

    const _read1 = session.draft.a;
    const _read2 = session.draft.b.c;

    expect(session.mutations).toHaveLength(0);
  });

  test('数组元素修改也被追踪', () => {
    const target = { list: [1, 2, 3] };
    const session = createDraftSession(target);

    session.draft.list[0] = 100;

    expect(target.list[0]).toBe(100);
    expect(session.mutations[0]?.path).toEqual(['list', '0']);
  });

  test('rollback 后 mutations 被清空', () => {
    const target = { a: 1 };
    const session = createDraftSession(target);

    session.draft.a = 2;
    session.rollback();

    expect(session.mutations).toHaveLength(0);
  });

  test('异常消息携带 lockData 前缀', () => {
    const target = { a: 1 };
    const session = createDraftSession(target);
    session.dispose();

    expect(() => {
      session.draft.a = 2;
    }).toThrow(/\[@cmtlyt\/lingshu-toolkit#lockData\]/u);
  });
});

describe('createDraftSession - Set / Map 追踪', () => {
  test('Set.add 会原地改 target 并记录 mutation', () => {
    const target = { tags: new Set<string>(['a']) };
    const session = createDraftSession(target);

    session.draft.tags.add('b');

    expect(target.tags.has('b')).toBe(true);
    expect(session.mutations).toHaveLength(1);
    expect(session.mutations[0]).toMatchObject({ path: ['tags'], op: 'set-add', value: 'b' });
  });

  test('Set.delete 与 Set.clear 记录对应 op', () => {
    const target = { tags: new Set<string>(['a', 'b']) };
    const session = createDraftSession(target);

    session.draft.tags.delete('a');
    session.draft.tags.clear();

    expect(session.mutations[0]).toMatchObject({ path: ['tags'], op: 'set-delete', value: 'a' });
    expect(session.mutations[1]).toMatchObject({ path: ['tags'], op: 'set-clear' });
    expect(target.tags.size).toBe(0);
  });

  test('Map.set 记录 path + [key, value]', () => {
    const target = { dict: new Map<string, number>([['a', 1]]) };
    const session = createDraftSession(target);

    session.draft.dict.set('b', 2);

    expect(target.dict.get('b')).toBe(2);
    expect(session.mutations[0]).toMatchObject({ path: ['dict'], op: 'map-set', value: ['b', 2] });
  });

  test('Map.delete / Map.clear 记录对应 op', () => {
    const target = {
      dict: new Map<string, number>([
        ['a', 1],
        ['b', 2],
      ]),
    };
    const session = createDraftSession(target);

    session.draft.dict.delete('a');
    session.draft.dict.clear();

    expect(session.mutations[0]).toMatchObject({ path: ['dict'], op: 'map-delete', value: 'a' });
    expect(session.mutations[1]).toMatchObject({ path: ['dict'], op: 'map-clear' });
    expect(target.dict.size).toBe(0);
  });

  test('Set 的 rollback 整体恢复到初始元素', () => {
    const target = { tags: new Set<string>(['a', 'b']) };
    const session = createDraftSession(target);

    session.draft.tags.add('c');
    session.draft.tags.delete('a');
    session.draft.tags.clear();

    session.rollback();

    expect(Array.from(target.tags).sort()).toEqual(['a', 'b']);
  });

  test('Map 的 rollback 整体恢复 key/value 对', () => {
    const target = {
      dict: new Map<string, number>([
        ['a', 1],
        ['b', 2],
      ]),
    };
    const session = createDraftSession(target);

    session.draft.dict.set('a', 100);
    session.draft.dict.delete('b');
    session.draft.dict.set('c', 3);

    session.rollback();

    expect(target.dict.get('a')).toBe(1);
    expect(target.dict.get('b')).toBe(2);
    expect(target.dict.has('c')).toBe(false);
    expect(target.dict.size).toBe(2);
  });

  test('dispose 后 Set mutation 抛 LockRevokedError', () => {
    const target = { tags: new Set<string>() };
    const session = createDraftSession(target);
    session.dispose();

    expect(() => session.draft.tags.add('x')).toThrow(LockRevokedError);
  });

  test('commit 后 Map mutation 抛 LockRevokedError', () => {
    const target = { dict: new Map<string, number>() };
    const session = createDraftSession(target);
    session.draft.dict.set('a', 1);
    session.commit();

    expect(() => session.draft.dict.set('b', 2)).toThrow(LockRevokedError);
  });

  test('Set 非 mutation 方法（has / size / iterator）不触发 mutation log', () => {
    const target = { tags: new Set<string>(['a']) };
    const session = createDraftSession(target);

    const _hasA = session.draft.tags.has('a');
    const _size = session.draft.tags.size;
    const _items = Array.from(session.draft.tags);

    expect(session.mutations).toHaveLength(0);
  });
});
