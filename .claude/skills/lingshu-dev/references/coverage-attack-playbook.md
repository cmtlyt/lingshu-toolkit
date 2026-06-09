# Coverage Attack Playbook — 模块覆盖率清零方法论

铁律：**通过真实测试命中代码，绝不修改源码 / 加 v8 ignore / 篡改统计脚本**。

本文档沉淀「将一个完整模块的 statements / branches / functions 全部推到 100%」的可复用方法论。当用户提出「补全 X 模块的测试覆盖率」「这个分支命中不了」时使用。

> **三条不可动摇的硬约束**：见 `SKILL.md` 顶部「Coverage Attack 三条不可动摇硬约束」一节，本文档不再重复。下文所有打法均基于该硬约束展开。

## 阅读路径（如何按本文档实战攻坚）

1. **先读 §1 Tier 分级**：判断目标模块整体复杂度，决定先攻哪批文件
2. **按 §2 标准工作流逐步执行**：Step A（跑 coverage）→ Step B（把每条未覆盖项映射到命中模式）→ Step C（导出内部函数）→ Step D（写测试）→ Step E（增量验证）→ Step F（终验）
3. **Step B 中识别出"防御分支"时**，跳到 §3 对应小节查具体打法（§3.1~§3.6 共 6 种模式）
4. **遇到定时器相关分支**，必须先读 §4 决定 fake timers 模式（默认 vs 精细化拦截 / 同步推进 vs 异步推进）
5. **写完每批测试前对照 §5 反模式自检**，避免踩坑

---

## 1. Tier 分级策略：从易到难

不要一上来就啃最复杂的状态机文件。按文件复杂度从低到高分层补测，先用简单文件建立测试基础设施，再迁移到硬骨头：

- **Tier 1（易）**：纯函数 / 工具模块 / 协议守卫 — 主路径调用即可命中，建立基础设施工厂（logger 工厂、外部依赖适配器工厂、state 工厂、辅助数据工厂）
- **Tier 2（中）**：基础 driver / 适配层 / 入口聚合层 — 复用 Tier 1 基础设施 + 用 stubGlobal 模拟环境能力探测分支
- **Tier 3（难）**：状态机层 / 多消息分发层 — 需导出更多内部函数 + spy 模块导出 + fake timers 推进定时器回调

## 2. 标准工作流

### Step A：跑覆盖率 + 扫描未覆盖项

先跑「目标模块带 coverage 的测试」生成 `coverage/coverage-final.json`，再用 `pnpm test:analyze` 扫出每条未覆盖项的「文件 / 行号 / 分支 idx」清单：

```bash
# 1. 跑带 coverage 的测试（生成 coverage/coverage-final.json）
#    纯 node 测试（*.node.test.ts）→ 用 test:lib:ci，更快且不启动浏览器
pnpm test:lib:ci src/shared/<module-name> --coverage.enabled
#    含浏览器测试 → 用 test:ci
pnpm test:ci src/shared/<module-name> --coverage.enabled

# 2. 分析未覆盖项
pnpm test:analyze src/shared/<module-name>

# 3. 聚焦单文件时叠加 --with-source，打印上下文
pnpm test:analyze src/shared/<module-name> --with-source --file=<path-fragment>
```

关键判定：分析脚本输出 `Files dirty: 0` 表示模块已清零；只要 `dirty > 0` 就继续 Step B。

### Step B：把每条未覆盖项映射到命中模式

对每条未覆盖项，先看上下文判断属于以下哪种类型，再选第 3 节对应模式：

| 未覆盖项类型 | 表现 | 命中模式 |
|---|---|---|
| 主路径漏测 | 正常路径少一个 case | 直接补常规测试 |
| 防御性 catch / cleanup | try/catch 错误处理 / finally 清理 | §3.1 伪 state + §3.2 getter 抛错 |
| 守门后死代码 | switch default、前置 type guard 之后的 `if (!x) return` | §3.3 spy 守卫放行 / §3.4 运行时构造非法数据 |
| 环境能力探测 | `typeof globalApi === 'undefined'` / `!globalApi.subFeature` 类的环境分支 | §3.5 stubGlobal |
| 定时器回调（纯同步） | setInterval / setTimeout 内部纯同步逻辑 | §3.6 fake timers + `advanceTimersByTime` |
| 定时器回调（涉 Promise） | 回调内部链式 Promise / await | §3.6 fake timers + `advanceTimersByTimeAsync` |

### Step C：导出内部函数（关键操作）

如果目标分支只能通过函数内部 state 触发，把内部函数和私有 type 一起 export 出来供测试 import。三条**导出规范**（与文档顶部的"三条不可动摇硬约束"不同：那是禁令，这里是导出操作的具体边界）：

- ✅ 导出的**必须是已存在于源码中**的纯函数 / 类型；**禁止**新增 testing-only setter / 后门 API
- ✅ 仅供 `__test__/*` 内部 import，**严禁**在该模块的主入口（`index.ts` 等）re-export，避免对外 API 被污染
- ✅ 命名保持源码原本的语义；**禁止**为测试改名

实操建议：在被测源码文件**末尾**单独建一个 `export { ... }` 块集中收纳测试用导出，对每个 export 加注释说明"仅供测试 import"，方便后续审查。

### Step D：编写命中测试 —— 基础设施先行

每个 coverage 攻坚测试文件顶部先建立**基础设施工厂**，避免每个 case 重复造数据：

- **logger 工厂**：返回带 `info / warn / error` mock 函数的 logger，便于断言"特定错误日志被打印"证明分支被命中
- **外部依赖适配器工厂**：根据被测 driver 类型，造一个最小可工作的"伪适配器"（如内存版 storage、伪 channel），暴露关键操作的 spy / 历史数组
- **state 工厂**：按目标 driver 真实 interface **填齐所有必填字段**生成默认 state，再让单个 case override 局部字段进入目标分支
- **辅助数据工厂**：状态机里的核心数据结构（如 waiter / token / 消息）造一个最小合法版本工厂

**deps 简化的合法性原则**：测试中如果某些 deps 字段是可选且当前 driver 不消费，可以**只构造一个仅含必填字段的对象，再通过双重断言转成完整 deps 类型**，省去伪造可选字段；这是**事实上的最小可工作集**，不是猜测。判断标准是：先看源码里 deps 接口的必填 / 可选字段定义，再看被测 driver 是否真的访问可选字段，二者交集为空才允许这种简化。

### Step E：增量验证（写一批测一批）

每补完一批测试立即重跑覆盖率测试（纯 node 用 `pnpm test:lib:ci`，含浏览器用 `pnpm test:ci`，均需 `--coverage.enabled`）+ `pnpm test:analyze src/shared/<module-name>`，看 `Files dirty` 是否在减少。**禁止**一次性写大量 case 攒着跑 —— 因为一旦中间某个 case 的 mock 思路错了，会污染后续 case 的 mock 状态，整批失败时排查成本极高。

### Step F：模块清零后做全局回归（终验）

- [ ] lint：用项目配置的 lint / format 工具（如 biome / eslint / prettier）检查目标模块路径，0 errors / 0 warnings
- [ ] 全量测试：目标模块所有测试通过
- [ ] 分析脚本输出 `Files dirty: 0`
- [ ] 直接读 `coverage/coverage-final.json` 验证目标模块每个文件的 stmt / branch / fn 三项**各自都等于 100%**（不是三项平均也不是三项最小值；零分支文件按"分支总数为零时视为 100%"处理）
- [ ] 全文搜索确认 `/* v8 ignore */` 注释**数量不多于攻坚前**（理想终态是数量保持不变或减少；新增任何一条都视为违反硬约束）
- [ ] git diff 检查：覆盖率统计脚本（即承担"裁判"角色、用于判定是否清零的分析脚本）零修改；模块主入口未追加 Step C 那批测试用内部导出

## 3. 6 种防御分支命中模式

每种模式给出「适用场景 / 核心思路 / 关键陷阱」三段。**禁止**从本节复制伪代码，实战时优先参考仓库内已有的同类测试文件再举一反三。

### 3.1 构造伪 state + 调用内部函数

- **适用**：状态机分支只在特定 state 形态下走到（典型如某子状态下的回调抛错 catch、某种 status 才进入的清理路径）
- **思路**：用 state 工厂生成默认 state，再 override 关键字段（`status` / 子状态对象），让 state 处于目标分支的前置形态；然后调 Step C 导出的内部函数触发副作用进入目标分支
- **陷阱**：override 子状态对象时**必须填齐目标 interface 的所有必填字段**（包括看似不重要的 boolean / timer 句柄等）。正确做法是优先用真实合法的最小值填齐：布尔字段给 false、函数字段给 mock 空函数、timer 句柄字段给 null 或源码 type 允许的"未注册态"占位值（**不要**调真定时器 API 占位 —— fake timers 模式下会污染 timer 队列、afterEach 还要额外清理）、ID 字段给固定字符串。**不要**用双重断言强转省略字段 —— 一旦目标分支或其后续清理逻辑访问到被省略的字段，会抛 TypeError（访问 undefined 上的属性），让你绕回到非目标分支或测试整体崩溃

### 3.2 getter 抛错命中 catch 分支

- **适用**：函数对某字段的读取被 try/catch 包裹（典型形态是：try 块里对某个对象的字段做读取并配合一个集合 / 容器操作，catch 块里做错误日志或清理）
- **思路**：让目标对象的目标字段成为**抛错的 getter**。在测试代码的闭包里维护一个调用计数器变量，getter 函数体里判断当前调用次数：第一次访问时抛出注入错误、后续访问返回正常值。这样既能让 try 块抛进 catch 命中目标分支，又避免了 catch 之后的清理逻辑再次踩到 getter 进入无限循环 / 错路径。两种构造方式按场景选择：
  - **新建对象**：用对象字面量的 ES 标准 getter 语法直接声明字段
  - **改造已有对象的字段**：用 `Object.defineProperty` 重新定义该字段的描述符，把原值替换成抛错 getter
- **陷阱**：
  1. **必须先预置数据让代码路径真的走到那个读字段的位置**：如果队列是空、或前置守卫提前 return，try 块根本没执行，永远命中不了 catch
  2. `Object.defineProperty` **必须显式声明 `configurable: true`**：默认值为 `false` 会导致后续 `afterEach` 还原属性、或多个 case 复用同一对象时二次 defineProperty 抛 TypeError

### 3.3 spy 模块导出绕过守门

- **适用**：switch default 分支 / 后置 if 被前置 type guard 挡住，正常路径不可达（典型形态是：函数开头先调一个类型守卫函数把所有非法输入早退掉，紧接着的 switch 列出所有合法 kind 的处理分支，最后的 default 分支因为前面已经把非法输入拦截了，永远走不到）
- **思路**：用 `vi.spyOn` 把守卫函数 mock 成"对任意输入都返回放行结果"的版本，然后传入"未知 kind"的非法输入，绕过守卫直达 switch 的 default 分支
- **陷阱**：
  1. 伪输入字段需配齐**所有变体共享的必填字段**（即所有合法 kind 的接口都强制要求的字段，如各变体共有的 ID 字段、来源标识、时间戳之类），否则 switch 之前的字段访问可能提前抛错绕过 default
  2. spy 必须 `mockRestore` 清理；推荐 `try / finally` 包裹断言确保 restore 执行，否则跨 case 污染极难排查

### 3.4 构造非法运行时数据绕过类型层

- **适用**：类型层禁止某种值（典型如某数组的元素类型不允许 `undefined`），但运行时有针对这种值的防御代码（典型形态：从数组取一个元素后立即判断是否 falsy，是则提前 return）需要被命中
- **思路**：在测试代码中先用双重断言把目标数组转成"允许包含 falsy 值"的宽类型变量，再往里追加一个 `undefined`（或其他类型层禁止的 falsy 值），让源码后续从该数组取元素时拿到 falsy 值，触发早退分支
- **陷阱**：双重断言**仅限测试代码**；**严禁**为了让分支变得"类型上可达"去修改源码 type 定义放宽限制，那是把"运行时防御"伪装成"类型不可达"的反向操作

### 3.5 stubGlobal 控制环境能力探测

- **适用**：环境探测分支，常见三层条件 → 三种 stub 值一一对应（下表中的 `fakeImpl` 指被测代码会调到的 API 子集的最小伪实现，构造方式见下方陷阱第 2 条）：

  | 源码条件分支 | stub 值 | 命中后行为 |
  |---|---|---|
  | `typeof globalApi === 'undefined'` | `vi.stubGlobal('globalApi', undefined)` | 进入"全局对象不存在"分支 |
  | `!globalApi.subFeature`（对象在但缺子能力） | `vi.stubGlobal('globalApi', {})` | 进入"子能力缺失"分支 |
  | `globalApi.subFeature` 存在 | `vi.stubGlobal('globalApi', { subFeature: fakeImpl })` | 进入"正常返回"分支 |

- **陷阱**：
  1. `afterEach` **必须** 调 `vi.unstubAllGlobals()`，否则后续测试看到的全局对象不可预测
  2. 伪实现 `fakeImpl` 通常用对象字面量提供"被测代码会调到的几个方法"的 vi.fn 实现，再做一层双重断言转成目标 interface，避免被迫实现整个真实接口。**双重断言的目标类型优先使用项目内部声明的 interface**，避免直接用 `lib.dom` 的全局类型。原因是：lib.dom 的内置类型签名会随 TypeScript 版本升级而漂移（典型如新增字段、可选字段变必填、联合类型扩展等），今天测试通过、明天升级 TS 后断言失败；项目内部 interface 是源码自己声明并被生产代码消费的"事实契约"，最稳定且与被测代码同步演进

### 3.6 fake timers 推进定时器回调

- **适用**：`setInterval` / `setTimeout` 注册的回调里包含未覆盖代码（如心跳保活、超时清理、定时轮询、延迟重试等）
- **思路**：先决定 fake timers 模式（默认 vs 精细化拦截，见 §4 决策），用 `vi.useFakeTimers` 启用；再调注册定时器的入口函数；然后用 `vi.advanceTimersByTime` 推进虚拟时间到目标定时器到期点触发回调。定时器回调里**只要**出现 `Promise / await / .then`，必须改用 `advanceTimersByTimeAsync`
- **陷阱**：
  1. 推进规则按定时器类型区分：**setTimeout（一次性）**：`N < 间隔` → 不触发；`N >= 间隔` → 触发 1 次（且**永远只触发 1 次**，无论 N 多大）；**setInterval（周期性）**：`N < 间隔` → 不触发；`k * 间隔 <= N < (k+1) * 间隔`（k 为正整数）→ 触发 k 次。为了精确证明"恰好命中一次"，**推荐推进精确等于注册间隔**。断言计数前必须先确认目标定时器是 setTimeout 还是 setInterval，否则 N 略大时 setInterval 多触发的次数会让断言挂掉
  2. 注册定时器的入口函数本身可能也立即执行一次同样的副作用（如进入某状态时立即执行一次 + 后续 setInterval 周期重复执行）。断言**必须**用「推进时间前后副作用数量差值」做强断言，三步走：第一步在调入口函数前先记录副作用容器（如 mock 函数调用次数、外部依赖收到的消息历史长度等）的当前计数；第二步调入口函数，断言计数增加量等于"立即副作用数"；第三步推进定时器时间，断言计数再次增加，且增加量等于"回调副作用数"。只有第三步看到正向差值才证明回调真被命中。**禁止**用 `toContainEqual` 这类弱断言（只看存在性，无法区分立即副作用 vs 回调副作用）
  3. 跨模块同名常量陷阱：不同模块 / 文件里出现同名常量（如多个文件各自定义同名的"心跳间隔"常量）可能取值不同，测试 import 必须从**真实定义文件**而非"恰好转手 re-export 同名"的中间文件，否则会推进错时间错过回调
  4. 默认 fake timers 选项**会**冻结 `Date.now()` / `performance.now()` 等时间源，与"源码内依赖真实时间戳做超时 / TTL 判定"的逻辑直接冲突 —— 见 §4 精细化拦截

---

## 4. Fake Timers 精细化拦截（关键决策点）

### 默认行为陷阱

`vi.useFakeTimers()` **不带 toFake 选项**时，按 vitest 官方文档（`Vi | useFakeTimers`），默认会 fake「除 `nextTick` 和 `queueMicrotask` 外，所有当前环境全局可用的定时器/时间相关方法」。该清单在不同运行环境（node / 浏览器 / vitest workspace 配置）会有差异，确切完整列表以你正在使用的 vitest 版本文档为准；**不要凭印象列举**。

**实测可复现的关键后果**：默认模式下 `Date.now()` / `performance.now()` 通常都被冻结。源码里**依赖真实时间戳做"过期 / 单调递增"判定**的逻辑（如超时检测、心跳保活、TTL 比较、单调递增的序号生成等），在默认 fake 模式下会因为时间不前进而失效，导致测试时序断言失败。

### 解决方案：精细化拦截

调 `vi.useFakeTimers(options)` 时显式给 `options.toFake` 传一个**只包含 JS 定时器 API**的字符串数组（最常见的四件套：`setTimeout` / `clearTimeout` / `setInterval` / `clearInterval`；如果源码还用了 `setImmediate` / `clearImmediate` / `requestAnimationFrame` / `cancelAnimationFrame` / `requestIdleCallback` / `cancelIdleCallback` 等其他定时器 API，必须按实际使用情况追加到 `toFake` 数组里），让 `Date` / `performance` 等时间源**不在拦截列表内**、保持真实墙钟。这样 `Date.now()` / `performance.now()` 仍会随时间前进，源码内的超时判定 / 单调时间戳逻辑能正常工作；同时所有受控定时器全部受测试控制可推进。

**典型适用场景**：任何同时满足"源码用 `Date.now()` / `performance.now()` 做时间判定" + "测试需要主动推进定时器触发回调"两个条件的场景。

### advanceTimersByTime vs advanceTimersByTimeAsync

| 版本 | 行为 | 何时用 |
|---|---|---|
| `advanceTimersByTime` | 仅推进 timer 队列并跑到期回调；跑完后**不主动让出事件循环 flush 微任务** | 仅当回调内**完全纯同步**（绝无 Promise / await / .then）时使用 |
| `advanceTimersByTimeAsync` | 每推进一段时间后会让出事件循环把 `.then` 微任务链跑完，再继续推进 | 回调内**只要出现任意一个** Promise / await / .then 就**必须**改用此版 |

**判断标准**（强约束）：定时器回调链路里**只要出现** `Promise / await / .then` 中**任意一个**，就**必须**用 async 版。同步版无法把"回调里通过 .then 安排的下一层 setTimeout"注册到队列，会导致 Promise 永远不 settle、测试 hang 至超时（vitest 默认 5s 超时，CI 上常表现为 hang）。两个版本不是"按情况二选一"的对等关系，而是"async 版能覆盖同步版的所有场景，反之不行"的单向覆盖关系。

### 微任务相关注意（与 fake timers 决策的边界）

按 vitest 官方文档，`vi.useFakeTimers()` 默认**不会** fake `process.nextTick` 和 `queueMicrotask`，所以默认情况下 `BroadcastChannel.postMessage` / `MessagePort.postMessage` 等**原生异步派发**所依赖的 microtask 队列**不受 fake timers 影响**。这意味着 fake timers 模式下做异步派发测试是安全的。

唯一与 fake timers 决策相关的陷阱：如果你**显式**把 `queueMicrotask` 加进 `toFake` 列表（如 `toFake: ['queueMicrotask', ...]`），原生异步派发的消息会被锁住、永远到不了 listener。除非确实有特殊需求要拦截 microtask，否则**不要**把它加进 `toFake`。

> 注意：原生异步派发本身是 microtask 时序的（即同步 `postMessage` 后必须 `await Promise.resolve()` 让出一拍才能让 listener 跑），这是事件机制的固有特性、与 fake timers 无关。该时序问题应在异步测试基础范畴解决（如 MDN BroadcastChannel 文档、vitest 异步测试指南），不属于 fake timers 决策。

### afterEach 清理

涉及 fake timers 的测试 **必须**在 `afterEach` 调 `vi.useRealTimers()`，否则污染后续测试的真实时间相关行为。

---

## 5. 反模式（禁止做）

本节不与「三条不可动摇硬约束」+ SKILL.md 「测试与覆盖率 Anti-Patterns」重复列出，仅补充本文档独有的攻坚陷阱：

- **❌ 凭印象写函数签名**：所有内部函数签名（参数个数、参数类型、返回值）必须先在源码核实，禁止凭"成对函数应该签名对称"的直觉假设。TS 函数声明形态多样（普通 / async / 箭头 / 类方法 / 对象方法），单条文本搜索难以一次覆盖；正确做法是先用源码搜索工具（IDE 跳转到定义 / `grep` / `file_grep` / `ripgrep` 等）列出名字所有出现位置，再读对应文件人工筛选出真正的定义行（区分 import / re-export / 调用 / 定义四种形态）
- **❌ 跨模块借同名常量**：同名常量在不同模块 / 文件里可能取值不同，测试 import 必须从**真实定义文件**而非中间转手 import 的文件读取
- **❌ 用弱断言伪装回调被命中**：`toContainEqual` / `toMatchObject` 这类「只检查存在性」的断言无法区分"立即副作用"和"定时器回调副作用"，证明回调真的被命中**必须**用「推进时间前后副作用数量差值」的强断言
- **❌ 直接默认 useFakeTimers 跑依赖 `Date.now()` 的源码**：默认 toFake 列表通常包含 `Date / performance`（确切清单以当前 vitest 版本文档为准），会冻结时间源；只要源码用 `Date.now()` / `performance.now()` 做时间判定，就必须用 `toFake: [...]` 精细化拦截，把时间源排除在外
- **❌ spy 不 restore**：`vi.spyOn` 之后必须 `mockRestore`（推荐 `try / finally` 包裹），否则跨测试污染极难排查
- **❌ 在主入口 re-export 内部函数**：模块主入口仅暴露公开 API，Step C 导出的内部函数仅供 `__test__/*` 直接 import；违反将让用户能调到本不该暴露的 API
- **❌ 修改源码让"防御分支变可达"**：防御分支本身是为生产环境的非常规情况兜底，不是测试不到就没价值；改源码让它从测试角度"可达"会破坏防御语义，本质上是篡改而非测试
- **❌ 加 testing-only setter / 后门 API**：任何形如 `_setStateForTest` / `__internal__` 的后门，无论命名多隐蔽，都会被未来的代码调用方滥用，必须从 Step C 设计阶段就杜绝
