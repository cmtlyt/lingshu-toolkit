### code review fix

**模板:**

```text
<file path>

<description>

先给我一个修复方案, 方案放到工具目录的 fixed 文件夹中, 等待我明确实施再按照方案改动逻辑, 如果需要我选择方案的话先将方案落盘再询问, 实施结束之后给我 commit message
```

**示例:**

```text
src/shared/lock-data/core/actions.ts

dispose() 与 in-flight acquire() 竞争时，不要把终态再回退成 idle。

如果 dispose() 在 driver.acquire() 等待期间触发，而驱动会按 signal 立即 reject，这个分支仍会执行 transitionTo(..., 'idle', token)。结果会出现已经 disposed 的实例又发出一次 idle 状态变更，而且 getLock()/update() 拿到的是 abort/timeout 类错误，而不是 LockDisposedError。这里需要在 state.disposed（或当前 phase 已是 disposed）时保留终态并直接走 throwDisposed(...)。

先给我一个修复方案, 方案放到工具目录的 fixed 文件夹中, 等待我明确实施再按照方案改动逻辑, 如果需要我选择方案的话先将方案落盘再询问, 实施结束之后给我 commit message
```
