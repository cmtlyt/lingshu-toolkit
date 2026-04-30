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
function createTestLogger(): LoggerAdapter & { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } {
  return {
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
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

    paired.tabA.postMessage(buildProbeMessage('probe-xyz'));
    // 等待 BroadcastChannel 投递
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(replies).toHaveLength(1);
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
    await new Promise((resolve) => setTimeout(resolve, 50));

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
    await new Promise((resolve) => setTimeout(resolve, 50));

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
    await new Promise((resolve) => setTimeout(resolve, 50));

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
    await new Promise((resolve) => setTimeout(resolve, 50));
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
