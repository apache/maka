Thanks @FaintGhost for digging the root cause out this thoroughly — this report is from October 11, and I re-checked every link of the chain against current main before touching anything: it still stands as described, and the fix follows your suggestion of reading the gateway's own 401 as "up".

**Summary**

- `gateway.ServedBy` (which the TUI's serve loop and `magpie daemon` ask) and `magpie healthcheck` both probe `GET /` and take a 401 for "no gateway". A gateway listening on a non-loopback address (`MAGPIE_ADDR=<tailscale-ip>:3425`, or shared on the LAN) refuses that probe the key it doesn't carry: the probe asks for the address MAGPIE_ADDR names and leaves by it, so it isn't loopback — and the refusal's body (`{"error":{"message":"no API key was sent: send a magpie gateway key …"}}`) contains no `"magpie"`.
- So the TUI read the gateway `magpie web` held as gone and went on trying to serve it every 15 seconds, its bind failing on the port held, and healthcheck answered `answers 401 Unauthorized, not as a magpie gateway` — exactly as reported.
- The change is on the probing side only, so LAN authentication itself is untouched: a new `gateway.RefusedProbe` recognizes the gateway's own refusal (its words name a magpie gateway key, which another service's 401 doesn't), and `ServedBy` and healthcheck take it for the gateway being up. Nothing at the address, a loopback probe and another service's 401 are read as before; `0.0.0.0` in Settings keeps probing `127.0.0.1`, which a gateway bound to `0.0.0.0` answers on loopback.

**Verification**

| Check | Result |
| --- | --- |
| `go test -tags nogui -run TestServedByFindsAGatewayOnTheNetwork ./internal/gateway/` | red at main with the test in, green at this head; red again with the fix reverted, green restored |
| `go test -tags nogui ./internal/gateway/` | ok, 334.8s |
| `go test -tags nogui ./internal/cli/` | ok, 30.2s |
| `gofmt -l` on the changed files | clean |
| `go vet -tags nogui ./...` (darwin), `GOOS=linux`, `GOOS=windows` | clean, clean, clean |
| `go build -tags nogui ./...` (darwin, linux, windows) | ok, ok, ok |

The new test drives the real guard stack (`lanGuard(New().Handler())`) from a non-loopback address with sharing on: a keyless probe must read as the gateway running, and nothing at the address must still read as nothing.

**Not verified**

- The reporter's exact setup (systemd + Tailscale + the TUI on the same machine); the test stands in for it at the HTTP guard level.
- The report's first scenario stays open: a TUI with no `MAGPIE_ADDR` of its own cannot learn which address a gateway started with a different `MAGPIE_ADDR` listens on, so it still reads that one as gone (the probe reaches `127.0.0.1`, where nothing listens). That needs the gateway's real address to be discovered across processes, which this change doesn't attempt; with `MAGPIE_ADDR` set the same on both, or `0.0.0.0` in Settings, the probe now reaches the gateway.
- Plugin log lines landing on the TUI's picture (the report's point 3) is a separate concern, not touched here.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: gateway: a gateway on the network is found running through its refusal of a keyless probe (#1677) — git am applies it as is; SHA-256 first 16: 68764c36bce9cd7a</summary>

```patch
From fd664874e11dc7103fb03c27820c3a5f6a2d9708 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Thu, 22 Oct 2026 06:16:09 +0800
Subject: [PATCH] gateway: a gateway on the network is found running through
 its refusal of a keyless probe (#1677)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

What changed: ServedBy and healthcheck took a 401 for no gateway. One
listening on a non-loopback address (MAGPIE_ADDR, or shared on the LAN)
refuses a probe from its own machine the key the probe doesn't carry:
the probe asks for the address MAGPIE_ADDR names and leaves by it, so
it isn't loopback, and the refusal's body names no "magpie", so the tui
read the gateway a magpie web held as gone and went on trying to serve
it every 15s, its bind failing on the port held, and healthcheck
answered "answers 401 Unauthorized, not as a magpie gateway".
RefusedProbe says a status and body are the gateway's own refusal (its
words name a magpie gateway key, another service's 401 doesn't), and
ServedBy and healthcheck take it for the gateway being up. Nothing at
the address, a loopback probe and another service's 401 are read as
before.

Run: go test -tags nogui -run
TestServedByFindsAGatewayOnTheNetwork ./internal/gateway/ — red at
origin/main's gateway.go with the test in, green at this head (red
again with the fix reverted, green restored). The full gateway package
is green under -tags nogui (334.8s), internal/cli too (30.2s);
gofmt -l clean; go vet -tags nogui ./... clean for darwin, linux and
windows; go build -tags nogui ./... ok for the three.

Fixes #1677
Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/cli/healthcheck_cli.go | 11 ++++++++---
 internal/gateway/gateway.go     | 14 +++++++++++++
 internal/gateway/lan_test.go    | 35 +++++++++++++++++++++++++++++++++
 3 files changed, 57 insertions(+), 3 deletions(-)

diff --git a/internal/cli/healthcheck_cli.go b/internal/cli/healthcheck_cli.go
index 52a73cc0..4d82e0e8 100644
--- a/internal/cli/healthcheck_cli.go
+++ b/internal/cli/healthcheck_cli.go
@@ -14,9 +14,11 @@ import (
 )
 
 // healthcheck: magpie healthcheck — exits 0 when a magpie gateway answers
-// at its address (MAGPIE_ADDR, else the port in Settings' Gateway address on 127.0.0.1,
-// 3425 unless set), for a container's
-// HEALTHCHECK, which has no curl to ask it with.
+// at its address (MAGPIE_ADDR, else the port in Settings' Gateway address on
+// 127.0.0.1, 3425 unless set), for a container's
+// HEALTHCHECK, which has no curl to ask it with. A gateway listening on the
+// network answers a probe from its own machine without the key with its
+// refusal of one (#1677), and that refusal says it is up.
 func healthcheck() error {
 	c := &http.Client{Timeout: 3 * time.Second}
 	res, err := c.Get(gateway.URL() + "/")
@@ -25,6 +27,9 @@ func healthcheck() error {
 	}
 	defer res.Body.Close()
 	b, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
+	if gateway.RefusedProbe(res.StatusCode, b) {
+		return nil
+	}
 	if res.StatusCode != http.StatusOK || !bytes.Contains(b, []byte(`"magpie"`)) {
 		return fmt.Errorf("%s answers %s, not as a magpie gateway", gateway.URL(), res.Status)
 	}
diff --git a/internal/gateway/gateway.go b/internal/gateway/gateway.go
index ae256889..95572c2f 100644
--- a/internal/gateway/gateway.go
+++ b/internal/gateway/gateway.go
@@ -285,6 +285,17 @@ type Served struct {
 	Serves  string // how it was started: app, tray, web, serve or tui; "" from one that doesn't say
 }
 
+// RefusedProbe says a status and body are the gateway's own refusal of a
+// request that came without an enabled gateway key. A gateway listening on
+// the network answers this computer's probe of it with that too (#1677):
+// the probe asks for MAGPIE_ADDR's address and leaves by it, so it isn't
+// loopback and is asked for the key. A refusal means something answers and
+// speaks of a magpie gateway key, so the gateway is up; another service's
+// 401 doesn't, and isn't one.
+func RefusedProbe(status int, body []byte) bool {
+	return status == http.StatusUnauthorized && bytes.Contains(body, []byte("magpie gateway key"))
+}
+
 // ServedBy asks the address which magpie answers there. Another magpie can
 // keep the port after this one is updated (a magpie serve left running, a
 // second copy, one that didn't quit), and every agent's request is then
@@ -307,6 +318,9 @@ func ServedBy() Served {
 		Serves  string `json:"serves"`
 	}
 	if decodeJSON(b, &info) != nil || info.Name != "magpie" {
+		if RefusedProbe(res.StatusCode, b) {
+			return Served{Running: true}
+		}
 		return Served{Running: bytes.Contains(b, []byte(`"magpie"`)), Window: bytes.Contains(b, []byte(`"window":true`))}
 	}
 	return Served{Running: true, Window: info.Window, Version: info.Version, Pid: info.Pid, Serves: info.Serves}
diff --git a/internal/gateway/lan_test.go b/internal/gateway/lan_test.go
index 3d381613..b2c90022 100644
--- a/internal/gateway/lan_test.go
+++ b/internal/gateway/lan_test.go
@@ -2,6 +2,7 @@ package gateway
 
 import (
 	"encoding/json"
+	"net"
 	"net/http"
 	"net/http/httptest"
 	"os"
@@ -388,3 +389,37 @@ func TestNetworkGatewayGuardsEveryRoute(t *testing.T) {
 		t.Fatal("loopback:", c, b)
 	}
 }
+
+// A gateway shared on the network answers this computer's probe of it with
+// its own refusal of a keyless request: the probe asks for the address
+// MAGPIE_ADDR names (the gateway's own, when it listens on one interface's
+// address), and leaves by it, so it isn't loopback and needs the key.
+// ServedBy is to find the gateway running there all the same (#1677): the
+// tui took the gateway a magpie web held for gone and went on trying to
+// serve it every 15s, and healthcheck said no gateway answered. Nothing at
+// the address is still nothing.
+func TestServedByFindsAGatewayOnTheNetwork(t *testing.T) {
+	fresh(t)
+	if err := settings.Save(settings.Settings{LAN: true}); err != nil {
+		t.Fatal(err)
+	}
+	sv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		r.RemoteAddr = "192.168.1.9:5000" // the probe comes from the address it asked for, not loopback
+		lanGuard(New().Handler()).ServeHTTP(w, r)
+	}))
+	defer sv.Close()
+	t.Setenv("MAGPIE_ADDR", strings.TrimPrefix(sv.URL, "http://"))
+	if s := ServedBy(); !s.Running {
+		t.Fatalf("a shared gateway's refusal of a keyless probe: %+v", s)
+	}
+	ln, err := net.Listen("tcp", "127.0.0.1:0")
+	if err != nil {
+		t.Fatal(err)
+	}
+	free := ln.Addr().String()
+	ln.Close()
+	t.Setenv("MAGPIE_ADDR", free)
+	if s := ServedBy(); s.Running {
+		t.Fatalf("nothing answering: %+v", s)
+	}
+}
-- 
2.50.1 (Apple Git-155)

```
</details>

Branch with the commit: [hunt60-d-1677-gateway-lan-probe](https://github.com/ggbdpq/magpie/tree/hunt60-d-1677-gateway-lan-probe) (head `fd664874e11dc7103fb03c27820c3a5f6a2d9708`).
