# #3615 验证车道：机理逐环对照（skygunner 自述 vs 代码实测）

验证对象：skygunner/magpie `fix/3615-loop-guard-does-not-cover` @ `125a5e087ef882a6223dff6645589b0ee33cdbd6`
落点：3way am 到 upstream/main tip `e17b6cefc`（本机 darwin/arm64，worktree /private/tmp/mg123-g，am 后 head `59a84c4e4`）
日期：2026-11-04

## 逐环对照

| # | 自述要点 | 代码证据 | 实测结论 |
|---|---|---|---|
| 1 | gap：exchanges/exchangeOf 在无 tool result 的 turn 停、mayLoop 只解析含 8 个 tool results 的 body | tip 原版 `toolLoopOf` 走 `exchanges()`（turn 无 result 即断）；`mayLoop` 原版只数 `toolResultMarks` | 对照成立（tip 原版代码可复读，消融红 8/8 佐证 gap 真实） |
| 2 | 1088 次形状 = 每回复一个 ~150-token 同名同参 tool call 无 result | 测试 fixture `answerlessTurns`：每 turn 单个 tool call、无 result、call id 递增 | 形状与 issue 数据一致（fixture 注释直接引用 issue 数字） |
| 3 | toolLoopUnansweredOf 从最新往回数：无 result 的同名同参连续 calls，call id 不计 | `toolLoopUnansweredOf`：倒序 walk；key = `Name + "\x00" + steadyArgs(Args)`（steadyArgs 归一化 key 序）；key 不含 ID | 成立；探针证实不同 id 同名同参仍判 loop |
| 4 | 8 连发答本 turn（notice 只说 result 没回来，不声称没跑） | `toolLoop.why()/notice()` 的 `unanswered` 分支："no result came back" / "never sent back a result ... nothing says whether the call ran" | 成立，文案不越界 |
| 5 | turn 不再出去；Routing/usage 走既有 Tool loop stopped 拒绝形态 | 复用 `answeredHere` 路径（与 result-shaped 同一出口）；测试断言 usage record `Provider=="magpie" && Rejected && Error 含 "tool loop"+"no result"` | 成立 |
| 6 | 重置条件：不同 call / 别的回复 / 有 result / 用户话 | 不同 call：`k != key → break walk`；有文字回复：`saidOn → break`；result/用户话：非 assistant 消息带 parts → `break`；reasoning 夹层：`continue` 不重置 | 成立（探针复核）；**result 重置无专门测试用例**，由代码路径+探针钉住 |
| 7 | 无新设置无新字符串 | 无 settings/GUI/i18n 改动；notice 是 agent 协议内文本（新增但非 GUI 字符串）；关闭走既有 Stop looping replies（noLoopGuard） | 成立 |
| 8 | mayLoop 同时认 8 个 tool calls（toolCallMarks，宽松匹配：mark 撞 result 只是多解析一次） | `mayLoop` 计数 `toolResultMarks + toolCallMarks`，`n >= toolLoopRepeats` 即读 body | 成立；marks 间无子串互撞（`"tool_use"` vs `"tool_result"`、`"functionCall"` vs `"functionResponse"` 等） |
| 9 | 八协议形态测试修前全红修后绿、vendor 0 次 | `TestToolLoopStuckWithoutResults` 8 子项（Responses 流式+整/Codex/Chat 流式+整/Anthropic 流式+整/Gemini） | 实测 am 到 tip 后 8/8 PASS，vendor asked 总计 1 次（7-turn 预检那 1 次，8-turn 停止请求 0 次） |
| 10 | TestToolLoopStuckNeedsTheSameCallAndNoWord 保持 | 不同 args 8 turns 通过 + 用户话夹层通过（Anthropic stream） | PASS（仅 Anthropic stream 一种协议覆盖重置边界，重置逻辑本身协议无关纯函数） |

## 与 tip 新增 wait 豁免的融合点（am 冲突，如实记录）

tip 在 skygunner 基线之后新增 `allWaits/isWait/waitWords/durationKeys`（"A turn whose calls are all waits is never a loop"，接在 result-shaped 的 `toolLoopOf`）。am 冲突为同位置并列新增，解法：两块并存，不动 skygunner 修法语义。

观察点：`toolLoopUnansweredOf` **没有** wait 豁免——`clock__sleep {"duration_ms":60000}` 连发 8 次且 result 从不回传会被停。语义上 wait 豁免的前提是"answered the same by design"（answer 发生过），unanswered 场景下 answer 未发生，二者不直接矛盾；且正常客户端必回传 wait 的 result（回传即重置）。探针已记录该边界行为，是否给 unanswered 形态加 wait 豁免留给维护者定夺，不构成阻断。

## 边界核验（探针 + 测试钉住情况）

| 边界 | 钉住方式 | 结果 |
|---|---|---|
| 7 turns（阈值下）通过 | 测试：`toolLoopRepeats-1` 全协议 + 探针 | PASS |
| 8 turns 停止 | 测试：全协议 8 子项 + 探针 | PASS |
| 不同 args 重置 | 测试：NeedsTheSameCallAndNoWord + 探针 | PASS |
| 不同 NAME 重置 | 探针（测试的 differing-args 与 name 等价键） | PASS |
| 用户话重置 | 测试：Anthropic stream "go on" 夹层 | PASS |
| result 重置 | 探针（无专门测试用例，如实标注） | PASS |
| call id 不计 | 探针（测试 fixture 的 id 本就递增，判定仍触发） | PASS |
| reasoning 夹层不重置 | 探针 | PASS |
| 误伤面：重试/轮询语义工具 | result 正常回传即重置；参数随时间变即不同 key；wait 类 result-shaped 已有 allWaits 豁免；仅"参数全同且 result 从不回传"才计数，8 次宽限 | 误伤面窄，边界合理 |

## 消融回红（ablate worktree：tool_loop.go 回退到 tip 原版，保留测试）

`TestToolLoopStuckWithoutResults`：exit=1，8/8 子测试 FAIL，失败模式全部为预期文案 `the agent wasn't told of the loop in its API`（vendor 回复直达 agent）。证据：ablation-red.log。

## 矩阵

- gofmt：`gofmt -l` 直跑 + `tr -d '\r'` 法，tool_loop.go / tool_loop_test.go 均无输出（净）。
- `go vet ./internal/gateway/`：exit=0 净；`GOOS=windows go vet ./internal/gateway/`：exit=0 净。
- `go build -tags nogui ./...`：通过（仅预存 dockflap/trayimage cgo warning，与清单一致）。
- `go test -tags nogui -timeout 25m -count=1 ./internal/gateway/...`：**exit=0，0 FAIL，706.038s**（-count=1 禁缓存）。skygunner 自述的 5 个基座红（TestClaudeClientCacheAbsentUnchanged / TestCodexFittedImagesPastTheBudget / TestMarshalRawIsEncodingJSON / FuzzMarshalRaw \u2028 / TestServeWSLListensBesideLoopback）在本机本次 tip+补丁上**未复现**（其声明基于 2026-10-28 的 tip；本验证 2026-11-04，其间 tip 有演进），如实记录。
- 边界探针（白盒、跑后即删）：TestProbeUnansweredResets / TestProbeWaitExemptionShape 全 PASS（probe_test.go 与 probe-out.log 存 /tmp/mg123-g6-tmp/）。
