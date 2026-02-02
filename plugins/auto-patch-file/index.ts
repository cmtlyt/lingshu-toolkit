import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vitest/config';

const fsp = fs.promises;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface PluginAutoPatchFileOptions {
  root?: string;
  mateFile: string;
  registryUrl?: string;
  docGenIgnoreEntryCheck?: boolean;
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

interface ToolMate {
  name: string;
}

function formatDirname(name: string) {
  return name.replace(/\B[A-Z]/g, (match) => `-${match.toLowerCase()}`).toLowerCase();
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
  template = template.replace(/\$\$(.*?)\$\$/g, (_, key) => data[key]);
  return template;
}

function parseInjectData(toolPath: string, namespace: string, tool: ToolMate, ctx: Context) {
  return {
    namespace,
    name: tool.name,
    shadcnPath: `${ctx.registryUrl}/${formatNameFromTool({ meta: tool, namespace })}`,
    npmVersion: ctx.packageJson.version,
    fileName: path.basename(toolPath),
  };
}

const toolFiles = fs.readdirSync(path.resolve(__dirname, 'template'));

async function createToolFiles(toolPath: string, namespace: string, tool: ToolMate, ctx: Context) {
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

async function initializeTools(namespace: string, namespacePath: string, toolMetas: ToolMate[], ctx: Context) {
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

async function packageJsonPatch(namesapces: string[], ctx: Context) {
  const packageJsonPath = path.resolve(ctx.root, 'package.json');
  const packageJson = JSON.parse(await fsp.readFile(packageJsonPath, 'utf-8'));
  ctx.packageJson = packageJson;

  const exports: Record<string, any> = packageJson.exports || {};

  namesapces.forEach((ns) => {
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
      path: path.relative(root, toolInfo.filePath),
    };
  });

  return writeJson(shadcnExportsFile, {
    // biome-ignore lint/style/useNamingConvention: ignore
    $schema: './node_modules/@cmtlyt/unplugin-shadcn-registry-generate/configuration-schema.json',
    exports,
  });
}

function createContext(options: PluginAutoPatchFileOptions) {
  const { root = process.cwd(), mateFile, registryUrl = './public/r' } = options;

  const realMetaFile = path.resolve(root, mateFile);
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
  type: 'file';
  name: string;
  label?: string;
  tag?: string;
  overviewHeaders?: number[];
  context?: string;
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
      metaMap[namespace] = JSON.parse(await fsp.readFile(metaPath, 'utf-8'));
      metaMap[namespace].forEach((item) => {
        docSet.add(item.name);
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
    const { meta, namespace, filePath, namespacePath } = toolInfo;
    const docName = path.resolve(path.dirname(filePath), 'index.mdx').slice(namespacePath.length + 1);
    if (docSet.has(docName)) {
      continue;
    }
    metaMap[namespace].push({
      type: 'file',
      label: meta.name,
      name: docName,
    });
  }
}

/**
 * 为各命名空间生成或更新 rspress 所需的文档元数据文件（_meta.json）。
 *
 * 该函数会在已有命名空间元数据的基础上，基于工具列表补充缺失的文档条目并将更新写回到各命名空间的 _meta.json 中。
 *
 * @param namespaceInfos - 已初始化的命名空间信息数组（包含命名空间路径等）。
 * @param toolInfos - 项目中所有工具的元数据列表，用于计算需要的文档条目。
 * @param _ctx - 运行时上下文（当前未被此函数使用，可传入以便未来扩展）。
 * @returns 写入并更新各命名空间 `_meta.json` 的写入结果。
 */
async function generateRspressDocMetas(namespaceInfos: NamespaceInfo[], toolInfos: ToolInfo[], _ctx: Context) {
  const { metaMap, docSet } = await initMetaMap(namespaceInfos);

  computeDocMeta(toolInfos, metaMap, docSet);

  return generateDocMeta(namespaceInfos, metaMap);
}

/**
 * 收集每个命名空间的 entry 文件（index.ts）中通过 `export ... from '...'` 声明引用的模块路径，并按命名空间分组返回。
 *
 * 该函数会读取传入的每个 NamespaceInfo 的 namespacePath 下的 index.ts，提取所有 `from '...'` 或 `from "..."` 中的路径并加入对应命名空间的集合。
 *
 * @param namespaceInfos - 包含 namespace 和 namespacePath 的命名空间信息数组
 * @returns 一个映射对象，键为命名空间名称，值为该命名空间 index.ts 中被 `export ... from` 引用的模块路径集合（Set<string>）
 */
async function parseNamespaceExports(namespaceInfos: NamespaceInfo[]) {
  const namespaceExports: Record<string, Set<string>> = {};
  const exportReg = /export.*?from\s+(['"])(.*?)\1/s;

  for (let i = 0, namespaceInfo = namespaceInfos[i]; i < namespaceInfos.length; namespaceInfo = namespaceInfos[++i]) {
    const { namespace, namespacePath } = namespaceInfo;
    const exportFromSet = namespaceExports[namespace] || new Set();
    namespaceExports[namespace] = exportFromSet;
    const entryContent = await fsp.readFile(path.resolve(namespacePath, 'index.ts'), 'utf-8');
    const entrys = entryContent.split(';\n');

    for (let j = 0, line = entrys[j]; j < entrys.length; line = entrys[++j]) {
      const [, , from] = line.match(exportReg) || [];
      if (!from) {
        continue;
      }
      exportFromSet.add(from);
    }
  }

  return namespaceExports;
}

/**
 * 将每个命名空间的导出路径以导出语句追加到对应的 src/<namespace>/index.ts 文件中。
 *
 * 遍历 namespaceExports 中的每个命名空间，将 Set 中的模块路径转换为 `export * from '...';` 语句并追加到该命名空间的 index.ts。
 *
 * @param namespaceExports - 键为命名空间名，值为该命名空间应导出的模块路径集合
 * @param ctx - 运行时上下文，至少需要包含项目根路径用于解析 index.ts 的目标位置
 * @returns 每个文件追加操作的结果数组，数组项对应一次 appendFile 调用的完成结果
 */
async function generateEntrys(namespaceExports: Record<string, Set<string>>, ctx: Context) {
  const namespace = Reflect.ownKeys(namespaceExports) as string[];

  return Promise.all(
    namespace.map(async (ns) => {
      const exportFromSet = namespaceExports[ns];
      const entryPath = path.resolve(ctx.root, 'src', ns, 'index.ts');
      const entryContent = `${Array.from(exportFromSet)
        .map((item) => `export * from '${item}';`)
        .join('\n')}\n`;
      return fsp.appendFile(entryPath, entryContent, 'utf-8');
    }),
  );
}

/**
 * 确保每个命名空间的入口索引包含对应工具的导出，并为缺失的导出生成索引条目。
 *
 * 遍历工具信息，比较已存在的命名空间导出列表，收集缺失的导出路径并将其写入或追加到各命名空间的 index.ts。
 *
 * @param namespaceInfos - 每个命名空间的元信息与路径集合，用于读取和比较现有导出
 * @param toolInfos - 待处理的工具信息列表，每项包含工具所在命名空间与文件路径
 * @param ctx - 运行时上下文，包含项目根路径和配置等必要信息
 * @returns 写入或追加命名空间索引文件的操作集合（每项对应一次文件写入或追加操作）
 */
async function patchNamespaceEntryExports(namespaceInfos: NamespaceInfo[], toolInfos: ToolInfo[], ctx: Context) {
  const namespaceExports: Record<string, Set<string>> = await parseNamespaceExports(namespaceInfos);
  const patchNamespaceExports: Record<string, Set<string>> = {};

  for (let i = 0, toolInfo = toolInfos[i]; i < toolInfos.length; toolInfo = toolInfos[++i]) {
    const { namespace, filePath } = toolInfo;
    const exportPath = `./${path.basename(path.dirname(filePath))}`;
    if (namespaceExports[namespace]?.has(exportPath)) {
      continue;
    }
    patchNamespaceExports[namespace] ||= new Set();
    patchNamespaceExports[namespace].add(exportPath);
  }

  return generateEntrys(patchNamespaceExports, ctx);
}

/**
 * 基于元数据文件初始化命名空间与工具，并触发文档元数据、shadcn 导出与命名空间入口导出补丁的生成任务。
 *
 * 读取并解析 ctx 指定的元数据文件，确保每个命名空间已初始化，更新 package.json 的 exports，初始化各工具文件，
 * 然后并行执行：生成 rspress 文档元数据、生成 shadcn-exports.json、以及修补命名空间的入口导出。
 *
 * @param ctx - 运行时上下文，包含根路径、元数据文件路径、注册表 URL、以及其他生成/写入所需配置
 * @returns 一个数组，按顺序包含三个任务的返回结果：generateRspressDocMetas、generateShadcnExports、patchNamespaceEntryExports 的返回值
 */
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

/**
 * 创建并返回一个用于根据元数据文件自动生成与修补项目文件的 Vitest 插件。
 *
 * @param options - 插件配置项，用于构建运行时上下文（例如项目根目录、元数据文件路径、注册表 URL、以及文档/条目检查相关选项）
 * @returns 一个符合 Vitest Plugin 接口的插件对象，会在 serve 模式下运行并在检测到元数据文件变更时触发处理流程以更新代码与元数据产物
 */
export function pluginAutoPatchFile(options: PluginAutoPatchFileOptions) {
  const ctx = createContext(options);

  void processHandler(ctx);

  return {
    name: '@cmtlyt/lingshu-toolkit:auto-patch-file',
    apply: 'serve',
    async watchChange(id) {
      if (id === ctx.metaFile) {
        void processHandler(ctx);
      }
    },
  } satisfies Plugin;
}