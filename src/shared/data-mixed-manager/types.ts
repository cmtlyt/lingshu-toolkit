import type { SLOT_TYPE } from './constants';

export type SlotType = (typeof SLOT_TYPE)[keyof typeof SLOT_TYPE];

export interface InputSlotConfig<T> {
  /** 坑位位置（从1开始） */
  position: number;
  /** 定坑数据 */
  data: T;
  /** 插入模式：cover-覆盖，before-在指定位置前插入，after-在指定位置后插入 */
  insertMode?: 'cover' | 'before' | 'after';
}

/**
 * 定坑配置接口
 */
export interface SlotConfig<T> {
  /** 坑位位置（从1开始） */
  position: number;
  /** 定坑数据 */
  data: T;
  /** 定坑类型 */
  type: 'fixed' | 'insert';
  /** 插入模式：cover-覆盖，before-在指定位置前插入，after-在指定位置后插入 */
  insertMode: 'cover' | 'before' | 'after';
  /** 输入位置（用于记录原始输入的位置） */
  inputPosition: number;
}

export interface BaseDataItem<T> {
  /** 数据内容 */
  data: T;
}

/**
 * 普通数据项接口
 */
export interface PlainDataItem<T> extends BaseDataItem<T> {
  /** 是否为定坑数据 */
  isFixed: false;
  /** 数据类型 */
  type: 'plain';
}

/**
 * 定坑数据项接口
 */
export interface FixedDataItem<T> extends BaseDataItem<T> {
  /** 是否为定坑数据 */
  isFixed: true;
  /** 定坑类型 */
  type: SlotConfig<T>['type'];
}

/**
 * 混合数据项类型
 * 可以是定坑数据项或普通数据项
 */
export type MixedDataItem<T> = FixedDataItem<T> | PlainDataItem<T>;

/**
 * 构建选项接口
 */
export interface BuildOptions {
  /** 是否延迟构建，为 true 时不立即构建混合数据 */
  lazy?: boolean;
  /** 构建模式：rebuild-全量重建，patch-增量更新 */
  mode?: 'rebuild' | 'patch';
}

interface DiffEventDetailMap<T> {
  change: { mode: NonNullable<BuildOptions['mode']> | 'clear'; mixedData: MixedDataItem<T>[] };
  clear: Record<PropertyKey, never>;
}

export interface BaseEventDetail {
  name: string;
}

export type EventDetailMap<T> = {
  [K in keyof DiffEventDetailMap<T>]: BaseEventDetail & DiffEventDetailMap<T>[K];
};

export type DMMEventHandler<T, K extends keyof EventDetailMap<T>> =
  | ((event: CustomEvent<EventDetailMap<T>[K]>) => void)
  | { handleEvent: (event: CustomEvent<EventDetailMap<T>[K]>) => void };

export interface DataMixedManagerOptions<T> {
  /** 实例名称 */
  name?: string;
  /** 定坑配置数组 */
  fixedSlots?: InputSlotConfig<T>[];
  /** 普通数据列表 */
  dataList?: T[];
  /** 事件监听 */
  listener?: {
    [K in keyof EventDetailMap<T>]?: DMMEventHandler<T, K>;
  };
}
