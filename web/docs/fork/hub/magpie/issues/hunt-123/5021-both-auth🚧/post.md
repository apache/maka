**What's wrong**

On a third-party Anthropic-compatible endpoint, `Qwen-Flash` always 403'd `invalid api-key` through magpie while `Deepseek-Flash` worked — and the same key, same model, passed **directly**. The captured difference: magpie sends the key in **both** `x-api-key` and `Authorization: Bearer` on Anthropic endpoints by default, and this vendor answers the pair with a bare 403 saying the key itself is invalid — no word about the headers. Credit @Jasonpetrelli for the capture, the per-model A/B, and the working workaround.

**Root cause**

magpie already handles the both-headers refusal — but only when the vendor **says so**: `RetryOneAuth` enters on a **401** whose body names both headers (`catalog.BothAuthRefused`), asks again with each alone, and learns the one taken. A vendor whose refusal never names them (`403 invalid api-key` — the pair reads as two keys, neither valid) never triggers the second ask, so the model stayed unreachable on the Anthropic endpoint while the same key served fine on the vendor's Chat endpoint (`provider test` answered OK, as the report notes, because that asks Chat).

**The fix** (3 files, +93/−5)

`catalog.AuthKeyRefused` — a 403 whose body says the api-key itself is invalid (`invalid api-key` / `invalid api key` / `invalid_api_key` / `invalid x-api-key` / `invalid key` / the CJK shape) — joins the 401 as a retry trigger; `RetryOneAuth`'s door widens to accept it. Everything downstream is unchanged: ask again with `x-api-key` alone first, then `Authorization`, learn the one that passes (`LearnAuthHeader` skips a pick of the user's), and a 403 that says nothing of the key goes as it came. The editor's existing Both/x-api-key/bearer picker remains the manual override.

**Verification**

| Check | Result |
| --- | --- |
| New `TestRetryOneAuthOnKeyRefused403` (vendor 403s both with the report's body → retry `x-api-key` alone → ok, learned, kept) | ok — asked exactly twice, `AuthHeader` kept `x-api-key` |
| Negative in the same test (a 403 `region not served`) | handed on as it came, asked once |
| Ablation (product files back at the parent, tests kept) | red — the try fails with `relay: invalid api-key` 403 (the report's error verbatim); restore, ok |
| The whole auth family (`TestRetryOneAuth*`, `TestBothAuthRefused`, `TestAuthHeaderChoice`, `TestListLearnsOneAuth` — the 401 paths and their learnings unchanged) | ok |
| `go test -tags nogui ./internal/provider/` full package | ok (101.8s) |
| `-race` on the auth tests, `gofmt -l`, `go vet -tags nogui`, `go build ./...` | ok / clean / clean (the trayimage cgo warning is #4821's, as on main) / ok |

<details><summary>patch: authheader: a 403 that reads as an invalid key asks again with one header (#5021) — git am applies it as is; SHA-256 first 16: a6093f55091ee5de</summary>

```patch
From 49950cb62e24180d9980f9ba0540c56c55fb5106 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 4 Nov 2026 05:38:36 +0800
Subject: [PATCH] authheader: a 403 that reads as an invalid key asks again
 with one header (#5021)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

A vendor that takes one auth header alone can answer a request carrying
both with a bare 403 "invalid api-key" — no word about the headers
(Jasonpetrelli: Qwen-Flash 403 with both, 200 with Authorization alone;
Deepseek-Flash 200 either way). The retry entered on a 401 naming both
headers, so a vendor whose refusal never names them never got the second
ask, and the model stayed unreachable on the Anthropic endpoint while
the same key passed on Chat.

AuthKeyRefused reads that shape (403, the body saying the api-key
itself is invalid) and RetryOneAuth asks again with each alone beside
the 401 branch; the learning pipeline is unchanged, and a 403 that says
nothing of the key goes as it came.

Tests: TestRetryOneAuthOnKeyRefused403 (vendor 403s both -> retry
x-api-key -> ok and kept; a region 403 goes as it came, asked once),
TestAuthKeyRefused (the word shapes, and 401s or other 403s not told).

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/catalog/authheader.go       | 21 +++++++++
 internal/provider/authheader.go      | 12 ++---
 internal/provider/authheader_test.go | 65 ++++++++++++++++++++++++++++
 3 files changed, 93 insertions(+), 5 deletions(-)

diff --git a/internal/catalog/authheader.go b/internal/catalog/authheader.go
index 1ac73fe87..01a3d2d43 100644
--- a/internal/catalog/authheader.go
+++ b/internal/catalog/authheader.go
@@ -41,6 +41,27 @@ func BothAuthRefused(status int, body []byte) bool {
 	return false
 }
 
+// AuthKeyRefused is a 403 whose body says the api-key itself is invalid.
+// A vendor that takes one auth header alone can answer a request carrying
+// both this way — the pair reads as two keys, neither valid — without a
+// word about the headers (Jasonpetrelli, #5021: 403 "invalid api-key" with
+// both, 200 with Authorization alone).
+func AuthKeyRefused(status int, body []byte) bool {
+	if status != http.StatusForbidden {
+		return false
+	}
+	b := bytes.ToLower(body)
+	for _, s := range []string{
+		"invalid api-key", "invalid api key", "invalid_api_key",
+		"invalid x-api-key", "invalid key", "无效的 api",
+	} {
+		if bytes.Contains(b, []byte(s)) {
+			return true
+		}
+	}
+	return false
+}
+
 // OneAuth leaves h with the key in the one header only names: x-api-key
 // alone, or Authorization alone.
 func OneAuth(h http.Header, only string) {
diff --git a/internal/provider/authheader.go b/internal/provider/authheader.go
index 279c7d230..ed169ee59 100644
--- a/internal/provider/authheader.go
+++ b/internal/provider/authheader.go
@@ -34,11 +34,13 @@ func (p Provider) BothAuth() bool {
 
 // RetryOneAuth hands on res, the answer to req, which p signed for its
 // Anthropic API; or, when the vendor refused it for carrying the key in
-// both x-api-key and Authorization (catalog.BothAuthRefused), the answer to
-// req asked again with each alone, x-api-key first, and remembers for p the
-// one it took (LearnAuthHeader). do sends a request as req was sent.
+// both x-api-key and Authorization — said outright (catalog.BothAuthRefused,
+// a 401) or read as an invalid key with no word about the headers
+// (catalog.AuthKeyRefused, a 403, #5021) — the answer to req asked again
+// with each alone, x-api-key first, and remembers for p the one it took
+// (LearnAuthHeader). do sends a request as req was sent.
 func RetryOneAuth(p Provider, req *http.Request, res *http.Response, do func(*http.Request) (*http.Response, error)) (*http.Response, error) {
-	if res == nil || res.StatusCode != http.StatusUnauthorized || p.AuthHeader != AuthBoth || !p.BothAuth() || req.GetBody == nil {
+	if res == nil || res.StatusCode != http.StatusUnauthorized && res.StatusCode != http.StatusForbidden || p.AuthHeader != AuthBoth || !p.BothAuth() || req.GetBody == nil {
 		return res, nil
 	}
 	// the user's own Authorization or x-api-key (Headers) is theirs
@@ -48,7 +50,7 @@ func RetryOneAuth(p Provider, req *http.Request, res *http.Response, do func(*ht
 	b, _ := io.ReadAll(io.LimitReader(res.Body, 64<<10))
 	res.Body.Close()
 	res.Body = io.NopCloser(bytes.NewReader(b))
-	if !catalog.BothAuthRefused(res.StatusCode, b) {
+	if !catalog.BothAuthRefused(res.StatusCode, b) && !catalog.AuthKeyRefused(res.StatusCode, b) {
 		return res, nil
 	}
 	for i, only := range catalog.OneAuthOrder {
diff --git a/internal/provider/authheader_test.go b/internal/provider/authheader_test.go
index bfb2857b9..2c4ba72f9 100644
--- a/internal/provider/authheader_test.go
+++ b/internal/provider/authheader_test.go
@@ -248,3 +248,68 @@ func TestRetryOneAuthOnlyOnThatRefusal(t *testing.T) {
 		t.Errorf("own header asked %v", got)
 	}
 }
+
+// #5021 (Jasonpetrelli): a vendor that takes one auth header alone can
+// answer a request carrying both with a bare 403 "invalid api-key" — no
+// word about the headers. Asked again with x-api-key alone it passes, and
+// that is kept; a 403 that says nothing of the key is handed on as it came.
+func TestRetryOneAuthOnKeyRefused403(t *testing.T) {
+	azureHome(t)
+	var mu sync.Mutex
+	var asked [][2]string
+	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		x, a := r.Header.Get("x-api-key"), r.Header.Get("Authorization")
+		mu.Lock()
+		asked = append(asked, [2]string{x, a})
+		mu.Unlock()
+		if x != "" && a != "" {
+			w.WriteHeader(http.StatusForbidden)
+			w.Write([]byte(`{"error":{"message":"relay: invalid api-key","type":"permission_error"}}`))
+			return
+		}
+		w.Header().Set("Content-Type", "application/json")
+		w.Write([]byte(`{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"text","text":"hi"}]}`))
+	}))
+	t.Cleanup(srv.Close)
+	if err := Save(Provider{ID: "relay", Name: "Relay", Anthropic: srv.URL, Key: "k", Models: []string{"claude-haiku-4-5"}}); err != nil {
+		t.Fatal(err)
+	}
+	p, _ := Find("relay")
+	rs := p.TestModels(context.Background(), []string{"claude-haiku-4-5"})
+	if len(rs) != 1 || !rs[0].OK {
+		t.Fatalf("test: %+v", rs)
+	}
+	mu.Lock()
+	got := append([][2]string(nil), asked...)
+	mu.Unlock()
+	if len(got) != 2 || got[0] != [2]string{"k", "Bearer k"} || got[1] != [2]string{"k", ""} {
+		t.Errorf("asked %v", got)
+	}
+	if q, _ := Find("relay"); q.AuthHeader != AuthXAPIKey {
+		t.Fatalf("kept %q", q.AuthHeader)
+	}
+
+	// a 403 that says nothing of the key goes as it came, asked once
+	var mu2 sync.Mutex
+	var asked2 [][2]string
+	srv2 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		x, a := r.Header.Get("x-api-key"), r.Header.Get("Authorization")
+		mu2.Lock()
+		asked2 = append(asked2, [2]string{x, a})
+		mu2.Unlock()
+		w.WriteHeader(http.StatusForbidden)
+		w.Write([]byte(`{"error":{"message":"region not served"}}`))
+	}))
+	t.Cleanup(srv2.Close)
+	if err := Save(Provider{ID: "relay2", Name: "Relay2", Anthropic: srv2.URL, Key: "k", Models: []string{"claude-haiku-4-5"}}); err != nil {
+		t.Fatal(err)
+	}
+	q, _ := Find("relay2")
+	q.TestModels(context.Background(), []string{"claude-haiku-4-5"})
+	mu2.Lock()
+	got2 := asked2
+	mu2.Unlock()
+	if len(got2) != 1 {
+		t.Errorf("region 403 asked %v", got2)
+	}
+}
-- 
2.50.1 (Apple Git-155)
```

</details>

**Branch with the commit**: [fix/5021-both-auth-headers](https://github.com/ggbdpq/magpie/tree/fix/5021-both-auth-headers) (head `49950cb62e24180d9980f9ba0540c56c55fb5106`).

**Not verified:** against the reporter's actual gateway (an internal one, not shareable) — the retry behavior is proven against a served fake with the captured 403 body; whether their vendor answers `x-api-key` alone with 200 (vs only `Authorization`, which the order tries second and also learns) is their one remaining observation, and either landing works with the same patch.

**Attribution**: AI-written (GLM-5.3-Flash via ZCode); I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.
