# Hunt47 / E-2899 — Claude bridge 丢弃请求的 effort

## 结论

已修复并提交。issue 的直接表述（"spawned claude -p 没有 --effort"）在当前 main 上的根因**不在 spawn 处**：`claudeCLIArgs`（`internal/gateway/claude_subscription.go:1934-1937`）早就会在 `req.Effort != ""` 时追加 `--effort <level>`（v0.1.1290 已包含）。真正的丢弃点在解析：`parseAnthropicRequest`（`internal/gateway/anthropic.go:241-251`）只在 `thinking.type` 为 `enabled`/`adaptive` 时才读 `output_config.effort`——带 effort 但不带 thinking 的请求到达 bridge 时 `req.Effort == ""`，于是没有 `--effort`。OpenAI 兼容路由的 `reasoning_effort` 一直无条件透传（`parseChat`，`internal/gateway/chat.go:84`），issue 期望的那一半本就成立。

修复（bridge 限定，最小 diff）：`serveSubscription`（`claude_subscription.go:4053-4062`）在解析后、对 Anthropic 协议且 `req.Effort == ""` 且未关 thinking 的请求，用 `outputConfigEffort`（`decide.go:665-676`，经同一 `effortOf` 归一）从请求体补读 effort。原解析门对其它后端原样保留（没有 thinking 的 effort 在上游会打开 thinking，正是门注释记录的回归）；bridge 处该级别就是 `--effort`，不依赖 thinking。无 effort 的请求照旧不加 flag；续用运行的级别更新走既有 `setEffort`（resume 路径自动覆盖）。

## 产物

- 分支 `hunt47-e-bridge-effort`，单提交 `091ca01d6d6725a8b0bb5605fef7b3c2197e2c64`（基线 upstream/main `ef655acb`），作者 ggbdpq <ggbdpq@gmail.com>
- patch：`0001-gateway-the-Claude-bridge-passes-the-request-s-effor.patch`，sha256 前 16 位 `bfbd20418e0db562`
- 英文评论稿：`2899-comment.body.md`（已 grep 验证零中文、含全部必需段落）

## RED / GREEN（公共缝）

- 测试：`TestClaudeBridgePassesTheRequestsEffort`（`internal/gateway/claude_effort_test.go`），走 `serveClaudeSubscription` HTTP 缝，用 testenv.Program 写的假 `claude` 脚本把 spawn 参数 `printf '%s\n' "$@"` 落盘断言（既有 harness 同款，见 claude_workdir_test.go）。
- RED（修前）：`output_config.effort max` 无 thinking → 记录的命令行无 `--effort`，FAIL（claude_effort_test.go:61）。
- GREEN（修后）：同一请求含 `--effort max`；带 thinking 的 effort 请求 `--effort high` 照旧；无 effort 请求无 `--effort`（三断言同测）。

## 消融 / 变异

- 消融：仅回退 serveSubscription 块 → RED；仅回退 decide.go → 编译失败（undefined outputConfigEffort）；恢复 → GREEN。
- 变异 (a) 去掉 append → RED；变异 (b) 无条件 append → RED 于"无 effort 不得有 flag"断言（claude_effort_test.go:73）；恢复 → GREEN。

## 验证矩阵

| 项 | 命令 | 结果 |
|---|---|---|
| 目标族 | `go test ./internal/gateway/ -run TestClaude -count=1` | ok 33.3s |
| effort 相关 | `-run 'Effort\|effort' -v` | 40 个全 PASS |
| 全包 | `go test ./internal/gateway/ -count=1` | ok 341.9s，exit 0 |
| -race | `-race -run TestClaude -count=1` | ok 40.5s |
| gofmt | 三个触达文件 | 干净 |
| vet | darwin / GOOS=linux / GOOS=windows | 全过 |
| 构建 | nogui：darwin / linux / windows | 全过（darwin 有 internal/gui/trayimage_darwin.go:112 预存 cgo 警告，非本次引入） |

## 不确定项（如实）

- 本机无 Claude 订阅账号，无法对真 CLI 验证；测试里的 Claude Code 是 shell 脚本替身。
- `--effort low|max` 生效的证据是报告者的 A/B 表，非厂商文档（magpie #385 提交记录旁证 2.1.286 接受五档）。
- low/max 之外的档位未对真 CLI 检验；magpie 侧五档均按请求原样透传（既有单测覆盖）。
- 报告者请求体是否带 thinking 无法确证；但"带 effort 无 thinking 被丢"已在当前 main 复现（RED 证据），与报告者采样到的现象一致。
