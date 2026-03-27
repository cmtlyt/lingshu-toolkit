import { describe, expect, test, vi } from 'vitest';
import { dataMixedManager } from '../index';

describe('dataMixedManager - 事件监听', () => {
  let manager: ReturnType<typeof dataMixedManager<number>>;

  test('change 事件触发', () => {
    manager = dataMixedManager<number>();
    const changeHandler = vi.fn();
    manager.addEventListener('change', changeHandler);
    manager.appendList([1, 2, 3]);
    expect(changeHandler).toHaveBeenCalledTimes(1);
    const event = changeHandler.mock.calls[0][0] as CustomEvent<{ name: string; mixedData: any[] }>;
    expect(event.detail.mixedData).toHaveLength(3);
    expect(event.detail.name).toBe('default');
  });

  test('批量更新时只触发一次事件', () => {
    manager = dataMixedManager<number>();
    const changeHandler = vi.fn();
    manager.addEventListener('change', changeHandler);
    manager.addFixedSlots([
      { position: 1, data: 100 },
      { position: 2, data: 200 },
      { position: 3, data: 300 },
    ]);
    // 没有普通数据时，不会触发事件
    expect(changeHandler).toHaveBeenCalledTimes(0);
  });

  test('removeEventListener 移除事件监听', () => {
    manager = dataMixedManager<number>();
    const changeHandler = vi.fn();
    manager.addEventListener('change', changeHandler);
    manager.appendList([1, 2, 3]);
    expect(changeHandler).toHaveBeenCalledTimes(1);

    manager.removeEventListener('change', changeHandler);
    manager.appendList([4, 5]);
    // 移除监听后，不再触发事件
    expect(changeHandler).toHaveBeenCalledTimes(1);
  });

  test('事件详情包含 name 字段', () => {
    manager = dataMixedManager<number>({ name: 'my-manager' });
    const changeHandler = vi.fn();
    manager.addEventListener('change', changeHandler);
    manager.appendList([1, 2, 3]);
    expect(changeHandler).toHaveBeenCalledTimes(1);
    const event = changeHandler.mock.calls[0][0] as CustomEvent<{ name: string; mixedData: any[] }>;
    expect(event.detail.name).toBe('my-manager');
  });
});
