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
