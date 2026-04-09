import process from 'node:process';
import react from '@vitejs/plugin-react';
import vue from '@vitejs/plugin-vue';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig, mergeConfig, type TestProjectInlineConfiguration } from 'vitest/config';
import vitestBaseConfig from './vitest.base.config';

const CI_TEST = process.env.ci_test?.trim() === 'true';

function getBrowserProjectConfig(namespace: string, config: TestProjectInlineConfiguration = {}) {
  return mergeConfig(
    vitestBaseConfig,
    mergeConfig(
      defineConfig({
        test: {
          typecheck: {
            // typecheck 过于耗时, ci 环境直接禁用
            enabled: !CI_TEST,
            include: [`src/${namespace}/**/*.test-d.ts`],
            ignoreSourceErrors: true,
          },
          include: [`src/${namespace}/**/*.test.{ts,tsx,js,jsx}`, `src/${namespace}/**/*.browser.test.{ts,tsx,js,jsx}`],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright({ launchOptions: { channel: 'chromium' } }),
            // https://vitest.dev/config/browser/playwright
            instances: [{ browser: 'chromium', name: `browser#${namespace}` }],
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
        getBrowserProjectConfig('shared', {
          test: {
            exclude: ['src/shared/**/*.node.test.{ts,tsx,js,jsx}'],
          },
        }),
        // shared node test
        getBrowserProjectConfig('shared', {
          test: {
            name: 'node#shared',
            browser: { enabled: false },
            exclude: ['src/shared/**/*.browser.test.{ts,tsx,js,jsx}'],
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
