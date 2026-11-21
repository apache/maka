# Hunt57 #3020 处理报告（task-notification 经 Claude 订阅桥被丢）

日期：2026-10-21。worktree：/tmp/magpie-h84（分支 hunt57-c-task-notification，base f5b01574 = upstream/main）。全程只本地；未 push、未发帖、未动主 clone 与其他 /tmp/magpie-h*。

## 产物

- 提交：`d0a9ef61745d9d9900e26e7c32d05ecb7dacd303`（parent=f5b01574，作者 ggbdpq <ggbdpq@gmail.com>，2 文件 +51/-0）
- patch：本目录 `3020-task-notification.patch`，sha256 前 16 `b61928472f034f1c`
- 英文帖：`issue-body.md`（五段 + 严格尾部模板；自动核验：零中文、尾部八项顺序正确、表格 9 行无行间空行、patch 为 format-patch 全文）
- 证据文件：`red.log`（RED 原文）、`green.log`（GREEN+负例）、`gateway-full.log`（全包 ok 320.989s）、`fix-subscription.diff`（消融用 diff 副本）、`commit-msg.txt`、`issue-original.md`（issue 全文）

## 假设与排除（任务给的三个嫌疑方向）

- ① redact 开启是报告者环境差异 → **证伪（非成因）**：单元层 RED 在 masking 关闭下复现（`continuing` harness 不启用掩码）；redact 是值级掩码/还原（redact.go），不丢块。
- ② Claude 直出路径对非标准 content block 的白名单/裁剪 → **证伪（非本例成因）**：relay 路径（attempt→passthrough，gateway.go:3594 起）body 原样转发，Anthropic 分支的改写（advisorTools/billing line/thinking 等）全是定向字段改写，不丢任意文本块；translate 路径 parse 保留 text 块与 role:system（rebuild 时转为 user，anthropicBody `role != "assistant" → user`），文本仍在。A/B 的确定性 NOT_SEEN 只有订阅桥能造成。
- ③ 丢点在 magpie 读取→转发之间 → **证实，精确丢点为订阅桥恢复路径**：
  - Claude Code 2.1.296+ 把 tool results 之后的尾随文本（hook 通知、`<total_tokens>`、mid-turn 用户话语）合并进一条 `{role:"system"}` 消息（c4f4aaaa #2060 实录）；后台任务的 `<task-notification>` 同路随行。报告者 routing 日志的 `system.harness` item（≈494 tokens、无前置 tag，与 results=[Agent,Bash] 同请求出现）正是这条 system 消息的观测投影。
  - 等待 results 的 run 走 `continueWith`（claude_subscription.go:3366，base 行号，下同）恢复：results 走 MCP，`saidWithResults`（:3257）提取的文本经 `queue`（:3424）作为 user 消息写入内部 CLI。
  - `saidWithResults` 两道闸把通知全形态挡掉：`case m.Role == "system" || m.Role == "developer"`（:3273，#2060 为 hook 通知加的）挡 system 形态；`case !agentNotice(p.Text)`（:3274）中 `agentNotice` 的 `injected` 列表含 `"<task-notification>"`（prompt.go:655，为 turn 判定加的）挡旧式 user 消息形态。
  - 对照不丢面：新 run 路径 `renderClaudePrompt`（:2598）/`renderClaudeTurn`（:2886）把每条消息按 Human:/Assistant: 渲染，通知存活（守卫测试 base 上即绿）——只有"run 等着 results"这条最常见路径丢，与 A/B（直连 2/2 SEEN、经 Magpie 3/3 NOT_SEEN、两边 stream-json 都发了通知）完全吻合。

## 修复

`internal/gateway/claude_subscription.go`：`saidWithResults` 增加 `case taskNotice(p.Text)`（`strings.Contains(text, "<task-notification>")`），置于 midTurn 提取之后、system 闸与 agentNotice 闸之前；hook 通知与 token 计数仍被挡（#2060 测试原样保持绿）。mid-turn 合并文本经 `midTurnSaid` 本就整段保留到 `midTurnEnd`（裸 `\n\n<task-notification>` 不匹配任何终止符），无新增丢失面。

`internal/gateway/claude_hook_notice_test.go`：两种形态（system 消息内 / 独立 user 消息）的 RED 测试 + 新 run 路径守卫测试。

## RED（base f5b01574，`go test ./internal/gateway/ -run TestClaudeTaskNotificationGoesOnWithTheResults -count=1 -v`）

```
--- FAIL: TestClaudeTaskNotificationGoesOnWithTheResults (0.00s)
    --- FAIL: TestClaudeTaskNotificationGoesOnWithTheResults/in_the_system_message (0.00s)
        claude_hook_notice_test.go:85: Claude Code was written [], want the task-notification
    --- FAIL: TestClaudeTaskNotificationGoesOnWithTheResults/a_message_of_its_own (0.00s)
        claude_hook_notice_test.go:85: Claude Code was written [], want the task-notification
FAIL
FAIL	github.com/yetone/magpie/internal/gateway	1.174s
```

断言级：两种形态通知都没送达内部 CLI（written []）。同跑的守卫 `TestClaudePromptToldTheTaskNotification` 在 base 上即 PASS（不对称性佐证）。

## GREEN（修复后定向 + 负例）

`-run 'TestClaudeTaskNotification|TestClaudePromptToldTheTaskNotification|TestClaudeHookNotices|TestClaudeUsersMessageAmongHookNoticesGoesOnAlone|TestClaudePromptToldHookNoticesNotAsTheUsers|TestAgentNoticeLeavesTheUsersWords' -count=1 -v`：全部 PASS（green.log），含 #2060 负例两条（hook 通知不排队、mid-turn 用户话语单独通过）。

## 消融（每步命令+结果见过程记录）

1. 还原 claude_subscription.go（checkout + diff 副本回滚）→ 红原文与 base RED 逐字一致；`git apply` 恢复 → 绿。
2. 打破核心：`taskNotice` 改为恒 `return false` → 两形态红（同断言）；还原 → 绿。证明测试钉住的就是该分支。

## Watched 三查

- a) 已述（修复核心单分支 + 谓词函数）。
- b) 兄弟面：`saidWithResults`/`agentNotice`/`midTurnHead` 在 codex_*/opencode_*/desktop_* bridge 零引用（rg 证实），闸只存在于 Claude 订阅桥；新 run 渲染路径本就写出通知文本（守卫测试双态绿）；`match` 只提 results/images，不动；`parseAnthropicRequest` 的未知块类型丢弃只在 translate 路径可达且通知走 text 块，不触；prompt.go `injected` 是观测/turn 判定，不承担投递，不改（改它会动会话键与 turn 判定）。
- c) 读失败/畸形：`taskNotice` 是 Contains，畸形或缺失 tag 时落到原两道闸（与 base 行为一致），无新失败路径；`queue` 的 2s 超时路径未动（results 照常送达）。

## 矩阵

| 项 | 结果 |
|---|---|
| 定向（上述 -run） | PASS |
| race 定向（同 -run 加 turn/intent 测试） | ok 2.148s |
| gofmt -l 两文件 | 空，exit 0 |
| go vet ./internal/gateway | 空，exit 0（一次误报 exit=1 是 grep 管道退出码，直跑复核 exit=0） |
| build darwin/arm64 `go build ./...` | exit 0（仅预存 ld 警告） |
| build linux/amd64 `-tags nogui` | exit 0 |
| build windows/amd64 | exit 0 |
| gateway 全包 `-count=1 -p 1 -timeout 30m` | ok 320.989s（真实完成，非超时家族） |

## 不确定项

- **未端到端**：没有真实 Claude Code 2.1.303 + 真实 Claude 订阅的端到端复跑；2.1.303 通知消息的精确字节是从 #2060 的 2.1.296 实录形态 + 报告者 routing 日志推断的（含 `<task-notification>` tag 的 system 消息随 results 同请求）。若 2.1.303 改成完全不含该 tag 的纯散文，本修复不覆盖——需报告者实测确认。
- 报告者环境里 provider 是否确为订阅桥（`Account.Agent == "claude"`）由 A/B 行为反推（relay/translate 路径均无法造成确定性全丢）；若其实配置是第三方 Messages 中转且中转自身丢 system 消息，则属上游问题，但 magpie 的桥修复对本例自洽。
- 通知若与 mid-turn 用户话语合并在同一 system 文本且被 `midTurnEnd` 截断的极端形态未构造测试（现有终止符集不含 `<task-notification>`，理论上不截）。
- 环境噪音：zsh profile 的 `_encode/_decode` 报错与本任务无关，已从日志 grep 掉。
