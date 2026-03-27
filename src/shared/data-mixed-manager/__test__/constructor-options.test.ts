import { describe, expect, test, vi } from 'vitest';
import { dataMixedManager } from '../index';

describe('dataMixedManager - 构造函数选项', () => {
  let manager: ReturnType<typeof dataMixedManager<number>>;

  test('通过构造函数初始化定坑配置', () => {
    manager = dataMixedManager<number>({
      fixedSlots: [
        { position: 1, data: 100 },
        { position: 2, data: 200 },
      ],
    });
    // 没有普通数据时，定坑数据不会显示
    const mixedData = manager.getMixedData();
    expect(mixedData).toHaveLength(0);
  });

  test('通过构造函数初始化普通数据', () => {
    manager = dataMixedManager<number>({
      dataList: [1, 2, 3],
    });
    // 构造函数中的 appendList 不会触发构建（lazy !== false）
    // 需要通过 getMixedData() 触发构建
    const mixedData = manager.getMixedData();
    expect(mixedData).toHaveLength(3);
    expect(mixedData[0]).toEqual({ isFixed: false, type: 'plain', data: 1 });
    expect(mixedData[1]).toEqual({ isFixed: false, type: 'plain', data: 2 });
    expect(mixedData[2]).toEqual({ isFixed: false, type: 'plain', data: 3 });
  });

  test('通过构造函数初始化事件监听', () => {
    const changeHandler = vi.fn();
    manager = dataMixedManager<number>({
      listener: {
        change: changeHandler,
      },
    });
    // 构造函数中的 appendList 不会触发事件
    manager.appendList([1, 2, 3]);
    // 需要通过 getMixedData() 触发构建和事件
    manager.getMixedData();
    expect(changeHandler).toHaveBeenCalledTimes(1);
  });

  test('通过构造函数初始化所有选项', () => {
    const changeHandler = vi.fn();
    manager = dataMixedManager<number>({
      name: 'test-manager',
      fixedSlots: [{ position: 2, data: 100 }],
      dataList: [1, 2, 3],
      listener: {
        change: changeHandler,
      },
    });
    // 构造函数中的 addFixedSlots(lazy: true) 不会触发构建
    // appendList 会触发构建（因为 lazy 为 false）
    // 由于 prevDataLength = 0，会全量构建，定坑会被插入
    const mixedData = manager.getMixedData();
    // [1, 2, 100, 3] (定坑位置基于混合结果)
    expect(mixedData).toHaveLength(4);
    expect(mixedData[0]).toEqual({ isFixed: false, type: 'plain', data: 1 });
    expect(mixedData[1]).toEqual({ isFixed: false, type: 'plain', data: 2 });
    expect(mixedData[2]).toEqual({ isFixed: true, type: 'fixed', data: 100 });
    expect(mixedData[3]).toEqual({ isFixed: false, type: 'plain', data: 3 });
    // 构造函数初始化时不会触发 change 事件
    expect(changeHandler).toHaveBeenCalledTimes(0);
    manager.appendList([4, 5, 6]);
    expect(changeHandler).toHaveBeenCalledTimes(1);
    expect(changeHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({
          name: 'test-manager',
          mode: 'patch',
        }),
      }),
    );
  });

  test('默认 name 为 default', () => {
    const changeHandler = vi.fn();
    manager = dataMixedManager<number>({
      listener: {
        change: changeHandler,
      },
    });
    manager.appendList([1, 2, 3]);
    expect(changeHandler).toHaveBeenCalledTimes(1);
    const event = changeHandler.mock.calls[0][0] as CustomEvent<{ name: string; mixedData: any[] }>;
    expect(event.detail.name).toBe('default');
  });
});
