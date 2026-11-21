# #3695 landed 判定 — tip 核对记录（2026-11-04）

## 结论

已 landed：v0.1.1701（430e3050d）修复，tip 仍在，无需 patch。本车道只发判定帖。

## 修复提交

- `430e3050d` — "gateway: magpie's own searches and image descriptions go without the agent's middleware (#3695)"
- 作者 JoeyWu-tech <joey110551567@gmail.com>（维护者评论：补丁收 coffemon @JoeyWu-tech，保留原作者）
- 提交日期 2026-10-26（维护者 2026-10-27 评论宣布 v0.1.1701 已修）
- `merge-base --is-ancestor 430e3050d upstream/main` → YES（实测）
- `merge-base --is-ancestor 430e3050d v0.1.1701` → YES；tag v0.1.1701 的 log -1 正是 430e3050d（实测）
- `merge-base --is-ancestor 430e3050d v0.1.2891` → YES（最新 release，2026-11-04 发布）
- 鲜度：`git log upstream/main --oneline --grep=3695` 只有 430e3050d 一条，无后续回退（实测）

## tip 现状（基线 upstream/main tip = e17b6cef，worktree /private/tmp/mg123-f 已 ff 对齐）

- `internal/gateway/middleware.go:140-142`：`ownAsk` 用空的 `mwRuns{}` 覆盖 triedKey 上的 agent middleware 记录，并清 agentTurnKey；注释块（:128-139）点名 #3695。
- `internal/gateway/vision.go:696`：图片描述请求 `http.NewRequestWithContext(ownAsk(magpieChose(ctx)), ...)`；调用链 seenBody:749 → describe:418 → describeWith:582 → askVisionWith:670（:696 在其内）。
- `internal/gateway/search.go:1109`：搜索替身请求同样 `ownAsk(magpieChose(ctx))`。
- 回归测试在案：`internal/gateway/middleware_test.go:197` TestImagesDescribedWithoutTheAgentsMiddleware、`:237` TestSearchesWithoutTheAgentsMiddleware。

## 本机实测（darwin/arm64）

- `go test -race -run 'TestImagesDescribedWithoutTheAgentsMiddleware|TestSearchesWithoutTheAgentsMiddleware' -count=2 ./internal/gateway/` → `ok github.com/yetone/magpie/internal/gateway 2.338s`，exit=0（日志 /tmp/mg123-f3-tmp/race-test.log）。

## 版本对照

| 项 | 版本 | 依据 |
| --- | --- | --- |
| 报告者（aiirobyte） | 0.1.1476（同一代码确认在 v0.1.1564 与当时 main e5dd869） | issue 正文环境段 |
| 修复首发 | v0.1.1701（= 430e3050d） | tag 实测 + 维护者评论 |
| 最新 release | v0.1.2891（2026-11-04） | gh release list |

## 与任务简报的差异

- 简报写"报告者 yinwu01"；实际 issue OP 是 **aiirobyte**（正文+commit 正文均点名 aiirobyte），yinwu01 是复现+patch 评论者（patch 托管在 JoeyWu-tech/magpie），维护者把 patch 记给 coffemon（@JoeyWu-tech）。判定帖 credit 按 on-record 事实覆盖三方：aiirobyte（报告）、yinwu01（复现+patch 工作）、JoeyWu-tech/coffemon（上游补丁）。

## 未验证

- 未复跑真实 `magpie serve` 多图并发场景（沿用维护者评论自述同样未做）。
