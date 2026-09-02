# 23：MCP 工具桥接、原子世代与连接监督

## 本课定位

MCP Client 把外部 Server 的 Tools 注册进本地 ToolRuntime；它不桥接 Resources/Prompts。远程工具仍经过本地可见性、审批、本体 Guard、取消、post/finalize 和 Session 管线。MCP 连接和工具世代有独立生命周期。

## 学习目标

- 为每个配置的 serverName 建立稳定本地身份；
- 支持 stdio 与 Streamable HTTP；
- 将远程 tool name 确定性映射为本地名称；
- 发现/更新时原子替换整代工具；
- 连接断开时保留 last-known tools 的明确行为并监督重连；
- 将 canonical MCP result 与模型内容投影分开；
- 安全处理图片、未知块、错误、输出 schema 和环境变量；
- dispose 时停止重连、关闭 client、排空同步并注销世代。

## 配置与身份

每插件实例：serverName（限定格式、同 Scope 唯一）、transport；stdio command/args/env/cwd 或 HTTP url/headers；tool call timeout；failOnStartupError；reconnect 策略。

公开工具名是 `(serverName, rawName)` 的纯函数：常见 `mcp__server__tool`，不符合模型名称词汇时做确定规范化并追加稳定 hash，避免不同原名折叠。永远用 rawName 发 `tools/call`，不能从公开名反解析。

远程 `serverInfo.name` 不可信、可能重名/升级改变，不能替代本地 serverName。

## 启动和世代

1. 在当前 Scope 预留 serverName；
2. 创建 supervisor/client；
3. initialize + 分页 tools/list；
4. 验证整份列表：rawName 唯一、schema 可支持/降级、映射名无本地冲突；
5. 在临时 Effect 中注册整代 tools；
6. 成功后原子交换 generation，释放旧 generation；
7. 初次失败：默认插件可激活但无工具并记录；`failOnStartupError` 时拒绝激活。

获取失败保留上一代；新 generation 注册中任一冲突回滚整代，禁止部分更新。`notifications/tools/list_changed` 只排队同步；初始、通知、重连同步共享串行队列，不交错 dispose/register。

## 断线与重连

固定基线默认指数退避 500ms、上限 30s、10 次（配置可改）。一次 interruption 共用尝试预算；稳定连接达到上限时长后重置预算。

- reconnect enabled：断线期间 last-known tools 仍列出，但调用明确失败；恢复后刷新世代；连续失败耗尽后注销 tools 并停止；
- reconnect disabled：断线后 tools 仍列出且调用失败，直到 reload；
- stdio process close 能触发 supervisor；Streamable HTTP 请求失败主要由 SDK 按请求暴露，不一定触发同样 respawn；
- shutdown 取消 timer/attempt，关闭 client，排空 sync，注销 tools。

这与“断线立刻从目录删除”不同；如果本项目选择立即删除，写差异并评估缓存/可发现性体验。

## 工具执行与结果

MCP definition execute 通过本地 ToolRuntime 调用 client：raw name + JSON args + caller signal + per-call timeout。远程 `isError` 在任何附件持久化前抛出，使本地形成失败工具结果。

canonical value 保留 `{ content: JsonValue[], structuredContent? }`，供 PTC/程序调用。Native 内容按块序投影；支持的 outputSchema 校验 structuredContent，不支持的词汇降级为 JsonValue 并明确限制。

图片：先整批 decode/validate，再保存任一成员；只有 PNG/JPEG/WebP/GIF 和模型/附件能力允许时进入持久引用。批中任何拒绝要按合同全批诊断/不产生半保存。音频、embedded resource、未知块不静默丢弃，返回有界诊断；resource link 以名称/URI 文本表示。

## 传输安全

- stdio 环境基于 scrubbed parent：移除名称匹配 KEY/PASSWORD/SECRET/TOKEN 和 DSH_*，再合并显式 env；
- command/cwd/env 是受信部署配置，不由模型提供；
- HTTP URL/header/OAuth token 不进入 Session；生产部署增加 SSRF、重定向、响应大小和 egress 策略；
- 每次调用有 timeout/abort；初始 connect/list 可能仍受 SDK 默认超时，需记录限制；
- server tools 不是自动 ontology Action，写操作必须有映射/策略。

## 实现任务

1. Config/schema/serverName Scope reservation；
2. deterministic public name algorithm + test vectors；
3. stdio/HTTP transport factory + env scrub；
4. supervisor lifecycle/reconnect budget；
5. paginated discovery/full-list validation；
6. atomic ToolRuntime generation swap；
7. tools/list_changed serial sync；
8. call cancellation/timeout/canonical result；
9. content/image/outputSchema projection；
10. dispose/HMR；
11. Resources/Prompts 明确标未实现。

## 测试矩阵

| 场景 | 预期 |
|---|---|
| 两 server 同 rawName | 不同稳定公开名 |
| 同 Scope duplicate serverName | 加载前失败 |
| 名称规范化碰撞向量 | hash 后不折叠 |
| tools/list 分页/重复 rawName | 完整发现/整表拒绝 |
| 更新获取失败/注册冲突 | 上一代保留/新代全回滚 |
| list_changed burst | 同一串行队列，最终最新世代 |
| 初始失败两个配置 | 默认无工具继续/严格模式加载失败 |
| 断线重连成功 | last-known 调用失败后恢复同名 tools |
| 耗尽/禁用重连 | 注销停止/保留失败直到 reload，按合同 |
| call abort/timeout/isError | 本地稳定失败，无伪成功 |
| output schema supported/unsupported | 校验/明确 JsonValue 降级 |
| 图片批次某项坏 | 不半持久化，诊断有界 |
| env scrub/secret | 未显式注入的敏感变量不进子进程/日志 |
| dispose in-flight reconnect/sync | timer/client/generation 全停稳 |

## 源码复盘

- [`packages/mcp/mcp-client/README.zh.md`](../deepseek-harness/packages/mcp/mcp-client/README.zh.md)；
- [`connection.ts`](../deepseek-harness/packages/mcp/mcp-client/src/connection.ts)、[`tools.ts`](../deepseek-harness/packages/mcp/mcp-client/src/tools.ts)、[`transport.ts`](../deepseek-harness/packages/mcp/mcp-client/src/transport.ts)；
- MCP client 的命名、世代、重连、图片和取消测试；
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) 只作为协议依赖，实际版本锁在项目 lockfile。

## 完成标准

- 公开名算法有不可变 test vectors；
- generation 只全量成功交换；
- 断线/重连/耗尽行为与文档一致；
- 所有 MCP 调用重新进入本地 ToolRuntime；
- secret/附件/未知块安全测试通过；
- Resources/Prompts 未被伪装成 Tools 结果。

## 复盘问题

1. 为什么 remote serverInfo.name 不能做本地 namespace？
2. 断线时保留 last-known schemas 有什么利弊？
3. canonical MCP value 与 Native content projection 为什么要分开？
