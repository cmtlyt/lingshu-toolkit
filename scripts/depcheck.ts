import path from 'node:path';
import { fileURLToPath } from 'node:url';
import depcheck, { type Options } from 'depcheck';

const options: Options = {
  skipMissing: false,
  ignoreBinPackage: false,
  ignoreMatches: ['@commitlint/*', '@vitest/*', 'changelogithub', 'cross-env', 'lint-staged'],
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));

depcheck(path.resolve(__dirname, '../'), options).then((unused) => {
  const { dependencies, devDependencies, missing, invalidFiles, invalidDirs } = unused;

  const errorMessages: string[] = [];

  // 检查未使用的依赖
  if (dependencies.length > 0) {
    errorMessages.push(`未使用的 dependencies: ${dependencies.join(', ')}`);
  }

  // 检查未使用的开发依赖
  if (devDependencies.length > 0) {
    errorMessages.push(`未使用的 devDependencies: ${devDependencies.join(', ')}`);
  }

  // 检查缺失的依赖
  if (Object.keys(missing).length > 0) {
    const missingEntries = Object.entries(missing)
      .map(([pkg, files]) => `${pkg} (used in: ${files.join(', ')})`)
      .join('; ');
    errorMessages.push(`缺失的依赖: ${missingEntries}`);
  }

  // 检查无效的文件
  if (invalidFiles.length > 0) {
    errorMessages.push(`无效的文件: ${invalidFiles.join(', ')}`);
  }

  // 检查无效的目录
  if (invalidDirs.length > 0) {
    errorMessages.push(`无效的目录: ${invalidDirs.join(', ')}`);
  }

  // 如果有任何问题，抛出错误
  if (errorMessages.length > 0) {
    const fullErrorMessage = errorMessages.join('\n');
    throw new Error(`depcheck: 发现依赖问题:\n${fullErrorMessage}`);
  }

  console.log('✅ 依赖检查通过，没有发现未使用或缺失的依赖');
});
