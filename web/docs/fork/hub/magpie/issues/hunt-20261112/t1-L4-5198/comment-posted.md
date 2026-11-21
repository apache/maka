**What's wrong**

A subagent's task its lead sealed reaches the provider that can open it (`sealedReader`, #1109), but `attempt`'s downgrades to a translation didn't know a sealed task is in the request. When the provider has been marked as having turned Codex's custom tools away (`customToolRefused`), the request is translated from the start; when the refusal is met on the sealed turn itself, the fallback after `passthrough` translates it. A translation reads an `agent_message`'s text and images alone (`responsesParts` has no case for `encrypted_content`), so the `NEW_TASK` header went to the model and the sealed body — the task itself — stayed behind, with an HTTP 200 saying the task was there.

**Repro** (code audit confirmed by an assertion-level test on `upstream/main` `e2afa3931`)

The new `TestSealedTaskWithCustomToolStaysWithTheRelayWhenCustomToolsAreOff` extends `TestSealedTaskGoesBackToTheRelayThatSealedIt`: one relay answers the lead and its subagent, the subagent's turn carries the existing `sealedHandoff` fixture plus Codex's `apply_patch` as a custom tool, and the relay is marked `customToolRefused` before the turn. Without the fix, the relay is sent a *translated* request whose `agent_message` holds only `"Message Type: NEW_TASK\nPayload:\n"` — no `encrypted_content` — with the custom tool turned into a function. `TestSealedTaskWithCustomToolRefusedNowIsNotTranslated` covers the fresh face: the relay answers 400 "Unsupported custom tool", and the translated retry that follows drops the body and answers 200.

**Root cause and fix**

`attempt` already keeps a native compaction out of every downgrade (`keep`, #1099). A sealed task (`from == Responses && hasSealedAgentMessage(body)`, the same predicate the web-search downgrade has exempted since #1109) now gets the same treatment:

- `if (keep || sealed) && relayable` puts the request back on the relay after any downgrade set it aside;
- after a mid-turn refusal, `if keep || sealed` returns the upstream's refusal to the client instead of translating.

A request whose provider does take the request as Codex sent it behaves exactly as before; the seal reaches the backend that can open it, and a genuine refusal of the custom tools is Codex's answer as the upstream said it — not a 200 with the task gone.

**Verification** (darwin, go1.x per go.mod, base `e2afa3931`, head `c632654a1ae28dca`)

| Check | Result |
| --- | --- |
| `go test ./internal/gateway -run TestSealedTask` | ok, 12 tests incl. the 2 new ones |
| New tests without the fix (base tree, tests kept) | both FAIL at the assertions above |
| Ablation: `(keep \|\| sealed) && relayable` → `keep` | `...StaysWithTheRelay...` FAIL: relay got the header-only translated request |
| Ablation: `keep \|\| sealed` → `keep` (post-refusal) | `...RefusedNow...` FAIL: client got 200, third (translated) request sent |
| Restored | ok |
| `go test ./internal/gateway` (full package) | ok 1002.7s, zero failures |
| `go test ./internal/gateway -run TestSealedTask -race -count=2` | ok |
| `gofmt`, `go vet` | clean |
| `GOOS=linux GOFLAGS=-tags=nogui go build ./...`, same for windows | ok |

**Siblings**: `rg -n "hasSealedAgentMessage"` → the web-search downgrade (already exempted, now shares the one computed predicate), the serve gate (`codex_subagent.go`, refuses unreadable providers before anyone is asked — untouched), the grok plugin's namespace guard (plugin-side, untouched), `gateway.go:2797` routing detection (untouched). `rg '"agent_message"'` in translators → `responses.go:429` (the one lossy reader, now never fed a sealed task), `itemText` (the compaction text-summary path, #5181/#5259, upstream's own), `zed_body.go` (carries the content parts whole, nothing dropped). Codex's own models reach the ChatGPT backend without `attempt` and go as they came, streamed or whole — not a face here.

**When the read fails**: `hasSealedAgentMessage` returns false for a body it can't read, so the request takes exactly its pre-patch path; nothing new is inferred from an unreadable body.

**Not verified**: a real ChatGPT-backend relay (Sub2API-style) and a real provider that refuses custom tools; the tests use the repository's fixtures against local fakes.

---
**Source**: reported in #5198 (code-audit report by KaranocaVe); the loss reproduced here is at the assertion level above.

**Red without the fix** (base `f6c882ad7`, the tree the fix grew on; rebased onto `e2afa3931` with zero drift in the four touched files, `git am` replays to the delivered tree byte for byte, new tests kept, product files reverted): both new tests fail as quoted in Repro. With the fix: `ok`.

**Siblings**: listed above.

**When the read fails**: listed above.

**Not verified**: real relay account, real custom-tool-refusing vendor.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

**Branch with the commit**: [hunt-20261112-t1-5198](https://github.com/ggbdpq/magpie/tree/hunt-20261112-t1-5198) (head `c632654a1ae28dca`).

**Patch**: <details><summary>patch: gateway: a sealed subagent task is never downgraded to a translation (#5198) — git am applies it as is; SHA-256 first 16: 2c2b1a11a00dd67a</summary>

```
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Thu, 12 Nov 2026 19:43:36 +0800
Subject: [PATCH] gateway: a sealed subagent task is never downgraded to a
 translation (#5198)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

A subagent's task its lead sealed goes to the provider that can open it
(sealedReader, #1109), but attempt's downgrades didn't know that: a
provider marked as having turned Codex's custom tools away had the
request translated from the start, and a refusal of the custom tools met
on the sealed turn itself translated on the fallback — and a translation
reads an agent_message's text and images alone, so the NEW_TASK header
went out and the task's sealed body stayed behind, with a 200 saying the
task was there.

A sealed task now goes with who can open it as it came, as a native
compaction does (#1099): every downgrade in attempt leaves it alone, and
the refusal met on the turn is the client's answer as the upstream said
it, not a 200 with the task gone.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/gateway.go                 | 16 +++-
 internal/gateway/sealed_agent_relay_test.go | 86 +++++++++++++++++++++
 2 files changed, 98 insertions(+), 4 deletions(-)

diff --git a/internal/gateway/gateway.go b/internal/gateway/gateway.go
index f14bf99a7..bf993c2ba 100644
--- a/internal/gateway/gateway.go
+++ b/internal/gateway/gateway.go
@@ -5650,6 +5650,13 @@ func (s *Server) attempt(w http.ResponseWriter, r *http.Request, from provider.P
 	// back whole (gathers)
 	relayable := slices.Contains(s.usable(p, model), from) && (p.Account == nil || !p.Account.Stream || streamOf(body) || gathers(p, from, body))
 	relay := relayable
+	// a subagent's task its lead sealed (#1109) is lost by a translation,
+	// as a native compaction is (#1099): responsesParts reads an
+	// agent_message's text and images alone, so the sealed body would be
+	// dropped and the NEW_TASK header asked alone. Every downgrade below
+	// leaves a sealed task with who can open it, as it came, or the request
+	// fails saying so
+	sealed := from == provider.Responses && hasSealedAgentMessage(body)
 	// a Claude model is asked on Messages whatever API the client spoke,
 	// for the cache breakpoints the translation adds: OpenCode speaks Chat
 	// for every model, and a relay drops cache_control on Chat, so every
@@ -5670,7 +5677,7 @@ func (s *Server) attempt(w http.ResponseWriter, r *http.Request, from provider.P
 	// apply_patch as a function, left web_search out and added
 	// max_output_tokens, the shape such a relay turns away (maralica on
 	// Discord). Its web_search goes to the relay as sent.
-	if relay && searchedForIt(r.Context(), p, from, model, body) && !(from == provider.Responses && (hasSealedAgentMessage(body) || codexAsSent(p, r.Header))) {
+	if relay && searchedForIt(r.Context(), p, from, model, body) && !(sealed || codexAsSent(p, r.Header)) {
 		relay, ownAPI = false, true
 	}
 	// Copilot seals an argument the tools mark "encrypted" (spawn_agent's
@@ -5743,7 +5750,7 @@ func (s *Server) attempt(w http.ResponseWriter, r *http.Request, from provider.P
 	if relay && !keep && streamOnly {
 		relay, ownAPI = false, true
 	}
-	if keep && relayable {
+	if (keep || sealed) && relayable {
 		relay, ownAPI = true, false
 	}
 	if relay {
@@ -5762,9 +5769,10 @@ func (s *Server) attempt(w http.ResponseWriter, r *http.Request, from provider.P
 		}
 		// the model isn't served on the client's own API: speak another;
 		// or it turned the custom tools away just now: speak it translated,
-		// except a compaction, which a translation would leave out
+		// except a compaction or a sealed subagent task, which a
+		// translation would leave out
 		if customOff() || !s.fits(p.ID, streamOnlyRefused(model), from) && !streamOf(body) {
-			if keep {
+			if keep || sealed {
 				return writeError(w, from, status, msg), msg
 			}
 			ownAPI = true
diff --git a/internal/gateway/sealed_agent_relay_test.go b/internal/gateway/sealed_agent_relay_test.go
index 687ae3805..e8a6c7913 100644
--- a/internal/gateway/sealed_agent_relay_test.go
+++ b/internal/gateway/sealed_agent_relay_test.go
@@ -1,6 +1,7 @@
 package gateway
 
 import (
+	"bytes"
 	"io"
 	"net/http"
 	"net/http/httptest"
@@ -64,6 +65,26 @@ func codexSubTurn(s *Server, model, session, parent, input string) *httptest.Res
 
 const leadAsk = `{"type":"message","role":"user","content":[{"type":"input_text","text":"spawn a worker"}]}`
 
+// subTools is Codex's tools on a subagent's turn: the web_search Codex
+// offers on every turn, plus apply_patch, which Codex offers as a custom
+// tool (#5198).
+const subTools = `[{"type":"web_search","external_web_access":true},{"type":"custom","name":"apply_patch","description":"Edit files"}]`
+
+// codexSubTurnTools is codexSubTurn with another set of tools.
+func codexSubTurnTools(s *Server, model, session, parent, input, tools string) *httptest.ResponseRecorder {
+	rec := httptest.NewRecorder()
+	body := `{"model":"` + model + `","stream":true,"tools":` + tools + `,"input":[` + input + `]}`
+	req := httptest.NewRequest("POST", CodexPath+"/responses", strings.NewReader(body))
+	req.Header.Set("Authorization", "Bearer chatgpt-token")
+	req.Header.Set("chatgpt-account-id", "acct-1")
+	req.Header.Set("session_id", session)
+	if parent != "" {
+		req.Header.Set("x-codex-parent-thread-id", parent)
+	}
+	s.Handler().ServeHTTP(rec, req)
+	return rec
+}
+
 // #1109: Codex on Ultra with s2a/gpt-6-astra for both the lead and its
 // subagent, s2a a Sub2API relay of the ChatGPT backend. The task the lead's
 // spawn_agent got sealed goes back to s2a, which sealed it, as it came —
@@ -110,6 +131,71 @@ func TestSealedTaskRefusedByAnotherRelay(t *testing.T) {
 	}
 }
 
+// #5198: the relay that sealed a subagent's task, marked as having turned
+// Codex's custom tools away before, is still sent the task as it came: the
+// downgrade to a translation reads an agent_message's text and images
+// alone, which would keep the NEW_TASK header and drop the sealed body,
+// and the request would come back 200 with the task gone.
+func TestSealedTaskWithCustomToolStaysWithTheRelayWhenCustomToolsAreOff(t *testing.T) {
+	fresh(t)
+	s2a := relayOn(t, "s2a")
+	s := New()
+	if rec := codexSubTurn(s, "s2a/gpt-6-astra", "lead-1", "", leadAsk); rec.Code != 200 {
+		t.Fatalf("lead: %d %s", rec.Code, rec.Body.String())
+	}
+	s.markUnfit("s2a", customToolRefused("gpt-6-astra"), provider.Responses)
+	rec := codexSubTurnTools(s, "s2a/gpt-6-astra", "worker-1", "lead-1", sealedHandoff, subTools)
+	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "on it") {
+		t.Fatalf("subagent: %d %s", rec.Code, rec.Body.String())
+	}
+	got := s2a.requests()
+	if len(got) != 2 || !strings.Contains(got[1], `"encrypted_content":"gAAAAATest_ciphertext=="`) || !strings.Contains(got[1], `"agent_message"`) {
+		t.Fatalf("s2a was sent %d requests; the subagent's: %v", len(got), got[len(got)-1:])
+	}
+}
+
+// #5198: a refusal of the custom tools met on the sealed turn itself is
+// the client's answer, the upstream's words as they came: the translated
+// retry would drop the sealed body and answer 200 with the task gone, so
+// the request is never translated.
+func TestSealedTaskWithCustomToolRefusedNowIsNotTranslated(t *testing.T) {
+	fresh(t)
+	var mu sync.Mutex
+	var got []string
+	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		b, _ := io.ReadAll(r.Body)
+		mu.Lock()
+		got = append(got, string(b))
+		mu.Unlock()
+		if bytes.Contains(b, []byte(`"type":"custom"`)) {
+			w.Header().Set("Content-Type", "application/json")
+			w.WriteHeader(http.StatusBadRequest)
+			io.WriteString(w, `{"error":{"message":"Unsupported custom tool: 'apply_patch'","type":"invalid_request_error","param":"tools","code":"unsupported_parameter"}}`)
+			return
+		}
+		w.Header().Set("Content-Type", "text/event-stream")
+		io.WriteString(w, sse(`data: {"type":"response.output_text.delta","delta":"on it"}`,
+			`data: {"type":"response.completed","response":{"id":"r1","status":"completed","output":[]}}`))
+	}))
+	t.Cleanup(up.Close)
+	if err := provider.Save(provider.Provider{ID: "s2a", Name: "S2A", Key: "sk-s2a", Models: []string{"gpt-6-astra"}, Responses: up.URL + "/v1"}); err != nil {
+		t.Fatal(err)
+	}
+	s := New()
+	if rec := codexSubTurn(s, "s2a/gpt-6-astra", "lead-1", "", leadAsk); rec.Code != 200 {
+		t.Fatalf("lead: %d %s", rec.Code, rec.Body.String())
+	}
+	rec := codexSubTurnTools(s, "s2a/gpt-6-astra", "worker-1", "lead-1", sealedHandoff, subTools)
+	if rec.Code != 400 || !strings.Contains(rec.Body.String(), "Unsupported custom tool") {
+		t.Fatalf("subagent: %d %s", rec.Code, rec.Body.String())
+	}
+	mu.Lock()
+	defer mu.Unlock()
+	if len(got) != 2 || !strings.Contains(got[1], `"encrypted_content":"gAAAAATest_ciphertext=="`) {
+		t.Fatalf("the relay was sent %d requests; the subagent's: %v", len(got), got[len(got)-1:])
+	}
+}
+
 // sealedReply is what Codex hands a lead when its subagent answers it with
 // send_message: an agent_message to /root whose payload the subagent's
 // server sealed, as the task the lead sent it was.
-- 
2.50.1 (Apple Git-155)


```

</details>
