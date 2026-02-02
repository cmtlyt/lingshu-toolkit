import react from '@vitejs/plugin-react';
import vue from '@vitejs/plugin-vue';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig, mergeConfig, type TestProjectInlineConfiguration } from 'vitest/config';
import vitestBaseConfig from './vitest.base.config';

function getProjectConfig(namespace: string, config: TestProjectInlineConfiguration = {}) {
  return mergeConfig(
    vitestBaseConfig,
    mergeConfig(
      defineConfig({
        test: {
          typecheck: {
            enabled: true,
            include: [`src/${namespace}/**/*.test-d.ts`],
          },
          include: [`src/${namespace}/**/*.test.{ts,tsx}`],
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
        getProjectConfig('shared'),
        getProjectConfig('shared', { test: { browser: { enabled: false } } }),
        getProjectConfig('react', {
          plugins: [react() as any],
        }),
        getProjectConfig('vue', {
          plugins: [vue() as any],
        }),
      ],
    },
  }),
);
