# 16：Todo 整表快照、单拥有者与会话投影

## 本课定位

Todo 是 Agent 自己维护的轻量协作清单，不是 15 的权威 Action DAG，也不自动调度工作。上游核心有意保持最小：条目没有稳定 id/revision，更新是整表替换，状态只有 pending/in_progress/completed。

## 学习目标

- 区分工具输入策略与持久日志不变量；
- 用 `todo/write` 完整快照重放当前清单；
- 将列表严格绑定到调用 Agent 的 Session；
- 让“是否允许多个 in_progress”成为部署策略，不污染历史兼容；
- 在下一 Turn 开始时清空“当前有效计划”投影，同时保留历史事件；
- 通过 Session Projection 向 UI 暴露 null/列表。

## 公共合同

### TodoItem

固定复刻形状：`{ content, status }`。content 非空、同一列表不重复；status 封闭为 pending/in_progress/completed；拒绝未知字段。不要擅自增加 id/priority/reason 再声称与上游等价。

如果本产品以后需要 CAS、多用户共享或逐项编辑，应另建增强模块/事件版本，不改变本课核心。

### 配置策略

`allowParallelInProgress` 必填：

- false：工具执行时最多一个 in_progress；
- true：可有多个；
- 这是当前部署的工具准入策略，不是持久日志不变量；
- 因此以前在宽松策略下写入的日志，部署收紧后仍应可回放。

### 所有者

工具调用必须有精确 owning Agent/Session。Subagent 各自拥有自己的清单；非 Agent 调用方拒绝；不支持多个 Agent 共享一张表。

### 事件与投影

- 成功调用在开放 Turn 内追加 `todo/write` 完整列表；
- 最新 snapshot 覆盖旧 snapshot；
- 首次写入前 projection 为 null；
- 一个 Turn 结束后可保留刚完成清单；下一 Turn 开始时有效清单清空；
- 原历史事件不删除；
- UI 通过 `todos` projection 收到状态。

## 实现任务

1. 严格 Todo schema；
2. `allowParallelInProgress` 配置校验和工具描述；
3. `todo_write` 工具、owner 解析和完整快照 append；
4. `todo/write` invariant（形状、重复、开放 Turn）；
5. `todos` projection 的 latest/next-turn-clear；
6. UI/client-safe types；
7. 恢复/fork/compaction 回放测试。

## 测试矩阵

| 场景 | 预期 |
|---|---|
| 首次/重复整表替换 | projection 精确等于最后 snapshot |
| 空 content/重复 content/未知字段 | 工具失败且不 append |
| 非法 status | schema 拒绝 |
| parallel=false 多 active | 工具策略拒绝 |
| 宽松历史在收紧部署回放 | invariant 仍接受 |
| 非 Agent/其他 Agent 调用 | owner 拒绝、无事件 |
| Turn 外伪造 todo/write | invariant 拒绝 |
| turn/end 后/下一 turn/start | 先保留，后清空有效 projection |
| resume/fork | 从日志得到同一当前视图 |
| projection registry 缺失 | 可选功能按合同禁用/显式失败 |

## 源码复盘

- [`packages/todo/tool-todo/README.zh.md`](../deepseek-harness/packages/todo/tool-todo/README.zh.md)；
- [`packages/todo/tool-todo/src/index.ts`](../deepseek-harness/packages/todo/tool-todo/src/index.ts)、`types.ts`、`invariant.ts`；
- 对应工具、投影和 invariant 测试。

## 完成标准

- 严格复刻最小条目和整表替换；
- 策略与日志不变量分离；
- 单一 owner 无越权；
- next-turn-clear 投影可重放；
- 若增加增强字段，单独写差异/版本方案。

## 复盘问题

1. 为什么上游 Todo 不需要稳定 item id？
2. allowParallel 为什么不能写进历史 invariant？
3. 清空 projection 和删除历史有什么区别？
