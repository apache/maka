## Summary

The branch of #141/#613 that no fix reached is the relay. On a vendor serving the Responses API natively, Codex's request is relayed as it came (`Server.passthrough`, internal/gateway/gateway.go:4179) — and the vendor's reply went back as it came too. A vendor that answers `collaboration.spawn_agent` with its plain-text arguments but no `encrypted_function_args` field (exactly what the issue's probe recorded: namespace kept, arguments kept, no list) handed Codex a call Codex cannot read as a plain-text task: `ToolCall::direct_source` (codex-rs tools/router.rs, rust-v0.163.0) picks `DirectPlaintextMessage` only when `encrypted_function_args` is present and empty. So Codex took the task for sealed, wrapped the readable message in an `encrypted_content` of its own under the NEW_TASK header, and the subagent — handed ciphertext it cannot open, which is really plain text — asked what the task was and did nothing. That is the issue's item 3-5.

The translated path has said "not sealed" since #613: `callTo` gives every namespaced call `encrypted_function_args: []` (internal/gateway/responses.go:1711, "Nothing magpie serves seals arguments"). The Grok and Zed relays have had it through `nsTidy` since #404 (internal/gateway/grok_namespace.go). The one place neither reached is the relay to any other vendor: `namespacedIn` was read only for Grok and Zed (internal/gateway/gateway.go:4385 at base), so no relayed reply ever carried the word.

## Cause

The relay's response side passes a vendor's reply through a row of small tidies, and the only one that knows Codex's namespaces was gated to two plugins. A vendor asked as Codex sends it keeps the namespace in its tools and says it back on the call; what is missing from its reply is not the name, it is the empty list — the one bit Codex reads to tell a plain-text task from a sealed one. Nothing magpie serves seals arguments on this path either: the marks in spawn_agent's schema go upstream only as schema, and the issue's probe confirms the vendor answers 200 with plain arguments and no list.

## Fix

The namespaced tools a Responses request offers are now read on every relay, not only Grok's and Zed's (internal/gateway/gateway.go, the `named` computation in `passthrough`), and `nsTidy.call` (internal/gateway/grok_namespace.go) now also handles a call whose namespace the upstream named itself: when (namespace, name) matches a tool the request offered and the call carries no `encrypted_function_args`, the empty list is added — the same shape `callTo` gives the translated path. A call that does carry a seal — OpenAI's own, or any upstream that answers the mark — goes back with that seal untouched, and a call to a tool outside every namespace says nothing about seals either way (both locked by `TestNativeRelayLeavesOtherCallsBe`). The loop closes on the way back: the field Codex replays of it in a later turn's history is still what `forVendor` leaves out of what a non-OpenAI vendor is asked (`openaiOnly`, internal/gateway/codex_backend.go:2422), so the vendor never sees it.

## Verification

| Run | Result |
|---|---|
| `TestNativeRelayNamespacedCallSaysUnsealed` (stub vendor, stream and whole; asserts the relay, not a translation, and the empty list on every function_call Codex reads) | red on base, green with the fix |
| ablation: fix removed (`git checkout` of the two source files) | red, same assertion, `native_relay_collab_test.go:122`; fix restored, green |
| mutation: the list filled (`[]any{""}`) | red — a non-empty list is not "unsealed"; restored, green |
| `TestNativeRelayLeavesOtherCallsBe` (sealed call, plain call) | green: the seal survives, the plain call stays bare |
| `go test ./internal/gateway -count=1` (full package) | ok 322.6s |
| the new tests + the #404/#613 namespace tests, `-race` | ok |
| `gofmt -l`, `go vet ./internal/gateway` | clean |
| `CGO_ENABLED=0 go build -tags nogui` darwin/arm64, linux/amd64, windows/amd64 | ok |

## Not verified

Not tried against the reporter's vendor or a real Codex Desktop; the stub's reply is the shape their probe recorded. The issue's second wish — a plaintext `agent_message` input item an upstream doesn't know turned into task text (their hand-built probe's 400 `unknown type: agent_message`) — is not addressed here: the real V2 rollout failed at the classification, before any `agent_message` went upstream, and reshaping every relayed conversation that carries one is a separate decision (the Grok relay does it in `grokAgentMessage`; a native relay doing it for every vendor is a bigger change than this branch needs).

---

**Source**: reported in #3183 (john-zeng-233, with V2 rollout records).

**Red without the fix** (base `f5b01574`):

```
--- FAIL: TestNativeRelayNamespacedCallSaysUnsealed (0.11s)
    native_relay_collab_test.go:122: stream true: Codex was given map[arguments: call_id:c9 id:fc_1 name:spawn_agent namespace:collaboration type:function_call]
FAIL
FAIL	github.com/yetone/magpie/internal/gateway	1.009s
```

(the call Codex was given carries no `encrypted_function_args` — the issue's item 3.)

**Siblings**: the field has three handling points, all now saying the same thing. The translated path adds the empty list in `callTo` (internal/gateway/responses.go:1711, #613); the request side strips what Codex replays of it before a non-OpenAI vendor is asked (`forVendor`/`openaiOnly`, internal/gateway/codex_backend.go:2422); the relay now adds it in `nsTidy.call` for a call named with its namespace (and, as since #404, renames a flat `collaboration__spawn_agent` back for the plugins that were offered it flat). No other spot in the tree reads or writes the field. The V1 spawn path, the spawn_agent models list and the session viewers do not touch it.

**When an upstream seals for real**: a reply whose namespaced call carries `encrypted_function_args` — OpenAI's own relays, or a vendor that honours the schema mark — passes with its seal exactly as it came; the fix adds nothing beside an absent list, and Codex's own handling of a seal it cannot open is unchanged.

Branch with the commit: [hunt57-e-native-relay-collab](https://github.com/ggbdpq/magpie/tree/hunt57-e-native-relay-collab) (head `9fff5bab`).

**Attribution**: AI-written; reviewed and posted by ggbdpq. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

**Patch**: 3 files changed, 189 insertions(+), 4 deletions(-). SHA-256 first 16: `1b3f7c114dcf2c15`.

```patch
From 9fff5bab0f3a2e1da5ac71d00d98890183634921 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 21 Oct 2026 22:27:00 +0800
Subject: [PATCH] gateway: a relayed Responses reply says a namespaced call's
 arguments are not sealed, so Codex V2 hands the subagent its task (#3183)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

Codex offers its collaboration tools in a namespace, and marks
spawn_agent's message "encrypted". On a vendor serving the Responses
API natively the request is relayed as it came, and the vendor's reply
went back as it came too: the function_call for collaboration.spawn_agent
reached Codex with its plain-text arguments and no encrypted_function_args
field at all. Codex reads a namespaced call as DirectPlaintextMessage
only when that field is there and empty (tools/router.rs, rust-v0.163.0),
so it took the task for sealed, wrapped the plain text in an
encrypted_content of its own, and the subagent — asked over that —
replied "tell me the task" and did nothing. The translated path has said
"not sealed" since #613 (callTo's encrypted_function_args []), and the
Grok and Zed relays have had it through nsTidy since #404; the relay to
any other vendor is the branch left out.

What changed: the namespaced tools a Responses request offers are now
read on every relay, not only Grok's and Zed's, and a call that comes
back with its namespace named is answered with the empty
encrypted_function_args list when it carries none. A call carrying a
seal — OpenAI's own, or any upstream that answers the mark — goes back
with that seal untouched, and calls to tools outside every namespace
say nothing about seals either way. The field Codex replays of it in a
later turn's history is still what forVendor leaves out of what a
non-OpenAI vendor is asked (openaiOnly), so the loop closes without the
vendor ever seeing it.

TestNativeRelayNamespacedCallSaysUnsealed relays a request with the
collaboration namespace to a stub vendor whose reply carries the call
streamed and whole, and reads every function_call Codex would see: both
shapes say the arguments are plain text, and the namespace went up as
Codex sent it (the request was relayed, not translated). Without the
fix the call arrives with no encrypted_function_args. TestNativeRelayLeavesOtherCallsBe
holds a sealed call's seal and leaves a plain call alone.

Run: go test ./internal/gateway -count=1 ok (322s); the new tests and
the #404/#613 namespace tests green with and without -race; gofmt -l
clean; go vet of the package clean; CGO_ENABLED=0 go build -tags nogui
for darwin/arm64, linux/amd64 and windows/amd64. Not tried against the
reporter's vendor; the stub's reply is the shape their probe recorded
(namespace and plain arguments kept, no encrypted list).

Fixes #3183

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/gateway.go                  |   6 +-
 internal/gateway/grok_namespace.go           |  20 ++-
 internal/gateway/native_relay_collab_test.go | 167 +++++++++++++++++++
 3 files changed, 189 insertions(+), 4 deletions(-)
 create mode 100644 internal/gateway/native_relay_collab_test.go

diff --git a/internal/gateway/gateway.go b/internal/gateway/gateway.go
index f315b819..63b0522e 100644
--- a/internal/gateway/gateway.go
+++ b/internal/gateway/gateway.go
@@ -4380,9 +4380,11 @@ func (s *Server) passthrough(w http.ResponseWriter, r *http.Request, p provider.
 	}
 	// a Grok subscription is given Codex's namespaced functions flat
 	// (grokBody), and Zed's plugin likewise (ZedBody); a call to one goes
-	// back under its namespace (#404)
+	// back under its namespace (#404). Any vendor asked as Codex sends it
+	// has its namespaced calls read by Codex: one without the empty
+	// encrypted_function_args list reads as sealed (#3183)
 	var named map[string]nsTool
-	if proto == provider.Responses && p.Account != nil && (p.Account.Agent == "grok" || p.PluginProvider() == "grok" || p.PluginProvider() == "zed") {
+	if proto == provider.Responses {
 		named = namespacedIn(body)
 	}
 	res, err := s.forward(r.Context(), p, proto, path, p.Prepare(body), r.Header)
diff --git a/internal/gateway/grok_namespace.go b/internal/gateway/grok_namespace.go
index f15a502f..c946acca 100644
--- a/internal/gateway/grok_namespace.go
+++ b/internal/gateway/grok_namespace.go
@@ -165,12 +165,28 @@ func (t *nsTidy) restore(data []byte) ([]byte, bool) {
 }
 
 // call names a function_call to a namespaced function by its name and
-// namespace, and reports whether it was one.
+// namespace, and reports whether it was one. A call whose namespace the
+// upstream said itself (a vendor asked as Codex sends it, #3183) needs no
+// naming, only the word that its arguments are not sealed: Codex reads a
+// namespaced call without the empty list as sealed, and the plain-text
+// task would reach its subagent as ciphertext.
 func (t *nsTidy) call(it map[string]any) bool {
-	if it == nil || it["type"] != "function_call" || it["namespace"] != nil {
+	if it == nil || it["type"] != "function_call" {
 		return false
 	}
 	name, _ := it["name"].(string)
+	if ns, _ := it["namespace"].(string); ns != "" {
+		for _, q := range t.named {
+			if q.Namespace == ns && q.Name == name {
+				if _, ok := it["encrypted_function_args"]; !ok {
+					it["encrypted_function_args"] = []any{}
+					return true
+				}
+				break
+			}
+		}
+		return false
+	}
 	if _, ok := t.named[name]; !ok {
 		return false
 	}
diff --git a/internal/gateway/native_relay_collab_test.go b/internal/gateway/native_relay_collab_test.go
new file mode 100644
index 00000000..af882460
--- /dev/null
+++ b/internal/gateway/native_relay_collab_test.go
@@ -0,0 +1,167 @@
+package gateway
+
+import (
+	"encoding/json"
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
+// codexCollabTools is Codex's collaboration namespace, spawn_agent in it.
+const codexCollabTools = `"tools":[
+	{"type":"function","name":"exec_command","parameters":{"type":"object"}},
+	{"type":"namespace","name":"collaboration","description":"Tools in the collaboration namespace.","tools":[
+		{"type":"function","name":"spawn_agent","description":"Spawns an agent.","parameters":{"type":"object","properties":{"message":{"type":"string","encrypted":true}}}}
+	]}
+]`
+
+// #3183 (john-zeng-233): a vendor serving the Responses API natively is
+// relayed Codex's request as it came, and its reply goes back as it came:
+// the call to collaboration.spawn_agent reached Codex without the empty
+// encrypted_function_args list, and Codex read the plain-text message as
+// sealed — the subagent was handed its task in an encrypted_content and
+// asked what the task was. Codex picks DirectPlaintextMessage only when
+// the list is there and empty, as the translated path's callTo gives it.
+func TestNativeRelayNamespacedCallSaysUnsealed(t *testing.T) {
+	fresh(t)
+	var mu sync.Mutex
+	var sent []map[string]any
+	call := `{"type":"function_call","id":"fc_1","call_id":"c9","name":"spawn_agent","namespace":"collaboration","arguments":"{\"message\":\"go\"}","status":"completed"}`
+	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		b, _ := io.ReadAll(r.Body)
+		var q map[string]any
+		json.Unmarshal(b, &q)
+		mu.Lock()
+		sent = append(sent, q)
+		mu.Unlock()
+		done := `{"id":"r1","object":"response","status":"completed","output":[` + call + `],"usage":{"input_tokens":5,"output_tokens":3}}`
+		if q["stream"] != true {
+			w.Header().Set("Content-Type", "application/json")
+			io.WriteString(w, done)
+			return
+		}
+		w.Header().Set("Content-Type", "text/event-stream")
+		io.WriteString(w, sse(
+			`event: response.created`+"\n"+`data: {"type":"response.created","response":{"id":"r1","object":"response","status":"in_progress","output":[]}}`,
+			`event: response.output_item.added`+"\n"+`data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"c9","name":"spawn_agent","namespace":"collaboration","arguments":""}}`,
+			`event: response.output_item.done`+"\n"+`data: {"type":"response.output_item.done","output_index":0,"item":`+call+`}`,
+			`event: response.completed`+"\n"+`data: {"type":"response.completed","response":`+done+`}`))
+	}))
+	defer up.Close()
+	if err := provider.Save(provider.Provider{ID: "ucloud", Name: "UCloud", Key: "k", Models: []string{"m"}, Responses: up.URL + "/v1"}); err != nil {
+		t.Fatal(err)
+	}
+	s := New()
+	for _, stream := range []bool{true, false} {
+		mu.Lock()
+		sent = nil
+		mu.Unlock()
+		body := `{"model":"ucloud/m","stream":` + map[bool]string{true: "true", false: "false"}[stream] + `,` + codexCollabTools + `,"input":[{"type":"message","role":"user","content":"go"}]}`
+		rec := httptest.NewRecorder()
+		s.Handler().ServeHTTP(rec, httptest.NewRequest("POST", "/v1/responses", strings.NewReader(body)))
+		if rec.Code != 200 {
+			t.Fatalf("stream %v: %d %s", stream, rec.Code, rec.Body)
+		}
+		// relayed, not translated: the namespace went up as Codex sent it
+		mu.Lock()
+		if len(sent) != 1 {
+			t.Fatalf("stream %v: the vendor was asked %d times", stream, len(sent))
+		}
+		q := sent[0]
+		mu.Unlock()
+		tools, _ := q["tools"].([]any)
+		if len(tools) != 2 {
+			t.Fatalf("stream %v: the vendor was offered %v", stream, q["tools"])
+		}
+		if tm, _ := tools[1].(map[string]any); tm["type"] != "namespace" || tm["name"] != "collaboration" {
+			t.Fatalf("stream %v: the request was translated, its tools went as %v", stream, q["tools"])
+		}
+
+		// every function_call Codex reads says its arguments are plain text
+		var items []map[string]any
+		if stream {
+			for _, line := range strings.Split(rec.Body.String(), "\n") {
+				data, ok := strings.CutPrefix(line, "data: ")
+				if !ok {
+					continue
+				}
+				var ev struct {
+					Item     map[string]any `json:"item"`
+					Response struct {
+						Output []map[string]any `json:"output"`
+					} `json:"response"`
+				}
+				if err := json.Unmarshal([]byte(data), &ev); err != nil {
+					t.Fatalf("%v: %s", err, data)
+				}
+				if ev.Item != nil {
+					items = append(items, ev.Item)
+				}
+				items = append(items, ev.Response.Output...)
+			}
+		} else {
+			var res struct {
+				Output []map[string]any `json:"output"`
+			}
+			if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
+				t.Fatalf("%v: %s", err, rec.Body)
+			}
+			items = res.Output
+		}
+		if len(items) == 0 || stream && len(items) != 3 {
+			t.Fatalf("stream %v: %s", stream, rec.Body)
+		}
+		for _, it := range items {
+			sealed, ok := it["encrypted_function_args"].([]any)
+			if it["name"] != "spawn_agent" || it["namespace"] != "collaboration" || !ok || len(sealed) != 0 {
+				t.Fatalf("stream %v: Codex was given %v", stream, it)
+			}
+		}
+	}
+}
+
+// The seal a reply carries is the seal the client reads: an upstream that
+// answered a namespaced call with its arguments sealed hands that seal on
+// untouched, and a call to a tool outside every namespace says nothing
+// about seals either way (#3183).
+func TestNativeRelayLeavesOtherCallsBe(t *testing.T) {
+	fresh(t)
+	sealed := `{"type":"function_call","id":"fc_1","call_id":"c9","name":"spawn_agent","namespace":"collaboration","arguments":"","encrypted_function_args":[{"content":"gAAAAAsealed"}],"status":"completed"}`
+	plain := `{"type":"function_call","id":"fc_2","call_id":"c8","name":"exec_command","arguments":"{}","status":"completed"}`
+	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		io.ReadAll(r.Body)
+		w.Header().Set("Content-Type", "application/json")
+		io.WriteString(w, `{"id":"r1","object":"response","status":"completed","output":[`+sealed+`,`+plain+`],"usage":{"input_tokens":5,"output_tokens":3}}`)
+	}))
+	defer up.Close()
+	if err := provider.Save(provider.Provider{ID: "ucloud", Name: "UCloud", Key: "k", Models: []string{"m"}, Responses: up.URL + "/v1"}); err != nil {
+		t.Fatal(err)
+	}
+	s := New()
+	body := `{"model":"ucloud/m","stream":false,` + codexCollabTools + `,"input":[{"type":"message","role":"user","content":"go"}]}`
+	rec := httptest.NewRecorder()
+	s.Handler().ServeHTTP(rec, httptest.NewRequest("POST", "/v1/responses", strings.NewReader(body)))
+	if rec.Code != 200 {
+		t.Fatalf("%d %s", rec.Code, rec.Body)
+	}
+	var res struct {
+		Output []map[string]any `json:"output"`
+	}
+	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
+		t.Fatal(err)
+	}
+	if len(res.Output) != 2 {
+		t.Fatalf("%s", rec.Body.String())
+	}
+	if got, ok := res.Output[0]["encrypted_function_args"].([]any); !ok || len(got) != 1 {
+		t.Fatalf("the seal was lost: %v", res.Output[0])
+	}
+	if _, ok := res.Output[1]["encrypted_function_args"]; ok {
+		t.Fatalf("a plain call was given a seal: %v", res.Output[1])
+	}
+}
-- 
2.50.1 (Apple Git-155)

```
