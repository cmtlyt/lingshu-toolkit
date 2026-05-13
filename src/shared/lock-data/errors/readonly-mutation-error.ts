/**
 * 直接修改 `readonly` 视图时抛出
 *
 * 归类为 TypeError 的原因：与原生对 frozen 对象写入时的规范语义对齐，
 * 便于业务代码用同一种 catch 分支处理"写入被阻止"类错误
 * 对应 RFC.md「错误类型」章节
 */
class ReadonlyMutationError extends TypeError {
  constructor(message?: string) {
    super(message);
    this.name = 'ReadonlyMutationError';
  }
}

export { ReadonlyMutationError };
