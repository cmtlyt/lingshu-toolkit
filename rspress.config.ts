import path from 'node:path';
import { env } from 'node:process';
import shadcnRegistryGenerate from '@cmtlyt/unplugin-shadcn-registry-generate';
import { defineConfig } from '@rspress/core';
import { config } from './scripts/config';

const isDev = env.NODE_ENV === 'development';

export default defineConfig({
  llms: true,
  base: '/lingshu-toolkit/',
  root: path.resolve(import.meta.dirname, 'src'),
  title: 'lingshu',
  route: {
    exclude: ['**/*.test.{ts,tsx,js,jsx}', '**/*.{ts,tsx,js,jsx}'],
  },
  lang: 'zh',
  themeConfig: {
    llmsUI: {
      placement: 'title',
    },
  },
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
          from: path.resolve(import.meta.dirname, 'src/public/r'),
          to: path.resolve(import.meta.dirname, 'doc_build/r'),
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
});
