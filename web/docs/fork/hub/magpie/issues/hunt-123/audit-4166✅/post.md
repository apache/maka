I took this and built your option 2 (the lead frames) as a prototype — and the prototype **hit the exact constraint you flagged**, so I've reverted it and left the pair on the branch as working evidence. No fix from me; the shape the real fix needs is below. Credit @waynesguan for the measured timelines (3.5s direct vs 14.7s through the group, 161 deltas vs 94 at one instant) and for the three options with the trade-offs already thought through.

**The prototype** (commit `e0a0ec795`, on the branch with its revert on top): at the first reasoning event of a held stream, `leadThinking` sends the reply's own `message_start` and an empty thinking block's start — no words — through the agent's stream; the thinking stays held (#248); Anthropic's stream only. My new test passed: the agent sees "thinking" begin at 3.2s, no words went through, and a refusal still fails the try over.

**What the full suite caught** (`TestHeldThinkingKeepsTheAgentAlive`, the #248/#5075 failover family): when the refusal **does** come and the next member answers in the same stream, the agent then receives **a second `message_start` and a second block at index 0** — my lead frames sat ahead of them, and the two replies no longer splice. The handover machinery (`refusalHandover.track`) counts blocks begun so the next member's frames can follow — but a lead frame written outside the try's event flow isn't in that ledger, and "message_start once per stream" is one of the invariants the join relies on. The test's name is the contract: one reply in the stream.

**So option 2's real shape** is bigger than the frames: the lead frames must join the handover protocol — `refusalHandover.track` counting them, the next member's `message_start` swallowed, its block indexes offset past the lead block, and the lead thinking block closed (or its deltas spliced) when the next member's reply begins. All doable — the machinery is there (`blocks`/`open`/`spoke`) — but it is a change to the failover join's protocol, not a frame or two, and that's the maintainer's call to make on #248's core path.

**The other two options stand as filed**: the group-level switch (1) is config plus one branch in `holdsThinking`; option 3 (same-family members skip the hold) reads `refusesAfterThinking`'s own model list. Both leave the failover protocol untouched.

The branch carries the prototype and the revert (`e0a0ec795` → `4a968ff9f`), the test for the lead behavior (green under the prototype, removed with it), and the full suite green again at the tip.

**Not verified:** no two-member group with real accounts here — the failover collision is the suite's test, which is exactly what caught it; the splice-extension shape (track + offset + swallow) is designed, not prototyped.

<details><summary>prototype + revert, for the record — git am applies both as is; SHA-256 first 16: be28bafb5b91a8b4</summary>

```patch
From e0a0ec795776d69c08a91c0085c7c7d5c7ae3ec0 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 4 Nov 2026 08:33:23 +0800
Subject: [PATCH 1/2] gateway: a held thinking tells the agent it is thinking
 (#4166)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

A group's held stream kept its thinking to itself until the answer came:
Claude Code's "thinking with max effort" line lasted no time at all,
and the whole thought landed minutes in, at once — every routed request
paid the model's whole thinking time before its first byte, though the
upstream and the routing were fast (#248's hold doing what it says).

While the thinking is held for a refusal after it, the stream now tells
the agent that it is thinking: the try's message_start and an empty
thinking block's start go out at the first reasoning, the model the
agent asked. No word of the try rides them, so a refusal still hands
the turn to the next member, whose reply follows these frames whole —
#248's guarantee that an agent never sees half of one reply and half of
another. Anthropic's stream only: Chat's first chunk and Responses'
response.created already go out with the keepalives, and a Gemini
stream takes no extra frames. Once a stream, never twice (keptAlive.lead).

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/fallback.go                  | 35 +++++++++++++
 internal/gateway/thinking_lead_frames_test.go | 52 +++++++++++++++++++
 2 files changed, 87 insertions(+)
 create mode 100644 internal/gateway/thinking_lead_frames_test.go

diff --git a/internal/gateway/fallback.go b/internal/gateway/fallback.go
index 3ea109f68..5cf0c39d0 100644
--- a/internal/gateway/fallback.go
+++ b/internal/gateway/fallback.go
@@ -2720,6 +2720,7 @@ func (h *holdWriter) scan() {
 				return
 			}
 			h.thinking = true
+			h.leadThinking()
 			continue
 		case eventError, eventRefusalError:
 			h.failure, h.failMsg = status, msg
@@ -2819,6 +2820,9 @@ type keptAlive struct {
 	// Only opted-in Claude cache reporting can defer initial keepalives.
 	// Selection releases it before process startup; expiry keeps the stream alive.
 	cacheReportUntil time.Time
+	// lead, whether the thinking's own opening frames went out (#4166):
+	// once a stream, never twice.
+	lead bool
 }
 
 // agentQuietMost is the longest a streaming Responses agent goes with no
@@ -2856,6 +2860,37 @@ func (a *keptAlive) tooQuiet(d time.Duration) bool {
 // idle timeout for a reasoning model, 240s, ended the turn first (#751). A
 // comment is no event in any protocol, so another account may still answer
 // after it, its stream going on in the same response (pass).
+// leadThinking tells the agent's stream that the try is thinking before
+// any of the thinking is given: the reply's own message_start (the model
+// the agent asked, as streamError names it) and an empty thinking block's
+// start, none of the try's words (#4166). An agent's "thinking with …
+// effort" line comes from those two frames; the thinking itself stays
+// held for a refusal after it (#248), and the next member's reply, when
+// one is asked for, follows these frames whole — a frame that says
+// nothing of the try's answer doesn't give the agent half of one reply
+// and half of another. Anthropic's stream only: Chat's first chunk and
+// Responses' response.created go out with the keepalives already, and a
+// Gemini stream takes no comment and no extra frames.
+func (h *holdWriter) leadThinking() {
+	a := h.alive
+	if a == nil || a.proto != provider.Anthropic || !h.stream || a.lead {
+		return
+	}
+	a.lead = true
+	if !a.sent {
+		h.keepAlive() // the 200 and the headers go first
+	}
+	sw := newSSEWriter(h.w)
+	sw.begun = true
+	model := a.model
+	ev := Event{Model: model}
+	e := &anthropicEncoder{w: sw, model: model}
+	e.start(ev)
+	e.openBlock(Thinking, map[string]any{"thinking": "", "signature": ""})
+	h.flush()
+	a.at = time.Now()
+}
+
 func (h *holdWriter) keepAlive() {
 	a := h.alive
 	// a Gemini stream has none, as geminiEncoder.keepalive: agy fails on
diff --git a/internal/gateway/thinking_lead_frames_test.go b/internal/gateway/thinking_lead_frames_test.go
new file mode 100644
index 000000000..92a627825
--- /dev/null
+++ b/internal/gateway/thinking_lead_frames_test.go
@@ -0,0 +1,52 @@
+package gateway
+
+import (
+	"net/http"
+	"net/http/httptest"
+	"strings"
+	"testing"
+
+	"github.com/yetone/magpie/internal/provider"
+	"time"
+)
+
+// A group's held stream kept its thinking to itself until the answer came,
+// so an agent's "thinking with max effort" line lasted no time at all and
+// the whole thought landed at once, minutes in (#4166). Held for a refusal
+// after it, the stream may still tell the agent *that* it is thinking —
+// the frames that say so carry none of the try's words, so the next
+// member's reply can still follow them whole (#248's guarantee kept).
+func TestHeldThinkingTellsTheAgentItIsThinking(t *testing.T) {
+	events := strings.SplitAfter(anthropicThoughtThenRefused, "\n\n")
+	w := httptest.NewRecorder()
+	h := newHoldWriter(w, true)
+	h.Header().Set("Content-Type", "text/event-stream")
+	h.WriteHeader(http.StatusOK)
+	alive := &keptAlive{proto: provider.Anthropic, model: "group/g", told: time.Now(), streams: true}
+	h.alive = alive
+	h.stream = true
+
+	// the try's message_start and the thinking block's start go by; the
+	// thinking is held (a refusal may still end it, #248)
+	h.Write([]byte(events[0] + events[1]))
+	body := w.Body.String()
+	if !strings.Contains(body, `"message_start"`) {
+		t.Fatal("the agent has no message_start while the try is held")
+	}
+	if !strings.Contains(body, `"content_block_start"`) || !strings.Contains(body, `"thinking"`) {
+		t.Fatal("the agent has no thinking block start while the try is held")
+	}
+	if strings.Contains(body, "The user wants a plan for") {
+		t.Fatal("the thinking's words went through before the answer did")
+	}
+
+	// the refusal ends the try as before: the next member answers, and
+	// nothing of this try's reply preceded it
+	for _, ev := range events[2:] {
+		h.Write([]byte(ev))
+	}
+	h.settle()
+	if h.passing || !h.refused {
+		t.Fatalf("refusal after thinking: passing %v refused %v", h.passing, h.refused)
+	}
+}
-- 
2.50.1 (Apple Git-155)


From 4a968ff9f052dd9d7d22f4306f33976a8e8c1523 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 4 Nov 2026 08:46:02 +0800
Subject: [PATCH 2/2] Revert "gateway: a held thinking tells the agent it is
 thinking (#4166)"

This reverts commit e0a0ec795776d69c08a91c0085c7c7d5c7ae3ec0.
---
 internal/gateway/fallback.go                  | 35 -------------
 internal/gateway/thinking_lead_frames_test.go | 52 -------------------
 2 files changed, 87 deletions(-)
 delete mode 100644 internal/gateway/thinking_lead_frames_test.go

diff --git a/internal/gateway/fallback.go b/internal/gateway/fallback.go
index 5cf0c39d0..3ea109f68 100644
--- a/internal/gateway/fallback.go
+++ b/internal/gateway/fallback.go
@@ -2720,7 +2720,6 @@ func (h *holdWriter) scan() {
 				return
 			}
 			h.thinking = true
-			h.leadThinking()
 			continue
 		case eventError, eventRefusalError:
 			h.failure, h.failMsg = status, msg
@@ -2820,9 +2819,6 @@ type keptAlive struct {
 	// Only opted-in Claude cache reporting can defer initial keepalives.
 	// Selection releases it before process startup; expiry keeps the stream alive.
 	cacheReportUntil time.Time
-	// lead, whether the thinking's own opening frames went out (#4166):
-	// once a stream, never twice.
-	lead bool
 }
 
 // agentQuietMost is the longest a streaming Responses agent goes with no
@@ -2860,37 +2856,6 @@ func (a *keptAlive) tooQuiet(d time.Duration) bool {
 // idle timeout for a reasoning model, 240s, ended the turn first (#751). A
 // comment is no event in any protocol, so another account may still answer
 // after it, its stream going on in the same response (pass).
-// leadThinking tells the agent's stream that the try is thinking before
-// any of the thinking is given: the reply's own message_start (the model
-// the agent asked, as streamError names it) and an empty thinking block's
-// start, none of the try's words (#4166). An agent's "thinking with …
-// effort" line comes from those two frames; the thinking itself stays
-// held for a refusal after it (#248), and the next member's reply, when
-// one is asked for, follows these frames whole — a frame that says
-// nothing of the try's answer doesn't give the agent half of one reply
-// and half of another. Anthropic's stream only: Chat's first chunk and
-// Responses' response.created go out with the keepalives already, and a
-// Gemini stream takes no comment and no extra frames.
-func (h *holdWriter) leadThinking() {
-	a := h.alive
-	if a == nil || a.proto != provider.Anthropic || !h.stream || a.lead {
-		return
-	}
-	a.lead = true
-	if !a.sent {
-		h.keepAlive() // the 200 and the headers go first
-	}
-	sw := newSSEWriter(h.w)
-	sw.begun = true
-	model := a.model
-	ev := Event{Model: model}
-	e := &anthropicEncoder{w: sw, model: model}
-	e.start(ev)
-	e.openBlock(Thinking, map[string]any{"thinking": "", "signature": ""})
-	h.flush()
-	a.at = time.Now()
-}
-
 func (h *holdWriter) keepAlive() {
 	a := h.alive
 	// a Gemini stream has none, as geminiEncoder.keepalive: agy fails on
diff --git a/internal/gateway/thinking_lead_frames_test.go b/internal/gateway/thinking_lead_frames_test.go
deleted file mode 100644
index 92a627825..000000000
--- a/internal/gateway/thinking_lead_frames_test.go
+++ /dev/null
@@ -1,52 +0,0 @@
-package gateway
-
-import (
-	"net/http"
-	"net/http/httptest"
-	"strings"
-	"testing"
-
-	"github.com/yetone/magpie/internal/provider"
-	"time"
-)
-
-// A group's held stream kept its thinking to itself until the answer came,
-// so an agent's "thinking with max effort" line lasted no time at all and
-// the whole thought landed at once, minutes in (#4166). Held for a refusal
-// after it, the stream may still tell the agent *that* it is thinking —
-// the frames that say so carry none of the try's words, so the next
-// member's reply can still follow them whole (#248's guarantee kept).
-func TestHeldThinkingTellsTheAgentItIsThinking(t *testing.T) {
-	events := strings.SplitAfter(anthropicThoughtThenRefused, "\n\n")
-	w := httptest.NewRecorder()
-	h := newHoldWriter(w, true)
-	h.Header().Set("Content-Type", "text/event-stream")
-	h.WriteHeader(http.StatusOK)
-	alive := &keptAlive{proto: provider.Anthropic, model: "group/g", told: time.Now(), streams: true}
-	h.alive = alive
-	h.stream = true
-
-	// the try's message_start and the thinking block's start go by; the
-	// thinking is held (a refusal may still end it, #248)
-	h.Write([]byte(events[0] + events[1]))
-	body := w.Body.String()
-	if !strings.Contains(body, `"message_start"`) {
-		t.Fatal("the agent has no message_start while the try is held")
-	}
-	if !strings.Contains(body, `"content_block_start"`) || !strings.Contains(body, `"thinking"`) {
-		t.Fatal("the agent has no thinking block start while the try is held")
-	}
-	if strings.Contains(body, "The user wants a plan for") {
-		t.Fatal("the thinking's words went through before the answer did")
-	}
-
-	// the refusal ends the try as before: the next member answers, and
-	// nothing of this try's reply preceded it
-	for _, ev := range events[2:] {
-		h.Write([]byte(ev))
-	}
-	h.settle()
-	if h.passing || !h.refused {
-		t.Fatalf("refusal after thinking: passing %v refused %v", h.passing, h.refused)
-	}
-}
-- 
2.50.1 (Apple Git-155)
```

</details>

**Branch with the commits**: [fix/4166-thinking-stream-group](https://github.com/ggbdpq/magpie/tree/fix/4166-thinking-stream-group) (head `4a968ff9f052dd9d7d22f4306f33976a8e8c1523` — prototype `e0a0ec795`, revert `4a968ff9f`).

**Attribution**: AI-written (GLM-5.3-Flash via ZCode); I've read the whole diff (and the revert) and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.
