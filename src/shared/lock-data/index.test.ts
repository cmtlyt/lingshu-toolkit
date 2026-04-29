import { describe, expect, test } from 'vitest';
import { lockData } from './index';

describe('lockData', () => {
  test('导出测试', () => {
    expect(lockData).toBeTypeOf('function');
  });
});
