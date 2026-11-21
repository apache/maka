**Summary**

After switching the global SOCKS5 proxy from A to B and saving, a new Test still left by A: `/api/proxy/check` showed B (read live from the settings) while `through.ip` was A's exit and `proxied` was absent — `throughLeg` saw the connection going to the wrong peer and `omitempty` dropped the field. `Dispatch` follows the global proxy through `base`, whose `Proxy` (`netproxy.Func`) is consulted only when a connection is dialled; the transport pools its HTTP/2 connections by target authority, so the idle connection dialled through A was reused whatever the setting said. `Dispatch.RoundTrip` now remembers the proxy setting each request left under and closes the idle connections when it moves (base's and every provider clone's), so the request after a save dials through the proxy in force; a connection a request is still reading is left to finish.

**Verification**

| Check | Command | Result |
|---|---|---|
| New test | `go test ./internal/netproxy -run TestGlobalSwitchDropsTheOldProxyConnections` | fails on base `d7b42fcf` (0 connections through B after the switch), passes with the fix |
| Package | `go test ./internal/netproxy -count=1 -tags nogui` | ok |
| Race | `go test -race ./internal/netproxy -count=1` | ok |
| Format | `gofmt -l internal/netproxy` | no output |
| Vet | `go vet ./internal/netproxy ./internal/gui ./internal/gateway`, also under `GOOS=linux` and `GOOS=windows` | clean (the cgo enum warnings in `internal/gui` are pre-existing) |
| Build | `go build` (darwin), `GOOS=windows go build ./...`, `GOOS=linux go build ./internal/netproxy ./internal/gateway ./internal/gui` | pass; a full `GOOS=linux go build ./...` fails inside the wails dependency (`undefined: pointer`) the same way on base `d7b42fcf` without this patch |

**Red without the fix** (base `d7b42fcf`): with `internal/netproxy/netproxy.go` reverted and the new test kept:

```
--- FAIL: TestGlobalSwitchDropsTheOldProxyConnections (0.02s)
    netproxy_test.go:324: after the switch: 1 connections through A, 0 through B, want the fresh dial through B and no new one through A
```

With the fix: `ok`. The test stands up two SOCKS5 fakes and one HTTP/2 TLS server, requests through A, saves B, and asserts the next request dials through B (`internal/netproxy/netproxy_test.go`).

**Siblings**: `rg -n 'netproxy.Func|netproxy.Dispatch' --glob '!*_test.go'` — every `Dispatch` consumer gets the drop at once: the Test's `http.DefaultClient`, the gateway's upstream draws/uploads/sockets, the workbuddy config client, MCP and mcpauth, the update check, model downloads, library MCP checks. Left as they are: `internal/otlp/otel.go` (an `http.Transport` without `Dispatch`, the telemetry exporter's own) and `internal/netproxy/bridge.go` (one transport per SOCKS address for plugin CLIs, never pooled across a switch).

**When the read fails**: an unreadable settings file reads as the default `""` through `settings.Load`, so the signature counts as a move and idle connections close once — the same reading dial-time `Func` makes, so routing and the pool cannot disagree; the worst case is one extra redial.

**Not verified**: the reporter's Docker/Linux deployment end to end; a real Cloudflare trace (both legs ran against local fakes); the in-flight edge — a Test clicked while another request is still streaming through the old connection to the same host multiplexes onto it until it closes.

---
**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: fix(netproxy): a switch of the global proxy drops the old proxy's idle connections (#4523) — git am applies it as is; SHA-256 first 16: a513123deb0f6ee9</summary>

```patch
From fdb120869346db4291a72c3219cc71504189a84d Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sun, 1 Nov 2026 18:35:15 +0800
Subject: [PATCH] fix(netproxy): a switch of the global proxy drops the old
 proxy's idle connections (#4523)

What changed
- Dispatch now remembers the proxy setting each request left under and,
  when it moves, closes the idle connections it kept (base's and every
  provider clone's), so the request after a switch dials through the
  proxy in force. A transport pools by target host, and its HTTP/2
  connections by the authority alone, so until now a Test after the
  switch rode the old proxy's connection and left by the old exit while
  the new proxy was the one shown.

Run
- go test ./internal/netproxy/ -run TestGlobalSwitchDropsTheOldProxyConnections
  fails on the parent (1 connection through A, 0 through B after the
  switch), passes here; the package's full suite passes (-tags nogui).

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/netproxy/netproxy.go      | 39 +++++++++++++++++++---
 internal/netproxy/netproxy_test.go | 52 ++++++++++++++++++++++++++++++
 2 files changed, 86 insertions(+), 5 deletions(-)

diff --git a/internal/netproxy/netproxy.go b/internal/netproxy/netproxy.go
index 6fae26f3a..b32023414 100644
--- a/internal/netproxy/netproxy.go
+++ b/internal/netproxy/netproxy.go
@@ -154,11 +154,14 @@ var HTTP1 func(u *url.URL) bool
 // base kept for that proxy alone. Connections are so reused among the
 // requests going through one proxy and never carried to another — HTTP/2
 // ones, which a transport shares by host whatever proxy they were dialled
-// through, among them. A request HTTP1 names goes through a clone kept
-// for HTTP/1.1 (http1Only), and one to a host whose certificate the
-// provider's user said not to check (WithUncheckedTLS) through a clone
-// kept for that host alone (uncheckTLS). A host whose IPv6 is taken but
-// goes nowhere is dialed over IPv4 (v4Fallback).
+// through, among them. A move of the global proxy (the settings) drops
+// the idle connections the old one dialled, which a transport, pooling
+// by target host alone, would have carried over the switch (#4523). A
+// request HTTP1 names goes through a clone kept for HTTP/1.1
+// (http1Only), and one to a host whose certificate the provider's user
+// said not to check (WithUncheckedTLS) through a clone kept for that
+// host alone (uncheckTLS). A host whose IPv6 is taken but goes nowhere
+// is dialed over IPv4 (v4Fallback).
 func Dispatch(base *http.Transport) http.RoundTripper {
 	v4Fallback(base)
 	return &dispatch{base: base, own: map[route]*http.Transport{}}
@@ -168,6 +171,12 @@ type dispatch struct {
 	base *http.Transport
 	mu   sync.Mutex
 	own  map[route]*http.Transport
+	// global is the proxy setting the last request to leave saw, and
+	// seenGlobal whether any has: a move closes the idle connections,
+	// which would carry the requests after a switch through the old
+	// proxy (#4523).
+	global     string
+	seenGlobal bool
 }
 
 // route is what a request needs of its transport other than base: a
@@ -180,6 +189,9 @@ type route struct {
 }
 
 func (d *dispatch) RoundTrip(req *http.Request) (*http.Response, error) {
+	if d.globalMoved() {
+		d.CloseIdleConnections()
+	}
 	r := route{choice: choiceOf(req.Context()), h1: HTTP1 != nil && HTTP1(req.URL), unchecked: uncheckedHost(req)}
 	if r == (route{}) {
 		return v4Retry(d.base, req)
@@ -187,6 +199,23 @@ func (d *dispatch) RoundTrip(req *http.Request) (*http.Response, error) {
 	return v4Retry(d.transport(r), req)
 }
 
+// globalMoved says the proxy in magpie's settings changed since the last
+// request to leave: base follows the setting at dial time (Func), but a
+// transport pools by target host, and its HTTP/2 connections by the
+// authority alone, so a connection dialled through the old proxy carried
+// the requests after a switch too, and the Test left by the old exit
+// while the new one was shown (#4523). Dropping the idle connections
+// sends the request after it through the proxy in force; one a request
+// is still reading is left to finish. The first request sees no move.
+func (d *dispatch) globalMoved() bool {
+	now := strings.TrimSpace(settings.Load().Proxy)
+	d.mu.Lock()
+	defer d.mu.Unlock()
+	moved := d.seenGlobal && d.global != now
+	d.global, d.seenGlobal = now, true
+	return moved
+}
+
 func (d *dispatch) transport(r route) *http.Transport {
 	d.mu.Lock()
 	defer d.mu.Unlock()
diff --git a/internal/netproxy/netproxy_test.go b/internal/netproxy/netproxy_test.go
index 8cef245b3..1db81e966 100644
--- a/internal/netproxy/netproxy_test.go
+++ b/internal/netproxy/netproxy_test.go
@@ -272,3 +272,55 @@ func TestDispatchHTTP1(t *testing.T) {
 		t.Fatalf("asked\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
 	}
 }
+
+// A switch of the global proxy leaves the connections its transport kept
+// through the old one behind: an HTTP/2 connection is pooled by the
+// target's authority alone, so the request after the save rode the old
+// proxy's connection and left by the old exit while the new proxy was
+// the one shown (#4523). The dispatch closes the idle connections when
+// the setting moves, so the request after it dials through the proxy in
+// force.
+func TestGlobalSwitchDropsTheOldProxyConnections(t *testing.T) {
+	clearProxyEnv(t)
+	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "exit") }))
+	srv.EnableHTTP2 = true
+	srv.StartTLS()
+	t.Cleanup(srv.Close)
+	pool := x509.NewCertPool()
+	pool.AddCert(srv.Certificate())
+	a, na := fakeSOCKS(t, "", "")
+	b, nb := fakeSOCKS(t, "", "")
+	d := Dispatch(&http.Transport{
+		// For, not Func: the test servers live on the loopback Func skips
+		Proxy:             func(r *http.Request) (*url.URL, error) { return For(r.URL) },
+		ForceAttemptHTTP2: true,
+		TLSClientConfig:   &tls.Config{RootCAs: pool},
+	}).(*dispatch)
+	t.Cleanup(d.CloseIdleConnections)
+	c := &http.Client{Transport: d, Timeout: 10 * time.Second}
+	get := func() {
+		res, err := c.Get(srv.URL)
+		if err != nil {
+			t.Fatalf("through the proxy: %v", err)
+		}
+		io.Copy(io.Discard, res.Body)
+		res.Body.Close()
+		if res.ProtoMajor != 2 {
+			t.Fatalf("the request went over %s, want HTTP/2", res.Proto)
+		}
+	}
+	if err := settings.Save(settings.Settings{Proxy: a.String()}); err != nil {
+		t.Fatal(err)
+	}
+	get()
+	if na.Load() != 1 || nb.Load() != 0 {
+		t.Fatalf("the first request: %d connections through A, %d through B", na.Load(), nb.Load())
+	}
+	if err := settings.Save(settings.Settings{Proxy: b.String()}); err != nil {
+		t.Fatal(err)
+	}
+	get()
+	if nb.Load() != 1 || na.Load() != 1 {
+		t.Fatalf("after the switch: %d connections through A, %d through B, want the fresh dial through B and no new one through A", na.Load(), nb.Load())
+	}
+}
-- 
2.50.1 (Apple Git-155)

```

</details>

Branch with the commit: [fix/4523-socks5-stale-conn](https://github.com/ggbdpq/magpie/tree/fix/4523-socks5-stale-conn) (head `fdb120869346db4291a72c3219cc71504189a84d`).
