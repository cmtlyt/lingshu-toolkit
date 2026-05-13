/**
 * authority/epoch.ts `probeForExistingSession` 内部 timeout 早退分支专项覆盖（node 环境 + fake timers）
 *
 * 该分支位置（epoch.ts 内）：
 *   const timeoutId = setTimeout(() => {
 *     if (settled) {     // ← line 219 被测分支：reply 已先 settle，timeout cb 仍触发 → settled=true 早退
 *       return;          // ← line 220
 *     }
 *     ...
 *   }, timeout);
 *
 * 现有 `epoch.browser.test.ts` 已覆盖 settled 早退的 reply 重入路径，但 timeout 路径
 * 依赖真实 BroadcastChannel + setTimeout 的内核投递时序，多次回归无法稳定命中。
 *
 * 本测试通过：
 *   1. 直接 import `probeForExistingSession`（仅文件内 named export，未在 lock-data/index.ts 暴露）
 *   2. 用 `vi.useFakeTimers()` 完全控制 setTimeout 触发时机
 *   3. 用同步可控 ChannelAdapter 让 reply 在 microtask 内 settle
 *   4. 显式 `vi.advanceTimersByTime` 推进 timeout cb，确认 settled=true 早退分支被命中（无副作用）
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { freshEpoch, probeForExistingSession, type ResolveEpochContext } from '@/shared/lock-data/authority/epoch';
import { PERSISTENT_EPOCH } from '@/shared/lock-data/constants';
import type { AuthorityAdapter, ChannelAdapter, LoggerAdapter, SessionStoreAdapter } from '@/shared/lock-data/types';

// ---------------------------------------------------------------------------
// stub 工厂
// ---------------------------------------------------------------------------

function createStubLogger(): LoggerAdapter {
  return {
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function createStubSessionStore(): SessionStoreAdapter {
  let value: string | null = null;
  return {
    read: () => value,
    write: (next: string) => {
      value = next;
    },
  };
}

function createStubAuthority(): AuthorityAdapter {
  return {
    read: () => null,
    write: () => {},
    remove: () => {},
    subscribe: () => () => {},
  };
}

interface ControlledChannel {
  readonly channel: ChannelAdapter;
  readonly feedMessage: (message: unknown) => void;
  readonly sentMessages: readonly unknown[];
}

function createControlledChannel(): ControlledChannel {
  const listeners = new Set<(message: unknown) => void>();
  const sent: unknown[] = [];
  const channel: ChannelAdapter = {
    postMessage: (message) => {
      sent.push(message);
    },
    subscribe: (onMessage) => {
      listeners.add(onMessage);
      return () => {
        listeners.delete(onMessage);
      };
    },
    close: () => {
      listeners.clear();
    },
  };
  return {
    channel,
    feedMessage: (message: unknown) => {
      for (const listener of listeners) {
        listener(message);
      }
    },
    sentMessages: sent,
  };
}

function buildCtx(channel: ChannelAdapter, sessionProbeTimeout: number): ResolveEpochContext {
  return {
    persistence: 'session',
    sessionStore: createStubSessionStore(),
    channel,
    authority: createStubAuthority(),
    logger: createStubLogger(),
    sessionProbeTimeout,
  };
}

// ---------------------------------------------------------------------------
// 测试主体
// ---------------------------------------------------------------------------

describe('probeForExistingSession / timeout cb 在 settled=true 后命中早退分支', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('reply 先 settle，再推进 timer 让 timeout cb 触发 → settled=true 早退（无副作用）', async () => {
    const { channel, feedMessage, sentMessages } = createControlledChannel();
    const ctx = buildCtx(channel, 100);

    // 1) 启动 probe；此时 listener + timeout 都已注册
    const probePromise = probeForExistingSession(ctx);

    // 2) 在下一 microtask 内：probeForExistingSession 已完成 subscribe + postMessage
    //    （Promise.resolve() 不会推进 fake timer，只让 microtask 队列消费）
    await Promise.resolve();
    expect(sentMessages).toHaveLength(1);
    const probeMessage = sentMessages[0] as { probeId: string };

    // 3) 用 reply 同步 settle —— settled=true 后 settle.resolve('first-epoch')
    feedMessage({ type: 'session-reply', probeId: probeMessage.probeId, epoch: 'first-epoch' });

    // 4) 推进 timer 跨过 sessionProbeTimeout（100ms）让 timeout cb 触发
    //    cb 入口 if (settled) return —— 命中被测分支，无可观察副作用
    vi.advanceTimersByTime(150);

    // 5) probePromise 仍 resolve 为 reply 的 epoch（timeout cb 早退后未污染结果）
    await expect(probePromise).resolves.toBe('first-epoch');
  });

  test('timeout 先触发：cb 进入正常路径 settle null → reply 后到也命中 settled=true 早退', async () => {
    // 反向用例：先让 timeout cb 走 settled=false 的正常路径（settle.resolve(null)），
    // 然后再 feed reply —— reply 进入 listener 时 settled=true，命中 listener 入口的 settled 早退
    // 这条用例同时触达 listener 的 settled 早退（line 203-204 同模式），形成双重保险
    const { channel, feedMessage, sentMessages } = createControlledChannel();
    const ctx = buildCtx(channel, 50);

    const probePromise = probeForExistingSession(ctx);

    await Promise.resolve();
    expect(sentMessages).toHaveLength(1);
    const probeMessage = sentMessages[0] as { probeId: string };

    // 1) 推进 timer 让 timeout 先触发：settled=false → 进入正常路径 settle null
    vi.advanceTimersByTime(60);
    await expect(probePromise).resolves.toBeNull();

    // 2) 再 feed reply：listener 进入时 settled=true，命中 listener 入口 if (settled) return 早退
    //    不会抛错也不会改变已 resolve 的 promise
    expect(() => {
      feedMessage({ type: 'session-reply', probeId: probeMessage.probeId, epoch: 'late-epoch' });
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 防御性兜底：probeForExistingSession `if (!channel) return null`
// ---------------------------------------------------------------------------

describe('probeForExistingSession / channel=null 防御性兜底', () => {
  test('ctx.channel=null 直接 return Promise.resolve(null)', async () => {
    // 公共路径下 resolveEpoch D 分支已对 !ctx.channel 提前 return freshEpoch；
    // probeForExistingSession 内的 `if (!channel)` 守卫不可触达。
    // 通过直接 import 调用并传 channel=null 命中该防御分支。
    const ctx: ResolveEpochContext = {
      persistence: 'session',
      sessionStore: createStubSessionStore(),
      channel: null,
      authority: createStubAuthority(),
      logger: createStubLogger(),
      sessionProbeTimeout: 100,
    };

    await expect(probeForExistingSession(ctx)).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 防御性兜底：freshEpoch `if (ctx.sessionStore) write` false 分支
// ---------------------------------------------------------------------------

describe('freshEpoch / sessionStore=null 防御性兜底', () => {
  test('ctx.sessionStore=null → 跳过 write，仍正常生成 epoch + remove authority', () => {
    // 公共路径下 resolveEpoch B 分支已对 !ctx.sessionStore 提前 return persistent；
    // freshEpoch 仅在 D/F 分支被调用，sessionStore 必存在。
    // 通过直接 import 调用并传 sessionStore=null 命中 `if (ctx.sessionStore)` false 分支。
    const removeMock = vi.fn();
    const authority: AuthorityAdapter = {
      read: () => null,
      write: () => {},
      remove: removeMock,
      subscribe: () => () => {},
    };
    const ctx: ResolveEpochContext = {
      persistence: 'session',
      sessionStore: null,
      channel: null,
      authority,
      logger: createStubLogger(),
      sessionProbeTimeout: 100,
    };

    const result = freshEpoch(ctx);
    // 生成新 UUID（非 PERSISTENT_EPOCH）
    expect(result.epoch).not.toBe(PERSISTENT_EPOCH);
    expect(result.epoch.length).toBeGreaterThan(0);
    expect(result.effectivePersistence).toBe('session');
    // sessionStore=null 走 false 分支跳过 write；authority.remove 仍被调用
    expect(result.authorityCleared).toBe(true);
    expect(removeMock).toHaveBeenCalledTimes(1);
  });
});
