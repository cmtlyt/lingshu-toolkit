import react from '@vitejs/plugin-react';
import vue from '@vitejs/plugin-vue';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig, mergeConfig, type TestProjectInlineConfiguration } from 'vitest/config';
import vitestBaseConfig from './vitest.base.config';

/**
 * 为指定的命名空间构建并返回一个包含浏览器测试设置的 Vitest 项目配置。
 *
 * 返回基于项目基础配置并预配置了类型检查、测试文件匹配模式与 Playwright 浏览器实例的项目配置，同时允许通过 `config` 参数覆盖或扩展这些设置。
 *
 * @param namespace - 对应 src/<namespace> 目录下的测试文件所属命名空间，用于生成测试文件的匹配模式
 * @param config - 可选的额外或覆盖的项目配置
 * @returns 合并后的项目配置对象（TestProjectInlineConfiguration），针对指定命名空间已启用浏览器测试并包含相应的测试文件匹配规则
 */
function getBrowserProjectConfig(namespace: string, config: TestProjectInlineConfiguration = {}) {
  return mergeConfig(
    vitestBaseConfig,
    mergeConfig(
      defineConfig({
        test: {
          typecheck: {
            enabled: true,
            include: [`src/${namespace}/**/*.test-d.ts`],
          },
          include: [`src/${namespace}/**/*.test.{ts,tsx}`, `src/${namespace}/**/*.browser.test.{ts,tsx}`],
          browser: {
            enabled: true,
            provider: playwright(),
            // https://vitest.dev/config/browser/playwright
            instances: [{ browser: 'chromium', headless: true }],
          },
        },
      }),
      config,
    ),
  );
}

export default mergeConfig(
  vitestBaseConfig,
  defineConfig({
    test: {
      projects: [
        getBrowserProjectConfig('shared'),
        // shared node test
        getBrowserProjectConfig('shared', {
          test: {
            browser: { enabled: false },
            exclude: ['src/shared/**/*.browser.test.{ts,tsx}'],
          },
        }),
        getBrowserProjectConfig('react', {
          plugins: [react() as any],
        }),
        getBrowserProjectConfig('vue', {
          plugins: [vue() as any],
        }),
      ],
    },
  }),
);