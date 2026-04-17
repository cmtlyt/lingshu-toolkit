type CompareFn<T> = (first: T, second: T) => number;

interface PriorityQueueOptions<T> {
  compare?: CompareFn<T>;
  allowDuplicate?: boolean;
}

interface HeapItem<T> {
  item: T;
  insertOrder: number;
}

export type { CompareFn, HeapItem, PriorityQueueOptions };
