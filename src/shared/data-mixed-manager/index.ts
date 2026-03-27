import { $dt, $t, dataHandler } from '@/shared/data-handler';
import type { PickRequired } from '@/shared/types/base';
import { throwError } from '../throw-error';
import { SLOT_TYPE } from './constants';
import type {
  BaseEventDetail,
  BuildOptions,
  DataMixedManagerOptions,
  DMMEventHandler,
  EventDetailMap,
  InputSlotConfig,
  MixedDataItem,
  SlotConfig,
  SlotType,
} from './types';

const validInfo = $dt({
  name: $t.string('default'),
  fixedSlots: $t.array([]),
  dataList: $t.array([]),
  listener: $t.object({}),
});

/**
 * 通用数据管理器类
 * 支持定坑逻辑处理，不包含具体业务逻辑
 *
 * @template T - 数据类型
 */
class DataMixedManager<T> extends EventTarget {
  addEventListener<E extends keyof EventDetailMap<T>>(
    type: E,
    listener: DMMEventHandler<T, E> | null,
    options?: AddEventListenerOptions | boolean,
  ): void;
  addEventListener(...args: any[]) {
    return super.addEventListener.apply(this, args as any);
  }

  removeEventListener<E extends keyof EventDetailMap<T>>(
    type: E,
    listener: DMMEventHandler<T, E> | null,
    options?: EventListenerOptions | boolean,
  ): void;
  removeEventListener(...args: any[]) {
    return super.removeEventListener.apply(this, args as any);
  }

  /** 实例配置 */
  private readonly options: Required<DataMixedManagerOptions<T>>;
  /** 位置到定坑配置的映射 */
  private readonly fixedSlots: Map<number, SlotConfig<T>> = new Map();
  /** 普通数据列表 */
  private readonly dataList: T[] = [];
  /** 混合后的数据 */
  private readonly mixedData: MixedDataItem<T>[] = [];
  /** 最后混合的定坑位置 */
  private lastMixedSlotIdx = -1;
  /** 上次处理的数据长度 */
  private prevDataLength = 0;
  /** 是否正在批量更新 */
  private isBatching = false;

  constructor(options?: DataMixedManagerOptions<T>) {
    super();

    const validOptions = dataHandler(options || {}, validInfo, { unwrap: true });
    const { fixedSlots, dataList, listener } = validOptions;
    this.options = validOptions;

    this.addFixedSlots(fixedSlots, { lazy: true });
    this.appendList(dataList);
    try {
      this.initListener(listener);
    } catch (error) {
      throwError('dataMixedManager', (error as Error).message, (error as Error).constructor as ErrorConstructor);
    }
  }

  /**
   * 初始化事件监听
   * @param listener - 事件监听
   */
  private initListener(listener: NonNullable<DataMixedManagerOptions<T>['listener']>) {
    const listenerNames = Object.keys(listener) as (keyof EventDetailMap<T>)[];

    for (
      let i = 0, name = listenerNames[i], handler = listener[name];
      i < listenerNames.length;
      name = listenerNames[++i], handler = listener[name]
    ) {
      this.addEventListener(name, handler as any);
    }
  }

  // @ts-expect-error ignore
  private getTypeText(_type: SlotType): SlotConfig<T>['type'] {
    // biome-ignore lint/style/useDefaultSwitchClause: ignore
    switch (_type) {
      case SLOT_TYPE.fixed:
        return 'fixed';
      case SLOT_TYPE.insert:
        return 'insert';
    }
  }

  private buildSlotConfig(config: InputSlotConfig<T>, type: SlotType) {
    // @ts-expect-error insertSlot 会预先构建好完整的 SlotConfig, 但是因为底层调用了 addFixedSlot, 所以应该预先读取 type, 否则会被传入的 type 覆盖类型
    const typeText = this.getTypeText(config.type || type);
    return {
      ...config,
      type: typeText,
      inputPosition: config.position,
      insertMode: config.insertMode || 'cover',
    };
  }

  /**
   * 添加定坑配置
   * @param config - 定坑配置
   * @param buildOptions - 构建选项
   * @returns 返回添加后的定坑位置
   */
  addFixedSlot(config: InputSlotConfig<T>, buildOptions?: BuildOptions) {
    const realConfig = this.reorderFixedSlots(this.buildSlotConfig(config, SLOT_TYPE.fixed));
    this.fixedSlots.set(realConfig.position, realConfig);
    this.buildMixedData(buildOptions);
    return realConfig.position;
  }

  /**
   * 重新排序定坑位置
   * 当插入模式为 before 或 after 时，需要调整后续定坑的位置
   * @param config - 定坑配置
   * @returns 返回调整后的定坑配置
   */
  private reorderFixedSlots(config: SlotConfig<T>): SlotConfig<T> {
    const { position: oldPosition, insertMode } = config;
    if (insertMode == null || insertMode === 'cover' || !this.fixedSlots.has(oldPosition)) {
      return { ...config, inputPosition: oldPosition };
    }
    const position = insertMode === 'after' ? oldPosition + 1 : oldPosition;

    for (
      let i = position + 1, preItem = this.fixedSlots.get(i - 1), currItem = this.fixedSlots.get(i);
      preItem;
      ++i, preItem = currItem, currItem = this.fixedSlots.get(i)
    ) {
      preItem.position = i;
      this.fixedSlots.set(i, preItem);
    }

    return { ...config, position, inputPosition: oldPosition };
  }

  /**
   * 批量添加定坑配置
   * @param configs - 定坑配置数组
   * @param buildOptions - 构建选项
   * @returns 返回添加后的定坑位置数组
   */
  addFixedSlots(configs: InputSlotConfig<T>[], buildOptions?: BuildOptions) {
    if (!configs.length) {
      return [];
    }
    const positions = this.batchUpdate(() => configs.map((config) => this.addFixedSlot(config)));
    this.buildMixedData(buildOptions);
    return positions;
  }

  /**
   * 移除指定位置的定坑配置
   * @param position - 要移除的定坑位置
   * @param buildOptions - 构建选项
   */
  deleteFixedSlot(position: number, buildOptions?: BuildOptions) {
    this.fixedSlots.delete(position);
    this.buildMixedData(buildOptions);
  }

  /**
   * 批量移除定坑配置
   * @param positions - 要移除的定坑位置数组
   * @param buildOptions - 构建选项
   */
  deleteFixedSlots(positions: number[], buildOptions?: BuildOptions) {
    if (!positions.length) {
      return;
    }
    this.batchUpdate(() => positions.forEach((position) => void this.deleteFixedSlot(position)));
    this.buildMixedData(buildOptions);
  }

  /**
   * 批量更新
   * @param callback - 更新回调
   */
  private batchUpdate<R>(callback: () => R): R {
    try {
      this.isBatching = true;
      const result = callback();
      return result;
    } finally {
      this.isBatching = false;
    }
  }

  /**
   * 清除所有定坑配置
   * @param buildOptions - 构建选项
   */
  clearFixedSlots(buildOptions?: BuildOptions) {
    this.fixedSlots.clear();
    this.buildMixedData(buildOptions);
  }

  /**
   * 追加新的数据列表到普通数据列表末尾
   * @param list - 要追加的数据数组
   * @param buildOptions - 构建选项，lazy 为 true 时延迟构建
   */
  appendList(list: T[], buildOptions?: BuildOptions) {
    if (!list.length) {
      return;
    }
    this.dataList.push(...list);
    this.buildMixedData({ ...buildOptions, lazy: (buildOptions || {}).lazy === true });
  }

  /**
   * 清空普通数据列表
   */
  clearList() {
    this.dataList.length = 0;
    this.mixedData.length = 0;
    this.dispatch('change', { mode: 'clear', mixedData: this.getMixedData({ mode: 'rebuild' }) });
    this.dispatch('clear');
  }

  /**
   * 获取混合后的数据
   * @param buildOptions - 构建选项
   * @returns 返回混合后的数据项数组
   */
  getMixedData(buildOptions?: Omit<BuildOptions, 'lazy'>): MixedDataItem<T>[] {
    this.buildMixedData({ ...buildOptions, lazy: false });
    return this.mixedData.slice();
  }

  /**
   * 分发事件
   * 同时在实例和 window 对象上触发事件
   * @param name - 事件名称
   * @param data - 事件数据
   */
  private dispatch<E extends keyof EventDetailMap<T>>(
    name: E,
    data?: Omit<EventDetailMap<T>[E], keyof BaseEventDetail>,
  ) {
    const detail = { name: this.options.name, ...data } as EventDetailMap<T>[E];
    this.dispatchEvent(new CustomEvent(name, { detail }));
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(`[DMM]:${name}`, { detail }));
    }
  }

  /**
   * 重新构建混合数据
   * 全局定坑：定坑位置始终固定在全局位置，普通数据在定坑位置之外填充
   * 定坑位置不会因为普通数据的变化而改变
   */
  private buildMixedData(buildOptions?: BuildOptions) {
    if (this.isBatching) {
      return;
    }
    const { lazy, mode } = buildOptions || {};
    // 重新混入的话重置索引
    if (mode === 'rebuild') {
      this.prevDataLength = 0;
      this.lastMixedSlotIdx = -1;
    }
    if (
      // lazy 模式直接跳过
      lazy !== false ||
      // 已处理的数据数量等于或超过数据列表数量
      this.dataList.length <= this.prevDataLength
    ) {
      return;
    }

    // 上一次原始数据的下标
    let dataStartIdx = this.prevDataLength;
    // 本次原始数据的目标下标
    const dataEndIdx = this.dataList.length;
    const newItemCount = dataEndIdx - dataStartIdx;
    // 保存本次原始数据的数量
    this.prevDataLength = dataEndIdx;

    const isPatchMode = dataStartIdx > 0;

    // 过滤出本次混合数据需要的定坑位置 (升序)
    const filteredSlots = this.sliceSlots(
      // patch 模式使用已混合数据的长度, 否则从头开始
      isPatchMode ? this.mixedData.length : this.lastMixedSlotIdx,
      this.mixedData.length + newItemCount,
    );
    // 可能为 0 所以用 ??
    this.lastMixedSlotIdx = filteredSlots.at(-1) ?? this.lastMixedSlotIdx;

    // 计算本次混合数据的起始下标, 如果上一次处理完之后下标为 0, 则代表需要全量重新混合数据, 重置起始下标
    let mixedStartIdx = isPatchMode ? this.mixedData.length : 0;
    // 预分配数组长度, 每次 push 会频繁扩容引发性能问题
    this.mixedData.length = (isPatchMode ? newItemCount + mixedStartIdx : dataEndIdx) + filteredSlots.length;

    for (
      let fpIdx = 0, fpItem = filteredSlots[fpIdx];
      // 原始数据需要全遍历
      dataStartIdx < dataEndIdx;
      // 写入下标需要每次累加
      ++mixedStartIdx
    ) {
      // 定坑跟插卡的下标应该基于混入结果稳定
      if (mixedStartIdx === fpItem) {
        const fixedSlot = this.fixedSlots.get(fpItem)!;
        this.mixedData[mixedStartIdx] = { isFixed: true, type: fixedSlot.type, data: fixedSlot.data };
        fpItem = filteredSlots[++fpIdx];
      } else {
        this.mixedData[mixedStartIdx] = { isFixed: false, type: 'plain', data: this.dataList[dataStartIdx] };
        ++dataStartIdx;
      }
    }

    this.dispatch('change', { mode: isPatchMode ? 'patch' : 'rebuild', mixedData: this.mixedData.slice() });
  }

  /**
   * 切片获取指定范围内的定坑位置
   * @param startIdx - 起始位置
   * @param endIdx - 结束位置，默认为正无穷
   * @returns 返回过滤后的定坑位置数组
   */
  private sliceSlots(startIdx: number, endIdx: number = Number.POSITIVE_INFINITY) {
    // -2 开始是为了过滤 0 的情况
    let prevItem = -2;
    let count = 0;
    return Array.from(this.fixedSlots.keys())
      .sort((ai, bi) => ai - bi)
      .filter((item) => {
        if (
          // 输入的 endIdx 应该根据需要添加的定坑数据进行修订, 保证数据混合后定坑位置稳定
          (item >= startIdx && item < endIdx + count) ||
          // 超范围后需要追加连续坑位, 保证增量更新数据一致性
          item - 1 === prevItem
        ) {
          ++count;
          prevItem = item;
          return true;
        }
        return false;
      });
  }

  /**
   * 插入数据（插卡模式）
   * 在指定位置插入数据，会触发全量重建
   * @param config - 定坑配置，必须指定插入模式
   * @returns 返回插入后的实际位置
   */
  insertSlot(config: PickRequired<InputSlotConfig<T>, 'insertMode'>) {
    // @ts-expect-error 这边需要指定 symbol type, 否则会被 addFixedSlot 覆盖类型
    const realPosition = this.addFixedSlot({ ...config, type: SLOT_TYPE.insert });
    // 插卡位置大于已混合的, 等同定坑
    if (realPosition > this.mixedData.length) {
      return realPosition;
    }

    // 插卡因为会直接更新已混合的数组, 所以直接进行全量更新, 防止因长度变动导致的增量更新数据不一致
    this.buildMixedData({ lazy: false, mode: 'rebuild' });
    return realPosition;
  }

  insertSlots(configs: PickRequired<InputSlotConfig<T>, 'insertMode'>[]) {
    if (!configs.length) {
      return [];
    }
    const positions = this.batchUpdate(() => configs.map((config) => this.insertSlot(config)));
    this.buildMixedData({ lazy: false, mode: 'rebuild' });
    return positions;
  }
}

/**
 * 创建数据管理器实例的工厂函数
 * @template T - 数据类型
 * @returns 返回一个新的 DataMixedManager 实例
 */
export function dataMixedManager<T>(options?: DataMixedManagerOptions<T>) {
  return new DataMixedManager<T>(options);
}
