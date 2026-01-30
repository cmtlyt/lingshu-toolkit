import { describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-vue';
import { defineComponent, nextTick, ref } from 'vue';
import { useTitle } from './index';

describe('useTitle', () => {
  test('导出测试', () => {
    expect(useTitle).toBeTypeOf('function');
  });

  test('基本使用 - 设置静态标题', async () => {
    const originalTitle = document.title;

    const TestComponent = defineComponent({
      setup() {
        useTitle('测试标题');
        return () => null;
      },
    });

    render(TestComponent);
    await nextTick();

    expect(document.title).toBe('测试标题');

    document.title = originalTitle;
  });

  test('返回值可以手动修改', async () => {
    const originalTitle = document.title;

    const TestComponent = defineComponent({
      setup() {
        const title = useTitle('初始标题');

        setTimeout(() => {
          title.value = '手动修改的标题';
        }, 10);

        return () => null;
      },
    });

    render(TestComponent);
    await nextTick();

    expect(document.title).toBe('初始标题');

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.title).toBe('手动修改的标题');

    document.title = originalTitle;
  });

  test('响应式更新 - 使用 ref', async () => {
    const originalTitle = document.title;
    const title = ref('初始标题');

    const TestComponent = defineComponent({
      setup() {
        useTitle(title);
        return () => null;
      },
    });

    render(TestComponent);
    await nextTick();

    expect(document.title).toBe('初始标题');

    title.value = '更新后的标题';
    await nextTick();
    expect(document.title).toBe('更新后的标题');

    document.title = originalTitle;
  });

  test('卸载时恢复原始标题', async () => {
    const originalTitle = 'Original Title';
    document.title = originalTitle;

    const TestComponent = defineComponent({
      setup() {
        useTitle('新标题');
        return () => null;
      },
    });

    const { unmount } = render(TestComponent);
    await nextTick();

    expect(document.title).toBe('新标题');

    unmount();
    await nextTick();
    expect(document.title).toBe(originalTitle);
  });

  test('配置 restoreOnUnmount 为 false', async () => {
    const originalTitle = 'Original Title';
    document.title = originalTitle;

    const TestComponent = defineComponent({
      setup() {
        useTitle('新标题', { restoreOnUnmount: false });
        return () => null;
      },
    });

    const { unmount } = render(TestComponent);
    await nextTick();

    expect(document.title).toBe('新标题');

    unmount();
    await nextTick();
    expect(document.title).toBe('新标题');

    document.title = originalTitle;
  });

  test('多次更新标题', async () => {
    const originalTitle = document.title;
    const title = ref('标题1');

    const TestComponent = defineComponent({
      setup() {
        useTitle(title);
        return () => null;
      },
    });

    render(TestComponent);
    await nextTick();

    expect(document.title).toBe('标题1');

    title.value = '标题2';
    await nextTick();
    expect(document.title).toBe('标题2');

    title.value = '标题3';
    await nextTick();
    expect(document.title).toBe('标题3');

    document.title = originalTitle;
  });

  test('返回的 ref 与传入的 ref 同步', async () => {
    const originalTitle = document.title;
    const inputTitle = ref('输入标题');

    const TestComponent = defineComponent({
      setup() {
        const title = useTitle(inputTitle);

        expect(title.value).toBe('输入标题');

        setTimeout(() => {
          inputTitle.value = '外部修改';
        }, 10);

        return () => null;
      },
    });

    render(TestComponent);
    await nextTick();

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.title).toBe('外部修改');

    document.title = originalTitle;
  });

  test('不传入参数', async () => {
    const originalTitle = document.title;
    const TestComponent = defineComponent({
      setup() {
        useTitle();
        return () => null;
      },
    });
    render(TestComponent);
    await nextTick();
    expect(document.title).toBe(originalTitle);
  });
});
