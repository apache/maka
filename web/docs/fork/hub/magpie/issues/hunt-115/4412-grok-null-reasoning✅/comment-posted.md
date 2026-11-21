Picked this up. The diagnosis held all the way through, and the narrow fix (proposal 2) is what I've patched: `foreignReasoning` — the word list behind the asked-again-without-it machinery — now also matches xAI's compaction-blob refusal, so the turn is retried once without the sealed reasoning, the refusal is remembered (`refusedSeals`), and later turns leave that seal out up front instead of 400ing every turn.

## Summary

- The three gates in the report are exactly right: `grokBody` needs an `Account` (a key relay has none), `xaiBody` is host-gated to `api.x.ai` (#3392's stated boundary), and `foreignReasoning`'s four alternatives all hinge on "encrypted content" wording the compaction-blob refusal never says.
- One regex alternative — `could not (decode|decrypt).{0,20}compaction[ _]blob` — closes it at the shared root: the refusal classification. That turns the 400 into strip-and-retry on the same member (`withoutReasoning`), records the refused seal so the next turn doesn't hit it again, and helps every Responses client, not only Codex. It does not require knowing that the relay proxies Grok, which is why I left proposal 1 (a per-provider "upstream is Grok" declaration) to you — it remains the generalizing fix for the proactive shaping (`xaiBody`'s three) on relays.
- Verified the fallback semantics are untouched: the strip-and-retry happens in the routing loop before failure classification would end the turn, so no change to `retryable`'s word lists was needed.

## What changed

- `internal/gateway/affinity.go`: one alternative on `foreignReasoning`, and the comment names the fifth wording.
- `internal/gateway/foreign_seal_test.go`: `TestForeignSealGrokRelayCompactionBlob` (a relay-like upstream refuses the null-content-beside-a-blob item with the verbatim #4412 answer, asserts the seal went once then not at all, and that the next turn leaves it out up front) and two new matched cases plus one negative in `TestForeignReasoningWords`.

## Run

| Check | Result |
|---|---|
| `go test ./internal/gateway/ -run 'TestForeignSealGrokRelayCompactionBlob\|TestForeignReasoningWords' -tags nogui` | RED on the parent (both fail: wording not matched, client gets the 400 after one try), GREEN here |
| Ablation: revert `internal/gateway/affinity.go` alone to the branch parent, tests kept | both tests red again, restored, green |
| `go test ./internal/gateway/ -tags nogui` (full package) | ok (536s) |
| `gofmt -l` on both changed files | clean |
| `go vet -tags nogui ./internal/gateway/` — darwin/arm64, linux/amd64, windows/amd64 | clean |
| `go build -tags nogui` — linux/amd64, windows/amd64, darwin/arm64 | ok (the darwin CGO warnings in internal/gui are pre-existing) |

## Not verified

- Against a real `opencode-go`-style relay: the tests use the verbatim refusal body from the report, but no live Grok relay was exercised.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: fix(gateway): a Grok key relay's compaction-blob refusal now strips the sealed reasoning and asks again (#4412) — git am applies it as is; SHA-256 first 16: 514429097a8dcd18</summary>

```patch
From daa84ce581f9e1cdd84362187afe885143cc34fc Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sun, 1 Nov 2026 21:09:34 +0800
Subject: [PATCH] fix(gateway): a Grok key relay's compaction-blob refusal now
 strips the sealed reasoning and asks again (#4412)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

What changed: foreignReasoning — the words that mark a vendor's refusal
of sealed reasoning it cannot read, and put the conversation on the
asked-again-without-it path (strip, retry, and the seal left out of
later turns up front) — gains one alternative for xAI's "Could not
decode the compaction blob. Ensure it is unmodified from the compact
response." A key relay that proxies Grok (an opencode-go-style member,
no account, any base URL) hands back exactly that for the reasoning
item Codex writes with "content": null beside its encrypted_content,
and until now the 400 went to the client after a single try: the
#3392 shaping (xaiBody's null-content removal) never runs on such a
relay because its host is not api.x.ai, and the refusal named no item
and nothing of encrypted content, so foreignReasoning passed it by.
The wording anchors on "could not decode/decrypt ... compaction blob",
so a refusal at fault some other way still is not taken for one.

Run: go test ./internal/gateway/ -run 'TestForeignSealGrokRelayCompactionBlob|TestForeignReasoningWords' -tags nogui (both fail on the parent, pass here; the ablation — reverting internal/gateway/affinity.go alone — turns both red again); go test ./internal/gateway/ -tags nogui; gofmt clean on both files; go vet -tags nogui on internal/gateway for darwin, linux and windows; go build -tags nogui for all three.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/affinity.go          |  10 ++-
 internal/gateway/foreign_seal_test.go | 121 +++++++++++++++++++++++++-
 2 files changed, 128 insertions(+), 3 deletions(-)

diff --git a/internal/gateway/affinity.go b/internal/gateway/affinity.go
index d26b2dea1..d3bdc2639 100644
--- a/internal/gateway/affinity.go
+++ b/internal/gateway/affinity.go
@@ -1027,8 +1027,14 @@ func unanswered(key string, c candidate) {
 // provided encrypted_content. Ensure the value is the unmodified
 // encrypted_content from a previous response."; Azure's (through a relay
 // in front of a deployment, snowshadow) "invalid encrypted summary",
-// which names no item and spells it with spaces.
-var foreignReasoning = regexp.MustCompile(`(?i)invalid_encrypted_content|invalid[ _]encrypted[ _](summary|content)|encrypted[ _]content.{0,80}could not be (verified|decrypted)|could not (decrypt|verify).{0,40}encrypted[ _]content`)
+// which names no item and spells it with spaces; xAI's compaction-blob
+// refusal, as a key relay that proxies Grok hands it back for the
+// reasoning item Codex writes with "content": null beside its
+// encrypted_content (zminds #4412) — "Could not decode the compaction
+// blob", which names no item and says nothing of encrypted content,
+// where the #3392 shaping (xaiBody's) never runs because the relay's
+// host isn't api.x.ai.
+var foreignReasoning = regexp.MustCompile(`(?i)invalid_encrypted_content|invalid[ _]encrypted[ _](summary|content)|encrypted[ _]content.{0,80}could not be (verified|decrypted)|could not (decrypt|verify).{0,40}encrypted[ _]content|could not (decode|decrypt).{0,20}compaction[ _]blob`)
 
 // refusedSeals remembers, per conversation and the key or account that
 // refused it, the sealed reasoning another one wrote. Codex hands every
diff --git a/internal/gateway/foreign_seal_test.go b/internal/gateway/foreign_seal_test.go
index 10c7dcdf4..3aca858d9 100644
--- a/internal/gateway/foreign_seal_test.go
+++ b/internal/gateway/foreign_seal_test.go
@@ -172,12 +172,14 @@ func TestForeignReasoningWords(t *testing.T) {
 		`{"error":{"message":"The encrypted content for item rs_1 could not be verified.","code":"invalid_encrypted_content"}}`,
 		"Grok (SuperGrok): Could not decrypt the provided encrypted_content.",
 		`{"error":{"message":"invalid encrypted summary","type":"invalid_request_error","param":null,"code":"validation_error"}}`,
+		relayCompaction,
+		"Could not decode the compaction blob. Ensure it is unmodified from the compact response.",
 	} {
 		if !foreignReasoning.MatchString(m) {
 			t.Errorf("not matched: %s", m)
 		}
 	}
-	for _, m := range []string{"Invalid value for reasoning.effort", "model not found", "could not parse the JSON body"} {
+	for _, m := range []string{"Invalid value for reasoning.effort", "model not found", "could not parse the JSON body", "Could not decode the request body."} {
 		if foreignReasoning.MatchString(m) {
 			t.Errorf("matched: %s", m)
 		}
@@ -334,6 +336,67 @@ func TestForeignSealGrokToCodexAccount(t *testing.T) {
 // no item.
 const azureSummary = `{"error":{"message":"invalid encrypted summary","type":"invalid_request_error","param":null,"code":"validation_error"}}`
 
+// relayCompaction is what a key relay that proxies Grok passes back for
+// the reasoning item Codex hands it with "content": null beside its
+// encrypted_content (zminds #4412): xAI's own compaction-blob refusal,
+// spelled by the relay in front of it. It names no item and says nothing
+// of encrypted content at all.
+const relayCompaction = `{"error":{"code":null,"message":"OpenCode Go: Could not decode the compaction blob. Ensure it is unmodified from the compact response.","param":null,"type":"invalid_request_error"}}`
+
+// grokRelay is a relay-like Responses upstream that proxies Grok: a null
+// content beside a sealed blob it refuses with the compaction-blob words
+// (a null beside no blob goes by — the issue counted 99 such items pass),
+// everything else it answers.
+type grokRelay struct {
+	mu  sync.Mutex
+	got [][]string // the sealed reasoning each request carried
+}
+
+func (g *grokRelay) ServeHTTP(w http.ResponseWriter, r *http.Request) {
+	b, _ := io.ReadAll(r.Body)
+	var q struct {
+		Input []struct {
+			Type    string          `json:"type"`
+			Content json.RawMessage `json:"content"`
+			Enc     string          `json:"encrypted_content"`
+		} `json:"input"`
+	}
+	json.Unmarshal(b, &q)
+	var got []string
+	refused := false
+	for _, it := range q.Input {
+		if it.Type != "reasoning" {
+			continue
+		}
+		if it.Enc != "" {
+			got = append(got, it.Enc)
+			refused = refused || strings.TrimSpace(string(it.Content)) == "null"
+		}
+	}
+	g.mu.Lock()
+	g.got = append(g.got, got)
+	g.mu.Unlock()
+	if refused {
+		w.Header().Set("Content-Type", "application/json")
+		w.WriteHeader(400)
+		io.WriteString(w, relayCompaction)
+		return
+	}
+	w.Header().Set("Content-Type", "text/event-stream")
+	io.WriteString(w, sse(
+		`data: {"type":"response.created","response":{"id":"r1","model":"grok-4.7"}}`,
+		`data: {"type":"response.output_text.delta","delta":"from relay"}`,
+		`data: {"type":"response.completed","response":{"id":"r1","usage":{"input_tokens":7,"output_tokens":1}}}`))
+}
+
+func (g *grokRelay) sent() [][]string {
+	g.mu.Lock()
+	defer g.mu.Unlock()
+	out := g.got
+	g.got = nil
+	return out
+}
+
 // A Codex thread the ChatGPT backend served, resumed on a relay in front
 // of an Azure deployment (snowshadow): the deployment can't read the
 // reasoning the ChatGPT backend sealed and refuses it as "invalid
@@ -384,3 +447,59 @@ func TestForeignSealAzureSummary(t *testing.T) {
 		t.Fatalf("next turn sent %q, want one request without the seal", got)
 	}
 }
+
+// A Codex conversation that reaches a key relay that proxies Grok
+// (zminds #4412): the relay is not api.x.ai, so the #3392 shaping
+// (xaiBody's null-content removal) never runs on its requests, and the
+// reasoning item Codex hands back — "content": null beside its
+// encrypted_content — comes out as xAI's "Could not decode the
+// compaction blob", a 400 that names no item and no encrypted content.
+// It's asked again without the reasoning, and the next turn leaves the
+// seal out up front, instead of 400ing on every turn with nothing
+// retrying.
+func TestForeignSealGrokRelayCompactionBlob(t *testing.T) {
+	fresh(t)
+	refusedSeals.Lock()
+	refusedSeals.m = map[string]sealsRefused{}
+	refusedSeals.Unlock()
+	rel := &grokRelay{}
+	up := httptest.NewServer(rel)
+	t.Cleanup(up.Close)
+	if err := provider.Save(provider.Provider{ID: "relay1", Name: "OpenCode Go", Key: "k", Models: []string{"grok-4.7"}, Responses: up.URL + "/v1"}); err != nil {
+		t.Fatal(err)
+	}
+	s := New()
+	turn := func(items ...string) (int, string) {
+		t.Helper()
+		in := `{"type":"message","role":"user","content":[{"type":"input_text","text":"count the lines"}]}`
+		for _, it := range items {
+			in += "," + it
+		}
+		rec := httptest.NewRecorder()
+		req := httptest.NewRequest("POST", "/v1/responses", strings.NewReader(`{"model":"relay1/grok-4.7","stream":true,"input":[`+in+`]}`))
+		req.Header.Set("session_id", "thread-relay")
+		s.Handler().ServeHTTP(rec, req)
+		return rec.Code, rec.Body.String()
+	}
+	// Codex's shape: the null content beside the seal (#4412's input[681])
+	sealed := `{"type":"reasoning","id":"rs_1","summary":[],"content":null,"encrypted_content":"gAABsealed"}`
+	call := func(id string) string {
+		return `{"type":"function_call","call_id":"` + id + `","name":"shell","arguments":"{}"},{"type":"function_call_output","call_id":"` + id + `","output":"ok"}`
+	}
+
+	// the relay refuses the null content beside the blob, and it's asked
+	// again without the reasoning
+	if code, body := turn(sealed, call("c1")); code != 200 || !strings.Contains(body, "from relay") {
+		t.Fatalf("first: %d %s", code, body)
+	}
+	if got := rel.sent(); len(got) != 2 || len(got[0]) != 1 || len(got[1]) != 0 {
+		t.Fatalf("first turn sent %q, want the seal once, then none", got)
+	}
+	// the next turn doesn't hit it again: the seal is left out up front
+	if code, body := turn(sealed, call("c1")); code != 200 || !strings.Contains(body, "from relay") {
+		t.Fatalf("next turn: %d %s", code, body)
+	}
+	if got := rel.sent(); len(got) != 1 || len(got[0]) != 0 {
+		t.Fatalf("next turn sent %q, want one request without the seal", got)
+	}
+}
-- 
2.50.1 (Apple Git-155)

```

</details>

Branch with the commit: [fix/4412-grok-null-reasoning](https://github.com/ggbdpq/magpie/tree/fix/4412-grok-null-reasoning) (head `daa84ce581f9e1cdd84362187afe885143cc34fc`).
