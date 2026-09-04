# 08：Workspace 与 Session 领域模块

## 1. 文档目标

本文件定义桌面端 Workspace 与 Session 的完整产品行为、跨进程合同、状态所有权和开发验收标准。它不是页面草图，而是实现 `packages/harness-domain` 与对应 Vue 功能时的任务清单和契约依据。

本模块必须坚持以下不可变边界：

- 官方 `@deepseek-ai/dsh-*` Client、Cordis、`ClientWorkspaceModel`、`ClientSessions` 与 Remote 只运行在 Electron Utility Process；
- Renderer 只能通过 Preload 接收本项目定义的 DTO、Snapshot、Patch 和 `DesktopError`；
- Workspace Registry、Session 日志、运行状态、队列和模型选择以 Harness 为唯一真源；
- Renderer 不扫描 Harness Home、不读取 Session JSONL、不推测官方内部状态；
- Unary 成功回执不替代官方 Snapshot/Patch，页面最终状态必须由 Utility 发布的权威状态确认；
- 非幂等写操作若在传输中断时无法确认结果，必须返回 `OUTCOME_UNKNOWN`，禁止自动重放。

## 2. 范围

### 2.1 V1 范围

- Workspace 完整可用生命周期：跟随、创建、选择、重命名、删除注册、排序；
- Workspace 内 Session 排序与 Session 归档；
- 原生目录选择、目录创建与受控打开 Workspace 路径；
- Session 列表、搜索、创建、打开、切换、重命名、Fork、归档；
- 普通 Session 与直接 Subagent Session 地址的统一只读标识；
- 模型目录、Provider 局部失败、模型与 reasoning effort 选择；
- Prompt 的 `queue`、`steer` 模式和 `requestId` 对账；
- Queue 查看、编辑、删除、转 steer；
- 当前 Turn Cancel；
- 图片附件提交、持久化附件读取与受控缓存；
- Composer Skills 和 Session 文件引用查询；
- Session follow/control 的资源申请与释放；
- 冷 Session 恢复、断线重连、generation 切换与错误恢复。

### 2.2 明确非范围

- 不删除 Workspace 目录、目录内文件或 Session 持久化记录；
- 上游当前归档是单向操作，V1 不伪造“取消归档”能力；
- 不建立独立于 Harness 的 Workspace/Session 数据库；
- 不支持 Renderer 提交任意宿主路径；
- 不允许用户连接任意远程 Harness；
- 不在本模块投影消息节点，Conversation 投影见 `09-Conversation投影模块.md`；
- 不在本模块定义 Timeline 与 Composer DOM，界面见 `11-Conversation与Composer界面.md`；
- V1 不实现 Session 物理删除；官方没有该桌面合同，界面不得出现假删除入口。

## 3. 上游依据与依赖

### 3.1 上游能力映射

| 桌面领域 | 官方 Remote / Client 能力 |
|---|---|
| Workspace | `workspace.follow/create/rename/delete/insertBefore/insertSessionBefore/archiveSession` |
| 目录选择 | `directoryPicker.pick/list/createDirectory`，仅在 Host 提供相应 capability 时出现 |
| Session | `session.list/search/create/rename/fork/prompt/updateQueue/cancel` |
| 模型 | `session.modelCatalog/selectModel` |
| 历史和实时 | `session.page/follow/control` |
| 附件 | `session.attachment`；Prompt 图片由 `session.prompt` 提交 |
| Skills | `skills.list` |
| 文件引用 | `fileReferences.list` |
| 原生打开 | `session.canOpenWorkspacePath/openWorkspacePath` |

上游语义以固定提交对应的以下源码为准：

- `deepseek-harness/packages/api/workspace-controller/src/index.ts`；
- `deepseek-harness/packages/api/workspace-controller/src/types.ts`；
- `deepseek-harness/packages/api/session-controller/src/index.ts`；
- `deepseek-harness/packages/api/session-controller/src/types.ts`；
- `deepseek-harness/packages/api/session-controller/src/client/`。

### 3.2 项目依赖

- 前置：公共合同、Electron Main、Preload、Harness Supervisor、Bridge、版本握手；
- 同步开发：Conversation 投影、Vue State Adapter；
- 后置：Conversation/Composer UI、Tool Presenter、Settings、E2E；
- 测试依赖：Fake Harness、真实固定版本 Harness、临时 Harness Home、受控时钟。

## 4. 建议目录

```text
packages/
  desktop-contracts/src/
    workspace.ts
    session.ts
    catalog.ts
    files.ts
    errors.ts
  harness-compat/src/v0_1_2/
    workspace-adapter.ts
    session-adapter.ts
    session-address.ts
    error-map.ts
  harness-domain/src/
    workspace-domain.ts
    session-directory.ts
    session-handle.ts
    session-subscription-pool.ts
    command-fence.ts
    capability-map.ts
  test-fixtures/src/
    workspace-fixtures.ts
    session-fixtures.ts

apps/desktop/src/renderer/features/
  workspaces/
    components/
    composables/
    store.ts
  sessions/
    components/
    composables/
    drafts.ts
```

`harness-compat` 是唯一可以导入官方 Client 包的目录；`apps/desktop/src/renderer` 只能导入 `desktop-contracts` 和纯 UI 包。

## 5. 领域状态与合同

### 5.1 Workspace 状态机

```text
UNINITIALIZED
  → SYNCING
  → READY
  → RESYNCING
  → READY

任意非终态 → FAILED
FAILED → SYNCING（用户重试或新 connection generation）
任意状态 → DISPOSED
```

每次 connection generation 必须先收到完整 baseline，才允许进入 `READY`。上一代的 `upsert/remove/order/archived` 一律丢弃。

### 5.2 Session 视图状态机

```text
CLOSED
  → OPENING
  → HYDRATING
  → READY_IDLE / READY_RUNNING
  → RESYNCING
  → READY_IDLE / READY_RUNNING

OPENING/HYDRATING/RESYNCING → FAILED
READY_* → CLOSING → CLOSED
```

`CLOSED` 只表示桌面端释放了该 Session 的投影和订阅，不表示删除或关闭官方 Session。后台仍运行的 Session 可以在 Sidebar 中显示运行状态，但不必维持完整 Conversation DOM。

### 5.3 写操作状态

```text
IDLE → SUBMITTING → CONFIRMED → IDLE
                  ↘ REJECTED  → IDLE
                  ↘ UNKNOWN   → RECONCILING → CONFIRMED / REJECTED / NEEDS_USER
```

`UNKNOWN` 表示请求可能已被 Harness 接受。创建、Prompt、Fork、Approval 等操作不得自动再次提交。

### 5.4 稳定 DTO

```ts
type WorkspaceDto = {
  workspaceId: string
  pathDisplay: string
  title: string
  sessionIds: readonly string[]
  createdAt: string
  updatedAt: string
}

type WorkspaceSnapshotDto = {
  generation: number
  revision: number
  phase: 'syncing' | 'ready' | 'failed'
  orderedIds: readonly string[]
  byId: Readonly<Record<string, WorkspaceDto>>
  archivedSessionIds: readonly string[]
  capabilities: {
    directoryPicker: boolean
    nativeOpen: boolean
    unarchiveSession: false
    deleteSession: false
  }
  error?: DesktopError
}

type SessionSummaryDto = {
  sessionId: string
  updatedAt: number
  running: boolean
  blank: boolean
  parentSessionId?: string
  origin?: 'subagent'
  workspaceId?: string
  cwdDisplay?: string
  title?: string
  model?: ModelSelectionDto
}

type SessionAddressDto =
  | { kind: 'session'; sessionId: string }
  | {
      kind: 'subagent'
      parentSessionId: string
      childSessionId: string
      mode: 'one-shot' | 'continuable'
    }

type SessionControlDto = {
  generation: number
  sessionId: string
  running: boolean
  canCancel: boolean
  queue: readonly QueueItemDto[]
  jobs: readonly SessionJobDto[]
  modelSelection: ModelSelectionDto | null
}
```

所有真实路径在 Renderer 中使用 `pathDisplay`，执行文件系统动作时传 opaque handle、WorkspaceId 或 SessionId；不得把 Renderer 传来的显示路径直接交给 Shell。

### 5.5 命令和 Patch

```text
workspace.subscribe
workspace.createFromSelection
workspace.rename
workspace.removeRegistration
workspace.moveBefore
workspace.moveSessionBefore
workspace.archiveSession
workspace.pickDirectory
workspace.createDirectory

session.list
session.search
session.create
session.open
session.closeView
session.rename
session.fork
session.modelCatalog
session.selectModel
session.prompt
session.queue.edit
session.queue.remove
session.queue.steer
session.cancelTurn
session.attachment.read
session.skills.list
session.fileReferences.list
session.openWorkspacePath
```

```ts
type WorkspacePatch = {
  generation: number
  fromRevision: number
  toRevision: number
  operations: readonly (
    | { type: 'upsert'; workspace: WorkspaceDto }
    | { type: 'remove'; workspaceId: string }
    | { type: 'order'; workspaceIds: readonly string[] }
    | { type: 'archived'; sessionIds: readonly string[] }
  )[]
}
```

Patch 只有在 `generation` 一致且 `fromRevision === localRevision` 时可应用，否则 Renderer 请求新 Snapshot。

## 6. Workspace 功能规格

### WS-001：Workspace 全量同步与实时跟随

**用户行为**

- 启动后看到 Workspace 的稳定排序、标题及所含 Session；
- 断线时看到“正在重新连接”，恢复后列表自动校正；
- 重连不会出现重复 Workspace、旧标题复活或顺序跳回旧值。

**实现步骤**

1. Utility 启动官方 `createWorkspaceStateStream()` 或等价官方 Client Model；
2. 每代第一个 `baseline` 转成 `WorkspaceSnapshotDto`，原子替换旧状态；
3. 将 `upsert/remove/order/archived` 转为连续 `WorkspacePatch`；
4. Utility 为 Patch 分配桌面 `revision`，并保留最新 Snapshot；
5. Renderer 仅在代次和 revision 连续时应用；发现缺口立即暂停增量并请求 Snapshot；
6. Utility dispose 时撤销官方订阅、Bridge listener 和 MessagePort producer。

**命令/DTO/Patch**

- 输入：`workspace.subscribe({ knownGeneration?, knownRevision? })`；
- 输出：`WorkspaceSnapshotDto | WorkspacePatch`；
- 上游：`workspace.follow()`，每个 generation 首帧必须是 baseline。

**边界、错误与恢复**

- baseline 前收到增量：视为协议错误并重建连接；
- `order` 含未知 ID：拒绝发布，记录兼容错误并要求 baseline；
- 延迟 unary 回执不得复活已被 `remove` 的 Workspace；
- Bridge 重启：generation 增加，Renderer 清空待应用 Patch。

**安全**

- `path` 只转换成显示值；日志默认散列或裁剪，不记录完整用户路径；
- Snapshot 有 Workspace 数量和字符串长度上限。

**测试**

- baseline、连续增量、重连替换、重复增量、乱序、移除后迟到 upsert；
- 10,000 次更新后 revision 连续且 Listener 数量稳定；
- 恶意超长路径、标题和未知 ID 被 Schema 拒绝。

**DoD**

- Fake Host 与真实 Harness 合同测试通过；
- generation 切换不存在旧状态闪回；
- dispose 后无活跃 stream、timer、listener。

### WS-002：选择目录并创建 Workspace

**用户行为**

- 点击“添加 Workspace”后使用系统目录选择器；
- 选择已注册目录时聚焦已有 Workspace，而不是产生副本；
- 无目录选择能力时入口被禁用并给出可理解说明。

**实现步骤**

1. Renderer 调用 `workspace.pickDirectory()`，Main 打开原生 Dialog 或由官方 directory picker 完成；
2. Main 返回一次性 `DirectoryHandle`，而不是让 Renderer构造路径；
3. Utility 解析 handle，规范化路径并映射 `workspace.create({ path })`；
4. 回执中的 `created:false` 转为 `existing` 结果；
5. UI 导航等待 Workspace Snapshot/Patch 已包含该 ID 后再完成；
6. 命令超时但结果未知时重新同步列表，不直接重试 create。

**命令/DTO/Patch**

```ts
workspace.createFromSelection({ directoryHandle, commandId })
→ { status: 'created' | 'existing', workspaceId: string }
```

**边界、错误与恢复**

- 用户取消选择不是错误，返回 `CANCELLED_BY_USER`；
- 目录不存在、权限不足、路径非法映射 `workspace/invalid-path`；
- Symlink、UNC、设备路径策略由 Main 安全层决定，V1 默认拒绝不受支持形式；
- 回执成功但 Patch 延迟时显示“正在同步”，超时后拉 Snapshot。

**安全**

- `shell:false`；不拼接命令行；
- Handle 有窗口、用途和 TTL 绑定，使用一次后失效；
- 不允许 Renderer 直接传 `C:\...` 作为 create 请求。

**测试**

- 新目录、已有目录、取消、权限拒绝、目录消失、symlink、中文/空格路径；
- 同一目录双击创建只产生一个 Workspace；
- 连接在提交后断开时通过 resync 确认真实结果。

**DoD**

- 所有路径只来自可信 Capability；
- 创建与复用两条 E2E 均通过；
- 不会创建重复导航项。

### WS-003：Workspace 重命名

**用户行为**

- 可以内联或在菜单中重命名；空白名称不可提交；冲突名称显示字段级错误；
- Escape 取消，Enter 提交，失败后保留用户输入供修改。

**实现步骤**

1. Renderer 本地 trim、长度和控制字符校验；
2. 发送 `workspace.rename({ workspaceId, title, commandId })`；
3. Utility 映射官方 `workspace.rename`；
4. 回执只用于结束 pending，最终标题以 upsert Patch 为准；
5. 同一 Workspace 同时只允许一个 rename 在途。

**命令/DTO/Patch**：成功返回 `{ workspaceId, acceptedTitle }`；状态 Patch 使用完整 `WorkspaceDto`。

**边界、错误与恢复**

- `workspace/name-conflict` 聚焦输入框；
- `workspace/not-found` 关闭编辑并刷新 Snapshot；
- `OUTCOME_UNKNOWN` 时保留编辑值并标记“正在确认”。

**安全**：标题作为纯文本渲染；限制 Unicode code points、禁止 NUL；日志不记录完整标题。

**测试**：空白、重复、超长、组合字符、并发重命名、删除与重命名竞态。

**DoD**：键盘和屏幕阅读器完成全流程；失败无错误标题写入本地真源。

### WS-004：删除 Workspace 注册

**用户行为**

- 删除前对话框明确说明“只移除 Workspace 注册，不删除目录、文件和 Session”；
- 当前 Workspace 被移除后，导航到下一个可用项或空状态；
- 删除失败时列表项仍存在并可重试。

**实现步骤**

1. Renderer 二次确认后发送 `workspace.removeRegistration`；
2. Utility 调用官方 `workspace.delete`；
3. 不做永久乐观删除，只显示行级 pending；
4. 等待 `remove` Patch；若回执成功但 Patch 未到，主动请求 Snapshot；
5. 删除后关闭该 Workspace 的纯 UI 路由状态，不删除 Session 视图缓存。

**命令/DTO/Patch**：`{ workspaceId, commandId } → { deleted:true }`。

**边界、错误与恢复**

- `workspace/not-found` 视为状态陈旧，resync 后结束；
- 传输中断返回 UNKNOWN，禁止自动再次提交；
- 当前 Session 仍存在时可继续打开其会话，只是不再显示在 Workspace 分组中。

**安全**：确认文案不可由 Harness 返回内容覆盖；删除命令不接受路径。

**测试**：有/无 Session、当前选中、重复点击、断线、迟到 Patch、工作目录仍存在。

**DoD**：任何测试都不删除真实目录；删除语义在 UI 和诊断中明确。

### WS-005：Workspace 排序

**用户行为**

- 拖拽或键盘将 Workspace 移到目标项之前；掉到末尾时 `beforeWorkspaceId` 省略；
- 服务拒绝后恢复权威顺序并提示原因。

**实现步骤**

1. UI 生成临时视觉预览，不立即覆盖权威数组；
2. 发送 `workspace.moveBefore`；
3. Utility 映射 `insertBefore` 并返回完整 `workspaceIds`；
4. 以官方回执/随后 order Patch 归一化排序；
5. 拖拽期间收到新 baseline 时取消拖拽并采用新状态。

**命令/DTO/Patch**：`{ workspaceId, beforeWorkspaceId?, commandId }`；Patch 为 `{ type:'order', workspaceIds }`。

**边界、错误与恢复**：自身作为 anchor、未知 ID、并发排序、列表更新中拖拽均 fail closed 并重同步。

**安全**：所有 ID 必须存在于当前 Snapshot；拖拽 Payload 不接受外部 MIME 数据。

**测试**：首位、末位、不变移动、键盘排序、并发排序、错误回滚。

**DoD**：鼠标和键盘结果一致；顺序只由官方完整数组提交。

### WS-006：Workspace 内 Session 排序与归档

**用户行为**

- 用户可调整 Workspace 内 Session 顺序；
- 归档后 Session 从普通导航隐藏，但历史不会被删除；
- V1 明确显示“当前版本不支持取消归档”。

**实现步骤**

1. 排序调用 `workspace.moveSessionBefore`，映射 `insertSessionBefore`；
2. 归档调用 `workspace.archiveSession`；
3. 排序完成后用返回的完整 Workspace row 替换；
4. 归档完成后用完整 `archivedSessionIds` 集合替换；
5. 当前 Session 被归档时先完成命令，再导航到相邻 Session；
6. 归档中正在运行的 Session 继续在后台运行，并可通过运行指示器/诊断访问，不伪装取消。

**命令/DTO/Patch**

```text
workspace.moveSessionBefore({workspaceId, sessionId, beforeSessionId?})
workspace.archiveSession({sessionId})
```

**边界、错误与恢复**

- `workspace/move-invalid`：刷新对应 Workspace；
- `session/not-found`：刷新 Session 列表；
- 已归档再次归档是幂等显示，但仍以返回全集为准；
- 不提供本地删除 archived ID 的“反归档”补丁。

**安全**：确认弹窗明确运行任务不会停止；归档命令只使用 SessionId。

**测试**：跨 Workspace 错误、未知 anchor、当前/运行 Session 归档、重复归档、重连保持归档。

**DoD**：归档是 durable display filter；所有界面不出现未经支持的 unarchive。

### WS-007：目录浏览、创建目录与受控打开路径

**用户行为**

- 创建 Workspace 时可浏览允许的目录并创建子目录；
- 在 Session 中点击“打开工作目录”时由系统文件管理器打开；
- 当前部署不支持原生打开时隐藏/禁用操作。

**实现步骤**

1. Utility 依据 capability 暴露 `directoryPicker` 与 `nativeOpen`；
2. 目录浏览使用官方 `pick/list/createDirectory` 或 Main 原生 Dialog，但二者只保留一个权威实现；
3. `createDirectory` 要求父 Handle + 单段名称，成功后返回新 Handle；
4. 原生打开优先使用官方 `canOpenWorkspacePath/openWorkspacePath`，只传由 Session/Tool 输出校验过的路径；
5. 打开失败返回可恢复错误，不在 Renderer 调用 `shell.openPath`。

**命令/DTO/Patch**：目录列表只返回 `{handle,name,kind,displayPath}`；不得返回可复用的无限期路径权限。

**边界、错误与恢复**：不可读、重名、路径消失、目录选择 backend 未挂载、打开取消分别使用稳定错误码。

**安全**：子目录名必须为一个 segment；拒绝 `..`、绝对路径、设备路径和 NUL；检查 symlink/TOCTOU 策略。

**测试**：中文、空格、隐藏目录、权限拒绝、重名、路径替换、Capability 失效。

**DoD**：Renderer 无法借接口浏览用户未授权路径；所有打开操作都有用户动作来源。

## 7. Session 功能规格

### SES-001：Session 列表、分组、搜索与状态更新

**用户行为**

- Sidebar 按 Workspace 与人工顺序展示普通 Session；Subagent-origin Session 不混入普通列表；
- 可按消息内容搜索，结果显示安全摘要并跳转；
- 运行状态和最近活动时间实时更新。

**实现步骤**

1. Utility 用官方 `session.list` 获得持久化与 live 汇总；
2. 订阅允许的 `api-session/added/removed/status/activity/error`，将通知合并到目录状态；
3. 普通通知不可靠，重连后必须再次 list；
4. 搜索映射 `session.search({query})`，输入 debounce 仅降低请求频率，不改变语义；
5. 每个请求带 query revision，晚到结果丢弃；
6. Renderer 按 Workspace `sessionIds`、archived set 和未归组 Session 派生显示树。

**命令/DTO/Patch**：`SessionDirectorySnapshotDto`、`SessionDirectoryPatch`、`session.search({query,queryRevision})`。

**边界、错误与恢复**：搜索空串不发请求；上游限制 20 条和 240 code points 摘要，UI 不假定全量；通知缺失以 list 修复。

**安全**：snippet 纯文本；搜索词不进入日志；数量、长度均有上限。

**测试**：冷/live Session、Subagent 排除、归档过滤、搜索竞态、重连漏通知、错误摘要。

**DoD**：重连后目录与官方 list 一致；搜索不会激活冷 Agent。

### SES-002：创建、打开、切换与关闭视图

**用户行为**

- 在 Workspace 内创建新 Session，或创建未归组 Session；
- 快速切换时看到各自草稿、滚动位置和运行状态；
- 关闭界面资源不会终止后台 Agent。

**实现步骤**

1. 生成 `commandId`，调用 `session.create({workspaceId?,cwd?,agentPreset?})`；
2. `cwd` 必须从 Workspace/Directory Handle 解析，不采用页面任意字符串；
3. 获得 SessionId 后，等待目录 Patch 或进行有界 list reconcile；
4. `session.open` 由 Subscription Pool 获取 history follow、control 和 Conversation Projector；
5. 同一地址多消费者引用计数；最后消费者释放后，延迟释放重型订阅；
6. UI 切换通过 route key + epoch，旧打开请求晚到时立即 dispose；
7. `session.closeView` 只释放客户端资源。

**命令/DTO/Patch**：`session.create` 返回 `{sessionId, agentPreset?}`；`session.open` 返回 `SessionViewSnapshotDto`。

**边界、错误与恢复**：`session/conflict`、preset conflict、Workspace attach 失败必须展示具体恢复动作；create UNKNOWN 时 list/reconcile，不重建 Session。

**安全**：客户端生成 ID 时使用加密随机源；Session 地址做 schema 与 capability 校验。

**测试**：双击创建、创建后断线、快速 A→B→A、打开不存在、冷 Session 激活、20 次打开/关闭泄漏。

**DoD**：不产生重复 Session；关闭视图不会 Cancel 或销毁后台会话。

### SES-003：Session 重命名

**用户行为**

- 用户可从 Header/Sidebar 重命名，错误在原位置显示；
- 成功后所有位置一致更新。

**实现步骤**

1. 客户端校验标题；
2. 调用 `session.rename({sessionId,title})`；
3. 记录返回的 durable `seq`，等待 Conversation/Session 目录覆盖该水位；
4. 不建立第二套标题数据库；
5. 同一 Session rename single-flight。

**命令/DTO/Patch**：返回 `{title,seq}`；目录 Patch 与 Conversation 投影均可确认。

**边界、错误与恢复**：`session/title-invalid`、not found、断线 UNKNOWN；冲突时重新 inspect/list。

**安全**：纯文本、限长、日志脱敏。

**测试**：空白、Unicode、运行中重命名、并发重命名、迟到事件。

**DoD**：标题来自 durable event；重启后仍一致。

### SES-004：Fork Session

**用户行为**

- 用户可从当前已完成节点 Fork，也可从最新完整前缀 Fork；
- 新 Session 自动打开，原 Session 不改变；
- 不可 Fork 的位置说明原因。

**实现步骤**

1. Timeline 将可 Fork 节点解析为 durable `atSeq`，禁止用数组下标；
2. 调用 `session.fork({sessionId,atSeq?})`；
3. 返回新 SessionId 后等待 Session Directory 出现；
4. 新 Session 打开时从官方 follow snapshot hydrate；
5. 不复制 Renderer 节点或草稿模拟 Fork。

**命令/DTO/Patch**：`session.fork({sourceSessionId,atSeq?,commandId}) → {sessionId}`。

**边界、错误与恢复**：只允许 completed-turn prefix；`session/fork-unavailable` 明确提示；UNKNOWN 时通过 parent/created time 辅助 reconcile，但不能凭猜测创建第二个。

**安全**：atSeq 必须属于当前地址并由投影提供；Renderer 不读取源日志。

**测试**：最新、指定 Turn、流式中、Tool 中间、非法 seq、断线 UNKNOWN。

**DoD**：Fork 结果由新 Session snapshot证明；源 Session 零修改。

### SES-005：模型目录、模型和 Reasoning Effort 选择

**用户行为**

- 用户看到按 Provider 分组的模型、描述和可选 reasoning effort；
- 某个 Provider 加载失败不会让整个选择器失效；
- 选择值作为该 Session 下一请求的模型，重启后按官方投影恢复。

**实现步骤**

1. Utility 调用 `session.modelCatalog()`，映射 default、routableProviders、groups、failures；
2. 目录按 connection generation 缓存，并提供显式刷新；
3. 选择时提交 provider/model/reasoningEffort；
4. Utility 调用 `session.selectModel`，使用 Host 归一化的 `selected`；
5. 最终选择来自 Session `modelSelection` projection 的 `next/lastUsed`；
6. 模型运行中切换只影响后续请求，UI 不暗示改变当前 Turn。

**命令/DTO/Patch**：`ModelCatalogDto`、`ModelSelectionDto`；命令 `session.selectModel`。

**边界、错误与恢复**：`session/model-unavailable` 时刷新目录；Provider failure 独立展示；selection UNKNOWN 时重新读 projection。

**安全**：Provider 的错误信息经错误归一化和长度限制；不显示 Secret。

**测试**：空目录、局部失败、默认模型、effort 缺省、运行中选择、重连恢复。

**DoD**：选择结果与官方 accepted selection 一致；页面不缓存过期模型为真源。

### SES-006：Prompt 提交与 Delivery Mode

**用户行为**

- 空闲 Session 发送后立即出现本地消息；
- 运行中可选择排队或 steer；
- 提交失败时本地回显明确标记失败并可由用户主动重新编辑；
- 连接中断时显示“结果未知”，绝不静默重复发送。

**实现步骤**

1. Composer 规范化文本和附件，生成加密随机 `requestId`；
2. Utility 在调用官方 prompt 前执行官方 `beginSubmission` 或兼容等价操作；
3. 立即发布 `PendingSubmissionPatch`；
4. 调用 `session.prompt({requestId,sessionId,mode,content,clientTimeZone})`；
5. durable `user/message.source.rpcId` 或 queue `rpcId` 到达时，以同一 requestId 原子替换回显；
6. 最早下一动画帧退休旧 echo，避免 DOM 空洞；
7. 明确失败立即退休并标记 failed；传输结果未知进入 reconcile；
8. UI 不允许同一 requestId 再提交。

**命令/DTO/Patch**：`PromptCommandDto` 和 `PendingSubmissionDto`；正文 part 仅 `text`/受校验 `image`。

**边界、错误与恢复**：时区非法、Session 不存在、Agent busy、steer 不可用、附件非法分别映射；UNKNOWN 后等待 durable event/queue，再允许用户用新 requestId 手动重发。

**安全**：限制文本、图片数量、单项与总字节；Prompt 正文不写日志/Metric；图片 base64 不经过普通 IPC JSON 日志。

**测试**：同帧 echo、queue/steer、durable 对账、RPC 先/事件先、失败、断线 UNKNOWN、重复点击、IME。

**DoD**：一条用户输入最多形成一个 durable 用户消息；本地回显不重复、不永久悬挂。

### SES-007：Queue 查看、编辑、删除与转 Steer

**用户行为**

- 运行中的 Session 显示 authoritative queue；
- 用户可编辑尚未处理的文本、删除项或将其变成 steer；
- 已被 Agent 消费的项操作失败时自动刷新，不假装成功。

**实现步骤**

1. Session control stream 每 generation 发布完整 queue baseline；
2. Renderer 只按 `QueueItemDto.id` 操作；
3. `edit` 将内容规范化成官方 ContentBlock；
4. `remove`、`steer` 映射 `session.updateQueue` 的 QueueAction；
5. 操作期间锁定该 item，不锁整个 queue；
6. 成功回执后等待下一个 control replacement；超时拉新 baseline。

**命令/DTO/Patch**：`session.queue.edit/remove/steer`，输入含 sessionId、itemId、commandId。

**边界、错误与恢复**：`queue-item-not-found`、`steer-unavailable`、Session 非 live；失败时去除 pending，采用最新 control state。

**安全**：编辑内容与 Prompt 相同限额；禁止任意 JSON content block；不记录正文。

**测试**：消费竞态、并发编辑/删除、重连 replacement、重复点击、未知 item。

**DoD**：Queue 永远以 control baseline 为准；运行/重连后无幽灵队列项。

### SES-008：取消当前 Turn

**用户行为**

- 只有 Session 正在运行且官方能力允许时显示 Stop；
- 点击后显示“正在停止”，队列不被清空；
- 取消已结束 Turn 不产生假成功。

**实现步骤**

1. `canCancel` 从 control/running 状态派生；
2. 发送 `session.cancelTurn({sessionId,commandId})`；
3. Utility 调用官方 `session.cancel`；
4. 回执仅表示请求已接收，UI 等待运行状态和 durable terminal 事件；
5. 设置取消期限，超时进入 DEGRADED/仍在运行状态而不是强制改成 stopped；
6. 不修改待处理 inbox。

**命令/DTO/Patch**：回执 `{accepted:true}`；终态来自 Session Patch。

**边界、错误与恢复**：Agent 已结束、Session cold、Bridge 重连；重复 Stop single-flight；结果未知时 resync control。

**安全**：取消只针对当前 Session，sender 与当前 window 校验。

**测试**：生成文本、Tool 执行、排队存在、重复取消、取消与自然结束竞态、断线。

**DoD**：UI、control 和 durable transcript 的终态一致；取消不删除 Queue。

### SES-009：附件提交、读取与缓存

**用户行为**

- 用户可通过选择器/拖放添加支持的图片，发送前看到缩略图、类型、大小和移除按钮；
- 历史图片按需加载，失败可重试；
- 不支持或超限文件在发送前明确拒绝。

**实现步骤**

1. Drop/Picker 交由 Preload/Main 创建受限 `FileHandle`；
2. Main 校验文件类型、魔数、大小、数量、符号链接和读取权限；
3. 通过分块 MessagePort 或 Utility 受控读取生成官方 Prompt image part；
4. Prompt 被接受后释放临时 handle/bytes；
5. 历史附件通过 `session.attachment({sessionId,attachmentId})` 授权读取；
6. Renderer 创建 Blob URL，节点卸载/Session 关闭时 revoke；
7. 缓存以 attachmentId + content hash 为键，有总字节 LRU 上限。

**命令/DTO/Patch**：Renderer 只见 `AttachmentDraftDto` 和 `AttachmentDisplayDto`；不把永久绝对路径放入 DTO。

**边界、错误与恢复**：文件改变、读取中取消、MIME 伪造、上游 `attachment-invalid`、历史附件缺失；发送失败保留 handle 到 TTL，过期后要求重选。

**安全**：默认拒绝 SVG/HTML；检查实际魔数；不自动请求外部图片 URL；大二进制不进入日志、Pinia、Crash report。

**测试**：有效图片、零字节、超限、伪扩展名、symlink、发送中修改、Blob URL 泄漏、历史越权读取。

**DoD**：只能读取用户选中或 Session 已证明可达的附件；资源释放可测。

### SES-010：Skills 与文件引用建议

**用户行为**

- 输入 `/` 时显示当前 Session 可供用户调用的 Skills；
- 输入文件触发符时显示当前 Session 允许的引用；
- 结果晚到不会覆盖更新后的输入；加载失败不阻止普通文本发送。

**实现步骤**

1. Skills 调用 `skills.list({sessionId})`，按 Session/capability generation 缓存；
2. 展示 name、description、whenToUse、modelInvocable；插入 literal `/name `；
3. 文件引用调用官方 `fileReferences.list`，参数严格按上游 compat adapter 构造；
4. 每次查询携带 `queryRevision` 和 Session epoch；
5. 切换 Session、关闭 suggestion 或连接代次变化时 Abort；
6. 只插入声明式文本/引用 DTO，不允许结果执行命令。

**命令/DTO/Patch**：`SkillEntryDto`、`FileReferenceDto`；所有数组和字符串有界。

**边界、错误与恢复**：冷 Session 的 Skills 列表不应激活 Agent；文件引用可能激活/恢复 Session，UI 显示加载；过期结果丢弃。

**安全**：候选 label 纯文本；文件路径以相对 display 值呈现；结果不能携带 HTML 或点击即执行动作。

**测试**：空列表、重复 name、查询竞态、切 Session、断线、超长候选、键盘导航。

**DoD**：建议系统不改变模型/Agent 状态，除非官方文件引用合同明确需要恢复；过期结果从不入 UI。

### SES-011：Session 恢复、后台资源和错误面

**用户行为**

- 应用重启后能回到最近 Session；
- Session 断线时可继续阅读现有内容，但发送被禁用或明确排队等待连接；
- 单个 Session 损坏不会导致整个应用白屏。

**实现步骤**

1. Renderer 只持久化最近 SessionId、UI 路由、scroll anchor 和草稿，不缓存官方 transcript 为真源；
2. 启动后先验证 SessionId 仍存在，再打开；
3. 后台运行 Session 只保留目录状态和有界控制信息；
4. Subscription Pool 对最近访问 Session 使用 LRU，超限释放 history/projector；
5. Session stream business/persistence failure 只终止该 Session；
6. Renderer 显示 error boundary，提供重试、复制错误码、打开诊断；
7. connection generation 变化后重建官方 Controller 并重新获取 Snapshot。

**命令/DTO/Patch**：`SessionResourceStatsDto` 用于测试/诊断，不含消息正文。

**边界、错误与恢复**：Session 不存在、持久化损坏、follow 无进展、重连重试耗尽、后台任务仍运行均有独立状态。

**安全**：错误详情经过白名单；不把原始堆栈和路径显示给普通用户。

**测试**：崩溃恢复、删除/损坏的最近 Session、20 个 Session 切换、Bridge restart、Renderer reload。

**DoD**：所有 Session 资源有 owner/dispose；单 Session 故障不污染其他 Session。

## 8. 错误映射原则

| 官方错误 | 桌面错误码 | UI 行为 |
|---|---|---|
| `workspace/invalid-path` | `WORKSPACE_PATH_INVALID` | 保留选择流程并允许重选 |
| `workspace/name-conflict` | `WORKSPACE_NAME_CONFLICT` | 字段级错误 |
| `workspace/not-found` | `WORKSPACE_STALE` | 关闭编辑并 resync |
| `workspace/move-invalid` | `WORKSPACE_ORDER_STALE` | 取消拖拽并 resync |
| `session/not-found` | `SESSION_NOT_FOUND` | 返回目录并刷新 |
| `session/conflict` | `SESSION_ID_CONFLICT` | 不重试，展示现有/请求差异 |
| `session/model-unavailable` | `MODEL_UNAVAILABLE` | 刷新目录并要求重新选择 |
| `session/queue-item-not-found` | `QUEUE_ITEM_STALE` | 刷新 control baseline |
| `session/steer-unavailable` | `STEER_UNAVAILABLE` | 保持 queue，不改本地状态 |
| `session/attachment-invalid` | `ATTACHMENT_INVALID` | 定位附件并允许移除 |
| carrier timeout after dispatch | `OUTCOME_UNKNOWN` | reconcile，禁止自动重复写 |

映射必须保留 `recoverable`、`retryKind`、`messageKey` 和安全 details；不得把上游英文 message 当唯一产品文案。

## 9. 开发顺序

1. 定义 Workspace/Session DTO、命令、错误与容量限制；
2. 接入 Workspace Client Model 与 generation baseline；
3. 接入 Session Directory list/events/search；
4. 实现 Subscription Pool 和 SessionAddress；
5. 实现 create/open/rename/Fork；
6. 实现 Model Catalog 与选择；
7. 实现 Prompt、本地提交对账 seam；
8. 实现 control、Queue 与 Cancel；
9. 实现附件能力；
10. 实现 Skills、文件引用、目录打开；
11. 实现 Workspace 排序、Session 排序、归档、删除注册；
12. 完成真实 Harness 合同、故障注入、泄漏和 E2E。

每一步应单独提交且正常运行 Git hooks；前一步 DoD 未满足时不进入依赖它的 UI 开发。

## 10. 模块验收清单

- [ ] Renderer 源码零导入 `@deepseek-ai/dsh-*`、Cordis、Node 或 Electron；
- [ ] Workspace 每个 generation 先 baseline，Patch revision 连续；
- [ ] Workspace 创建不接受 Renderer 任意路径；
- [ ] Workspace 删除从未删除磁盘目录或 Session；
- [ ] Workspace 和 Session 排序都以官方完整结果为准；
- [ ] Session 归档明确是单向能力，页面无伪 unarchive；
- [ ] Session list/search 不激活冷 Agent；
- [ ] 创建 UNKNOWN 不自动创建第二次；
- [ ] Fork 使用 durable seq，不使用 UI 下标；
- [ ] 模型选择以官方 projection 恢复；
- [ ] Prompt requestId 完成本地回显和 durable/queue 对账；
- [ ] Queue edit/remove/steer 都处理被消费竞态；
- [ ] Cancel 不清空 inbox，终态由官方状态确认；
- [ ] 附件只有用户授权或 Session 可达时可读；
- [ ] Skills 与引用的过期查询不覆盖新 Session；
- [ ] 断线重连丢弃旧 generation；
- [ ] 20 次打开/关闭 Session 后 listener、timer、stream、Blob URL 回到基线；
- [ ] 所有失败都有稳定 DesktopError、恢复动作和自动测试；
- [ ] Workspace/Session 全生命周期真实安装包 E2E 通过。

## 11. 模块完成定义

只有同时满足以下条件才可标记本模块完成：

1. WS-001～WS-007、SES-001～SES-011 均已实现，或在正式 V1 范围账本中明确标记“不适用”并获审批；
2. 每个命令具备成功、业务拒绝、取消、载波中断和 generation 变化测试；
3. Fake Host、固定版本真实 Harness、Renderer E2E 三层证据一致；
4. 不存在本地第二真源、非幂等自动重试、路径越权、Secret/正文日志泄漏；
5. 性能、资源与无障碍门禁通过；
6. 功能矩阵、DTO Schema、错误映射和实现处于同一版本并能追溯到独立提交。
