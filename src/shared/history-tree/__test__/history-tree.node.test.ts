import { describe, expect, test, vi } from 'vitest';
import { createHistoryTree } from '../core';

describe('history-tree - 基础提交', () => {
  test('创建树后根节点数据正确', () => {
    const tree = createHistoryTree({ initialData: { x: 0 } });
    expect(tree.currentData).toEqual({ x: 0 });
    expect(tree.size).toBe(1);
    expect(tree.parentData).toBeNull();
  });

  test('连续 commit 创建线性链', () => {
    const tree = createHistoryTree({ initialData: 'v0' });
    const id1 = tree.commit('v1');
    const id2 = tree.commit('v2');

    expect(tree.size).toBe(3);
    expect(tree.currentData).toBe('v2');

    const node2 = tree.getNode(id2);
    expect(node2.parentId).toBe(id1);

    const node1 = tree.getNode(id1);
    expect(node1.childrenIds).toEqual([id2]);

    const root = tree.getRoot();
    expect(root.childrenIds).toEqual([id1]);
  });
});

describe('history-tree - 分支创建', () => {
  test('checkout 到中间节点后 commit 创建分支', () => {
    const tree = createHistoryTree({ initialData: 'v0' });
    const id1 = tree.commit('v1');
    tree.commit('v2');

    tree.checkout(id1);
    const id3 = tree.commit('v3');

    const node1 = tree.getNode(id1);
    expect(node1.childrenIds).toHaveLength(2);
    expect(tree.currentId).toBe(id3);
    expect(tree.currentData).toBe('v3');
  });
});

describe('history-tree - 复杂分支拓扑（v0~v9）', () => {
  test('还原 RFC 示例中的完整分支拓扑', () => {
    const tree = createHistoryTree({ initialData: 'd0' });
    const id1 = tree.commit('d1');
    const id2 = tree.commit('d2');

    tree.checkout(id1);
    const id3 = tree.commit('d3');
    const id4 = tree.commit('d4');
    const id5 = tree.commit('d5');

    tree.checkout(id2);
    const id6 = tree.commit('d6');

    tree.checkout(id3);
    const id7 = tree.commit('d7');

    tree.checkout(id4);
    const id8 = tree.commit('d8');
    const id9 = tree.commit('d9');

    expect(tree.size).toBe(10);

    expect(tree.getRoot().childrenIds).toEqual([id1]);
    expect(tree.getNode(id1).childrenIds).toEqual([id2, id3]);
    expect(tree.getNode(id2).childrenIds).toEqual([id6]);
    expect(tree.getNode(id3).childrenIds).toEqual([id4, id7]);
    expect(tree.getNode(id4).childrenIds).toEqual([id5, id8]);
    expect(tree.getNode(id5).childrenIds).toEqual([]);
    expect(tree.getNode(id6).childrenIds).toEqual([]);
    expect(tree.getNode(id7).childrenIds).toEqual([]);
    expect(tree.getNode(id8).childrenIds).toEqual([id9]);
    expect(tree.getNode(id9).childrenIds).toEqual([]);

    expect(tree.getNode(id3).parentId).toBe(id1);
    expect(tree.getNode(id7).parentId).toBe(id3);
    expect(tree.getNode(id8).parentId).toBe(id4);
    expect(tree.getNode(id6).parentId).toBe(id2);
  });
});

describe('history-tree - 路径回溯', () => {
  test('getPathData 返回从当前节点到根的有序列表', () => {
    const tree = createHistoryTree({ initialData: 'd0' });
    const id1 = tree.commit('d1');
    const id2 = tree.commit('d2');

    tree.checkout(id1);
    tree.commit('d3');
    const id4 = tree.commit('d4');

    tree.checkout(id4);
    tree.commit('d8');
    tree.commit('d9');

    expect(tree.getPathData()).toEqual(['d9', 'd8', 'd4', 'd3', 'd1', 'd0']);

    tree.checkout(id2);
    const id6 = tree.commit('d6');
    tree.checkout(id6);
    expect(tree.getPathData()).toEqual(['d6', 'd2', 'd1', 'd0']);
  });
});

describe('history-tree - 节点查询', () => {
  test('getCurrentNode 返回当前节点信息', () => {
    const tree = createHistoryTree({ initialData: 'root' });
    tree.commit('child');

    const current = tree.getCurrentNode();
    expect(current.data).toBe('child');
    expect(current.parentId).toBe(tree.getRoot().id);
  });

  test('getNode 返回指定节点信息', () => {
    const tree = createHistoryTree({ initialData: 'root' });
    const id = tree.commit('child');

    const node = tree.getNode(id);
    expect(node.id).toBe(id);
    expect(node.data).toBe('child');
  });

  test('getRoot 返回根节点', () => {
    const tree = createHistoryTree({ initialData: 'root' });
    tree.commit('child');

    const root = tree.getRoot();
    expect(root.data).toBe('root');
    expect(root.parentId).toBeNull();
  });
});

describe('history-tree - 错误处理', () => {
  test('checkout 不存在的节点抛错', () => {
    const tree = createHistoryTree({ initialData: 'root' });
    expect(() => tree.checkout('non-existent')).toThrow(
      '[@cmtlyt/lingshu-toolkit#history-tree]: Node "non-existent" does not exist',
    );
  });

  test('getNode 不存在的节点抛错', () => {
    const tree = createHistoryTree({ initialData: 'root' });
    expect(() => tree.getNode('non-existent')).toThrow(
      '[@cmtlyt/lingshu-toolkit#history-tree]: Node "non-existent" does not exist',
    );
  });
});

describe('history-tree - size 计数', () => {
  test('commit 后 size 正确递增', () => {
    const tree = createHistoryTree({ initialData: 'v0' });
    expect(tree.size).toBe(1);

    tree.commit('v1');
    expect(tree.size).toBe(2);

    tree.commit('v2');
    expect(tree.size).toBe(3);
  });
});

describe('history-tree - currentData getter', () => {
  test('commit 后 currentData 更新', () => {
    const tree = createHistoryTree({ initialData: 'v0' });
    expect(tree.currentData).toBe('v0');

    tree.commit('v1');
    expect(tree.currentData).toBe('v1');
  });

  test('checkout 后 currentData 更新', () => {
    const tree = createHistoryTree({ initialData: 'v0' });
    tree.commit('v1');
    const rootId = tree.getRoot().id;

    tree.checkout(rootId);
    expect(tree.currentData).toBe('v0');
  });
});

describe('history-tree - parentData getter', () => {
  test('根节点的 parentData 为 null', () => {
    const tree = createHistoryTree({ initialData: 'root' });
    expect(tree.parentData).toBeNull();
  });

  test('子节点的 parentData 返回父节点数据', () => {
    const tree = createHistoryTree({ initialData: 'root' });
    tree.commit('child');
    expect(tree.parentData).toBe('root');
  });

  test('checkout 后 parentData 跟随变化', () => {
    const tree = createHistoryTree({ initialData: 'v0' });
    const id1 = tree.commit('v1');
    tree.commit('v2');

    expect(tree.parentData).toBe('v1');

    tree.checkout(id1);
    expect(tree.parentData).toBe('v0');
  });
});

describe('history-tree - 自定义 id 生成', () => {
  test('传入 generateId 后节点使用自定义 id', () => {
    let counter = 100;
    const tree = createHistoryTree({
      initialData: 'root',
      generateId: () => `node-${counter++}`,
    });

    expect(tree.currentId).toBe('node-100');

    const id1 = tree.commit('v1');
    expect(id1).toBe('node-101');

    const id2 = tree.commit('v2');
    expect(id2).toBe('node-102');
  });
});

describe('history-tree - 重复 id 检测', () => {
  test('generateId 返回重复 id 时抛错', () => {
    let called = false;
    const tree = createHistoryTree({
      initialData: 'root',
      generateId: () => {
        if (!called) {
          called = true;
          return 'unique-root';
        }
        return 'unique-root';
      },
    });

    expect(() => tree.commit('v1')).toThrow('[@cmtlyt/lingshu-toolkit#history-tree]: Duplicate node id "unique-root"');
  });
});

describe('history-tree - 边界情况', () => {
  test('只有根节点时 getPathData 返回单元素列表', () => {
    const tree = createHistoryTree({ initialData: 'only-root' });
    expect(tree.getPathData()).toEqual(['only-root']);
  });

  test('checkout 到当前节点不抛错', () => {
    const tree = createHistoryTree({ initialData: 'root' });
    const currentId = tree.currentId;
    expect(() => tree.checkout(currentId)).not.toThrow();
    expect(tree.currentId).toBe(currentId);
  });
});

describe('history-tree - getSnapshot', () => {
  test('返回包含所有节点的快照', () => {
    const tree = createHistoryTree({ initialData: 'v0' });
    const id1 = tree.commit('v1');
    tree.commit('v2');

    const snapshot = tree.getSnapshot();
    expect(snapshot.rootId).toBe(tree.getRoot().id);
    expect(snapshot.currentId).toBe(tree.currentId);
    expect(Object.keys(snapshot.nodes)).toHaveLength(3);
    expect(snapshot.nodes[id1].data).toBe('v1');
  });

  test('快照中 childrenIds 为副本，修改不影响原树', () => {
    const tree = createHistoryTree({ initialData: 'v0' });
    tree.commit('v1');

    const snapshot = tree.getSnapshot();
    const rootNode = snapshot.nodes[snapshot.rootId];
    const childrenCopy = [...rootNode.childrenIds];
    expect(childrenCopy).toHaveLength(1);

    // 原树提交新节点
    tree.commit('v2');
    // 之前的快照不应变化
    expect(rootNode.childrenIds).toHaveLength(1);
  });
});

describe('history-tree - onChange', () => {
  test('commit 后触发 onChange 回调', () => {
    const tree = createHistoryTree({ initialData: 'v0' });
    const listener = vi.fn();
    tree.onChange(listener);

    tree.commit('v1');

    expect(listener).toHaveBeenCalledTimes(1);
    const snapshot = listener.mock.calls[0][0];
    expect(snapshot.currentId).toBe(tree.currentId);
    expect(Object.keys(snapshot.nodes)).toHaveLength(2);
  });

  test('checkout 后触发 onChange 回调', () => {
    const tree = createHistoryTree({ initialData: 'v0' });
    tree.commit('v1');

    const listener = vi.fn();
    tree.onChange(listener);

    const rootId = tree.getRoot().id;
    tree.checkout(rootId);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0].currentId).toBe(rootId);
  });

  test('多个 listener 均被通知', () => {
    const tree = createHistoryTree({ initialData: 'v0' });
    const listenerA = vi.fn();
    const listenerB = vi.fn();
    tree.onChange(listenerA);
    tree.onChange(listenerB);

    tree.commit('v1');

    expect(listenerA).toHaveBeenCalledTimes(1);
    expect(listenerB).toHaveBeenCalledTimes(1);
  });

  test('取消订阅后不再触发', () => {
    const tree = createHistoryTree({ initialData: 'v0' });
    const listener = vi.fn();
    const unsubscribe = tree.onChange(listener);

    tree.commit('v1');
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    tree.commit('v2');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
