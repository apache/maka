provider: sub2api 面板的余额查询配上登录令牌时，令牌被原样发到只认 Key 的 /v1/usage，不像 new-api 那样被拦下并告知去处

## 现象

自定义供应商的 Balance URL 填 sub2api 面板给 key 查余额的 `/v1/usage`，又把面板的登录令牌（JWT）粘进 Balance token 字段时，magpie 把这个 JWT 当作 Authorization 原样发去 `/v1/usage`。该接口只认 API key（`keyQueryOf` 的注释：asked with the key alone），JWT 被当作无效 key 拒绝，卡片上只显示面板返回的原始 401，没有一句该改哪里。

同一形状的配置在 new-api 面板上已经被防呆拦下：Balance URL `/api/usage/token` + 访问令牌时，请求根本不发出，错误直接告知改设 `/api/user/self`（c9e47f043）。今天 ef0c515e 给两家面板补齐了反向兜底（账户查询没带令牌时改问 key 查询），但正向防呆仍然只覆盖 new-api 一家。`balanceAuthorization` 甚至已按 sub2api 的 JWT 形状发送（"a JWT (a sub2api panel's login token) as a bearer"），说明这条输入是预期内的。

## 最小复现

假面板（httptest）对带非 key Authorization 的 `/v1/usage` 一律回 401 `{"error":"invalid API key"}`：

```go
p := Provider{ID: "panel", Chat: srv.URL, Key: "sk-two",
    BalanceToken: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzIn0.sig",
    BalanceURL:   srv.URL + "/v1/usage"}
_, ok, err := Balance(context.Background(), p)
```

新增的 `TestSub2APIKeyUsageWithLoginToken` 期望「令牌从不发出、错误告知改设 `<site>/api/v1/user/profile (Balance field $data.balance)`」。在 upstream/main `6087c82b0`（发帖前最后一次 fetch 的 tip）上它红：

```
--- FAIL: TestSub2APIKeyUsageWithLoginToken (0.00s)
    zz_red_test.go:27: ok true, err 401 Unauthorized: {"error":"invalid API key"}, asked true
FAIL
```

`asked=true`：令牌确实被发出去了，错误也是面板的原文而非 magpie 的指引。同一测试在补丁上绿，且去掉令牌后 key 仍照常查询（`$remaining` 路径不受影响）。

## 根因

`internal/provider/balance.go` `balanceRead` 的守卫只认 new-api 的 key 查询：

```go
if src.token != "" && p.BalanceURL != "" && balanceURLPath(p.BalanceURL) == newAPIKeyUsage {
    return "", nil, nil, true, errKeyUsageWithToken(p.BalanceURL)
}
```

`tokenQueries` 里 sub2api 与 new-api 成对（`{sub2APIProfile, sub2APIKeyUsage, "$data.balance"}`），`/v1/usage` 配令牌与 `/api/usage/token` 配令牌结构完全相同、下场也相同（只能被拒），守卫却漏了前者。GUI 同构：`app.js` 的 `balanceFix` 警告只在 `path === "/api/usage/token"` 时出现，`balanceError` 的转述也只认 new-api 那句错误。

## 修法

- `balanceRead` 的守卫改成 switch 两个 key 查询：new-api 分支原样保留；sub2api 分支新增 `errSub2APIKeyUsageWithToken`，同形的错误告知改设 `<site>/api/v1/user/profile`（Balance field `$data.balance`）或去掉令牌只查 key。两个包装共用 `errKeyQueryWithToken`，原有 `errKeyUsageWithToken` 的对外文案一字未改（`TestKeyUsageWithAccessToken` 的断言原样通过）。
- GUI：`balanceFix` 加 `/v1/usage` 分支（提示 sub2api 用 `/api/v1/user/profile`），`balanceError` 加对应转述分支；新增 2 条字符串 × zh/zh-TW/ja/de。

## 验证

| 检查 | 结果 |
| --- | --- |
| `TestSub2APIKeyUsageWithLoginToken`（新）在 `6087c82b0` | 红：`asked true`，err 为面板原始 401 |
| 同测试 + 补丁 | 绿；去令牌后 key 查询照常（`asked=true`、走 `$remaining`） |
| `TestKeyUsageWithAccessToken`、`TestBalanceKeyAsBearer` 及 balance 系全部既有测试 | 绿（new-api 分支文案未变） |
| `go test -tags nogui -p 2 -count=1 ./internal/provider/` | ok（71.9s） |
| `go test -tags nogui -p 2 -count=1 ./internal/cli/ ./internal/gui/` | ok（25.4s / 171.6s） |
| `node --test internal/gui/tests/balance-fix.test.cjs`（chromium，含 en/zh/ja/de × 900/440 与既有 Sub2API shortcut 用例） | 49/49 |
| `node --test internal/gui/tests/i18n-keys.test.cjs` | 3/3 |
| `gofmt -l internal/`；`go vet`（darwin；GOOS=linux `-tags nogui`；GOOS=windows）provider+gui | 干净（仅 `trayimage_darwin.go` 已知 cgo 警告） |
| `go build`（darwin；GOOS=linux `-tags nogui`；GOOS=windows） | ok |

## 没跑什么

- 真实 sub2api 面板（本机无账号）：「`/v1/usage` 只认 key、JWT 必被拒」依据的是仓内注释与 `keyQueryOf`/`balanceAuthorization` 的既有语义，未对真实面板发请求。
- Playwright 只跑了 `balance-fix.test.cjs`（chromium）与 `i18n-keys.test.cjs`；webkit 本机下载未完成，webkit 半边未跑。
- `go test ./...` 全量未跑。

补丁（`git format-patch -1 --stdout`，基于 `6087c82b0`）：

<details>
<summary>patch</summary>

```patch
__PATCH__
```

</details>

分支：`hunt21-b-balance-sub2api-token`（fork 上 `ggbdpq/magpie`）。

保留作者署名请求：如采纳，请保留提交作者 `ggbdpq <ggbdpq@gmail.com>`（仓库不收外部 PR，故以 issue + patch 交付）。

Generated-by: GLM-5.3-Flash (ZCode)
