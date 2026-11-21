# #5399 已修判定取证（车道 N2，2026-11-06）

## 结论

issue 所报 bug 已被上游 b7631300e 修复并随 v0.1.3075 发布；无补丁可交，交付=判定帖。

## 时间线（git 实证）

- b7631300e `claudetui: a successful interactive turn tells its account's allowance`，作者 qiqll，提交时间 2026-11-03 19:33 +0800。
- issue 基线 326e72f4（2026-11-05 22:07 +0800，reporter fork 点）：`merge-base --is-ancestor b7631300e 326e72f4` = NO；first-parent 位次 b7631300e=140 < 326e72f4=167（越靠前越新），即修复晚于基线进 main。
- 首个含修复的 tag：v0.1.3075（2026-11-06 05:54 +0800）；reporter 实测的 v0.1.2925（2026-11-04）早于修复。
- `git log upstream/main --grep 5399` = 空：上游自修未引用单号（handbook 10 §20 同族，方向鲜度判例 #4335 形）。
- issue 评论仅我方 take（comment-6687480801），无收编标记。

## 覆盖面对照（reporter 分支 vs 落地修复）

| reporter 分支要点 | 落地 b7631300e | 判定 |
| --- | --- | --- |
| tap.js 把 `anthropic-ratelimit-unified-*` headers 放 open 行 | 同（`"h"` 字段，仅这些头） | 已盖 |
| tap.go 转 `rate_limit_info`（status+unifiedWindows，解析不出则窗口留空） | 同（`rateLimitInfo`，5h/7d/7d_oi→five_hour/seven_day/seven_day_overage_included，两数齐才收） | 已盖 |
| message_start 前发出；整读消息留到 turn 末 | 同（settle 兜底 + toldOf 只认最新） | 已盖 |
| API error 后重置去重（untold） | 不同机制同意图：transcript.go 先 settle tap 再发 error 自己的 reading（最新者胜） | 等价 |
| 百分比未变不重发（去重） | 不去重，每成功回复都发；NoteClaudeLimits 留最后听到的一条 | 非行为缺口（下游幂等） |
| bridge/provider/routing 不动 | 同（gateway 已把 rate_limit_event 喂 NoteClaudeLimits） | 一致 |

残余缺口（reporter 自己点名的）：不加载 tap 的 interactive Claude Code 仍不报——落地修复同样不盖，判定帖已如实转述。

## 测试取证（worktree /private/tmp/mg-5399 @ 12a9970d6，GOCACHE=/tmp/mg-5399-gocache）

- HEAD 绿：`go test -tags nogui -count=1 ./internal/claudetui/ -run 'TestTapTellsReplyLimits|TestTapLimitsOfMessageToldWhole|TestTapErrorLimitsLast|TestShimTellsTapLimits|TestTapKeptLimitsNotAfterNewer'` → 5/5 PASS（1.093s）。
- 消融回红：`git restore --source=326e72f4 -- internal/claudetui/tap.go internal/claudetui/tap.js internal/claudetui/transcript.go`（只退产品文件）→ 同命令 5/5 FAIL（TestShimTellsTapLimits 30s 等待超时，其余断言红）——与 issue 症状（used 只在重启/窗口重置/429 时动）一致。
- 消融后 `git restore --source=12a9970d6` 复原，`git status --porcelain` 干净。

## 交付

- 判定帖：post.md → issue 评论 → GET 回读 readback。
- 不 push（无补丁）；本地分支 fix/5399-interactive-allowance 与 worktree 用后即清。
