import { existsSync, globSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import shadcnRegistryGenerate from '@cmtlyt/unplugin-shadcn-registry-generate';
import { defineConfig } from '@rslib/core';
import { config } from './scripts/config';

function getEntrys(namespace: string) {
  return globSync([`src/${namespace}/**/*.ts`], {
    cwd: import.meta.dirname,
    exclude: [`src/${namespace}/index.ts`, 'src/**/*.test.{ts,tsx,js,jsx}', 'src/**/*.test-d.{ts,tsx,js,jsx}'],
  });
}

const metaFilePath = path.resolve(__dirname, 'meta/toolkit.meta.json');

function getEntryInfo() {
  const unbundleEntryResult: Record<string, string[]> = {};
  const mainEntryResult: Record<string, string[]> = {};

  if (!existsSync(metaFilePath)) {
    writeFileSync(metaFilePath, '{}\n');
  }

  const meta = JSON.parse(readFileSync(metaFilePath, 'utf-8'));
  const namespaces = Reflect.ownKeys(meta) as string[];

  namespaces.forEach((ns) => {
    const nsp = path.resolve(__dirname, 'src', ns);
    const entrys = getEntrys(ns);
    if (existsSync(path.resolve(nsp, 'index.ts'))) {
      mainEntryResult[`${ns}/index`] = [`./src/${ns}/index.ts`];
    }
    if (entrys.length > 0) {
      unbundleEntryResult[ns] = entrys;
    }
  });

  return {
    unbundleEntry: unbundleEntryResult,
    mainEntry: mainEntryResult,
  };
}

const { unbundleEntry, mainEntry } = getEntryInfo();

export default defineConfig({
  output: {
    target: 'web',
    minify: true,
    copy: [{ from: path.resolve(__dirname, './.npmignore'), to: path.resolve(__dirname, './dist') }],
  },
  lib: [
    {
      source: {
        entry: unbundleEntry,
      },
      outBase: './src',
      format: 'esm',
      dts: true,
      bundle: false,
    },
    {
      source: { entry: mainEntry },
      format: 'esm',
      dts: true,
      bundle: true,
      tools: {
        rspack: {
          plugins: [
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
  ],
  server: { publicDir: false },
});
