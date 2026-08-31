# Web 控制台

## 目标

使用 Vue 3 构建一个只依赖 API 和投影的控制台，展示会话、工具执行、审批、本体决策、长期任务和子 Agent。Web 不成为新的业务状态真源。

## 前置条件

完成 [SDK 与 ACP 接入](25-SDK与ACP接入.md)。

## 页面顺序

1. Runtime 连接页：连接状态、版本、健康检查。
2. Session 列表：工作区、Preset、状态、更新时间、父子关系。
3. 对话页：用户消息、Assistant 流、Reasoning 折叠、Tool Card、错误和取消。
4. Composer：发送、排队、steer、取消、Plan/Goal 状态。
5. 审批和提问面板：风险说明、参数摘要、允许一次、拒绝、关闭。
6. 本体面板：版本、当前 Fact Snapshot、候选 Action、Policy Decision 和命中规则。
7. 本体计划页：DAG、节点状态、factRevision、重试、补偿和人工恢复。
8. 子 Agent/Job 页：树、状态、输出、继续消息和中断。
9. 设置页：模型、凭据引用、Preset、MCP 和权限；Secret 永不回显。

## 状态管理

每个 Pinia Store 先通过 RPC 获取 Snapshot，再应用 cursor notification。Store 记录最后 cursor 和 connection generation；重连后旧 generation 的消息全部丢弃。对话节点由服务端 Session Projection 提供，前端不从任意事件重新推导 Turn 规则。

## Tool Card

Tool Card 有 pending、running、approval、completed、failed、cancelled 和 outcome-unknown。渲染由工具名和 `meta.presentation` 选择；未知工具使用通用 JSON/Text 卡。diff、terminal 和 location 等专用视图只读纯展示数据，不发起隐藏副作用。

## 本体可解释性

Policy Decision 展示 Action、allow/deny、reason code、规则 ID、本体版本和事实 revision。敏感字段只显示脱敏摘要。用户可以从计划节点跳转到 Tool Call、事实变更和补偿事件，形成完整审计链。

## 手写顺序

1. 用 `create-vue` 建立 TypeScript/Vite 项目，启用 `vue-tsc`。
2. 实现协议 Client、连接 Store 和 Snapshot + cursor reducer。
3. 实现 Session 列表和只读对话。
4. 实现 Composer、流式更新和取消。
5. 实现审批/问题交互。
6. 实现本体决策和 DAG。
7. 实现子 Agent、Job 和设置页面。
8. 补无障碍、键盘操作、虚拟列表和大日志性能。

## 测试与完成标准

组件测试覆盖 Store reducer、Tool Card 和交互状态；Playwright 覆盖创建 Session、流式回答、工具审批、策略拒绝、取消、重连、计划补偿和子 Agent。完成后刷新浏览器不会丢状态，也不会重复显示已消费通知。

## DSH 参考

- [当前 Web 应用](../deepseek-harness/apps/web)
- [Client Web 包](../deepseek-harness/packages/client/web/README.md)
- [Host API Proxy](../deepseek-harness/packages/host/apiproxy/README.md)
