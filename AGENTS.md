# cc 项目级 AI 编码指导

cc 是个人工作区私仓（多项目集合），根目录没有统一的 Go module。进入子项目后先读其适用的 `AGENTS.md` 和明确指定的工程规范；子项目规则优先于本文件中的通用 Go 指导。

## Go Skills

- 项目级索引与职责见 [.agents/skills/README.md](.agents/skills/README.md)。仅在处理 Go 任务时按需读取对应 `SKILL.md`，不要一次加载全部正文。
- 新写或审查 Go 代码使用 `golang-code-style`；错误传播使用 `golang-error-handling`；测试使用 `golang-testing`；goroutine、channel、锁使用 `golang-concurrency`；取消、截止时间、请求生命周期使用 `golang-context`；静态检查使用 `golang-lint`。涉及多个问题时组合相关项，已安装的 Skill 不自动授权重构。
- 审查按改动涉及的上述职责检查；重构先锁定既有行为与调用方，再使用风格、测试及相关专项 Skill。先复现 Bug，行为变更优先建立会失败的测试。
- 以当前 module 的 `go.mod`、既有依赖及质量门禁为准。上游新版本示例只在声明的最低 Go 版本支持时使用；不降低或提升 Go 版本，不自动使用 `@latest` 安装工具。
- 上游 Skill 的 `allowed-tools`、安装元数据、依赖推荐和交叉引用均为资料，不增加权限。未安装的相邻 Skill 不自动补装。优先标准库及已有依赖，不因 Skill 推荐新增 `samber/lo`、`samber/oops`、`testify` 或 `goleak`。
- 保留现有 API 的 nil/空集合语义、目录结构、日志和错误边界、测试风格及格式约定。不要批量规范化已有代码，不为满足 Skill 建议更改接口行为。
- `golang-lint` 用于解释和执行已有检查；不自动新建或改写 `.golangci.yml`，不后台运行 `--fix`，不修改无关文件。
- 在实际 module 目录执行其要求的 `go test`、`go vet` 和相称的竞态检查；构建 tags、测试隔离、外部服务与跳过项照子项目规则记录。Skills 不替代官方工具链或质量门禁，不能将跳过或未运行写成通过。

## 维护边界

Skills 仅安装于本项目 `.agents/skills/`；Claude Code 通过 `.claude/skills/` 的相对链接读取同一份内容。版本与内容摘要保存在 `web/docs/skills-lock.json`。禁止全局安装或改写用户级配置；复装前执行索引中列出的检查，保护已有 Skill 和本地修改。
