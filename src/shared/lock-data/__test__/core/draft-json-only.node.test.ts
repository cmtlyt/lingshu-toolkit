/**
 * draft.ts 的 JSON-only 契约回归测试
 *
 * 覆盖 src/shared/lock-data/fixes/collection-deep-mutation-bypass.md 方案的 5 组核心用例：
 *  1. 入口拦截 - target 内含 Map / Set 抛 TypeError
 *  2. 入口拦截 - target 内含 Date / RegExp / class 实例抛 TypeError
 *  3. 入口允许 - 纯 JSON 数据
 *  4. 写入拦截 - recipe 里写入非 JSON 值抛 TypeError，且 target / mutations 不被污染
 *  5. 环形引用 - 入口检测到 cycle 抛 TypeError
 */

import { describe, expect, test } from 'vitest';
import { createDraftSession } from '@/shared/lock-data/core/draft';

describe('createDraftSession - JSON-only 契约', () => {
  describe('入口拦截 - 非 JSON 值', () => {
    test('target 内含 Map 抛 TypeError 且消息包含路径', () => {
      const target = { dict: new Map<string, number>([['a', 1]]) };

      expect(() => createDraftSession(target)).toThrow(TypeError);
      expect(() => createDraftSession(target)).toThrow(/Map.*at "dict"/u);
    });

    test('target 内含 Set 抛 TypeError', () => {
      const target = { tags: new Set<string>(['a']) };

      expect(() => createDraftSession(target)).toThrow(/Set.*at "tags"/u);
    });

    test('嵌套深处的 Map / Set 也会被命中且路径准确', () => {
      const target = { user: { profile: { ids: new Set<number>() } } };

      expect(() => createDraftSession(target)).toThrow(/Set.*at "user\.profile\.ids"/u);
    });

    test('数组内的 Map 命中索引路径', () => {
      const target = { list: [{ x: 1 }, { y: new Map() }] };

      expect(() => createDraftSession(target)).toThrow(/Map.*at "list\[1\]\.y"/u);
    });

    test('target 内含 Date 抛 TypeError', () => {
      const target = { createdAt: new Date() };

      expect(() => createDraftSession(target)).toThrow(/Date.*at "createdAt"/u);
    });

    test('target 内含 RegExp 抛 TypeError', () => {
      const target = { pattern: /foo/u };

      expect(() => createDraftSession(target)).toThrow(/RegExp.*at "pattern"/u);
    });

    test('target 内含 class 实例抛 TypeError 并描述类名', () => {
      class Foo {
        x = 1;
      }
      const target = { foo: new Foo() };

      expect(() => createDraftSession(target)).toThrow(/class instance \(Foo\).*at "foo"/u);
    });

    test('target 内含 function 抛 TypeError', () => {
      const target: { handler: unknown } = { handler: () => 1 };

      expect(() => createDraftSession(target)).toThrow(/function.*at "handler"/u);
    });

    test('target 内含 bigint 抛 TypeError', () => {
      const target: { big: unknown } = { big: 10n };

      expect(() => createDraftSession(target)).toThrow(/bigint.*at "big"/u);
    });

    test('target 内含 NaN 抛 TypeError', () => {
      const target = { x: Number.NaN };

      expect(() => createDraftSession(target)).toThrow(/NaN.*at "x"/u);
    });

    test('target 内含 Infinity 抛 TypeError', () => {
      const target = { x: Number.POSITIVE_INFINITY };

      expect(() => createDraftSession(target)).toThrow(/Infinity.*at "x"/u);
    });

    test('target 内含 undefined 抛 TypeError 并提示用 null', () => {
      const target: { x: unknown } = { x: undefined };

      expect(() => createDraftSession(target)).toThrow(/undefined.*at "x".*null/u);
    });

    test('错误信息携带 lockData 前缀', () => {
      const target = { dict: new Map() };

      expect(() => createDraftSession(target)).toThrow(/\[@cmtlyt\/lingshu-toolkit#lockData\]/u);
    });
  });

  describe('入口允许 - 纯 JSON 数据', () => {
    test('plain object / array / primitive 嵌套通过', () => {
      const target = {
        name: 'cmt',
        age: 18,
        active: true,
        meta: null,
        tags: ['a', 'b', 'c'],
        nested: {
          list: [
            { id: 1, label: 'first' },
            { id: 2, label: 'second' },
          ],
        },
      };

      expect(() => createDraftSession(target)).not.toThrow();
    });

    test('Object.create(null) 视为 plain object 通过', () => {
      const inner = Object.create(null);
      inner.x = 1;
      const target = { data: inner };

      expect(() => createDraftSession(target)).not.toThrow();
    });

    test('顶层为数组通过', () => {
      const target = [1, 2, { x: 3 }];

      expect(() => createDraftSession(target)).not.toThrow();
    });

    test('同一引用出现在两个兄弟节点不被误判为环', () => {
      const shared = { x: 1 };
      const target = { a: shared, b: shared };

      expect(() => createDraftSession(target)).not.toThrow();
    });
  });

  describe('写入拦截 - recipe 里赋非 JSON 值', () => {
    test('赋值 new Set 抛 TypeError 且 target / mutations 不被污染', () => {
      const target: { x: unknown; y: number } = { x: 1, y: 2 };
      const session = createDraftSession(target);

      expect(() => {
        session.draft.x = new Set();
      }).toThrow(/Set.*at "x"/u);

      // fail-fast：原地写入未发生，mutations / snapshot 都不受污染
      expect(target.x).toBe(1);
      expect(session.mutations).toHaveLength(0);

      // 后续合法写入仍可正常工作
      session.draft.y = 3;
      expect(target.y).toBe(3);
      expect(session.mutations).toHaveLength(1);
    });

    test('赋值 Date 抛 TypeError', () => {
      const target: { d: unknown } = { d: 1 };
      const session = createDraftSession(target);

      expect(() => {
        session.draft.d = new Date();
      }).toThrow(/Date.*at "d"/u);
    });

    test('赋值含 NaN 的对象抛 TypeError 且路径深入到 NaN 字段', () => {
      const target: { x: unknown } = { x: 0 };
      const session = createDraftSession(target);

      expect(() => {
        session.draft.x = { a: { b: Number.NaN } };
      }).toThrow(/NaN.*at "x\.a\.b"/u);
    });

    test('rollback 后非 JSON 值的失败写入不影响最终状态', () => {
      const target: { x: unknown; y: number } = { x: 1, y: 2 };
      const session = createDraftSession(target);

      session.draft.y = 99;
      expect(() => {
        session.draft.x = new Map();
      }).toThrow(TypeError);

      session.rollback();

      expect(target.x).toBe(1);
      expect(target.y).toBe(2);
    });
  });

  describe('环形引用拦截', () => {
    test('入口检测到对象自循环抛 TypeError', () => {
      interface Cyclic {
        name: string;
        self?: Cyclic;
      }
      const target: Cyclic = { name: 'cmt' };
      target.self = target;

      expect(() => createDraftSession(target)).toThrow(/cyclic reference/u);
    });

    test('入口检测到深层环抛 TypeError 并定位路径', () => {
      interface CycleNode {
        id: number;
        child?: CycleNode;
      }
      const root: CycleNode = { id: 1 };
      const child: CycleNode = { id: 2 };
      root.child = child;
      child.child = root;

      expect(() => createDraftSession({ root })).toThrow(/cyclic reference at "root\.child\.child"/u);
    });

    test('数组自循环抛 TypeError', () => {
      const arr: unknown[] = [1, 2];
      arr.push(arr);

      expect(() => createDraftSession({ list: arr })).toThrow(/cyclic reference/u);
    });
  });
});
