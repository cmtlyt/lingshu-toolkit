# Node.js Version Check

## Required Version

**Node.js >= 22**（项目 `.nvmrc` 指定具体版本，`nvm use` 自动切换）。

## Check

```bash
node --version
```

## Error Message Template

版本检查失败时，向用户展示此消息：

```text
⚠️ **{TESTING|BUILDING} SKIPPED:** Cannot run {tests|build commands} due to Node.js version mismatch.

Current Node.js version: {version}
Required Node.js version: >= 22

**Solutions:**
- nvm: `nvm use 22`（推荐，项目已有 .nvmrc）
- fnm: `fnm use 22`
- volta: `volta pin node@22`
- 直接安装: https://nodejs.org/en/download
```

## After Fixing

```bash
pnpm run check
pnpm run test:ci
pnpm run build
```

> **Note:** Agent 运行环境的 nvm 加载方式见 `AGENTS.md`「Agent 运行环境」章节。
