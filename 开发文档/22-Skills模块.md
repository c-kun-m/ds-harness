# 22：Skills 多 Provider 发现、分层胜出与按需加载

## 本课定位

Skill Registry 自身没有任何 Skill 内容。Provider 贡献目录和正文，Consumer 把小型目录给模型/用户并按需加载 body。Skill 是受信任指令，不是执行沙箱；其中命令仍需经过 Tool/Approval/Ontology/Sandbox。

## 学习目标

- 分离 registry、provider、filesystem provider 和 model consumer；
- 合并 global + Scope layers 的候选；
- 用稳定 rank/provider/local order 解决同名候选；
- 对 provider 失败保留“不完整观测”语义；
- 缓存目录但不缓存正文；
- 用 provider-driven invalidate/revision 防止陈旧目录；
- 分开 modelInvocable/userInvocable；
- 安全解析 filesystem Skill 和资源根。

## Registry 合同

### Provider

provider 有唯一 name（`runtime` 保留），`list(options)` 返回候选/完整性，`get(candidate)` 返回定义，注册返回 disposer + 精确 invalidate。提供方依次查询；取消停止调用者等待，但不响应 signal 的 provider 后台工作仍可能继续，因此 teardown/timeout 属 provider 责任。

### Candidate/Definition

候选包含 kebab-case name、description、invocation booleans、provider/rank/source 等。Registry 在缓存/返回前验证。`get()` 返回的 definition name 必须与胜出 candidate 相同，否则失效缓存并拒绝陈旧选择。

### 分层胜出

读取合并 global layer 和观察 Scope chain：nearest layer 直接覆盖远层同名；同一层依次按 rank、provider registration order、provider local order 决定。低优先候选记录诊断/隐藏，而不是依赖文件系统偶然顺序。

运行时内存 Skill 也进入层，默认 invocation policy 和 provider label 明确；同层同名按规则 first-wins 并诊断。

## Invocation Policy

`modelInvocable` 和 `userInvocable` 独立，四种组合都保留。Model catalog/tool 只筛前者，用户命令只筛后者；不要用“模型禁用”顺带禁用户。

## 收集、缓存和失效

- list/snapshot 收集每层所有 provider，失败被包含并标 incomplete；
- 完成目录按 cwd + scope chain + revision 缓存，有全局上限；
- 收集中发生一次 revision 变化可重试一次，再变化则返回最新但 incomplete、不缓存；
- definition body 从不缓存，每次 get 都问 provider；
- Registry 无 TTL，provider/runtime register/dispose/invalidate 才增加 revision、清缓存、发 `skills/change`；
- 迟到 invalidate 只有精确 registration 仍 active 才有效。

Consumer 可以在 incomplete observation 时保留 last-good model catalog，但那属于 consumer 状态，不等于 Registry 缓存旧结果。

## Filesystem Provider

- 只扫描明确 roots 和层级，不递归所有 Markdown；
- `<name>/SKILL.md` + 安全 frontmatter；
- name/description/invocation fields 严格解析；
- project/custom/user roots 的 rank 是 provider 自己的规则，不冒充全局所有 provider 顺序；
- 路径 canonicalization、symlink/escape 策略明确；
- body/resource root 读取大小受限；
- parser 不执行代码/YAML tag；
- watcher 触发精确 invalidate。

## 模型 Consumer

初始/替换目录消息只含 name、description、invocation，带 source/digest；模型调用 `skill(name)` 后正文作为保留工具结果进入历史。后续文件编辑不改写旧历史。无效/不可见 name 返回稳定结果。

## 实现任务

1. Candidate/Definition/Policy/Provider types；
2. ScopedLayers provider/runtime registry；
3. collection arbitration/incomplete diagnostics；
4. cwd/scope/revision bounded cache；
5. get revalidation + signal race；
6. precise invalidate/change；
7. filesystem roots/frontmatter/path safety；
8. model/user consumers/catalog digest；
9. watcher/last-good consumer behavior；
10. Skill body 的安全展示与执行边界。

## 测试矩阵

| 场景 | 预期 |
|---|---|
| global/near scope 同名 | near 胜出 |
| 同层 rank/registration/local order | 确定胜出 + 诊断 |
| model/user 四种 policy | 两个目录各自筛选 |
| provider list 失败 | incomplete，其他候选仍可用 |
| revision 收集中变化 1/2 次 | 重试/返回 incomplete 不缓存 |
| cache hit/evict | 相同 key 复用，上限生效 |
| get body 修改 | 每次加载最新正文，不改写历史 |
| get 名称变化/迟到 invalidate | 陈旧拒绝，替代 provider 不受影响 |
| bad frontmatter/name/path/symlink | fail-closed，不逃逸 root |
| watcher invalidate | revision/change，consumer 更新目录 |
| Skill 命令 | 仍经过 Tool/Approval/Guard/Sandbox |

## 源码复盘

- [`packages/skill/skill/README.zh.md`](../deepseek-harness/packages/skill/skill/README.zh.md) 与 [`src/index.ts`](../deepseek-harness/packages/skill/skill/src/index.ts)；
- [`packages/skill/skill-filesystem/README.zh.md`](../deepseek-harness/packages/skill/skill-filesystem/README.zh.md)；
- [`packages/skill/tool-skill/README.zh.md`](../deepseek-harness/packages/skill/tool-skill/README.zh.md)；
- invocation policy、缓存/失效和目录消息测试。

## 完成标准

- arbitration 对任何 provider 顺序确定；
- incomplete 与 last-good 职责不混淆；
- body 不缓存且名称重新验证；
- 精确 invalidate 不影响替代注册；
- filesystem 无路径逃逸/代码执行；
- 模型只先看到小目录，按需才看到正文。

## 复盘问题

1. 为什么正文不缓存，而目录可以缓存？
2. Registry 返回 incomplete 与 consumer 保留 last-good 有何区别？
3. nearest layer 和 rank 谁先决定胜出？
