Each point of the review, and what the third form does about it:

- **metadata.user_id** — the body's metadata is untouched now: `buildChat` renders none and a Responses client's metadata is not read, so Claude Code's `user_id` (the account uuid and session) has no ride to any Chat provider, and none is sent again after a refusal either (that whole refusal-retry shape is gone with the carrying).
- **`?beta=true`** — the query merge is gone entirely: a translated request goes by the path `upstreamPath` names, byte for byte as main, and nothing of the caller's URL rides it.
- **`X-Cid` to subscription vendors** — the header no longer goes on `forwardOnce`'s shared path, where every ask got it: it is set only for a translated ask, and only when the provider is not a signed-in account's (`p.Account == nil` is part of the only place the mark is made). A relayed request carries none even when the provider is opted in, so the vendor a caller reaches as itself — most of all a subscription's — is never handed it.
- **the query filter's list of key names** — gone with the merge; nothing filters, nothing merges.
- **narrow opt-in** — carrying is now one field the user turns on for one provider, `carry-cid=yes` (provider.CarryCid, off by default). Off, the default, the request is byte for byte what main sends today: no metadata, no query, no header. On, only the header rides, only on the translated route, and only if the caller sent one — none is invented. What still needs your call, and why the shape is where it is:
  1. the field's name (`carry-cid`) and the header's (`X-Cid`, the report's own);
  2. whether the header alone is worth carrying at all, given the other two carriers stay dead — we propose leaving the body's metadata and the query dead until you say otherwise, since no filter or mapping of theirs can be made safe against the names magpie doesn't know;
  3. whether a relayed provider should be able to opt in the same way (this patch says no: the report's loss is the translated route's, and the relay's vendor sees the caller's traffic as itself).

The caller's own header for the provider still has the last word: the user's `X-Cid` in SentHeaders replaces it in the signing, as any user header does.

## Verification

| Check | Result |
|---|---|
| `go test -tags nogui -count=1 -run 'TestTranslatedRequestCarriesOnlyTheOptedInCidHeader\|TestTranslatedRequestCarriesNothingByDefault\|TestRelayedRequestCarriesNoCallerCidEvenWhenOptedIn\|TestOptedInProviderInventsNoCidHeader' ./internal/gateway` | ok (4 tests, also at `-race`) |
| RED, clean main `da169135a` | `p.CarryCid undefined (type provider.Provider has no field or method CarryCid)` — there is no way to opt in |
| RED, field+CLI only (gateway not reading) | `the opted-in provider's upstream got X-Cid "", want the caller's` (T1); T2/T3/T4 green there — the zero-change faces hold before the fix too |
| Ablation: gateway.go reverted to the parent, field/CLI/tests kept | T1 red again with the same line; green with the commit restored |
| `go test -tags nogui -count=1 -timeout 25m -v ./internal/gateway` | 4085 pass, 1 red: TestKeyLimitReservationsStayInTheirWindow/total/tokens — red on the parent `da169135a` alone too (this machine), not this change; an earlier full run hit the default 10-minute suite timeout while a severed-passthrough test waited on IO, and that test passes alone in ~1s on both this branch and the parent |
| `go test -tags nogui -count=1 ./internal/provider` | ok |
| `go test -tags nogui -count=1 ./internal/cli` | 4 red: TestHealthcheckFindsTheRunningGatewayWithoutMagpieAddr, TestUpdateRestartsTheGatewayItFindsWithoutMagpieAddr, TestEveryRouteHasACommandOrIsNamed, TestUpdateFindsAMagpieThatWroteNoRecord — red on the parent `da169135a` too (this machine's own gateway on :3425 answers the find-tests; the route test wants a command for `/api/plugin-pages/arrange`), not this change |
| `go test -tags nogui -count=1 ./internal/gui` | 2 red, TestProxyCheckSaysAProxyPassedBy and TestSessionReadsRoutes — both known reds on main |
| `gofmt -l` (5 touched files), `go vet -tags nogui ./internal/gateway ./internal/provider ./internal/cli ./internal/gui` | clean |
| `go build -tags nogui` darwin / GOOS=linux / GOOS=windows | ok |

**Source**: the report's three carriers at a translated provider (url= only); the review's four named harms and the opt-in call.

**Red without the fix** (parent `da169135a`): the caller's `X-Cid` never reaches a translated provider's upstream; with the field and the CLI word alone (no reader) the same request still shows `X-Cid ""` upstream — the config is silently ignored, which is what the ablation re-reds.

**Siblings, changed and not**: the GUI's provider save keeps fields its editor doesn't show (`in.X = old.X` for what the CLI or TUI set) — CarryCid added to that keep-list, or one save in the editor would strip the opt-in. Not changed: `forwardOnce`'s per-client header copies (Claude Code's relay, Codex's, bili's, OpenCode's, Cline's, Kilo's — each an established shape contract; X-Cid is in none of them and they are byte-for-byte as they were); `passthrough` (relayed asks carry none, test-locked); `countOn`'s count_tokens; the Bedrock branch that already strips `metadata` (#176, the existing per-endpoint care this shape follows); the IR's reading of an Anthropic client's metadata (inbound parsing; its rendering stays Anthropic-endpoints only, #359); a Responses client's `client_metadata`; `session_parent`'s `x-codex-turn-metadata` (internal bookkeeping); `AddCopy`'s flag propagation and `accountSettings`' inheritance (an opt-in is one provider's word, and the `p.Account == nil` gate makes inheritance moot); `normalize` and storage (whole-struct, the field rides).

**When the read fails**: a caller that sent no `X-Cid` gets none invented (test); an unmarked provider behaves byte for byte as main (test); magpie's own probes, drawings and searches pass empty headers, so they never carry one; a request whose context holds no mark — relayed, counted, a subscription's — builds none in.

**Not verified**: no live vendor behind the stub — whether a real Chat endpoint accepts or ignores an `X-Cid` header is unexercised, and the opt-in is the user's word for it; no signed-in account in the test rig, so the `p.Account == nil` gate is code-read and sibling-reasoned, not run; the GUI keep-list line is code-read, not driven through an editor save.

---
**Attribution**: AI-written; I've read the whole diff and can answer questions on it myself. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>Patch details: gateway: a translated ask of a provider marked carry-cid=yes carries the caller's X-Cid header (#4899) — git am applies it as is; SHA-256 first 16: ffbee0f8225bed57</summary>

```
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 11 Nov 2026 22:15:42 +0800
Subject: [PATCH] gateway: a translated ask of a provider marked carry-cid=yes
 carries the caller's X-Cid header (#4899)

What changed
The caller's correlation carriers (the body's metadata, the X-Cid
header, the query string) never reached a translated provider
(yetone/magpie#4899). The review of the earlier patch named where the
carrying as written went wrong: Claude Code's metadata.user_id (the
account uuid and session) would reach every third-party Chat provider,
?beta=true would be added to Chat upstreams, an X-Cid header would go
to subscription vendors, which could fingerprint magpie by it, and the
query's secret filter was a list of key names, which misses the names
it doesn't know. Carrying would have to be a narrow opt-in.

So this carries only the header, only by the user's word, only on the
translated route:

- provider.CarryCid (carry-cid=yes|no on the CLI), off, the default:
  nothing of the caller's correlations goes anywhere, as it never has.
- On, the header rides the translated ask of that provider alone
  (callerCidKey set on forwardTranslated's context, put on the request
  in forwardOnce), and only when the caller sent it. No metadata, no
  query string: those two stay dropped, so no user_id leaves and no
  upstream URL gains a parameter.
- Never on a relayed ask and never for a signed-in account's provider:
  the mark is only made for p.Account == nil, and a vendor the caller
  reaches as itself is where a vendor could fingerprint magpie.
- The user's own header for the provider still replaces it in the
  signing.

Run
go test -tags nogui -count=1 -run
'TestTranslatedRequestCarriesOnlyTheOptedInCidHeader|TestTranslatedRequestCarriesNothingByDefault|TestRelayedRequestCarriesNoCallerCidEvenWhenOptedIn|TestOptedInProviderInventsNoCidHeader'
./internal/gateway

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/cli/providers_cli.go      |  12 +++
 internal/gateway/carry_cid_test.go | 167 +++++++++++++++++++++++++++++
 internal/gateway/gateway.go        |  23 ++++
 internal/gui/providers.go          |   1 +
 internal/provider/provider.go      |  11 ++
 5 files changed, 214 insertions(+)
 create mode 100644 internal/gateway/carry_cid_test.go

diff --git a/internal/cli/providers_cli.go b/internal/cli/providers_cli.go
index 0148279d7..63143d0b7 100644
--- a/internal/cli/providers_cli.go
+++ b/internal/cli/providers_cli.go
@@ -1383,6 +1383,18 @@ func applyPairs(p *provider.Provider, pairs []string) error {
 			default:
 				return fmt.Errorf("fallback-for-others=yes|no, not %q", v)
 			}
+		case "carry-cid":
+			// yes: a translated request of it carries the caller's X-Cid
+			// header (provider.CarryCid, #4899); no, the default: none of
+			// the caller's correlations goes anywhere
+			switch strings.ToLower(v) {
+			case "yes", "on":
+				p.CarryCid = true
+			case "no", "off":
+				p.CarryCid = false
+			default:
+				return fmt.Errorf("carry-cid=yes|no, not %q", v)
+			}
 		case "free":
 			// yes: every model of it counts as free for Free first and
 			// Cheapest routing, by the user's word (jiabubu on Discord:
diff --git a/internal/gateway/carry_cid_test.go b/internal/gateway/carry_cid_test.go
new file mode 100644
index 000000000..1fe13e867
--- /dev/null
+++ b/internal/gateway/carry_cid_test.go
@@ -0,0 +1,167 @@
+package gateway
+
+import (
+	"io"
+	"net/http"
+	"net/http/httptest"
+
+	"sync"
+	"testing"
+
+	"github.com/tidwall/gjson"
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// cidStub records what reached it — the query string, the headers and the
+// raw body — and answers an SSE stream, as Chat Completions or, when told,
+// as Anthropic (#4899).
+type cidStub struct {
+	mu          sync.Mutex
+	query       string
+	head        http.Header
+	body        []byte
+	asAnthropic bool
+}
+
+func (c *cidStub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
+	raw, _ := io.ReadAll(r.Body)
+	c.mu.Lock()
+	c.query, c.head, c.body = r.URL.RawQuery, r.Header, raw
+	anthropic := c.asAnthropic
+	c.mu.Unlock()
+	w.Header().Set("Content-Type", "text/event-stream")
+	if anthropic {
+		io.WriteString(w, "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"role\":\"assistant\",\"type\":\"message\",\"content\":[],\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}\n\n")
+		io.WriteString(w, "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n")
+		io.WriteString(w, "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"OK\"}}\n\n")
+		io.WriteString(w, "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n")
+		io.WriteString(w, "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":1}}\n\n")
+		io.WriteString(w, "data: {\"type\":\"message_stop\"}\n\n")
+		return
+	}
+	io.WriteString(w, chatReply)
+}
+
+func (c *cidStub) got() (string, http.Header, []byte) {
+	c.mu.Lock()
+	defer c.mu.Unlock()
+	return c.query, c.head, c.body
+}
+
+// The caller's correlation carriers against the review's named faces: a
+// request to a translated provider carries Claude Code's own metadata
+// (`user_id`, the account uuid and session) in the body, an `X-Cid` header
+// and a `cid` query — as the report asked for. None of the three may leave
+// unless the user marked that one provider as taking the header, and even
+// then only the header goes, only to a translated endpoint that is not a
+// signed-in account's: no metadata (it would hand the account uuid to the
+// vendor), no query (it would add ?beta=true upstream, and a filter of key
+// names misses the ones it doesn't know), never a subscription's vendor
+// (it could fingerprint magpie by the header) (#4899).
+const cidBody = `{"model":"fake/m1","max_tokens":100,"metadata":{"user_id":"user_aa11bb22_account_uuid_session_cc33"},"messages":[{"role":"user","content":"hi"}]}`
+
+func saveCidProvider(t *testing.T, url, field string) {
+	t.Helper()
+	p := provider.Provider{ID: "fake", Name: "Fake", Key: "k", Models: []string{"m1"}}
+	switch field {
+	case "chat":
+		p.Chat = url + "/v1"
+	case "chat-carry":
+		p.Chat = url + "/v1"
+		p.CarryCid = true
+	case "relay-carry":
+		p.Anthropic = url
+		p.CarryCid = true
+	}
+	if err := provider.Save(p); err != nil {
+		t.Fatal(err)
+	}
+}
+
+// A provider the user marked carry-cid=yes: a translated request of its
+// carries the caller's X-Cid header, and nothing else of the three — no
+// metadata, no query string (#4899).
+func TestTranslatedRequestCarriesOnlyTheOptedInCidHeader(t *testing.T) {
+	fresh(t)
+	up := &cidStub{}
+	hs := httptest.NewServer(up)
+	t.Cleanup(hs.Close)
+	saveCidProvider(t, hs.URL, "chat-carry")
+	head := map[string]string{"X-Cid": "abc123"}
+	code, reply := postWith(t, "/v1/messages?cid=abc123", cidBody, head)
+	if code != 200 {
+		t.Fatalf("status %d: %s", code, reply)
+	}
+	q, h, b := up.got()
+	if h.Get("X-Cid") != "abc123" {
+		t.Errorf("the opted-in provider's upstream got X-Cid %q, want the caller's", h.Get("X-Cid"))
+	}
+	if q != "" {
+		t.Errorf("the caller's query %q went upstream; the query stays dropped", q)
+	}
+	if gjson.GetBytes(b, "metadata").Exists() {
+		t.Errorf("metadata went upstream (Claude Code's user_id in it): %s", gjson.GetBytes(b, "metadata").Raw)
+	}
+}
+
+// Off, the default, nothing changes: a provider not marked carries none of
+// the three, as current main is (#4899).
+func TestTranslatedRequestCarriesNothingByDefault(t *testing.T) {
+	fresh(t)
+	up := &cidStub{}
+	hs := httptest.NewServer(up)
+	t.Cleanup(hs.Close)
+	saveCidProvider(t, hs.URL, "chat")
+	head := map[string]string{"X-Cid": "abc123"}
+	code, reply := postWith(t, "/v1/messages?cid=abc123", cidBody, head)
+	if code != 200 {
+		t.Fatalf("status %d: %s", code, reply)
+	}
+	q, h, b := up.got()
+	if h.Get("X-Cid") != "" {
+		t.Errorf("an unmarked provider's upstream got X-Cid %q", h.Get("X-Cid"))
+	}
+	if q != "" {
+		t.Errorf("the caller's query %q went upstream", q)
+	}
+	if gjson.GetBytes(b, "metadata").Exists() {
+		t.Errorf("metadata went upstream: %s", gjson.GetBytes(b, "metadata").Raw)
+	}
+}
+
+// A relayed request carries none, however marked: the opt-in is the
+// translated route's alone, and a vendor the caller reaches as itself —
+// most of all a signed-in account's — is never handed the header (#4899).
+func TestRelayedRequestCarriesNoCallerCidEvenWhenOptedIn(t *testing.T) {
+	fresh(t)
+	up := &cidStub{asAnthropic: true}
+	hs := httptest.NewServer(up)
+	t.Cleanup(hs.Close)
+	saveCidProvider(t, hs.URL, "relay-carry")
+	head := map[string]string{"X-Cid": "abc123"}
+	code, reply := postWith(t, "/v1/messages", cidBody, head)
+	if code != 200 {
+		t.Fatalf("status %d: %s", code, reply)
+	}
+	_, h, _ := up.got()
+	if h.Get("X-Cid") != "" {
+		t.Errorf("the relay's upstream got X-Cid %q; the relay stays as it is", h.Get("X-Cid"))
+	}
+}
+
+// Marked, but the caller sent no X-Cid: none is invented for it (#4899).
+func TestOptedInProviderInventsNoCidHeader(t *testing.T) {
+	fresh(t)
+	up := &cidStub{}
+	hs := httptest.NewServer(up)
+	t.Cleanup(hs.Close)
+	saveCidProvider(t, hs.URL, "chat-carry")
+	code, reply := postWith(t, "/v1/messages", cidBody, nil)
+	if code != 200 {
+		t.Fatalf("status %d: %s", code, reply)
+	}
+	_, h, _ := up.got()
+	if h.Get("X-Cid") != "" {
+		t.Errorf("the upstream got an invented X-Cid %q", h.Get("X-Cid"))
+	}
+}
diff --git a/internal/gateway/gateway.go b/internal/gateway/gateway.go
index 64a4efdbd..8e6e91b96 100644
--- a/internal/gateway/gateway.go
+++ b/internal/gateway/gateway.go
@@ -5945,6 +5945,12 @@ func (s *Server) forward(ctx context.Context, p provider.Provider, to provider.P
 	return res, err
 }
 
+// callerCidKey is the caller's X-Cid a translated ask of a provider the
+// user marked carry-cid=yes carries (#4899): put on the translated route
+// alone (forwardTranslated), read where the request to the provider is
+// built; a relayed ask and a signed-in account's never hold it.
+type callerCidKey struct{}
+
 // forwardOnce is one request to the provider, as forward makes it.
 func (s *Server) forwardOnce(ctx context.Context, p provider.Provider, to provider.Protocol, path string, body []byte, in http.Header) (*http.Response, error) {
 	reqCtx := ctx
@@ -6164,6 +6170,13 @@ func (s *Server) forwardOnce(ctx context.Context, p provider.Provider, to provid
 			}
 		}
 	}
+	if v, ok := ctx.Value(callerCidKey{}).(string); ok && v != "" {
+		// the caller's correlation header, on the translated ask of a
+		// provider the user marked as taking it (provider.CarryCid,
+		// #4899); the user's own header for the provider is put in its
+		// place by the signing, after
+		req.Header.Set("X-Cid", v)
+	}
 	if provider.OpenCodeURL(req.URL.String()) {
 		if zenFree {
 			// only what OpenCode 2.2.5 sends its gateway: an agent's own
@@ -8184,6 +8197,16 @@ func (s *Server) forwardTranslated(ctx context.Context, p provider.Provider, to
 			// thinkingConfig can, and loses minimal and xhigh
 			fctx = provider.WithEffort(ctx, req.Effort)
 		}
+		if p.CarryCid && p.Account == nil {
+			// the user marked this provider as taking the caller's X-Cid
+			// (provider.CarryCid, #4899): the header rides this translated
+			// ask (forwardOnce puts it on), and a signed-in account's
+			// vendor — the one that could fingerprint magpie by it — never
+			// does
+			if v := in.Get("X-Cid"); v != "" {
+				fctx = context.WithValue(fctx, callerCidKey{}, v)
+			}
+		}
 		res, err := s.forward(fctx, p, to, path, p.Prepare(body), in)
 		if err != nil || res.StatusCode < 400 {
 			if dropped && err == nil {
diff --git a/internal/gui/providers.go b/internal/gui/providers.go
index bd754c427..3d9ebbbe2 100644
--- a/internal/gui/providers.go
+++ b/internal/gui/providers.go
@@ -2373,6 +2373,7 @@ func providerRoutes(mux *http.ServeMux, w Windows) {
 					in.KeepLoginAs = old.KeepLoginAs
 					in.SwitchOnly, in.RestartApp = old.SwitchOnly, old.RestartApp // switchonly, restartapp
 					in.KeepSelf = old.KeepSelf                                    // keepself
+					in.CarryCid = old.CarryCid                                    // carry-cid
 					in.CapStop, in.CapCareful = old.CapStop, old.CapCareful       // capstop, capcareful
 					in.UseFirst = old.UseFirst                                    // usefirst
 					in.NoStandIn = old.NoStandIn                                  // standin
diff --git a/internal/provider/provider.go b/internal/provider/provider.go
index 412b06389..363b3c808 100644
--- a/internal/provider/provider.go
+++ b/internal/provider/provider.go
@@ -205,6 +205,17 @@ type Provider struct {
 	// sync's copy of the provider on the other computer points at a
 	// magpie that is not that one (hanslin1666 on Discord).
 	KeepSelf bool `json:"keepSelf,omitempty"`
+	// CarryCid, on a translated provider, carries the caller's X-Cid
+	// correlation header to it (#4899). Off, the default, nothing of the
+	// caller's correlations goes anywhere, as it never has: the request's
+	// metadata (Claude Code's user_id in it, the account uuid and
+	// session) and its query string stay dropped, and no header is added.
+	// On, only the header rides, and only on the translated route — a
+	// relayed request, most of all to a signed-in account's vendor, which
+	// could fingerprint magpie by it, carries none, and a caller that
+	// sent no X-Cid gets none invented. The user's word that this one
+	// provider's endpoint takes the header.
+	CarryCid bool `json:"carryCid,omitempty"`
 
 	// MaxConcurrency is how many requests may be out at the vendor at once
 	// on each of its keys or accounts (Discord, Lemon: a Codex account is
-- 
2.50.1 (Apple Git-155)
```

</details>

Branch with the commit: [hunt-20261111-r1-4899-rework](https://github.com/ggbdpq/magpie/tree/hunt-20261111-r1-4899-rework) (head `6e4e0ae428e39356d46055c662549ed6548edef6`).
