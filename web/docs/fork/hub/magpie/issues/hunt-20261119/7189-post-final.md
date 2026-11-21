Two faces in this report, and they split by repo: what magpie can say and what the plugin does with it. This patch is the magpie half — the gateway now hands a plugin provider's fetch the compaction verdict it already maintains, as `X-Magpie-Compaction: 1`, so a bridge like `opencode-agy-cli-auth` can keep a summarization turn out of its live tool validation. The plugin half (a read-only compaction path in `packages/agy-cli/index.mjs`, and the silent 112 KiB clip) is left for the plugins repo, at the end.

**Root cause:** `compacting()` in `internal/gateway/compacting.go` classifies an agent's compaction for accounting and routing (a `compact` rule, the usage row's `Compaction` kind), but the verdict goes no further — a plugin provider receives the replayed history as a plain turn. On `agy-cli` that turn then runs normal tool validation (`validateResults()`), which rejects the re-seen historical tool results with `409 agy bridge: conflicting duplicate result` — 87 attempts across three historical tool IDs in one session, all retried by the client, none distinguishable from a real turn's failure.

**The fix:** serve carries the verdict in the request's context (`withCompactionMark`, set whenever `call.Kind` ends up `compact` — the gateway's own classification and a client's own compaction mark alike), and the try that goes to a plugin provider sets `X-Magpie-Compaction: "1"` from it, next to `FallbackHeader` and the session headers it already sets there. A client's `X-Magpie-Compaction` of its own is never the gateway's word: the header comes from the context alone, and a plain turn says nothing however it forges the header. The plugin host's `MAGPIE_ONLY` list takes the mark off whatever the plugin sends on, so a plugin that forwards the headers it was given leaks none of it to its vendor. The value is deliberately just the verdict: what a plugin does with a compaction turn is its design to make, and the same mark serves any bridge plugin, not only agy-cli's.

**Source:** reported in #7189 with the code-level chain (`compacting.go`'s classification ending at the usage row, `validateResults()`'s rejection, and the `renderInitialPromptParts` clip), reproduced on agy-cli 0.1.95/0.1.96.

**Red without the fix:** `TestPluginToldTheCompaction` (new) — on a Claude Code auto-compaction request to a fake plugin provider, `the plugin was told compaction "", want "1"`. Reverting the host's `MAGPIE_ONLY` entry alone fails at the other end: `the vendor got X-Magpie-Compaction: ["1"]` (the plugin forwards the headers it was given). Restoring each passes; the forged-header and plain-turn cases pass throughout.

**Siblings:**
- The to-plugin header family (`X-Magpie-Session`, `X-Magpie-Subagent`, `X-Magpie-Fallback`, `X-Magpie-Effort`, `X-Magpie-Work-Dir`/`-Work-Git`) is set at the same try and stripped by the same `MAGPIE_ONLY` list; the mark follows both halves.
- The plugin host's check-in fetches (`minimax`/`workbuddy`/`qoder`/`trae_checkin`, `zen_bun`) build their `FetchRequest` directly with no conversation to compact — deliberately not marked.
- Codex's compaction rides its own `x-openai-subagent` mark into `codex_backend.go` and never goes through the plugin fetch path — out of scope here.
- The reporter's two plugin-side asks, left for the plugins repo: (1) on `X-Magpie-Compaction: 1`, run the summarization turn on an isolated read-only path — no client tools, no `validateResults()` against history; (2) `renderInitialPromptParts`'s 112 KiB cap must not return a summary as if complete — fail explicitly (or read the omitted middle back) instead of silently clipping. Both are `packages/agy-cli/index.mjs` (`AGY_BRIDGE_MAX_PROMPT_BYTES`); a plugin-side patch belongs in magpie-community/plugins.

| Check | Result |
| --- | --- |
| `TestPluginToldTheCompaction` | Green at final head; without the gateway fix: `the plugin was told compaction "", want "1"`; without the host strip: `the vendor got X-Magpie-Compaction: ["1"]` |
| Ablation (both halves reverted separately, tests kept) | Assertion-level red at each; restored, green |
| `TestPluginToldTheEffort` (existing header-family test) | Pass unchanged |
| Targeted `-race` (`TestPluginTold*`) | Pass |
| `go test -tags nogui -timeout=45m -count=1 ./internal/gateway/` | Exit 1 with 3 failures, all pre-existing — bare base `0a37c9368` fails the same three: `TestOpenCodeGoOwnFreeModelGetsNothingOfOpenCodes` (upstream 35e5989f1's darwin assertion, the documented local red) and `TestOpenAIProviderTurnsGoOverWebSocketByDefault`/`TestOpenAIProviderSocketOffNeverDials` (both 401 from the socket fixture's key check); nothing else, 930.8s |
| `gofmt -l` changed files, `git diff --check` | No output / clean |
| `go vet` darwin; `GOOS=linux go vet -tags nogui`; `GOOS=windows go vet` (gateway, provider, plugin) | All exit 0 |
| darwin/windows `go build ./…`; linux `go build -tags nogui ./…` | All exit 0 |
| Actual rebase onto `0a37c9368` | Clean; `git range-diff` `=` (no drift) |
| Strict `git am` on `0a37c9368` | Applies cleanly; resulting tree equals final head (`f7d91b0b0`); author remains `ggbdpq <ggbdpq@gmail.com>` |

**Not verified:** against a live `agy-cli` plugin — the 409 stop and the summary's completeness are the plugin's behavior, and this patch only gives it the signal (the issue's reproduction used agy-cli 0.1.95/0.1.96 with Claude Code 2.1.318). Whether a Claude Code compaction request's replayed `tool_result` blocks survive translation to the plugin's Anthropic shape unchanged is asserted only at the header level here.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

**Branch with the commit**: [fix/7189-agy-compact-boundary](https://github.com/ggbdpq/magpie/tree/fix/7189-agy-compact-boundary), head `ff9a41860e4324b23af86625d5e8c3f17451e8f1`.

<details><summary>patch: gateway: a plugin's fetch is told the gateway's own compaction verdict (#7189) — git am applies it as is; SHA-256 first 16: 284e39a41e26d421</summary>

```patch
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Thu, 19 Nov 2026 23:41:30 +0800
Subject: [PATCH] gateway: a plugin's fetch is told the gateway's own
 compaction verdict (#7189)

What changed: a request the gateway classified as an agent's compaction
(compactSystems/compactAsks, or a kind the client's own mark named) now
carries the verdict to a plugin provider's fetch in X-Magpie-Compaction:
"1", set on the try that goes to the plugin. The verdict rides the
request's context from serve, and the try sets the header from it alone,
so a client's X-Magpie-Compaction of its own is never the gateway's word
and a plain turn says nothing. The plugin host's magpie-only list takes
the mark off whatever the plugin sends on (host.js), so a plugin that
forwards the headers it was given leaks none of it to its vendor.

Run: TestPluginToldTheCompaction (new) fails without the fix (the plugin
was told compaction "", want "1" on a Claude Code auto-compaction
request) and fails again with the host's magpie-only list reverted (the
vendor got X-Magpie-Compaction); it passes with both, the forged and
plain cases included. TestPluginToldTheEffort passes unchanged. See the
issue post for the matrix.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/compacting.go             | 21 ++++-
 internal/gateway/gateway.go                | 14 ++++
 internal/gateway/plugin_compaction_test.go | 95 ++++++++++++++++++++++
 internal/plugin/host.js                    | 10 ++-
 internal/plugin/testdata/fake/index.js     |  2 +-
 internal/provider/plugins.go               |  9 ++
 6 files changed, 145 insertions(+), 6 deletions(-)
 create mode 100644 internal/gateway/plugin_compaction_test.go

diff --git a/internal/gateway/compacting.go b/internal/gateway/compacting.go
index 783c11fa6..39e7dde8a 100644
--- a/internal/gateway/compacting.go
+++ b/internal/gateway/compacting.go
@@ -1,6 +1,9 @@
 package gateway
 
-import "strings"
+import (
+	"context"
+	"strings"
+)
 
 // An agent compacting its conversation asks a model to summarize it, with
 // a prompt of its own in the system prompt or as the last user message; a
@@ -11,6 +14,22 @@ import "strings"
 // conversation (usage's "Compaction" purpose).
 const KindCompact = "compact"
 
+// compactionKey carries the request's own compaction verdict from serve to
+// the tries: a plugin provider's fetch is told it in CompactionHeader, so
+// a bridge can keep the summarization turn out of its live tool validation
+// (#7189). Nothing but serve sets it, so a client's X-Magpie-Compaction of
+// its own is never the gateway's word.
+type compactionKey struct{}
+
+func withCompactionMark(ctx context.Context) context.Context {
+	return context.WithValue(ctx, compactionKey{}, true)
+}
+
+func hasCompactionMark(ctx context.Context) bool {
+	v, _ := ctx.Value(compactionKey{}).(bool)
+	return v
+}
+
 // compactLead is how far into the system prompt, or into a text part of the
 // last user message, an agent's compaction prompt may begin. Each agent puts
 // its prompt first or behind a short lead of its own (Claude Code's billing
diff --git a/internal/gateway/gateway.go b/internal/gateway/gateway.go
index 198184813..315188ce2 100644
--- a/internal/gateway/gateway.go
+++ b/internal/gateway/gateway.go
@@ -2678,6 +2678,14 @@ func (s *Server) serve(w http.ResponseWriter, r *http.Request, from provider.Pro
 	if call.Kind == "" {
 		call.Kind = inferredKind(r.Header, from, body)
 	}
+	// a compaction the gateway classified itself goes to a plugin
+	// provider's fetch as CompactionHeader: a bridge that replays history
+	// through its live tool validation dies on the replayed results as a
+	// 409 the client retries (#7189). The try carries the verdict in its
+	// context; a client's X-Magpie-Compaction of its own is never it.
+	if call.Kind == KindCompact {
+		r = r.WithContext(withCompactionMark(r.Context()))
+	}
 	// the reply counted as it reaches the agent, for the Routing page
 	// while it is out (#4951); learned from once it ends
 	capture.live = liveBegin(inflightOf(r.Context()), call.Model, from)
@@ -6675,6 +6683,12 @@ func (s *Server) forwardOnce(ctx context.Context, p provider.Provider, to provid
 		if hasFallback(ctx) {
 			req.Header.Set(provider.FallbackHeader, "1")
 		}
+		// the gateway's own compaction verdict, for a bridge that keeps
+		// its summarization turn out of live tool validation (#7189)
+		req.Header.Del(provider.CompactionHeader)
+		if hasCompactionMark(ctx) {
+			req.Header.Set(provider.CompactionHeader, "1")
+		}
 	}
 	if p.IsRemoteMagpie() {
 		// as magpie, whatever a copy above put on (Claude Code's or
diff --git a/internal/gateway/plugin_compaction_test.go b/internal/gateway/plugin_compaction_test.go
new file mode 100644
index 000000000..f06c0b51f
--- /dev/null
+++ b/internal/gateway/plugin_compaction_test.go
@@ -0,0 +1,95 @@
+package gateway
+
+import (
+	"io"
+	"net/http"
+	"net/http/httptest"
+	"slices"
+	"strings"
+	"sync"
+	"testing"
+
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// A plugin's fetch is told when the gateway itself classified the request
+// as an agent's compaction (CompactionHeader, "1"): the plugin's bridge
+// can then keep the summarization turn out of its live tool validation,
+// where Claude Code's replayed history otherwise dies as a 409 the client
+// retried 87 times in one session (#7189). The mark is the gateway's own
+// verdict: a client's X-Magpie-Compaction of its own is not passed on as
+// one, and a plain turn says nothing.
+func TestPluginToldTheCompaction(t *testing.T) {
+	var mu sync.Mutex
+	var got, vendored []http.Header
+	pid := besideFake(t, "fakeco", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		io.Copy(io.Discard, r.Body)
+		mu.Lock()
+		// the plugin sends the headers it was given on, and the host takes
+		// the magpie ones off: the vendor reads none of them
+		vendored = append(vendored, r.Header.Clone())
+		got = append(got, r.Header.Clone())
+		mu.Unlock()
+		w.Header().Set("Content-Type", "text/event-stream")
+		for _, e := range []string{
+			`{"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"fake-claude","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}`,
+			`{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
+			`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}`,
+			`{"type":"content_block_stop","index":0}`,
+			`{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}`,
+			`{"type":"message_stop"}`,
+		} {
+			io.WriteString(w, "data: "+e+"\n\n")
+		}
+	}))
+	for _, tc := range []struct {
+		name, system, body, forge string
+		want                      string
+	}{
+		{
+			name:   "claude code auto-compaction",
+			system: `"You are a helpful AI assistant tasked with summarizing conversations."`,
+			body:   `,"messages":[{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"out"},{"type":"text","text":"Your task is to create a detailed summary of the conversation so far"}]}]`,
+			want:   "1",
+		},
+		{name: "plain turn", body: `,"messages":[{"role":"user","content":"hi"}]`},
+		{
+			name:  "a client's own mark is not the gateway's",
+			body:  `,"messages":[{"role":"user","content":"hi"}]`,
+			forge: "X-Magpie-Compaction: 1\r\n",
+		},
+	} {
+		mu.Lock()
+		got, vendored = nil, nil
+		mu.Unlock()
+		rec := httptest.NewRequest("POST", "/v1/messages", strings.NewReader(`{"model":"`+pid+`/fake-claude","max_tokens":16`+
+			func() string {
+				if tc.system != "" {
+					return `,"system":` + tc.system
+				}
+				return ""
+			}()+tc.body+`}`))
+		rec.Header.Set("X-Magpie-Compaction", "1")
+		rr := httptest.NewRecorder()
+		New().Handler().ServeHTTP(rr, rec)
+		if rr.Code != 200 {
+			t.Fatalf("%s: %d %s", tc.name, rr.Code, rr.Body)
+		}
+		mu.Lock()
+		sent := slices.Clone(got)
+		mu.Unlock()
+		if len(sent) == 0 {
+			t.Fatalf("%s: the plugin got nothing", tc.name)
+		}
+		for _, h := range sent {
+			if g := h.Get("X-Saw-Compaction"); g != tc.want {
+				t.Errorf("%s: the plugin was told compaction %q, want %q", tc.name, g, tc.want)
+			}
+		}
+		for _, h := range vendored {
+			if h.Get("X-Magpie-Compaction") != "" {
+				t.Errorf("%s: the vendor got %s: %q", tc.name, provider.CompactionHeader, h.Values("X-Magpie-Compaction"))
+			}
+		}
+	}
+}
diff --git a/internal/plugin/host.js b/internal/plugin/host.js
index f72330dd0..fc837b38e 100644
--- a/internal/plugin/host.js
+++ b/internal/plugin/host.js
@@ -728,12 +728,14 @@ function asked(input, init) {
 
 // MAGPIE_ONLY are the headers magpie tells a plugin's fetch where the agent
 // that asked works (WorkDirHeader and WorkGitHeader in internal/provider),
-// that a queue needn't be waited out (FallbackHeader), and the session and
-// subagent the agent named (SessionToPluginHeader, SubagentToPluginHeader)
-// and the effort asked of a model with variants (EffortHeader):
+// that a queue needn't be waited out (FallbackHeader), the session and
+// subagent the agent named (SessionToPluginHeader, SubagentToPluginHeader),
+// the effort asked of a model with variants (EffortHeader), and that the
+// request is an agent's compaction by the gateway's own verdict
+// (CompactionHeader):
 // for the plugin to read, never for its vendor, so a plugin that sends on
 // the headers it was given sends them nowhere.
-const MAGPIE_ONLY = ["x-magpie-work-dir", "x-magpie-work-git", "x-magpie-fallback", "x-magpie-session", "x-magpie-subagent", "x-magpie-effort"]
+const MAGPIE_ONLY = ["x-magpie-work-dir", "x-magpie-work-git", "x-magpie-fallback", "x-magpie-session", "x-magpie-subagent", "x-magpie-effort", "x-magpie-compaction"]
 
 function unsaid(input, init) {
   if (input instanceof Request && MAGPIE_ONLY.some((k) => input.headers.has(k))) {
diff --git a/internal/plugin/testdata/fake/index.js b/internal/plugin/testdata/fake/index.js
index 4202fe258..3f0042482 100644
--- a/internal/plugin/testdata/fake/index.js
+++ b/internal/plugin/testdata/fake/index.js
@@ -264,7 +264,7 @@ export const FakePlugin = async ({ client }) => ({
         // where magpie said the agent works, as the plugin read it; its own
         // headers go on too, as a plugin that sends on what it got sends
         // them, for the host to take off
-        for (const k of ["x-magpie-work-dir", "x-magpie-work-git", "x-magpie-fallback", "x-magpie-session", "x-magpie-subagent", "x-magpie-effort"]) if (h.has(k)) h.set("x-saw-" + k.slice(9), h.get(k))
+        for (const k of ["x-magpie-work-dir", "x-magpie-work-git", "x-magpie-fallback", "x-magpie-session", "x-magpie-subagent", "x-magpie-effort", "x-magpie-compaction"]) if (h.has(k)) h.set("x-saw-" + k.slice(9), h.get(k))
         // $FAKE_QUEUE: that model is queued at the vendor, as Qoder's free
         // models are: waited out (here until magpie gives up) unless magpie
         // said it needn't be, then said at once with the queue's 503
diff --git a/internal/provider/plugins.go b/internal/provider/plugins.go
index 8feb5fdb5..963e7a501 100644
--- a/internal/provider/plugins.go
+++ b/internal/provider/plugins.go
@@ -55,6 +55,15 @@ const (
 // (host.js), as it does the two above.
 const FallbackHeader = "X-Magpie-Fallback"
 
+// CompactionHeader, "1", tells a plugin's fetch that the gateway itself
+// classified the request as an agent's compaction: the plugin can keep the
+// summarization turn out of its live tool validation, where Claude Code's
+// replayed history dies as a 409 it retries (#7189). The mark is the
+// gateway's own verdict, set on the try that goes to a plugin provider;
+// the plugin host takes it off whatever the plugin sends on (host.js), as
+// it does the above.
+const CompactionHeader = "X-Magpie-Compaction"
+
 // WaitHeader tells a magpie's gateway how many seconds its client waits
 // for the answer: a model test asking a remote magpie sends its own wait,
 // and the gateway takes no retry pause or patience round that would end
-- 
2.50.1 (Apple Git-155)

```

</details>

