# 2933 侦察结果：Claude 订阅桥丢 tool results → 挂起 + 配额快烧

- Issue: yetone/magpie#2933
- 分支: `hunt48-d-bridge-toolresults`（worktree `/tmp/magpie-h17`，base upstream/main `e4ac5e87`）
- 结论: **有确定性缺陷，已修**。commit `1de5d792fdad891d173f0db435f5476d2bbce8bb`，format-patch sha256 前 16 `07563606fc07a9f5`。

## 缺陷（H1，成立）

`serveSubscription`（`internal/gateway/claude_subscription.go`）里工具结果请求按 **tool_use id 精确匹配**（`b.calls[callID]`）找到停着的 run 后，若 `run.follows(req.Messages)` 失败（本次请求的历史与 run 上次听到的不是前缀一致），旧代码直接 `run.abort()`。

问题在于：**带同一批 tool_use id 的请求不一定来自 run 的原主**。Claude Code 的 fork 子代理（代码注释 4085-4093 明说：fork 从 lead 的对话现状出发，对其每个调用各带一份结果）和 `--resume` 会话共享同一批 `toolu_*` id。这类「冒充」请求：

1. `claimResume()` 认领停着的 run（parked 状态下必然成功）；
2. `follows` 失败（fork/resume 重建的历史与 run 听到的不一致）；
3. `abort()` 杀掉 run——**而真主人的结果还在路上**。

真主人的结果随后到达 → `b.calls` 已被 `finish/removeRun` 清掉 → `noRunWaiting` → 新 run 被告知整个对话（392 条消息）→ 缓存全量重写 = 配额快烧 + TTFT 极长 = 用户看到的「挂起」。

与日志逐条对上：
- `let go: earlier messages changed while it waited for tool results` = 冒充请求（或本客户端压缩）在杀 run；
- `tool results no run waiting: the run that made the calls ended 26s ago: magpie ended it` = 真主人的结果晚到 26s，run 已被杀（`killed=true` → whyLost 输出 "magpie ended it"）；
- `two runs were let go in the same second, followed by no run waits for this turn: its run ended 0s ago` = 两个 fork 请求同时到达，各杀各认领的 run，主会话的结果几秒后扑空；
- `a new Claude Code is told the whole conversation: 392 messages` = 690 行的全量重发日志。

## 假设清单与裁决

| # | 假设 | 裁决 | 证据 |
|---|------|------|------|
| H1 | 历史改写的冒充请求经 byExactID 认领后 abort 杀掉真 run | **成立（缺陷，已修）** | RED 测试：改写请求杀 run、真主人结果扑空落到第三只 run |
| H2 | 单客户端 mid-turn 压缩（Pi/microcompact）触发同一 abort | 设计内（4110 旧注释），但 abort 并非必需——请求反正拿新 run | 同一修复覆盖：新行为下Pi 案例客户端可见行为不变，旧 run 变成受 parkLongest/parkedMost 约束的僵尸 |
| H3 | 30 分钟 turn 定时器（line 755 + continueWith 重置）杀长轮次 | 设计内，遗留为 feature request（reporter 建议可配置是合理的） | 代码路径：`AfterFunc(30min, abortFor("it waited as long as it may"))` |
| H4 | idleMost=6 逐出挤掉主会话 run | 设计内，且 shelve→`--resume` 保缓存（无 session 文件时才真 abort）；可配置属 feature request | `keepIdle`/`shelve`/`unshelve`；仅当 `--no-session-persistence` 生效（无共享 work dir、WSL）时无缓解 |
| H5 | 双账号路由切换触发 `accountChanged` abort | 排除 | 报告者日志无 "tool results account changed" 行 |

## 修复

`follows` 失败时不再 `abort()`：新增 `released()` 释放 `claimResume` 的认领（`resuming=false`）并把 run 的定时器重置为 `parkLongest`（5 分钟，与「caller 已停不发结果」的既有语义一致），请求自己拿新 run。效果：

- 冒充请求照样得到回答（新 run，与 answeredElsewhere 路径一致）；
- 真主人的结果几秒后到达 → byExactID → 认领已释放 → `follows` 通过 → 结果照常递给原 run，**热缓存保住**；
- 若真主人永远不来，僵尸按 parkLongest 收割（parkLongest 语义复用，无新常量、无新配置）。

日志行改为 `tool results go on in a run of their own: earlier messages changed while the run that made the calls waits for them`（旧的 "let go" 措辞不再属实）。

## 验证

- RED：`TestRunLetGoWhenTheClientRewroteTheConversation`（改写请求杀 run + 真主人结果落第三只 run）、`TestRewrittenRunWaitsParkLongestForItsOwnResults`（改写请求当场杀 run）——修前双双失败，失败点与预测一致。
- GREEN：两测试通过；新行为断言：改写请求由第二只 run 回答、原 run 不死、原 run 自己的结果仍递给它、超 parkLongest 无结果则收割。
- 变异 1（去掉定时器重置）→ 收割测试红（run 等 10s 不死）；变异 2（不释放认领）→ 递送测试红（结果落第三只 run）。两者均被测试锁死。
- 消融：新增面只有 `released()` 6 行 + 分支改写 + 注释，无可删复杂度。
- 矩阵：targeted 家族 `-race` ✓；全部 `TestClaude*` ✓；全 gateway 包（341s）✓；`gofmt -l` 改动文件 ✓；`go vet ./internal/gateway/` ×3 exit 0 ✓；`go build ./...` ×3 exit 0 ✓。

## 未验证 / 边界（诚实声明）

- 未用真实并发 Claude Code CLI + fork 子代理复现报告者的完整环境；修复针对的是仓库内可确定性复现的配对缺陷（杀 run 的事实与顺序由日志与代码路径钉死）。
- 报告者日志里 "ended 7m48s ago" 那类行**也可能**部分来自 H3（30 分钟定时器）与 H4（idleMost 逐出）——这两个是设计内行为，本补丁不改；reporter 的「可配置」建议是独立的 feature request。
- "ended 26s/0s ago" 的间隙与 H1 的冒充级联吻合（fork 工具先完成、lead 晚 26s），但不能排除个别实例是定时器/逐出所为。

## 工件

- 英文评论稿: `2933-comment.body.md`（含完整 format-patch）
- 分支: `hunt48-d-bridge-toolresults` @ `1de5d792`（/tmp/magpie-h17，未推送）
