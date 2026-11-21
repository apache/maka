# hunt47-a / yetone/magpie#2974 — 翻译路径上非 rs_ id 的流式 reasoning 被客户端收到两次

日期：2026-10-19（本地 macOS，worktree `/tmp/magpie-h9`，分支 `hunt47-a-reasoning-dup`，基线 upstream/main `ef655acb40b2b2b5484e8eab41c79ff8b41bb6d3`）

## 结论

已修复并单提交交付。commit `05b78de07b3be257ee0547a3185c16820826066c`（作者 ggbdpq <ggbdpq@gmail.com>），patch sha256 前 16 位 `b7174fc8d5b50791`。未推送、未发评论。

## 根因（与 issue 一致，已实测确认）

翻译后的 Responses→Responses 路径上，上游 reasoning item 的 id 不以 `rs_` 开头且带 summary 流式输出时：

1. 编码器 `KThinkStart` 只对 `rs_` 前缀的 id 记 `thinkID`，其余情况 `openItem` 自造 `rs_<newID()>`；
2. `output_item.done` 带 `encrypted_content` 时解码器发 `KSealed`（上游自己的 id），编码器 `ev.ID == e.itemID` 不成立 → 先把流式 item 以自造 id 关掉（不带 sealed），再把 sealed item added/done 整个又发一遍 → 客户端看到 3 个 reasoning item。

整包（非流式/collector）路径无此问题：`ir.go:563` 的 KSealed 按" openness"合并进流式 thinking，从不看 id。

## 修法（按维护者在 issue 里给的方向）

- 解码器 `responsesDecoder`：新增 `addedID map[int]string`，按 `output_index` 记住每个 reasoning item added 时的 id；sealed done 时用该 id（非空时）替换 done 的 item id —— 覆盖 Copilot 这类"每个事件换 id"的上游。
- 编码器 `responsesEncoder`：新增 `thinkUp`，记住 `KThinkStart` 携带的 id（无论形状；`thinkID` 仍只收 `rs_`，流式 item 的 added id 行为不变）；`KSealed` 匹配条件加上 `ev.ID == e.thinkUp` → `closeAs(raw)` 用 sealed 收掉流式 item；`thinkUp` 随 `closeAs` 清空。
- 测试 `TestResponsesStreamForeignReasoningIDNotDoubled`（`reasoning_state_responses_test.go:201`）：维护者探针转正式用例，`cpStream` 把 `responsesSealedStream` 的 id 换成 `Cp…`，两个子表（稳定 id / 每事件轮换 id），断言客户端可见流：added/done 各恰好 2 个 reasoning item + `response.completed` 里 2 个。

## RED / GREEN

- RED（基线 `ef655acb`，提交前测试先行）：两个子表都挂，重复项直接在输出里：
  `added reasoning ids [rs_18dff988b7dd1e6800000001 Cp6820f38x Cp6820f3bx], want … Cp6820f3bx`（3 个，正是 issue 里的探针结果）。
- GREEN：修复后新用例 ok 1.0s；`-run 'TestReasoning|TestResponses|TestSealed|TestTranslate'` ok 9.0s。

## 消融

把 `internal/gateway/responses.go` 从 `git show upstream/main:...` 还原（测试保留）→ 两个子表 RED（重复项重现）；恢复修复 → GREEN。唯一被触达的产品文件，已备份于 `/tmp/h9-keep/internal/gateway/responses.go`。

## 变异

- (a) 去掉 `thinkUp` 的记忆（赋值+匹配条件一起拿掉）→ 两个子表 RED；
- (b) 去掉解码器按 `output_index` 改写 id → 仅 `ids that change per event` RED，`stable ids` PASS（证明 output_index 匹配只对轮换 id 承重）。
两者均已恢复。

## 验证矩阵（darwin/arm64，全部实测）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 全包 | `go test -tags nogui -count=1 ./internal/gateway/` | ok 356.0s，exit 0 |
| 定向族 | `-run 'TestReasoning|TestResponses|TestSealed|TestTranslate'` | ok 9.0s |
| -race 定向 | 同上 + `-race` | ok 11.1s |
| gofmt | `gofmt -l internal/gateway/` | 空 |
| vet | darwin / `GOOS=linux` / `GOOS=windows`，均 `-tags nogui` | 全净 |
| 构建 | darwin `./...`、linux `./...`、`GOOS=windows go build -o /dev/null .` | 全过（darwin 的 cgo 警告来自未触达的 `internal/gui/trayimage_darwin.go`，预存） |

## 交付物

- `0001-gateway-a-streamed-reasoning-summary-the-upstream-se.patch`（format-patch，git am 可用）
- `2974-comment.body.md`（英文成帖，已 grep 验证零中文字符；含分支行、RED 证据、验证表、Siblings、Not verified、AI/Attribution 尾注、完整 patch）
- 本文件。

## 不确定项 / 未验证

1. 没有真实上游同时满足"非 rs_ id + 非 空 summary"：OpenAI/Codex 是 `rs_`；按 issue 里维护者 2026-10-19 的抓包，Copilot `/responses`（id 轮换）目前 `summary: []`，线上影响仍是条件性的。只对 issue 描述的两种 id 形状的 fixture 验证，未对真实上游验证。
2. 修复后（issue 方案本身的含义）流式 item 的 added 用编码器自造 `rs_` id、done 用上游 sealed item 的 id —— 与轮换 id 上游自身线上行为一致，Codex 读 `output_item.done` 取整 item；除用例的事件级断言外未对真实客户端验证。
3. 维护者提到的 relayed 路径 `idTidy` 在本树（`ef655acb`）不存在（应在其修复 echo_ts 的在途改动里）；本单只动翻译路径，relayed 路径原样透传无需改。
4. sealed-only（无 summary）item 在轮换 id 上游下 add-whole 的 added/done 都用 done 的 raw（上游 added id 不同于它）—— 预存行为，与本重复 bug 无关，未动。
