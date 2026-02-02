import tsConfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';
import { pluginAutoPatchFile } from './plugins/auto-patch-file';
import { config } from './scripts/config';

export default defineConfig({
  // Configure Vitest (https://vitest.dev/config/)
  plugins: [
    tsConfigPaths(),
    pluginAutoPatchFile({ registryUrl: config.registryUrl, mateFile: 'meta/toolkit.meta.json' }),
  ],
  test: {
    coverage: {
      include: ['src/**'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/**/*.{mdx,md}',
        'src/**/*.test-d.{ts,tsx}',
        'src/test/**',
        'src/**/*.test.browser.{ts,tsx}',
      ],
      provider: 'v8',
      cleanOnRerun: false,
      reporter: ['json', 'html'],
      reportOnFailure: true,
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
    clearMocks: true,
  },
});
