import { describe, expect, test, vi } from 'vitest';
import { priorityQueue } from './index';

describe('priorityQueue', () => {
  test('导出测试', () => {
    expect(priorityQueue).toBeTypeOf('function');
  });

  describe('基本功能', () => {
    test('应该能正确入队和出队元素（最小堆）', () => {
      const queue = priorityQueue<number>();
      expect(queue.enqueue(3)).toBe(true);
      expect(queue.enqueue(1)).toBe(true);
      expect(queue.enqueue(2)).toBe(true);

      expect(queue.dequeue()).toBe(1);
      expect(queue.dequeue()).toBe(2);
      expect(queue.dequeue()).toBe(3);
    });

    test('应该能正确入队和出队元素（最大堆）', () => {
      const queue = priorityQueue<number>({ compare: (a, b) => b - a });
      expect(queue.enqueue(1)).toBe(true);
      expect(queue.enqueue(3)).toBe(true);
      expect(queue.enqueue(2)).toBe(true);

      expect(queue.dequeue()).toBe(3);
      expect(queue.dequeue()).toBe(2);
      expect(queue.dequeue()).toBe(1);
    });

    test('peek 应该返回队首元素但不移除', () => {
      const queue = priorityQueue<number>();
      queue.enqueue(3);
      queue.enqueue(1);
      queue.enqueue(2);

      expect(queue.peek()).toBe(1);
      expect(queue.size()).toBe(3);
      expect(queue.peek()).toBe(1);
    });

    test('size 应该返回队列大小', () => {
      const queue = priorityQueue<number>();
      expect(queue.size()).toBe(0);

      queue.enqueue(1);
      expect(queue.size()).toBe(1);

      queue.enqueue(2);
      expect(queue.size()).toBe(2);

      queue.dequeue();
      expect(queue.size()).toBe(1);
    });

    test('isEmpty 应该正确判断队列是否为空', () => {
      const queue = priorityQueue<number>();
      expect(queue.isEmpty()).toBe(true);

      queue.enqueue(1);
      expect(queue.isEmpty()).toBe(false);

      queue.dequeue();
      expect(queue.isEmpty()).toBe(true);
    });

    test('toArray 应该返回队列的数组副本', () => {
      const queue = priorityQueue<number>();
      queue.enqueue(3);
      queue.enqueue(1);
      queue.enqueue(2);

      const array = queue.toArray();
      expect(array).toEqual([1, 2, 3]);
      expect(array).not.toBe(queue.toArray());
    });

    test('clear 应该清空队列', () => {
      const queue = priorityQueue<number>();
      queue.enqueue(1);
      queue.enqueue(2);
      queue.enqueue(3);

      queue.clear();
      expect(queue.isEmpty()).toBe(true);
      expect(queue.size()).toBe(0);
      expect(queue.peek()).toBeUndefined();
    });
  });

  describe('重复元素处理', () => {
    test('默认情况下应该拒绝重复元素', () => {
      const consoleWarn = vi.spyOn(console, 'warn');
      const queue = priorityQueue<number>();

      expect(queue.enqueue(1)).toBe(true);
      expect(queue.enqueue(2)).toBe(true);
      expect(queue.enqueue(1)).toBe(false);
      expect(queue.enqueue(2)).toBe(false);

      expect(queue.size()).toBe(2);
      expect(consoleWarn).toHaveBeenCalledWith('[PriorityQueue] Duplicate item detected: 1');
      expect(consoleWarn).toHaveBeenCalledWith('[PriorityQueue] Duplicate item detected: 2');

      consoleWarn.mockRestore();
    });

    test('allowDuplicate 为 true 时应该允许重复元素', () => {
      const queue = priorityQueue<number>({ allowDuplicate: true });

      expect(queue.enqueue(1)).toBe(true);
      expect(queue.enqueue(1)).toBe(true);
      expect(queue.enqueue(1)).toBe(true);

      expect(queue.size()).toBe(3);
    });

    test('相同优先级元素应该保持 FIFO 顺序', () => {
      const queue = priorityQueue<number>({ allowDuplicate: true });

      queue.enqueue(1);
      queue.enqueue(2);
      queue.enqueue(1);
      queue.enqueue(1);
      queue.enqueue(2);

      expect(queue.dequeue()).toBe(1);
      expect(queue.dequeue()).toBe(1);
      expect(queue.dequeue()).toBe(1);
      expect(queue.dequeue()).toBe(2);
      expect(queue.dequeue()).toBe(2);
    });

    test('对象类型相同优先级应该保持 FIFO 顺序', () => {
      interface Task {
        id: number;
        priority: number;
      }

      const queue = priorityQueue<Task>({
        compare: (a, b) => a.priority - b.priority,
        allowDuplicate: true,
      });

      queue.enqueue({ id: 1, priority: 1 });
      queue.enqueue({ id: 2, priority: 2 });
      queue.enqueue({ id: 3, priority: 1 });
      queue.enqueue({ id: 4, priority: 1 });
      queue.enqueue({ id: 5, priority: 2 });

      expect(queue.dequeue()?.id).toBe(1);
      expect(queue.dequeue()?.id).toBe(3);
      expect(queue.dequeue()?.id).toBe(4);
      expect(queue.dequeue()?.id).toBe(2);
      expect(queue.dequeue()?.id).toBe(5);
    });
  });

  describe('批量操作', () => {
    test('enqueueMany 应该批量入队元素', () => {
      const queue = priorityQueue<number>();
      const results = queue.enqueueMany([3, 1, 2, 4]);

      expect(results).toEqual([true, true, true, true]);
      expect(queue.size()).toBe(4);
      expect(queue.dequeue()).toBe(1);
      expect(queue.dequeue()).toBe(2);
    });

    test('enqueueMany 应该正确处理重复元素', () => {
      const consoleWarn = vi.spyOn(console, 'warn');
      const queue = priorityQueue<number>();
      const results = queue.enqueueMany([1, 2, 1, 3, 2]);

      expect(results).toEqual([true, true, false, true, false]);
      expect(queue.size()).toBe(3);

      consoleWarn.mockRestore();
    });
  });

  describe('自定义比较函数', () => {
    test('应该支持对象类型和自定义比较', () => {
      interface Task {
        id: number;
        priority: number;
      }

      const queue = priorityQueue<Task>({
        compare: (a, b) => a.priority - b.priority,
      });

      queue.enqueue({ id: 1, priority: 3 });
      queue.enqueue({ id: 2, priority: 1 });
      queue.enqueue({ id: 3, priority: 2 });

      expect(queue.dequeue()?.id).toBe(2);
      expect(queue.dequeue()?.id).toBe(3);
      expect(queue.dequeue()?.id).toBe(1);
    });

    test('应该支持多字段比较', () => {
      interface Item {
        value: number;
        timestamp: number;
      }

      const queue = priorityQueue<Item>({
        compare: (a, b) => {
          if (a.value !== b.value) {
            return a.value - b.value;
          }
          return a.timestamp - b.timestamp;
        },
      });

      queue.enqueue({ value: 1, timestamp: 3 });
      queue.enqueue({ value: 1, timestamp: 1 });
      queue.enqueue({ value: 2, timestamp: 2 });

      expect(queue.dequeue()?.timestamp).toBe(1);
      expect(queue.dequeue()?.value).toBe(1);
      expect(queue.dequeue()?.value).toBe(2);
    });

    test('应该支持复杂对象的自定义比较', () => {
      interface Job {
        name: string;
        priority: number;
        createdAt: Date;
      }

      const queue = priorityQueue<Job>({
        compare: (a, b) => {
          if (a.priority !== b.priority) {
            return a.priority - b.priority;
          }
          return a.createdAt.getTime() - b.createdAt.getTime();
        },
        allowDuplicate: true,
      });

      const now = new Date('2024-01-01');
      queue.enqueue({ name: 'job1', priority: 2, createdAt: now });
      queue.enqueue({ name: 'job2', priority: 1, createdAt: now });
      queue.enqueue({ name: 'job3', priority: 2, createdAt: new Date('2024-01-02') });
      queue.enqueue({ name: 'job4', priority: 1, createdAt: new Date('2024-01-03') });

      expect(queue.dequeue()?.name).toBe('job2');
      expect(queue.dequeue()?.name).toBe('job4');
      expect(queue.dequeue()?.name).toBe('job1');
      expect(queue.dequeue()?.name).toBe('job3');
    });

    test('应该支持字符串属性的自定义比较', () => {
      interface User {
        name: string;
        score: number;
      }

      const queue = priorityQueue<User>({
        compare: (a, b) => {
          if (a.score !== b.score) {
            return b.score - a.score;
          }
          return a.name.localeCompare(b.name);
        },
      });

      queue.enqueue({ name: 'Alice', score: 90 });
      queue.enqueue({ name: 'Bob', score: 85 });
      queue.enqueue({ name: 'Charlie', score: 90 });
      queue.enqueue({ name: 'David', score: 85 });

      expect(queue.dequeue()?.name).toBe('Alice');
      expect(queue.dequeue()?.name).toBe('Charlie');
      expect(queue.dequeue()?.name).toBe('Bob');
      expect(queue.dequeue()?.name).toBe('David');
    });

    test('应该支持嵌套对象的自定义比较', () => {
      interface Task {
        id: number;
        meta: {
          level: number;
          urgency: number;
        };
      }

      const queue = priorityQueue<Task>({
        compare: (a, b) => {
          const aPriority = a.meta.level * 10 + a.meta.urgency;
          const bPriority = b.meta.level * 10 + b.meta.urgency;
          return bPriority - aPriority;
        },
      });

      queue.enqueue({ id: 1, meta: { level: 1, urgency: 5 } });
      queue.enqueue({ id: 2, meta: { level: 2, urgency: 3 } });
      queue.enqueue({ id: 3, meta: { level: 1, urgency: 8 } });
      queue.enqueue({ id: 4, meta: { level: 2, urgency: 1 } });

      expect(queue.dequeue()?.id).toBe(2);
      expect(queue.dequeue()?.id).toBe(4);
      expect(queue.dequeue()?.id).toBe(3);
      expect(queue.dequeue()?.id).toBe(1);
    });
  });

  describe('边界情况', () => {
    test('空队列 dequeue 应该返回 undefined', () => {
      const queue = priorityQueue<number>();
      expect(queue.dequeue()).toBeUndefined();
    });

    test('空队列 peek 应该返回 undefined', () => {
      const queue = priorityQueue<number>();
      expect(queue.peek()).toBeUndefined();
    });

    test('单个元素队列应该正常工作', () => {
      const queue = priorityQueue<number>();
      queue.enqueue(1);

      expect(queue.size()).toBe(1);
      expect(queue.peek()).toBe(1);
      expect(queue.dequeue()).toBe(1);
      expect(queue.isEmpty()).toBe(true);
    });

    test('大量元素应该保持正确性', () => {
      const queue = priorityQueue<number>({ allowDuplicate: true });
      const elements = Array.from({ length: 1000 }, () => Math.floor(Math.random() * 1000));

      elements.forEach((element) => void queue.enqueue(element));

      const sorted = [...elements].sort((a, b) => a - b);
      for (let i = 0; i < sorted.length; i++) {
        expect(queue.dequeue()).toBe(sorted[i]);
      }
      expect(queue.isEmpty()).toBe(true);
    });
  });

  describe('字符串类型', () => {
    test('应该支持字符串类型', () => {
      const queue = priorityQueue<string>();
      queue.enqueue('c');
      queue.enqueue('a');
      queue.enqueue('b');

      expect(queue.dequeue()).toBe('a');
      expect(queue.dequeue()).toBe('b');
      expect(queue.dequeue()).toBe('c');
    });

    test('应该支持字符串自定义比较', () => {
      const queue = priorityQueue<string>({
        compare: (a, b) => b.localeCompare(a),
      });
      queue.enqueue('a');
      queue.enqueue('c');
      queue.enqueue('b');

      expect(queue.dequeue()).toBe('c');
      expect(queue.dequeue()).toBe('b');
      expect(queue.dequeue()).toBe('a');
    });
  });

  describe('FIFO 顺序保证', () => {
    test('toArray 应该按照插入顺序返回相同优先级的元素', () => {
      const queue = priorityQueue<number>({ allowDuplicate: true });
      queue.enqueue(1);
      queue.enqueue(2);
      queue.enqueue(1);
      queue.enqueue(1);
      queue.enqueue(2);

      const array = queue.toArray();
      expect(array).toEqual([1, 1, 1, 2, 2]);
    });

    test('heapifyUp 应该在相同优先级时保持 FIFO 顺序', () => {
      const queue = priorityQueue<number>({ allowDuplicate: true });
      queue.enqueue(1);
      queue.enqueue(1);
      queue.enqueue(1);

      expect(queue.dequeue()).toBe(1);
      expect(queue.dequeue()).toBe(1);
      expect(queue.dequeue()).toBe(1);
    });
  });

  describe('构造函数选项处理', () => {
    test('应该正确处理 undefined 选项', () => {
      const queue = priorityQueue<number>(undefined);
      expect(queue.size()).toBe(0);
      expect(queue.isEmpty()).toBe(true);

      queue.enqueue(1);
      expect(queue.peek()).toBe(1);
    });

    test('应该正确处理空对象选项', () => {
      const queue = priorityQueue<number>({});
      expect(queue.size()).toBe(0);
      expect(queue.isEmpty()).toBe(true);

      queue.enqueue(1);
      expect(queue.peek()).toBe(1);
    });

    test('应该正确处理部分选项', () => {
      const queue = priorityQueue<number>({ allowDuplicate: true });
      expect(queue.enqueue(1)).toBe(true);
      expect(queue.enqueue(1)).toBe(true);
      expect(queue.size()).toBe(2);
    });

    test('应该正确处理异常选项', () => {
      // @ts-expect-error test
      expect(priorityQueue(null).allowDuplicate).toBe(false);
      // @ts-expect-error test
      expect(priorityQueue(0).allowDuplicate).toBe(false);
      // @ts-expect-error test
      expect(priorityQueue('123').allowDuplicate).toBe(false);
      // @ts-expect-error test
      expect(priorityQueue(true).allowDuplicate).toBe(false);
    });
  });
});
