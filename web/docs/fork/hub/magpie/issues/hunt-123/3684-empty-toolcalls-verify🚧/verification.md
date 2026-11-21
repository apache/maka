# #3684 验证车道记录（skygunner 分支核验）

日期：2026-11-04 / 本机 darwin/arm64 / 判定：**FAIL（转判定帖）**

## 对象

- issue：yetone/magpie #3684（phantom tool_calls finish，11 例中 6 例为叙述+幻影 finish 子形状）
- 竞速者分支：skygunner/magpie `fix/r25-empty-tool-calls-finish`，head `91625dca0bb33ee696be639e659bdf4c8f1b6abd`，自述基点 `19253f67bca2310c32739a6eaac88546b3574dbc`
- 当前 upstream/main：`e17b6cefc7b25c19d1e522f9e8a9626bf68912d9`
- 我的 take：#3684#issuecomment-6621466422

## 逐环核对其自述五点（读 91625dca 全 diff）

| # | 自述点 | diff 落点 | 核验 |
| - | ------ | --------- | ---- |
| 1 | 无 calls 的 choice 结 stop（流式+整响应） | chattidy.go chatTidy.line 新增 `finish==tool_calls && !called → stop`；chatWhole.flush 新增 `known && len(native)==0 → stop` | 成立，消融回红证明 |
| 2 | 流式态 per choice | 用既有 `t.called[choice]` map；TestChatPhantomFinishPerChoice 钉住同帧双 choice 反序 | 成立 |
| 3 | 原生 calls 保持 tool_calls | chatWhole 升级条件改为 `known && len>0`；流式靠 called=true 走原逻辑 | 成立，native 子测试钉住 |
| 4 | text 解析 calls（textCallTidy 在 chatTidy 后）仍 tool_calls | chatTidy 先降 stop → textCallTidy 解析 `<tool_call>` 后无条件 `finish_reason="tool_calls"` 升回（textcalls.go:811 附近）；whole 侧 wholeTextCalls 在 chatWhole 降级段之前写 calls | 成立，text_parsed stream+whole 子测试钉住 |
| 5 | 不可读 tool_calls 值按 unknown 原样 | chatWhole：`known := !has \|\| decodeJSON==nil`，known=false 不降不升 | 代码成立；**无直接测试**（无 decode 失败 fixture），帖中标 Not verified |

附加改动：流式空数组 delete 从 `string(calls)=="[]"` 扩为 `decodeJSON==nil && len(native)==0`（null/`[ ]` 也在交付前剔除、不置 called）——防止空数组记成调用（自述里的另一半）。

## 3way am 到当前 tip（冲突与调和）

`git am -3` 到 e17b6cefc：chattidy.go 流式 finish 段与 docs 两文件冲突（空数组扩展与 chatWhole 段自动合并成功，落位正确：chatWhole 降级段在 wholeTextCalls 之后、#1475 dropped 段之前）。

**基点漂移根因**：基点 19253f67b（10-26）之后上游合入 #1475（`82ff88933`，10-31）——nameless call 丢弃 + `called` 收窄到 `named`（t.named），finish 处理改为 switch。skygunner 基点上无这些。

我的调和（临时树 /tmp/mg123-e4-tmp/amtree，commit cd909fa97，不推送）：

1. chattidy.go 流式段：保留 tip 的 #1475 switch，追加其降级为 `else if`（`!t.called[choice]` 且 finish=tool_calls → stop）
2. docs finish bullet：其 #3684 句子融进 tip 重写后的行（相邻新增了 #1475 bullet）
3. docs nameless bullet 的 "(a reply that came with no calls keeps its finish)"（#1475 引入的表述）与新行为矛盾 → 改为 "as does a phantom one over a reply that came with no calls at all (#3684)"

## 测试证据

定向（合并树）：
- TestChatPhantomToolFinish：16 子场景（absent/`[]`/null/`[ ]` × 有无 tools × stream/whole）全 PASS
- TestChatPhantomFinishKeepsRealCalls：native/text_parsed × stream/whole 全 PASS
- TestChatPhantomFinishPerChoice PASS；TestChatCallsEndToolCalls PASS（升级回归）
- 兄弟面：TestNameless*、TestTextWritten*、TestChatTidy*、TestEmptyCallID*、TestStreamedCall* 全 PASS，唯一红 TestToolCallsFinishWithNoCallsStaysWhole

消融回红（chattidy.go 回退到 tip 原版、保留新测试）：
- TestChatPhantomToolFinish：8 个 stream 场景全 FAIL（finish "tool_calls" want stop）→ 修前会挂，RED 证明
- TestChatPhantomFinishPerChoice FAIL；KeepsRealCalls PASS；TestToolCallsFinishWithNoCallsStaysWhole PASS（红非预存）

全量 `go test -tags nogui -timeout 25m ./internal/gateway/...`（685s）：
- 唯一 FAIL：TestToolCallsFinishWithNoCallsStaysWhole（chat_call_name_test.go:202，finish "stop" want "tool_calls"，fixture content="Done." 无 calls）
- 任务预存红清单项（TestCodexPoolSaysTheClientsVersion/TestMothX/TestEveryRouteHasACommandOrIsNamed/TestProxyCheckSaysAProxyPassedBy/TestHostToldTheGatewayAddress/TestPluginCheckinAsksAgainAtUntil）本次全量均未红（清单可能对应旧基线）；dockflap cgo warning 仅在 build 出现

矩阵：gofmt（触面文件）clean；`go vet -tags nogui ./internal/gateway/` 0；build -tags nogui 0。

鲜度：upstream/main 无 3684 commit；skygunner 分支 head 未 force-push（仍 91625dca0）；issue 评论仍 2 条。

## FAIL 判定理由

TestToolCallsFinishWithNoCallsStaysWhole（#1475，82ff88933，10-31）钉住"无 calls 的 reply 保持其 finish"旧行为；#3684 要求改为 stop。其分支基点（10-26）早于 #1475 五天，其全量跑看不到该测试。修法方向与 #3684 一致、机理五环全过、RED→GREEN 成立，但 am 到当前 tip 必红既有测试——验证车道不替作者改上游既有测试预期，转判定：作者需 rebase 到 ≥82ff88933 并显式处理该测试（按 #3684 更新预期为 stop，或由维护者裁决 #1475 保守边界是否豁免 content-only reply）。

## Not verified

- 不可读 tool_calls 值（decode 失败）原样：代码逻辑在，无直接 fixture 测试
- 真 opencode-zen-free 上游请求（与作者同，未打真实网络）
- 空数组 decode 扩展对流式 `null` 的 delta 输出形状：消融/定向未单独断言（合并后 null 场景经 else-if 与 #1475 两条路殊途同归 stop）

## 文件

- /tmp/mg123-e4-tmp/：91625dca-full.diff、targeted.log、sibling.log、ablation.log、full-gateway.log、chattidy-base.go / chattidy-tip.go（基点/ tip 对照）
- /tmp/mg123-e4-tmp/amtree：合并验证树（cd909fa97，临时，不推送）
