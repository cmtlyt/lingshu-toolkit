import { $dt, $t, dataHandler } from '@/shared/data-handler';
import { logger } from '@/shared/logger';
import { tryCall } from '@/shared/try-call';
import type { CompareFn, HeapItem, PriorityQueueOptions } from './types';
import { defaultCompare, getLeftChildIndex, getParentIndex, getRightChildIndex, updateSmallestIndex } from './utils';

const validInfo = $dt({
  compare: $t.function(() => defaultCompare),
  allowDuplicate: $t.boolean(false),
});

class PriorityQueue<T> {
  private readonly heap: HeapItem<T>[] = [];
  private readonly itemSet: Set<T> = new Set();
  private readonly compare: CompareFn<T>;
  private readonly allowDuplicate: boolean;
  private insertCounter = 0;

  constructor(options: PriorityQueueOptions<T> = {}) {
    const { compare, allowDuplicate } = dataHandler(options || {}, validInfo, { unwrap: true });
    this.compare = compare;
    this.allowDuplicate = allowDuplicate;
  }

  private swapItems(index1: number, index2: number): void {
    [this.heap[index1], this.heap[index2]] = [this.heap[index2], this.heap[index1]];
  }

  private heapifyUp(index: number): void {
    let currentIndex = index;
    while (currentIndex > 0) {
      const parentIndex = getParentIndex(currentIndex);
      const current = this.heap[currentIndex];
      const parent = this.heap[parentIndex];
      const compareResult = this.compare(current.item, parent.item);

      if (compareResult < 0) {
        this.swapItems(currentIndex, parentIndex);
        currentIndex = parentIndex;
      } else {
        break;
      }
    }
  }

  private heapifyDown(index: number): void {
    let currentIndex = index;
    const size = this.heap.length;

    while (currentIndex < size) {
      const leftChildIndex = getLeftChildIndex(currentIndex);
      const rightChildIndex = getRightChildIndex(currentIndex);
      let smallestIndex = currentIndex;

      smallestIndex = updateSmallestIndex(leftChildIndex, smallestIndex, size, this.heap, this.compare);
      smallestIndex = updateSmallestIndex(rightChildIndex, smallestIndex, size, this.heap, this.compare);

      if (smallestIndex === currentIndex) {
        break;
      }

      this.swapItems(currentIndex, smallestIndex);
      currentIndex = smallestIndex;
    }
  }

  private isDuplicate(item: T): boolean {
    if (!this.allowDuplicate) {
      return this.itemSet.has(item);
    }
    return false;
  }

  enqueue(item: T): boolean {
    if (this.isDuplicate(item)) {
      const desc = tryCall(
        () => (typeof item === 'object' && item !== null ? JSON.stringify(item) : String(item)),
        () => Object.prototype.toString.call(item),
      );
      logger.warn('PriorityQueue.enqueue', `Duplicate item detected: ${desc}`);
      return false;
    }

    const heapItem: HeapItem<T> = {
      item,
      insertOrder: this.insertCounter++,
    };

    this.itemSet.add(item);
    this.heap.push(heapItem);
    this.heapifyUp(this.heap.length - 1);

    return true;
  }

  enqueueMany(items: T[]): boolean[] {
    return items.map((item) => this.enqueue(item));
  }

  dequeue(): T | undefined {
    if (this.heap.length === 0) {
      return;
    }

    if (this.heap.length === 1) {
      return this.heap.pop()!.item;
    }

    const root = this.heap[0].item;
    this.heap[0] = this.heap.pop()!;
    this.heapifyDown(0);

    this.itemSet.delete(root);
    return root;
  }

  peek(): T | undefined {
    if (this.heap.length === 0) {
      return;
    }
    return this.heap[0].item;
  }

  size(): number {
    return this.heap.length;
  }

  isEmpty(): boolean {
    return this.heap.length === 0;
  }

  clear(): void {
    this.heap.length = 0;
    this.insertCounter = 0;
  }

  /**
   * 返回队列中所有元素的有序数组副本
   *
   * @description
   * 该方法返回一个新数组，包含队列中的所有元素，按照以下顺序排列：
   * 1. 优先级从小到大（根据 compare 函数）
   * 2. 相同优先级的元素按照插入顺序（FIFO）
   *
   * 注意：返回的是数组副本，修改返回的数组不会影响原队列
   *
   * @returns 按优先级和插入顺序排序的元素数组
   *
   * @example
   * ```ts
   * const queue = priorityQueue<number>();
   * queue.enqueue(3);
   * queue.enqueue(1);
   * queue.enqueue(2);
   *
   * console.log(queue.toArray()); // [1, 2, 3]
   * ```
   */
  toArray(): T[] {
    const items = [...this.heap];

    items.sort((first, second) => {
      const compareResult = this.compare(first.item, second.item);
      if (compareResult !== 0) {
        return compareResult;
      }
      return first.insertOrder - second.insertOrder;
    });

    return items.map((item) => item.item);
  }
}

function priorityQueue<T>(options?: PriorityQueueOptions<T>): PriorityQueue<T> {
  return new PriorityQueue(options);
}

export { priorityQueue };
