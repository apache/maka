# Hunt48-C：#2973 Codex 401 expired 未自动刷新

## 结论

已修复缺陷 (a)，缺陷 (b) 经核实已在 main 修掉（上游提交 `d5bc9f00`，2026-10-19，恰在我们 base `e4ac5e87` 之内，reporter 的 v0.1.1231 早于它）。单提交 `93e69010cd6625817bee674a5e2583e1028902de`，分支 `hunt48-c-codex-401-refresh`，未推送、未发评论。

## 改了什么（(a) / (b) 的取舍）

- **(a) 已改**：401 且正文说"token 已过期、请刷新"（`SignInRefreshable`：OpenAI 的 `token_expired` 代码 + 报告原文措辞）时，`noteSignIn` 当场做一次有界（20s）、合并并发（复用签名锁 `codexMu`/`savedTokenMu`，且 token 已换新则跳过）的强制刷新：saved 账号走既有 `renewSavedLogin(force=true)`（刷新被拒仍由既有 `savedRefreshFailed` 记 lapse），live/own 账号走新增 `codexTokenRefresh(dir, force=true)`（`codexToken` 本体不变，只加 force 参数）。不新增状态、不标记账号，下一请求即带新 token；同请求不重试（`fail:"other"` 短 backoff 照旧）。
- **(b) 未改**：main 上 `restAfterMarked` 的 default 分支已有 `status != 401 && != 403` 守卫（d5bc9f00，plugins#243），认证失败不会再继承 quota window；现行为为分钟级 backoff，符合"认证失败短暂 rest"。

## 文件

- `internal/provider/signin_expired.go`（新）：`SignInRefreshable` + `NoteRefreshableSignIn`
- `internal/provider/account.go`：`codexToken` 拆出 `codexTokenRefresh(force)`（最小重构，行为不变）
- `internal/gateway/signin_revoked.go`：`noteSignIn` 增加 refreshable 分派（revoked 优先）
- 测试：`internal/gateway/codex_refresh_401_test.go`（端到端 RED 主测试 + 非 expired 401 不刷新守卫）、`internal/provider/signin_expired_test.go`（词表）
- 文档：`docs/subsystems/providers-accounts.md`、`docs/subsystems/gateway-routing.md` 各加一行

## RED/GREEN（精确）

- RED（e4ac5e87 原始代码 + 新测试）：`--- FAIL: TestCodexExpired401RefreshesLogin ... the sign-in was renewed 0 times, want once`（第二次请求仍带旧 token 再次 401）
- GREEN（修复后）：定向家族 `go test ./internal/gateway/ -run 'TestCodexExpired401RefreshesLogin|TestCodexOther401DoesntRefresh|TestRevoked|TestSignInRevoked|TestCodexRefresh|TestSubscriptionAccountsTakeOver|TestSignInRefreshableWords'` 全 PASS，exit 0

## 消融

3 个产品文件（account.go / signin_revoked.go / signin_expired.go）恢复 upstream、测试保留 → RED 复现（同上 0 次刷新）；恢复修复 → GREEN。

## 变异

1. 去掉 gateway 刷新触发 → RED（renewed 0 times）
2. 放宽为"所有 401 都刷新" → 两个守卫拦下：`TestCodexOther401DoesntRefresh`（"Incorrect API key provided" 也触发了刷新）+ `TestSignInRefreshableWords`（token_revoked / refresh_token_reused 行）
3. 去掉 401 状态门槛 → 词表拦下 403/500/429 行
   每组变异后均恢复原状。

## 矩阵

| 检查 | 结果 |
| --- | --- |
| `go test ./internal/gateway/`（全量） | ok 339.7s，exit 0 |
| `go test ./internal/provider/`（全量） | ok 80.9s，exit 0 |
| 定向测试 `-race` | ok |
| `gofmt -l`（触达文件） | 干净 |
| `go vet` darwin/linux/windows | 干净 |
| `go build` darwin/windows | OK |
| `go build ./internal/gateway/ ./internal/provider/`（GOOS=linux） | OK |

预存环境限制（如实报）：`GOOS=linux go build .` 全量二进制在本机失败于 Wails GUI 依赖（`undefined: pointer`，GTK/cgo 环境缺失），与本改动无关（改动不涉 gui/import/build tags），所触两个包 linux 编译通过。

## 产出

- Commit：`93e69010cd6625817bee674a5e2583e1028902de`（作者 ggbdpq <ggbdpq@gmail.com>）
- Patch：`0001-provider-a-401-that-says-the-token-expired-refreshes.patch`，sha256 前 16 位 `09cdd398db5830d2`
- 评论稿：`2973-comment.body.md`（英文，内嵌完整 format-patch，已校验与 .patch 文件逐字一致、中文仅存在于 patch 引用行内）

## 不确定项

1. 无真实 ChatGPT 后端：匹配措辞来自报告引文（"Your authentication token has expired. Please try refreshing it."），真实响应可能是别的 JSON 包裹形态（词表按子串匹配，两种形态都覆盖，但真实形态未验证）。
2. `token_expired` 代码一并纳入 refreshable 是推断（依据 #1793 维护者"普通 token_expired 不按吊销处理"），非本次报告实证。
3. reporter 的 pro→promax 升级是否为令牌失效诱因：未测试（报告自己也无证据，修复对成因不敏感）。
4. 强制刷新在 macOS keychain store 下的路径仅由既有 store 测试间接覆盖，新测试走 file store。
5. reporter 提到的"续期成功后应使相关认证冷却及额度缓存失效"未单独实现：本修复后认证失败只剩分钟级 backoff（无 cache 失效问题），quota 缓存既有的 staleAllowance/renewed 机制未动。
