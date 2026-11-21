# hunt36 A 路 · #2637 issue 草稿（已发布版）

- 分支：`ggbdpq/magpie` 的 `hunt36-a-audit-usage-ingest-first-text`，提交 `fedd5eff`（base `8bb9375e7`）
- patch：`docs/issues/hunt36/a-usage-ingest-first-text.patch`
- 状态：已发帖 https://github.com/yetone/magpie/issues/2643 （2026-10-17，拉回核验通过：分支链接/署名请求/尾注/patch 围栏齐全，body 10702 字符）

---

**标题**：usage: reported 记录可带 `first_text_ms` 与 `flow_ms`，reported 推理调用才能报出回答速度

## 1. 来源、环境与收益

接 #2637（tsy0716）。现场：`POST /v1/magpie/usage/requests`（#1874，`internal/gateway/usage_ingest.go`）按 `ingestFields` 白名单收字段，白名单里没有 `usage.jsonl` 已有的 `first_text_ms` 与 `flow_ms`，带它们的记录整批 400。自报调用的客户端往往精确知道自己回复的首个正文时间，没有入口就只能：推理调用速度显示 "—"，或不带 `reasoning` 发（把推理 token 除进回答窗口，出现 6000+ tok/s 的读数）。修复后已有 reporter 不受影响，两端字段语义完全一致。

## 2. 最小复现（issue 原 repro，在 base `8bb9375e7` 上）

```sh
curl -s http://127.0.0.1:3425/v1/magpie/usage/requests -H 'Content-Type: application/json' -d '[{
  "t":"2026-10-17T00:24:29Z","agent":"my-app","provider":"xai","model":"grok-4.7","rid":"repro-1",
  "in":10696,"out":307,"reasoning":129,"ms":5035,"ttft_ms":4632,"first_text_ms":4700,"status":200}]'
# 实际：400, record 0: first_text_ms: not a field a reported record takes (...)
# 预期：200 accepted，Requests 页该行能算出回答速度
```

测试级复现：`TestUsageIngestFirstTextAndFlow`（`internal/gateway/usage_ingest_test.go`）在基线上红，报文与上同。

## 3. 根因与修法

- 根因：`ingestFields`（`usage_ingest.go:73`）是 reported 记录的字段白名单，缺 `first_text_ms`/`flow_ms`；`parseReported` 也没有对应的读取分支。而 `usage.Record.FirstText`/`Flow`（`internal/usage/usage.go:99,129`）和下游 `DecodeOf`、`HeldShare`、`ThinkPace`（`usage.go:537,540,560`）本来就消费这两个字段——网关自己写的行一直带它们，只有 reported 行带不了。
- 修法：白名单加两个字段；`parseReported` 沿用 `ttft_ms` 的同一 `whole()` 校验（非负整数、上限一天）读进 `rec.FirstText`/`rec.Flow`。写入后页面速度、HeldShare、ThinkPace 对 reported 行与网关行走同一条路，usage 包零改动。
- 作用域：只放行两个字段，其他白名单外字段照旧 400；不发这两个字段的既有 reporter 不受影响。

## 4. 验证

| 步骤 | 结果 |
| --- | --- |
| BASELINE（`8bb9375e7`，产品文件=`usage_ingest.go`）+ 新测试 | RED：`record 0: first_text_ms: not a field a reported record takes (...)` |
| MODIFIED（`fedd5eff`） | GREEN：accepted 2；读回行 `ft-1` FirstText=4700、`ft-2` Flow=300；负数/小数/带引号/超一天按字段名 400 |
| ABLATION（只把 `internal/gateway/usage_ingest.go` 摘回基线，测试保留） | RED：同上 400（该文件在 `d4a1b9ba`/`8bb9375e` 两版逐字节相同） |
| RESTORED（`-count=1`） | GREEN：`go test -tags nogui -p 2 -run TestUsageIngest ./internal/gateway` ok |
| 相邻 | `-run 'Decode\|Speed\|TTFT' ./internal/usage` ok |
| 格式/静态 | `gofmt -l` 空；`go vet ./...`（darwin）、`GOOS=linux/windows go vet -tags nogui ./...` 干净（internal/gui 的 trayimage cgo `Wenum-conversion` 警告与 main 相同，已知项） |
| 构建 | darwin `go build .`、`GOOS=linux/windows go build -tags nogui`：ok（darwin ld 重复库警告为已知环境项） |

## 5. 未验证与待决策

- 没跑：完整 `go test -timeout 45m ./...`（改动面为 gateway 包 ingest 一处，跑了定向集与相邻包定向）；真实 reporter 的看板视图（记录形状在 ingest 边界断言、并经 GET 路由读回验证）。
- 待决策（维护者取舍）：`flow_ms` 一起放行使 `HeldShare` 对 reported 行生效（#2637 的 ask 2）；若只想先放 `first_text_ms`，摘掉 `parseReported` 的 `flow_ms` 分支即可，其余不变。

## 没跑什么

完整套件、GUI 套件（无 GUI 文件）、真实 DeepSeek/xai 账号、Windows/Linux 实机运行（仅交叉 vet/build）。

## patch

<details>
<summary>git format-patch -1 fedd5eff（base 8bb9375e7）</summary>

```patch
见 https://github.com/ggbdpq/magpie/commit/fedd5eff
（原文随帖附于邮件补丁，分支 hunt36-a-audit-usage-ingest-first-text 可直接 git am / cherry-pick）
```

</details>

分支：https://github.com/ggbdpq/magpie/tree/hunt36-a-audit-usage-ingest-first-text （提交 https://github.com/ggbdpq/magpie/commit/fedd5eff ）

合入请保留原作者署名，或加 `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`。

Generated-by: GLM-5.3-Flash (ZCode)
