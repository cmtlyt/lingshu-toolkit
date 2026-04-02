import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { allx } from '../index';

describe('allx - 实际使用场景测试', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  test('模拟数据获取场景', async () => {
    const result = await allx({
      user: async () => {
        return { id: 1, name: 'John' };
      },
      posts: async function () {
        const user = await this.$.user;
        return [
          { userId: user.id, title: 'Post 1' },
          { userId: user.id, title: 'Post 2' },
        ];
      },
      comments: async function () {
        const posts = await this.$.posts;
        return posts.map((post: { title: string }) => {
          return { postTitle: post.title, comment: 'Great!' };
        });
      },
    });

    expect(result.user).toEqual({ id: 1, name: 'John' });
    expect(result.posts).toHaveLength(2);
    expect(result.comments).toHaveLength(2);
  });

  test('模拟配置加载场景', async () => {
    const result = await allx({
      baseConfig: async () => {
        return { apiUrl: 'https://api.example.com' };
      },
      userConfig: async () => {
        return { theme: 'dark' };
      },
      mergedConfig: async function () {
        const [base, user] = await Promise.all([this.$.baseConfig, this.$.userConfig]);
        return { ...base, ...user };
      },
    });

    expect(result.mergedConfig).toEqual({
      apiUrl: 'https://api.example.com',
      theme: 'dark',
    });
  });

  test('模拟并行 API 调用', async () => {
    const result = await allx({
      api1: async () => {
        await vi.advanceTimersByTimeAsync(10);
        return { data: 'api1' };
      },
      api2: async () => {
        await vi.advanceTimersByTimeAsync(15);
        return { data: 'api2' };
      },
      api3: async () => {
        await vi.advanceTimersByTimeAsync(5);
        return { data: 'api3' };
      },
      combined: async function () {
        const [r1, r2, r3] = await Promise.all([this.$.api1, this.$.api2, this.$.api3]);
        return [r1.data, r2.data, r3.data];
      },
    });

    expect(result.combined).toEqual(['api1', 'api2', 'api3']);
  });
});
