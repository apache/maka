@yetone Carrying @baileyh8's tested fix for #7413. A Responses history can carry a provider-specific `extra_content.google.thought_signature` on a tool call — the vendor field magpie keeps in retained histories for Gemini thinking. When magpie summarizes that history through its built-in Codex subscription, neither the internal summary ask nor a native `/responses/compact` relay ever runs the provider middleware chain: `codexCompact`'s `ask` calls `serve` directly, and the native compact arrives at `codexUpstreamOn` from the mux, both without the `mwRuns` request context that `triedOn` reads. No destination-scoped middleware can therefore strip `extra_content` from the official Codex compaction copy alone, and the Codex backend refuses the whole request with HTTP 400 `Unknown parameter: input[N].extra_content` on every attempt.

**The fix** (the reporter's own commit, carried as-is): a host-owned `Kind` on the middleware context (`gwmw.Info.Kind`, set to the same `KindCompact` constant `serve` already records compaction calls with; request JSON cannot set it), and a `compactionMiddleware` that gives each summary attempt and each subscription-native compaction a fresh **provider-only** middleware lifecycle — `Begin`/`End` own the runtimes for the attempt, only the `Tried` (onProvider) half is collected, no `Request`, `Wrap`, `Accounts`, response hooks or asynchronous context hooks run. The summary ask releases its runs when the attempt ends; the native compact route applies `triedOn` explicitly against the Codex account, except for an OpenAI API-key request, which is not the Codex subscription target of this hook. Vendor-specific field cleaning stays opt-in in an independent middleware — the checked-in `testdata` fixture is read by the tests only, nothing loads it automatically. Ordinary request lifecycles, request/account/response hooks, other internal asks and API-key native compaction are unchanged.

**Red without the fix** (carrier tree with the three production files' hunks reverted, the new tests and fixture kept — the reporter's own ablation recipe):

```
--- FAIL: TestCompactionMiddlewareOfficialSummaryCopy (0.38s)
2026/11/21 17:18:58 gateway: other's call to codex/gpt-5.5 on codex failed: 400 after 213ms: Codex: Unknown parameter: input[1].extra_content
    codex_compact_middleware_test.go:67: summary status=400 reply={"error":{"code":null,"message":"compaction: codex (codex/gpt-5.5, http://127.0.0.1:54820/backend-api/codex) answered the summary request 400 Bad Request: Codex: Unknown parameter: input[1].extra_content (HTTP 400, invalid_request_error)","param":null,"type":"invalid_request_error"}}
--- FAIL: TestCompactionMiddlewareNativeCompactCopy (0.02s)
    codex_compact_middleware_test.go:104: native status=400 reply={"error":{"message":"Unknown parameter: extra_content"}}
```

The two preservation tests (`TestCompactionMiddlewareOtherProviderUntouched`, `TestCompactionMiddlewareRetainedHistoryContinuesWithSignature`) pass on the old code too — they hold the line the fix must not break. With the fix restored: all four pass.

<details><summary>patch: gateway: expose provider middleware for Codex compaction — git am applies it as is; SHA-256 first 16: 3e75f7ce9159b23c</summary>

````pFrom 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: baileyh8 <185746299+baileyh8@users.noreply.github.com>
Date: Sat, 21 Nov 2026 15:10:57 +0800
Subject: [PATCH] gateway: expose provider middleware for Codex compaction

Give internal summary attempts and native Codex compaction a fresh provider-only middleware lifecycle with host-owned compact context. Leave vendor-specific field cleanup opt-in, preserving retained histories and other destinations.

Add synthetic HTTP 400 reproductions for unsupported extra_content and verify signed tool continuation remains intact. New regressions fail on unpatched v0.1.4634 and pass with this change; focused compaction/signature/middleware checks and targeted race checks pass. Broader validation is documented in the submission.
---
 docs/subsystems/gateway-middleware.md         |  19 +++
 internal/gateway/codex_backend.go             |  15 ++
 .../gateway/codex_compact_middleware_test.go  | 157 ++++++++++++++++++
 internal/gateway/middleware.go                |  28 ++++
 .../codex-compaction-clean.middleware.mjs     |  34 ++++
 internal/gwmw/gwmw.go                         |   2 +
 6 files changed, 255 insertions(+)
 create mode 100644 internal/gateway/codex_compact_middleware_test.go
 create mode 100644 internal/gateway/testdata/codex-compaction-clean.middleware.mjs

diff --git a/docs/subsystems/gateway-middleware.md b/docs/subsystems/gateway-middleware.md
index c4671130d..a2e8f4b5b 100644
--- a/docs/subsystems/gateway-middleware.md
+++ b/docs/subsystems/gateway-middleware.md
@@ -69,3 +69,22 @@ node --test internal/gui/tests/plugin-middleware.test.cjs
 # in magpie-community/plugins: each package runs its cases.json through the hooks
 bun test packages/think-tags packages/model-map packages/param-override packages/system-prompt packages/word-guard packages/antigravity-cloak
 ```
+
+
+## Internal Codex compaction attempts
+
+Codex summary requests and native `/responses/compact` requests initialize
+fresh provider-only middleware chains through `compactionMiddleware`.
+Their context has the host-owned `kind: "compact"`; ordinary requests omit
+it. Request metadata cannot set this field. `onRequest`, `onAccount`, response
+hooks and asynchronous context hooks do not run on these internal attempts.
+Each attempt owns and releases its runtimes; provider attempts still derive
+from unchanged source bytes. A plugin can therefore sanitize an official
+Codex compaction copy with `onProvider` and `ctx.provider.account === "codex"`
+without changing the conversation or another provider's copy. An API-key
+request on the direct native compaction route is left unchanged.
+
+Regression coverage: `TestCompactionMiddlewareOfficialSummaryCopy`,
+`TestCompactionMiddlewareNativeCompactCopy` and
+`TestCompactionMiddlewareOtherProviderUntouched` and
+`TestCompactionMiddlewareRetainedHistoryContinuesWithSignature`.
diff --git a/internal/gateway/codex_backend.go b/internal/gateway/codex_backend.go
index df1bc03ee..0f66920ce 100644
--- a/internal/gateway/codex_backend.go
+++ b/internal/gateway/codex_backend.go
@@ -1002,6 +1002,19 @@ func (s *Server) codexUpstreamOn(w http.ResponseWriter, r *http.Request, rest st
 	// row written below sums this call's tries in its own context (#4456)
 	r = r.WithContext(s.countBytes(r.Context()))
 	w0, body0 := w, body // as they came, for the fallbacks (codexFallBack)
+	if r.Method == http.MethodPost && rest == "/responses/compact" {
+		var done func()
+		r, done = compactionMiddleware(r, body)
+		defer done()
+		to := provider.Provider{ID: "codex", Name: "Codex", Account: &provider.Account{Agent: "codex"}}
+		if on != nil {
+			to = *on
+		}
+		// An OpenAI API key is not the Codex subscription target of this hook.
+		if !apiKey(r.Header) {
+			body = triedOn(r.Context(), to, modelOf(body), body)
+		}
+	}
 	// Claude's blocks magpie gave Codex (claudeseal) are Claude's alone:
 	// to OpenAI each item is its summary, as before magpie carried them
 	body = withoutClaudeSeals(body)
@@ -3883,6 +3896,8 @@ func (s *Server) codexCompact(w http.ResponseWriter, r *http.Request, body []byt
 	r = askWhole(r)
 	r = askCompaction(r)
 	ask := func(r *http.Request, b []byte) (*recorder, compactResult, error) {
+		r, done := compactionMiddleware(r, b)
+		defer done()
 		rec := &recorder{header: http.Header{}, status: 200}
 		s.serve(rec, r, provider.Responses, b)
 		if rec.status >= 400 {
diff --git a/internal/gateway/codex_compact_middleware_test.go b/internal/gateway/codex_compact_middleware_test.go
new file mode 100644
index 000000000..b38e61a35
--- /dev/null
+++ b/internal/gateway/codex_compact_middleware_test.go
@@ -0,0 +1,157 @@
+package gateway
+
+import (
+	"bytes"
+	"encoding/json"
+	"github.com/yetone/magpie/internal/gwmw"
+	"github.com/yetone/magpie/internal/middleware"
+	"github.com/yetone/magpie/internal/provider"
+	"io"
+	"net/http"
+	"net/http/httptest"
+	"os"
+	"strings"
+	"sync"
+	"testing"
+)
+
+const compactSignatureHistory = `{"model":"fake/m1","stream":true,"input":[{"type":"message","role":"user","content":"Synthetic calculator fixture."},{"type":"function_call","id":"fc_fixture","call_id":"call_fixture","name":"read_fixture","arguments":"{\"extra_content\":\"business data\"}","extra_content":{"google":{"thought_signature":"synthetic-signature"}}},{"type":"function_call_output","call_id":"call_fixture","output":"synthetic tool result"},{"type":"compaction_trigger"}]}`
+
+func compactCleaner(t *testing.T) {
+	t.Helper()
+	src, err := os.ReadFile("testdata/codex-compaction-clean.middleware.mjs")
+	if err != nil {
+		t.Fatal(err)
+	}
+	onMiddleware(t, string(src))
+	stop := gwmw.Use(middleware.Chain{})
+	t.Cleanup(stop)
+}
+
+func TestCompactionMiddlewareOfficialSummaryCopy(t *testing.T) {
+	up := setup(t, provider.Responses, &fake{t: t})
+	var mu sync.Mutex
+	var sent [][]byte
+	chatgpt(t, func(w http.ResponseWriter, r *http.Request) {
+		if r.Method != "POST" {
+			io.WriteString(w, `{"models":[]}`)
+			return
+		}
+		b, _ := io.ReadAll(r.Body)
+		mu.Lock()
+		sent = append(sent, append([]byte(nil), b...))
+		mu.Unlock()
+		if bytes.Contains(b, []byte(`"extra_content":{"google"`)) {
+			w.WriteHeader(400)
+			io.WriteString(w, `{"error":{"message":"Unknown parameter: input[1].extra_content","type":"invalid_request_error"}}`)
+			return
+		}
+		w.Header().Set("Content-Type", "text/event-stream")
+		io.WriteString(w, summaryReply)
+	})
+	codexSignedIn(t)
+	if err := provider.Save(provider.Provider{ID: "codex", Models: []string{"gpt-5.5"}}); err != nil {
+		t.Fatal(err)
+	}
+	if err := provider.Save(provider.Provider{ID: "fake", Name: "Fake", Key: "fixture-key", Models: []string{"m1"}, Responses: up.URL + "/v1"}); err != nil {
+		t.Fatal(err)
+	}
+	compactCleaner(t)
+	if err := provider.SetCodexCompactModel("codex/gpt-5.5"); err != nil {
+		t.Fatal(err)
+	}
+	original := []byte(compactSignatureHistory)
+	before := append([]byte(nil), original...)
+	code, reply := codexPost(t, string(original))
+	if code != 200 || !strings.Contains(compactedText(t, reply), "SUMMARY") {
+		t.Fatalf("summary status=%d reply=%s", code, reply)
+	}
+	if !bytes.Equal(original, before) {
+		t.Fatal("source history changed")
+	}
+	mu.Lock()
+	defer mu.Unlock()
+	if len(sent) != 1 || bytes.Contains(sent[0], []byte(`"extra_content":{"google"`)) {
+		t.Fatalf("official copy was not cleaned; calls=%d", len(sent))
+	}
+	if !bytes.Contains(sent[0], []byte(`business data`)) || !bytes.Contains(original, []byte(`synthetic-signature`)) {
+		t.Fatal("business argument or original signature lost")
+	}
+}
+
+func TestCompactionMiddlewareNativeCompactCopy(t *testing.T) {
+	setup(t, provider.Responses, &fake{t: t})
+	var sent []byte
+	chatgpt(t, func(w http.ResponseWriter, r *http.Request) {
+		sent, _ = io.ReadAll(r.Body)
+		if bytes.Contains(sent, []byte(`"extra_content":{"google"`)) {
+			w.WriteHeader(400)
+			io.WriteString(w, `{"error":{"message":"Unknown parameter: extra_content"}}`)
+			return
+		}
+		w.Header().Set("Content-Type", "application/json")
+		io.WriteString(w, `{"id":"resp_compact","object":"response.compaction","output":[{"type":"compaction","encrypted_content":"synthetic-seal"}],"usage":{"input_tokens":3,"output_tokens":1,"total_tokens":4}}`)
+	})
+	compactCleaner(t)
+	body := strings.Replace(compactSignatureHistory, `"fake/m1"`, `"gpt-5.5"`, 1)
+	body = strings.Replace(body, `,{"type":"compaction_trigger"}`, "", 1)
+	req := httptest.NewRequest("POST", CodexPath+"/responses/compact", strings.NewReader(body))
+	req.Header.Set("Authorization", "Bearer chatgpt-token")
+	req.Header.Set("chatgpt-account-id", "acct-1")
+	rec := httptest.NewRecorder()
+	New().Handler().ServeHTTP(rec, req)
+	if rec.Code != 200 || bytes.Contains(sent, []byte(`"extra_content":{"google"`)) {
+		t.Fatalf("native status=%d reply=%s", rec.Code, rec.Body.String())
+	}
+	if !strings.Contains(body, "synthetic-signature") {
+		t.Fatal("original signature lost")
+	}
+}
+
+func TestCompactionMiddlewareOtherProviderUntouched(t *testing.T) {
+	f := &fake{t: t, reply: summaryReply}
+	setup(t, provider.Responses, f)
+	compactCleaner(t)
+	code, reply := codexPost(t, compactSignatureHistory)
+	if code != 200 {
+		t.Fatalf("status=%d reply=%s", code, reply)
+	}
+	if !strings.Contains(string(f.got), "synthetic-signature") {
+		t.Fatal("another provider lost its signature")
+	}
+}
+
+// A successful summary is not enough: the same retained history must still
+// carry its vendor signature on a later ordinary tool continuation.
+func TestCompactionMiddlewareRetainedHistoryContinuesWithSignature(t *testing.T) {
+	f := &fake{t: t, reply: summaryReply}
+	setup(t, provider.Responses, f)
+	compactCleaner(t)
+	code, reply := codexPost(t, compactSignatureHistory)
+	if code != 200 || !strings.Contains(compactedText(t, reply), "SUMMARY") {
+		t.Fatalf("compaction status=%d reply=%s", code, reply)
+	}
+	var request map[string]json.RawMessage
+	if err := json.Unmarshal([]byte(compactSignatureHistory), &request); err != nil {
+		t.Fatal(err)
+	}
+	var input []json.RawMessage
+	if err := json.Unmarshal(request["input"], &input); err != nil {
+		t.Fatal(err)
+	}
+	// Remove only the trigger, retaining the signed tool exchange verbatim.
+	input = input[:len(input)-1]
+	request["input"], _ = json.Marshal(input)
+	// Caller metadata must not grant an ordinary request compact privileges.
+	request["kind"] = json.RawMessage(`"compact"`)
+	body, _ := json.Marshal(request)
+	code, reply = codexPost(t, string(body))
+	if code != 200 {
+		t.Fatalf("continuation status=%d reply=%s", code, reply)
+	}
+	if !strings.Contains(string(f.got), `"thought_signature":"synthetic-signature"`) ||
+		!strings.Contains(string(f.got), `"call_id":"call_fixture"`) ||
+		!strings.Contains(string(f.got), `synthetic tool result`) {
+		t.Fatal("ordinary continuation lost its original signature, call ID or tool result")
+	}
+}
diff --git a/internal/gateway/middleware.go b/internal/gateway/middleware.go
index 1f6904a9a..61f048537 100644
--- a/internal/gateway/middleware.go
+++ b/internal/gateway/middleware.go
@@ -261,3 +261,31 @@ func hookKind(r *http.Request, agent string) string {
 	}
 	return ""
 }
+
+// compactionMiddleware gives each summary attempt a fresh provider-only chain.
+// Agent hooks and response hooks are not run on the host's internal request.
+// Every provider starts from that attempt's original bytes through triedOn.
+func compactionMiddleware(r *http.Request, body []byte) (*http.Request, func()) {
+	info := gwmw.Info{Protocol: string(provider.Responses), Model: modelOf(body), Stream: streamOf(body), Path: r.URL.Path, Agent: agentOf(r), Kind: KindCompact}
+	var runs mwRuns
+	var active []gwmw.Run
+	for _, a := range gwmw.AgentsWanted(middlewareWanted) {
+		run := a.Begin(info)
+		if run == nil {
+			continue
+		}
+		active = append(active, run)
+		if tried, ok := run.(gwmw.Tried); ok {
+			runs.tried = append(runs.tried, tried)
+		}
+	}
+	done := func() {
+		for i := len(active) - 1; i >= 0; i-- {
+			active[i].End()
+		}
+	}
+	if len(runs.tried) == 0 {
+		return r, done
+	}
+	return r.WithContext(context.WithValue(r.Context(), triedKey{}, runs)), done
+}
diff --git a/internal/gateway/testdata/codex-compaction-clean.middleware.mjs b/internal/gateway/testdata/codex-compaction-clean.middleware.mjs
new file mode 100644
index 000000000..1ef1f93aa
--- /dev/null
+++ b/internal/gateway/testdata/codex-compaction-clean.middleware.mjs
@@ -0,0 +1,34 @@
+// Destination-scoped sanitizer. Never edits the caller's history in place.
+// Requires a trusted `kind: "compact"` supplied by the Magpie host, not the body.
+const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
+const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
+
+function stripField(value) {
+  if (!object(value) || !own(value, 'extra_content')) return value;
+  const copy = { ...value };
+  delete copy.extra_content;
+  return copy;
+}
+
+export function onProvider(body, ctx) {
+  // Missing host capabilities are a no-op. Never infer the destination from
+  // the current conversation model, a user prompt or a caller-supplied flag.
+  if (ctx?.protocol !== 'responses' || ctx?.kind !== 'compact'
+    || ctx?.provider?.account !== 'codex' || !object(body) || !Array.isArray(body.input)) return;
+  let changed = false;
+  const input = body.input.map(item => {
+    let copy = stripField(item);
+    if (object(copy) && Array.isArray(copy.content)) {
+      let contentChanged = false;
+      const content = copy.content.map(part => {
+        const clean = stripField(part);
+        contentChanged ||= clean !== part;
+        return clean;
+      });
+      if (contentChanged) copy = { ...copy, content };
+    }
+    changed ||= copy !== item;
+    return copy;
+  });
+  return changed ? { ...body, input } : undefined;
+}
diff --git a/internal/gwmw/gwmw.go b/internal/gwmw/gwmw.go
index 0951ef3fe..4a8f58bf0 100644
--- a/internal/gwmw/gwmw.go
+++ b/internal/gwmw/gwmw.go
@@ -33,6 +33,8 @@ type Info struct {
 	Stream   bool   `json:"stream"`
 	Path     string `json:"path"`
 	Agent    string `json:"agent,omitempty"`
+	// Kind is set by the host for its own compaction, never by request metadata.
+	Kind string `json:"kind,omitempty"`
 }
 
 // Reject is a request a middleware turned away: the agent gets Status with
-- 
2.50.1 (Apple Git-155)

````

</details>

**Branch with the commit**: [`fix/7413-compaction-middleware`](https://github.com/ggbdpq/magpie/tree/fix/7413-compaction-middleware) (head `db31b52b559e17ff8ac1cf5cef526da045d076b6`), cherry-picked onto current `upstream/main` (`0a735cae0`, 13 commits past the reporter's base `v0.1.4634`); applied clean with no conflicts. On a fresh checkout `git am` applies clean (verified on detached `0a735cae0`: applied, resulting tree byte-identical to the branch head's tree, author kept `baileyh8`).

| Check | Result |
| --- | --- |
| `TestCompactionMiddlewareOfficialSummaryCopy`, `…NativeCompactCopy`, `…OtherProviderUntouched`, `…RetainedHistoryContinuesWithSignature` (new) | red before the fix (the two 400s above), pass after — ok 1.383s, 4/4 |
| targeted `-race` over the same four | pass |
| `go test -tags nogui -timeout 45m -count=1 ./internal/gateway ./internal/gwmw` | FAIL on this box — 74 failures in `internal/gateway`, all environment-bound (Claude Code CLI/TUI and OpenAI-socket tests that need this machine's real tool shims); `./internal/gwmw` ok (0.289s) |
| same run on base `0a735cae0` | FAIL with the same 73 environment-bound failures plus its own two (`TestClaudeTUIConversationKeepsItsFolderWhenTheCallerMoves`, `TestClaudeTUIResumedSessionIsGivenItsInstructions`) — the only carrier-side extra, `TestSearchQueueKeepsCodexAlive`, passes 3× alone on the carrier tree — a load flake, as recorded on #7307; zero tip-only failures |
| `gofmt -l` on the changed Go files | prints nothing |
| `git diff --check` | clean |
| `go vet ./...`; `GOOS=linux go vet -tags nogui ./...`; `GOOS=windows go vet ./...` | clean |
| `go build`; `GOOS=linux go build -tags nogui`; `GOOS=windows go build` | clean (darwin linker warnings pre-existing) |
| Ablation | reverting the three production files' hunks with the tests kept turns the two symptom tests red with the exact 400s above; restored, green |
| Composition with magpie's own pending compaction fix (#7189) | the two fixes coexist: merged `fix/7413-compaction-middleware` with our `fix/7189-agy-compact-boundary` branch in one tree — all 48 compaction-family tests pass in the merged tree, the reporter's four and our `TestPluginToldTheCompaction` among them |

**Composition, since the two touch the same family**: #7413's `gwmw.Info.Kind` and #7189's `X-Magpie-Compaction` header are complementary host-owned compaction signals with the same threat model — a client must not be able to claim compaction privileges (#7413's Kind is never set from request metadata; #7189's header is set only by `serve` and a client's own is never passed on). The Go files are disjoint; the only merge touchpoint is the plugin host's `MAGPIE_ONLY` header list, where the union resolved cleanly (upstream's `caller-*` trio + #7189's `x-magpie-compaction`). So a middleware can read `ctx.kind` on compaction copies while the gateway still tells its plugin the compaction verdict by header, and neither fix weakens the other's client-forgery guard.

**Siblings** (`rg` over the compaction request constructions and the middleware chain): fixed by the carried commit — `codexCompact`'s summary ask (`codex_backend.go`) and `codexUpstreamOn`'s native `/responses/compact` for subscription requests, the only two compaction copies that bypassed the chain. Left by the author's stated scope, unchanged here: an API-key request on the direct native compaction route (`responsesCompact` relays it as it came to the provider's own API); and the title/description side-asks (`codexTitle`, `codexDescription`) — their bodies derive from the conversation through `codexInput`, which keeps a `function_call`'s `extra_content`, and they reach the Codex subscription through `serve` without middleware, so by reading they share the disease shape; not reproduced here, and worth its own follow-up rather than a silent widening of the reporter's minimal patch. Not a bypass: `codexFallBack` re-serves the agent's original request with its context intact, so the original middleware runs still apply per try in the try loop. Different by design: magpie's own asks (image description, classification, web search, advisor) run no agent middleware and their bodies are magpie-built, not retained histories.

**Not verified**: a real Codex subscription upstream (the 400 wording is the reporter's own probe text, reproduced here against loopback fake providers only); a real Gemini provider putting `extra_content` into a live history; the GUI.

**Attribution**: the fix is @baileyh8's; I carried the commit over as-is (author kept) and ran the verification above. AI-written (GLM-5.3-Flash (ZCode)) only for the carrying and the verification; I've read the whole diff. Please keep the author (`baileyh8`).
