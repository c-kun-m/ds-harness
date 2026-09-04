# 20：风险登记与 ADR 索引

## 1. 目标

本文件集中记录会改变架构、范围、数据或发布策略的风险与决策。风险不能只存在于聊天记录；每个高风险项必须具有验证任务、Owner、触发条件、缓解措施和关闭证据。

## 2. 风险等级

| 等级 | 定义 | 处理规则 |
|---|---|---|
| P0 | 不解决就无法安全开始后续核心开发或无法发布 | 阻断阶段退出 |
| P1 | 会造成严重功能、数据、安全或恢复问题 | RC 前必须关闭 |
| P2 | 有明确降级路径但影响体验或维护成本 | 建立期限和 Owner |
| P3 | 低影响优化或远期能力 | 进入 Later Backlog |

## 3. 当前风险登记

| 风险 ID | 等级 | 风险 | 触发或证据 | 缓解与验证 | 关闭条件 | 状态 |
|---|---|---|---|---|---|---|
| RISK-001 | P0 | 官方 Client/协议仍为 alpha，可能破坏兼容 | 上游升级产生 Remote/Schema Diff | 精确锁 tag/commit；生成协议指纹；每版本独立 compat | 锁文件、真实合同和升级 Diff 门禁通过 | 开放 |
| RISK-002 | P0 | 官方 Client 或 Conversation 投影不能在 Utility 无 React 运行 | Phase 1 Bundle/Runtime Spike 失败 | 只挂静态 Client；提炼公共 headless export；不把临时依赖塞进 Renderer | Utility 可运行真实 Controller/Projection 且差分测试通过 | 开放 |
| RISK-003 | P0 | Readiness stdout 含 Token，通用日志可能泄露 | Canary 出现在日志或 CI Artifact | Parser 先于 logger 截获；集中 Redactor；Fuzz | 所有日志路径零泄漏 | 开放 |
| RISK-004 | P0 | Windows 缺少可靠 POSIX SIGTERM，可能留孤儿或未 Flush | Main 强杀或正常退出遗留进程 | stdin lifecycle companion + Job Object + 进程树测试 | 500 次启停和 Main 崩溃测试零孤儿 | 开放 |
| RISK-005 | P0 | Session 格式 v0 缺少迁移合同 | 新 Runtime 无法可靠读取旧数据 | 冻结 Runtime；Copy-on-Upgrade；副本预检；阻止无迁移升级 | N-1→N 和回滚证据完整 | 开放 |
| RISK-006 | P1 | Dynamic Cordis Client 插件假设 React Browser Half | Host 等待未注册页面处理器 | V1 静态能力白名单；禁用未验证动态 Client；Generic Tool fallback | Must 能力不依赖 React 动态模块 | 开放 |
| RISK-007 | P1 | Approval/Question 是瞬时交互，断线可能误答或丢失 | generation 变化时仍显示旧请求 | 单 Owner Coordinator；一次性状态机；旧 generation 过期 | 故障注入下不重复、不跨代提交 | 开放 |
| RISK-008 | P1 | 动态高度虚拟列表在 Prepend/流式时跳动 | 锚点误差超预算 | Key+Offset 锚点、ResizeObserver、滚动状态机 | 25k Event 下误差 ≤2px | 开放 |
| RISK-009 | P1 | Markdown/Highlight/Diff 产生 O(n²) 或阻塞 | 长内容 Long Task/内存超限 | 尾部增量解析、Worker、懒加载、容量限制 | 性能预算和事件风暴测试通过 | 开放 |
| RISK-010 | P1 | 慢 Renderer 导致 Bridge 队列无界 | backlog 持续增长 | credit/ack、高水位、Delta 合并、Snapshot Resync | 压测不 OOM 且终态事件完整 | 开放 |
| RISK-011 | P1 | 模型/Tool 内容造成 XSS、URL 或文件越权 | 安全 corpus 可执行代码或读越界 | AST 渲染、协议白名单、Capability Handle、统一 sanitizer | 安全测试 Critical/High 为零 | 开放 |
| RISK-012 | P1 | 更新中断损坏 App 或 Harness Home | 注入崩溃后无可启动副本 | 签名 Staging、Drain、Copy-on-Upgrade、原子切换 | 每个注入点均可恢复 | 开放 |
| RISK-013 | P2 | Electron Bundle、内存和 CPU 超预算 | 基准退化 >10% | 官方 Client 留在 Utility、虚拟化、Worker、懒加载 | 专用 Runner 达到预算 | 开放 |
| RISK-014 | P2 | 多 Session/多 Interaction 状态串线 | 快速切换后错误目标收到命令 | 所有命令携带 Session、generation、request ID | 属性/E2E 无跨会话污染 | 开放 |
| RISK-015 | P2 | 用户误以为支持远程 Harness | 输入远程 URL 或 LAN 模式 | V1 不提供入口；文档和错误明确 Managed Local Only | UI 无远程配置入口 | 开放 |

## 4. 首批 ADR

| ADR | 决策 | 状态 | 需要的验证证据 |
|---|---|---|---|
| ADR-001 | V1 只支持应用管理的本机 loopback Harness | 已决定 | 端到端受管模式测试 |
| ADR-002 | 官方 Harness 与 Client/Compat 精确版本锁步 | 已决定 | Release Manifest 与错配拒绝测试 |
| ADR-003 | 官方 Runtime 作为独立 Sidecar，不运行在 Electron Node 中 | 已决定 | 发布形态 Runtime Smoke |
| ADR-004 | 所有官方 Client/Cordis/Controller/Projection 运行在 Utility | 待 Phase 1 验证 | Node/Utility Bundle、真实连接、差分测试 |
| ADR-005 | Renderer 只消费版本化 Desktop DTO/Patch | 已决定 | 依赖边界 CI 和 Resync 测试 |
| ADR-006 | UI 通过只读 `app://desktop/` 加载 | 已决定 | 路径、CSP、导航安全测试 |
| ADR-007 | Web Host HTTP/WS 是 V1 官方对接通道 | 已决定 | Unary、Mux Stream、认证和重连合同 |
| ADR-008 | stdin lifecycle + Windows Job Object 负责退出 | 待 Phase 1 验证 | 正常、崩溃、强杀进程树测试 |
| ADR-009 | Headless Conversation 优先公共上游导出，禁止 GA 私有路径依赖 | 待 Phase 1 验证 | Bundle 依赖与语义差分 |
| ADR-010 | Pinia 只拥有 UI 状态，不复制 Harness 状态机 | 已决定 | Store 边界测试 |
| ADR-011 | GSAP 只拥有表现层并遵循 Motion Reason | 已决定 | Cleanup、Reduced Motion、性能测试 |
| ADR-012 | Harness 更新采用人工门禁和 Copy-on-Upgrade | 已决定 | N-1→N、故障注入、回滚测试 |
| ADR-013 | V1 不执行第三方 Renderer JavaScript | 已决定 | Plugin/Presenter 安全测试 |
| ADR-014 | Windows x64 首发，其他平台逐项认证 | 已决定 | 原生 CI、签名、安装测试 |

## 5. ADR 文档模板

```text
# ADR-NNN：标题

状态：提议 / 已接受 / 已否决 / 已替代
日期：
关联功能：
关联风险：

背景：当前事实和约束
决策：唯一明确选择
候选方案：评估过但未选择的方案
理由：为什么选择
正面影响：
负面影响与成本：
安全/数据/兼容影响：
验证计划：命令、测试、制品
回退条件：什么证据会推翻本决策
替代 ADR：如被替代则链接
```

## 6. 风险维护规则

1. 新发现的功能缺口先判断是否构成风险，再进入功能清单。
2. 风险状态只能在存在验证证据时从开放改为缓解或关闭。
3. P0 风险未关闭时不得越过其阶段门禁。
4. 上游升级时重新审计 RISK-001、RISK-002、RISK-005、RISK-006、RISK-007。
5. Electron、Updater、凭据或插件边界变化时重新进行威胁建模。
6. 已关闭风险如果触发条件再次出现，应重新开放，不复用旧结论。
7. 每次目标模式运行结束时说明新增、变化和仍开放的 P0/P1 风险。
