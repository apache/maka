# GuaHub 项目级 Skills 索引

Go 指导集中在六个专项 Skill；项目覆盖规则集中在 [AGENTS.md](../../AGENTS.md)，Claude Code 的根入口导入同一文件。上游正文保持原样，按任务读取，不复制通用规范。

## 已安装

以下六项来自 [samber/cc-skills-golang](https://skills.sh/samber/cc-skills-golang)，固定提交 `8e899e20ff0cd4dc524af3993e4c62d8ee8c5717`，通过官方 [Skills CLI](https://skills.sh/docs/cli) `skills@1.7.1` 安装。

| Skill | 上游版本 | 职责与触发条件 | 状态 |
|---|---|---|---|
| [golang-code-style](golang-code-style/SKILL.md) | 1.3.0 | 新写、修改、审查 Go 代码时检查惯用写法与清晰度 | 已完成 |
| [golang-error-handling](golang-error-handling/SKILL.md) | 1.3.1 | 错误创建、包装、传播、匹配及日志边界 | 已完成 |
| [golang-testing](golang-testing/SKILL.md) | 1.4.0 | 行为测试、表驱动测试、测试隔离、竞态及失败复现 | 已完成 |
| [golang-concurrency](golang-concurrency/SKILL.md) | 1.2.1 | goroutine、channel、锁、所有权及并发退出路径 | 已完成 |
| [golang-context](golang-context/SKILL.md) | 1.3.1 | Context 传递、取消、截止时间和请求生命周期；同步机制由 concurrency 负责 | 已完成 |
| [golang-lint](golang-lint/SKILL.md) | 1.4.1 | 解释并运行已有 vet/lint 门禁；不自动引入工具、模板或修复 | 已完成（指导文本） |
| [create-plan](create-plan/SKILL.md) | 既有 | 用户明确要求编码计划时使用；不作为所有 Go 任务的前置步骤 | 已完成（原样保留） |

自动触发依赖 Agent 根据 `description` 选择 Skill；关键任务可明确点名，例如“使用 golang-concurrency 和 golang-context 检查这个取消路径”。Codex 可使用 `$golang-testing`，Claude Code 可使用 `/golang-testing`（[官方调用说明](https://code.claude.com/docs/en/skills)）。审查组合涉及的专项；重构先明确范围并保护既有行为，再加载测试与相关专项。

## 暂缓安装

| 候选 | 状态 | 判断依据 |
|---|---|---|
| `golang-gopls` | 跳过 | 当前没有 gopls；候选包含 MCP/插件配置引导，本次不修改机器配置。以后有导航需求且工具就绪时再评估 |
| `cxuu/golang-skills` 的 `go-code-review` | 跳过 | 核心及子项目已覆盖审查；nil slice 建议与核心冲突，单装缺少相邻 Skill 引用 |
| `golang-project-layout` | 跳过 | 现有独立项目结构明确，本次无架构修改需求 |
| `golang-performance` | 跳过 | 没有具体性能瓶颈及测量验收条件 |
| `golang-refactoring` | 跳过 | 本次不重构业务，现有核心已能提供相关指导 |

## 安装与验证

从 GuaHub 根目录执行；脚本只使用 Node 标准库，不引入项目依赖。

```bash
node scripts/go-skills.mjs check
node scripts/go-skills.mjs install
```

`check` 核验固定来源、提交、官方锁文件内容摘要、入口元数据、可执行文件与 Claude 相对链接。`install` 仅补装缺失 Skill；六项完整时不写文件。发现本地修改、版本冲突、未锁定同名 Skill、异常链接或不兼容锁文件时停止，已有 Skill 和其他锁条目保留。断链需先审查并恢复链接；不以自动覆盖修复配置。首次或缺失项安装需要网络及 Node >= 22.20.0；npm 缓存、CLI 状态放临时目录，禁用安装生命周期脚本和遥测。

脚本调用固定 CLI 与固定提交，等效安装参数如下，建议使用脚本获得覆盖保护：

```bash
DISABLE_TELEMETRY=1 XDG_STATE_HOME="${TMPDIR:-/tmp}/guahub-skills-install-state" \
  npm_config_cache="${TMPDIR:-/tmp}/guahub-skills-install-npm" \
  npm_config_ignore_scripts=true npm_config_registry=https://registry.npmjs.org \
  npx --yes skills@1.7.1 add https://github.com/samber/cc-skills-golang/tree/8e899e20ff0cd4dc524af3993e4c62d8ee8c5717 \
  --skill golang-code-style golang-error-handling golang-testing golang-concurrency golang-context golang-lint \
  --agent codex claude-code --yes --json
```

目录为 `.agents/skills/<名称>/` 正文，`.claude/skills/<名称>` 相对链接，`web/docs/skills-lock.json` 官方锁文件。不要使用全局参数、`--all` 或无目标的批量更新。需要升级时先审计新提交和 diff，再同步脚本提交常量与官方锁文件。

从 GuaHub 根启动 Agent 使用这些入口。本机 Codex 的只读 `skills/list` 已验证根目录六项均为启用的 `repo` Skill；独立 coding-agent 子仓库与相邻 github 工作区未继承本次安装。Claude 已通过项目路径、相对链接和官方 CLI 列表检查，未进行新会话的模型触发实测。新装 Skills 的发现证据及验证边界见 [本次验收记录](../../web/docs/sessions/curated/projects/2026-10-09-Go-Skills-集成与验收.md)。

## 安全回滚

先保存本地变更并确认上述 `check` 通过，再在 GuaHub 根按六个名称执行官方项目级移除；保留已有 `create-plan`，不要使用 `--all`。缓存与状态继续隔离到临时目录。

```bash
DISABLE_TELEMETRY=1 XDG_STATE_HOME="${TMPDIR:-/tmp}/guahub-skills-rollback-state" \
  npm_config_cache="${TMPDIR:-/tmp}/guahub-skills-rollback-npm" \
  npm_config_ignore_scripts=true npm_config_registry=https://registry.npmjs.org \
  npx --yes skills@1.7.1 remove golang-code-style golang-error-handling golang-testing golang-concurrency golang-context golang-lint --yes
```

完整回退还需按本次 diff 撤销 Go 专用入口、索引、脚本、许可证、记录及 `.gitignore` 新增段；只有锁文件无其他条目时才移除它。不要重置整个工作树，不影响已有修改或其他 Skill。移除与复装已在临时项目演练，未对真实 GuaHub 执行回滚。
