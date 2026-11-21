## Consistency note: the icon fetch already sends a loopback proxy the NAME

Following up on h4rk8s's point about fake-DNS / proxy / SSRF policy needing
consistent treatment across fetching paths: I traced the icon path
(`internal/provider/icon.go`) against the gateway's image guard
(`internal/gateway/image_fetch_guard.go`). Verdict: **no gap** — where hunt51's
gateway patch had to stop pinning fake-IP names, the icon fetch never had a
pin to remove. A protective test now locks the working behavior.

**(a) Through a loopback proxy under fake-IP, the icon fetch asks the proxy for the NAME.**

`guardClient` (icon.go:95) wraps the default transport's `Proxy` and
`DialContext`. With a proxy in play, Go's `http.Transport` dials only the
proxy's own address — `connectMethod.addr()` returns `canonicalAddr(cm.proxyURL)`
(go1.26.8, net/http/transport.go:2079) — and for https targets it sends
`CONNECT <name>:<port>` built from `cm.targetAddr`, which is captured from the
request URL *before* the transport's proxy func runs (transport.go:986,
1877–1884). The icon guard fits that shape exactly:

1. the `Proxy` wrapper judges the site's name once via `publicHost`
   (icon.go:106); a fake-IP answer (198.18.0.0/15) passes `publicIP`'s #252
   allowance (icon.go:221–248), and the proxy's own host:port is then marked
   in the `proxies` map (icon.go:109);
2. the transport dials the proxy (say 127.0.0.1:7890); that address is in the
   map, so `publicDial` is skipped and the loopback proxy is dialed as it is
   (icon.go:113–118);
3. the CONNECT line carries the name. Nothing resolves or pins the target
   locally on this path — rewriting the URL host to the resolved address
   before RoundTrip (what the gateway's image fetch did, now
   image_fetch_guard.go:276) is the only way a pin could happen, and the icon
   client has no such rewrite. In fact it *cannot* work from inside the
   `Proxy` callback at all, since `cm.targetAddr` is taken before that runs —
   a detail I verified while trying to break the new test from there.

The new `TestGuardClientFakeIPThroughLoopbackProxyKeepsName`
(internal/provider/icon_test.go:302) locks this: with resolution stubbed to
answer every name into 198.18.0.0/15 (a 9-line seam, `lookupIPAddr`, mirroring
the gateway's existing `lookupIP`), a loopback test proxy records
`CONNECT icon.example:443`. It is green on the current code — protective, not
a regression fix — and a RoundTrip-time pin makes it fail with "the proxy was
not asked for the name: 198.18.7.11:443", so a future pin lands as a visible
test failure here first.

**(b) A literal `https://198.18.x.x/icon.png` does slip past where the gateway refuses — and that difference tracks the URL's sender, not a hole.**

Mechanically yes: `iconURL` refuses only non-https and `local()` hosts
(loopback / RFC 1918; 198.18.0.5 is neither), and `publicIP` passes it (#252),
while the gateway's `publicAddr` refuses the same literal (specialNets,
image_fetch_guard.go:156). But icon URLs are not model output, which is the
sender the gateway's blanket refusal is sized for:

- `FetchIcon` (import links, plugin icons, partner logos) never dials the icon
  host at all: the URL is rewritten to usemagpie.ai's icon proxy
  (`internal/iconproxy`), so the guard only ever sees usemagpie.ai; a literal
  would ride along as a query parameter fetched from Cloudflare's network, not
  from the user's machine.
- `FaviconFor` is the one path where magpie itself dials a non-user-chosen
  URL, and its candidates come from the user's own provider base URL and the
  site's own page — user config, the same trust level behind the gateway's
  fetchPrivate and vendor-host exceptions.
- Reachability: without Clash TUN, 198.18.0.0/15 (RFC 2544) is unroutable; with
  it, a literal is an *unmapped* fake-IP — Clash assigned no name to it, so the
  TUN carries nothing and nothing answers HTTP in that range. A mapped fake-IP
  adds no capability either: whoever can write `198.18.x.y` (an address Clash
  mapped for `d`) can write `d` itself, which passes the guard the same way —
  the same property the gateway accepted when it started keeping the name for
  fake-IP-resolving hosts.

So the icon path is consistent with the gateway where the two face the same
sender, and stricter-or-looser only where their senders differ.

Branch: [`hunt52-a-icon-fakeip`](https://github.com/ggbdpq/magpie/tree/hunt52-a-icon-fakeip), one commit on top of upstream `dee5c9d7` — the protective test plus the small resolver seam it needs; the patch below applies with `git am`.

<details><summary>patch: provider: a test locks the icon fetch's fake-IP shape through a loopback proxy — git am applies it as is</summary>

```patch
From 9e52c7bdd498d337c2904fab962ab067218c9398 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Tue, 20 Oct 2026 21:33:51 +0800
Subject: [PATCH] provider: lock the icon fetch sending a site's name through a
 loopback proxy under fake-ip

#2593's loopback-proxy case: with Clash TUN fake-ip (or Surge's enhanced
mode) the resolver answers every name into 198.18.0.0/15, and an icon
fetch through a proxy on this computer works only if the proxy is asked
for the site's NAME - a CONNECT by a pinned fake-IP address fails there.
That already works, and this locks it: net/http's transport dials only
the proxy's own address when one is set (guardClient's proxies map
exempts it from the dial guard) and the CONNECT line carries the name;
nothing resolves or pins the target locally on that path.

Protective and green before. A resolver seam (lookupIPAddr, as the
gateway's lookupIP already is) lets the test stand in Clash's answer;
a RoundTrip-time pin, what the gateway's image fetch once did, fails
it with "the proxy was not asked for the name".

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/provider/icon.go      | 11 +++++++--
 internal/provider/icon_test.go | 43 ++++++++++++++++++++++++++++++++++
 2 files changed, 52 insertions(+), 2 deletions(-)

diff --git a/internal/provider/icon.go b/internal/provider/icon.go
index 9a88f971..045da8b4 100644
--- a/internal/provider/icon.go
+++ b/internal/provider/icon.go
@@ -120,11 +120,18 @@ func guardClient() *http.Client {
 	return &c
 }
 
+// lookupIPAddr is where the icon guard resolves a host; tests point it at
+// a fake-IP answer to stand for Clash TUN's (#252), as the gateway's
+// lookupIP is for its guard.
+var lookupIPAddr = func(ctx context.Context, host string) ([]net.IPAddr, error) {
+	return net.DefaultResolver.LookupIPAddr(ctx, host)
+}
+
 // publicHost checks a site's answers with the same rules as publicDial,
 // for a fetch the proxy will make. A name that doesn't resolve
 // here is left to the proxy, which may be the only way to reach it.
 func publicHost(ctx context.Context, host string) error {
-	ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
+	ips, err := lookupIPAddr(ctx, host)
 	if err != nil {
 		return nil
 	}
@@ -185,7 +192,7 @@ func publicDial(ctx context.Context, dial func(context.Context, string, string)
 	if err != nil {
 		return nil, err
 	}
-	ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
+	ips, err := lookupIPAddr(ctx, host)
 	if err != nil {
 		return nil, err
 	}
diff --git a/internal/provider/icon_test.go b/internal/provider/icon_test.go
index 8f2326d3..e5d9081f 100644
--- a/internal/provider/icon_test.go
+++ b/internal/provider/icon_test.go
@@ -289,3 +289,46 @@ func TestGuardClientThroughLocalProxy(t *testing.T) {
 		t.Fatalf("the proxy was asked for a private site: %v", asked)
 	}
 }
+
+// Protective, green before (#2593): with Clash's TUN fake-ip or Surge's
+// enhanced mode on, the resolver answers every name into 198.18.0.0/15,
+// and through a proxy on this computer the fetch works only if the proxy
+// is asked for the site's NAME — a CONNECT by a pinned fake-IP address
+// fails there, since the proxy resolves it where magpie can't see. The
+// guard judges the name before the proxy is asked, the proxy's own
+// address is dialed as it is, and the CONNECT line carries the name. This
+// locks behavior that already works, so a later change that pins the
+// address (as the gateway's image fetch once did) fails here first.
+func TestGuardClientFakeIPThroughLoopbackProxyKeepsName(t *testing.T) {
+	was := lookupIPAddr
+	lookupIPAddr = func(_ context.Context, _ string) ([]net.IPAddr, error) {
+		// what a fake-ip resolver answers for every name (#252)
+		return []net.IPAddr{{IP: net.ParseIP("198.18.7.11")}}, nil
+	}
+	t.Cleanup(func() { lookupIPAddr = was })
+
+	var connect string
+	proxy := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
+		if r.Method == http.MethodConnect {
+			connect = r.Host // authority form: name:port
+		}
+		rw.WriteHeader(http.StatusOK)
+	}))
+	defer proxy.Close()
+	pu, _ := url.Parse(proxy.URL)
+	dt := http.DefaultTransport.(*http.Transport)
+	old := dt.Proxy
+	dt.Proxy = http.ProxyURL(pu)
+	t.Cleanup(func() { dt.Proxy = old })
+
+	// The fetch ends in an error on purpose: the test proxy opens the
+	// tunnel and forwards nowhere, so the TLS handshake inside it fails.
+	// What is locked is what reached the proxy.
+	req, _ := http.NewRequest(http.MethodGet, "https://icon.example/logo.png", nil)
+	if _, err := guardClient().Do(req); err == nil {
+		t.Fatal("a fetch through a CONNECT-only test proxy was expected to fail")
+	}
+	if connect != "icon.example:443" {
+		t.Fatalf("the proxy was not asked for the name: %q", connect)
+	}
+}
-- 
2.50.1 (Apple Git-155)
```

</details>
