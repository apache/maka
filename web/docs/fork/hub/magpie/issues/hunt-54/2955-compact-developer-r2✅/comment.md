Re-based onto `c922225f` after the Codex compaction wave (`4896fc3b`, `694674cf`, `19901812`) reshaped the same area of `internal/gateway/codex_backend.go`; the one conflict resolved by keeping the wave's one-line `userMessage` — it now delegates to `codexsummary.UserMessage` — and inserting `developerItemsAsSystem` ahead of it, the behavior unchanged, and nothing of the fix moves into the new `internal/codexsummary` package, which writes no role but the user's. On unmodified `c922225f` the reporter's failure still reproduces (below), so the wave did not cover it: the wave made magpie's compaction item portable and moved where its `magpie1:` mark is read, but the summary ask itself still goes to the provider through `forVendor` with the thread's developer messages in it.

## Verification

| Check | Command | Result |
| --- | --- | --- |
| New tests, patched | `go test ./internal/gateway/ -run 'TestCodexCompactDeveloperAsSystemOnAVendorRelay\|TestVendorRelayTurnKeepsItsDeveloperMessage' -count=1` | ok 1.030s, exit 0 |
| Compaction + relay + rewrite + ported families | same with `-run 'TestCodexCompact\|TestLocalCompaction\|TestNativeCompaction\|TestVendorRelay\|TestAdditionalTools\|TestCodexOpenAIFields\|TestCodexRewrites\|TestPortedCompaction' -count=1` | ok 2.658s, exit 0, 40 tests, the wave's own `TestPortedCompactionReadsTheSame` among them |
| Race, same families | same with `-race -count=1` | ok 18.742s, exit 0 |
| Whole package | `go test ./internal/gateway/ -count=1 -p 1 -timeout 30m` | ok 329.524s, exit 0 |
| Ablation, behavior short-circuit | `if false && compaction` around the swap in `forVendor` | compaction FAIL (same 400), turn PASS; restored → ok |
| Mutation, vendor gate inverted | `!(…)` around the openai/codex early return of `forVendor` | FAIL (same 400); restored → ok |
| gofmt | `gofmt -l` on the six touched files | clean |
| vet | `go vet ./internal/gateway/` (darwin, `GOOS=linux`, `GOOS=windows`) | clean on all three |
| build | `go build ./...` darwin/arm64 and windows/amd64; `GOOS=linux GOARCH=amd64 go build -tags nogui ./...` | ok (darwin full build links with ld version warnings only, pre-existing) |
| `git am` | patch applied to a clean worktree at `c922225f` | applies as is |

---

**Source**: reported in #2955; this comment re-bases the earlier patch after upstream's compaction wave.

**Red without the fix** (base `c922225f`): with the product files reverted and the new tests kept, `go test ./internal/gateway -run TestCodexCompactDeveloperAsSystemOnAVendorRelay` fails:
```
--- FAIL: TestCodexCompactDeveloperAsSystemOnAVendorRelay (0.21s)
    codex_compact_developer_test.go:43: 400 {"error":{"code":"invalid_parameter_error","message":"Fake: developer is not one of ['system', 'assistant', 'user', 'tool', 'function']","param":null,"type":"invalid_request_error"}}
        upstream got {"input":[{"content":[{"text":"You are Codex, a coding agent.","type":"input_text"}],"role":"developer","type":"message"},...
```
With the fix: `ok`.

**Siblings**: where the developer role is mapped today, and why this sits with them — `parseResponses` lifts `system`/`developer` into the system prompt or a `<system-reminder>` user message (`responses.go:354,361`, translated route, untouched); `developerAsSystem` is the same swap on the Chat→Chat passthrough (`gateway.go:6305`, called at `4226`, untouched); `ZedBody` for Zed's cloud (`internal/provider/zed_body.go:36`, untouched); `codexInput`/`chatgpt_api.go` go the other way for the ChatGPT backend, `system` becomes `developer` (`internal/provider/codex_request.go:293,436`, `chatgpt_api.go:611`, untouched — why OpenAI and codex accounts stay excluded here); the cached-search `additional_tools` item rides a turn with the `developer` role (`codex_request.go:556`, the #350 family — a turn's shape, not the summary ask, untouched); `message_tools.go:66` and `format.go:270` only read `system`/`developer` together, no role written (untouched); the new `internal/codexsummary` writes the user role alone (`UserMessage`), so nothing of the swap belongs there. `rg 'forVendor\('` finds one production caller (`gateway.go:4187`, feeding the flag) besides tests; no other gateway site writes `"developer"` into a request.

**When the read fails**: if a body does not decode, `developerItemsAsSystem` returns it unchanged, so a request that cannot be read goes over the wire as it came, like every other path in `forVendor`; the same holds when `forVendor`'s own decode of the body fails.

**Not verified**: no real chat-only vendor was asked — the red is a fake answering with the reporter's exact 400; the report does not say which leg carried the developer message (the provider's own `/responses` or a relay's), but both are the relayed route this fits, and the 400's role list is Chat Completions' own; if the reporter's provider had no Responses URL at all, current main already translates that compaction cleanly and this patch changes nothing there; an ordinary turn that itself carries a developer message to such a vendor is still left as Codex sent it (#350, #1758) and would still be refused there; the wave's rollout port (`sessions.PortCodexRollouts`) is upstream's own work and is only exercised here through its tests (`TestPortedCompactionReadsTheSame` among the families above), not re-verified against a real Codex.

Branch with the commit: [hunt47-c-compact-developer](https://github.com/ggbdpq/magpie/tree/hunt47-c-compact-developer) (head `f8d8ae63`).

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

**Patch**: <details><summary>patch: gateway: a Codex compaction relayed to a vendor that isn't OpenAI's asks as system, not developer (#2955) — git am applies it as is; SHA-256 first 16: d432e41caa5a0c68</summary>
```patch
From f8d8ae631bb7eb0a29c6ff6f6b83010b06e45198 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Tue, 20 Oct 2026 00:35:23 +0800
Subject: [PATCH] gateway: a Codex compaction relayed to a vendor that isn't
 OpenAI's asks as system, not developer (#2955)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

forVendor, the fitting a relayed Responses request gets before it goes to
a provider that isn't OpenAI's, now turns the developer messages of a
summary ask magpie made itself (codexCompact) into system ones, where
they stand (developerItemsAsSystem). Codex's own turns keep the role the
client sent, which a relay may be checking them by (#350, #1758), and
OpenAI's own API and the ChatGPT backend, which take developer as Codex
sends it, get the compaction as it came too.

Why: on a provider whose Responses endpoint fronts a chat-only vendor (a
relay of one; DeepSeek's preset names one base for chat and responses
alike), every Codex compaction failed there with 400 "developer is not
one of ['system', 'assistant', 'user', 'tool', 'function']", retried five
times, while the turns around it passed: the summary request is relayed
as Codex sent it (tools: [], #378), and the compaction carries a
developer message its turns don't. The translated route already lifts
such messages into the system prompt; the summary ask now says them as
system on the relayed route too, in place, so a thread's cached prefix
keeps its shape (#502) — what Zed's cloud is already given (ZedBody) and
what a Chat Completions upstream is given (developerAsSystem).

Run: TestCodexCompactDeveloperAsSystemOnAVendorRelay (red before, green
after; ablated and mutated), the compaction families (TestCodexCompact*,
TestLocalCompaction*, TestNativeCompaction*, TestVendorRelay*,
TestAdditionalTools*, TestCodexOpenAIFields*), the full gateway package,
-race over the families, go vet and go build of the package on darwin,
linux and windows.

Fixes #2955

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/codex_backend.go             | 61 ++++++++++++++-
 .../gateway/codex_compact_developer_test.go   | 78 +++++++++++++++++++
 internal/gateway/codex_compact_guard.go       | 15 ++++
 internal/gateway/codex_openai_fields_test.go  |  6 +-
 internal/gateway/codex_rewrite_scan_test.go   |  6 +-
 internal/gateway/gateway.go                   |  2 +-
 6 files changed, 159 insertions(+), 9 deletions(-)
 create mode 100644 internal/gateway/codex_compact_developer_test.go

diff --git a/internal/gateway/codex_backend.go b/internal/gateway/codex_backend.go
index 3777b829..c8c4023a 100644
--- a/internal/gateway/codex_backend.go
+++ b/internal/gateway/codex_backend.go
@@ -2409,14 +2409,20 @@ var openaiOnly = [][]byte{[]byte(`"internal_chat_message_metadata_passthrough"`)
 // forVendor is a Responses request as Codex sends it to a provider not
 // OpenAI's: without its messages' internal metadata, a call's
 // encrypted_function_args, stream_options' reasoning_summary_delivery and
-// configuration_update items.
+// configuration_update items; and, for a summary ask of magpie's own
+// (compaction, codexCompact), with its developer messages as the system
+// ones they are (developerItemsAsSystem) — Codex's own turns keep the
+// role, which a relay may be checking them by (#350, #1758).
 // A relay that checks it is Codex's turned the lot away ("invalid codex
 // request", #292). OpenAI's API and the ChatGPT backend get it as it came;
 // so does anything else, byte for byte, when none of them is in it.
-func forVendor(p provider.Provider, body []byte) []byte {
+func forVendor(p provider.Provider, body []byte, compaction bool) []byte {
 	if p.Account != nil && p.Account.Agent == "codex" || strings.HasSuffix(p.Host(), "openai.com") {
 		return body
 	}
+	if compaction {
+		body = developerItemsAsSystem(body)
+	}
 	if !slices.ContainsFunc(openaiOnly, func(k []byte) bool { return bytes.Contains(body, k) }) || !forVendorChanges(body) {
 		return body
 	}
@@ -2499,6 +2505,56 @@ func forVendorChanges(body []byte) bool {
 	})
 }
 
+// developerItemsAsSystem turns the developer messages of a Responses
+// request into system ones, where they stand. A provider that isn't
+// OpenAI's may not take the role: its Responses answered a Codex
+// compaction 400 "developer is not one of ['system', 'assistant', 'user',
+// 'tool', 'function']", the chat-only vendor behind it knowing chat roles
+// alone (#2955) — every retry Codex made failed the same, while the turns
+// around it, carrying no developer message, passed. Zed's cloud turned
+// the whole request away over one (ZedBody), and a Chat Completions
+// upstream is given the messages as system for the same reason
+// (developerAsSystem). A developer message says what a system one says,
+// and every Responses backend takes system; the ChatGPT backend, which
+// takes developer alone, never comes here. The message stays where it
+// stood, so a thread's cached prefix keeps its shape (#502).
+func developerItemsAsSystem(body []byte) []byte {
+	if !bytes.Contains(body, []byte(`"developer"`)) {
+		return body
+	}
+	var q map[string]json.RawMessage
+	if json.Unmarshal(body, &q) != nil {
+		return body
+	}
+	var items []json.RawMessage
+	if json.Unmarshal(q["input"], &items) != nil {
+		return body
+	}
+	changed := false
+	out := make([]json.RawMessage, 0, len(items))
+	for _, raw := range items {
+		dec := json.NewDecoder(bytes.NewReader(raw))
+		dec.UseNumber() // a number goes back as it came, not as a float
+		var it map[string]any
+		if dec.Decode(&it) == nil && (it["type"] == nil || it["type"] == "message") && it["role"] == "developer" {
+			it["role"] = "system"
+			if b, err := marshalPlain(it); err == nil {
+				raw, changed = b, true
+			}
+		}
+		out = append(out, raw)
+	}
+	if !changed {
+		return body
+	}
+	q["input"], _ = marshalPlain(out)
+	nb, err := marshalPlain(q)
+	if err != nil {
+		return body
+	}
+	return nb
+}
+
 func userMessage(text string) map[string]any { return codexsummary.UserMessage(text) }
 
 // codexCompact compacts a conversation held by a magpie model: the model
@@ -2536,6 +2592,7 @@ func (s *Server) codexCompact(w http.ResponseWriter, r *http.Request, body []byt
 		r.Header.Set(turnMetadataHeader, turn)
 	}
 	r = askWhole(r)
+	r = askCompaction(r)
 	ask := func(b []byte) (*recorder, compactResult, error) {
 		rec := &recorder{header: http.Header{}, status: 200}
 		s.serve(rec, r, provider.Responses, b)
diff --git a/internal/gateway/codex_compact_developer_test.go b/internal/gateway/codex_compact_developer_test.go
new file mode 100644
index 00000000..08b03fc6
--- /dev/null
+++ b/internal/gateway/codex_compact_developer_test.go
@@ -0,0 +1,78 @@
+package gateway
+
+import (
+	"net/http"
+	"strings"
+	"testing"
+
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// vendorDeveloper400 is what a chat-role upstream answers a request
+// carrying the developer role with (DeepSeek among them, #2955).
+const vendorDeveloper400 = `{"error":{"code":"invalid_parameter_error","message":"developer is not one of ['system', 'assistant', 'user', 'tool', 'function']","param":null,"type":"invalid_request_error"}}`
+
+// #2955: Codex on a provider whose Responses endpoint validates chat
+// roles — a relay of a chat-only vendor's among them, DeepSeek's preset
+// base alike: every compaction failed there with 400 "developer is not
+// one of ['system', 'assistant', 'user', 'tool', 'function']" while the
+// turns around it passed, and Codex retried each five times. The summary
+// request is relayed as it came, and the compaction carries a developer
+// message its turns don't. The summary ask magpie makes itself goes to a
+// provider that isn't OpenAI's with its developer messages as the system
+// ones they are, where they stand: what Zed's cloud is given (ZedBody),
+// and what a Chat Completions upstream is given (developerAsSystem).
+func TestCodexCompactDeveloperAsSystemOnAVendorRelay(t *testing.T) {
+	f := &fake{t: t, reply: sse(
+		`data: {"type":"response.created","response":{"id":"resp_v1","status":"in_progress","output":[]}}`,
+		`data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"SUMMARY"}]}}`,
+		`data: {"type":"response.completed","response":{"id":"resp_v1","status":"completed","output":[]}}`)}
+	f.refuse = func(body []byte) (int, string) {
+		if strings.Contains(string(body), `"role":"developer"`) {
+			return http.StatusBadRequest, vendorDeveloper400
+		}
+		return 0, ""
+	}
+	setup(t, provider.Responses, f)
+	code, body := codexPost(t, `{"model":"fake/m1","stream":true,"store":false,
+	  "input":[{"type":"message","role":"developer","content":[{"type":"input_text","text":"You are Codex, a coding agent."}]},
+	  {"type":"message","role":"user","content":[{"type":"input_text","text":"fix the login bug"}]},
+	  {"type":"message","role":"assistant","content":[{"type":"output_text","text":"I fixed main.go"}]},
+	  {"type":"compaction_trigger"}]}`)
+	if code != 200 || !strings.Contains(body, `"compaction"`) {
+		t.Fatalf("%d %s\nupstream got %s", code, body, f.got)
+	}
+	if got := compactedText(t, body); got != "SUMMARY" {
+		t.Errorf("summary %q", got)
+	}
+	if strings.Contains(string(f.got), `"role":"developer"`) {
+		t.Errorf("developer went over the wire: %s", f.got)
+	}
+	// the message itself stays, where it stood, as a system one
+	if !strings.Contains(string(f.got), `"role":"system"`) || !strings.Contains(string(f.got), "You are Codex, a coding agent.") {
+		t.Errorf("system message lost: %s", f.got)
+	}
+	for _, want := range []string{"fix the login bug", "I fixed main.go", "CONTEXT CHECKPOINT COMPACTION"} {
+		if !strings.Contains(string(f.got), want) {
+			t.Errorf("summary request lacks %q: %s", want, f.got)
+		}
+	}
+}
+
+// A turn on the same provider goes as it came, developer message and all:
+// only magpie's own summary ask is fitted, never Codex's own turn, whose
+// shape a relay may be checking (#350, #1758).
+func TestVendorRelayTurnKeepsItsDeveloperMessage(t *testing.T) {
+	f := &fake{t: t, reply: sse(
+		`data: {"type":"response.completed","response":{"id":"resp_v2","status":"completed","output":[]}}`)}
+	setup(t, provider.Responses, f)
+	code, body := codexPost(t, `{"model":"fake/m1","stream":true,"store":false,
+	  "input":[{"type":"message","role":"developer","content":[{"type":"input_text","text":"You are Codex, a coding agent."}]},
+	  {"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}]}`)
+	if code != 200 {
+		t.Fatalf("%d %s", code, body)
+	}
+	if !strings.Contains(string(f.got), "hello") || !strings.Contains(string(f.got), `"role":"developer"`) {
+		t.Errorf("turn's developer message changed: %s", f.got)
+	}
+}
diff --git a/internal/gateway/codex_compact_guard.go b/internal/gateway/codex_compact_guard.go
index b3f7f5ca..fede0624 100644
--- a/internal/gateway/codex_compact_guard.go
+++ b/internal/gateway/codex_compact_guard.go
@@ -125,6 +125,21 @@ func wantsWhole(ctx context.Context) bool {
 	return v
 }
 
+// compactionAskKey marks a request that is magpie's own summary ask for a
+// compaction (codexCompact). It is not Codex's turn: a provider that
+// isn't OpenAI's is given its developer messages as the system ones they
+// are (forVendor), while Codex's own turns keep the role the client sent.
+type compactionAskKey struct{}
+
+func asksCompaction(ctx context.Context) bool {
+	v, _ := ctx.Value(compactionAskKey{}).(bool)
+	return v
+}
+
+func askCompaction(r *http.Request) *http.Request {
+	return r.WithContext(context.WithValue(r.Context(), compactionAskKey{}, true))
+}
+
 func askWhole(r *http.Request) *http.Request {
 	return r.WithContext(context.WithValue(r.Context(), wholeReplyKey{}, true))
 }
diff --git a/internal/gateway/codex_openai_fields_test.go b/internal/gateway/codex_openai_fields_test.go
index 2598b477..3a25f925 100644
--- a/internal/gateway/codex_openai_fields_test.go
+++ b/internal/gateway/codex_openai_fields_test.go
@@ -84,18 +84,18 @@ func TestCodexOpenAIFieldsStayWithOpenAI(t *testing.T) {
 		{Responses: "https://api.openai.com/v1"},
 		{Account: &provider.Account{Agent: "codex"}},
 	} {
-		if got := forVendor(p, []byte(sent)); string(got) != sent {
+		if got := forVendor(p, []byte(sent), false); string(got) != sent {
 			t.Errorf("%+v: %s", p, got)
 		}
 	}
 	// another client's stream_options stay
 	vendor := provider.Provider{Responses: "https://relay.example/v1"}
 	other := `{"model":"m1","input":"hi","stream":true,"stream_options":{"include_obfuscation":false}}`
-	if got := forVendor(vendor, []byte(other)); string(got) != other {
+	if got := forVendor(vendor, []byte(other), false); string(got) != other {
 		t.Errorf("another client's: %s", got)
 	}
 	both := `{"stream_options":{"include_obfuscation":false,"reasoning_summary_delivery":"sequential_cutoff"}}`
-	if got := forVendor(vendor, []byte(both)); string(got) != `{"stream_options":{"include_obfuscation":false}}` {
+	if got := forVendor(vendor, []byte(both), false); string(got) != `{"stream_options":{"include_obfuscation":false}}` {
 		t.Errorf("both: %s", got)
 	}
 }
diff --git a/internal/gateway/codex_rewrite_scan_test.go b/internal/gateway/codex_rewrite_scan_test.go
index 51ef28f3..26628cdc 100644
--- a/internal/gateway/codex_rewrite_scan_test.go
+++ b/internal/gateway/codex_rewrite_scan_test.go
@@ -61,7 +61,7 @@ var codexRewrites = func() []codexRewrite {
 			}
 			return wasWithModel(b, "gpt-5.5<&>")
 		}},
-		{"forVendor", func(b []byte) []byte { return forVendor(relay, b) }, func(b []byte) []byte { return wasForVendor(relay, b) }},
+		{"forVendor", func(b []byte) []byte { return forVendor(relay, b, false) }, func(b []byte) []byte { return wasForVendor(relay, b) }},
 	}
 	for _, magpie := range []bool{false, true} {
 		for _, native := range []bool{false, true} {
@@ -97,10 +97,10 @@ func TestCodexRewritesLeaveTurnUndecoded(t *testing.T) {
 	plain := codexSession(60, func(_ int, it map[string]any) { delete(it, "internal_chat_message_metadata_passthrough") })
 	plain = append(plain[:len(plain)-1], []byte(`,"note":"internal_chat_message_metadata_passthrough"}`)...)
 	relay := provider.Provider{Responses: "https://relay.example/v1"}
-	if got := forVendor(relay, plain); !bytes.Equal(got, plain) {
+	if got := forVendor(relay, plain, false); !bytes.Equal(got, plain) {
 		t.Fatal("forVendor changed a body with nothing to leave out")
 	}
-	if a := testing.AllocsPerRun(5, func() { forVendor(relay, plain) }); a > 10 {
+	if a := testing.AllocsPerRun(5, func() { forVendor(relay, plain, false) }); a > 10 {
 		t.Errorf("forVendor: %v allocations for a body it leaves as it came", a)
 	}
 }
diff --git a/internal/gateway/gateway.go b/internal/gateway/gateway.go
index e8ab620a..412700b3 100644
--- a/internal/gateway/gateway.go
+++ b/internal/gateway/gateway.go
@@ -4184,7 +4184,7 @@ func (s *Server) passthrough(w http.ResponseWriter, r *http.Request, p provider.
 		if p.Account == nil || p.Account.Agent != "codex" {
 			body, searchFn = searchAsFunction(body)
 		}
-		body = forVendor(p, body)
+		body = forVendor(p, body, asksCompaction(r.Context()))
 		if replay {
 			// its reasoning goes back as text, never left out: DeepSeek
 			// refuses a request without it (#1104)
-- 
2.50.1 (Apple Git-155)

```

</details>
