Fixed on my fork: a plugin provider that says its upstream only admits the official Codex client now gets Codex's own request headers on, as a provider without an account always has.

Thanks @BB-fat for the report — the config-hook opt-in and the reasoning against forwarding to every plugin (vendors behind Cursor, Grok and the rest have their requests pinned) follow your suggested direction, and #2817's split of identity headers from addressing ones is kept: the allowlist is `codexClientHeader`'s, unchanged.

**What changed**

`forwardOnce` copies Codex's identity headers (`codexClientHeader`: the `User-Agent`, `originator`, `session-id`, `thread-id`, and the `x-codex-*`/`x-openai-*` ones `codexHeader` lets through) only when `p.Account == nil` — and a plugin provider always has an account (`Agent: "plugin"`), so it got none and the request went as magpie's own `User-Agent`. The condition now also takes a plugin provider carrying the new `codexClient` flag:

- the plugin's `config` hook sets `codexClient: true` on the provider, exactly as `searches: true` does (#2027);
- the host reads it, carries it on `plugin.Provider`, and `pluginProvider` sets it on the provider it builds;
- the forwarded headers stay the allowlist: the plugin's own key still signs the request, and Codex's ChatGPT sign-in and attestation never go on (`codexHeader` keeps them off, as before).

Off — the default — a plugin's requests keep the shape its pinning tests say (Cursor's, Grok's), so only a plugin whose upstream wants Codex's client turns it on.

**Verification** (darwin/arm64, ablation against `df7c94bdf`)

| Check | Result |
|---|---|
| `TestPluginCodexClientHeaders` (Codex request → plugin with the flag → its `fetch` sees the `User-Agent`, `originator`, `session-id`, `thread-id`, `x-codex-window-id`, the plugin's key still on) | red at `df7c94bdf`, green with the change |
| `TestPluginWithoutCodexClientFlagSendsNoCodexHeaders` (no flag → nothing forwarded, magpie's own `User-Agent`) | green both |
| `go test -tags nogui ./internal/gateway/...` | ok (640s) |
| `go test -tags nogui ./internal/plugin/ ./internal/provider/` | ok, but `TestHostToldTheGatewayAddress` — red at `df7c94bdf` too (pre-existing) |
| targeted header tests under `-race` | ok |
| `gofmt -l`, `go vet`, `go build ./...` | clean (build's cgo warnings are the usual darwin ones) |

Files: `internal/gateway/gateway.go` (the condition + its comment), `internal/provider/provider.go` (the `CodexClient` field), `internal/provider/plugins.go` (the copy), `internal/plugin/providers.go` (the `plugin.Provider` field), `internal/plugin/host.js` (reads and carries it), `internal/gateway/plugin_codex_client_test.go` (the two tests), and the fake plugin's testdata gained `$FAKE_CODEX_CLIENT` beside `$FAKE_SEARCHES`.

<details>
<summary>Patch (<code>git am</code>) — 81debe82a2ea54bad97b39edff5c2b4969345dc4, SHA-256 (first 16) 361bfef147b4e0ac</summary>

```
From 81debe82a2ea54bad97b39edff5c2b4969345dc4 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 4 Nov 2026 08:39:12 +0800
Subject: [PATCH] plugins: a provider may have Codex's own headers on to its
 upstream (#4197)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

A plugin provider never got Codex's own request headers, so a Responses
relay that only admits the official Codex client rejected Codex's
requests through it with 403 "native codex clients only", while the same
key configured as a custom provider answered 200 (BB-fat; the Codex side
of #2817). The body reached the relay unchanged; only the headers were
missing, and the plugin cannot make them up — its loader and chat.headers
hooks never see the agent's original headers, and made-up ones would not
match the body's prompt_cache_key and client_metadata anyway.

forwardOnce copies Codex's identity headers (codexClientHeader: the
User-Agent, originator, session-id, thread-id, and the x-codex-/x-openai-
ones codexHeader lets through) only to a provider without an account. A
plugin provider always has one (Agent "plugin"), so it got none, and the
request went as magpie's own User-Agent. The condition now also takes a
plugin provider that says its upstream is such a relay: a new codexClient
flag, set by the plugin's config hook as searches is (#2027), read by the
host, carried on plugin.Provider, and set on the provider it builds. Off,
the default, a plugin's requests keep the shape its pinning tests say
(Cursor's, Grok's). The allowlist is unchanged: the plugin's own key
still signs the request, and Codex's ChatGPT sign-in and attestation
never go on.

Tested (darwin/arm64): TestPluginCodexClientHeaders (a Codex request to a
plugin with the flag reaches its fetch with the identity headers, its key
still on) and TestPluginWithoutCodexClientFlagSendsNoCodexHeaders (no
flag, nothing forwarded) — red at df7c94bdf, green with the change;
internal/gateway with -tags nogui ok (640s); internal/plugin ok but
TestHostToldTheGatewayAddress, red at df7c94bdf too (the port-moved
assertion, pre-existing); internal/provider ok; gofmt -l clean; go vet
clean; go build ./... ok; the targeted header tests green under -race.

Fixes #4197
Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/gateway.go                  |   7 +-
 internal/gateway/plugin_codex_client_test.go | 108 +++++++++++++++++++
 internal/plugin/host.js                      |   5 +
 internal/plugin/providers.go                 |   8 +-
 internal/plugin/testdata/fake/index.js       |   4 +
 internal/provider/plugins.go                 |   4 +
 internal/provider/provider.go                |  10 ++
 7 files changed, 143 insertions(+), 3 deletions(-)
 create mode 100644 internal/gateway/plugin_codex_client_test.go

diff --git a/internal/gateway/gateway.go b/internal/gateway/gateway.go
index 077e3f3d7..f0842e8e3 100644
--- a/internal/gateway/gateway.go
+++ b/internal/gateway/gateway.go
@@ -5352,13 +5352,16 @@ func (s *Server) forwardOnce(ctx context.Context, p provider.Provider, to provid
 			req.Header.Del("anthropic-beta")
 		}
 	}
-	if p.Account == nil && (to == provider.Responses || to == provider.Chat) && fromCodex(in) {
+	if (p.Account == nil || p.CodexClient) && (to == provider.Responses || to == provider.Chat) && fromCodex(in) {
 		// a relay that serves only Codex (Discord: "This account only
 		// allows Codex official clients") knows it by its User-Agent,
 		// originator and x-codex- headers, which go on as Codex sent them,
 		// as they do when Codex talks to the relay itself; its key to
 		// magpie never does. A test asked as Codex asks with them
-		// (provider.TestAs)
+		// (provider.TestAs). A plugin's provider says its upstream is one
+		// such relay (Provider.CodexClient, #4197): its own key still
+		// signs the request, Codex's sign-in and attestation never go on,
+		// and a plugin that says nothing keeps magpie's own shape
 		seen := http.Header{}
 		lite := liteKept(p, to, true, modelOf(body))
 		for k, vs := range in {
diff --git a/internal/gateway/plugin_codex_client_test.go b/internal/gateway/plugin_codex_client_test.go
new file mode 100644
index 000000000..5f68fd236
--- /dev/null
+++ b/internal/gateway/plugin_codex_client_test.go
@@ -0,0 +1,108 @@
+package gateway
+
+import (
+	"io"
+	"net/http"
+	"net/http/httptest"
+	"strings"
+	"sync"
+	"testing"
+)
+
+// A plugin whose upstream only admits the official Codex client can have
+// its config hook set codexClient on the provider: Codex's identity
+// headers (its User-Agent, originator, the session and thread, and the
+// x-codex- ones) then go on to it as Codex sent them, as they do to a
+// provider without an account (#4197, BB-fat — the Codex side of #2817).
+// The plugin's own key still signs the request, and Codex's ChatGPT
+// sign-in and attestation never go on (codexHeader keeps them off).
+// Without the flag nothing is forwarded, as the plugins whose requests are
+// pinned to magpie's own shape (Cursor's, Grok's) have them.
+func TestPluginCodexClientHeaders(t *testing.T) {
+	t.Setenv("FAKE_CODEX_CLIENT", "1")
+	var mu sync.Mutex
+	var got []http.Header
+	pid := besideFake(t, "fakeco", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		io.Copy(io.Discard, r.Body)
+		mu.Lock()
+		got = append(got, r.Header.Clone())
+		mu.Unlock()
+		w.Header().Set("Content-Type", "text/event-stream")
+		io.WriteString(w, sse(
+			`data: {"type":"response.created","response":{"id":"r1","model":"fake-resp"}}`,
+			`data: {"type":"response.completed","response":{"id":"r1","output":[],"usage":{"input_tokens":5,"output_tokens":2}}}`))
+	}))
+	rec := httptest.NewRecorder()
+	req := httptest.NewRequest("POST", "/v1/responses", strings.NewReader(`{"model":"`+pid+`/fake-resp","input":"hi","stream":false}`))
+	req.Header.Set("User-Agent", "codex_cli_rs/0.164.0 (Mac OS 26.6.0; arm64)")
+	req.Header.Set("originator", "codex_cli_rs")
+	req.Header.Set("session-id", "3f2a9c1e-7b64-4d0f-a111-52f0f26e6f5a")
+	req.Header.Set("thread-id", "b59e0e32-6c1a-4a2e-9f4c-6d3aa2f6b7c1")
+	req.Header.Set("x-codex-window-id", "42")
+	New().Handler().ServeHTTP(rec, req)
+	if rec.Code != 200 {
+		t.Fatalf("status %d: %s", rec.Code, rec.Body)
+	}
+	mu.Lock()
+	defer mu.Unlock()
+	if len(got) != 1 {
+		t.Fatalf("asked %d times", len(got))
+	}
+	h := got[0]
+	for k, want := range map[string]string{
+		"User-Agent":        "codex_cli_rs/0.164.0 (Mac OS 26.6.0; arm64)",
+		"Originator":        "codex_cli_rs",
+		"Session-Id":        "3f2a9c1e-7b64-4d0f-a111-52f0f26e6f5a",
+		"Thread-Id":         "b59e0e32-6c1a-4a2e-9f4c-6d3aa2f6b7c1",
+		"X-Codex-Window-Id": "42",
+	} {
+		if h.Get(k) != want {
+			t.Errorf("the vendor got %s %q; want %q", k, h.Get(k), want)
+		}
+	}
+	if h.Get("Authorization") == "" {
+		t.Error("the vendor got no Authorization: the plugin's own sign-in never went off")
+	}
+}
+
+// Without the flag a plugin's requests keep magpie's own shape: a Codex
+// caller's identity headers stay off it, as the plugins pinned to them
+// (Cursor's, Grok's) have their requests said (plugin_grok_parity_test).
+func TestPluginWithoutCodexClientFlagSendsNoCodexHeaders(t *testing.T) {
+	var mu sync.Mutex
+	var got []http.Header
+	pid := besideFake(t, "fakeco", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		io.Copy(io.Discard, r.Body)
+		mu.Lock()
+		got = append(got, r.Header.Clone())
+		mu.Unlock()
+		w.Header().Set("Content-Type", "text/event-stream")
+		io.WriteString(w, sse(
+			`data: {"type":"response.created","response":{"id":"r1","model":"fake-resp"}}`,
+			`data: {"type":"response.completed","response":{"id":"r1","output":[],"usage":{"input_tokens":5,"output_tokens":2}}}`))
+	}))
+	rec := httptest.NewRecorder()
+	req := httptest.NewRequest("POST", "/v1/responses", strings.NewReader(`{"model":"`+pid+`/fake-resp","input":"hi","stream":false}`))
+	req.Header.Set("User-Agent", "codex_cli_rs/0.164.0 (Mac OS 26.6.0; arm64)")
+	req.Header.Set("originator", "codex_cli_rs")
+	req.Header.Set("session-id", "3f2a9c1e-7b64-4d0f-a111-52f0f26e6f5a")
+	req.Header.Set("x-codex-window-id", "42")
+	New().Handler().ServeHTTP(rec, req)
+	if rec.Code != 200 {
+		t.Fatalf("status %d: %s", rec.Code, rec.Body)
+	}
+	mu.Lock()
+	defer mu.Unlock()
+	if len(got) != 1 {
+		t.Fatalf("asked %d times", len(got))
+	}
+	h := got[0]
+	for _, k := range []string{"Originator", "Session-Id", "Thread-Id", "X-Codex-Window-Id"} {
+		if v := h.Get(k); v != "" {
+			t.Errorf("the vendor got %s %q without the flag", k, v)
+		}
+	}
+	if ua := h.Get("User-Agent"); strings.HasPrefix(ua, "codex") {
+		t.Errorf("the vendor got Codex's User-Agent %q without the flag", ua)
+	}
+}
diff --git a/internal/plugin/host.js b/internal/plugin/host.js
index e45cb0b2a..e74ba1c62 100644
--- a/internal/plugin/host.js
+++ b/internal/plugin/host.js
@@ -1846,6 +1846,10 @@ async function info(id, key, strict, limit, quiet) {
     // tool offered on its Anthropic or Responses API by itself, so a
     // client's web_search goes to it as sent (#2027)
     searches: cfg?.searches === true,
+    // magpie's own field: the provider's upstream only admits the official
+    // Codex client, so Codex's identity headers go on to it as Codex sent
+    // them (#4197)
+    codexClient: cfg?.codexClient === true,
     models: {},
   }
   if (md) for (const m of Object.values(md.models ?? {})) out.models[m.id] = fromModelsDev(md, m)
@@ -2230,6 +2234,7 @@ function rowOf(id, a, keys, stored, p, own) {
     options: optionsOf(a.auth),
     decide: p.decide === true,
     searches: p.searches === true,
+    codexClient: p.codexClient === true,
     maxConcurrency: concurrencyOf(a),
     maxAccounts: atOnceOf(a),
     signedIn: keys.length > 0,
diff --git a/internal/plugin/providers.go b/internal/plugin/providers.go
index ee1a3eb62..ad0d17416 100644
--- a/internal/plugin/providers.go
+++ b/internal/plugin/providers.go
@@ -162,7 +162,13 @@ type Provider struct {
 	// offered on its Anthropic or Responses API by itself, as a custom
 	// provider's Searches does (#825): its config hook set searches on it
 	// (#2027), for a plugin in front of Claude's or Codex's API.
-	Searches  bool    `json:"searches,omitempty"`
+	Searches bool `json:"searches,omitempty"`
+	// CodexClient says the provider's upstream only admits the official
+	// Codex client (#4197): its config hook set codexClient on it, and
+	// Codex's identity headers go on to it as Codex sent them, as they do
+	// to a provider without an account.
+	CodexClient bool `json:"codexClient,omitempty"`
+
 	SignedIn  bool    `json:"signedIn"`
 	AuthType  string  `json:"authType"`
 	AccountID string  `json:"accountId"`
diff --git a/internal/plugin/testdata/fake/index.js b/internal/plugin/testdata/fake/index.js
index bf239fc81..0f9b3dc03 100644
--- a/internal/plugin/testdata/fake/index.js
+++ b/internal/plugin/testdata/fake/index.js
@@ -157,6 +157,10 @@ export const FakePlugin = async ({ client }) => ({
     // $FAKE_SEARCHES: the provider's upstream searches by itself (#2027),
     // as a plugin in front of Claude's API says
     if (process.env.FAKE_SEARCHES) cfg.provider[ID].searches = true
+    // $FAKE_CODEX_CLIENT: the provider's upstream only admits the official
+    // Codex client (#4197), as a Responses relay in front of OpenAI's API
+    // says; its codexClient flag is magpie's own field
+    if (process.env.FAKE_CODEX_CLIENT) cfg.provider[ID].codexClient = true
     // $FAKE_DECIDE: the provider serves a decision API too (#1514), asked
     // at its base /systemone through the loader's fetch: fake-clef is a
     // decision model it marks, jev-9 one magpie knows by its name.
diff --git a/internal/provider/plugins.go b/internal/provider/plugins.go
index 45511e21f..38b10d5fd 100644
--- a/internal/provider/plugins.go
+++ b/internal/provider/plugins.go
@@ -604,6 +604,10 @@ func pluginProviderServing(pp plugin.Provider, l pluginLogin, keys []string) Pro
 	// searches, as a relay is said to (#2027): its client's web_search goes
 	// to it as sent, on the APIs it has an address for (searchesItself)
 	p.Searches = pp.Searches
+	// one in front of a relay that only admits the official Codex client
+	// says so (#4197): Codex's identity headers go on to it as Codex sent
+	// them, as they do to a provider without an account
+	p.CodexClient = pp.CodexClient
 	return p
 }
 
diff --git a/internal/provider/provider.go b/internal/provider/provider.go
index 393b023e4..34274448c 100644
--- a/internal/provider/provider.go
+++ b/internal/provider/provider.go
@@ -312,6 +312,16 @@ type Provider struct {
 	// fitting, which a backend that isn't OpenAI's needs (#350).
 	CodexAsSent bool `json:"codexAsSent,omitempty"`
 
+	// CodexClient has a request Codex sends go to a plugin's provider with
+	// Codex's identity headers on, as they do to one without an account
+	// (#4197): a plugin whose upstream only admits the official Codex
+	// client says so (its config hook set codexClient on it, as searches
+	// is). The headers stay codexClientHeader's allowlist; the plugin's
+	// own key still signs the request, and Codex's ChatGPT sign-in and
+	// attestation never go on. Off, the default, a plugin's request keeps
+	// the shape its pinning tests say (Cursor's, Grok's).
+	CodexClient bool `json:"codexClient,omitempty"`
+
 	// PromptAsWritten, on Antigravity's subscription, has the system prompt
 	// go to Google exactly as the agent wrote it. By default the few lines
 	// Google answers with a 429 "Resource has been exhausted" whatever
-- 
2.50.1 (Apple Git-155)


```
</details>

- Branch: https://github.com/ggbdpq/magpie/tree/fix/4197-codex-headers (head 81debe82a2ea54bad97b39edff5c2b4969345dc4)

AI use: written with GLM-5.3-Flash (ZCode) — analysis, patch and tests are AI-written; author ggbdpq.
