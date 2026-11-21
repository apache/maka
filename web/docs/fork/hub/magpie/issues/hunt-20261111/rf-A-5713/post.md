Refresh of the rebase I posted above (2026-11-10, onto `7e5cebb86`), itself a refresh of the patch — same commit, one more carry onto current `upstream/main` (`0781d2214`), zero conflicts, verification re-run. `searchRoundsBack` and its callers are unchanged on main in the meantime; a chat upstream still reads none of a search whose items were dropped, so the face stands as reported.

Unchanged, as delivered: a `web_search_call` a client sends back — with no Claude signature, so it is not a magpie search — keeps its query and the pages it found as text on a chat upstream (`searchSaid`: "Searched the web for: … / Pages found:"), instead of being silently deleted; nothing is made up (no call invented for a result that was never kept), and a search beside Claude thinking goes back as written as before.

<details><summary>patch: gateway: a web search a client sends back keeps its query and the pages it found on a chat upstream (#5713) — git am applies it as is; SHA-256 first 16: 3115fc485754f5e8</summary>

```text
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Mon, 9 Nov 2026 06:06:05 +0800
Subject: [PATCH] gateway: a web search a client sends back keeps its query and
 the pages it found on a chat upstream (#5713)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

Codex keeps the searches of its turns as web_search_call items and
sends them back with the next request. magpie parsed the query and
the pages found, then dropped them again: only a search beside
Claude's signed thinking went back (searchRoundsBack), and one with
none beside it was taken out of the messages, so a Chat upstream
read nothing of what had been searched and the model asked the same
things again, telling the user it had to double-check (wudilyy999,
0.1.3327).

Such a search now goes as text: the query it asked and the pages it
was found on, which is what the client kept of it. No call is made
up for it, as no result of its own is kept to answer one, and what
the pages said was never kept, so none is written. The round beside
Claude's signed thinking is put back as it was, and a request with
no search in it is untouched.

Attribution: 分析与补丁由 GLM-5.3-Flash (ZCode) 协助完成
Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/claude_search_round_test.go | 93 ++++++++++++++++++--
 internal/gateway/responses.go                | 41 ++++++---
 internal/gateway/responses_search_test.go    |  4 +-
 3 files changed, 120 insertions(+), 18 deletions(-)

diff --git a/internal/gateway/claude_search_round_test.go b/internal/gateway/claude_search_round_test.go
index 835b76115..480e353b7 100644
--- a/internal/gateway/claude_search_round_test.go
+++ b/internal/gateway/claude_search_round_test.go
@@ -2,6 +2,7 @@ package gateway
 
 import (
 	"encoding/json"
+	"fmt"
 	"io"
 	"net/http"
 	"net/http/httptest"
@@ -213,18 +214,20 @@ func TestClaudeThinkingAroundMagpieSearchGoesBackAsWritten(t *testing.T) {
 }
 
 // A search beside no thinking of Claude's (another model's turn, a reply
-// without signed thinking) is left out, as before: no call is made up for
-// it.
-func TestSearchWithoutClaudeThinkingStaysOut(t *testing.T) {
+// without signed thinking) keeps the query it asked and the pages it
+// found, as the client sent them (#5713), as text: no call is made up for
+// it that no result would answer, and what the pages said was never kept,
+// so none is written.
+func TestSearchWithoutClaudeThinkingGoesBackAsText(t *testing.T) {
 	body := `{"model":"m","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"q"}]},` +
 		`{"type":"reasoning","summary":[{"type":"summary_text","text":"thought"}]},` +
-		`{"type":"web_search_call","id":"ws_1","status":"completed","action":{"type":"search","query":"latest go"}},` +
+		`{"type":"web_search_call","id":"ws_1","status":"completed","action":{"type":"search","query":"latest go","sources":[{"type":"url","url":"https://go.dev/doc/devel/release"}]}},` +
 		`{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Go 1.27.1."}]}]}`
 	r, err := parseResponses([]byte(body))
 	if err != nil {
 		t.Fatal(err)
 	}
-	if len(r.Messages) != 2 || r.Messages[1].Role != "assistant" || len(r.Messages[1].Parts) != 2 {
+	if len(r.Messages) != 2 || r.Messages[1].Role != "assistant" || len(r.Messages[1].Parts) != 3 {
 		t.Fatalf("messages %+v", r.Messages)
 	}
 	for _, p := range r.Messages[1].Parts {
@@ -232,4 +235,84 @@ func TestSearchWithoutClaudeThinkingStaysOut(t *testing.T) {
 			t.Fatalf("made up %+v", p)
 		}
 	}
+	if said := text(r.Messages[1].Parts); !strings.Contains(said, "Searched the web for: latest go") || !strings.Contains(said, "https://go.dev/doc/devel/release") {
+		t.Fatalf("the query or the pages it found were lost: %q", said)
+	}
+}
+
+// A client's search history reaches a Chat upstream (#5713, wudilyy999):
+// Codex sends the searches of its turns back as web_search_call items, a
+// provider on Chat read none of them, and the model searched the same
+// things again and again. The query and the pages found go as text, the
+// function calls and their outputs keep their pairing, and no search call
+// is made up that no result would answer.
+func TestSearchHistoryReachesAChatUpstream(t *testing.T) {
+	f := &fake{t: t, reply: sse(
+		`data: {"id":"c1","model":"m1","choices":[{"delta":{"role":"assistant","content":"done"}}]}`,
+		`data: {"id":"c1","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}`)}
+	setup(t, provider.Chat, f)
+	body := `{"model":"fake/m1","stream":true,"tools":[{"type":"function","name":"noop","parameters":{"type":"object","properties":{}}}],"input":[` +
+		`{"type":"message","role":"user","content":"Find the evidence and use the tool."},` +
+		`{"type":"web_search_call","id":"ws_diag","status":"completed","action":{"type":"search","query":"UNIQUE_SEARCH_QUERY_X718","sources":[{"type":"url","url":"https://example.invalid/UNIQUE_SEARCH_RESULT_X718"}]}},` +
+		`{"type":"function_call","id":"fc_diag","call_id":"call_diag","name":"noop","arguments":"{}"},` +
+		`{"type":"function_call_output","call_id":"call_diag","output":"UNIQUE_TOOL_RESULT_X718"},` +
+		`{"type":"message","role":"user","content":"Continue with the evidence already found."}]}`
+	if code, body := post(t, "/v1/responses", body); code != 200 || !strings.Contains(body, "response.completed") {
+		t.Fatalf("status %d: %s", code, body)
+	}
+	var q struct {
+		Messages []struct {
+			Role      string `json:"role"`
+			Content   any    `json:"content"`
+			ToolCalls []struct {
+				ID       string `json:"id"`
+				Function struct {
+					Name      string `json:"name"`
+					Arguments string `json:"arguments"`
+				} `json:"function"`
+			} `json:"tool_calls"`
+			ToolCallID string `json:"tool_call_id"`
+		} `json:"messages"`
+	}
+	if err := json.Unmarshal(f.got, &q); err != nil {
+		t.Fatalf("%v: %s", err, f.got)
+	}
+	said := ""
+	calls, answered := 0, map[string]bool{}
+	for _, m := range q.Messages {
+		switch c := m.Content.(type) {
+		case string:
+			said += c
+		case []any:
+			for _, p := range c {
+				if o, ok := p.(map[string]any); ok {
+					said += fmt.Sprint(o["text"])
+				}
+			}
+		}
+		for _, c := range m.ToolCalls {
+			calls++
+			answered[c.ID] = false
+			if c.Function.Name != "noop" || c.Function.Arguments != "{}" {
+				t.Fatalf("made up a call for the search: %+v", c)
+			}
+		}
+		if m.ToolCallID != "" {
+			answered[m.ToolCallID] = true
+		}
+		if !strings.Contains(string(f.got), "UNIQUE_TOOL_RESULT_X718") {
+			t.Fatalf("the tool's output was lost: %s", f.got)
+		}
+	}
+	for id, ok := range answered {
+		if !ok {
+			t.Fatalf("the call %s has no result to answer it: %s", id, f.got)
+		}
+	}
+	if calls != 1 {
+		t.Fatalf("made %d calls, want the one the client sent: %s", calls, f.got)
+	}
+	if !strings.Contains(said, "UNIQUE_SEARCH_QUERY_X718") || !strings.Contains(said, "https://example.invalid/UNIQUE_SEARCH_RESULT_X718") {
+		t.Fatalf("the search's query or the pages it found never reached the chat upstream: %q\n%s", said, f.got)
+	}
 }
diff --git a/internal/gateway/responses.go b/internal/gateway/responses.go
index 13b0849d7..3ffc927f6 100644
--- a/internal/gateway/responses.go
+++ b/internal/gateway/responses.go
@@ -634,7 +634,11 @@ func readResponsesFor(body []byte, facts, keepInstructions bool) (*Request, erro
 // stream gave up (oreoft on Discord). An assistant message with Claude's
 // signed thinking is split at each search into the call and its result,
 // the query and the pages found, as what the search said was never kept.
-// A search with no Claude thinking beside it is left out, as before.
+// A search with no Claude thinking beside it goes as text (#5713): the
+// query and the pages found are what the client kept of it, and a chat
+// upstream read none of them while they were dropped, so the model went
+// without and searched the same things again. No call is made up for it,
+// as no result of its own is kept to answer one.
 func searchRoundsBack(msgs []Message, name string) []Message {
 	if !slices.ContainsFunc(msgs, func(m Message) bool { return slices.ContainsFunc(m.Parts, isSearch) }) {
 		return msgs
@@ -647,10 +651,16 @@ func searchRoundsBack(msgs []Message, name string) []Message {
 			continue
 		}
 		if m.Role != "assistant" || !slices.ContainsFunc(m.Parts, claudeSigned) {
-			m.Parts = slices.DeleteFunc(slices.Clone(m.Parts), isSearch)
-			if len(m.Parts) > 0 {
-				out = append(out, m)
+			parts := make([]Part, 0, len(m.Parts))
+			for _, p := range m.Parts {
+				if isSearch(p) {
+					parts = append(parts, Part{Kind: Text, Text: searchSaid(p) + "\n\n"})
+					continue
+				}
+				parts = append(parts, p)
 			}
+			m.Parts = parts
+			out = append(out, m)
 			continue
 		}
 		var cur []Part
@@ -665,16 +675,9 @@ func searchRoundsBack(msgs []Message, name string) []Message {
 				id = fmt.Sprintf("call_search_back_%d", n)
 			}
 			args, _ := json.Marshal(map[string]string{"query": p.Text})
-			result := "Searched the web for: " + p.Text
-			if len(p.Hits) > 0 {
-				result += "\nPages found:"
-				for _, h := range p.Hits {
-					result += "\n- " + h.URL
-				}
-			}
 			cur = append(cur, Part{Kind: ToolCall, ID: id, Name: name, Args: args})
 			out = append(out, Message{Role: "assistant", Parts: cur},
-				Message{Role: "user", Parts: []Part{{Kind: ToolResult, CallID: id, Text: result}}})
+				Message{Role: "user", Parts: []Part{{Kind: ToolResult, CallID: id, Text: searchSaid(p)}}})
 			cur = nil
 		}
 		if len(cur) > 0 {
@@ -684,6 +687,20 @@ func searchRoundsBack(msgs []Message, name string) []Message {
 	return mergeTurns(out)
 }
 
+// searchSaid is what a search said as it went: the query it asked and the
+// pages it was found on. What the pages said was never kept, and none is
+// made up.
+func searchSaid(p Part) string {
+	said := "Searched the web for: " + p.Text
+	if len(p.Hits) > 0 {
+		said += "\nPages found:"
+		for _, h := range p.Hits {
+			said += "\n- " + h.URL
+		}
+	}
+	return said
+}
+
 func isSearch(p Part) bool { return p.Kind == Search }
 
 // claudeSigned is thinking Claude signed, or its redacted_thinking.
diff --git a/internal/gateway/responses_search_test.go b/internal/gateway/responses_search_test.go
index b45e5b03e..449f958d7 100644
--- a/internal/gateway/responses_search_test.go
+++ b/internal/gateway/responses_search_test.go
@@ -258,7 +258,9 @@ func TestResponsesSearchItemReplayed(t *testing.T) {
 	for _, m := range req.Messages {
 		said = append(said, m.Role+":"+text(m.Parts))
 	}
-	if !reflect.DeepEqual(said, []string{"user:Search the web", "assistant:Found it.", "user:Thanks"}) {
+	if !reflect.DeepEqual(said, []string{"user:Search the web",
+		"assistant:Searched the web for: nerdctl CDI\nPages found:\n- https://github.com/containerd/nerdctl/releases\n\nFound it.",
+		"user:Thanks"}) {
 		t.Fatalf("turn changed by a replayed search item: %q", said)
 	}
 }
-- 
2.50.1 (Apple Git-155)

```

</details>

**Branch with the commit**: [`hunt-20261111-rf-5713`](https://github.com/ggbdpq/magpie/tree/hunt-20261111-rf-5713) (head `f10d07eea1d07da3d00aa4fb99c7c470695857d3`), rebased onto current `upstream/main` (`0781d2214`); on a fresh checkout at that tip `git am` applies it as is (replayed on a detached worktree, resulting tree identical to the branch head, checked by tree hash).

Verification this round (on `0781d2214` + this commit, `GOCACHE` pinned):

| Check | Result |
| --- | --- |
| `go test -tags nogui ./internal/gateway -run 'Search\|WebSearch'` (the search family whole: `TestSearchHistoryReachesAChatUpstream` new, `TestResponsesSearchResults`/`DecodedResults`/`FollowedByFailure`/`NotInvented`/`ItemReplayed`, the Claude-round tests) | ok (10.6s), zero failures |
| Ablation: the search-as-text round dropped (the item deleted as main does, build intact) | red: `TestSearchHistoryReachesAChatUpstream`; restored: green |
| `gofmt -l` on the three touched files | prints nothing |
| `go vet -tags nogui ./internal/gateway/` | clean |
| `go build -tags nogui ./...` darwin / `GOOS=linux` | clean |

**Siblings** (re-checked): `searchRoundsBack` is the one seam — the Claude-thinking path (`TestClaudeThinkingAroundMagpieSearchGoesBackAsWritten`, `TestSearchWithoutClaudeThinkingGoesBackAsText`) and the magpie-own-search result round (which already went as a `ToolResult`) are the other faces, both held by their tests; Codex's own `tool_search_call` items and the native-search rewrite (`2df46e3c8`'s, magpie's own searches) are different namespaces, untouched.

**Not verified**: a real client replaying `web_search_call` items against a real chat upstream (the tests shape the items as the Responses protocol gives them); the model's repeat-search behavior on a live provider.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.
