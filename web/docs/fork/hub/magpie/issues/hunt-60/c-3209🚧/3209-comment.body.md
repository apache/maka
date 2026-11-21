Told onto the gateway's own address, the page now goes beside it and the gateway serves: `/v1/chat/completions`, `/v1/messages` and `/v1/models` answer the catalog, not the sign-in page.

**Summary**

`StartWeb` binds the page before the backend reaches `serveGateway`, and there `gateway.ServedBy` finds no magpie answering and `gateway.Taken` — a bare TCP dial to the gateway's URL — finds the port held: by this very process's page listener. Taken for another magpie's, the gateway is skipped, and the watch asks again every 15 seconds for as long as the process lives, so it never serves: nothing errors, and the one log line reads as if another magpie were involved. One correction to the report's frame: the stock page address has been `127.0.0.1:3430`, beside the gateway, since `magpie web` began (#102), so the broken case needs the page told onto the gateway's port — `--addr 127.0.0.1:3425` as in the reproduction, `magpie serve --web=<gateway addr>`, or `MAGPIE_ADDR` on 3430 with the default page address, which breaks with no flag at all.

**What changed**

`StartWeb` now listens through `webListen`, which moves the page beside the gateway when it is told onto the gateway's port on hosts both listeners would take: the same host on the page's usual port (`WebAddr`, 3430, which `magpie web`'s own default now shares as one definition), or, that taken or the gateway's port too, on a free port of the page's own — and one log line says where the page went and why. The gateway keeps its address, the agents' base URL; `gateway.Taken` itself is untouched, and a port it finds held is now always someone else's: a real second magpie on the port is still waited for and taken over from, exactly as before (`TestGatewayTakenOver`, `TestGatewayNotServedBesideASlowOne` both still green). Of the report's three directions, skipping `Taken` for the process's own listener alone could not work — the gateway's own bind would then fail against the page for as long as it lives — so the self-listener is kept out of the probe's road instead, before the page ever binds; the better log alone left the deadlock; and the retry already existed (the 15-second watch), only against a holder that never goes away.

**The test**

`TestWebOnTheGatewaysOwnAddress`, new, on the takeover tests' harness: a free port becomes `MAGPIE_ADDR`, the page is started onto it as `StartWeb` is given it, and the test asks the gateway's `/` for the catalog the report shows (`"apis"`) and the page's link for its key trade. At this fix's parent it is red, with the log the report quotes word for word ("is taken but doesn't answer as magpie yet") against the page's own listener; at this head it is green.

**Verification**

| Check | Result |
| --- | --- |
| `TestWebOnTheGatewaysOwnAddress` (new) | green; red at the fix's parent, the report's log word for word |
| The fix reverted at the tree, then restored | red again, then green |
| `TestGatewayTakenOver`, `TestGatewayNotServedBesideASlowOne` | green |
| `go test -tags nogui ./internal/cli` | ok |
| `go test -tags nogui ./internal/gui` | ok but `TestProxyCheckSaysAProxyPassedBy`, red at the parent too |
| `gofmt -l` | clean |
| `go vet ./...`; `GOOS=linux go vet -tags nogui ./...`; `GOOS=windows go vet -tags nogui ./...` | exit 0 (a pre-existing cgo enum warning in `trayimage_darwin.go`, at the parent too) |
| `go build -tags nogui`, darwin, linux/amd64, windows/amd64 | exit 0 |

**Not verified**

No browser was driven here: the test speaks to the real page and gateway servers over loopback, which is the agents' road, but the reporter's click-through on Windows is not reproduced. `magpie serve --web=<gateway addr>` and the `MAGPIE_ADDR`-on-3430 case take the same `StartWeb` path the test drives, but neither is run end to end here. A page deliberately wanted at the gateway's address (say behind a reverse proxy naming that port) now starts beside it instead — the log says so — since one port cannot hold both listeners; such a setup had the gateway dark before either way.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: web: a page told onto the gateway's own address goes beside it, and the gateway serves (#3209) — git am applies it as is; SHA-256 first 16: 3701f5bc5fa7f100</summary>

```patch
From ced737100a5b5aa6a9fe53c37549fa7ef0f217e7 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Thu, 22 Oct 2026 06:16:57 +0800
Subject: [PATCH] web: a page told onto the gateway's own address goes beside
 it, and the gateway serves
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

`magpie web --gateway --addr 127.0.0.1:3425` — the gateway's own
address — never served the gateway (#3209): StartWeb binds the page
before the backend reaches serveGateway, and there gateway.ServedBy
finds no magpie and gateway.Taken finds the port held — by this very
process's page listener. Taken for another magpie's, the gateway is
left to it, and the watch asks again every 15s for as long as the
process lives: /v1/chat/completions, /v1/messages and /v1/models all
answer the page's sign-in, under one log line that reads as if another
magpie were involved. `magpie serve --web=<gateway addr>` takes the
same road, and so does `magpie web` with MAGPIE_ADDR on the page's own
port.

One port holds one listener, and the gateway is the one to keep its:
the agents point there, while the page sits beside it anyway unless
told (127.0.0.1:3430). StartWeb now goes through webListen, which
moves the page beside the gateway when it is told onto the gateway's
port on hosts both listeners would take — the same host on the page's
usual port, or, that taken or the gateway's too, on a free port of its
own, and says so. A page whose port another program really holds is
untouched, and so is gateway.Taken: a port the probe finds held is now
always someone else's.

Ran: TestWebOnTheGatewaysOwnAddress, new: a page started onto the
gateway's address, the gateway mounted, its / answering the catalog
the issue shows, and the page's link trading its key beside it. At
this fix's parent, red, with the log the issue quotes word for word
("is taken but doesn't answer as magpie yet") against the page's own
listener; at this head, green. With the fix reverted at the tree the
test went red again, and green once more when restored.
TestGatewayTakenOver and TestGatewayNotServedBesideASlowOne, the two
the Taken check answers to, green. go test -tags nogui ./internal/cli
ok, ./internal/gui ok but TestProxyCheckSaysAProxyPassedBy, red at the
parent too. gofmt -l clean. go vet ./... and GOOS=linux and GOOS=windows
go vet -tags nogui ./... clean but the cgo enum warning in
trayimage_darwin.go, at the parent too. go build -tags nogui on darwin,
linux/amd64 and windows/amd64 ok.

Fixes #3209

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/cli/web_cli.go       |  2 +-
 internal/gui/takeover_test.go | 72 +++++++++++++++++++++++++++++++++++
 internal/gui/web.go           | 67 +++++++++++++++++++++++++++++++-
 3 files changed, 139 insertions(+), 2 deletions(-)

diff --git a/internal/cli/web_cli.go b/internal/cli/web_cli.go
index a60f8b63..216ccab8 100644
--- a/internal/cli/web_cli.go
+++ b/internal/cli/web_cli.go
@@ -14,7 +14,7 @@ import (
 )
 
 // webAddr is where `magpie web` listens unless told: beside the gateway.
-const webAddr = "127.0.0.1:3430"
+const webAddr = gui.WebAddr
 
 // webCmd: magpie web [--addr host:port] [--lan] [--no-open] [--gateway]
 // [--tls-cert <file> --tls-key <file>] —
diff --git a/internal/gui/takeover_test.go b/internal/gui/takeover_test.go
index e9543393..1e6351d7 100644
--- a/internal/gui/takeover_test.go
+++ b/internal/gui/takeover_test.go
@@ -2,9 +2,11 @@ package gui
 
 import (
 	"context"
+	"io"
 	"net"
 	"net/http"
 	"os"
+	"strings"
 	"testing"
 	"time"
 
@@ -99,3 +101,73 @@ func TestGatewayNotServedBesideASlowOne(t *testing.T) {
 		t.Fatal("listened for the gateway on a port another magpie holds")
 	}
 }
+
+// Told onto the gateway's own address, the page doesn't take it: one port
+// holds one listener, and the gateway keeps its — the agents point there,
+// while a page on it was only ever taken for another magpie's, which this
+// one waited for for as long as it lived, and /v1 answered the sign-in
+// page instead (#3209). The page goes beside it, and the gateway serves.
+func TestWebOnTheGatewaysOwnAddress(t *testing.T) {
+	t.Setenv("HOME", t.TempDir())
+	t.Setenv("USERPROFILE", os.Getenv("HOME"))
+	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
+	t.Setenv("XDG_CACHE_HOME", t.TempDir())
+	t.Setenv("MAGPIE_WEB_KEY", "")
+	ln, err := net.Listen("tcp", "127.0.0.1:0")
+	if err != nil {
+		t.Fatal(err)
+	}
+	gw := ln.Addr().String()
+	ln.Close()
+	t.Setenv("MAGPIE_ADDR", gw)
+	// the updater starts with the page: its first look at the feed waits
+	// five seconds, past this test, and asks then only once it is due
+	updates.mu.Lock()
+	updates.asked = time.Now()
+	updates.mu.Unlock()
+
+	w, err := StartWeb(gw, "test")
+	if err != nil {
+		t.Fatal(err)
+	}
+	t.Cleanup(func() {
+		w.srv.Close()
+		webPage.Store(false)
+		gatewayMu.Lock()
+		defer gatewayMu.Unlock()
+		if served.Load() != nil && servedRun.stop != nil {
+			servedRun.stop()
+			<-servedRun.done
+		}
+		served.Store(nil)
+		takenSaid.Store(false)
+	})
+	if w.Addr == gw {
+		t.Fatalf("the page took the gateway's own address %s", gw)
+	}
+	// the gateway serves on its own address, and never the page's sign-in
+	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(50 * time.Millisecond) {
+		res, err := http.Get("http://" + gw + "/")
+		if err == nil {
+			b, _ := io.ReadAll(io.LimitReader(res.Body, 64<<10))
+			res.Body.Close()
+			if strings.Contains(string(b), `"apis"`) {
+				break
+			}
+		}
+		if time.Now().After(deadline) {
+			t.Fatalf("the gateway on %s never served: %v", gw, err)
+		}
+	}
+	// and the page answers where it went beside the gateway: the link's
+	// key is traded for a sign-in cookie, which a plain Get wouldn't keep
+	// past its redirect, so that is left unfollowed
+	get := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
+	res, err := get.Get(w.Link)
+	if err != nil || res.StatusCode != http.StatusSeeOther {
+		b, _ := io.ReadAll(io.LimitReader(res.Body, 1<<10))
+		res.Body.Close()
+		t.Fatalf("the page on %s: %d %v %s", w.Link, res.StatusCode, err, b)
+	}
+	res.Body.Close()
+}
diff --git a/internal/gui/web.go b/internal/gui/web.go
index 36728a89..99762860 100644
--- a/internal/gui/web.go
+++ b/internal/gui/web.go
@@ -64,6 +64,71 @@ var webReexec atomic.Bool
 // browser's cookie still opens the page (#111).
 const webRunKey = "MAGPIE_WEB_RUNKEY"
 
+// WebAddr is where the page listens unless told: beside the gateway, whose
+// address the agents point at and which the page never takes from it.
+const WebAddr = "127.0.0.1:3430"
+
+// webListen listens for the page on addr — beside the gateway when addr is
+// the gateway's own address: one port holds one listener, and the gateway
+// keeps it, the agents pointing there, while a page on it would only ever
+// be taken by gateway.ServedBy and gateway.Taken for another magpie's,
+// which this one then waits for for as long as it lives, and the agents'
+// paths answer the page's sign-in (#3209). The page goes where it sits
+// beside the gateway anyway (WebAddr), or, that taken or the gateway's
+// too, on a free port of its own, and says so.
+func webListen(addr string) (net.Listener, error) {
+	beside, move := pageBeside(addr)
+	if !move {
+		return net.Listen("tcp", addr)
+	}
+	ln, err := net.Listen("tcp", beside)
+	if err != nil {
+		// that one is taken too: the same host on a port of the page's own
+		host, _, _ := net.SplitHostPort(beside)
+		ln, err = net.Listen("tcp", net.JoinHostPort(host, "0"))
+	}
+	if err != nil {
+		return nil, err
+	}
+	log.Printf("magpie web: %s is the gateway's own address, so the page is on %s", addr, ln.Addr())
+	return ln, nil
+}
+
+// pageBeside says where the page listens instead of addr, and whether it
+// must: the same host on the page's port beside the gateway, when addr
+// names the gateway's port on hosts both listeners would take.
+func pageBeside(addr string) (string, bool) {
+	host, port, err := net.SplitHostPort(addr)
+	if err != nil {
+		return "", false
+	}
+	gwHost, gwPort, err := net.SplitHostPort(gateway.Addr())
+	if err != nil || port != gwPort || !bothTake(host, gwHost) {
+		return "", false
+	}
+	_, beside, err := net.SplitHostPort(WebAddr)
+	if err != nil || beside == gwPort {
+		beside = "0" // the gateway is on the page's own port: one of the page's own, then
+	}
+	return net.JoinHostPort(host, beside), true
+}
+
+// bothTake says whether two listen hosts take the same requests: equal,
+// either of them on every interface, or the same address. A host that
+// isn't an address (a name) is taken as overlapping: the page going
+// beside the gateway does no harm there, the two fighting over one port
+// does.
+func bothTake(a, b string) bool {
+	if a == b {
+		return true
+	}
+	ai, bi := net.ParseIP(a), net.ParseIP(b)
+	if ai == nil || bi == nil {
+		return true
+	}
+	return ai.IsUnspecified() || bi.IsUnspecified() || ai.Equal(bi)
+}
+
 // StartWeb serves the page on addr (host:port), as the given version of
 // magpie, which keeps itself up to date as the app does. Every request needs the
 // key the link carries, taken once into a cookie other sites' pages can't
@@ -79,7 +144,7 @@ func StartWeb(addr, version string) (*Web, error) {
 	if fixed {
 		keep = webCookieAge
 	}
-	ln, err := net.Listen("tcp", addr)
+	ln, err := webListen(addr)
 	if err != nil {
 		return nil, err
 	}
-- 
2.50.1 (Apple Git-155)

```

</details>

Branch with the commit: [hunt60-c-3209-gateway-selfport](https://github.com/ggbdpq/magpie/tree/hunt60-c-3209-gateway-selfport) (head `ced737100a5b5aa6a9fe53c37549fa7ef0f217e7`).
