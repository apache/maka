# #2955 compact-developer R2 rebase 报告（hunt54，2026-10-20）

## 产物

- 工作树：`/tmp/magpie-h51`，分支 `hunt54-r1-compact-developer`，基 `c922225f`（=upstream/main）。
- 新 head SHA（完整）：`f8d8ae631bb7eb0a29c6ff6f6b83010b06e45198`（cherry-pick 6f8e2ea3 所得，commit message 与原版逐字一致，含 `Generated-by: GLM-5.3-Flash (ZCode)` 尾注，未追加未修改）。
- patch：`/Users/ggbdpq/cc/guahub/fork/magpie-hub/docs/issues/hunt54/2955-compact-developer-r2/2955-compact-developer-r2.patch`
- sha256 前 16：`d432e41caa5a0c68`
- 英文回帖草稿：同目录 `comment.md`（零中文已验证，模型名只在 patch 内 Generated-by，围栏 4 个 ```成对）。
- 全包日志：同目录 `gateway-full.log`（tee 落盘）。
- 未推送、未发帖、未动主 clone、未动其他 /tmp/magpie-h* 目录。

## 上游是否语义性覆盖（假设 ①②③）

- **① summary ask 仍走 forVendor：是。** `694674cf` 只把 magpie1: 项的读取（`codexInputAs` 历史回放）与写入（`codexCompact` 的 `encrypted_content`）移进 `internal/codexsummary`；`codexCompact` 构造 summary ask 后仍经 `s.serve(rec, r, provider.Responses, b)` → passthrough → `forVendor`（`gateway.go:4187`）中继。`4896fc3b` 完全不碰 internal/gateway。
- **② developer→system 需求不消失：不变。** ported rollout 改的是 magpie 退出后的 rollout 文件与回放时 compaction item→user message 的替换；summary ask 本身仍携带对话里的 developer 消息（`codexInputAs` 只动 compaction/compaction_trigger 项）。RED 实证：`c922225f` 裸基上测试仍以记者的 400 失败。
- **③ 落点：与 hunt53 相同**（forVendor 第三参 + developerItemsAsSystem 在 openaiOnly/forVendorChanges 早退门之前 + askCompaction ctx 标记）。`git log --grep '#2955' upstream/main` 仍为空。

## 冲突解法

唯一冲突：`internal/gateway/codex_backend.go` 的 `userMessage` 区。上游 `694674cf` 把 `userMessage` 改成一行委托 `codexsummary.UserMessage`，而 patch 在旧多行版前插入 `developerItemsAsSystem`。解法：保留上游一行版（不重写上游重构），patch 新函数放它前面。其余五文件（codex_compact_guard.go、gateway.go、codex_compact_developer_test.go、codex_openai_fields_test.go、codex_rewrite_scan_test.go）自动合并。

## RED / GREEN 原文

RED（base `c922225f` 裸基 + 上轮测试文件，exit=1，`/tmp/magpie-h51/red-r2.log`）：

```
--- FAIL: TestCodexCompactDeveloperAsSystemOnAVendorRelay (0.21s)
    codex_compact_developer_test.go:43: 400 {"error":{"code":"invalid_parameter_error","message":"Fake: developer is not one of ['system', 'assistant', 'user', 'tool', 'function']","param":null,"type":"invalid_request_error"}}
        upstream got {"input":[{"content":[{"text":"You are Codex, a coding agent.","type":"input_text"}],"role":"developer","type":"message"},...
```

GREEN（patched，exit=0）：

```
--- PASS: TestCodexCompactDeveloperAsSystemOnAVendorRelay (0.10s)
--- PASS: TestVendorRelayTurnKeepsItsDeveloperMessage (0.01s)
ok  	github.com/yetone/magpie/internal/gateway	1.030s
```

## 消融（行为短路法）

- 短路接线 `if false && compaction`（forVendor 内）：compaction 测试 FAIL 同一 400，turn 测试 PASS（flag 精确圈定 summary ask）；还原后复绿 ok。
- 附加变异：vendor 判定取反 `!(…)`（openai/codex 早退门）：FAIL 同一 400；还原复绿 ok。

## Watched 三查

- (a) vendor 判定打破：见上变异，回红后还原复绿。
- (b) 兄弟面（rg 'developer' gateway+codexsummary 生产码 / rg 'forVendor\('）：`parseResponses`（responses.go:354,361，翻译路，不改）；`developerAsSystem`（gateway.go:6305，调用 4226，Chat→Chat，不改）；`ZedBody`（provider/zed_body.go:36，不改）；`codexInput`/`chatgpt_api.go` 反向换角色（codex_request.go:293,436、chatgpt_api.go:611，ChatGPT 后端拒 system，这正是排除 OpenAI/codex 账号的原因，不改）；cached-search `additional_tools` 项以 developer 角色搭 turn（codex_request.go:556，#350 家族 turn 形状，不改）；`message_tools.go:66`、`format.go:270` 只读不写（不改）；prompt.go/ollama_chat.go/chat.go/claude_subscription.go 均为 system+developer 成对读取（不改）；**新包 codexsummary 零 developer 写入**（只造 user 消息），无迁移对象。`forVendor` 生产调用方唯一：gateway.go:4187（已喂 flag）。
- (c) 未知 vendor/解码失败：非 openai.com 且非 codex 账号的 vendor 正常获得 fitting（含换角色）；body 解码失败时 `developerItemsAsSystem` 原样返回，与 forVendor 其余失败分支同构；summary ask 无 developer 消息时在 bytes.Contains 便宜门处原样返回。

## 矩阵逐项

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 定向两测 | `-run 'TestCodexCompactDeveloperAsSystemOnAVendorRelay\|TestVendorRelayTurnKeepsItsDeveloperMessage' -count=1` | ok 1.030s, exit 0 |
| 家族定向 | `-run 'TestCodexCompact\|TestLocalCompaction\|TestNativeCompaction\|TestVendorRelay\|TestAdditionalTools\|TestCodexOpenAIFields\|TestCodexRewrites\|TestPortedCompaction' -count=1` | ok 2.658s, exit 0, 40 测（含上游新 TestPortedCompactionReadsTheSame） |
| race | 同家族 `-race -count=1` | ok 18.742s, exit 0 |
| 全包 | `go test ./internal/gateway/ -count=1 -p 1 -timeout 30m` | ok 329.524s, exit 0（无超时，未降级） |
| gofmt | 六个触达文件 `gofmt -l` | 空 |
| vet | darwin + GOOS=linux + GOOS=windows | 三者全清 |
| build | darwin/arm64 `./...`；windows/amd64 `./...`；linux/amd64 `-tags nogui ./...` | 全过（darwin 仅预存 ld 版本警告） |
| git am | 干净 worktree @ `c922225f` | applies as is（临时 worktree 已删） |

## 不确定项

- 真实 chat-only vendor 未验证（假 vendor 按记者的 400 原文拒绝 developer）；记者报告未指明 developer 消息走哪条腿（provider 自身 /responses 还是 relay），但两条都是本 patch 适配的中继路。
- 上游 rollout 移植（`sessions.PortCodexRollouts`）是上游自己的工作，本单只经其测试覆盖，未对真实 Codex 复验。
- comment.md 中 turn 测试行 "compaction FAIL, turn PASS" 来自消融观察；正式表中消融行已如实写明。
