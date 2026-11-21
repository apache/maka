# hunt46 / a-2817 修复记录（本地笔记，勿提交进仓库）

issue: yetone/magpie#2817 — 插件 provider 拿不到 Claude Code 的自有请求头，"仅官方 Claude Code 客户端" 的上游（sub2api 限流组）全部 403，同 key 走自定义 provider 全 200。

## 产出

- worktree `/tmp/magpie-h7`，分支 `hunt46-a-plugin-claude-headers`，基线 upstream/main `1a3b9268860263f263a2c832b1f9b6d1b57e3fa0`。
- commit `f599af7e475c5e9e02c6e2cfc845bcd8383b30e4`，作者 ggbdpq <ggbdpq@gmail.com>（已核对）。
- patch `0001-gateway-a-plugin-provider-that-speaks-Anthropic-with.patch`，sha256 前 16 位 `2f255703f03b5966`。
- 本目录：RESULT.md（本文件）、2817-comment.body.md（英文、可直接贴、零中文字符已校验、内嵌 patch 与格式补丁逐字节一致已校验）、format-patch 一个文件。

## 代码调查结论（方向选择的依据）

报告给了三个方向，选了方向 1（插件账号 = 说 Anthropic + loader 给了 key，按自定义 provider 对待），调查支持干净落地：

- 两道闸都在 gateway 包、且都在 `to/proto == provider.Anthropic` 之内：
  - `forwardOnce`（gateway.go:3835 改前为 `p.Account == nil && fromClaudeCode(in)`）转发 claudeCodeHeader 五族（user-agent、x-app、anthropic-*、x-stainless-*、x-claude-code-*，绝不含对方的 key）；
  - `passthrough`（改前 4180 行）追加 `?beta=true`，同样要求 `p.Account == nil`。
- `internal/provider/user_agent.go:10` 的 `PassesUserAgent`（#1851）也卡 `p.Account == nil`，但本修不需要动它：转发的 header 集合本身就含 user-agent，会像自定义 provider 一样覆盖 magpie 的 UA（RED 输出证实改前 UA=magpie/dev、改后=claude-cli）。动它会改变所有 agent 对所有插件的 UA，超出本单。
- 插件账号必带 account：`internal/provider/plugins.go` 的 `pluginProvider` 里 `&Account{Agent: "plugin", …, plugin: &pp, pluginKey: acct.Key}`。
- "说 Anthropic" 在 relay 时已由 `pluginProtocol`（m.NPM = `@ai-sdk/anthropic`）决定路由的 `to`，两道闸的所在块即是该条件，OpenAI 形状的插件（Chat/Responses）天然不进这两块。
- "用 key 认证" 的接缝：`plugin.LoaderOptions(ctx, pp.ID, key)` 返回 `Options{BaseURL, APIKey, Headers, Fetch}`，有按 (provider, account, generation) 的缓存；`pluginFetch` 与 `Provider.Origin` 在 relay 时本来就会调它。host.js 的 fetchAs 把 magpie 传的 headers 放在 SDK 头之后、chat.headers 之前 → 转发头能穿过插件 fetch 到上游，插件的 key 签名不受影响（测试断言 Authorization=Bearer k1 前后都过）。
- Codex 的同构闸（`p.Account == nil && (Responses|Chat) && fromCodex(in)`，gateway.go:3851 一带）保持原样：报告只涉及 Claude Code，无对应 relay 可验证，留给维护者，评论里已写明。

## TDD 与证据

1. RED（基线 1a3b9268，只加测试 `TestClaudeCodeHeadersReachAnthropicPlugin`，位于 claude_code_headers_test.go，镜像 #179 测试形状 + TestPluginProvider 的 fake 插件基建，bun 1.4.2）：
   - User-Agent: got "magpie/dev", want "claude-cli/2.1.0 (external, cli)"
   - X-App: got "", want "cli"
   - Anthropic-Dangerous-Direct-Browser-Access: got "", want "true"
   - X-Stainless-Lang: got "", want "js"
   - X-Claude-Code-Session-Id: got "", want "ses-1"
   - query "", want beta=true
   - （Anthropic-Beta 与 Authorization=Bearer k1 改前即过，符合预期）
   - 日志 /tmp/h7-red.log，EXIT=1。
2. GREEN：最小改动两处条件 + 两个小助手（`gateway.claudeCodeRelay`、`provider.Provider.LoaderKeyed`）。定向 `TestClaudeCodeHeaders` 绿（1.157s）。
3. 消融：gateway.go 与 provider/plugins.go 全部还原 `git show upstream/main:<path>`（/tmp/h7-keep/ 留底），只留测试 → RED 同样 6 行；恢复 → GREEN（1.017s）。
4. 变异：(a) 只还原 header 闸 → 5 条 header 断言红、query 断言不红；(b) 只还原 beta 闸 → 只有 `query "", want beta=true` 红。各自独立红，证明两处都必要且测试钉得住。恢复后绿。

## 验证矩阵（darwin/arm64，go 1.26.8，-tags nogui）

| 项 | 命令 | 结果 |
|---|---|---|
| 定向 | `go test -tags nogui -count=1 -run 'TestForward\|TestPlugin\|TestPassthrough\|TestClaudeCode' ./internal/gateway/` | ok 40.440s，EXIT=0 |
| 全量 | `go test -tags nogui -count=1 ./internal/gateway/` | ok 313.791s，EXIT=0 |
| race | `go test -race -tags nogui -count=1 -run 'TestForward\|TestPlugin' ./internal/gateway/` | ok 60.171s，EXIT=0 |
| gofmt | `gofmt -l internal/gateway/ internal/provider/` | 空 |
| vet | darwin/linux/windows 三 GOOS，`./internal/gateway ./internal/provider` | 全 0 |
| build | darwin `./...`；linux `-tags nogui ./...`；linux 触及包原样；windows `-o /dev/null .`；windows `-tags nogui ./...` | 全 0 |

预存问题（如实）：裸 `GOOS=linux go build ./...` 在 Wails GUI 依赖内部失败（menu_linux.go `undefined: pointer`，模块缓存，需 Linux GTK），与本次改动无关、基线同样失败，`-tags nogui` 下 linux 全仓构建干净。

## 未验证 / 不确定

- 没有真实 sub2api 上游与受限组 key：403 文案引自报告；上游是否像收自定义 provider 一样收这套转发头，端到端未测（论据=头集合与 #179 对自定义 provider 发的逐字节相同，后者有既有测试钉住）。
- 报告说 sub2api loader 返回 `{baseURL, apiKey}`；本地用仓库自带 fake 插件（loader 带 apiKey、且带自己的 fetch）建模。loader 既无 key 也无 fetch（纯 OAuth）的插件不转发——符合意图但无真实插件可测。
- `?beta=true` 只走 relay（passthrough）路径，与自定义 provider 的现状一致；被翻译（非 relay）的 Claude Code 请求有头无 query。
- Linux/Windows 仅构建与 vet，未跑运行时。
- LoaderOptions 首次调用会跑一次插件的 loader（之后按 sign-in/host 缓存）；pluginFetch 每请求本来就会调，成本可忽略。

## 纪律确认

- 只在 /tmp/magpie-h7 动手；未 push、未发 GitHub 评论；未动主 clone 与其他 worktree；未用 stash/reset/checkout --。
- 提交作者 ggbdpq <ggbdpq@gmail.com>；commit 消息以 -F 文件写入，含 Generated-by: GLM-5.3-Flash (ZCode)。
