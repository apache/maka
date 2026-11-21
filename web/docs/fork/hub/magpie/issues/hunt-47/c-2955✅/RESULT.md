# hunt47-c — issue 2955 修复记录

## 结论

已修复：Codex 的 compaction（`compaction_trigger`）在"Provider 同时有 Responses 端点、而其背后是只认 chat 角色的厂商"时，magpie 自己构造的摘要请求原样转发，其中携带的 `developer` 角色消息直达厂商，被 400 `developer is not one of ['system', 'assistant', 'user', 'tool', 'function']` 拒绝；该 400 不是 404/itemNotFound/upstreamFailed/protection 之一，`plainCompact` 重试不触发，原样回给 Codex，Codex 重试 5 次。普通 turn 不带 developer 消息所以 200。

- 提交：`58906f6ec14de57ae740244bcb0b6c28aa25a64a`（单提交，基线 upstream/main `ef655acb40b2b2b5484e8eab41c79ff8b41bb6d3`，分支 `hunt47-c-compact-developer`）
- patch sha256 前 16 位：`cc195a80c01bf5e6`（`0001-gateway-a-Codex-compaction-relayed-to-a-vendor-that-.patch`）
- 作者/提交者：`ggbdpq <ggbdpq@gmail.com>`

## 与任务假设的差异（重要）

任务假设 bug 在"翻译后的 Chat 路径"。实测（探针测试）证明**翻译路径在当前 main 已经安全**：`parseResponses` 把 developer 消息提升进 system prompt（线程中途的放进 `<system-reminder>` user 消息，#502），`buildChat` 从不写 developer；用"developer 消息 + compaction_trigger + 纯 chat provider"复现，线上角色为 system/user/assistant/user，compaction 成功。0.1.1272 与 main 之间该形状无变化（查了 `v0.1.1272..ef655acb` 的相关 diff）。

真正的缺口在**原样转发的 Responses 路径**：provider 有 Responses URL（DeepSeek 预设 chat/responses 同一 base；暴露 /v1/responses 的中转同理）时，`codexCompact` 的摘要请求走 `passthrough`，`forVendor` 不处理角色。修复落在这个共享点。

中途踩坑：第一版把 developer→system 无条件加进 `forVendor`，全量测试被 `TestAdditionalToolsRelayed`（#350 契约：原样转发的 turn 保留 developer 角色，中转可能按它校验 Codex 形状）拦下。改为**只对 magpie 自己的摘要请求生效**：`codexCompact` 里 `askCompaction(r)` 打上下文标记（与 `askWhole` 同构），`forVendor(p, body, compaction)` 只在标记为真时调 `developerItemsAsSystem`。OpenAI 自家 API 与 ChatGPT backend（backend 拒绝 system 角色，`codexInput` 反向归一）跳过，#2582 的账号路径不受影响。

## 改动面

- `internal/gateway/codex_compact_guard.go`：`compactionAskKey` + `asksCompaction`/`askCompaction`（标记 magpie 自己的摘要请求）。
- `internal/gateway/codex_backend.go`：`codexCompact` 设置标记；`forVendor` 增加 `compaction` 参数；新函数 `developerItemsAsSystem`（逐 item 用 `UseNumber` 解码，仅重编改动的 item，消息原位换角色）。
- `internal/gateway/gateway.go`：`passthrough` 调用处传入 `asksCompaction(r.Context())`。
- 测试：新增 `codex_compact_developer_test.go`（RED 用例 + turn 保持 developer 的范围锁用例）；`codex_openai_fields_test.go` 三处 `forVendor` 调用补 `false`。

## RED/GREEN 与消融/变异证据

- RED（`ef655acb` 原代码 + 新测试）：摘要请求线上带 `"role":"developer"`，假上游回 reporter 的原 400，Codex 收到 400（fail 日志见 comment 的 Red before the fix 节）。
- GREEN：同请求换角色为 system，compaction 200 返回 SUMMARY。
- 消融：4 个产品文件从 `upstream/main` 恢复（测试保留）→ RED；恢复修复 → GREEN。
- 变异 a（developer→user）：RED（"system message lost"——developer 消息不得降级为 user turn）。
- 变异 b（去掉 `askCompaction` 标记，修复不生效）：compaction 用例 RED，普通 turn 用例 GREEN——证明修复恰好落在缺口处。
- 所有临时改动均从 `/tmp/h11-keep/` 副本恢复，未动共享树。

## 验证矩阵（最终代码）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 定向族 | `go test ./internal/gateway/ -run 'TestCodexCompact\|TestLocalCompaction\|TestNativeCompaction\|TestVendorRelay\|TestAdditionalTools\|TestCodexOpenAIFields' -count=1` | ok，37 个用例，exit 0 |
| 全量包 | `go test ./internal/gateway/ -count=1` | ok 319.078s，exit 0（含 `TestAdditionalToolsRelayed`） |
| -race | 同定向族加 `-race` | ok，exit 0 |
| gofmt | `gofmt -l internal/gateway/` | 干净 |
| vet | `go vet ./internal/gateway/`（darwin/linux/windows） | 三平台全过 |
| 构建 | `go build ./internal/gateway/`（darwin/linux/windows）；darwin `go build ./...` | 全过；darwin 全仓仅 ld 版本警告 |

预存问题（与本改动无关，如实记录）：`GOOS=linux go build ./...` 失败于 wails v3 beta.24 模块缓存内的 `webview_window_linux.go`（`undefined: pointer`），属 GUI 依赖的环境问题；`./internal/gateway/` 的 linux/windows 构建正常。amend 只改了新测试的函数名/注释，全量套件在 amend 前树上全绿，amend 后又跑了一次全量（见下）。

## 不确定项

1. 无真实 DeepSeek/chat-only 上游可打；厂商角色白名单引自 issue 原文（与 Chat Completions 角色集一致），RED 用假上游以原 400 拒绝 developer。
2. 无法从报告确证 reporter 的请求走的是 provider 自身 /responses（DeepSeek 预设 Responses 同 base）还是中转的 /responses——两者同属本修复覆盖的转发路径；400 角色表含 `function`，必是 chat 角色校验方。
3. 若 reporter 的 provider 真的只有 chat URL，当前 main 的翻译路径本来就干净（发现 1），本补丁对该场景零影响。
4. 普通 turn 自身携带 developer 消息打到这类厂商仍会按 Codex 原样被拒（#350/#1758 决定保留），不在本单范围；已在 comment 的 Not verified 说明。

## 工件

- `2955-comment.body.md`：可发英文评论（含完整 patch、验证表、Siblings、Not verified、指定结尾两行；已 grep 确认零中文）。
- `0001-gateway-a-Codex-compaction-relayed-to-a-vendor-that-.patch`：format-patch，未推送、未发帖。
