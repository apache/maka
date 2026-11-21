Refreshed on current `main` (`e6bf4adf1`) — refreshed, not redesigned: same change as before, cherry-picked clean onto today's tip.

**Red without the fix** (bare `e6bf4adf1`, the tests from this branch):

```
--- FAIL: TestTestAsksOnTheURLsItHas/Test
    the chat endpoint is asked with the key as the gateway asks it:
    {Protocol:chat OK:false Error:no key is on for this endpoint}
--- FAIL: TestTestAsksOnTheURLsItHas/TestModels
    a model's test asks the endpoint too:
    {Error:no key that's on sees this model}
--- FAIL: TestProviderKeyProtocolPair          (internal/cli)
--- FAIL: TestProviderShowsKeyProtocol         (internal/cli)
```

With the fix: all four `ok`.

**Verification** (all on `e6bf4adf1`, darwin/arm64):
| What | Result |
| --- | --- |
| `go test ./internal/provider -run TestTestAsksOnTheURLsItHas` | ok |
| `go test ./internal/cli -run TestProviderKeyProtocolPair -run ...ShowsKeyProtocol` | ok |
| full `go test ./internal/provider` | ok 137.8s, zero failures |
| full `go test ./internal/cli` | 4 failures, all red on the bare base too (`TestHealthcheckFindsTheRunningGatewayWithoutMagpieAddr`, `TestUpdateRestarts…`, `TestEveryRouteHasACommandOrIsNamed`, `TestUpdateFindsAMagpieThatWroteNoRecord` — gateway-hunting/timing tests) |
| `go test -race ./internal/provider` | 3 failures, all previously attributed timing/baseline reds (`TestPluginCheckinAsksAgainAtUntil`, `TestSignInDoneOnceTheAccountIsBack`, `TestModelTestAsksTheAccountThatServesIt`) — nothing new |
| `gofmt` / `go vet` | clean |
| `GOOS=linux go build -tags nogui ./internal/...` | ok |
| ablation (the three ask-whole tails reverted to the baseline returns, tests kept) | the provider test red again at both subtests; restored, green. Ablating the `key.protocol` CLI pair parses reds both CLI tests; restored, green |
| `git am` on detached `e6bf4adf1` | applies as is; tree identical to the branch head |

**Siblings**: the ask-whole shape is written three times, once per test entry (`keySeeing`, `testWith`, `keyFor`) — all three changed alike, each falling back to the baseline return when any key can speak a URL the provider has. `detect.go`'s own "no key is on" line is the detection face, untouched.

**Branch with the commit**: [hunt-20261111-rf-4056](https://github.com/ggbdpq/magpie/tree/hunt-20261111-rf-4056) (head `125977b65d9d632f`).

**Not verified**: the reporter's relay with a real Anthropic-locked key on an OpenAI-only URL (the fixture serves the gateway's exact asking shape).

**Attribution**: AI-written; I've read the whole diff and can answer questions on it myself. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

**Patch**: <details><summary>patch: provider: a test asks on the URLs it has, as the gateway does, and key.protocol= is a CLI pair (#4056) — git am applies it as is; SHA-256 first 16: ae54205f78b0c944</summary>

```patch
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 4 Nov 2026 22:34:05 +0800
Subject: [PATCH] provider: a test asks on the URLs it has, as the gateway
 does, and key.protocol= is a CLI pair

A custom provider's key made for one protocol, with no URL for it on
the provider (a relay's key picked up for Anthropic alone, its address
typed in the OpenAI-compatible field only), is asked on the URLs the
provider has: requests were answered that way since #1702, while a
test of the endpoint said "no key is on for this endpoint", and the
only way to free the key was editing providers.json by hand.

keyFor now falls back the way perKeyEvery plans the provider whole,
so Test tells what the vendor answered, and provider set (and add)
takes key.protocol=chat|responses|anthropic|gemini|any, the editor's
Key protocol; the provider's page and provider key say the lock, with
the way off it, beside the key.

Fixes #4056

Generated-by: GLM-5.3-Flash (ZCode)
---
 .../cli/provider_key_protocol_cli_test.go     | 108 ++++++++++++++++++
 internal/cli/providers_cli.go                 |  32 +++++-
 internal/provider/key_protocol_nourl_test.go  |  65 +++++++++++
 internal/provider/test.go                     |  41 ++++++-
 4 files changed, 238 insertions(+), 8 deletions(-)
 create mode 100644 internal/cli/provider_key_protocol_cli_test.go
 create mode 100644 internal/provider/key_protocol_nourl_test.go

diff --git a/internal/cli/provider_key_protocol_cli_test.go b/internal/cli/provider_key_protocol_cli_test.go
new file mode 100644
index 000000000..4f1d0f380
--- /dev/null
+++ b/internal/cli/provider_key_protocol_cli_test.go
@@ -0,0 +1,108 @@
+package cli
+
+import (
+	"io"
+	"os"
+	"strings"
+	"testing"
+
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// key.protocol= on provider add and set says which one protocol the first
+// key works with, as the editor's Key protocol does; any, or empty, takes
+// the lock off (#4056: a relay's key picked up for Anthropic alone, its
+// URL typed in the OpenAI field, could only be freed by editing
+// providers.json by hand). A protocol magpie doesn't know is refused, and
+// nothing is written for it. The provider's page says the lock, and how
+// to take it off, beside the key.
+func TestProviderKeyProtocolPair(t *testing.T) {
+	home := t.TempDir()
+	t.Setenv("HOME", home)
+	t.Setenv("USERPROFILE", home)
+	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
+	t.Setenv("XDG_CACHE_HOME", t.TempDir())
+	if err := provider.Save(provider.Provider{ID: "relay", Name: "Relay", Key: "k1", KeyProtocol: provider.Anthropic, Chat: "http://127.0.0.1:1/v1"}); err != nil {
+		t.Fatal(err)
+	}
+	if err := providerCmd([]string{"provider", "set", "relay", "key.protocol=any"}); err != nil {
+		t.Fatal(err)
+	}
+	if p, err := provider.Find("relay"); err != nil || p.KeyProtocol != "" {
+		t.Fatalf("any: %q %v", p.KeyProtocol, err)
+	}
+	for _, c := range []struct {
+		v    string
+		want provider.Protocol
+	}{
+		{"anthropic", provider.Anthropic},
+		{"chat", provider.Chat},
+		{"responses", provider.Responses},
+		{"gemini", provider.Gemini},
+	} {
+		if err := providerCmd([]string{"provider", "set", "relay", "key.protocol=" + c.v}); err != nil {
+			t.Fatalf("%q: %v", c.v, err)
+		}
+		if p, err := provider.Find("relay"); err != nil || p.KeyProtocol != c.want {
+			t.Fatalf("key.protocol=%q: %q %v", c.v, p.KeyProtocol, err)
+		}
+	}
+	if err := providerCmd([]string{"provider", "set", "relay", "key.protocol="}); err != nil {
+		t.Fatal(err)
+	}
+	if p, _ := provider.Find("relay"); p.KeyProtocol != "" {
+		t.Fatalf("empty left the protocol: %q", p.KeyProtocol)
+	}
+	if err := providerCmd([]string{"provider", "set", "relay", "key.protocol=openai"}); err == nil || !strings.Contains(err.Error(), "chat|responses|anthropic|gemini|any") {
+		t.Fatalf("a made-up protocol: %v", err)
+	}
+	if p, _ := provider.Find("relay"); p.KeyProtocol != "" {
+		t.Fatalf("a refused value changed the protocol: %q", p.KeyProtocol)
+	}
+}
+
+func showProviderOutput(t *testing.T, args ...string) string {
+	t.Helper()
+	r, w, err := os.Pipe()
+	if err != nil {
+		t.Fatal(err)
+	}
+	old := os.Stdout
+	os.Stdout = w
+	var out strings.Builder
+	done := make(chan struct{})
+	go func() {
+		b, _ := io.ReadAll(r)
+		out.Write(b)
+		close(done)
+	}()
+	err = providerCmd(args)
+	w.Close()
+	os.Stdout = old
+	<-done
+	r.Close()
+	if err != nil {
+		t.Fatal(err)
+	}
+	return out.String()
+}
+
+func TestProviderShowsKeyProtocol(t *testing.T) {
+	home := t.TempDir()
+	t.Setenv("HOME", home)
+	t.Setenv("USERPROFILE", home)
+	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
+	t.Setenv("XDG_CACHE_HOME", t.TempDir())
+	if err := provider.Save(provider.Provider{ID: "relay", Name: "Relay", Key: "k1", KeyProtocol: provider.Anthropic, Chat: "http://127.0.0.1:1/v1"}); err != nil {
+		t.Fatal(err)
+	}
+	if out := showProviderOutput(t, "provider", "relay"); !strings.Contains(out, "anthropic only") || !strings.Contains(out, "key.protocol=any") {
+		t.Fatalf("the key's protocol is said with the way off it: %s", out)
+	}
+	if err := providerCmd([]string{"provider", "set", "relay", "key.protocol=any"}); err != nil {
+		t.Fatal(err)
+	}
+	if out := showProviderOutput(t, "provider", "relay"); strings.Contains(out, "anthropic only") {
+		t.Fatalf("a key for any protocol says no lock: %s", out)
+	}
+}
diff --git a/internal/cli/providers_cli.go b/internal/cli/providers_cli.go
index 0148279d7..86c13eb39 100644
--- a/internal/cli/providers_cli.go
+++ b/internal/cli/providers_cli.go
@@ -34,7 +34,7 @@ const providerUsage = `usage:
   magpie provider <id>                    show one provider and its models
   magpie provider add <preset> <key>      add a preset vendor   e.g. magpie provider add deepseek sk-…
                                           again, it adds another (deepseek-2); k=v pairs too: id, name, header.X-Foo
-  magpie provider add <name> k=v…         add a custom vendor   k: url, anthropic, responses, gemini, decide, key, models, catalog, icon, header.X-Foo, balance, balance.path, balance.method, balance.token, models.url, list, search, user-agent,
+  magpie provider add <name> k=v…         add a custom vendor   k: url, anthropic, responses, gemini, decide, key, key.protocol, models, catalog, icon, header.X-Foo, balance, balance.path, balance.method, balance.token, models.url, list, search, user-agent,
                                           access.key, access.secret (a Volcengine access key, or a Tencent Cloud SecretId and SecretKey, for its plan's windows)
   magpie provider set <id> k=v…           change a provider's settings, with the same k=v pairs as add;
                                           codex=as-sent sends Codex's Responses requests as Codex sent them
@@ -538,7 +538,13 @@ func providerCmd(args []string) error {
 		if err := provider.Save(*p); err != nil {
 			return err
 		}
-		fmt.Println(green.Render("✓"), p.Name, "key", muted.Render(provider.Mask(p.Key)))
+		said := muted.Render(provider.Mask(p.Key))
+		if p.KeyProtocol != "" {
+			// the key keeps the protocol picked for the one before it:
+			// said, with the way off it (#4056)
+			said += muted.Render("  " + string(p.KeyProtocol) + " only · magpie provider set " + p.ID + " key.protocol=any takes it off")
+		}
+		fmt.Println(green.Render("✓"), p.Name, "key", said)
 		return nil
 	case "icon":
 		if len(rest) != 2 {
@@ -974,7 +980,13 @@ func showProviderAsking(p provider.Provider, ask bool) error {
 		kv("signs with", creds)
 		kv("as", v.Impersonate)
 	case p.Key != "":
-		kv("key", muted.Render(provider.Mask(p.Key)))
+		key := muted.Render(provider.Mask(p.Key))
+		if p.KeyProtocol != "" {
+			// the one protocol the key works with (#4056), with the way
+			// off it
+			key += muted.Render("  " + string(p.KeyProtocol) + " only · magpie provider set " + p.ID + " key.protocol=any takes it off")
+		}
+		kv("key", key)
 	case p.Ready():
 		kv("key", muted.Render("none needed"))
 	default:
@@ -1179,6 +1191,20 @@ func applyPairs(p *provider.Provider, pairs []string) error {
 			}
 		case "key":
 			p.Key = v
+		case "key.protocol":
+			// the one protocol the key works with, as the editor's Key
+			// protocol does; any, or empty, is all of them (#4056: a
+			// relay's key picked up for Anthropic alone, with its URL
+			// typed in the OpenAI field, could only be freed by editing
+			// providers.json by hand)
+			switch proto := provider.Protocol(strings.ToLower(strings.TrimSpace(v))); proto {
+			case "", "any":
+				p.KeyProtocol = ""
+			case provider.Chat, provider.Responses, provider.Anthropic, provider.Gemini:
+				p.KeyProtocol = proto
+			default:
+				return fmt.Errorf("key.protocol=chat|responses|anthropic|gemini|any, not %q", v)
+			}
 		case "catalog":
 			p.Catalog = v
 		case "models":
diff --git a/internal/provider/key_protocol_nourl_test.go b/internal/provider/key_protocol_nourl_test.go
new file mode 100644
index 000000000..9e2fec8ee
--- /dev/null
+++ b/internal/provider/key_protocol_nourl_test.go
@@ -0,0 +1,65 @@
+package provider
+
+import (
+	"context"
+	"io"
+	"net/http"
+	"net/http/httptest"
+	"strings"
+	"sync"
+	"testing"
+)
+
+// A key made for one protocol, on a provider with no URL for it, is asked
+// on the URLs the provider has (#1702): the gateway sends requests there,
+// so a test of an endpoint asks there too — not "no key is on for this
+// endpoint", which sent xtnntn (#4056) editing providers.json by hand for
+// a key the gateway was answering with all along.
+func TestTestAsksOnTheURLsItHas(t *testing.T) {
+	detectHome(t)
+	var mu sync.Mutex
+	var seen []string
+	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		mu.Lock()
+		seen = append(seen, r.Method+" "+r.URL.Path)
+		mu.Unlock()
+		switch r.Method + " " + r.URL.Path {
+		case "POST /v1/chat/completions":
+			io.WriteString(w, `{"id":"c","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"hi"},"finish_reason":"length"}]}`)
+		default:
+			http.Error(w, `{"error":{"message":"Invalid URL (`+r.Method+" "+r.URL.Path+`)"}}`, http.StatusNotFound)
+		}
+	}))
+	defer srv.Close()
+	p := Provider{ID: "relay", Name: "Relay", Key: "sk-relay", KeyProtocol: Anthropic, Chat: srv.URL + "/v1", Models: []string{"gpt-5.5"}}
+	ctx := context.Background()
+	t.Run("Test", func(t *testing.T) {
+		rs := p.Test(ctx)
+		if len(rs) != 1 {
+			t.Fatalf("Test: %+v", rs)
+		}
+		if r := rs[0]; !r.OK || r.Protocol != Chat || !strings.Contains(r.Model, "gpt-5.5") {
+			t.Fatalf("the chat endpoint is asked with the key as the gateway asks it: %+v", r)
+		}
+		mu.Lock()
+		defer mu.Unlock()
+		var posts []string
+		for _, a := range seen {
+			if strings.HasPrefix(a, "POST ") {
+				posts = append(posts, a)
+			}
+		}
+		if len(posts) != 1 || posts[0] != "POST /v1/chat/completions" {
+			t.Fatalf("the upstream saw %v", posts)
+		}
+	})
+	t.Run("TestModels", func(t *testing.T) {
+		rs := p.TestModels(ctx, []string{"gpt-5.5"})
+		if len(rs) != 1 {
+			t.Fatalf("TestModels: %+v", rs)
+		}
+		if r := rs[0]; !r.OK || r.Protocol != Chat {
+			t.Fatalf("a model's test asks the endpoint too: %+v", r)
+		}
+	})
+}
diff --git a/internal/provider/test.go b/internal/provider/test.go
index 403d90263..66e7bc05f 100644
--- a/internal/provider/test.go
+++ b/internal/provider/test.go
@@ -539,7 +539,10 @@ func (p Provider) testOne(ctx context.Context, model string) Result {
 // keySeeing is p with the key a test of model on proto goes with: of
 // the keys routing takes the model to (KeysFor: one the user lets serve
 // it, whose plan and list have it), one made for that API, else one made
-// for any. A provider without keys is left as it is.
+// for any. A provider without keys is left as it is. One whose keys are
+// all made for a protocol it has no URL for is asked whole, on the URLs
+// it has, as the gateway asks it (#1702, #4056), whatever its keys'
+// lists say of the model.
 func (p Provider) keySeeing(proto Protocol, model string) (Provider, bool) {
 	if len(p.KeysOn()) == 0 {
 		return p, true
@@ -552,7 +555,12 @@ func (p Provider) keySeeing(proto Protocol, model string) (Provider, bool) {
 			}
 		}
 	}
-	return p, false
+	for _, k := range p.KeysOn() {
+		if q := p.WithKey(k); len(q.Speaks()) > 0 {
+			return p, false
+		}
+	}
+	return p, true
 }
 
 // testWith is the key or account an endpoint's test goes with, and the
@@ -560,7 +568,9 @@ func (p Provider) keySeeing(proto Protocol, model string) (Provider, bool) {
 // model of its to test there (one the user lets it serve, AccountModels),
 // else the first such key with none; a provider without keys, with the
 // model picked from every account's, as the account that serves it
-// (routedTo). ok is false when no key is on for proto.
+// (routedTo). One whose keys are all made for a protocol the provider
+// has no URL for is asked whole, as the gateway asks it (#4056). ok is
+// false when no key is on for proto.
 func (p Provider) testWith(proto Protocol) (Provider, string, bool) {
 	keys := p.KeysOn()
 	if len(keys) == 0 {
@@ -586,7 +596,17 @@ func (p Provider) testWith(proto Protocol) (Provider, string, bool) {
 	if found {
 		return first, "", true
 	}
-	return p, "", false
+	// every key on is made for a protocol the provider has no URL for:
+	// the gateway asks the provider whole, on the URLs it has (#1702),
+	// so the endpoint is asked with the key as it is, and what the
+	// vendor answered is said, not "no key is on" (#4056)
+	for _, k := range keys {
+		if q := p.WithKey(k); len(q.Speaks()) > 0 {
+			return p, "", false
+		}
+	}
+	model := p.testModel(p, proto)
+	return p.routedTo(model), model, true
 }
 
 // accountFor is p as the account of its accounts on a request for model
@@ -640,6 +660,12 @@ func (p Provider) testOn(ctx context.Context, client string, proto Protocol, mod
 
 // keyFor is p using the first key on that works with proto: one made for
 // it, else one made for any. A provider without keys is left as it is.
+// One whose keys are all made for a protocol it has no URL for is left as
+// it is too: the gateway asks it whole, on the URLs it has (#1702), so
+// the endpoint is asked with the key as it is, and what the vendor
+// answered is said, not "no key is on" (#4056: a relay's key picked up
+// for Anthropic alone, its URL typed in the OpenAI field only, was said
+// to be missing while requests were answered with it).
 func (p Provider) keyFor(proto Protocol) (Provider, bool) {
 	keys := p.KeysOn()
 	if len(keys) == 0 {
@@ -652,7 +678,12 @@ func (p Provider) keyFor(proto Protocol) (Provider, bool) {
 			}
 		}
 	}
-	return p, false
+	for _, k := range keys {
+		if q := p.WithKey(k); len(q.Speaks()) > 0 {
+			return p, false
+		}
+	}
+	return p, true
 }
 
 // zenPublic is whether p is OpenCode Zen asked with the key OpenCode
-- 
2.50.1 (Apple Git-155)

```
</details>

