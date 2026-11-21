## Symptom

On a Cursor subscription model through magpie, a Pi turn that keeps one native Run across many tool steps dies at that Run's absolute 15-minute lifetime mid-reply: the 200 is long since sent, the partial text ends with `error: {"message":"native Run lifetime expired","code":410}` in the stream, and Pi shows `Error: native Run lifetime expired`. The wording is the cursor plugin's (`@magpie-community/opencode-cursor-auth`, `NATIVE_LIMITS.lifetime = 15 * 60_000`, a `fail(410)` on the absolute deadline). Asked again, the conversation goes on fine on a fresh Run — but Pi has already given up on the turn.

## Minimal repro

Point a client like Pi (`api: openai-completions`) at magpie, and have the upstream fail mid-reply with exactly the plugin's words:

```
data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":"half said"}}]}

data: {"error":{"message":"native Run lifetime expired","code":410}}
```

The client is handed the bare wording. Pi decides whether to retry from the error's text alone (#2372 — by then the status can no longer be told), and no word of `native Run lifetime expired` is one it retries on: the turn ends where asking again would go on.

## Root cause

The error rides a 200 stream, so only its text ever reaches the agent. `native Run lifetime expired` carries no word Pi's retry list knows (`retry your request`, `timed out`, `rate limit`, 429/5xx, ...), so Pi reads it as a final failure. The Run is gone but the conversation is not — the error just never says so.

## Fix

Tell the agent, in the words Pi knows, that this particular error may be asked again — the same thing `saysPassing` already does for magpie's own stream errors:

- `withRunRetryHint` (gateway.go): a message containing the plugin's wording (new `deadRunSaid`) that `passingSaid` does not already take for said gets ` (you can retry your request)` appended; any other wording goes as it came.
- The Chat relay mends the error event's message (`chatTidy` → new `errorSaidAgain`, the error's other fields kept); a translated reply's error carries the hint too (`streamTranslated`).
- `needsTidy` passes lines carrying the wording through the tidy path so the mend can happen.

## Verification

Evidence archived on this branch's head `2cc906938`; the targeted pair re-run green by the continuation lane today.
| Check | Result |
|---|---|
| RED without the fix (`red-first-run.txt`) | `TestRunExpiredSaysAskAgain` + `TestRunExpiredTranslatedSaysAskAgain` FAIL — the bare wording relayed verbatim |
| GREEN with the fix (`green-first-run.txt`) | both PASS, `ok internal/gateway 1.046s` |
| Ablation, fix reverted by hand (`ablation-red.txt`) | both FAIL again |
| Targeted re-run, this lane, `-run 'TestRunExpired...' -count=1 -v` | both PASS, `ok internal/gateway 1.161s` |
| `go vet ./...`, `GOOS=linux go vet -tags nogui ./...`, `GOOS=windows go vet ./...` | clean (archived run) |
| gateway package re-vetted this lane (darwin + `GOOS=linux -tags nogui` + `GOOS=windows`), `GOOS=linux go build -tags nogui` | clean / ok |
| `gofmt -l` on the 4 changed files | prints nothing |
| `go test ./internal/gateway/` full (`gateway-full-1.txt`) | one FAIL: `TestCodexPoolSaysTheClientsVersion` — pre-existing Codex User-Agent version assertion, none of this change's files |
| nogui full matrix (`nogui-full.txt`) | FAILs all pre-existing, outside the change: `internal/agent` TestMothX; `internal/cli` TestSettingsCLISetsWhatTheWindowSaves, TestEveryRouteHasACommandOrIsNamed, TestProxyCheckSaysAProxyPassedBy; gateway TestCodexPoolSaysTheClientsVersion |

Not verified:

- A real Cursor Run actually hitting its 15-minute deadline (needs a live subscription and the wait); here a fake upstream speaks the plugin's exact wording, which is all the relay sees.
- The plugin-side asks (the reporter's expected 1, renewing or rebuilding before the deadline) live in magpie-community/plugins and are out of this patch's reach; this only makes sure that when the cut does happen, the agent is told it may ask again.
- The full matrices ran on base 01d4489a2. Upstream has since added two commits (both `internal/sessions/`, no file of this patch touched); the targeted gateway pair was re-run green on the current head.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: fix(gateway): tell the agent a dead cursor Run's error may be asked again (#4419) — git am applies it as is; SHA-256 first 16: f4c967fd7575a9c5</summary>
```
From 2cc906938e2e74e320abb74a56c1879ff88e98f5 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Mon, 2 Nov 2026 05:07:14 +0800
Subject: [PATCH] fix(gateway): tell the agent a dead cursor Run's error may be
 asked again (#4419)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

The cursor plugin fails a native Run that outlived its absolute 15-minute
lifetime mid-reply with "native Run lifetime expired" in the stream, the
200 long since sent. The Run is gone and the conversation is not — asked
again, the history is rebuilt on a fresh Run — but the error's text is all
the agent reads (its status can no longer be told, #2372), and no word of
it is one Pi retries on: the turn ended where asking again goes on (#4419).

The relay now says it in the words Pi knows, as saysPassing does for
magpie's own stream errors: the Chat relay mends the error event's message
(chatTidy), and a translated reply's error carries it too (streamTranslated).
An error of any other wording goes as it came.

Verified: TestRunExpiredSaysAskAgain and TestRunExpiredTranslatedSaysAskAgain
fail without the change (the bare wording relayed) and pass with it; with the
fix reverted by hand both go red again. go vet ./..., GOOS=linux go vet -tags
nogui ./... and GOOS=windows go vet ./... are clean; go build, GOOS=linux and
GOOS=windows go build -tags nogui build; gofmt -l prints nothing on the
changed files.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/chattidy.go               | 39 ++++++++++++++--
 internal/gateway/continuation.go           |  3 ++
 internal/gateway/gateway.go                | 18 ++++++++
 internal/gateway/late_stream_error_test.go | 54 ++++++++++++++++++++++
 4 files changed, 111 insertions(+), 3 deletions(-)

diff --git a/internal/gateway/chattidy.go b/internal/gateway/chattidy.go
index fe7e23e6a..e1ad9d203 100644
--- a/internal/gateway/chattidy.go
+++ b/internal/gateway/chattidy.go
@@ -109,6 +109,7 @@ var (
 	contentPartsSpace = []byte(`"content": [`)
 	toolCallsField    = []byte(`"tool_calls"`)
 	functionCallField = []byte(`"function_call":{`)
+	runExpiredText    = []byte(deadRunSaid)
 )
 
 // write takes what was read and gives back what to send on: every line
@@ -158,7 +159,8 @@ func needsTidy(line []byte) bool {
 		bytes.Contains(line, contentParts) ||
 		bytes.Contains(line, contentPartsSpace) ||
 		bytes.Contains(line, toolCallsField) ||
-		bytes.Contains(line, functionCallField)
+		bytes.Contains(line, functionCallField) ||
+		bytes.Contains(line, runExpiredText)
 }
 
 // needs is needsTidy, a finish_reason once a choice made a call, and a
@@ -264,10 +266,16 @@ func (t *chatTidy) line(line []byte) []byte {
 	if raw, ok := chunk["usage"]; ok {
 		chunk["usage"], usageMended = openAIUsage(raw)
 	}
+	errorMended := false
+	if raw, ok := chunk["error"]; ok {
+		if nb, chg := errorSaidAgain(raw); chg {
+			chunk["error"], errorMended = nb, true
+		}
+	}
 	var choices []map[string]json.RawMessage
 	if decodeJSON(chunk["choices"], &choices) != nil {
 		choices = nil
-		if !usageMended {
+		if !usageMended && !errorMended {
 			return line
 		}
 	}
@@ -355,7 +363,7 @@ func (t *chatTidy) line(line []byte) []byte {
 			}
 		}
 	}
-	if !changed && !usageMended {
+	if !changed && !usageMended && !errorMended {
 		return line
 	}
 	if changed {
@@ -368,6 +376,31 @@ func (t *chatTidy) line(line []byte) []byte {
 	return append(append([]byte("data: "), nb...), end...)
 }
 
+// errorSaidAgain is a relayed error event with the dead Run's wording
+// told the agent it may ask again (withRunRetryHint, #4419); ok is false
+// for an error of any other wording, or one with no message, which go as
+// they came, their other fields kept.
+func errorSaidAgain(raw json.RawMessage) (json.RawMessage, bool) {
+	var m map[string]json.RawMessage
+	if decodeJSON(raw, &m) != nil || m == nil {
+		return raw, false
+	}
+	var msg string
+	if decodeJSON(m["message"], &msg) != nil || msg == "" {
+		return raw, false
+	}
+	said := withRunRetryHint(msg)
+	if said == msg {
+		return raw, false
+	}
+	m["message"], _ = json.Marshal(said)
+	nb, err := json.Marshal(m)
+	if err != nil {
+		return raw, false
+	}
+	return nb, true
+}
+
 // emptyFunctionCall reports whether raw is a legacy function_call
 // carrying nothing: a name and arguments both empty strings or nulls,
 // either absent (#4659). A null is the contract's own nothing and is not
diff --git a/internal/gateway/continuation.go b/internal/gateway/continuation.go
index b7c86efa7..384cb91c4 100644
--- a/internal/gateway/continuation.go
+++ b/internal/gateway/continuation.go
@@ -450,6 +450,9 @@ func (s *Server) streamTranslated(w http.ResponseWriter, r *http.Request, p prov
 				h.mu.Unlock()
 			}
 		case KError:
+			// the dead Run's wording tells the agent it may ask again
+			// (#4419), as a failure of magpie's own does (saysPassing)
+			ev.Text = withRunRetryHint(ev.Text)
 			if ev.Code == "" && cont.possible() && !inGroupTry(r.Context()) {
 				// held while the reply may yet go on; sent when it can't
 				failed, failedCode, failedStatus, cut = ev.Text, ev.Code, ev.Status, true
diff --git a/internal/gateway/gateway.go b/internal/gateway/gateway.go
index 227341172..95e0d8dbe 100644
--- a/internal/gateway/gateway.go
+++ b/internal/gateway/gateway.go
@@ -8741,6 +8741,24 @@ func streamError(w http.ResponseWriter, proto provider.Protocol, model string, s
 // unreachable server.
 var passingSaid = regexp.MustCompile(`(?i)\b(429|500|502|503|504)\b|timed? ?out|rate.?limit|too many requests|overloaded|service.?unavailable|server.?error|internal.?error|connection.?(error|refused|reset)|retry your request|try your request again`)
 
+// deadRunSaid is how the cursor plugin says it failed a native Run that
+// outlived its absolute 15-minute lifetime mid-reply (#4419). The Run is
+// gone and the conversation is not — asked again, the history is rebuilt
+// on a fresh Run — but the error rides a 200 stream, so the agent reads
+// the text alone (#2372), and no word of it is one Pi retries on: the
+// turn ended where asking again goes on.
+const deadRunSaid = "native Run lifetime expired"
+
+// withRunRetryHint is msg with a word to ask again on, when it is the
+// dead Run's: the words saysPassing gives magpie's own stream errors,
+// which passingSaid takes for said already.
+func withRunRetryHint(msg string) string {
+	if msg == "" || !strings.Contains(msg, deadRunSaid) || passingSaid.MatchString(msg) {
+		return msg
+	}
+	return msg + " (you can retry your request)"
+}
+
 // saysPassing is msg, an error sent in a stream whose status the agent
 // can no longer be told, with the status said in it when it is one a
 // moment may clear (408, 429, 5xx) and msg says so in no words an agent
diff --git a/internal/gateway/late_stream_error_test.go b/internal/gateway/late_stream_error_test.go
index 3843a8768..dfe804be0 100644
--- a/internal/gateway/late_stream_error_test.go
+++ b/internal/gateway/late_stream_error_test.go
@@ -85,6 +85,60 @@ func TestLateStreamErrorNotKept(t *testing.T) {
 	}
 }
 
+// The cursor plugin fails a native Run that outlived its 15-minute
+// lifetime mid-reply with "native Run lifetime expired" in the stream, its
+// 200 long since sent (#4419). The Run is gone and the conversation is
+// not — asked again, the history is rebuilt on a fresh Run — but an agent
+// that reads only the error's text (Pi, #2372) has no word in it it
+// retries on, so the turn ended where asking again goes on. The relay
+// says it in the words Pi knows; an error of any other wording goes as it
+// came.
+func TestRunExpiredSaysAskAgain(t *testing.T) {
+	fresh(t)
+	f := &fake{reply: sse(`data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":"half said"}}]}`,
+		`data: {"error":{"message":"native Run lifetime expired","code":410}}`,
+		`data: {"error":{"message":"native outbound messages limit reached","code":429}}`)}
+	setup(t, provider.Chat, f)
+	code, body := post(t, "/v1/chat/completions", `{"model":"fake/m1","stream":true,"messages":[{"role":"user","content":"hi"}]}`)
+	if code != 200 {
+		t.Fatalf("status = %d, want 200; body: %s", code, body)
+	}
+	if !strings.Contains(body, "half said") {
+		t.Fatalf("the reply so far didn't reach the client: %s", body)
+	}
+	var said []string
+	for _, ev := range events(body) {
+		if e, ok := ev["error"].(map[string]any); ok {
+			said = append(said, e["message"].(string))
+		}
+	}
+	if len(said) != 2 {
+		t.Fatalf("the client was told %d errors, want 2: %s", len(said), body)
+	}
+	if said[0] != "native Run lifetime expired (you can retry your request)" {
+		t.Fatalf("the dead Run's error reached the client with no word to retry on: %q", said[0])
+	}
+	if said[1] != "native outbound messages limit reached" {
+		t.Fatalf("an error of another wording was rewritten: %q", said[1])
+	}
+}
+
+// The same dead-Run error reaches a client magpie translates for, its
+// words again the only thing the agent reads (#4419 on a Messages client).
+func TestRunExpiredTranslatedSaysAskAgain(t *testing.T) {
+	fresh(t)
+	f := &fake{reply: sse(`data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":"half said"}}]}`,
+		`data: {"error":{"message":"native Run lifetime expired","code":410}}`)}
+	setup(t, provider.Chat, f)
+	code, body := postMessages(t, `{"model":"fake/m1","stream":true,"max_tokens":8,"messages":[{"role":"user","content":"hi"}]}`)
+	if code != 200 {
+		t.Fatalf("status = %d, want 200; body: %s", code, body)
+	}
+	if !strings.Contains(body, "native Run lifetime expired (you can retry your request)") {
+		t.Fatalf("the dead Run's error reached the client with no word to retry on: %s", body)
+	}
+}
+
 // A conversation affine keeps on an account by the account alone — the
 // model that answered it has left the group, and the widest of affine's
 // matches still holds it there — loses its stick when that reply breaks
-- 
2.50.1 (Apple Git-155)

```

</details>

Branch with the commit: [fix/4419-cursor-run-lifetime](https://github.com/ggbdpq/magpie/tree/fix/4419-cursor-run-lifetime) (head `2cc906938e2e74e320abb74a56c1879ff88e98f5`).
