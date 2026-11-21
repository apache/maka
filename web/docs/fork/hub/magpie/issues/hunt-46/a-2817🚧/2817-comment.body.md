A plugin provider never got Claude Code's own request headers, so an upstream restricted to the official client rejected it while the same key through a custom provider worked. From the report (sub2api's group restricted to the official Claude Code client, one key configured two ways, Claude Code → `group/…` → `claude-opus-5-5`):

| How the key is configured | Result |
|---|---|
| custom provider | 200, every time |
| plugin provider (`api.npm: "@ai-sdk/anthropic"`, loader returns `{baseURL, apiKey}`) | 403 `This group is restricted to the official Claude Code client.`, then routing backed the subscription off to the next account and session affinity kept it there |

I verified the three gates on current `main` (`1a3b9268`): `forwardOnce` copies Claude Code's headers only `if p.Account == nil && fromClaudeCode(in)`; the `?beta=true` in `passthrough` is `p.Account == nil` too; and `provider.PassesUserAgent` passes the caller's User-Agent only when `p.Account == nil`. A plugin provider always has an account (`&Account{Agent: "plugin", …}`), so it got none of them, and its loader and `chat.headers` hooks never see the agent's original headers, so it can't add them itself.

Of the report's three directions I took **1**: treat a plugin account whose model speaks Anthropic (`@ai-sdk/anthropic`) and that authenticates with an API key like a custom provider here. The seam is clean: the model's npm package is already what decides `to` at routing time, and the loader's key is reachable at relay time (`plugin.LoaderOptions`, which the plugin's fetch asks on every request anyway). Directions 2 (an opt-in flag) and 3 (handing the agent's headers to `chat.headers`) remain open and would still work on top of this.

Branch: [`hunt46-a-plugin-claude-headers`](https://github.com/ggbdpq/magpie/tree/hunt46-a-plugin-claude-headers), one commit on top of upstream `1a3b9268...`; the patch below applies with `git am`.

## What changed

- `internal/gateway/gateway.go:3835` — the header gate becomes `claudeCodeRelay(ctx, p) && fromClaudeCode(in)`.
- `internal/gateway/gateway.go:3983` — new `claudeCodeRelay`: true for `p.Account == nil` (a custom provider, as before) or `p.LoaderKeyed(ctx)`; false for every other signed-in provider.
- `internal/gateway/gateway.go:4190` — the `?beta=true` gate becomes `claudeCodeRelay(r.Context(), p) && …`, same widening.
- `internal/provider/plugins.go:457` — new `Provider.LoaderKeyed(ctx)`: for a plugin account, the loader's `Options.APIKey` is non-empty (`plugin.LoaderOptions`, cached per sign-in and host).

So the exact condition is: **a plugin account + the request goes on Anthropic's API (both call sites already stand inside `to/proto == provider.Anthropic`, which a model's `@ai-sdk/anthropic` decides) + the loader gave a key**. The forwarded set is the same as #179's (`user-agent`, `x-app`, `anthropic-*`, `x-stainless-*`, `x-claude-code-*`, never the key Claude Code was given), and the plugin's own key still signs the request — `host.js` puts the caller's headers over the SDK's and the `chat.headers` hooks over those, so they reach the upstream through the plugin's fetch.

## Red before the fix

Base `1a3b9268860263f263a2c832b1f9b6d1b57e3fa0`, new test `TestClaudeCodeHeadersReachAnthropicPlugin` (a Claude Code request relayed to the package's fake plugin, `fakeco/fake-claude` on `@ai-sdk/anthropic`, signed in with an API key):

```
--- FAIL: TestClaudeCodeHeadersReachAnthropicPlugin (0.11s)
    claude_code_headers_test.go:176: User-Agent: got "magpie/dev", want "claude-cli/2.1.0 (external, cli)"
    claude_code_headers_test.go:176: X-App: got "", want "cli"
    claude_code_headers_test.go:176: Anthropic-Dangerous-Direct-Browser-Access: got "", want "true"
    claude_code_headers_test.go:176: X-Stainless-Lang: got "", want "js"
    claude_code_headers_test.go:176: X-Claude-Code-Session-Id: got "", want "ses-1"
    claude_code_headers_test.go:190: query "", want beta=true
FAIL
```

(`Anthropic-Beta` already passed before the fix: `anthropic-version`/`anthropic-beta` are forwarded to every Anthropic request regardless of account. The plugin's `Authorization: Bearer k1` assertion passed before and after — its own key is untouched.)

## Verification

darwin/arm64, go 1.26.8, bun 1.4.2; all tests `-tags nogui`:

| Check | Command | Result |
|---|---|---|
| New test after fix | `go test -tags nogui -count=1 -run TestClaudeCodeHeaders ./internal/gateway/` | ok (1.2s) |
| Ablation (product files restored from `upstream/main`, test kept) | same | red, the six lines above |
| Mutation (a): header gate reverted, `?beta=true` kept | same | red on the five header lines only |
| Mutation (b): `?beta=true` reverted, header gate kept | same | red on `query "", want beta=true` only |
| Targeted suite | `go test -tags nogui -count=1 -run 'TestForward\|TestPlugin\|TestPassthrough\|TestClaudeCode' ./internal/gateway/` | ok 40.4s |
| Full gateway | `go test -tags nogui -count=1 ./internal/gateway/` | ok 313.8s |
| Race | `go test -race -tags nogui -count=1 -run 'TestForward\|TestPlugin' ./internal/gateway/` | ok 60.2s |
| Format | `gofmt -l internal/gateway/ internal/provider/` | empty |
| Vet | `go vet -tags nogui` on the two touched packages, GOOS darwin/linux/windows | clean |
| Builds | `go build ./...` (darwin); `GOOS=linux go build -tags nogui ./...` and the touched packages plain; `GOOS=windows go build -o /dev/null .` | all ok |

No pre-existing failures met along the way. One note: a plain `GOOS=linux go build ./...` fails inside the Wails GUI dependency (`menu_linux.go: undefined: pointer`, module cache, needs Linux GTK); it fails the same without this patch and builds clean with `-tags nogui`.

## Siblings

- **An OpenAI-speaking plugin** (Codex's sibling, `forwardOnce`'s `p.Account == nil && (to == Responses \|\| to == Chat) && fromCodex(in)`): the same gap exists for a plugin in front of a relay that serves only Codex, and I left it exactly as it is — the report is about Claude Code, the request shape differs, and I have no such relay to test against. Widening it later would be the same two-line move.
- **`provider.PassesUserAgent`** (#1851's opt-in User-Agent pass, `internal/provider/user_agent.go:10`): unchanged. It needs no widening here — the forwarded set includes `user-agent` itself, which overwrites magpie's for the plugin exactly as for a custom provider, and widening it would hand every agent's UA to plugins on every request.
- **Signed-in subscriptions**: a Claude subscription takes `serveClaudeSubscription`, not this relay path; every other account provider keeps the old behavior (`claudeCodeRelay` is false for them).

## Not verified

- No real sub2api upstream or restricted-group key was available; the 403 wording is quoted from the report. That the upstream accepts the forwarded set as it does for custom providers is untested end to end — the claim rests on the set being byte-identical to what a custom provider sends, which the existing #179 test pins.
- The report's plugin returns `{baseURL, apiKey}` from its loader; I modeled it with the repo's fake plugin (loader with an apiKey, and its own fetch). A loader that returns neither a key nor `Fetch` (pure OAuth) is not forwarded to — intended, but untested against a real such plugin.
- `?beta=true` rides the relay path only (as for custom providers): a Claude Code request translated rather than relayed gets the headers but not the query.
- Runtime on Linux/Windows is untested (builds and vet only).

**AI**: written with an AI coding agent; I've read the whole diff and can answer questions on it myself. The model name is in the commit's trailer.

**Attribution**: If you apply the patch, please keep its author (ggbdpq) or add a `Co-authored-by: ggbdpq <ggbdpq@gmail.com>` line.

<details><summary>patch (0001-gateway-a-plugin-provider-that-speaks-Anthropic-with.patch, applies with git am)</summary>

```patch
From f599af7e475c5e9e02c6e2cfc845bcd8383b30e4 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Mon, 19 Oct 2026 07:25:14 +0800
Subject: [PATCH] gateway: a plugin provider that speaks Anthropic with a key
 gets Claude Code's headers as a custom provider does (#2817)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

What changed: the two gates #179 added for relays widen to a plugin's
account that speaks Anthropic and whose loader gave a key —
provider.LoaderKeyed asks the loader for its Options (cached, and asked
on every request through the plugin anyway): forwardOnce copies Claude
Code's headers (user-agent, x-app, anthropic-*, x-stainless-*,
x-claude-code-*, never the key it was given) and passthrough appends
?beta=true for it as for a provider of the user's own. The plugin's own
key still signs the request, and its fetch carries the headers on as
magpie put them (host.js sets the caller's headers over the SDK's, the
chat.headers hooks over those).

Why: a plugin provider always has an account (&Account{Agent: "plugin"},
internal/provider/plugins.go), so p.Account == nil never held for it and
it got none of it: an upstream serving the official Claude Code client
alone (sub2api's restricted groups) answered every request through the
plugin 403 while the same key through a custom provider went 200, and
routing backed the subscription account off to the next. Its loader and
chat.headers hooks never see the agent's original headers, so the plugin
cannot add them itself.

Scope: plugin accounts only, and on Anthropic's API alone, where the two
gates already stand — a plugin whose model speaks OpenAI (Chat,
Responses) is untouched, and so is a signed-in subscription. The User-Agent
gate of #1851 (provider.PassesUserAgent) stays as it is: the forwarded set
includes user-agent itself, which overwrites magpie's for the plugin
exactly as for a custom provider.

Run (darwin/arm64, go1.26, bun 1.4.2), all -tags nogui:
- new TestClaudeCodeHeadersReachAnthropicPlugin: red on 1a3b9268 (UA
  "magpie/dev", x-app, x-stainless-*, x-claude-code-* and ?beta=true all
  missing), green after; both sides of an ablation (product files
  restored from upstream/main) and of two single-hunk mutations rechecked
- go test -run 'TestForward|TestPlugin|TestPassthrough|TestClaudeCode'
  ./internal/gateway/: ok 40.4s
- go test ./internal/gateway/ (full): ok 313.8s
- go test -race -run 'TestForward|TestPlugin' ./internal/gateway/: ok 60.2s
- gofmt -l internal/gateway internal/provider: none
- go vet ./internal/gateway ./internal/provider on darwin, linux,
  windows: clean
- builds: darwin ./..., linux ./... (-tags nogui) and the touched
  packages plain, GOOS=windows go build -o /dev/null .: all ok

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/claude_code_headers_test.go | 103 +++++++++++++++++++
 internal/gateway/gateway.go                  |  14 ++-
 internal/provider/plugins.go                 |  16 +++
 3 files changed, 131 insertions(+), 2 deletions(-)

diff --git a/internal/gateway/claude_code_headers_test.go b/internal/gateway/claude_code_headers_test.go
index 3bbb5820..156377b6 100644
--- a/internal/gateway/claude_code_headers_test.go
+++ b/internal/gateway/claude_code_headers_test.go
@@ -2,12 +2,20 @@ package gateway
 
 import (
 	"bytes"
+	"context"
+	"fmt"
+	"io"
 	"net/http"
 	"net/http/httptest"
+	"path/filepath"
 	"strings"
+	"sync"
 	"testing"
+	"time"
 
+	"github.com/yetone/magpie/internal/plugin"
 	"github.com/yetone/magpie/internal/provider"
+	"github.com/yetone/magpie/internal/testenv"
 )
 
 // A relay that serves only Claude Code (#179: packy's "only accessible via
@@ -87,3 +95,98 @@ func TestClaudeCodeHeadersReachAnthropicRelay(t *testing.T) {
 		t.Errorf("other agent: %q %v %q", ua, f.head, query)
 	}
 }
+
+// A plugin's provider whose model speaks Anthropic and whose loader gave a
+// key is relayed a Claude Code request as a custom provider is (#2817): an
+// upstream that serves the official client alone (#179) knows it by its own
+// headers and ?beta=true, which go through the plugin's fetch as they go to
+// a relay, the plugin's own key signing the request as ever.
+func TestClaudeCodeHeadersReachAnthropicPlugin(t *testing.T) {
+	bun := testenv.Bun(t)
+	fresh(t)
+	t.Setenv("MAGPIE_BUN", bun)
+	t.Cleanup(plugin.Settle)
+
+	var mu sync.Mutex
+	var head http.Header
+	var query, got string
+	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		b, _ := io.ReadAll(r.Body)
+		mu.Lock()
+		head, query, got = r.Header, r.URL.RawQuery, string(b)
+		mu.Unlock()
+		w.Header().Set("Content-Type", "text/event-stream")
+		for _, e := range []string{
+			`{"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"fake-claude","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}`,
+			`{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
+			`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi from claude"}}`,
+			`{"type":"content_block_stop","index":0}`,
+			`{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}`,
+			`{"type":"message_stop"}`,
+		} {
+			fmt.Fprintf(w, "data: %s\n\n", e)
+		}
+	}))
+	defer up.Close()
+	t.Setenv("FAKE_BASE", up.URL+"/v1")
+
+	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
+	defer cancel()
+	abs, _ := filepath.Abs("../plugin/testdata/fake/index.js")
+	if _, err := plugin.Add(ctx, abs); err != nil {
+		t.Fatal(err)
+	}
+	if _, err := plugin.Providers(ctx); err != nil {
+		t.Fatal(err)
+	}
+	if _, err := plugin.APIKey(ctx, "fakeco", 0, nil, "k1", plugin.NewAccount); err != nil {
+		t.Fatal(err)
+	}
+	if p, err := provider.Find("fakeco"); err != nil || !p.IsPlugin() {
+		t.Fatalf("Find = %+v, %v", p, err)
+	}
+
+	claude := http.Header{
+		"User-Agent":               {"claude-cli/2.1.0 (external, cli)"},
+		"X-App":                    {"cli"},
+		"Anthropic-Beta":           {"claude-code-20250219,interleaved-thinking-2025-05-14"},
+		"X-Stainless-Lang":         {"js"},
+		"X-Claude-Code-Session-Id": {"ses-1"},
+		"Anthropic-Dangerous-Direct-Browser-Access": {"true"},
+	}
+	// streamed, as Claude Code asks: a plugin's account only streams, so the
+	// request is relayed as it was sent
+	body := `{"model":"fakeco/fake-claude","stream":true,"max_tokens":5,"system":[{"type":"text","text":"You are Claude Code, Anthropic's official CLI for Claude."}],"metadata":{"user_id":"user_abc_account__session_123"},"messages":[{"role":"user","content":"hi"}]}`
+	rec := httptest.NewRecorder()
+	req := httptest.NewRequest("POST", "/v1/messages?beta=true", strings.NewReader(body))
+	for k, v := range claude {
+		req.Header[k] = v
+	}
+	New().Handler().ServeHTTP(rec, req)
+	if rec.Code != 200 {
+		t.Fatalf("%d %s", rec.Code, rec.Body.String())
+	}
+	if !strings.Contains(rec.Body.String(), "hi from claude") {
+		t.Fatalf("the reply didn't come back: %s", rec.Body.String())
+	}
+	mu.Lock()
+	defer mu.Unlock()
+	for _, k := range []string{"User-Agent", "X-App", "Anthropic-Beta", "Anthropic-Dangerous-Direct-Browser-Access", "X-Stainless-Lang", "X-Claude-Code-Session-Id"} {
+		if h := head.Get(k); h != claude.Get(k) {
+			t.Errorf("%s: got %q, want %q", k, h, claude.Get(k))
+		}
+	}
+	if a := head.Get("Authorization"); a != "Bearer k1" {
+		t.Errorf("the plugin's own key: %q", a)
+	}
+	// the body went through as Claude Code sent it, its system line and
+	// metadata kept, as to a relay
+	for _, want := range []string{`"You are Claude Code, Anthropic's official CLI for Claude."`, `"metadata":{"user_id":"user_abc_account__session_123"}`} {
+		if !strings.Contains(got, want) {
+			t.Errorf("body lost %s: %s", want, got)
+		}
+	}
+	if query != "beta=true" {
+		t.Errorf("query %q, want beta=true", query)
+	}
+}
diff --git a/internal/gateway/gateway.go b/internal/gateway/gateway.go
index 30b87946..5ea761ed 100644
--- a/internal/gateway/gateway.go
+++ b/internal/gateway/gateway.go
@@ -3832,7 +3832,7 @@ func (s *Server) forwardOnce(ctx context.Context, p provider.Provider, to provid
 				req.Header.Set(h, v)
 			}
 		}
-		if p.Account == nil && fromClaudeCode(in) {
+		if claudeCodeRelay(ctx, p) && fromClaudeCode(in) {
 			// a relay that serves only Claude Code (#179: "only accessible
 			// via the official Claude CLI") knows it by its own headers,
 			// which go on as it sent them; its key to magpie never does
@@ -3980,6 +3980,16 @@ func claudeCodeHeader(k string) bool {
 	return false
 }
 
+// claudeCodeRelay is whether p is asked a Claude Code request as a relay
+// is (#179): a provider of the user's own, or a plugin's account whose
+// model speaks Anthropic and whose loader gave a key (#2817) — the
+// plugin's fetch carries the headers on as magpie put them, its own key
+// signing the request as ever. Asked on Anthropic's API alone, where the
+// gate's callers stand; a subscription signed in to is neither.
+func claudeCodeRelay(ctx context.Context, p provider.Provider) bool {
+	return p.Account == nil || p.LoaderKeyed(ctx)
+}
+
 // fromCodex is a request Codex sent — its CLI, exec, the IDE extension,
 // desktop app or ACP adapter — by the User-Agent (codex_cli_rs/0.159.2
 // (Mac OS 26.6.0; arm64) kitty, Codex Desktop/0.162.3 …) or the originator it gives
@@ -4177,7 +4187,7 @@ func (s *Server) passthrough(w http.ResponseWriter, r *http.Request, p provider.
 	if proto == provider.Gemini && p.IsVertex() && geminiWhole {
 		path = provider.VertexWholePath(upstream) // answered as one JSON body
 	}
-	if proto == provider.Anthropic && p.Account == nil && fromClaudeCode(r.Header) && r.URL.Query().Get("beta") == "true" {
+	if proto == provider.Anthropic && claudeCodeRelay(r.Context(), p) && fromClaudeCode(r.Header) && r.URL.Query().Get("beta") == "true" {
 		path += "?beta=true" // as Claude Code asks it
 	}
 	if proto != provider.Anthropic {
diff --git a/internal/provider/plugins.go b/internal/provider/plugins.go
index d9814e66..dcc7dd07 100644
--- a/internal/provider/plugins.go
+++ b/internal/provider/plugins.go
@@ -454,6 +454,22 @@ func (p Provider) Origin(ctx context.Context) string {
 	return scheme + "://" + HostOf(rest)
 }
 
+// LoaderKeyed is whether the account's loader gave a key (its Options'
+// apiKey, an API-key sign-in's): such a provider's requests are signed
+// with it, as a provider of the user's own are (#2817). false for any
+// other provider, and when the loader can't be asked.
+func (p Provider) LoaderKeyed(ctx context.Context) bool {
+	if !p.IsPlugin() {
+		return false
+	}
+	pp := *p.Account.plugin
+	if cur, ok := PluginOf(p.ID); ok {
+		pp = cur
+	}
+	o, err := plugin.LoaderOptions(ctx, pp.ID, p.Account.pluginKey)
+	return err == nil && o.APIKey != ""
+}
+
 // pluginFetch sends a request the gateway made for a plugin's provider
 // through the plugin: to the base URL its loader gave (else the model's,
 // the provider's, the AI SDK package's), with what the loader adds.
-- 
2.50.1 (Apple Git-155)

```

</details>
