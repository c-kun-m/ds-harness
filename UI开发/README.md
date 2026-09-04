# DeepSeek Harness 桌面 UI 开发文档

> 文档状态：`BASELINE-DRAFT`
> 目标平台：Windows x64 首发，macOS ARM64 与 Linux x64 后续
> 产品形态：Electron + Vue 3 + GSAP 自定义桌面前端，对接官方 DeepSeek Harness 本机服务
> 适用对象：产品、架构、开发、测试、安全、发布与后续接手本项目的 Codex 任务

## 1. 文档目标

本目录不是概念说明，而是桌面产品的可执行开发合同。它必须同时解决五个问题：

1. 要交付哪些用户功能，哪些明确不交付。
2. 每项功能由哪个模块负责，依赖哪些上游能力。
3. 功能如何实现、通过什么接口、出现故障时如何恢复。
4. 功能需要满足哪些安全、测试、性能与完成条件。
5. 开发必须按什么顺序推进，何时允许进入下一阶段。

任何实现如果无法映射到本目录中的全局功能 ID，原则上不得进入生产代码；任何标记为 V1 范围内的功能如果没有实现证据、测试证据和验收证据，版本不得宣称完成。

## 2. 不可破坏的总原则

1. **官方 Runtime 是业务真源。** 不在桌面端重写 DeepSeek Harness Agent Runtime、Session Journal 或 Workspace 状态机。
2. **所有官方代码位于隔离边界内。** `@deepseek-ai/dsh-*`、Cordis、官方 Controller 和 Conversation 投影固定运行在 Electron Utility Process。
3. **Renderer 只消费稳定合同。** Vue Renderer 只能接收版本化 Desktop DTO、Snapshot、Patch 和明确命令结果，不能导入官方包、Node.js 或 Electron 内部 API。
4. **服务仅限本机托管。** V1 只连接应用自己启动的、监听 `127.0.0.1` 随机端口的官方 Harness；不提供远程 Host 地址输入。
5. **凭据不进入页面。** 启动 Token、认证 Cookie、Provider Secret 和 API Key 不得进入 Renderer、Pinia、浏览器存储、普通日志或诊断包。
6. **写操作不盲目重试。** Prompt、Approval、Question、Create、Delete 等非幂等操作在结果不确定时进入 `OUTCOME_UNKNOWN`，由快照或用户确认消歧。
7. **版本原子锁步。** App、Harness Runtime、官方 Client、兼容适配器和协议指纹作为一个 Release Set 发布。
8. **GSAP 只属于表现层。** 动画不得决定业务状态、消息顺序、滚动真值或网络生命周期。
9. **测试是完成证据。** “代码写完”不等于完成；必须满足对应功能 ID 的测试、性能、安全和 DoD。
10. **一次改动一次提交。** 每个独立完成的代码或文档变更使用正常 Git Hook 单独提交，绝不使用 `git commit --no-verify`。

## 3. 文档阅读和执行顺序

### 3.1 基础合同

| 顺序 | 文件 | 作用 | 当前责任 |
|---|---|---|---|
| 1 | `00-产品目标范围与完成定义.md` | 定义产品目标、用户旅程、范围和最终完成定义 | 所有角色先读 |
| 2 | `01-技术基线与上游锁定.md` | 固定技术栈、官方版本、制品和兼容策略 | 架构、构建、发布 |
| 3 | `02-总体架构与进程边界.md` | 固定进程、信任边界、数据流、生命周期 | 全体开发 |
| 4 | `03-全量功能清单.md` | 所有全局功能 ID、优先级、归属和验收摘要 | 产品、开发、QA |
| 5 | `04-工程骨架与公共合同.md` | 固定 Monorepo、DTO、Patch、IPC、错误和 CI | 基础设施开发 |

### 3.2 模块与执行文档

每个模块文档必须按全量功能 ID 逐项展开；尚未建立的文件状态为 `PLANNED`，不能被当成已经完成：

| 顺序 | 文件 | 负责内容 |
|---|---|---|
| 05 | `05-Electron主进程与安全外壳.md` | Main、Preload、窗口、`app://`、Native Intent、Utility 分发 |
| 06 | `06-Harness运行时管理.md` | Runtime 制品、Home、启动、Readiness、Guardian、退出 |
| 07 | `07-Bridge传输与官方客户端兼容层.md` | Token/Cookie、HTTP、WS mux、官方 Client、重连、背压、Compat |
| 08 | `08-Workspace与Session领域模块.md` | Workspace、Session、模型、Prompt、Queue、附件 |
| 09 | `09-Conversation投影模块.md` | Headless 节点、Snapshot/Patch、Tool 配对、Gap Repair |
| 10 | `10-Vue状态与应用外壳.md` | Vue bootstrap、Pinia 边界、路由、布局和错误边界 |
| 11 | `11-Conversation与Composer界面.md` | 虚拟列表、滚动、Markdown、Worker、输入、发送和取消 |
| 12 | `12-工具卡审批问题Subagent与Goal.md` | Presenter、Approval、Question、Subagent、Goal |
| 13 | `13-设置凭据设计系统与GSAP.md` | Settings、Credential、Design、GSAP、i18n、a11y |
| 14 | `14-安全可观测性与故障恢复.md` | 威胁模型、日志、诊断和分层崩溃恢复 |
| 15 | `15-测试性能与质量门禁.md` | 测试分层、性能预算、CI 和质量门禁 |
| 16 | `16-打包更新迁移与回滚.md` | 制品、签名、SBOM、安装、更新、数据和回滚 |
| 17 | `17-开发阶段任务与里程碑.md` | 严格阶段、任务前置关系和退出门禁 |
| 18 | `18-功能追踪矩阵.md` | 功能状态、实现、测试、验收和 Release Evidence |
| 19 | `19-编码提交与文档维护规范.md` | 编码边界、独立提交和文档同步规则 |
| 20 | `20-风险登记与ADR索引.md` | 风险、阻断条件、ADR 和决策状态 |

## 4. 全局功能 ID 规则

格式为 `<领域前缀>-<三位流水号>`。ID 创建后永不复用；删除功能时保留 ID 并标记 `REMOVED`。

| 前缀 | 领域 | 前缀 | 领域 |
|---|---|---|---|
| `PRD` | 产品范围与完成定义 | `BASE` | 技术基线与上游锁定 |
| `ENG` | 工程骨架、合同、构建与 CI | `ARCH` | 总体架构和进程边界 |
| `ELM` | Electron Main、Preload 和系统能力 | `HRS` | Harness Runtime Supervisor |
| `BRG` | Harness Bridge 和官方兼容层 | `WS` | Workspace |
| `SES` | Session、模型、Prompt、Queue | `CP` | Conversation Headless 投影 |
| `VUE` | Vue 状态和应用外壳 | `CONV` | Conversation 页面和内容渲染 |
| `COMP` | Composer、附件、引用 | `TOOL` | Tool 展示与 Inspector |
| `INT` | Approval、User Question | `SUB` | Subagent |
| `GOAL` | Goal 管理 | `SET` | 设置与凭据 |
| `CRED` | Credential 生命周期 | `DS` | Design System 和主题 |
| `GSAP` | GSAP 动效 | `I18N` | 国际化 |
| `A11Y` | 无障碍 | `SEC` | 安全 |
| `OBS` | 日志、指标、诊断 | `REC` | 故障恢复 |
| `PERF` | 性能与资源预算 | `TEST` | 测试工程 |
| `PKG` | 打包、签名和制品 | `UPD` | 更新、迁移与回滚 |
| `DOC` | 文档治理 |  |  |

### 4.1 优先级

| 等级 | 含义 | 发布规则 |
|---|---|---|
| `P0` | 产品成立、安全或数据完整性的前置条件 | 未完成时不得进入内部 Alpha |
| `P1` | V1/GA 必须具备的核心能力 | 未完成时不得发布 GA |
| `P2` | V1 应具备的完整体验或运维能力 | 必须完成，例外需书面变更评审 |
| `P3` | 明确规划但不阻塞 V1 的增强能力 | 可移入后续版本，但不得伪装成已完成 |

### 4.2 功能状态

```text
PROPOSED → APPROVED → IN_PROGRESS → IMPLEMENTED → VERIFIED → RELEASED
                  ↘ BLOCKED
                  ↘ REMOVED（必须保留原因和替代项）
```

`IMPLEMENTED` 只代表代码存在；只有代码审查、自动测试、手工验收和所需证据全部通过后，才能标记为 `VERIFIED`。

## 5. 每份模块文档的强制结构

后续每份开发文件都必须包含以下章节，不能用一句“参见其他文件”替代模块自身的关键合同：

1. 模块目标。
2. 范围与非范围。
3. 前置依赖和下游依赖。
4. 建议目录与文件职责。
5. 状态机和数据模型。
6. 功能总表：ID、优先级、用户行为、实现方式、接口。
7. 每项功能的故障与恢复策略。
8. 每项功能的安全约束。
9. 每项功能的测试要求。
10. 每项功能的 Definition of Done。
11. 开发顺序与每步退出门禁。
12. 模块验收清单和可追溯证据位置。

模块实现必须引用 `03-全量功能清单.md` 中已有的 ID；发现遗漏时先更新全量清单，再增加实现。

## 6. 文档治理功能

| ID | P | 开发者行为 | 实现与接口 | 故障恢复与安全 | 测试与 DoD |
|---|---|---|---|---|---|
| `DOC-001` | P0 | 能从目录按开发顺序找到唯一规范 | README 维护有序索引；文件名使用两位阶段序号 | 重命名必须同步所有引用；禁止同时存在两个“最终版” | 链接检查通过；索引覆盖全部现存文档 |
| `DOC-002` | P0 | 能用功能 ID 从需求追踪到代码和测试 | 需求、Issue、Commit、测试用例使用同一全局 ID | ID 永不复用；冲突时保留较早 ID 并迁移引用 | 抽查任一 P0/P1 ID 均可定位实现与证据 |
| `DOC-003` | P0 | 能判断模块是否真的完成 | 每个模块维护验收清单和证据路径 | 缺少证据一律视为未完成，不根据口头状态恢复 | Completion Audit 覆盖所有 P0/P1/P2 |
| `DOC-004` | P1 | 能明确知道一次变更影响哪些模块 | 使用 Decision Record 记录跨边界决策和兼容影响 | 决策回滚保留历史，不覆盖旧结论 | 架构评审检查相关文档已同步 |
| `DOC-005` | P1 | 能知道文档基于哪个上游版本 | 所有协议相关文档引用 `upstream.lock.json` 的 release-set ID | 上游变更但文档未更新时 CI 阻断 | 基线 Hash 与文档元数据一致 |
| `DOC-006` | P1 | 新开发者可以按文档复现环境 | 每步给出输入、输出、依赖和退出门禁 | 失败步骤必须给出清理和重试方式，不要求删除用户数据 | 干净 VM 按文档完成 bootstrap |
| `DOC-007` | P1 | 产品变更不会静默删减功能 | 范围变更先更新全量清单、优先级、风险和迁移说明 | 删除 P0/P1/P2 必须记录批准人、原因和替代路径 | 发布评审对比上一版本功能清单 |
| `DOC-008` | P2 | 用户和支持人员能获得准确发布说明 | 从 Verified 功能、已知问题和迁移记录生成 Release Notes | 自动生成内容必须人工审核并脱敏 | Release Notes 与实际制品 Manifest 一致 |

## 7. 核心数据模型

文档层面使用以下记录保证可追溯性；实际 Schema 在 `04-工程骨架与公共合同.md` 中定义：

```ts
type FeatureRecord = {
  id: string;
  title: string;
  priority: "P0" | "P1" | "P2" | "P3";
  status: "PROPOSED" | "APPROVED" | "IN_PROGRESS" | "IMPLEMENTED" | "VERIFIED" | "RELEASED" | "BLOCKED" | "REMOVED";
  ownerModule: string;
  upstreamCapabilities: string[];
  implementationEvidence: string[];
  testEvidence: string[];
  securityEvidence: string[];
  releaseSet: string;
};
```

任何 Evidence 都必须是可复现的文件、命令结果、CI Artifact、测试报告或签名制品，不能只写“已测试”。

## 8. 总体开发顺序

```text
范围冻结与上游锁定
→ 官方接入 Spike
→ 工程骨架和公共合同
→ Electron 安全外壳与 Runtime Supervisor
→ Bridge 和官方 Client
→ Workspace / Session / Conversation 投影
→ 最小业务 Alpha
→ 长会话、Composer 和 Tool 交互
→ Settings、Design、GSAP、i18n、A11Y
→ 安全、性能、恢复、更新与发布硬化
→ Internal → Beta → RC → GA
```

各阶段不得仅按日历结束；必须满足对应文档中的退出门禁。

## 9. 文档依赖和建议目录

```text
UI开发/
├─ README.md
├─ 00-产品目标范围与完成定义.md
├─ 01-技术基线与上游锁定.md
├─ 02-总体架构与进程边界.md
├─ 03-全量功能清单.md
├─ 04-工程骨架与公共合同.md
├─ 05-Electron主进程与安全外壳.md
├─ 06-Harness运行时管理.md
├─ 07-Bridge传输与官方客户端兼容层.md
├─ 08-Workspace与Session领域模块.md
├─ 09-Conversation投影模块.md
├─ 10-Vue状态与应用外壳.md
├─ 11-Conversation与Composer界面.md
├─ 12-工具卡审批问题Subagent与Goal.md
├─ 13-设置凭据设计系统与GSAP.md
├─ 14-安全可观测性与故障恢复.md
├─ 15-测试性能与质量门禁.md
├─ 16-打包更新迁移与回滚.md
├─ 17-开发阶段任务与里程碑.md
├─ 18-功能追踪矩阵.md
├─ 19-编码提交与文档维护规范.md
├─ 20-风险登记与ADR索引.md
├─ scripts/verify-docs.mjs   # 文档、ID、责任和链接自动校验
├─ decisions/                 # 架构决策记录，后续建立
├─ evidence/                  # 验收证据索引，不保存 Secret
└─ templates/                 # 功能、模块、发布检查模板
```

基线自检命令：

```powershell
node UI开发/scripts/verify-docs.mjs
```

该命令必须在文档改名、功能 ID 增删、责任模块调整以及每个阶段退出前执行。它验证 22 份文档、280 个功能 ID、31 个覆盖区间、逐功能标题、同目录链接、代码围栏和不可破坏的架构原则。

依赖方向为 `00 → 01 → 02 → 03 → 04 → 具体模块 → 测试/发布`。如果低层文档与高层目标冲突，以更靠前的已批准文档为准，并通过变更评审修正文档，而不是让代码自行选择解释。

## 10. README 验收清单

- [ ] 文档目的、产品形态和安全边界明确。
- [ ] 全局功能 ID 前缀无重复且覆盖所有模块。
- [ ] 优先级、状态流和完成证据定义明确。
- [ ] 后续模块强制模板包含功能、实现、接口、恢复、安全、测试和 DoD。
- [ ] 开发顺序与阶段门禁一致。
- [ ] 不把官方 React Web UI、远程 Host 或 Runtime 重写误列为 V1。
- [ ] Renderer/Utility 的依赖边界表述唯一且无歧义。
- [ ] Git 提交规则被记录且未允许绕过 Hook。
