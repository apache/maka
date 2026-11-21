# 4172-thinking-signature 发布记录（Lane D，2026-11-04）

## 结局：判定帖（已修复，无 patch）

- issue: yetone/magpie#4172（MOMO0302-02，OPEN，0 评论/0 竞品 PR/0 assignee，让位闸通过）
- take: https://github.com/yetone/magpie/issues/4172#issuecomment-6618909005
- 判定帖: https://github.com/yetone/magpie/issues/4172#issuecomment-6618947752（GET 回读 3692 字节，八要素全中，credit 在正文首段）
- 无 patch：根因已被上游 764a032f6 修复，本单产出为判定帖

## 根因判定（已证）

报告者 2026-10-29 12:07 +08:00 四次 400，magpie 0.1.1990。Anthropic 把 thinking block 的 signature 绑定到「会话 + 当时的请求形状（tools list）」；Codex 会话中途 tools 变化（tool search 按需加载 / MCP server 变更）→ 重放历史的已签名 thinking block 前缀不匹配 → 400 "bound to a different conversation"。

时间线钉死：v0.1.1990 tag 指向 3959192e9（2026-10-29）；修复 commit 764a032f6（2026-10-30 13:14 +0800，ferock 的同文案单）不在 v0.1.1990 内，首个含它的编号发布是 **v0.1.2157**（tag 直接指向该 commit）。报告日期与修复落地差一天，四次 400 正落在缺口里。

## 覆盖链路（追完）

- `forward()`（gateway.go:5123）末尾 3 次重试环读 400：`refuseBoundThinking`（thinking_bound.go）命中 `boundRefusal` 正则（含 "Invalid `signature` in `thinking` block"/"bound to a different conversation"，与报告者文案逐句匹配）→ 记住被点名块及其后所有 thinking 块（per provider+account，`thinkingOwner`）→ `forwardOnce` 重发无这些块的请求。
- 预剥：`forwardOnce` 内 `withoutRefusedThinking`（下一 turn 直接不送）+ `withoutForeignThinking`（11-03 增，剥 DeepSeek UUID 形签名；Anthropic 自签块不走此路，走响应式 mend）。
- Codex→Anthropic 翻译路径走 `forwardTranslated`（gateway.go:6847）→ `s.forward`（gateway.go:7130），重试环覆盖。Claude seal 往返（claude_seal.go claudeseal）把 Anthropic 签名块经 Responses reasoning item encrypted_content 回传，签名原样到达翻译路径。
- 报告者两建议的取舍：beta `thinking-binding-controls-2026-08-01` 有意不发（764a032f6 commit message 明说：Claude Code 只在 flag 后发它，magpie 不模仿）；「tools 不匹配就剥」以响应式落地——拒绝消息点名位置（`messages.<m>.content.<b>`），不猜哪个 turn 分叉。

## 验证证据

- 定向：`go test -tags nogui -run 'TestBoundRefusalRead|TestBoundThinkingLeftOut|TestOtherRefusalKeepsThinking|TestWithoutThinkingBlocks|TestPluginBoundThinkingLeftOut' ./internal/gateway` ok（1.154s）。`boundClaude` fake 复现报告者同文案 400（含 drop_block 句）。
- gofmt 净（thinking_bound.go）；`go vet ./internal/gateway` 净；未改产品文件，无全量矩阵义务。
- 764a032f6..df7c94bdf diff 确认：机制仅增 `withoutForeignThinking` 预剥，boundRefusal 正则与重试环未变；fetch upstream 后 df7c94bdf 仍为 tip（无更新变更）。

## 未验证（帖内已声明）

- 本机无官方 key Anthropic 账号，未对真 API 复现 400；测试为 fake upstream 重放报告者文案。tools-list 绑定语义来自 Anthropic 自己的错误文本（报告者原文引用）。

## 产物

- post.md（判定帖正文，POST 用件）
- 无 patch、无 commit（零产品改动）
