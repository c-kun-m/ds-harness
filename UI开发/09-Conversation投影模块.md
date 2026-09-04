# 09：Conversation 投影模块

## 1. 文档目标

Conversation 投影模块把官方 Session history/follow/control 中的浏览器安全数据，转换成自定义 Vue UI 可以稳定消费的 `ConversationSnapshotDto` 与 `ConversationPatchDto`。本模块负责“事件意味着什么、节点如何关联、如何恢复连续性”，不负责 DOM、虚拟滚动、Markdown 样式或动画。

最高优先级原则：

- 官方 Client、Cordis、Session Controller、Headless Conversation Assembler 全部位于 Utility Process；
- Renderer 不接收原始 `SessionWireEvent`，不导入上游 event 类型，不自行重放 Harness 日志；
- 投影必须保持上游用户可见语义，不能为了 Vue 方便擅自删改事件；
- 所有增量都受 `connectionGeneration + sessionEpoch + revision` 三重围栏保护；
- gap、部分重叠、非法 surface replace 等情况必须 fail closed 并重建 Snapshot；
- 本地回显是临时表现，不得写入 durable history，也不能制造第二条用户消息；
- Tool call/result、Approval、Question、Goal、Subagent 等关系只按稳定 ID 和官方投影建立，禁止靠相邻数组元素猜测。

## 2. 范围与非范围

### 2.1 范围

- 官方 history opening snapshot、page、live follow frame 的摄取；
- 普通 event 与 packed chunk row 的无损解包/消费；
- Surface append/replace 语义与节点稳定身份；
- 用户消息、Assistant 文本、Reasoning、状态、错误、命令输入、Tool call/result 的 Headless 投影；
- 本地 submission echo 和 durable/queue 对账；
- sequence 连续性、重复去除、gap detection、tail repair；
- 向前分页、`loadThrough(seq)` 与 prepend 元数据；
- Session projections（模型、Goal 等）的 snapshot/update；
- Direct Subagent SessionAddress；
- Snapshot/Patch 编码、大小控制、背压与 Resync；
- 缓存、后台 Session 降级、资源回收；
- 与官方 Web 投影的 golden/differential 测试。

### 2.2 非范围

- 不拥有 Workspace、Session 目录和队列命令，见 `08-Workspace与Session领域模块.md`；
- 不解析 Markdown、ANSI、Diff，不创建 HTML；
- 不管理 Vue Store、DOM、虚拟列表高度和滚动；
- 不运行 Tool，不决定 Approval，也不发送 Subagent Prompt；
- 不修改、压缩或修复 Harness 持久化文件；
- 不允许第三方 Presenter 参与投影状态；
- 不把完整 raw event 长期复制到 Renderer 或 Pinia。

## 3. P0 技术决策

固定上游已公开无 React 依赖的 `UiConversation` 与 `ConversationNodeAssembler`，但官方 Chat 节点注册器当前没有承诺稳定的公共 headless export。正式实现按以下顺序决策：

1. **首选**：向上游贡献 `ui-chat/headless` 公共入口，仅导出纯 Conversation Definition 注册，不加载 React/CSS；
2. **备选**：在 `harness-compat/v0_1_2/conversation` 建立版本专属投影器，并用官方 Web 作为差分 Oracle；
3. **禁止**：GA 代码静默依赖 `@deepseek-ai/.../src/*` 私有路径；Spike 阶段如临时使用，必须在兼容账本标为发布阻塞项；
4. 每次上游升级必须重新运行 event catalog、projection golden 和 differential suite。

若这项决策未完成，允许开发纯文本技术演示，但不得宣称 Conversation 模块可发布。

## 4. 依赖与建议目录

### 4.1 依赖

- 上游：Session Controller client、`UiConversation`、`ConversationNodeAssembler`、Session Projection 类型；
- 项目：Bridge、Desktop Contracts、Session Subscription Pool、错误与容量限制；
- 下游：Vue Adapter、Conversation Timeline、Tool Presenter、Interaction Center、Goal/Subagent UI；
- 测试：官方 Web projection harness、Session fixtures、Fake Stream、fast-check。

### 4.2 建议目录

```text
packages/harness-compat/src/v0_1_2/conversation/
  register-headless.ts
  event-codec.ts
  projection-codec.ts
  upstream-adapter.ts
  parity-ledger.md

packages/harness-conversation/src/
  conversation-projector.ts
  conversation-state.ts
  history-ingest.ts
  surface-reducer.ts
  node-normalizer.ts
  tool-pairing.ts
  submission-reconciler.ts
  gap-controller.ts
  pagination-controller.ts
  patch-builder.ts
  cache-policy.ts
  limits.ts
  diagnostics.ts

packages/desktop-contracts/src/
  conversation.ts
  interaction.ts
  tool-presenter.ts

packages/test-fixtures/src/conversation/
  golden/
  malformed/
  high-volume/
```

## 5. 数据模型与状态机

### 5.1 投影生命周期

```text
NEW
  → OPENING_FOLLOW
  → HYDRATING
  → READY
  → PAGING / APPLYING_LIVE
  → READY

READY → GAP_DETECTED → REPAIRING → READY
READY → CONNECTION_LOST → WAITING_GENERATION → HYDRATING
任意活动状态 → FAILED
任意状态 → DISPOSING → DISPOSED
```

只有 `READY`、`PAGING` 和 `APPLYING_LIVE` 可以对 Renderer 发布增量。`HYDRATING` 与 `REPAIRING` 在内部构建下一份状态，完成后一次性发布 reset/snapshot。

### 5.2 游标与围栏

```ts
type ProjectionFence = {
  connectionGeneration: number
  sessionEpoch: number
  addressKey: string
  revision: number
  durableFromSeq: number | null
  durableThroughSeq: number
}
```

- `connectionGeneration`：Bridge 每次物理连接重建递增；
- `sessionEpoch`：同一 Session 投影实例每次重建递增；
- `revision`：桌面 Snapshot/Patch 连续号，不等同于官方 event seq；
- `durableFromSeq/ThroughSeq`：当前已覆盖的官方闭区间；packed row 覆盖其全部成员；
- 任意 fence 不匹配的异步结果、Worker 结果和 Patch 都必须丢弃。

### 5.3 Snapshot

```ts
type ConversationSnapshotDto = {
  protocolVersion: number
  connectionGeneration: number
  sessionEpoch: number
  revision: number
  address: SessionAddressDto
  header: SessionHeaderDto
  range: { fromSeq: number | null; throughSeq: number; hasEarlier: boolean }
  nodes: readonly ConversationNodeDto[]
  pendingSubmissions: readonly PendingSubmissionDto[]
  projections: Readonly<Record<string, ProjectionValueDto>>
  runState: 'idle' | 'running' | 'stopping' | 'unknown'
  phase: 'ready' | 'degraded' | 'failed'
  error?: DesktopError
}
```

### 5.4 Patch

```ts
type ConversationPatchDto = {
  connectionGeneration: number
  sessionEpoch: number
  fromRevision: number
  toRevision: number
  range: { fromSeq: number | null; throughSeq: number; hasEarlier: boolean }
  reason:
    | 'live-event'
    | 'stream-coalesced'
    | 'history-prepend'
    | 'local-submission'
    | 'durable-reconcile'
    | 'projection-update'
    | 'control-update'
  anchor?: { nodeKey: string; expectedOffsetPx?: number }
  operations: readonly ConversationPatchOperation[]
}

type ConversationPatchOperation =
  | { op: 'insertBefore'; beforeKey?: string; nodes: readonly ConversationNodeDto[] }
  | { op: 'update'; key: string; changes: ConversationNodeChangesDto }
  | { op: 'remove'; keys: readonly string[] }
  | { op: 'replaceRange'; fromKey?: string; throughKey?: string; nodes: readonly ConversationNodeDto[] }
  | { op: 'setPendingSubmissions'; items: readonly PendingSubmissionDto[] }
  | { op: 'setProjection'; name: string; value: ProjectionValueDto | null }
  | { op: 'setRunState'; value: ConversationSnapshotDto['runState'] }
```

`reset` 不作为普通 Patch 操作；一旦需要全量替换，直接发布新 Snapshot，防止局部 Patch 和旧 revision 混用。

### 5.5 节点联合类型

```text
ConversationNodeDto
  user-message
  assistant-message
  reasoning
  tool-call
  tool-result
  command-input
  command-result
  status
  error
  interaction-marker
  turn-divider
  unknown-event
```

所有节点至少包含：

- `key`：同一 durable history 重放稳定；
- `kind`；
- `turnId?`、`messageId?`、`callId?`；
- `seqRange`；
- `timeRange`；
- `status`；
- `content` 的结构化安全 DTO；
- `capabilities`，如 copy、fork、openInspector；
- `source`：`durable | pending-local | control`；
- `presentationVersion`，用于 Presenter 兼容。

## 6. 全局不变量

1. 同一 `(address, seq)` durable event 只消费一次；
2. 当前覆盖范围必须连续，完整重复可丢弃，gap 或部分重叠必须 repair；
3. packed chunk row 的 `[seq, seq + memberCount - 1]` 必须整体计入连续性；
4. Node key 不使用数组索引、DOM 序号或到达时间；
5. Tool result 即使先于 call 到达，也按 callId 暂存和配对；
6. 未知事件若 `ignorable:true` 可记录诊断并跳过，否则发布 `unknown-event` 或触发兼容失败，不得静默吞掉关键语义；
7. `surfaceOp.replace` 只能替换已经覆盖且边界合法的区间；
8. pending echo 只能被同 `requestId/rpcId` 的 durable message 或 queue occurrence 退休；
9. terminal、error、Approval、Question、Tool result 不得因背压丢弃；
10. 一个 Patch 要么完整应用，要么完全不应用；
11. Snapshot 构建期间的 live event 必须由官方 follow-before-baseline 合同或本地缓存保证不丢；
12. dispose 返回时不存在仍能发布该 epoch Patch 的任务。

## 7. 功能规格

### CP-001：官方 Headless 能力装配

**用户行为**

- 用户看到的消息顺序、Tool 关系、Turn 边界与官方 Harness Web 保持一致；
- 上游版本不兼容时显示明确升级/兼容错误，而不是空白页面。

**实现步骤**

1. 在 Utility 的固定版本 compat 插件中创建官方 Cordis Client Context；
2. 挂载官方 Remote、Session Controller、`UiConversation`、Assembler 与纯节点 Definition；
3. 若存在公共 `ui-chat/headless`，只从该公共入口注册；
4. 若使用自有兼容投影，按上游事件目录实现，并登记 parity ledger；
5. 启动时比较 Runtime、Client、protocol fingerprint、projectionVersion；
6. 缺少必需 Definition 或 schema 时 fail closed，不退化到随意 JSON 展示作为“正常模式”。

**命令/DTO/Patch**

- 内部接口：`createProjector(address, fence, limits): ConversationProjector`；
- 对 Renderer 只暴露 Snapshot/Patch，不暴露 Context、Assembler 或官方 Class。

**边界、错误与恢复**

- Definition 冲突、缺少 codec、未知必需事件、私有导出失效均映射 `CONVERSATION_COMPAT_INCOMPATIBLE`；
- 单 Session 投影失败只关闭该投影，Bridge 保持可诊断；
- 用户可复制版本指纹，不显示原始 stack。

**安全**

- 动态官方 Browser Half 和 React 插件不挂载；
- 只加载构建时白名单 Definition；禁止运行来自 Session 内容的模块名。

**测试**

- 公共导出 smoke、缺失 Definition、重复注册、版本错配、dispose/HMR；
- 固定 fixtures 与官方 Web 做节点级差分。

**DoD**

- GA 不引用上游私有 `src/*`；
- 差异账本无未分类用户可见差异；
- Utility 卸载后官方 Context 完全停稳。

### CP-002：Opening Snapshot 与历史记录摄取

**用户行为**

- 打开 Session 时一次看到完整、顺序正确的最近历史；
- packed 流式文本在重启后与实时看到的内容完全一致；
- 初始加载失败时显示重试而不是半条消息。

**实现步骤**

1. 先开启官方 follow，再接受 opening snapshot；
2. 验证 address/header 身份、cursor、records、projection baseline；
3. 对普通 `event` 保持原始 seq/time/data 语义；
4. 对 `chunks` 按 fragment 与 timestamp-gap 数组无损送入 assembler，计算完整 seq range；
5. 在私有 builder 中完成投影后一次性发布 Snapshot；
6. Hydrate 前到达的 live frame 放入有界队列，按 seq 衔接；
7. 任一记录校验失败时丢弃整个未发布 builder。

**命令/DTO/Patch**

- 上游：`session.follow({address,maxMessages})` opening snapshot；
- 桌面：`conversation.open({address, preferredTailMessages}) → ConversationSnapshotDto`。

**边界、错误与恢复**

- 空 Session：`fromSeq:null`、nodes 空，不伪造欢迎事件；
- cursor 小于最后 record 范围、记录倒序或 packed 元数据不匹配：协议错误；
- hydrate 超过时间/内存预算：终止该 Session，并允许用户用更小窗口重试。

**安全**

- 每条 event、单 content block、总 snapshot 有字节和节点上限；
- 原始 event data 不进入普通日志；诊断只记录 type/seq/size/hash。

**测试**

- 空历史、普通事件、packed chunks、混合记录、hydrate 时 live 事件、超大/畸形数据；
- 相同历史多次构建产生相同 key、节点和 hash。

**DoD**

- 初始 Snapshot 原子发布；
- packed 与 live 文本最终值一致；
- hydrate 失败无半成品状态或资源泄漏。

### CP-003：实时 Event、Surface 与稳定节点更新

**用户行为**

- 流式回答持续更新同一条消息，不产生大量重复气泡；
- replace/压缩类 Surface 更新后，界面与重载后的历史一致；
- 未识别但可安全显示的事件不会让整个会话崩溃。

**实现步骤**

1. 每个 live event 先验证 generation、address、seq 连续性和结构限制；
2. 将事件交给官方 assembler 或兼容 reducer；
3. 通过投影前后稳定节点快照生成最小 insert/update/remove/replaceRange；
4. 高频同 block 文本/Reasoning 更新在 Utility 侧可合并，但 seq 游标逐项提交；
5. terminal、status、error、interaction 立即 flush；
6. `surfaceOp.replace` 通过 seq→node index 映射计算受影响范围；
7. 节点 key 在内容变化时保持稳定，身份事件变化才替换。

**命令/DTO/Patch**：`ConversationPatchDto.reason = live-event | stream-coalesced`。

**边界、错误与恢复**

- 完整重复 event 丢弃并计数；
- 部分重叠 packed row、未知 replace 区间、倒序 seq 进入 GAP/REPAIR；
- 不可识别且非 ignorable 的事件触发兼容错误或 `unknown-event`，由版本策略决定。

**安全**

- `data` 只映射到已定义字段，禁止对象 spread 让上游新增字段穿透 DTO；
- 文本保留为纯字符串，绝不在 Utility 生成 HTML。

**测试**

- token burst、reasoning/text 交替、surface replace、重复/倒序/重叠、未知事件；
- 5,000 event/s 60 秒不 OOM，终态不丢。

**DoD**

- 每种事件有显式处理策略；
- 增量结果与重放全量 Snapshot 完全一致；
- Patch 数量受合并策略约束但语义无损。

### CP-004：消息、Turn 与命令节点装配

**用户行为**

- 用户消息、Assistant 文本、Reasoning、命令输入、命令结果和错误拥有清晰稳定的视觉单元；
- Reload 后节点身份、顺序和可操作能力不变化；
- Fork/复制等操作只在语义完整的位置可用。

**实现步骤**

1. 建立上游 node kind → Desktop node kind 的穷尽映射；
2. 按 durable messageId/turnId/callId/definition identity 生成 key；
3. 将一个 Turn 的多个文本 block 保持有序，不按字符串内容合并身份；
4. Command input 作为独立节点，不伪造成 `user/message`；
5. 给节点附 `seqRange` 与 `capabilities.forkAtSeq`；
6. 未结束 Turn 明确 `streaming/running`，不能提供 completed-only 操作；
7. 仅传结构化 content blocks，展示决策留给 Renderer。

**命令/DTO/Patch**：`ConversationNodeDto` 的 discriminated union；变更用 `update` 而非整树 replacement。

**边界、错误与恢复**

- 缺 ID 的 legacy/unknown event 使用版本化确定 key（address + seq + definition），不可用随机数；
- 跨 Turn 的非法引用进入 diagnostic node；
- 终态后又收到 chunk 视为协议错误并 resync。

**安全**：能力字段由 Utility 派生，Renderer 不能根据内容自行启用 Fork/openPath。

**测试**：多 block、空 block、命令输入、错误 Turn、重放 key 稳定性、capability gate。

**DoD**：所有公开 node kind 有 schema、fixture 和 Renderer fallback；重载后 key 稳定。

### CP-005：Tool Call/Result 配对与状态归一化

**用户行为**

- Tool 从准备、运行到成功/失败/取消始终显示为同一逻辑卡片；
- result 先到、call 暂缺或未知工具时仍能安全显示；
- 超大结果显示摘要并可进入 Inspector。

**实现步骤**

1. 以 `(session address, callId)` 建立有界 ToolPairing 表；
2. call 到达创建 `tool-call` node，保存 toolName、参数结构、seq；
3. result 到达更新同 callId node 或创建 orphan-safe result node；
4. 后到 call 与 orphan result 原子合并；
5. 状态归一化为 `pending/running/succeeded/failed/cancelled/outcome-unknown`；
6. Tool result meta 保留白名单字段，正文转换成受限 content DTO；
7. Turn 完结或窗口超过上限仍未配对，冻结 orphan 状态并记录诊断。

**命令/DTO/Patch**：`ToolNodeDto` 必含 `callId/toolName/status/inputSummary/resultSummary/presenterHint`，完整 payload 按需通过 Inspector capability 获取。

**边界、错误与恢复**

- callId 重复但内容冲突：兼容错误并 resync；
- 没有 result 不能假装失败；崩溃修复若官方表示 outcome unknown，必须如实展示；
- Presenter 不存在不影响投影，使用 generic hint。

**安全**

- Tool 参数、结果不直接作为 HTML/ANSI；
- 完整 shell/path 内容默认不写日志；
- payload 深度、节点和总字节有上限，循环对象在 schema 层拒绝。

**测试**

- 正常、result-before-call、call-only、重复、冲突、超大、unknown、cancel/outcome unknown；
- ToolPairing 表在 Session 释放后为零。

**DoD**

- 每个 callId 最多一个逻辑 Tool node；
- Generic fallback 拿到足够安全 DTO；
- 配对和终态与全量重放一致。

### CP-006：本地 Submission Echo 对账

**用户行为**

- 点击发送的同一帧看到自己的输入；
- durable 消息或 Queue 到达时无闪烁、无重复；
- 明确失败、放弃或 Session 关闭时 Echo 有确定终态。

**实现步骤**

1. `beginSubmission` 在序列化和 RPC 前同步登记 `requestId`；
2. 根据当前 running 与 delivery mode 固定 placement：`transcript/queued/steering`；
3. 发布 `setPendingSubmissions` 或 insert pending node Patch；
4. durable user source `rpcId` 或 queue `rpcId` 到达时建立匹配；
5. durable 节点可渲染后，下一动画帧退休 Echo；
6. RPC 明确失败/用户放弃立即标 failed 并调用 `onRetire` 一次；
7. dispose 时所有未退休 Echo 进入 failed/disposed，不跨 epoch 保留。

**命令/DTO/Patch**

```ts
type PendingSubmissionDto = {
  requestId: string
  placement: 'transcript' | 'queued' | 'steering'
  content: readonly SafeContentPartDto[]
  status: 'serializing' | 'submitting' | 'unknown' | 'failed'
  createdAt: number
  error?: DesktopError
}
```

**边界、错误与恢复**

- durable event 先于 RPC 回执仍正常退休；
- Queue occurrence 与 durable transcript 只允许一个最终承接者；
- reconnect 后 Echo 只在当前 Utility 进程内 reconcile；Renderer reload 从 durable state 重建，不从磁盘恢复 Echo；
- UNKNOWN 不自动再次 Prompt。

**安全**：Echo 内容不写日志、不持久化；附件临时能力按 TTL 释放。

**测试**：同帧可见、事件先/回执先、Queue、Steer、明确失败、UNKNOWN、dispose、重复 rpcId。

**DoD**：`onRetire` 恰好一次；不存在重复用户消息或永久 Echo。

### CP-007：连续性检查与 Gap Repair

**用户行为**

- 短暂断线后会话自动恢复，消息不丢失、不重复、不乱序；
- 无法修复时页面明确提示该 Session 需要重新加载，而不是继续展示错误历史。

**实现步骤**

1. 对每条 record 计算闭区间 `[startSeq,endSeq]`；
2. `start === through + 1` 正常应用；`end <= through` 为完整重复；其余为 gap/部分重叠；
3. 检测到异常后冻结对 Renderer 的增量发布；
4. 调用官方 Client SessionEventStream 内建 repair，或用 `page` 从当前 through 之后拉 tail；
5. 在私有副本中校验并追平 buffered live frames；
6. 成功后发布一次新 Snapshot；
7. 无进展、业务错误或预算耗尽时终止投影并要求显式重开。

**命令/DTO/Patch**：内部 `GapReport` 只包含 range/type/size；成功向 Renderer发布 Snapshot，不发送“猜测补丁”。

**边界、错误与恢复**

- 载波断开允许自动恢复；业务/persistence 连续性失败不无限重试；
- generation 变化直接用新 opening snapshot，不把旧 buffer 接到新代；
- repair 并发只允许一个，重复请求合并到最低目标。

**安全**：repair 页数、记录数、总字节和总时长有硬预算，防止恶意 Host 触发无限读取。

**测试**：单帧 gap、多帧 gap、完整重复、部分 packed overlap、repair 时新事件、无进展页面、重连换代。

**DoD**：属性测试证明已发布范围始终连续；修复失败后不会继续发布可疑 Patch。

### CP-008：历史分页、Prepend 与 Turn Jump

**用户行为**

- 向上滚动可以加载更早历史，内容插入后原阅读位置不跳；
- 搜索/Fork 跳转到尚未加载的 Turn 时自动加载到目标；
- 多次快速触发只运行一个合理的分页链。

**实现步骤**

1. `loadOlder()` 使用官方 50-message 页语义；
2. `loadThrough(seq)` 使用官方 200-message 循环页语义，并合并为当前最低目标；
3. 验证 page `beforeSeq/throughSeq` 和当前覆盖区间相接；
4. 投影历史页到新节点，在旧第一可见节点之前生成 insertBefore；
5. Patch 携带 `anchor.nodeKey`，Renderer 执行高度补偿；
6. 页面无进展时停止，避免无限请求；
7. 分页期间 live tail 继续独立摄取，两个方向在 revision builder 中串行提交。

**命令/DTO/Patch**

```text
conversation.loadOlder({address, sessionEpoch})
conversation.loadThrough({address, targetSeq, sessionEpoch})
→ progress/result；实际内容通过 Patch/Snapshot 发布
```

**边界、错误与恢复**

- target 已覆盖则立即成功；
- target 小于有效最早 seq 且 hasMore=false 返回 NOT_FOUND；
- prepend 与 surface replace 冲突时退回全量 Snapshot；
- 用户切 Session 时 Abort 并丢弃旧 epoch 结果。

**安全**：targetSeq 为安全整数且必须来自当前 Session 搜索/Fork capability；限制连续页面和总字节。

**测试**：一页、多页、目标已覆盖、无进展、分页中 live event、快速多目标、Session 切换。

**DoD**：投影连续且无重复节点；Renderer 可以凭 anchor 达到 ≤2px 误差。

### CP-009：Session Projection 状态

**用户行为**

- Goal、模型选择及其他已声明的 Session Projection 随历史和 control 更新；
- 页面重载后得到与实时状态一致的投影；
- 未安装能力时界面隐藏对应功能。

**实现步骤**

1. Opening snapshot 的 `projections` 作为 exact baseline；
2. 接受 control stream 的完整 projection replacement；
3. 接受 durable `session/projection` 类更新，并以官方 watermark 规则决定新旧；
4. 将每个白名单 projection 映射成独立 DTO；
5. 未知 projection 不穿透 Renderer，仅记录 name/version/hash；
6. 投影值与 Conversation 节点分开 Patch，避免重建整段聊天。

**命令/DTO/Patch**：`setProjection(name,value)`；白名单至少包含 `modelSelection`、`goal` 以及后续明确支持的 `todo/plan`。

**边界、错误与恢复**

- baseline 与 live replacement 冲突按 watermark/新 generation 规则处理；
- projection schema 失败只禁用对应产品功能，若它影响节点装配则升级为 Session 兼容错误；
- completed/absent goal 的 UI 语义由 Goal 模块决定。

**安全**：每个 projection 单独 schema；不允许未知对象原样进入 Renderer。

**测试**：历史播种、control 替换、乱序水位、未知/畸形 projection、重连。

**DoD**：相同 cut 的 projection 值确定；功能可用性受 capability 控制。

### CP-010：Generation Reset、缓存与后台 Session

**用户行为**

- Bridge/Harness 重启后当前会话自动校正；
- 切换回来时快速显示最近 Snapshot，再验证官方新状态；
- 长期开多个 Session 不导致持续内存上涨。

**实现步骤**

1. generation 变化时停止旧 projector，递增 sessionEpoch；
2. Renderer 收到 lifecycle reset 后拒绝旧 epoch Patch；
3. Utility LRU 仅缓存稳定 DTO Snapshot，不缓存官方 live Controller 为永久对象；
4. 当前 Session 保持实时优先；后台运行 Session 保留必要 control，文本增量 100–250ms 合并；
5. 非活动且非运行 Session 超过预算时释放 follow/projector；
6. 再打开必须用新 follow opening snapshot 验证缓存，缓存只能作为骨架/短暂占位；
7. 设置每 Session、全局节点、字节、订阅和待处理任务上限。

**命令/DTO/Patch**：`conversation.lifecycle({type:'reset'|'disposed', generation, sessionEpoch})` 与 `ConversationResourceStatsDto`。

**边界、错误与恢复**

- 内存压力触发主动淘汰，不淘汰当前交互 Session；
- Patch 队列越过高水位时丢弃可重建增量并发送 Snapshot，不丢 terminal；
- Renderer 慢消费者可断开该 Port 并重新同步。

**安全**：缓存只在内存；内容不进入 localStorage/IndexedDB；诊断只记录大小与数量。

**测试**：20/100 Session 切换、内存压力、Bridge restart、慢 Renderer、旧 epoch worker/Patch 晚到。

**DoD**：强制 GC 后内存增长在项目预算内；无跨 Session/跨代内容污染。

### CP-011：诊断、差分和可追溯性

**用户行为**

- 遇到会话不兼容时能导出不含内容的诊断信息；
- 正常产品界面不向用户展示内部 raw event。

**实现步骤**

1. 记录 event type、seq range、byte size、projector version、patch count 和 hash；
2. 为每个 Snapshot 计算非加密一致性 fingerprint，仅用于测试/诊断；
3. 测试环境将同 fixture 输入官方 Web 与桌面 projector；
4. 比较节点顺序、身份、状态、Tool pairing、Turn terminal、projection 和 anchor；
5. 允许的外观差异进入 versioned parity ledger；
6. 每次升级生成事件/Schema/节点差异报告。

**命令/DTO/Patch**：`ProjectionDiagnosticDto` 明确禁止正文、Tool 参数、路径、Secret。

**边界、错误与恢复**：hash 不等于语义证明；发现差异必须人工分类，不得自动更新 golden 掩盖回归。

**安全**：诊断包二次脱敏；SessionId 默认散列；任何原文 fixture 必须是合成数据。

**测试**：故意制造差异确认门禁失败；Secret canary 确保诊断零泄漏。

**DoD**：所有支持事件有 fixture；上游升级时未分类差异为零。

## 8. Patch 合并与背压规则

| 类型 | 是否可合并 | 规则 |
|---|---|---|
| 同一文本/Reasoning 节点连续 delta | 可以 | 同一帧最多发布一次最终 changes，durable seq 仍全部推进 |
| 节点 insert/remove | 有条件 | 仅相邻且不跨 anchor/interaction 边界 |
| Tool terminal/result | 不可丢 | 立即 flush |
| Approval/Question | 不可丢 | 立即 flush，并优先于纯文本 delta |
| Error/Turn terminal | 不可丢 | 立即 flush |
| Projection replacement | 同名可取最后值 | 必须保留正确 watermark |
| 历史 prepend | 不和 live insert 混为一项 | 必须带 anchor |
| Generation reset | 不可合并为普通 Patch | 发布全量 Snapshot |

建议限制在公共合同中配置，而不是散落 magic number：

- 单 IPC Patch 建议 ≤256KB；
- 大 content 使用分块/Inspector capability；
- 单 Session 待发送 Patch 队列建议 ≤2MB；
- 达高水位时暂停文本增量，生成最新 Snapshot；
- terminal/interaction 保留专用容量，避免被文本洪泛挤出。

## 9. 安全检查表

- 原始 Session event 不进入 Renderer；
- 官方新增字段不会通过对象 spread 自动穿透；
- Markdown/HTML/ANSI 均未在本模块解释执行；
- Tool 参数、路径、Prompt、响应正文不进入日志；
- 所有数组、字符串、对象深度、节点、帧、缓存都有硬上限；
- 未知非 ignorable 事件不会静默忽略；
- direct Subagent address 同时校验 parent/child/mode；
- Fork、打开路径、Inspector 等 capability 由 Utility 生成；
- SessionId、callId、messageId 只作为数据，不拼成文件路径或 DOM selector；
- dispose/Abort 后任何晚到结果不得发布。

## 10. 测试矩阵

| 类别 | 必测内容 |
|---|---|
| 确定性 | 相同事件多次重放生成完全相同 Snapshot/keys |
| 顺序 | 正常、重复、倒序、gap、部分 overlap、packed rows |
| Surface | append、合法 replace、越界 replace、replace 与分页竞态 |
| Streaming | 高频 text/reasoning、terminal、error、取消 |
| Tool | call/result 正反顺序、orphan、冲突、unknown、巨大输出 |
| Echo | 回执先、event 先、queue、steer、失败、UNKNOWN、dispose |
| 分页 | loadOlder、loadThrough、多目标、无进展、live 并发 |
| Projection | baseline、replacement、水位、畸形、缺 capability |
| 生命周期 | reconnect、Bridge restart、Renderer reload、LRU 淘汰 |
| 属性测试 | 随机事件分块与重放，证明 range 连续和 node identity 唯一 |
| 差分 | 官方 Web vs Desktop 的用户可见语义 |
| 性能 | 1,000 Turn、25k Event、5k Event/s、20 Session 切换 |
| 安全 | 超大/深层 JSON、恶意文本、未知事件、诊断 Secret canary |

## 11. 开发顺序

1. 冻结 Conversation DTO、Fence、Patch、Limits；
2. 完成 Headless export/compat ADR 与最小 parity fixture；
3. 实现 history ingest、packed row range 和 opening snapshot；
4. 实现基础消息/Turn/Reasoning 节点；
5. 实现 live event 与最小 Patch builder；
6. 实现 Tool pairing 与 unknown fallback；
7. 实现 local echo reconcile；
8. 实现 gap detection/repair；
9. 实现 loadOlder/loadThrough 与 prepend anchor；
10. 实现 projection values；
11. 实现 generation reset、LRU、背压和 resource stats；
12. 完成 differential、fuzz、性能和泄漏门禁。

## 12. 验收清单

- [ ] 官方 Client 与 Projector 全在 Utility；Renderer 只见 DTO/Patch；
- [ ] GA 代码不引用上游私有 `src/*`；
- [ ] Opening Snapshot 在完整校验后原子发布；
- [ ] 普通和 packed history 的 seq 范围计算准确；
- [ ] 节点 key 重放稳定且不使用数组下标；
- [ ] 高频 delta 合并但 terminal/interaction/result 永不丢失；
- [ ] Tool call/result 任意到达顺序均正确配对；
- [ ] pending echo 只被同 rpcId durable/queue 状态退休；
- [ ] gap/overlap 时停止发布并 repair，失败后不继续错误状态；
- [ ] prepend 带稳定 anchor，支持 Renderer ≤2px 补偿；
- [ ] generation/sessionEpoch/revision 三重围栏生效；
- [ ] 慢消费者和内存压力不能形成无界队列；
- [ ] 25k events 的 Snapshot、Patch、内存和耗时符合性能预算；
- [ ] 官方 Web 差分无未分类用户可见差异；
- [ ] 所有日志与诊断不包含 Prompt、响应、Tool 参数、路径、Secret；
- [ ] dispose 后 stream、timer、listener、buffer、projector 全部为零。

## 13. 模块完成定义

CP-001～CP-011 必须全部有实现、自动测试和当前上游版本证据；协议目录中所有支持事件必须有显式投影或显式不适用说明；相同 fixture 的增量应用、断线修复与从头重放必须得到相同最终 Snapshot。任何未解决的私有上游导入、未分类投影差异、可能丢 terminal 的背压逻辑或无法证明 dispose 的资源，都属于发布阻塞项。
