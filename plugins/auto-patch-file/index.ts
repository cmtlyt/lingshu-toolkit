/** biome-ignore-all lint/performance/noAwaitInLoops: plugin 不需要过于严格 */
/** biome-ignore-all lint/nursery/useNamedCaptureGroup: plugin 不需要过于严格 */
import fs from 'node:fs';
import path from 'node:path';
import process, { env } from 'node:process';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vitest/config';

const fsp = fs.promises;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface PluginAutoPatchFileOptions {
  root?: string;
  metaFile: string;
  registryUrl?: string;
  docGenIgnoreEntryCheck?: boolean;
  scriptMode?: boolean;
  debounceMs?: number;
}

interface Context {
  root: string;
  metaFile: string;
  registryUrl: string;
  shadcnExportsFile: string;
  docGenIgnoreEntryCheck: boolean;
  packageJson: Record<string, any>;
}

async function parseMetaFile(metaFile: string) {
  const meta = await fsp.readFile(metaFile, 'utf-8');
  return JSON.parse(meta);
}

async function initializeNamespace(namespacePath: string) {
  await fsp.mkdir(namespacePath, { recursive: true });
  await fsp.writeFile(path.resolve(namespacePath, 'index.ts'), 'export {};\n');
  return namespacePath;
}

function initializeNamespaces(namespaces: string[], ctx: Context) {
  return Promise.all(
    namespaces.map(async (ns) => {
      const nsp = path.resolve(ctx.root, 'src', formatDirname(ns));
      if (fs.existsSync(nsp) && fs.statSync(nsp).isDirectory()) {
        return { namespace: ns, namespacePath: nsp };
      }
      return { namespace: ns, namespacePath: await initializeNamespace(nsp) };
    }),
  );
}

interface ToolMeta {
  name: string;
}

function formatDirname(name: string) {
  return name.replace(/\B[A-Z]/gu, (match) => `-${match.toLowerCase()}`).toLowerCase();
}

const templateMap = new Proxy({} as Record<string, string>, {
  get(target, prop: string, receiver) {
    const cacheValue = Reflect.get(target, prop, receiver);
    if (cacheValue) {
      return cacheValue;
    }
    const template = fs.readFileSync(path.resolve(__dirname, 'template', prop), 'utf-8');
    Reflect.set(target, prop, template, receiver);
    return template;
  },
});

function parseTemplate(tempName: string, data: Record<string, any>) {
  let template = templateMap[tempName];
  template = template.replace(/\$\$(.*?)\$\$/gu, (_, key) => data[key]);
  return template;
}

function formatUpdateTime(date = new Date()) {
  const pad = (_n: number) => `${_n}`.padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function parseInjectData(toolPath: string, namespace: string, tool: ToolMeta, ctx: Context) {
  return {
    namespace,
    ...tool,
    shadcnPath: `${ctx.registryUrl}/${formatNameFromTool({ meta: tool, namespace })}`,
    npmVersion: ctx.packageJson.version,
    fileName: path.basename(toolPath),
    updateTime: formatUpdateTime(),
  };
}

const toolFiles = fs.readdirSync(path.resolve(__dirname, 'template'));

async function createToolFiles(toolPath: string, namespace: string, tool: ToolMeta, ctx: Context) {
  const entryPath = path.resolve(toolPath, 'index.ts');
  const hasEntry = fs.existsSync(entryPath);
  for (let i = 0, tempName = toolFiles[i]; i < toolFiles.length; tempName = toolFiles[++i]) {
    const filePath = path.resolve(toolPath, tempName);
    if (fs.existsSync(filePath)) {
      continue;
    }
    // 如果需要生成的是文档, 则判断是否忽略入口文件的检查, 如果忽略的话直接跳过该分支, 否则判断入口是否存在, 存在则警告并且跳过文件生成
    if (tempName.endsWith('.mdx') ? !ctx.docGenIgnoreEntryCheck && hasEntry : hasEntry) {
      console.warn(`${entryPath} already exists, skip create ${tempName}`);
      continue;
    }
    await fsp.writeFile(filePath, parseTemplate(tempName, parseInjectData(toolPath, namespace, tool, ctx)), 'utf-8');
  }
  return entryPath;
}

async function initializeTools(namespace: string, namespacePath: string, toolMetas: ToolMeta[], ctx: Context) {
  return Promise.all(
    toolMetas.map(async (tool) => {
      const toolPath = path.resolve(namespacePath, formatDirname(tool.name));
      if (!(fs.existsSync(toolPath) && fs.statSync(toolPath).isDirectory())) {
        await fsp.mkdir(toolPath, { recursive: true });
      }
      return { meta: tool, namespace, namespacePath, filePath: await createToolFiles(toolPath, namespace, tool, ctx) };
    }),
  );
}

async function writeJson(filePath: string, json: Record<string, any>) {
  return fsp.writeFile(filePath, `${JSON.stringify(json, null, 2)}\n`, 'utf-8');
}

async function packageJsonPatch(namespaces: string[], ctx: Context) {
  const packageJsonPath = path.resolve(ctx.root, 'package.json');
  const packageJson = JSON.parse(await fsp.readFile(packageJsonPath, 'utf-8'));
  ctx.packageJson = packageJson;

  const exports: Record<string, any> = packageJson.exports || {};

  namespaces.forEach((ns) => {
    exports[`./${ns}`] = {
      types: `./dist/${ns}/index.d.ts`,
      import: `./dist/${ns}/index.js`,
    };
    exports[`./${ns}/*`] = {
      types: `./dist/${ns}/*/index.d.ts`,
      import: `./dist/${ns}/*`,
    };
  });

  packageJson.exports = exports;

  return writeJson(packageJsonPath, packageJson);
}

type ToolInfo = Awaited<ReturnType<typeof initializeTools>>[number];

function formatNameFromTool(toolInfo: Pick<ToolInfo, 'namespace' | 'meta'>) {
  const { meta } = toolInfo;
  return `${toolInfo.namespace}${meta.name[0].toUpperCase()}${meta.name.slice(1)}`;
}

async function generateShadcnExports(toolInfos: ToolInfo[], ctx: Context) {
  const { root, shadcnExportsFile } = ctx;
  const exports = toolInfos.map((toolInfo) => {
    return {
      ...toolInfo.meta,
      name: formatNameFromTool(toolInfo),
      path: path.relative(root, toolInfo.filePath).split(path.sep).join('/'),
    };
  });

  return writeJson(shadcnExportsFile, {
    $schema: './node_modules/@cmtlyt/unplugin-shadcn-registry-generate/configuration-schema.json',
    exports,
  });
}

function createContext(options: PluginAutoPatchFileOptions) {
  const { root = process.cwd(), metaFile, registryUrl = './public/r' } = options;

  const realMetaFile = path.resolve(root, metaFile);
  const shadcnExportsFile = path.resolve(root, 'shadcn-exports.json');
  const ctx = {
    root,
    registryUrl,
    metaFile: realMetaFile,
    shadcnExportsFile,
    docGenIgnoreEntryCheck: options.docGenIgnoreEntryCheck === true,
    packageJson: {},
  };
  return ctx;
}

type NamespaceInfo = Awaited<ReturnType<typeof initializeNamespaces>>[number];

interface DocMeta {
  id: string;
  type: 'file' | 'dir';
  name: string;
  label?: string;
  tag?: string;
  overviewHeaders?: number[];
  context?: string;
  collapsed?: boolean;
}

async function initMetaMap(namespaceInfos: NamespaceInfo[]) {
  const metaMap = {} as Record<string, DocMeta[]>;
  const docSet = new Set<string>();
  await Promise.all(
    namespaceInfos.map(async ({ namespace, namespacePath }) => {
      const metaPath = path.resolve(namespacePath, '_meta.json');
      if (!fs.existsSync(metaPath)) {
        metaMap[namespace] = [];
        return;
      }
      metaMap[namespace] = JSON.parse((await fsp.readFile(metaPath, 'utf-8')).trim() || '[]');
      metaMap[namespace].forEach((item) => {
        docSet.add(item.id);
      });
    }),
  );
  return { metaMap, docSet };
}

async function generateDocMeta(namespaceInfos: NamespaceInfo[], metaMap: Record<string, DocMeta[]>) {
  return Promise.all(
    namespaceInfos.map(async ({ namespace, namespacePath }) => {
      const metaPath = path.resolve(namespacePath, '_meta.json');
      return writeJson(metaPath, metaMap[namespace]);
    }),
  );
}

function computeDocMeta(toolInfos: ToolInfo[], metaMap: Record<string, DocMeta[]>, docSet: Set<string>) {
  for (let i = 0, toolInfo = toolInfos[i]; i < toolInfos.length; toolInfo = toolInfos[++i]) {
    const { meta, namespace, namespacePath, filePath } = toolInfo;
    const toolPath = path.dirname(filePath);
    const docId = `${namespace}@${meta.name}`;

    if (docSet.has(docId)) {
      continue;
    }

    const toolMetaPath = path.resolve(toolPath, '_meta.json');
    if (fs.existsSync(toolMetaPath)) {
      metaMap[namespace].push({
        id: docId,
        type: 'dir',
        label: meta.name,
        name: path.relative(namespacePath, toolPath).split(path.sep).join('/'),
        collapsed: true,
      });
      continue;
    }

    const docPath = path.resolve(toolPath, 'index.mdx');
    if (!fs.existsSync(docPath)) {
      continue;
    }
    const docName = docPath
      .slice(namespacePath.length + 1)
      .split(path.sep)
      .join('/');
    metaMap[namespace].push({
      id: docId,
      type: 'file',
      label: meta.name,
      name: docName,
    });
  }
}

async function generateRspressDocMetas(namespaceInfos: NamespaceInfo[], toolInfos: ToolInfo[], _ctx: Context) {
  const { metaMap, docSet } = await initMetaMap(namespaceInfos);

  computeDocMeta(toolInfos, metaMap, docSet);

  return generateDocMeta(namespaceInfos, metaMap);
}

function getEntryContent(exportFromSet?: Set<string>) {
  const exportLines = Array.from(exportFromSet || [])
    .sort()
    .map((item) => `export * from '${item}';`);

  return exportLines.length > 0 ? `${exportLines.join('\n')}\n` : 'export {};\n';
}

async function snapshotEntryFiles(namespace: string[], ctx: Context) {
  const entrySnapshots = new Map<string, string | null>();

  for (let i = 0, ns = namespace[i]; i < namespace.length; ns = namespace[++i]) {
    const entryPath = path.resolve(ctx.root, 'src', ns, 'index.ts');
    entrySnapshots.set(entryPath, fs.existsSync(entryPath) ? await fsp.readFile(entryPath, 'utf-8') : null);
  }

  return entrySnapshots;
}

async function rollbackEntries(entryPath: string, entrySnapshots: Map<string, string | null>) {
  try {
    const snapshot = entrySnapshots.get(entryPath);

    if (snapshot === null || snapshot === undefined) {
      await fsp.rm(entryPath, { force: true });
      return false;
    }

    await fsp.writeFile(entryPath, snapshot, 'utf-8');
    return false;
  } catch {
    return true;
  }
}

async function generateEntries(namespaceExports: Record<string, Set<string>>, ctx: Context) {
  const namespace = Reflect.ownKeys(namespaceExports) as string[];
  const entrySnapshots = await snapshotEntryFiles(namespace, ctx);
  let currentEntryPath: string | undefined;

  try {
    for (let i = 0, ns = namespace[i]; i < namespace.length; ns = namespace[++i]) {
      currentEntryPath = path.resolve(ctx.root, 'src', ns, 'index.ts');
      const entryContent = getEntryContent(namespaceExports[ns]);

      await fsp.writeFile(currentEntryPath, entryContent, 'utf-8');
      currentEntryPath = undefined;
    }
  } catch (error) {
    const rollbackFailed = currentEntryPath ? await rollbackEntries(currentEntryPath, entrySnapshots) : false;

    if (rollbackFailed) {
      console.error('[auto-patch-file] entry rollback failed, workspace may be inconsistent');
      console.error(currentEntryPath);
    }

    throw error;
  }
}

async function patchNamespaceEntryExports(namespaceInfos: NamespaceInfo[], toolInfos: ToolInfo[], ctx: Context) {
  const namespaceExports: Record<string, Set<string>> = {};

  for (let i = 0, namespaceInfo = namespaceInfos[i]; i < namespaceInfos.length; namespaceInfo = namespaceInfos[++i]) {
    namespaceExports[namespaceInfo.namespace] = new Set();
  }

  for (let i = 0, toolInfo = toolInfos[i]; i < toolInfos.length; toolInfo = toolInfos[++i]) {
    const { namespace, filePath } = toolInfo;
    const exportPath = `./${path.basename(path.dirname(filePath))}`;
    namespaceExports[namespace] ||= new Set();
    namespaceExports[namespace].add(exportPath);
  }
  return generateEntries(namespaceExports, ctx);
}

async function processHandler(ctx: Context) {
  const meta = await parseMetaFile(ctx.metaFile);
  const namespaces = (Reflect.ownKeys(meta) as string[]).filter((key) => key !== '$schema');
  const namespaceInfos = await initializeNamespaces(namespaces, ctx);
  await packageJsonPatch(namespaces, ctx);
  const toolInfos = (
    await Promise.all(
      namespaceInfos.map(async (namespaceInfo) => {
        const { namespace, namespacePath } = namespaceInfo;
        return initializeTools(namespace, namespacePath, meta[namespace], ctx);
      }),
    )
  ).flat(1);
  return Promise.all([
    generateRspressDocMetas(namespaceInfos, toolInfos, ctx),
    generateShadcnExports(toolInfos, ctx),
    patchNamespaceEntryExports(namespaceInfos, toolInfos, ctx),
  ]);
}

export function pluginAutoPatchFile(options: PluginAutoPatchFileOptions) {
  if (env.gen_file_disabled === 'true') {
    return { name: '@cmtlyt/lingshu-toolkit:auto-patch-file' } satisfies Plugin;
  }

  const ctx = createContext(options);
  const { scriptMode = false, debounceMs = 100 } = options;

  let running = false;
  let dirty = false;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  const clearDebounceTimer = () => {
    if (!debounceTimer) {
      return;
    }

    clearTimeout(debounceTimer);
    debounceTimer = undefined;
  };

  /**
   * 刷新处理队列。
   *
   * 当存在待处理变更时串行执行 processHandler, 并在处理期间持续吸收新的触发请求,
   * 直到 dirty 被消费完成为止。
   */
  const flushProcessQueue = async () => {
    if (running) {
      return;
    }

    running = true;

    try {
      while (dirty) {
        dirty = false;

        try {
          await processHandler(ctx);
        } catch (error) {
          console.error('[auto-patch-file] process failed');
          console.error(error);
        }
      }
    } finally {
      running = false;
    }
  };

  const requestProcess = () => {
    dirty = true;
    void flushProcessQueue();
  };

  /**
   * 立即触发处理逻辑, 并清除当前已存在的防抖定时器。
   */
  const triggerProcessImmediately = () => {
    clearDebounceTimer();
    requestProcess();
  };

  /**
   * 根据运行模式调度处理逻辑:
   * - scriptMode 下立即执行
   * - watch 模式下通过防抖合并短时间内的重复触发
   */
  const scheduleProcess = () => {
    if (scriptMode) {
      triggerProcessImmediately();
      return;
    }

    clearDebounceTimer();

    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      requestProcess();
    }, debounceMs);
  };

  triggerProcessImmediately();

  return {
    name: '@cmtlyt/lingshu-toolkit:auto-patch-file',
    apply: 'serve',
    async watchChange(id) {
      if (id === ctx.metaFile) {
        scheduleProcess();
      }
    },
  } satisfies Plugin;
}
