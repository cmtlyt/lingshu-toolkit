import { describe, expect, test } from 'vitest';
import { serializeAuthority } from '../../authority/serialize';

describe('authority/serialize — field order contract', () => {
  test('字段顺序严格为 rev → ts → epoch → snapshot', () => {
    const raw = serializeAuthority(42, 1_714_198_800_123, 'persistent', { a: 1 });
    expect(raw).toBe('{"rev":42,"ts":1714198800123,"epoch":"persistent","snapshot":{"a":1}}');

    // rev 索引 < ts 索引 < epoch 索引 < snapshot 索引
    const revIdx = raw.indexOf('"rev"');
    const tsIdx = raw.indexOf('"ts"');
    const epochIdx = raw.indexOf('"epoch"');
    const snapshotIdx = raw.indexOf('"snapshot"');
    expect(revIdx).toBeLessThan(tsIdx);
    expect(tsIdx).toBeLessThan(epochIdx);
    expect(epochIdx).toBeLessThan(snapshotIdx);
  });

  test('rev 永远在首位（索引 1，紧接左花括号）', () => {
    const raw = serializeAuthority(0, 0, 'persistent', null);
    expect(raw.startsWith('{"rev":0')).toBe(true);
  });

  test('负数 rev 正确序列化', () => {
    const raw = serializeAuthority(-1, 100, 'persistent', null);
    expect(raw).toBe('{"rev":-1,"ts":100,"epoch":"persistent","snapshot":null}');
  });

  test('产物可被 JSON.parse 还原', () => {
    const raw = serializeAuthority(7, 1_700_000_000_000, 'abc-123', { nested: { x: [1, 2] } });
    const parsed = JSON.parse(raw);
    expect(parsed).toEqual({
      rev: 7,
      ts: 1_700_000_000_000,
      epoch: 'abc-123',
      snapshot: { nested: { x: [1, 2] } },
    });
  });

  test('epoch 为 UUID 字符串时正确转义', () => {
    const epoch = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
    const raw = serializeAuthority(1, 1, epoch, {});
    expect(JSON.parse(raw).epoch).toBe(epoch);
  });

  test('snapshot 含引号 / 反斜杠 / 换行等特殊字符时正确转义', () => {
    const snapshot = {
      quote: 'hello "world"',
      backslash: 'a\\b',
      newline: 'line1\nline2',
      unicode: '中文🚀',
    };
    const raw = serializeAuthority(1, 1, 'persistent', snapshot);
    expect(JSON.parse(raw).snapshot).toEqual(snapshot);
  });

  test('snapshot 字面量包含 "rev" 或 "epoch" 字段不会干扰外层解析', () => {
    // 用户 snapshot 里的 "rev" / "epoch" 字段与外层结构同名，但因为在 snapshot 内部，
    // 正则 extract 只锚定开头不会被误匹配
    const snapshot = { rev: 999, epoch: 'user-epoch', ts: -1 };
    const raw = serializeAuthority(5, 1000, 'outer-epoch', snapshot);
    const parsed = JSON.parse(raw);
    expect(parsed.rev).toBe(5);
    expect(parsed.epoch).toBe('outer-epoch');
    expect(parsed.ts).toBe(1000);
    expect(parsed.snapshot).toEqual(snapshot);
  });

  test('snapshot 为数组 / 原始类型时也能序列化', () => {
    expect(JSON.parse(serializeAuthority(1, 1, 'persistent', [1, 2, 3])).snapshot).toEqual([1, 2, 3]);
    expect(JSON.parse(serializeAuthority(1, 1, 'persistent', 'plain-string')).snapshot).toBe('plain-string');
    expect(JSON.parse(serializeAuthority(1, 1, 'persistent', 42)).snapshot).toBe(42);
    expect(JSON.parse(serializeAuthority(1, 1, 'persistent', null)).snapshot).toBe(null);
  });
});
