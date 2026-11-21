# hunt-123 / Lane A / #5111 工作日志（2026-11-04）

结局：**完成交付——patch 已附 issue，fork 分支已推，GET 回读八要素全中**。
分析帖：https://github.com/yetone/magpie/issues/5111#issuecomment-6610411473
交付帖：https://github.com/yetone/magpie/issues/5111#issuecomment-6610713532
分支：https://github.com/ggbdpq/magpie/tree/fix/5111-litellm-budget-429（head `ba42bfcd52e460d69d2ec6eb655838bdd6f6f3b7`，基线=7785c4278=发布时 upstream/main tip，已 ff 同步过 6 个无关新提交）
patch：`0001-gateway-a-LiteLLM-Budget-has-been-exceeded-429-is-ou.patch`（SHA-256 前 16 `cc9d8111b5a477a4`）

## 根因（探针实证于修复前）
- `routing.go` `failure()` 的 `usedUpWords` 只认识相邻二元组 `budget (exceeded|exhausted)` 和 `out of budget`；LiteLLM 的 "Budget **has been** exceeded! Key=… Current cost… Max budget…" 被 "has been" 拆开，body 又无 quota/insufficient/billing/limit/plan 词 → creditWords/brokeWords 不中（429 下 credit 本就要求 brokeWords）→ minuteLimit/backSoon/rateWords 全空 → 落最后一个 `case status == 429` 读 `rate`（报告里 `"by":"backoff","failures":7`）→ `OwnQuotaRest`（quota-rest）永不生效。
- 修法：`budget.{0,32}(exceeded|exhausted)`（窗口 12 实距 + 余量），一行 + 注释；负对照 `LiteLLM: Rate limit exceeded` 仍 failRate（测试钉住）。

## 兄弟面（rg 全查，列改/不改）
- `fallback.go:1496 quotaWords`：同样的二元组但带裸 `exceeded`，`quotaSaid`（无 status 场景）已能匹配本 body → 不改。
- `draw.go:1142`：直接复用 `usedUpWords` → 自动继承，不改。
- `stream_error_passing_test.go piDeny`：测试侧 regex，非产品词表 → 不改。
- #5006 反向面：SenseNova "inference exceeds tpm/rpm limit" 不含 `budget`，新窗口抓不到它 → 不受影响。
- TS 侧（packages/ai retry.ts/overflow.ts）：无 budget 词表 → 无面。

## 验证矩阵（全部实际跑过）
- RED：新增两行（JSON 信封 + 裸句）在旧词表上读 `rate` 且被原地重试（红 4 行）。
- GREEN：一词修复后全过；负对照 pass。
- 消融：commit 后 routing.go 回退到父提交（测试保留）→ 红（`ablation-red-on-parent.log`，4 FAIL）；恢复 → 绿（`green-after-fix.log`）。
- 全量：`go test -tags nogui -count=1 -timeout 25m ./internal/gateway/...` ok 629.6s（无预存红出现）。
- race：定向（本测试 + TestOwnQuotaRest + TestChineseNotTooLong）ok。
- gofmt -l 两文件净、`go vet ./internal/gateway/` 净、`go build ./...` 过（ld 警告为本机 SDK 预存噪音）。

## Not verified（帖内已声明）
- 本机无真实 LiteLLM 中转：分类钉在报告引用的 body 上；通道侧（failQuota → quota-rest 生效）由既有 `TestOwnQuotaRest` 钉住；真实中转的 body 细节（alias 拼写、信封）可能围绕该句变化。rest-lift 读取是通道既有行为，未另测。

## 流程合规
让位闸（c=0、无维护者表态、`git log -S budget` 无 landed 修复、报告者无方案）→ 分析帖 → take → TDD → 消融 → 矩阵 → commit（`-F` 文件，尾注 Generated-by: GLM-5.3-Flash (ZCode)）→ push（remote -v 先核 origin=ggbdpq/magpie）→ ls-remote 核对 → format-patch 落盘 → 帖稿 Write 落文件 `--body-file` 发布 → GET 回读。
