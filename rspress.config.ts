import path from 'node:path';
import process from 'node:process';
import shadcnRegistryGenerate from '@cmtlyt/unplugin-shadcn-registry-generate';
import { defineConfig } from '@rspress/core';
import { config } from './scripts/config';

const isDev = process.env.NODE_ENV === 'development';

export default defineConfig(async () => {
  return {
    llms: true,
    base: '/lingshu-toolkit/',
    root: path.resolve(__dirname, 'src'),
    title: 'lingshu',
    route: {
      exclude: ['**/*.test.{ts,tsx,js,jsx}', '**/*.{ts,tsx,js,jsx}'],
    },
    lang: 'zh',
    i18nSource: {
      outlineTitle: { zh: '目录', en: 'Outline' },
      prevPageText: { zh: '上一页', en: 'Previous Page' },
      nextPageText: { zh: '下一页', en: 'Next Page' },
    },
    markdown: {
      showLineNumbers: true,
    },
    builderConfig: {
      output: {
        copy: [
          {
            from: path.resolve(__dirname, 'src/public/r'),
            to: path.resolve(__dirname, 'doc_build/r'),
          },
        ],
      },
      tools: {
        rspack: {
          plugins: isDev
            ? []
            : [
                shadcnRegistryGenerate.rspack({
                  outputDir: config.shadcnRegistryPluginOutputDir,
                  basePath: config.shadcnRegistryPluginBasePath,
                  registryUrl: config.registryUrl,
                  noRootRegistry: config.shadcnRegistryPluginNoRoot,
                }),
              ],
        },
      },
    },
  };
});
