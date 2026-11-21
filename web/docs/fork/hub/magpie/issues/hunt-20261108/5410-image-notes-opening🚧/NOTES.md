# 5410 · Remote magpie+Claude 订阅：text-only 轮模型去开 [Image: source] 远端路径

- take: https://github.com/yetone/magpie/issues/5410#issuecomment-6714286114
- 帖: https://github.com/yetone/magpie/issues/5410#issuecomment-6714624242
- fork 分支: fix/5410-image-notes-opening head 0e49218d987a792c51e0802c4910d040bc9fe2ac（基=upstream/main 1cb3dc435）
- patch sha256 前16: ca3c1a9379502713

## 矩阵（全部实测）

- RED（基线父提交树）：TestClaudePromptSaysNotesPathsArentOpen 失败，turn 文本=报告者 quoted 逐字形状（"…are about the images in the conversation history above, not images sent with this turn."）
- GREEN：同测试 + TestClaudePromptSaysWhoseImageNotesAre / SaysToolResultImagesAreAttached / SaysPastCallsAreARecord / MarksEarlierTurns 全绿
- 消融：只退产品文件（git checkout HEAD~1 -- claude_subscription.go，diff --stat 复证 1 file changed）→ 测试红；恢复（checkout HEAD）→ 绿；终态 git diff HEAD 空
- gofmt -l 干净；go vet ./internal/gateway 过
- 全量 go test ./internal/gateway -timeout 30m：ok（931.9s，日志 go-test-full-gateway-30m.log；首跑默认 10m 超时被打断为 FAIL，mcpauth.go:1007 为超时栈帧，30m 重跑全绿）

## 兄弟面

notes 家族 4 位点：currentTurnOpen 两分支（改：说归属缺"别开"）；imageNotesNote（renderClaudePrompt 4655 / renderClaudeTurn 5080 两调用点，不动：已含 "a path in one is not something to open"）；historyOpen / desktopNote 不涉 notes。renderClaudeTurn 无历史概念（saved session 只发本轮，notes 恒为本轮自己的，imageNotesNote 已覆盖）。

## 排雷五查

评论区空（take 前+发布前两次复核均只余自家 take）；无收编形态；open PR 无引用；log --grep 5410 空；域词 -S 仅 8468afecb / 113672508 两个历史提交。

## 未验证

报告者端到端环境（Codex desktop→remote magpie→Claude）与真模型是否停叫 view_image（等效句 3/3→0/3 是报告者自己的 A/B）。
