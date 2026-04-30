/**
 * 权威副本 Lazy Parse 快路径
 *
 * 对应 RFC.md「Lazy Parse 快路径」章节。
 *
 * 设计动机：
 * - 高频 `storage` 事件（尤其同 Tab 频繁 commit 时）绝大多数命中"rev 未变"快路径
 * - 避免对 MB 级 snapshot 反复 `JSON.parse`
 * - `persistence: 'session'` 下 epoch 不匹配时同样走快路径直接丢弃，不误应用上一会话组数据
 *
 * 两条快路径：
 * 1. `extractRev`：正则锚定开头匹配 `{"rev":<整数>`，失败走全量 parse 兜底
 * 2. `extractEpoch`：正则匹配 `,"epoch":"<string>"`，用于快路径 epoch 过滤
 *
 * 快路径开销恒为 O(首部长度)，与 snapshot 总长无关；MB 级 value 下仍稳定在亚微秒
 */

import { isNumber, isObject, isString } from '@/shared/utils/verify';

/**
 * 快路径提取 rev
 *
 * 匹配锚定开头的 `{"rev":<整数>` 字段；失败返回 null（调用方应走全量 parse 兜底）
 *
 * 支持负数 rev（理论上单调递增不会出现，但序列化格式允许）
 */
function extractRev(raw: string): number | null {
  const match = /^\{"rev":(?<rev>-?\d+)/u.exec(raw);
  if (!match) {
    return null;
  }
  return Number(match[1]);
}

/**
 * 快路径提取 epoch
 *
 * 匹配 `,"epoch":"<string>"`；失败返回 null（调用方应走全量 parse 兜底或按"无 epoch"处理）
 *
 * 正则说明：
 * - 逗号前缀锚定：epoch 必然出现在 rev / ts 之后，不会错匹配 snapshot 内字面量
 * - `[^"\\]*`：epoch 由 UUID 或常量 `'persistent'` 生成，不含引号和反斜杠；
 *   若用户自定义 adapter 注入了含转义的 epoch（理论上不应该），快路径会失配走 JSON.parse 兜底
 */
function extractEpoch(raw: string): string | null {
  const match = /,"epoch":"(?<epoch>[^"\\]*)"/u.exec(raw);
  if (!match) {
    return null;
  }
  return match[1];
}

/**
 * `readIfNewer` 的最小输入契约
 *
 * 刻意不依赖完整 Entry 结构，只要求 rev 去重基线 + epoch 过滤基线两个字段。
 * Phase 5 的 `core/registry.ts` 中 Entry 天然满足此结构。
 */
interface ReadIfNewerContext {
  /**
   * 已应用的最大 rev；用于去重判定
   *
   * 首次初始化时为 `0`（首个远端 rev > 0 必定命中）
   */
  readonly lastAppliedRev: number;

  /**
   * 当前 Tab 的会话纪元
   *
   * - `null` 表示"尚未 resolveEpoch 完成" / "不启用 epoch 过滤"（视调用上下文）
   * - `'persistent'` 常量（persistence 策略）
   * - UUID 字符串（session 策略）
   *
   * 非 null 时：快路径提取远端 epoch，若不一致则直接丢弃（不解析 snapshot）
   */
  readonly epoch: string | null;
}

/**
 * `readIfNewer` 的产物
 *
 * 仅包含应用所需的最小字段；`ts` / `epoch` 对调用方无意义，不暴露
 */
interface ReadIfNewerResult {
  readonly rev: number;
  readonly snapshot: unknown;
}

/**
 * 权威副本原始 value 的全量形态
 *
 * 仅在快路径失配走 `JSON.parse` 兜底时使用；字段与 `serializeAuthority` 的产物对应
 */
interface AuthorityFullShape {
  readonly rev: number;
  readonly ts: number;
  readonly epoch: string;
  readonly snapshot: unknown;
}

/**
 * 按"是否比本地更新"决定是否返回 snapshot
 *
 * 流程（RFC L1167-1188）：
 * 1. `raw` 为 null / 空串 → 返回 null（删除 key / 首次读取）
 * 2. 快路径 `extractRev`：
 *    - 失配 → 走 JSON.parse 兜底（旧格式 / 手动写入 / 自定义 adapter 产物）
 *    - 命中但 `remoteRev <= lastAppliedRev` → 返回 null（不解析 snapshot，O(1) 丢弃）
 * 3. epoch 快路径过滤：本地 epoch 非 null 时，对比远端 epoch；不一致 → 返回 null
 * 4. 真的要应用时才 `JSON.parse(raw)` 解析 snapshot
 */
function readIfNewer(ctx: ReadIfNewerContext, raw: string | null): ReadIfNewerResult | null {
  // raw 非字符串（null / undefined / 空串）直接丢弃；空串也非法，不必全量 parse
  if (!raw) {
    return null;
  }

  const remoteRev = extractRev(raw);
  if (remoteRev === null) {
    return readIfNewerFallback(ctx, raw);
  }

  // 快路径：rev 未推进，直接 O(1) 丢弃，不解析 snapshot
  if (remoteRev <= ctx.lastAppliedRev) {
    return null;
  }

  // epoch 快路径过滤：仅在本地已有 epoch 时生效
  if (isString(ctx.epoch)) {
    const remoteEpoch = extractEpoch(raw);
    if (isString(remoteEpoch) && remoteEpoch !== ctx.epoch) {
      return null;
    }
  }

  // rev 命中 + epoch 一致（或无 epoch 过滤），才真正 parse snapshot
  const parsed = parseAuthorityRaw(raw);
  if (!parsed) {
    return null;
  }
  return { rev: remoteRev, snapshot: parsed.snapshot };
}

/**
 * 全量 parse 兜底路径
 *
 * 仅在 `extractRev` 失配时走此路径（旧格式 / 手动写入 / 非标准产物）；
 * 解析失败 / 非法结构时返回 null + 调用方自行判断是否日志化
 */
function readIfNewerFallback(ctx: ReadIfNewerContext, raw: string): ReadIfNewerResult | null {
  const parsed = parseAuthorityRaw(raw);
  if (!parsed) {
    return null;
  }
  if (parsed.rev <= ctx.lastAppliedRev) {
    return null;
  }
  if (isString(ctx.epoch) && parsed.epoch !== ctx.epoch) {
    return null;
  }
  return { rev: parsed.rev, snapshot: parsed.snapshot };
}

/**
 * 安全 JSON.parse + 结构校验
 *
 * 返回 null 的情况：
 * - `JSON.parse` 抛错（非法 JSON）
 * - 结构不符（缺 rev / epoch / snapshot 字段 / rev 非数字 / epoch 非字符串）
 *
 * 刻意不抛错：调用方（`storage` 事件 / 定时 pull）不应因单条脏数据中断
 */
function parseAuthorityRaw(raw: string): AuthorityFullShape | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(parsed)) {
    return null;
  }
  const obj = parsed as { rev?: unknown; ts?: unknown; epoch?: unknown; snapshot?: unknown };
  if (!isNumber(obj.rev)) {
    return null;
  }
  if (!isString(obj.epoch)) {
    return null;
  }
  // ts / snapshot 允许任意类型（snapshot 可能是 null / 数组 / 原始类型）；
  // ts 缺失不影响判定，用 0 兜底
  return {
    rev: obj.rev,
    ts: isNumber(obj.ts) ? obj.ts : 0,
    epoch: obj.epoch,
    snapshot: obj.snapshot,
  };
}

export type { AuthorityFullShape, ReadIfNewerContext, ReadIfNewerResult };
export { extractEpoch, extractRev, parseAuthorityRaw, readIfNewer };
