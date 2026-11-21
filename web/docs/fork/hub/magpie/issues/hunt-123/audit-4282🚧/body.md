A patch for this, on a branch — it follows the reporter's four requirements, and the isolated loopback setup here mirrors the reporter's own (credit to kylefu8 for the precise spec and the measurements).

**What's wrong.** A long session of screenshots pushes the request past a vendor's byte cap while the tokens still fit the model's window, and every turn is refused from then on. The plugin chain is no guarantee: as the reporter measured (34,603,056 bytes reaching a simulated upstream with the async hook and the sync middleware both failing), a plugin that fails or times out stands aside and the whole body goes out anyway. Nothing native checks the final size.

**Root cause.** The gateway has no surface for a per-provider cap on the bytes of one request as they actually go out. What exists acts on the model's token window (context fitting, the refit-smaller path) or inside plugins; no code measures the final body at the send site, so an over-cap body is always handed to the vendor and refused after the fact.

**The fix** (fork branch [`fix/4282-body-size-limit`](https://github.com/ggbdpq/magpie/tree/fix/4282-body-size-limit), head `c45499dd0ceb952b71a4a5a135bcd0c46f98c866`):

- `provider.BodyLimit`, off by default (0), per provider, clamped to at most 1 GiB. Set with `magpie provider body-limit <id> 28mib` — plain bytes or kb/kib/mb/mib/gib, `off` takes it away.
- Checked in `forwardOnce` immediately before `provider.SetBody` hands the body to the transport — after every plugin, route, protocol translation and context fitting has had its say. As the reporter asked, the metered layer is defined: it is the raw body handed to the transport, the plain bytes, counted before the zstd compression a Codex wire turn applies — the larger side of what the vendor receives.
- Over the limit, the request is refused locally with a 413 typed `request_too_large`, which says the size, the limit and where the limit is set. The provider is asked nothing (the tests assert 0 upstream calls), the body is not truncated, and the refusal is not acted on as a vendor word: it is marked so the refit-smaller path doesn't fit the body and ask again, and the fallback loop doesn't hand the body to another provider (serve reads the refusal's own words, the way `restrictedSaid` reads magpie's own words elsewhere). The provider is not rested by it either.
- A plugin that fails or times out cannot bypass the check: it sits after the whole plugin chain, whatever the plugins did.
- The GUI editor doesn't show the limit; a save keeps what it was set to.

<details>
<summary>patch (0001, 562 insertions, 10 files — also at <code>0001-gateway-a-provider-s-own-limit-on-the-bytes-of.patch</code> on the branch)</summary>

```diff
From c45499dd0ceb952b71a4a5a135bcd0c46f98c866 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Thu, 5 Nov 2026 01:14:15 +0800
Subject: [PATCH] gateway: a provider's own limit on the bytes of one request,
 refused here (#4282)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

A long session of screenshots can pass a vendor's byte cap while its
tokens still fit the model's window, and then every turn is refused and
the session can neither go on nor compact. The images a plugin shrinks
are no guarantee: a plugin that fails, or times out, stands aside and
the whole body goes (the reporter measured 34.6 MB reach an upstream
that way).

So a provider takes a BodyLimit, off by default, set with `magpie
provider body-limit <id> 28mib` (bytes, or kb/kib/mb/mib/gib, off to
take it away; at most a GiB). forwardOnce measures the body as it goes
out — after every plugin, route, translation and fitting has had its
say, the bytes provider.SetBody hands the transport, the Content-Length
on the wire. A body over the limit is refused with a 413 said here,
which says the size and the limit: the provider is asked nothing, the
body is not cut, and the request is not sent again — the refusal is
marked so refitOverCap doesn't read it as the vendor's word and fit the
body smaller to ask again, and it is not handed to the provider's
fallback either: the limit is the user's own word for this provider, and
the body never went out (serve reads the refusal's own words, as
restrictedSaid does). A turn to a Codex account goes zstd-compressed on
the wire; the limit counts it before that compression, the plain bytes,
the larger and so safer side of what the vendor receives.

The editor doesn't show the limit; a save keeps what it was set to, as
it keeps the rest cap.

Fixes #4282

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/cli/body_limit_cli_test.go  |  51 +++++++
 internal/cli/providers_cli.go        |  79 ++++++++++
 internal/gateway/body_limit.go       |  72 ++++++++++
 internal/gateway/body_limit_test.go  | 207 +++++++++++++++++++++++++++
 internal/gateway/gateway.go          |  20 ++-
 internal/gui/body_limit_save_test.go |  41 ++++++
 internal/gui/providers.go            |   5 +
 internal/provider/body_limit.go      |  27 ++++
 internal/provider/body_limit_test.go |  57 ++++++++
 internal/provider/provider.go        |   7 +
 10 files changed, 562 insertions(+), 4 deletions(-)
 create mode 100644 internal/cli/body_limit_cli_test.go
 create mode 100644 internal/gateway/body_limit.go
 create mode 100644 internal/gateway/body_limit_test.go
 create mode 100644 internal/gui/body_limit_save_test.go
 create mode 100644 internal/provider/body_limit.go
 create mode 100644 internal/provider/body_limit_test.go

diff --git a/internal/cli/body_limit_cli_test.go b/internal/cli/body_limit_cli_test.go
new file mode 100644
index 000000000..d4afb4015
--- /dev/null
+++ b/internal/cli/body_limit_cli_test.go
@@ -0,0 +1,51 @@
+package cli
+
+import (
+	"testing"
+
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// #4282: `magpie provider body-limit <id> 28mib` sets the most bytes one
+// request to the provider may take, a plain number counts bytes, and off
+// takes the limit away.
+func TestBodyLimitCmd(t *testing.T) {
+	home := t.TempDir()
+	t.Setenv("HOME", home)
+	t.Setenv("USERPROFILE", home)
+	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
+	if err := provider.Save(provider.Provider{ID: "xk", Name: "xk", Chat: "https://example.invalid/v1", Key: "k"}); err != nil {
+		t.Fatal(err)
+	}
+	limit := func() int {
+		p, err := provider.Find("xk")
+		if err != nil {
+			t.Fatal(err)
+		}
+		return p.BodyLimit
+	}
+	if err := bodyLimitCmd([]string{"xk", "28mib"}); err != nil || limit() != 28<<20 {
+		t.Fatalf("28mib: %d (%v)", limit(), err)
+	}
+	if err := bodyLimitCmd([]string{"xk", "1 MiB"}); err != nil || limit() != 1<<20 {
+		t.Fatalf("1 MiB: %d (%v)", limit(), err)
+	}
+	if err := bodyLimitCmd([]string{"xk", "2048"}); err != nil || limit() != 2048 {
+		t.Fatalf("2048: %d (%v)", limit(), err)
+	}
+	if err := bodyLimitCmd([]string{"xk", "off"}); err != nil || limit() != 0 {
+		t.Fatalf("off: %d (%v)", limit(), err)
+	}
+	if err := bodyLimitCmd([]string{"xk", "28zb"}); err == nil || limit() != 0 {
+		t.Fatal("28zb was taken")
+	}
+	if err := bodyLimitCmd([]string{"xk", "-5"}); err == nil || limit() != 0 {
+		t.Fatal("-5 was taken")
+	}
+	if err := bodyLimitCmd([]string{"nosuch", "1mib"}); err == nil {
+		t.Fatal("an unknown provider was given a limit")
+	}
+	if err := bodyLimitCmd([]string{"xk"}); err != nil {
+		t.Fatalf("reading alone: %v", err)
+	}
+}
diff --git a/internal/cli/providers_cli.go b/internal/cli/providers_cli.go
index a1e77c68d..18ca86258 100644
--- a/internal/cli/providers_cli.go
+++ b/internal/cli/providers_cli.go
@@ -9,6 +9,7 @@ import (
 	"maps"
 	"os"
 	"path/filepath"
+	"regexp"
 	"slices"
 	"strconv"
 	"strings"
@@ -117,6 +118,10 @@ const providerUsage = `usage:
                                           off: one that fails without saying why (a relay's 5xx) doesn't
                                           rest at all, while out of quota, its key refused or rate limited
                                           still rests it
+  magpie provider body-limit <id> [28mib|512kb|2048|off]
+                                          the most bytes one request to it may take, as it goes out, after plugins
+                                          and translation; a body over it is refused here and the provider asked
+                                          nothing (off: no limit)
   magpie provider listed <id> yes|no      no: its models serve only through routing groups, not in the list
   magpie provider off|on <id>             switch it off (kept, but no agent or request uses it), or on again
   magpie provider test <id> [--as codex|claude-code] [model…]
@@ -655,6 +660,8 @@ func providerCmd(args []string) error {
 		return quotaRestCmd(rest)
 	case "rest-cap":
 		return restCapCmd(rest)
+	case "body-limit":
+		return bodyLimitCmd(rest)
 	case "listed":
 		// no: the provider's models leave the list agents see and serve
 		// only through the routing groups they are in
@@ -2028,6 +2035,78 @@ func restCapMinutes(s string) (int, error) {
 	return restMinutes(s)
 }
 
+// bodyLimitCmd reads and sets the most bytes one request to a provider
+// may take (#4282): `magpie provider body-limit <id>` says it, `<id>
+// 28mib` sets it, `<id> off` takes it away.
+func bodyLimitCmd(rest []string) error {
+	if len(rest) < 1 || len(rest) > 2 {
+		return fmt.Errorf("magpie provider body-limit <id> [28mib|512kb|2048|off]")
+	}
+	p, err := provider.Find(rest[0])
+	if err != nil {
+		return err
+	}
+	if len(rest) > 1 {
+		n, err := bodyLimitBytes(rest[1])
+		if err != nil {
+			return err
+		}
+		if err := provider.SetBodyLimit(p.ID, n); err != nil {
+			return err
+		}
+		if p, err = provider.Find(p.ID); err != nil {
+			return err
+		}
+	}
+	if p.BodyLimit > 0 {
+		fmt.Printf("%s · one request to it takes at most %s, as it goes out; a body over it is refused here, the provider asked nothing (`magpie provider body-limit %s off` takes it away)\n", p.Name, sizeWords(p.BodyLimit), p.ID)
+	} else {
+		fmt.Printf("%s · requests of any size go to it (magpie's own)\n", p.Name)
+	}
+	return nil
+}
+
+// bodyLimitSize reads a size as bodyLimitCmd takes it: a number of
+// bytes, or the unit named — 2048, 512kb, 28mib. A kb is a KiB, as a
+// vendor counts a stated "32 MB … (33554432 bytes)".
+var bodyLimitSize = regexp.MustCompile(`^(\d+(?:\.\d+)?)\s*(b|bytes|kb|kib|mb|mib|gb|gib)?$`)
+
+// bodyLimitBytes is the bytes bodyLimitSize read.
+func bodyLimitBytes(s string) (int, error) {
+	s = strings.ToLower(strings.TrimSpace(s))
+	switch s {
+	case "off", "default", "none", "-", "0":
+		return 0, nil
+	}
+	m := bodyLimitSize.FindStringSubmatch(s)
+	if m == nil {
+		return 0, fmt.Errorf("the body limit is a number of bytes or a size (28mib, 512kb), or off, not %q", s)
+	}
+	f, err := strconv.ParseFloat(m[1], 64)
+	if err != nil || f < 0 {
+		return 0, fmt.Errorf("the body limit is a size, not %q", s)
+	}
+	unit := map[string]float64{"": 1, "b": 1, "bytes": 1, "kb": 1 << 10, "kib": 1 << 10, "mb": 1 << 20, "mib": 1 << 20, "gb": 1 << 30, "gib": 1 << 30}[m[2]]
+	if n := f * unit; n > float64(provider.MaxBodyLimit) {
+		return 0, fmt.Errorf("the most a body limit may be is %s (%d bytes), not %q", sizeWords(provider.MaxBodyLimit), provider.MaxBodyLimit, s)
+	} else {
+		return int(n), nil
+	}
+}
+
+// sizeWords says a number of bytes as a size: 1.0 MB, 28.0 MiB.
+func sizeWords(n int) string {
+	switch {
+	case n >= 1<<30 && n%(1<<30) == 0:
+		return fmt.Sprintf("%d GiB", n>>30)
+	case n >= 1<<20 && n%(1<<20) == 0:
+		return fmt.Sprintf("%d MiB", n>>20)
+	case n >= 1<<10 && n%(1<<10) == 0:
+		return fmt.Sprintf("%d KiB", n>>10)
+	}
+	return fmt.Sprintf("%d bytes", n)
+}
+
 // restMinutes reads a rest as quotaRestCmd takes it: default (0), a
 // number of minutes, a Go duration (90m, 6h) or a number of days (7d).
 func restMinutes(s string) (int, error) {
diff --git a/internal/gateway/body_limit.go b/internal/gateway/body_limit.go
new file mode 100644
index 000000000..0d365bcce
--- /dev/null
+++ b/internal/gateway/body_limit.go
@@ -0,0 +1,72 @@
+package gateway
+
+import (
+	"bytes"
+	"encoding/json"
+	"fmt"
+	"io"
+	"net/http"
+
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// A provider's own cap on the bytes of one request, as it goes out
+// (issue #4282, kylefu8). A long session of images can pass a vendor's
+// byte cap while its tokens still fit the model's window, and every turn
+// of it is refused from then on; the images a plugin shrinks are no
+// guarantee, a plugin that fails or times out standing aside. So the
+// user sets a limit per provider, and forwardOnce measures the request
+// after every plugin, route, translation and fitting has had its say —
+// the bytes provider.SetBody hands the transport, the Content-Length on
+// the wire. A body over the limit is refused with a 413 said here: the
+// provider is asked nothing, the body is not cut, and the request is not
+// sent again, fitted or otherwise. A turn to a Codex account goes
+// zstd-compressed on the wire; the limit counts it before that
+// compression, the plain bytes, which is the larger and so the safer
+// side of what the vendor receives.
+
+// bodyLimitMark marks, for the moment forward reads it, the 413 said
+// here for a body over the provider's BodyLimit. It comes off at once:
+// the vendor's learned byte cap (refitOverCap) would fit such a body
+// smaller and ask again, and this request never went out.
+const bodyLimitMark = "Magpie-Body-Limit"
+
+// refusedForBodyLimit says whether res is the 413 said here for a body
+// over the provider's BodyLimit, and takes its mark off.
+func refusedForBodyLimit(res *http.Response) bool {
+	if res == nil || res.Header.Get(bodyLimitMark) == "" {
+		return false
+	}
+	res.Header.Del(bodyLimitMark)
+	return true
+}
+
+// bodyLimitWords is what that 413 calls itself: the one phrase no vendor
+// says, by which the refusal is known again where it lands (as
+// restrictedSaid knows magpie's own words of a restricted account).
+const bodyLimitWords = "the provider's body limit, `magpie provider body-limit`"
+
+// bodyLimitSaid says a refusal is the 413 said here for a body over the
+// provider's BodyLimit, read from its words. serve reads it to keep the
+// refusal from being handed to another member: the limit is the user's
+// own word for this provider, and the body never went out, so there is
+// nothing of it for another to take.
+func bodyLimitSaid(body []byte) bool {
+	return bytes.Contains(body, []byte(bodyLimitWords))
+}
+
+// bodyLimitRefusal is that 413: the size, the limit, and where the limit
+// is set, said as a request_too_large so a client that compacts on one
+// (Codex) may do so.
+func bodyLimitRefusal(p provider.Provider, size, limit int) *http.Response {
+	msg := fmt.Sprintf("the request is %s, over the %s most %s takes in one request (%s); it was not sent", mb(size), mb(limit), p.Name, bodyLimitWords)
+	out, _ := json.Marshal(map[string]any{"type": "error", "error": map[string]any{"type": "request_too_large", "message": msg}})
+	h := http.Header{}
+	h.Set("Content-Type", "application/json")
+	h.Set(bodyLimitMark, "1")
+	return &http.Response{
+		Status: "413 Request Entity Too Large", StatusCode: http.StatusRequestEntityTooLarge,
+		Proto: "HTTP/1.1", ProtoMajor: 1, ProtoMinor: 1,
+		Header: h, Body: io.NopCloser(bytes.NewReader(out)), ContentLength: int64(len(out)),
+	}
+}
diff --git a/internal/gateway/body_limit_test.go b/internal/gateway/body_limit_test.go
new file mode 100644
index 000000000..ad8c38716
--- /dev/null
+++ b/internal/gateway/body_limit_test.go
@@ -0,0 +1,207 @@
+package gateway
+
+import (
+	"io"
+	"net/http"
+	"net/http/httptest"
+	"strings"
+	"sync"
+	"testing"
+
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// limitedUp is an upstream that answers every request with a summary and
+// keeps every body it was sent, for the tests of a provider's own body
+// limit (body_limit.go).
+type limitedUp struct {
+	proto provider.Protocol
+	mu    sync.Mutex
+	got   [][]byte
+}
+
+func (u *limitedUp) ServeHTTP(w http.ResponseWriter, r *http.Request) {
+	b, _ := io.ReadAll(r.Body)
+	u.mu.Lock()
+	u.got = append(u.got, b)
+	u.mu.Unlock()
+	if u.proto == provider.Chat {
+		w.Header().Set("Content-Type", "text/event-stream")
+		io.WriteString(w, sse(
+			`data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"SUMMARY"}}]}`,
+			`data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1}}`,
+			`data: [DONE]`))
+		return
+	}
+	w.Header().Set("Content-Type", "text/event-stream")
+	io.WriteString(w, sse(
+		`data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"SUMMARY"}]}}`,
+		`data: {"type":"response.completed","response":{"id":"resp_s","status":"completed","output":[]}}`))
+}
+
+func (u *limitedUp) calls() [][]byte {
+	u.mu.Lock()
+	defer u.mu.Unlock()
+	return append([][]byte(nil), u.got...)
+}
+
+// limitOn points magpie's provider file at a temp dir and adds provider
+// "fake" on up, whose body limit is n bytes (0: none, as it is by
+// default).
+func limitOn(t *testing.T, up *limitedUp, n int) {
+	t.Helper()
+	noRests()
+	t.Cleanup(noRests)
+	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
+	t.Setenv("XDG_CACHE_HOME", t.TempDir())
+	host := httptest.NewServer(up)
+	t.Cleanup(host.Close)
+	p := provider.Provider{ID: "fake", Name: "1017dp", Key: "k", Models: []string{"m1"}, BodyLimit: n}
+	if up.proto == provider.Chat {
+		p.Chat = host.URL + "/v1"
+	} else {
+		p.Responses = host.URL + "/v1"
+	}
+	if err := provider.Save(p); err != nil {
+		t.Fatal(err)
+	}
+}
+
+// longTurn is a Codex turn whose body carries a plain Chinese text well
+// over a MiB: UTF-8 counted in bytes, as a vendor counts them.
+func longTurn(fill int) string {
+	return `{"model":"fake/m1","stream":true,"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"请把这整段记录压缩成一句话 ` + strings.Repeat("记录", fill) + `"}]}]}`
+}
+
+// A provider's own body limit refuses an over-the-limit request here, a
+// 413 that says the size and the limit: the upstream is asked nothing,
+// and nothing is sent again in its place (issue #4282). The limit counts
+// bytes, a Chinese text among them.
+func TestBodyLimitRefusedUnsent(t *testing.T) {
+	up := &limitedUp{proto: provider.Responses}
+	limitOn(t, up, 1<<20)
+	body := longTurn(300_000)
+	if len(body) <= 1<<20 {
+		t.Fatalf("the test body is only %d bytes", len(body))
+	}
+	code, said := post(t, "/v1/responses", body)
+	if code != http.StatusRequestEntityTooLarge {
+		t.Fatalf("answered %d: %.400s", code, said)
+	}
+	if !strings.Contains(said, "request_too_large") || !strings.Contains(said, "body limit") {
+		t.Errorf("the refusal doesn't say it is the body limit: %.400s", said)
+	}
+	if n := len(up.calls()); n != 0 {
+		t.Fatalf("the upstream was asked %d times", n)
+	}
+}
+
+// With no body limit set — as it is by default — the same body goes to
+// the provider as it always did.
+func TestBodyLimitOffByDefault(t *testing.T) {
+	up := &limitedUp{proto: provider.Responses}
+	limitOn(t, up, 0)
+	code, said := post(t, "/v1/responses", longTurn(300_000))
+	if code != 200 {
+		t.Fatalf("answered %d: %.400s", code, said)
+	}
+	if n := len(up.calls()); n != 1 {
+		t.Fatalf("the upstream was asked %d times", n)
+	}
+}
+
+// The limit counts the request's final body, as it goes out after the
+// protocol's conversion (an Anthropic client asked as Chat), not the body
+// the client sent; a body that comes to exactly the limit goes.
+func TestBodyLimitCountsTheBodyAsSent(t *testing.T) {
+	// as it goes out, with no limit: the converted body's size, which a
+	// conversion may only grow
+	up := &limitedUp{proto: provider.Chat}
+	limitOn(t, up, 0)
+	body := `{"model":"fake/m1","max_tokens":16,"messages":[{"role":"user","content":"请把这段记录压缩成一句话 ` + strings.Repeat("记录", 60_000) + `"}]}`
+	sizes := map[int]bool{}
+	for range 2 {
+		code, said := postAnthropic(t, body)
+		if code != 200 {
+			t.Fatalf("answered %d: %.400s", code, said)
+		}
+		calls := up.calls()
+		sizes[len(calls[len(calls)-1])] = true
+	}
+	if len(sizes) != 1 {
+		t.Fatalf("the converted body came out %v over two asks", sizes)
+	}
+	sent := len(up.calls()[0])
+	if inbound := len(body); inbound >= sent-1 {
+		t.Fatalf("the conversion didn't grow the body: %d in, %d out", inbound, sent)
+	}
+
+	// a byte under what went out: refused here, the upstream asked nothing
+	up2 := &limitedUp{proto: provider.Chat}
+	limitOn(t, up2, sent-1)
+	if code, said := postAnthropic(t, body); code != http.StatusRequestEntityTooLarge {
+		t.Fatalf("a byte under the size it goes out at answered %d: %.400s", code, said)
+	}
+	if n := len(up2.calls()); n != 0 {
+		t.Fatalf("the upstream was asked %d times", n)
+	}
+
+	// the size it goes out at, exactly: it goes
+	up3 := &limitedUp{proto: provider.Chat}
+	limitOn(t, up3, sent)
+	if code, said := postAnthropic(t, body); code != 200 {
+		t.Fatalf("at the size it goes out at exactly, answered %d: %.400s", code, said)
+	}
+	if n := len(up3.calls()); n != 1 {
+		t.Fatalf("the upstream was asked %d times", n)
+	}
+}
+
+// The refusal is not handed to the provider's fallback: the limit is the
+// user's own word for this provider, the body never went out, and no
+// other provider is asked for it — nothing is retried, nothing switches
+// (issue #4282). A vendor's own 413 hands over, as it always did; this
+// one was never the vendor's word.
+func TestBodyLimitRefusalNotHandedOver(t *testing.T) {
+	upA := &limitedUp{proto: provider.Responses}
+	upB := &limitedUp{proto: provider.Responses}
+	noRests()
+	t.Cleanup(noRests)
+	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
+	t.Setenv("XDG_CACHE_HOME", t.TempDir())
+	hostA := httptest.NewServer(upA)
+	hostB := httptest.NewServer(upB)
+	t.Cleanup(func() { hostA.Close(); hostB.Close() })
+	p := provider.Provider{ID: "fake", Name: "1017dp", Key: "k", Models: []string{"m1"}, BodyLimit: 1 << 20, Fallback: []string{"fake2/m1"}, Responses: hostA.URL + "/v1"}
+	if err := provider.Save(p); err != nil {
+		t.Fatal(err)
+	}
+	p2 := provider.Provider{ID: "fake2", Name: "1017dp2", Key: "k", Models: []string{"m1"}, Responses: hostB.URL + "/v1"}
+	if err := provider.Save(p2); err != nil {
+		t.Fatal(err)
+	}
+	code, said := post(t, "/v1/responses", longTurn(300_000))
+	if code != http.StatusRequestEntityTooLarge {
+		t.Fatalf("answered %d: %.400s", code, said)
+	}
+	if !strings.Contains(said, "body limit") {
+		t.Errorf("the refusal doesn't say it is the body limit: %.400s", said)
+	}
+	if n := len(upA.calls()); n != 0 {
+		t.Fatalf("the limited provider was asked %d times", n)
+	}
+	if n := len(upB.calls()); n != 0 {
+		t.Fatalf("the fallback was asked for a body the limit refused, %d times, and answered it", n)
+	}
+}
+
+// postAnthropic asks the gateway's /v1/messages as Claude Code does.
+func postAnthropic(t *testing.T, body string) (int, string) {
+	t.Helper()
+	rec := httptest.NewRecorder()
+	req := httptest.NewRequest("POST", "/v1/messages", strings.NewReader(body))
+	req.Header.Set("Content-Type", "application/json")
+	req.Header.Set("anthropic-version", "2023-06-01")
+	New().Handler().ServeHTTP(rec, req)
+	return rec.Code, rec.Body.String()
+}
diff --git a/internal/gateway/gateway.go b/internal/gateway/gateway.go
index 757d55393..15486b6b5 100644
--- a/internal/gateway/gateway.go
+++ b/internal/gateway/gateway.go
@@ -4134,7 +4134,7 @@ func (s *Server) serve(w http.ResponseWriter, r *http.Request, from provider.Pro
 				break
 			}
 		}
-		if !last && !hw.passing && !hw.refused && (hw.code() == http.StatusRequestEntityTooLarge || overflowed(hw.code(), hw.errBody())) {
+		if !last && !hw.passing && !hw.refused && !bodyLimitSaid(hw.errBody()) && (hw.code() == http.StatusRequestEntityTooLarge || overflowed(hw.code(), hw.errBody())) {
 			// too long for this member's model, and as long on every
 			// account of it, but another member — another model, or this
 			// one at another vendor — may hold it (#700: the overflow went
@@ -4142,7 +4142,10 @@ func (s *Server) serve(w http.ResponseWriter, r *http.Request, from provider.Pro
 			// window, where the next member would have answered). Only
 			// those not known to be too small are left to ask; none, and
 			// the agent is told, to compact. A byte cap (413) also belongs
-			// to this member: another vendor may take the same body. It
+			// to this member: another vendor may take the same body — but
+			// the 413 said here for the provider's own body limit isn't
+			// handed over (body_limit.go): the limit is the user's own
+			// word for this provider, and the body never went out. It
 			// doesn't say the request exceeds another model's window, so
 			// no token estimate filters those members. Nobody rests.
 			tokens := 0
@@ -5235,9 +5238,11 @@ func (s *Server) forward(ctx context.Context, p provider.Provider, to provider.P
 		}
 	}()
 	res, err = s.forwardOnce(ctx, p, to, path, body, in)
-	if err == nil && res.StatusCode >= 400 {
+	if !refusedForBodyLimit(res) && err == nil && res.StatusCode >= 400 {
 		// a body over the provider's byte cap: asked again with its
-		// oldest images left out, or said as a 413 (body_cap.go)
+		// oldest images left out, or said as a 413 (body_cap.go) — but
+		// the 413 said here for the provider's own body limit isn't
+		// fitted and isn't asked again (body_limit.go)
 		res, err = s.refitOverCap(ctx, p, to, path, body, in, res)
 	}
 	if err == nil && mantleRoutes(p, to) {
@@ -5408,6 +5413,13 @@ func (s *Server) forwardOnce(ctx context.Context, p provider.Provider, to provid
 		}
 		path, body = at, b
 	}
+	if n := p.BodyLimit; n > 0 && len(body) > n {
+		// the provider's own body limit (body_limit.go): the last word on
+		// the body as it goes out, after every plugin, route, translation
+		// and fitting has had its say. Refused here, the provider asked
+		// nothing, and nothing is sent again for it.
+		return bodyLimitRefusal(p, len(body), n), nil
+	}
 	base := p.Base(to)
 	zenFree := p.IsOpenCode() && p.OpenCodeFree(gjson.GetBytes(body, "model").String())
 	if zenFree {
diff --git a/internal/gui/body_limit_save_test.go b/internal/gui/body_limit_save_test.go
new file mode 100644
index 000000000..d0a9a22cb
--- /dev/null
+++ b/internal/gui/body_limit_save_test.go
@@ -0,0 +1,41 @@
+package gui
+
+import (
+	"net/http"
+	"net/http/httptest"
+	"strings"
+	"testing"
+
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// #4282: the editor knows nothing of the most bytes one request to a
+// provider may take, set with `magpie provider body-limit <id> 28mib`,
+// so its save keeps it.
+func TestSaveKeepsBodyLimit(t *testing.T) {
+	home := t.TempDir()
+	t.Setenv("HOME", home)
+	t.Setenv("USERPROFILE", home)
+	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
+	t.Setenv("XDG_CACHE_HOME", t.TempDir())
+	if err := provider.Save(provider.Provider{ID: "limit-test", Name: "Limit", Chat: "https://example.invalid/v1", Key: "k"}); err != nil {
+		t.Fatal(err)
+	}
+	if err := provider.SetBodyLimit("limit-test", 28<<20); err != nil {
+		t.Fatal(err)
+	}
+	mux := http.NewServeMux()
+	providerRoutes(mux, nil)
+	w := httptest.NewRecorder()
+	mux.ServeHTTP(w, httptest.NewRequest("POST", "/api/provider/save", strings.NewReader(`{"id":"limit-test","name":"Limit","chat":"https://example.invalid/v1"}`)))
+	if w.Code != 200 {
+		t.Fatalf("%d %s", w.Code, w.Body)
+	}
+	got, err := provider.Find("limit-test")
+	if err != nil {
+		t.Fatal(err)
+	}
+	if got.BodyLimit != 28<<20 || got.Name != "Limit" {
+		t.Fatalf("the save dropped the body limit %d", got.BodyLimit)
+	}
+}
diff --git a/internal/gui/providers.go b/internal/gui/providers.go
index 50a1f8e12..246e5408b 100644
--- a/internal/gui/providers.go
+++ b/internal/gui/providers.go
@@ -1878,6 +1878,11 @@ func providerRoutes(mux *http.ServeMux, w Windows) {
 				if in.RestCap == 0 && old != nil {
 					in.RestCap = old.RestCap
 				}
+				// and the most bytes one request to it may take, set
+				// with `magpie provider body-limit` (#4282)
+				if in.BodyLimit == 0 && old != nil {
+					in.BodyLimit = old.BodyLimit
+				}
 				// and Codex's requests as sent, set with `magpie provider
 				// set <id> codex=as-sent` (#1758)
 				if !in.CodexAsSent && old != nil {
diff --git a/internal/provider/body_limit.go b/internal/provider/body_limit.go
new file mode 100644
index 000000000..530fcfc08
--- /dev/null
+++ b/internal/provider/body_limit.go
@@ -0,0 +1,27 @@
+package provider
+
+import (
+	"fmt"
+)
+
+// MaxBodyLimit is the most a provider's body limit may be set to. A
+// vendor's own cap is far under it: Command Code takes 32 MiB in one
+// request, a long Codex turn runs 45 MiB, and a GiB leaves room for
+// either many times over.
+const MaxBodyLimit = 1 << 30
+
+// SetBodyLimit sets the most bytes one request to the provider may take,
+// measured as it goes out (issue #4282): a body over it is refused
+// before the provider is asked anything, and is not cut or sent again.
+// 0, the default, takes the limit away.
+func SetBodyLimit(id string, bytes int) error {
+	if bytes < 0 || bytes > MaxBodyLimit {
+		return fmt.Errorf("the body limit is from 0 (off) to %d bytes (a GiB), not %d", MaxBodyLimit, bytes)
+	}
+	p, err := Find(id)
+	if err != nil {
+		return err
+	}
+	p.BodyLimit = bytes
+	return Save(*p)
+}
diff --git a/internal/provider/body_limit_test.go b/internal/provider/body_limit_test.go
new file mode 100644
index 000000000..ec72df235
--- /dev/null
+++ b/internal/provider/body_limit_test.go
@@ -0,0 +1,57 @@
+package provider
+
+import (
+	"testing"
+)
+
+// A provider's body limit is 0 (off) unless it is set, is never negative,
+// and is kept within a GiB (issue #4282).
+func TestBodyLimitNormalize(t *testing.T) {
+	if p := normalize(Provider{BodyLimit: 0}); p.BodyLimit != 0 {
+		t.Fatalf("the default isn't off: %d", p.BodyLimit)
+	}
+	if p := normalize(Provider{BodyLimit: -4}); p.BodyLimit != 0 {
+		t.Fatalf("a negative limit is %d, not off", p.BodyLimit)
+	}
+	if p := normalize(Provider{BodyLimit: 28 << 20}); p.BodyLimit != 28<<20 {
+		t.Fatalf("28 MiB came out %d", p.BodyLimit)
+	}
+	if p := normalize(Provider{BodyLimit: MaxBodyLimit + 1}); p.BodyLimit != MaxBodyLimit {
+		t.Fatalf("over the most came out %d, not %d", p.BodyLimit, MaxBodyLimit)
+	}
+}
+
+// `SetBodyLimit` sets the most bytes one request to a provider may take,
+// takes it back off, and refuses a limit it could never keep.
+func TestSetBodyLimit(t *testing.T) {
+	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
+	t.Setenv("XDG_CACHE_HOME", t.TempDir())
+	if err := Save(Provider{ID: "bl", Name: "bl", Chat: "https://example.invalid/v1", Key: "k"}); err != nil {
+		t.Fatal(err)
+	}
+	if err := SetBodyLimit("bl", 28<<20); err != nil {
+		t.Fatal(err)
+	}
+	p, err := Find("bl")
+	if err != nil {
+		t.Fatal(err)
+	}
+	if p.BodyLimit != 28<<20 {
+		t.Fatalf("the limit is %d", p.BodyLimit)
+	}
+	if err := SetBodyLimit("bl", -1); err == nil {
+		t.Fatal("a negative limit was taken")
+	}
+	if err := SetBodyLimit("bl", MaxBodyLimit+1); err == nil {
+		t.Fatal("a limit over the most was taken")
+	}
+	if err := SetBodyLimit("bl", 0); err != nil {
+		t.Fatal(err)
+	}
+	if p, err = Find("bl"); err != nil || p.BodyLimit != 0 {
+		t.Fatalf("off left %d (%v)", p.BodyLimit, err)
+	}
+	if err := SetBodyLimit("nosuch", 1); err == nil {
+		t.Fatal("an unknown provider was given a limit")
+	}
+}
diff --git a/internal/provider/provider.go b/internal/provider/provider.go
index b333f4fa9..984f3bd4b 100644
--- a/internal/provider/provider.go
+++ b/internal/provider/provider.go
@@ -241,6 +241,12 @@ type Provider struct {
 	// upstreams, and a rest of half an hour held every request back until
 	// magpie restarted). Off by default: such a refusal rests it as ever.
 	LimitRestOff bool `json:"limitRestOff,omitempty"`
+	// BodyLimit is the most bytes one request to the provider may take,
+	// measured as it goes out, after every plugin, route and translation
+	// has had its say (#4282). A body over it is refused before the
+	// provider is asked anything: not cut, not sent again. 0 sends
+	// requests of any size, as it does by default.
+	BodyLimit int `json:"bodyLimit,omitempty"`
 
 	// PriceRate is what the provider charges against the official price
 	// (ITea312, #819): a relay that bills 0.8× or 1.5× of it. It scales the
@@ -1680,6 +1686,7 @@ func normalize(p Provider) Provider {
 	p.AccountWeights = normalAccountWeights(p.AccountWeights)
 	p.QueueLimit, p.QueueWait = min(max(p.QueueLimit, 0), MaxQueueLimit), min(max(p.QueueWait, 0), MaxQueueWait)
 	p.MaxRPM = min(max(p.MaxRPM, 0), MaxRPMLimit)
+	p.BodyLimit = min(max(p.BodyLimit, 0), MaxBodyLimit)
 	p.QuotaRest = min(max(p.QuotaRest, 0), MaxQuotaRest)
 	if p.RestCap != RestCapOff {
 		p.RestCap = min(max(p.RestCap, 0), MaxQuotaRest)
-- 
2.50.1 (Apple Git-155)

```

</details>

**Verification** (loopback httptest upstreams only, no real vendor called — the same isolation the reporter used):

| Check | Result |
| --- | --- |
| `go test -run 'TestBodyLimitRefusedUnsent\|TestBodyLimitOffByDefault\|TestBodyLimitCountsTheBodyAsSent\|TestBodyLimitRefusalNotHandedOver\|TestBodyLimitNormalize\|TestSetBodyLimit\|TestBodyLimitCmd\|TestSaveKeepsBodyLimit' -count=1` in gateway/provider/cli/gui | all pass |
| `TestBodyLimitRefusedUnsent` — over-limit refused as 413 saying size and limit, upstream asked 0 times, UTF-8 Chinese text among the counted bytes | pass |
| `TestBodyLimitCountsTheBodyAsSent` — the counted body is the converted one as it goes out (Anthropic client, Chat upstream: the conversion grows it), a body exactly at the limit goes | pass |
| `TestBodyLimitRefusalNotHandedOver` — with a fallback configured, the refusal is not handed to it: 413 to the agent, fallback upstream asked 0 times; before the serve-loop guard this failed with `answered 200` (the fallback was asked with the same body) | pass |
| `go test -tags nogui -count=1 -timeout 25m ./internal/gateway/` | ok, 705.99s, 0 failures |
| `gofmt -l` on touched files, `go vet` on gateway/provider/cli | clean |
| Ablation: product files reverted to the parent commit | the new tests fail (build: `undefined: bodyLimitCmd`, `undefined: provider.SetBodyLimit`, `BodyLimit undefined`) |
| Rebased on current `upstream/main` before the runs | clean, no conflicts |

**Not verified / boundaries.** No run against a real vendor account — loopback upstreams only, so the real bytes a vendor counts are not measured here. The tests exercise the Responses and Chat protocols through the Anthropic client; other protocols reach the same single checkpoint in `forwardOnce` but are not exercised by the new tests. A vendor that measures the body differently again (re-encoding at its own edge) may still disagree with this count — this limit is the user's own guard, set below what the vendor takes, not a claim of any vendor's official cap.

The patch is AI-written (GLM-5.3-Flash via ZCode), authored and committed by ggbdpq. Branch head: `c45499dd0ceb952b71a4a5a135bcd0c46f98c866`.
