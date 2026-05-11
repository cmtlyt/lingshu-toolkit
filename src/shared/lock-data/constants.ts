/**
 * lock-data 模块的全局常量
 *
 * 所有 key / 默认值统一收敛到此文件，避免散落在各模块中导致跨 Tab 契约漂移。
 * 详见 RFC.md「默认值总览」「StorageAuthority / 存储格式」章节。
 */

/**
 * 跨 Tab 存储 key 的统一前缀
 *
 * 为什么不用 `lingshu:lock-data`：包含作者 scope 可避免与其他未来集成到页面的
 * 第三方锁库（同样用 lock-data 命名）发生 localStorage key 冲突
 */
const LOCK_PREFIX = '@cmtlyt/lingshu-toolkit:lockData';

/**
 * "永不超时"标记
 *
 * 使用 unique symbol（而非 Infinity / -1 / 0）是为了：
 * 1. 在 TypeScript 层完整区别于"未设置"和任意数值
 * 2. 避免 setTimeout 对非法数值的静默降级
 * 3. 让业务侧必须显式 import 才能使用，降低误用概率
 */
const NEVER_TIMEOUT: unique symbol = Symbol('@cmtlyt/lingshu-toolkit:lockData#NEVER_TIMEOUT');

/**
 * 默认抢锁超时（毫秒）
 *
 * 5000ms 是协作类场景的经验值：
 * - 大于人类主动操作的响应延迟阈值（2s）
 * - 小于用户感知到"卡住"的耐心上限（10s）
 */
const DEFAULT_TIMEOUT = 5000;

/**
 * session-probe 探测响应的等待窗口（毫秒）
 *
 * 仅首次启动（sessionStorage 无 epoch 时）阻塞；刷新 / bfcache 恢复走快路径跳过探测。
 * 100ms 已覆盖同源 Tab 间 BroadcastChannel 的典型回响延迟（<30ms）。
 */
const DEFAULT_SESSION_PROBE_TIMEOUT = 100;

/**
 * persistent 策略下固定使用的 epoch 值
 *
 * 使用常量字符串而非随机 uuid，保证跨会话重开仍能匹配同一权威副本。
 */
const PERSISTENT_EPOCH = 'persistent';

/** 统一用于 throwError 第一参数的函数名，保证错误消息前缀一致 */
const ERROR_FN_NAME = 'lockData';

export { DEFAULT_SESSION_PROBE_TIMEOUT, DEFAULT_TIMEOUT, ERROR_FN_NAME, LOCK_PREFIX, NEVER_TIMEOUT, PERSISTENT_EPOCH };
