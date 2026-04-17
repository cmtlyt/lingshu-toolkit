import type { CompareFn, HeapItem } from './types';

function defaultCompare<T>(left: T, right: T): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function getParentIndex(index: number): number {
  return Math.floor((index - 1) / 2);
}

function getLeftChildIndex(index: number): number {
  return 2 * index + 1;
}

function getRightChildIndex(index: number): number {
  return 2 * index + 2;
}

function updateSmallestIndex<T>(
  childIndex: number,
  smallestIndex: number,
  size: number,
  heap: HeapItem<T>[],
  compare: CompareFn<T>,
): number {
  if (childIndex >= size) {
    return smallestIndex;
  }

  const childCompare = compare(heap[childIndex]!.item, heap[smallestIndex]!.item);
  if (childCompare < 0 || (childCompare === 0 && heap[childIndex]!.insertOrder < heap[smallestIndex]!.insertOrder)) {
    return childIndex;
  }

  return smallestIndex;
}

export { defaultCompare, getLeftChildIndex, getParentIndex, getRightChildIndex, updateSmallestIndex };
