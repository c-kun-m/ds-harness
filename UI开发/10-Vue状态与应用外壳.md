# 10：Vue 状态、Renderer Adapter 与应用外壳

## 1. 文档目标

本文件定义 Vue Renderer 如何安全地消费 Utility Process 发布的稳定 DTO/Patch，以及应用启动、路由、布局、状态页、错误隔离、资源释放和 UI 状态持久化的完整实现方案。

核心边界只有一条解释：

> Harness 领域状态的所有者在 Utility Process；Renderer 只持有当前视图所需的可丢弃副本。Pinia 负责 UI 意图和偏好，不重新实现 Workspace、Session、Conversation、Queue、Goal 或 Connection 状态机。

Renderer 被重载、崩溃或缓存全部清除后，必须能只依赖 Main/Bridge/Utility 的 Snapshot 恢复业务界面。

## 2. 范围与非范围

### 2.1 范围

- Vue 3、TypeScript、Vite、Vue Router、Pinia 的运行骨架；
- Preload Desktop API 的唯一接入层；
- Snapshot/Patch 的浅响应式适配与原子提交；
- generation、epoch、revision 校验；
- 启动路由、Workspace/Session 路由和 Settings 路由；
- Sidebar、Header、Content、Inspector 三栏应用外壳；
- 启动、同步、断线、降级、崩溃、升级不兼容等全局状态页；
- 路由恢复、窗口布局、面板状态、最近打开项；
- Session 级草稿和滚动锚点的 UI 状态容器；
- 错误边界、组件级恢复、命令 pending/error 反馈；
- 全局快捷键、命令面板入口和焦点路由；
- 生命周期、订阅、Timer、Worker、GSAP 清理接口；
- Renderer 性能与资源诊断。

### 2.2 非范围

- 不启动 Harness、不持有 Cookie/Token；
- 不直接执行 HTTP、WebSocket、文件系统或 Shell；
- 不导入任何 `@deepseek-ai/dsh-*`、Cordis、Electron Main API；
- 不解释 Session 原始事件；
- 不在 Pinia 持久化 Transcript 或官方 Settings Secret；
- 不定义 Timeline/Composer 内部细节，见 `11-Conversation与Composer界面.md`；
- 不定义 Design Token 和 GSAP 动画规范，见 `13-设置凭据设计系统与GSAP.md`；
- V1 不做多个 BrowserWindow 同时控制同一 Session。

## 3. 依赖和建议目录

### 3.1 依赖

- 前置：Desktop Contracts、Preload API、Bridge 生命周期、Workspace/Session DTO、Conversation Snapshot/Patch；
- 同步：Design System primitives、i18n、A11y 基线；
- 下游：Conversation、Composer、Tool、Approval、Settings 页面；
- 测试：Preload fake、MessagePort fake、Vue Test Utils、Playwright Electron。

### 3.2 建议目录

```text
apps/desktop/src/renderer/
  main.ts
  App.vue
  router/
    index.ts
    routes.ts
    guards.ts
    route-codec.ts
  bridge/
    desktop-api.ts
    resource-channel.ts
    command-client.ts
    patch-fence.ts
  state/
    bootstrap.store.ts
    navigation.store.ts
    layout.store.ts
    preferences.store.ts
    drafts.store.ts
    notices.store.ts
    persistence.ts
  resources/
    workspace-resource.ts
    session-directory-resource.ts
    conversation-resource.ts
    interaction-resource.ts
    settings-resource.ts
  shell/
    AppBootstrapGate.vue
    AppFrame.vue
    PrimarySidebar.vue
    SessionHeader.vue
    ContentOutlet.vue
    InspectorHost.vue
    StatusCenter.vue
    CommandPalette.vue
  errors/
    GlobalErrorBoundary.vue
    FeatureErrorBoundary.vue
    error-presenter.ts
  lifecycle/
    scope.ts
    visibility.ts
    resource-registry.ts
```

## 4. 状态所有权

| 状态 | 唯一权威 | Renderer 表现形式 | 是否持久化 |
|---|---|---|---|
| Runtime/Bridge connection | Main/Utility | 只读 `RuntimeHealthDto` | 否 |
| Workspace | 官方 Controller/Utility | `shallowRef<WorkspaceSnapshotDto>` | 否 |
| Session 目录 | 官方 Controller/Utility | `shallowRef<SessionDirectorySnapshotDto>` | 否 |
| Conversation | Utility Projector | `shallowRef<ConversationSnapshotDto>` | 否 |
| Queue/Jobs/运行状态 | 官方 control stream/Utility | 只读 DTO | 否 |
| Approval/Question | Utility Interaction Coordinator | 只读 DTO + command pending | 否 |
| 当前路由 | Vue Router | route + navigation store | 仅最后安全路由 |
| 面板宽度/折叠 | Pinia layout store | 数值与枚举 | 是 |
| 主题/语言/motion | Pinia preferences store | 枚举 | 是 |
| Composer 草稿 | Pinia drafts store | 按 SessionAddress 的纯文本/handle metadata | 可选本地持久化，绝不含 Secret |
| Scroll anchor | UI view cache | `{nodeKey,offset}` | 可选短期 |
| Command pending | component/command client | commandId→状态 | 否 |
| GSAP、Observer、Worker | 组件 effect scope | 非响应式资源 | 否 |

禁止事项：

- 将官方 Controller、Class、Map、AbortController、WebSocket 放进 Pinia；
- 对 25k event 的大对象使用 Vue deep reactive；
- 在 localStorage/IndexedDB 保存完整 Conversation、Tool payload、Prompt 历史或 Credential；
- 用 Toast 成功状态替代官方 Patch；
- 由多个 Store 各自订阅同一底层 MessagePort。

## 5. 应用启动状态机

```text
BOOTSTRAPPING
  → SHELL_READY
  → RUNTIME_STARTING
  → BRIDGE_CONNECTING
  → DOMAIN_SYNCING
  → INTERACTIVE

RUNTIME_STARTING/BRIDGE_CONNECTING/DOMAIN_SYNCING
  → DEGRADED / RECOVERY_REQUIRED / UPDATE_REQUIRED

INTERACTIVE → RECONNECTING → DOMAIN_SYNCING → INTERACTIVE
任意状态 → FATAL_RENDERER_ERROR
```

各状态允许的界面：

| 状态 | 可阅读旧数据 | 可发送命令 | 界面 |
|---|---:|---:|---|
| BOOTSTRAPPING | 否 | 否 | 最小品牌骨架，不播放长动画 |
| RUNTIME_STARTING | 否 | 仅取消启动/诊断 | 启动进度与阶段 |
| DOMAIN_SYNCING | 可显示 skeleton | 否 | Workspace/Session 同步提示 |
| INTERACTIVE | 是 | 按 capability | 正常应用 |
| RECONNECTING | 是 | 默认禁用写操作 | 顶部断线条与重连进度 |
| DEGRADED | 部分 | 只允许明确安全动作 | 局部降级说明 |
| UPDATE_REQUIRED | 否 | 仅更新/退出/诊断 | 版本不兼容页 |
| RECOVERY_REQUIRED | 可选 | 仅恢复动作 | 崩溃循环/数据预检页 |

## 6. Renderer Resource 合同

所有领域资源实现相同接口：

```ts
type ResourceView<TSnapshot> = {
  phase: 'idle' | 'subscribing' | 'ready' | 'resyncing' | 'failed' | 'disposed'
  snapshot: ShallowRef<TSnapshot | null>
  error: ShallowRef<DesktopError | null>
  resync(): Promise<void>
  dispose(): void
}
```

订阅帧统一为：

```ts
type ResourceEnvelope<T> = {
  protocolVersion: number
  resource: string
  generation: number
  epoch: number
  requestId?: string
  payload: T
}
```

每个 Resource 只有一个 `PatchFence`：

- Snapshot 可在新 generation/epoch 下原子替换；
- Patch 必须满足 generation/epoch 相同、`fromRevision === currentRevision`；
- 校验失败时不尝试“尽量应用”，进入 `resyncing`；
- `dispose()` 后 Envelope 即便晚到也不能写入 ref。

## 7. 功能规格

### VUE-001：Renderer Bootstrap 与协议握手

**用户行为**

- 启动时看到明确阶段，不会出现空白白屏；
- Runtime 或协议不兼容时得到可执行的更新/诊断动作；
- 重载 Renderer 不会重启正在运行的 Harness Session。

**实现步骤**

1. `main.ts` 只安装 error trap、i18n、Pinia、Router 和 Desktop API wrapper；
2. 调用 `desktop.bootstrap.getSnapshot()` 获取 app/runtime/protocol/capability 状态；
3. 先校验 Desktop API protocol，再订阅 lifecycle；
4. Bootstrap Gate 根据状态机决定渲染启动页或 AppFrame；
5. `DOMAIN_SYNCING` 并行建立 Workspace 与 Session Directory resource；
6. 两者 baseline 完成后进入 INTERACTIVE；非关键资源可随后 lazy load；
7. Renderer reload 只重建订阅，并用新 clientInstanceId 与旧 Port 隔离。

**命令/DTO/Patch**

- `bootstrap.getSnapshot()`；
- `bootstrap.subscribe()`；
- `BootstrapSnapshotDto`、`CapabilitySetDto`、`RuntimeHealthDto`。

**边界、错误与恢复**

- Preload API 缺失：Fatal Page；
- 协议 major 不匹配：UPDATE_REQUIRED；
- 可选 capability 缺失：局部功能关闭，不阻塞启动；
- baseline 超时：展示 retry/restart/diagnostics，不循环刷新。

**安全**

- Bootstrap DTO 运行时校验；
- Renderer 不接收端口、Token、Cookie、真实 runtime 路径或环境变量；
- 生产环境关闭 Vue devtools 和 source map 暴露策略按发布文档执行。

**测试**

- 每个启动状态、协议错配、Preload 缺失、Bridge 重启、Renderer reload；
- 测试状态变化不会重复安装全局 listener。

**DoD**

- 从进程启动到 INTERACTIVE 有确定状态链；
- 所有失败都有恢复动作；
- Reload 后运行中的 Session 不被取消。

### VUE-002：Snapshot/Patch 浅响应式适配

**用户行为**

- Workspace、Session 和 Conversation 更新即时且无中间撕裂；
- 断线恢复时不会看到旧数据混入；
- 大会话仍保持输入与滚动响应。

**实现步骤**

1. 对每个 Resource 使用 `shallowRef` 保存不可变 Snapshot；
2. DTO 在 Preload 和 Renderer 边界再做一次 schema 校验；
3. Patch 在非响应式 working copy 上完整验证和应用；
4. 成功后一次赋值新 Snapshot，不逐字段触发深层 reactive；
5. 大数组使用结构共享：未变节点保留引用；
6. 在一次 microtask/frame 中批量提交同资源可安全合并的 Patch；
7. revision gap 触发 `resync()`，期间保持最后已验证 Snapshot 只读。

**命令/DTO/Patch**：`createResourceAdapter<TSnapshot,TPatch>({validateSnapshot,applyPatch})`。

**边界、错误与恢复**

- Patch 中任一操作非法则整批拒绝；
- 更新不存在 key、重复 insert、越界 replacement 均要求 Snapshot；
- 旧 generation/epoch 静默丢弃但增加 diagnostic counter。

**安全**

- DTO 只包含 plain data；拒绝 prototype、函数、Symbol、BigInt 和非有限数；
- 限制 Patch operations、字符串和总字节数。

**测试**

- 原子失败、结构共享、gap、旧代、重复 Patch、25k nodes 性能；
- 验证没有 Vue deep proxy 大型节点对象。

**DoD**

- Patch 应用要么全成要么全不成；
- 25k event 场景满足主线程预算；
- Resource dispose 后 ref 不再变化。

### VUE-003：Pinia Store 边界与本地持久化

**用户行为**

- 主题、语言、面板布局和草稿在安全范围内恢复；
- 清除缓存不会丢失 Harness Session；
- 切换 Session 后各自草稿不串线。

**实现步骤**

1. 建立 `bootstrap/navigation/layout/preferences/drafts/notices` 六类 UI Store；
2. 领域 Resource 通过 composable 注入，不复制进 Pinia；
3. 持久化只对白名单字段逐项编码并带 `uiStateVersion`；
4. 版本升级用纯函数 migration；失败则备份损坏值并回到默认；
5. drafts key 使用 canonical SessionAddress key，不只用 childSessionId；
6. 附件 draft 只保存短期 opaque handle metadata，不保存二进制/真实路径；
7. 提供“清除 UI 状态”和“删除 Harness 数据”两个完全分离的入口。

**命令/DTO/Patch**：`UiPersistenceDocument` 明确白名单；任何新增字段必须通过隐私审查。

**边界、错误与恢复**

- localStorage 不可用、配额满、JSON 损坏不能阻塞 App；
- Session 已不存在时清理其陈旧草稿；
- 多标签/多窗口不支持，检测到第二 owner 时拒绝写。

**安全**

- 禁止 Secret、Prompt 历史、响应、Tool payload、Cookie、Token、完整路径进入持久化；
- 草稿可能敏感，默认仅本机且提供关闭持久化选项；正式策略可改为 OS 加密存储。

**测试**

- schema migration、损坏数据、配额错误、SessionAddress 冲突、敏感字段 canary。

**DoD**

- Store 清单和字段清单可审计；
- 清 UI 状态不触碰 Harness Home；
- Secret Scanner 对持久化快照零命中。

### VUE-004：路由、恢复与导航围栏

**用户行为**

- 可以在 Home、Workspace、普通 Session、Subagent Session、Settings、Diagnostics 间导航；
- 刷新后安全恢复最近路由；目标不存在时返回合理父级；
- 快速切换不会显示上一 Session 的迟到数据。

**实现步骤**

1. 路由参数只包含 opaque ID，不包含 Token、真实路径和正文；
2. `route-codec` 对普通/子 Session 地址做 parse/stringify；
3. Guard 先检查 bootstrap/capability，再申请对应 Resource；
4. 每次路由导航生成 navigation epoch；旧异步 open 完成后立即 dispose；
5. 保存最近安全路由，恢复时用 Session Directory/Workspace Snapshot 验证；
6. 目标缺失按 Session→Workspace→Home 降级；
7. 跳转到消息使用 route state/command，不把任意 node 内容放 URL。

**命令/DTO/Patch**：`NavigationIntentDto` 由组件发出，Router Adapter 统一执行。

**边界、错误与恢复**

- archived Session 上游当前无浏览面：恢复到 Home 并说明；
- Subagent 地址缺 parent/mode：拒绝；
- 连接中断时可保持当前只读 route，待重连校验。

**安全**

- 所有外部 deep link 默认关闭；将来开启必须由 Main 验签/校验；
- Router 不执行 URL 中的命令，不接受 `javascript:` 或文件路径。

**测试**

- 直接刷新各 route、快速 A→B、目标删除、archived、错误 Subagent、重连。

**DoD**

- 导航 epoch 防止串 Session；
- Route 全部可序列化、可验证且不泄密。

### VUE-005：三栏应用外壳与响应式布局

**用户行为**

- 默认拥有 Workspace/Session Sidebar、主内容和 Inspector；
- 可调整宽度、折叠 Sidebar/Inspector，小窗口仍能完成主流程；
- 200% 缩放时不出现关键操作不可达。

**实现步骤**

1. `AppFrame` 使用 CSS Grid 管理三栏，不让 JS 持续计算布局；
2. Resizable Panel 使用 Pointer Capture 和 requestAnimationFrame 合并；
3. 宽度用设计 Token 约束 min/max，并持久化规范化比例；
4. 窄窗口切成 overlay drawer，打开时 focus trap；
5. Inspector 由 `InspectorIntent` 驱动，内容按类型 lazy load；
6. Header 与 Composer 保持固定语义区，Conversation 自占滚动容器；
7. 监听 ResizeObserver，只对必要 root 使用，组件卸载断开。

**命令/DTO/Patch**：`LayoutState {sidebar,inspector,density}`，不包含业务状态。

**边界、错误与恢复**

- 屏幕/缩放变化导致值越界时 clamp；
- Pointer cancel/窗口失焦时结束 resize；
- Inspector 内容失败只关闭/显示局部错误。

**安全**：拖拽只接受内部 pointer，不消费外部 DataTransfer；Inspector Intent 经过 schema。

**测试**：最小窗口、4K、200% zoom、键盘 resize、LTR/未来 RTL、快速展开折叠。

**DoD**：主流程在支持窗口尺寸和 200% zoom 下可达；无 layout thrash 长任务。

### VUE-006：Workspace/Session 导航树表现层

**用户行为**

- Sidebar 显示 Workspace、普通 Session、运行状态、待审批标记、搜索结果；
- 创建、重命名、排序、归档的 pending 状态局部呈现；
- Subagent 不混入普通 Session 列表。

**实现步骤**

1. 使用 Workspace/Session Resource 的只读 computed 派生树；
2. archived set、origin、人工 order 和未归组规则集中在一个 selector；
3. 每行 key 为领域 ID；运行指示和 pending interaction 单独更新；
4. 行菜单只展示 capability 允许的命令；
5. Drag preview 属于 layout/UI Store，提交后由官方 Patch校正；
6. 搜索结果作为临时视图，不改原树；
7. 大列表按需要虚拟化，但菜单/焦点保留稳定 row ID。

**命令/DTO/Patch**：组件只调用 `NavigationIntent` 和 08 定义的命令，不直接触碰 Preload。

**边界、错误与恢复**

- 正在编辑的行被删除：关闭编辑并播报；
- 排序期间 baseline 替换：取消拖拽；
- 搜索请求晚到：由 query revision 丢弃。

**安全**：title/snippet 使用文本插值；菜单动作不从名称动态生成命令。

**测试**：分组、unassigned、archived、subagent、运行状态、pending interaction、键盘菜单。

**DoD**：树是纯派生视图；无 Session 内容复制或领域写入。

### VUE-007：命令调度、Single-flight 与反馈

**用户行为**

- 点击操作后只禁用相关控件；成功、拒绝、取消和结果未知有不同反馈；
- 重复点击不会提交两次；
- 关键错误可复制错误码并进入诊断。

**实现步骤**

1. 所有组件通过 `CommandClient.execute(command)`，不直接调用 `window.desktop`；
2. Command Client 生成 commandId、AbortController 和 operation key；
3. 根据命令策略执行 `single-flight/replaceable/parallel`；
4. request/reply 做 schema 验证并归一化 DesktopError；
5. `accepted` 与 `state confirmed` 分开表示；
6. Toast 只提示瞬时结果，字段/行级错误留在原位置；
7. route/session dispose 时只 Abort 尚未 dispatch 的请求；已 dispatch 非幂等请求进入 reconcile。

**命令/DTO/Patch**：`CommandOutcome = confirmed | rejected | cancelled | outcome-unknown`。

**边界、错误与恢复**

- Preload reject、timeout、Renderer navigation、generation change；
- UNKNOWN 不变成 generic failed，不自动重试；
- 同 operation key 的命令根据策略拒绝或替换。

**安全**：命令是 discriminated union；无通用 channel/method 字符串；错误 details 白名单。

**测试**：双击、Abort 前/后 dispatch、timeout、accepted 后 Patch 延迟、UNKNOWN reconcile。

**DoD**：所有写操作声明 command policy；无非幂等自动重试。

### VUE-008：错误边界与恢复表面

**用户行为**

- 单张 Tool Card、Inspector 或设置页出错不会白屏；
- Session 数据失败只影响当前 Session；全局协议故障才进入全屏状态；
- 用户得到“重试同步、重启 Bridge、重启 Harness、导出诊断”等恰当动作。

**实现步骤**

1. 分为 App、Route、Conversation、Presenter、Inspector 五级 Error Boundary；
2. `error-presenter` 按稳定 error code 映射标题、说明、动作、严重度；
3. `onErrorCaptured` 只捕获表现错误，不吞掉领域失败；
4. 未知 JS 错误生成 renderer incidentId，记录脱敏 stack；
5. 连续崩溃同组件进入静态 fallback，避免无限 remount；
6. 恢复动作调用固定命令，不重新加载整个应用作为万能方案；
7. Fatal 页面保留退出和诊断能力。

**命令/DTO/Patch**：`ErrorPresentationDto` 是本地派生，不传原始 Error 对象。

**边界、错误与恢复**

- Error Boundary 自身失败使用最小静态 fallback；
- i18n key 缺失回落稳定英文 key；
- 重试次数有上限并可被用户显式再次触发。

**安全**：不显示 stack、真实路径、Prompt、Tool payload、Secret；复制内容走脱敏白名单。

**测试**：每一层注入 throw、循环错误、i18n 缺失、恢复动作失败、诊断可达。

**DoD**：任一叶子组件故障不导致全局白屏；全局 fatal 仍可安全退出。

### VUE-009：订阅、Effect Scope 与资源注册表

**用户行为**

- 长时间使用、切换 Session 和打开关闭页面后应用性能不逐步下降；
- 页面隐藏/恢复不会产生重复订阅。

**实现步骤**

1. 创建 `createOwnedScope(ownerId)`，统一登记 unsubscribe、Abort、Worker、Observer、Timer、GSAP context；
2. Vue composable 用 `effectScope`，并在 `onScopeDispose` 逆序清理；
3. 同一领域 resource 通过 registry 引用计数，不让多个组件重复开 Port；
4. 页面 visibility 只调整低优先级合批，不断开正在运行的重要 stream；
5. HMR 仅开发启用，dispose 时撤销所有模块 listener；
6. 测试构建暴露只读 resource counts。

**命令/DTO/Patch**：`RendererResourceStatsDto` 只包含数量、类型和 owner hash。

**边界、错误与恢复**

- 清理函数抛错用 allSettled 继续其他清理；
- acquire 过程中 owner dispose，完成后立即释放；
- refcount 不得小于零，异常视为编程错误。

**安全**：统计不包含内容与真实 ID；生产不可通过调试接口执行清理外操作。

**测试**：20/100 次 mount/unmount、快速 route、HMR、visibility、清理抛错、late acquire。

**DoD**：listener/timer/worker/observer/port/tween 回到基线；无 unhandled rejection。

### VUE-010：全局快捷键、焦点与命令面板入口

**用户行为**

- 可以用键盘切换 Sidebar、聚焦 Composer、打开搜索/命令面板/设置；
- 输入框和 IME 中不会误触全局命令；
- capability 不存在的命令不会出现。

**实现步骤**

1. 快捷键注册表以 semantic command ID 定义，不直接绑定业务函数；
2. Router/Shell 提供 Command Context 解析当前 capability；
3. 捕获前检查 event composition、editable target、modal stack；
4. 命令面板只列本地静态 command descriptors 和当前 capability；
5. 选择后发 `NavigationIntent` 或固定领域命令；
6. Dialog 关闭恢复触发前焦点；
7. 菜单与快捷键共享同一 command registry。

**命令/DTO/Patch**：`UiCommandDescriptor {id,labelKey,shortcut,enabledReason}`。

**边界、错误与恢复**：快捷键冲突构建时失败；操作 pending 时禁用；平台键位差异由 keymap 处理。

**安全**：模型输出和 Plugin Inventory 不能注册快捷键/命令；禁止 eval 或动态 import 名称。

**测试**：输入框、IME、Modal、屏幕阅读器、冲突、capability 变化。

**DoD**：核心导航和发送以外操作可键盘完成；无输入误触。

### VUE-011：Renderer 性能与可观测性

**用户行为**

- 大会话和长时间运行时界面保持流畅；
- 诊断可说明卡顿来自 Patch、渲染、Worker 或布局，而不采集用户内容。

**实现步骤**

1. 用 Performance marks 测 `event received → patch committed → next paint`；
2. 记录 mounted rows、Patch operations、Worker count、long tasks 和 Heap 采样；
3. 只用稳定低基数 label，不使用 SessionId/ToolCallId；
4. 开发模式提供只读 overlay，正式版进入诊断页；
5. 性能采样可配置且默认低频；
6. 建立 1,000 Turn/25k event 的回放路由；
7. 基准超限使 Nightly/RC 失败。

**命令/DTO/Patch**：Metrics 不包含文本；Trace 只用随机 operation correlation ID。

**边界、错误与恢复**：Performance API 不可用时静默禁用统计，不影响主流程；采集队列有界。

**安全**：不采集 DOM 文本、URL query、路径、Prompt 和响应；诊断导出二次脱敏。

**测试**：指标准确性、label cardinality、关闭采集、长任务注入、队列上限。

**DoD**：采集开销 CPU <1%、内存 <20MB；性能基准可重复。

## 8. 页面和路由清单

| 路由 | 主视图 | 必需资源 | 缺能力/失败行为 |
|---|---|---|---|
| `/` | 最近 Session 或欢迎页 | Workspace、Session Directory | 空状态可创建 Workspace |
| `/workspace/:id` | Workspace 概览/首个 Session | Workspace、Session Directory | ID 不存在回 Home |
| `/session/:id` | 普通 Conversation | Session/Conversation/Control | 局部错误页 |
| `/subagent/:parent/:child/:mode` | 子会话 | Subagent catalog、Conversation | 地址不完整拒绝 |
| `/settings/:section?` | 设置中心 | Settings/Credentials/Catalog | 对应区块降级 |
| `/diagnostics` | 健康与诊断 | Runtime/Resource stats | 永远不显示内容正文 |
| `/recovery` | 恢复模式 | Main recovery actions | 禁止普通业务写操作 |

## 9. 开发顺序

1. 建立 Vue/Vite/Router/Pinia 最小安全入口；
2. 完成 Desktop API wrapper、Envelope Schema、PatchFence；
3. 完成 Bootstrap Gate 和全局状态机；
4. 完成 Workspace、Session Directory Resource Adapter；
5. 完成 Router codec、guard 和 route epoch；
6. 完成 AppFrame、Sidebar、Header、Inspector host；
7. 完成 Pinia Store 白名单和 UI state migration；
8. 完成 Command Client、single-flight 和错误呈现；
9. 完成 Conversation Resource 接口，供 11 使用；
10. 完成 owned scope/resource registry；
11. 完成快捷键和命令面板；
12. 完成性能、泄漏、错误注入和 E2E。

## 10. 验收清单

- [ ] Renderer 构建依赖图中没有官方 DSH、Cordis、Node、Electron Main 包；
- [ ] 所有跨进程数据均经运行时 schema 验证；
- [ ] 领域 Snapshot 使用 shallowRef，不进入深响应 Pinia；
- [ ] Patch 全批原子应用，gap 自动 resync；
- [ ] Pinia 只含 UI 状态、草稿和偏好；
- [ ] UI 持久化白名单不含 Secret、正文、Tool payload 或真实路径；
- [ ] 启动状态每一步有界且有失败页面；
- [ ] Router 快速切换不会显示旧 Session Patch；
- [ ] archived/Subagent/普通 Session 导航语义准确；
- [ ] AppFrame 在最小窗口、200% zoom、亮暗主题可用；
- [ ] accepted 与 confirmed 分开，UNKNOWN 不自动重试；
- [ ] 五级错误边界通过故障注入；
- [ ] 所有 listener、Port、Worker、Observer、Timer、Tween 有 owner；
- [ ] 20 次 Session 切换和 Renderer reload 后资源回到基线；
- [ ] 核心流程纯键盘可达且 IME 不误触；
- [ ] 25k event 场景和监测开销达到性能预算。

## 11. 模块完成定义

VUE-001～VUE-011 全部实现并通过组件、集成、Electron E2E、性能、泄漏和无障碍测试；Renderer 在丢弃全部本地领域副本后能仅靠 Snapshot 恢复；不存在第二套领域 reducer、通用 IPC、深响应大对象、跨代 Patch 或敏感信息持久化。任一资源无法证明 dispose、任一启动失败只能靠刷新解决，均视为未完成。
