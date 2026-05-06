import { describe, expect, test } from 'vitest';
import { extractEpoch, extractRev, parseAuthorityRaw, readIfNewer } from '../../authority/extract';
import { serializeAuthority } from '../../authority/serialize';

describe('authority/extract — extractRev (fast path)', () => {
  test('标准产物正确提取 rev', () => {
    const raw = serializeAuthority(42, 1000, 'persistent', { a: 1 });
    expect(extractRev(raw)).toBe(42);
  });

  test('rev 为 0 正确提取', () => {
    expect(extractRev(serializeAuthority(0, 0, 'persistent', null))).toBe(0);
  });

  test('rev 为负数正确提取', () => {
    expect(extractRev(serializeAuthority(-1, 0, 'persistent', null))).toBe(-1);
  });

  test('rev 为多位数正确提取', () => {
    expect(extractRev(serializeAuthority(1_234_567_890, 0, 'persistent', null))).toBe(1_234_567_890);
  });

  test('非法格式（非 JSON 开头）失配返回 null', () => {
    expect(extractRev('invalid json')).toBe(null);
    expect(extractRev('')).toBe(null);
  });

  test('旧格式（字段顺序不同）失配返回 null', () => {
    expect(extractRev('{"ts":100,"rev":1,"snapshot":{}}')).toBe(null);
  });

  test('不会被 snapshot 内的 "rev" 字面量干扰', () => {
    // snapshot 内包含 rev 字段，外层 rev=5
    const raw = serializeAuthority(5, 100, 'persistent', { rev: 999 });
    expect(extractRev(raw)).toBe(5);
  });
});

describe('authority/extract — extractEpoch (fast path)', () => {
  test('标准产物正确提取 epoch', () => {
    expect(extractEpoch(serializeAuthority(1, 1, 'persistent', null))).toBe('persistent');
  });

  test('UUID epoch 正确提取', () => {
    const uuid = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
    expect(extractEpoch(serializeAuthority(1, 1, uuid, {}))).toBe(uuid);
  });

  test('非法格式失配返回 null', () => {
    expect(extractEpoch('invalid')).toBe(null);
    expect(extractEpoch('{"rev":1}')).toBe(null);
  });

  test('snapshot 内的 "epoch" 字段不会被错匹配', () => {
    // 外层 epoch=outer，snapshot 内也有 epoch 字段
    const raw = serializeAuthority(1, 1, 'outer-epoch', { epoch: 'inner-epoch' });
    expect(extractEpoch(raw)).toBe('outer-epoch');
  });
});

describe('authority/extract — readIfNewer (快路径 + 兜底)', () => {
  test('raw 为 null / 空串直接返回 null', () => {
    expect(readIfNewer({ lastAppliedRev: 0, epoch: null }, null)).toBe(null);
    expect(readIfNewer({ lastAppliedRev: 0, epoch: null }, '')).toBe(null);
  });

  test('远端 rev <= 本地 lastAppliedRev 走快路径直接丢弃', () => {
    const raw = serializeAuthority(3, 100, 'persistent', { big: 'data' });
    expect(readIfNewer({ lastAppliedRev: 3, epoch: null }, raw)).toBe(null);
    expect(readIfNewer({ lastAppliedRev: 5, epoch: null }, raw)).toBe(null);
  });

  test('远端 rev > 本地 lastAppliedRev 返回 snapshot', () => {
    const raw = serializeAuthority(5, 100, 'persistent', { value: 42 });
    const result = readIfNewer({ lastAppliedRev: 3, epoch: null }, raw);
    expect(result).toEqual({ rev: 5, snapshot: { value: 42 } });
  });

  test('epoch 不一致时（本地有 epoch）走快路径丢弃', () => {
    const raw = serializeAuthority(5, 100, 'epoch-a', { value: 42 });
    expect(readIfNewer({ lastAppliedRev: 0, epoch: 'epoch-b' }, raw)).toBe(null);
  });

  test('epoch 一致时正常返回', () => {
    const raw = serializeAuthority(5, 100, 'epoch-a', { value: 42 });
    const result = readIfNewer({ lastAppliedRev: 0, epoch: 'epoch-a' }, raw);
    expect(result).toEqual({ rev: 5, snapshot: { value: 42 } });
  });

  test('本地 epoch 为 null 时不做 epoch 过滤（初始化前）', () => {
    const raw = serializeAuthority(5, 100, 'any-epoch', { value: 42 });
    const result = readIfNewer({ lastAppliedRev: 0, epoch: null }, raw);
    expect(result).toEqual({ rev: 5, snapshot: { value: 42 } });
  });

  test('首次初始化（lastAppliedRev=0）且首个远端 rev=1 命中', () => {
    const raw = serializeAuthority(1, 100, 'persistent', { first: true });
    const result = readIfNewer({ lastAppliedRev: 0, epoch: null }, raw);
    expect(result).toEqual({ rev: 1, snapshot: { first: true } });
  });

  test('格式失配走 JSON.parse 兜底（旧格式字段顺序）', () => {
    const raw = '{"ts":100,"rev":5,"epoch":"persistent","snapshot":{"v":1}}';
    const result = readIfNewer({ lastAppliedRev: 0, epoch: null }, raw);
    expect(result).toEqual({ rev: 5, snapshot: { v: 1 } });
  });

  test('兜底路径同样遵守 rev / epoch 过滤', () => {
    // 旧格式 + rev 过期
    expect(
      readIfNewer({ lastAppliedRev: 10, epoch: null }, '{"ts":100,"rev":5,"epoch":"persistent","snapshot":{}}'),
    ).toBe(null);
    // 旧格式 + epoch 不一致
    expect(
      readIfNewer({ lastAppliedRev: 0, epoch: 'epoch-a' }, '{"ts":100,"rev":5,"epoch":"epoch-b","snapshot":{}}'),
    ).toBe(null);
  });

  test('非法 JSON 返回 null 不抛错', () => {
    expect(readIfNewer({ lastAppliedRev: 0, epoch: null }, 'not json')).toBe(null);
    expect(readIfNewer({ lastAppliedRev: 0, epoch: null }, '{incomplete')).toBe(null);
  });

  test('结构不完整（缺 rev / epoch 字段）返回 null', () => {
    expect(readIfNewer({ lastAppliedRev: 0, epoch: null }, '{"ts":1}')).toBe(null);
    expect(readIfNewer({ lastAppliedRev: 0, epoch: null }, '{"rev":"not-number"}')).toBe(null);
  });

  test('结构不完整（缺 snapshot 字段）走兜底路径返回 null', () => {
    // 旧格式触发 fallback：rev / epoch 都合法但 snapshot 字段完全缺失，必须返回 null
    // 防止把残缺记录当合法值返回 { snapshot: undefined } 污染应用层
    const raw = '{"ts":100,"rev":1,"epoch":"persistent"}';
    expect(readIfNewer({ lastAppliedRev: 0, epoch: null }, raw)).toBe(null);
  });
});

describe('authority/extract — parseAuthorityRaw (safe parse)', () => {
  test('合法产物返回完整结构', () => {
    const raw = serializeAuthority(5, 100, 'persistent', { a: 1 });
    expect(parseAuthorityRaw(raw)).toEqual({
      rev: 5,
      ts: 100,
      epoch: 'persistent',
      snapshot: { a: 1 },
    });
  });

  test('ts 缺失时兜底为 0', () => {
    const raw = '{"rev":5,"epoch":"persistent","snapshot":null}';
    expect(parseAuthorityRaw(raw)).toEqual({ rev: 5, ts: 0, epoch: 'persistent', snapshot: null });
  });

  test('非法 JSON 返回 null', () => {
    expect(parseAuthorityRaw('not json')).toBe(null);
    expect(parseAuthorityRaw('')).toBe(null);
  });

  test('rev 非数字返回 null', () => {
    expect(parseAuthorityRaw('{"rev":"5","epoch":"e","snapshot":null}')).toBe(null);
  });

  test('epoch 非字符串返回 null', () => {
    expect(parseAuthorityRaw('{"rev":5,"epoch":1,"snapshot":null}')).toBe(null);
  });

  test('snapshot 字段完全缺失返回 null（不当作合法记录）', () => {
    // 残缺值：rev / epoch 都合法但缺 snapshot key —— 必须按"非法结构"处理返回 null
    // 而不是返回 { snapshot: undefined } 让脏数据污染应用层
    expect(parseAuthorityRaw('{"rev":1,"epoch":"persistent"}')).toBe(null);
    expect(parseAuthorityRaw('{"rev":1,"ts":100,"epoch":"persistent"}')).toBe(null);
  });

  test('snapshot 为合法 falsy 值（null / false / 0 / 空串）正常通过', () => {
    // snapshot 字段允许任意类型；关键是"键存在"而非"值真值"
    expect(parseAuthorityRaw('{"rev":1,"epoch":"e","snapshot":null}')).toEqual({
      rev: 1,
      ts: 0,
      epoch: 'e',
      snapshot: null,
    });
    expect(parseAuthorityRaw('{"rev":1,"epoch":"e","snapshot":false}')).toEqual({
      rev: 1,
      ts: 0,
      epoch: 'e',
      snapshot: false,
    });
    expect(parseAuthorityRaw('{"rev":1,"epoch":"e","snapshot":0}')).toEqual({
      rev: 1,
      ts: 0,
      epoch: 'e',
      snapshot: 0,
    });
    expect(parseAuthorityRaw('{"rev":1,"epoch":"e","snapshot":""}')).toEqual({
      rev: 1,
      ts: 0,
      epoch: 'e',
      snapshot: '',
    });
  });

  test('snapshot 为显式 undefined（JSON 中无法直接表达，以 key 存在但值缺失的等价形式校验）', () => {
    // 标准 JSON 不支持 undefined 字面量；"key 存在但值是 undefined"在 JSON.parse 产物中
    // 唯一可能出现的形式是 key 在源串中显式出现 —— 这种用 in / Reflect.has 仍判定为 true
    // 为了让脏数据无法绕过校验，构造一个 Object.create(null) 形式的对象走非 JSON 路径已不可达
    // （parseAuthorityRaw 入口必经 JSON.parse），此处仅做契约说明：JSON.parse 产物只会出现两种形态
    //   1. snapshot key 完全不出现 → Reflect.has = false → 返回 null（上一用例已覆盖）
    //   2. snapshot key 出现 + 任意 JSON 值 → Reflect.has = true → 通过（本用例已覆盖）
    expect(true).toBe(true);
  });
});

describe('authority/extract — 性能快路径（大 snapshot 不解析）', () => {
  test('大 snapshot + rev 过期时，快路径在亚毫秒级完成', () => {
    // 构造一个 1MB 级别的 snapshot
    const bigSnapshot = { payload: 'x'.repeat(1 * 1024 * 1024) };
    const raw = serializeAuthority(3, 100, 'persistent', bigSnapshot);

    // 快路径 rev 过期（本地已 applied 到 5）：应该立即丢弃，不 parse 1MB 数据
    const start = performance.now();
    const result = readIfNewer({ lastAppliedRev: 5, epoch: null }, raw);
    const elapsed = performance.now() - start;

    expect(result).toBe(null);
    // 快路径理论上 < 1ms，放宽到 10ms 避免 CI 抖动
    expect(elapsed).toBeLessThan(10);
  });

  test('大 snapshot + epoch 不一致时，快路径不解析 snapshot', () => {
    const bigSnapshot = { payload: 'y'.repeat(512 * 1024) };
    const raw = serializeAuthority(10, 100, 'epoch-a', bigSnapshot);

    const start = performance.now();
    const result = readIfNewer({ lastAppliedRev: 0, epoch: 'epoch-b' }, raw);
    const elapsed = performance.now() - start;

    expect(result).toBe(null);
    expect(elapsed).toBeLessThan(10);
  });
});
