# Skills 模块

## 目标

让 Runtime 发现本地任务说明，先向模型提供小型目录，需要时再加载完整 `SKILL.md`。Skill 是受信任提示词，不是可隔离执行代码。

## 前置条件

完成 [Workflow 模块](21-Workflow模块.md)。

## Skill 格式

目录 Skill 使用 `<name>/SKILL.md`，frontmatter 包含 `name`、`description`，可选 `whenToUse`、`disable-model-invocation`、`user-invocable` 和 metadata。name 使用 kebab-case。MVP 只发现一层目录，不递归扫描任意 Markdown。

## Provider 与优先级

Skill Registry 合并多个 Provider，每个候选有 providerName、rank、source 和 trust。Filesystem Provider 的默认 rank 顺序为 project `.dsh/skills`、project `.agents/skills`、custom、user `.dsh/skills`、user `.agents/skills`；随附或运行时 Skill 用独立 Provider 注册，不硬塞进 filesystem 排名。

同名候选由最小 rank 获胜；相同 rank 冲突必须报诊断，不能按文件系统偶然顺序选择。

## Catalog 与 Body

Catalog 只包含名称、描述和调用策略，并以 digest 写入模型可见事件。`skill(name)` 工具每次从 Provider 重新加载 body，检查名称没有在发现后变化，再返回正文和资源根路径。body 进入普通工具历史，后续编辑不改写旧历史。

## 安全

- 解析 frontmatter 不执行代码。
- 禁止 `../` 逃逸资源根；符号链接策略必须配置并测试。
- `disable-model-invocation` 错误值按 fail closed 处理。
- Skill 中的命令只是说明，实际执行仍经过工具、审批、本体 Guard 和沙箱。
- Web 明确显示来源和信任等级。

## 手写顺序

1. 定义 Registry、Provider、Candidate 和诊断类型。
2. 实现 frontmatter parser 和文件 Provider。
3. 实现 rank 合并和 digest。
4. 实现 Catalog Context 和 `skill` loader tool。
5. 可选增加文件 watcher；错误时保留 last-good catalog 并标记不完整。

## 测试与完成标准

覆盖各根目录优先级、同名冲突、坏 frontmatter、模型禁用、用户禁用、路径逃逸、body 改名和 watcher 失效。完成后模型首个请求只看到目录，调用 `skill` 后才看到正文。

## DSH 参考

- [Skill Registry](../deepseek-harness/packages/skill/skill/README.md)
- [Filesystem Provider](../deepseek-harness/packages/skill/skill-filesystem/README.md)
- [Skill Tool](../deepseek-harness/packages/skill/tool-skill/README.md)
