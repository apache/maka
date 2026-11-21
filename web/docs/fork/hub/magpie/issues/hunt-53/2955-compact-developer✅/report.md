# #2955 rebase 报告（hunt53-r1-compact-developer @ /tmp/magpie-h41）

## 结论

原 patch 已成功 rebase 到 `318697dc`（=upstream/main），行为不变，全矩阵绿。上游 `58cfca2f` 只是重构了 `forVendor` 的内部实现（原地读 item + `forVendorChanges` 预扫门），**没有**顺手覆盖本修（`developerItemsAsSystem`/`askCompaction` 等符号在 upstream/main 上不存在，`git log --grep '#2955' upstream/main` 为空），新 main 上不修仍红，照常交付。

## 关键产物

- **新 head SHA（完整）**：`6f8e2ea36f79f8b99a00199a07154c26afc8ff8d`（分支 `hunt53-r1-compact-developer`，ahead 1，工作树干净）
- **patch**：`/Users/ggbdpq/cc/guahub/fork/magpie-hub/docs/issues/hunt53/2955-compact-developer/0001-gateway-a-Codex-compaction-relayed-to-a-vendor-that-.patch`
- **sha256 前 16**：`1bbad2994a01d3c0`（全值 `1bbad2994a01d3c0af2795c37f7fa7390ab9204b6220f568d6ea4784912ea607`）
- **英文回帖草稿**：`/Users/ggbdpq/cc/guahub/fork/magpie-hub/docs/issues/hunt53/2955-compact-developer/comment.md`（零中文、围栏配对、表行无空行、模型名只在 patch 内 Generated-by，均已程序化校验）
- **全包日志**：同目录 `gateway-full.log`（`ok 330.131s`，exit 0）
- 分支名沿用 `hunt47-c-compact-developer`（主线程 force-push 目标），head 写 `6f8e2ea3`。
- `git am` 已在临时 worktree（upstream/main 干净检出）验证干净应用，事后已删。

## 冲突解法（一句话）

保留上游新门 `if !slices.ContainsFunc(openaiOnly, …) || !forVendorChanges(body)`，把 `if compaction { body = developerItemsAsSystem(body) }` 插到该门**之前**（compaction 请求可能不含任何 openaiOnly 标记，放门后会被早退短路）；冲突 2 处为上游新增 `forVendorChanges` 与我方新增 `developerItemsAsSystem` 同位，两者都保留（上游在前）。

## 改动面（6 文件，+159/−9）

原 5 文件全部保留原样语义 + 新增 1 个编译桥接：上游 `58cfca2f` 带来的 `internal/gateway/codex_rewrite_scan_test.go` 有 3 处 2 参调用 `forVendor`，改 3 参签名后补 `, false`（零行为，保持其与 `wasForVendor` 的逐字节对比语义）。`developerItemsAsSystem` 本体未改写为 rawObject 风格（最小改动；仅 compaction=true 时被调用，且自带 `bytes.Contains` 廉价门）。commit message 原样保留（含 `Fixes #2955` 与原 `Generated-by` 尾注）。

## 步骤 2 RED 原文（新 main 318697dc，未修）

```
--- FAIL: TestCodexCompactDeveloperAsSystemOnAVendorRelay (0.11s)
    codex_compact_developer_test.go:43: 400 {"error":{"code":"invalid_parameter_error","message":"Fake: developer is not one of ['system', 'assistant', 'user', 'tool', 'function']","param":null,"type":"invalid_request_error"}}

        upstream got {"input":[{"content":[{"text":"You are Codex, a coding agent.","type":"input_text"}],"role":"developer","type":"message"},...(后接 user/assistant/CONTEXT CHECKPOINT COMPACTION 摘要请求全文)...
FAIL
FAIL	github.com/yetone/magpie/internal/gateway	1.077s
```

同跑的 scoping 测试 `TestVendorRelayTurnKeepsItsDeveloperMessage` 未修即绿（符合预期）。说明：RED 只取了新测试文件 `codex_compact_developer_test.go`；原提交里 `codex_openai_fields_test.go` 的 diff 是纯 3 参调用点适配（自身无断言），取到 2 参 base 上唯一"桥接"就是实现修复本身，故不取——对任务书的一处已声明偏离。

## GREEN 原文（cherry-pick 解冲突后，含桥接）

```
=== RUN   TestCodexCompactDeveloperAsSystemOnAVendorRelay
--- PASS: TestCodexCompactDeveloperAsSystemOnAVendorRelay (0.11s)
=== RUN   TestVendorRelayTurnKeepsItsDeveloperMessage
--- PASS: TestVendorRelayTurnKeepsItsDeveloperMessage (0.04s)
PASS
ok  	github.com/yetone/magpie/internal/gateway	1.089s
```

## 消融（逐个还原产品文件，保留测试，必须见断言级 FAIL）

| 还原文件 | 桥接 | 结果 |
| --- | --- | --- |
| `codex_backend.go` | gateway 调用点与 6 处测试调用临时回 2 参 | FAIL（同上断言原文，developer 上线）；恢复→绿 |
| `codex_compact_guard.go` | 先撞 build failed（上游 guard 无 `askCompaction`，保留的 backend :2598 调它）→ 按任务书补零行为桥接：guard 保持上游原文，backend 删 `askCompaction` 行、gateway 第三参临时字面 `false` | FAIL（同上）；恢复→绿 |
| `gateway.go` | 还原后其调用点临时字面 `false`（编译需要） | FAIL（同上）；恢复→绿 |

每次消融后 `git checkout HEAD -- .` 恢复并复跑定向绿。FAIL 断言原文三连均与步骤 2 相同（400 原样回传、`"role":"developer"` 在线上）。

## Watched 三查

(a) **Mutation**：vendor 判定反转一行（`if !(p.Account != nil && p.Account.Agent == "codex" || strings.HasSuffix(p.Host(), "openai.com"))`）→ compaction 测试回红（同上 400 原文）→ 还原复绿。
(b) **Siblings**（rg 'developer' 与 rg 'forVendor\('，均排 _test）：全仓写 developer 角色处共 5 类——`parseResponses`（responses.go:354/361，译路由，已把 developer 抬进 system prompt/`<system-reminder>`，不改）；`developerAsSystem`（gateway.go:6283，Chat→Chat 直通的同款交换，不改）；`ZedBody`（provider/zed_body.go:36，不改）；`codexInput`/`chatgpt_api.go:611`（provider/codex_request.go:293/436，反方向 system→developer，ChatGPT backend 拒 system item，这正是本修排除 OpenAI/codex 账户的原因，不改）；`message_tools.go:66`、`format.go:270`（只读谓词，不写角色，不改）。`forVendor` 生产调用方唯一（gateway.go:4165，现已喂 flag）。与原帖结论比对：五项全部在位、语义无漂移；唯一结构漂移就是 `forVendor` 内部实现与新增 `codex_rewrite_scan_test.go`。
(c) **失败/未知 vendor**：vendor 判定是静态的（account agent + host 后缀，无 I/O），不存在"读失败"；非 OpenAI 主机且非 codex 账户 = vendor，compaction 时 developer 原地变 system；`developerItemsAsSystem` 解码失败时原样返回 body（上线如旧）。compaction 400 失败路径核实：`codexCompact` 的 plainCompact 重试只认 404/itemNotFound/upstreamFailed/protectionRefused，vendor 的角色 400 不命中，直传 Codex（五次重试）——与原帖一致。

## 矩阵逐项（全部在 /tmp/magpie-h41）

| 项 | 命令 | 结果 | exit |
| --- | --- | --- | --- |
| 定向 | `go test ./internal/gateway/ -run 'TestCodexCompactDeveloperAsSystemOnAVendorRelay\|TestVendorRelayTurnKeepsItsDeveloperMessage' -count=1 -v` | 两测 PASS，ok 1.089s | 0 |
| 家族 | 同上加 `\|TestCodexCompact\|TestLocalCompaction\|TestNativeCompaction\|TestVendorRelay\|TestAdditionalTools\|TestCodexOpenAIFields\|TestCodexRewrites` | 39 测试 PASS，ok 3.092s | 0 |
| race | 家族同款 + `-race` | ok 19.217s | 0 |
| gofmt | `gofmt -l $(git diff --name-only upstream/main -- '*.go')` | 无输出 | 0 |
| vet | `go vet ./internal/gateway/` | 无输出 | 0 |
| build darwin/arm64 | `go build ./...` | ok（仅 ld warning 过滤后无错） | 0 |
| build windows/amd64 | `go build ./...` | ok | 0 |
| build linux/amd64 | 不带 tags：`wails/v3 pkg/application menu_linux.go: undefined: pointer`（GOMODCACHE 内只读第三方，gui 包，预存）；带 `-tags nogui ./...`：ok；`./internal/gateway/` 三平台均 ok | 预存失败已定性，绕行绿 | nogui 0 |
| 全包 | `go test ./internal/gateway/ -count=1 -p 1 -timeout 30m`（后台） | `ok 330.131s`，日志 0 个 `--- FAIL` | 0 |

## 不确定项 / 未验证

- 未碰真实 chat-only vendor；RED 是用报告者原始 400 文本的 fake。
- 报告无法判断 developer 消息走的是 provider 自带 `/responses` 还是中转的——两者同为本修覆盖的中继路由。
- 裸 `GOOS=linux go build ./...` 在本机挂 wails gui 依赖（预存、与本改动无关）；comment.md 的 build 行已如实写为「plain linux ./... fails in the wails gui dependency, pre-existing」。
- gh api 开头一次瞬时 EOF（重试成功）；usage/限额信息本次调用不可见。

## 事故记录（已恢复）

步骤 2 首跑误在主 clone（cwd 未加 -C）落地测试文件并跑了旧 main——已当场 `restore --staged` + 删除，主 clone `git status --porcelain` 0 行、仍 behind 130（与接手时一致）；该次 RED 作废，已在 /tmp/magpie-h41 上重做。此后所有 git 用 `-C`、go 用子 shell cd。

## 禁止项核对

未 push、未发帖、主 clone 只读（事故已恢复）、未动其他 /tmp/magpie-h*、未 stash、未改上游重构、未加依赖、未改 Generated-by 尾注。
