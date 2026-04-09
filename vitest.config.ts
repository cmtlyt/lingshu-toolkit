import { defineConfig, mergeConfig } from 'vitest/config';
import vitestBaseConfig from './vitest.base.config';

export default mergeConfig(
  vitestBaseConfig,
  defineConfig({
    test: {
      include: ['src/**/*.test.{ts,tsx,js,jsx}'],
      exclude: ['src/{vue,react}/**', 'src/**/*.browser.test.{ts,tsx,js,jsx}'],
    },
  }),
);
