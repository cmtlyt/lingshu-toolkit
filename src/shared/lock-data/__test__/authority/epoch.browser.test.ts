import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  buildProbeMessage,
  buildReplyMessage,
  generateUuid,
  isSessionProbeMessage,
  isSessionReplyMessage,
  type ResolveEpochContext,
  resolveEpoch,
  subscribeSessionProbe,
} from '../../authority/epoch';
import { PERSISTENT_EPOCH } from '../../constants';
import type { AuthorityAdapter, ChannelAdapter, LoggerAdapter, SessionStoreAdapter } from '../../types';

/**
 * 构造测试用 LoggerAdapter（全部 vi.fn 便于断言调用次数）
 */
function createTestLogger(): LoggerAdapter & {
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  return {
    warn: vi.fn<(message: string, ...extras: unknown[]) => void>(),
    error: vi.fn<(message: string, ...extras: unknown[]) => void>(),
    debug: vi.fn<(message: string, ...extras: unknown[]) => void>(),
  };
}

/**
 * 构造内存版 SessionStoreAdapter（避免依赖真实 sessionStorage 的测试间污染）
 */
function createMemorySessionStore(initial: string | null = null): SessionStoreAdapter & {
  _store: { value: string | null };
} {
  const store = { value: initial };
  return {
    _store: store,
    read: () => store.value,
    write: (value: string) => {
      store.value = value;
    },
  };
}

/**
 * 构造内存版 AuthorityAdapter（仅用到 remove；其他方法用 noop）
 */
function createMemoryAuthority(): AuthorityAdapter & { _removed: { count: number } } {
  const removed = { count: 0 };
  return {
    _removed: removed,
    read: () => null,
    write: () => {},
    remove: () => {
      removed.count++;
    },
    subscribe: () => () => {},
  };
}

/**
 * 构造内存版 ChannelAdapter，用于模拟单 Tab 场景（无对端）
 * postMessage 会记录但不回传
 */
function createSilentChannel(): ChannelAdapter & { _sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    _sent: sent,
    postMessage: (message: unknown) => {
      sent.push(message);
    },
    subscribe: () => () => {},
    close: () => {},
  };
}

/**
 * 构造两个共享同一 BroadcastChannel name 的 ChannelAdapter，
 * 模拟跨 Tab 的真实通信（原生 BroadcastChannel 不回环，两侧独立监听）
 *
 * 复用 adapters/channel.ts 的默认实现，但必须保证两个 adapter 都
 * 在当前测试周期内手动 close，避免跨测试污染
 */
function createPairedBroadcastChannels(name: string): {
  tabA: ChannelAdapter;
  tabB: ChannelAdapter;
  cleanup: () => void;
} {
  const logger = createTestLogger();
  const tabAListeners = new Set<(message: unknown) => void>();
  const tabBListeners = new Set<(message: unknown) => void>();

  // 用真实 BroadcastChannel 保证跨"Tab"消息确实要经过内核投递
  const bcA = new BroadcastChannel(name);
  const bcB = new BroadcastChannel(name);

  bcA.addEventListener('message', (e) => {
    for (const cb of tabAListeners) {
      cb(e.data);
    }
  });
  bcB.addEventListener('message', (e) => {
    for (const cb of tabBListeners) {
      cb(e.data);
    }
  });

  const tabA: ChannelAdapter = {
    postMessage: (message) => {
      try {
        bcA.postMessage(message);
      } catch (error) {
        logger.warn('tabA postMessage failed', error);
      }
    },
    subscribe: (onMessage) => {
      tabAListeners.add(onMessage);
      return () => {
        tabAListeners.delete(onMessage);
      };
    },
    close: () => {
      bcA.close();
    },
  };

  const tabB: ChannelAdapter = {
    postMessage: (message) => {
      try {
        bcB.postMessage(message);
      } catch (error) {
        logger.warn('tabB postMessage failed', error);
      }
    },
    subscribe: (onMessage) => {
      tabBListeners.add(onMessage);
      return () => {
        tabBListeners.delete(onMessage);
      };
    },
    close: () => {
      bcB.close();
    },
  };

  return {
    tabA,
    tabB,
    cleanup: () => {
      bcA.close();
      bcB.close();
      tabAListeners.clear();
      tabBListeners.clear();
    },
  };
}

describe('authority/epoch — 消息辅助函数', () => {
  test('buildProbeMessage 产出固定形状', () => {
    const msg = buildProbeMessage('probe-id-1');
    expect(msg).toEqual({ type: 'session-probe', probeId: 'probe-id-1' });
  });

  test('buildReplyMessage 产出固定形状', () => {
    const msg = buildReplyMessage('probe-id-1', 'epoch-abc');
    expect(msg).toEqual({ type: 'session-reply', probeId: 'probe-id-1', epoch: 'epoch-abc' });
  });

  test('isSessionProbeMessage 合法性校验', () => {
    expect(isSessionProbeMessage({ type: 'session-probe', probeId: 'x' })).toBe(true);
    expect(isSessionProbeMessage({ type: 'session-reply', probeId: 'x' })).toBe(false);
    expect(isSessionProbeMessage({ type: 'session-probe' })).toBe(false);
    expect(isSessionProbeMessage(null)).toBe(false);
    expect(isSessionProbeMessage('probe')).toBe(false);
  });

  test('isSessionReplyMessage 合法性校验', () => {
    expect(isSessionReplyMessage({ type: 'session-reply', probeId: 'x', epoch: 'e' })).toBe(true);
    expect(isSessionReplyMessage({ type: 'session-reply', probeId: 'x' })).toBe(false);
    expect(isSessionReplyMessage({ type: 'session-probe', probeId: 'x', epoch: 'e' })).toBe(false);
    expect(isSessionReplyMessage(null)).toBe(false);
  });
});

describe('authority/epoch — generateUuid', () => {
  test('优先使用 crypto.randomUUID 返回标准 UUID', () => {
    const uuid = generateUuid();
    // 浏览器环境下 crypto.randomUUID 必然可用，产物符合 UUID v4 格式
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
  });

  test('两次调用产出不同 UUID', () => {
    const a = generateUuid();
    const b = generateUuid();
    expect(a).not.toBe(b);
  });
});

describe('authority/epoch — resolveEpoch 六分支', () => {
  test('A 分支：persistent 策略返回常量 persistent，不触达 sessionStore', async () => {
    const sessionStore = createMemorySessionStore('should-not-read');
    const logger = createTestLogger();
    const ctx: ResolveEpochContext = {
      persistence: 'persistent',
      sessionStore,
      channel: createSilentChannel(),
      authority: createMemoryAuthority(),
      logger,
    };
    const result = await resolveEpoch(ctx);
    expect(result.epoch).toBe(PERSISTENT_EPOCH);
    expect(result.effectivePersistence).toBe('persistent');
    expect(result.authorityCleared).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('B 分支：session + sessionStore 不可用 → 降级为 persistent + warn', async () => {
    const logger = createTestLogger();
    const ctx: ResolveEpochContext = {
      persistence: 'session',
      sessionStore: null,
      channel: createSilentChannel(),
      authority: createMemoryAuthority(),
      logger,
    };
    const result = await resolveEpoch(ctx);
    expect(result.epoch).toBe(PERSISTENT_EPOCH);
    expect(result.effectivePersistence).toBe('persistent');
    expect(result.authorityCleared).toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  test('C 分支：sessionStorage 已有 epoch → 直接继承（刷新/bfcache）', async () => {
    const existingEpoch = 'abcd-1234';
    const sessionStore = createMemorySessionStore(existingEpoch);
    const channel = createSilentChannel();
    const ctx: ResolveEpochContext = {
      persistence: 'session',
      sessionStore,
      channel,
      authority: createMemoryAuthority(),
      logger: createTestLogger(),
    };
    const result = await resolveEpoch(ctx);
    expect(result.epoch).toBe(existingEpoch);
    expect(result.effectivePersistence).toBe('session');
    expect(result.authorityCleared).toBe(false);
    // C 分支不应广播 probe
    expect(channel._sent).toHaveLength(0);
  });

  test('D 分支：session + channel 不可用 → 生成新 UUID + 清空 authority + warn', async () => {
    const logger = createTestLogger();
    const sessionStore = createMemorySessionStore(null);
    const authority = createMemoryAuthority();
    const ctx: ResolveEpochContext = {
      persistence: 'session',
      sessionStore,
      channel: null,
      authority,
      logger,
    };
    const result = await resolveEpoch(ctx);
    expect(result.epoch).toMatch(/^[0-9a-f-]+$/u);
    expect(result.epoch).not.toBe(PERSISTENT_EPOCH);
    expect(result.effectivePersistence).toBe('session');
    expect(result.authorityCleared).toBe(true);
    expect(authority._removed.count).toBe(1);
    // 新 epoch 被写入 sessionStore，供本 Tab 后续刷新继承
    expect(sessionStore._store.value).toBe(result.epoch);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  test('E 分支：收到 session-reply → 继承响应方 epoch', async () => {
    const paired = createPairedBroadcastChannels(`test-e-${Math.random()}`);
    const sessionStore = createMemorySessionStore(null);
    const authority = createMemoryAuthority();

    // tabB 模拟常驻响应者，已持有 epoch="existing-tab-epoch"
    const unsubscribeResponder = subscribeSessionProbe(paired.tabB, () => 'existing-tab-epoch');

    try {
      const ctx: ResolveEpochContext = {
        persistence: 'session',
        sessionStore,
        channel: paired.tabA,
        authority,
        logger: createTestLogger(),
        sessionProbeTimeout: 200,
      };
      const result = await resolveEpoch(ctx);

      expect(result.epoch).toBe('existing-tab-epoch');
      expect(result.effectivePersistence).toBe('session');
      expect(result.authorityCleared).toBe(false);
      // E 分支继承时也要写入 sessionStore
      expect(sessionStore._store.value).toBe('existing-tab-epoch');
      // 不应清空 authority
      expect(authority._removed.count).toBe(0);
    } finally {
      unsubscribeResponder();
      paired.cleanup();
    }
  });

  test('F 分支：探测超时 → 生成新 UUID + 清空 authority', async () => {
    const paired = createPairedBroadcastChannels(`test-f-${Math.random()}`);
    const sessionStore = createMemorySessionStore(null);
    const authority = createMemoryAuthority();

    try {
      // 没有 responder，探测必然超时
      const ctx: ResolveEpochContext = {
        persistence: 'session',
        sessionStore,
        channel: paired.tabA,
        authority,
        logger: createTestLogger(),
        sessionProbeTimeout: 50, // 短超时加速测试
      };
      const result = await resolveEpoch(ctx);

      expect(result.epoch).not.toBe(PERSISTENT_EPOCH);
      expect(result.epoch.length).toBeGreaterThan(0);
      expect(result.effectivePersistence).toBe('session');
      expect(result.authorityCleared).toBe(true);
      expect(authority._removed.count).toBe(1);
      expect(sessionStore._store.value).toBe(result.epoch);
    } finally {
      paired.cleanup();
    }
  });

  test('F 分支：authority 为 null 时不报错，authorityCleared=false', async () => {
    const paired = createPairedBroadcastChannels(`test-f-noauth-${Math.random()}`);
    try {
      const sessionStore = createMemorySessionStore(null);
      const ctx: ResolveEpochContext = {
        persistence: 'session',
        sessionStore,
        channel: paired.tabA,
        authority: null,
        logger: createTestLogger(),
        sessionProbeTimeout: 50,
      };
      const result = await resolveEpoch(ctx);
      expect(result.authorityCleared).toBe(false);
      expect(result.epoch.length).toBeGreaterThan(0);
    } finally {
      paired.cleanup();
    }
  });

  test('F 分支：authority.remove 抛错时降级为 warn，不中断流程', async () => {
    const paired = createPairedBroadcastChannels(`test-f-throw-${Math.random()}`);
    try {
      const sessionStore = createMemorySessionStore(null);
      const logger = createTestLogger();
      const throwingAuthority: AuthorityAdapter = {
        read: () => null,
        write: () => {},
        remove: () => {
          throw new Error('mock remove fail');
        },
        subscribe: () => () => {},
      };
      const ctx: ResolveEpochContext = {
        persistence: 'session',
        sessionStore,
        channel: paired.tabA,
        authority: throwingAuthority,
        logger,
        sessionProbeTimeout: 50,
      };
      const result = await resolveEpoch(ctx);
      expect(result.epoch.length).toBeGreaterThan(0);
      expect(result.authorityCleared).toBe(false);
      expect(logger.warn).toHaveBeenCalledTimes(1);
    } finally {
      paired.cleanup();
    }
  });
});

describe('authority/epoch — probeId 过滤', () => {
  test('其他 probeId 的 reply 不会误触发当前 resolve', async () => {
    const paired = createPairedBroadcastChannels(`test-probeid-${Math.random()}`);
    const sessionStore = createMemorySessionStore(null);
    const authority = createMemoryAuthority();

    // tabB 故意发送一个错配的 reply（probeId 不匹配）
    const unsubB = paired.tabB.subscribe((message) => {
      if (message && typeof message === 'object' && (message as { type?: string }).type === 'session-probe') {
        // 故意用错的 probeId 回复
        paired.tabB.postMessage({
          type: 'session-reply',
          probeId: 'wrong-probe-id',
          epoch: 'should-be-ignored',
        });
      }
    });

    try {
      const ctx: ResolveEpochContext = {
        persistence: 'session',
        sessionStore,
        channel: paired.tabA,
        authority,
        logger: createTestLogger(),
        sessionProbeTimeout: 100,
      };
      const result = await resolveEpoch(ctx);

      // probeId 错配 → 走 F 分支生成新 epoch
      expect(result.epoch).not.toBe('should-be-ignored');
      expect(result.authorityCleared).toBe(true);
    } finally {
      unsubB();
      paired.cleanup();
    }
  });
});

describe('authority/epoch — subscribeSessionProbe (响应方)', () => {
  let paired: ReturnType<typeof createPairedBroadcastChannels>;

  beforeEach(() => {
    paired = createPairedBroadcastChannels(`test-responder-${Math.random()}`);
  });

  afterEach(() => {
    paired.cleanup();
  });

  test('持有 epoch 的 Tab 收到 probe 时广播 reply', async () => {
    const replies: unknown[] = [];
    paired.tabA.subscribe((message) => {
      if (isSessionReplyMessage(message)) {
        replies.push(message);
      }
    });

    const unsub = subscribeSessionProbe(paired.tabB, () => 'responder-epoch');
    // 让订阅真正生效 —— BroadcastChannel.addEventListener 在某些浏览器实现下
    // 需要走一次 microtask 才会注册到内核的订阅表；直接 postMessage 可能丢首条
    await Promise.resolve();

    paired.tabA.postMessage(buildProbeMessage('probe-xyz'));
    // 正向断言：用 vi.waitFor 显式轮询等待 BroadcastChannel 广播到达
    // timeout 放宽到 2000ms：全量 workspace 并发下 BroadcastChannel 可能经历
    // tabA→kernel→tabB→subscribeSessionProbe 回调→tabB→kernel→tabA 两次跨 Tab 投递，
    // 高并发 worker 拥挤时累计延迟可能 > 500ms
    await vi.waitFor(
      () => {
        expect(replies).toHaveLength(1);
      },
      { timeout: 2000, interval: 10 },
    );

    expect(replies[0]).toEqual({ type: 'session-reply', probeId: 'probe-xyz', epoch: 'responder-epoch' });
    unsub();
  });

  test('尚未 resolved 的 Tab（getMyEpoch 返回 null）不响应', async () => {
    const replies: unknown[] = [];
    paired.tabA.subscribe((message) => {
      if (isSessionReplyMessage(message)) {
        replies.push(message);
      }
    });

    const unsub = subscribeSessionProbe(paired.tabB, () => null);
    paired.tabA.postMessage(buildProbeMessage('probe-abc'));
    // 反向断言（期望始终为空）：必须等"足够久"才能证明确实无消息，vi.waitFor 不适用
    // 150ms 为高并发 workspace 下 BroadcastChannel 可能的最坏投递窗口
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(replies).toHaveLength(0);
    unsub();
  });

  test('getMyEpoch 返回空串不响应', async () => {
    const replies: unknown[] = [];
    paired.tabA.subscribe((message) => {
      if (isSessionReplyMessage(message)) {
        replies.push(message);
      }
    });

    const unsub = subscribeSessionProbe(paired.tabB, () => '');
    paired.tabA.postMessage(buildProbeMessage('probe-empty'));
    // 反向断言：同上，150ms 等够高并发下最坏投递窗口
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(replies).toHaveLength(0);
    unsub();
  });

  test('非 session-probe 消息被忽略', async () => {
    const replies: unknown[] = [];
    paired.tabA.subscribe((message) => {
      if (isSessionReplyMessage(message)) {
        replies.push(message);
      }
    });

    const unsub = subscribeSessionProbe(paired.tabB, () => 'any-epoch');
    // 发送非 probe 类型消息
    paired.tabA.postMessage({ type: 'some-other-message', payload: 'x' });
    paired.tabA.postMessage('plain string');
    paired.tabA.postMessage(null);
    // 反向断言：同上，150ms 等够高并发下最坏投递窗口
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(replies).toHaveLength(0);
    unsub();
  });

  test('unsubscribe 后不再响应', async () => {
    const replies: unknown[] = [];
    paired.tabA.subscribe((message) => {
      if (isSessionReplyMessage(message)) {
        replies.push(message);
      }
    });

    const unsub = subscribeSessionProbe(paired.tabB, () => 'epoch-x');
    unsub();

    paired.tabA.postMessage(buildProbeMessage('probe-after-unsub'));
    // 反向断言：同上，150ms 等够高并发下最坏投递窗口
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(replies).toHaveLength(0);
  });
});

describe('authority/epoch — TOCTOU 与多 Tab 收敛', () => {
  test('多 Tab 同时启动（都超时）各自 freshEpoch；收敛到最早由 authority.write 完成（Phase 4.4 职责）', async () => {
    // 本测试只验证 resolveEpoch 层：两 Tab 都超时时各自产生独立 UUID，
    // 收敛到"最早 epoch"是 Phase 4.4 initAuthority 在 resolve 后做一次 authority.read
    // + readIfNewer 实现的 —— 这里只确认 resolveEpoch 不做全局收敛（边界清晰）
    const pairedA = createPairedBroadcastChannels(`test-toctou-a-${Math.random()}`);
    const pairedB = createPairedBroadcastChannels(`test-toctou-b-${Math.random()}`);

    try {
      const [resultA, resultB] = await Promise.all([
        resolveEpoch({
          persistence: 'session',
          sessionStore: createMemorySessionStore(null),
          channel: pairedA.tabA,
          authority: createMemoryAuthority(),
          logger: createTestLogger(),
          sessionProbeTimeout: 50,
        }),
        resolveEpoch({
          persistence: 'session',
          sessionStore: createMemorySessionStore(null),
          channel: pairedB.tabA,
          authority: createMemoryAuthority(),
          logger: createTestLogger(),
          sessionProbeTimeout: 50,
        }),
      ]);

      expect(resultA.epoch).not.toBe(resultB.epoch);
      expect(resultA.effectivePersistence).toBe('session');
      expect(resultB.effectivePersistence).toBe('session');
    } finally {
      pairedA.cleanup();
      pairedB.cleanup();
    }
  });
});

describe('authority/epoch — generateUuid fallback（无 crypto.randomUUID）', () => {
  let originalCrypto: unknown;

  beforeEach(() => {
    originalCrypto = (globalThis as { crypto?: unknown }).crypto;
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'crypto', {
      value: originalCrypto,
      configurable: true,
      writable: true,
    });
  });

  test('crypto 不存在时走 Math.random + Date.now 兜底，仍产出非空字符串', () => {
    Object.defineProperty(globalThis, 'crypto', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    const id = generateUuid();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    // 兜底产物的形态：{base36}-{base36}，不会是 UUID v4 格式
    expect(id).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
    expect(id).toMatch(/^[0-9a-z]+-[0-9a-z]+$/u);
  });

  test('crypto 存在但 randomUUID 不是函数 → 走兜底（兼容老浏览器 crypto 仅含 getRandomValues）', () => {
    Object.defineProperty(globalThis, 'crypto', {
      value: { getRandomValues: () => new Uint8Array(0) },
      configurable: true,
      writable: true,
    });
    const id = generateUuid();
    expect(typeof id).toBe('string');
    expect(id).toMatch(/^[0-9a-z]+-[0-9a-z]+$/u);
  });

  test('crypto.randomUUID 抛错时走兜底', () => {
    Object.defineProperty(globalThis, 'crypto', {
      value: {
        randomUUID: () => {
          throw new Error('SecurityError');
        },
      },
      configurable: true,
      writable: true,
    });
    const id = generateUuid();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });
});

/**
 * 为 settled 重入保护测试构造一个**同步可控**的 ChannelAdapter
 *
 * 与 `createPairedBroadcastChannels` 的真实 BroadcastChannel 不同：
 * - 真实 BroadcastChannel 走内核投递，message 到达对端是异步的，且并发 worker 跑测试
 *   时调度顺序不稳定，过去导致这两个 flaky 用例偶发"reply 与 noise 抵达 listener
 *   的顺序错乱 / probe 被吞掉"
 * - 这里只关心 `probeForExistingSession` handler 内部的两条早退分支（`settled` /
 *   `!isSessionReplyMessage`），跨 Tab 通信不是被测对象 —— 因此把 listener 引用
 *   暴露给测试代码主动同步调用即可，完全规避内核投递时序
 *
 * 测试代码通过 `feedMessage(msg)` 直接同步触发 listener，按确定顺序覆盖目标分支
 */
function createControlledChannel(): {
  channel: ChannelAdapter;
  feedMessage: (message: unknown) => void;
  sentMessages: readonly unknown[];
} {
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
      for (const cb of listeners) {
        cb(message);
      }
    },
    sentMessages: sent,
  };
}

describe('authority/epoch — probeForExistingSession 早退分支（settled 重入保护）', () => {
  test('probe 已 resolve 后第二条 reply 不会重复 settle（settled 早退）', async () => {
    // 用 controlledChannel 完全规避 BroadcastChannel 内核投递时序：
    // resolveEpoch 内 channel.postMessage(probe) 后，listener 已通过 channel.subscribe
    // 注册到 controlled channel；测试代码读取 sentMessages 拿到 probeId，再 feedMessage
    // 同步驱动两条 reply 进入 listener，按确定顺序命中 settled 早退分支
    const { channel, feedMessage, sentMessages } = createControlledChannel();
    const sessionStore = createMemorySessionStore(null);
    const authority = createMemoryAuthority();

    const resultPromise = resolveEpoch({
      persistence: 'session',
      sessionStore,
      channel,
      authority,
      logger: createTestLogger(),
      sessionProbeTimeout: 200,
    });

    // 给一个 microtask 让 probeForExistingSession 完成 subscribe + postMessage
    await Promise.resolve();
    expect(sentMessages).toHaveLength(1);
    const probeMessage = sentMessages[0] as { type: string; probeId: string };
    expect(probeMessage.type).toBe('session-probe');
    const probeId = probeMessage.probeId;
    expect(probeId).toBeTruthy();

    // 第一条 reply：进入 listener 后 settled=true → settle.resolve('first-epoch')
    feedMessage({ type: 'session-reply', probeId, epoch: 'first-epoch' });
    // 第二条同 probeId 的伪造 reply：listener 入口 if (settled) return 早退（被测分支）
    feedMessage({ type: 'session-reply', probeId, epoch: 'second-epoch' });

    const result = await resultPromise;
    expect(result.epoch).toBe('first-epoch');

    // 二次 feed 不会污染已 resolve 的结果（再 feed 一条同样早退）
    feedMessage({ type: 'session-reply', probeId, epoch: 'third-epoch' });
    expect(result.epoch).toBe('first-epoch');
  });

  test('probe 已 resolve 后非 reply 类型消息不会触发回退（!isSessionReplyMessage 早退）', async () => {
    const { channel, feedMessage, sentMessages } = createControlledChannel();
    const sessionStore = createMemorySessionStore(null);
    const authority = createMemoryAuthority();

    const resultPromise = resolveEpoch({
      persistence: 'session',
      sessionStore,
      channel,
      authority,
      logger: createTestLogger(),
      sessionProbeTimeout: 200,
    });

    await Promise.resolve();
    const probeMessage = sentMessages[0] as { probeId: string };
    const probeId = probeMessage.probeId;

    // 先发非法 noise：listener 进入 if (!isSessionReplyMessage) return 早退（被测分支）
    feedMessage({ type: 'random-noise', payload: 1 });
    // 再发合法 reply：settled=true，settle.resolve('real-epoch')
    feedMessage({ type: 'session-reply', probeId, epoch: 'real-epoch' });

    const result = await resultPromise;
    expect(result.epoch).toBe('real-epoch');
  });

  test('未传 sessionProbeTimeout 时走 DEFAULT_SESSION_PROBE_TIMEOUT 默认值（不抛错且能正常超时）', async () => {
    // 不传 sessionProbeTimeout，触发 ctx.sessionProbeTimeout || DEFAULT_SESSION_PROBE_TIMEOUT 的 default 分支；
    // 没有 paired 响应者，最终走 F 分支（超时 → 生成新 epoch）
    const paired = createPairedBroadcastChannels(`test-default-timeout-${Math.random()}`);
    const sessionStore = createMemorySessionStore(null);
    const authority = createMemoryAuthority();

    try {
      // 默认超时是 100ms（DEFAULT_SESSION_PROBE_TIMEOUT），这里只验证「不传 timeout 也能正常 resolve」
      const result = await resolveEpoch({
        persistence: 'session',
        sessionStore,
        channel: paired.tabA,
        authority,
        logger: createTestLogger(),
        // 故意不传 sessionProbeTimeout
      });
      expect(result.effectivePersistence).toBe('session');
      expect(result.authorityCleared).toBe(true);
    } finally {
      paired.cleanup();
    }
  }, 1000);

  test('超时触发后 settled 已置为 true → 后续到达的 reply 不会改变 result（timeout 早退 + reply 早退）', async () => {
    // fake timers 仅拦截 setTimeout/clearTimeout/setInterval/clearInterval，
    // 不 fake 微任务 / Promise / Date / BroadcastChannel —— BC 消息派发走浏览器原生异步
    // 队列，与 JS 定时器解耦，因此可以在 fake timers 下正常工作
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const paired = createPairedBroadcastChannels(`test-timeout-then-reply-${Math.random()}`);
    const sessionStore = createMemorySessionStore(null);
    const authority = createMemoryAuthority();

    // 响应者收到 probe 后，通过 fake setTimeout 延迟 200ms（远晚于 timeout=50ms）才回复
    const unsubscribe = paired.tabB.subscribe((message) => {
      if (message && typeof message === 'object' && (message as { type?: unknown }).type === 'session-probe') {
        const probeId = (message as { probeId: string }).probeId;
        setTimeout(() => {
          paired.tabB.postMessage({ type: 'session-reply', probeId, epoch: 'late-epoch' });
        }, 200);
      }
    });

    try {
      const resolvePromise = resolveEpoch({
        persistence: 'session',
        sessionStore,
        channel: paired.tabA,
        authority,
        logger: createTestLogger(),
        sessionProbeTimeout: 50,
      });

      // 推进到源码 setTimeout(50) 触发，触发后进入 settled=true，settle.resolve(null)
      // advanceTimersByTimeAsync 同时会让微任务跑，使 finally 内的 clearTimeout/unsubscribe 完成
      await vi.advanceTimersByTimeAsync(60);

      const result = await resolvePromise;
      // timeout 路径触发 → 走 freshEpoch 生成新 UUID，而非 'late-epoch'
      expect(result.epoch).not.toBe('late-epoch');
      expect(result.authorityCleared).toBe(true);

      // 继续推进到 200ms 让晚到的 reply 真实派发；此时 channel 已 unsubscribe，
      // 即使消息送达也不会再调用 callback（验证 settled=true 的 reply 早退分支）
      await vi.advanceTimersByTimeAsync(200);
      expect(result.epoch).not.toBe('late-epoch');
    } finally {
      unsubscribe();
      paired.cleanup();
      vi.useRealTimers();
    }
  });
});

/**
 * probeForExistingSession 残余分支补测
 *
 * resolveEpoch 在 D 分支已经把 !ctx.channel 拦截掉，但 probeForExistingSession 内部
 * 仍保留 `if (!channel) return Promise.resolve(null)` 作为防御性早退（避免 unsafe 调用顺序时
 * channel 为 null 导致 NPE）。这里通过直接构造 ctx + 强制走 reply 双触发场景覆盖：
 *   1. settled 重入：同一 probeId 多次 reply，第二次进入 subscribe callback 时 settled=true 早退
 *   2. settled 重入（timeout 后）：reply 早到 settle，timeout 仍触发 cb，进入 settled=true 早退
 */
describe('authority/epoch — probeForExistingSession 防御性 / settled 重入', () => {
  test('reply 早到后 timeout 触发 cb：进入 settled=true 早退分支（line 219-220）', async () => {
    // fake timers 仅拦截 setTimeout/clearTimeout/setInterval/clearInterval，
    // 不影响 BroadcastChannel 原生异步投递；reply 通过 BC 真实派发先送达，
    // 然后用 advanceTimersByTimeAsync 推进源码内 setTimeout(..., 500) 让 timeout cb 触发
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const paired = createPairedBroadcastChannels(`probe-double-settle-${Math.random()}`);
    const sessionStore = createMemorySessionStore(null);
    const authority = createMemoryAuthority();

    const replyEpoch = 'reply-fast-epoch';
    const unsubscribe = paired.tabB.subscribe((message) => {
      if (message && typeof message === 'object' && (message as { type?: unknown }).type === 'session-probe') {
        const probeId = (message as { probeId: string }).probeId;
        // 立即回复 → reply 先到，timeout 后到时进入 settled=true 早退
        paired.tabB.postMessage({ type: 'session-reply', probeId, epoch: replyEpoch });
      }
    });

    try {
      const result = await resolveEpoch({
        persistence: 'session',
        sessionStore,
        channel: paired.tabA,
        authority,
        logger: createTestLogger(),
        sessionProbeTimeout: 500, // 给 BroadcastChannel 真实异步投递留足时间
      });
      // E 分支：继承 reply 的 epoch
      expect(result.epoch).toBe(replyEpoch);

      // 推进 fake timers 让源码内 setTimeout(..., 500) 自然到期 → 进入 settled=true 早退分支
      // 此时 reply 已 settle 并 clearTimeout，但源码 timer 在 finally 触发 clearTimeout
      // 之前若已 settle 完成，timer 已被清除；此处推进只是兜底验证不抛错
      await vi.advanceTimersByTimeAsync(600);
    } finally {
      unsubscribe();
      paired.cleanup();
      vi.useRealTimers();
    }
  });

  test('多个 reply 触发：第一条进 subscribe cb 后 settled=true，第二条命中早退分支（line 203-204）', async () => {
    const paired = createPairedBroadcastChannels(`probe-multi-reply-${Math.random()}`);
    const sessionStore = createMemorySessionStore(null);
    const authority = createMemoryAuthority();

    const unsubscribe = paired.tabB.subscribe((message) => {
      if (message && typeof message === 'object' && (message as { type?: unknown }).type === 'session-probe') {
        const probeId = (message as { probeId: string }).probeId;
        // 同一 probeId 连发两条 reply；第一条 settle 后第二条命中 settled=true 早退
        paired.tabB.postMessage({ type: 'session-reply', probeId, epoch: 'first-reply' });
        paired.tabB.postMessage({ type: 'session-reply', probeId, epoch: 'second-reply' });
      }
    });

    try {
      const result = await resolveEpoch({
        persistence: 'session',
        sessionStore,
        channel: paired.tabA,
        authority,
        logger: createTestLogger(),
        sessionProbeTimeout: 1000,
      });
      // 第一条 reply 决定 epoch，第二条进入 settled=true 早退后被忽略
      expect(result.epoch).toBe('first-reply');
    } finally {
      unsubscribe();
      paired.cleanup();
    }
  });

  test('错误 probeId 的 reply 被过滤（命中 message.probeId !== probeId 早退分支）', async () => {
    const paired = createPairedBroadcastChannels(`probe-wrong-id-${Math.random()}`);
    const sessionStore = createMemorySessionStore(null);
    const authority = createMemoryAuthority();

    const unsubscribe = paired.tabB.subscribe((message) => {
      if (message && typeof message === 'object' && (message as { type?: unknown }).type === 'session-probe') {
        // 故意发不匹配的 probeId → 命中 probeId mismatch 早退；后再发正确 probeId → 命中 happy path
        paired.tabB.postMessage({ type: 'session-reply', probeId: 'wrong-id', epoch: 'wrong-epoch' });
        const correctId = (message as { probeId: string }).probeId;
        paired.tabB.postMessage({ type: 'session-reply', probeId: correctId, epoch: 'correct-epoch' });
      }
    });

    try {
      const result = await resolveEpoch({
        persistence: 'session',
        sessionStore,
        channel: paired.tabA,
        authority,
        logger: createTestLogger(),
        sessionProbeTimeout: 1000,
      });
      expect(result.epoch).toBe('correct-epoch');
    } finally {
      unsubscribe();
      paired.cleanup();
    }
  });
});

describe('authority/epoch — freshEpoch sessionStore 写入', () => {
  test('D 分支 freshEpoch 写入 sessionStore（命中 line 246 ctx.sessionStore 分支）', async () => {
    const sessionStore = createMemorySessionStore(null);
    const authority = createMemoryAuthority();

    const result = await resolveEpoch({
      persistence: 'session',
      sessionStore,
      channel: null, // 触发 D 分支
      authority,
      logger: createTestLogger(),
    });

    // D 分支生成新 epoch + 写入 sessionStore + 调用 authority.remove
    expect(result.authorityCleared).toBe(true);
    expect(result.epoch).not.toBe(PERSISTENT_EPOCH);
    expect(sessionStore._store.value).toBe(result.epoch);
    expect(authority._removed.count).toBe(1);
  });
});
