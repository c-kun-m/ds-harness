# MCP 模块

## 目标

接入外部 MCP Server，并把远程工具映射到本地 Tool Runtime。MVP 只桥接 Tools；Resources 和 Prompts 留到工具路径、权限和结果类型稳定后开发。

## 前置条件

完成 [Skills 模块](22-Skills模块.md)。

## SDK 与传输

使用 MCP 官方 TypeScript SDK 的稳定 v2 client 包。支持本地 stdio 和远程 Streamable HTTP。每个 Server 配置唯一 `serverName`，映射后的工具名使用规范化前缀避免冲突，例如 `mcp__<server>__<tool>`。

## 连接生命周期

状态为 disconnected、connecting、ready、reconnecting、failed、disposed。连接完成后分页读取 `tools/list` 并注册工具；收到 list changed 后原子替换该 Server 的工具集合。断线时撤销工具，避免模型继续看到不可用 Schema。

## 重连

采用可配置指数退避，参考 DSH 默认值：初始 500ms、上限 30s、最多 10 次，并加入 jitter。认证错误、配置错误和协议不兼容不自动重连；瞬时断线可重连。Runtime shutdown 立即取消等待。

## 调用路径

MCP 工具的输入 Schema 在注册时验证。模型调用后仍经过本地 Tool pre/approval/ontology Guard/timeout/post 管线，Tool body 才调用 MCP client。远程结果转换为本地 ContentBlock；未知内容类型作为受控文本或 artifact 处理，不能丢弃错误。

## 安全

- stdio command、cwd 和 env 是受信任部署配置，不允许模型临时指定。
- 子进程环境默认去除无关凭据，只注入该 Server 需要的 Secret。
- Streamable HTTP 限制协议、Host、重定向、响应大小和超时，并有 SSRF allowlist。
- MCP Tool 能力不等于执行许可，仍受本体 Action 映射约束。
- OAuth/Authorization 使用独立凭据接口，Token 不进入 Session。

## 手写顺序

1. 定义 MCP Server Config 和连接状态机。
2. 实现 stdio Transport 和进程回收。
3. 实现 tools/list 分页、名称规范化和原子注册。
4. 实现 callTool 结果映射和取消。
5. 实现 list changed 和自动重连。
6. 实现 Streamable HTTP、认证和 SSRF 策略。
7. 最后评估 Resources/Prompts 的独立 Capability，不混进 Tool 返回值。

## 测试与完成标准

使用本地测试 Server 覆盖分页、动态更新、同名冲突、断线重连、调用取消、进程退出、结果过大、恶意 Schema 和 Secret 隔离。完成后 MCP 工具在断线时从模型目录消失，重连后恢复，且执行日志包含本地策略决定。

## DSH 与官方参考

- [DSH MCP Client](../deepseek-harness/packages/mcp/mcp-client/README.md)
- [DSH 当前连接实现](../deepseek-harness/packages/mcp/mcp-client/src/connection.ts)
- [MCP TypeScript SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/)
