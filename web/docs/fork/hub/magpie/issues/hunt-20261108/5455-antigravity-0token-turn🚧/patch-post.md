@yetone @JZongf reported on v0.1.3101 that an antigravity/gemini-4-argon turn whose last message is a tool's result the model has nothing to say after (right after an MCP wait/acknowledgement, or at the end of a subagent run) dies as a deterministic 0-token reply: Code Assist sends one ~487-byte chunk and closes the stream, magpie reads that as a transport failure, resends the full ~210–250 KB prompt 5–6 times per HTTP request, and answers Claude Code with a 502 that it retries nine more times on its own — some sixty identical upstream calls, 12–15 MB uploaded, and the session hung for ~25 minutes, every single time.

**Root cause**: the silent chunk carries a candidate with a role and no parts, usageMetadata counting no output token, and no `finishReason` (`internal/gateway/continuation.go:92`, old code). `geminiEnds` early-returned "not an end" for any chunk that has `"candidates"` but no `"finishReason"` anywhere, so the clean close read as `errEndedShort` ("the reply ended before it was complete"). That is a transport failure: `transportFailed` (`internal/gateway/fallback.go:2020`) matches its words, `passing` re-asks the last account left twice more, and the request hands on to other accounts — the reporter's `tries: 6` — instead of the empty-reply path, whose budget is bounded and whose error says what actually happened (`#667`, `#1221`).

**The fix**: a candidate that says nothing and names no end is the same silence a reply with no candidate at all already is (`#667`): `geminiEnds` now ends the reply on a chunk whose candidates carry no parts and no finishReason (`{"candidates":[{"content":{"role":"model"}}]}`, `{"candidates":[{}]}`, including Code Assist's `{response:…}` wrap), so the reply lands in the empty-reply branch — one in-place re-ask while the stream is still held, then `"<provider>: an empty reply (the model answered nothing; try again)"`, asked of the next account, resting none. `"candidates":[]` without a finishReason, which the old early return also mislabeled a cut, is the same nothing. A candidate with parts is untouched: a stream that stops before its finishReason is still a cut (`#1643`), and a reply that said something before its silent candidate still goes as it came. The reporter's suggested turn-completion (answering a silent post-tool turn with a clean `end_turn`) isn't taken — `#667`'s canon deliberately makes a Gemini empty an error so the agent asks again; changing that is this project owner's call.

<details><summary>patch: gateway: a Gemini candidate that says nothing and names no end is an empty reply, not a cut (#5455, JZongf) — git am applies it as is; SHA-256 first 16: 8b1a0927d282c1eb</summary>

```text
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sun, 8 Nov 2026 10:05:21 +0800
Subject: [PATCH] gateway: a Gemini candidate that says nothing and names no
 end is an empty reply, not a cut (#5455, JZongf)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

Antigravity's Code Assist, serving gemini-4-argon a turn whose last
message is a tool's result the model has nothing to say after, ends the
stream with one ~487-byte chunk: a candidate carrying a role and no
parts, usageMetadata counting no output token, and no finishReason, the
connection closing right after. geminiEnds took the chunk for no end —
its candidates are there, their finishReason is not — so the reply was a
cut one, "the reply ended before it was complete", a transport failure
the request asked again of the same account and handed on, five or six
200 KB asks of the same silence per HTTP request, and the 502 the agent
got sent Claude Code into nine retries of its own: some sixty identical
upstream calls and a turn hanging near half an hour (magpie v0.1.3101,
usage.jsonl over four runs). A candidate that says nothing and names no
end is the same silence a reply with no candidate at all is (#667): the
empty reply's to answer, asked again on the same account and failed as
"an empty reply (the model answered nothing; try again)", never a cut
one's. `"candidates":[]` without a finishReason, which the old early
return also left to the cut's, is the same nothing. A candidate with
parts keeps the cut's error for the stream that stops before its
finishReason (#1643), and a reply that ends with a proper finishReason,
STOP as an error to a client that asked for no stream, is unchanged.

TestGeminiSilentCandidateIsEmptyReply runs the reporter's wire shape
through the Anthropic, Chat and whole-reply paths of a fake Gemini
upstream (the decoder Code Assist shares), fails on the old code with
the cut's error, and passes asked again as the empty reply's; a reply
that said something before its silent candidate still goes as it came.
---
 internal/gateway/continuation.go              | 31 ++++++-
 .../gateway/gemini_silent_candidate_test.go   | 87 +++++++++++++++++++
 internal/gateway/gemini_upstream_cut_test.go  |  5 ++
 3 files changed, 121 insertions(+), 2 deletions(-)
 create mode 100644 internal/gateway/gemini_silent_candidate_test.go

diff --git a/internal/gateway/continuation.go b/internal/gateway/continuation.go
index ffc12d1be..9b03c2bd9 100644
--- a/internal/gateway/continuation.go
+++ b/internal/gateway/continuation.go
@@ -87,10 +87,37 @@ var errEndedShort = errors.New("the reply ended before it was complete")
 // stream cut after any of them would read as whole. A chunk with no
 // candidate at all — usage alone, or a prompt blocked — ends it too: such
 // a reply said nothing, and is the empty reply's to answer (#667), not a
-// cut one's.
+// cut one's. So is one whose candidate carries no parts and no
+// finishReason — Code Assist's turn-end when the model has nothing to
+// say, a role alone or an empty object, usage counting no output token,
+// then the stream closes (#5455, JZongf): a candidate that says nothing
+// and names no end is the same silence.
 func geminiEnds(data []byte) bool {
 	if !bytes.Contains(data, []byte(`"finishReason"`)) && bytes.Contains(data, []byte(`"candidates"`)) {
-		return false
+		type chunk struct {
+			Candidates []struct {
+				Content struct {
+					Parts []json.RawMessage `json:"parts"`
+				} `json:"content"`
+			} `json:"candidates"`
+		}
+		var ch struct {
+			chunk
+			Response *chunk `json:"response"`
+		}
+		if json.Unmarshal(data, &ch) != nil {
+			return false
+		}
+		c := ch.chunk
+		if ch.Response != nil {
+			c = *ch.Response
+		}
+		for _, cand := range c.Candidates {
+			if len(cand.Content.Parts) > 0 {
+				return false // said something, its end is a finishReason's to tell
+			}
+		}
+		return true
 	}
 	type chunk struct {
 		Candidates []struct {
diff --git a/internal/gateway/gemini_silent_candidate_test.go b/internal/gateway/gemini_silent_candidate_test.go
new file mode 100644
index 000000000..216d521dd
--- /dev/null
+++ b/internal/gateway/gemini_silent_candidate_test.go
@@ -0,0 +1,87 @@
+package gateway
+
+import (
+	"net/http/httptest"
+	"path/filepath"
+	"strings"
+	"testing"
+)
+
+// A Code Assist (Antigravity) reply that ends its stream with a candidate
+// that carries no parts and no finishReason — the model answered nothing,
+// now and then right after a tool's result — went to the agent as a reply
+// cut short ("the reply ended before it was complete"): asked again as a
+// transport failure, the whole 200 KB prompt resent several times over,
+// then a 502 the agent spends its own ten retries on — minutes of the
+// same 0-token ask, ~60 upstream calls in a reporter's session (#5455,
+// JZongf). Such a candidate says the reply is over with nothing said in
+// it, as a reply with no candidate at all does (#667): the empty reply's
+// to answer, asked again on the same account and failed as that error,
+// not a cut one's. The reporter's wire shape: one ~487-byte chunk with
+// usageMetadata (in: 2049, out: 0) and a role-only candidate, then the
+// stream closes.
+
+// silentCandidates is the shapes on the wire: the Gemini API's bare chunk
+// and Code Assist's, wrapped in a response, and a candidate that is an
+// empty object outright.
+var silentCandidates = map[string]string{
+	"role only":   `data: {"candidates":[{"content":{"role":"model"}}],"usageMetadata":{"promptTokenCount":2049,"candidatesTokenCount":0,"thoughtsTokenCount":0,"cachedContentTokenCount":52607}}` + "\n\n",
+	"wrapped":     `data: {"response":{"candidates":[{"content":{"role":"model"}}],"usageMetadata":{"promptTokenCount":2049,"candidatesTokenCount":0,"thoughtsTokenCount":0}}}` + "\n\n",
+	"bare object": `data: {"candidates":[{}],"usageMetadata":{"promptTokenCount":4098,"candidatesTokenCount":0}}` + "\n\n",
+}
+
+func askSilentCandidate(t *testing.T, reply, path, body string) (*fake, int, string) {
+	t.Helper()
+	home := t.TempDir()
+	t.Setenv("HOME", home)
+	t.Setenv("USERPROFILE", home)
+	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
+	t.Setenv("XDG_CACHE_HOME", filepath.Join(home, ".cache"))
+	t.Setenv("XDG_DATA_HOME", filepath.Join(home, ".local", "share"))
+
+	f := &fake{t: t}
+	up := httptest.NewServer(f)
+	t.Cleanup(up.Close)
+	saveGem(t, up.URL, "gemini-4-argon")
+	f.reply = reply
+	code, out := post(t, path, body)
+	return f, code, out
+}
+
+func TestGeminiSilentCandidateIsEmptyReply(t *testing.T) {
+	for what, reply := range silentCandidates {
+		for _, a := range []struct{ name, path, body string }{
+			{"anthropic", "/v1/messages", `{"model":"gem/gemini-4-argon","stream":true,"max_tokens":256,"messages":[{"role":"user","content":"hi"},{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"wait","input":{}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"matched: []"}]}]}`},
+			{"chat", "/v1/chat/completions", `{"model":"gem/gemini-4-argon","stream":true,"messages":[{"role":"user","content":"hi"}]}`},
+		} {
+			f, code, body := askSilentCandidate(t, reply, a.path, a.body)
+			if strings.Contains(body, "ended before it was complete") {
+				t.Errorf("%s, %s: the silent candidate read as a cut: %d %s", what, a.name, code, body)
+			}
+			if !strings.Contains(body, "an empty reply") {
+				t.Errorf("%s, %s: not the empty reply's error: %d %s", what, a.name, code, body)
+			}
+			if f.calls < 2 {
+				t.Errorf("%s, %s: asked %d times, not again", what, a.name, f.calls)
+			}
+		}
+		// a client that asked for no stream is told the same error
+		_, code, body := askSilentCandidate(t, reply, "/v1/chat/completions",
+			`{"model":"gem/gemini-4-argon","messages":[{"role":"user","content":"hi"}]}`)
+		if code != 502 || !strings.Contains(body, "an empty reply") || strings.Contains(body, "ended before") {
+			t.Errorf("%s, not streamed: %d %s", what, code, body)
+		}
+	}
+}
+
+// A reply that has the silent candidate among its chunks, but said
+// something before it, is no empty reply: it goes as it came.
+func TestGeminiTextThenSilentCandidateIsSaid(t *testing.T) {
+	reply := `data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Done."}]}}]}` + "\n\n" +
+		`data: {"candidates":[{"content":{"role":"model"}}],"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":3}}` + "\n\n"
+	_, code, body := askSilentCandidate(t, reply, "/v1/chat/completions",
+		`{"model":"gem/gemini-4-argon","stream":true,"messages":[{"role":"user","content":"hi"}]}`)
+	if code != 200 || !strings.Contains(body, "Done.") || strings.Contains(body, "an empty reply") {
+		t.Errorf("text then silent candidate: %d %s", code, body)
+	}
+}
diff --git a/internal/gateway/gemini_upstream_cut_test.go b/internal/gateway/gemini_upstream_cut_test.go
index e083c851e..ed26cc312 100644
--- a/internal/gateway/gemini_upstream_cut_test.go
+++ b/internal/gateway/gemini_upstream_cut_test.go
@@ -93,6 +93,11 @@ func TestGeminiEnds(t *testing.T) {
 		`{"usageMetadata":{"promptTokenCount":0}}`:                true,
 		`{"promptFeedback":{"blockReason":"PROHIBITED_CONTENT"}}`: true,
 		`{"response":{"usageMetadata":{"promptTokenCount":0}}}`:   true,
+		// a candidate with no parts and no finishReason: the same silence,
+		// Code Assist's turn-end with nothing in it (#5455)
+		`{"candidates":[{"content":{"role":"model"}}],"usageMetadata":{"promptTokenCount":2049,"candidatesTokenCount":0,"thoughtsTokenCount":0,"cachedContentTokenCount":52607}}`: true,
+		`{"candidates":[{}]}`: true,
+		`{"response":{"candidates":[{"content":{"role":"model"}}],"usageMetadata":{"promptTokenCount":2049}}}`: true,
 		`not json`: false,
 	} {
 		if got := geminiEnds([]byte(chunk)); got != want {
-- 
2.50.1 (Apple Git-155)
```

</details>

**Branch with the commit**: [`fix/5455-antigravity-0token-turn`](https://github.com/ggbdpq/magpie/tree/fix/5455-antigravity-0token-turn) (head `45c48aa41fc5423e2131a6f7fa2d00ea9ea0f84b`), rebased onto current `upstream/main` (`0fc3455e2`); on a fresh checkout `git am` applies clean (verified: the am'd tree is byte-identical to my working tree).

| Check | Result |
| --- | --- |
| `TestGeminiSilentCandidateIsEmptyReply` (new; the reporter's wire shape — role-only candidate, wrapped variant, `{"candidates":[{}]}` — through the Anthropic, Chat and whole-reply paths) | red before the fix with "the reply ended before it was complete", pass after as the empty reply, asked again |
| `TestGeminiEnds` (extended with the three silent shapes) | red on the three new rows before, pass after |
| `TestGeminiTextThenSilentCandidateIsSaid` (new) | red before (told the cut's error), pass after (200, no empty-reply error) |
| `TestGeminiEmptyReplyIsAnError`, `TestGeminiEmptyRepliesAskedAgain`, `TestGeminiUpstreamEndedShort`, `TestGeminiNonStreamEndedShort`, `TestGeminiEmptyReplyGroupFailover` | pass, unchanged |
| `go test ./internal/gateway/ -tags nogui -timeout 30m -count=1` | ok (779s), zero failures |
| `go test ./... -tags nogui -timeout 30m -count=1` (temp HOME) | 3 failures, each failing the same on `upstream/main` `0fc3455e2` re-run from a clean checkout of it: `TestMothX`, `TestProxyCheckSaysAProxyPassedBy` (this machine's local proxy), `TestHostToldTheGatewayAddress` (port race) |
| targeted `-race` | pass |
| `gofmt -l internal/gateway/` | prints nothing |
| `go vet ./internal/gateway/`; `GOOS=linux go vet -tags nogui ./...`; `GOOS=windows go vet ./...` | clean |
| `go build`; `GOOS=linux go build -tags nogui`; `GOOS=windows go build` | clean (`GOOS=linux go build ./...` without `-tags nogui` fails inside wails v3.0.0-beta.24, `undefined: pointer` — dependency-side, fails the same on `upstream/main`) |
| Ablation | turning the new "ends on a candidates-only silence" branch `false` again makes all three new tests red with the cut's error; restored, green |
| Re-verified on `upstream/main` `0fc3455e2` | the commit is made directly on it; the three pre-existing failures above were re-run on a clean checkout of that same commit |

**Not verified**: against a real Antigravity account on gemini-4-argon — that engine/platform is NOT-RUNNABLE here; the tests drive a fake upstream through the decoder and translate Code Assist shares (the same proxy `TestGeminiEmptyReplyIsAnError` has used since `#667`). The retry storm's remaining tail — Claude Code's own nine retries after the bounded empty-reply 502 — is upstream of magpie and stays with the maintainer's turn-completion decision.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

Generated-by: GLM-5.3-Flash (ZCode)
