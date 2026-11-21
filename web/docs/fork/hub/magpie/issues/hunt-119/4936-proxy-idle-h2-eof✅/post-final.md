A first try on Antigravity through a local proxy stalls ~20.5s and fails `502 unexpected EOF`, then magpie's own retry serves at once on a new connection — the report reads that as the connection pool reusing a connection the proxy's tunnel had already dropped, meeting the 20s health-check ping. A local reproduction says the stall is real but the reuse window is not what it rides on, and the 20s is.

## Measured, on a real HTTP/2 stand-in

The feedback loop: a real HTTP/2 vendor, a raw byte-pump in front of it (the tunnel), a client transport with magpie's exact settings (`HTTP2: {SendPingTimeout: 20s, PingTimeout: 10s}`, `IdleConnTimeout: 90s`), and a switch that makes the tunnel drop the far side silently the way a NAT or a relay session does — bytes in, nothing out, no FIN. With `GODEBUG=http2debug=1`:

- The health check does fire with no request in flight: `sending health check` 20s into an idle connection, whatever the stream count — the report's reading that Go's http2 client sends no PING while it holds no active streams does not hold on Go 1.26.8.
- A connection whose path dies while it is idle is therefore pinged within the idle itself and dropped at PingAfter+PingTimeout (30s), removed from the pool; the next request dials a new connection and answers at once. There is no 50–90s zombie-reuse window under these settings: a tunnel dead throughout an idle never survives to be reused.
- What reproduces the report is the death arriving around the write: a turn written onto a connection whose path dies under it gets no frame back, and its failure comes only from the next health check — the ping reaches the dead tunnel and the tunnel's own end closes (`unexpected EOF`, the report's error, at ~PingAfter), or the ping goes unanswered and the connection is closed for a lost ping at PingAfter+PingTimeout. Either way the turn rides out the whole interval to the next scheduled probe, then magpie's 1s retry dials fresh and serves: the report's 21,499–21,899ms `retried_ms` is PingAfter + the write + the poke + the retry wait, and the code the report quotes is the right code — only the story around it differs.

One honest gap: with idle health checks cycling at a ~20s cadence, the probe that finds the death should land a phase-dependent 0–20s after the write, yet the report's six samples sit in a 400ms window at ~20.5s. The reconciliation I could not verify locally (no Antigravity account): magpie talks to the same host beside the agent's turns — quota and model traffic — and a reply from it just before the turn resets the last-frame clock, putting the next ping ~20s after the turn's write every time.

## Fix

The stall is the discovery latency of a dead path, and the read-idle ping is its only probe, so `netproxy.PingAfter` goes 20s → 10s: a turn in flight on a path that died now rides out at most ~10.5s instead of ~20.5s. The budget `PingAfter+PingWait` stays ≥20s, which is the margin a body under `uploadBytes` needs on a slow uplink — a ping queued behind the body is answered only after its last byte (#3909): 64KB at about 3KB/s still fits. `PingWait` is untouched.

The report's other two suggestions I did not take, with the measurements above as the reason: an `IdleConnTimeout` of 30–45s under a proxy evicts connections whose staleness the ping already settles within 30s of idle, and does nothing for a death that arrives after the write; a health check before reusing an idle connection has no hook in the stdlib transport, and the reused connection was ping-alive shortly before the write anyway. magpie's retry after 1s is already as instant as its own machinery makes it; the 20s dominated.

## Verification

| Check | Result |
|---|---|
| `go test -tags nogui -count=1 -run 'TestRequestOnAHoledConnectionFailsAtThePing\|TestPingAfterSizesTheDeadPathDiscovery' ./internal/netproxy` | ok (mechanism: a turn on a holed connection fails within PingAfter+PingWait at scaled timings and a retry dials its own connection; sizing: `PingAfter 20s; want 10s` red before, green after) |
| RED before the fix | `TestPingAfterSizesTheDeadPathDiscovery` fails with `PingAfter 20s; want 10s` |
| Ablation: `netproxy.go` from the parent db7c57670, tests kept | the sizing test red again with the same line; green with the commit restored |
| `go test -tags nogui -count=1 ./internal/netproxy`, new tests at `-race` and `-count=3` | ok |
| `go test -tags nogui -count=1 ./internal/...` | ok apart from four reds that are red alone on the parent commit too (`TestMothX`, `TestProxyCheckSaysAProxyPassedBy`, `TestHostToldTheGatewayAddress`) or green alone (`TestCodexPoolSaysTheClientsVersion`, a known full-suite flake) |
| `go test -tags nogui -count=1 -run 'TestSilentHTTP2ConnectionIsDropped\|TestUploadStillUnderwayIsNotCutByHealthPing' ./internal/gateway` | ok (the #2843 and #3909 behaviors over the new value) |
| `gofmt -l`, `go vet -tags nogui ./internal/netproxy ./internal/gateway` | clean |
| `go build -tags nogui` darwin / GOOS=linux / GOOS=windows | ok |

Not verified: no Antigravity account, no Mihomo, no SS/IEPL line here — the stand-in's tunnel dies silently, but the report's exact phasing (the constant ~21.5s) rests on the same-host-traffic hypothesis above, and the poke-EOF the report saw (the tunnel answering the ping with a close) is only inferred from its numbers, my shim being the silent kind that takes PingAfter+PingTimeout instead. The 10s value is a trade, not a derivation: lower still would eat #3909's budget for bodies under `uploadBytes` on slow uplinks, and the maintainer may prefer another split.

---

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: netproxy: the health check pings a silent connection after 10s, not 20 (#4936) — git am applies it as is; SHA-256 first 16: e4f83f9791b2f9c8</summary>

```
From 7c3aec7dfce18c623f9e7fc7e7c313331bfcff41 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Tue, 3 Nov 2026 07:57:43 +0800
Subject: [PATCH] fix(netproxy): the health check pings a silent connection
 after 10s, not 20 (#4936)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

What changed
The HTTP/2 health check is the only probe of a connection whose path has
died silently, so a turn in flight on such a connection waits for the
next one: with PingAfter at 20s a first try read EOF came ~20.5s after it
was written (Antigravity through a local proxy whose tunnel a NAT or a
relay had dropped, yetone/magpie#4936), and magpie's own retry served at
once on a new connection. PingAfter is 10s now: finding a dead path costs
at most half of what it did, and the margin a body under uploadBytes
needs on a slow uplink — the budget PingAfter+PingWait, a ping queued
behind the body and answered only after its last byte (#3909) — still
covers 64KB at about 3KB/s.

Run
go test -tags nogui -count=1 ./internal/netproxy (a new test walks a turn
onto a connection whose path dies under it and watches it fail at the
health check, then a retry serve on a connection of its own; a second
locks the sizing)
go test -tags nogui -count=1 ./internal/... — TestMothX,
TestProxyCheckSaysAProxyPassedBy and TestHostToldTheGatewayAddress are
red alone on the parent commit too; TestCodexPoolSaysTheClientsVersion is
a known full-suite flake, green alone
go vet, gofmt, GOOS=linux GOARCH=amd64 go build, GOOS=windows
GOARCH=amd64 go build, go build on darwin.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/netproxy/deadpath_test.go | 224 +++++++++++++++++++++++++++++
 internal/netproxy/netproxy.go      |  10 +-
 2 files changed, 233 insertions(+), 1 deletion(-)
 create mode 100644 internal/netproxy/deadpath_test.go

diff --git a/internal/netproxy/deadpath_test.go b/internal/netproxy/deadpath_test.go
new file mode 100644
index 000000000..e6070e062
--- /dev/null
+++ b/internal/netproxy/deadpath_test.go
@@ -0,0 +1,224 @@
+package netproxy
+
+import (
+	"bufio"
+	"crypto/ecdsa"
+	"crypto/elliptic"
+	"crypto/rand"
+	"crypto/tls"
+	"crypto/x509"
+	"crypto/x509/pkix"
+	"io"
+	"math/big"
+	"net"
+	"net/http"
+	"strings"
+	"sync"
+	"testing"
+	"time"
+)
+
+// A request whose connection's path dies after it was written — a proxy's
+// tunnel whose far side a NAT or a relay dropped — is discovered only by
+// the connection's health check, which goes out PingAfter after the last
+// frame the connection received (#4936: a first try read EOF ~20.5s after
+// it was written, then magpie's own retry succeeded at once on a new
+// connection). The test watches the bound with the timings scaled down: a
+// holed connection is pinged at PingAfter, dropped at PingAfter+PingWait,
+// and the try on it fails with the connection, while the next one dials
+// anew and succeeds.
+func TestRequestOnAHoledConnectionFailsAtThePing(t *testing.T) {
+	pingAfter, pingWait := time.Second, 500*time.Millisecond
+
+	// The vendor, speaking HTTP/2 over TLS on a listener the shim pumps
+	// raw bytes into, as a CONNECT tunnel would.
+	srv := newH2Vendor(t)
+	// The tunnel: a byte pump with a hole per connection.
+	shim, err := net.Listen("tcp", "127.0.0.1:0")
+	if err != nil {
+		t.Fatal(err)
+	}
+	t.Cleanup(func() { shim.Close() })
+	var mu sync.Mutex
+	holed := map[net.Conn]bool{}
+	serverHits := 0
+	go func() {
+		for {
+			c, err := shim.Accept()
+			if err != nil {
+				return
+			}
+			go func(c net.Conn) {
+				defer c.Close()
+				s, err := net.Dial("tcp", srv.Addr())
+				if err != nil {
+					return
+				}
+				defer s.Close()
+				mu.Lock()
+				serverHits++
+				holed[c] = false
+				mu.Unlock()
+				defer func() { mu.Lock(); delete(holed, c); mu.Unlock() }()
+				var once sync.Once
+				go func() { // vendor -> client
+					io.Copy(c, s)
+					once.Do(func() { c.Close() })
+				}()
+				br := bufio.NewReader(c)
+				buf := make([]byte, 16<<10)
+				for {
+					n, err := br.Read(buf)
+					if n > 0 {
+						mu.Lock()
+						hole := holed[c]
+						mu.Unlock()
+						if !hole {
+							if _, werr := s.Write(buf[:n]); werr != nil {
+								once.Do(func() { c.Close() })
+								return
+							}
+						}
+					}
+					if err != nil {
+						once.Do(func() { s.Close() })
+						return
+					}
+				}
+			}(c)
+		}
+	}()
+	punchHole := func() {
+		mu.Lock()
+		defer mu.Unlock()
+		for c := range holed {
+			holed[c] = true
+		}
+	}
+
+	client := &http.Client{Transport: &http.Transport{
+		ForceAttemptHTTP2: true,
+		TLSClientConfig:   &tls.Config{InsecureSkipVerify: true},
+		HTTP2:             &http.HTTP2Config{SendPingTimeout: pingAfter, PingTimeout: pingWait},
+	}}
+	post := func() (time.Duration, int, error) {
+		start := time.Now()
+		req, err := http.NewRequest("POST", "https://"+shim.Addr().String()+"/turn", nil)
+		if err != nil {
+			t.Fatal(err)
+		}
+		res, err := client.Do(req)
+		took := time.Since(start)
+		if err != nil {
+			return took, 0, err
+		}
+		io.Copy(io.Discard, res.Body)
+		res.Body.Close()
+		return took, res.StatusCode, nil
+	}
+
+	if took, code, err := post(); err != nil || code != 200 {
+		t.Fatalf("the first turn: %d in %v, %v", code, took, err)
+	}
+	punchHole() // the tunnel's far side dies, the way a NAT session does
+
+	took, code, err := post()
+	mu.Lock()
+	dials := serverHits
+	mu.Unlock()
+	if err == nil {
+		t.Fatalf("the turn on the holed connection answered %d in %v; want the dead path found at the ping", code, took)
+	}
+	if took < pingAfter-pingAfter/4 {
+		t.Fatalf("the turn failed after %v, before the health check was due (%v): %v", took, pingAfter, err)
+	}
+	if took > pingAfter+pingWait+3*time.Second {
+		t.Fatalf("the turn failed after %v; the health check should have found the dead path by %v: %v", took, pingAfter+pingWait, err)
+	}
+	said := err.Error()
+	if !containsAny(said, "connection lost", "EOF", "unexpected EOF", "closed") {
+		t.Fatalf("the turn failed with %q; want the connection's own end", said)
+	}
+	// magpie's own retry: a new connection, the turn served.
+	took, code, err = post()
+	if err != nil || code != 200 {
+		t.Fatalf("the retry: %d in %v, %v", code, took, err)
+	}
+	mu.Lock()
+	dials = serverHits
+	mu.Unlock()
+	if dials != 2 {
+		t.Fatalf("the vendor was dialed %d times; want the retry on a connection of its own", dials)
+	}
+}
+
+func containsAny(s string, subs ...string) bool {
+	for _, sub := range subs {
+		if strings.Contains(s, sub) {
+			return true
+		}
+	}
+	return false
+}
+
+// The health check is the only probe of a connection whose path has died
+// silently: a turn in flight on it waits for the next one, so PingAfter is
+// how long a vendor's silence before a turn's first byte can cost (#4936:
+// a first try read EOF 20.5s in, then a retry that served at once — the
+// 20s was the ping). Half of it keeps the budget PingAfter+PingWait at
+// 20s, the margin a body under uploadBytes needs on an uplink of about
+// 3KB/s before a ping queued behind it is mistaken for a lost one (#3909).
+func TestPingAfterSizesTheDeadPathDiscovery(t *testing.T) {
+	if PingAfter != 10*time.Second {
+		t.Fatalf("PingAfter %v; want 10s: the dead path of a turn in flight is found by the next health check, and #3909's slow bodies keep the %v budget PingAfter+PingWait", PingAfter, PingAfter+PingWait)
+	}
+	if PingWait != 10*time.Second {
+		t.Fatalf("PingWait %v; want 10s", PingWait)
+	}
+}
+
+// h2Vendor is an HTTP/2 server on a plain listener a test's shim can pump
+// raw bytes to.
+type h2Vendor struct {
+	ln net.Listener
+}
+
+func (v *h2Vendor) Addr() string { return v.ln.Addr().String() }
+
+func newH2Vendor(t *testing.T) *h2Vendor {
+	t.Helper()
+	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
+	if err != nil {
+		t.Fatal(err)
+	}
+	tmpl := x509.Certificate{
+		SerialNumber:          big.NewInt(1),
+		Subject:               pkix.Name{CommonName: "127.0.0.1"},
+		IPAddresses:           []net.IP{net.ParseIP("127.0.0.1").To4()},
+		NotBefore:             time.Now().Add(-time.Hour),
+		NotAfter:              time.Now().Add(time.Hour),
+		KeyUsage:              x509.KeyUsageKeyEncipherment | x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
+		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
+		IsCA:                  true,
+		BasicConstraintsValid: true,
+	}
+	der, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &key.PublicKey, key)
+	if err != nil {
+		t.Fatal(err)
+	}
+	ln, err := net.Listen("tcp", "127.0.0.1:0")
+	if err != nil {
+		t.Fatal(err)
+	}
+	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		w.Header().Set("Content-Type", "text/event-stream")
+		w.WriteHeader(200)
+		io.WriteString(w, "data: ok\n\n")
+	}), TLSConfig: &tls.Config{
+		Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}},
+		NextProtos:   []string{"h2"},
+	}}
+	go srv.ServeTLS(ln, "", "")
+	t.Cleanup(func() { ln.Close() })
+	return &h2Vendor{ln: ln}
+}
diff --git a/internal/netproxy/netproxy.go b/internal/netproxy/netproxy.go
index 54c0ce65b..b10d7864f 100644
--- a/internal/netproxy/netproxy.go
+++ b/internal/netproxy/netproxy.go
@@ -43,7 +43,15 @@ func Install() {
 
 // PingAfter and PingWait: an HTTP/2 connection that has had no frame for
 // PingAfter is pinged, and dropped when no answer comes within PingWait.
-var PingAfter, PingWait = 20 * time.Second, 10 * time.Second
+// The health check is the only probe of a connection whose path has died
+// silently, so a turn in flight on it waits for the next one: PingAfter is
+// how long a vendor's silence before a turn's first byte can cost (#4936,
+// a first try read EOF 20.5s in on a connection whose tunnel a NAT or a
+// relay had dropped). The budget PingAfter+PingWait is also the margin a
+// body under uploadBytes needs on a slow uplink, a ping queued behind it
+// answered only after the last byte (#3909): 20s covers 64KB at about
+// 3KB/s.
+var PingAfter, PingWait = 10 * time.Second, 10 * time.Second
 
 // HTTP2Health is the HTTP/2 setting of a transport to the vendors. Every
 // request to one host shares one HTTP/2 connection, and one gone silent
-- 
2.50.1 (Apple Git-155)
```

</details>

Branch with the commit: [fix/4936-proxy-idle-h2-eof](https://github.com/ggbdpq/magpie/tree/fix/4936-proxy-idle-h2-eof) (head `7c3aec7dfce18c623f9e7fc7e7c313331bfcff41`).
