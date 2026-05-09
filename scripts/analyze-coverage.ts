#!/usr/bin/env node
/**
 * 分析 vitest 产出的 `coverage/coverage-final.json`，找出指定模块下的未覆盖
 * 文件 / 行号 / 分支，便于针对性补测试。
 *
 * 用法：
 *   esno scripts/analyze-coverage.ts <module-path-fragment> [--with-source] [--file=<path-fragment>]
 *
 * 例：
 *   esno scripts/analyze-coverage.ts src/shared/lock-data
 *   esno scripts/analyze-coverage.ts src/shared/lock-data --with-source
 *   esno scripts/analyze-coverage.ts src/shared/lock-data --with-source --file=broadcast-state
 *
 * 前置：先跑一次 `pnpm test` 或 `pnpm test:lib`（带 `--coverage.enabled`）生成
 * `coverage/coverage-final.json`；项目里 `pnpm test:ci` 不开启 coverage，所以 CI
 * 模式跑完后此脚本会因找不到 coverage 文件而失败 —— 此时改用 `pnpm test --run`
 * 等带 coverage 的命令重跑一次。
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { argv, cwd, exit } from 'node:process';

// ---------------------------------------------------------------------------
// 类型定义：对齐 istanbul-lib-coverage / vitest v8 reporter 的 coverage-final.json 形状
// ---------------------------------------------------------------------------

interface SourceLocation {
  readonly line: number;
  readonly column: number;
}

interface SourceRange {
  readonly start: SourceLocation;
  readonly end: SourceLocation;
}

interface FunctionMapEntry {
  readonly name: string;
  readonly decl: SourceRange;
  readonly loc: SourceRange;
  readonly line: number;
}

interface BranchMapEntry {
  readonly type: string;
  readonly line: number;
  readonly loc: SourceRange;
  readonly locations: readonly SourceRange[];
}

// `s` / `f` / `b` 是 istanbul coverage-final.json 的固定字段名（hits 计数表），
// 由 vitest / istanbul 直接产出，无法改名 —— 故对单字符标识豁免 useNamingConvention
// biome-ignore-start lint/style/useNamingConvention: istanbul coverage 外部数据契约固定使用 s/f/b 单字符字段名
interface FileCoverageEntry {
  readonly statementMap: Readonly<Record<string, SourceRange>>;
  readonly fnMap: Readonly<Record<string, FunctionMapEntry>>;
  readonly branchMap: Readonly<Record<string, BranchMapEntry>>;
  readonly s: Readonly<Record<string, number>>;
  readonly f: Readonly<Record<string, number>>;
  readonly b: Readonly<Record<string, readonly number[]>>;
}
// biome-ignore-end lint/style/useNamingConvention: istanbul coverage 外部数据契约固定使用 s/f/b 单字符字段名

type CoverageReport = Readonly<Record<string, FileCoverageEntry>>;

interface UncoveredStatement {
  readonly id: string;
  readonly line: number | undefined;
  readonly column: number | undefined;
}

interface UncoveredFunction {
  readonly id: string;
  readonly name: string | undefined;
  readonly line: number | undefined;
}

interface UncoveredBranch {
  readonly id: string;
  readonly branchIdx: number;
  readonly type: string | undefined;
  readonly line: number | undefined;
  readonly locStart: SourceLocation | undefined;
}

interface FileSummary {
  readonly file: string;
  readonly statements: { readonly total: number; readonly uncovered: readonly UncoveredStatement[] };
  readonly functions: { readonly total: number; readonly uncovered: readonly UncoveredFunction[] };
  readonly branches: { readonly total: number; readonly uncovered: readonly UncoveredBranch[] };
}

interface CliOptions {
  readonly moduleFilter: string;
  readonly withSourceContext: boolean;
  readonly fileFilter: string | undefined;
}

// ---------------------------------------------------------------------------
// CLI 参数解析
// ---------------------------------------------------------------------------

function parseCliOptions(rawArgs: readonly string[]): CliOptions {
  const positionalArg = rawArgs.find((arg) => !arg.startsWith('--'));
  const fileFlag = rawArgs.find((arg) => arg.startsWith('--file='));
  return {
    moduleFilter: positionalArg || 'src/shared/lock-data',
    withSourceContext: rawArgs.includes('--with-source'),
    fileFilter: fileFlag ? fileFlag.slice('--file='.length) : undefined,
  };
}

// ---------------------------------------------------------------------------
// 源码读取 + 片段构造（仅在 --with-source 模式下使用）
// ---------------------------------------------------------------------------

const sourceCache = new Map<string, readonly string[] | null>();

function readSourceLines(absoluteFilePath: string): readonly string[] | null {
  const cached = sourceCache.get(absoluteFilePath);
  if (cached !== undefined) {
    return cached;
  }
  if (!existsSync(absoluteFilePath)) {
    sourceCache.set(absoluteFilePath, null);
    return null;
  }
  const sourceLines = readFileSync(absoluteFilePath, 'utf-8').split('\n');
  sourceCache.set(absoluteFilePath, sourceLines);
  return sourceLines;
}

function buildSourceSnippet(
  sourceLines: readonly string[] | null,
  targetLine: number | undefined,
  contextLines: number,
): string {
  if (!(sourceLines && targetLine)) {
    return '';
  }
  const startLine = Math.max(1, targetLine - contextLines);
  const endLine = Math.min(sourceLines.length, targetLine + contextLines);
  const renderedLines: string[] = [];
  for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
    const marker = lineNumber === targetLine ? '>' : ' ';
    renderedLines.push(`      ${marker} ${String(lineNumber).padStart(4)} | ${sourceLines[lineNumber - 1]}`);
  }
  return `\n${renderedLines.join('\n')}`;
}

// ---------------------------------------------------------------------------
// 单文件覆盖度提取
// ---------------------------------------------------------------------------

function extractUncoveredStatements(entry: FileCoverageEntry): UncoveredStatement[] {
  const result: UncoveredStatement[] = [];
  for (const [id, hits] of Object.entries(entry.s)) {
    if (hits !== 0) {
      continue;
    }
    const start = entry.statementMap[id]?.start;
    result.push({ id, line: start?.line, column: start?.column });
  }
  return result;
}

function extractUncoveredFunctions(entry: FileCoverageEntry): UncoveredFunction[] {
  const result: UncoveredFunction[] = [];
  for (const [id, hits] of Object.entries(entry.f)) {
    if (hits !== 0) {
      continue;
    }
    const fnInfo = entry.fnMap[id];
    result.push({ id, name: fnInfo?.name, line: fnInfo?.decl?.start?.line });
  }
  return result;
}

function extractUncoveredBranches(entry: FileCoverageEntry): UncoveredBranch[] {
  const result: UncoveredBranch[] = [];
  for (const [id, hitsArr] of Object.entries(entry.b)) {
    if (!Array.isArray(hitsArr)) {
      continue;
    }
    for (let branchIdx = 0; branchIdx < hitsArr.length; branchIdx += 1) {
      if (hitsArr[branchIdx] !== 0) {
        continue;
      }
      const branchInfo = entry.branchMap[id];
      result.push({
        id,
        branchIdx,
        type: branchInfo?.type,
        line: branchInfo?.line,
        locStart: branchInfo?.locations?.[branchIdx]?.start,
      });
    }
  }
  return result;
}

function countTotalBranches(entry: FileCoverageEntry): number {
  let total = 0;
  for (const hitsArr of Object.values(entry.b)) {
    if (Array.isArray(hitsArr)) {
      total += hitsArr.length;
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function loadCoverageReport(coveragePath: string): CoverageReport {
  if (!existsSync(coveragePath)) {
    console.error(`[analyze-coverage] coverage 文件不存在：${coveragePath}`);
    console.error('[analyze-coverage] 请先跑一次带 coverage 的测试，例如：pnpm test 或 pnpm test:lib');
    exit(1);
  }
  const raw = readFileSync(coveragePath, 'utf-8');
  return JSON.parse(raw) as CoverageReport;
}

function buildSummary(
  report: CoverageReport,
  moduleFilter: string,
  repoRoot: string,
): {
  readonly totalFiles: number;
  readonly summary: readonly FileSummary[];
} {
  let totalFiles = 0;
  const summary: FileSummary[] = [];

  for (const [absPath, fileData] of Object.entries(report)) {
    if (!absPath.includes(moduleFilter)) {
      continue;
    }
    totalFiles += 1;

    const uncoveredStatements = extractUncoveredStatements(fileData);
    const uncoveredFunctions = extractUncoveredFunctions(fileData);
    const uncoveredBranches = extractUncoveredBranches(fileData);

    if (uncoveredStatements.length === 0 && uncoveredFunctions.length === 0 && uncoveredBranches.length === 0) {
      continue;
    }

    summary.push({
      file: absPath.replace(`${repoRoot}/`, ''),
      statements: { total: Object.keys(fileData.s).length, uncovered: uncoveredStatements },
      functions: { total: Object.keys(fileData.f).length, uncovered: uncoveredFunctions },
      branches: { total: countTotalBranches(fileData), uncovered: uncoveredBranches },
    });
  }

  return { totalFiles, summary };
}

function printFileSummary(item: FileSummary, repoRoot: string, contextSize: number, withSource: boolean): void {
  console.log(`\n📁 ${item.file}`);
  const absoluteFilePath = resolve(repoRoot, item.file);
  const sourceLines = withSource ? readSourceLines(absoluteFilePath) : null;

  if (item.statements.uncovered.length > 0) {
    console.log(`  ✗ Statements (${item.statements.uncovered.length}/${item.statements.total}):`);
    for (const stmt of item.statements.uncovered) {
      console.log(
        `      - id=${stmt.id} line=${stmt.line} col=${stmt.column}${buildSourceSnippet(sourceLines, stmt.line, contextSize)}`,
      );
    }
  }
  if (item.functions.uncovered.length > 0) {
    console.log(`  ✗ Functions  (${item.functions.uncovered.length}/${item.functions.total}):`);
    for (const fn of item.functions.uncovered) {
      console.log(
        `      - id=${fn.id} name=${fn.name} line=${fn.line}${buildSourceSnippet(sourceLines, fn.line, contextSize)}`,
      );
    }
  }
  if (item.branches.uncovered.length > 0) {
    console.log(`  ✗ Branches   (${item.branches.uncovered.length}/${item.branches.total}):`);
    for (const branch of item.branches.uncovered) {
      const locDescription = `${branch.locStart?.line}:${branch.locStart?.column}`;
      console.log(
        `      - id=${branch.id}#${branch.branchIdx} type=${branch.type} line=${branch.line} loc=${locDescription}${buildSourceSnippet(sourceLines, branch.line, contextSize)}`,
      );
    }
  }
}

function main(): void {
  const cliOptions = parseCliOptions(argv.slice(2));
  const repoRoot = cwd();
  const coveragePath = resolve(repoRoot, 'coverage/coverage-final.json');

  const report = loadCoverageReport(coveragePath);
  const { totalFiles, summary } = buildSummary(report, cliOptions.moduleFilter, repoRoot);

  console.log(`\n=== Coverage Analysis: ${cliOptions.moduleFilter} ===`);
  console.log(`Files scanned : ${totalFiles}`);
  console.log(`Files dirty   : ${summary.length}\n`);

  const contextSize = cliOptions.withSourceContext ? 1 : 0;
  for (const item of summary) {
    if (cliOptions.fileFilter && !item.file.includes(cliOptions.fileFilter)) {
      continue;
    }
    printFileSummary(item, repoRoot, contextSize, cliOptions.withSourceContext);
  }

  console.log('\n=== End ===\n');
}

main();
