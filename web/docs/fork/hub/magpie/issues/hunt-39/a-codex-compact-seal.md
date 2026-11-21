## 现象

#2642 的修复（bf931f82）把「带着已记录 writer 的原生压缩的 `/responses` 请求」送进路由（`codexSealedFor` → serve → `checkpointReaders`）：writer 还在就送到 writer，writer 不可达就本地 400，用 `checkpointError` 说清原因（谁写的、为什么去不了、怎么恢复、该 provider 现在原生压缩开着没有）。

但同一请求发到 Codex CLI 的遗留压缩端点 `POST /codex/responses/compact` 时，`codexBackend` 在任何 seal 检查之前就 `break` 到转发（"preserve native compaction's existing passthrough"）：请求原样发到 Codex 的登录账号，如果输入里带着另一个账号写下的 compaction item（writer 已在 magpie 里关闭/登出/移除），登录账号读不了这个 seal，请求被 ChatGPT 后端拒绝，客户端拿到的是上游的裸 400，margie 自己的设置明明能说出原因和恢复办法。

## 复现（修前，upstream/main 04e8aa8f）

沙盒 HOME、fake ChatGPT 后端、无网络。`codexSignedIn(t)`（登录 = me@example.com/acct-1，无备用账号），`nativeOn(t, "codex")`，`wroteCheckpoint` 记录 `gone@example.com` 写下 seal，然后：

```
POST /codex/responses/compact
{"model":"gpt-5.5","stream":true,"input":[{"type":"compaction","encrypted_content":"gAAAAB-sealed-by-gone"},{"type":"message","role":"user","content":[{"type":"input_text","text":"go on"}]}]}
```

实际：200 转发发生——fake 后端收到 `/backend-api/codex/responses/compact`，body 原样带着 seal（fake 回 400 时客户端拿到的就是那个裸 400）。同样的 body 发 `/responses` 则是本地 400 + `checkpointError` 的完整解释（bf931f82 已修）。

## 根因

- `internal/gateway/codex_backend.go`：`/responses/compact` 分支在 `compactOn`/`compactSigninHeld` 之后直接 `break // preserve native compaction's existing passthrough`，先于 `codexAccounts`/`codexSealedFor` 的 seal 检查；转发（`codexUpstream`）到达的是登录账号，seal 只有写它的账号能读（#1099、#2271）。
- bf931f82 的提交说明把 `/responses/compact` 排除在 #2642 之外，理由一是「legacy 端点的 body 没有 trigger，codexCompact 答不了」（对——所以本修复不做 codexCompact 接管，也不把 compact 改道 serve：serve 无法重现「只压缩」语义），理由二是「单登录没有别的账号可去」——但 writer 已不可达时转发**必然**被拒，这不是「去哪」的问题，而是「在本地就能说清为什么」的问题。

## 修法

`codex_backend.go`：`break` 之前，`checkpointOf(body)` 命中且 `codexSealedRelayGone(r, cp)`（writer 不是 magpie 的 auth.json 登录账号）时，本地 400 `checkpointError(model, cp)`，不转发。以下照旧转发、不判定：

- seal 是登录账号自己写下的（后端认自己的 seal）；
- seal 是 magpie 的 key 候选写下的（`Who` 含 `#`）；
- 请求头 `chatgpt-account-id` 指名的账号不是 auth.json 登录的账号——WSL 或另一 `CODEX_HOME` 的 Codex 用自己的登录，magpie 读不到，此时不代替它下判断（沿用 `codexServed` 的既有谨慎）。

没有记录 seal 的 compact 仍原样原生压缩，与之前一致。

## 测试

`TestNativeCompactionCompactionHoldsTheWriter`（fake ChatGPT 后端、沙盒 HOME、不触网），三个子测试：

1. 别的账号的 seal：400，说明 writer、恢复办法、"Native compaction is on for codex"；后端 0 次被问。
2. 登录自己的 seal：照旧转发，200，后端被问 1 次。
3. 请求指名另一账号（≠auth.json 登录）：照旧转发，200。

**修前红与消融**（upstream/main 04e8aa8f 上）：只留测试、`codex_backend.go` 回基线，子测试 1 红——200、后端被问 `responses/compact`；恢复修复全绿（改动只有一个产品文件，消融态即基线态）。

## 运行

- `go test -tags nogui -p 2 -count=1 -run 'NativeCompaction|Compact|Checkpoint|TestCodex' ./internal/gateway/`：ok（24s）。
- 新测试及其 seal 兄弟 `-race`：ok。
- `gofmt -l internal/gateway/`：clean；`go vet -tags nogui ./internal/gateway/` darwin/linux/windows：clean；三平台 `go build -tags nogui ./...`：ok（darwin 有已知的 trayimage cgo warning）。

## 没跑什么

- 没有真实 ChatGPT 账号：没验证遗留端点对 seal 的拒绝文案与 `/responses` 是否一致——本修复的拒绝是 magpie 自己给出的，上游文案只影响不修复时的体验。
- 没跑完整套件（internal/gateway 全包 ~45 分钟负载超时是 #2108/#2544 已记录的环境现象）；改动面限于 `/responses/compact` 的一个分支。

## 分支

https://github.com/ggbdpq/magpie/tree/hunt39-a-audit-codex-compact-seal （a8a468cf，基于 upstream/main 04e8aa8f）

合入请保留原作者或加 `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`。

Generated-by: GLM-5.3-Flash (ZCode)
