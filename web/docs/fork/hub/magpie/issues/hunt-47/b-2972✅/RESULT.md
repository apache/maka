# hunt47-b：#2972 Chat length 截断 + 纯 reasoning 空转

- 仓库/worktree：`/tmp/magpie-h10`，分支 `hunt47-b-length-reasoning`，基线 upstream/main `ef655acb40b2b2b5484e8eab41c79ff8b41bb6d3`
- 提交：`4985b38f9785e7243573cfb1cc37ce0442920736`（单提交，作者 ggbdpq <ggbdpq@gmail.com>）
- patch：`0001-gateway-a-length-cut-that-said-nothing-is-not-a-comp.patch`，sha256 前 16 位 `d70109904f49b218`
- 未推送、未发评论（按任务约束）

## 结论

Chat 上游以 `finish_reason:"length"` 结束、零正文零工具调用（只有 thinking 或全空）的回复，此前被两道闸门放过、当作成功交给 agent；现在走既有 emptyReply 路径（原地重问 → 客户端协议内错误 → 组 failover，不 rest 账号）。谓词（平述）：

> `finish_reason == "length"` 且 无任何正文/工具调用（只有 thinking 或全空） 且 上游协议为 Chat 且 非 magpie 自写的 title/description/prediction 侧调用。

刻意不动：`length` 且有正文/调用（正常截断，行为不变）；Gemini/CodeAssist 的 MAX_TOKENS+纯 thinking（#667 立场，有测试钉住）；标题截断回 `response.incomplete`（#1466）。

## main 上核实 reporter 指认的两道闸门（均已证实）

1. `emptyFails(proto)`（gateway.go）只对 `CodeAssist`/`Gemini` 返回 true——Chat 上游根本不进空回复检查；
2. `answersNothing(stop)` 显式排除 `length`/`filter`——注释写明 "not cut at its length (all reasoning)"。

合并效果：`(empty || repliesCounted && uncounted)` 对 Chat 两项皆 false，加上 `answersNothing("length")`=false，void 畅通。

## 改动面（4 文件，+145/−6）

- `internal/gateway/gateway.go`：新增 `cutVoidAt`/`cutVoid`（紧挨 `answersNothing`）；`translate` 整回复闸门加第二个析取支。
- `internal/gateway/continuation.go`：`streamTranslated` 流式闸门加同一析取支；Chat 协议在"还没说话"时扣留 KStop/KUsage（与 Gemini 既有机制同构），重问时丢弃保留事件，重试有话时按序补发——保证 agent 不会先收到 `finish_reason` 再收到错误。
- `internal/gateway/upstream_test.go`：`TestClinePassUpstreamRecorded` 更新（见下）。
- `internal/gateway/chat_length_nothing_test.go`：新增两个测试（void 红→绿；有正文截断护栏恒绿）。

## 过程中发现的标本（重要）

`internal/gateway/testdata/clinepass_stream.sse`——仓库自带的真实录像**本身就是 #2972 同构 void**：`finish_reason:"length"`、`completion_tokens:16` 与 `reasoning_tokens:16` 精确相等、零正文零工具调用（DeepSeek/Cline 链路，reporter 之外的独立证据）。该测试原先把这个 void 钉成成功；已按新行为更新 Messages 客户端侧断言（重问后以 `an empty reply` 收场，ClinePass 元数据断言全保留），Chat 客户端侧（relay）断言原样不动。

## RED/GREEN（TDD）

- RED（upstream/main 代码 + 新测试）：流式 Responses 客户端收到 `response.incomplete`（只有 reasoning 输出块）、Messages 客户端收到 200+`stop_reason:"max_tokens"`+thinking 块、无流 200——全部是"成功"。
- GREEN（修复后）：流式被原地重问（calls≥2）后以流内 `an empty reply` 收场、无 `finish_reason`/`response.incomplete`/`max_tokens`；无流 502+emptyReply。
- 护栏 `TestChatLengthWithTextIsTruncation`（length+有正文）：修前修后均绿，200+正文+截断标记+仅 1 次调用。

## 消融

- 拷贝 `gateway.go`/`continuation.go` 至 `/tmp/h10-keep/`，用 `git show upstream/main:<path>` 还原两文件 → `TestChatLengthNothingSaidIsAnError` FAIL；恢复修复文件 → PASS。

## 变异

- (a) `cutVoid` 恒 false（检测死、代码在）→ void 测试 FAIL；恢复 → PASS。
- (b) 谓词忽略 saidNothing（过宽，打中有正文 length）→ **现有** `TestTooFewTokensSaidWithSigns`（limit_test）与护栏 `TestChatLengthWithTextIsTruncation` 一起 FAIL（重试 3 次、502 emptyReply）；恢复 → 全 PASS。证明检测既不死也不过宽。

## 矩阵

| 项 | 命令/方式 | 结果 |
|---|---|---|
| 定向族 | empty-reply/titles/limits/overflow/thinking/chat_length | 全绿 |
| 全 gateway 包 | `go test ./internal/gateway/... -count=1`（后台落盘 /tmp/h10-full-gateway-2.log） | `ok ... 320.046s`，0 FAIL，exit=0（首跑唯一 FAIL 为 TestClinePassUpstreamRecorded，定性为钉住旧行为，更新后复跑全绿） |
| -race | 定向（新测试+ClinePass+titles+limit+overflow） | PASS |
| gofmt | `gofmt -l internal/gateway/` | 空 |
| vet | darwin/linux/windows | 全过 |
| 构建 | darwin/windows 全仓 + 根二进制 | OK（darwin 仅预存 ld 警告） |
| 构建 linux | `internal/gateway` 单独 | OK；根二进制被 wails v3 beta.24 自身 linux 文件（`undefined: pointer`，经 internal/gui 引入）阻断——预存环境问题，与本 diff 无关（diff 只触 internal/gateway） |

## 边界与未决（诚实清单）

1. **relay/passthrough 旁路未修**：流式 Chat 客户端 + Chat 上游按设计逐字节透传，void 检测不经过该路径。reporter 的 dsh 是 `openai-completions`；若其流式发起请求，则大概率走的就是 relay——本修复关不掉那条路上的空转。在 passthrough 内做语义拦截意味着把 hold/retry 机制重造一遍，超出单 issue 最小改动，已在评论里明说。修复覆盖的是 translate 路径（非流式 Chat 客户端、Messages/Responses 客户端——正是两道闸门所在）。
2. 无真实 qoder 账号：假上游按 reporter 表格暗示的线协议（`reasoning_content` delta + `finish_reason:"length"`）搭建。
3. 48,000 硬上限是 reporter 对自家 usage.jsonl 的解读，未对上游核实；本修复不依赖该数值。
4. 侧调用豁免复用 `titleCheckKey`（title/description/prediction 三个包装都会设置）；未包装的原始侧调用（如 Codex 自带标题请求直通）不豁免，void 会触发并让客户端重问——与 #1466 的精神一致但形态不同，评论已注明。

## 产物

- `RESULT.md`（本文件）
- `2972-comment.body.md`（英文 post-ready，含完整 format-patch）
- `0001-gateway-a-length-cut-that-said-nothing-is-not-a-comp.patch`
