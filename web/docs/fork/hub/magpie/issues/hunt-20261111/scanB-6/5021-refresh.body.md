Refreshed, not redesigned — the same two-commit series ([the first patch](https://github.com/yetone/magpie/issues/5021#issuecomment-6623860245) and [the rework that supersedes it](https://github.com/yetone/magpie/issues/5021#issuecomment-6625540718)), rebased onto current `upstream/main` (`10c331531`, 569 commits past `0d99261dc`, the branch's original base). Zero conflicts; the seams are the same shapes: the `BothAuthRefused`/`AuthKeyRefused` word-classifier pair in `internal/catalog/authheader.go` and `internal/provider/authheader.go` carried zero drift, and `catalog/live.go`'s growth since the last post (model naming, a Vercel preset, the relay `/v1` tester) lands in other regions of `fetchPage` — the retry hunk at line 781 re-applies as written. Upstream has not taken the fix (`git log -S TestRetryOneAuthOnKeyRefused403` empty). Patch 0001 is byte-identical to the November 9 post (same sha256); 0002's bytes shifted through line numbers alone (same hunks, same semantics).

Verification on the new base (`10c331531` + these two commits; upstream has since advanced to `a535bbf3c` — no commit on that range touches the patches' files, checked again at post time):
| Check | Result |
| --- | --- |
| `go test -tags nogui -count=1 -run 'TestRetryOneAuthOnKeyRefused403\|TestRetryOneAuth404NotLearned\|TestList404NotLearned' ./internal/provider -v` | all three PASS (1.247s) |
| same with `-race` | ok (3.160s) |
| `go test -tags nogui -count=1 ./internal/provider` | 130.4s, zero failures |
| `go test -tags nogui -count=1 ./internal/catalog` | 2.3s, zero failures |
| `go test -tags nogui -count=1 -timeout 60m ./internal/gateway` | 897.0s, zero failures |
| `gofmt -l` on the five touched files; `go vet -tags nogui ./internal/provider ./internal/catalog` | clean; clean |
| `GOOS=linux go build -tags nogui ./...`; `GOOS=windows` | ok; ok |

Ablation re-done on the new base, the mutation one condition at the semantic fork: the 403 trigger lifted out of `RetryOneAuth` (retry on explicit 401 again) → `TestRetryOneAuthOnKeyRefused403` red, and `TestRetryOneAuth404NotLearned` red too (its fixture's first leg is the same 403-then-retry chain, so it rightly feels the loss) → restored → all three green (1.071s).

**Siblings** (every reader, re-checked on the new base): the classifier pair has exactly two readers — the retry trigger in `fetchPage` (live.go:781, this series' 0002) and the pre-retry confirmation in `RetryOneAuth` (authheader.go:53) — and they compose: catalog learns from the vendor's answer, provider retries the same request once with one header. `RetryOneAuth` itself has two call chains (the provider test sender and the gateway's request path at gateway.go:6288), both through the one trigger line. `OneAuthOrder` (x-api-key first) has the two consumers the series touches and no others.

**Not verified**: a real upstream that answers Qwen-Flash's `403 {"error":{"code":"invalid_api_key"}}` — the reporter's environment; the fixtures replay the same shapes locally.

The patches below `git am` clean, in order (0001 then 0002), onto a tree at `10c331531`.

**Patch 0001**: <details><summary>authheader: a 403 that reads as an invalid key asks again with one header — git am applies it as is; SHA-256 first 16: a581dd1167fc7924</summary>

````
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 4 Nov 2026 05:38:36 +0800
Subject: [PATCH 1/2] authheader: a 403 that reads as an invalid key asks again
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


````

</details>

**Patch 0002**: <details><summary>authheader: a header a vendor doesn't take is not one that worked — git am applies it as is; SHA-256 first 16: b1ef3f07b0b39256</summary>

````
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 4 Nov 2026 15:43:43 +0800
Subject: [PATCH 2/2] authheader: a header a vendor doesn't take is not one
 that worked (#5021)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

The reporter's retest of the #5021 retry found the learn too wide: any
answer that wasn't 401/403 counted as the header working. Their vendor
answers x-api-key alone with a 404 saying the apiKey header is missing —
a header it doesn't take at all — so the retry learned x-api-key, handed
the 404 back, and every model on the provider 404'd from then on.

Only a real answer is learned now (2xx): a header the vendor doesn't
take (404) or an outage (5xx) is not, and the next header is asked
before the answer goes back.

The model list had the same two gaps: it learned on not-401/403, and it
never retried on the #5021 403 "invalid api-key" refusal at all — only
on the outright 401 — so a provider on such a vendor could not fetch its
list to begin with. It now retries on both refusals and learns only an
answer.

Fixes #5021 (reporter Jasonpetrelli's retest and 2xx narrowing; the 404
vendor shape and capture are theirs).

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/catalog/live.go             |  9 ++-
 internal/provider/authheader.go      | 11 ++--
 internal/provider/authheader_test.go | 90 ++++++++++++++++++++++++++++
 3 files changed, 102 insertions(+), 8 deletions(-)

diff --git a/internal/catalog/live.go b/internal/catalog/live.go
index 5d481665c..62d7ff6a8 100644
--- a/internal/catalog/live.go
+++ b/internal/catalog/live.go
@@ -778,13 +778,16 @@ func fetchPage(ctx context.Context, url, key string, anthropic bool, headers map
 	if err != nil {
 		return nil, false, "", err
 	}
-	if auth.learned != nil && auth.only == "" && key != "" && BothAuthRefused(res.StatusCode, b) {
-		// refused for sending both: each alone, the one taken kept
+	if auth.learned != nil && auth.only == "" && key != "" && (BothAuthRefused(res.StatusCode, b) || AuthKeyRefused(res.StatusCode, b)) {
+		// refused for sending both — outright, or read as an invalid key
+		// with no word about the headers (#5021): each alone, the one that
+		// answered kept; a header the vendor doesn't take can come as 404,
+		// so only a real answer is learned
 		for _, only := range OneAuthOrder {
 			if res, b, err = ask(only); err != nil {
 				return nil, false, "", err
 			}
-			if res.StatusCode != http.StatusUnauthorized && res.StatusCode != http.StatusForbidden {
+			if res.StatusCode >= 200 && res.StatusCode < 300 {
 				auth.learned(only)
 				break
 			}
diff --git a/internal/provider/authheader.go b/internal/provider/authheader.go
index ed169ee59..434cbbc73 100644
--- a/internal/provider/authheader.go
+++ b/internal/provider/authheader.go
@@ -37,8 +37,8 @@ func (p Provider) BothAuth() bool {
 // both x-api-key and Authorization — said outright (catalog.BothAuthRefused,
 // a 401) or read as an invalid key with no word about the headers
 // (catalog.AuthKeyRefused, a 403, #5021) — the answer to req asked again
-// with each alone, x-api-key first, and remembers for p the one it took
-// (LearnAuthHeader). do sends a request as req was sent.
+// with each alone, x-api-key first, and remembers for p the one that
+// answered (LearnAuthHeader). do sends a request as req was sent.
 func RetryOneAuth(p Provider, req *http.Request, res *http.Response, do func(*http.Request) (*http.Response, error)) (*http.Response, error) {
 	if res == nil || res.StatusCode != http.StatusUnauthorized && res.StatusCode != http.StatusForbidden || p.AuthHeader != AuthBoth || !p.BothAuth() || req.GetBody == nil {
 		return res, nil
@@ -67,10 +67,11 @@ func RetryOneAuth(p Provider, req *http.Request, res *http.Response, do func(*ht
 		if res, err = do(again); err != nil {
 			return nil, err
 		}
-		if res.StatusCode != http.StatusUnauthorized && res.StatusCode != http.StatusForbidden {
-			LearnAuthHeader(p.ID, only)
-			return res, nil
+		if res.StatusCode < 200 || res.StatusCode >= 300 {
+			continue // not an answer: a header the vendor doesn't take can come as 404 (#5021's retest), an outage as 5xx — none of these is one that worked
 		}
+		LearnAuthHeader(p.ID, only)
+		return res, nil
 	}
 	return res, nil
 }
diff --git a/internal/provider/authheader_test.go b/internal/provider/authheader_test.go
index 2c4ba72f9..9cbef5997 100644
--- a/internal/provider/authheader_test.go
+++ b/internal/provider/authheader_test.go
@@ -217,6 +217,96 @@ func TestListLearnsOneAuth(t *testing.T) {
 	}
 }
 
+// #5021's vendor, the reporter's retest: a header the vendor doesn't take
+// at all is not refused 401/403 — x-api-key alone gets a 404 saying the
+// apiKey header is missing. That is not a header that worked: it is not
+// learned, and Authorization alone is asked before the answer goes back.
+func TestRetryOneAuth404NotLearned(t *testing.T) {
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
+			w.Write([]byte(`{"message":"invalid api-key","type":"authentication_error"}`))
+			return
+		}
+		if x != "" {
+			w.WriteHeader(http.StatusNotFound)
+			w.Write([]byte(`{"success":false,"code":"AUTH_KEY_MISSING","msg":"请求头缺失 apiKey 参数"}`))
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
+	if len(got) != 3 || got[1] != [2]string{"k", ""} || got[2] != [2]string{"", "Bearer k"} {
+		t.Errorf("asked %v", got)
+	}
+	if q, _ := Find("relay"); q.AuthHeader != AuthBearer {
+		t.Fatalf("kept %q", q.AuthHeader)
+	}
+}
+
+// The model list learns the same way: a 404 to x-api-key alone is a header
+// the vendor doesn't take, not one that worked — the list goes on to
+// Authorization alone and that is what is kept.
+func TestList404NotLearned(t *testing.T) {
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
+			w.Write([]byte(`{"message":"invalid api-key","type":"authentication_error"}`))
+			return
+		}
+		if x != "" {
+			w.WriteHeader(http.StatusNotFound)
+			w.Write([]byte(`{"success":false,"code":"AUTH_KEY_MISSING","msg":"请求头缺失 apiKey 参数"}`))
+			return
+		}
+		w.Write([]byte(`{"data":[{"id":"claude-haiku-4-5"}]}`))
+	}))
+	t.Cleanup(srv.Close)
+	if err := Save(Provider{ID: "relay", Name: "Relay", Anthropic: srv.URL, Key: "k"}); err != nil {
+		t.Fatal(err)
+	}
+	p, _ := Find("relay")
+	ms, err := p.Fetch(context.Background())
+	if err != nil || len(ms) == 0 {
+		t.Fatalf("list: %v %v", ms, err)
+	}
+	mu.Lock()
+	got := append([][2]string(nil), asked...)
+	mu.Unlock()
+	if len(got) != 3 || got[1] != [2]string{"k", ""} || got[2] != [2]string{"", "Bearer k"} {
+		t.Errorf("asked %v", got)
+	}
+	if q, _ := Find("relay"); q.AuthHeader != AuthBearer {
+		t.Errorf("kept %q", q.AuthHeader)
+	}
+}
+
 // Another 401 is handed on as it came, asked once; so is a 401 to a request
 // whose Authorization is the user's own header.
 func TestRetryOneAuthOnlyOnThatRefusal(t *testing.T) {
-- 
2.50.1 (Apple Git-155)


````

</details>

Branch with the two commits: [fix/5021-both-auth-headers](https://github.com/ggbdpq/magpie/tree/fix/5021-both-auth-headers) (head `1ff97d8826a1246bc95210b96dc21adcfc2ee1ac`; authorship `ggbdpq` unchanged from the original patches).

**Attribution**: AI-written; I've read the whole diff and can answer questions on it myself. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.
