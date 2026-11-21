# #2833 gateway compacting 规则不认识 Alma 的压缩请求

## 结论

在 `internal/gateway/compacting.go` 的 `compactAsks` 增加一条 Alma 的压缩问句即可；已用 TDD 落地，测试与验证矩阵全绿。未添加 `compactSystems` 条目：仓库内（`internal/gateway`、`internal/sessions`、`docs`、`internal/agentplug`）没有任何 Alma 压缩 system prompt 原文，issue 也未给出，按规则不臆造。

## 事实核对

- `compacting()` 的消费方只有两处：`internal/gateway/rules.go:212`（组里存在 `Compact` 规则时才调用）和 `internal/gateway/prefill.go:59`。
- `leads(text, p)` 用 `strings.Index` 取首次出现并要求 `i <= compactLead`（2048）；`compactAsks` 里 `opens == ""` 的条目走这条路径。
- 全仓 `rg "Merge the previous summary"` 无命中，确认仓库里没有既有 Alma 处理；`rg -i alma internal/gateway/` 只有 #912 会话回写、#2375、caller 识别等，与压缩无关。
- issue 称该句在 user message 第 0 字节；实现按 `leads` 语义（起始 2048 字节内）匹配，第 0 字节必然命中。

## 改动

- `internal/gateway/compacting.go`：`compactAsks` 末尾 +3 行（含注释）。
- `internal/gateway/compacting_test.go`：新增 `almaCompactAsk` 常量与 `TestRuleCompactAlma`（+38 行）。
  - 端到端：用既有 `ruled` + `postAs`/`lastRoute` 机制，断言 `X-Magpie-Model` 与 `Route.Rule`；本包既有测试也直接调 `compacting(req)`，这里选端到端是因为它同时覆盖「规则命中」这一公共行为，并且能按 issue 报告用同一个响应头复现。
  - 负例：长消息深处嵌入**完整**原句，必须不命中，用来显式验证 `compactLead` 边界（把 `compactLead` 改成 `1 << 20` 时该负例转红，已实测）。

## RED / GREEN / 消融 / 变异（最终树）

| 步骤 | 命令 | 结果 |
| --- | --- | --- |
| RED | `go test -tags nogui -count=1 -run TestRuleCompactAlma ./internal/gateway/`（产品文件为 upstream/main 原文） | FAIL：`from kb` / `b/big` / `Compact:false`，exit 1 |
| GREEN | 同上，加修复后 | `ok 1.053s`，exit 0 |
| 消融 | 修复文件备份到 `/tmp/h2-keep`，`git show upstream/main:internal/gateway/compacting.go > internal/gateway/compacting.go`，保留测试 | FAIL，同一断言，exit 1 |
| 消融恢复 | 拷回修复文件 | `ok 1.081s`，exit 0 |
| 变异 | 新条目 `with` → `into` | FAIL，同一断言，exit 1 |
| 变异恢复 | 拷回修复文件 | `ok 1.038s`，exit 0 |
| 边界依赖 | `compactLead = 1 << 20` | 负例转红（`a/small`, `Compact:true`），exit 1；恢复后绿 |

## 验证矩阵（最终提交树）

| 检查 | 结果 |
| --- | --- |
| `go test -tags nogui -count=1 -run 'TestCompact\|TestCompacting\|TestRule' ./internal/gateway/` | exit 0，`ok 2.839s` |
| `go test -tags nogui -count=1 ./internal/gateway/`（全量，后台） | exit 0，`ok 344.144s` |
| `gofmt -l internal/gateway/` | 空（0 行） |
| `go vet -tags nogui ./internal/gateway/` | exit 0 |
| `GOOS=linux go vet -tags nogui ./internal/gateway/` | exit 0 |
| `GOOS=windows go vet -tags nogui ./internal/gateway/` | exit 0 |
| `go build -tags nogui ./...` | exit 0 |
| `GOOS=linux go build -tags nogui ./...` | exit 0 |
| `GOOS=windows go build -tags nogui -o /dev/null .` | exit 0 |
| `go test -race -tags nogui -count=1 -run 'TestCompact\|TestCompacting' ./internal/gateway/` | exit 0，`ok 2.172s` |

全量包没有出现 flaky 或预存失败，一次通过。

## 未验证 / 不确定

- 没有真实 Alma 客户端跑过；措辞来自 issue 报告原文，没有自行观察 Alma 的行为。
- Alma 压缩时的 system prompt 开头未知，因此只加 ask。
- 匹配依赖该句出现在 user message 起始 2048 字节内；报告称是第 0 字节，若实际更靠后则不会命中。

## 产物

- 提交：`3d8ed8560fa3365aaa9ddbc7403ca902a5e6a417`（分支 `hunt44-b-gw-alma-compact`，base `95ef45fda4b3978e94f12954a27d41e5ef1dca85`）
- patch：`0001-gateway-a-compaction-rule-sees-Alma-s-compaction-ask.patch`，sha256 前 16 位 `5df21a5ef21b4bba`
- 评论草稿：`2833-comment.body.md`（英文，可直接发布，未发布）
- 证据文件在 `/tmp/h2-keep/`：`ablation-red-final.txt`、`restored-green-final.txt`、`mutation-red-final.txt`、`bound-final.txt`、`sel-final.txt`、`race-final.txt`、`full-package-final2.txt`、`vet2-*.txt`、`build2-*.txt`
