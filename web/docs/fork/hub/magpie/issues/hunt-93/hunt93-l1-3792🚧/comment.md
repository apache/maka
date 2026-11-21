When the loop guard ends a reply stuck in a loop, the cut's error began a message of its own instead of ending the one already going (#3792, reported by JoeyWu-tech and confirmed live): on the Chat protocol the error was preceded by a chunk with an id magpie had made up (`"id":"chatcmpl-…","model":""`) right after the vendor's own chunks, on Anthropic a second `message_start` began, on Responses a second `response.created` did. A client that reads each chunk's identity stops at the stranger's message as a conflict and never learns why the reply ended — the stream just dies at the cut.

Minimal reproduction: stream a reply that repeats itself until the loop guard trips it, on any of the agents' protocols, and read the tail of the stream the agent got. The new test below does exactly this against a looping vendor on all four protocols (`chat`, `anthropic`, `responses`, `gemini` over `loopAsks`); before the fix the chat case saw two ids in one stream and `"model":""`, the anthropic case two `message_start`s, the responses case two `response.created`s.

Root cause: `cutLoop` (internal/gateway/fallback.go) wrote its error with `streamError`, which builds a fresh protocol encoder — and every encoder's `event` entry begins a message when none was begun (`if ev.Kind != KStart && !e.started { e.start(Event{}) }`, chat.go/anthropic.go/responses.go/gemini.go). The error event alone would have been fine; the implicit `start` is what minted a fresh id (magpie's `newID`, since no identity reaches it) with an empty model and opened a second message mid-stream.

The fix writes the cut's error as one event of the reply already going, the event alone: `streamFailure(proto, saysPassing(http.StatusBadGateway, msg))`. `streamFailure` is the shape a vendor's own mid-reply error takes in each protocol — no id, no model, bare error — and it is already what the passthrough's mid-reply cut ends a stream with (gateway.go, next to `cutMidReply`). `saysPassing` keeps the "(502: you can retry your request)" wording the old path put in the text. Errors before any reply began keep `streamError`: there a message of its own is the point (see Siblings).

Verification (macOS, go1.25.5, at head `19572499`):

| Check | Result |
| --- | --- |
| `go test ./internal/gateway/ -run TestLoopCutsErrorDoesntStartAMessage` (new, four subtests) | ok 0.18s, exit 0 |
| the same with only `fallback.go` restored (fix reverted, test kept) | red, three subtests: chat `"the cut's error began a message of its own, with no model"` (`"id":"chatcmpl-18e2…","model":""` in the tail), anthropic the same plus a second `message_start` visible, responses the same plus `"id":"resp_18e2…","model":""` `response.failed`; gemini passed before and after (its old path already wrote the bare error object) |
| the other ten tests of `loop_guard_test.go` | ok 7.9s, exit 0 |
| `go test -count=1 ./internal/gateway/` full package | ok 533.331s, exit 0 |
| `go test -race -run 'TestLoop\|TestReasoningLoop' ./internal/gateway/` | ok 83.129s, exit 0 |
| `gofmt -l internal/gateway/` | clean |
| `go vet -tags nogui ./internal/gateway/` darwin, `GOOS=linux`, `GOOS=windows` | exit 0 each |
| `go build -tags nogui ./...` darwin, `GOOS=linux`, `GOOS=windows` | ok each |
| `go test -tags nogui ./...` full tree | gateway and 70 packages ok; `agent`, `gui`, `provider`, `usage` red on this machine with the change and without it — usage's `TestUsageReadAfterAppendHashesNothingOnAFineClock` re-run red on the clean baseline (a fine-clock test this sandbox's clock fails), the rest dialing ports and processes this sandbox refuses; none of them gateway's |

## Source

Found in the issue's captured stream, reported by JoeyWu-tech in #3792: after the loop guard cut a looping reply, the agent's client stopped at the cut's chunk as an identity conflict — a message begun by magpie (fresh id, empty model) following the message the vendor had begun — instead of reading the error and saying why the reply ended.

## Red without the fix

```
=== RUN   TestLoopCutsErrorDoesntStartAMessage/chat
    loop_guard_test.go:471: the cut's error began a message of its own, with no model:
        ...,"created":1793053306,"id":"chatcmpl-18e2347b6fe1af9000000001","model":"","object":"chat.completion.chunk","usage":null}
        data: {"error":{"message":"magpie ended this reply: the model's reasoning was stuck in a loop, ...
=== RUN   TestLoopCutsErrorDoesntStartAMessage/anthropic
    loop_guard_test.go:471: the cut's error began a message of its own, with no model:
        ,"stop_sequence":null,"type":"message","usage":{"input_tokens":0,...}},"type":"message_start"}
        event: error
=== RUN   TestLoopCutsErrorDoesntStartAMessage/responses
    loop_guard_test.go:471: the cut's error began a message of its own, with no model:
        ...,"id":"resp_18e2347b7268142000000004","model":"","object":"response","status":"failed",...,"type":"response.failed"}
--- FAIL: TestLoopCutsErrorDoesntStartAMessage (0.18s)
```

Restoring the fix went green on all four. The full-suite reds above are this sandbox's, present on the clean baseline `eee57199` the same way; nothing of them touches the gateway.

## Siblings

`rg streamError|streamFailure` over internal/gateway: `streamError`'s three other callers stay as they are, for in each the reply has not begun — `failTo` (gateway.go) answers after only keepalive comments, `failWith` (codex_backend.go) is "a failure before any reply" by its own comment, and `release` (fallback.go) sends a held failure the agent has seen nothing of — so there the error must begin a message to be a well-formed reply at all, which is exactly what `streamError`'s encoder does. `streamFailure`'s other caller is the passthrough's mid-reply cut (gateway.go), the precedent this fix follows; no other site ends a begun stream. The reloop path (`mayReloop`/`letGoLoop`) is untouched: it ends a Chat-only passing stream before the guard's cut and its shape is unchanged, and `TestReasoningLoopIsAskedAgain` and `TestLoopAfterTextIsNotAskedAgain` hold.

## Not verified

No real strict client (the reporter's) against a real looping vendor — the identity-conflict stop is the report's own account, reproduced here at the byte level by the new test; fx's exact `ConflictingIdentity` wording is quoted from the issue, not re-run. Gemini's agents see no change from this fix (its old path already wrote the event alone), asserted by the test but not by a before/after diff of a real Gemini stream.

Branch with the commit: [hunt93-l1-3792-stream-error](https://github.com/ggbdpq/magpie/tree/hunt93-l1-3792-stream-error) (head `19572499`) (branch not pushed yet — will push on approval).

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>.`

**Patch**: <details><summary>patch: gateway: a loop cut's error is an event of the reply going, not a message of its own (#3792) — git am applies it as is; SHA-256 first 16: 68d7ea623e422e80</summary>

```patch
From 19572499d7716f2b966797487d292e1e56ef4c03 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Tue, 27 Oct 2026 06:35:18 +0800
Subject: [PATCH] gateway: a loop cut's error is an event of the reply going,
 not a message of its own
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

cutLoop ended a reply found stuck in a loop with streamError, whose
fresh encoder begins a message of its own first: a Chat chunk with an
id magpie made up (chatcmpl-...) and "model":"" followed the vendor's
own chunks, an Anthropic message_start and a Responses
response.created began a message again with none of the reply's
identity. A client that reads each chunk's identity stops at the
stranger's message and never learns why the reply ended (#3792). The
cut's error is now one event of the reply already going, the event
alone, written with streamFailure — the shape a vendor's own
mid-reply error takes, as the passthrough's cut ends one already.
An error before a reply began (failTo, failWith, release) keeps
streamError: there a message of its own is the point.

Run at this head (macOS, go1.25.5):
- TestLoopCutsErrorDoesntStartAMessage (new; the four agents'
  protocols over loopAsks): on the old code red — chat's cut carried
  a second id (chatcmpl-18e2...) and "model":""", Anthropic began its
  message a second time, Responses created a second response;
  Gemini's own error shape was already the event alone, and passed
  before and after. Green after, all four.
- The other ten tests of loop_guard_test.go: ok.
- go test -count=1 ./internal/gateway: ok.
- go test -race -run 'TestLoop|TestReasoningLoop'
  ./internal/gateway: ok.
- gofmt -l internal/gateway: clean; go vet -tags nogui
  ./internal/gateway on darwin, GOOS=linux and GOOS=windows: ok.
- go build -tags nogui ./... on darwin, GOOS=linux and GOOS=windows:
  ok.
- go test -tags nogui ./...: gateway and 70 packages ok; four red on
  this machine with the change and without it (usage's
  TestUsageReadAfterAppendHashesNothingOnAFineClock re-run on the
  clean baseline, red the same; agent, gui and provider dialing
  ports and processes this sandbox refuses). None of them gateway's.

Not tried: a real strict client against a real looping vendor.

Fixes #3792

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/fallback.go        |  7 ++++-
 internal/gateway/loop_guard_test.go | 49 +++++++++++++++++++++++++++++
 2 files changed, 55 insertions(+), 1 deletion(-)

diff --git a/internal/gateway/fallback.go b/internal/gateway/fallback.go
index 6ae086e3..8a3957fc 100644
--- a/internal/gateway/fallback.go
+++ b/internal/gateway/fallback.go
@@ -1936,7 +1936,12 @@ func (h *holdWriter) cutLoop(b []byte, t loopTrip) (int, error) {
 	} else {
 		io.WriteString(h.w, "\n\n")
 	}
-	streamError(h.w, proto, http.StatusBadGateway, msg)
+	// the error is an event of the reply already going, the event alone, as
+	// a vendor's own mid-reply error is (streamFailure): an error that
+	// began a message of its own — a fresh id, no model, none of the
+	// reply's identity known here — has a client that reads each chunk's
+	// identity stop at it and never learn why the reply ended (#3792)
+	h.w.Write(streamFailure(proto, saysPassing(http.StatusBadGateway, msg)))
 	h.looped, h.ended = msg, true
 	h.flush()
 	if h.stop != nil {
diff --git a/internal/gateway/loop_guard_test.go b/internal/gateway/loop_guard_test.go
index 9a34bb6e..2895c199 100644
--- a/internal/gateway/loop_guard_test.go
+++ b/internal/gateway/loop_guard_test.go
@@ -7,11 +7,13 @@ import (
 	"encoding/json"
 	"fmt"
 	"io"
+	"maps"
 	"math/rand"
 	"net/http"
 	"net/http/httptest"
 	"os"
 	"path/filepath"
+	"slices"
 	"strings"
 	"sync/atomic"
 	"testing"
@@ -451,6 +453,53 @@ func TestLoopEndsTheReplyOnEveryProtocol(t *testing.T) {
 	}
 }
 
+// The loop cut's error ends a reply the agent already has (#3792): it is
+// an event of the message going, not a message of its own — one begun with
+// an id and a model of magpie's has a client that reads each chunk's
+// identity stop at it (fx's ConflictingIdentity) and never learn why the
+// reply ended.
+func TestLoopCutsErrorDoesntStartAMessage(t *testing.T) {
+	for _, x := range loopAsks {
+		t.Run(x.name, func(t *testing.T) {
+			v := &loopingVendor{letGo: make(chan bool, 4)}
+			gw := deepseekOn(t, v)
+			got := askStream(t, gw+x.path, x.body)
+			if !strings.Contains(got, "stuck in a loop") {
+				t.Fatalf("the reply wasn't cut:\n%s", got[max(len(got)-800, 0):])
+			}
+			if strings.Contains(got, `"model":""`) {
+				t.Fatalf("the cut's error began a message of its own, with no model:\n%s", got[max(len(got)-600, 0):])
+			}
+			switch x.name {
+			case "chat":
+				// the error joins the reply already going: every chunk the
+				// agent reads carries the id the vendor began it with
+				ids := map[string]bool{}
+				readSSE(strings.NewReader(got), func(_, data string) error {
+					var id struct {
+						ID string `json:"id"`
+					}
+					if json.Unmarshal([]byte(data), &id) == nil && id.ID != "" {
+						ids[id.ID] = true
+					}
+					return nil
+				})
+				if len(ids) != 1 {
+					t.Fatalf("the stream's chunks carry %d ids (%v), want the vendor's one", len(ids), slices.Sorted(maps.Keys(ids)))
+				}
+			case "anthropic":
+				if n := strings.Count(got, "event: message_start"); n != 1 {
+					t.Fatalf("the stream began its message %d times, want once", n)
+				}
+			case "responses":
+				if n := strings.Count(got, "event: response.created"); n != 1 {
+					t.Fatalf("the stream began its response %d times, want once", n)
+				}
+			}
+		})
+	}
+}
+
 // loopCut checks what the agent got of a looping reply, got, and what came
 // of it: the stream's error, not its end (done); the vendor asked asks
 // times and let go each time; nobody resting; the usage record's
-- 
2.50.1 (Apple Git-155)

```

</details>
