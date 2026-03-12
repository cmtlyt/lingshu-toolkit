# Node.js Version Check and Management

This reference provides complete instructions for checking and managing Node.js versions in the lingshu-toolkit project.

## Required Version

The project requires **Node.js >= 22**.

## Check Current Version

```bash
node --version
```

## Version Manager Priority

Try version managers in this order:

1. **nvm**: `nvm use 22`
2. **fnm**: `fnm use 22`
3. **volta**: `volta pin node@22`
4. **n**: `n 22`

## If Version Switch Fails

If no version manager is available or switching fails:

### For macOS/Linux

1. **Install a version manager** (recommended):
   - nvm: https://github.com/nvm-sh/nvm
   - fnm: https://github.com/Schniz/fnm (cross-platform)
   - volta: https://volta.sh (cross-platform)
   - n: https://github.com/tj/n

2. **Set default version** (if version manager already installed):
   - nvm: `nvm alias default 22`
   - fnm: `fnm default 22`
   - volta: `volta pin node@22` (in project root)

3. **Manual switch** (temporary):
   - nvm: `nvm use 22`
   - fnm: `fnm use 22`
   - volta: `volta pin node@22`
   - n: `n 22`

### For Windows

1. **Install a version manager** (recommended):
   - nvm-windows: https://github.com/coreybutler/nvm-windows
   - fnm: https://github.com/Schniz/fnm (cross-platform, supports Windows)
   - volta: https://volta.sh (cross-platform, supports Windows)

2. **Set default version** (if version manager already installed):
   - nvm-windows: `nvm use 22` (in new terminal)
   - fnm: `fnm default 22`
   - volta: `volta pin node@22` (in project root)

3. **Manual switch** (temporary):
   - nvm-windows: `nvm use 22` (in new terminal)
   - fnm: `fnm use 22`
   - volta: `volta pin node@22`

### Alternative: Direct Installation

If you prefer not to use a version manager, download and install Node.js 22 directly:
- Download: https://nodejs.org/en/download
- Choose the installer for your operating system
- After installation, open a new terminal and verify: `node --version`

## Error Message Template

When version check fails, use this message:

```
⚠️ **{TESTING|BUILDING} SKIPPED:** Cannot run {tests|build commands} due to Node.js version mismatch.

Current Node.js version: {version}
Required Node.js version: >= 22

**Solutions:**

[Insert the appropriate section from above based on user's OS]
```

## After Fixing Version

Run the intended command manually:
```bash
# For testing
pnpm run test:ci

# For building
pnpm run check
pnpm run test:ci
pnpm run build
```
