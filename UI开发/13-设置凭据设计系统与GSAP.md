# 13：设置、凭据、Design System、GSAP、i18n 与无障碍

## 1. 文档目标

本文件定义设置中心、Credential 安全录入、OS Keychain、设计系统、GSAP 动效、国际化和无障碍的完整产品与工程合同。这些能力必须与业务模块同时进入 Definition of Done，不能作为上线前“补样式”的尾项。

统一边界：

- 官方 Settings/Credentials/Plugin Inventory Client 与 Cordis 全部运行在 Utility Process；
- Renderer 只接收本项目规范化的 `Settings*Dto`、`CredentialInfoDto`、`PluginInventoryDto`，不接收官方 Schema Class；
- Credential 明文只能从用户输入瞬时经过 Renderer→Preload→Utility→官方 Credentials write，任何读接口都不得返回明文；
- 正式版凭据 Provider 必须使用 OS 安全存储；安全存储不可用时 fail closed，不降级明文文件；
- Design Token 是视觉真源，业务组件不得散落颜色、间距、z-index 和 duration magic number；
- GSAP 只驱动表现，任何业务成功、提交、清理和权限决定都不能依赖动画回调；
- 产品文案必须使用 i18n key；模型、Tool、路径等不受信任内容不翻译、不插值成 HTML；
- V1 以 WCAG 2.2 AA 为最低无障碍目标。

## 2. 范围与非范围

### 2.1 范围

- Settings Center 导航、加载、搜索、字段表单、验证、保存、冲突解决；
- 官方 `settings.describe/update/replace/mutate`；
- `applies: live/restart` 和安全重启引导；
- 打开 Host-owned Settings Document、打开用户 Agent Preset 目录；
- Plugin Inventory 与 Agent Preset composition 的只读诊断；
- Credential reference 发现、批量 describe、set、unset、刷新与只读来源；
- Windows Credential Manager 优先的 OS Keychain Provider 方案；
- Light/Dark/System/Forced Colors、密度与全部 Design Token；
- Primitive、Pattern 和 Product Surface 组件分层；
- GSAP motion token、scope、清理、滚动接管、reduced-motion；
- `zh-CN`、`en-US`、pseudo-locale、Intl 格式化；
- 键盘、Focus、ARIA、Live Region、200% Zoom、屏幕阅读器；
- Storybook/组件目录、视觉回归、A11y、Motion、性能测试。

### 2.2 明确非范围

- 不在 Renderer 或 Pinia 回读、缓存、显示 Credential 明文；
- 不支持任意 JSON/JS 插件向设置页注入可执行组件；
- Plugin Inventory V1 只读，不能启用、禁用、安装或卸载插件；
- 不允许 Settings 页面直接编辑任意宿主文件；
- 不自动重启正在运行任务的 Harness；
- 不用 GSAP 动画每个 token、历史 prepend、断线恢复、虚拟行 recycle；
- 不翻译模型生成内容、Tool 参数、文件内容和用户名称；
- 不以仅颜色表达状态；
- V1 不承诺 RTL，但 Token/布局不能人为阻塞未来支持；
- Linux 无可用 Secret Service 时不得退化到明文。

## 3. 依赖与建议目录

### 3.1 依赖

- Desktop Contracts、Settings/credential compat adapter、Command Client；
- Main Runtime Supervisor、Native Capability Broker、Updater/Diagnostics；
- Harness Host 侧 `desktop-credentials-provider`；
- Vue、Pinia（仅 UI preference）、Vue Router；
- GSAP、Intl、Axe、视觉回归工具；
- 发布侧签名 helper、SBOM、第三方许可证。

### 3.2 建议目录

```text
packages/desktop-contracts/src/
  settings.ts
  credentials.ts
  plugin-inventory.ts
  preferences.ts

packages/harness-compat/src/v0_1_2/
  settings-adapter.ts
  credential-adapter.ts
  plugin-inventory-adapter.ts
  settings-schema-normalizer.ts

packages/desktop-credentials-provider/
  src/provider.ts
  src/vault-port.ts
  src/helper-client.ts
  tests/

native/credential-vault-helper/
  windows/
  macos/
  linux/

packages/design-system/src/
  tokens/
    color.css
    typography.css
    spacing.css
    motion.css
    elevation.css
    density.css
  primitives/
  patterns/
  product/
  themes/
  motion/
    use-motion-scope.ts
    motion-policy.ts

apps/desktop/src/renderer/features/settings/
  SettingsPage.vue
  SettingsNavigation.vue
  SettingsNamespaceForm.vue
  CredentialField.vue
  PluginInventoryPage.vue
  RuntimeAboutPage.vue
  settings-form-controller.ts

apps/desktop/src/renderer/i18n/
  index.ts
  zh-CN/
  en-US/
  pseudo/
```

## 4. 设置与凭据状态

### 4.1 Settings Resource 状态机

```text
IDLE → LOADING → READY
READY → SAVING → READY
READY/SAVING → CONFLICT → RELOADING → READY
READY → RESTART_REQUIRED
LOADING/SAVING → FAILED → LOADING（显式重试）
任意状态 → DISPOSED
```

一个 Namespace 的保存失败不能阻塞其他 Namespace；全局 Provider 缺失才使设置页进入整体 unavailable。

### 4.2 Credential Field 状态机

```text
UNKNOWN → DESCRIBING → CONFIGURED / UNCONFIGURED / READ_ONLY
UNCONFIGURED → EDITING → SETTING → CONFIGURED
CONFIGURED → REPLACING → SETTING → CONFIGURED
CONFIGURED → UNSETTING → UNCONFIGURED
任意写状态 → REJECTED / OUTCOME_UNKNOWN → DESCRIBING
```

`OUTCOME_UNKNOWN` 后只能重新 `describe(ref)` 确认 configured metadata；绝不能尝试读取原值，也不能自动重复提交 Secret。

### 4.3 DTO

```ts
type SettingsNamespaceDto = {
  ns: string
  labelKey: string
  applies: 'live' | 'restart'
  revision: number
  writable: boolean
  fields: readonly SettingsFieldDescriptorDto[]
  resolvedValue: JsonValue
  baseValue?: JsonValue
  userValue?: JsonValue
  secretSlots: readonly { path: readonly string[]; set: boolean }[]
}

type CredentialInfoDto = {
  ref: string
  configured: boolean
  source?: 'environment' | 'keychain' | 'provider' | 'unknown'
  writable: boolean
}

type PluginInventoryDto = {
  entries: readonly PluginEntryDto[]
  agentPresets?: readonly AgentPresetPluginGroupDto[]
  fetchedAt: number
}
```

官方序列化 Schemastery schema 必须在 Utility 中转换为项目稳定的 `SettingsFieldDescriptorDto`；Renderer 不实例化官方 Schema，也不通过上游 schema 动态执行代码。

## 5. Settings 功能规格

### SET-001：设置中心导航、加载与搜索

**用户行为**

- 从独立 Settings 路由浏览 General、Models/Providers、Agents、Plugins、Appearance、Accessibility、Updates、Diagnostics、About；
- 通过搜索定位字段；加载失败只影响对应区块并可重试；
- 返回会话时保留之前 Session，不触发 Harness 重启。

**实现步骤**

1. Settings route 进入时调用 Utility `settings.describe()`；
2. Utility 转换 writable、hasDocument、namespace schema/value/base/user/secrets/revision；
3. 页面导航来自静态产品 section + 动态 namespace descriptor 映射，不执行 Host 提供的组件；
4. 搜索索引只包含 i18n label/description 和 namespace，不索引 Secret/值；
5. 数据按 generation 缓存，收到 `settings/document-updated` 后标 dirty并有界刷新；
6. 各 Namespace 独立 Error Boundary；
7. 路由卸载 Abort 请求并释放订阅。

**命令/DTO/Patch**：`settings.describe/subscribe`；`SettingsDescribeDto`、`SettingsNamespacePatchDto`。

**边界、错误与恢复**

- Settings provider 缺失：整体不可用并显示 profile 修复；
- Namespace schema 不支持：显示只读 JSON 摘要和兼容错误；
- event 通知不可靠，重连后必须 describe 全量替换。

**安全**

- describe 已 `redactSecrets:true`，Utility 仍逐字段白名单映射；
- 搜索、日志和诊断不采集字段值；
- Host 返回文案只按纯文本显示。

**测试**

- 空/多 namespace、Provider 缺失、局部 schema 失败、通知、重连、搜索、卸载。

**DoD**

- Settings 页面不持有官方类型；
- 无 Secret 值跨读通道；
- 每个区块可独立失败/恢复。

### SET-002：Provider 与模型可用性

**用户行为**

- 在 Models/Providers 分区看到每个 Provider 的配置状态、可用模型、能力与局部错误；
- 某个 Provider 故障时仍能查看和使用其他 Provider；
- 页面只显示脱敏状态，不回显 API Key、Authorization header 或原始上游错误体。

**实现步骤**

1. Utility 通过官方 Provider/Model discovery 与 `session.modelCatalog` 能力建立权威快照；
2. 将每个 Provider 独立规范化为 `ProviderAvailabilityDto`，只保留 id、displayName、configured、health、models、capability 与稳定错误码；
3. Model 行复用 SES-005 的 `ModelOptionDto`/Reasoning capability，避免 Settings 与 Composer 各自解释模型；
4. Credential ref 只关联 CRED-001 的 metadata，不把 Secret 或伪掩码塞入 DTO；
5. Provider 查询使用独立 deadline/Abort，失败按 Provider 隔离，不把整个 Catalog 降为 ERROR；
6. `credentials/reference-updated`、settings revision 或 Harness generation 变化时失效相关 Provider cache，并 debounce 刷新；
7. Renderer 仅按 DTO 渲染 configured/degraded/unavailable，修复动作通过封闭 Intent 跳转到对应 Credential/Settings 字段；
8. 原始错误仅在 Utility 映射为 messageKey/supportCode，Renderer 不接收响应 body、header 或堆栈。

**命令/DTO/Patch**：`settings.providers.describe`、`session.modelCatalog`；`ProviderAvailabilitySnapshotDto`、`ModelOptionDto`、`ProviderAvailabilityPatchDto`。

**边界、错误与恢复**

- Provider 未配置、Credential 被环境变量只读覆盖、Catalog 超时、返回空模型、模型 capability 未知；
- 旧 generation/catalogRevision 的结果直接丢弃；连续失败保留上次快照并明确标 `stale`，不能伪装可用；
- “未配置”“鉴权失败”“限流”“离线”“协议不兼容”必须是不同稳定状态。

**安全**

- Provider 返回的 displayName/error 全按纯文本；
- 禁止记录请求 header、endpoint query、Credential value 和原始错误体；
- 修复 Intent 只携稳定 providerId/credentialRef，不接受任意路由或 URL。

**测试**

- 多 Provider 一成一败、未配置/鉴权/限流/离线、空 Catalog、capability 变化、Credential 轮换、generation fence、脱敏 canary。

**DoD**

- 一个 Provider 的失败不阻断其他 Provider；
- Settings 与 Composer 对同一模型/Reasoning 能力呈现一致；
- Renderer、日志和诊断中无 Secret 或原始 Provider 错误体。

### SET-003：保存、Path Mutation、Replace 与 CAS 冲突

**用户行为**

- 按 Schema 使用输入框、数字、开关、选择、列表或对象编辑器修改 Harness 普通设置；
- 保存字段时只提交改动；并发变化不会被静默覆盖；
- 冲突时查看最新值，选择重新应用或放弃；
- Reset 字段只移除 user override，恢复 base/default；
- `live` 设置立即生效，`restart` 设置明确显示待安全重启；高级用户可由官方能力打开 Settings 文档或用户 Agent Preset 目录。

**实现步骤**

1. Utility 将允许的官方 Schemastery 节点转换为稳定 descriptor：string/number/boolean/enum/array/object/secret；不支持节点转 `unsupported-readonly`；
2. Renderer 建立 `FormDraft`，保存 source revision、touched paths 与客户端校验；value/base/user 三层分别表达 resolved 值、composition 基线和用户 override；
3. Secret slot 替换为 CRED-002 一次性编辑器，绝不进入普通 JSON draft/序列化；
4. 普通表单优先生成 `settings.mutate(ns,ops,expectedRevision)`；
5. 简单顶层 merge 可用 `update`，完整 advanced editor 经明确确认后才用 `replace`；
6. 每次写携当前 `revision`，禁止正式 UI 传 `undefined` 无条件覆盖；
7. `unset path` 表示恢复继承，不写入显示的 resolved default；
8. 成功返回的新 redacted namespace 原子替换；
9. `settings/conflict` 时 describe 最新值，对 touched paths 做三方 diff；不自动重放 mutation；
10. carrier UNKNOWN 后重新 describe，通过 revision/value 判断结果；
11. descriptor 的 `applies: live|restart` 驱动生效提示；restart 写成功只记录 `PendingRestartReasonDto`，不伪装已生效；
12. Main Supervisor 在用户请求重启时执行 preflight，检查运行 Turn、Queue、Interaction 和后台 job；只对 managed runtime 执行 drain/stop/start/auth/resync；
13. 新 generation 完成全部 domain baseline 后才清 pending restart；失败保留“设置已保存、尚未生效”的事实；
14. `hasDocument` 时仅调用官方 `openSettingsDocument()`；Agent Preset 仅以 `presetId` 调 `openAgentPresetDirectory`，路径由 Host 解析；
15. 外部文件更新通过 `settings/document-updated` 触发 describe；旧 draft 标 stale，由用户选择丢弃或重新应用。

**命令/DTO/Patch**：`settings.mutate/update/replace/openDocument/openAgentPresetDirectory`、`runtime.restartPreflight/restartManagedHarness`；`SettingsFieldDescriptorDto`、`SettingsMutationOutcome`、`PendingRestartReasonDto`。

**边界、错误与恢复**

- 可选/nullable、空数组、嵌套对象、未知 enum、巨型/深层 schema、空 ops、非法 path、provider read-only、settings/rejected、conflict、UNKNOWN；
- 保存期间收到 provider event，只标 stale，等待当前结果后 reconcile；
- 局部失败保留 draft；设置写成功但重启失败、重启时应用退出、活动 Approval、崩溃循环分别恢复；
- Settings 文档或 Preset 不存在/只读/原生 opener 失败时不回退到 Renderer 任意路径打开。

**安全**

- path segment、深度、ops、payload bytes 有上限；
- 原型污染 key 拒绝；
- Schema 禁止携带 HTML、函数、正则执行器、远程组件 URL；
- 日志只记录 ns、path hash、revision、结果，不记录 value；
- 重启确认文字来自产品 i18n；Renderer 不能 kill 进程；open 动作只传 namespace/presetId，不传路径。

**测试**

- 每种 descriptor、默认/override、unknown schema、mutate/update/replace、reset、两客户端 CAS、event 竞态、UNKNOWN、恶意 path；
- live/restart、空闲/运行/Queue/Interaction preflight、重启失败与 generation baseline；
- document 有/无、user/system preset、外部更新、恶意 presetId。

**DoD**

- 正式表单没有无条件写；
- CAS 冲突不会丢用户输入或覆盖新值；
- returned view 与重读一致；Secret 永不进入普通表单；
- 没有静默自动重启或 Renderer 路径参数，生效点与信任边界可验证。

### SET-004：Plugin Inventory 与支持状态

**用户行为**

- 查看当前 Loader entries、enabled、fiber phase，以及每个 Agent Preset 的 composition；
- failed、broken、conditional、unsupported 有清楚说明；
- V1 明确只读，不出现启用、禁用、安装、删除或加载插件自定义 UI 的入口。

**实现步骤**

1. Utility 调用官方/可信 Loader 的 `pluginInventory.list()`，逐字段白名单映射为稳定 DTO；
2. Inventory 是 point-in-time snapshot，页面进入与用户手动刷新时读取；相关通知只触发 debounce refresh；
3. entry、preset group 和 row 使用稳定 ID/order，不根据展示名称建立身份；
4. `fiberPhase:null`、roster absent 和空 roster 分别表达，不推断原因；
5. preset `broken` 与 condition 以纯文本显示，动态 React/Web component 一律标记 unsupported；
6. Renderer 使用内置静态 Pattern 渲染，不根据 moduleName/path 做 import；
7. 刷新 single-flight；新 snapshot 由 generation/revision fence 原子替换，失败时保留旧快照并标 stale；
8. 支持状态由 release capability matrix 和 inventory DTO 联合派生，不由 Renderer 猜测。

**命令/DTO/Patch**：`settings.pluginInventory.refresh`；`PluginInventoryDto`、`PluginEntryDto`、`AgentPresetPluginGroupDto`。

**边界、错误与恢复**

- Loader/roster absent、空 inventory、单个 broken entry、刷新超时、通知风暴、超长字段；
- refresh 失败不影响其他 Settings 分区；旧 snapshot 标出抓取时间与 stale 状态；
- 未知 phase/status 进入 `unknown` fallback，不白屏也不默认为 healthy。

**安全**

- moduleName/condition/broken 全按纯文本并限制长度；
- 不加载插件 Renderer JS、远程 URL 或样式，不暴露文件系统路径；
- V1 无 inventory mutation command，模型文本不能制造安装/启用 Intent。

**测试**

- 所有 fiber phase、roster absent/empty、broken/conditional、未知状态、刷新竞态、超长字段、恶意 moduleName、权限扫描。

**DoD**

- Inventory 与官方 Loader/签名 release capability 可追溯；
- 页面不存在任何写 Plugin 或动态加载插件 UI 的路径；
- 局部异常不会阻塞设置中心。

### SET-005：App、Harness、协议与更新版本

**用户行为**

- 在 About/Updates 查看 Desktop App、Electron、Harness tag/commit、官方 Client、协议、Projection compatibility 与 release channel；
- 看到当前版本是否兼容、是否有更新、下载/校验/待重启状态；
- 一键复制经过脱敏的支持信息，更新失败时仍能继续使用已验证的当前版本。

**实现步骤**

1. Main 从签名 release manifest、打包元数据和正在运行的 Utility handshake 组装 `VersionInfoDto`，禁止 Renderer 从 `process/env` 猜版本；
2. 明确列出 appVersion、electronVersion、harnessTag/commit、clientVersion、protocolVersion、projectionFingerprint、platform/arch 与 buildId；
3. compatibility 由 04 的协议握手矩阵计算为 compatible/degraded/blocked，并给出稳定 reason/messageKey；
4. Updater 只接受签名 manifest/artifact，状态机为 `IDLE→CHECKING→AVAILABLE→DOWNLOADING→VERIFYING→READY_TO_RESTART`，失败进入 `ERROR` 且保留当前 runtime；
5. 更新检查、下载、取消、安装重启均使用封闭 Intent 和 single-flight receipt；Renderer 不接收下载 URL 或文件路径；
6. Harness/App 配对按 release set 原子选择，不允许 Renderer 混搭未验证版本；
7. 复制支持信息使用字段白名单和长度上限，只含稳定版本、兼容状态、supportCode 与匿名诊断计数；
8. snapshot/patch 均带 generation/revision；应用重启后重新握手，只有 baseline 完成才显示更新成功。

**命令/DTO/Patch**：`diagnostics.versionSnapshot`、`updater.check/download/cancel/installAndRestart`；`VersionInfoDto`、`ReleaseSetDto`、`UpdateStatePatchDto`。

**边界、错误与恢复**

- 离线、更新服务超时、无更新、manifest/artifact 签名错误、磁盘不足、下载中退出、安装失败、Harness/App 版本错配；
- 下载可按验证过的 updater 能力续传；非幂等安装 UNKNOWN 时先读取 updater 状态，不重复安装；
- compatibility blocked 进入专用恢复页，不能仅靠隐藏按钮继续运行。

**安全**

- 更新 URL、签名 key、临时路径和进程控制仅在 Main/Updater；
- 支持信息移除用户名、绝对路径、Workspace/Session ID、Prompt、Secret 与 header；
- Harness/Client/Projection fingerprint 来自构建证据，不信任 Host 自报展示文案。

**测试**

- 版本字段完整性、每个 compatibility 分支、无更新/有更新、断网/续传、签名错、磁盘不足、退出恢复、原子 release set、支持信息 canary。

**DoD**

- 版本信息可由 Manifest/handshake 自动复核；
- 未签名或不兼容更新无法进入 READY/安装；
- 支持信息可复制且不含敏感路径、身份和内容。

### SET-006：UI 偏好、缓存与诊断入口

**用户行为**

- 管理主题、语言、密度、动效、默认面板、快捷键提示等仅属于 Desktop UI 的偏好；
- 分类型查看并清理可重建缓存，不删除 Workspace、Session、Harness Home 或 OS Keychain 凭据；
- 查看脱敏诊断摘要、复制支持码或显式导出诊断包，并在动作前看到包含/不包含的数据。

**实现步骤**

1. 将 UI 偏好定义为版本化 `UiPreferencesVn`，只包含枚举、布尔、受限数值和合法 panel sizes；与 Harness Settings namespace 分库存储；
2. 启动时执行纯函数迁移；损坏字段逐项回默认并记录无内容 supportCode，不因一个字段清空全部偏好；
3. theme/locale/reduced-motion/density 通过 DS/GSAP/i18n adapter 应用；领域资源、Controller、Secret 和大型日志禁止进入偏好 Store；
4. Cache Inventory 分为 markdown AST、syntax/highlight、projection cold snapshot、attachment thumbnail、search index 等可重建类别，提供 bytes/entryCount/lastUsed；
5. `cache.clear(category|allRebuildable)` 先关闭关联 Worker/句柄，再清受控 App cache；完成后返回逐类 receipt 并惰性重建；
6. 清理命令的 allowlist 明确排除 Harness Home、Workspace 文件、Session 数据、Settings 文档、Credentials 与 updater rollback artifact；
7. Diagnostics Snapshot 从 OBS/RECOVERY 只取白名单 metrics、版本、状态码和资源计数；默认不含正文、命令全文、绝对路径或稳定用户标识；
8. 导出必须由用户明确动作，先预览 categories/估算大小/脱敏规则，再由 Main 写入用户选择的目标；Renderer 只收到 opaque receipt；
9. reset UI preferences 与 clear cache 是两个独立二次确认动作；完成后只重建 UI 状态，不重启/删除官方领域对象。

**命令/DTO/Patch**：`uiPreferences.read/patch/reset`、`cache.inventory/clear`、`diagnostics.snapshot/export`；`UiPreferencesDto`、`CacheInventoryDto`、`ClearCacheReceiptDto`、`DiagnosticsExportIntentDto`。

**边界、错误与恢复**

- 偏好旧版本/部分损坏、磁盘只读、清理中退出、文件占用、部分 cache 失败、Worker 同时写、诊断包过大、用户取消文件选择；
- 清理结果逐类标 success/failed/skipped，失败类仍可重试；UNKNOWN 时重新读 inventory，不重复扩大范围；
- reset 后路由/焦点回到合法默认位置，不能白屏。

**安全**

- Utility/Main 使用固定 cache roots 与类别映射，拒绝 Renderer 路径、glob、`..`、junction/symlink 越界；
- 导出包先运行 Secret/path/content canary 与大小限制，用户未同意不上传；
- UI 偏好不接受 CSS、脚本、URL 或任意快捷键代码。

**测试**

- 每版迁移/损坏恢复、主题/语言即时应用、每类 cache 清理、文件锁/部分失败/中断恢复、边界路径与 symlink、诊断 canary、200% zoom 下确认流程。

**DoD**

- 偏好迁移确定且不污染 Harness Settings；
- “清缓存/重置 UI”不会删除 Session、Workspace、Home 或 Credential；
- 诊断默认最小化、导出有明确知情动作且 canary 零泄漏。

## 6. Credential 功能规格

### CRED-001：Credential Reference 发现与批量 Describe

**用户行为**

- Settings 字段旁看到“已配置/未配置”、来源和是否可修改；
- 页面刷新后状态准确；绝不显示 Secret 明文或伪掩码原值。

**实现步骤**

1. Utility 从规范化 Settings field descriptors 收集 Credential refs；
2. ref 必须符合 `^[A-Za-z_][A-Za-z0-9_]*$`；
3. 去重并按最多 64 个分批调用 `credentials.describe(refs)`；
4. 映射 configured/source/writable，仅白名单字段；
5. 收到 `credentials/reference-updated(ref)` 后只刷新受影响 ref；
6. 重连/设置页重新进入时重新 describe，环境变量变化无法订阅；
7. Renderer Store 只保存 metadata。

**命令/DTO/Patch**：`credentials.describe({refs}) → Record<ref,CredentialInfoDto>`。

**边界、错误与恢复**

- 无 Provider、非法 ref、批次部分失败、事件早于初始 read；
- 一个批次失败按 ref group 显示，不伪造 unconfigured。

**安全**

- API 设计中不存在 getSecret；
- Provider 额外 enumerable 字段被 Utility 丢弃；
- ref 数量、格式和批次受限。

**测试**

- configured/unconfigured、env read-only、64/65 refs、非法 ref、额外字段、通知。

**DoD**

- Renderer/日志/测试快照不含任何 Secret value；
- metadata 与官方 describe 一致。

### CRED-002：一次性提交新 Secret

**用户行为**

- 输入新 Secret 后一次性保存；成功后输入立即清空，只显示“已配置”；
- 已配置值无法回看；替换或删除进入 CRED-003 的明确动作；
- 环境变量等 read-only 来源说明如何在外部修改。

**实现步骤**

1. Secret input 使用普通受控组件的最短生命周期，不进 Pinia/持久化；
2. 空值不可 set；此表单不把空值解释为删除；
3. Preload 对 Secret 命令使用专用 channel/结构，禁止通用日志 middleware序列化 payload；
4. Utility 直接调用官方 `credentials.set(ref,value)`；
5. Promise settle 后覆盖/清空 Renderer buffer、Preload临时变量和 Utility command对象引用；
6. 成功后调用 describe/等待 reference-updated，只显示 metadata；
7. Provider 挂载官方 `ctx.credentials` seam，Windows V1 通过签名固定路径的 Vault Helper 写 Credential Manager；不把 Electron native ABI 模块装入 Harness Node；
8. Helper 使用长度前缀封闭消息、`shell:false`、消息/父进程/ACL 限制，返回 write receipt/metadata，不向 Renderer/Main 回传 Secret；
9. 安全存储 unavailable/locked/denied 时返回稳定失败，禁止退回明文文件或环境变量；
10. UNKNOWN 后不重发 value，提示用户重新 describe 并决定是否重新输入。

**命令/DTO/Patch**：外部为 `credentials.setSecret`；内部调用官方 `credentials.set(ref,value)` 和封闭 `VaultWriteRequest`。Secret payload 不进入通用 `DesktopCommand` debug stringify；读回复永不含 value。

**边界、错误与恢复**

- 空值、Provider 拒绝、read-only source、窗口关闭、Bridge/Helper crash、Vault locked/denied、签名错、UNKNOWN；
- JS 字符串无法保证物理内存擦除，文档不得虚假承诺；应最小化存活范围与副本。

**安全**

- input 默认禁止 spellcheck/autocomplete，根据平台密码策略设置；
- Clipboard paste 允许用户动作，但不自动读 Clipboard；
- Secret 永不进日志、Metric、trace、crash context、DOM attribute、URL、Pinia、localStorage；
- Helper 最小权限、无网络、绝对路径启动、无动态库搜索路径劫持；打包签名/哈希进入 Runtime manifest 与 SBOM。

**测试**

- set、空值、read-only、UNKNOWN、组件卸载、真实 Windows Vault、锁定/拒绝、Helper kill/签名篡改、Secret canary 全链扫描。

**DoD**

- 没有任何 API/界面可回读 Secret；
- canary 不出现在日志、诊断、快照或错误；
- V1 Windows Secret 仅存在 OS Vault/必要瞬时内存，安全存储失败 fail closed。

### CRED-003：更新、删除凭据与 Keychain Provider 能力

**用户行为**

- 已配置凭据只能显式替换或删除，永远不能回看原值；
- 删除前看到 Provider/模型受影响范围并二次确认；
- Secret 由 Windows Credential Manager（后续 macOS Keychain/Linux Secret Service）保存，Vault 锁定、不可用或权限拒绝时明确失败。

**实现步骤**

1. Replace 使用独立一次性输入和 `credentials.set(ref,newValue)`；旧值不读入 UI，空字符串不代表删除；
2. Delete 使用独立 `credentials.unset(ref)`，确认页显示稳定 providerId、credentialRef label 与受影响模型数量，不展示 Secret；
3. 两类动作均以 ref 为 single-flight key；返回 UNKNOWN 时只重新 describe metadata，不自动重复写/删；
4. 成功后等待 `credentials/reference-updated` 或主动 describe，随后使相关 Model Catalog/Provider availability cache 失效；
5. read-only/environment source 禁用 replace/delete，并说明外部修复位置，不尝试 shadow write；
6. Desktop Harness profile 挂载 `desktop-credentials-provider`，实现官方 `ctx.credentials` Provider seam；UI 始终调用官方 `describe/set/unset` Remote；
7. Provider 通过签名、固定路径的 `credential-vault-helper` 访问 OS Vault，避免把 Electron native ABI 模块装入 Harness Node；
8. Windows V1 target name 包含产品 id + profile id + credential ref，绝不含 Secret；Helper 使用长度前缀消息或 ACL 本地通道，关闭 Shell，限制父进程/消息大小；
9. Secret 只在每次 resolve/write 临时存在，不跨模型请求缓存；Helper 只回 metadata/write receipt，Host 消费时才在 Host 内存获得；
10. 安全存储 unavailable 时稳定报错，禁止降级到明文 local store；平台实现通过统一 `CredentialVaultPort` 合同测试。

**命令/DTO/Patch**：`credentials.replaceSecret`、`credentials.delete`；Utility 调官方 `credentials.set/unset/describe`；内部 `VaultWriteRequest/VaultDeleteRequest` 是严格封闭联合且不记录 payload。

**边界、错误与恢复**

- Vault locked、用户取消 OS dialog、Helper crash、签名/哈希错、同 ref 并发替换/删除、升级 target namespace；
- Provider write receipt丢失时重新 describe metadata；不自动二次写 Secret；
- 删除已不存在按幂等结果处理但仍重读 metadata；Helper crash 有限重启，不触发整个 Harness crash loop。

**安全**

- Helper 最小权限、无网络、无动态库搜索路径劫持、绝对路径启动、`shell:false`；
- OS ACL 限当前用户；日志层在帧解析前剔除 Secret；
- 不通过环境变量传新 Secret；环境变量来源按官方语义 read-only 优先；
- 删除确认不允许 Host/模型文案重写，影响范围只能来自可信 dependency DTO。

**测试**

- replace/delete、read-only、UNKNOWN、双击/并发竞态、真实 Windows Vault、锁定/拒绝、Helper kill、升级、签名篡改、dump/log canary；
- 平台不可用时确认无明文文件产生。

**DoD**

- 替换/删除后 metadata 与下一次 Provider resolve 一致；
- V1 Windows 的 Secret 仅存在 OS Vault/必要瞬时内存，安全存储不可用 fail closed；
- Helper 经签名、供应链和故障注入门禁，删除动作有明确影响确认。

### CRED-004：凭据验证、失效提示与修复

**用户行为**

- Provider 能在不回显 Secret 的前提下显示未配置、待验证、有效、失效、限流或离线；
- 凭据失效时获得可操作修复提示并跳到具体 ref；替换后下一次请求使用新值；
- 外部来源变更可手动刷新，不要求重启。

**实现步骤**

1. `CredentialInfoDto` 扩展 validation=`unknown|checking|valid|invalid|rate_limited|offline`、checkedAt 与稳定 reasonCode；不含服务响应文本；
2. Provider 每次模型操作 resolve，不跨请求缓存；验证优先使用官方 provider health/auth probe，无法安全探测时保持 unknown 而非发起计费请求；
3. 验证由用户显式触发或 Provider 真实请求结果驱动，按 ref/provider 设置 cooldown、Abort 与 single-flight；
4. `reference-updated` 驱动 badge refresh，但消费者不依赖事件才能读取新值；环境变量变化通过页面进入/手动刷新 describe；
5. replace/delete 后使相关 Model Catalog cache 失效并刷新 adapter 状态；下一请求重新 resolve；
6. 鉴权失败映射 `credential/invalid`，限流/网络/服务故障分别映射，不把所有失败误判为坏 Key；details 只保留 ref/providerId/supportCode；
7. 修复 Intent 只跳转到 CRED-002/003 的可信 ref；成功修改后重新验证并保留上一错误至权威结果；
8. 清除 App UI cache 不删除 Credentials；卸载策略明确说明 Vault entry 保留/删除选择。

**命令/DTO/Patch**：`credentials.refresh({refs})`、`credentials.validate({ref,providerId})`；`CredentialValidationPatchDto`。模型失败跳转只携 ref/providerId，不携 value。

**边界、错误与恢复**：更新事件丢失、Provider shadow、验证超时/不支持、429、离线、轮换与在途请求竞态、Catalog refresh 失败、旧验证结果晚到；旧 generation/refRevision 结果丢弃。

**安全**：验证不把 Secret 带入 Renderer/日志，不自动发业务 Prompt；诊断包不含 vault target 敏感部分；不远程上传 metadata 除非用户同意。

**测试**：valid/invalid/rate-limit/offline/unknown、unsupported probe、超时/cooldown、晚到结果、rotation、event miss、env shadow、下一模型请求、canary、卸载策略。

**DoD**：失效/限流/离线不混淆；轮换对下一请求生效；状态最终与 describe/真实 Provider 结果一致；所有错误路径零 Secret 泄漏。

## 7. Design System 功能规格

### DS-001：Foundation Tokens

**用户行为**

- 全应用颜色、排版、间距、圆角、阴影、密度和状态一致；主题切换无闪白；
- 系统字体缺失时仍可读。

**实现步骤**

1. 定义 semantic CSS custom properties，不让业务组件引用 raw hex；
2. Token 分为 color/typography/space/size/radius/elevation/z/density/motion；
3. 状态色同时配 icon/text/border，不只依赖颜色；
4. 字体栈优先系统 UI，monospace 独立；
5. density 只切换受支持 Token，不用组件局部乘数；
6. 在首个 paint 前由 preload-safe inline theme bootstrap设置 class，避免 FOUC；
7. z-index 使用命名层级：base/sticky/popover/modal/toast/critical。

**命令/DTO/Patch**：公开 Token 命名和弃用策略；组件只消费 semantic token。

**边界、错误与恢复**：未知主题回 System；CSS 变量缺失有构建检查；用户 OS 字号/对比变化实时响应。

**安全**：主题值是枚举，禁止用户 CSS/任意 style 注入。

**测试**：Token completeness、主题首帧、字体 fallback、视觉截图、对比度。

**DoD**：业务组件无新增 raw color/z-index/motion magic number。

### DS-002：Accessible Primitives

**用户行为**

- Button、Input、Select、Checkbox、Radio、Dialog、Menu、Tooltip、Tabs、Popover、Toast 行为一致且可键盘使用。

**实现步骤**

1. 每个 Primitive 定义 states：default/hover/focus/active/disabled/loading/error；
2. 优先原生语义元素，确需自定义时实现完整 ARIA keyboard pattern；
3. Focus ring 使用 `:focus-visible` 且高对比可见；
4. Overlay 统一 focus trap、escape、outside click 和 restore focus；
5. Disabled 与 aria-disabled 语义按可聚焦需求区分；
6. Loading 不改变控件宽度，不移除可读 label；
7. 每个 Primitive 提供类型安全 props/event。

**命令/DTO/Patch**：Primitives 不导入业务 DTO/Bridge；只发语义 UI 事件。

**边界、错误与恢复**：nested overlays、virtual list menu、异步关闭、组件卸载恢复焦点。

**安全**：Tooltip/label 默认 text；禁止任意 HTML slot 处理不可信内容。

**测试**：键盘矩阵、axe、focus trap、pointer、touch、forced colors、visual states。

**DoD**：所有产品页只使用已验证 Primitive；无重复自造 Dialog/Menu。

### DS-003：Patterns 与 Product Surfaces

**用户行为**

- Empty/Loading/Error、Status Row、Tool Card、Interaction Panel、Settings Row、Resizable Panel 等有统一信息层级。

**实现步骤**

1. Patterns 组合 Primitives，不接领域 transport；
2. Product Surface 接稳定 DTO，但仍通过 Intent emit；
3. 每个表面定义 compact/comfortable、loading/error/empty/overflow；
4. 长文本、路径、代码、状态都规定截断与 Inspector 行为；
5. 统一 destructive confirm、inline error、retry、outcome unknown样式；
6. Slot API 限制可替换区域，避免 CSS/交互漂移；
7. Storybook 覆盖所有状态。

**命令/DTO/Patch**：Pattern 不能调用 CommandClient；Product Surface 只发封闭 Intent。

**边界、错误与恢复**：超长语言、无图标、未知状态、窄屏、200% zoom。

**安全**：不可信值全用 SafeText/SafeMarkdown primitives。

**测试**：状态矩阵、超长/空内容、视觉、A11y、响应式。

**DoD**：每个业务模块不再重复实现状态/错误/确认基础交互。

### DS-004：Light、Dark、System 与 Forced Colors

**用户行为**

- 可选浅色、深色或跟随系统；系统变化即时响应；Windows 高对比度下信息仍完整。

**实现步骤**

1. Preference 仅存 `light/dark/system`；resolved theme 独立派生；
2. 监听 `prefers-color-scheme`，仅 system 模式生效；
3. `color-scheme` 同步浏览器原生控件；
4. forced-colors 下使用系统颜色并保留边框/图标/文本状态；
5. Code highlight theme 与 resolved theme 同步，旧 Worker结果由 theme revision 丢弃；
6. 图标使用 currentColor/SVG，不用只有位图颜色含义；
7. 所有关键组合测 WCAG AA。

**命令/DTO/Patch**：`ThemePreference` 是枚举；不接受远程主题包。

**边界、错误与恢复**：系统事件抖动、主题切换中 Worker晚到、OS forced colors。

**安全**：禁止注入 CSS URL 和外部字体。

**测试**：四种模式、首帧、实时切换、截图、contrast、Shiki fence。

**DoD**：无主题闪烁；状态在 forced colors 下不丢失。

### DS-005：响应式布局、信息密度与治理

**用户行为**

- 不同窗口宽度、200% zoom 与 compact/comfortable 密度下仍能访问主导航、Conversation、Composer 和关键动作；
- 面板尺寸可调整、可恢复，视觉升级不会造成模块间风格和交互漂移。

**实现步骤**

1. 定义 layout semantic tokens：最小窗口、Sidebar/Inspector min/max/default、gutter、touch target 与 content measure；
2. 三栏按容器/窗口断点转换为 resizable panels、drawer 或单栏 route，Composer/Stop/Interaction 不能被折叠到不可达；
3. panel sizes 只保存合法比例/像素范围；窗口缩小或 zoom 变化时 clamp，恢复空间后可回到用户尺寸；
4. compact/comfortable 仅切换 density token，不压缩可点击目标和焦点轮廓；
5. 长路径、翻译、模型名和错误按 Pattern 的 wrap/truncate/Inspector 规则处理，禁止横向页面溢出；
6. Design System 独立 package/version；Token/Primitive/layout 变更写 changeset 与迁移说明；
7. lint 禁止 raw color、任意 z-index、随意媒体断点和重复 primitive；Storybook 使用纯合成 fixtures；
8. 视觉基线覆盖中英文、主题、密度、最小/典型/宽窗口、200% zoom、forced colors、motion reduced；差异需人工审批。

**命令/DTO/Patch**：`LayoutPreferenceDto` 只含 panel/density 枚举与受限尺寸；Design System 公开 API 只能从 package index 导入，禁止深路径。

**边界、错误与恢复**：超窄窗口、200%/系统大字体、panel preference 损坏、长翻译、breaking token change、截图字体/平台抗锯齿差异；无合法三栏空间时确定降级为 drawer/单栏。

**安全**：Storybook 不打入生产包；fixture 无真实 Prompt/Secret。

**测试**：断点/拖拽/clamp/恢复、200% zoom、键盘调整 panel、长文案、API extractor、lint、visual、tree-shaking、production bundle scan。

**DoD**：最小支持窗口与 200% zoom 不遮挡主动作；布局偏好可恢复/重置；视觉变更有证据且生产包不含 Storybook/测试数据。

## 8. GSAP 功能规格

### GSAP-001：Motion Tokens 与统一节奏

**用户行为**

- 页面、面板、Tool 与反馈动效使用一致且克制的速度、距离和缓动；
- 动效不改变业务完成时刻，也不延迟焦点、审批或错误可见性。

**实现步骤**

1. 定义 duration/ease/distance/stagger semantic token，至少含 instant/fast/standard/emphasis；
2. Token 输出为 TypeScript 常量与 CSS variables，GSAP config 只从 token adapter 读取；
3. 默认仅动画 transform/opacity；width/height/top/left 等布局属性需例外记录和性能证据；
4. 每个产品 Pattern 声明允许的 motion role：enter/exit/expand/attention/scroll；
5. 业务状态与 DOM 语义先提交，动画只呈现已发生的结果；
6. Error/Approval/Question/Stop/focus target 立即可用，不等待 stagger/onComplete；
7. 禁止远程 easing/plugin、模型文本驱动时序和页面局部 magic number。

**命令/DTO/Patch**：`MotionTokens`、`MotionRole` 是本地设计系统 API；不访问 Pinia 业务 store、Bridge 或官方 Client。

**边界、错误与恢复**：Token 缺失、未知 role、低 FPS、多个状态同帧发生；未知配置回到 instant 终态。

**安全**：不把模型文本拼成 selector/config；不执行远程 easing/plugin；动效不能遮蔽安全警告。

**测试**：Token completeness、role 映射、仅 transform/opacity lint、错误/Interaction 即时可用、视觉与性能基线。

**DoD**：所有动效时序可追溯到 token；业务不依赖动画回调完成；无页面私有 motion magic number。

### GSAP-002：`useMotionScope` 生命周期与资源清理

**用户行为**

- 页面、Session、虚拟行或 Overlay 卸载/重用后不残留动画、Listener 或内联样式；
- 快速切换时新组件不会被旧 Timeline 改写。

**实现步骤**

1. `useMotionScope(root)` 内部创建唯一 `gsap.context()` 和 owner id；
2. scope 提供 `to/fromTo/timeline/quickTo/matchMedia` 封装，所有实例登记到资源注册表；
3. Vue watcher cleanup 先 kill/clearProps 旧 tween 再创建新 tween，并以 renderEpoch 防止晚到 callback；
4. `onScopeDispose` 执行 context.revert、timeline.kill、matchMedia.revert 和自建 input listener/RAF 清理，且幂等；
5. selector/ref 只能位于 scope root；虚拟列表 row key/epoch 改变立即 dispose 旧 owner；
6. route、Session generation、Dialog close、Renderer reload 都走同一 cleanup contract；
7. 清理异常被局部捕获并记录无内容 MotionStats，不能阻断 Vue 卸载或业务状态。

**命令/DTO/Patch**：`MotionScope`、`MotionOwnerId`、`MotionStatsDto`；composable 不接 transport DTO，生命周期由 Vue scope 驱动。

**边界、错误与恢复**：root 未挂载、组件快速 remount、route 销毁、虚拟 row recycle、watcher 同帧重跑、cleanup throw；最终强制回合法 CSS 终态。

**安全**：不使用全局 selector，不把模型文本/ID直接拼 selector；Stats 不含 Session/node 内容。

**测试**：mount/unmount、watch replace、20 次 route/Session/Tool 切换、虚拟回收、cleanup fault、tween/listener/inline style 回基线。

**DoD**：所有 GSAP 调用位于 owned context；20 次切换后 Timeline/Listener 不增长；无旧动画修改新 epoch DOM。

### GSAP-003：真实用户状态变化与 Reason-coded 动效

**用户行为**

- 真实用户导航、开关面板、展开 Tool 或新 Interaction 有合适反馈；
- 流式 Token 不闪烁，历史补页、重连、快照恢复和虚拟回收不“飞入”。

**实现步骤**

1. 所有触发传 `MotionReason`：user-navigation/user-toggle/modal-open/live-event/history-prepend/snapshot-reset/reconnect/virtual-recycle；
2. 仅 user-* 与符合策略的 live-event 播放；system restore/prepend/reconnect/recycle/token-delta 直接终态；
3. 页面、Sidebar/Inspector、Dialog/Popover 先建立路由、布局、语义和 Focus Trap，再动画 transform/opacity；
4. pending local echo 只用极短 opacity，不逐 token；新语义节点完成可轻量入场；
5. Tool expand 先记录虚拟列表 anchor，再动画内部表面；ResizeObserver/scroll compensation 保证锚点；
6. Error/Approval/Question 立即可见；巨大 DOM 不逐项 stagger；
7. 同一 owner 新用户动作从当前值打断/反向，旧 transition callback 由 epoch 丢弃；
8. 动画不修改 Conversation/Pinia/Interaction 数据，交互逻辑不依赖 `onComplete`。

**命令/DTO/Patch**：`MotionTransitionRequest {ownerId,role,reason,epoch}`；Conversation 使用稳定 node key 和 patch reason，不读取 raw event。

**边界、错误与恢复**：节点同帧 insert+update、虚拟回收、Tool高度变化、terminal burst。

**安全**：不通过动画降低危险操作可见性。

**测试**：各 patch reason、stream burst、prepend、reconnect、virtualization、anchor误差。

**DoD**：动画不破坏 ≤2px anchor 和 ≤160 mounted rows。

### GSAP-004：可取消滚动与用户输入接管

**用户行为**

- 自动滚动可随时用滚轮、触摸、指针和键盘打断；
- 用户接管后保持 Conversation 锚点，不被晚到 tween 或流式 Patch 抢回尾部。

**实现步骤**

1. Scroll tween 由 ScrollMachine 唯一创建；
2. wheel/touchstart/pointerdown/scroll keys 在同一帧 kill tween、使 owner epoch 失效并转 DETACHED；
3. programmatic scroll 携原因和目标 anchor；仅用户点“回到底部/跳转”可 FORCE_FOLLOW；
4. `autoKill` 之外保留显式 input listeners，避免虚拟容器/触控板差异；listeners 归 GSAP-002 scope；
5. 输入与 tween 同帧时用户输入优先；旧 `onUpdate/onComplete` 先检查 epoch；
6. focus navigation 使用浏览器必要滚动，不强加平滑；
7. history prepend compensation 直接同步应用，不动画；Tool 高度变化遵循 CONV 锚点修正；
8. hidden tab/窗口失焦时取消非必要 scroll tween，恢复后不自动重播。

**命令/DTO/Patch**：`ScrollMotionRequest {reason,targetAnchor,ownerEpoch}`、`ScrollInterruptReason`；状态真值在 Conversation `ScrollMachine`。

**边界、错误与恢复**：输入与 programmatic scroll 同帧、连续跳转、target 被虚拟回收、prepend/resize 同时发生、hidden tab；目标失效则停在当前可见锚点。

**安全**：模型/Tool 内容不能触发 FORCE_FOLLOW；输入 telemetry 不记录按键内容或滚动位置。

**测试**：wheel/touch/pointer/所有 scroll keys、同帧竞态、hidden/visible、target recycle、prepend、keyboard/NVDA，断言一帧内停止且锚点误差 ≤2px。

**DoD**：用户输入一帧内取得控制；晚到 callback 不重夺滚动；取消后锚点与 FOLLOWING/DETACHED 状态一致。

### GSAP-005：Reduced Motion、性能与 Motion QA

**用户行为**

- 系统或应用选择减少动态效果时无强制运动，功能、焦点和状态反馈保持完整；
- 长时间运行不会因动效逐渐变慢，低性能设备仍可使用。

**实现步骤**

1. `MotionPolicy` 合并 OS `prefers-reduced-motion` 与本地偏好，默认尊重 OS；不得提供绕过 OS 的强制全量动效模式；
2. 使用 `gsap.matchMedia()` 在 reduce 模式令 duration=0、取消 stagger/视差/平滑滚动并直接写终态，保留 focus/aria/status；
3. preference/OS 运行时变化立即 kill 不再允许的 tween、revert 旧 matchMedia scope，再以新 policy 稳定到终态；
4. 记录活跃 tween/timeline 数量和单帧 layout/paint；同屏并发超过预算直接终态；
5. 禁止动画 height/width/top/left 的 lint/review rule，特例需性能证据；
6. 页面 hidden 时暂停/取消非必要 timeline；`will-change` 只在动画期间添加并清除；
7. E2E 在 normal/reduced 两种模式执行功能、截图和时序断言；低端 CPU/GPU 节流验证长任务；
8. 20 次路由/Session/Tool 展开后 tween/listener/inline style 计数回基线。

**命令/DTO/Patch**：`MotionPolicy {allowed,durationScale,scrollBehavior}`、测试模式只读 `MotionStatsDto`；均不可控制业务。

**边界、错误与恢复**：动画中 OS 设置变化、低 FPS、matchMedia 不可用、动画插件加载失败、context cleanup throw；全部降级为 CSS 终态。

**安全**：Reduced Motion 偏好只存本地，不作为用户画像遥测；统计无内容、输入或 Session ID。

**测试**：OS/应用 reduce 切换、动画中切换、键盘/焦点/ARIA 功能等价、长稳、低端节流、快速操作、泄漏、长任务、visual regression。

**DoD**：Reduced Motion 直接终态且功能等价；稳态无孤儿 tween；Motion 不使性能门槛退化超过 10%。

## 9. i18n 功能规格

### I18N-001：文案域、Key 与加载架构

**用户行为**

- 首发完整支持 `zh-CN`、`en-US`，切换不需要重启；缺翻译有稳定 fallback。

**实现步骤**

1. 按 app/workspace/session/conversation/tool/interaction/settings/error 域拆字典；
2. key 使用稳定语义名，不把英文原文当 key；
3. 首屏基础域同步内置，非首屏按 route lazy load；
4. 缺 key 开发环境显著报错，生产 fallback en-US 后显示 key而非空白；
5. TypeScript 生成 key union，构建检查未使用/缺失 key；
6. ICU message处理复数/选择，不手工字符串拼接；
7. 模型/Tool/user content 始终原样作为参数的 text node。

**命令/DTO/Patch**：locale bundle 是签名应用静态资源，Host不能下发可执行翻译。

**边界、错误与恢复**：lazy chunk失败、key缺失、插值类型错、长翻译。

**安全**：翻译与参数不经 innerHTML；不信任内容不能成为 format string。

**测试**：key completeness、fallback、chunk失败、恶意插值、production bundle。

**DoD**：业务组件无用户可见硬编码；两语言功能矩阵完整。

### I18N-002：Locale 切换与 Intl 格式化

**用户行为**

- 时间、持续时长、数字、文件大小和列表符合当前语言；模型时间戳语义准确；切换即时更新。

**实现步骤**

1. preference 保存 `system/zh-CN/en-US`，resolved locale 单独派生；
2. 使用 `Intl.DateTimeFormat/RelativeTimeFormat/NumberFormat/ListFormat/PluralRules`；
3. 时间存 epoch/ISO，格式化时读取当前 locale/timezone；
4. 长持续时间使用稳定单位策略，不每秒重建整个树；
5. locale revision 作为 Worker/渲染缓存 fence；
6. `<html lang>`、日期输入和 aria labels 同步；
7. 系统语言改变仅 system 模式响应。

**命令/DTO/Patch**：DTO 不传预翻译业务文案，只传 messageKey + safe parameters；上游原 message为 fallback detail。

**边界、错误与恢复**：不支持 locale、invalid timezone、DST、未来时间、极大数。

**安全**：timezone/locale 是枚举/验证值；不用于路径/命令。

**测试**：时区、DST、复数、文件大小、切换、Worker late result。

**DoD**：所有日期数字使用 Intl；切换不重建领域资源。

### I18N-003：伪本地化、内容边界与翻译 QA

**用户行为**

- 长中文/英文不会截断关键操作；模型输出不被错误翻译；术语一致。

**实现步骤**

1. 生成膨胀、重音、可选 RTL 镜像 pseudo locale；
2. CI 截图覆盖关键页面和 200% zoom；
3. 建立 Harness、Session、Workspace、Tool、Prompt、Goal、Subagent 术语表；
4. 明确三类内容：产品文案可翻译、官方稳定错误映射翻译、不可信内容原样；
5. Carrier 原始错误仅在诊断安全详情，不作为主文案；
6. 发布前运行 missing/unused/placeholder mismatch 检查；
7. 每个新功能 DoD 必须包含 zh/en 文案。

**命令/DTO/Patch**：翻译参数 schema固定；placeholder缺失构建失败。

**边界、错误与恢复**：超长文本、CJK断行、emoji、双向字符、术语冲突。

**安全**：Bidi控制符在路径/ID显示中可视化或隔离；翻译不扩大权限描述。

**测试**：pseudo截图、长文本、Bidi、placeholder fuzz、术语 lint。

**DoD**：两语言与 pseudo 无 P0布局问题；功能清单不存在漏翻项。

## 10. A11y 功能规格

### A11Y-001：语义、键盘和焦点基础

**用户行为**

- 不使用鼠标可完成启动、选择 Session、发送、停止、审批、回答、设置与诊断；
- 焦点位置始终可见且符合操作顺序。

**实现步骤**

1. 使用 landmarks、heading hierarchy、button/input/list等原生语义；
2. 定义全局 Tab 顺序与 Skip Link；
3. `:focus-visible` 在全部主题/forced colors 达标；
4. 路由导航把焦点移到主标题，Session Patch 不抢焦点；
5. 虚拟列表聚焦项保留/安全转移；
6. 快捷键在 editable/composition中避让；
7. 所有 pointer 动作有键盘等价。

**命令/DTO/Patch**：每个交互组件文档化 keyboard matrix。

**边界、错误与恢复**：元素卸载、错误页替换、快速 route、虚拟回收。

**安全**：焦点不可被模型内容诱导到隐藏操作；禁止正 tabindex序号。

**测试**：纯键盘 E2E、axe、NVDA焦点日志、forced colors。

**DoD**：关键流程纯键盘完成；无焦点陷阱或丢失。

### A11Y-002：Dialog、Menu、Combobox 与危险决策

**用户行为**

- Dialog/菜单/选择器遵循标准键位；危险操作和 Approval 清楚可辨；关闭后回到触发点。

**实现步骤**

1. Dialog focus trap、初始焦点、Escape策略、aria-modal；
2. Menu Arrow/Home/End/Escape；Combobox 输入与 listbox active descendant；
3. destructive confirm 标题说明真实影响，默认焦点按风险规范；
4. Approval allow/reject 不只靠颜色/位置；
5. Popover与虚拟内容保持稳定 aria owner；
6. 异步 pending 时不移除 label，使用 busy/status；
7. 关闭/失效恢复原 trigger 或安全 fallback。

**命令/DTO/Patch**：Primitive统一实现，业务层不得另造键盘逻辑。

**边界、错误与恢复**：trigger已卸载、nested dialog、request突然过期、IME。

**安全**：不能用自动聚焦/动画诱导 allow；危险动作需明确文本。

**测试**：APG键盘矩阵、NVDA、过期竞态、嵌套 overlay、reduced-motion。

**DoD**：所有复杂控件通过自动与人工测试；危险决策语义无歧义。

### A11Y-003：Live Region、流式输出与状态播报

**用户行为**

- 能获知回答开始/完成、Tool 状态、错误、待审批和新消息，但不会被每个 Token 打断。

**实现步骤**

1. 建立唯一 Announcement Coordinator；
2. 流式 token区域 `aria-live=off`；
3. 只播报语义边界：start/complete/fail/cancel/interaction-required/new-content-count；
4. 高频事件按 Session/类型合并并限制速率；
5. 后台 Session 只播报高优先级 interaction，不播全文；
6. 用户在 DETACHED 时播报新节点数量而非内容；
7. 错误消息关联当前控件和错误摘要。

**命令/DTO/Patch**：`AnnouncementEvent` 是本地封闭类型，不允许任意模型字符串直接入 live region。

**边界、错误与恢复**：多 Tool 同时完成、快速 cancel/complete、切 Session、屏幕阅读器延迟。

**安全**：不自动朗读 Prompt、响应、Secret、路径、命令全文。

**测试**：播报次数/顺序、5k event/s、后台 Session、NVDA人工脚本。

**DoD**：长流式任务播报有用且不洪泛；敏感正文零自动播报。

### A11Y-004：Zoom、Reflow、Contrast 与发布审计

**用户行为**

- 200% zoom、最小支持窗口、Windows高对比和 reduced-motion 下仍能完成所有核心任务。

**实现步骤**

1. 以 reflow 优先，避免固定像素高度截断；Conversation 保留唯一主滚动；
2. 200% 时三栏转换 drawer/单栏，Composer与Stop固定可达；
3. 文本对比、非文本控件、focus indicator 按 WCAG AA；
4. forced-colors 使用系统颜色；
5. target size、错误识别、状态一致性按 2.2 检查；
6. CI运行 axe，RC运行 NVDA人工回归；macOS发布后加 VoiceOver；
7. 每个已知问题有 severity、owner、期限，严重问题阻塞发布。

**命令/DTO/Patch**：A11y测试矩阵纳入功能清单与发布证据。

**边界、错误与恢复**：长翻译、系统大字体、4K/小屏、forced color icon、浏览器 zoom变化。

**安全**：不可把安全警告在高对比/zoom下隐藏或截断。

**测试**：axe、截图、键盘、NVDA、200% zoom、forced-colors、reduced-motion。

**DoD**：Axe critical/serious=0；人工主流程通过；无安全提示不可达。

## 11. 开发顺序

1. 冻结 Settings/Credential DTO、错误、Secret 通道和容量限制；
2. 完成 Utility Settings Schema normalizer 与 `describe` 只读页；
3. 完成 path mutation + revision CAS + conflict UI；
4. 完成 Credential describe/set/unset 的 Secret-safe 通道；
5. 完成 Windows OS Keychain Provider 与签名 Helper；
6. 完成 restart semantics、Settings document/Agent preset打开；
7. 完成 Plugin Inventory 与 Runtime About；
8. 建立 Foundation Tokens、主题和基础 Primitives；
9. 建立 Patterns/Product Surfaces 与 Storybook；
10. 接入 `useMotionScope` 和受控页面/Tool动效；
11. 完成 zh-CN/en-US/pseudo 与 Intl；
12. 完成键盘、NVDA、Zoom、Forced Colors、Reduced Motion；
13. 完成安全、视觉、性能、泄漏和真实安装包 E2E。

## 12. 验收清单

- [ ] Renderer 不导入官方 Settings/Credentials/Schema Class；
- [ ] `settings.describe` 的 Secret 全部保持 redacted；
- [ ] 未支持 schema 只读/fail closed，不动态执行；
- [ ] 正式设置写全部携 expectedRevision；
- [ ] conflict/UNKNOWN 不自动重放写操作；
- [ ] restart 设置不会静默重启运行中的 Harness；
- [ ] 打开设置文档/Agent preset 不接受 Renderer路径；
- [ ] Plugin Inventory 完全只读且 moduleName不用于动态加载；
- [ ] Credential API 不存在明文读路径；
- [ ] Secret 不进入 Pinia、localStorage、日志、trace、Metric、crash、诊断、URL；
- [ ] 正式 Credential Provider 使用 OS Vault，故障不降级明文；
- [ ] Windows Helper 已签名、哈希固定、最小权限且无网络；
- [ ] Key 轮换对下一请求生效；
- [ ] 业务组件无 raw color/z-index/duration magic number；
- [ ] Primitive keyboard/A11y矩阵通过；
- [ ] Light/Dark/System/Forced Colors 均通过视觉和对比测试；
- [ ] 所有 GSAP 位于 owned context 并只影响表现；
- [ ] prepend/reconnect/virtual recycle/token 不播放动效；
- [ ] 用户输入一帧内取消自动滚动；
- [ ] zh-CN/en-US/pseudo 功能文案完整；
- [ ] 模型/Tool/user内容从不作为翻译格式或 HTML；
- [ ] 全核心流程纯键盘和 NVDA 可完成；
- [ ] Axe critical/serious=0，200% zoom/reduced-motion功能完整；
- [ ] 20 次页面切换后 listener、Worker、Observer、Tween 回到基线。

## 13. 模块完成定义

SET-001～SET-006、CRED-001～CRED-004、DS-001～DS-005、GSAP-001～GSAP-005、I18N-001～I18N-003、A11Y-001～A11Y-004 必须全部具备实现、Schema、错误恢复、安全和测试证据。任何可回读 Secret、明文凭据降级、无 CAS 设置覆盖、业务依赖动画回调、模型内容使用 `innerHTML`、关键流程无法键盘完成或高对比模式隐藏安全信息的实现，都属于发布阻塞项。
