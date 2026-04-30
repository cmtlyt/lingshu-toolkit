/**
 * 权威副本存储格式序列化
 *
 * 对应 RFC.md「存储格式（固化契约）」章节。
 *
 * 固化字段顺序：`rev → ts → epoch → snapshot`
 *
 * 固化理由：
 * 1. `JSON.stringify({ rev, ts, epoch, snapshot })` 在 JS 规范上不保证字段顺序
 *    （V8 / SpiderMonkey 实测按插入顺序，但不作为契约），手动拼接避免任何引擎差异
 * 2. `rev` 固定首位：`extractRev` 用锚定开头的正则即可安全提取，不被 snapshot 内容干扰
 * 3. `epoch` 固定在 snapshot 之前：`extractEpoch` 在小范围内匹配，快路径开销与 value 总长无关
 * 4. `snapshot` 固定尾部：用户数据可能包含 `"rev"` / `"epoch"` 等字面量，放在尾部避免正则锚定出错
 *
 * snapshot 的序列化统一走 `JSON.stringify`，不做字段顺序保证（snapshot 内部由用户控制）
 */

interface AuthoritySerializedParts {
  readonly rev: number;
  readonly ts: number;
  readonly epoch: string;
  readonly snapshot: unknown;
}

/**
 * 序列化权威副本 value
 *
 * 产物形如：`{"rev":42,"ts":1714198800123,"epoch":"ab12...","snapshot":{...}}`
 *
 * @param rev 单调递增版本号
 * @param ts 写入时间戳（ms，来自 `Date.now()`）
 * @param epoch 会话纪元；`persistence === 'persistent'` 时固定为 `'persistent'`，否则为 UUID 字符串
 * @param snapshot 用户数据快照；由调用方保证已通过 `adapters.clone` 深克隆
 */
function serializeAuthority(rev: number, ts: number, epoch: string, snapshot: unknown): string {
  return `{"rev":${rev},"ts":${ts},"epoch":${JSON.stringify(epoch)},"snapshot":${JSON.stringify(snapshot)}}`;
}

export type { AuthoritySerializedParts };
export { serializeAuthority };
