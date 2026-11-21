# #3183 处理报告（hunt57-e-native-relay-collab）

日期：2026-10-21。worktree：`/tmp/magpie-h86`，base `f5b01574` = upstream/main。

## 结果

- **走了修复路，未放弃**。
- **head SHA**：`9fff5bab0f3a2e1da5ac71d00d98890183634921`（分支 `hunt57-e-native-relay-collab`，1 个提交，3 文件 +189/−4）。
- **patch**：`0001-gateway-a-relayed-Responses-reply-says-a-namespaced-.patch`，SHA-256 前 16 = `1b3f7c114dcf2c15`（英文帖内嵌 patch 与文件逐字节一致，已程序化比对）。
- **英文帖**：`issue-body.md`（五段 + 严格尾部，零中文，未发布）。
- 未 push、未发帖、主 clone 未动、无 stash、未动其他 /tmp/magpie-h*。

## 假设（三条全部证实）

1. **原生中继原样透传**：`Server.passthrough`（gateway.go:4179）响应侧只有 phase/id/int 等 tidy；唯一补 `encrypted_function_args` 的 `nsTidy`→`callTo` 只在 grok/zed 启用（base gateway.go:4385 的 `named` 计算条件）。通用 native Responses 供应商（如 UCloud DeepSeek）的 function_call 原样透传，无该字段——上游本就不回（报告者探针：200+namespace+明文参数+无字段）。该补：Codex `ToolCall::direct_source`（rust-v0.163.0 tools/router.rs）只认「字段显式存在且为空」→ DirectPlaintextMessage。
2. **先例形状是空数组**：翻译路径 `callTo`（responses.go:1711，#613）设 `[]any{}`，注释「Nothing magpie serves seals arguments. Codex reads a namespaced call without this list as sealed」。风险控制：中继只在**缺席**时补；上游真封印（字段存在，OpenAI 原生路径）则原样放行。报告者看到的「明文假密文」是 Codex 误分类后自封的 encrypted_content，不是 magpie 伪造密文。
3. **测试可确定性**：fake Responses 上游回 namespace+name 的 spawn_agent call → 断言中继输出带 `[]`，stream/非 stream 双形状 + 负例。

## 修法（最小，与先例同形状）

- `internal/gateway/gateway.go`：`named = namespacedIn(body)` 从 grok/zed 限定放宽到所有 Responses 中继（+注释 3 行）。
- `internal/gateway/grok_namespace.go`：`nsTidy.call` 新增 namespace-echoed 分支——(namespace,name) 命中请求工具且缺字段时补 `[]any{}`；flat-name 分支（grok/zed 改名回 namespace）原样保留。
- `internal/gateway/native_relay_collab_test.go`：新增 167 行两个测试。

环路闭合：Codex 下一轮把带 `[]` 的 call 回放进历史时，`forVendor`/`openaiOnly`（codex_backend.go:2422）恰好把它从发往非 OpenAI 上游的请求里剥掉——该字段永不落到第三方上游。

## RED（断言级，base exit=1）

```
--- FAIL: TestNativeRelayNamespacedCallSaysUnsealed (0.11s)
    native_relay_collab_test.go:122: stream true: Codex was given map[arguments: call_id:c9 id:fc_1 name:spawn_agent namespace:collaboration type:function_call]
FAIL
FAIL	github.com/yetone/magpie/internal/gateway	1.009s
```

全文 `red-native-relay.log`。

## 消融（备份 cp + git checkout，无 stash）

还原源改动 → 同断言红（exit=1）；恢复 → 绿；变异字段形状 `[]any{""}` → 红（非空列表 ≠ unsealed）；还原 → 绿，diff 精确回到 +22/−4 两文件。

## Watched 三查

- **(a)** RED/GREEN/消融如上。
- **(b)** `rg encrypted_function_args` 全部处理点：翻译 `callTo`（responses.go:1711，不改）、请求侧 `forVendor`（codex_backend.go:2422/2468/2472/2513，不改）、中继 `nsTidy.call`（本次新增）。其余 spawn_agent 命中（codex_spawn_models、claude_subscription:2811、agent/codex、provider/codex_subagent、sessions）均为 V1/models/展示机制，不碰该字段，无需改。
- **(c)** 负例：上游回已封印 call（字段非空存在）→ 原样透传封印不动；非 namespaced 的普通 call → 不补字段。`TestNativeRelayLeavesOtherCallsBe` 锁定。畸形类型字段：只查存在性（presence），存在即不动，与 base 行为一致。

## 矩阵

| 项 | 结果 |
|---|---|
| 定向（新 2 测 + #404/#613 namespace 家族） | 绿 |
| `go test ./internal/gateway -count=1` 全包 | ok 322.625s（后台 tee `/tmp/hunt57-gateway-full.txt`） |
| 定向 `-race` | 绿 |
| `gofmt -l internal/gateway/` | 空 |
| `go vet ./internal/gateway` | 净 |
| `CGO_ENABLED=0 go build -tags nogui` darwin/arm64、linux/amd64、windows/amd64 | 全过（仓库 Makefile 的 cross 姿势；`./cmd` 不存在，入口在根 `main.go`） |

## 边界与未验证

- 未对报告者真实供应商/真实 Codex Desktop 验证；stub 回复形状按其探针记录构造。
- issue 期望的第二半（上游不认识的明文 `agent_message` 输入项转任务正文，其手搓探针的 400 unknown type）**未做**：真实 V2 复现在分类处即失败，尚无 agent_message 上行；对全供应商中继改写会话属更大的独立决策（grok 有 `grokAgentMessage` 先例）。已如实写进英文帖 Not verified。

## 产物清单

`/Users/ggbdpq/cc/guahub/fork/magpie-hub/docs/issues/hunt57/3183-native-relay-collab/`
- `0001-gateway-a-relayed-Responses-reply-says-a-namespaced-.patch`（format-patch，SHA-256 前 16 `1b3f7c114dcf2c15`）
- `issue-body.md`（英文帖草稿，未发布）
- `red-native-relay.log`（RED 原文）
- `report.md`（本文件）
