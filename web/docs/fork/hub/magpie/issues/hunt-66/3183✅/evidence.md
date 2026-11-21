# #3183 验证证据（Lane E，hunt66）

对象 commit：skygunner b1ae66c779355c897eed2337f83666447ae8db2a。我方原 patch：9fff5bab（hunt57-e-native-relay-collab，响应侧 only）。

## 1. attribution 实查

- Author: vincent <webmaster@palmit.com.au>
- trailer 逐字摘录：`Co-authored-by: ggbdpq <ggbdpq@gmail.com>`（命中）
- message 声明：`Adapt ggbdpq/magpie 9fff5bab0f3a2e1da5ac71d00d98890183634921 for third-party Responses replies...`

## 2. 保真对比（响应侧）+ 「另半」定性

- **grok_namespace.go nsTidy.call**：与我方 9fff5bab 的 hunk 逐字同一（含注释）。
- **测试文件**：`diff <(git show 9fff5bab:...test.go) <(git show b1ae66c7:...test.go)` = `167a168,233`——前 167 行与我方逐字同一，追加 66 行 = 两个新测试（TestNativeRelayPlainAgentMessage、TestNativeRelayOpenAICallUnchanged）。b1ae66c7 内该文件为 create mode（其父基点无我方提交，自包含）。
- **gateway.go 门（行为分叉）**：我方 = `if proto == provider.Responses { named = namespacedIn(body) }`（所有中继无差别）；对方 = `if proto == provider.Responses && (p.Account == nil || p.Account.Agent != "codex") && !strings.HasSuffix(p.Host(), "openai.com")`（排除 codex 账号与 openai.com 主机，"preserving native OpenAI/ChatGPT behavior"）。对方新增 TestNativeRelayOpenAICallUnchanged 锁定该分叉（OpenAI 原生调用不加 marker——该测试在我方形态下会红）。
- **请求侧「另半」**（我方 patch 明示不碰、对方补上）：
  1. `openaiOnly` 表追加 `"agent_message"` 探针；
  2. `forVendor` 输入项循环内：`agent_message` 项经 `provider.PlainAgentMessage` 转 user message（保留 sender/recipient/text/images，sealed/unsupported 保持 opaque）；
  3. `grokAgentMessage` 导出改名 `PlainAgentMessage`（grok.go 定义+调用点），复用既有 Grok 转换器而非新写。
- **请求侧独立测试**：有。TestNativeRelayPlainAgentMessage（转换+OpenAI 路不变+sealed/unsupported opaque 三组负例）。

## 3. 漂移与落地

- b1ae66c7^ = 3833e3f3，merge-base = 63be4771，`63be4771..3833e3f3` = 467。
- cherry-pick 到 tip：三处冲突。
  1. docs：对方侧混入其基线的 #3205 Kimi 段（tip 无该特性，实测 tip 0 命中）→ 只保留 #3183 段。
  2. codex_backend.go：对方基线的 `forVendorChanges`（topMember/anyInputItem helper，tip 无此函数）与 tip 的 `userMessage` 错位对齐 → 保留 tip userMessage、丢弃 forVendorChanges；其职责在 tip 由 openaiOnly 探针（自动合并已加 agent_message）+ forVendor 自身覆盖；forVendor 主体改动与 openaiOnly 追加自动合并到位（codex_backend.go:1881、1935）。
  3. provider/grok.go：对方基线有 grokPluginBody/grokShaped 拆分（#3110，tip 无）→ 保 tip 单函数结构，只取注释改名；rename 两处（调用点 :298、定义 :322/329）自动合并。
- 本地 commit 7ffab9bf，+282/−11（原 +284/−12，差值=有意丢弃的 forVendorChanges hunk 与 Kimi 段）。

## 4. GREEN

- gateway 定向 8 测试（4 新 + TestGrokPluginGetsAgentMessageAsUser/TestGrokPluginGetsNamespacedTools/TestCodexOpenAIFieldsStayWithOpenAI/TestGrokPluginCallsGiveCodexIntegers）：`ok ... 4.863s` exit=0
- provider 定向 7 测试（TestGrokBodyAgentMessageGoesAsUser/TestGrokBodyLeavesSealedAgentMessage/TestGrokBodyFlattensNamespacedCalls 等）：`ok ... 0.883s` exit=0
- 4 新测试 `-race -tags nogui -count=3`：`ok ... 6.712s` exit=0

## 5. 消融回红（摘 gateway.go/grok_namespace.go/codex_backend.go/provider/grok.go 回 HEAD^，留测试）

命令：`go test -tags nogui -count=1 -run '^(4 新测试)$' ./internal/gateway/`

RED 原文（ablation-red.log）：

```
--- FAIL: TestNativeRelayNamespacedCallSaysUnsealed (0.57s)
--- FAIL: TestNativeRelayPlainAgentMessage (0.21s)
    native_relay_collab_test.go:122: stream true: Codex was given map[arguments: call_id:c9 id:fc_1 name:spawn_agent namespace:collaboration type:function_call]
    native_relay_collab_test.go:191: task wasn't converted: {"input":[{"author":"/root",...,"type":"agent_message"}],...}
FAIL  exit=1
```

- 响应侧 RED 与我方原帖的 RED 断言逐字同行（:122）。
- 请求侧 RED 锁定「另半」（task wasn't converted）。
- 另两个测试（LeavesOtherCallsBe/OpenAICallUnchanged）在旧代码上保护性通过（符合预期，非 RED 证据）。
- 恢复后同命令：`ok ... 1.983s` exit=0。

## 6. 兄弟面

`rg encrypted_function_args`（非测试）：callTo（responses.go:1541，#613 翻译路径）、forVendor strip（codex_backend.go:1932）、中继补写（grok_namespace.go:180-181）、openaiOnly 表——四处与帖内 Siblings 宣称一致，无第五处读写点。gateway.go 两门（#3183 named :4121、#3152 intTidy :4426）共存正常。

## 7. 质量门与未跑

- gofmt -l 五文件 → 空；`go vet -tags nogui ./internal/gateway/ ./internal/provider/` → 净。
- 未跑：真实 Codex V2 会话/第三方 vendor（双方都未跑）；gateway 全量（协议定向）。
