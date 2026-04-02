import { describe, expect, test } from 'vitest';
import { allx } from '../index';

describe('allx - 类型和接口测试', () => {
  test('验证返回值类型保持一致', async () => {
    const result = await allx({
      string: async () => 'test' as const,
      number: async () => 42 as const,
      boolean: async () => true as const,
    });

    // TypeScript 类型检查
    const _stringCheck: 'test' = result.string;
    const _numberCheck: 42 = result.number;
    const _booleanCheck: true = result.boolean;

    expect(result.string).toBe('test');
    expect(result.number).toBe(42);
    expect(result.boolean).toBe(true);
  });

  test('options 参数（当前为空）', async () => {
    const result = await allx(
      {
        task: async () => 'value',
      },
      {},
    );

    expect(result).toEqual({ task: 'value' });
  });
});
