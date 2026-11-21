gateway: a Codex compaction relayed to a vendor that isn't OpenAI's asks as system, not developer (#2955)

The reporter runs magpie 0.1.1272 with Codex CLI 0.163.0 (`openai_base_url` at magpie's `/backend-api/codex`, `X-Codex-Beta-Features: prevent_idle_sleep,remote_compaction_v2`) on `deepseek-v4.1-flash-1017`, a model of a provider configured `baseAPI = "chat"`. Every `/compact` — and the automatic compaction — fails, each attempt retried five times, with the upstream's:

```json
{"error":{"code":"invalid_parameter_error","message":"developer is not one of ['system', 'assistant', 'user', 'tool', 'function']","param":null,"type":"invalid_request_error"}}
```

`in = 0` on every attempt, while ordinary turns on the same endpoint and model return 200. That role list is Chat Completions': the request reached something that validates chat roles.

Branch: [`hunt47-c-compact-developer`](https://github.com/ggbdpq/magpie/tree/hunt47-c-compact-developer), one commit on top of upstream `ef655acb`; the patch below applies with `git am`.

## What changed

Two findings on current main (`ef655acb`) decided where the fix goes:

1. **The fully translated route is already safe.** On a provider with only a Chat URL, a `compaction_trigger` is replaced by magpie's summary ask (`codexInputAs` → `codexCompact`), re-served as Responses, parsed by `parseResponses` — which lifts `developer` messages into the system prompt (or, mid-thread, into a `<system-reminder>` user message, #502) — and rebuilt by `buildChat`, which never writes `developer`. I reproduced the reporter's shape (a developer message plus a `compaction_trigger`) against a Chat-only fake: the wire carried `system`, `user`, `assistant`, `user` and the compaction completed. Nothing in `v0.1.1272..ef655acb` touched this, so the shape has not changed since the reporter's version.

2. **The gap is the relayed route.** A provider that also speaks Responses — DeepSeek's own preset names one base for chat and responses alike; a relay exposing `/v1/responses` over a chat-only vendor is the same shape — has the summary ask **relayed as it came** (`passthrough`, the compaction offers no tools, #378), and `forVendor`, the fitting that relay gets, did nothing about roles. The compaction carries a developer message its turns don't, the vendor's role check rejects it, magpie passes the 400 back (it is not a 404 / `itemNotFound` / `upstreamFailed` / protection refusal, so the `plainCompact` retry at #866/#1008 doesn't fire), and Codex retries it five times. Turns carry no developer message, so they pass.

The fix marks the request as magpie's own summary ask (`askCompaction` in `codexCompact`, mirroring the existing `askWhole`) and, at that one point, `forVendor` turns its developer messages into system ones (`developerItemsAsSystem`), in place, so a thread's cached prefix keeps its shape (#502). OpenAI's own API and the ChatGPT backend — which take `developer` as Codex sends it, and whose backend rejects `system` input items — still get the compaction byte for byte. Codex's own turns on any provider keep the role the client sent.

## Red before the fix

With the new test's fake answering any body carrying `"role":"developer"` with the reporter's exact 400, `TestCodexCompactDeveloperAsSystemOnAVendorRelay` failed on unmodified `ef655acb`:

```
codex_compact_developer_test.go:43: 400 {"error":{"code":"invalid_parameter_error","message":"Fake: developer is not one of ['system', 'assistant', 'user', 'tool', 'function']","param":null,"type":"invalid_request_error"}}
    upstream got {"input":[{"content":[{"text":"You are Codex, a coding agent.","type":"input_text"}],"role":"developer","type":"message"},...
```

The summary ask went over the wire with `"role":"developer"` and the vendor's 400 came back to Codex — the reporter's failure, end to end. With the patch, the same request goes out as `system` and the compaction completes with the summary.

## Verification

| Check | Command | Result |
| --- | --- | --- |
| New test, upstream `ef655acb` | `go test ./internal/gateway/ -run TestCodexCompactDeveloperAsSystemOnAVendorRelay` | FAIL (400 relayed to Codex, `developer` on the wire) |
| New test + scoping test, patched | same, plus `TestVendorRelayTurnKeepsItsDeveloperMessage` | PASS (compaction 200 with summary; a turn's developer message untouched) |
| Ablation | all four touched product files restored from `upstream/main`, tests kept | FAIL (same red); restoring the files → PASS |
| Mutation a: `developer` → `user` | same test | FAIL ("system message lost" — a developer message must not become a user turn) |
| Mutation b: marker removed (fix never fires on the summary ask) | compaction test vs turn test | compaction FAIL, turn PASS (fix sits exactly where the gap was) |
| Compaction + relay families | `go test ./internal/gateway/ -run 'TestCodexCompact\|TestLocalCompaction\|TestNativeCompaction\|TestVendorRelay\|TestAdditionalTools\|TestCodexOpenAIFields' -count=1` | ok, 37 tests, exit 0 |
| Whole package | `go test ./internal/gateway/ -count=1` | ok 319.078s, exit 0 (includes `TestAdditionalToolsRelayed`, the #350 contract the first draft of this fix broke and this scoping respects) |
| Race | same families with `-race` | ok, exit 0 |
| gofmt | `gofmt -l internal/gateway/` | clean |
| vet | `go vet ./internal/gateway/` (darwin, `GOOS=linux`, `GOOS=windows`) | clean on all three |
| build | `go build ./internal/gateway/` (darwin, `GOOS=linux`, `GOOS=windows`); `go build ./...` on darwin | ok; darwin full build links with ld version warnings only |

## Siblings

Where developer roles are mapped today, and why this sits with them:

- `parseResponses` (translated Responses → any other API): lifts `developer` into the system prompt, or keeps it in place as a `<system-reminder>` user message after the first reply (#502). The compaction through a translated route was already consistent with ordinary turns.
- `developerAsSystem` (Chat → Chat passthrough): the same swap for Chat Completions bodies, added for Pi on DeepSeek (#1, "every backend accepts system, OpenAI included"). The summary ask now gets the same treatment on the relayed Responses route.
- `ZedBody` (Zed's plugin): Zed's cloud turned the whole request away over `developer` ("unknown variant `developer`"), and the fix there was the same in-place swap.
- `codexInput` (`internal/provider/codex_request.go`): goes the *other* way for the ChatGPT backend — `system` becomes `developer`, because that backend rejects `system` input items. That is why the swap here skips OpenAI's own API and codex accounts: the compaction through magpie's ChatGPT accounts (#2582) must keep `developer`.
- `TestAdditionalToolsRelayed` (#350) asserts a relayed turn keeps its `developer` role — a relay may be checking Codex's shape by it (#1758). That test is why the swap is scoped to magpie's own summary ask rather than applied to every relayed request; my first draft applied it unconditionally and that test caught it.

## Not verified

- No real DeepSeek or other chat-only upstream was asked; the vendor's role whitelist is quoted from the report, and it matches the Chat Completions role set. The RED is a fake that refuses `developer` with the reporter's exact error.
- I cannot tell from the report which leg carried the reporter's developer message — the provider's own `/responses` (the DeepSeek preset points Responses at the same base as chat) or a relay's — but both are the same relayed route this patch fixes, and the 400's role list (with `function` in it) is Chat's own.
- If the reporter's provider truly had no Responses URL at all, current main already translates that compaction cleanly (finding 1), and this patch changes nothing there.
- An ordinary turn that itself carries a developer message to such a vendor is left as Codex sent it (#350, #1758) and would still be refused there; this patch only fits the request that is magpie's own.

**AI**: written with an AI coding agent; I've read the whole diff and can answer questions on it myself. The model name is in the commit's trailer.

**Attribution**: If you apply the patch, please keep its author (ggbdpq) or add a `Co-authored-by: ggbdpq <ggbdpq@gmail.com>` line.

<details><summary>patch — gateway: a Codex compaction relayed to a vendor that isn't OpenAI's asks as system, not developer (#2955)</summary>

```patch
From 58906f6ec14de57ae740244bcb0b6c28aa25a64a Mon Sep 17 00:00:00 2001
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
 internal/gateway/gateway.go                   |  2 +-
 5 files changed, 156 insertions(+), 6 deletions(-)
 create mode 100644 internal/gateway/codex_compact_developer_test.go

diff --git a/internal/gateway/codex_backend.go b/internal/gateway/codex_backend.go
index b783f9be..e18898b1 100644
--- a/internal/gateway/codex_backend.go
+++ b/internal/gateway/codex_backend.go
@@ -2037,14 +2037,20 @@ var openaiOnly = [][]byte{[]byte(`"internal_chat_message_metadata_passthrough"`)
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
 	if !slices.ContainsFunc(openaiOnly, func(k []byte) bool { return bytes.Contains(body, k) }) {
 		return body
 	}
@@ -2102,6 +2108,56 @@ func forVendor(p provider.Provider, body []byte) []byte {
 	return nb
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
 func userMessage(text string) map[string]any {
 	return map[string]any{"type": "message", "role": "user",
 		"content": []map[string]any{{"type": "input_text", "text": text}}}
@@ -2142,6 +2198,7 @@ func (s *Server) codexCompact(w http.ResponseWriter, r *http.Request, body []byt
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
diff --git a/internal/gateway/gateway.go b/internal/gateway/gateway.go
index 8f950d31..fdb7225b 100644
--- a/internal/gateway/gateway.go
+++ b/internal/gateway/gateway.go
@@ -4139,7 +4139,7 @@ func (s *Server) passthrough(w http.ResponseWriter, r *http.Request, p provider.
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
