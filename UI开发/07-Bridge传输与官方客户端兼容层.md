# 07：Bridge 传输与官方客户端兼容层

## 1. 文档目标

本文件定义桌面端怎样在 Electron Utility Process 内建立、认证并使用官方 DeepSeek Harness Client，以及怎样把官方 Cordis Service、Controller 和 Conversation Projection 收敛为稳定、受限、可恢复的 Desktop Bridge 协议。

完成本模块后，应当得到以下确定结果：

```text
Main 创建并监督受管 Utility
  → Utility 校验 Main 握手与固定 Release Set
  → 启动 Token 只在 Utility 内换取内存 Cookie
  → 自定义 fetch/openStream 接入官方 ClientTransportHooks
  → Utility 内组装 Cordis + Connection + Gateway + Remotes
  → Utility 内组装 Session/Workspace Controller + Conversation Projection
  → 等待官方 generation 与领域 baseline 同步
  → 仅向 Renderer 发布 Desktop DTO、Snapshot、Patch、Capability、Interaction
```

以下约束是本章不可放宽的架构门禁：

- 官方 DSH 包、Cordis Context、Session Controller、Workspace Controller、Conversation Projection 只能存在于 Bridge Utility 及其 `harness-compat` 依赖图中。
- Main 只管理进程生命周期、MessagePort 和原生能力，不解析 Workspace、Session 或 Conversation 业务。
- Renderer 和 Preload 不导入任何官方 DSH/Cordis 包，不接触 Cookie、启动 Token、Harness URL、官方 Remote 对象或原始事件。
- Bridge 不提供 `invoke(method, args)`、任意 URL、任意 Remote namespace 或任意 Cordis 动态代码入口；所有页面能力都必须进入版本化白名单。
- V1 只连接本应用启动、绑定 `127.0.0.1` 且已经过 Runtime Supervisor 验证的 Harness 实例。

## 2. 范围、边界与责任

### 2.1 本模块负责

- Utility 身份握手、Release Set 核验和 MessagePort 所有权。
- 启动 Token 到 Host-only Cookie 的认证交换，以及 Cookie 的内存生命周期。
- 官方 unary HTTP transport 与 `/api/remote.mux` WebSocket multiplex transport。
- 官方 Cordis/Connection/Gateway/Remotes/Session/Workspace Client 的确定性装配和释放。
- 官方连接 generation、领域 baseline、重连、gap repair 和 readiness 汇聚。
- 官方类型、错误、事件和 capability 到 Desktop Contract 的版本化映射。
- Renderer 消费端的请求、取消、订阅、流控、重同步和交互应答协调。
- Fake transport、固定上游 fixture、真实 Host 合同测试和升级差分门禁。

### 2.2 本模块不负责

- 不启动、停止或强杀 Harness；这是 `06-Harness运行时管理.md` 的职责。
- 不创建窗口、文件选择器、系统通知或外链；这是 `05-Electron主进程与安全外壳.md` 的职责。
- 不让 Renderer 读取绝对路径。Renderer 只提交 Main 签发的 opaque capability。
- 不重新实现 Harness 的 Session 持久化、Queue、Agent Loop 或 Tool 执行。
- 不把官方 Web 页面嵌入 Electron，也不加载其 JavaScript Bundle。
- 不把动态 Cordis `getClientCode`、`invoke`、Inspector 或任意插件 UI 透传给 Renderer。
- 不承诺兼容未锁定的 Harness 版本；版本变化必须经过 `BRG-018`。

### 2.3 安全边界的现实说明

Utility 是 Node 能力进程，不是 Chromium sandbox。它与 Main 分权、没有 BrowserWindow 能力、只接收裁剪环境变量，但在当前桌面操作系统上仍以用户权限运行。V1 的安全控制是最小依赖图、精确网络 authority、固定命令白名单、无任意文件路径、无 Secret 出站和可审计生命周期；不能把这些软件约束描述成 OS 级隔离。若风险评估要求抵御 Utility 内依赖被攻陷，后续版本必须增加 Windows AppContainer/防火墙规则或独立低权限账号，并单独形成 ADR。

## 3. 固定上游基线与已核验事实

本章以仓库 `deepseek-harness` 的 tag `dsh-v0.1.2-alpha.4`、commit `4e84901e6471b79ec0338099867ebb4606d12bb5` 为唯一上游语义源。实现时必须在 Release Set Manifest 中再次核对该值。

| 已核验事实 | 固定源码证据 | 本项目结论 |
|---|---|---|
| Transport 注入面 | `packages/client/connection/src/client/index.ts` 的 `ClientTransportHooks` 和 `__DSH_TRANSPORT__` | Utility 在装配 Connection 前同时注入受控 `fetch` 与 `openStream` |
| 无 `location` 时的 unary 基址 | 同文件经 `createWebConnectionRpc` 构造 `http://dsh.internal/api/...` | adapter 不信任该 authority，只取已生成 pathname，并重写到 Supervisor 给出的固定 origin |
| Gateway stream | `packages/api/gateway/src/stream-protocol.ts` 定义 `REMOTE_STREAM_MUX_PATH = '/api/remote.mux'` | 一个物理 WS 承载多个 logical stream |
| Stream parser | 同文件的 `parseRemoteStreamServerMessage`；`packages/api/gateway/src/client/stream-client.ts` 消费它 | 不能凭文档手写猜测帧；compat 必须绑定固定源码与差分测试 |
| 包导出限制 | `packages/api/gateway/package.json` 只发布 `lib`；当前公开 client entry 不导出 mux client/parser | GA 禁止运行时私有 `src/*` 导入；采用带 MIT 归属、固定 SHA 的版本化 compat 生成物，或在发布前获得上游公开 factory |
| Connection generation | `packages/client/connection/src/client/connection.ts` 及 README | `$events` 首项 ready 且监听器已挂载后才发布 generation |
| 官方重连节奏 | Connection README 与实现 | 500ms、1s、2s、4s、8s、10s 上限，50%–100% jitter；10s 档失败后终态 disconnected |
| Gateway 重试责任 | Connection README | mux 每次只做一次物理连接；Bridge 不再叠加第二套自动重试 |
| Session follow/control | `packages/api/session-controller/src/client/transport.ts` | follow 是 journal 语义，control 每 generation 有完整 baseline |
| Session Client | `packages/api/session-controller/src/client/sessions/session.ts`、`service.ts` | `loadOlder()` 每次 50 条，`loadThrough(seq)` 每页 200；`beginSubmission` 提供本地回显与 durable `rpcId` 对账 |
| Workspace Client | `packages/api/workspace-controller` client 实现与测试 | 先全量 baseline，再处理 upsert/remove/order/archive；重连替换 baseline |
| Remote event | `packages/api/remotes/src/remote-events.ts` | Approval 与 User Question 是 waterfall；其余固定 allowlist 为 emit |
| Remote error | `packages/typert/protocol/src/remote-error.ts` | 官方错误有 `code/message/details`；carrier、cancel、协议和 outcome unknown 需在 Bridge 另行分类 |
| Session 持久化格式 | `packages/session/session-persistence-jsonl/src/format.ts` | 当前 `SESSION_FORMAT_VERSION = 0`，alpha 阶段无跨版本兼容承诺；桌面端不得直接解析 JSONL |

### 3.1 当前官方事件白名单

`@deepseek-ai/dsh-api-remotes` 当前固定版本转发以下事件；升级时必须逐项差分：

| 事件 | 模式 | Bridge 处理 |
|---|---|---|
| `agent-preset/selected` | emit | 更新 capability/selection 投影 |
| `approval/request` | waterfall | 进入 Interaction Coordinator，必须恰好一次回答或 fail closed |
| `api-session/activity` | emit | 更新 Session 活跃时间 |
| `api-session/added` | emit | Session 列表增量 |
| `api-session/error` | emit | 归一化并关联 Session |
| `api-session/removed` | emit | 删除 Session 投影 |
| `api-session/status` | emit | 更新运行状态 |
| `commands/change` | emit | 刷新命令 catalog |
| `credentials/reference-updated` | emit | 只更新引用状态，不携带 Secret |
| `cordis/request-run` | emit | V1 不向 Renderer 暴露；只记受限诊断 |
| `cordis/request-run-resolved` | emit | V1 不向 Renderer 暴露 |
| `cordis/dynamic-package` | emit | V1 不执行页面代码，只触发 capability 重新评估 |
| `cordis/dynamic-retract` | emit | V1 不执行页面代码，只触发 capability 重新评估 |
| `cordis/inspect-query` | emit | V1 不向 Renderer 暴露 |
| `cordis/inspect-query-resolved` | emit | V1 不向 Renderer 暴露 |
| `llm/adapters-updated` | emit | 刷新 provider/model capability |
| `settings/document-updated` | emit | 刷新 Settings 投影 |
| `user-questions/request` | waterfall | 进入 Interaction Coordinator，必须恰好一次回答或取消 |

### 3.2 当前官方 Remote 能力账本

这张表用于证明“完整装配”和“最小暴露”是两件不同的事。`api-remotes` 可以在 Utility 内挂载官方 contribution；Renderer 只能访问第三列批准的 Desktop operation，不能获得 Remote 对象。

| 官方 namespace | 当前方法 | V1 暴露策略 |
|---|---|---|
| Session | `list`、`search`、`create`、`selectModel`、`modelCatalog`、`canOpenWorkspacePath`、`openWorkspacePath`、`rename`、`fork`、`prompt`、`attachment`、`updateQueue`、`cancel`、`page`、stream `follow`、stream `control` | 经 WS/Session/Conversation 模块映射；没有通用调用 |
| Skills | `list` | 映射为只读 catalog |
| FileReferences | `list` | 按 Session 映射且移除非必要路径 |
| Workspace | `create`、`rename`、`delete`、`insertBefore`、`insertSessionBefore`、`archiveSession`、stream `follow` | 经 Workspace DTO/command 映射 |
| DirectoryPicker | `pick`、`list`、`createDirectory` | 不暴露；桌面端使用 Main opaque directory capability |
| Settings | `describe`、`canOpenAgentPresetDirectory`、`update`、`replace`、`mutate`、`openSettingsDocument`、`openAgentPresetDirectory` | describe/update 类映射；打开目录/文档改走 Main Intent |
| Credentials | `describe`、`set`、`unset` | 映射固定表单；`describe` 不得产生 Secret 回显 |
| AgentPresets | `list`、`read`、`copy`、`deletePreset`、scoped `select` | 映射 DTO 与显式确认命令 |
| Commands | `list`、scoped `execute` | 只允许 catalog 中、当前 generation 存在的 command id |
| Goals | scoped `create`、`edit`、`pause`、`resume`、`complete`、`clear` | 命令映射；当前值来自 Session projection，不虚构 `get` |
| LLM | `listProviders`、`listConfigurableProviders`、`discoverModels` | 映射脱敏 provider/model catalog |
| Subagent | `list`、`prompt`、`interruptByParent` | 映射父子作用域命令 |
| PluginInventory | `list` | 只读、去除任意客户端执行入口 |
| MessageFeedback | `list`、`put`、`delete` | 映射固定 feedback DTO |
| SessionReference | `candidates` | 映射候选项并做数量限制 |
| Dynamic Cordis | `undefineFromPanel`、`runHostHalf`、`getClientCode`、`resolveRequestRun`、`settleUserRun`、`stopFromPanel`、`syncInspectManifest`、`resolveInspectQuery`、`inventory`、`reportRenderFailure`、`reportClientGuardFailure`、`invoke` | V1 全部不暴露给 Renderer；不得执行远端返回的任意页面代码 |

## 4. 依赖与建议目录

### 4.1 前置与下游依赖

| 类型 | 依赖 |
|---|---|
| 前置 | `01` 的 Release Set、`02` 的进程边界、`04` 的 Desktop Contract、`05` 的 Utility/Port Supervisor、`06` 的 Runtime Handle 与 readiness handoff |
| 官方运行依赖 | 精确锁定的 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-typert-registry`、`@deepseek-ai/dsh-client-connection/client`、`@deepseek-ai/dsh-api-gateway/client`、`@deepseek-ai/dsh-api-remotes/client`、`@deepseek-ai/dsh-api-session-controller/client`、`@deepseek-ai/dsh-api-workspace-controller/client` 及其精确 lockfile 闭包 |
| Transport | Node 内建 `fetch`/`AbortController`、精确锁定的 `ws`；不得使用 Electron Session Cookie Jar |
| 合同 | `desktop-contracts` 的 Frame Schema、DTO、Error、Capability、Limits、ProtocolVersion |
| 下游 | Workspace/Session 模块、Conversation Projection、Vue Adapter、Interaction、Settings 与诊断模块 |

官方包名和 client entry 必须由固定源码的 package manifest/exports 验证后进入 lockfile；若某 entry 在发布制品不存在，不得靠 bundler alias 隐式穿透 `src/*`。

### 4.2 建议目录

```text
apps/desktop/src/bridge/
├─ entry.ts                         # Utility 唯一入口
├─ bootstrap/
│  ├─ parent-handshake.ts           # Main 身份、Release Set、Port 接收
│  ├─ bridge-state-machine.ts
│  └─ readiness-barrier.ts
├─ auth/
│  ├─ authority.ts                  # 精确 loopback authority 值对象
│  ├─ token-exchange.ts
│  └─ memory-cookie.ts
├─ transport/
│  ├─ authenticated-fetch.ts
│  ├─ authenticated-mux.ts
│  ├─ stream-owner.ts
│  └─ transport-errors.ts
├─ official/
│  ├─ create-client-context.ts
│  ├─ apply-order.ts
│  ├─ controller-registry.ts
│  └─ official-readiness.ts
├─ protocol/
│  ├─ frame-router.ts
│  ├─ command-table.ts
│  ├─ subscription-hub.ts
│  ├─ flow-control.ts
│  └─ chunk-assembler.ts
├─ interactions/
│  ├─ coordinator.ts
│  ├─ approval-adapter.ts
│  └─ question-adapter.ts
├─ resources/
│  ├─ session-subscription-pool.ts
│  ├─ disposal-registry.ts
│  └─ capability-resolver.ts
├─ observability/
│  ├─ error-normalizer.ts
│  ├─ redactor.ts
│  └─ audit.ts
└─ tests/
   ├─ unit/
   ├─ contract/
   ├─ integration/
   └─ fault/

packages/harness-compat/
├─ src/
│  ├─ index.ts
│  └─ versions/
│     └─ dsh-0.1.2-alpha.4/
│        ├─ adapter.ts
│        ├─ capability-map.ts
│        ├─ error-map.ts
│        ├─ event-map.ts
│        ├─ mux-wire.generated.ts
│        └─ projection-adapter.ts
├─ upstream/
│  └─ manifest.json                 # commit、source path、SHA-256、MIT notice
└─ tests/
   ├─ golden/
   ├─ differential/
   └─ real-host/
```

`mux-wire.generated.ts` 不是手工复制后无人维护的代码。生成任务必须从固定 checkout 读取被批准的协议定义，保留许可证与来源 SHA；CI 用 SHA 和行为 fixture 验证它仍对应 Release Set。若最终拿到上游正式公开的认证 WebSocket factory，应删除生成实现并走公开入口，同时保留同一合同测试。

### 4.3 依赖边界门禁

- `apps/desktop/src/renderer/**`、`preload/**`、`main/**` 和 `desktop-contracts` 禁止 import `@deepseek-ai/dsh-*`、`@deepseek-ai/cordis`、`ws` 或 `harness-compat`。
- `harness-compat` 不能依赖 Vue、Pinia、Electron Main API 或 BrowserWindow。
- `bridge` 不能 import `electron.shell`、`dialog`、`clipboard` 或任意渲染组件。
- 生产 Bundle 扫描必须证明不存在 `@deepseek-ai/*/src/*` 运行时导入。
- 所有官方版本必须精确解析为 `0.1.2-alpha.4`；`workspace:^` 只属于上游 monorepo，不得原样进入桌面发行 lockfile。

## 5. Bridge 总体合同

### 5.1 生命周期状态机

```text
CREATED
  → WAITING_PARENT
  → VALIDATING_RELEASE
  → WAITING_RUNTIME
  → AUTHENTICATING
  → ASSEMBLING_CLIENT
  → CONNECTING
  → SYNCING_BASELINES
  → READY

READY → DEGRADED → CONNECTING
READY → DISPOSING → STOPPED
任意初始化态 → FAILED_INIT → DISPOSING → STOPPED
连续恢复失败 → RECOVERY_REQUIRED
```

规则：

- 每个 Utility 进程有不可复用的 `bridgeInstanceId`；每次 Main 分发新 Port 产生 `portEpoch`；每次官方连接 ready 产生单调递增的 `connectionGeneration`。
- 只有当前 Runtime 实例、认证成功、官方 generation 已发布、Workspace baseline 已安装、必需 Session/Capability 基线已同步时才能进入 `READY`。
- `DEGRADED` 可以展示最后一次确认的只读快照，但写命令默认关闭；页面必须看见陈旧标记。
- 任何旧 `bridgeInstanceId/portEpoch/connectionGeneration` 的帧都在入口丢弃并计数，不能修改当前状态。
- Bridge 自身不决定重启 Harness；它报告故障类别和是否建议重启，由 Main/Runtime Supervisor 统一执行。

### 5.2 Parent → Bridge 私有启动合同

这些消息只在 Main 创建的控制通道上传输，不进入 Renderer-facing Port：

```ts
type BridgeControlMessage =
  | {
      type: "bridge.bootstrap";
      bridgeInstanceId: string;
      releaseSet: ReleaseSetDto;
      uiProtocolVersion: ProtocolVersionDto;
      runtime: {
        runtimeInstanceId: string;
        origin: string;              // 必须是 http://127.0.0.1:<port>
        readinessToken: string;      // 一次性交接，不落盘、不转发
      };
      rendererPort: MessagePort;
    }
  | { type: "bridge.replace-renderer-port"; portEpoch: number; port: MessagePort }
  | { type: "bridge.system-resumed"; observedAt: string }
  | { type: "bridge.prepare-shutdown"; deadlineAt: string }
  | { type: "bridge.dispose"; reason: BridgeDisposeReason };

type BridgeControlEvent =
  | { type: "bridge.phase"; phase: BridgePhase; runtimeInstanceId?: string }
  | { type: "bridge.ready"; bridgeInstanceId: string; connectionGeneration: number }
  | { type: "bridge.fault"; fault: SanitizedBridgeFault }
  | { type: "bridge.drained"; bridgeInstanceId: string };
```

### 5.3 Renderer-facing MessagePort 合同

```ts
interface BridgeFrameBase {
  uiProtocolVersion: ProtocolVersionDto;
  bridgeInstanceId: string;
  portEpoch: number;
  runtimeInstanceId: string;
  connectionGeneration: number;
  sequence: number;
}

type UiToBridgeFrame =
  | { type: "hello"; protocol: ProtocolVersionDto; clientNonce: string }
  | { type: "request"; requestId: string; operation: DesktopOperation; deadlineAt: string; payload: unknown }
  | { type: "cancel-request"; requestId: string; reason: "user" | "navigation" | "shutdown" }
  | { type: "subscribe"; subscriptionId: string; topic: DesktopTopic; cursor?: SnapshotCursorDto }
  | { type: "unsubscribe"; subscriptionId: string }
  | { type: "ack"; subscriptionId: string; throughSequence: number; credit: number }
  | { type: "resync"; subscriptionId: string; reason: "gap" | "reload" | "consumer-reset" }
  | { type: "interaction-answer"; interactionId: string; answer: InteractionAnswerDto };

type BridgeToUiFrame =
  | { type: "hello-ack"; capabilities: CapabilitySnapshotDto; limits: ContractLimitsDto }
  | { type: "result"; requestId: string; outcome: DesktopResultDto }
  | { type: "state"; state: BridgeStateDto }
  | { type: "snapshot"; subscriptionId: string; revision: number; payload: DomainSnapshotDto }
  | { type: "patch"; subscriptionId: string; baseRevision: number; revision: number; patch: DomainPatchDto }
  | { type: "resync-required"; subscriptionId: string; reason: ResyncReason }
  | { type: "interaction-open"; interaction: InteractionDto }
  | { type: "interaction-update"; interaction: InteractionUpdateDto }
  | { type: "interaction-close"; interactionId: string; outcome: InteractionOutcomeDto };
```

所有 union 都由 `desktop-contracts` 的 runtime Schema 定义。上面的 TypeScript 只解释形状，不得成为绕过 Schema 的第二真源。

### 5.4 V1 全局硬限额

以下是 Desktop Bridge 合同，不是 Harness 默认值：

| 项目 | V1 限额 | 超限行为 |
|---|---:|---|
| 单个 MessagePort Frame | 256 KiB（序列化后） | 拒绝并返回 `VALIDATION_PAYLOAD_TOO_LARGE` |
| 单 chunk | 64 KiB | 拒绝当前 chunk transfer |
| 组装中 Snapshot | 32 MiB/订阅 | 取消组装并要求分页或重新同步 |
| 单对象嵌套深度 | 32 | Schema 拒绝 |
| 单字符串 | 128 Ki UTF-8；Prompt 另按领域合同 | Schema 拒绝 |
| 单 Port pending request | 64 | 新请求返回 `BRIDGE_BUSY` |
| 并发有副作用命令 | 8 | 有界 FIFO，过 deadline 不执行 |
| 单 Port active subscription | 32 | 拒绝新增并提示关闭后台 Session |
| 单订阅未确认 soft watermark | 2 MiB | 合并可合并 Patch、暂停后台增量 |
| 单订阅未确认 hard watermark | 4 MiB | 发 `resync-required`，丢弃仅可重建的旧 Patch |
| Bridge 全局出站积压 | 16 MiB | 停止新订阅，最慢消费者进入 resync |
| 默认 unary deadline | 30 秒 | 只中止本地等待，不推断业务已撤销 |
| 普通请求最大 deadline | 5 分钟 | Schema 拒绝更长 deadline |
| chunk transfer 并发 | 每 Port 2 个 | 新 transfer 返回 busy |

官方附件当前默认值是每图 20 MiB、最多 20 张、总计 200 MiB、64M 像素、单边 8192；官方 HTTP bridge 默认 request body 上限为 300 MiB。桌面端不能把 300 MiB 当作 Renderer IPC 预算。附件必须走 `BRG-011` 的 capability 流水线，并以运行时返回的 `imageLimits` 和 Desktop 硬上限两者中更严格者为准。

## 6. 功能总表

本章使用唯一前缀 `BRG`，完整范围为 `BRG-001` 至 `BRG-018`。

| ID | 优先级 | 功能 | 主要交付 |
|---|---|---|---|
| `BRG-001` | P0 | 受管 Utility 身份与启动握手 | Parent handshake、Release Set/Port ownership |
| `BRG-002` | P0 | Token 换 Cookie 与 authority 锁定 | Memory Cookie、303/Host/Origin 验证 |
| `BRG-003` | P0 | 官方 unary HTTP transport | `ClientTransportHooks.fetch` adapter |
| `BRG-004` | P0 | 官方 multiplex stream transport | 认证 `/api/remote.mux`、logical stream owner |
| `BRG-005` | P0 | 官方 Cordis/Client/Controller/Projection 装配 | 确定 apply 顺序与 readiness |
| `BRG-006` | P0 | 版本化官方兼容层 | DTO/Event/Error/Projection adapter |
| `BRG-007` | P0 | 单一连接状态与 generation | Bridge phase/generation gate |
| `BRG-008` | P1 | 自动有界重连 | 使用官方 backoff、未知结果处理 |
| `BRG-009` | P0 | baseline、follow 与 gap repair | 全域同步后才 Ready |
| `BRG-010` | P0 | 慢消费者流控 | credit/ack/coalesce/resync |
| `BRG-011` | P0 | 请求/订阅/业务取消分离 | Abort、unsubscribe、Session cancel |
| `BRG-012` | P0 | 稳定错误与恢复动作 | DesktopError normalizer/redaction |
| `BRG-013` | P1 | 多 Session 订阅资源池 | active/background/sleep + LRU |
| `BRG-014` | P1 | Capability Snapshot | 官方能力与本地策略交集 |
| `BRG-015` | P1 | 可审计关联 | request/correlation/session/stream id |
| `BRG-016` | P1 | 安全停止与重建 | reverse dispose、partial init cleanup |
| `BRG-017` | P1 | 无真实模型的确定性测试 | Fake transport + recorded fixture |
| `BRG-018` | P1 | 上游升级差分门禁 | fingerprint/report/new adapter |

## 7. 逐功能开发规格

### BRG-001：受管 Utility 身份与启动握手

**行为**

Bridge 只接受 Main 在创建 Utility 时交付的一次 `bridge.bootstrap`。握手同时绑定 `bridgeInstanceId`、Release Set、`runtimeInstanceId`、固定 loopback origin、一次性 readiness Token 和首个 Renderer Port。任何来自 argv、环境变量、Renderer 或普通文件的 Harness URL 都不作为生产输入。

**实现步骤**

1. Utility 入口先安装 `uncaughtException/unhandledRejection` 的脱敏故障出口，再等待控制 Port。
2. 校验消息类型、发送端通道、唯一 bootstrap 次数、Protocol major、Release Set SHA 和 origin。
3. 把 Token 移交给 `TokenExchange`；其他启动字段冻结为只读 `ManagedRuntimeHandle`。
4. 为 renderer Port 分配单调 `portEpoch`，安装双向 Schema validator；旧 Port 在替换前先撤销订阅。
5. 只有握手校验通过才 import/instantiate 官方 Client，避免错误父进程触发网络或插件副作用。

**接口或消息**

- 输入：`bridge.bootstrap`、`bridge.replace-renderer-port`。
- 输出：`bridge.phase(WAITING_RUNTIME|AUTHENTICATING)` 或 `bridge.fault`。
- 内部接口：`ParentIdentity.acceptOnce(message): ManagedBridgeBootstrap`、`PortLease.replace(port): PortEpoch`。

**状态机**

`CREATED → WAITING_PARENT → VALIDATING_RELEASE → WAITING_RUNTIME`。重复 bootstrap、major 不匹配或 Release Set 不一致进入 `FAILED_INIT`；替换 Renderer Port 不改变 Bridge generation，只递增 `portEpoch`。

**限额**

bootstrap 最多 64 KiB；等待父握手 10 秒；每个 Bridge 同时恰好一个控制 Port、一个活动 Renderer Port；替换 Port 频率最多 10 次/分钟，超过后报告 crash-loop 信号。

**错误与恢复**

`PARENT_HANDSHAKE_TIMEOUT`、`RELEASE_SET_MISMATCH`、`PROTOCOL_MAJOR_MISMATCH`、`RUNTIME_HANDLE_INVALID` 均 fail closed。Renderer reload 只替换页面 Port；Utility/官方连接保留。控制 Port 关闭则立即停止接收写命令并进入 dispose。

**安全**

origin 必须精确为 `http://127.0.0.1:<1..65535>`，拒绝 hostname、IPv6、userinfo、path、query、fragment 和默认端口猜测。Token 不进入日志、异常 cause、crash report 或 Renderer 帧。

**测试**

Schema 正反例；重复/迟到 bootstrap；假 Main Port；Release Set 逐字段差异；origin fuzz；Renderer Port 连续替换 20 次；控制 Port 突然关闭；Bundle 证明校验前没有官方副作用。

**Definition of Done**

未通过 Main 身份、Release Set 和 origin 校验时网络调用数为零；有效握手仅被消费一次；旧 Port 无法继续发送或接收业务帧；全部故障输出已脱敏。

### BRG-002：Token 换 Cookie 与 authority 锁定

**行为**

Utility 对固定 origin 执行且只执行一次 `GET /?token=<readinessToken>`，手动处理响应。成功必须是 HTTP 303、`Location: /`，并恰好取得一个 authority-bound Harness Cookie；之后所有 HTTP/WS 只使用 Cookie 和固定 Origin，不再携带 Token。

**实现步骤**

1. 从 `ManagedRuntimeHandle` 复制 token 到最短生命周期的局部对象；设置 `redirect: "manual"`。
2. 用 `URL` 构造根路径，只允许一个 `token` 参数，禁止拼接字符串。
3. 验证 status 303、Location 精确为相对 `/`，拒绝绝对/跨 authority redirect。
4. 使用 Node `Headers.getSetCookie()`（若运行时无该能力则使用经过测试的 RFC6265 parser）读取 Set-Cookie，要求恰好一个预期 `dsh-auth-*` Cookie，校验 `Path=/`、`HttpOnly`、`SameSite=Strict` 且没有 `Domain`。
5. 内存只保存 `name=value` 和绑定 authority；释放 Token 引用。随后用第一条严格 unary/WS 握手验证 Cookie，认证失败则丢弃 Cookie 并请求整个受管实例重建。

**接口或消息**

- 输入：`TokenExchangeInput { origin, readinessToken, runtimeInstanceId }`。
- 输出：`MemoryCredential { cookieHeader, authority, runtimeInstanceId }`，此类型禁止 structured clone 和 JSON 序列化。
- 状态事件：`bridge.phase(AUTHENTICATING)`；失败输出仅有 `AUTH_EXCHANGE_FAILED` 支持码。

**状态机**

`UNAUTHENTICATED → EXCHANGING → AUTHENTICATED → INVALIDATED`。一次对象不能从 `INVALIDATED` 回到 `AUTHENTICATED`；恢复必须使用新 runtimeInstanceId 和新 Token。

**限额**

认证响应 header 总计不超过 32 KiB；Set-Cookie 单值不超过 8 KiB；交换 5 秒 deadline；不自动重试同一 Token。

**错误与恢复**

网络失败、非 303、错误 Location、零个或多个 Cookie、Host/Origin 拒绝都归一为不同内部原因、同一用户错误族。认证结果未知时不重放 Token；通知 HRS 停止旧实例并启动新实例。

**安全**

禁用 redirect；禁止 Cookie 持久化、Electron `session.cookies`、系统凭据库、磁盘 cache 和诊断导出。JavaScript 字符串无法保证物理清零，文档和实现只能承诺最短引用生命周期与永不序列化，不能声称安全擦除。

**测试**

真实 Host 认证成功；303/302/200 差异；绝对跳转、双 Cookie、伪 cookie name、超长 header；Token 出现在异常/日志时令测试失败；旧 Cookie 跨端口、跨 runtime、跨 authority 复用必须失败。

**Definition of Done**

Token 只出现在 HRS→Bridge 的一次性私有对象和单次认证 URL；成功后 RPC/WS 均不含 Token；Cookie 仅驻留 Utility 内存并绑定唯一 runtime authority。

### BRG-003：官方 unary HTTP transport

**行为**

实现 `ClientTransportHooks.fetch`，让官方生成的 unary endpoint 继续使用官方 codec 与调用路径，同时由 Utility 注入 Cookie、Origin、deadline 和审计。adapter 只接受官方 Connection 生成的 `/api/...` POST，不向上游或 Renderer暴露通用 fetch。

**实现步骤**

1. 在应用官方 Connection plugin 前设置 `globalThis.__DSH_TRANSPORT__ = { fetch, openStream }`。
2. 解析传入 URL；允许虚拟 `http://dsh.internal` 或精确 origin，但只取经白名单验证的 pathname。
3. 拒绝非 `POST`、非 `/api/`、userinfo/query/fragment、跨 authority 和未知 content type；把 URL 重写为固定 runtime origin。
4. 合并调用 AbortSignal 与 Desktop deadline，注入 `Cookie`、精确 `Origin` 和 correlation header；禁止调用方覆盖 Host/Cookie/Origin。
5. 使用 `redirect: "error"` 和 no-store 语义发送，限制响应 header/body；把 Response 原样交回官方 Connection codec 解析，carrier 故障在外围记录。

**接口或消息**

`AuthenticatedRpcFetch.fetch(input: URL|RequestInfo, init?: RequestInit): Promise<Response>`；Renderer 只能经 `request.operation` 触发 command table，不能传 URL、method 或 header。

**状态机**

每个 unary：`QUEUED → DISPATCHING → HEADERS → DECODING → SETTLED`；本地取消可从非终态进入 `WAIT_ABORTED`，但远端副作用的最终状态可能是 `OUTCOME_UNKNOWN`。

**限额**

默认 30 秒、最长 5 分钟；并发 pending 64、写命令 8；响应 header 64 KiB；普通 JSON 响应 8 MiB。附件不经这个普通 body 限额/Renderer IPC，而走受控附件通道。官方 Host 的 300 MiB 上限不是允许页面发送大对象的理由。

**错误与恢复**

DNS/代理不应参与 `127.0.0.1`；连接拒绝、ECONNRESET、超时属于 carrier error。401 使 credential 失效并要求 runtime 重建；403 视为 trust/authority 配置损坏；5xx 不通用重试。只有命令元数据声明幂等且尚未写出 body 时才允许一次受控重试。

**安全**

删除 `authorization`、`proxy-authorization`、`referer` 等非必要 header；拒绝 CRLF；不记录 request/response body；错误日志不带 Cookie、Token、Prompt、Tool body 或 credentials。

**测试**

与真实 Host 的每类 unary smoke；恶意 URL/method/header fuzz；deadline 与 Abort 竞态；响应过大；401/403/5xx；非幂等 prompt 在断线点前后均不自动重发；官方 codec 拒绝畸形响应。

**Definition of Done**

所有官方 unary 调用通过同一受控 fetch；不存在 Renderer→网络或通用 URL 路径；官方 codec 仍是 wire payload 的最终解析者；取消、超时和 outcome unknown 可区分。

### BRG-004：官方 multiplex stream transport

**行为**

实现 `ClientTransportHooks.openStream(endpoint, payload, signal)`，通过一个带 Cookie/Origin 的 Node `ws` 连接 `/api/remote.mux`，返回官方 Client 需要的已解码 `AsyncIterable<unknown>`。同一物理 socket 复用 logical stream id，支持 open/item/end/error/cancel，并把 owner 绑定到 generation。

**实现步骤**

1. Phase 0 从固定上游 protocol source 生成 `mux-wire.generated.ts`，记录 commit、source SHA 和 MIT notice。
2. 使用 `ws` 建立 `ws://127.0.0.1:<port>/api/remote.mux`，显式设置 `Cookie` 与 `Origin`；拒绝 redirect、extension 和跨 authority upgrade。
3. 复用固定上游 `REMOTE_STREAM_MUX_PATH` 和 server-message parser 语义；所有 inbound text 在分派前完成长度和 Schema 校验。
4. 建立 `Map<streamId, StreamOwner>`；open 注册后才能发帧，item 只进入对应 single-consumer queue，end/error/cancel 恰好结算一次。
5. socket close/error 时原子终止当前 generation 全部流；由官方 Connection loop 决定重连节奏，Bridge 不启动平行 socket retry timer。
6. 所有 stream AbortSignal、subscription dispose 和 Bridge dispose 都发送/执行有界 cancel，再释放本地 owner。

**接口或消息**

`openStream(endpoint: string, payload: unknown, signal: AbortSignal): AsyncIterable<unknown>`。内部 frame 只能使用上游生成的 discriminated union；Renderer 看不到 stream id 和 mux frame，只看到 `snapshot/patch/state`。

**状态机**

物理 socket：`CLOSED → CONNECTING → OPEN → CLOSING → CLOSED`。logical stream：`ALLOCATED → OPEN_SENT → ACTIVE → END|REMOTE_ERROR|CANCELLED|CARRIER_LOST`。跨 generation stream id 不复用。

**限额**

每 Bridge 一个活动物理 mux；最多 128 logical streams；每流 inbound queue soft 1 MiB、hard 2 MiB；单 wire frame 1 MiB；open payload 256 KiB；close handshake 2 秒。Host 侧当前 heartbeat 默认 2,000ms、最多漏 2 次，本模块据 socket/generation 结果响应，不另造不兼容 ping 协议。

**错误与恢复**

parser/schema 错误使整个物理 generation 不可信并关闭 socket；未知 stream id 计数且忽略，超过 3 次/分钟触发协议不兼容；单个 Remote stream error 只结算该 logical stream；carrier lost 交给官方 Connection 重开 generation。

**安全**

不启用 `perMessageDeflate`；不接受二进制或跨 origin redirect；禁止从 Renderer 指定 endpoint/stream id/header；Cookie 仅在 upgrade header 中使用且被 redactor 注册。

**测试**

用固定 server fixture 覆盖 open/item/end/error/cancel、乱序、重复终态、未知 id、畸形 JSON、超大帧、半开和 128 流压力；真实 Host 验证 Cookie/Origin；与上游 `stream-protocol` 测试向量做差分。

**Definition of Done**

一个物理 WS 可稳定承载全部官方 logical stream；每个流有 owner、AbortSignal 和唯一终态；断线无队列泄漏；生产 Bundle 无私有 `src/*` import，protocol 生成物可追溯到固定 commit。

### BRG-005：官方 Cordis、Client、Controller 与 Projection 装配

**行为**

Utility 建立唯一 Cordis `Context`，按上游声明的 inject 依赖拓扑装配 Registry、Connection、Gateway、Remotes、Session Controller、Workspace Controller 和 Conversation Projection。Main/Renderer 不持有这些对象。任何必需 contribution 装配失败都整体回滚，不能发布半可用 Ready。

**实现步骤**

1. 静态 import 固定 client entry；禁止在生产读取 Host 返回的任意 client bundle。
2. 先安装 transport hooks，再创建 Cordis Context 和 typert registry。
3. 根据每个官方 package manifest 的 `dsh.client.inject` 构建并在测试中拓扑排序；固定版本生成 `apply-order.ts` 快照。
4. 依次应用 Connection、Gateway、Remotes、Session/Workspace Controller；Conversation Projection 采用 `09` 选定的官方 headless export 或版本化 adapter。
5. 为每一步登记 disposer；等待 Cordis Loader settle、官方 connection generation、Workspace baseline、Session catalog、Capability baseline。
6. 将官方 service 放入 Utility 私有 `ControllerRegistry`，只由 command/mapper 调用。

**接口或消息**

内部 `createOfficialClient(input): Promise<OfficialClientRuntime>`，返回 `context`、`connection`、`sessions`、`workspaces`、`projectionFactory`、`dispose`；该类型不得进入 `desktop-contracts`。

**状态机**

`EMPTY → CONTEXT_CREATED → CORE_APPLIED → REMOTES_MOUNTED → CONTROLLERS_MOUNTED → SETTLING → READY`。任意阶段失败进入 `ROLLING_BACK → DISPOSED`；不允许从失败实例继续补装。

**限额**

一个 Bridge 一个 root Context；初始化总 deadline 30 秒；每一步单独记录不含业务数据的耗时；禁止动态 contribution 数量无界增长，固定 manifest 之外的 UI contribution 不挂载。

**错误与恢复**

缺 package/export、inject cycle、Loader rejection、服务缺失、projection adapter 不匹配分别映射 compat/init 错误。恢复通过销毁整个 official runtime 并创建新 generation，不在污染的 Context 上局部重试。

**安全**

不设置 `ownsHost: true`，除非未来实现真正由页面拥有 Host 的模式；当前本机能力由受管 loopback 与 Desktop policy 判定。Dynamic Cordis 可以因 `api-remotes` 依赖存在于 Utility，但 `getClientCode/invoke` 无 Renderer route 且不执行返回代码。

**测试**

应用顺序 golden；随机注入每一步失败并验证逆序释放；缺失 contribution；Loader 超时；重复创建/销毁 20 次；import graph 证明官方对象未越界；真实 Host 端到端创建 Context 并取得官方 generation。

**Definition of Done**

官方 Client/Controller/Projection 全部只在 Utility；装配顺序可由源码和 manifest 解释；Ready 前所有必需服务和 baseline 均存在；partial init 无 listener/socket/timer 泄漏。

### BRG-006：版本化官方兼容层

**行为**

`harness-compat` 是唯一把官方类型/事件/错误/投影转换成 Desktop DTO 的位置。每个 adapter 精确绑定一个 Release Set，未知 discriminant、缺失必需字段或未分类方法默认 fail closed，不以 `as any` 继续运行。

**实现步骤**

1. 为 `dsh-0.1.2-alpha.4` 建立版本目录和 `CompatFingerprint`。
2. 把官方 method descriptor、event allowlist、codec descriptor、公开 export、mux protocol SHA、projection fixture 写入机器可读 manifest。
3. 每个领域建立显式 `fromOfficial/toOfficial` mapper；映射时重新验证 Desktop Schema，不把 class、Map、Set、Error、Signal 或 function 跨 Port。
4. 建立 operation table：Desktop operation → 官方 service/method → idempotency/cancel/deadline/capability。
5. 对没有稳定公开入口的 mux/projection 走已批准的生成物；GA 不允许运行时私有 import。
6. 对所有未知 union 产生 `COMPAT_UNSUPPORTED_VARIANT`，隔离当前领域并记录 fingerprint。

**接口或消息**

`HarnessCompatAdapter` 至少提供 `fingerprint`、`createTransport`、`mapError`、`mapCapabilities`、`mapWorkspace`、`mapSession`、`createConversationProjection`、`operationTable`。

**状态机**

`UNVERIFIED → FINGERPRINT_MATCHED → CONTRACT_PROBED → COMPATIBLE`；任意硬差异进入 `INCOMPATIBLE`。一个运行实例不能在两套 adapter 之间热切换。

**限额**

每个 Release Set 恰好一个 adapter；fingerprint manifest 最大 1 MiB；未知 variant 阈值为 1（立即停用受影响 capability）；不允许“最佳努力”透传未知字段。

**错误与恢复**

Fingerprint mismatch 在发起业务命令前阻断。非关键新增可在新 adapter 中明确标记 ignored；必需能力缺失进入 Recovery 页面并提供版本信息。恢复只能安装匹配 Release Set 或发布新的 compat adapter。

**安全**

mapper 默认丢弃绝对路径、stack、headers、body、Secret、可执行代码和原型；输出创建为 plain data，并经 structured-clone/Schema 检查。生成物保留许可证和供应链 provenance。

**测试**

每个 mapper 正反例、unknown variant、prototype pollution、深度/大小 fuzz；官方 fixture 与 Desktop golden；Bundle 私有导入扫描；Release Set 改一字节必须阻断。

**Definition of Done**

所有跨进程官方值都有显式 mapper；没有 raw official object 和 `any` escape；当前 adapter 有完整 fingerprint、测试证据与许可证归属；不匹配版本不能进入 Ready。

### BRG-007：单一连接状态与 generation

**行为**

Bridge 将官方 Connection 状态、物理 mux 状态、领域 baseline 状态汇聚为唯一 `BridgeStateDto`。官方 `$events` ready 是 generation 真源；新 generation 开始前停止发布旧 Patch，Ready 只由 readiness barrier 统一决定。

**实现步骤**

1. 订阅 `ctx.connection.state` 与 `generation`，为每个官方 ready 分配 Desktop `connectionGeneration`。
2. generation 变化时先关闭旧领域 producer，标记所有旧 request/subscription owner。
3. 新建 generation scope，重开 Workspace/Session/control/follow 并等待基线。
4. 原子发布新 Capability + Snapshot，再把状态切到 Ready。
5. 所有出站帧添加 bridge/runtime/port/generation/sequence；消费者回执也必须匹配当前代次。

**接口或消息**

`BridgeStateDto { phase, bridgeInstanceId, runtimeInstanceId, connectionGeneration, stale, blockingReason?, retry? }`；Main 接收简化 `bridge.phase`，Renderer 接收完整 `state`。

**状态机**

官方状态映射为 `CONNECTING → SYNCING_BASELINES → READY ↔ DEGRADED → DISCONNECTED`。`generation=N` 只能进入 `N+1`，不能回退；Runtime 变化时必须先清空 generation。

**限额**

状态事件合并窗口 16ms；同一 phase 重复值不发送；generation 计数使用 safe integer，Bridge 重启时由新 `bridgeInstanceId` 分隔；baseline 总等待 30 秒。

**错误与恢复**

非法迁移、generation 回退、旧 scope 发帧都记 `BRIDGE_STATE_INVARIANT` 并停止相关 producer。baseline 超时进入 Degraded/Recovery，不把进程存活误报为 Ready。

**安全**

状态 DTO 只包含枚举、时间和随机实例 id，不包含 origin、port、Cookie、Token、Host home 或绝对路径。

**测试**

状态机 model-based test；旧代迟到帧；快速断开/重连；baseline 半成功；Renderer reload 不改变 generation；Bridge restart 改 instance；1,000 次随机迁移无非法 Ready。

**Definition of Done**

应用只有一个可观察连接真相；每帧可判定所属代次；旧 generation 永远不能覆盖新状态；`READY` 可由明确 barrier 证据解释。

### BRG-008：自动有界重连

**行为**

临时 carrier 故障时复用官方 Connection controller 的自动恢复：500ms、1s、2s、4s、8s、10s cap，并使用官方 50%–100% jitter。Bridge 不给 mux 增加第二套 backoff；10s 档失败后等待显式恢复或 Runtime Supervisor 重建。

**实现步骤**

1. 将 socket/end/malformed ready 交给官方 generation source，使当前 generation 失效。
2. 监听官方 `connecting/connected/disconnected` 并投影，不自行 schedule 相同连接。
3. 每次 generation 失效冻结写 capability，把已确认快照标记 stale。
4. 分类 pending command：未 dispatch 可安全取消；已 dispatch 的非幂等命令结算 outcome unknown；只读请求可在新 generation 由调用方重取。
5. 新 generation Ready 后按 `BRG-009` 全量同步，不沿用旧 listener 或 cursor 假定。
6. 用户显式“重新连接”调用官方 `ctx.connection.reconnect()`，不直接 new 第二个 socket。

**接口或消息**

`state.retry { attempt, earliestRetryAt?, terminal }`；命令结果可为 `OUTCOME_UNKNOWN` 并携带安全恢复动作 `RESYNC_DOMAIN`，不提供“自动重发”按钮。

**状态机**

`READY → DEGRADED → CONNECTING(attempt 1..terminal) → SYNCING → READY`；末档失败进入 `DISCONNECTED`。Runtime process exit 则离开本状态机，交 HRS 更换 runtimeInstanceId。

**限额**

重连节奏完全采用固定上游默认；不允许通过 Renderer 配置。显式 reconnect 节流 1 次/5 秒；stale snapshot 最长保留 10 分钟或直到用户退出，期间写操作关闭。

**错误与恢复**

认证 401 不走同 Cookie 重连，直接 invalidate 并要求新 Runtime；403 视为 trust failure；protocol mismatch 进入 compat blocked；纯 carrier 故障才进入官方 backoff。

**安全**

重连不重新输出 Token、不降低 Host/Origin 校验、不切换到用户地址、不为“可用性”关闭证书/Schema/版本检查。

**测试**

fake clock 精确验证六档 cap 与 jitter 区间；物理 mux 只有一个连接尝试源；每个 dispatch 阶段断线；401/403 不循环；显式 reconnect 节流；恢复后 listener 数不增长。

**Definition of Done**

临时故障可有界恢复且没有 retry storm；末档失败可见；非幂等命令不重复；恢复后的状态来自新 baseline 而不是旧缓存猜测。

### BRG-009：baseline、follow 与 gap repair

**行为**

Bridge 使用官方 Workspace/Session Controller 的 baseline 和流语义构建领域状态。Session event stream 遵循官方“先打开 follow，再取 page”的竞态规避；control 每 generation 接受完整 baseline；序列缺口使用官方 tail page 修补。全域必需 baseline 安装完成前不发布 Ready。

**实现步骤**

1. 新 generation 创建 Workspace follow、Session list/control 以及当前活跃 Session follow owner。
2. Workspace 首个完整 snapshot 原子替换本地模型，再应用 upsert/remove/order/archive。
3. Session 打开时调用官方 Session Client，让其处理 follow-before-page、replace/prepend/append 和 reconnect gap repair；不直接读 JSONL。
4. `loadOlder()` 保留官方 50 条一页，`loadThrough(seq)` 保留 200/页语义，Bridge 只映射结果。
5. control 新 generation 全量替换 queue/jobs/projections；禁止把旧控制状态 merge 到新 baseline。
6. Conversation Projection 在 Utility 消费 Controller 状态并生成 Desktop Snapshot/Patch。
7. 为每域维护连续 Desktop revision；发现缺口时暂停 Patch 并发 `resync-required`。

**接口或消息**

- Topics：`workspace.list`、`session.list`、`session.control:<id>`、`conversation:<id>`、`capabilities`。
- 输出：`snapshot(revision)`、`patch(baseRevision, revision)`。
- 输入：`resync(subscriptionId, reason)`、领域分页 command。

**状态机**

每订阅：`NEW → OPENING_FOLLOW → LOADING_BASELINE → LIVE → GAP_REPAIR → LIVE`；无法修补进入 `RESYNC_REQUIRED`；dispose 进入 `CLOSED`。

**限额**

单 Session history snapshot 32 MiB；超出后只交付窗口化页面与 cursor。active Session 实时，background 受 `BRG-013` 限制。gap repair 最多连续 3 页/轮，仍有缺口则全量 resync。

**错误与恢复**

page 与 follow 竞态由官方 Client 处理；Bridge mapper 异常只隔离该 Session。未知 seq、baseline 超时或 revision gap 不应用部分状态；重新订阅并取得 Snapshot。单 Session 损坏不使其他 Workspace 下线。

**安全**

Snapshot/Patch 在发送前移除 Host home、绝对路径、raw tool secrets 和未批准字段；Session id 经 Schema 校验，不能转成文件路径。

**测试**

follow/page 交错、prepend/append/replace、断线 gap、control replacement、Workspace reorder/remove；50/200 页边界；断点注入验证不丢不重；同一 fixture 重放结果确定。

**Definition of Done**

Ready 前所有必需 baseline 完整；重连后状态与官方当前快照一致；revision 连续、缺口必定 resync；Bridge 从不解析持久化 JSONL。

### BRG-010：慢消费者流控

**行为**

每个 Renderer subscription 使用 credit/ack 和有界队列。消费者冻结时，Bridge 合并可重建的 text/reasoning/progress Patch；result、终态、error、Interaction open/close 不丢。达到硬水位则要求 Snapshot resync，而不是继续占用内存。

**实现步骤**

1. subscribe 时发初始 credit 窗口和 Snapshot；每个 frame 记录 sequence/size。
2. Renderer 原子应用后回 `ack(throughSequence, credit)`；Bridge 只释放连续已确认帧。
3. 为 Patch type 定义显式 coalescer：同 node 的 replace/text delta 可合并，结构新增/删除按 revision 顺序保留。
4. soft watermark 暂停 background producer 并合并；hard watermark 丢弃仅可由 Snapshot 重建的旧增量，发 `resync-required`。
5. 不可丢终态进入独立小型 priority queue；若该队列也超限，关闭 Port 并让新页面重建。

**接口或消息**

`ack`、`resync`、`resync-required`；内部 `SubscriptionQueue.enqueue(frame, priority)`、`coalesce(key)`、`ackThrough(seq)`。

**状态机**

`FLOWING → SOFT_PRESSURE → COALESCING → FLOWING`，或 `SOFT_PRESSURE → HARD_PRESSURE → AWAITING_RESYNC → FLOWING`；Port close 进入 `DISPOSED`。

**限额**

沿用 5.4：单订阅 2/4 MiB 水位、全局 16 MiB、32 个 active subscription。初始 credit 64 帧，ack 最迟 1 秒；priority queue 最多 256 帧/1 MiB。

**错误与恢复**

ack 回退、越过最后发送 sequence、未知 subscription 都是协议错误；连续 3 次关闭该 Port。resync 超时 10 秒关闭订阅，不影响官方 Controller。

**安全**

队列中的数据同样执行 DTO 限额与 redaction；不因为背压把内容临时写磁盘；诊断只记 byte/frame 计数，不记 payload。

**测试**

5,000 events/s；冻结 Renderer 60 秒；ack 乱序/重复/越界；coalesce 与完整重放差分；Interaction 在压力下不丢；硬水位后内存封顶并成功 Snapshot 恢复。

**Definition of Done**

慢页面不能拖垮 Utility/Harness；队列有精确硬上限；可丢与不可丢分类有测试；任意降级最终都能通过 Snapshot 得到正确状态。

### BRG-011：请求、订阅与业务取消分离

**行为**

`cancel-request` 只停止本地等待与允许传播的 transport Abort；`unsubscribe` 只释放观察流；“停止当前 Agent/Turn”必须调用显式 Session `cancel` 领域命令。这三者在 UI 文案、协议、审计和错误码上不得混同。

**实现步骤**

1. command table 为每个 operation 声明 `idempotency`、`abortSemantics`、`businessCancelOperation` 和 deadline。
2. 每个 request 建立 AbortController；Renderer cancel/deadline/Port close 触发本地 abort。
3. 对已发送的写命令，本地 abort 返回 `WAIT_CANCELLED` 或 `OUTCOME_UNKNOWN`，不得宣称 Harness 工作已停止。
4. unsubscribe 调用 logical stream disposer 和 projection owner，不调用 Session `cancel`。
5. `session.cancelTurn` 经单独确认策略映射到官方 Session `cancel`。
6. shutdown 时先拒绝新写请求，再 abort wait、unsubscribe，最后 dispose client。

**接口或消息**

`cancel-request { requestId, reason }`、`unsubscribe { subscriptionId }`、领域 operation `session.cancelTurn`；结果枚举 `CANCELLED_BEFORE_DISPATCH`、`WAIT_CANCELLED`、`OUTCOME_UNKNOWN`、`BUSINESS_CANCEL_ACCEPTED`。

**状态机**

request：`QUEUED → DISPATCHED → SETTLED`；`QUEUED → CANCELLED_BEFORE_DISPATCH`；`DISPATCHED → WAIT_CANCELLED/OUTCOME_UNKNOWN`。subscription：`ACTIVE → UNSUBSCRIBING → CLOSED`。业务运行由 Session control 状态机独立确认。

**限额**

同 requestId 的 cancel 幂等；business cancel 每 Session single-flight；unsubscribe 本地完成上限 2 秒；abort listener 每 request 恰好一个且结算后移除。

**错误与恢复**

迟到 result 不重新打开已取消的 request，但可触发领域 resync。Session cancel 失败后以 control baseline 为真；断线中的 cancel outcome unknown，不自动重发。

**安全**

request/subscription owner 绑定当前 Port、generation 和 Session scope；一个页面不能取消另一 Port 或另一 Session 的操作；错误不泄露原始 official args。

**测试**

排队前、写 body 前、写 body 后、收到响应前的取消；unsubscribe 与 stream end 竞态；Port close；重复 cancel；业务 cancel 后 control 未改变；late result；owner 越权。

**Definition of Done**

三类取消具有不同消息、状态和测试；页面不会因关闭订阅误停 Agent，也不会因取消等待误报远端已取消；所有 Abort listener 可回收。

### BRG-012：稳定错误与恢复动作

**行为**

Bridge 把官方 `RemoteError(code,message,details)`、HTTP carrier、WS carrier、认证、Schema、取消、compat 和 outcome unknown 映射为版本化 `DesktopErrorDto`。用户看到稳定 messageKey/action，开发诊断看到 supportCode 和脱敏上下文。

**实现步骤**

1. 建立穷尽的 `error-map.ts`，保留内部 `upstreamCode`，但只输出批准的 Desktop code。
2. 对 official `details` 使用 code-specific allowlist，不做通用对象透传。
3. carrier 错误按 phase 分类；AbortError 根据 request 状态映射；未知写结果单独映射。
4. Redactor 在 logger、result、crash fault 三个出口共同运行，并对 Token/Cookie/path/Prompt/credential 做 canary test。
5. 为每个 Desktop code 配置 `retryable`、`userAction`、`scope`、`messageKey`；禁止 UI 根据 message 字符串猜恢复。

**接口或消息**

`DesktopErrorDto { code, messageKey, severity, scope, retryable, userActions, supportCode, safeDetails? }`。`cause/stack/headers/rawBody/upstreamArgs` 永不跨 Port。

**状态机**

错误自身为终态值；恢复由 scope 决定：`REQUEST` 可重新执行安全读；`SUBSCRIPTION` resync；`GENERATION` reconnect；`RUNTIME` restart；`COMPAT` 安装匹配版本。

**限额**

messageKey 128 字符、supportCode 64、安全 details 8 KiB/深度 8/数组 50；错误链最多检查 8 层；未知 code 输出统一安全码但内部计数并触发升级门禁。

**错误与恢复**

Normalizer 自身失败必须退化为 `INTERNAL_ERROR`，仍经过最小 redaction。未知官方 code 不直接显示 message/details；连续未知 code 将 Capability 置为 degraded 并要求诊断。

**安全**

默认 deny details；不输出 stack、Host header、Cookie、Token、响应 body、用户 Prompt、Tool input/output、环境变量或个人绝对路径。supportCode 使用随机/哈希关联，不编码 PII。

**测试**

官方所有已知 Remote code 映射；未知 code；循环 cause；恶意 details/prototype；Secret canary；Windows/POSIX path；巨大错误；i18n key snapshot；恢复 action 与 scope 一致。

**Definition of Done**

每个 P0/P1 失败路径都有稳定错误和可执行恢复动作；边界上没有 raw Error；Secret/path/content redaction 负向测试全绿；未知错误不会静默冒充已知语义。

### BRG-013：多 Session 订阅资源池

**行为**

Bridge 按 active、background、sleep 三档管理 Session follow/control/projection。当前 Session 保持实时；有限数量后台 Session 保留轻量状态；更旧 Session 保存恢复 cursor 后释放。切回时先显示已确认 Snapshot，再验证新 generation/官方状态。

**实现步骤**

1. `SessionSubscriptionPool` 以 `sessionId + generation` 为 key，owner 包含 follow/control/projection/consumers。
2. active Session 获得实时 priority；最近 4 个 background Session 保持轻量 follow，最多 16 个保留内存 Snapshot；其余进入 sleep。
3. LRU 淘汰前记录安全 cursor/revision 元数据，dispose 所有官方 listener/stream/worker。
4. 切回 sleep Session 时新建 owner、获取 baseline/gap repair，再切到 live。
5. Session removed、Workspace removed、generation end、Port 无消费者时立即清理相应 owner。

**接口或消息**

内部 `acquire(sessionId, consumerId)`、`setActive(sessionId)`、`release(lease)`、`evict(reason)`；Renderer 仍只用 subscribe/unsubscribe。

**状态机**

`COLD → OPENING → ACTIVE ↔ BACKGROUND → SLEEPING → COLD`；generation end 从任意活动态到 `DISPOSING → COLD`。

**限额**

1 个 active、4 个 live background、16 个 resident snapshots、最多 32 页面订阅；内存预算由全局 16 MiB 出站之外单独设定为 128 MiB projection cache，达到预算按 LRU 提前淘汰。

**错误与恢复**

单 Session 打开失败只关闭该 owner；切换竞态以最后 active intent 为准；旧 owner 的迟到 Patch 因 generation/session epoch 被拒绝。cursor 无效则全量 baseline。

**安全**

LRU key 只用 opaque Session id；不把 cwd/path 用作缓存文件名；V1 projection cache 仅内存，不把对话内容落入自建磁盘缓存。

**测试**

50/100 Session 快速切换；删除正在打开的 Session；generation 切换；Renderer reload；GC/leak snapshot；内存压力 LRU；迟到 producer；切回后与完整重放一致。

**Definition of Done**

多 Session 使用量有硬上限；淘汰和恢复不丢官方状态；单 Session 故障隔离；20 次 Bridge/Renderer 生命周期后 listener、stream 和 heap 不线性增长。

### BRG-014：Capability Snapshot

**行为**

UI 能力由“固定 compat 支持 × 当前官方 method/event/catalog × connection phase × 本地安全/产品策略”求交集生成。缺失或未知默认 false。跨 generation 时 Capability 与第一批 Snapshot 原子切换，页面不靠版本号或错误尝试猜能力。

**实现步骤**

1. 为每个按钮/操作定义稳定 capability id，并关联 operation table。
2. 在 Client 装配后读取已挂载 method descriptor、catalog 与 loopback事实；再应用 Desktop policy。
3. 生成 `CapabilitySnapshotDto`，包含 revision、generation、布尔支持、必要 limits/reason。
4. provider、model、command、preset、settings 或插件 inventory 更新时重新计算。
5. capability 降级时取消尚未 dispatch 的相关命令；已 dispatch 命令按真实结果结算。

**接口或消息**

Topic `capabilities`；`CapabilitySnapshotDto { revision, generation, capabilities: Record<CapabilityId, CapabilityStateDto> }`。状态为 `enabled/disabled/temporarilyUnavailable`，原因是固定枚举。

**状态机**

`UNKNOWN → COMPUTING → PUBLISHED`；generation 结束进入 `STALE`；新 generation `COMPUTING → PUBLISHED`。不存在默认 enabled。

**限额**

Capability 数量最多 512；Snapshot 256 KiB；更新合并 50ms；每秒最多发布 10 次，最终状态必须发布。

**错误与恢复**

descriptor/mapper 失败使相关 capability disabled，并产生 compat 诊断；不使无关只读能力全部消失。必需 P0 capability 缺失则 readiness barrier 不放行。

**安全**

绝不把 Dynamic Cordis `invoke/getClientCode`、官方 DirectoryPicker 或任意网络/文件能力标记给 Renderer。credential capability 只表示可执行 set/unset，不包含值。

**测试**

方法缺失/新增、事件缺失、provider 更新、断线、跨 generation、策略关闭、未知 capability；每个 UI 条件引用存在的 id；快照原子性和限额。

**Definition of Done**

页面所有条件功能都由 capability 驱动；缺失能力安全关闭且有原因；危险官方入口永不出现在 Snapshot；跨代无短暂错误启用。

### BRG-015：可审计关联

**行为**

所有领域命令、transport 请求、logical stream、Session 和 Interaction 通过不含 PII 的 id 关联。审计记录“谁在何代请求了什么类别、结果与耗时”，默认不记录 Prompt、Tool body、Conversation 文本、Secret 或绝对路径。

**实现步骤**

1. 入口接收/生成 `requestId` 和 `correlationId`，验证随机 id 格式、长度与当前 Port owner。
2. operation table 生成 `operationClass`；transport 生成内部 rpc/stream id；建立短期关联表。
3. 每次状态变化发结构化 audit record，通过 redactor 后进入诊断 sink。
4. Interaction 沿用 eventId 的哈希化关联，Session id 只在内存关联；外部 support bundle 使用带安装盐的不可逆短标签。
5. 请求结算/TTL 到期立即释放关联表。

**接口或消息**

`AuditRecord { at, bridgeInstanceId, generation, correlationId, operationClass, phase, durationMs?, outcomeCode?, byteCounts? }`；没有 payload 字段。

**状态机**

关联项 `CREATED → DISPATCHED → SETTLED → EXPIRED`；stream `OPEN → ACTIVE → CLOSED → EXPIRED`。重复终态只计 invariant，不生成第二业务结论。

**限额**

活动关联最多 1,024；settled 内存保留 10 分钟；单 record 4 KiB；日志速率 200 条/秒，超限按类别聚合计数；Interaction 审计不记录回答正文。

**错误与恢复**

审计 sink 失败不能阻断业务；转为内存计数并报告 observability degraded。关联表超限时拒绝新非关键诊断，不能丢失 command result。

**安全**

禁止 Prompt、Tool input/output、Cookie、Token、credential、response body、完整路径和稳定跨安装用户标识。开发模式也必须显式 opt-in 才能采集内容，生产包默认无该开关。

**测试**

端到端 request→RPC→result 关联；多 Session 并发；重复 id/伪造 owner；redaction canary；速率限制；sink 故障；support bundle secret scan。

**Definition of Done**

一个支持码能还原阶段、代次和错误类别而不暴露用户内容；活动关联有界且可释放；审计故障不改变业务结果。

### BRG-016：安全停止与重建

**行为**

Bridge 使用单一 Disposal Registry 逆序停止：拒绝新写 → 结算/标记 pending → 回答或关闭 Interaction → 停领域 producer → dispose Projection/Controller → stop Connection/mux → 清 Cookie/transport → 关闭 Port → 报 `bridge.drained`。重复 dispose 必须幂等。

**实现步骤**

1. 每创建一个 listener/timer/socket/stream/context 就立即向 scope 注册 disposer。
2. `prepare-shutdown` 将 phase 设为 disposing，关闭 command admission，给 Renderer 发最终 state。
3. 在 deadline 内排空已完成 result；未确认写命令标 outcome unknown；pending waterfall 采用上游允许的 fail-closed 结果。
4. 子 scope 按创建逆序 dispose，并等待有上限的 Promise。
5. 清除 transport global、MemoryCredential 引用和关联表，关闭 Port，向 Main 回 drained。
6. partial init 也走同一 registry；超时由 Main 终止 Utility。

**接口或消息**

`bridge.prepare-shutdown { deadlineAt }`、`bridge.dispose`、`bridge.drained`；内部 `DisposalRegistry.add(name, dispose)`、`disposeAll(deadline)`。

**状态机**

`RUNNING → DRAINING → DISPOSING → STOPPED`；任何态调用 dispose 都收敛到同一个 Promise。超时为 `DISPOSE_TIMEOUT`，但本地状态仍标 STOPPED 并允许 Main kill。

**限额**

Bridge 自身优雅排空预算 4 秒，为 Main/Harness 的 5 秒边界预留余量；单 disposer 1 秒；最多 1,024 disposer；所有 timer 在停止后为零。

**错误与恢复**

某 disposer 抛错被聚合、脱敏并继续后续清理；socket close 超时直接 terminate 自有 socket；不得杀非自身 PID。Main 若收到 crash 而非 drained，创建全新 Utility/bridgeInstanceId。

**安全**

停止日志不 dump pending payload；Interaction 关闭使用 fail-closed 结果；Cookie/Token 不进入 aggregate error；只释放本 Bridge owner 的资源。

**测试**

每个 init 步骤故障；dispose 两次/并发调用；disposer 抛错/卡死；Port/WS/Context 各阶段强杀；20 次重建 listener/timer/socket 不增长；pending approval/question 在退出时 fail closed。

**Definition of Done**

正常退出在预算内发 drained；异常退出可由 Main 重建；partial init 和 double dispose 无泄漏；没有业务命令在 DRAINING 后开始 dispatch。

### BRG-017：无真实模型或凭据的确定性测试

**行为**

核心 Bridge 测试不依赖真实 LLM Key。Fake transport 重放固定官方 wire/Controller fixture，支持可编程 barrier、fault 和 fake clock；同时保留一组固定版本真实 Harness 合同测试，防止 Fake 自证正确。

**实现步骤**

1. 实现与 `ClientTransportHooks` 同形的 Fake fetch/openStream，所有响应先经过官方 codec。
2. 记录/手工审查来自固定上游测试的非敏感 fixture，manifest 含 source commit/SHA/schema version。
3. fault DSL 支持 before-dispatch、after-write、before-response、stream gap、duplicate、malformed、disconnect、slow consumer。
4. fake clock 驱动 backoff/deadline/LRU，barrier 精确控制竞态。
5. CI 分层运行 unit/contract/fault；Windows job 运行无 Key 的真实 `dsh --profile web` smoke。
6. fixture 更新必须经过差分 review 和 Secret/路径扫描。

**接口或消息**

测试接口 `BridgeScenario { initial, steps, expectedFrames, expectedAudit }`；Fake 只存在于 test export，生产 Bundle 扫描禁止 fixture/fault DSL。

**状态机**

Scenario runner：`ARRANGE → RUN → BARRIER → ASSERT → DISPOSE`；任何测试即使失败也必须执行资源断言。

**限额**

单 fixture 10 MiB、单 scenario 虚拟时钟 10 分钟、默认 5,000 frame；随机测试保存 seed；真实 Host smoke 60 秒超时且不访问外部模型。

**错误与恢复**

fixture 与当前 fingerprint 不匹配时测试直接失败，不能自动升级。真实 Host 不可启动时 CI 标基础设施失败，不把必需合同测试静默 skip。

**安全**

fixture 禁止真实 Prompt、Token、Cookie、Key、用户名和个人路径；生成时替换并扫描；Fake 不开放到生产 feature flag。

**测试**

测试框架自身 mutation test：故意改变 frame/event/error/limit 必须让套件失败；Fake 与真实 Host 对同一 probe 的结果差分；生产 Bundle negative scan。

**Definition of Done**

开发者离线、无 Key 能覆盖所有 P0 Bridge 路径和竞态；真实 Host 合同能发现 Fake 漂移；fixture 可追溯、确定、无 Secret。

### BRG-018：上游升级差分门禁

**行为**

每次 Harness 版本变化先生成差分报告，再决定复用、修改或新增 compat adapter。未分类的 method/event/codec/error/projection/mux/认证差异为零之前，升级不能进入主分支或发布。

**实现步骤**

1. 检出候选 tag/commit，验证签名/来源并生成新的 Release Set。
2. 提取 package versions/exports/inject graph、Remote descriptor、event allowlist、error codes、mux protocol、认证行为、Controller fixture 和 projection golden。
3. 与当前 `CompatFingerprint` 产生 machine-readable 和 reviewer-readable diff。
4. 分类 additive-safe、behavior-change、breaking、security-sensitive；为每项绑定 owner、ADR、mapper/test。
5. 新建版本 adapter 或明确证明可复用；运行 old/new producer-consumer、Fake、真实 Host、官方 Web projection differential。
6. 更新 release manifest、许可证/SBOM、回滚包；灰度验证后才切默认。

**接口或消息**

`CompatDiffReport { from, to, exports, methods, events, codecs, errors, mux, auth, controllers, projection, classification, evidence }`；构建门禁消费报告，不进入运行时 Renderer。

**状态机**

候选版本：`DISCOVERED → FINGERPRINTED → DIFFED → CLASSIFIED → ADAPTER_READY → VERIFIED → APPROVED`；任意未分类项进入 `BLOCKED`。

**限额**

一次升级只跨一个目标 Release Set；未分类差异允许数量 0；P0 differential 失败允许数量 0；报告和 golden 必须保留至少两个已发布版本用于回滚验证。

**错误与恢复**

候选失败不修改当前锁定版本。发现数据/协议不兼容时保留旧发行并建立迁移/回滚 ADR；不能以关闭 Schema、私有 import 或跳过 fixture 作为临时上线办法。

**安全**

特别审查 auth Cookie、Host/Origin、dynamic code、DirectoryPicker、credential、plugin 与新 Remote namespace；依赖/SBOM/许可证/漏洞扫描属于升级必要证据。

**测试**

模拟新增/删除/改名方法、event mode 改变、codec 收紧、未知 error、mux frame 改变、projection 语义改变、auth redirect 改变；确保每种差异都阻断并指向责任人。

**Definition of Done**

升级有可复现 fingerprint、零未分类 diff、新/旧 adapter、真实 Host 与投影差分证据、回滚验证；当前生产版本在候选失败时完全不受影响。

## 8. Approval 与 User Question 的统一交互规则

`approval/request` 和 `user-questions/request` 是上游 waterfall 调用，而不是普通通知。BRG-004/005 建立 Remote event source 后，必须恰好注册一个 Bridge handler：

1. 收到 invocation 后校验 event、context、generation 和安全 DTO mapper。
2. 创建唯一 `interactionId`，发布 `interaction-open`，并保持上游 continuation。
3. 接受当前 Port owner 的一次回答；先写本地终态锁，再调用上游 result/continuation。
4. 上游 cancellation、generation end、Renderer 关闭或 Bridge shutdown 时关闭 Interaction；迟到回答返回 `INTERACTION_CLOSED`。
5. Approval 没有可用 responder 时返回上游允许的 fail-closed 结果，绝不默认允许。当前上游失败语义包括 allowed-once、rejected、unavailable、cancelled 等分类，实际 wire 值以固定 codec 为准。
6. Question 同样遵循 waterfall，只从固定 question schema 构造答案，不传任意对象。

每个 invocation 必须恰好一个终态：answered、rejected/unavailable、cancelled 或 generation-lost。0 次和 2 次回答都属于测试失败。

## 9. 开发任务顺序

任务编号使用 `BRG-Txx`，与功能 ID 分离。

| 顺序 | 任务 | 关联功能 | 产物与退出条件 |
|---:|---|---|---|
| `BRG-T01` | 固定 upstream fingerprint | BRG-006、018 | manifest 能重现 commit/package/export/inject/method/event/error/mux SHA |
| `BRG-T02` | 完成公开 seam 可行性 spike | BRG-003、004、005 | 证明 `fetch/openStream` 可运行；决定公开 factory 或版本化生成物，ADR 批准 |
| `BRG-T03` | 建立 Bridge entry 与 parent handshake | BRG-001、007、016 | 无网络的 Utility 可握手、换 Port、故障和幂等退出 |
| `BRG-T04` | 实现 authority/token/cookie | BRG-002 | 真实 Host 303/Cookie 合同与 secret canary 全绿 |
| `BRG-T05` | 实现 authenticated unary fetch | BRG-003、011、012、015 | 官方 unary smoke、deadline/cancel/error/audit 可用 |
| `BRG-T06` | 实现 authenticated mux | BRG-004、011、016 | logical stream 全协议、owner、压力与断线测试全绿 |
| `BRG-T07` | 确定性装配官方 Context | BRG-005、006 | apply-order golden、Loader readiness、partial rollback |
| `BRG-T08` | 实现 connection/generation barrier | BRG-007、008 | 官方 backoff、旧代隔离、末档 disconnected |
| `BRG-T09` | 接入 Workspace/Session baseline | BRG-009 | follow-before-page、control replacement、gap repair |
| `BRG-T10` | 接入 Conversation Projection | BRG-005、006、009 | `09` 的 headless/adapter gate 和 projection differential |
| `BRG-T11` | 建立 Desktop command/capability/error table | BRG-006、011、012、014 | 无通用 invoke；每个 UI operation 有全套元数据 |
| `BRG-T12` | 建立 subscription flow control | BRG-010、013 | 5k event/s 与冻结 Renderer 下内存有界 |
| `BRG-T13` | 建立 waterfall Interaction | BRG-004、005、011、015 | Approval/Question 恰好一次、断线/退出 fail closed |
| `BRG-T14` | 完成多 Session 池与资源释放 | BRG-013、016 | 50/100 Session、20 次重建、heap/listener 门禁 |
| `BRG-T15` | 建立 Fake/fixture/fault suite | BRG-017 | 无 Key CI 覆盖 P0；Fake/真实 Host 差分 |
| `BRG-T16` | 建立升级差分流水线 | BRG-018 | 模拟 breaking changes 全部能阻断 |
| `BRG-T17` | Electron 全链路验收 | BRG-001..018 | Renderer 零官方包/网络/Secret，启动、恢复、退出证据齐全 |

不得在 `BRG-T02` 尚未证明认证 WS 与 projection seam 可维护时开始大规模页面开发。该门槛若失败，应先推动上游增加公开 transport/projection factory，或由架构评审批准可追溯生成 adapter；不允许在页面层临时复刻官方协议。

## 10. 测试矩阵与证据

| 层级 | 必测内容 | 证据 |
|---|---|---|
| Unit | authority、Cookie parser、operation table、mapper、error、state、LRU、coalescer | 覆盖率、mutation、property seed |
| Contract | Desktop Frame、official codec、mux frame、Remote event、Capability | golden 与正反例报告 |
| Integration/Fake | 初始化、unary、stream、gap、Interaction、backpressure、dispose | scenario trace 与 leak count |
| Real Harness | Token exchange、Cookie/Origin、全部 P0 unary、mux、Controller baseline | 固定 commit 的 Windows CI 日志（脱敏） |
| Differential | Fake vs Real、Desktop vs 官方 Web projection、old vs new adapter | machine-readable diff |
| Fault | Utility crash、Harness crash、Port reload、half-open、timeout、malformed frame | fault matrix |
| Performance | 5k event/s、32 订阅、128 logical streams、50 Session 切换 | p50/p95/p99、heap/queue chart |
| Security | import/bundle、URL/header fuzz、Secret canary、prototype pollution、dynamic Cordis denial | SBOM、scan、negative fixture |

最低故障注入点：

- bootstrap 校验之前与之后；
- Token request 发出之前、写出之后、收到 303 之前；
- unary body 写出之前/之后和 response decode 之前；
- WS upgrade、首帧、活动流、终态和 close；
- Cordis 每个 apply/settle 阶段；
- follow 已开但 page 未完成、page 已完成但增量未应用；
- Patch 已排队但未 ack、hard watermark 后；
- Approval/Question 已打开、回答发送前/后；
- dispose registry 的每个资源类型。

## 11. 模块级 Definition of Done

- `BRG-001..BRG-018` 每一项都完成对应代码、测试、证据和 code owner review。
- 真实 Harness `dsh-v0.1.2-alpha.4` 上 Token→Cookie、unary、mux、generation、Session/Workspace Controller 合同全绿。
- 官方 DSH/Cordis/Controller/Conversation Projection 仅存在于 Utility 依赖图；Renderer、Preload、Main 的 bundle scan 为零。
- 生产路径没有通用 fetch、WebSocket、Remote invoke、Dynamic Cordis client code 或 raw directory picker 暴露。
- 生产 Bundle 没有 `@deepseek-ai/*/src/*` 私有导入；必要 compat 生成物有 commit/SHA/license/差分证据。
- 旧 bridge/runtime/port/generation 的任何消息都不能改变当前页面状态。
- 断线时非幂等命令不自动重放，等待取消和业务取消不混淆。
- 慢 Renderer、50 Session 切换、128 logical streams 和 20 次重建下，内存、listener、timer、socket 均保持在预算内。
- Approval/User Question 每次 invocation 恰好一个 fail-closed 终态，迟到答案无效。
- Token/Cookie/Prompt/Tool body/credential/个人路径不出现在 Port、日志、crash report、fixture 或 support bundle。
- 上游升级流水线能对 method/event/codec/error/mux/auth/projection 任一差异 fail closed。

## 12. 验收清单

### 12.1 架构与依赖

- [ ] Bridge 是唯一官方客户端宿主，Main 和 Renderer 没有官方对象。
- [ ] Cordis、Connection、Gateway、Remotes、Session/Workspace Controller、Conversation Projection 均在 Utility。
- [ ] `ClientTransportHooks.fetch/openStream` 在官方 plugin apply 前安装。
- [ ] Dynamic Cordis、DirectoryPicker、任意 URL/Remote invoke 均无 Renderer route。
- [ ] Release Set、package exports、inject graph 和 compat fingerprint 精确匹配固定上游。

### 12.2 认证与传输

- [ ] origin 只接受精确 `http://127.0.0.1:<port>`。
- [ ] Token exchange 要求 303、`Location: /`、唯一 Host-only Cookie，并禁用 redirect。
- [ ] Token/Cookie 永不进入 Renderer、磁盘、日志或异常。
- [ ] unary 只允许官方生成的 `/api/...` POST，Cookie/Origin 不可由调用方覆盖。
- [ ] 一个认证 mux socket 承载 logical streams；每流有 owner、cancel 和硬容量上限。
- [ ] 协议 parser/常量来自可追溯固定上游，生产无私有 source import。

### 12.3 生命周期与正确性

- [ ] Bridge phase、runtime instance、generation、port epoch、sequence/revision 定义清晰并被 Schema 强制。
- [ ] 只有认证、官方 generation、Workspace/Session/Capability baseline 全部完成才 Ready。
- [ ] 官方 backoff 是唯一重连调度；末档失败明确 disconnected。
- [ ] Workspace baseline/reorder/remove 和 Session follow/page/control/gap repair 全部通过竞态测试。
- [ ] 旧 generation Patch、迟到请求结果和旧 Port 帧不会污染当前状态。
- [ ] partial init、double dispose、Bridge crash 和 Renderer reload 可恢复且无资源增长。

### 12.4 Renderer 合同

- [ ] 页面只见 Desktop operation、DTO、Snapshot、Patch、Capability、Error、Interaction。
- [ ] 没有 raw official type、Error、function、Signal、Map/Set 或绝对路径跨 Port。
- [ ] 每个 operation 声明幂等性、deadline、取消语义、capability 和错误范围。
- [ ] request cancel、unsubscribe、Session business cancel 是三个不同合同。
- [ ] credit/ack、2/4 MiB 水位、coalesce、priority 和 resync 均实现并有压力证据。
- [ ] Capability 缺失默认关闭，跨 generation 原子更新。

### 12.5 安全、测试与升级

- [ ] Approval 和 User Question waterfall 恰好一个 handler、一个终态、默认 fail closed。
- [ ] 错误 details 使用 code-specific allowlist，未知 code 不透传。
- [ ] Audit id 不含 PII，日志默认无 Prompt/Tool/Secret/path。
- [ ] 无 Key Fake 覆盖 P0，且固定版本真实 Host 合同防止 Fake 漂移。
- [ ] 5k event/s、32 订阅、128 logical streams、50/100 Session 和 20 次重建通过预算。
- [ ] 任意上游 method/event/codec/error/mux/auth/projection 未分类差异都会阻断升级。
- [ ] `BRG-001..BRG-018` 的 Definition of Done 均有可下载、可复现的验收证据。
