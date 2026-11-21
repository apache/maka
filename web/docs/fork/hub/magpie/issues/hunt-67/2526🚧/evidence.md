# hunt67 Lane A · #2526 验证证据（guo-yu 独立复现+修复提案）

验证时间：2026-10-23。worktree：magpie-hunt67-a（分支 hunt67/a，起点 be002aca）。
工件：帖内 inline diff（评论 id 6359419062，guo-yu，2026-10-23T07:02:13Z），声基点 v0.1.1330 = e00fbdbbc74f9829027a78769cbeb265d6271fb4。
转写件：guo-yu-2526.patch（逐字转写自帖内 ```diff 块）。

## 0. 帖子与基线复核
- GET /issues/2526 → 正文（Raters0，10-16 现场报告）。
- GET /issues/2526/comments → length = 3（= 查重基线 c=3）：6217925977 ggbdpq 10-16T14:41、6218111199 ggbdpq 10-16T14:50（我方根因诊断）、6359419062 guo-yu 10-23T07:02。发稿前再次复核仍为 3。
- `git fetch origin main` → origin/main = be002aca（会话开始）；收尾复 fetch → **前移至 da6fd87e**（新增 19f9a80d、da6fd87e，均 site/gui）。

## 1. 基点距离与 blob 一致性
```
$ git rev-list --count e00fbdbb..be002aca   → 5（bac5be06/65e80405/a1cce7fa/84d902ce/be002aca）
$ git diff --stat e00fbdbb be002aca -- internal/gateway/
  → classify.go/classify_test.go/decide.go/decide_test.go/plugin_workdir_test.go，无 gateway.go
$ git rev-parse be002aca:internal/gateway/gateway.go
  → 87b90e910685a8e8c772faca589552c6c2f91df7  == patch 前像 index 87b90e9（字节等同）
$ git rev-parse da6fd87e:internal/gateway/gateway.go
  → 87b90e9…（最新 tip 上仍等同，零漂移）
```

## 2. 落地（apply --3way）
```
$ git apply --3way --check guo-yu-2526.patch   # on be002aca, HEAD 干净
  Falling back to direct application... ×2
  Applied patch to 'internal/gateway/gateway.go' cleanly.
  exit=0
$ git apply --3way guo-yu-2526.patch           → exit=0，A/A/M 三文件
# on da6fd87e（detached）复测：--check exit=0、apply exit=0、3-way 去重正确
$ rg -n 'codexRecheck :=|quotaRecheck\(' internal/gateway/gateway.go
  1644: codexRecheck := …（1 处）
  2128 / 3501 / 3502: quotaRecheck(…)（各 1 次）
```

## 3. 消融回红（产品回退到 be002aca，仅保留 codex_quota_recheck_test.go）
```
$ go test -tags nogui -run 'TestCodexQuotaRecheck' -count=1 -v ./internal/gateway/
  exit=1（RED 原文，red-plain.log）
  codex_quota_recheck_test.go:36: first: 429 Retry-After "7200": {"error":…usage limit has been reached…}
  --- FAIL: TestCodexQuotaRecheckAccountsRecover (0.58s)
  codex_quota_recheck_test.go:82: request 0: 429 Retry-After "900": …weekly usage limit…
  --- FAIL: TestCodexQuotaRecheckHeldKeys (0.18s)
  codex_quota_recheck_test.go:102: cap: 429 Retry-After "10800" tried "" spent ""
  --- FAIL: TestCodexQuotaRecheckCaps (0.25s)
  codex_quota_recheck_test.go:130: 429 Retry-After "7200" after 1 upstream calls; want 429 "60" once
  --- FAIL: TestCodexQuotaRecheckHeaders/long_quota
  codex_quota_recheck_test.go:130: 429 Retry-After "Fri, 23 Oct 2026 09:49:36 GMT" after 1 upstream calls; want 429 "60" once
  --- FAIL: TestCodexQuotaRecheckHeaders/date_quota
  --- PASS: TestCodexQuotaRecheckHeaders/{short_quota,one_minute,rate,credit,other_agent}
  --- PASS: TestCodexQuotaRecheckKeepsAutoReset
```
RED 值 7200/900/10800 与提案帖声称的基线值逐一相符；机理同形（长 Retry-After 让客户端长睡，即现场 5355s 的形态）。
```
# 恢复完整 patch 后 GREEN（green-plain.log）
$ go test -tags nogui -run 'TestCodexQuotaRecheck' -count=1 -v ./internal/gateway/
  exit=0；--- PASS 全部 5 测试 + Headers 7 子测试；ok …gateway 3.281s
```

## 4. 相称矩阵
```
$ go test -tags nogui -race -run 'TestCodexQuotaRecheck' -count=1 ./internal/gateway/
  exit=0（CGO_ENABLED=1 + mingw64 gcc；green-race.log：ok 6.834s）
$ gofmt -l codex_quota_recheck.go codex_quota_recheck_test.go gateway.go → 无输出，exit=0
$ go vet -tags nogui ./internal/gateway/ → exit=0
$ go test -tags nogui -run 'TestAccountCap|TestCodexAutoReset|TestCodexNoCredits|TestNativeCompaction|TestStrictAffinity|TestDrawCapped|TestStrictKeep' -count=1 ./internal/gateway/
  exit=0（neighbors.log：ok 10.742s，无 FAIL）
$ go test -tags nogui -run 'TestCodexQuotaRecheck' -count=1 ./internal/gateway/   # on da6fd87e
  exit=0（green-da6fd87e.log：ok 3.312s）
```
未跑：整仓 `go test ./...`（禁令）、-race 的 da6fd87e 复跑（gateway.go 字节等同，定向 -race 已在 be002aca 覆盖）、Windows 外平台 vet/build（本机 win32）。

## 5. 根因关系与兄弟面（代码判定，be002aca 行号）
- 我方 10-16 诊断的 cappedError 本机拦截路径：gateway.go:2118 → 2124-2126 写 Retry-After（无上限）→提案 hunk2 在此截短；#2517 compaction pin 出口（checkpointCappedError，2115）同出口一并覆盖——与我方 10-16 修法口径一致。
- 新指出的路由上游 quota 拒绝路径：vendor 429/Retry-After 经 routing.go:1231 落入响应头；最终拒绝在 hunk3（gateway.go:3497-3503）截短，`hw.header` 与 `w.Header()` 都截；quotaHeld 持有响应（gateway.go:2674 → heldBack → 3448-3456 写头）也流经 hunk3 覆盖。
- 判定复用：quotaRecheck 只调既有 `retryAfter`（routing.go:1268，秒/日期/ ratelimit-reset 头一体的唯一解析器），无第二套解析。
- 冷却先后：restAfterMarked 的两处 rest 计算（3434、3447-3455）都在 hunk 之前读 vendor 原头；quotaRecheck 不动 x-ratelimit-reset-* 头，只改 Retry-After。
- 未覆盖面（点名，不抢修）：
  a) draw.go:519 drawOnAccounts 的 capBack Retry-After（同型长睡眠，我方 10-16 已点名；提案也未盖）。
  b) key_limit.go:63 网关 key 预算拒绝（gwbudget.Refusal.RetryAfter）——运营者策略类，未盖。
  c) **strict 角落**：gateway.go:3568（failVerify/strictAlone 时的 restAfter）在 hunk 之后读已截短的 hw.header。但 quota rest 取值优先链为 正文 resets_at(923) → clineBackIn(925) → reset 头(927) → 本地窗口(929) → Retry-After(931，最后兜底)，且 min(d, longestQuota) 封顶（944）；仅当拒绝只以 Retry-After 表达等待时才受影响。静态判定，提案测试未覆盖（其测试只测 session affinity）。
  d) lan.go:420（auth flood，有界桶）、gateway.go:2774（lane/RPM ≤1min）、relay_status.go:88（内部 busy 调度，noteBusy 消费）不属于 quota 面，不盖属正确取舍。

## 6. attribution 实查
- 工件为帖内 inline diff，**无 fork 分支、无 commit**——`git show --format=fuller` 无对象可查，trailer 无从存在。
- 内容与我方 df41c438（30s cappedRecheck 落 fallback.go + TestCodexNoCreditsRetryAfterBounded + 文案）对比：文件、常量（60s vs 30s）、测试名全不同；我方 commit 从未进上游（rg cappedRecheck 于 be002aca/e00fbdbb 均无匹配，exit=1）。**无我方内容，无需 Co-authored-by: ggbdpq**；其观点源头是否受我方诊断启发无从从工件判定（帖内未引用我方评论）。
- 落地时应归作者 guo-yu（id 1269537）：`Co-authored-by: guo-yu <1269537-guo-yu@users.noreply.github.com>`（或 Author 直署）。
- guo-yu 帖内生产日志（481,803/481,784s 两条）我方不可复核；合成 RED 已复现其机理形态。
