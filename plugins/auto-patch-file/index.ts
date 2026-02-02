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

async function generateRspressDocMetas(namespaceInfos: NamespaceInfo[], toolInfos: ToolInfo[], _ctx: Context) {
  const { metaMap, docSet } = await initMetaMap(namespaceInfos);

  computeDocMeta(toolInfos, metaMap, docSet);

  return generateDocMeta(namespaceInfos, metaMap);
}

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
