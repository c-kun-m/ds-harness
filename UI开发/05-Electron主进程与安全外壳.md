# 05：Electron 主进程与安全外壳

## 1. 文档目标

本文件定义桌面应用 Main Process 的全部职责、接口、状态机和验收门禁。完成本模块后，应用应具备一个可启动、可恢复、可安全承载 Vue Renderer 与 Harness Bridge Utility 的桌面外壳；此时即使业务页面尚未完成，也不能存在任意网络、任意 IPC、任意文件或任意导航能力。

固定进程边界如下：

```text
Electron Main
  ├─ 创建并保护 BrowserWindow
  ├─ 创建 Bridge Utility Process
  ├─ 管理 Harness Sidecar 生命周期
  ├─ 代理经过授权的 OS 能力
  └─ 分发 MessagePort，但不解析 Session/Conversation 业务

Preload
  └─ 暴露固定、版本化、可撤销的桌面 API

Bridge Utility
  └─ 持有官方 DSH Client、Cordis、Controller、Conversation Projection、Cookie

Vue Renderer
  └─ 只消费本项目 DTO/Patch；无 Node、无官方 DSH 包、无网络、无 Secret
```

本文件的“限额”均为本项目 V1 工程合同，不声称是 Electron 或 Harness 的默认值；修改限额必须同时修改 Schema、测试与发布兼容记录。

## 2. 边界与非职责

### 2.1 Main 可以做什么

- 管理应用启动、单实例、窗口、Utility、Harness、更新与退出。
- 注册 `app://desktop` 并提供签名包内的静态 Renderer 资源。
- 验证 IPC sender、消息 Schema、deadline 和容量。
- 打开系统文件/目录选择器、受控外链、剪贴板写入、通知等原生能力。
- 保存不敏感的窗口状态和应用偏好。
- 汇总进程健康状态、版本信息和脱敏诊断。

### 2.2 Main 禁止做什么

- 不导入 `@deepseek-ai/dsh-*`、Cordis、官方 Controller 或 Conversation Projection。
- 不维护 Workspace、Session、Turn、Tool、Approval 或 Queue 的业务状态。
- 不读取、改写或扫描 Session JSONL。
- 不持有 Harness Cookie；启动 Token 只能短暂存在于 Supervisor 的一次性对象中。
- 不把任意字符串解释成 IPC 方法、Shell 命令、文件路径或 URL。
- 不向 Renderer 暴露 `ipcRenderer`、`shell`、`fs`、`child_process`、真实文件句柄或 MessagePort 底层帧。

## 3. 上游与 Electron 依据

- Electron Utility Process 支持 Node 环境和可转移 `MessagePortMain`，适合作为官方 Client 隔离进程：[Electron Utility Process](https://www.electronjs.org/docs/latest/api/utility-process)。
- Electron 要求对特权 IPC 校验 sender，Renderer 应启用 sandbox 与 context isolation：[Electron Security](https://www.electronjs.org/docs/latest/tutorial/security)、[Process Sandboxing](https://www.electronjs.org/docs/latest/tutorial/sandbox)。
- 自定义标准协议必须在 `app.ready` 前声明，handler 在 ready 后安装：[Electron Protocol](https://www.electronjs.org/docs/latest/api/protocol/)。
- 固定上游基线是 `dsh-v0.1.2-alpha.4`、commit `4e84901e6471b79ec0338099867ebb4606d12bb5`。Main 与上游的唯一直接关系是启动固定 Runtime；任何协议或业务关系均由 Bridge 拥有。

## 4. 依赖与目录

### 4.1 依赖

允许依赖：

- `electron/main` 与 `electron/common` 的主进程 API。
- Node 标准库。
- `packages/desktop-contracts` 中不依赖 Electron、Vue、Harness 的纯合同。
- 本项目的日志、配置、更新、Runtime Supervisor 和安全模块。

禁止依赖：

- Vue、Pinia、GSAP、浏览器 DOM 包。
- 所有 `@deepseek-ai/dsh-*` 与 Cordis 包。
- Renderer 的组件、Store 或路由。

### 4.2 建议目录

```text
apps/desktop/src/main/
  bootstrap/
    start-desktop.ts
    single-instance.ts
    app-paths.ts
  protocol/
    register-scheme.ts
    asset-manifest.ts
    handle-app-request.ts
    security-headers.ts
  windows/
    create-main-window.ts
    window-registry.ts
    window-state.ts
    renderer-recovery.ts
  ipc/
    sender-policy.ts
    native-command-router.ts
    port-broker.ts
    request-registry.ts
  native/
    file-capabilities.ts
    external-link.ts
    clipboard.ts
    notifications.ts
  bridge/
    bridge-supervisor.ts
    bridge-handshake.ts
  lifecycle/
    shutdown-coordinator.ts
    power-events.ts
  security/
    content-policy.ts
    permissions.ts
  diagnostics/
    main-health.ts

packages/desktop-contracts/src/
  main.ts
  native.ts
  bridge-handshake.ts
  errors.ts
  limits.ts
```

## 5. 公共合同

### 5.1 主进程状态

```text
AppPhase =
  BOOTSTRAPPING
  | RECOVERY_CHECK
  | STARTING_SERVICES
  | READY
  | DEGRADED
  | QUITTING
  | TERMINATED
```

只允许以下主路径：

```text
BOOTSTRAPPING → RECOVERY_CHECK → STARTING_SERVICES → READY
STARTING_SERVICES → DEGRADED
READY ↔ DEGRADED
任一非终态 → QUITTING → TERMINATED
```

### 5.2 Main 请求信封

```ts
interface MainRequestEnvelope<Operation extends MainOperation, Payload> {
  readonly uiProtocolVersion: number
  readonly rendererInstanceId: string
  readonly requestId: string
  readonly deadlineAt: number
  readonly operation: Operation
  readonly payload: Payload
}

interface MainReplyEnvelope<Value> {
  readonly requestId: string
  readonly ok: boolean
  readonly value?: Value
  readonly error?: DesktopError
}
```

`operation` 必须是编译期封闭联合，首版只允许：

```text
system.getAppInfo
system.openExternal
system.writeClipboard
system.showNotification
file.pickFiles
file.pickDirectory
file.revokeCapability
file.revealCapability
window.getState
window.setSidebarWidth
window.setInspectorWidth
diagnostics.export
runtime.getStatus
runtime.restart
update.getStatus
update.check
update.install
```

业务命令不经过此路由；Workspace、Session、Conversation、Interaction、Settings 通过 Renderer 与 Bridge 之间的专用 MessagePort。

### 5.3 文件能力

```ts
interface FileCapability {
  readonly id: string
  readonly kind: 'file' | 'directory'
  readonly displayName: string
  readonly mime?: string
  readonly size?: number
  readonly issuedAt: number
  readonly expiresAt: number
  readonly permissions: readonly ('read' | 'reveal')[]
}
```

Renderer 永远看不到能力背后的真实路径。Main 与 Bridge 通过内部一次性解析接口传递真实路径；该内部接口不进入 Preload 公共 API。

## 6. 功能总表

| ID | 功能 | 优先级 | 主要产物 |
|---|---|---:|---|
| ELM-001 | 应用启动、目录与单实例 | P0 | Bootstrap、AppPaths、启动状态机 |
| ELM-002 | `app://desktop` 静态资源协议 | P0 | Scheme、Asset Manifest、Security Headers |
| ELM-003 | 安全 BrowserWindow 与窗口注册表 | P0 | Window Factory、Window Registry |
| ELM-004 | 导航、权限、新窗口与外链策略 | P0 | Navigation/Permission Policy |
| ELM-005 | Main IPC 身份、Schema、超时与取消 | P0 | Native Command Router |
| ELM-006 | Renderer—Bridge MessagePort 分发 | P0 | Port Broker、Handshake |
| ELM-007 | 文件与目录 Capability Broker | P0 | Opaque Capability Store |
| ELM-008 | 剪贴板、通知和受控系统动作 | P1 | Native Capability Services |
| ELM-009 | Bridge Utility 生命周期管理 | P0 | Bridge Supervisor |
| ELM-010 | Renderer 崩溃与窗口恢复 | P0 | Recovery Coordinator |
| ELM-011 | 系统休眠、唤醒与网络切换协作 | P1 | Power Event Adapter |
| ELM-012 | 全应用有界退出 | P0 | Shutdown Coordinator |

## 7. 功能详细规格

### ELM-001：应用启动、目录与单实例

**行为**

- 第一个进程成为唯一 Owner；第二个进程不得启动另一套 Bridge 或 Harness，只能向 Owner 发送经过校验的激活意图，然后退出。
- 启动时解析并冻结 `config`、`cache`、`logs`、`runtime`、`harness-home`、`backups` 六类目录；Harness Home 不得放入可随意清理的 cache。
- 检查上次异常退出标记、未完成更新标记和 Runtime Home 独占锁，再进入服务启动。

**实现步骤**

1. 在调用 `app.whenReady()` 前执行 scheme 声明与 `app.requestSingleInstanceLock()`。
2. 创建 `AppInstanceId`，写入仅含版本和时间的运行标记；正常退出时原子清除。
3. 使用 `app.getPath()` 解析基础目录，再拼接固定子目录；逐个创建并检查读写权限。
4. 显式装配 `WindowRegistry`、`BridgeSupervisor`、`HarnessSupervisor`、`NativeCapabilityBroker`，禁止通过可变全局单例隐式获取。
5. 第二实例只接受 `focus` 或经过 Schema 校验的“打开受支持本地资源”意图；V1 不接受远程 URL deep link。

**接口或消息**

- `startDesktop(): Promise<DesktopApplication>`。
- `AppPaths` 是只读对象，不向 Renderer 暴露真实 Harness Home。
- Main 内部事件：`app.phaseChanged { previous, next, reason, at }`。

**状态机**

- 使用第 5.1 节 `AppPhase`。
- 一旦进入 `QUITTING`，所有新能力请求返回 `APP_SHUTTING_DOWN`。

**限额**

- 主窗口最多 1 个；V1 不创建任意业务子窗口。
- 第二实例 argv 总长度上限 32 KiB，参数数量上限 64。
- 启动恢复扫描只读取固定标记文件，不递归扫描 Harness Home。

**错误与恢复**

- 配置损坏：保留原文件，使用默认 UI 配置进入 `DEGRADED`；不能自动重置 Harness 数据。
- Harness Home 锁被占用：显示单实例/残留进程恢复页，不绕过锁。
- 目录不可写：显示目录和安全错误码，但不暴露不必要的用户路径到 Renderer 日志。

**安全**

- 第二实例输入视为不可信；禁止把 argv 拼成 Shell、HTML 或任意 URL。
- 环境变量不得覆盖 Runtime 可执行路径、Preload 路径或 Renderer 资源目录。

**测试**

- 连续启动 10 个实例，只产生一个 Main、一个 Bridge、一个 Harness。
- 覆盖损坏配置、只读目录、残留标记、占用锁、中文与空格路径。
- 属性测试任意 argv 不得触发命令执行或路径越界。

**Definition of Done**

- 目录分类、所有权和清理策略有自动测试。
- 单实例测试在已打包 Windows 制品中通过。
- 所有启动失败均映射为稳定错误码和用户恢复动作。

### ELM-002：`app://desktop` 静态资源协议

**行为**

- Renderer 只从 `app://desktop/` 加载签名应用内资源，不使用 `file://`，不加载远程脚本。
- 只响应构建时生成的 Asset Manifest 中存在的路径；未知路径除 SPA 允许的导航入口外返回 404。

**实现步骤**

1. 在 `app.ready` 前执行 `protocol.registerSchemesAsPrivileged`，仅设置 `standard:true`、`secure:true`、`codeCache:true`；不得设置 `bypassCSP`、`allowServiceWorkers`。
2. 在 ready 后对窗口所使用的精确 Session 安装 `session.protocol.handle('app', handler)`。
3. 解析 URL 后要求 `hostname === 'desktop'`、无 userinfo、无非默认 port、无 query 驱动文件选择。
4. 以构建生成的 `asset-manifest.json` 做 URL path → ASAR 内相对资源的精确映射，不直接把 URL path 与磁盘路径 `join`。
5. 对 `GET`/`HEAD` 返回正确 MIME、`nosniff`、CSP、Referrer-Policy、Permissions-Policy；其他方法返回 405。
6. HTML 禁止缓存；带内容 Hash 的资源允许 immutable 缓存。

**接口或消息**

- `registerDesktopSchemeBeforeReady(): void`。
- `installDesktopProtocol(session, manifest): Promise<Dispose>`。
- 不存在 Renderer 可调用的协议注册接口。

**状态机**

```text
UNDECLARED → DECLARED → INSTALLED → DISPOSED
```

重复安装、ready 后首次声明或 dispose 后继续响应均为编程错误。

**限额**

- URL 长度上限 8 KiB。
- Manifest 条目上限由构建门禁固定；运行时不做目录枚举。
- 单个未压缩前端资源不得超过 25 MiB；更大资源必须拆分或外置为受控内容。

**错误与恢复**

- Manifest 缺失、签名不符或入口缺失：拒绝打开主窗口并进入 Recovery UI。
- 单资源读取失败：返回无敏感路径的 404/500；不得回退到任意磁盘文件。

**安全**

- CSP 从 `default-src 'none'` 开始，至少包含 `script-src 'self'`、`style-src 'self'`、`img-src 'self' blob: data:`、`connect-src 'none'`、`object-src 'none'`、`frame-src 'none'`、`base-uri 'none'`、`form-action 'none'`。
- 若 GSAP、字体或高亮资源需要额外来源，必须打包本地，不添加 CDN。
- 路径穿越、编码斜杠、反斜杠、NUL 和未登记资源全部拒绝。

**测试**

- 覆盖 `%2e%2e`、双重编码、反斜杠、超长 URL、未知 host、非 GET、缺失 Manifest。
- 在 packaged ASAR 上测试入口、动态 chunk、字体、Worker 和 source map 策略。
- CSP 测试确认 fetch/XHR/WebSocket 到任意地址均失败。

**Definition of Done**

- Dev 与 packaged 模式使用相同 origin 和安全策略；开发期如需 Vite，只能由显式 dev 构建标志开启，正式包路径不可达。
- 资源映射没有 URL 到任意磁盘路径的通用转换。
- 安全头与协议配置被自动快照测试锁定。

### ELM-003：安全 BrowserWindow 与窗口注册表

**行为**

- 创建唯一主窗口，窗口在 Preload、Bridge Port 和首个安全页面准备完成前保持不可见。
- 所有窗口都由 `WindowRegistry` 登记 owner ID、webContents ID、允许 origin 和销毁状态。

**实现步骤**

1. Window Factory 固定设置 `nodeIntegration:false`、`contextIsolation:true`、`sandbox:true`、`webviewTag:false`、`webSecurity:true`、`allowRunningInsecureContent:false`。
2. Preload 路径来自签名应用资源的绝对路径，不从配置或 URL 获取。
3. 使用 `show:false`，在 `ready-to-show` 且 Bridge 握手完成后显示；启动失败则显示本地 Recovery 页面。
4. 为窗口生成不可复用的 `rendererInstanceId`；reload 或 render-process-gone 后必须更换。
5. 保存边界前将坐标限制到当前显示器 workArea；检测屏幕变化并纠正离屏窗口。

**接口或消息**

- `createMainWindow(context): Promise<ManagedWindow>`。
- `ManagedWindow { ownerId, browserWindow, phase, dispose() }`。
- Preload 只能读取公开的 `window.bootstrap` 快照，不读取 BrowserWindow 对象。

**状态机**

```text
CREATING → LOADING → HANDSHAKING → VISIBLE → CLOSING → CLOSED
                    ↘ FAILED
```

**限额**

- V1 仅一个业务窗口；Dialog、Menu 不创建含远程内容的 BrowserWindow。
- 最小尺寸 960×640；恢复尺寸必须落入当前 workArea。
- 页面加载和握手各自有 15 秒 deadline。

**错误与恢复**

- 页面加载失败：最多自动重载一次，然后进入 Recovery 页面。
- Preload 失败或握手版本不匹配：销毁该 webContents，禁止在不安全降级模式继续。
- GPU 崩溃不改变业务真源；Renderer 重建后从 Bridge 请求完整 Snapshot。

**安全**

- 不启用 `enableRemoteModule`、spellcheck 外的额外权限或实验性 Blink feature。
- 生产环境关闭 DevTools 快捷打开；内部构建也不能因此放宽 Node/网络边界。

**测试**

- 自动断言最终 WebPreferences，而不是只测试 Factory 默认参数。
- 注入 Preload 加载失败、超时、Renderer 崩溃、显示器拔插和离屏状态。
- Renderer 中 `process`、`require`、Electron、Node Socket 均不可用。

**Definition of Done**

- 所有 BrowserWindow 均经唯一 Factory 创建。
- 窗口从未短暂展示空白、不可信远程页或未初始化 UI。
- 销毁窗口会撤销 owner 的 IPC、Port、Capability 和 Timer。

### ELM-004：导航、权限、新窗口与外链策略

**行为**

- 主页面不能导航离开 `app://desktop/`，不能创建未经管理的新窗口，不能自行申请摄像头、麦克风、地理位置、USB、串口等权限。
- 用户明确点击的 HTTPS 外链经二次验证后交给系统浏览器。

**实现步骤**

1. `will-navigate` 默认 `preventDefault()`；只有当前文档内部的允许路由由 Vue Router 处理。
2. `setWindowOpenHandler` 永远返回 deny；合法外链转成 `system.openExternal` 意图。
3. 对窗口 Session 安装 `setPermissionRequestHandler` 和 `setPermissionCheckHandler`，默认拒绝。
4. 外链解析后只允许 `https:`，要求无 userinfo、hostname 非空、URL 可规范化；展示目标 hostname 供用户确认。
5. `shell.openExternal` 前再次校验同一个结构化 URL，不接收 Renderer 已拼好的命令。

**接口或消息**

- `system.openExternal({ url, source })`。
- `ExternalOpenDecision = OPENED | USER_CANCELED | DENIED`。

**状态机**

```text
REQUESTED → VALIDATED → CONFIRMING → OPENED
          ↘ DENIED      ↘ CANCELED
```

**限额**

- URL 上限 8 KiB；一次只允许一个外链确认 Dialog。
- 同一 Renderer 每 10 秒最多发起 5 次请求，超限返回 `RATE_LIMITED`。

**错误与恢复**

- OS 打开失败只返回安全原因码，用户可以复制已验证 URL；不得改用 Shell fallback。
- Renderer reload 会取消尚未确认的请求。

**安全**

- 拒绝 `file:`、`javascript:`、`data:`、`vbscript:`、`shell:`、自定义协议和含 userinfo 的 URL。
- URL 文本来自模型时必须显示真实 hostname，不用富文本替代。

**测试**

- 使用混合大小写协议、Unicode hostname、控制字符、双重编码、超长 URL 和重定向诱导测试。
- 权限请求、新窗口、iframe 导航、下载触发均默认失败。

**Definition of Done**

- Renderer 无任何绕过 Main 直接打开外链的路径。
- 所有权限与导航策略均有 packaged E2E。

### ELM-005：Main IPC 身份、Schema、超时与取消

**行为**

- Preload 暴露领域化方法；Main 对每个请求先认证 sender，再解析 Envelope 和 Payload，然后执行固定 handler。
- 页面销毁、owner 变化、deadline 到期或应用退出时，相关请求全部取消。

**实现步骤**

1. 使用静态 Handler Map 注册封闭 `MainOperation`，禁止动态反射调用。
2. 校验 `event.sender` 属于 WindowRegistry 当前窗口，`senderFrame` 是 mainFrame，URL origin 精确为 `app://desktop`，owner ID 与当前握手一致。
3. 先检查原始消息近似字节数，再进行运行时 Schema 解析，避免畸形巨大对象导致深度遍历。
4. 为每个 request 建立 AbortController；deadline、窗口关闭、退出流程触发 abort。
5. 回复统一转成可 structured-clone 的 `MainReplyEnvelope`，不跨边界传 `Error`、Class、Map、Function。

**接口或消息**

- IPC channel 固定为 `desktop:main-request-v1`；不得按功能创建可猜测的无限 channel。
- `cancel { rendererInstanceId, requestId }` 只能取消同 owner 的请求。

**状态机**

```text
RECEIVED → AUTHENTICATED → VALIDATED → RUNNING → SUCCEEDED
          ↘ REJECTED      ↘ REJECTED  ↘ CANCELED | TIMED_OUT | FAILED
```

**限额**

- 单控制消息序列化后上限 256 KiB，嵌套深度 32，数组元素 1,000，字符串 128 KiB。
- 每个 Renderer 同时运行最多 32 个 Main 请求，排队最多 64 个。
- 默认 deadline 30 秒；Dialog 类上限 5 分钟；调用方不能请求无限 deadline。

**错误与恢复**

- 使用 `IPC_SENDER_DENIED`、`IPC_SCHEMA_INVALID`、`IPC_LIMIT_EXCEEDED`、`IPC_DEADLINE_EXCEEDED`、`IPC_CANCELED`。
- Handler 异常转换为 DesktopError；内部 stack 只进入脱敏本地日志。

**安全**

- 必须先验证 sender，后读取敏感 Payload。
- 重复 requestId 在同 owner 生命周期内拒绝，防止重放。

**测试**

- Fuzz 任意对象、getter/proxy、循环结构、深层数组、旧 owner、子 frame 和伪造 origin。
- 关闭窗口时验证所有 pending handler 都收到 abort 且无晚到回复。

**Definition of Done**

- 没有 `send(channel:string, payload:any)` 或 `invoke(method:string)` 类型接口。
- 100 万组轻量属性输入不造成越权、崩溃或无界分配。

### ELM-006：Renderer—Bridge MessagePort 分发

**行为**

- Main 只负责创建和转移 Port，不解析 Workspace/Session/Conversation 帧。
- 每次 Renderer 或 Bridge 重建都生成新 `portEpoch`；旧 Port 必须关闭，旧帧不能进入新页面。

**实现步骤**

1. Bridge 进入 `WAITING_FOR_PORT` 且 Renderer 完成 Preload 握手后，Main 创建 `MessageChannelMain`。
2. 将一端通过 Utility `postMessage(..., [port])` 转移给 Bridge，另一端通过 `webContents.postMessage(..., [port])` 转移给 Preload。
3. 两端分别交换 `hello { uiProtocolVersion, ownerId, portEpoch }`；只有版本与 owner 匹配才发布 ready。
4. Preload 将原始 Port 封装在闭包，向页面暴露领域方法和订阅，不把 Port 对象挂到 `window`。
5. 任一端 close、reload 或 crash 时 Main 关闭对应 epoch，并重新执行完整握手。

**接口或消息**

```text
Main → Bridge: bridge-port/install { ownerId, portEpoch } + transferredPort
Main → Preload: renderer-port/install { ownerId, portEpoch } + transferredPort
Bridge/Preload → Main: port-handshake/result { portEpoch, ok, protocolVersion }
```

业务帧合同由 Bridge 文档定义，Main 只读取握手信封。

**状态机**

```text
ABSENT → CREATING → INSTALLING → HANDSHAKING → ACTIVE → CLOSING → CLOSED
                                  ↘ FAILED
```

**限额**

- 每个主窗口仅一个 active Port pair。
- 握手 5 秒超时；失败最多自动重建一次，之后进入 DEGRADED。
- Main 不为业务帧建立第二条旁路 IPC。

**错误与恢复**

- 版本不匹配：关闭 Port 并显示 `UI_PROTOCOL_INCOMPATIBLE`。
- Bridge crash：旧 Port 关闭；新 Bridge 完成认证后才建立新 Port。
- Renderer crash：Bridge 保持 Harness 状态，旧 owner 的请求全部取消，新 Renderer 请求 Snapshot。

**安全**

- Port 只能转移给 WindowRegistry 中当前主 frame 和当前 Bridge PID。
- Port epoch 和 owner ID 是隔离标识，不替代 Schema 校验。

**测试**

- 覆盖握手乱序、重复 hello、版本错配、旧 Port 晚到消息、Bridge/Renderer 在握手中崩溃。
- 重载 Renderer 20 次，Port、listener 和 pending request 数量回到基线。

**Definition of Done**

- Main 代码不导入任何业务 DTO reducer，也不按业务 topic 分支。
- 只有完成双端握手的 Port 才能使 UI 进入可交互状态。

### ELM-007：文件与目录 Capability Broker

**行为**

- 用户通过系统 Dialog 明确选择文件或目录后，Renderer 只收到带 TTL 的 opaque capability；使用者按声明权限消费。
- 文件能力默认一次性用于附件读取；目录能力可用于创建 Workspace，但不能变成任意目录浏览 API。

**实现步骤**

1. Dialog 请求使用固定 options 模板；Renderer 只能提供有限过滤器和选择用途，不能提供任意起始路径。
2. 对选择结果执行绝对路径规范化、存在性、类型、symlink/final path 与基础元数据检查。
3. Capability Store 以随机 128-bit ID 记录 owner、真实路径、用途、权限、签发/过期时间和消费次数。
4. Renderer 调用只携带 capability ID；Main 内部通过专用 Port 向 Bridge 交付一次性路径解析结果。
5. owner 销毁、TTL 到期、消费完成或显式 revoke 时清除记录。

**接口或消息**

- `file.pickFiles({ purpose:'attachment', filters }) → FileCapability[]`。
- `file.pickDirectory({ purpose:'workspace-create' }) → FileCapability | null`。
- 内部 `resolveCapability({ id, expectedPurpose, consumer:'bridge' })` 不向 Renderer 暴露。

**状态机**

```text
ISSUED → CONSUMING → CONSUMED
  ├→ EXPIRED
  └→ REVOKED
```

目录能力可配置有限多次消费，但每次都重新校验 final path。

**限额**

- 每 owner 活跃 capability 最多 128 个；默认 TTL 10 分钟。
- 单次选择最多 20 个附件；元数据检查不读取完整文件。
- 文件内容不通过 Main IPC 整块传输；由 Bridge 在能力解析后按业务限额读取。

**错误与恢复**

- 用户取消返回 `null`/空数组，不作为错误。
- 路径消失、类型变化或 symlink 目标变化返回 `FILE_CAPABILITY_STALE`，要求重新选择。
- 不自动扩大权限或回退到字符串路径。

**安全**

- capability 与 renderer owner、用途和 consumer 绑定；不可跨窗口或跨启动复用。
- 日志只记录 capability ID 的短 hash 和错误码，不记录完整路径。

**测试**

- 覆盖路径穿越、junction/symlink、TOCTOU、网络路径、设备路径、中文/超长路径、过期和重放。
- 验证 Renderer 无法枚举 Capability Store 或猜测有效 ID。

**Definition of Done**

- 所有 Renderer 发起的文件/目录功能只接受 capability，不接受真实路径。
- owner 清理测试证明 capability 不泄漏。

### ELM-008：剪贴板、通知和受控系统动作

**行为**

- 只开放用户发起的剪贴板写入、通知显示和受控 reveal；V1 不提供后台剪贴板读取、任意可执行文件启动或通用 Shell。

**实现步骤**

1. 为每个动作建立独立 Schema 和显式用途。
2. 剪贴板只写纯文本；富 HTML 写入另立安全评审。
3. 通知正文使用应用生成的短摘要，不直接注入完整模型输出。
4. reveal 只能接受仍有效且带 `reveal` 权限的 capability。

**接口或消息**

- `system.writeClipboard({ text })`。
- `system.showNotification({ kind, titleKey, bodyKey, args })`。
- `file.revealCapability({ id })`。

**状态机**

- 无持久业务状态；请求遵循 ELM-005 的请求状态机。

**限额**

- 剪贴板文本 1 MiB；通知标题 128 字符、正文 512 字符。
- 通知每分钟最多 10 条，同类状态聚合。

**错误与恢复**

- OS 能力不可用时返回 `NATIVE_CAPABILITY_UNAVAILABLE`；不得使用 Shell 命令替代。
- 页面销毁后的通知请求取消。

**安全**

- 禁止读剪贴板、模拟键鼠、启动任意程序。
- 通知动作回调只能生成固定 app intent，不能携带可执行 URL。

**测试**

- 覆盖超长文本、控制字符、恶意通知内容、无权限和无图形会话。

**Definition of Done**

- 每个系统动作都有明确用户触发点、速率限制和审计事件。
- 不存在通用 `executeNativeAction(name,args)`。

### ELM-009：Bridge Utility 生命周期管理

**行为**

- Main 在 ready 后以固定入口创建唯一 Bridge Utility；Utility 崩溃不直接终止 Harness，Main 可在熔断规则内重建 Bridge。

**实现步骤**

1. 使用 `utilityProcess.fork()` 加载签名包内绝对入口；设置最小 env、固定 cwd、`serviceName:'dsh-desktop-bridge'`。
2. stdout/stderr 走脱敏结构化日志；生产不允许 `inherit` 到任意父 Console。
3. 启动握手校验 app build、UI protocol、compat version 和 Utility PID。
4. 向 Utility 一次性交付 Harness launch descriptor；Token 通过不可记录的单次消息传入。
5. 监听 `spawn`、`message`、`exit` 和不可恢复错误；保存状态但不解析会话业务。
6. 退出时先请求 Bridge dispose；超时后调用 `kill()` 并确认 exit。

**接口或消息**

```text
bridge.init { appBuild, uiProtocolVersion, compatVersion, launchDescriptor }
bridge.ready { bridgeInstanceId, capabilitiesDigest }
bridge.health { phase, connectionState, generation, queueDepth }
bridge.shutdown { deadlineAt }
bridge.shutdownComplete { bridgeInstanceId }
```

**状态机**

```text
STOPPED → SPAWNING → HANDSHAKING → READY → STOPPING → STOPPED
             ↘ FAILED      READY → CRASHED → BACKOFF → SPAWNING
```

**限额**

- 唯一 Bridge；握手 10 秒，正常 dispose 10 秒。
- 5 分钟内崩溃 3 次进入 `CRASH_LOOP`，停止自动重启。
- Main—Bridge 控制消息 256 KiB；业务流只走 MessagePort。

**错误与恢复**

- 握手失败：结束 Utility，清除 Token，必要时重启 Harness 获取新 Token。
- Bridge 崩溃：所有结果未知的写操作由新 Bridge 恢复后对账，Main 不自动重放。
- Crash loop：进入 Recovery 页面，提供重启 Runtime、导出诊断和退出。

**安全**

- Utility 入口、依赖闭包和 ASAR 完整性必须验证。
- 环境中不继承签名密钥、Updater Secret、无关 API Key、`NODE_OPTIONS` 或调试参数。

**测试**

- 注入启动失败、握手错版、异常退出、V8 fatal、重复 ready、退出超时。
- 重启 Bridge 100 次，无 Port、listener、process 或 Cookie 泄漏。

**Definition of Done**

- Main 只依据 Bridge 控制快照决策生命周期，不读取官方 Controller。
- Bridge crash/restart 不会重复发送 Prompt、Approval 或其他写请求。

### ELM-010：Renderer 崩溃与窗口恢复

**行为**

- Renderer 崩溃或 reload 时 Harness 与 Bridge 保持运行；新 Renderer 以新 owner 和 Port 获取全量 Snapshot。

**实现步骤**

1. 监听 `render-process-gone`、`unresponsive`、`did-fail-load` 与 `destroyed`。
2. 立即撤销旧 owner 的 Main 请求、Capability、Port 和 Dialog。
3. 对可恢复崩溃最多自动重建一次；连续崩溃进入无业务脚本的 Recovery 页面。
4. 新页面完成协议与 Port 握手后，Preload 请求 `bridge.bootstrapSnapshot`；禁止复用旧 Pinia 状态作为真源。
5. 保存并恢复不敏感布局，但草稿恢复策略由 Renderer 文档定义。

**接口或消息**

- `renderer.lifecycle { ownerId, phase, reason }` 仅内部日志。
- Bridge 收到 `renderer.detached { ownerId }` 与新 `renderer.attached { ownerId, portEpoch }`。

**状态机**

```text
HEALTHY → UNRESPONSIVE → HEALTHY | RELOADING
HEALTHY → GONE → RELOADING → HANDSHAKING → HEALTHY
                     ↘ RECOVERY_MODE
```

**限额**

- 60 秒内最多自动恢复 1 次；第二次进入 Recovery Mode。
- Snapshot 等待上限 15 秒；期间 UI 不开放写操作。

**错误与恢复**

- Bridge 同时不可用时，先恢复 Bridge，再恢复 Renderer Snapshot。
- 旧 owner 的晚到响应全部丢弃并计数。

**安全**

- Recovery 页面仍使用相同 sandbox、CSP 和 Preload 最小接口。
- 不因崩溃临时开启 DevTools、NodeIntegration 或远程页面。

**测试**

- 在 streaming、分页、Dialog、Approval 等不同阶段强杀 Renderer。
- 验证未提交操作不被重复提交，已提交操作以服务端 Snapshot 对账。

**Definition of Done**

- Renderer 恢复不依赖 Main 缓存业务状态。
- 20 次 reload 后资源数量回到基线。

### ELM-011：系统休眠、唤醒与网络切换协作

**行为**

- Main 只传播 OS 生命周期事实；Bridge 决定连接重试，Harness Supervisor 决定进程健康，Main 不直接修改 Session 状态。

**实现步骤**

1. 监听 `powerMonitor` 的 suspend、resume、lock-screen、unlock-screen、shutdown（平台支持时）。
2. 每个事件携带单调序号和 wall-clock 时间发送给 Bridge/Supervisor。
3. suspend 前停止新原生 Dialog；resume 后触发健康探测，而不是假设原 Socket 可用。
4. 网络变化作为“建议重新探测”信号，真正 connection generation 由官方 Client 决定。

**接口或消息**

- `system.lifecycle { seq, kind, at }`，kind 为封闭联合。

**状态机**

```text
ACTIVE ↔ SUSPENDED
ACTIVE ↔ LOCKED
任一状态 → OS_SHUTDOWN
```

**限额**

- 生命周期事件合并窗口 250ms；终止/关机事件不合并。
- 不缓存超过最近 32 条，仅记录计数和最终状态。

**错误与恢复**

- resume 后 Bridge 未恢复则进入 DEGRADED，用户可手动重连；Main 不无限重启 Harness。

**安全**

- 锁屏时不得在通知中显示 Prompt、工具参数或工作区内容。

**测试**

- 模拟休眠跨越 WebSocket heartbeat、Token 交换和更新流程；验证旧 generation 事件被拒绝。

**Definition of Done**

- 休眠/唤醒不会触发重复写操作或自动批准交互请求。
- 系统事件监听在退出时全部释放。

### ELM-012：全应用有界退出

**行为**

- 用户退出、系统关机、更新安装和不可恢复故障都进入同一个有界退出协调器；关闭窗口不是直接 `process.exit()`。

**实现步骤**

1. 原子把 AppPhase 设为 `QUITTING`，拒绝新写请求。
2. 通知 Renderer 进入只读关闭页，取消 Main 原生请求。
3. 请求 Bridge 停止新调用、取消可取消读取、dispose 官方 Client/Cordis/Projection。
4. 请求 Harness Supervisor 正常 drain；等待持久化与进程退出。
5. 关闭 Port、窗口、Protocol Handler、日志和更新资源。
6. 清除运行标记并退出；任一步超时都继续执行剩余清理，最终才强制回收。

**接口或消息**

- `shutdown.request({ reason, deadlineAt })`。
- `ShutdownReport { steps[], forced, durationMs }`；报告不得含 Secret/业务正文。

**状态机**

```text
IDLE → QUIESCING → BRIDGE_DRAIN → HARNESS_DRAIN → NATIVE_CLEANUP → COMPLETE
任一步 → ESCALATING → COMPLETE
```

**限额**

- 建议总退出预算 15 秒：Bridge 5 秒、Harness 使用其官方 5 秒 dispose 上界、其他资源 5 秒；实际执行可并行但必须保留各阶段证据。
- 第二次退出请求视为升级：立即缩短到强制清理路径，但仍要回收进程树。

**错误与恢复**

- 单步失败不得阻止后续步骤；全部错误聚合进 ShutdownReport。
- 更新安装只有收到 Harness 已退出和数据 flush 证据后才能继续。

**安全**

- 退出报告、Windows 事件和崩溃日志不能包含 readiness Token、Cookie、Prompt 或 API Key。
- 禁止使用 `process.exit()` 跳过清理，除最终强制兜底之外。

**测试**

- 在启动、认证、streaming、tool、approval、更新和 Renderer 崩溃各阶段触发退出。
- 强杀 Main 后由 Runtime 文档定义的 Job Object/guardian 验证无孤儿进程。

**Definition of Done**

- packaged Windows 应用连续退出 500 次无 Bridge、Harness 或 Tool 孤儿。
- 正常退出留下的运行标记、锁、Port、Listener 和 Timer 均为零。

## 8. 开发任务顺序

1. `ELM-T001`：建立 Main 依赖边界规则，禁止 DSH/Vue/Renderer 导入。
2. `ELM-T002`：实现 AppPaths、配置 Schema、运行标记和单实例。
3. `ELM-T003`：实现 `app://desktop` scheme、Asset Manifest 和安全头测试。
4. `ELM-T004`：实现唯一 Window Factory 与 WindowRegistry。
5. `ELM-T005`：实现导航、权限、新窗口和外链 deny-by-default 策略。
6. `ELM-T006`：定义 MainRequest/Reply Schema 和 SenderPolicy。
7. `ELM-T007`：实现请求 registry、deadline、abort 和 owner 清理。
8. `ELM-T008`：实现 Utility BridgeSupervisor 与控制面握手。
9. `ELM-T009`：实现 MessagePort Broker 与 epoch 替换。
10. `ELM-T010`：实现 FileCapability Store 和 Dialog。
11. `ELM-T011`：实现剪贴板、通知和 reveal 最小能力。
12. `ELM-T012`：实现 Renderer crash/reload 恢复。
13. `ELM-T013`：实现 power lifecycle adapter。
14. `ELM-T014`：实现 ShutdownCoordinator 和 packaged Windows E2E。

每项任务必须单独测试、单独提交；不得使用 `git commit --no-verify`。ELM-T003～T009 未通过前，不接入正式业务页面。

## 9. 模块验收清单

- [ ] Main、Preload、Bridge、Renderer 的权限边界与代码依赖边界一致。
- [ ] Main 不导入任何官方 DSH、Cordis、Controller 或 Conversation 代码。
- [ ] 正式页面只从 `app://desktop/` 加载，`file://` 和远程页面不可达。
- [ ] BrowserWindow 的 sandbox、context isolation、Node 隔离和 CSP 有自动断言。
- [ ] 导航、新窗口和权限请求默认拒绝。
- [ ] 所有 Main IPC 先校验 sender，再校验容量和 Schema。
- [ ] 不存在通用 IPC、通用 Shell、通用路径或通用 URL 接口。
- [ ] 业务数据只通过 Bridge MessagePort；Main 不解析业务帧。
- [ ] Renderer 只能持有 opaque file capability，不能获得真实路径。
- [ ] Bridge/Renderer 重建会更换 owner 与 portEpoch，旧消息被丢弃。
- [ ] Renderer 崩溃后从 Bridge Snapshot 恢复，不依赖 Main 业务缓存。
- [ ] 正常退出和 Main 强杀场景均无孤儿进程。
- [ ] 所有日志、错误和退出报告通过 Secret Redactor。

## 10. 本模块完成定义

只有以下证据同时存在时，本模块才算完成：

1. 单元、属性、集成与 packaged Windows E2E 全部通过。
2. Electron 安全配置、协议资源、IPC sender 与 Capability 攻击测试通过。
3. Main 的依赖图证明没有上游 DSH 或 Vue 业务依赖。
4. 20 次 Renderer reload 和 100 次 Bridge 重启无资源增长。
5. 500 次应用启停无孤儿进程、残留锁和 Secret 泄漏。
6. 每个功能 ID 均能追溯到代码 Owner、测试用例和独立 Git 提交。
