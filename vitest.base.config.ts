import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tsConfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';
import { pluginAutoPatchFile } from './plugins/auto-patch-file';
import { config } from './scripts/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
        'src/shared/logger/**',
        'src/**/__test__/*',
        'src/**/*.test.{ts,tsx,js,jsx}',
        'src/**/*.{mdx,md}',
        'src/**/*.test-d.{ts,tsx,js,jsx}',
        'src/{test,public}/**',
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
    browser: {
      screenshotDirectory: path.resolve(__dirname, '__screenshots__'),
      screenshotFailures: false,
    },
  },
});
