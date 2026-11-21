# #5100 已发布 patch 的新 tip 复核（2026-11-04，重复车道 H）

## 判定

今天 08:17 的 take（评论 6626073577）是同一 fork 并行车道的**重复调度**：昨晚已由
5100-drift-own-claude 车道发布完整 patch 帖（评论 2026-11-03T16:39Z，head
22d2d4ede781490e0d4308cf77dfabf555869a20，分支 fix/5100-drift-own-claude 已推 fork）。
按撞车纪律：不撤回、不重发；本车道只做复核 + 处置说明帖。

## 任务书原定方向（源头隔离，报告者方案 1）不可行的代码证据

- 登录账号（configDir=""）预热：`warmClaudeLogin`（internal/provider/claude_warmup.go）
  对 Active 账号传 ""，`inClaudeDir`（internal/gateway/claude_subscription.go:752）
  原样返回 env——凭据就在用户 `~/.claude`，`cleanClaudeEnv` 刻意剥
  ANTHROPIC_BASE_URL/AUTH_TOKEN 让预热直连 Anthropic。隔离须复制用户 OAuth
  凭据到 magpie 管理目录（凭据落盘复制，危害红线）且 token 刷新两处分裂。
- 桥接 `--resume`：用户旧会话的 transcript 在用户 `~/.claude/projects/`，换
  CLAUDE_CONFIG_DIR 即 resume 不到；project 字段因此天然是用户目录，
  `/tmp/magpie-*` 前缀过滤（报告者已指出）也盖不住。
- 报告者观察到的"不一致"分支：15:48 那次 helper 走的是**已存账号**
  （saved dir，inClaudeDir 设置 CLAUDE_CONFIG_DIR，隔离生效）；13:52/13:57 的
  `--resume` 与 Active 账号预热走**登录账号**（configDir=""，不隔离）。行为
  与 inClaudeDir 的 configDir 分支完全对应，无未知路径。

## 新 tip（3eb2bda4f，上游前进 1 提交）实测

- `git am -3` 干净适用（verify worktree 72cad1a82）。
- 定向 4 测试：TestClaudeDriftOwnSessions / TestWarmClaudeSaysItsOwnSession /
  TestClaudeHelperSessionIsMagpiesOwn / TestClaudeBridgeSessionIsMagpiesOwn 全绿。
- `gofmt -l`（8 改动文件）clean；`go vet`（agent/gateway/usage）clean；
  `go build ./...` ok（仅预存 cgo/ld 警告）。
- `go test -tags nogui ./internal/usage/` 全量 ok（56.6s）。
- `go test -tags nogui ./internal/agent/` 全量：唯一红 TestMothX——在**未打
  patch 的新 tip 3eb2bda4f 上单跑同样挂**（1.80s FAIL），预存实锤，与本 patch 无关。
- `go test -tags nogui ./internal/gateway/` 全量：见 post-verify 备注（后台跑）。

## 兄弟面 rg 全查（patch 覆盖面独立复核）

- `LastUsed:` 全仓仅两处：claude.go:2424（带 sessionId skip）、codex.go:1895
  （不带——magpie 从不起 headless Codex，无 OwnSession 可注册，不改有据）。
- OwnSession 注册点 3 处全查：claude_warmup.go:70（-p 启动前）、:174（resultLines
  读 result 行时，覆盖 -p 预热与 one-off helper）、claude_subscription.go:3671
  （桥接 run 的 init，经 ownClaudeSession wrapper）。
- 读失败语义：sessionId 字段缺失/坏 JSON 的行照旧计为使用（不 skip），宁误报
  不漏报；注册表重启即空，bypassed() 的 used.After(started) 挡重启前旧行。
