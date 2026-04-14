import { describe, expect, test, vi } from 'vitest';
import { dataMixedManager } from '../index';

describe('dataMixedManager - 边界情况', () => {
  let manager: ReturnType<typeof dataMixedManager<number>>;

  test('定坑位置为 0', () => {
    manager = dataMixedManager<number>();
    manager.appendList([1, 2, 3]);
    manager.addFixedSlot({ position: 0, data: 100 });
    const mixedData = manager.getMixedData();
    expect(mixedData).toHaveLength(3);
  });

  test('定坑位置超出范围', () => {
    manager = dataMixedManager<number>();
    manager.appendList([1, 2, 3]);
    manager.addFixedSlot({ position: 10, data: 100 });
    const mixedData = manager.getMixedData();
    expect(mixedData).toHaveLength(3);
  });

  test('多个定坑位置相同', () => {
    manager = dataMixedManager<number>();
    // 先添加定坑配置，由于没有数据，不会触发构建
    manager.addFixedSlot({ position: 2, data: 100 });
    manager.addFixedSlot({ position: 2, data: 200 });
    // 第二次添加时，由于没有 insertMode，会覆盖第一个
    // 再添加数据，appendList 会触发构建
    // 由于 prevDataLength = 0，会全量构建，定坑会被插入
    manager.appendList([1, 2, 3]);
    const mixedData = manager.getMixedData();
    expect(mixedData).toHaveLength(4);
    expect(mixedData[0]).toEqual({ isFixed: false, type: 'plain', data: 1 });
    expect(mixedData[1]).toEqual({ isFixed: false, type: 'plain', data: 2 });
    expect(mixedData[2]).toEqual({ isFixed: true, type: 'fixed', data: 200 });
    expect(mixedData[3]).toEqual({ isFixed: false, type: 'plain', data: 3 });
  });

  test('连续定坑位置', () => {
    manager = dataMixedManager<number>();
    manager.addFixedSlots([
      { position: 2, data: 100 },
      { position: 3, data: 200 },
      { position: 4, data: 300 },
    ]);
    manager.appendList([1, 2, 3, 4, 5]);
    const mixedData = manager.getMixedData();
    // [1, 100, 200, 300, 2, 3, 4, 5]
    expect(mixedData).toHaveLength(8);
  });

  test('空数据管理器', () => {
    manager = dataMixedManager<number>();
    const mixedData = manager.getMixedData();
    expect(mixedData).toHaveLength(0);
  });

  test('插卡空数组', () => {
    const change = vi.fn();
    manager = dataMixedManager<number>({ listener: { change } });
    manager.appendList([1, 2, 3]);
    expect(change).toHaveBeenCalledOnce();
    const positions = manager.insertSlots([]);
    expect(positions).toEqual([]);
    const mixedData = manager.getMixedData();
    expect(mixedData).toHaveLength(3);
    expect(change).toHaveBeenCalledOnce();
  });

  test('插卡位置大于已处理的混合数据, 然后添加数据到插卡位置', () => {
    const change = vi.fn();
    manager = dataMixedManager<number>({ listener: { change } });
    manager.appendList([1, 2, 3]);
    expect(change).toHaveBeenCalledTimes(1);
    // 插卡位置 5 大于已处理的混合数据长度 (3)
    // 由于 position > mixedData.length，等同于定坑，不会触发全量重建
    const position = manager.insertSlot({ position: 5, data: 100, insertMode: 'before' });
    expect(position).toBe(5);
    expect(change).toHaveBeenCalledTimes(1);
    const firstData = manager.getMixedData();
    // 插卡位置超出范围，不会被插入
    expect(firstData).toHaveLength(3);
    // 添加数据到插卡位置
    manager.appendList([4, 5, 6]);
    expect(change).toHaveBeenCalledTimes(2);
    const secondData = manager.getMixedData();
    expect(change).toHaveBeenCalledTimes(2);
    // 现在数据长度为 6，插卡位置 5 在范围内，会被插入
    expect(secondData).toHaveLength(7);
    expect(secondData[0]).toEqual({ isFixed: false, type: 'plain', data: 1 });
    expect(secondData[1]).toEqual({ isFixed: false, type: 'plain', data: 2 });
    expect(secondData[2]).toEqual({ isFixed: false, type: 'plain', data: 3 });
    expect(secondData[3]).toEqual({ isFixed: false, type: 'plain', data: 4 });
    expect(secondData[4]).toEqual({ isFixed: false, type: 'plain', data: 5 });
    expect(secondData[5]).toEqual({ isFixed: true, type: 'insert', data: 100 });
    expect(secondData[6]).toEqual({ isFixed: false, type: 'plain', data: 6 });
  });

  test('构造函数监听事件不合法, 应报错', () => {
    expect(() =>
      dataMixedManager<number>({
        listener: {
          invalidEvent: () => {},
          // @ts-expect-error 传入不合法的类型
          change: 1,
        },
      }),
    ).toThrow(TypeError);
  });
});
