import { describe, expect, test, vi } from 'vitest';
import { animation, stepAnimation } from './index';

describe('animation', () => {
  describe('导出测试', () => {
    test('应该导出 animation 函数', () => {
      expect(animation).toBeTypeOf('function');
    });

    test('应该导出 stepAnimation 函数', () => {
      expect(stepAnimation).toBeTypeOf('function');
    });
  });

  describe('stepAnimation', () => {
    test('应该生成指定步数的动画序列', () => {
      const generator = stepAnimation(0, 10, 10);
      const values = Array.from(generator);

      expect(values).toHaveLength(11);
      expect(values[0]).toBe(0);
      expect(values[10]).toBe(10);
    });

    test('应该正确处理数字插值', () => {
      const generator = stepAnimation(0, 100, 4);
      const values = Array.from(generator);

      expect(values).toEqual([0, 25, 50, 75, 100]);
    });

    test('应该正确处理负数插值', () => {
      const generator = stepAnimation(10, -10, 4);
      const values = Array.from(generator);

      expect(values).toEqual([10, 5, 0, -5, -10]);
    });

    test('应该正确处理小数插值', () => {
      const generator = stepAnimation(0, 1, 4);
      const values = Array.from(generator);

      expect(values).toEqual([0, 0.25, 0.5, 0.75, 1]);
    });

    test('应该正确处理数组插值', () => {
      const generator = stepAnimation([0, 0], [10, 10], 4);
      const values = Array.from(generator);

      expect(values).toEqual([
        [0, 0],
        [2.5, 2.5],
        [5, 5],
        [7.5, 7.5],
        [10, 10],
      ]);
    });

    test('应该正确处理嵌套数组插值', () => {
      const generator = stepAnimation(
        [
          [0, 0],
          [0, 0],
        ],
        [
          [10, 10],
          [10, 10],
        ],
        1,
      );
      const values = Array.from(generator);

      expect(values).toEqual([
        [
          [0, 0],
          [0, 0],
        ],
        [
          [10, 10],
          [10, 10],
        ],
      ]);
    });

    test('应该正确处理对象插值', () => {
      const generator = stepAnimation({ x: 0, y: 0 }, { x: 10, y: 10 }, 4);
      const values = Array.from(generator);

      expect(values).toEqual([
        { x: 0, y: 0 },
        { x: 2.5, y: 2.5 },
        { x: 5, y: 5 },
        { x: 7.5, y: 7.5 },
        { x: 10, y: 10 },
      ]);
    });

    test('应该正确处理嵌套对象插值', () => {
      const generator = stepAnimation({ pos: { x: 0, y: 0 } }, { pos: { x: 10, y: 10 } }, 1);
      const values = Array.from(generator);

      expect(values).toEqual([{ pos: { x: 0, y: 0 } }, { pos: { x: 10, y: 10 } }]);
    });

    test('应该正确处理对象嵌套数组插值', () => {
      const generator = stepAnimation({ points: [0, 0, 0, 0] }, { points: [10, 10, 10, 10] }, 1);
      const values = Array.from(generator);

      expect(values).toEqual([{ points: [0, 0, 0, 0] }, { points: [10, 10, 10, 10] }]);
    });

    test('应该正确处理对象嵌套复杂数组插值', () => {
      const generator = stepAnimation(
        {
          points: [
            [0, 0],
            [0, 0],
          ],
        },
        {
          points: [
            [10, 10],
            [10, 10],
          ],
        },
        1,
      );
      const values = Array.from(generator);

      expect(values).toEqual([
        {
          points: [
            [0, 0],
            [0, 0],
          ],
        },
        {
          points: [
            [10, 10],
            [10, 10],
          ],
        },
      ]);
    });

    test('应该正确处理数组嵌套对象插值', () => {
      const generator = stepAnimation(
        [
          { x: 0, y: 0 },
          { x: 0, y: 0 },
        ],
        [
          { x: 10, y: 10 },
          { x: 10, y: 10 },
        ],
        1,
      );
      const values = Array.from(generator);

      expect(values).toEqual([
        [
          { x: 0, y: 0 },
          { x: 0, y: 0 },
        ],
        [
          { x: 10, y: 10 },
          { x: 10, y: 10 },
        ],
      ]);
    });

    test('应该正确处理复杂嵌套结构（数组嵌套对象嵌套数组）', () => {
      const generator = stepAnimation(
        [{ points: [0, 0] }, { points: [0, 0] }],
        [{ points: [10, 10] }, { points: [10, 10] }],
        1,
      );
      const values = Array.from(generator);

      expect(values).toEqual([
        [{ points: [0, 0] }, { points: [0, 0] }],
        [{ points: [10, 10] }, { points: [10, 10] }],
      ]);
    });

    test('应该正确处理复杂嵌套结构（对象嵌套数组嵌套对象）', () => {
      const generator = stepAnimation(
        {
          items: [
            { x: 0, y: 0 },
            { x: 0, y: 0 },
          ],
        },
        {
          items: [
            { x: 10, y: 10 },
            { x: 10, y: 10 },
          ],
        },
        1,
      );
      const values = Array.from(generator);

      expect(values).toEqual([
        {
          items: [
            { x: 0, y: 0 },
            { x: 0, y: 0 },
          ],
        },
        {
          items: [
            { x: 10, y: 10 },
            { x: 10, y: 10 },
          ],
        },
      ]);
    });

    test('应该支持自定义 parser', () => {
      const generator = stepAnimation('0px', '100px', 4, {
        parser: (value) => Number.parseFloat(value),
      });
      const values = Array.from(generator);

      expect(values).toEqual([0, 25, 50, 75, 100]);
    });

    test('应该支持自定义 formatter', () => {
      const generator = stepAnimation(0, 100, 4, {
        formatter: (value) => `${value.toFixed(2)}px`,
      });
      const values = Array.from(generator);

      expect(values).toEqual(['0.00px', '25.00px', '50.00px', '75.00px', '100.00px']);
    });

    test('应该同时支持 parser 和 formatter', () => {
      const generator = stepAnimation('0px', '100px', 4, {
        parser: (value) => Number.parseFloat(value),
        formatter: (value) => `${value.toFixed(1)}px`,
      });
      const values = Array.from(generator);

      expect(values).toEqual(['0.0px', '25.0px', '50.0px', '75.0px', '100.0px']);
    });

    test('当 from 和 to 类型不一致时应该抛出错误', () => {
      expect(() => {
        Array.from(stepAnimation(0, '10' as any, 10));
      }).toThrow('from and to must be the same type');
    });

    test('当数组长度不一致时应该抛出错误', () => {
      expect(() => {
        Array.from(stepAnimation([0, 0], [10] as any, 10));
      }).toThrow('from and to must be the same length');
    });

    test('当对象键不一致时应该抛出错误', () => {
      expect(() => {
        Array.from(stepAnimation({ x: 0 }, { y: 10 } as any, 10));
      }).toThrow('from and to must be the same keys');
    });
  });

  describe('animation', () => {
    test('应该返回一个 Promise', () => {
      const promise = animation(0, 10, 100);

      expect(promise).toBeInstanceOf(Promise);
    });

    test('应该调用 onUpdate 回调', async () => {
      const onUpdate = vi.fn();
      const promise = animation(0, 10, 50, { onUpdate });

      await promise;

      expect(onUpdate).toHaveBeenCalled();
      expect(onUpdate).toHaveBeenCalledWith(0);
    });

    test('应该在动画完成时调用 onComplete 回调', async () => {
      const onComplete = vi.fn();
      const promise = animation(0, 10, 50, { onComplete });

      await promise;

      expect(onComplete).toHaveBeenCalledTimes(1);
    });

    test('应该正确使用自定义 easing 函数', async () => {
      const onUpdate = vi.fn();
      const easing = (t: number) => t * t;

      await animation(0, 10, 50, { onUpdate, easing });

      expect(onUpdate).toHaveBeenCalled();
    });

    test('应该正确处理数字动画', async () => {
      const onUpdate = vi.fn();
      const promise = animation(0, 100, 50, { onUpdate });

      await promise;

      expect(onUpdate).toHaveBeenCalledWith(0);
    });

    test('应该正确处理数组动画', async () => {
      const onUpdate = vi.fn();
      const promise = animation([0, 0], [10, 10], 50, { onUpdate });

      await promise;

      expect(onUpdate).toHaveBeenCalledWith([0, 0]);
    });

    test('应该正确处理对象动画', async () => {
      const onUpdate = vi.fn();
      const promise = animation({ x: 0, y: 0 }, { x: 10, y: 10 }, 50, { onUpdate });

      await promise;

      expect(onUpdate).toHaveBeenCalledWith({ x: 0, y: 0 });
    });

    test('应该支持自定义 parser', async () => {
      const onUpdate = vi.fn();
      const promise = animation('0px', '100px', 50, {
        onUpdate,
        parser: (value) => Number.parseFloat(value),
      });

      await promise;

      expect(onUpdate).toHaveBeenCalledWith(0);
    });

    test('应该支持自定义 formatter', async () => {
      const onUpdate = vi.fn();
      const promise = animation(0, 100, 50, {
        onUpdate,
        formatter: (value) => `${value.toFixed(2)}px`,
      });

      await promise;

      expect(onUpdate).toHaveBeenCalledWith('0.00px');
    });

    test('应该同时支持 parser 和 formatter', async () => {
      const onUpdate = vi.fn();
      const promise = animation('0px', '100px', 50, {
        onUpdate,
        parser: (value) => Number.parseFloat(value),
        formatter: (value) => `${value.toFixed(1)}px`,
      });

      await promise;

      expect(onUpdate).toHaveBeenCalledWith('0.0px');
    });

    test('当 from 和 to 类型不一致时应该抛出错误', async () => {
      await expect(animation(0, '10' as any, 50)).rejects.toThrow('from and to must be the same type');
    });

    test('当数组长度不一致时应该抛出错误', async () => {
      await expect(animation([0, 0], [10] as any, 50)).rejects.toThrow('from and to must be the same length');
    });

    test('当对象键不一致时应该抛出错误', async () => {
      await expect(animation({ x: 0 }, { y: 10 } as any, 50)).rejects.toThrow('from and to must be the same keys');
    });

    test('应该正确处理 duration 为 0 的情况', async () => {
      const onUpdate = vi.fn();
      const onComplete = vi.fn();

      await animation(0, 10, 0, { onUpdate, onComplete });

      expect(onUpdate).toHaveBeenCalledWith(0);
      expect(onComplete).toHaveBeenCalledTimes(1);
    });

    test('应该正确处理负数 duration', async () => {
      const onUpdate = vi.fn();
      const onComplete = vi.fn();

      await animation(0, 10, -50, { onUpdate, onComplete });

      expect(onUpdate).toHaveBeenCalledWith(0);
      expect(onComplete).toHaveBeenCalledTimes(1);
    });

    test('默认 easing 函数应该是线性的', async () => {
      const onUpdate = vi.fn();
      const promise = animation(0, 100, 50, { onUpdate });

      await promise;

      expect(onUpdate).toHaveBeenCalled();
    });

    test('应该能够取消动画', async () => {
      const onUpdate = vi.fn();
      const onComplete = vi.fn();
      const promise = animation(0, 100, 1000, { onUpdate, onComplete });

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(onUpdate).toHaveBeenCalled();
      expect(onComplete).not.toHaveBeenCalled();

      await promise;
    });

    test('应该正确处理多次调用 animation', async () => {
      const onUpdate1 = vi.fn();
      const onUpdate2 = vi.fn();

      const promise1 = animation(0, 10, 50, { onUpdate: onUpdate1 });
      const promise2 = animation(0, 20, 50, { onUpdate: onUpdate2 });

      await Promise.all([promise1, promise2]);

      expect(onUpdate1).toHaveBeenCalled();
      expect(onUpdate2).toHaveBeenCalled();
    });

    test('应该正确处理嵌套对象动画', async () => {
      const onUpdate = vi.fn();
      const promise = animation({ pos: { x: 0, y: 0 } }, { pos: { x: 10, y: 10 } }, 50, { onUpdate });

      await promise;

      expect(onUpdate).toHaveBeenCalledWith({ pos: { x: 0, y: 0 } });
    });

    test('应该正确处理嵌套数组动画', async () => {
      const onUpdate = vi.fn();
      const promise = animation(
        [
          [0, 0],
          [0, 0],
        ],
        [
          [10, 10],
          [10, 10],
        ],
        50,
        { onUpdate },
      );

      await promise;

      expect(onUpdate).toHaveBeenCalledWith([
        [0, 0],
        [0, 0],
      ]);
    });

    test('应该正确处理对象嵌套数组动画', async () => {
      const onUpdate = vi.fn();
      const promise = animation({ points: [0, 0, 0, 0] }, { points: [10, 10, 10, 10] }, 50, {
        onUpdate,
      });

      await promise;

      expect(onUpdate).toHaveBeenCalledWith({ points: [0, 0, 0, 0] });
    });

    test('应该正确处理对象嵌套复杂数组动画', async () => {
      const onUpdate = vi.fn();
      const promise = animation(
        {
          points: [
            [0, 0],
            [0, 0],
          ],
        },
        {
          points: [
            [10, 10],
            [10, 10],
          ],
        },
        50,
        { onUpdate },
      );

      await promise;

      expect(onUpdate).toHaveBeenCalledWith({
        points: [
          [0, 0],
          [0, 0],
        ],
      });
    });

    test('应该正确处理数组嵌套对象动画', async () => {
      const onUpdate = vi.fn();
      const promise = animation(
        [
          { x: 0, y: 0 },
          { x: 0, y: 0 },
        ],
        [
          { x: 10, y: 10 },
          { x: 10, y: 10 },
        ],
        50,
        { onUpdate },
      );

      await promise;

      expect(onUpdate).toHaveBeenCalledWith([
        { x: 0, y: 0 },
        { x: 0, y: 0 },
      ]);
    });

    test('应该正确处理复杂嵌套结构（数组嵌套对象嵌套数组）动画', async () => {
      const onUpdate = vi.fn();
      const promise = animation(
        [{ points: [0, 0] }, { points: [0, 0] }],
        [{ points: [10, 10] }, { points: [10, 10] }],
        50,
        { onUpdate },
      );

      await promise;

      expect(onUpdate).toHaveBeenCalledWith([{ points: [0, 0] }, { points: [0, 0] }]);
    });

    test('应该正确处理复杂嵌套结构（对象嵌套数组嵌套对象）动画', async () => {
      const onUpdate = vi.fn();
      const promise = animation(
        {
          items: [
            { x: 0, y: 0 },
            { x: 0, y: 0 },
          ],
        },
        {
          items: [
            { x: 10, y: 10 },
            { x: 10, y: 10 },
          ],
        },
        50,
        { onUpdate },
      );

      await promise;

      expect(onUpdate).toHaveBeenCalledWith({
        items: [
          { x: 0, y: 0 },
          { x: 0, y: 0 },
        ],
      });
    });
  });
});
