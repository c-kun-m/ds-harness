# 11：Conversation Timeline、内容渲染与 Composer 界面

## 1. 文档目标

本文件定义用户每天使用最多的 Conversation 与 Composer 表面。目标是在超长 Session、持续流式输出、复杂 Tool 节点和频繁切换下，仍做到内容正确、滚动稳定、输入即时、可访问且可恢复。

本模块只消费 `09-Conversation投影模块.md` 定义的稳定 Snapshot/Patch 和 `08-Workspace与Session领域模块.md` 定义的命令。Renderer 不接收原始 Harness event，不运行官方 Client，不访问 HTTP/WS、Token、Cookie、文件系统或 Shell。

## 2. 范围与非范围

### 2.1 范围

- Session Header、Conversation 状态面、Timeline 和 Composer 布局；
- 动态高度虚拟列表与 DOM 行数量控制；
- FOLLOWING/DETACHED/PAGING/TURN_JUMP/RESTORING/FORCE_FOLLOW 滚动状态机；
- 历史 prepend 锚定、Session 切换滚动恢复；
- 文本与 Reasoning 流式合帧显示；
- Markdown AST、代码高亮、数学公式、链接、图片和复制；
- Worker 任务协议、缓存、过期结果丢弃；
- Conversation 内搜索结果跳转、Turn 定位、回到底部；
- 消息操作：复制、Fork、打开 Inspector；
- Composer 输入、中文 IME、草稿、发送快捷键；
- `queue`/`steer` delivery mode；
- 模型/reasoning effort 选择；
- 图片附件选择、预览、移除和发送；
- Skills、文件引用和 `@` 建议入口；
- Queue 项编辑/删除/转 steer；
- 当前 Turn Cancel；
- local echo、pending、failed、outcome unknown 表现；
- 键盘、屏幕阅读器、200% zoom、reduced-motion。

### 2.2 非范围

- 不定义 Tool 专属卡片内部，见 `12-工具卡审批问题Subagent与Goal.md`；
- 不实现完整交互式 PTY；Shell 首发仅安全 transcript；
- 不允许 Markdown raw HTML、远程脚本或自动加载外部资源；
- 不允许 Composer 自己判断官方队列或运行真相；
- 不实现多人协作编辑、语音输入、富文本所见即所得；
- V1 不在 Renderer 内做 Session 持久化或离线 Prompt 排队；
- 不对每个 Token 播放动画或发送 `aria-live`。

## 3. 依赖与建议目录

### 3.1 依赖

- `desktop-contracts`：Conversation、Session、Attachment、Catalog、Inspector DTO；
- `conversation-resource`：Snapshot/Patch、loadOlder/loadThrough；
- `command-client`：Prompt、Queue、Cancel、Fork 等稳定命令；
- Design System、Motion System、i18n；
- Worker runtime：Markdown、Shiki、KaTeX、Diff/JSON 按需任务；
- Tool/Interaction Presenter slots。

### 3.2 建议目录

```text
apps/desktop/src/renderer/features/conversation/
  ConversationPage.vue
  SessionHeader.vue
  ConversationTimeline.vue
  ConversationRow.vue
  ConversationEmptyState.vue
  NewContentButton.vue
  VirtualizerAdapter.ts
  scroll/
    scroll-machine.ts
    anchor-controller.ts
    scroll-restoration.ts
  content/
    MarkdownBlock.vue
    ReasoningBlock.vue
    CodeBlock.vue
    MathBlock.vue
    SafeLink.vue
    AttachmentImage.vue
    UnknownNode.vue
  render/
    render-cache.ts
    worker-client.ts
    markdown-policy.ts
  actions/
    MessageActions.vue
    conversation-search.ts

apps/desktop/src/renderer/features/composer/
  Composer.vue
  ComposerEditor.vue
  ComposerToolbar.vue
  ModelPicker.vue
  AttachmentTray.vue
  QueuePanel.vue
  DeliveryModePicker.vue
  suggestions/
  composer-machine.ts
  draft-controller.ts
  submit-controller.ts

packages/render-workers/src/
  worker.ts
  markdown.ts
  highlight.ts
  math.ts
  protocol.ts
```

## 4. 页面组成与状态

```text
ConversationPage
├── SessionHeader
│   ├── title / model / running state
│   └── search / subagent / session actions
├── TimelineViewport（唯一滚动容器）
│   ├── virtual top spacer
│   ├── ConversationRow[]
│   ├── virtual bottom spacer
│   └── new-content / load-state overlays
├── ComposerContextStack
│   ├── Goal / Queue / Interaction status
│   └── Session warnings
└── ComposerHost
    ├── editor / suggestions / attachments
    ├── model / delivery mode
    └── send / stop
```

### 4.1 Timeline 页面状态

```text
LOADING
READY_EMPTY
READY_IDLE
READY_STREAMING
PAGING_EARLIER
RESYNCING_READONLY
FAILED
```

### 4.2 滚动状态机

```text
FOLLOWING
  ├── 用户向上滚动 → DETACHED
  ├── 历史请求 → PAGING_PREPEND
  └── 恢复路由 → RESTORING

DETACHED
  ├── 点“新内容” → FORCE_FOLLOW → FOLLOWING
  ├── 搜索/节点跳转 → TURN_JUMP → DETACHED
  └── 滚至底部阈值 → FOLLOWING

PAGING_PREPEND → 原状态
TURN_JUMP → DETACHED
RESTORING → FOLLOWING 或 DETACHED
```

只有 `FOLLOWING/FORCE_FOLLOW` 可执行自动尾随。历史 prepend、重连 Snapshot、虚拟行回收不触发滚动动画。

### 4.3 Composer 状态机

```text
DISABLED_NO_SESSION
READY_EMPTY / READY_DIRTY
COMPOSING_IME
VALIDATING
SUBMITTING
SUBMITTED
FAILED
OUTCOME_UNKNOWN

READY_* ↔ SUGGESTING
READY_* ↔ ATTACHMENT_READING
READY_* ↔ QUEUE_EDITING
```

当前 Session running 与 Composer 状态正交；运行时可根据 capability 发送 queue/steer，但不存在 capability 时必须禁用。

## 5. View Model 与 Worker 合同

### 5.1 Timeline Row

```ts
type TimelineRowVm = {
  key: string
  kind: ConversationNodeDto['kind']
  estimatedHeight: number
  content: ConversationNodeDto
  visualState: 'stable' | 'streaming' | 'pending' | 'failed' | 'unknown'
  actions: readonly ('copy' | 'fork' | 'inspect')[]
}
```

`TimelineRowVm` 是纯派生值，不持久化，不回写领域状态。

### 5.2 Worker 请求

```ts
type RenderTaskEnvelope = {
  workerEpoch: number
  sessionEpoch: number
  nodeKey: string
  contentRevision: number
  taskId: string
  kind: 'markdown' | 'highlight' | 'math' | 'plain-text-search'
  payload: unknown
}
```

Worker 响应必须带回相同 fence。任一字段落后于当前节点即丢弃，不能覆盖新内容。

### 5.3 渲染结果

Worker 返回自定义、安全、可 structured-clone 的 AST，不返回 HTML 字符串。Renderer 使用受控 Vue components 渲染白名单节点：paragraph、text、emphasis、strong、list、blockquote、code、link、table、math。未知 AST 节点降级为纯文本。

## 6. Conversation 功能规格

### CONV-001：Conversation 页面装配与状态表面

**用户行为**

- 打开 Session 后先看到可预测 skeleton，再原子出现历史；
- 空 Session 显示可操作引导；运行、停止、重连、失败状态清晰；
- 当前 Session 切换时不闪出上一 Session 内容。

**实现步骤**

1. Router 为 SessionAddress 申请 `conversation-resource`；
2. 页面以 route epoch + session epoch 作为 key；
3. Snapshot 完整到达前只显示 skeleton/缓存占位，不挂 Composer 写能力；
4. Snapshot 校验后同帧装配 Header、Timeline、Context Stack、Composer；
5. Patch 只由 Resource Adapter 应用，组件读取 shallow snapshot；
6. RESYNCING 时现有内容只读，写操作依据 Bootstrap/Session capability 禁用；
7. 页面卸载先撤销 Observer/Worker/Tween，再 release resource。

**命令/DTO/Patch**：`conversation.open/closeView`、`ConversationSnapshotDto/PatchDto`。

**边界、错误与恢复**

- Session not found 返回上级路由；
- Projection incompatible 显示局部版本页；
- Snapshot 太大显示有界错误和诊断入口；
- A→B 快速切换的 A 结果由 epoch 丢弃。

**安全**：Header/title/content 全部按纯数据渲染；页面不调用 Preload 原始对象。

**测试**：empty、idle、running、resync、failed、快速切换、组件 throw、dispose。

**DoD**：所有页面状态有截图与 E2E；任何旧 Session 数据不会进入新页面。

### CONV-002：动态高度虚拟列表

**用户行为**

- 1,000 Turn/25k event 的会话仍可顺畅滚动；
- 展开 Tool、图片加载、代码高亮导致高度变化时视图不突然跳跃；
- 键盘焦点项不会因虚拟化无提示消失。

**实现步骤**

1. 以稳定 node key/turn key 作为虚拟项 identity；
2. 设置按 kind 的初始高度估计，挂载后用 ResizeObserver 更新；
3. 高度缓存键包含 node key + presentation revision + viewport width bucket；
4. 只挂载视口与 overscan，目标顶层行数 ≤160；
5. 高度变化时 Anchor Controller 保持当前阅读锚点；FOLLOWING 时保持底部；
6. 展开/折叠前记录 anchor，变化后一次补偿；
7. 聚焦行将进入 sticky overscan；若必须回收，先把焦点转到等价控制点并播报；
8. Session/width/density 变化按策略失效高度缓存。

**命令/DTO/Patch**：Virtualizer 只接 `TimelineRowVm[]`；不读取官方事件。

**边界、错误与恢复**

- ResizeObserver loop 只记录并下一帧重测，禁止同步递归布局；
- 极高单节点采用内部 Inspector/折叠，不让一行无限高；
- key 重复视为投影错误，停止列表并请求 Snapshot。

**安全**：估算不依据执行内容；超大节点只显示受限摘要。

**测试**：动态高度、图片晚到、代码高亮、展开 Tool、键盘焦点、resize、25k event。

**DoD**：挂载顶层行 ≤160；滚动帧 p95 ≤16.7ms；无 key/index 混用。

### CONV-003：自动尾随、用户脱离与滚动接管

**用户行为**

- 位于底部时新内容自动跟随；
- 用户向上阅读后，新内容不抢位置，只显示计数按钮；
- 点击按钮平滑/直接回到底部，用户滚轮或按键可立即打断。

**实现步骤**

1. 用底部距离阈值、用户输入事件和程序化滚动 token 驱动状态机；
2. wheel/touch/pointer/键盘滚动在同一捕获层标记 user intent；
3. FOLLOWING 下 Patch 提交后等待测量，再定位 bottom anchor；
4. DETACHED 记录自脱离以来新增稳定节点数，不统计 token delta；
5. FORCE_FOLLOW 使用可取消滚动；reduced-motion 直接定位；
6. 任意用户输入 kill 当前 scroll tween 并进入 DETACHED；
7. 到达底部阈值且没有用户向上意图后重新 FOLLOWING。

**命令/DTO/Patch**：纯 UI 状态；Patch 的 `reason` 决定是否允许自动跟随。

**边界、错误与恢复**

- 视口 resize、图片高度变化、虚拟测量晚到；
- 程序化 scroll 产生的事件不能误判用户输入；
- 重连 reset 不强制跳底部，恢复旧 anchor。

**安全**：不将模型文本用于 selector；只用 node key map。

**测试**：流式尾随、用户上滑、输入打断、reduced-motion、高度变化、重连。

**DoD**：用户阅读位置不被流式输出抢走；所有 tween 可中止并清理。

### CONV-004：历史 Prepend、滚动恢复和 Turn Jump

**用户行为**

- 顶部加载更早历史后原第一可见内容保持同一位置；
- 切回 Session 恢复到之前节点和相对偏移；
- 搜索/Fork 跳转到未加载 Turn 时自动加载并聚焦。

**实现步骤**

1. 触顶或点击“加载更早”时记录 `anchorKey + offsetTop`；
2. 调用 `conversation.loadOlder`，等待 `history-prepend` Patch；
3. Patch 应用与测量完成后计算新位置差，一次性修正 scrollTop；
4. 重复触发合并，PAGING_PREPEND 期间不发第二请求；
5. 路由离开保存 `{nodeKey,offset,wasFollowing}`；
6. 恢复时若节点未加载，调用 `loadThrough(targetSeq)`；
7. Turn Jump 完成后聚焦语义容器并短暂高亮，保持 DETACHED；
8. anchor 不存在时按最近 durable seq 降级，不使用绝对旧 scrollTop。

**命令/DTO/Patch**：使用 09 的 anchor Patch 和 loadOlder/loadThrough 命令。

**边界、错误与恢复**

- hasEarlier=false 不再触发；
- 页面无进展显示结束/错误；
- Session epoch 改变取消恢复；
- prepend 中宽度变化则等待稳定两帧后补偿。

**安全**：target seq 必须来自投影 capability/search，不接收页面任意巨大数字。

**测试**：多页、动态高度、并发 live tail、切换恢复、目标不存在、≤2px 锚点误差。

**DoD**：参考机 prepend 误差 ≤2px；无多余滚动振荡（基准建议额外 scroll 调用 ≤5）。

### CONV-005：流式文本与 Reasoning 更新调度

**用户行为**

- 文本和 Reasoning 连续显示但输入、滚动不被阻塞；
- 结束、错误、取消、审批等待立即可见；
- 后台 Session 不浪费前台渲染资源。

**实现步骤**

1. Resource Adapter 接收 Patch 后将同 node 的纯文本 changes 合并到下一 animation frame；
2. 当前可见 Session 每帧最多 commit 一次；后台 Session 100–250ms 合批；
3. terminal/error/interaction/tool result 绕过延迟并 flush 之前文本；
4. DOM 只更新变化的尾部 node，历史节点引用保持不变；
5. Markdown 增量只重新解析受影响的尾部 block；
6. 完成时运行一次全量 parse 校正；
7. 页面隐藏时保持领域数据接收，但暂停非必要测量/动画。

**命令/DTO/Patch**：`ConversationPatchDto.reason` 和 node `contentRevision/status`。

**边界、错误与恢复**

- 同帧 terminal 与 delta 保证 delta 先应用；
- Patch backlog 达高水位时请求 Snapshot；
- Worker 晚到由 revision fence 丢弃。

**安全**：纯文本 delta 不拼 `innerHTML`；不把流内容写 Performance label。

**测试**：5k event/s、终态优先、后台/前台切换、tab hidden、worker 延迟。

**DoD**：event-to-visible-tail p95 ≤100ms；流式主线程任务 p95 ≤8ms；终态不丢。

### CONV-006：Markdown、安全链接与基础富内容

**用户行为**

- 支持段落、列表、引用、表格、链接、代码、数学和图片；
- 点击外链先按安全策略交由系统浏览器；
- 不支持/畸形内容以纯文本安全显示。

**实现步骤**

1. Markdown 文本交 Worker 解析白名单 AST；
2. 禁用 raw HTML、内联事件、iframe、style、script 和任意组件语法；
3. Renderer 用静态 Vue component map 渲染 AST；
4. URL 解析后仅允许明确协议，外链发 `system.openExternal` Intent；
5. 远程图片默认不加载，展示域名与用户确认；Session attachment 使用受控 Blob URL；
6. 表格/长行使用局部横向滚动；
7. 解析失败使用原始纯文本 fallback，错误隔离到单 block。

**命令/DTO/Patch**：`SafeMarkdownAstDto`；链接 Intent 只有规范化 URL，不含执行代码。

**边界、错误与恢复**

- 未闭合 Markdown 在流式阶段允许临时 AST；final 后校正；
- 极深嵌套/巨型表格触发 budget fallback；
- Blob URL 节点卸载时 revoke。

**安全**：通过 OWASP XSS、`javascript:`、`data:text/html`、恶意 SVG、Unicode URL 混淆测试。

**测试**：全部白名单节点、raw HTML、恶意链接、超深嵌套、流式未闭合、fallback。

**DoD**：不存在 `v-html` 渲染模型内容；安全 Corpus 全通过。

### CONV-007：代码高亮、数学与大内容 Worker

**用户行为**

- 可复制代码、查看语言；高亮或公式加载失败时仍能读纯文本；
- 大代码/大 JSON 不冻结窗口。

**实现步骤**

1. Code block 首屏先纯文本，进入视口后 lazy import Shiki grammar；
2. 高亮任务发送 Worker，key 为 node/content revision/language/theme；
3. 只接受白名单 token span，不接收 HTML；
4. 数学用 KaTeX 安全选项，流式未闭合时延迟；
5. 超过 inline budget 的内容 head/tail 摘要，完整内容打开 Inspector；
6. Worker pool 有并发、队列、单任务时限和 LRU cache；
7. 主题切换只使相关 render cache 失效。

**命令/DTO/Patch**：`HighlightTokensDto`、`MathTreeDto`，均带 task fence。

**边界、错误与恢复**

- 未知语言回纯文本；worker crash 重启一次，之后局部降级；
- 任务淘汰/取消不显示错误；晚到结果丢弃。

**安全**：限制语言名、源码长度、token 数；Worker 无 Node、网络和文件能力。

**测试**：未知语言、主题切换、worker crash、超大代码、late result、数学恶意宏。

**DoD**：重型解析无 >50ms 主线程任务；Renderer 首屏包不静态包含全部 grammar。

### CONV-008：消息操作、搜索与 Inspector 导航

**用户行为**

- 可复制当前消息纯文本、Fork 合法 Turn、查看完整 Tool/内容；
- 会话搜索可跳转到已加载或更早的结果；
- 操作菜单支持键盘且不会覆盖正文。

**实现步骤**

1. 操作由 node `capabilities` 决定，不由 kind 自行猜测；
2. Copy 通过受控 Clipboard Intent，只复制用户明确选择的内容；
3. Fork 使用 `forkAtSeq` 调用 SES-004；
4. Inspect 发 `InspectorIntent {kind,nodeKey,sessionEpoch}`；
5. 搜索输入在 Worker 对已加载纯文本索引；全 Session 搜索调用官方 Session Search，再 `loadThrough`；
6. 结果携 query revision，晚到丢弃；
7. 跳转后设置临时 highlight，不修改 Conversation node。

**命令/DTO/Patch**：`MessageActionIntent`、`SearchResultDto`、`InspectorIntent`。

**边界、错误与恢复**

- 内容仍 streaming 时 Copy 标记当前快照；
- Fork seq 不再合法时显示状态陈旧并 resync；
- Inspector payload 不存在时显示 fallback。

**安全**：Clipboard 默认只写不读；外部链接和打开文件必须经 Main capability；搜索词不日志。

**测试**：capability gate、copy、Fork 竞态、搜索 revision、未加载跳转、键盘菜单。

**DoD**：不存在由 Renderer 文本推断出的高权限动作；所有操作可追溯到稳定 ID。

### CONV-009：状态播报、无障碍与视觉稳定性

**用户行为**

- 屏幕阅读器能理解消息作者、状态、Tool 和交互边界；
- 流式输出不会每个 Token 打断用户；
- reduced-motion、高对比度和 200% zoom 下功能完整。

**实现步骤**

1. Timeline 使用语义 list/feed，节点提供可读 heading/label；
2. `aria-live` 只播报“回答开始/完成/失败/等待操作/新消息数量”；
3. streaming 文本区域默认 `aria-live=off`；
4. Reasoning、Tool、长代码折叠按钮有 expanded/controls；
5. 焦点跳转只发生于明确用户动作，后台 Patch 不抢焦点；
6. forced-colors 使用系统颜色和非颜色状态符号；
7. reduced-motion 时所有过渡直接终态；
8. 200% zoom 时单列布局保持 Composer 和 Stop 可达。

**命令/DTO/Patch**：本地 `AnnouncementEvent` 由语义状态生成，不包含模型全文。

**边界、错误与恢复**：大量 terminal 同时到达时合并播报；虚拟化回收聚焦节点先安全转移焦点。

**安全**：不把未经限制的模型文本自动播报；防止超长内容造成辅助技术拒绝服务。

**测试**：axe、键盘、NVDA、200% zoom、forced-colors、reduced-motion、流式播报次数。

**DoD**：关键会话流程可不使用鼠标完成；无严重 axe 问题。

## 7. Composer 功能规格

### COMP-001：编辑器、IME 与输入规则

**用户行为**

- 支持多行纯文本、中文/日文/韩文 IME、撤销重做和粘贴；
- Enter/快捷键行为可配置，IME 候选确认不会误发送；
- 空文本且无附件不能发送。

**实现步骤**

1. V1 使用受控 textarea 或经过严格选择的纯文本 editor，不使用 HTML contenteditable 作为数据真源；
2. 跟踪 `compositionstart/end`，composing 时 Enter 永不提交；
3. 提交前按 Unicode 保留内容，仅规范化项目规定的换行，不 trim 用户有意义正文；
4. 输入长度以 code points/UTF-8 bytes 双重限额；
5. 粘贴默认纯文本；图片粘贴进入附件管线；
6. 发送快捷键通过统一 keymap；
7. disabled/read-only 状态保留可复制，不允许输入。

**命令/DTO/Patch**：本地 `ComposerTextState`；提交时构造 `PromptCommandDto`。

**边界、错误与恢复**

- compositionend 与 keydown 同帧按浏览器测试结果 fencing；
- 超限显示剩余量和字节原因；
- 粘贴巨大文本在插入前拒绝/裁剪必须由用户确认。

**安全**：始终当纯文本；不解析粘贴 HTML；禁止隐藏字符执行行为。

**测试**：中文 IME、emoji、组合字符、CRLF、撤销、粘贴 HTML、大文本、快捷键。

**DoD**：IME 主流程不误发；所有输入限制与 Bridge Schema 一致。

### COMP-002：Session 独立草稿与恢复

**用户行为**

- 切换 Session 后草稿各自保留；发送成功后只清除对应草稿；
- 应用异常重启可按用户设置恢复草稿；
- 删除/归档不可访问 Session 后不会无限积累草稿。

**实现步骤**

1. 草稿 key 使用 canonical SessionAddress；
2. 文本更新 debounce 写 UI Store，界面本身即时更新；
3. 附件只保存 opaque handle metadata 和过期时间；
4. Prompt 确认被官方接受后，若当前 revision 未变化才清空提交版本；
5. 用户提交后继续输入时，新文本不得被旧回执清空；
6. 启动后清理过期/不存在 Session 草稿；
7. 提供关闭草稿持久化和一键清理。

**命令/DTO/Patch**：`ComposerDraft {revision,text,attachments,deliveryPreference}`，不含模型历史。

**边界、错误与恢复**：存储失败不阻止输入；handle 过期要求重选；UNKNOWN 保留草稿提交副本供用户决定。

**安全**：草稿可能敏感，不进入日志；严禁保存 Secret 字段和文件二进制。

**测试**：A/B 切换、提交后继续输入、失败、UNKNOWN、重启、存储损坏、过期附件。

**DoD**：任何异步回执只影响它提交的 draft revision；不跨 Session 清空。

### COMP-003：可用性、运行模式与 Delivery Mode

**用户行为**

- 普通空闲 Session 直接发送；运行中可选择 Queue 或 Steer；
- one-shot Subagent 永远只读；continuable Subagent 按 parent/running capability 决定可输入/Stop；
- 重连/版本错误时 Composer 给出原因而不是无响应。

**实现步骤**

1. `ComposerPolicy` 只从 SessionAddress、control DTO、capabilities、connection phase 派生；
2. 输出 `canType/canSend/canStop/deliveryModes/readOnlyReason`；
3. running 普通 Session 默认使用用户上次明确选择或产品默认 queue；
4. steer 不可用时自动隐藏，不把旧 preference 强行提交；
5. one-shot child 使用 read-only presenter；
6. continuable child Prompt 路由由 Utility 根据地址调用官方 subagent API；
7. generation 变化立即重新计算并取消尚未 dispatch 的提交。

**命令/DTO/Patch**：`ComposerPolicyDto` 可由 Renderer纯函数产生，但其输入 capability 来自 Utility。

**边界、错误与恢复**：parent 不可用、child 仍 running、Session cold、control baseline 未到、interaction pending。

**安全**：Renderer 不能通过修改 mode 绕过 capability，Bridge 必须二次验证。

**测试**：所有地址/运行/连接/capability 组合的 table-driven 测试。

**DoD**：策略矩阵无遗漏；禁用状态有可读原因且服务器再次校验。

### COMP-004：模型与 Reasoning Effort 选择器

**用户行为**

- 查看 Provider 分组、模型说明、当前/下一请求选择；
- 局部 Provider 失败仍可选择其他模型；
- 运行中选择明确提示只影响后续请求。

**实现步骤**

1. 打开选择器时读取缓存的 `ModelCatalogDto`，过期则刷新；
2. 搜索只在本地对 label/description；
3. 选择模型后根据其 reasoning metadata 重置/保留合法 effort；
4. 调用 SES-005 命令；
5. pending 时仅锁当前选择器；
6. 最终状态等待官方 model projection；
7. capability/目录变化时关闭已失效选项。

**命令/DTO/Patch**：`session.modelCatalog/selectModel`、`ModelCatalogDto`。

**边界、错误与恢复**：空 provider、局部 failure、模型下线、stale catalog、选择 UNKNOWN。

**安全**：Provider failure 文本限长、纯文本；任何 credential 不进入目录 DTO。

**测试**：搜索、键盘、局部失败、effort、运行中选择、目录刷新竞态。

**DoD**：官方 selection 是唯一确认来源；无模型时仍可进入 Settings 修复。

### COMP-005：附件选择、拖放、预览与提交

**用户行为**

- 可选择、粘贴或拖放允许的图片；发送前预览、移除、查看错误；
- 读取中显示进度，可取消；超限在提交前阻止。

**实现步骤**

1. Picker/drop/paste 全部进入统一 `AttachmentDraftController`；
2. Renderer 只把 DataTransfer token 交 Preload，Main 生成 FileHandle；
3. 读取/魔数/尺寸/数量校验由 Main/Utility 完成；
4. 返回安全 thumbnail Blob channel 与 metadata；
5. Composer 校验总 payload 后构造 image parts；
6. 提交成功释放临时 bytes；失败按 TTL 保留重试能力；
7. remove/dispose 时 revoke URL、Abort read、释放 handle。

**命令/DTO/Patch**：SES-009 定义的 `AttachmentDraftDto`；不得传永久路径。

**边界、错误与恢复**：同文件重复、读取时变化、伪 MIME、0 byte、超限、Session 切换、handle 过期。

**安全**：默认拒绝 SVG/HTML/可执行；外部图片 URL 不作为本地附件读取；文件名纯文本。

**测试**：picker/drop/paste、取消、超限、恶意类型、Blob URL/handle 泄漏。

**DoD**：用户未授权文件不可读；所有附件资源在结束后可证明释放。

### COMP-006：Skills、文件引用与 `@` 建议

**用户行为**

- 输入 `/`、文件触发符、`@` 后出现键盘可操作建议；
- 选择 Skill 插入 `/name `，选择 Subagent 只插入 literal `@label `；
- 建议加载失败不影响普通输入。

**实现步骤**

1. 输入解析器仅识别光标附近当前 trigger，不解释为执行命令；
2. 为每次查询分配 queryRevision + sessionEpoch；
3. `/` 调 SES-010 skills，文件来源调 fileReferences，`@` 使用 Utility 提供的当前运行 child DTO；
4. 候选按稳定 ID 去重，分组和排序确定；
5. Arrow/Enter/Escape/Tab 遵循统一 combobox 交互；
6. 选择结果替换当前 trigger range；
7. Session/epoch/光标上下文变化立即丢弃结果。

**命令/DTO/Patch**：`SuggestionRequest/ResultDto`，候选只含文本与 inert metadata。

**边界、错误与恢复**：同名 Skill/Subagent、重命名、空列表、网络错误、IME composing 时不打开错误触发。

**安全**：候选不能带 HTML、命令回调或动态 import；`@label` 不获得隐式控制能力。

**测试**：三类来源、查询竞态、键盘、IME、同名、Session 切换、错误 fallback。

**DoD**：建议只是输入辅助；不存在点击候选直接执行工具/子 Agent 的路径。

### COMP-007：发送、本地回显与不确定结果

**用户行为**

- 点击发送后即时看到内容；
- 明确失败可编辑后手动重试；
- 结果未知时保留提示并等待官方状态，不产生重复消息。

**实现步骤**

1. 捕获当前 draft revision、delivery mode、model context、attachments；
2. 进入 VALIDATING，执行与合同一致的本地校验；
3. 生成 requestId，调用 SES-006；
4. pending submission Patch 驱动 local echo，组件不自行插入 durable node；
5. accepted 后清空已提交 revision，若用户已继续输入则只移除提交前缀/保留新 revision；
6. rejected 显示字段/全局错误并保留 draft；
7. outcome unknown 显示“可能已发送”，等待 rpcId durable/queue reconcile；
8. 用户主动重发必须产生新 requestId并明确可能重复风险。

**命令/DTO/Patch**：`PromptCommandDto`、`PendingSubmissionDto`、`CommandOutcome`。

**边界、错误与恢复**：双击、Enter/key repeat、事件先于回执、accepted 后断线、附件过期、model unavailable。

**安全**：正文/附件不进入日志；Bridge 再次校验 payload/capability。

**测试**：同帧 echo、各种竞态、UNKNOWN、提交后继续输入、重复点击、重连。

**DoD**：一 requestId 最多一个 durable 用户消息；任何失败都不静默丢草稿。

### COMP-008：Queue 面板与待处理 Prompt 修改

**用户行为**

- 可查看 queue/steering/context placement；编辑自己的待处理内容、删除、转 steer；
- Agent 已消费项目时自动采用新状态并说明操作过期。

**实现步骤**

1. QueuePanel 只读 `SessionControlDto.queue`；
2. item key 使用官方 itemId，rpcId 用于标记 local echo 对账；
3. 编辑使用临时 editor，不直接修改 Snapshot；
4. 提交调用 SES-007 的 edit/remove/steer；
5. item 级 single-flight；
6. 成功等待 control replacement，失败恢复权威 item；
7. item 消失时关闭 editor并播报“已处理”。

**命令/DTO/Patch**：QueueItemDto 与固定命令，无通用 action 字符串。

**边界、错误与恢复**：消费竞态、重连 baseline、重复 remove、steer unavailable、未知结果。

**安全**：编辑内容走 Prompt 同一 Schema；不展示未知 JSON 为 HTML。

**测试**：全部 action、消费竞态、并发、键盘、重连、echo 对账。

**DoD**：本地 queue 不成为真源；任何操作失败后与 control snapshot 一致。

### COMP-009：停止当前 Turn

**用户行为**

- Session 运行时 Send 区显示 Stop；点击后进入“正在停止”；
- 队列保留，停止完成后 Composer 根据最新状态恢复；
- continuable Subagent 的 Stop 调正确的 parent-routed interrupt。

**实现步骤**

1. Stop 可见性来自 `ComposerPolicy.canStop`；
2. 普通 Session 调 `session.cancelTurn`；Subagent 调 interaction 模块定义的 interrupt；
3. command single-flight，重复点击无第二请求；
4. accepted 只显示 stopping，不直接把 running 改 false；
5. 等官方 control/Conversation terminal；
6. 超时提示“停止仍在处理中”，允许诊断，不自动强杀 Harness；
7. generation 变化后重新同步状态。

**命令/DTO/Patch**：普通 Session 使用 SES-008；Subagent 使用 SUB-005。

**边界、错误与恢复**：自然结束竞态、Tool 正执行、断线 UNKNOWN、parent 不可用。

**安全**：地址和权限在 Utility 再验证；Stop 不暴露进程 kill。

**测试**：文本/Tool、自然结束、重复、Queue 保留、普通/Subagent、断线。

**DoD**：UI 与官方终态一致；Stop 永不清空 Queue 或强杀 Runtime。

### COMP-010：Composer 无障碍、焦点与移动/窄屏布局

**用户行为**

- 纯键盘完成输入、模型选择、附件、建议、Queue 和 Stop；
- 错误与发送状态被适度播报；
- 200% zoom/窄屏下输入和主按钮始终可达。

**实现步骤**

1. Editor、toolbar、suggestion list、attachment tray 使用正确 label/description；
2. Suggestion 实现标准 combobox/listbox focus 模型；
3. 发送失败聚焦错误摘要或保持 editor 焦点并关联 `aria-describedby`；
4. 发送成功不抢焦点，继续留在 editor；
5. Modal/Picker 关闭恢复触发控件；
6. 窄屏 toolbar 折叠为可访问 menu，Send/Stop 不隐藏；
7. 状态播报只覆盖提交成功/失败/未知和 Stop 完成。

**命令/DTO/Patch**：本地 UI 行为，不向 Harness 发送额外数据。

**边界、错误与恢复**：多错误合并、Suggestion 异步关闭、虚拟键盘 resize、IME。

**安全**：不把 Prompt 全文放 aria label/遥测；辅助文案限长。

**测试**：axe、Tab 顺序、NVDA、IME、200% zoom、窄屏、reduced-motion。

**DoD**：核心 Composer 流程无需鼠标；无严重 A11y 问题。

## 8. 性能预算

| 指标 | 发布门槛 |
|---|---:|
| 本地 Echo 可见 | p95 ≤ 1 帧 |
| Harness Patch 到可见 Tail | p95 ≤100ms，p99 ≤250ms |
| 流式稳态主线程任务 | p95 ≤8ms |
| 滚动帧耗时 | p95 ≤16.7ms |
| 稳态 Long Task | 不允许 >100ms |
| 1,000 Turn/25k event 顶层挂载行 | ≤160 |
| Prepend 锚点误差 | ≤2px |
| 非首屏重型模块 | 必须 lazy load |
| 20 次 Session 切换 | Worker/Observer/Listener 无增长 |

## 9. 开发顺序

1. 页面状态、TimelineRowVm 和 Worker protocol；
2. 静态消息列表和基础纯文本 fallback；
3. 动态高度 Virtualizer；
4. 滚动状态机和尾随；
5. Prepend/restore/jump anchor；
6. 流式 Patch frame batching；
7. 安全 Markdown AST Worker；
8. Shiki/KaTeX/图片/Inspector lazy rendering；
9. Composer editor、IME 和草稿；
10. Model、delivery mode、send/local echo；
11. 附件和 suggestions；
12. Queue、Cancel、搜索、Fork；
13. A11y、reduced-motion、性能、泄漏与 E2E。

## 10. 验收清单

- [ ] Conversation 页面只消费稳定 DTO/Patch；
- [ ] 1,000 Turn/25k event 顶层 DOM 行 ≤160；
- [ ] node key/高度缓存不使用数组下标；
- [ ] FOLLOWING/DETACHED 等所有滚动状态有自动测试；
- [ ] 用户滚动立即接管并取消自动滚动；
- [ ] 历史 prepend 锚点误差 ≤2px；
- [ ] Session 恢复使用 nodeKey+offset，不依赖绝对 scrollTop；
- [ ] delta 合帧但 terminal/error/interaction 不延迟丢失；
- [ ] Markdown 不使用 `v-html`，raw HTML 永远禁用；
- [ ] Worker 结果携带完整 fence，晚到结果丢弃；
- [ ] Shiki/KaTeX/重型 Presenter 按需加载；
- [ ] 外链、附件图片和复制都经过受控 Intent；
- [ ] 中文 IME 不误发送；
- [ ] 草稿按完整 SessionAddress 隔离；
- [ ] 发送竞态不会清除用户后续输入；
- [ ] Prompt UNKNOWN 不自动重发；
- [ ] Queue 以 control Snapshot 为真源；
- [ ] Stop 不清 Queue、不伪造终态；
- [ ] reduced-motion、200% zoom、forced-colors、键盘、NVDA 通过；
- [ ] 20 次切换后 Worker、Observer、Blob URL、Listener、Tween 回到基线。

## 11. 模块完成定义

CONV-001～CONV-009 与 COMP-001～COMP-010 全部实现并通过单元、组件、视觉、真实 Electron E2E、性能、泄漏、安全和无障碍门禁；相同 Conversation Snapshot 在 Reload 后呈现相同语义；长会话、流式、分页、附件和 IME 均不能破坏输入响应或状态正确性。任何依赖每 Token 动画、`v-html`、绝对 scrollTop 恢复、数组下标 key 或页面自行解释 raw event 的实现都不满足完成定义。
