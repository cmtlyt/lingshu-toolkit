/**
 * 默认 CloneFn 适配器实现
 *
 * 设计三层降级：
 * 1. `structuredClone` 原生（Node 17+ / 现代浏览器） —— 支持 Map / Set / Date / TypedArray / 循环引用
 * 2. JSON.parse(JSON.stringify(...)) —— 丢失特殊类型但覆盖 95% 普通对象场景，降级时 `logger.warn`
 * 3. JSON 也失败（循环引用 / BigInt / function） —— `logger.error` 后返回原值（业务自担风险，
 *    lockData 的 Draft 层已以 readonly-view 隔离外部修改路径，直接复用原引用不会破坏只读契约）
 *
 * 对应 RFC.md「默认实现」：structuredClone + JSON fallback + logger.warn
 */

import type { CloneFn, LoggerAdapter } from '../types';
import { resolveLoggerAdapter } from './logger';

/**
 * 能力探测 —— `structuredClone` 是否可用
 *
 * 同时具备两个条件才算可用：
 * 1. globalThis.structuredClone 是函数
 * 2. 能成功克隆一个 trivial 对象（规避某些 polyfill 宣称存在但实现不完整的情况）
 */
function hasStructuredClone(): boolean {
  const candidate = (globalThis as { structuredClone?: unknown }).structuredClone;
  if (typeof candidate !== 'function') {
    return false;
  }
  try {
    (candidate as <V>(value: V) => V)({ __probe__: 1 });
    return true;
  } catch {
    return false;
  }
}

/**
 * 创建默认的深克隆函数
 *
 * 工厂签名：接收可选 logger（来自用户 adapters.logger 或默认 logger），
 * 降级路径的 warn / error 统一走该 logger，保证日志前缀一致
 */
function createSafeCloneFn(logger?: LoggerAdapter): CloneFn {
  // 走 resolveLoggerAdapter 保证"缺失方法由默认 logger 补全"的统一契约
  const boundLogger = resolveLoggerAdapter(logger);
  const structuredCloneAvailable = hasStructuredClone();

  // 只在工厂创建时探测一次，避免每次 clone 调用都反复探测
  if (structuredCloneAvailable) {
    const nativeClone = (globalThis as { structuredClone: <V>(value: V) => V }).structuredClone;
    return function clone<V>(value: V): V {
      try {
        return nativeClone(value);
      } catch (error) {
        // structuredClone 对 function / Symbol / DOMException 等会抛 DataCloneError
        // 此时退回 JSON fallback，但第一次失败后依然保留 structuredClone 路径
        // —— 因为后续不同 value 可能是正常可克隆的
        boundLogger.warn(
          'structuredClone failed for current value, falling back to JSON clone. This may lose special types (Map / Set / Date / TypedArray).',
          error,
        );
        return jsonCloneOrReturn(value, boundLogger);
      }
    };
  }

  boundLogger.warn(
    'structuredClone is not available in current runtime; falling back to JSON clone. Consider passing adapters.clone (e.g. lodash cloneDeep) if data contains Map / Set / Date / class instances.',
  );
  return function clone<V>(value: V): V {
    return jsonCloneOrReturn(value, boundLogger);
  };
}

/**
 * JSON 克隆兜底
 *
 * 独立抽出便于 structuredClone 失败时复用；JSON 再失败时直接返回原值（最后一道防线）
 */
function jsonCloneOrReturn<V>(value: V, logger: LoggerAdapter): V {
  try {
    return JSON.parse(JSON.stringify(value)) as V;
  } catch (error) {
    logger.error(
      'Both structuredClone and JSON clone failed; returning original reference. Caller must treat the value as potentially aliased.',
      error,
    );
    return value;
  }
}

export { createSafeCloneFn };
