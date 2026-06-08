export interface HistoryTreeOptions<T> {
  /** 初始数据，将作为根节点（v0）的存储数据 */
  initialData: T;

  /**
   * 自定义节点 id 生成函数
   * 每次创建新节点时调用，返回值作为节点 id
   * 调用方需自行保证返回值的唯一性
   *
   * @default 内置自增数字转字符串（"0", "1", "2", ...）
   */
  generateId?: () => string;
}

export interface HistoryNodeInfo<T> {
  /** 节点唯一标识 */
  readonly id: string;

  /** 节点存储的数据 */
  readonly data: T;

  /** 父节点 id，根节点为 null */
  readonly parentId: string | null;

  /** 子节点 id 列表 */
  readonly childrenIds: readonly string[];
}

export interface HistoryTreeSnapshot<T> {
  /** 根节点 id */
  readonly rootId: string;

  /** 当前节点 id */
  readonly currentId: string;

  /** 所有节点信息，key 为节点 id */
  readonly nodes: Readonly<Record<string, HistoryNodeInfo<T>>>;
}

export interface HistoryTree<T> {
  /**
   * 提交新数据，在当前节点下创建子节点，并将指针移到新节点
   * 框架原样存储 data，不做任何处理
   *
   * @returns 新创建的节点 id
   */
  commit: (data: T) => string;

  /**
   * 切换当前指针到指定节点
   * 切换后可继续 commit 创建新分支
   *
   * @throws 节点不存在时抛出错误
   */
  checkout: (nodeId: string) => void;

  /**
   * 获取当前节点到根节点路径上所有节点的存储数据
   * 返回有序列表：[当前节点数据, 父节点数据, ..., 根节点数据]
   */
  getPathData: () => T[];

  /** 获取当前节点信息 */
  getCurrentNode: () => HistoryNodeInfo<T>;

  /**
   * 获取指定节点信息
   *
   * @throws 节点不存在时抛出错误
   */
  getNode: (nodeId: string) => HistoryNodeInfo<T>;

  /** 获取根节点信息 */
  getRoot: () => HistoryNodeInfo<T>;

  /** 获取整棵树的快照，包含所有节点信息、根节点 id 和当前节点 id */
  getSnapshot: () => HistoryTreeSnapshot<T>;

  /**
   * 注册变更监听器，当 commit / checkout 导致树状态变化时触发
   * 回调参数为最新的快照
   *
   * @returns 取消订阅函数
   */
  onChange: (listener: (snapshot: HistoryTreeSnapshot<T>) => void) => () => void;

  /** 获取当前节点的 id */
  readonly currentId: string;

  /** 获取当前节点的存储数据（getter） */
  readonly currentData: T;

  /** 获取当前节点的父节点存储数据（getter），根节点无父节点时返回 null */
  readonly parentData: T | null;

  /** 获取树中所有节点的数量（getter，代理内部 nodes Map 的 size） */
  readonly size: number;
}
