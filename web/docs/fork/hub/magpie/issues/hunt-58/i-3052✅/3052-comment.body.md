## Source & environment

From #3052 (gunduziba, 2026-10-20): a client agent routed through magpie to a provider that is really a [billion-context](https://github.com/ranxianglei/billion-context) proxy (a custom provider whose Responses URL is the `/bili/` prefix form, `http://localhost:8787/bili/<real-upstream>/v1`), with the cooperative plugin installed client-side (pi + billion-context-pi), loses the `x-bili-plugin` / `x-bili-plugin-conversation` / `x-bili-plugin-context-window` request headers on the way through magpie. The proxy then sees an anonymous session (`pfa-*`, its prefix-affinity fallback) instead of the plugin's named session, degrades to plain proxy mode and injects a duplicate set of compression tools (~18 KiB on the wire) beside the ones the plugin registered natively. Verified here on `f5b01574` (upstream/main) with `gh issue view 3052`; the header names, the `forwardOnce` path and the reporter's direct-vs-through-magpie contrast all check out against the code. This change touches only the gateway's outgoing headers.

## Minimal repro

A request carrying the three headers, sent twice — straight to the proxy and through magpie (from the issue, reproduced at the header level by the test below):

- direct: the proxy's log shows the cooperative session (`sess=test-123`), no tool injection;
- through magpie: the proxy's log shows an anonymous `pfa-*` session and the wire gains the injected tools — the headers never arrived.

## Root cause

`forwardOnce` (`internal/gateway/gateway.go`) builds the upstream request with a fresh `http.NewRequestWithContext` and copies only what its allowlist knows: `Content-Type`, `Accept`, the `User-Agent` (the agent's only where the provider passes it on, #1851), `anthropic-version`/`anthropic-beta` on Anthropic, Claude Code's own headers when the relay serves only Claude Code (#179, widened by #2817), Codex's when it serves only Codex, and the synthesized clients OpenCode's, Cline's and Kilo's gateways ask for. `x-bili-` is on no family, so the cooperative session headers are dropped by construction. Both outgoing paths go through this one function — `forward` (the relay path) calls it directly, and `passthrough` sends through `s.forward(..., r.Header)` — so the single copy loop is the whole surface. Nothing declares the stripping as a policy: no test holds "unknown headers stay off" as a guarantee, and the history (#179, then the Codex block, then #2817) reads as families admitted one by one as relays needed them. This is a gap, not an exemption.

## Fix

- `internal/gateway/gateway.go`: `forwardOnce` gains a copy loop, beside the Claude Code and Codex ones, that puts the client's `x-bili-*` headers on as it sent them; a `biliHeader` predicate beside `claudeCodeHeader` and `codexClientHeader` admits the family by its `x-bili-` prefix, in the shape of the `anthropic-`/`x-stainless-`/`x-claude-code-`/`x-openai-`/`x-codex-` families already there. None of these headers is a key: the provider's own signing (`p.Sign`) still runs after, and the test pins that a client `Authorization` never rides along.
- Scope guards in the test: a header outside every family (`X-Custom-Whatever`) still stays off, and the request goes out with the provider's key, not the client's.
- Not done here, for the maintainer to weigh: generalizing this into a per-provider "pass-through client headers" setting (a sibling of `PassUserAgent`, #1851, and the per-provider static `Headers`). This change only admits the family the issue reports, as the Claude Code and Codex families were before it.

## Verification

| Check | Command | Result |
|---|---|---|
| New test, baseline | product file back at `f5b01574`, test kept: `go test -run TestForwardOnceCarriesBiliHeaders ./internal/gateway/` | FAIL: `X-Bili-Plugin = "", want "pi"`, same for `-Conversation` and `-Context-Window` (the scope guards pass on the baseline too) |
| New test, fixed | `go test -run TestForwardOnceCarriesBiliHeaders ./internal/gateway/` | ok |
| Ablation | same removal again, restored after | FAIL again on the removal, ok after restore |
| New test, uncached | `go test -tags nogui -count=1 -run TestForwardOnceCarriesBiliHeaders ./internal/gateway/` | ok 1.113s |
| Full owning package | `go test -tags nogui -count=1 ./internal/gateway/` | ok 337.007s |
| gofmt | `gofmt -l` on the two changed files | clean |
| go vet | host `go vet ./...`; `GOOS=linux go vet -tags nogui ./...`; `GOOS=windows go vet -tags nogui ./...` | clean (a pre-existing cgo warning in `internal/gui/trayimage_darwin.go` on the host, untouched by this change) |
| Builds | `go build ./...`; `GOOS=linux go build -tags nogui ./...`; `GOOS=windows go build ./...` | ok on all three |

The test runs on httptest over loopback; no network, no real account, no bili service.

## Not verified

Not run end to end against a real billion-context proxy — the reporter's bili-side log lines (`sess=test-123` direct, `pfa-*` through magpie) are taken from the issue, and this fix is verified at the header level only. Cross-OS coverage is vet and build, not a run on those platforms.

---

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: gateway: a billion-context proxy in front of the provider gets the client's x-bili- headers (#3052) — git am applies it as is; SHA-256 first 16: 877c8ee32fc86b29</summary>

```patch
From 1fd206c7d04a41e9395e08dfaf8a5a45a79e3d86 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Thu, 22 Oct 2026 00:04:57 +0800
Subject: [PATCH] gateway: a billion-context proxy in front of the provider
 gets the client's x-bili- headers (#3052)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

What changed: forwardOnce copies the client's x-bili-* headers on to the
request it builds for the provider, by a biliHeader predicate beside
claudeCodeHeader and codexClientHeader — an x-bili- prefix, in the shape
of the anthropic-, x-stainless-, x-claude-code-, x-openai- and x-codex-
families already on the allowlist. The headers carry the cooperative
plugin's name, conversation and context window, never a key; a header no
family allowlists, and the client's own key, still stay off.

Why: forwardOnce builds the upstream request from nothing and copies only
allowlisted headers, so a client talking to a billion-context (bili)
proxy put in front of its provider lost the x-bili- ones that name its
cooperative session — bili then saw an anonymous session and injected a
duplicate set of compression tools beside the plugin's own (#3052).
Whether to generalize this into a per-provider "pass-through client
headers" setting, beside PassUserAgent (#1851) and a provider's own
Headers, is the maintainer's call; this change only admits the family
the issue reports.

Run: go test -run TestForwardOnceCarriesBiliHeaders ./internal/gateway
fails on the baseline with the three headers empty and passes with the
change (httptest, no network); ablation (product file back at baseline,
test kept) fails again. gofmt -l clean; go vet ./..., GOOS=linux and
GOOS=windows go vet -tags nogui ./... clean; native, GOOS=linux -tags
nogui and GOOS=windows builds clean; go test -tags nogui
./internal/gateway green.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/bili_headers_test.go | 63 +++++++++++++++++++++++++++
 internal/gateway/gateway.go           | 16 +++++++
 2 files changed, 79 insertions(+)
 create mode 100644 internal/gateway/bili_headers_test.go

diff --git a/internal/gateway/bili_headers_test.go b/internal/gateway/bili_headers_test.go
new file mode 100644
index 00000000..06498af3
--- /dev/null
+++ b/internal/gateway/bili_headers_test.go
@@ -0,0 +1,63 @@
+package gateway
+
+import (
+	"context"
+	"io"
+	"net/http"
+	"net/http/httptest"
+	"sync"
+	"testing"
+
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// TestForwardOnceCarriesBiliHeaders holds #3052: a billion-context proxy
+// put in front of the provider knows a cooperative plugin's session by the
+// x-bili- headers the agent sent, so forwardOnce copies them on. A header
+// no family allowlists, and the client's own key, still stay off.
+func TestForwardOnceCarriesBiliHeaders(t *testing.T) {
+	var mu sync.Mutex
+	got := http.Header{}
+	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		mu.Lock()
+		got = r.Header.Clone()
+		mu.Unlock()
+		w.Header().Set("Content-Type", "application/json")
+		io.WriteString(w, `{}`)
+	}))
+	defer up.Close()
+
+	in := http.Header{}
+	in.Set("User-Agent", "pi/0.0.56")
+	in.Set("x-bili-plugin", "pi")
+	in.Set("x-bili-plugin-conversation", "test-123")
+	in.Set("x-bili-plugin-context-window", "200000")
+	in.Set("X-Custom-Whatever", "never")
+	in.Set("Authorization", "Bearer client-key")
+
+	s := New()
+	p := provider.Provider{Responses: up.URL, Key: "provider-key"}
+	res, err := s.forwardOnce(context.Background(), p, provider.Responses, "/v1/responses", []byte(`{"model":"gpt-5.5","input":"hi"}`), in)
+	if err != nil {
+		t.Fatal(err)
+	}
+	res.Body.Close()
+
+	mu.Lock()
+	defer mu.Unlock()
+	for _, h := range []struct{ key, want string }{
+		{"X-Bili-Plugin", "pi"},
+		{"X-Bili-Plugin-Conversation", "test-123"},
+		{"X-Bili-Plugin-Context-Window", "200000"},
+	} {
+		if v := got.Get(h.key); v != h.want {
+			t.Errorf("%s = %q, want %q: the bili proxy reads it to know the cooperative session", h.key, v, h.want)
+		}
+	}
+	if v := got.Get("X-Custom-Whatever"); v != "" {
+		t.Errorf("X-Custom-Whatever = %q, want none: only allowlisted families go on", v)
+	}
+	if v := got.Get("Authorization"); v != "Bearer provider-key" {
+		t.Errorf("Authorization = %q, want the provider's key, never the client's", v)
+	}
+}
diff --git a/internal/gateway/gateway.go b/internal/gateway/gateway.go
index f315b819..637c884d 100644
--- a/internal/gateway/gateway.go
+++ b/internal/gateway/gateway.go
@@ -4029,6 +4029,15 @@ func (s *Server) forwardOnce(ctx context.Context, p provider.Provider, to provid
 		}
 		provider.SawClient(provider.ClientCodex, seen)
 	}
+	// a billion-context proxy put in front of the provider (#3052) knows a
+	// cooperative plugin's session by its x-bili- headers, which go on as
+	// the agent sent them: the plugin's name, the conversation and the
+	// context window it serves. None of them is a key.
+	for k, vs := range in {
+		if biliHeader(k) {
+			req.Header[k] = slices.Clone(vs)
+		}
+	}
 	if provider.OpenCodeURL(req.URL.String()) {
 		// as OpenCode itself sends it, which Zen's free tier asks for,
 		// with the conversation's own session, which Zen and Go route and
@@ -4171,6 +4180,13 @@ func codexClientHeader(k string) bool {
 	return codexHeader(k)
 }
 
+// biliHeader is one of the headers a billion-context (bili) proxy put in
+// front of the provider asks a cooperative plugin by: x-bili-plugin, its
+// conversation and its context window, all x-bili- prefixed and none a key.
+func biliHeader(k string) bool {
+	return strings.HasPrefix(strings.ToLower(k), "x-bili-")
+}
+
 // passthrough relays a request the provider understands as-is, with the
 // model name swapped for the provider's own. The token counts the reply
 // carries are read on the way past into u. done is false, with nothing
-- 
2.50.1 (Apple Git-155)

```

</details>

Branch with the commit: [hunt58-i-3052-bili-headers](https://github.com/ggbdpq/magpie/tree/hunt58-i-3052-bili-headers) (head `1fd206c7d04a41e9395e08dfaf8a5a45a79e3d86`).
