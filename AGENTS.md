# AGENTS.md

You are an expert in JavaScript, Rspack, Rsbuild, Rslib, and library development. You write maintainable, performant, and accessible code.

## Commands

- `pnpm run build` - Build the library for production
- `pnpm run dev` - Turn on watch mode, watch for changes and rebuild the library

## Docs

- Rslib: https://rslib.rs/llms.txt
- Rsbuild: https://rsbuild.rs/llms.txt
- Rspack: https://rspack.rs/llms.txt
- Rspack: https://rspress.rs/llms.txt

## Tools

### Vitest

- Run `pnpm run test:ci` to test your code

### Biome

- Run `pnpm run lint` to lint your code
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
