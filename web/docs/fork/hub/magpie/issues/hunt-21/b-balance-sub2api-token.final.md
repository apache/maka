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
From b94e55bf886e98173d10e3916032c51e89573151 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 14 Oct 2026 22:39:08 +0800
Subject: [PATCH] provider, gui: a login token beside sub2api's /v1/usage is
 told the panel's account query, not sent to the key's

What changed:
- balance.go: the guard that never sends a balance token to new-api's
  /api/usage/token (c9e47f043) now covers sub2api's /v1/usage too, and
  says to set <site>/api/v1/user/profile (Balance field $data.balance)
  or remove the token, as the new-api branch says its /api/user/self.
- gui: the editor's token warning (balanceFix) and the refusal wording
  (balanceError) each name sub2api's /v1/usage beside the token; two new
  strings in zh, zh-TW, ja and de.

Run:
- TestSub2APIKeyUsageWithLoginToken (new): a JWT beside /v1/usage is
  never sent there and the panel's account query is named; the key alone
  still asks. On upstream/main 2c18c697 it fails asked=true with the
  panel's raw 401 (the token went out as Authorization).
- TestKeyUsageWithAccessToken, TestBalanceKeyAsBearer and the balance
  tests unchanged; go test -tags nogui -p 2 -count=1
  ./internal/provider ok (71.9s). i18n-keys.test.cjs 3/3.
- gofmt -l clean; go vet darwin, GOOS=linux -tags nogui, GOOS=windows on
  internal/provider and internal/gui; go build darwin, GOOS=linux
  -tags nogui, GOOS=windows.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gui/assets/app.js        |  2 ++
 internal/gui/assets/i18n.js       |  8 ++++++++
 internal/provider/balance.go      | 29 ++++++++++++++++++++++++++---
 internal/provider/balance_test.go | 28 ++++++++++++++++++++++++++++
 4 files changed, 64 insertions(+), 3 deletions(-)

diff --git a/internal/gui/assets/app.js b/internal/gui/assets/app.js
index eb3b4be0..62f94b84 100644
--- a/internal/gui/assets/app.js
+++ b/internal/gui/assets/app.js
@@ -12568,6 +12568,7 @@ function balanceFieldOf(raw) {
 // knows the fix (see balance.go); "" for any other.
 function balanceError(err) {
   if (/takes the API key, not the access token/.test(err)) return t("The Balance URL …/api/usage/token takes the API key, not the access token — set it to …/api/user/self in the provider's settings");
+  if (/takes the API key, not the login token/.test(err)) return t("The Balance URL …/v1/usage takes the API key, not the login token — set it to …/api/v1/user/profile in the provider's settings");
   if (/New-Api-User/i.test(err)) return t("Add the header New-Api-User = your user ID (shown in the site's personal settings) to the provider's Headers");
   return "";
 }
@@ -12588,6 +12589,7 @@ function balanceFix(p) {
     try { path = new URL(u).pathname.replace(/\/+$/, ""); } catch {}
     let why = "";
     if (path === "/api/usage/token") why = t("…/api/usage/token takes the API key, not this token: for the account's balance, new-api uses /api/user/self; sub2api uses /api/v1/user/profile.");
+    else if (path === "/v1/usage") why = t("…/v1/usage takes the API key, not this token: for the account's balance, a sub2api panel uses /api/v1/user/profile.");
     else if (!u) why = t("The token needs a Balance URL: a new-api relay uses /api/user/self; a sub2api panel uses /api/v1/user/profile to read the account's balance.");
     if (why) {
       box.classList.add("warn");
diff --git a/internal/gui/assets/i18n.js b/internal/gui/assets/i18n.js
index 7493c4ad..9d77836c 100644
--- a/internal/gui/assets/i18n.js
+++ b/internal/gui/assets/i18n.js
@@ -2896,6 +2896,8 @@ const I18N = {
     "optional · the account's system access token": "可选 · 账户的系统访问令牌",
     "What the Balance URL is asked with in place of the key, when it wants the account's own token: a new-api relay's System Access Token, or a sub2api panel's login token (a JWT, sent as a Bearer); it is used for nothing else.": "余额接口需要账户自己的令牌时，用它代替 Key 去请求：new-api 中转站填「系统访问令牌」，sub2api 面板填登录令牌（JWT，会以 Bearer 发送）；不作他用。",
     "…/api/usage/token takes the API key, not this token: for the account's balance, new-api uses /api/user/self; sub2api uses /api/v1/user/profile.": "…/api/usage/token 只认 API Key，不认这个令牌：查账户余额时，new-api 使用 /api/user/self，sub2api 使用 /api/v1/user/profile。",
+    "…/v1/usage takes the API key, not this token: for the account's balance, a sub2api panel uses /api/v1/user/profile.": "…/v1/usage 只认 API Key，不认这个令牌：查账户余额时，sub2api 面板使用 /api/v1/user/profile。",
+    "The Balance URL …/v1/usage takes the API key, not the login token — set it to …/api/v1/user/profile in the provider's settings": "余额查询地址 …/v1/usage 只认 API Key，不认登录令牌，请在供应商设置里改为 …/api/v1/user/profile",
     "The token needs a Balance URL: a new-api relay uses /api/user/self; a sub2api panel uses /api/v1/user/profile to read the account's balance.": "令牌还需要一个余额查询地址：new-api 中转站用 /api/user/self 凭令牌查账户余额；sub2api 面板用 /api/v1/user/profile。",
     "Use {url}": "改用 {url}",
     "A new-api relay also wants the header New-Api-User = your user ID (shown in the site's personal settings): add it under Headers.": "new-api 中转站还需请求头 New-Api-User = 你的用户 ID（见站点个人设置），请在「请求头」中添加。",
@@ -7091,6 +7093,8 @@ const I18N = {
     "optional · the account's system access token": "可選 · 帳戶的系統存取權杖",
     "What the Balance URL is asked with in place of the key, when it wants the account's own token: a new-api relay's System Access Token, or a sub2api panel's login token (a JWT, sent as a Bearer); it is used for nothing else.": "餘額介面需要帳戶自己的令牌時，用它代替 Key 去請求：new-api 中轉站填「系統存取權杖」，sub2api 面板填登入令牌（JWT，會以 Bearer 傳送）；不作他用。",
     "…/api/usage/token takes the API key, not this token: for the account's balance, new-api uses /api/user/self; sub2api uses /api/v1/user/profile.": "…/api/usage/token 只認 API Key，不認這個令牌：查帳戶餘額時，new-api 使用 /api/user/self，sub2api 使用 /api/v1/user/profile。",
+    "…/v1/usage takes the API key, not this token: for the account's balance, a sub2api panel uses /api/v1/user/profile.": "…/v1/usage 只認 API Key，不認這個令牌：查帳戶餘額時，sub2api 面板使用 /api/v1/user/profile。",
+    "The Balance URL …/v1/usage takes the API key, not the login token — set it to …/api/v1/user/profile in the provider's settings": "餘額查詢位址 …/v1/usage 只認 API Key，不認登入令牌，請在供應商設定裡改為 …/api/v1/user/profile",
     "The token needs a Balance URL: a new-api relay uses /api/user/self; a sub2api panel uses /api/v1/user/profile to read the account's balance.": "令牌還需要一個餘額查詢位址：new-api 中轉站用 /api/user/self 憑令牌查帳戶餘額；sub2api 面板用 /api/v1/user/profile。",
     "Use {url}": "改用 {url}",
     "A new-api relay also wants the header New-Api-User = your user ID (shown in the site's personal settings): add it under Headers.": "new-api 中轉站還需請求頭 New-Api-User = 你的使用者 ID（見站點個人設定），請在「請求頭」中新增。",
@@ -11289,6 +11293,8 @@ const I18N = {
     "optional · the account's system access token": "任意 · アカウントのシステムアクセストークン",
     "What the Balance URL is asked with in place of the key, when it wants the account's own token: a new-api relay's System Access Token, or a sub2api panel's login token (a JWT, sent as a Bearer); it is used for nothing else.": "残高 URL がアカウント自身のトークンを求める場合に、キーの代わりに使うものです。new-api 中継サイトでは System Access Token、sub2api パネルではログイントークン（JWT、Bearer として送信）を入力します。それ以外には使いません。",
     "…/api/usage/token takes the API key, not this token: for the account's balance, new-api uses /api/user/self; sub2api uses /api/v1/user/profile.": "…/api/usage/token が受け付けるのは API キーで、このトークンではありません。アカウント残高の取得には new-api は /api/user/self、sub2api は /api/v1/user/profile を使います。",
+    "…/v1/usage takes the API key, not this token: for the account's balance, a sub2api panel uses /api/v1/user/profile.": "…/v1/usage が受け付けるのは API キーで、このトークンではありません。アカウント残高の取得には sub2api パネルでは /api/v1/user/profile を使います。",
+    "The Balance URL …/v1/usage takes the API key, not the login token — set it to …/api/v1/user/profile in the provider's settings": "残高 URL …/v1/usage が受け付けるのは API キーで、ログイントークンではありません — プロバイダの設定で …/api/v1/user/profile に変更してください",
     "The token needs a Balance URL: a new-api relay uses /api/user/self; a sub2api panel uses /api/v1/user/profile to read the account's balance.": "トークンには残高 URL が必要です。new-api 中継サイトでは /api/user/self、sub2api パネルでは /api/v1/user/profile でトークンによりアカウント残高を取得します。",
     "Use {url}": "{url} を使う",
     "A new-api relay also wants the header New-Api-User = your user ID (shown in the site's personal settings): add it under Headers.": "new-api 中継サイトではヘッダー New-Api-User = あなたのユーザー ID（サイトの個人設定に表示）も必要です。「ヘッダー」に追加してください。",
@@ -15496,6 +15502,8 @@ const I18N = {
     "optional · the account's system access token": "optional · das System-Zugriffstoken des Kontos",
     "What the Balance URL is asked with in place of the key, when it wants the account's own token: a new-api relay's System Access Token, or a sub2api panel's login token (a JWT, sent as a Bearer); it is used for nothing else.": "Damit wird die Guthaben-URL statt mit dem Schlüssel abgefragt, wenn sie das eigene Token des Kontos verlangt: das System Access Token eines new-api-Relays oder das Login-Token eines sub2api-Panels (ein JWT, als Bearer gesendet); es wird für nichts anderes verwendet.",
     "…/api/usage/token takes the API key, not this token: for the account's balance, new-api uses /api/user/self; sub2api uses /api/v1/user/profile.": "…/api/usage/token erwartet den API-Schlüssel, nicht dieses Token: Für das Kontoguthaben verwendet new-api /api/user/self und sub2api /api/v1/user/profile.",
+    "…/v1/usage takes the API key, not this token: for the account's balance, a sub2api panel uses /api/v1/user/profile.": "…/v1/usage erwartet den API-Schlüssel, nicht dieses Token: Für das Kontoguthaben verwendet ein sub2api-Panel /api/v1/user/profile.",
+    "The Balance URL …/v1/usage takes the API key, not the login token — set it to …/api/v1/user/profile in the provider's settings": "Die Guthaben-URL …/v1/usage erwartet den API-Schlüssel, nicht das Login-Token – stellen Sie sie in den Anbietereinstellungen auf …/api/v1/user/profile",
     "The token needs a Balance URL: a new-api relay uses /api/user/self; a sub2api panel uses /api/v1/user/profile to read the account's balance.": "Das Token braucht eine Guthaben-URL: Ein new-api-Relay fragt das Kontoguthaben mit dem Token unter /api/user/self ab, ein sub2api-Panel unter /api/v1/user/profile.",
     "Use {url}": "{url} verwenden",
     "A new-api relay also wants the header New-Api-User = your user ID (shown in the site's personal settings): add it under Headers.": "Ein new-api-Relay verlangt zusätzlich den Header New-Api-User = Ihre Benutzer-ID (in den persönlichen Einstellungen der Website zu sehen): Fügen Sie ihn unter „Header“ hinzu.",
diff --git a/internal/provider/balance.go b/internal/provider/balance.go
index 55437090..b8d0a705 100644
--- a/internal/provider/balance.go
+++ b/internal/provider/balance.go
@@ -206,7 +206,25 @@ func errKeyUsageWithToken(raw string) error {
 	if u, err := url.Parse(strings.TrimSpace(raw)); err == nil && u.Host != "" {
 		self = u.Scheme + "://" + u.Host + newAPIUserSelf
 	}
-	return fmt.Errorf("the Balance URL %s takes the API key, not the access token: set it to %s (Balance field %s) for the account's balance, or remove the token for the key's own", raw, self, newAPIQuotaPath)
+	return errKeyQueryWithToken(raw, self, newAPIQuotaPath, "access token")
+}
+
+// errSub2APIKeyUsageWithToken is a login token beside sub2api's query for a
+// key, which takes the key alone as new-api's does: the panel's query for
+// the account is named in its place.
+func errSub2APIKeyUsageWithToken(raw string) error {
+	profile := sub2APIProfile
+	if u, err := url.Parse(strings.TrimSpace(raw)); err == nil && u.Host != "" {
+		profile = u.Scheme + "://" + u.Host + sub2APIProfile
+	}
+	return errKeyQueryWithToken(raw, profile, "$data.balance", "login token")
+}
+
+// errKeyQueryWithToken is a balance token beside a panel's query for a key
+// (new-api's /api/usage/token, sub2api's /v1/usage), which never takes it:
+// what to name in its place is said.
+func errKeyQueryWithToken(raw, accountURL, accountField, token string) error {
+	return fmt.Errorf("the Balance URL %s takes the API key, not the %s: set it to %s (Balance field %s) for the account's balance, or remove the token for the key's own", raw, token, accountURL, accountField)
 }
 
 // balanceRefusal is what a reply of {"success":false,"message":…} says, a
@@ -1132,8 +1150,13 @@ func balanceRead(ctx context.Context, p Provider) (amount string, parts []Balanc
 	if !ok || p.Account != nil || p.Key == "" {
 		return "", nil, nil, false, nil
 	}
-	if src.token != "" && p.BalanceURL != "" && balanceURLPath(p.BalanceURL) == newAPIKeyUsage {
-		return "", nil, nil, true, errKeyUsageWithToken(p.BalanceURL)
+	if src.token != "" && p.BalanceURL != "" {
+		switch balanceURLPath(p.BalanceURL) {
+		case newAPIKeyUsage:
+			return "", nil, nil, true, errKeyUsageWithToken(p.BalanceURL)
+		case sub2APIKeyUsage:
+			return "", nil, nil, true, errSub2APIKeyUsageWithToken(p.BalanceURL)
+		}
 	}
 	req, err := http.NewRequestWithContext(ctx, http.MethodGet, withBalanceKey(src.url, p.Key, true), nil)
 	if err != nil {
diff --git a/internal/provider/balance_test.go b/internal/provider/balance_test.go
index 673c9e32..99351777 100644
--- a/internal/provider/balance_test.go
+++ b/internal/provider/balance_test.go
@@ -358,6 +358,34 @@ func TestKeyUsageWithAccessToken(t *testing.T) {
 	}
 }
 
+// A login token beside sub2api's /v1/usage, which takes only the key, is
+// never sent there either: the panel's query for the account is named in
+// its place, as new-api's is above.
+func TestSub2APIKeyUsageWithLoginToken(t *testing.T) {
+	asked := false
+	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		asked = true
+		w.WriteHeader(http.StatusUnauthorized)
+		w.Write([]byte(`{"error":"invalid API key"}`))
+	}))
+	defer srv.Close()
+	p := Provider{ID: "panel", Chat: srv.URL, Key: "sk-two",
+		BalanceToken: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzIn0.sig",
+		BalanceURL:   srv.URL + "/v1/usage"}
+	_, ok, err := Balance(context.Background(), p)
+	if !ok || err == nil || asked {
+		t.Fatalf("ok %v, err %v, asked %v", ok, err, asked)
+	}
+	if want := srv.URL + "/api/v1/user/profile (Balance field $data.balance)"; !strings.Contains(err.Error(), want) || !strings.Contains(err.Error(), "takes the API key, not the login token") {
+		t.Fatalf("err = %v", err)
+	}
+	// the key alone still asks it
+	p.BalanceToken = ""
+	if _, _, err := Balance(context.Background(), p); !asked || err == nil {
+		t.Fatalf("without the token: asked %v, err %v", asked, err)
+	}
+}
+
 // new-api's /api/user/self with its field left out reads the quota as
 // new-api counts it, $1 to 500000.
 func TestUserSelfDefaultField(t *testing.T) {
-- 
2.50.1 (Apple Git-155)
```

</details>

分支：`hunt21-b-balance-sub2api-token`（fork 上 `ggbdpq/magpie`）。

保留作者署名请求：如采纳，请保留提交作者 `ggbdpq <ggbdpq@gmail.com>`（仓库不收外部 PR，故以 issue + patch 交付）。

Generated-by: GLM-5.3-Flash (ZCode)
