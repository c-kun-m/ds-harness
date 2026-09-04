# 12：Tool Presenter、Approval、User Question、Subagent 与 Goal

## 1. 文档目标

本文件定义复杂交互表面：Tool 卡片、用户审批、结构化问题、Subagent 会话与 Goal。它们的共同特点是具有稳定业务身份、异步生命周期和潜在高风险操作，不能简化成“拿 JSON 渲染一个组件”。

统一边界：

- 官方 Client、Remote event waterfall、Session/Goal/Subagent Controller 全部运行在 Utility Process；
- Utility 把官方对象转换为稳定 DTO，并保留回答 Promise、CAS ref、parent/child authority 等敏感能力；
- Renderer Presenter 只接收数据和声明式 Intent，不获得 transport、Cookie、文件系统、Shell 或任意 Remote；
- 未知 Tool 必须安全降级为 Generic Card，不能导致白屏或静默消失；
- Approval/Question 是瞬时一次性请求，Host/Utility 是“是否仍 pending”的唯一真源；
- Goal mutation 必须使用当前投影携带的 exact `{id,revision}` 做 CAS；
- Subagent continuation 必须携带完整 `{parentSessionId,childSessionId,mode}`，不以 label 寻址。

## 2. 范围与非范围

### 2.1 范围

- Tool Presenter 注册、选择、Schema、fallback、局部错误隔离和懒加载；
- Shell、文件读取/写入、搜索、Diff、Subagent 与 Generic 首批 Presenter；
- 大输出 Inspector、复制、受控打开路径；
- Approval `allowed-once/rejected/cancelled/unavailable`；
- User Question 的单选、多选、自定义答案、跳过、取消和 plan-review intent；
- 统一 Interaction Inbox、Composer takeover、过期和竞态处理；
- Subagent direct-child catalog、递归树、导航、延续 Prompt 和 interrupt；
- one-shot/continuable read-only 规则；
- `@label` 的 inert 文本建议；
- Goal projection、创建、编辑、暂停、恢复、完成、清除与 CAS；
- 键盘、无障碍、性能、安全、故障恢复和测试。

### 2.2 非范围

- V1 不加载第三方任意 Vue/React/JavaScript Presenter；
- 不执行 Tool、不修改 Tool 参数或结果；
- 不把 Approval “允许一次”扩展成永久授权；
- 不在 Renderer 保存未提交 Interaction draft 到磁盘；
- 不推测 Approval 风险等级替代 Host policy；
- 不通过 `@label` 控制或寻址 Subagent；
- 不从 Subagent `activity` 推断 durable 成功、失败或取消；
- 不在没有官方能力时伪造 Goal block/unblock；
- 不展示 Goal process-local activation 为可靠 durable 状态；
- 不实现完整 PTY 或任意文件编辑器。

## 3. 依赖与建议目录

### 3.1 依赖

- Conversation Node DTO、Tool Node DTO、Session Projection DTO；
- Utility Remote event adapter、Interaction Coordinator、Goal/Subagent compat；
- MessagePort、Command Client、Inspector Host、Safe Markdown/ANSI/Diff Worker；
- Design System、i18n、A11y、Motion System；
- Fake Host、malicious fixture corpus、真实 Harness。

### 3.2 建议目录

```text
packages/desktop-contracts/src/
  tools.ts
  interactions.ts
  subagents.ts
  goals.ts

packages/harness-domain/src/
  interactions/
    interaction-coordinator.ts
    approval-adapter.ts
    question-adapter.ts
  subagents/
    subagent-catalog.ts
    subagent-control.ts
  goals/
    goal-adapter.ts
    goal-errors.ts

apps/desktop/src/renderer/features/tools/
  registry.ts
  ToolBoundary.vue
  GenericToolCard.vue
  ShellToolCard.vue
  FileToolCard.vue
  SearchToolCard.vue
  DiffToolCard.vue
  inspector/

apps/desktop/src/renderer/features/interactions/
  InteractionHost.vue
  InteractionInbox.vue
  ApprovalPanel.vue
  QuestionPanel.vue
  PlanReviewPanel.vue
  interaction-drafts.ts

apps/desktop/src/renderer/features/subagents/
  SubagentCatalog.vue
  SubagentTree.vue
  SubagentStatus.vue
  composer-policy.ts

apps/desktop/src/renderer/features/goals/
  GoalBar.vue
  GoalEditor.vue
  GoalActions.vue
```

## 4. 核心合同和状态机

### 4.1 Tool Presenter 合同

```ts
type ToolPresenterDescriptor = {
  id: string
  version: number
  matches: readonly { toolName: string; schemaVersion?: number }[]
  load: () => Promise<ToolPresenterModule>
}

type ToolPresenterProps = {
  node: ToolNodeDto
  density: 'compact' | 'comfortable'
  emitIntent(intent: ToolIntentDto): void
}
```

Presenter 禁止接收 `desktopApi`、CommandClient、Session Controller 或任意回调对象；唯一输出是经过 schema 的 `ToolIntentDto`。

### 4.2 Interaction DTO

```ts
type PendingInteractionDto = {
  interactionId: string
  connectionGeneration: number
  sessionEpoch: number
  sessionAddress: SessionAddressDto
  kind: 'approval' | 'question'
  state: 'open' | 'responding'
  createdAt: number
  expiresAt?: number
  request: ApprovalRequestDto | QuestionRequestDto
}
```

`interactionId` 是 Utility 为一次正在等待的 waterfall invocation 生成的不可猜本地身份。不得假设它等于 durable `approval/asked.id`；上游转发的实时 Approval payload不提供该 durable ID。

### 4.3 Interaction 状态机

```text
RECEIVED → OPEN → RESPONDING → RESOLVED
                 ├──────────→ REJECTED
                 ├──────────→ OUTCOME_UNKNOWN
OPEN/RESPONDING ────────────→ CANCELLED_BY_HOST
OPEN/RESPONDING ────────────→ EXPIRED
任意非终态 ────────────────→ CONNECTION_LOST
```

Utility 重启或 connection generation 改变时，旧 Interaction 全部失效；不得从 Renderer/磁盘恢复回答能力。

### 4.4 Subagent 地址与 Goal DTO

```ts
type SubagentAddressDto = {
  parentSessionId: string
  childSessionId: string
  mode: 'one-shot' | 'continuable'
}

type GoalDto = {
  id: string
  revision: number
  objective: string
  phase: 'active' | 'paused' | 'blocked' | 'complete'
  blockedReason?: { code: string; message: string }
  maxGoalRounds: number
  roundsStarted: number
  createdAt: number
  updatedAt: number
  activation: 'unknown'
}
```

Projection 不持久化 Goal activation，Renderer 必须使用 `unknown`，不能用 `active` phase 推断已 armed。

## 5. Tool Presenter 功能规格

### TOOL-001：Presenter Registry、匹配和懒加载

**用户行为**

- 已支持 Tool 使用清晰专属卡片；未支持 Tool 使用 Generic Card；
- 某个 Presenter 加载失败只影响该卡片；
- 升级后 Tool schema 变化不会误套旧卡片。

**实现步骤**

1. 构建时注册静态 descriptor，按 exact wire tool name + schemaVersion 匹配；
2. ToolNodeDto 先过公共 schema，再过 Presenter 私有 schema；
3. 匹配唯一且校验成功才 lazy import Presenter；
4. 无匹配、多匹配、schema 失败都进入 Generic；
5. 每张卡片包裹 `ToolBoundary`，异常后保留 Generic fallback；
6. Registry 冻结后不可由模型/Host inventory 动态注入代码；
7. 开发环境提供覆盖检查，正式构建生成 presenter manifest/hash。

**命令/DTO/Patch**：输入 `ToolNodeDto`；输出仅 `ToolIntentDto`，更新来自 Conversation Patch。

**边界、错误与恢复**

- Presenter chunk 下载失败、模块 throw、schema mismatch、重复注册均局部降级；
- 版本不认识时不猜兼容；
- HMR dispose 仅开发有效，不能遗留旧 descriptor。

**安全**

- 禁止 eval、远程 module、任意组件名动态 import；
- Presenter 无 transport/file/shell；
- 所有 payload 深度、节点、字符串和总字节受限。

**测试**

- 精确匹配、unknown、版本不匹配、重复、加载失败、render throw、恶意 payload；
- 构建依赖图确保 Presenter 不导入 Preload/官方 Client。

**DoD**

- 任意合法 ToolNode 都能显示专属或 Generic；
- 单卡错误不影响 Conversation；
- Registry manifest 可追溯。

### TOOL-002：Generic Tool Card 与未知数据

**用户行为**

- 未知工具仍显示名称、状态、开始/结束时间、安全参数摘要和结果摘要；
- 可复制经过确认的纯文本或在 Inspector 查看受限 JSON；
- 不因超大或递归数据卡死。

**实现步骤**

1. 将输入/结果转换成 `SafeJsonTreeDto`，限制深度、节点、数组长度和字符串长度；
2. 默认折叠，摘要仅显示白名单标量；
3. 巨大内容显示字节/节点数量和 head/tail；
4. JSON 格式化在 Worker 完成，结果带 node revision fence；
5. 状态统一为 pending/running/succeeded/failed/cancelled/outcome-unknown；
6. 打开 Inspector 使用 nodeKey 获取当前稳定 DTO，不传整块数据到路由；
7. 对不合法数据使用“无法安全显示”的静态 fallback。

**命令/DTO/Patch**：`ToolIntentDto = inspect | copySafeText | openPathCapability`；Generic 默认只有前两项。

**边界、错误与恢复**：call-only、result-only、冲突、未知 content block、Worker crash；任何失败不改变 Tool终态。

**安全**：字符串永不作为 HTML/URL/路径执行；复制前显示明确范围；默认掩码疑似 Secret。

**测试**：循环/深层/百万数组模拟、Secret canary、unknown block、Worker late result。

**DoD**：未知 Tool 100% 有安全可读 fallback；主线程无大 JSON 长任务。

### TOOL-003：Shell/Command Presenter

**用户行为**

- 查看命令摘要、cwd 显示值、运行状态、退出码、耗时和清洗后的输出；
- 输出过大时只显示 head/tail并打开 Inspector；
- V1 不提供交互式输入或“重新执行”按钮。

**实现步骤**

1. 对已知 Shell tool schema 提取 command、cwd、timeout 等白名单字段；
2. 命令默认单行折叠，展开才显示完整纯文本；
3. stdout/stderr 保持通道标识，ANSI 通过安全 transcript parser；
4. 丢弃/转义 OSC 8、窗口标题、剪贴板、设备控制和未知控制序列；
5. 输出采用行虚拟化，达到阈值后 head/tail + Inspector；
6. exit code/signal/timeout/outcome unknown 使用不同状态；
7. 复制命令/输出需要明确用户动作并经过 Secret redaction 提示。

**命令/DTO/Patch**：只消费 ToolNodeDto；可发 `copySafeText`、`inspect`，不发 execute。

**边界、错误与恢复**：无 exit code、被取消、编码错误、超长单行、混合 ANSI、result 缺失。

**安全**：不创建终端仿真器执行 OSC；不将 command 作为链接；cwd 不直接交给 Shell。

**测试**：ANSI corpus、OSC clipboard/link、超大输出、无终态、exit/signal/timeout、Secret。

**DoD**：恶意终端输出不能改标题、剪贴板、打开链接或执行代码；大输出滚动达标。

### TOOL-004：文件读取/写入 Presenter 与受控打开

**用户行为**

- 查看操作类型、相对路径显示、范围、结果和可选 diff；
- 点击“打开文件/所在目录”必须经过权限检查；
- 文件已变化或不存在时显示当前失败，不伪造成功。

**实现步骤**

1. 按官方 tool name/version 验证 input/result；
2. 路径只显示 workspace-relative 或脱敏 display path；
3. 读取内容使用代码/文本块预算；二进制只显示 metadata；
4. 写入优先展示官方结果/diff，不读取磁盘补造结果；
5. Open Intent 携 `sessionId + nodeKey + pathCapabilityId`；
6. Utility 验证 capability 属于当前 Tool/Session 且未过期后调用受控打开；
7. Presenter 不允许传 Renderer 自己编辑的路径。

**命令/DTO/Patch**：`ToolIntentDto.openPath({capabilityId,intent:'file'|'folder'})`。

**边界、错误与恢复**：路径不存在、越界、symlink 改变、二进制、超大文本、partial write、outcome unknown。

**安全**：规范化和 Workspace 边界检查在 Main/Utility；拒绝设备路径、NUL、协议 URL；内容禁 raw HTML。

**测试**：正常/相对/绝对显示、路径穿越、symlink TOCTOU、二进制、超大、capability 过期。

**DoD**：Renderer 不能借 Presenter 打开任意路径；写入展示只来自 durable Tool result。

### TOOL-005：Search Presenter

**用户行为**

- 查看查询、匹配数量、文件/网页结果摘要和跳转；
- 大量结果分组、虚拟化；未知来源仍可安全显示；
- 打开本地结果或外链都经过受控 Intent。

**实现步骤**

1. 按 tool schema 区分 workspace search、file search、web search；
2. 结果归一化为 `SearchHitDto {source,label,snippet,locationCapability?}`；
3. snippet 纯文本高亮，匹配区间按 code points 验证；
4. 首屏只展示前 N 项，完整列表进入 Inspector/虚拟列表；
5. 本地 hit 用 path capability，Web hit 用 normalized https external intent；
6. 结果统计从 DTO 数量派生，不解析文案；
7. schema 不匹配进入 Generic。

**命令/DTO/Patch**：`inspect/openPath/openExternal/copySafeText` intents。

**边界、错误与恢复**：无结果、部分失败、snippet 区间非法、重复 hit、超大列表、非 https URL。

**安全**：snippet 不用 innerHTML；URL 需协议/长度/域名规则；路径能力绑定 Session。

**测试**：本地/Web/混合、恶意 URL、Unicode 区间、10k hits、keyboard navigation。

**DoD**：结果量不阻塞 UI；打开动作全部经过 Broker 二次校验。

### TOOL-006：Diff Presenter

**用户行为**

- 查看文件列表、增删统计、hunk 和行号；超大 Diff 可折叠并进入 Inspector；
- Diff 解析失败仍可看安全原文摘要。

**实现步骤**

1. Worker 解析 unified diff，输出有界 `DiffTreeDto`；
2. 限制文件、hunk、行、单行和总字节；
3. 主卡显示文件摘要和小 Diff，大 Diff 使用虚拟化 Inspector；
4. 不完整流式 Diff 先纯文本/等待 final，避免反复全量 parse；
5. final revision 后缓存 parse 结果；
6. 文件导航使用 path capability；
7. Worker parse error 回到 escaped plain text。

**命令/DTO/Patch**：`DiffTreeDto` 带 node/content revision；Intent 仅 inspect/openPath/copy。

**边界、错误与恢复**：binary diff、rename、no-newline、极长行、截断、Worker crash、late result。

**安全**：文件名和行内容纯文本；不执行 patch、不写磁盘；拒绝 HTML/ANSI 控制效果。

**测试**：Git diff corpus、恶意路径、超大、截断、二进制、Worker 故障。

**DoD**：解析永不在主线程形成 >50ms 任务；Diff Presenter 没有 apply 权限。

### TOOL-007：Inspector、Intent Broker 与 Presenter 质量门禁

**用户行为**

- 可在独立 Inspector 查看长内容、固定当前位置、复制安全片段；
- 当前节点更新/消失时 Inspector 明确刷新或关闭；
- Presenter 操作失败有局部反馈。

**实现步骤**

1. Inspector 只保存 `{sessionEpoch,nodeKey,viewKind}`；
2. 每次打开从当前 Conversation Snapshot 派生最新内容；
3. 大数据按页/分块加载，Renderer 不一次结构化克隆无限 payload；
4. 所有 ToolIntent 进入本地 registry，再映射固定 Main/Utility 命令；
5. Broker 校验当前 route、node capability、用户手势和 TTL；
6. Inspector component 与 Worker 各有 Error Boundary/owned scope；
7. 为每个 Presenter建立 Story、schema fixture、恶意 fixture、A11y/visual/perf 测试。

**命令/DTO/Patch**：`InspectorIntent` 与 `ToolIntentDto` 是封闭联合类型。

**边界、错误与恢复**：节点被 replace、Session 切换、capability 过期、分块中断；按当前 epoch fail closed。

**安全**：无任意 command/path/url；复制、打开都需用户手势；诊断不采集内容。

**测试**：Intent fuzz、stale node、分块背压、Inspector reopen、Error Boundary、资源泄漏。

**DoD**：所有 Presenter action 可在一处审计；单 Presenter 无法扩大权限。

## 6. Interaction 功能规格

### INT-001：Utility Interaction Coordinator 与统一 Inbox

**用户行为**

- 任意 Session 的待审批/问题都有清晰标记；当前 Session 按先后处理一个请求；
- 切换 Session 不会丢请求；请求被 Host 撤回后立即失效；
- Renderer reload 后旧按钮不能回答旧 Promise。

**实现步骤**

1. Utility 在官方 Cordis Client Context 注册 `approval/request` 和 `user-questions/request` waterfall answerer；
2. 每次 invocation 生成不可猜 `interactionId`，保存 resolver、AbortSignal、generation、SessionAddress；
3. 将请求严格转换成 DTO，发布完整 `InteractionSnapshotDto` 或 Patch；
4. 同 Session 依照到达顺序和 precedence 选当前 composer owner，其他留 Inbox；
5. Renderer 回答时 Utility 原子执行 `OPEN→RESPONDING`，第二次回答拒绝；
6. Host signal abort/Context dispose/generation change时关闭 resolver，发布 expired/cancelled；
7. 没有可用桌面 answerer时遵循上游 fail-closed，不返回默认 allow。

**命令/DTO/Patch**：`interaction.subscribe/respond/cancel`；`InteractionSnapshotDto`、`InteractionPatchDto`。

**边界、错误与恢复**

- 请求没有 Agent/Session 映射：交给 `next()` 或 fail closed，不显示成全局可回答；
- Renderer 消失不应让请求永久挂起；按生命周期策略返回 cancelled/unavailable；
- generation 变化旧 interactionId 全部失效。

**安全**

- resolver 永不跨进程；ID 使用加密随机；
- 回答校验 sender、window、generation、Session、kind 和 schema；
- 默认 deny/fail closed。

**测试**

- 多 Session、多请求、重复回答、abort、Renderer reload、Bridge restart、无 answerer；
- 证明每个 resolver 恰好 settle 一次。

**DoD**

- Pending 真源只在 Utility；
- 同一 interactionId 最多一次成功提交；
- 任何断连不产生隐式允许。

### INT-002：Approval 表面

**用户行为**

- 看到 Tool 名称、关联 Tool 卡、原因和“仅允许一次/拒绝”；
- 请求撤回时按钮立即失效；
- V1 不显示“永久允许”。

**实现步骤**

1. Utility 映射 `toolName/callId/reason`，关联当前 Session ToolNode；
2. Renderer 在 Composer takeover 或 Interaction Center 显示 ApprovalPanel；
3. 允许结果严格编码 `allowed-once`，拒绝编码 `rejected`；
4. 点击后同步锁定全部决策按钮，发送 `interaction.respond`；
5. 成功后等待 Host waterfall 完成/interaction remove；
6. `cancelled/unavailable` 仅作为 Host 终态显示，用户不能伪造 unavailable；
7. durable `approval/asked/decided` 由 Conversation 作为审计状态展示，但不被当作实时回答能力。

**命令/DTO/Patch**：`ApprovalRequestDto`、`ApprovalAnswerDto {outcome:'allowed-once'|'rejected'}`。

**边界、错误与恢复**：callId 缺失时仍显示通用详情；Tool 卡已回收可打开 Generic detail；OUTCOME_UNKNOWN 禁止再次批准，等待交互失效/同步。

**安全**：默认聚焦“拒绝”或中性标题，不用动效诱导允许；原因/Tool 参数不作为 HTML；无永久授权。

**测试**：allow/reject、重复点击、abort 同帧、无 callId、恶意 reason、旧 generation、键盘。

**DoD**：允许一次与拒绝完整可达；没有任何默认 allow 或倒计时自动 allow。

### INT-003：User Question 与 Plan Review

**用户行为**

- 一次请求逐题回答，支持单选、多选、自定义答案、跳过、前后导航；
- 单选可选后推进，多选保留多项；IME Enter 只确认候选；
- 合法 `plan-review` 使用“讨论/拒绝/批准”专门表面，但不改变答案协议。

**实现步骤**

1. Utility 校验 question id 唯一、问题/选项/数量/文本上限；
2. Renderer draft 以 interactionId + questionId 存在内存，不落盘；
3. 单选 custom 与 option 互斥；多选允许 selected + custom；
4. Skip 编码 `{selected:[]}`，保留其他题 draft；
5. 所有题完成/跳过后一次提交完整 answers 数组；
6. Close 编码本地 cancel，Utility 让 wait 以官方取消语义结束；
7. 只有一题、intent=plan-review、detail 存在、approve label 在 options 且表达能力完整时选择 PlanReviewPanel；
8. plan review approve/refuse 返回模型提供的原 label；“讨论”取消 wait 回 Composer；
9. 未知 intent 回通用 QuestionPanel。

**命令/DTO/Patch**：严格对应 `AskUserQuestionItem/AnswerItem` 的桌面 DTO；Intent 只改变布局。

**边界、错误与恢复**

- 重复 question id、approve 不在 options、空/超长 options 回 generic/compat error；
- Session 切换保留内存 draft，interaction 变化立即清空；
- Host abort 关闭并丢弃 draft；
- 回答 UNKNOWN 不再次提交。

**安全**：question/detail/option 使用 Safe Markdown/纯文本；选项 label 作为值精确回传，不解释命令；限制自定义文本。

**测试**：单/多选、custom、skip、cancel、IME、plan-review eligibility、未知 intent、duplicate ID。

**DoD**：协议允许的每种答案都可表达；专门表面绝不缩小答案集合。

### INT-004：交互过期、恢复、优先级与无障碍

**用户行为**

- 当前请求失效时听到/看到明确通知，无法再点击；
- 多个请求不会覆盖，用户可在 Inbox 定位来源 Session；
- 所有决策可纯键盘完成，危险操作文案稳定。

**实现步骤**

1. Utility 给每个 interaction 发布 state 与终止 reason；
2. Renderer 选择器只让一个请求取得 Composer，其余展示计数；
3. Approval 与 Question precedence 明确版本化，不能依赖注册顺序；
4. 切 Session 后当前请求留在原 Session，Sidebar 显示 pending badge；
5. 过期时保留短暂只读摘要，按钮全部移除；
6. Focus 在失效后返回 Composer/Inbox trigger；
7. `aria-live` 只播报“需要操作/已撤回/已提交”，不朗读完整敏感参数；
8. Interaction draft 只活在页面/Session scope，full reload 后不恢复。

**命令/DTO/Patch**：`InteractionTerminalReason = answered | host-cancelled | expired | connection-lost | unavailable`。

**边界、错误与恢复**：回答与 abort 竞态以 Utility 原子状态为准；旧 UI 回答返回 `INTERACTION_STALE`。

**安全**：风险决策不用颜色单独表达；防 clickjacking 的桌面窗口策略由 Electron 外壳保证。

**测试**：优先级、多 Session、焦点、重复、abort race、reload、NVDA、reduced-motion。

**DoD**：交互从收到到 settle 的每条路径可测；无 pending Promise 泄漏。

## 7. Subagent 功能规格

### SUB-001：Direct-child Catalog 与递归树

**用户行为**

- 父 Session Header 显示全部 Subagent 后代数量和活动提示；
- 展开树看到 mode、activity、label、子节点提示、token/duration（能力存在时）；
- corrupt/unavailable 项可读但不可打开。

**实现步骤**

1. Utility 调 `subagents.list(parentSessionId)`，映射 entries 与 parentAvailable；
2. 每一层只在展开时 lazy list，根层打开立即加载；
3. `hasChildren` 仅作为 disclosure hint，展开后以子 catalog 为真源；
4. 构建树时记录祖先集合，检测循环与深度/节点上限；
5. child 用完整 parent/child/mode 地址；diagnostic 保存 reason；
6. activity 仅显示 running/inactive，不映射成功失败；
7. 可选 token/timing 来自已声明 projection，不能从文本猜测；
8. 展开的 branch 列表更新做 debounce，不无限轮询。

**命令/DTO/Patch**：`subagent.catalog({parentSessionId}) → SubagentCatalogDto`。

**边界、错误与恢复**：parent unavailable 仍可浏览 durable catalog；projection unavailable 显示模块错误；循环/超深切断并诊断。

**安全**：label 纯文本；ID 不拼路径；目录数量和深度受限。

**测试**：多层、one-shot/continuable、diagnostic、循环恶意数据、lazy race、parent offline。

**DoD**：树完整且有界；普通 Sidebar 不重复显示 Subagent-origin Session。

### SUB-002：子会话导航与只读策略

**用户行为**

- 点击健康节点打开精确子会话 transcript；
- one-shot 始终只读；continuable 根据 parent/child 状态显示输入或恢复说明；
- breadcrumb 能回到直接父链。

**实现步骤**

1. 导航使用 `SessionAddressDto.kind='subagent'`；
2. Router 校验 parent/child/mode 均存在；
3. Conversation follow 使用 exact direct-subagent address；
4. one-shot 固定 `canType=false/canStop=false`；
5. continuable：parent live 时可 Prompt；parent 不可用且 child inactive 时只读；child 仍 running 时允许独立 Stop但可能禁止 Send；
6. breadcrumb 从 catalog/Session header派生，不凭 URL 猜祖先；
7. ordinary fork 边界停止 Subagent lineage。

**命令/DTO/Patch**：`ComposerPolicyDto` 和 exact `SubagentAddressDto`。

**边界、错误与恢复**：catalog hint 过期，最终命令由 Host权威检查；地址错误/unauthorized 返回父 Session。

**安全**：label 不作为地址；Renderer 修改 mode 无法绕过 Utility 校验。

**测试**：全部 mode/activity/parent 组合、普通 fork 边界、错误地址、快速导航。

**DoD**：只读矩阵完整；没有通过普通 `session.prompt` 错投子会话。

### SUB-003：Continuable Subagent Prompt

**用户行为**

- 可向 continuable child 发送文本/图片，立即本地回显；
- 消息进入 child FIFO inbox，成功回执不代表执行完成；
- parent 不可用/无权时显示明确原因。

**实现步骤**

1. 生成共享 `session-request-id` requestId；
2. Utility 根据地址调用官方 `subagents.prompt`，固定 mode=`continuable`；
3. 内容与普通 Prompt 使用相同 attachment admission 和时区校验；
4. local echo 与 child durable rpcId 对账；
5. receipt messageId 仅证明 inbox accepted；
6. failure/UNKNOWN 遵循 COMP-007，不自动重发；
7. Host 二次检查 direct parent live、ownership、resumable、delivery capability。

**命令/DTO/Patch**：`subagent.prompt({requestId,parentSessionId,childSessionId,mode:'continuable',content,clientTimeZone})`。

**边界、错误与恢复**：parent-unavailable、not-resumable、unauthorized、delivery-unavailable、attachment-invalid、invalid-time-zone。

**安全**：完整地址和 capability 由 Utility校验；正文/图片不日志。

**测试**：成功、各错误、事件/回执竞态、图片、UNKNOWN、重复点击。

**DoD**：一 requestId 最多一个 child durable message；one-shot 无发送路径。

### SUB-004：`@` 引用来源

**用户行为**

- 输入 `@` 可选择当前运行 children；插入 literal `@label `；
- 同名 label 清晰区分展示，但插入仍只是文本；
- 选择不会自动发送或建立控制连接。

**实现步骤**

1. 候选来自 Utility 当前 Session/subagent catalog 的只读 DTO，不额外 RPC；
2. 仅筛选产品规定的 running/healthy candidate；
3. 显示 label + 短 ID 辅助区分；
4. 插入经过纯文本转义的 `@label `；
5. 不在 Prompt 中加入隐藏 child ID；
6. label 更新时已有草稿不自动重写；
7. 候选 dispose 与 Session epoch 绑定。

**命令/DTO/Patch**：`SubagentMentionCandidateDto` 是 inert suggestion，不含 action callback。

**边界、错误与恢复**：重复 label、无 label one-shot、child 状态变化、旧查询结果。

**安全**：不让模型/label 注入命令；`@` 不具有授权和 continuation 语义。

**测试**：重复/Unicode label、状态变化、键盘、Session 切换、选择不触发 RPC。

**DoD**：代码与文案都明确 `@` 仅为 literal text。

### SUB-005：Interrupt by Parent

**用户行为**

- running continuable child 显示独立 Stop；点击后进入 stopping；
- parent Agent 即使当前不 live，官方允许的 exact parent authority 仍可中断；
- idle/completed no-op 不误报“强杀完成”。

**实现步骤**

1. 使用 exact `childSessionId,parentSessionId,mode:'continuable'`；
2. Utility 调 `subagents.interruptByParent`；
3. accepted 只表示 cancel signal admitted；
4. UI 等 control/Conversation terminal 确认；
5. item-level single-flight；
6. unauthorized 立即刷新 catalog/address；
7. 超时显示仍在停止，不暴露 process kill。

**命令/DTO/Patch**：`subagent.interrupt({address,commandId}) → {accepted:true}`。

**边界、错误与恢复**：already completed/idle accepted no-op、unauthorized、generation change、自然结束竞态。

**安全**：只允许 continuable direct parent 地址；Main/Utility sender 与 capability 校验。

**测试**：running、idle、completed、parent offline、unauthorized、重复、断线。

**DoD**：Stop 语义与上游一致；无错误 child 被中断。

## 8. Goal 功能规格

### GOAL-001：Goal Projection 与 Goal Bar

**用户行为**

- 当前 Goal 在 Composer Context Stack 显示 objective、phase、rounds 和上限；
- loading、无 Goal、complete/cleared 按产品规则隐藏或进入历史状态；
- blocked 显示稳定原因；不误报自动续跑已 armed。

**实现步骤**

1. Utility 从 Session `goal` projection 映射 GoalDto；
2. Projection 为 null 表示没有当前 Goal/已 clear；
3. `active/paused/blocked/complete` 映射样式与动作 capability；
4. `roundsStarted/maxGoalRounds` 明确展示预算；
5. activation 固定 unknown，除非未来增加可靠官方 live channel；
6. Goal command input 由 Conversation definition 投影，不伪造成 user message；
7. Goal Bar 不建立 refresh timer/store。

**命令/DTO/Patch**：`setProjection('goal',GoalDto|null)`。

**边界、错误与恢复**：projection loading/schema failure、complete、blocked reason 缺失；局部禁用 Goal UI。

**安全**：objective/reason 纯文本或 Safe Markdown；长度限制；不日志。

**测试**：所有 phase、null/loading、rounds、重连、projection malformed。

**DoD**：Goal Bar 完全由 projection 驱动；无 durable activation 误导。

### GOAL-002：创建与编辑 Goal

**用户行为**

- 无当前 Goal 或当前已完成时可创建；可编辑 objective 和 max rounds；
- 非 complete Goal 已存在时创建被拒绝并引导编辑/清除；
- 编辑冲突时保留输入并刷新最新版本。

**实现步骤**

1. 创建表单校验非空 objective 和正整数 maxGoalRounds；
2. 调 `goals.create(session scope,{objective,maxGoalRounds?})`；
3. 编辑从当前 projection 读取 exact GoalRef，再调 `goals.edit(ref,changes)`；
4. 至少一项变更；不提交无变化；
5. single-flight 防同帧重复；
6. 回执后等待 goal projection更新；
7. stale revision 刷新 projection，展示 diff/允许用户重新应用。

**命令/DTO/Patch**：`goal.create`、`goal.edit`；DTO 不把官方 Agent 对象传 Renderer。

**边界、错误与恢复**：already exists、invalid objective/edit/round cap、stale ref、Agent not live、UNKNOWN。

**安全**：objective 不作为命令执行；限制长度；错误不暴露内部 Agent。

**测试**：创建、complete 后替换、已存在、只改 objective/round、stale CAS、重复点击。

**DoD**：所有 mutation 使用当前投影 ref；无 last-write-wins 覆盖他人更新。

### GOAL-003：Pause、Resume、Complete 与 Clear

**用户行为**

- active 可 pause；paused/blocked 可 resume；active/paused/blocked 可 complete；当前 Goal 可 clear；
- 无效转移不显示或被服务拒绝后校正；
- Clear 明确保留 durable history/tombstone，不等于删除过去对话。

**实现步骤**

1. 按 phase 派生动作，但 Utility 仍使用官方 GoalService权威校验；
2. 每次点击读取最新 exact GoalRef；
3. 调 `goals.pause/resume/complete/clear`；
4. Resume 前显示剩余 rounds；预算耗尽时要求先编辑上限；
5. 回执后等待 projection；
6. Clear 使用确认对话框并说明语义；
7. complete/clear 后移除 Goal Bar 的 pending状态，不删除 transcript command node。

**命令/DTO/Patch**：封闭 `GoalMutationCommand` 联合类型；Clear 返回 tombstone ref 仅供 reconcile。

**边界、错误与恢复**：invalid transition、stale revision、round exhausted、Agent not live、UNKNOWN。

**安全**：Clear 确认文案固定；不允许 Renderer 自定义 operation 字符串。

**测试**：完整 phase transition matrix、budget、重复、stale、clear历史保留、重连。

**DoD**：每种官方公开 transition 有 UI/命令/测试；无不支持的 unblock 按钮。

### GOAL-004：CAS、错误恢复、并发与无障碍

**用户行为**

- 两个快速操作/后台更新冲突时不会覆盖新 Goal；
- stale 提示说明状态已变化并展示最新值；
- Goal 表单和操作纯键盘可达。

**实现步骤**

1. 所有操作携 `{id,revision}`，Utility 不缓存过期 ref；
2. Goal Bar 同步 single-flight，避免同帧点击绕过 pending render；
3. `GOAL_STALE_REVISION` 后请求/等待新 projection，不自动重放用户意图；
4. 由用户查看差异后再次提交；
5. generation/Session epoch 变化使表单 pending 失效；
6. 显示稳定错误码和恢复动作；
7. Dialog focus trap、字段错误关联、状态变化适度播报。

**命令/DTO/Patch**：`GoalCommandOutcome` 明确 `stale/outcome-unknown/rejected`。

**边界、错误与恢复**：edit 与 pause 竞态、resume 与 rounds 更新、clear 与重连、完整 Session 冷恢复。

**安全**：不自动重试 CAS mutation；Goal 文本不入日志/Metric label。

**测试**：确定性并发/barrier、旧 ref、UNKNOWN、焦点、NVDA、Session 切换。

**DoD**：没有 last-write-wins；所有并发冲突需要用户基于新状态决定。

## 9. 开发顺序

1. 冻结 Tool、Interaction、Subagent、Goal DTO 和安全 limits；
2. 建立 Presenter Registry、ToolBoundary、Generic Card；
3. 完成 Utility Interaction Coordinator 和一次性 responder；
4. 完成 Approval；
5. 完成 Generic Question 和 plan-review；
6. 完成 Shell/File/Search/Diff Presenter 与 Inspector Broker；
7. 完成 Subagent Catalog/Tree 与 exact navigation；
8. 完成 continuable Prompt、`@` source 和 interrupt；
9. 完成 Goal projection、create/edit 和 transition；
10. 完成恶意 corpus、竞态、E2E、A11y、性能和资源泄漏测试。

## 10. 验收清单

- [ ] Presenter 全部是静态白名单，未知 Tool 进入 Generic；
- [ ] 单 Presenter 错误不会导致 Conversation 白屏；
- [ ] Presenter 没有 transport、文件、Shell、Cookie、官方 Client 权限；
- [ ] Shell ANSI、路径、URL、Diff、JSON 恶意 corpus 全通过；
- [ ] 大 Tool 输出不阻塞主线程；
- [ ] 所有高权限动作经 ToolIntent Broker 和 capability 二次校验；
- [ ] Interaction resolver 只存在 Utility，恰好 settle 一次；
- [ ] generation/reload 后旧 interactionId 不可回答；
- [ ] Approval 只有 allow-once/reject，无默认 allow/永久授权；
- [ ] User Question 可表达单选、多选、custom、skip、cancel；
- [ ] plan-review 只改变布局，不改变答案可达性；
- [ ] Subagent 树有深度、循环、节点和请求上限；
- [ ] one-shot 永远只读；continuable 使用 exact parent/child/mode；
- [ ] `@label` 只插入文本，不获得控制语义；
- [ ] interrupt accepted 不被误作已停稳；
- [ ] Goal 只由 projection 驱动且 activation 不被误推断；
- [ ] Goal 所有 mutation 使用 exact CAS ref；
- [ ] stale/UNKNOWN mutation 不自动重试；
- [ ] 所有交互纯键盘可完成，Axe 严重问题为零；
- [ ] dispose 后 interaction promise、listener、Worker、Presenter scope 为零。

## 11. 模块完成定义

TOOL-001～TOOL-007、INT-001～INT-004、SUB-001～SUB-005、GOAL-001～GOAL-004 必须全部具备实现、Schema、fixture、错误恢复、安全和 E2E 证据。任意未知 Tool 白屏、Approval 默认放行、旧交互可重复回答、Subagent 用 label 寻址、Goal 不带 CAS、Presenter 可直接调用高权限 API，都属于发布阻塞问题。
