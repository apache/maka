Diagnosed from the code path, and it matches the report's three-row table exactly. `corsGuard` (internal/gateway/cors.go) sits inside `Handler`, and `lanGuard` sits in front of it (`Front`, internal/gateway/oneport.go). So a request that reaches the gateway from another machine — direct on the LAN, or through a reverse proxy, whose forwarding header (`X-Forwarded-For` and friends) makes it count as remote from loopback too — met `lanGuard`'s key check first: while the gateway is shared (or listens on the network), `identifyCaller` refused the keyless preflight 401 with "no API key was sent …" before `corsGuard` could see it, and with no CORS headers on the answer the browser logged `PreflightMissingAllowOriginHeader`. On loopback `lanGuard` asks no key, which is why the same preflight was answered 204 there — the whitelist itself was working all along.

A preflight is an OPTIONS that declares the call to come, and per what CORS asks of it carries no key and no body: the browser cannot send one, so it could never pass a key check.

`lanGuard` now hands a preflight (an OPTIONS with an Origin and an `Access-Control-Request-Method`) to `corsGuard` instead, after the allow list and the shared/on-network rules have judged it, as they judge every request. `corsGuard` answers a listed origin's with its 204 and headers and refuses any other page's with no CORS headers, as on loopback. The call the preflight asks after still needs an enabled gateway key; an OPTIONS that declares no call is no preflight; and while magpie isn't shared, a preflight from another machine is refused like everything else. `magpie web`'s page port, which hands client routes to the same `Front`, is covered by the same change.

The new test reproduces the report's table at the `lanGuard(Handler())` seam (httptest, both entries):

| Check | Result |
| --- | --- |
| new `TestCORSPreflightFromLAN` | red before the fix — LAN-direct and reverse-proxy (X-Forwarded-For) rows 401 with the report's own error body, loopback row green; green after; product files reverted alone (test kept, base a3768cdd1) → red again |
| the report's three rows in the test | loopback 204 + Allow-Origin/Allow-Headers; LAN 204; proxied 204 — plus an unlisted origin's preflight refused with no headers, a keyless GET and a plain OPTIONS from the LAN still 401, a preflight while not shared still refused |
| `go test -tags nogui` CORS/LAN family (`TestCORS*`, `TestLAN*`, `TestForeignPages…`, `TestOpaqueOrigin…`, `TestLocalhostSubdomain…`, `TestRebound…`, `TestOnePort…`, `TestFront…`) | ok |
| the same family with `-race` | ok |
| `go test -count=1 -timeout 50m -tags nogui ./internal/gateway` | every test ok except `TestCodexPoolSaysTheClientsVersion`, the known #4807 in a full package run (passes run alone at this head) |
| `go test -tags nogui ./internal/access ./internal/settings .` | ok |
| `./internal/gui` full | `TestProxyCheckSaysAProxyPassedBy` fails, and fails the same way run alone on the untouched base a3768cdd1 — this machine's environment (it drives `checkProxy`'s ALL_PROXY walk, nothing of the gateway) |
| `gofmt -l` on the three touched files; `go vet ./...` (darwin), `GOOS=linux go vet -tags nogui ./...`, `GOOS=windows go vet ./...` | clean (the darwin cgo enum-conversion warnings in internal/gui are pre-existing) |
| `go build .` darwin / linux / windows (`-tags nogui`) | ok |

**Not verified on real hardware:** a real Trancy page against a real LAN address and a real Nginx Proxy Manager install — the report's LAN and proxy rows are taken from its measured curl and browser evidence, and are reproduced here with httptest at the same seam instead. A browser-side retest of the report's "add custom engine" flow is still worth doing.

**Patch** (`git am` applies it as is; SHA-256 first 16: `279aba6eb4307807`):

<details><summary>patch: gateway: a browser's CORS preflight from another machine is answered, not asked for a key (#4931)</summary>

```patch
From 323210d7c1f90522fb78a11d38ab73ac03a0b68a Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Tue, 3 Nov 2026 00:19:09 +0800
Subject: [PATCH] gateway: a browser's CORS preflight from another machine is
 answered, not asked for a key (#4931)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

From the report (magpie 0.1.2698, macOS 27.0.1, LAN sharing on, gateway
port 3425): a page at https://learn.trancy.org, listed in Settings ->
Network and sharing -> Web pages, failed to add itself as a custom
engine ("Failed to fetch"). The same OPTIONS preflight for /v1/models,
declaring GET and the authorization header with no key on it, was
answered 204 with the CORS headers at http://127.0.0.1:3425 and refused
401 with no CORS headers at the machine's LAN address and behind an
HTTPS reverse proxy (Nginx Proxy Manager, no CORS handling of its own);
the browser logged net::ERR_FAILED,
corsError: PreflightMissingAllowOriginHeader, and gave up before the
keyed POST. The 401 body was the gateway's own "no API key was sent:
send a magpie gateway key as Authorization: Bearer <key> (or
x-api-key)".

lanGuard sits in front of Handler (Front, oneport.go), and corsGuard is
inside Handler, so a request from another machine met the key check
first: with the gateway shared (or listening on the network),
identifyCaller refused the keyless preflight 401 before corsGuard could
see it. On loopback lanGuard asks no key, which is why the same
preflight was answered there. A preflight is an OPTIONS that declares
the call to come, and per what CORS asks of it carries no key and no
body: the browser cannot send one.

lanGuard now hands a preflight (corsPreflight: an OPTIONS with an
Origin and an Access-Control-Request-Method) to corsGuard instead,
after the allow list and the shared/on-network rules have judged it as
they judge every request. corsGuard answers a listed origin's with its
204 and headers and refuses any other page's as on loopback; the call
the preflight asks after still needs an enabled gateway key, and an
OPTIONS that declares no call is no preflight. `magpie web`'s page
port, which hands client routes to the same Front, is covered by the
same change.

Tests (internal/gateway/cors_test.go), from the report's three-row
table:
- TestCORSPreflightFromLAN: the loopback preflight answered 204 (the
  row that already worked), the LAN-direct one and the reverse-proxy
  one (X-Forwarded-For, loopback peer) answered 204 with Allow-Origin
  and Allow-Headers; an unlisted origin's preflight refused with no
  CORS headers; a keyless GET and a plain OPTIONS from the LAN still
  401; a preflight while magpie isn't shared still refused.

Broken by hand (the preflight handoff taken back out of lanGuard): the
LAN-direct and reverse-proxy rows go red, 401 with the report's own
error body, while the loopback row stays green; restored, ok.

Run (macOS arm64, this tree, -tags nogui):
- go test -run 'TestCORS|TestLAN|TestForeignPages|TestOpaqueOrigin|
  TestLocalhostSubdomain|TestRebound|TestOnePort|TestFront'
  ./internal/gateway: ok.
- the same with -race: ok.
- go vet ./internal/gateway, and with GOOS=linux and GOOS=windows: ok.
- go build . with GOOS=darwin, GOOS=linux and GOOS=windows: ok (the
  darwin cgo enum-conversion warnings in internal/gui are pre-existing).
- gofmt -l on the three touched files: clean.
- go test -count=1 -timeout 50m -tags nogui ./internal/gateway: every
  test ok except TestCodexPoolSaysTheClientsVersion, the known #4807
  (another test's Codex identity reaches it in a full package run); it
  passes run alone at this head.
- go test -tags nogui -count=1 ./internal/access ./internal/settings .:
  ok. ./internal/gui: TestProxyCheckSaysAProxyPassedBy fails, and fails
  the same way run alone on the untouched base a3768cdd1 — this
  machine's environment, not this change (the test drives checkProxy's
  ALL_PROXY walk, nothing of the gateway).

Not tried: a real Trancy page against a real LAN address and a real
Nginx Proxy Manager install; the report's LAN and proxy rows are taken
from its measured curl and browser evidence, and reproduced here at the
lanGuard/corsGuard seam with httptest instead. A preflight arriving
while magpie isn't shared is still refused, so the browser reports the
preflight, not the later call, as the failure — the network's rules
come first, as the report asks.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/cors.go      | 11 ++++-
 internal/gateway/cors_test.go | 82 +++++++++++++++++++++++++++++++++++
 internal/gateway/lan.go       | 12 +++++
 3 files changed, 104 insertions(+), 1 deletion(-)

diff --git a/internal/gateway/cors.go b/internal/gateway/cors.go
index 75a7b932e..94bbccbd1 100644
--- a/internal/gateway/cors.go
+++ b/internal/gateway/cors.go
@@ -67,7 +67,7 @@ func corsGuard(next http.Handler) http.Handler {
 		h.Set("Access-Control-Allow-Origin", origin)
 		h.Add("Access-Control-Expose-Headers", SessionHeader)
 		h.Add("Vary", "Origin")
-		if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != "" {
+		if corsPreflight(r) {
 			h.Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
 			if asked := corsHeaders(r.Header.Get("Access-Control-Request-Headers")); asked != "" {
 				h.Set("Access-Control-Allow-Headers", asked)
@@ -207,6 +207,15 @@ func corsAllowed(origin string) bool {
 	return err == nil && len(o) == 1 && slices.Contains(list, o[0])
 }
 
+// corsPreflight: r is a browser's CORS preflight, an OPTIONS that
+// declares the actual call to come. A browser puts no key on one —
+// neither an Origin-headered one on the headers it asks for — which is
+// why lanGuard passes one to this file's guard before asking for a key
+// (#4931).
+func corsPreflight(r *http.Request) bool {
+	return r.Method == http.MethodOptions && r.Header.Get("Origin") != "" && r.Header.Get("Access-Control-Request-Method") != ""
+}
+
 // corsHeaders is a preflight's Access-Control-Request-Headers as the
 // answer allows them: the header names asked for, nothing else.
 func corsHeaders(asked string) string {
diff --git a/internal/gateway/cors_test.go b/internal/gateway/cors_test.go
index 9b2d0739e..06a971372 100644
--- a/internal/gateway/cors_test.go
+++ b/internal/gateway/cors_test.go
@@ -614,3 +614,85 @@ func TestCORSExtensionOrigin(t *testing.T) {
 		t.Errorf("another extension: %d %v", w.Code, w.Header())
 	}
 }
+
+// A preflight that reaches the gateway from another machine was refused
+// 401 for the key a preflight may not carry (#4931: the same preflight
+// for a listed origin was answered 204 on loopback and 401, with no CORS
+// headers, on the LAN address and behind an HTTPS reverse proxy, whose
+// forwarding header makes it remote from loopback too — a browser
+// reports it as PreflightMissingAllowOriginHeader and the page's fetch
+// fails). lanGuard now hands a preflight to corsGuard, which answers a
+// listed origin's and refuses any other page's, while the call it asks
+// after still needs the key, and the network's rules (the allow list,
+// sharing on the LAN) are judged first, as for every request.
+func TestCORSPreflightFromLAN(t *testing.T) {
+	fresh(t)
+	s := settings.Load()
+	s.CORSOrigins = []string{"https://learn.trancy.org"}
+	s.LAN = true
+	if err := settings.Save(s); err != nil {
+		t.Fatal(err)
+	}
+	srv := lanGuard(New().Handler())
+	do := func(remote, host, method, origin, key string, hdr map[string]string) *httptest.ResponseRecorder {
+		t.Helper()
+		r := httptest.NewRequest(method, "/v1/models", nil)
+		r.RemoteAddr = remote
+		r.Host = host
+		if origin != "" {
+			r.Header.Set("Origin", origin)
+		}
+		if key != "" {
+			r.Header.Set("Authorization", "Bearer "+key)
+		}
+		for k, v := range hdr {
+			r.Header.Set(k, v)
+		}
+		w := httptest.NewRecorder()
+		srv.ServeHTTP(w, r)
+		return w
+	}
+	pf := map[string]string{"Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization"}
+	const trancy = "https://learn.trancy.org"
+	const lan = "192.168.1.9:50123"
+	const lanHost = "192.168.1.5:3425"
+
+	// the issue's first row: on loopback the preflight was answered
+	if w := do("127.0.0.1:50123", "127.0.0.1:3425", "OPTIONS", trancy, "", pf); w.Code != http.StatusNoContent ||
+		w.Header().Get("Access-Control-Allow-Origin") != trancy || w.Header().Get("Access-Control-Allow-Headers") != "authorization" {
+		t.Errorf("loopback preflight: %d %v", w.Code, w.Header())
+	}
+	// direct on the LAN: was 401, with no CORS headers
+	if w := do(lan, lanHost, "OPTIONS", trancy, "", pf); w.Code != http.StatusNoContent ||
+		w.Header().Get("Access-Control-Allow-Origin") != trancy || w.Header().Get("Access-Control-Allow-Headers") != "authorization" {
+		t.Errorf("LAN preflight: %d %v", w.Code, w.Header())
+	}
+	// behind a reverse proxy that forwards with a header (nginx): was 401
+	if w := do("127.0.0.1:50123", "magpie.example.com", "OPTIONS", trancy, "",
+		map[string]string{"Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization", "X-Forwarded-For": "203.0.113.7"}); w.Code != http.StatusNoContent ||
+		w.Header().Get("Access-Control-Allow-Origin") != trancy {
+		t.Errorf("proxied preflight: %d %v", w.Code, w.Header())
+	}
+
+	// a page not listed is refused, as on loopback: no 204, no headers
+	if w := do(lan, lanHost, "OPTIONS", "https://evil.example", "", pf); w.Header().Get("Access-Control-Allow-Origin") != "" || w.Code == http.StatusNoContent {
+		t.Errorf("unlisted origin's preflight: %d %v", w.Code, w.Header())
+	}
+	// the call the preflight asks after still needs the key
+	if w := do(lan, lanHost, "GET", trancy, "", nil); w.Code != http.StatusUnauthorized {
+		t.Errorf("keyless call from the LAN: %d", w.Code)
+	}
+	// an OPTIONS that declares no call is no preflight
+	if w := do(lan, lanHost, "OPTIONS", trancy, "", nil); w.Code != http.StatusUnauthorized {
+		t.Errorf("plain OPTIONS from the LAN: %d", w.Code)
+	}
+	// and while magpie isn't shared, the network's rules refuse a
+	// preflight as they refuse everything else from another machine
+	s.LAN = false
+	if err := settings.Save(s); err != nil {
+		t.Fatal(err)
+	}
+	if w := do(lan, lanHost, "OPTIONS", trancy, "", pf); w.Code == http.StatusNoContent || w.Header().Get("Access-Control-Allow-Origin") != "" {
+		t.Errorf("preflight while not shared: %d %v", w.Code, w.Header())
+	}
+}
diff --git a/internal/gateway/lan.go b/internal/gateway/lan.go
index 90a270b27..42f839ca2 100644
--- a/internal/gateway/lan.go
+++ b/internal/gateway/lan.go
@@ -368,6 +368,18 @@ func lanGuard(next http.Handler) http.Handler {
 			http.Error(w, "magpie isn't shared on the local network", http.StatusForbidden)
 			return
 		}
+		// a browser's preflight carries no key, and CORS forbids putting
+		// one on it: it could never pass the key check below, so corsGuard,
+		// next, answers it instead — a listed origin's (204 and the
+		// headers), any other page refused as on loopback — while the call
+		// it asks after still needs the key (#4931: a preflight from
+		// another machine, direct on the LAN or behind a reverse proxy,
+		// was refused 401 for the key it may not carry, and the browser
+		// gave up before the keyed call)
+		if remote && corsPreflight(r) {
+			next.ServeHTTP(w, r)
+			return
+		}
 		// the key page itself is the same bytes for everyone, so it is
 		// opened before the key it asks for is typed; its data isn't
 		if remote && keyPageOpen(r) {
-- 
2.50.1 (Apple Git-155)
```

</details>

Branch with the commit: [fix/4931-cors-options-lan](https://github.com/ggbdpq/magpie/tree/fix/4931-cors-options-lan) (head `323210d7c1f90522fb78a11d38ab73ac03a0b68a`).

Attribution: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>.`
