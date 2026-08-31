# Todo 模块

## 目标

为一个 Session 提供轻量工作清单，帮助 Agent 和用户查看当前进度。Todo 是协作状态，不是本体计划、Goal 或外部任务平台。

## 前置条件

完成 [本体计划、回写与补偿](15-本体计划回写与补偿.md)。

## 数据和事件

`TodoItem` 包含稳定 ID、内容和 `pending | in_progress | completed`。`todo/write` 事件保存完整新列表和 revision；更新使用整表替换，便于重放和 UI 一致显示。

## 规则

- 默认最多一个 `in_progress`；配置允许并行时可以多个。
- completed 项不能无解释地回退，回退需携带 reason。
- 列表大小、单项长度和总字节数有限制。
- Todo 不驱动 Agent 自动工作，也不改变本体 Fact。

## 手写顺序

1. 定义 Todo Schema、revision 和投影。
2. 实现 `TodoService.get/replace`，使用 CAS 防止并发覆盖。
3. 注册 `todo_write` 工具，参数是完整列表。
4. 添加 Web 投影和 compact Context；只在变化时进入模型可见内容。

## 测试与完成标准

覆盖创建、整表替换、非法状态、多个 in-progress、过期 revision、重放和并发写。完成后刷新或恢复 Session，Todo 顺序和状态保持一致。

## DSH 参考

- [Todo 包](../deepseek-harness/packages/todo/README.md)
