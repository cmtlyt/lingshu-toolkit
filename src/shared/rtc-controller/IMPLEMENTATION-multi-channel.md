# 实施清单：rtc-controller 多 DataChannel 支持

> 对应 RFC：`RFC-multi-channel.md`

## Step 1: `core/controller-context.ts` — 增加 channels 注册表

- [ ] `ControllerContext` 接口增加 `channels: Map<string, RTCDataChannel>` 字段

**改动量**：1 行

---

## Step 2: `core/data-channel.ts` — 通道生命周期自动注册

- [ ] `wireDataChannelEvents` 中 `onopen` 回调：`ctx.channels.set(channel.label, channel)`
- [ ] `wireDataChannelEvents` 中 `onclose` 回调：`ctx.channels.delete(channel.label)`

**改动量**：2 行

---

## Step 3: `types.ts` — 扩展 RtcController 接口

- [ ] `send` 增加第二个重载签名：`send(label: string, data: ...): void`
- [ ] 新增 `emitTo` 方法签名
- [ ] 新增 `getChannel(label?: string): RTCDataChannel | undefined`
- [ ] 新增 `getChannelLabels(): string[]`

**改动量**：~12 行

---

## Step 4: `core/controller.ts` — 核心实现

- [ ] ctx 初始化：增加 `channels: new Map()`
- [ ] 新增 `resolveChannel(ctx, label, caller)` 辅助函数：按 label 查找通道，不存在则 throwError
- [ ] 修改 `send` 函数：第一个参数为 string 且第二个参数存在时走 label 路由，否则走默认通道
- [ ] 新增 `emitTo` 函数：通过 resolveChannel 获取目标通道，编码事件消息后发送
- [ ] 新增 `getChannel` 函数：不传 label 返回 `defaultChannel`，传 label 从 `channels` 查找
- [ ] 新增 `getChannelLabels` 函数：返回 `[...ctx.channels.keys()]`
- [ ] `performDispose` 中：遍历 `ctx.channels` 关闭所有通道，然后 `ctx.channels.clear()`
- [ ] `reconnect` 中：清理 `ctx.channels`
- [ ] return 对象：挂载 `emitTo`、`getChannel`、`getChannelLabels`

**改动量**：~40 行

---

## Step 5: 补充测试

- [ ] 新建 `__test__/multi-channel.browser.test.ts`（需要 RTCDataChannel，走浏览器环境）
- [ ] 测试用例：
  - `createDataChannel` 创建的通道自动注册到 channels
  - `getChannel()` 无参返回默认通道
  - `getChannel(label)` 返回指定通道
  - `getChannelLabels()` 返回所有已注册 label
  - `send(label, data)` 通过指定通道发送
  - `emitTo(label, event, payload)` 通过指定通道发送事件
  - `send(label, data)` label 不存在时抛错
  - 通道关闭后自动从 channels 移除
  - dispose 后 channels 清空

---

## Step 6: 全量验证

- [ ] `pnpm run check`
- [ ] `pnpm run test:ci src/shared/rtc-controller`
- [ ] `pnpm run build`
