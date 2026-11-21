The report's reading is right, and I reproduced the whole shape on base `e4ac5e8712eb5750a0043bf9d206313eceadbf0d`: a plugin ends the turn on purpose because its upstream's stream died mid-call (the plugins#38 contract: "the gateway can retry or fail over"), and the gateway instead classified the failure as unknown, rested the account for a minute of backoff, and handed the failure to the client — so the retry the plugin engineered never happened and the user's next attempt met the backoff too.

Branch: [`hunt48-e-cutshort-retry`](https://github.com/ggbdpq/magpie/tree/hunt48-e-cutshort-retry), one commit on top of upstream `e4ac5e87`; the patch below applies with `git am`.

## What changed

- The contract's own wording ("the model's tool call, written as text, was cut short" — shared by the plugins that read text-form calls: trae, qoder's `CUT_SHORT`) is classified as a failure of its own, `failCut` (`internal/gateway/continuation.go`).
- In `serve`, such a failure is asked again where it stood: the same member once (the parser reads the same stream, but the cut doesn't come again), then the next member as any failure's is (`cutReasks` with `retryPause` between, `internal/gateway/gateway.go`); nobody rests and no failure is counted for it (`internal/gateway/routing.go`), and the last member left keeps its usual same-member retries — the agent hears of it only after those run out.
- Other plugin errors keep today's classification exactly: a plugin that is wrong in a lasting way still rests and still fails the turn (`TestPluginCutShortLeavesOtherErrorsAlone`).

## Red before the fix

Base `e4ac5e87`, tests `TestPluginCutShortIsRetriedNotRested` / `TestPluginCutShortEveryMemberCutEndsTheTurn` (`internal/gateway/plugin_cutshort_test.go`, fake upstream answering the plugin's cut-short contract):

- before the fix, the failing account is tried once, gets the 60 s backoff, and its mate answers;
- with the fix, the same member answers on its second try and nobody rests; when every member cuts, the turn ends with nobody rested.

Ablation: with the serve branch short-circuited and the tests kept, the first two tests fail again; restored, green. The classification, the counting and the rest exemption each sit in the diff hunks shown above.

## Verification

| Check | Result |
| --- | --- |
| `go test -tags nogui -count=1 -run TestPluginCutShort ./internal/gateway/` | ok |
| `go test -tags nogui -count=1 ./internal/gateway/` (full package) | ok, ~316s |
| `go test -race -tags nogui` targeted family | ok |
| `gofmt -l internal/gateway/` | empty |
| `go vet -tags nogui ./internal/gateway/` darwin / linux / windows | clean |
| builds darwin, windows; gateway package for linux | ok (a full linux binary still fails in the wails GUI dependency, as on the unfixed base) |

## Siblings

The classification sits beside the word lists that decide retryable failures (a sibling change of mine adds a vendor "model not served here" set on #2887); `answersNothing` and the empty-reply gates (#2972's void) are different failures and are untouched. Plugins other than the two named send no such wording and behave as before.

## Not verified

- No real Trae CN account: the error's shape is quoted from the plugin's source (`CUT_SHORT` branch) as the issue quotes it, and the fake delivers it the same way.
- Whether a cut that repeats immediately (a vendor dying on every try) behaves well under the same-member retry is covered only by `TestPluginCutShortEveryMemberCutEndsTheTurn`'s shape, not by a real dead upstream.

**AI**: written with an AI coding agent; I've read the whole diff and can answer questions on it myself. The model name is in the commit's trailer.

**Attribution**: If you apply the patch, please keep its author (ggbdpq) or add a `Co-authored-by: ggbdpq <ggbdpq@gmail.com>` line.

<details><summary>patch: gateway: a plugin's cut-short tool call is retried, not rested for a minute (#2873) — git am applies it as is; SHA-256 first 16: ed7e527385eb8911</summary>

```patch
From 89f9d8c14647da83c228aeab9eefa705d244f7f0 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Tue, 20 Oct 2026 02:12:28 +0800
Subject: [PATCH] gateway: a plugin's cut-short tool call is retried, not
 rested for a minute (#2873)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

A plugin that reads a model's text-form tool calls ends a turn whose
upstream stream died mid-call as a failure, so the gateway can act
(magpie-community/plugins#38: the turn ends as an error "the gateway can
retry or fail over"). The gateway did neither: the error was classified
as an unknown failure, the account was rested for a minute of backoff,
and the failure was passed to the client — the retry the plugin
engineered never happened, and the user's next attempt met the backoff
too (#2873's routing record: status 200, usage null, fail "other",
rest "backoff", 60s).

What changed: the contract's own error wording ("the model's tool call,
written as text, was cut short", shared by the plugins that read
text-form calls — packages/trae, packages/qoder's CUT_SHORT) is
classified as a failure of its own, "cut". Nobody rests for it and no
failure is counted: the same member is asked again once — the plugin's
parser reads the same but the cut doesn't come again — then the next
member as any failure's is; the last member left keeps its usual
same-member retries, and the agent is told only after the retries run
out.

Why: a cut is transient and nobody's fault — the account is as good as
it was, and a minute of backoff only pushed the user's next attempt off
the same account the plugin had proven works.

Run: the new tests (plugin_cutshort_test.go) fail on the unfixed tree —
the failing account is tried once, rested, and its mate answers; with
the fix the same member answers on its second try, nobody rests, and
every member cutting still ends the turn with nobody rested. Full
gateway package green (316s), targeted family green under -race, vet
and gofmt clean, builds fine on darwin and windows; the linux
cross-build fails in the wails GUI dependency exactly as it does on the
unfixed base (needs a native linux build), and the gateway package
itself builds for linux.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/continuation.go         |   6 ++
 internal/gateway/gateway.go              |  25 +++++
 internal/gateway/plugin_cutshort_test.go | 127 +++++++++++++++++++++++
 internal/gateway/routing.go              |  26 +++++
 4 files changed, 184 insertions(+)
 create mode 100644 internal/gateway/plugin_cutshort_test.go

diff --git a/internal/gateway/continuation.go b/internal/gateway/continuation.go
index 5ffabace..1a22cca9 100644
--- a/internal/gateway/continuation.go
+++ b/internal/gateway/continuation.go
@@ -53,6 +53,12 @@ func emptyRetries(w http.ResponseWriter, ctx context.Context) int {
 // than ended with the loop's error.
 const loopReasks = 1
 
+// cutReasks is how many times a try a plugin ended on its upstream's
+// stream dying mid-call (plugins#38) is asked again where it stood, before
+// the next member is (#2873): the parser reads the same, the cut doesn't
+// come again.
+const cutReasks = 1
+
 // errStreamCut ends a reply's read once its error event is in hand,
 // without waiting on a vendor that keeps the connection open after it.
 var errStreamCut = errors.New("stream cut mid-reply")
diff --git a/internal/gateway/gateway.go b/internal/gateway/gateway.go
index b42a6779..11a4d29f 100644
--- a/internal/gateway/gateway.go
+++ b/internal/gateway/gateway.go
@@ -2305,6 +2305,9 @@ func (s *Server) serve(w http.ResponseWriter, r *http.Request, from provider.Pro
 	// asked again (loopReasks); reasked, the times a translated one was
 	// asked again in place, tries the route doesn't list (#2436)
 	reloops, reasked := 0, 0
+	// the try whose plugin ended the turn on its upstream's stream dying
+	// mid-call (plugins#38), asked again where it stood (cutReasks, #2873)
+	cuts := 0
 	// ended is when the last try's reply ended: the request's ms end there,
 	// not after what magpie writes down of it once it has (#1939: sticks
 	// and the provider's last answer, saved to disk, took seconds on a busy
@@ -3233,6 +3236,28 @@ func (s *Server) serve(w http.ResponseWriter, r *http.Request, from provider.Pro
 				continue
 			}
 		}
+		if !last && hw.failed() && failure(hw.code(), hw.errBody()) == failCut {
+			// a plugin ended the turn on purpose, its upstream's stream
+			// having died mid-call (plugins#38: "the gateway can retry or
+			// fail over"). Nobody rests: the parser reads the same but the
+			// cut doesn't come again, so the same one is asked again once,
+			// then the next member as any failure's is (#2873)
+			try.Fail = failCut
+			if other == nil {
+				other = &Try{Status: call.Status, Error: call.Error}
+			}
+			s.trace.update(tr, func(t *Route) { t.Tries[len(t.Tries)-1] = try })
+			skipped = append(skipped, c.label()+": "+call.Error)
+			if cuts < cutReasks {
+				cuts++
+				select {
+				case <-time.After(retryPause):
+				case <-r.Context().Done():
+				}
+				i--
+			}
+			continue
+		}
 		if !last && hw.failed() {
 			if f := failure(hw.code(), hw.errBody()); other == nil && f != failQuota && f != failCredit {
 				other = &Try{Status: call.Status, Error: call.Error}
diff --git a/internal/gateway/plugin_cutshort_test.go b/internal/gateway/plugin_cutshort_test.go
new file mode 100644
index 00000000..a1ddf66b
--- /dev/null
+++ b/internal/gateway/plugin_cutshort_test.go
@@ -0,0 +1,127 @@
+package gateway
+
+import (
+	"strings"
+	"testing"
+
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// A plugin that reads a model's text-form tool calls ends a turn whose
+// stream died mid-call as a failure, so the gateway retries or fails over
+// (magpie-community/plugins#38, #2873): a 200 whose stream stops with an
+// error event, the call it was reading unsent. The words are the
+// contract's own, shared by the plugins that read text-form calls
+// (packages/trae, packages/qoder's CUT_SHORT).
+const cutShortSaid = "Trae CN: the model's tool call, written as text, was cut short; it is not sent on as the answer"
+
+var cutShortStream = sse(
+	`data: {"id":"c","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}`,
+	`data: {"error":{"message":"`+cutShortSaid+`","type":"api_error","code":null}}`,
+	`data: [DONE]`)
+
+func chatStreamSaid(said string) string {
+	return sse(
+		`data: {"id":"c","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"`+said+`"},"finish_reason":"stop"}]}`,
+		`data: [DONE]`)
+}
+
+// A plugin account whose upstream cut the call short mid-stream is asked
+// again — the parser reads the same, the cut doesn't come again — and its
+// second answer is the reply; the next member isn't needed, and nobody
+// rests: the account did nothing wrong a minute of backoff would mend
+// (#2873: the routing record showed fail "other" and a 60s backoff, and
+// the retry the plugin engineered never happened).
+func TestPluginCutShortIsRetriedNotRested(t *testing.T) {
+	fresh(t)
+	a := &scripted{replies: []reply{
+		{200, "text/event-stream", cutShortStream},
+		{200, "text/event-stream", chatStreamSaid("from a")},
+	}}
+	b := &scripted{replies: []reply{{200, "text/event-stream", chatStreamSaid("from b")}}}
+	scriptedOn(t, "a", provider.Chat, a)
+	scriptedOn(t, "b", provider.Chat, b)
+	if err := provider.SaveGroup(provider.Group{Name: "G", Members: []string{"a/m", "b/m"}, Routing: provider.Ordered}); err != nil {
+		t.Fatal(err)
+	}
+	s := New()
+	code, body := postAs(t, s, "", `{"model":"group/g","stream":true,"messages":[{"role":"user","content":"hi"}]}`)
+	if code != 200 || !strings.Contains(body, "from a") || strings.Contains(body, "from b") || a.n != 2 || b.n != 0 {
+		t.Fatalf("%d %s (a %d, b %d)", code, body, a.n, b.n)
+	}
+	r := s.trace.routes[len(s.trace.routes)-1]
+	if len(r.Tries) != 2 || r.Tries[0].Fail != failCut || r.Tries[0].Rest != nil || r.Tries[1].Status != 200 {
+		t.Fatalf("tries: %+v", r.Tries)
+	}
+	if s.resting("a") || s.resting("b") || len(routed.failures) != 0 {
+		t.Fatalf("a cut is nobody's fault: a resting %v, b %v, failures %v", s.resting("a"), s.resting("b"), routed.failures)
+	}
+
+	// the next request finds the account as good as it was: asked first
+	// again, and answering
+	code, body = postAs(t, s, "", `{"model":"group/g","stream":true,"messages":[{"role":"user","content":"hi"}]}`)
+	if code != 200 || !strings.Contains(body, "from a") || b.n != 0 {
+		t.Fatalf("next request: %d %s (a %d, b %d)", code, body, a.n, b.n)
+	}
+}
+
+// Every member's stream may cut, and the turn still ends: the same one is
+// asked again once, the members after it as any failure's are, and the
+// agent is told after the retries run out — with nobody resting, so the
+// user's next attempt isn't met by a minute of backoff (#2873).
+func TestPluginCutShortEveryMemberCutEndsTheTurn(t *testing.T) {
+	fresh(t)
+	a := &scripted{replies: []reply{{200, "text/event-stream", cutShortStream}}}
+	b := &scripted{replies: []reply{{200, "text/event-stream", cutShortStream}}}
+	scriptedOn(t, "a", provider.Chat, a)
+	scriptedOn(t, "b", provider.Chat, b)
+	if err := provider.SaveGroup(provider.Group{Name: "G", Members: []string{"a/m", "b/m"}, Routing: provider.Ordered}); err != nil {
+		t.Fatal(err)
+	}
+	s := New()
+	code, body := postAs(t, s, "", `{"model":"group/g","stream":true,"messages":[{"role":"user","content":"hi"}]}`)
+	// a streaming agent is told of the failure as its stream's error event
+	if code != 200 || !strings.Contains(body, "cut short") {
+		t.Fatalf("%d %s", code, body)
+	}
+	if a.n != 2 || b.n != 1+lastRetries {
+		t.Fatalf("a asked %d, b %d", a.n, b.n)
+	}
+	r := s.trace.routes[len(s.trace.routes)-1]
+	if s.resting("a") || s.resting("b") || len(routed.failures) != 0 {
+		t.Fatalf("nobody rests for a cut: a %v, b %v, failures %v", s.resting("a"), s.resting("b"), routed.failures)
+	}
+	for i, try := range r.Tries {
+		if try.Rest != nil {
+			t.Fatalf("try %d rested: %+v", i, try)
+		}
+	}
+}
+
+// A plugin's other errors keep their own lanes: the contract's unreadable
+// call (#2414), a model its vendor doesn't serve, a sign-in it turned
+// away — none is a cut, and each rests or fails over as it did.
+func TestPluginCutShortLeavesOtherErrorsAlone(t *testing.T) {
+	for _, x := range []struct {
+		status int
+		body   string
+		want   string
+	}{
+		// the contract's UNREADABLE: the block is whole but can't be read
+		// — the model's doing, told apart from a stream that died
+		{502, `{"error":{"message":"Trae CN: the model's tool call, written as text, can't be read; it is not sent on as the answer","type":"api_error"}}`, failOther},
+		// a plugin whose vendor doesn't serve the model asked for
+		{400, `{"error":{"message":"the model fake-x does not exist"}}`, failOther},
+		// a sign-in its vendor turned away
+		{401, `{"error":{"message":"token expired"}}`, failOther},
+		// the vendor's own cut-short words, a reply of its own kind
+		{502, `{"error":{"message":"upstream connect error"}}`, failOther},
+	} {
+		if got := failure(x.status, []byte(x.body)); got != x.want {
+			t.Errorf("failure(%d, %s) = %s, want %s", x.status, x.body, got, x.want)
+		}
+	}
+	if got := failure(502, []byte(`{"error":{"message":"`+cutShortSaid+`"}}`)); got != failCut {
+		t.Errorf("the contract's cut-short error is %s, want %s", got, failCut)
+	}
+}
diff --git a/internal/gateway/routing.go b/internal/gateway/routing.go
index 6929fdd8..3901df58 100644
--- a/internal/gateway/routing.go
+++ b/internal/gateway/routing.go
@@ -239,6 +239,13 @@ var (
 	// RESOURCE_EXHAUSTED. A 5xx's words don't: a relay's 500 "当前模型 …
 	// 负载已经达到上限，请稍后重试" is its load's limit, not the plan's (#1418).
 	quotaCodes = regexp.MustCompile(`(?i)limit reached\|\d{10}\b|usage_limit_reached|RESOURCE_EXHAUSTED`)
+	// cutWords: a plugin's own error for the turn its upstream's stream
+	// died mid-call: the model wrote its tool call as text, the text
+	// stopped before the call was whole, and the plugin ends the turn as a
+	// failure "the gateway can retry or fail over" — its words, shared by
+	// the plugins that read text-form calls (magpie-community/plugins#38,
+	// packages/trae and packages/qoder's CUT_SHORT; #2873)
+	cutWords = regexp.MustCompile(`(?i)tool call, written as text, was cut short`)
 )
 
 // Why a candidate failed, as rest tells it.
@@ -298,6 +305,12 @@ const (
 	// 403 11140, "账号存在异常行为，已被限制使用", #1849) — the next is
 	// asked, and it rests restrictedRest, until the vendor lifts it
 	failRestricted = "restricted"
+	// failCut: a plugin ended the turn on purpose — its upstream's stream
+	// died mid-call, and the tool call it was reading, written as text,
+	// can't go on as the answer (plugins#38: the turn ends as an error
+	// "the gateway can retry or fail over"). The cut isn't the account's
+	// doing: the request is asked again, and nobody rests (#2873)
+	failCut = "cut"
 )
 
 // loopErrType is the usage log's ErrType for a reply ended for looping
@@ -357,6 +370,13 @@ func failure(status int, body []byte) string {
 	// the words are matched decoded, too
 	body = wordsOf(body)
 	switch {
+	case cutWords.Match(body):
+		// a plugin ended the turn on purpose: its upstream's stream died
+		// mid-call, and the call it was reading isn't the answer
+		// (plugins#38). The cut is transient and nobody's fault — the next
+		// answer mostly isn't one — so the request is asked again, and
+		// nobody rests (#2873)
+		return failCut
 	case restrictedSaid(status, body):
 		return failRestricted
 	case overflowed(status, body):
@@ -814,6 +834,12 @@ func (s *Server) restAfterMarked(c candidate, status int, header http.Header, bo
 	now := time.Now()
 	d := fallbackCooldown
 	why := failureOf(c, status, body)
+	if why == failCut {
+		// a plugin ended the turn on purpose, its upstream's stream having
+		// died mid-call (plugins#38): the account is as good as it was, the
+		// request is asked again, and no rest and no failure counted (#2873)
+		return Rest{Why: why, Status: status, By: "off", Until: now}
+	}
 	if header.Get(zdrHeader) != "" || zdrRefused(status, body) {
 		// Command Code's Zero Data Retention setting refused the request:
 		// the model and the account are as good as they were, and answer
-- 
2.50.1 (Apple Git-155)

```

</details>
