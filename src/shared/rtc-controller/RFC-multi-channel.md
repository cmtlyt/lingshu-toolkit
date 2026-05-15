# RFC: rtc-controller 多 DataChannel 支持

## 背景

当前 rtc-controller 仅维护一个 `defaultChannel`，`emit()` / `send()` 都硬编码走这条通道。虽然已有 `createDataChannel()` API 可创建额外通道，但：

1. 创建后无内部注册，控制器不感知其存在
2. `emit()` / `send()` 无法指定目标通道
3. 用户必须自行管理通道引用和收发，失去了控制器封装的价值

## 目标

让 rtc-controller **原生管理多条 DataChannel**，并支持通过 `label` 选择目标通道进行数据发送。

## 设计原则

1. **向后兼容** — 不传 label 时行为与当前完全一致（走默认通道）
2. **最小 API 变更** — 复用现有 `createDataChannel`，仅扩展 `emit` / `send` 的签名
3. **自动注册** — `createDataChannel` 创建的通道自动纳入管理
4. **远端通道也纳管** — `ondatachannel` 收到的远端创建通道同样注册

## API 变更

### 1. `send()` 增加可选 `label` 参数

```typescript
// 现有（保持不变）
send(data: string | ArrayBuffer | Blob | ArrayBufferView): void;

// 新增重载
send(label: string, data: string | ArrayBuffer | Blob | ArrayBufferView): void;
```

运行时区分：第一个参数为 string 且第二个参数存在时走 label 模式，否则走默认通道。

### 2. `emit()` 增加可选 `options`

```typescript
// 现有（保持不变）
emit<K extends keyof UserEvents>(
  event: K,
  ...args: UserEvents[K] extends void ? [] : [payload: UserEvents[K]]
): void;

// 新增：通过 options 指定通道
emitTo<K extends keyof UserEvents>(
  label: string,
  event: K,
  ...args: UserEvents[K] extends void ? [] : [payload: UserEvents[K]]
): void;
```

> 用独立方法 `emitTo` 而非修改 `emit` 签名，避免类型推断复杂化。

### 3. `createDataChannel()` 行为增强

现有 API 签名不变，但行为增强：创建的通道**自动注册到内部 `channels` 注册表**，后续可通过 label 路由。

```typescript
// 签名不变
createDataChannel(label: string, options?: RTCDataChannelInit): RTCDataChannel;
```

**使用示例：**

```typescript
const controller = createRtcController({ signaling, autoCreateDataChannel: true });
await controller.connect();

// 默认通道已就绪（label = '__default__'），可直接 send/emit
controller.send('hello');
controller.emit('chat', { text: 'hi' });

// 创建额外通道 — 自动注册，就绪后可通过 label 路由
const fileChannel = controller.createDataChannel('file-transfer', { ordered: true });

// 等待新通道就绪
controller.on('data-channel-ready', ({ label }) => {
  if (label === 'file-transfer') {
    // 通过 label 定向发送
    controller.send('file-transfer', fileBlob);
    controller.emitTo('file-transfer', 'file-meta', { name: 'a.png', size: 1024 });
  }
});

// 查询通道
controller.getChannel();                  // → 默认通道（RTCDataChannel）
controller.getChannel('file-transfer');   // → 文件通道（RTCDataChannel）
controller.getChannelLabels();            // → ['__default__', 'file-transfer']
```

### 4. `getChannel()` 查询 API

```typescript
/** 不传 label 时返回默认通道，传 label 时按名称查找，不存在返回 undefined */
getChannel(label?: string): RTCDataChannel | undefined;

/** 获取所有已注册通道的 label 列表 */
getChannelLabels(): string[];
```

### 4. 事件增强

`raw-message` 事件 payload 已包含 `channel: RTCDataChannel`，无需改动。

`data-channel-ready` / `data-channel-closed` 已包含 `label`，无需改动。

## 内部实现

### ControllerContext 变更

```typescript
interface ControllerContext<UserEvents extends EventMap = EventMap> {
  // ... 现有字段 ...

  /** 默认数据通道（保留，向后兼容） */
  defaultChannel: RTCDataChannel | null;

  /** 多通道注册表：label → RTCDataChannel */
  channels: Map<string, RTCDataChannel>;
}
```

### 通道注册流程

1. **`createDataChannel(label, options)`**：创建后自动 `channels.set(label, channel)`
2. **`ondatachannel` 回调**：远端创建的通道也 `channels.set(channel.label, channel)`
3. **`wireDataChannelEvents` 中 `onclose`**：关闭时自动 `channels.delete(label)`
4. **`dispose()`**：遍历 `channels` 关闭所有通道并清空

### send / emitTo 路由

```
resolveChannel(label?: string) → RTCDataChannel:
  if label 未提供 → return defaultChannel （现有行为）
  if channels.has(label) → return channels.get(label)
  else → throw RtcChannelNotReadyError
```

### 默认通道与注册表的关系

- `defaultChannel` 也会被注册到 `channels` 中（key = 其 label）
- `defaultChannel` 仍作为快捷引用保留，确保 `send(data)` 零开销

## RtcController 接口变更汇总

```typescript
interface RtcController<UserEvents extends EventMap = BuiltinEvents> {
  // ... 现有 ...

  // 数据通道 — 修改
  send(data: string | ArrayBuffer | Blob | ArrayBufferView): void;           // 不变
  send(label: string, data: string | ArrayBuffer | Blob | ArrayBufferView): void; // 新增

  // 数据通道 — 新增
  emitTo<K extends keyof UserEvents>(
    label: string,
    event: K,
    ...args: UserEvents[K] extends void ? [] : [payload: UserEvents[K]]
  ): void;
  getChannel(label: string): RTCDataChannel | undefined;
  getChannelLabels(): string[];
}
```

## rtc-room 联动

rtc-room 的 `broadcast` / `send` / `broadcastRaw` / `sendRaw` 暂不改动。后续可在 room 层增加 `channel` 参数透传到 controller。

## 文件改动清单

| 文件 | 变更 |
|------|------|
| `types.ts` | `RtcController` 接口增加 `send` 重载、`emitTo`、`getChannel`、`getChannelLabels` |
| `core/controller-context.ts` | 增加 `channels: Map<string, RTCDataChannel>` |
| `core/controller.ts` | 初始化 `channels`；修改 `send` 路由；新增 `emitTo` / `getChannel` / `getChannelLabels`；`dispose` 清理 |
| `core/data-channel.ts` | `wireDataChannelEvents` 中 `onopen` 注册到 `channels`，`onclose` 从 `channels` 删除 |
| 测试文件 | 补充多通道场景测试 |

## 不做什么

- **不改 `emit()` 签名** — 保持简洁，定向发送用 `emitTo`
- **不做通道优先级/负载均衡** — 超出当前需求范围
- **不改 rtc-room** — 本 RFC 仅涉及 controller 层
