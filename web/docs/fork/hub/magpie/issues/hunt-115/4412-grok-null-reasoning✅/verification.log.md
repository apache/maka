# #4412 验证日志（hunt-115 / 车道 a11）

- Issue: https://github.com/yetone/magpie/issues/4412（zminds，0 评论，OPEN）
- 开工 upstream SHA: `9d08993c8bd40de5d002bc364a16be344c5d78fa`
- 分支: `fix/4412-grok-null-reasoning` @ `daa84ce581f9e1cdd84362187afe885143cc34fc`（fork: ggbdpq/magpie）
- 占坑: https://github.com/yetone/magpie/issues/4412#issuecomment-6558233005（`take`）
- 发布: https://github.com/yetone/magpie/issues/4412#issuecomment-6558385093
- patch SHA-256 前 16: `514429097a8dcd18`

## 诊断结论

三道闸全漏 relay（与 issue 报告一致）：
1. `provider/grok.go` `grokBody`——挂在 Grok 订阅账号/插件（需 `Account`），key relay 无 Account。
2. `gateway/xai_body.go` `xaiBody`→`withoutNullReasoningContent`——`p.Host() != "api.x.ai"` 即返回原文（#3392 定版边界）；relay host 是 opencode.ai。
3. `gateway/affinity.go:1031` `foreignReasoning`——四个 alternative 全锚 "encrypted content" 系措辞，"Could not decode the compaction blob" 一个都不命中 → 无 strip-and-retry、无 refusedSeals 记忆、无 failover，400 单次交客户端。

修法：`foreignReasoning` 加一个 alternative `could not (decode|decrypt).{0,20}compaction[ _]blob`，命中后走既有机器（gateway.go:3460）：`withoutReasoning` 同员重试 + `refused()` 记录 seals → 下一轮 `withoutRefused` 前置剥离。瓶颈口单口、fail-closed（"compaction blob" 锚死 xAI 密封语义）、落现有 seam。issue 提案 1（per-provider 声明 upstream=Grok）留给维护者。

## RED（消融前，分支父提交基线）

```
--- FAIL: TestForeignReasoningWords (0.00s)
    foreign_seal_test.go:179: not matched: {"error":{"code":null,"message":"OpenCode Go: Could not decode the compaction blob. ..."}}
    foreign_seal_test.go:179: not matched: Could not decode the compaction blob. Ensure it is unmodified from the compact response.
--- FAIL: TestForeignSealGrokRelayCompactionBlob (0.10s)
    foreign_seal_test.go:493: first: 400 {"error":{"code":null,"message":"OpenCode Go: OpenCode Go: Could not decode the compaction blob. ..."}}
```

## GREEN

```
--- PASS: TestForeignSealAcrossGroupMembers (0.18s)
--- PASS: TestForeignReasoningWords (0.00s)
--- PASS: TestForeignSealGrokToCodexAccount (0.32s)
--- PASS: TestForeignSealAzureSummary (0.03s)
--- PASS: TestForeignSealGrokRelayCompactionBlob (0.02s)
ok  	github.com/yetone/magpie/internal/gateway	1.134s
```

## 消融

`git checkout HEAD~1 -- internal/gateway/affinity.go`（只回产品文件，测试保留）→ 两个新测试回红：

```
--- FAIL: TestForeignReasoningWords (0.00s)
--- FAIL: TestForeignSealGrokRelayCompactionBlob (0.10s)
```

恢复后 git status 干净。

## 验证矩阵

| 检查 | 结果 |
|---|---|
| 定向 5 测试 `-tags nogui` | 全 PASS |
| `go test ./internal/gateway/ -tags nogui` 全量 | ok（536s，exit 0） |
| `gofmt -l` 两改动文件 | 干净 |
| `go vet -tags nogui ./internal/gateway/` darwin/arm64 + linux/amd64 + windows/amd64 | 干净 |
| `go build -tags nogui` linux/amd64 + windows/amd64 + darwin/arm64 | ok（darwin CGO warning 预存于 internal/gui，本单未触 gui） |

## Watched 三查

1. 手拆回红：✅（消融段）。
2. 兄弟面 rg（null reasoning / 措辞消费）：
   - `gateway.go:5367/6505` xaiBody 调用点注释——不改（host 门= #3392 定版边界，扩展需 provider 声明面=提案 1）。
   - `provider/grok.go` grokBody/grokShaped——不改（账号/插件路径，key relay 无 Account 是结构性条件）。
   - `codex_backend.go` withoutUnreadable（OpenAI Codex 后端路径）——不改（xAI 措辞不出现在该上游）。
   - `fallback.go` retryable 词表——不改（strip-and-retry 在 routing 循环内先于失败分类生效，修后无需 failover；动词表会改变全部 400 的 rest 语义，面大）。
   - `agent/pi.go:130`、`codex_titles.go:336`——无关（effort 映射/标题 null 语义）。
3. 失败读取语义：regex 不匹配 → 400 照旧交客户端（现状）；匹配后 `withoutReasoning` 无项可剥 → `withoutCompaction`（checkpoint==nil 且非 native compaction）→ 仍无 → 原失败分类，`resealed < 2` 上限防死循环。热路径代价：新增 alternative 只在 `hw.code() >= 400` 失败路径上 Match，成功路径零开销。

## POST 前门禁

- `git log 9d08993c8..upstream/main` = c0477aa72、15b035eef，均不含 #4412/reasoning/grok → 无自修。
- 两新提交未触及 affinity.go / foreign_seal_test.go → 无碰撞，无需 rebase。

## 回读

GET `repos/yetone/magpie/issues/comments/6558385093`：author=ggbdpq，Attribution/patch 块/SHA/分支链接/`</details>` 全在；`ends_with_branch_line=false` 系 GitHub 存储尾部追加 `\n\n`，od 核对尾部字节即 `(head \`daa84ce5...\`).`。未重发。
