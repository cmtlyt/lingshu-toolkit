import { throwError } from '@/shared/throw-error';
import type { HistoryNodeInfo, HistoryTree, HistoryTreeOptions, HistoryTreeSnapshot } from './types';

const MODULE_NAME = 'history-tree';

interface HistoryNode<T> {
  id: string;
  data: T;
  parentId: string | null;
  childrenIds: string[];
}

function createDefaultGenerateId(): () => string {
  let counter = 0;
  return () => String(counter++);
}

function toNodeInfo<T>(node: HistoryNode<T>): HistoryNodeInfo<T> {
  return {
    id: node.id,
    data: node.data,
    parentId: node.parentId,
    childrenIds: [...node.childrenIds],
  };
}

function getNodeOrThrow<T>(nodes: Map<string, HistoryNode<T>>, nodeId: string): HistoryNode<T> {
  const node = nodes.get(nodeId);
  if (!node) {
    throwError(MODULE_NAME, `Node "${nodeId}" does not exist`);
  }
  return node;
}

export function createHistoryTree<T>(options: HistoryTreeOptions<T>): HistoryTree<T> {
  const generateId = options.generateId ?? createDefaultGenerateId();
  const nodes = new Map<string, HistoryNode<T>>();

  const rootId = generateId();
  const rootNode: HistoryNode<T> = {
    id: rootId,
    data: options.initialData,
    parentId: null,
    childrenIds: [],
  };
  nodes.set(rootId, rootNode);

  let currentId = rootId;
  const listeners = new Set<(snapshot: HistoryTreeSnapshot<T>) => void>();

  function buildSnapshot(): HistoryTreeSnapshot<T> {
    const snapshotNodes: Record<string, HistoryNodeInfo<T>> = {};
    for (const [id, node] of nodes) {
      snapshotNodes[id] = toNodeInfo(node);
    }
    return { rootId, currentId, nodes: snapshotNodes };
  }

  function notifyListeners(): void {
    if (listeners.size === 0) {
      return;
    }
    const snapshot = buildSnapshot();
    for (const listener of listeners) {
      listener(snapshot);
    }
  }

  return {
    commit(data: T): string {
      const newId = generateId();
      if (nodes.has(newId)) {
        throwError(MODULE_NAME, `Duplicate node id "${newId}"`);
      }

      const newNode: HistoryNode<T> = {
        id: newId,
        data,
        parentId: currentId,
        childrenIds: [],
      };

      const parentNode = nodes.get(currentId)!;
      parentNode.childrenIds.push(newId);
      nodes.set(newId, newNode);
      currentId = newId;

      notifyListeners();
      return newId;
    },

    checkout(nodeId: string): void {
      getNodeOrThrow(nodes, nodeId);
      currentId = nodeId;
      notifyListeners();
    },

    getPathData(): T[] {
      const result: T[] = [];
      let current: HistoryNode<T> | undefined = nodes.get(currentId);

      while (current) {
        result.push(current.data);
        current = current.parentId === null ? undefined : nodes.get(current.parentId);
      }

      return result;
    },

    getCurrentNode(): HistoryNodeInfo<T> {
      return toNodeInfo(nodes.get(currentId)!);
    },

    getNode(nodeId: string): HistoryNodeInfo<T> {
      return toNodeInfo(getNodeOrThrow(nodes, nodeId));
    },

    getRoot(): HistoryNodeInfo<T> {
      return toNodeInfo(nodes.get(rootId)!);
    },

    getSnapshot(): HistoryTreeSnapshot<T> {
      return buildSnapshot();
    },

    onChange(listener: (snapshot: HistoryTreeSnapshot<T>) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    get currentId(): string {
      return currentId;
    },

    get currentData(): T {
      return nodes.get(currentId)!.data;
    },

    get parentData(): T | null {
      const current = nodes.get(currentId)!;
      if (current.parentId === null) {
        return null;
      }
      return nodes.get(current.parentId)!.data;
    },

    get size(): number {
      return nodes.size;
    },
  };
}
