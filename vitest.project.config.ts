import process from 'node:process';
import react from '@vitejs/plugin-react';
import vue from '@vitejs/plugin-vue';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig, mergeConfig, type TestProjectInlineConfiguration } from 'vitest/config';
import vitestBaseConfig from './vitest.base.config';

function getBrowserProjectConfig(namespace: string, config: TestProjectInlineConfiguration = {}) {
  return mergeConfig(
    vitestBaseConfig,
    mergeConfig(
      defineConfig({
        test: {
          typecheck: {
            // typecheck 过于耗时, ci 环境直接禁用
            enabled: process.env.skip_type_check?.trim() !== 'true',
            include: [`src/${namespace}/**/*.test-d.ts`],
            ignoreSourceErrors: true,
          },
          include: [`src/${namespace}/**/*.test.{ts,tsx}`, `src/${namespace}/**/*.browser.test.{ts,tsx}`],
          browser: {
            enabled: true,
            provider: playwright(),
            // https://vitest.dev/config/browser/playwright
            instances: [{ browser: 'chromium', headless: true, name: namespace }],
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
            exclude: ['src/shared/**/*.node.test.{ts,tsx}'],
          },
        }),
        // shared node test
        getBrowserProjectConfig('shared', {
          test: {
            name: 'shared#node',
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
