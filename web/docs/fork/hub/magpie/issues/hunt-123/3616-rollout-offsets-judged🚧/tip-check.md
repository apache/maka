# 3616 tip 核对（2026-11-04）

- tip: upstream/main e17b6cef，worktree /private/tmp/mg123-g 分支 fix/3616-rollout-offsets-judged
- 修复提交 67b12956（2026-10-27，作者 yetone）是 tip 祖先：merge-base --is-ancestor 通过
- 首发发布 tag：v0.1.1742 直接指向 67b12956a（2026-10-27）；含修复的最新 v0.1.* tag：v0.1.2891（2026-11-04）
- 报告者版本 0.1.1545（issue 正文环境段）< 0.1.1742 → 升级指引成立
- tip 代码：fitLine internal/sessions/codex_portable.go:497（短行 JSON 后补空格保长；paged rollout 更长行保持原行）；repairLineages 同文件 :521；paginated() :489 读 payload.history_mode
- 守护测试在 tip：TestPortCodexRolloutsKeepsBytePlaces(:335) / TestPortCodexRolloutsLongerLine(:386) / TestPortCodexRolloutsRepairsForks(:411)（codex_portable_test.go）、TestMoveCodexProviderKeepsBytePlaces（codex_provider_test.go:194）
- 实测：go test -count=1 -run 'TestPortCodexRolloutsKeepsBytePlaces|TestPortCodexRolloutsLongerLine|TestPortCodexRolloutsRepairsForks|TestMoveCodexProviderKeepsBytePlaces' ./internal/sessions/ → ok 1.194s
- 鲜度：git log upstream/main --grep=3616 仅 bec9df088（引用 #3616 的 move-open harness，非修复）；67b12956 消息源自 Discord xybio 报告，无 Fixes #3616 尾注，与 issue 的挂钩依据是 yinwu01 10-27 评论
- 发布：take comment-6620969126；判定帖 comment-6621015303（GET 回读 len=2587 可见）
