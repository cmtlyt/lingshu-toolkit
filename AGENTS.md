# AGENTS.md

You are an expert in JavaScript, Rspack, Rsbuild, Rslib, and library development. You write maintainable, performant, and accessible code.

## Commands

- `pnpm run build` - Build the library for production
- `pnpm run dev` - Turn on watch mode, watch for changes and rebuild the library

## Docs

- Rslib: https://rslib.rs/llms.txt
- Rsbuild: https://rsbuild.rs/llms.txt
- Rspack: https://rspack.rs/llms.txt
- Rspress: https://rspress.rs/llms.txt

## Tools

### Vitest

- Run `pnpm run test:ci` to test your code

### Biome

- Run `pnpm run check` to lint your code
- Run `pnpm run format` to format your code

## 代码规范

- 报错始终应该使用 `shared/throw-error` 模块导出的函数, 而不是直接 `throw new Error`

## Agent 运行环境

非交互式 shell（Agent 默认执行环境）通常**不会自动加载** `~/.zshrc` / `~/.zprofile`，导致 `pnpm` / `node` / `nvm` 等命令报 `command not found`。

### 解决方法：在每条命令前 `source` 加载 nvm

本仓库使用 `nvm` 管理 node 版本（`~/.nvm/nvm.sh` 已存在），需要在每条 shell 命令前手动加载：

```bash
# 单条命令
source ~/.nvm/nvm.sh && nvm use && pnpm --version

# 多条命令链（推荐：先加载环境再切换项目目录）
source ~/.nvm/nvm.sh && cd /path/to/repo && nvm use && pnpm run test:ci

# 跑单个测试文件（直接给 test:ci 传 filepath，无需手写 vitest 参数）
source ~/.nvm/nvm.sh && cd /path/to/repo && nvm use && pnpm run test:ci src/shared/lock-data/__test__/authority/extract.node.test.ts
```

### 注意事项

- **`.nvmrc` 自动适配**：项目根目录有 `.nvmrc`（当前指定 node 24），`nvm use`（不带参数）会自动读取并切换到对应版本
- **PATH 哈希缓存**：`nvm use` 后 `which node` 可能仍指向旧版本（zsh 哈希缓存），但**实际执行 `node` / `pnpm` 命令使用的是切换后的版本**，可忽略 `which` 输出
- **避免重新启动 shell**：Agent 每条命令都是独立的子 shell，PATH 修改不持久；每次都需要重新 `source`

### 备选方案

如果 nvm 加载失败，可降级到直接路径调用：

```bash
# 直接用绝对路径（适用于已知 node 版本时）
~/.nvm/versions/node/v24.14.1/bin/pnpm --version
```

<!-- CODEGRAPH_START -->
## CodeGraph

This project has a CodeGraph MCP server (`codegraph_*` tools) configured. CodeGraph is a tree-sitter-parsed knowledge graph of every symbol, edge, and file. Reads are sub-millisecond and return structural information grep cannot.

### When to prefer codegraph over native search

Use codegraph for **structural** questions — what calls what, what would break, where is X defined, what is X's signature. Use native grep/read only for **literal text** queries (string contents, comments, log messages) or after you already have a specific file open.

| Question | Tool |
|---|---|
| "Where is X defined?" / "Find symbol named X" | `codegraph_search` |
| "What calls function Y?" | `codegraph_callers` |
| "What does Y call?" | `codegraph_callees` |
| "How does X reach/become Y? / trace the flow from X to Y" | `codegraph_trace` (one call = the whole path, incl. callback/React/JSX dynamic hops) |
| "What would break if I changed Z?" | `codegraph_impact` |
| "Show me Y's signature / source / docstring" | `codegraph_node` |
| "Give me focused context for a task/area" | `codegraph_context` |
| "See several related symbols' source at once" | `codegraph_explore` |
| "What files exist under path/" | `codegraph_files` |
| "Is the index healthy?" | `codegraph_status` |

### Rules of thumb

- **Answer directly — don't delegate exploration.** For "how does X work" / architecture questions, answer with 2-3 codegraph calls: `codegraph_context` first, then ONE `codegraph_explore` for the source of the symbols it surfaces. For a specific **flow** ("how does X reach Y") start with `codegraph_trace` from→to — one call returns the whole path with dynamic hops bridged — then ONE `codegraph_explore` for the bodies; don't rebuild the path with `codegraph_search` + `codegraph_callers`. Codegraph IS the pre-built index, so spawning a separate file-reading sub-task/agent — or running a grep + read loop — repeats work codegraph already did and costs more for the same answer.
- **Trust codegraph results.** They come from a full AST parse. Do NOT re-verify them with grep — that's slower, less accurate, and wastes context.
- **Don't grep first** when looking up a symbol by name. `codegraph_search` is faster and returns kind + location + signature in one call.
- **Don't chain `codegraph_search` + `codegraph_node`** when you just want context — `codegraph_context` is one call.
- **Don't loop `codegraph_node` over many symbols** — one `codegraph_explore` call returns several symbols' source grouped in a single capped call, while each separate node/Read call re-reads the whole context and costs far more.
- **Index lag**: the file watcher debounces ~500ms behind writes; don't re-query immediately after editing a file in the same turn.

### If `.codegraph/` doesn't exist

The MCP server returns "not initialized." Ask the user: *"I notice this project doesn't have CodeGraph initialized. Want me to run `codegraph init -i` to build the index?"*
<!-- CODEGRAPH_END -->
