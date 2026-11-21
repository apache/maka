Outstanding forensics in the issue — the `usage.jsonl` table, the `out == reasoning` exact equality on all four cuts, and the reading that 48,000 is qoder's real (and nowhere-declared) hard cap made this one easy to chase down. Thank you.

I verified both gates you named on current main (`ef655acb`):

- `emptyFails(actual)` is true only for `CodeAssist` and `Gemini` — a Chat upstream like qoder never enters the empty-reply check at all;
- even where it does, `answersNothing("length")` returns false — the comment says a cut at its length (all reasoning) is spared.

So a `stop=length` reply with `saidAnything(parts) == false` (only thinking, no text, no tool call) went back to the agent as a normal 200 — exactly your table's four `48,000 = 48,000` rows.

The predicate I chose, stated plainly: **`finish_reason == "length"` AND nothing said (no text, no tool call — only thinking, or nothing at all) AND the upstream protocol is Chat AND the request is not a title/description/prediction magpie writes itself.** It deliberately leaves alone: a `length` cut WITH text or calls (today's truncation, untouched), a Gemini/Code Assist cut at `MAX_TOKENS` with only its reasoning (#667's stance, pinned by a test), and titles cut short before their text, which still go back as the `response.incomplete` Codex asks again after (#1466).

One boundary to be upfront about: a streaming Chat client in front of a Chat upstream is **relayed byte-for-byte** (passthrough, by design), and this fix does not intercept that path — it closes the translated paths (non-streaming Chat clients, and Messages/Responses clients, which is where the two gates stood). Your dsh profile is `openai-completions`; if it streams, its requests likely rode the relay. I left that alone rather than rebuild the hold/retry machinery inside passthrough — flagged here so nobody thinks this alone stops the dsh loop for streaming clients.

A nice find along the way: the repo's own recorded `testdata/clinepass_stream.sse` is a specimen of the same void from another vendor — `finish_reason "length"`, 16 completion tokens, all 16 of them reasoning, no text, no calls. Its test pinned the old behavior, so the commit updates the Messages-client expectations (asked again, then the error; the ClinePass metadata assertions kept) and leaves the Chat-client relay expectations untouched.

Branch: [`hunt47-b-length-reasoning`](https://github.com/ggbdpq/magpie/tree/hunt47-b-length-reasoning), one commit on top of upstream `ef655acb`; the patch below applies with `git am`.

## What changed

- `internal/gateway/gateway.go`: `cutVoidAt`/`cutVoid` beside `answersNothing`, and a second disjunct on the empty-reply gate in `translate` (the whole-reply path).
- `internal/gateway/continuation.go`: the same disjunct on the gate in `streamTranslated`, and Chat now holds a stream's end events (`KStop`/`KUsage`) while nothing is said — as Gemini's already are — so a voided try is asked again before any `finish_reason` has gone to the client. On retry the kept end events are dropped; if the retry speaks, they are flushed in order as before.
- `internal/gateway/upstream_test.go`: `TestClinePassUpstreamRecorded` updated for the recorded void (see above).
- `internal/gateway/chat_length_nothing_test.go`: the new tests.

The failure the agent now sees is the existing `emptyReply` one ("an empty reply (the model answered nothing; try again)"): asked again in place first, then the error in the client's own protocol, a routing group fails over to its next member, and no account is rested — all of that is the #667 machinery reused, no new error path.

## Red before the fix

`TestChatLengthNothingSaidIsAnError` on upstream/main: a fake Chat upstream ending `finish_reason:"length"` with one `reasoning_content` delta answered 200 — a `response.incomplete` to a Responses client, `stop_reason:"max_tokens"` with only a thinking block to a Messages client, the raw relay to a Chat one. After the change: asked again, then `an empty reply` in-stream (or a 502 when not streamed), upstream asked at least twice.

## Verification

| Check | Command | Result |
|---|---|---|
| New tests | `go test ./internal/gateway/ -run 'TestChatLengthNothingSaidIsAnError\|TestChatLengthWithTextIsTruncation'` | RED on main (void), then both PASS |
| Targeted families | empty-reply, titles, limits, overflow, thinking tests | PASS |
| Full gateway package | `go test ./internal/gateway/... -count=1` | ok 320s, 0 failures |
| Race | targeted run with `-race` | PASS |
| Format | `gofmt -l internal/gateway/` | clean |
| Vet | `go vet` darwin / linux / windows | clean |
| Build | `go build` darwin / windows | ok; linux ok for `internal/gateway`, root binary blocked by wails v3 beta's own linux files (pre-existing, untouched) |
| Ablation | restore `gateway.go` + `continuation.go` from `upstream/main` | tests go RED; restore → GREEN |
| Mutation | kill the void check → RED; widen it to fire on `length` WITH text → existing `TestTooFewTokensSaidWithSigns` and the truncation guard go RED | proves the check is neither dead nor over-reaching |

## Siblings

- #667 / #1221 (reasoning-then-empty on `STOP`): untouched — their gate (`emptyFails`, the retry-then-error-then-failover path) is what this fix extends; the new predicate deliberately does not change what they cover.
- #2436 (loop breaker): untouched — it fires on reasoning stuck in a loop mid-reply; this is about a reply that ended cleanly cut with nothing in it.
- #2274 / `endedIncomplete` (`incompleteReply`): untouched — that is the Responses-event "ended cut short" machinery for relays that stop mid-reply; here the upstream *said* its reply ended (`length`), so the empty-reply path is the honest one.
- #1466 (cut titles stay incomplete): deliberately preserved via the side-call exemption.

## Not verified

- No real qoder account here: the fake upstream speaks the wire shape your table implies (`reasoning_content` deltas, then `finish_reason:"length"`), not qoder itself.
- The 48,000 cap is your reading of your own usage log; I could not confirm it against the vendor, and nothing in this patch depends on the exact number.
- The streaming-Chat-client relay boundary above is untested territory for this patch by construction.

**AI**: written with an AI coding agent; I've read the whole diff and can answer questions on it myself. The model name is in the commit's trailer.

**Attribution**: If you apply the patch, please keep its author (ggbdpq) or add a `Co-authored-by: ggbdpq <ggbdpq@gmail.com>` line.

<details><summary>patch — 0001-gateway-a-length-cut-that-said-nothing-is-not-a-completed-reply (#2972)</summary>

```patch
From 4985b38f9785e7243573cfb1cc37ce0442920736 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Tue, 20 Oct 2026 00:27:22 +0800
Subject: [PATCH] gateway: a length cut that said nothing is not a completed
 reply (#2972)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

What changed: a Chat upstream's reply cut at its length having said
nothing — no text and no tool call, only thinking or nothing at all —
now fails as an empty reply, the path a Gemini's empty reply takes
(#667): asked again in place, then the error in the client's own
protocol, a group's next member asked, no account rested. A length cut
that said something is still the truncation it always was, and a title,
description or prediction written by magpie still goes back the
response.incomplete it was (#1466).

Why: qoder/dfmodel ended four replies of one dsh turn with 48,000
output tokens each, every one of them reasoning — out == reasoning
exactly each time, 192,000 tokens and 919 seconds for nothing. The
agent was told the output limit was reached, went on at the user's
"continue", and the same void ran four times. Both gates an empty
reply fails at let it through: emptyFails is not for Chat (only
CodeAssist and Gemini are), and answersNothing spares a cut at its
length by design. The repo's own recorded ClinePass stream is a
specimen of the same shape from another vendor — finish_reason
"length", 16 completion tokens, all 16 of them reasoning, no text and
no calls (testdata/clinepass_stream.sse); its Messages-client test now
expects the asked-again error, its Chat client unchanged.

The check sits beside answersNothing (cutVoidAt, cutVoid) and extends
the empty-reply gates in translate and streamTranslated; a Chat
stream's end events are held while nothing is said, as Gemini's already
are, so a voided try is asked again without a finish_reason having gone
to the client. A streaming Chat client in front of a Chat upstream is
still relayed as it came (passthrough); this closes the translated
paths, where the two gates stood.

Run:
- go test ./internal/gateway/... -count=1: ok, 320s (with the new
  TestChatLengthNothingSaidIsAnError red on upstream/main, and
  TestChatLengthWithTextIsTruncation green before and after)
- gofmt -l clean; go vet clean on darwin, linux, windows
- builds: darwin, windows ok; linux ok for internal/gateway, the root
  binary blocked by wails v3 beta 24's own linux files (pre-existing,
  untouched by this diff)

Fixes #2972

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/chat_length_nothing_test.go | 105 +++++++++++++++++++
 internal/gateway/continuation.go             |   8 +-
 internal/gateway/gateway.go                  |  21 +++-
 internal/gateway/upstream_test.go            |  17 ++-
 4 files changed, 145 insertions(+), 6 deletions(-)
 create mode 100644 internal/gateway/chat_length_nothing_test.go

diff --git a/internal/gateway/chat_length_nothing_test.go b/internal/gateway/chat_length_nothing_test.go
new file mode 100644
index 00000000..64dd63e6
--- /dev/null
+++ b/internal/gateway/chat_length_nothing_test.go
@@ -0,0 +1,105 @@
+package gateway
+
+import (
+	"io"
+	"net/http"
+	"net/http/httptest"
+	"strings"
+	"testing"
+	"time"
+
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// A Chat reply cut at its length that said nothing — the whole budget
+// spent on reasoning, no text and no call — is not a completed reply.
+// qoder/dfmodel ended four replies of one dsh turn so (#2972): 48,000
+// output tokens each, every one of them reasoning, and the agent, told
+// the output limit was reached, went on at the user's "continue" and
+// burned the same void again. Both gates an empty reply fails at let it
+// through: emptyFails is not for Chat, and answersNothing spares a cut
+// at its length. It fails as an empty reply (#667's) now, asked again
+// first. One that said something still goes as it came, and a title cut
+// short before its text is still the response.incomplete Codex asks
+// again after (#1466).
+func TestChatLengthNothingSaidIsAnError(t *testing.T) {
+	fresh(t)
+	old := retryPause
+	retryPause = time.Millisecond
+	t.Cleanup(func() { retryPause = old })
+	calls := 0
+	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		io.ReadAll(r.Body)
+		calls++
+		w.Header().Set("Content-Type", "text/event-stream")
+		io.WriteString(w, sse(
+			`data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"let me think"}}]}`,
+			`data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":10,"completion_tokens":48000}}`,
+			`data: [DONE]`))
+	}))
+	t.Cleanup(up.Close)
+	if err := provider.Save(provider.Provider{ID: "qo", Name: "Qoder", Key: "k", Models: []string{"dfmodel"}, Chat: up.URL + "/v1"}); err != nil {
+		t.Fatal(err)
+	}
+
+	// streamed: asked again, then the error in the stream — never a reply
+	// ended as it should with nothing in it
+	for _, a := range []struct{ name, path, body, ended string }{
+		{"anthropic", "/v1/messages", `{"model":"qo/dfmodel","stream":true,"max_tokens":64,"messages":[{"role":"user","content":"hi"}]}`, `"stop_reason":"max_tokens"`},
+		{"responses", "/v1/responses", `{"model":"qo/dfmodel","stream":true,"input":"hi"}`, `response.incomplete`},
+	} {
+		calls = 0
+		code, body := post(t, a.path, a.body)
+		if strings.Contains(body, a.ended) || !strings.Contains(body, "an empty reply") || calls < 2 {
+			t.Errorf("%s: a void cut answered %d after %d calls, not the empty-reply error: %s", a.name, code, calls, body)
+		}
+	}
+
+	// not streamed: the same error, not a reply whole with nothing in it
+	calls = 0
+	code, body := post(t, "/v1/messages", `{"model":"qo/dfmodel","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}`)
+	if code != 502 || !strings.Contains(body, "an empty reply") {
+		t.Errorf("a void cut, not streamed: %d %s", code, body)
+	}
+}
+
+// A length cut that said something is the truncation it always was, told
+// to the client as such.
+func TestChatLengthWithTextIsTruncation(t *testing.T) {
+	fresh(t)
+	old := retryPause
+	retryPause = time.Millisecond
+	t.Cleanup(func() { retryPause = old })
+	calls := 0
+	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		io.ReadAll(r.Body)
+		calls++
+		w.Header().Set("Content-Type", "text/event-stream")
+		io.WriteString(w, sse(
+			`data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"Half an ans"}}]}`,
+			`data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":10,"completion_tokens":48000}}`,
+			`data: [DONE]`))
+	}))
+	t.Cleanup(up.Close)
+	if err := provider.Save(provider.Provider{ID: "qo", Name: "Qoder", Key: "k", Models: []string{"dfmodel"}, Chat: up.URL + "/v1"}); err != nil {
+		t.Fatal(err)
+	}
+	for _, a := range []struct{ name, path, body, ended string }{
+		{"anthropic", "/v1/messages", `{"model":"qo/dfmodel","stream":true,"max_tokens":64,"messages":[{"role":"user","content":"hi"}]}`, `"stop_reason":"max_tokens"`},
+		{"responses", "/v1/responses", `{"model":"qo/dfmodel","stream":true,"input":"hi"}`, `response.incomplete`},
+	} {
+		calls = 0
+		code, body := post(t, a.path, a.body)
+		if code != 200 || !strings.Contains(body, "Half an ans") || !strings.Contains(body, a.ended) ||
+			strings.Contains(body, "an empty reply") || calls != 1 {
+			t.Errorf("%s: a cut that said something answered %d after %d calls: %s", a.name, code, calls, body)
+		}
+	}
+
+	calls = 0
+	code, body := post(t, "/v1/messages", `{"model":"qo/dfmodel","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}`)
+	if code != 200 || !strings.Contains(body, "Half an ans") || !strings.Contains(body, `"stop_reason":"max_tokens"`) ||
+		strings.Contains(body, "an empty reply") || calls != 1 {
+		t.Errorf("a cut that said something, not streamed: %d after %d calls: %s", code, calls, body)
+	}
+}
diff --git a/internal/gateway/continuation.go b/internal/gateway/continuation.go
index 5ffabace..bb572fc9 100644
--- a/internal/gateway/continuation.go
+++ b/internal/gateway/continuation.go
@@ -374,6 +374,9 @@ func (s *Server) streamTranslated(w http.ResponseWriter, r *http.Request, p prov
 	// counts: a reply in this protocol counts its tokens, and one that
 	// said nothing and counted none fails too (repliesCounted, #2086)
 	var counts bool
+	// voids: a reply in this protocol cut at its length that says nothing
+	// fails too (cutVoidAt, #2972)
+	var voids bool
 	empties := 0 // the times such a reply was asked again here
 	said, stop := false, ""
 	var kept []Event       // the reply's end, while nothing is said in it
@@ -436,7 +439,7 @@ func (s *Server) streamTranslated(w http.ResponseWriter, r *http.Request, p prov
 		case KStop:
 			stop = ev.Stop
 		}
-		if (empty || counts) && !said {
+		if (empty || counts || voids) && !said {
 			switch {
 			case saysSomething(ev):
 				said = true
@@ -477,6 +480,7 @@ func (s *Server) streamTranslated(w http.ResponseWriter, r *http.Request, p prov
 			u.RequestID = requestID(res.Header)
 			summaryUpstream = actual == provider.Responses || actual == provider.Gemini || actual == provider.CodeAssist
 			empty, counts = emptyFails(actual), repliesCounted(actual)
+			voids = cutVoidAt(actual, r.Context())
 		}
 		if err == nil && res.StatusCode >= 400 {
 			b, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
@@ -589,7 +593,7 @@ func (s *Server) streamTranslated(w http.ResponseWriter, r *http.Request, p prov
 			if held != nil {
 				held()
 			}
-			if (empty || counts && uncounted(this)) && !said && answersNothing(stop) {
+			if (empty || counts && uncounted(this)) && !said && answersNothing(stop) || voids && cutVoid(stop, !said) {
 				if empties < emptyRetries(w, r.Context()) && r.Context().Err() == nil {
 					// asked again here first, for the agent to have the
 					// answer rather than the error: Gemini on a long
diff --git a/internal/gateway/gateway.go b/internal/gateway/gateway.go
index 8f950d31..c5c0707c 100644
--- a/internal/gateway/gateway.go
+++ b/internal/gateway/gateway.go
@@ -5815,7 +5815,8 @@ func (s *Server) translate(w http.ResponseWriter, r *http.Request, p provider.Pr
 		msg := p.Name + ": " + errEndedShort.Error()
 		return writeError(w, from, 502, msg), msg
 	}
-	if (empty || repliesCounted(actual) && uncounted(col.res.Usage)) && !saidAnything(col.res.Parts) && answersNothing(col.res.Stop) {
+	if (empty || repliesCounted(actual) && uncounted(col.res.Usage)) && !saidAnything(col.res.Parts) && answersNothing(col.res.Stop) ||
+		cutVoidAt(actual, r.Context()) && cutVoid(col.res.Stop, !saidAnything(col.res.Parts)) {
 		msg := p.Name + ": " + emptyReply
 		return writeError(w, from, 502, msg), msg
 	}
@@ -5870,6 +5871,24 @@ func answersNothing(stop string) bool {
 	return stop != "length" && stop != "filter"
 }
 
+// cutVoidAt tells whether a reply in proto cut at its length that says
+// nothing fails: a Chat upstream's does (#2972: qoder/dfmodel ended four
+// replies of one turn with 48,000 tokens each, every one of them
+// reasoning, and the agent, told the output limit was reached, went on
+// at the user's "continue" and burned the same void again). A Gemini's
+// and a Code Assist's still goes as it came (#667), and so does a title,
+// description or prediction written here: its cut goes back the
+// response.incomplete it was, Codex's to ask again (#1466).
+func cutVoidAt(proto provider.Protocol, ctx context.Context) bool {
+	return proto == provider.Chat && ctx.Value(titleCheckKey{}) == nil
+}
+
+// cutVoid says whether this reply was one: cut at its length having said
+// nothing — no text and no call, only thinking, or nothing at all.
+func cutVoid(stop string, saidNothing bool) bool {
+	return saidNothing && stop == "length"
+}
+
 // saysSomething tells whether an event is any of a reply an agent shows or
 // acts on: text, a call, a search, an image.
 func saysSomething(ev Event) bool {
diff --git a/internal/gateway/upstream_test.go b/internal/gateway/upstream_test.go
index 181277d2..cddbf7c0 100644
--- a/internal/gateway/upstream_test.go
+++ b/internal/gateway/upstream_test.go
@@ -196,7 +196,11 @@ func TestUpstreamOfClinePass(t *testing.T) {
 
 // The real ClinePass stream's provider reaches the route, its try, the
 // request log and the usage ledger, relayed to a Chat client or translated
-// to a Messages one (#2847).
+// to a Messages one (#2847). The recording is itself a length cut that
+// said nothing — 16 completion tokens, all 16 of them reasoning (#2972)
+// — so the Messages client's reply is asked again and ends with the
+// empty-reply error, its ClinePass metadata kept; a Chat client's is
+// relayed as it came.
 func TestClinePassUpstreamRecorded(t *testing.T) {
 	stream := clinePassStream(t)
 	for _, path := range []string{"/v1/chat/completions", "/v1/messages"} {
@@ -220,14 +224,21 @@ func TestClinePassUpstreamRecorded(t *testing.T) {
 			if rec.Code != 200 {
 				t.Fatalf("%d %s", rec.Code, rec.Body)
 			}
+			translated := path == "/v1/messages"
+			if translated && !strings.Contains(rec.Body.String(), "an empty reply") {
+				t.Errorf("a length cut that said nothing answered as it came: %s", rec.Body)
+			}
 			r := lastRoute(s)
-			if r.Upstream != "deepseek" || len(r.Tries) != 1 || r.Tries[0].Upstream != "deepseek" {
+			if !translated && (r.Upstream != "deepseek" || len(r.Tries) != 1) {
+				t.Errorf("route upstream %q, tries %+v", r.Upstream, r.Tries)
+			}
+			if len(r.Tries) == 0 || r.Tries[0].Upstream != "deepseek" {
 				t.Errorf("route upstream %q, tries %+v", r.Upstream, r.Tries)
 			}
 			if calls := s.Recent(); len(calls) == 0 || calls[0].Usage.Upstream != "deepseek" {
 				t.Errorf("request log: %+v", calls)
 			}
-			if u := usage.Load(time.Time{}); len(u) != 1 || u[0].Upstream != "deepseek" {
+			if u := usage.Load(time.Time{}); len(u) == 0 || u[0].Upstream != "deepseek" {
 				t.Errorf("usage %+v", u)
 			}
 		})
-- 
2.50.1 (Apple Git-155)

```

</details>
