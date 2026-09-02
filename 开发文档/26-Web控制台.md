# 26：Web 控制台、投影消费与连接恢复

## 本课定位

Web 是 Runtime 的观察和交互客户端，不是新的业务真源。它只通过 24 的 typed remotes/snapshot streams 和服务端 Projection 工作；不能在浏览器重新发明 Turn、Goal、权限或本体状态机。

框架可用本项目选择的 Vue 3/Pinia，也可以用其他前端；学习重点是连接代次、投影、可恢复交互和纯展示。上游 Client 使用插件化浏览器模块体系，行为合同比框架 API 更重要。

## 学习目标

- 先建立 connection generation，再加载业务页面；
- 每个 Store 用 opening snapshot + validated deltas；
- 丢弃旧 generation 的迟到帧；
- 对 journal gap/overlap 重新 baseline，不猜状态；
- 正确展示消息/chunk/tool/approval/outcome-unknown；
- 让 UI action 调用权威 Remote，不直接修改持久 Store；
- 对敏感值、超大日志、图片和错误安全降级；
- 支持刷新/断线/重连而不重复事件。

## 页面与模块顺序

1. Connection/boot：版本、Host facts、连接状态、恢复操作；
2. Session list/workspace：投影、lineage、状态、更新时间；
3. Conversation：committed messages、流式临时块、reasoning、tool cards；
4. Composer：followup/steer/inject/attachment/cancel；
5. Approval/question：一次决定、撤回/迟到状态；
6. Todo/Plan/Goal：服务端 projection，pending/armed 明确；
7. Jobs/Subagent/Workflow：树、输出、阶段、控制权限；
8. Ontology：version/snapshot/candidate/decision；
9. Ontology Plan：DAG、execution/fact revision、compensation/blocker；
10. Settings/inventory：模型、Preset、MCP、permissions；Secret 永不回显。

可以按模块插件/slot 延迟加载，但一个 entry 加载失败时必须有可诊断启动页；不能出现半个页面悄悄缺安全控件。

## Store 状态模型

每个 Remote store 至少记录：

- connectionGeneration；
- baseline revision/cursor/range；
- current projection/entities；
- stream status/error；
- optimistic action identity（若有）；
- pending interaction ids。

流程：打开 stream → 验证 ready/opening snapshot → 原子发布新 generation store → 应用连续 deltas。旧 generation frame 全丢弃；gap/partial overlap 终止当前 reducer并重新 snapshot。不要从“最后一条看起来像什么”猜缺失事件。

## Conversation 投影

- committed message 来自 Session Surface/Projection；
- assistant chunk 是临时增量，final message 到达后按 identity 合并/替换，不重复显示；
- reconnect 不依赖 chunk 重放，最终 committed message 是权威；
- request/step/turn 状态来自服务端投影；
- outcome-unknown 与 failed/cancelled 分开，显示“先验证副作用”；
- compaction summary 作为 Surface 节点展示，可跳转审计原事件，但普通用户不加载巨大日志。

## Tool Card

状态至少：queued/policy/approval/running/completed/failed/cancelled/outcome-unknown。Card renderer 由 tool identity/稳定 view tag 选择；未知工具使用通用安全文本/JSON。

- presentation 是纯派生，不能触发隐藏副作用；
- 不把 canonical 大值全放 DOM；
- diff/terminal/location/image 使用受控引用和尺寸限制；
- tool args/results 做字段 redaction；
- Approval 允许一次按钮绑定 request id，结算后禁用，迟到点击不重放决定。

## Composer 与控制

- 显示 followup/steer/inject 的真实区别；
- 输入提交后先等 receipt，不伪装成已回答；
- 防重复提交用 client action id/button state，但服务端仍幂等/鉴权；
- cancel 表示请求收敛，UI 保持 cancelling 直到服务端状态停稳；
- attachment 批量准入失败不留下半条消息；
- Plan/Goal/permissions 选择展示 pending/actual，而不是乐观覆盖真值。

## 本体可解释性

PolicyDecision 显示 stage、allow/deny、reason、rule ids、ontologyVersion、factRevision、action/tool version和安全摘要。Plan node 可跳到 decision、tool call/result、FactMutation、outbox/commit、postcondition 和 compensation。敏感 evidence 只显示授权 view。

## 安全与性能

- DOM 文本默认转义，不用不可信 Markdown HTML；
- 链接/资源 URI 协议 allowlist；
- CSP、origin/auth/CSRF 按部署；
- Token/Secret 不进 localStorage/URL/error report；
- 虚拟列表/分页/journal，避免全量事件进入内存；
- chunk 合并按 block identity，不丢终态；
- 关闭页面/切路由 dispose stream/listener；
- 多标签页操作都由服务端 CAS/owner 决定。

## 实现任务

1. Vue/Vite/TypeScript + generated Remote client；
2. boot/connection generation/recovery；
3. reusable snapshot/journal Store reducer；
4. Session list + Conversation committed/streaming；
5. Composer/attachment/cancel；
6. ToolCard/approval/question；
7. Todo/Plan/Goal/Jobs/Subagent/Workflow；
8. Ontology decision/DAG audit chain；
9. settings/inventory/secret handling；
10. accessibility/keyboard/virtualization；
11. component/e2e/fault tests。

## 测试矩阵

| 场景 | 必须观察到 |
|---|---|
| opening snapshot + deltas | Store 一致 |
| reconnect old frame late | 丢弃旧 generation |
| duplicate/gap/overlap | 完整重复忽略，gap/partial overlap 重载 |
| chunk→final/reload | 不重复、不丢 committed message |
| receipt/idle/cancel | UI 状态与真实语义一致 |
| approval double/late click | 服务端一次决定，UI 不重放 |
| outcome unknown | 不显示普通 retry 按钮/成功 |
| projection unavailable/plugin removed | 页面安全降级并解释，不读内部对象 |
| huge log/result | UI 有界、可分页/引用读取 |
| sensitive decision/tool | DOM、日志、error report 无原值 |
| XSS link/Markdown payload | 不执行脚本/危险协议 |
| stream/page dispose | 无旧 listener/重复通知 |
| two tabs CAS | 陈旧操作被服务端拒绝并刷新 |

## 源码复盘

- [`packages/client/README.zh.md`](../deepseek-harness/packages/client/README.zh.md) 与 `connection/modules/store/ui-*`；
- [`packages/client/web/README.zh.md`](../deepseek-harness/packages/client/web/README.zh.md)；
- [`packages/client/ui-conversation`](../deepseek-harness/packages/client/ui-conversation)、`ui-tool`、`ui-approval`、`ui-goal`、`ui-plan` 等；
- [`packages/host/webserver/README.zh.md`](../deepseek-harness/packages/host/webserver/README.zh.md)；
- Web connection/HMR/snapshot stream E2E。

## 完成标准

- 所有业务状态来自 Remote projection；
- 刷新/重连无重复、无 gap；
- Tool/Approval/Unknown outcome 语义诚实；
- 本体审计链可导航且脱敏；
- 页面卸载无 stream/listener 泄漏；
- Playwright 从真实 Host 入口通过关键路径。

## 复盘问题

1. 为什么浏览器不能从原始事件自行重建全部业务状态？
2. chunk 和 committed message 如何避免双显示？
3. optimistic UI 可以做什么，绝不能成为哪类状态的权威？
