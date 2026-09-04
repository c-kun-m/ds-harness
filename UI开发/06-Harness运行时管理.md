# 06：Harness 运行时管理

## 1. 文档目标

本文件定义如何把固定版本的官方 DeepSeek Harness 作为受管理的本机 Sidecar 服务运行，包括制品校验、数据目录、启动参数、就绪解析、一次性 Token 交接、健康判定、重启熔断、优雅退出和 Windows 进程树回收。

该模块的最终结果不是“能把命令跑起来”，而是提供一个确定的受管服务合同：

```text
已验证的 Runtime 制品
  → 独占并保护 Harness Home
  → 只在 127.0.0.1:随机端口启动官方 web profile
  → 安全消费带 Token 的 readiness
  → 交给 Bridge 完成 Cookie 认证
  → 在进程、认证与官方 generation 都就绪后发布 READY
  → 故障时有界重启，关闭时排空并回收整棵进程树
```

V1 只支持应用自己启动的本机 Harness；不支持用户输入远程地址、LAN 服务、共享 Host 或连接任意现有进程。

## 2. 已核验的上游事实

以下内容来自当前固定源码，不是本项目推测：

| 事实 | 固定源码 |
|---|---|
| 上游版本 | `dsh-v0.1.2-alpha.4`，commit `4e84901e6471b79ec0338099867ebb4606d12bb5` |
| Node 要求 | 根 `package.json` 为 `^22.19.0 || >=24.0.0` |
| Canonical 启动形式 | `dsh --profile web`；`dsh web` 是硬编码 alias |
| 随机端口 | `--port 0` 被明确支持，由 OS 选择端口 |
| 本机绑定 | Web profile 默认 `127.0.0.1`；`--host 0.0.0.0` 被 CLI 明确拒绝 |
| 就绪信号 | `dsh web: <authenticated-url>` 只在 Loader 树 settle 且 Connection 认证可用后输出；上游注释明确允许 supervisor 观察此行后发起 RPC |
| 认证入口 | URL 根路径携带进程启动 Token；`GET /` 成功后返回 303、`Set-Cookie` 并跳转到干净 `/` |
| 官方停止 | CLI 的 SIGTERM/SIGINT 会 dispose 根 Fiber；`ProcessShutdown` 的默认强制上界为 5,000ms |
| Web stdin 生命周期 | 当前 Web profile 没有像 SDK/ACP profile 那样调用 `exitOnStdinEnd`，因此 Windows 桌面端必须增加很薄的生命周期 companion 或证明等价的跨平台优雅关闭 |
| Session 格式 | `SESSION_FORMAT_VERSION = 0`，上游明确不承诺预发布版本间兼容 |

对应源码入口：

- `deepseek-harness/packages/bundle/web-app/src/startup.ts`
- `deepseek-harness/packages/bundle/web-app/src/index.ts`
- `deepseek-harness/packages/client/connection/src/browser-auth.ts`
- `deepseek-harness/apps/cli/src/args.ts`
- `deepseek-harness/apps/cli/src/profile-boot.ts`
- `deepseek-harness/apps/cli/src/process-shutdown.ts`
- `deepseek-harness/packages/boot/cmdline/src/index.ts`
- `deepseek-harness/packages/core/session/src/types.ts`

## 3. 边界与所有权

### 3.1 Runtime Supervisor 拥有

- Runtime Manifest、文件完整性和平台适配检查。
- Harness Home 独占锁和异常退出标记。
- Sidecar/guardian 的启动、stdin/stdout/stderr、PID、退出码和整棵进程树。
- Readiness Parser，以及 Token 被 Bridge 接收前的极短生命周期。
- Sidecar 状态机、启动/关闭 deadline、退避和 Crash Loop Fuse。
- 向 Main/Bridge 发布不含业务内容的运行状态。

### 3.2 Runtime Supervisor 不拥有

- Harness Cookie、HTTP/WS、官方 Connection generation；这些由 Bridge 拥有。
- Session、Workspace、Prompt、Tool、Approval、Subagent 等业务状态。
- Session 文件解析、迁移或修复。
- Runtime 下载和安装；Updater 负责准备并原子切换已验证制品。
- Renderer 页面和恢复状态的具体展示。

## 4. 依赖与目录

### 4.1 建议目录

```text
apps/desktop/src/main/runtime/
  runtime-supervisor.ts
  runtime-state.ts
  runtime-manifest.ts
  runtime-verifier.ts
  runtime-command.ts
  runtime-environment.ts
  runtime-home-lock.ts
  readiness-parser.ts
  token-handoff.ts
  process-guardian.ts
  process-health.ts
  restart-policy.ts
  runtime-shutdown.ts
  runtime-errors.ts

packages/harness-runtime-overlay/
  src/desktop-lifecycle.ts
  cordis.desktop.patch.yml
  package.json

native/runtime-guardian/windows/
  # 创建 Job Object、启动 Runtime、透传管道、父进程消失时清理

packages/test-support-desktop/src/runtime/
  fake-runtime.ts
  readiness-fixtures.ts
  process-tree-assertions.ts
```

### 4.2 依赖

- `desktop-contracts`：状态、错误和 launch descriptor。
- Electron Main 生命周期，但不依赖 Renderer。
- OS 文件锁与 Windows Job Object 的经过审计实现。
- Bridge 控制面：只接收 `authenticated`、`generationReady`、`shutdownComplete` 等摘要。
- 日志 Redactor 必须在任何原始 stdout/stderr sink 之前可用。

## 5. Runtime Manifest 与公共合同

### 5.1 Runtime Manifest

```ts
interface RuntimeManifestV1 {
  readonly manifestVersion: 1
  readonly runtimeId: string
  readonly upstream: {
    readonly tag: 'dsh-v0.1.2-alpha.4'
    readonly commit: '4e84901e6471b79ec0338099867ebb4606d12bb5'
    readonly packageVersion: '0.1.2-alpha.4'
  }
  readonly nodeRange: '^22.19.0 || >=24.0.0'
  readonly packagedNodeVersion: string
  readonly platform: 'win32' | 'darwin' | 'linux'
  readonly arch: 'x64' | 'arm64'
  readonly entryRelativePath: string
  readonly profile: 'web'
  readonly overlayRelativePath: string
  readonly overlaySha256: string
  readonly files: readonly { path: string; size: number; sha256: string }[]
  readonly officialClientDigest: string
  readonly remoteProtocolDigest: string
  readonly sessionFormatVersion: 0
  readonly builtAt: string
}
```

Manifest 由发布流水线生成并签入发布制品；运行时不得根据本机 `node_modules` 临时推断版本。

### 5.2 Launch Descriptor

```ts
interface HarnessLaunchDescriptor {
  readonly runtimeInstanceId: string
  readonly pid: number
  readonly origin: string             // 只允许 http://127.0.0.1:<port>
  readonly token: OneShotSecret       // 仅 Main→Bridge 一次性控制消息
  readonly runtimeId: string
  readonly upstreamCommit: string
  readonly protocolDigest: string
  readonly startedAt: number
}
```

`OneShotSecret` 只是类型与生命周期约束，不得实现 `toJSON()`、`toString()` 或通用日志格式化。

### 5.3 Runtime 状态机

```text
STOPPED
  → VERIFYING
  → ACQUIRING_HOME
  → SPAWNING
  → WAITING_READINESS
  → AWAITING_BRIDGE_AUTH
  → READY

READY ↔ DEGRADED

任一启动态 → START_FAILED
任一运行态 → CRASHED → BACKOFF → VERIFYING
任一非终态 → STOPPING → STOPPED
CRASHED/BACKOFF → CRASH_LOOP
VERIFYING/ACQUIRING_HOME → BLOCKED
```

每次状态转换必须记录：`previous`、`next`、`reasonCode`、`runtimeInstanceId?`、`at` 和 `correlationId`，不得记录 Token、Cookie、Prompt 或工具内容。

## 6. 功能总表

| ID | 功能 | 优先级 | 主要产物 |
|---|---|---:|---|
| HRS-001 | Runtime 制品发现、版本与完整性校验 | P0 | Manifest Loader、Verifier |
| HRS-002 | Harness Home 分类、独占锁与启动恢复 | P0 | Home Lease、Recovery Marker |
| HRS-003 | Desktop Profile Overlay | P0 | Web Patch、stdin Lifecycle Companion |
| HRS-004 | 启动命令与环境冻结 | P0 | Launch Plan、Env Policy |
| HRS-005 | Windows Guardian 与 Sidecar 创建 | P0 | Process Guardian、Job Object |
| HRS-006 | Readiness 解析、Token 脱敏与一次性交接 | P0 | Secret-safe Parser、Launch Descriptor |
| HRS-007 | 认证屏障、健康判定与状态发布 | P0 | Readiness Barrier、Health Snapshot |
| HRS-008 | 崩溃识别、退避重启与熔断 | P0 | Restart Policy、Crash Loop Mode |
| HRS-009 | 优雅停止、升级停稳与强制清理 | P0 | Shutdown Controller |
| HRS-010 | 数据格式与版本切换保护 | P0 | Compatibility Guard |
| HRS-011 | Runtime 日志、指标与诊断 | P1 | Redacted Process Telemetry |

## 7. 功能详细规格

### HRS-001：Runtime 制品发现、版本与完整性校验

**行为**

- Supervisor 只从当前应用发布 Manifest 选择与 OS/CPU 匹配的固定 Runtime，不搜索 PATH，不使用用户全局安装的 `dsh` 或 Node。
- 启动前验证应用签名/ASAR 完整性、Manifest、入口文件和整个 Runtime 文件闭包。

**实现步骤**

1. 从签名应用资源固定路径读取 `runtime-manifest.json`，先做大小限制和运行时 Schema 校验。
2. 要求 platform、arch、App compatibility set、upstream commit、official client digest、protocol digest 全部等于当前应用编译常量。
3. 对 Manifest 中每个文件做规范化相对路径检查，再校验大小与 SHA-256；拒绝 Manifest 外的可执行入口替换。
4. 验证 packaged Node 版本满足 `^22.19.0 || >=24.0.0`；开发模式也不得偷偷使用不满足范围的系统 Node。
5. 可选执行受限 `dsh --version` smoke，但它不能替代文件闭包和 Manifest 校验。

**接口或消息**

- `verifyRuntime(expected): Promise<VerifiedRuntime>`。
- `VerifiedRuntime` 只能由 verifier 构造；Launch Plan 不接受字符串路径。
- 状态：`VERIFYING`。

**状态机**

```text
UNVERIFIED → VERIFYING → VERIFIED
                 ↘ REJECTED
```

每次应用启动重新验证关键入口与 Manifest；完整闭包可以用受签名、与应用版本绑定的验证缓存优化，但首次与更新后必须全量验证。

**限额**

- Manifest 上限 4 MiB、文件条目上限 100,000、单路径 UTF-8 上限 1,024 bytes。
- 哈希并发最多 `min(4, logicalCpu)`，避免启动时抢占全部 CPU。
- 验证缓存只保存 hash/mtime/size，不缓存 Secret。

**错误与恢复**

- `RUNTIME_MANIFEST_INVALID`、`RUNTIME_PLATFORM_MISMATCH`、`RUNTIME_HASH_MISMATCH`、`RUNTIME_NODE_UNSUPPORTED` 全部 fail closed。
- 用户只能重新安装/更新到已签名制品；不得提供“仍然运行”按钮。

**安全**

- 禁止环境变量、注册表、当前工作目录或 Renderer Payload 改写 Runtime 路径。
- 路径规范化后必须仍在固定 runtime root 内；拒绝 symlink/junction 逃逸。

**测试**

- 篡改入口、依赖、Manifest、overlay、大小、平台、arch、Node 版本和 symlink。
- 在正式签名/ASAR 产物上执行，而非只测试源码目录。

**Definition of Done**

- 被篡改任意受保护文件后启动必然失败。
- 发布制品能追溯到唯一 upstream commit、lockfile 和构建 provenance。

### HRS-002：Harness Home 分类、独占锁与启动恢复

**行为**

- App 为 Harness 提供专属、持久的 Home；缓存、日志或应用卸载的临时数据不得与 Session 数据混在一起。
- 同一 Home 同时只允许一个受管 Runtime 写入。

**实现步骤**

1. 解析固定数据根并建立 `homes/current`、`homes/staging`、`backups`、`locks`、`run` 分区。
2. 使用 OS 级排他文件锁建立 `HomeLease`；锁对象由 Main 持有到 Sidecar 完全退出。
3. 写入原子运行标记：app build、runtime ID、PID、启动时间；标记只用于诊断，不替代 OS 锁。
4. 启动发现残留标记时先确认没有活跃 lease/进程，再进入恢复检查；禁止只根据陈旧 PID 删除数据。
5. 将 `DSH_HOME` 作为冻结 Launch Environment 传给 Sidecar。

**接口或消息**

- `acquireHarnessHome(runtimeId): Promise<HomeLease>`。
- `HomeLease { root, runMarker, releaseAfterProcessExit() }`。
- Renderer 只看 `HOME_IN_USE` 等状态，不获得真实路径。

**状态机**

```text
FREE → ACQUIRING → OWNED → RELEASING → FREE
               ↘ BLOCKED
```

**限额**

- 锁等待不超过 3 秒；V1 不做无限等待。
- 启动阶段不递归扫描 Home，不读取 Session 正文。
- 磁盘空间检查和备份配额由发布文档定义，Supervisor 只消费其结果。

**错误与恢复**

- 锁被占用：进入 `BLOCKED/HOME_IN_USE`，提示定位另一个实例或残留进程。
- 标记残留但锁可用：记录异常退出，继续只读诊断；不自动删除 Session。
- Home 不可写：拒绝启动，不回退到临时目录。

**安全**

- Home root 不受 Renderer 输入控制。
- 日志默认不记录完整路径；诊断包中使用路径类别和 hash。

**测试**

- 两进程并发抢锁、Main 崩溃、陈旧 PID、只读目录、磁盘满、中文/空格/长路径。
- 验证清缓存、更新和卸载选项不会误删 Home。

**Definition of Done**

- 同一 Home 永远不会出现两个写入 Runtime。
- 异常退出后的下一次启动不需要删除用户数据即可恢复或给出明确阻塞原因。

### HRS-003：Desktop Profile Overlay

**行为**

- 仍启动官方 `web` profile 和官方 Host Remote，不加载官方 React 页面。
- Overlay 只修正桌面表层差异：不打开浏览器、不向模型声称用户在官方 Web GUI、保留 readiness，并让 stdin EOF 进入官方有界退出流程。

**实现步骤**

1. 创建版本化 `cordis.desktop.patch.yml`，作为 `--patch` 层叠在官方 Web bundle 之后。
2. 完整重述 `web-runtime` 配置：`openBrowser:false`、`printUrl:true`、`surfaceContext:false`，并保留 `trustedHosts` 的原始动态表达式；上游 patch 语义会整体替换目标行的 `config`，不得只写一个字段。
3. 插入极薄的 `desktop-lifecycle` Host plugin。该插件使用上游公开 `exitOnStdinEnd(ctx, label)`，使 Main 关闭 stdin 后通过 `ctx.appExit(0)` 和现有 `ProcessShutdown` dispose 根 Fiber。
4. Lifecycle plugin 不注册模型工具、Session 事件、Remote API 或配置写入。
5. 构建时对官方默认组合与 Overlay 后组合做 diff，禁止意外删除 session/workspace/gateway/connection 等 Host 行。

**接口或消息**

- Overlay 是发布制品的一部分并由 Manifest hash 锁定。
- `desktop-lifecycle` 无外部 Remote；其唯一输入是 stdin EOF，唯一效果是请求官方 appExit。

**状态机**

```text
MOUNTED → WAITING_APP_READY → ACTIVE → EOF_SEEN → EXIT_REQUESTED → DISPOSED
```

EOF 在 app ready 前到达时，由上游 `exitOnStdinEnd` 等待 ready 后请求退出，避免掩盖启动失败。

**限额**

- Overlay 只允许审核过的固定 row id；不允许用户追加任意 `--patch`。
- Lifecycle plugin 不读取 stdin 数据，只监听 EOF。

**错误与恢复**

- Overlay row 不匹配、插件无法解析或组合 diff 异常：构建/启动失败，不静默回到原 Web profile。
- Lifecycle plugin 失败时仍有官方 SIGTERM（POSIX）和 Windows Job Object 强制兜底，但该构建不得进入 GA。

**安全**

- Overlay 路径由 Manifest 提供且已校验；Renderer/用户配置不可修改。
- `trustedHosts` 保持空数组，命令固定绑定 `127.0.0.1`；V1 不扩展 LAN authority。

**测试**

- 对 `dsh --profile web --patch <overlay> --dump-config` 的结果做 golden test。
- stdin EOF 在 ready 前、ready 后、streaming、持久化 flush 中分别测试。
- 验证系统提示和受管 Shell 环境中不出现错误的 Web GUI surface context。

**Definition of Done**

- 官方 Host 功能矩阵保持完整，桌面表层差异全部显式可审计。
- Windows stdin EOF 能触发正常 dispose，且测试不依赖 POSIX signal。

### HRS-004：启动命令与环境冻结

**行为**

- 使用绝对路径、参数数组和 `shell:false` 启动已验证 Runtime；只监听 loopback 随机端口，不打开浏览器。

**实现步骤**

1. 从 `VerifiedRuntime` 生成不可变 Launch Plan。
2. Canonical argv：`--profile web --patch <verified-overlay> --no-open --host 127.0.0.1 --port 0`；launcher flag `--patch` 必须位于 Web app 自己的 flags 之前。
3. 设置固定 cwd 为用户选定的 Workspace 启动上下文或专用安全工作目录；cwd 决策不得来源于未校验字符串。
4. 构建环境白名单：OS 必需项、PATH/PATHEXT、用户目录、临时目录、locale、`DSH_HOME`、显式代理配置和经批准的 provider secret 名称。
5. 移除 `NODE_OPTIONS`、Electron 调试变量、Inspector、签名密钥、Updater Secret 和无关应用凭据。
6. stdout/stderr/stdin 全部使用 pipe，先绑定安全消费者，再允许进程继续输出。

**接口或消息**

- `buildLaunchPlan(VerifiedRuntime, HomeLease, LaunchPolicy): LaunchPlan`。
- `LaunchPlan` 中 argv 是只读数组，不提供 shell command 字符串。

**状态机**

- 无独立运行状态；只在 `SPAWNING` 前生成一次，启动后不可变。

**限额**

- argv 总长上限 32 KiB；环境总大小遵守 Windows 32,767 字符限制并留出 20% 安全余量。
- 单个环境值上限 8 KiB；明确的 provider secret 可单独放宽但不得记录。

**错误与恢复**

- 环境过大、cwd 不可用、入口消失：返回稳定错误并回到 STOPPED；不得切换到 Shell 或 PATH fallback。
- 代理配置非法时拒绝该配置，不能把 Sidecar 暴露到非 loopback。

**安全**

- Secret env 只按确切名称加入且标记 sensitive；日志只输出键名和来源，不输出值。
- 不继承 `ELECTRON_RUN_AS_NODE` 或允许任意 `--inspect`。

**测试**

- 空格/Unicode 路径、恶意参数、超大环境、缺失 PATH、代理、legacy provider secret。
- 捕获真实子进程 argv，证明没有 shell 解释。

**Definition of Done**

- 开发和 packaged 启动使用同一 Launch Plan 生成器。
- 启动日志不能重建任何 Secret 值。

### HRS-005：Windows Guardian 与 Sidecar 创建

**行为**

- Windows 上由受签名 guardian 把 Runtime 及其后代放入带 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的 Job Object；Main 消失时整棵树最终被 OS 回收。
- 正常路径仍优先通过 stdin EOF 让 Harness flush 和 dispose，Job Object 只是兜底。

**实现步骤**

1. Main 启动固定 `runtime-guardian.exe`，guardian 创建 Job Object 和匿名管道。
2. guardian 使用 `CreateProcessW` 以 suspended 状态创建 Runtime，随后 `AssignProcessToJobObject`，成功后恢复主线程。
3. guardian 透明转发 stdin/stdout/stderr并向 Main 报告 Runtime PID；不得解析 Token。
4. Main 持有 guardian 控制句柄；Main/guardian 正常退出时关闭 Job handle。
5. 非 Windows 平台使用进程组/session 与等价的 parent-death/kill-tree 策略，但必须单独验收。

**接口或消息**

- Main↔guardian 使用长度前缀控制帧，仅允许 `spawned`、`spawnFailed`、`terminateTree`、`exited`。
- Harness stdout/stderr 走独立原始 pipe，不能和控制帧共用。

**状态机**

```text
GUARDIAN_STARTING → JOB_CREATED → CHILD_ASSIGNED → RUNNING → DRAINING → EXITED
                                  ↘ SPAWN_FAILED
任一运行态 → MAIN_GONE → JOB_CLOSED → EXITED
```

**限额**

- 只允许一个 Runtime root；控制帧 64 KiB。
- guardian 握手 5 秒，启动 Runtime 10 秒；readiness 另由 HRS-006 计时。

**错误与恢复**

- 无法创建/设置 Job 或无法 assign child：立即终止尚未运行的 child，构建进入 `RUNTIME_GUARD_UNAVAILABLE`；Windows GA 禁止无 guardian 降级。
- guardian 意外退出按 Runtime crash 处理，不能假设 child 已消失，需验证进程树。

**安全**

- guardian、Runtime 和 Manifest 同属签名制品；控制 pipe 只继承给预期进程。
- 禁止把任意 Renderer 参数转发给 guardian。

**测试**

- 强杀 Main、guardian、Harness；让 Harness 派生 Tool 子进程后再强杀。
- 验证正常退出能 flush，异常退出能在期限内回收整树。

**Definition of Done**

- Windows clean VM 上强杀 Main 100 次，Harness 与后代均在规定期限内消失。
- guardian 失败时应用明确拒绝进入正常工作模式。

### HRS-006：Readiness 解析、Token 脱敏与一次性交接

**行为**

- 原始 stdout 必须先经过 Secret-aware Readiness Parser；只有非敏感输出或已脱敏输出才能进入日志。
- 只接受一次精确的 `http://127.0.0.1:<port>/?token=<non-empty>` 根 URL，并把 Token 一次性交给当前 Bridge。

**实现步骤**

1. 在 spawn 前创建 UTF-8 增量 decoder；处理任意 chunk 边界和 CRLF/LF。
2. 对每行先检测 `dsh web:` 前缀，再解析 URL；不使用宽松正则直接截取后打印。
3. 要求 scheme=`http:`、hostname=`127.0.0.1`、port 1..65535、pathname=`/`、无 hash、恰好一个非空 `token`、无其他 authority/userinfo。
4. 生成 `HarnessLaunchDescriptor`；原始行和 Token 永不进入通用 Logger、异常 message、metrics 或测试 snapshot。
5. 通过一次性 Main→Bridge 控制消息发送；Bridge ACK 后清空 Buffer 引用并将 secret handle 标为 consumed。
6. 后续重复相同行只记 `READINESS_DUPLICATE` 的脱敏计数；不同 origin/token 视为协议违规并停止 Runtime。

**接口或消息**

- `ReadinessParser.push(Buffer): ReadinessEvent[]`。
- `tokenHandoff.offer(descriptor): Promise<ConsumedAck>`；同一 Token 只能调用一次。

**状态机**

```text
COLLECTING → CANDIDATE → VALIDATED → OFFERED → CONSUMED → REDACTED
               ↘ REJECTED      ↘ HANDOFF_FAILED
```

**限额**

- 单行上限 16 KiB，未换行缓冲上限 64 KiB；超限停止 Runtime。
- readiness 默认 deadline 30 秒，正式策略允许 10–120 秒但不能无限。
- stdout 日志限速与轮转由 HRS-011 负责；Token 行无论限速状态都必须被消费/脱敏。

**错误与恢复**

- 启动超时、EOF 前无 readiness、畸形 URL、错误 host、重复冲突均视为本次启动失败。
- Token handoff 在 ACK 前 Bridge 崩溃：Token 状态按“可能已暴露”处理，停止并重启 Runtime获取新 Token，不给第二个 Bridge 重放。

**安全**

- 测试失败输出也只能包含 `<redacted-token>`。
- 不调用 URL 对象的默认字符串化记录 authenticated URL。

**测试**

- Token 每个字符位置切 chunk、UTF-8 噪声、CRLF、无换行、超长行、多 token、userinfo、IPv6、localhost、重定向式 URL。
- 10 万组合成 Secret canary 在 console、日志、异常、snapshot、CI artifact 中命中数为零。

**Definition of Done**

- Readiness Parser 在所有 stdout sink 之前安装。
- Token 只有 Parser、一次性交接对象和 Bridge 认证函数三个允许持有点。

### HRS-007：认证屏障、健康判定与状态发布

**行为**

- 收到 readiness 不等于业务 READY。只有进程存活、Bridge Cookie 交换成功、官方 Connection generation ready、关键 Controller baseline 完成后，Supervisor 才发布 READY。

**实现步骤**

1. Readiness 后转为 `AWAITING_BRIDGE_AUTH`，交付 launch descriptor。
2. Bridge 回报分阶段摘要：`AUTHENTICATED`、`CONNECTION_READY`、`CONTROLLERS_READY`。
3. 全部屏障通过后发布 Runtime READY；其中任一撤回则转为 DEGRADED，而不是保持陈旧 ready。
4. 进程退出是最高优先级终态；Bridge 心跳只证明 Bridge 活着，不覆盖 child exit。
5. 上游 Gateway 默认每 2 秒发 WebSocket ping、2 次未命中会关闭连接；Bridge 应依据官方 carrier/connection state 报告，不另造相互竞争的 WS 重试循环。

**接口或消息**

```text
bridge.runtimeStage {
  runtimeInstanceId,
  stage: AUTHENTICATED | CONNECTION_READY | CONTROLLERS_READY | DEGRADED,
  connectionGeneration?,
  reasonCode?
}
```

- `RuntimeHealthSnapshot` 只包含 phase、PID、uptime、generation、最近错误码和重启次数。

**状态机**

遵循第 5.3 节；`READY → DEGRADED → READY` 必须发生在同一 runtimeInstanceId，Sidecar 重启必须生成新 ID。

**限额**

- Bridge 认证 10 秒、Controller baseline 20 秒；超时转 DEGRADED/失败策略由错误类别决定。
- Bridge 控制健康消息 1 秒最多 2 条，状态变化不合并。

**错误与恢复**

- 401/403、authority 错配、协议指纹错配不可在同一 Token 上循环重试；停止 Runtime重新启动。
- 物理 WS 丢失由官方 Connection 重试；超过其终态后保持 DEGRADED，用户可手动重连或请求受控 Runtime 重启。

**安全**

- 状态消息禁止包含 origin query、Cookie、Host Home 真实路径和用户内容。
- Main 不通过自行 HTTP 请求绕过 Bridge 认证来“探活”。

**测试**

- 进程活着但 Cookie 失败、WS 半开、generation 撤回、Controller baseline 失败、旧 runtime ID 晚到 ready。

**Definition of Done**

- UI 显示 READY 时四层屏障均有证据。
- 任何旧 runtime/connection generation 的健康消息都不能恢复新实例状态。

### HRS-008：崩溃识别、退避重启与熔断

**行为**

- 非预期退出按退出阶段与错误分类；只有受管、可重试且 App 未退出时才自动重启。
- 重启不自动重放任何可能已经到达 Harness 的写操作。

**实现步骤**

1. 记录 `expectedStop` token；只有匹配当前 stop generation 的退出才算正常。
2. 收集退出码、signal/guardian reason、运行时长、最后状态，不记录业务正文。
3. 可重试崩溃按带 jitter 的序列 `1s, 2s, 5s, 10s, 30s` 退避；稳定运行 10 分钟后清零序列。
4. 5 分钟内 3 次非预期退出进入 `CRASH_LOOP`，停止自动重启。
5. 每次重启重新验证 Runtime、重新获取 Home lease 状态、生成新 runtimeInstanceId/Token/Bridge generation。

**接口或消息**

- `restartPolicy.recordExit(ExitFact): RestartDecision`。
- `RestartDecision = STOP | RETRY_AFTER | ENTER_CRASH_LOOP`。
- 用户手动“重启 Harness”会清除一次退避等待，但不会清除 Crash Loop 审计历史；确认后只尝试一次。

**状态机**

```text
CRASHED → CLASSIFYING → BACKOFF → VERIFYING
                    ↘ CRASH_LOOP
                    ↘ STOPPED
```

**限额**

- 同时只能存在一个 spawn attempt；用户连点合并为同一个 Promise。
- Crash 历史最多保存 32 条并持久化脱敏摘要。

**错误与恢复**

- 完整性、协议、Home、配置和数据不兼容错误不可自动重试。
- 端口、瞬时进程错误可重试；达到熔断后展示诊断、重装 Runtime、选择备份、退出等动作。
- 所有未确认写操作统一交给 Bridge 标记 `OUTCOME_UNKNOWN`。

**安全**

- Crash loop 不得切换到用户 PATH 中的其他 `dsh`。
- 手动重启仍执行完整验证与认证，不提供跳过检查选项。

**测试**

- 不同阶段退出、连续崩溃、稳定窗口后复位、用户连点、App 正在退出、旧进程晚到 exit。

**Definition of Done**

- 自动重启有界且确定，永远不会出现双 Runtime。
- 非幂等写操作在重启路径中零自动重放。

### HRS-009：优雅停止、升级停稳与强制清理

**行为**

- 停止先冻结新业务、让 Bridge dispose，再通过 stdin EOF 请求官方根 Fiber 有界释放；只有超时后才终止 Job Object/进程树。

**实现步骤**

1. 接受唯一 stop token，状态转 `STOPPING`；后续 stop 调用加入同一 Promise，第二次用户强制退出可升级。
2. 通知 Bridge 停止新调用并 dispose Client streams，等待其确认。
3. 关闭 Harness stdin 写端；desktop lifecycle companion 调用上游 `ctx.appExit(0)`。
4. 等待官方 5 秒 `ProcessShutdown` 上界外加 guardian/pipe 余量；验证 root PID 与后代均退出。
5. 若未退出，guardian `terminateTree`；仍未退出则记录 fatal cleanup 并阻止更新安装。
6. 进程退出后才释放 Home lease、清运行标记和 Token 对象。

**接口或消息**

- `stopRuntime({ reason, deadlineAt, force }): Promise<RuntimeStopReport>`。
- reason 为 `APP_EXIT | USER_RESTART | UPDATE | RECOVERY | OS_SHUTDOWN`。

**状态机**

```text
RUNNING → QUIESCING_BRIDGE → CLOSING_STDIN → WAITING_EXIT → STOPPED
                                               ↘ TERMINATING_TREE → STOPPED | CLEANUP_FAILED
```

**限额**

- Bridge quiesce 建议 5 秒；Harness 官方 dispose 5 秒；guardian 强制回收 3 秒。
- 总期限由 App Shutdown Coordinator 给出，Supervisor 不得无限延长。

**错误与恢复**

- Bridge 不响应：继续关闭 Harness，但将可能写操作标记未知。
- Harness 非零退出但 stop 已发起：记录停止失败，不进入自动重启。
- 更新流程若无法证明进程树消失和 Home lease 释放，必须中止切换。

**安全**

- 禁止 Shell `taskkill` 拼接 PID；强制终止通过 guardian 持有的 Job handle。
- 不删除 Home 来解决无法退出问题。

**测试**

- 在 LLM stream、Tool 子进程、Approval、持久化写入、启动未 ready 时停止。
- 反复 stop、第二次强制、guardian 不响应、Main 被强杀。

**Definition of Done**

- 正常路径能看到 Bridge disposed 与官方进程退出证据。
- packaged Windows 连续 500 次停止后无任何后代进程或被占用文件。

### HRS-010：数据格式与版本切换保护

**行为**

- Supervisor 不解析或迁移 Session，但必须阻止未经验证的新 Runtime 对当前 Home 写入，也阻止旧 Runtime打开已切换到新格式的数据。

**实现步骤**

1. Home 元数据保存最后成功写入的 runtime ID、upstream commit、session format 声明和 app compatibility set。
2. 当前固定上游格式为 v0且无广泛兼容承诺，因此相同数字 `0` 不能被当成跨 commit 兼容证明。
3. App/Runtime 切换前由 Updater 在 Home 副本上执行真实启动、认证、Session 枚举和 fixture 回放；Supervisor只接受签名的 `MigrationApproval`。
4. 若没有目标 commit 对当前 Home 的验证证据，保持旧 Runtime并阻止自动升级。
5. 新版本已经写入后，回滚必须切回升级前快照；不得让旧 Runtime 打开新 Home。

**接口或消息**

- `CompatibilitySetId` 同时包含 app、Runtime commit、official Client、protocol digest、projection version 和数据验证版本。
- `MigrationApproval { from, to, sourceHomeDigest, stagedHomeDigest, testReportDigest, signature }`。

**状态机**

```text
CURRENT → STAGING_VERIFIED → SWITCH_PENDING → CURRENT_NEW
             ↘ REJECTED          ↘ ROLLED_BACK_TO_SNAPSHOT
```

**限额**

- 未持有 Home lease 时不执行切换。
- 可用磁盘空间、备份数量和复制限额由发布文档定义；空间不足时 fail closed。

**错误与恢复**

- Manifest/metadata 不一致、缺失验证报告或 staged smoke 失败：保持当前版本和 Home 不变。
- 不把上游 `SessionFormatUnsupportedError` 当成损坏；展示正确升级方向并保留原文件。

**安全**

- MigrationApproval 与制品 Manifest 都要验签；Renderer 不能伪造“兼容”。
- 禁止原地破坏性迁移和静默删除无法读取的 Session。

**测试**

- 模拟相同 format number 但不同事件词汇、更新中断、磁盘满、staging 失败、切换后崩溃和回滚。

**Definition of Done**

- 当前 v0 上游不会被无人值守自动升级到未经数据验证的 commit。
- 每次 Runtime 切换均有可审计的副本测试与回滚证据。

### HRS-011：Runtime 日志、指标与诊断

**行为**

- 记录足以定位启动、退出和健康问题的结构化信息，但默认不记录 Prompt、Response、Tool 参数、完整路径、Token、Cookie 或 provider secret。

**实现步骤**

1. stdout 先经过 HRS-006；非 Token 行再经过通用 Redactor 和行级限速器。
2. stderr 单独记录，仍执行 URL/query/header/secret 模式脱敏。
3. 每次状态转换、spawn、readiness、auth stage、exit、restart decision 和 stop step 生成结构化事件。
4. 指标包含 verify/start/readiness/auth/stop 时长、restart 次数、crash loop、PID 存活；不以 Session ID 等高基数值做 label。
5. 诊断包只包含 Manifest 摘要、状态历史、退出事实、进程树检查和脱敏日志。

**接口或消息**

- `RuntimeDiagnosticSnapshot` 不包含 launch descriptor 的 token 字段。
- 日志事件只能接收已经分类的 safe fields；原始 child chunk 不能直接传给 logger。

**状态机**

- 无独立业务状态；日志 sink 有 `ACTIVE → DEGRADED → CLOSED`，写入失败不能阻断退出。

**限额**

- Runtime 日志建议 5×10 MiB，总 50 MiB；单行记录 64 KiB，超出截断并计数。
- 状态历史内存保留最近 256 条；持久日志依轮转策略。

**错误与恢复**

- 日志目录不可写时进入 memory ring buffer（最多 2 MiB）并告警，不将原始 stdout 打到 console fallback。
- Redactor 失败时丢弃该记录而不是原样写入。

**安全**

- Secret canary 同时扫描 log、diagnostic zip、测试输出和 crash report。
- PID、版本和错误码可记录；Token URL、Cookie header 和环境值不可记录。

**测试**

- 大量 stdout、恶意 ANSI、深层 Error cause、Token 嵌套 URL、日志磁盘满、轮转竞态。

**Definition of Done**

- 10 万组合成 Token/API key/cookie 输入的泄漏命中为零。
- 仅凭诊断包能判断失败阶段、Runtime 版本和退出原因，同时无法恢复用户内容或 Secret。

## 8. 开发任务顺序

1. `HRS-T001`：锁定 Runtime Manifest Schema、CompatibilitySet 与发布目录。
2. `HRS-T002`：实现 Manifest Loader、路径约束和全文件 hash verifier。
3. `HRS-T003`：实现 Harness Home lease、运行标记和异常退出检测。
4. `HRS-T004`：实现并测试 desktop profile overlay 的 config diff。
5. `HRS-T005`：实现 `desktop-lifecycle` stdin EOF companion 及上游 dispose 集成测试。
6. `HRS-T006`：实现 Launch Plan 和环境冻结。
7. `HRS-T007`：实现 secret-aware Readiness Parser；在任何真实 spawn 前先完成 canary 测试。
8. `HRS-T008`：实现 Windows guardian、Job Object 和 pipe 协议。
9. `HRS-T009`：启动真实固定版本 Harness，完成 readiness 与一次性 Token handoff。
10. `HRS-T010`：实现 Bridge 认证/Controller readiness 屏障和 Health Snapshot。
11. `HRS-T011`：实现 exit 分类、退避与 Crash Loop Fuse。
12. `HRS-T012`：实现 Bridge quiesce、stdin EOF、官方 5 秒 dispose 与 guardian 强制清理。
13. `HRS-T013`：实现 Compatibility Guard 与更新系统接口。
14. `HRS-T014`：完成结构化日志、指标、诊断与 packaged Windows 故障测试。

每个任务完成后必须独立提交并运行 Git Hook，禁止 `git commit --no-verify`。HRS-T005、T007、T008、T009、T012 是 P0 Spike；其中任一项未通过，Windows 版本不得开始 GA 功能承诺。

## 9. 模块验收清单

- [ ] Runtime 固定为 `dsh-v0.1.2-alpha.4` / `4e84901e...`，不存在浮动依赖。
- [ ] packaged Node 满足上游 engine，且不复用 Electron Node 运行 Host。
- [ ] Runtime、Overlay、guardian 和依赖闭包均由 Manifest 与签名保护。
- [ ] 启动使用绝对路径、参数数组、`shell:false`。
- [ ] canonical argv 只绑定 `127.0.0.1` 并使用 `--port 0`、`--no-open`。
- [ ] Desktop Overlay 关闭错误的官方 Web surface context并保留完整 Host 能力。
- [ ] 同一 Harness Home 同时只有一个 Owner。
- [ ] Readiness Parser 在所有日志 sink 之前，Token 不落盘、不进 console、不进异常。
- [ ] Token 只向当前 Bridge 交付一次；不确定是否消费时重启 Runtime 获取新 Token。
- [ ] READY 需要进程、认证、Connection generation 和 Controller baseline 四层证据。
- [ ] 自动重启有界；5 分钟 3 次崩溃进入 Crash Loop。
- [ ] 非幂等写操作不在 Runtime 重启后自动重放。
- [ ] stdin EOF 能跨平台触发官方有界 dispose。
- [ ] Windows Job Object 能在 Main 崩溃时回收 Runtime 与 Tool 后代。
- [ ] 当前 Session 格式 v0 不被视为跨 commit 兼容承诺。
- [ ] 更新前必须有 staged Home 验证和可恢复快照。
- [ ] 500 次启停、100 次 Main 强杀无孤儿进程和被占用文件。
- [ ] 日志与诊断包 Secret Canary 命中为零。

## 10. 本模块完成定义

以下证据全部存在，本模块才算完成：

1. 固定发布形态的 Runtime 可在 clean Windows VM 上验证、启动、认证、停稳。
2. 正常退出、Main 崩溃、guardian 异常、Sidecar 崩溃和 Crash Loop 均有确定状态与自动化测试。
3. Readiness 与 Token 的端到端泄漏测试为零。
4. 真实官方 Session 能在重启后恢复，且 Supervisor 从未直接读取或改写 Session 文件。
5. 更新兼容门禁能拒绝未经验证的上游 commit 与数据目录组合。
6. 每个 HRS 功能 ID 都对应代码 Owner、测试、运行证据和独立提交。
