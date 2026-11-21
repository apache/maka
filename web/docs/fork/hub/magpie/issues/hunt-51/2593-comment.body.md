The counterexample is right, and it changes the fix. My earlier patch only removed `198.18.0.0/15` from `specialNets`; that gets a fake-IP name past the guard, but `publicTransport` then pins the resolved address and hands it to the proxy, and a real proxy cannot route a fake-IP — CONNECT by name succeeds where CONNECT by the pinned fake-IP fails, as your table shows. So the guard passing was only half the job.

This patch implements the narrow exception you described, and keeps the pin everywhere else.

Branch: [`hunt51-a-fakeip-proxy`](https://github.com/ggbdpq/magpie/tree/hunt51-a-fakeip-proxy), one commit on top of upstream `d9c6a60d` (head `b6067647`); the patch below applies with `git am`.

## What changed

`internal/gateway/image_fetch_guard.go`:

- New predicate `fakeIPProxy(host, addrs, proxy)` — true only when **all** of: the URL named a DNS name (not an address literal), the selected proxy is on a literal loopback address, and **every** address the name resolved to is inside `198.18.0.0/15`. An empty answer, a mixed answer, a proxy named rather than addressed, a proxy elsewhere, or no proxy all return false.
- Where the guard checked the resolved addresses, `byName` (that predicate) lets the fake-IP answer through; the checks still ran on what the name resolved to here, and every other shape is refused exactly as before.
- Where the request is pinned to an address, a `byName` request keeps the caller's hostname instead: HTTPS CONNECT carries the name (so TLS SNI is the name) and a plain HTTP request to an HTTP proxy keeps the name as its authority. For HTTP the authority comes from the checked URL, never from an unrelated request `Host`, so a foreign `Host` still cannot replace the target.
- `specialNets` is **unchanged**: `198.18.0.0/15` stays refused for literals, for direct connections, for non-loopback proxies and for mixed answers. Redirects go through the same checks again.

The trust boundary is the one your comment names: in this branch the loopback proxy does the final resolution, and magpie cannot independently observe or pin the destination inside it. That is why the exception is limited to a proxy on this computer and to answers that are *entirely* fake-IP.

## Red before the fix

Base `d9c6a60d`, tests `TestFakeIPThroughALoopbackProxyKeepsTheName` and `TestFakeIPProxyPredicate` (`internal/gateway/image_fetch_guard_test.go`):

```
--- FAIL: TestFakeIPThroughALoopbackProxyKeepsTheName
    a fake-IP name through a loopback proxy: Get "http://fake.test/img.png":
    it is at a private address, which magpie doesn't download from: ...
```

The proxy was asked `[]` — the request never reached it. After the fix the proxy is asked the name (`http://fake.test/img.png`, and for HTTPS the CONNECT is by name), while a mixed answer, an address literal, a non-loopback proxy and no proxy keep the old refusal and never reach a proxy.

Ablation: with `fakeIPProxy` short-circuited to `false` and the tests kept, the same assertion fails; restored, green.

Mutations, each caught by its own case in the predicate table: allowing a non-loopback proxy → 1 failure; allowing mixed answers → `a mixed answer: true, want false`; allowing an address literal → 2 failures; allowing a nil proxy → 1 failure. Each restored, green.

## Verification

| Check | Result |
| --- | --- |
| `go test -tags nogui -run 'TestFakeIP' ./internal/gateway/` | ok |
| the families this touches (web_fetch, image edits, draw, dialler, fetchPrivate) | ok, 32.5s |
| `go test -race -run 'TestFakeIP\|TestWebFetch\|TestEditImage\|TestPublicAddr\|TestPrivateDialer'` | ok, 15.9s |
| full gateway package | times out on this machine under load — on the clean base too (`-p 1 -timeout 20m`: FAIL 1201.8s), so recorded as pre-existing, not green |
| `gofmt -l internal/gateway/` | empty |
| `go vet -tags nogui ./internal/gateway/`, `GOOS=linux`, `GOOS=windows` | all clean |
| builds darwin / linux / windows | ok |

## Siblings

The guard is shared by `web_fetch`, image and video downloads, image edits and the vendor-URL paths — all of them get the same exception, since they all go through `publicTransport`. The dialler (`privateDialer`) is untouched: a direct connection never sees a fake-IP because a direct connection has no proxy to carry it. The icon path (`internal/provider/icon.go`, #252) already lets the range through for its own reason; this makes the gateway's rule explicit and narrower instead of copying that blanket allowance.

## Not verified

- No real Clash TUN / Surge setup on this machine; the proxy is an `httptest` server standing in for a loopback proxy, and the resolver is faked. Your two-machine result is the field evidence.
- Your exact Surge comparison (CONNECT by name vs by fake-IP) is reproduced at the request level (what the proxy is asked), not against a real Surge.
- The HTTP (not HTTPS) branch through a proxy is covered by asserting the authority the proxy receives; I did not run a real HTTP proxy.

**AI**: written with an AI coding agent; I've read the whole diff and can answer questions on it myself. The model name is in the commit's trailer.

**Attribution**: If you apply the patch, please keep its author (ggbdpq) or add a `Co-authored-by: ggbdpq <ggbdpq@gmail.com>` line.

<details><summary>patch: gateway: a fake-IP answer through a loopback proxy keeps the name (#2593) — git am applies it as is</summary>

```patch
From b6067647fde1bc751662964d1c817e65058be684 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Tue, 20 Oct 2026 16:36:52 +0800
Subject: [PATCH] gateway: a fake-IP answer through a loopback proxy keeps the
 name (#2593)

The earlier patch on this issue only took 198.18.0.0/15 out of
specialNets. That gets a fake-IP name past the guard, but publicTransport
still pins the resolved address and hands it to the proxy, and a real
proxy cannot route a fake-IP: h4rk8s' two-machine comparison shows CONNECT
by name succeeding where CONNECT by the pinned fake-IP failed. The guard
passing was only half the job.

What changed: a name that resolves only into 198.18.0.0/15, through a
proxy on a literal loopback address, keeps the caller's name instead of
being pinned (fakeIPProxy in image_fetch_guard.go). The guard's address
checks still run on what the name resolved to; HTTPS CONNECT and TLS SNI
carry the name, and a plain HTTP request to an HTTP proxy keeps the name
as its authority, taken from the checked URL and never from a request's
own Host. Every other shape keeps the pin and the refusal: an address
literal, any real address beside the fake ones, a proxy named rather than
addressed, a proxy elsewhere, no proxy at all. specialNets is unchanged,
so the range stays refused for literals, direct connections and every
non-loopback proxy, and redirects go through the same checks again.

The trust boundary is explicit: in this branch the loopback proxy does the
final resolution and magpie cannot pin the destination inside it, which is
why the exception is limited to a proxy on this computer and answers that
are entirely fake-IP.

Run (darwin/arm64, base d9c6a60d): TestFakeIPThroughALoopbackProxyKeepsTheName
and TestFakeIPProxyPredicate fail on the unfixed tree (the request never
reaches the proxy: "it is at a private address"); green with the change.
Ablation: fakeIPProxy short-circuited to false, tests kept - the same
failure; restored, green. Mutations, each caught by its own table case:
non-loopback proxy allowed (1 failure), mixed answers allowed ("a mixed
answer: true, want false"), address literal allowed (2 failures), nil
proxy allowed (1 failure). The families this touches (web_fetch, image
edits, draw, the dialler, fetchPrivate) pass in 32.5s; targeted -race ok
15.9s; gofmt clean, vet on darwin/linux/windows clean, builds on all
three. The full gateway package times out on this machine under load -
on the clean base too (-p 1 -timeout 20m: FAIL 1201.8s, the same
pre-existing timeout #2544/#2108 run into), so that gate is recorded as
pre-existing, not green.

Not tried against a real Clash TUN or Surge setup: the proxy is an
httptest server standing in for a loopback proxy and the resolver is
faked; h4rk8s' report is the field evidence.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/image_fetch_guard.go      |  52 +++++-
 internal/gateway/image_fetch_guard_test.go | 184 +++++++++++++++++++++
 2 files changed, 232 insertions(+), 4 deletions(-)

diff --git a/internal/gateway/image_fetch_guard.go b/internal/gateway/image_fetch_guard.go
index b91472f3..b9b0dee3 100644
--- a/internal/gateway/image_fetch_guard.go
+++ b/internal/gateway/image_fetch_guard.go
@@ -195,6 +195,37 @@ func publicAddr(a netip.Addr) bool {
 	return true
 }
 
+// fakeIPRange is RFC 2544's benchmarking range, which Clash's TUN mode with
+// fake-ip and Surge's enhanced mode answer every name with while the TUN or
+// the proxy carries the connection to the real host (#252, #2593). No
+// machine on the user's network sits in it.
+var fakeIPRange = netip.MustParsePrefix("198.18.0.0/15")
+
+// fakeIPProxy is a name that resolves only into fakeIPRange, through a
+// proxy on this computer: the fake-IP resolver's own answer, carried by
+// the proxy. Pinning the address would hand the proxy one it can't route
+// (a CONNECT by fake-IP fails where the name's succeeds, #2593), so the
+// name goes to the proxy instead and it resolves the destination itself.
+// Every other shape keeps the pin: an address literal, any real answer
+// beside the fake ones, a proxy elsewhere, no proxy at all.
+func fakeIPProxy(host string, addrs []netip.Addr, proxy *url.URL) bool {
+	if proxy == nil || host == "" {
+		return false
+	}
+	if _, err := netip.ParseAddr(strings.TrimSuffix(strings.TrimPrefix(host, "["), "]")); err == nil {
+		return false // the URL named an address, not a name
+	}
+	if ip := net.ParseIP(proxy.Hostname()); ip == nil || !ip.IsLoopback() {
+		return false
+	}
+	for _, a := range addrs {
+		if !fakeIPRange.Contains(a.Unmap()) {
+			return false
+		}
+	}
+	return len(addrs) > 0
+}
+
 // guardDialer dials only addresses ok allows, checked on the address the
 // socket is about to connect to.
 func guardDialer(ok func(netip.Addr) bool) *net.Dialer {
@@ -247,11 +278,17 @@ func (pt publicTransport) RoundTrip(req *http.Request) (*http.Response, error) {
 	}
 	allow := allowFor(pt.also)
 	named := allow.host(host, port)
+	// a fake-IP resolver's answer through a loopback proxy is let in: the
+	// proxy resolves the name itself (fakeIPProxy says why and when)
+	byName := fakeIPProxy(host, addrs, proxy)
 	for _, a := range addrs {
-		if !named && !allow.addr(a) {
+		if !byName && !named && !allow.addr(a) {
 			return nil, errPrivateAddress
 		}
 	}
+	// a fake-IP resolver's answer through a loopback proxy: the name goes
+	// on to the proxy, which resolves it (fakeIPProxy); every other shape
+	// keeps the pin
 	var tc *tls.Config
 	if upstreamTLS != nil {
 		tc = upstreamTLS.Clone()
@@ -274,7 +311,13 @@ func (pt publicTransport) RoundTrip(req *http.Request) (*http.Response, error) {
 		}).DialContext
 	}
 	out := req.Clone(req.Context())
-	out.URL.Host = net.JoinHostPort(addrs[0].Unmap().String(), port)
+	if byName {
+		// the name, as the caller wrote it: the proxy's CONNECT and TLS's
+		// SNI both keep it
+		out.URL.Host = net.JoinHostPort(host, port)
+	} else {
+		out.URL.Host = net.JoinHostPort(addrs[0].Unmap().String(), port)
+	}
 	out.Host = req.Host
 	if out.Host == "" {
 		out.Host = req.URL.Host
@@ -282,8 +325,9 @@ func (pt publicTransport) RoundTrip(req *http.Request) (*http.Response, error) {
 	// a plain http:// URL through an HTTP proxy is sent to it whole, its
 	// host taken from Host: the proxy would resolve the name again, so it
 	// is given the address instead (a site that serves only by name won't
-	// answer it; https://, and any URL through SOCKS, keep the name)
-	if proxy != nil && req.URL.Scheme == "http" && (proxy.Scheme == "http" || proxy.Scheme == "https") {
+	// answer it; https://, and any URL through SOCKS, keep the name) —
+	// unless it is a fake-IP name the loopback proxy must resolve itself
+	if !byName && proxy != nil && req.URL.Scheme == "http" && (proxy.Scheme == "http" || proxy.Scheme == "https") {
 		out.Host = out.URL.Host
 	}
 	return t.RoundTrip(out)
diff --git a/internal/gateway/image_fetch_guard_test.go b/internal/gateway/image_fetch_guard_test.go
index de320c34..d9fc4b64 100644
--- a/internal/gateway/image_fetch_guard_test.go
+++ b/internal/gateway/image_fetch_guard_test.go
@@ -7,6 +7,7 @@ import (
 	"net/http"
 	"net/http/httptest"
 	"net/netip"
+	"net/url"
 	"os"
 	"strings"
 	"sync"
@@ -253,3 +254,186 @@ func TestPrivateDialerRefusesPrivateAddresses(t *testing.T) {
 		t.Fatal("the private service was asked")
 	}
 }
+
+// A fake-IP resolver (Clash TUN, Surge enhanced) answers every name with
+// an address in RFC 2544's benchmarking range, and an explicit loopback
+// proxy carries the connection to the real host. Pinning the address
+// there sends the proxy an address it can't route: the report's own
+// comparison shows CONNECT by name succeeding while the same CONNECT by
+// fake-IP failed (#2593, h4rk8s). With a name, a loopback proxy and every
+// answer inside 198.18.0.0/15, the proxy is given the name, and the
+// address checks still run on what the name resolved to.
+func TestFakeIPThroughALoopbackProxyKeepsTheName(t *testing.T) {
+	fresh(t)
+	var mu sync.Mutex
+	var asked []string
+	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		mu.Lock()
+		asked = append(asked, r.URL.String()+" Host="+r.Host)
+		mu.Unlock()
+		w.Header().Set("Content-Type", "image/png")
+		w.Write(pngBytes)
+	}))
+	t.Cleanup(proxy.Close)
+	st := settings.Load()
+	st.Proxy = proxy.URL
+	if err := settings.Save(st); err != nil {
+		t.Fatal(err)
+	}
+	resolveTo(t, map[string]string{
+		"fake.test":  "198.18.5.1",
+		"mixed.test": "198.18.5.1",
+		"real.test":  "93.184.216.34",
+	})
+	// a name answering with a fake-IP and a real one is not the fake-IP
+	// resolver's answer alone: it stays pinned, as any name's does
+	was := lookupIP
+	lookupIP = func(_ context.Context, host string) ([]netip.Addr, error) {
+		if host == "mixed.test" {
+			return []netip.Addr{netip.MustParseAddr("198.18.5.1"), netip.MustParseAddr("93.184.216.34")}, nil
+		}
+		return was(context.Background(), host)
+	}
+	t.Cleanup(func() { lookupIP = was })
+
+	// the name is what the proxy is given, and the request is read
+	req, _ := http.NewRequest("GET", "http://fake.test/img.png", nil)
+	resp, err := publicClient.Do(req)
+	if err != nil {
+		t.Fatalf("a fake-IP name through a loopback proxy: %v", err)
+	}
+	resp.Body.Close()
+	if a := seenAsks(&mu, asked); len(a) != 1 || !strings.Contains(a[0], "fake.test") || strings.Contains(a[0], "198.18") {
+		t.Fatalf("the proxy was asked %q", a)
+	}
+
+	// an https:// request keeps the name too, so the proxy's CONNECT is by
+	// name and TLS's SNI is the name
+	asked = nil
+	req, _ = http.NewRequest("GET", "https://fake.test/img.png", nil)
+	if resp, err := publicClient.Do(req); err == nil {
+		resp.Body.Close()
+	}
+	if a := seenAsks(&mu, asked); len(a) != 1 || !strings.Contains(a[0], "fake.test") || strings.Contains(a[0], "198.18") {
+		t.Fatalf("https: the proxy was asked %q", a)
+	}
+
+	// a mixed answer is not the fake-IP resolver's alone: a real address
+	// beside the fake ones is refused, as it is with no proxy at all, and
+	// the proxy is not asked
+	asked = nil
+	req, _ = http.NewRequest("GET", "http://mixed.test/img.png", nil)
+	if resp, err := publicClient.Do(req); !errors.Is(err, errPrivateAddress) {
+		if err == nil {
+			resp.Body.Close()
+		}
+		t.Fatalf("a mixed answer: %v, want the private-address refusal", err)
+	}
+	if a := seenAsks(&mu, asked); len(a) != 0 {
+		t.Fatalf("a mixed answer reached the proxy: %q", a)
+	}
+
+	// a name at a real address through the same proxy keeps the pin, as
+	// before
+	asked = nil
+	req, _ = http.NewRequest("GET", "http://real.test/img.png", nil)
+	if resp, err := publicClient.Do(req); err == nil {
+		resp.Body.Close()
+	}
+	if a := seenAsks(&mu, asked); len(a) != 1 || !strings.Contains(a[0], "93.184.216.34") {
+		t.Fatalf("a real answer: the proxy was asked %q", a)
+	}
+}
+
+// seenAsks copies what a fake proxy was asked, holding its lock.
+func seenAsks(mu *sync.Mutex, asked []string) []string {
+	mu.Lock()
+	defer mu.Unlock()
+	return append([]string(nil), asked...)
+}
+
+// The fake-IP exception is the loopback proxy's alone: a name whose
+// answers are in the benchmarking range is still refused through a
+// non-loopback proxy, through no proxy, and when the URL is the literal
+// address.
+func TestFakeIPIsNotAnExceptionElsewhere(t *testing.T) {
+	fresh(t)
+	resolveTo(t, map[string]string{"fake.test": "198.18.5.1"})
+	setProxy := func(t *testing.T, v string) {
+		t.Helper()
+		was := settings.Load()
+		st := was
+		st.Proxy = v
+		if err := settings.Save(st); err != nil {
+			t.Fatal(err)
+		}
+		t.Cleanup(func() { settings.Save(was) })
+	}
+
+	// no proxy at all: a fake-IP answer is refused, as it always was
+	setProxy(t, "direct")
+	for name, u := range map[string]string{
+		"no proxy":            "http://fake.test/img.png",
+		"the literal address": "http://198.18.5.1/img.png",
+	} {
+		req, _ := http.NewRequest("GET", u, nil)
+		_, err := publicClient.Do(req)
+		if !errors.Is(err, errPrivateAddress) {
+			t.Errorf("%s: %v, want the private-address refusal", name, err)
+		}
+	}
+
+	// a literal address is not a name a resolver answered: even through a
+	// loopback proxy it stays refused
+	var mu sync.Mutex
+	var asked []string
+	loop := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		mu.Lock()
+		asked = append(asked, r.URL.String())
+		mu.Unlock()
+		w.Write(pngBytes)
+	}))
+	t.Cleanup(loop.Close)
+	setProxy(t, loop.URL)
+	req, _ := http.NewRequest("GET", "http://198.18.5.1/img.png", nil)
+	_, err := publicClient.Do(req)
+	if !errors.Is(err, errPrivateAddress) {
+		t.Errorf("a fake-IP literal through a loopback proxy: %v, want the private-address refusal", err)
+	}
+	if a := seenAsks(&mu, asked); len(a) != 0 {
+		t.Errorf("a fake-IP literal reached the loopback proxy: %q", a)
+	}
+}
+
+// fakeIPProxy is the exception's predicate alone: a name, a proxy on this
+// computer, and every answer inside 198.18.0.0/15. Each part is what
+// keeps the exception from reaching anything else.
+func TestFakeIPProxyPredicate(t *testing.T) {
+	fake := []netip.Addr{netip.MustParseAddr("198.18.5.1")}
+	real := []netip.Addr{netip.MustParseAddr("93.184.216.34")}
+	both := append(append([]netip.Addr(nil), fake...), real...)
+	loop := &url.URL{Scheme: "http", Host: "127.0.0.1:7890"}
+	far := &url.URL{Scheme: "http", Host: "203.0.113.9:3128"}
+	named := &url.URL{Scheme: "http", Host: "proxy.corp:3128"}
+	for _, c := range []struct {
+		name  string
+		host  string
+		addrs []netip.Addr
+		proxy *url.URL
+		want  bool
+	}{
+		{"a fake-IP name through a loopback proxy", "fake.test", fake, loop, true},
+		{"the same with [::1]", "fake.test", fake, &url.URL{Scheme: "http", Host: "[::1]:7890"}, true},
+		{"no proxy", "fake.test", fake, nil, false},
+		{"a proxy elsewhere", "fake.test", fake, far, false},
+		{"a proxy named, not addressed", "fake.test", fake, named, false},
+		{"a real answer", "real.test", real, loop, false},
+		{"a mixed answer", "mixed.test", both, loop, false},
+		{"an address literal", "198.18.5.1", fake, loop, false},
+		{"no addresses", "empty.test", nil, loop, false},
+	} {
+		if got := fakeIPProxy(c.host, c.addrs, c.proxy); got != c.want {
+			t.Errorf("%s: %v, want %v", c.name, got, c.want)
+		}
+	}
+}
-- 
2.50.1 (Apple Git-155)

```

</details>
