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

  test('rollback 后被删除的属性恢复为原值', () => {
    const target: { a?: number } = { a: 1 };
    const session = createDraftSession(target);

    Reflect.deleteProperty(session.draft, 'a');
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
