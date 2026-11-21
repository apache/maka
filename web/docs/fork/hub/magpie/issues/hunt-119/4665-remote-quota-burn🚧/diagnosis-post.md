# 4665 diagnosis post — 2026-11-03, lane I (hunt-119)

Issue: #4665 (使用 Magpie + Magpie Remote 时，Claude Code 的 5h 额度消耗非常快)
Reporter: zilonghe, filed 2026-11-01, no data attached, asks: known anomaly? what to collect? mitigation?
Verdict: diagnosis post (no patchable bug in magpie at a3768cdd1 for this report).
Take: https://github.com/yetone/magpie/issues/4665#issuecomment-6583777545
Diagnosis: https://github.com/yetone/magpie/issues/4665#issuecomment-6583840707 (GET read-back verified, 3108 chars, attribution present)

## Posted text (final, as posted)

This is the known quota-burn family — #606 is the main issue with the data — and going through Magpie Remote should land in the same place, because the Remote hop does not change the path that spends the window. What matters most is the version of the magpie that owns the Claude subscription, which in your setup is the remote one.

**What spends the window**

1. Up to v0.1.2265, every Claude subscription run went through `claude -p` (headless). Anthropic labels those requests `sdk-cli` and counts them at about twice the interactive rate (anthropics/claude-code#97074; the independent measurements collected in #606 land at 1.3–3x, and magpie's own changelog says "about twice"). That alone reads as "the 5h window melts" while the API-equivalent cost stays ordinary. Since v0.1.2266 (2026-10-31, 43966a53f) a subscription's run is Claude Code's interactive mode by default, and `-p` is only the fallback: safeguards, opted-in client cache marks, a JSON schema, URL images, a first message over 400KB, or the interactive mode failing to start. The remote magpie is the one running the bridge, so its version decides. Latest is v0.1.2738.
2. One Remote-specific amplifier is already fixed: with a session on a Remote magpie, Claude Code's own background `claude-sonnet-5` classifier calls used to fall back to the session's Opus, and each one rewrote tens of thousands of tokens of 1h cache (9 calls wrote 480K in the #2187 sample). Fixed in 429698f96, first shipped in v0.1.1238.
3. What the Remote hop does not do, checked at current main (a3768cdd1): it does not send anything twice — one relayed call, one vendor call; it does not break reuse — the inner session a turn resumes is keyed by the conversation's own content, and the session headers travel with the relay (#672); and the run's working folder falls back to magpie's own shared folder on the remote (#626), which is what keeps the cache hitting.

**To pin it down without spending anything** (reads only, from logs you already have):

- Versions of both magpies and your Claude Code. Pre-v0.1.2266 on the remote is the simplest explanation for what you describe.
- Sum one 5h window in both magpies' `usage.jsonl` (local and remote): calls, in/out, `cache_read`, `cache_write_1h`. On a pre-2266 remote the burn shows with ordinary cache ratios — no anomaly needed, it is the metering.
- In the remote magpie's log, a run that had to be `-p` prints `claude: this run is -p: <why>`, and the provider page names the mode and the same why (current versions only; older ones are `-p` for everything).

Until the remote is upgraded, the ways around the `-p` metering are the ones already tracked: letting Claude Code use its own sign-in (the model group at the top of its picker does not pass magpie at all), and #4022 / #3933 for the rest.

If your versions are pre-v0.1.2266, upgrading should change the picture on its own; if they are current and the window still melts, the sums above will say which of the remaining known causes it is — that data belongs in #606.

**Attribution**: AI-written; read-only diagnosis, no code in this comment.

## Evidence table (verification, all at upstream/main a3768cdd1)

| Claim | Where verified |
| --- | --- |
| -p requests labeled sdk-cli counted ~2x interactive | internal/gateway/claude_subscription.go:1089-1091 (comment), commit 43966a53f message, anthropics/claude-code#97074 |
| interactive mode default since v0.1.2266 | `git tag --contains 43966a53f` → first v0.1.2266; `claudeTUIRuns = true` (claude_subscription.go:1084); claudetui lands 2026-10-31 |
| -p fallback reasons | claudePrint()/claudeMachineWhy() claude_subscription.go:1112-1165 |
| Remote classifier→Opus fixed 429698f96, first v0.1.1238 | `git merge-base --is-ancestor 429698f96 upstream/main`; first tag v0.1.1238; test TestClaudeDesktopClassifierOnRemoteMagpie in desktop_turn_test.go |
| no double vendor call on Remote hop | internal/gateway/remote_magpie.go (headers only; passOnCaller) |
| resume keyed by conversation content | turnKey() claude_subscription.go:2445; nextTurn() :1521 |
| session headers carried across relay (#672) | remote_magpie.go:132-157 passOnCaller |
| remote workdir falls back to shared folder (#626, CLOSED) | clientWorkDir() claude_subscription.go:442-454 ("a caller elsewhere" → "") |
| #606 community data 1.3–3x, cache-hit-but-burn examples | issue 606 comments (Guuuu233, chilin11, BeiZi6, SuInk) |
| classifier marks kept as opted-in client's (#3835, CLOSED) | docs/subsystems/claude-subscription-bridge.md §Client-placed cache marks; claude_cache.go:34-45 |
| warmup burns one Haiku "hi" only (not a factor) | internal/gateway/claude_warmup.go warmClaude() |

## Key mechanism notes (for the journal, if ever needed)

- 关键时间线：#4665 报于 11-01；TUI 交互模式（43966a53f）首发 v0.1.2266 于 10-31。报告者极可能在 v0.1.2265 及以下（纯 `claude -p`/sdk-cli 时代）。#606 早期 yetone 说"magpie 只走 claude -p"已被 43966a53f 取代。
- 让位闸：issue 零评论无 assignee 后 take；POST 前复查仍只有自己的 take，无撞车 PR，tip 无新提交。
- worktree 未创建（诊断路线，零代码改动），无矩阵可跑。
- 后续观察点：报告者回版本号/数据后，若 pre-2266 → 引导升级后关进 #606；若 current 版本仍快烧 → 数据归 #606（剩余已知因： opted-in cache marks 强制 -p、#2933 工具结果丢失全量重写在途）。
