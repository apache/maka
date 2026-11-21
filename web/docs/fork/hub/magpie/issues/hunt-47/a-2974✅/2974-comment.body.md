Confirmed on current main (`ef655acb`): the probe reproduces exactly as described. The `responsesSealedStream` fixture with its ids renamed to stable non-`rs_` ones gives a Responses client three reasoning items, not two — the streamed summary added/done under an `rs_` id the encoder made up (`rs_18dff…`), then the sealed summarized item added/done again under its own id, then the sealed-only one; and the same when the ids change per event. This implements the direction sketched in the issue: remember the id `KThinkStart` came with, and for an upstream whose ids rotate, match the seal by the id the item went out added by (`output_index`). Thank you for the precise probe — it made this a two-field fix.

Branch: [`hunt47-a-reasoning-dup`](https://github.com/ggbdpq/magpie/tree/hunt47-a-reasoning-dup), one commit on top of upstream `ef655acb`; the patch below applies with `git am`.

## What changed

- `internal/gateway/responses.go:1346-1349` — `responsesDecoder.addedID`: the id each reasoning item went out `response.output_item.added` by, kept by its `output_index` (`:1487-1490`; the event now decodes `output_index`, `:1442`).
- `internal/gateway/responses.go:1517-1522` — at the item's sealed done, the `KSealed` event is told by that added id, so an upstream whose ids change per event (Copilot's) has its done recognized as the item that streamed.
- `internal/gateway/responses.go:1629-1633` — `responsesEncoder.thinkUp`: the id `KThinkStart` came with, whatever its shape (`:1865`; `thinkID` still takes `rs_` ids only, so the streamed item still goes out added under an `rs_` id when the upstream's isn't one — unchanged).
- `internal/gateway/responses.go:1874` — the seal closes the streamed item (`closeAs`) when it is that item's (`ev.ID == e.thinkUp` joins the existing `""`/`itemID` matches); `thinkUp` is cleared with the open item (`:1815-1816`) so it can't outlive it.
- `internal/gateway/reasoning_state_responses_test.go:160-246` — the probe as a committed test, asserting the client-visible stream: exactly two reasoning added/done items and two in `response.completed`, in both id shapes.

## Red before the fix

Base `ef655acb40b2b2b5484e8eab41c79ff8b41bb6d3`, test `TestResponsesStreamForeignReasoningIDNotDoubled`, both subtests, with the duplicate in the failing output:

```
--- FAIL: TestResponsesStreamForeignReasoningIDNotDoubled (0.00s)
    --- FAIL: TestResponsesStreamForeignReasoningIDNotDoubled/stable_ids (0.00s)
        reasoning_state_responses_test.go:237: added reasoning ids [rs_18dff988b7dd1e6800000001 Cp6820f38x Cp6820f3bx], want the streamed item under the encoder's rs_ id and Cp6820f3bx
    --- FAIL: TestResponsesStreamForeignReasoningIDNotDoubled/ids_that_change_per_event (0.00s)
        reasoning_state_responses_test.go:237: added reasoning ids [rs_18dff98692135c5800000001 Cp6820f38b Cp6820f3bb], want the streamed item under the encoder's rs_ id and Cp6820f3bb
```

Three added reasoning items where the upstream made two. The same test with the upstream's product code restored under it (ablation) fails the same way; with the fix it passes.

## Verification

| Check | Command | Result |
| --- | --- | --- |
| New test, fix applied | `go test -tags nogui -count=1 -run TestResponsesStreamForeignReasoningIDNotDoubled ./internal/gateway/` | ok 1.0s |
| Targeted families | `go test -tags nogui -count=1 -run 'TestReasoning|TestResponses|TestSealed|TestTranslate' ./internal/gateway/` | ok 9.0s |
| Full package | `go test -tags nogui -count=1 ./internal/gateway/` | ok 356.0s |
| Race, targeted | `go test -tags nogui -count=1 -race -run 'TestReasoning|TestResponses|TestSealed|TestTranslate' ./internal/gateway/` | ok 11.1s |
| Format | `gofmt -l internal/gateway/` | empty |
| Vet | `go vet -tags nogui ./internal/gateway/`; same with `GOOS=linux`, `GOOS=windows` | clean |
| Builds | `go build -tags nogui ./...` (darwin); `GOOS=linux go build -tags nogui ./...`; `GOOS=windows go build -tags nogui -o /dev/null .` | all ok (a pre-existing cgo warning in the untouched `internal/gui/trayimage_darwin.go`) |
| Ablation | `git show upstream/main:internal/gateway/responses.go` over the new test | red (duplicate shown), fix back → green |
| Mutation (a) | drop the remembered id (`thinkUp` assign + match) | both subtests red |
| Mutation (b) | drop the decoder's `output_index` rewrite | only `ids that change per event` red, `stable ids` green |

## Siblings

- The relayed path (the issue's `idTidy` context): the upstream's bytes reach the client as they came, so added and done ids are already the upstream's own pair — nothing to match, left alone.
- Whole replies to a Responses client (`renderResponses`): the collector merges a seal into the streamed thinking by openness, never by id (`internal/gateway/ir.go:563-571`), so a non-streaming client was never doubled — left as is.
- The Messages encoder's `KSealed` (`internal/gateway/anthropic.go:1489-1497`): only `sealAnthropic` (a redacted block, which never streams a summary first) passes, added by block index and not by id — left as is.
- The `KSealed` add-whole path and `KSearch` in the Responses encoder add whole items without ids of their own to match — untouched.

## Not verified

- No live upstream at hand that sends non-`rs_` reasoning ids together with non-empty summaries: OpenAI/Codex ids start with `rs_`, and per the issue's 2026-10-19 captures Copilot's `/responses` (non-`rs_`, rotating ids, gpt-5.5, effort low) returned `summary: []` every time — so the live impact stays conditional until some upstream sends both. The fix is verified against fixtures in the two id shapes the issue describes, not against a real one.
- One visible wrinkle remains, as the issue's sketch implies: a streamed item whose upstream id isn't `rs_` goes out added under the encoder's own `rs_` id and done as the sealed item under the upstream's. That is what an upstream with rotating ids does on its own wire, and Codex reads the full item from `output_item.done`; I have not verified it against a real client beyond the event-level assertions in the test.

**AI**: written with an AI coding agent; I've read the whole diff and can answer questions on it myself. The model name is in the commit's trailer.

**Attribution**: If you apply the patch, please keep its author (ggbdpq) or add a `Co-authored-by: ggbdpq <ggbdpq@gmail.com>` line.

<details><summary>patch (0001-gateway-a-streamed-reasoning-summary-the-upstream-se.patch)</summary>

```patch
From 05b78de07b3be257ee0547a3185c16820826066c Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Tue, 20 Oct 2026 00:10:09 +0800
Subject: [PATCH] gateway: a streamed reasoning summary the upstream seals by
 its own id is not given to the client twice (#2974)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

What changed:
- responsesDecoder remembers, by its output_index, the id a reasoning
  item went out added by, and tells the item's sealed done event by
  that id, so an upstream whose ids change per event (Copilot's) has
  its done recognized as the item that streamed.
- responsesEncoder remembers the id KThinkStart came with whatever its
  shape (thinkUp; thinkID kept taking rs_ ids only) and closes the
  streamed item with the sealed one when the seal is that item's,
  instead of closing it unsealed and adding the sealed item again.

Why: on the translated Responses -> Responses path, a reasoning item
whose upstream id does not start with rs_ and that streams a summary
reached the client twice — once under an rs_ id the encoder made up,
then again whole at output_item.done, because the seal's id never
matched the made-up one (#2974, reported and probed by yetone).

Run (darwin/arm64, go test -tags nogui):
- new TestResponsesStreamForeignReasoningIDNotDoubled (stable ids and
  ids that change per event) is red on ef655acb with the duplicate
  shown (added reasoning ids [rs_18dff…0001 Cp6820f38x Cp6820f3bx])
  and green with the fix
- ablation: upstream responses.go restored under the new test → red
  again; fix back → green
- mutations: dropping the remembered id → both subtests red; dropping
  the output_index rewrite → only the rotating-ids subtest red
- full ./internal/gateway/: ok 356.0s; -race targeted families:
  ok 11.1s; gofmt clean; go vet darwin/linux/windows clean; builds
  darwin ./..., linux ./... and GOOS=windows . all ok

Generated-by: GLM-5.3-Flash (ZCode)
---
 .../gateway/reasoning_state_responses_test.go | 85 +++++++++++++++++++
 internal/gateway/responses.go                 | 32 +++++--
 2 files changed, 110 insertions(+), 7 deletions(-)

diff --git a/internal/gateway/reasoning_state_responses_test.go b/internal/gateway/reasoning_state_responses_test.go
index 56e5e7e1..9c0163dd 100644
--- a/internal/gateway/reasoning_state_responses_test.go
+++ b/internal/gateway/reasoning_state_responses_test.go
@@ -3,6 +3,7 @@ package gateway
 import (
 	"bytes"
 	"encoding/json"
+	"strings"
 	"testing"
 
 	"github.com/yetone/magpie/internal/provider"
@@ -159,3 +160,87 @@ func TestResponsesSealedReasoningStaysWithResponses(t *testing.T) {
 		}
 	}
 }
+
+// withID is a reasoning item raw under another id.
+func withID(t *testing.T, raw, id string) string {
+	t.Helper()
+	var m map[string]any
+	if err := decodeJSON([]byte(raw), &m); err != nil {
+		t.Fatal(err)
+	}
+	m["id"] = id
+	b, _ := json.Marshal(m)
+	return string(b)
+}
+
+// cpStream is responsesSealedStream from an upstream whose reasoning ids
+// aren't OpenAI's rs_ … (Copilot's begin Cp6820…): the item that streams
+// its summary went out added and in every delta by one id, and comes back
+// done as the sealed item by another (the same one when the upstream's ids
+// are stable, as the summary's raw on done carries).
+func cpStream(t *testing.T, summarizedAdded, summarizedDone, sealedAdded, sealedDone string) []string {
+	t.Helper()
+	rp := strings.NewReplacer(
+		rsSummarized, withID(t, rsSummarized, summarizedDone),
+		"rs_6820f383d7c08191846711c5df8233bc0ac5ba57aafcbac7", summarizedAdded,
+		rsSealed, withID(t, rsSealed, sealedDone),
+		"rs_6820f3b2e9fc8191a5c7d0ab1c8e2f4a0ac5ba57aafcbac7", sealedAdded,
+	)
+	out := make([]string, len(responsesSealedStream))
+	for i, l := range responsesSealedStream {
+		out[i] = rp.Replace(l)
+	}
+	return out
+}
+
+// A reasoning item the upstream seals at its done is the one that streamed
+// its summary, whatever id it went by: the client reads the summary once.
+// The old encoder knew its streamed item only by an OpenAI rs_ id, closed
+// it unsealed at the seal, then added the sealed item again, so a client
+// of the translated path read the summary as two items (#2974).
+func TestResponsesStreamForeignReasoningIDNotDoubled(t *testing.T) {
+	for name, ids := range map[string]struct{ sumA, sumD, sealA, sealD string }{
+		"stable ids":                {sumA: "Cp6820f38x", sumD: "Cp6820f38x", sealA: "Cp6820f3bx", sealD: "Cp6820f3bx"},
+		"ids that change per event": {sumA: "Cp6820f38a", sumD: "Cp6820f38b", sealA: "Cp6820f3ba", sealD: "Cp6820f3bb"},
+	} {
+		t.Run(name, func(t *testing.T) {
+			evs := translateStream(t, provider.Responses, provider.Responses,
+				cpStream(t, ids.sumA, ids.sumD, ids.sealA, ids.sealD)...)
+			var added []string
+			var done, completed []any
+			deltas := 0
+			for _, ev := range evs {
+				item, _ := ev["item"].(map[string]any)
+				switch ev["type"] {
+				case "response.output_item.added":
+					if item["type"] == "reasoning" {
+						added = append(added, item["id"].(string))
+					}
+				case "response.output_item.done":
+					if item["type"] == "reasoning" {
+						done = append(done, item)
+					}
+				case "response.reasoning_summary_text.delta":
+					deltas++
+				case "response.completed":
+					for _, it := range ev["response"].(map[string]any)["output"].([]any) {
+						if it.(map[string]any)["type"] == "reasoning" {
+							completed = append(completed, it)
+						}
+					}
+				}
+			}
+			if deltas == 0 {
+				t.Fatal("the summary never streamed")
+			}
+			if len(added) != 2 || !strings.HasPrefix(added[0], "rs_") || added[1] != ids.sealD {
+				t.Fatalf("added reasoning ids %v, want the streamed item under the encoder's rs_ id and %s", added, ids.sealD)
+			}
+			for form, items := range map[string][]any{"done": done, "completed": completed} {
+				if len(items) != 2 || !jsonIs(t, items[0], withID(t, rsSummarized, ids.sumD)) || !jsonIs(t, items[1], withID(t, rsSealed, ids.sealD)) {
+					t.Fatalf("%s reasoning items %v, want 2: %s sealed by %s, then %s", form, items, rsSummarized, ids.sumD, rsSealed)
+				}
+			}
+		})
+	}
+}
diff --git a/internal/gateway/responses.go b/internal/gateway/responses.go
index fe494c91..e5dd11f7 100644
--- a/internal/gateway/responses.go
+++ b/internal/gateway/responses.go
@@ -1343,6 +1343,10 @@ type responsesDecoder struct {
 	held    string          // its deltas since they made whole JSON, not given yet
 	whole   jsonWhole       // where its deltas stand in their JSON
 	full    string          // the open call's arguments as its done events give them
+	// addedID is the id each reasoning item went out added by, by its
+	// output_index: an upstream whose ids change per event (Copilot's)
+	// does the same item done by another (#2974)
+	addedID map[int]string
 }
 
 // argsDelta gives an open call's argument delta, or holds it when with
@@ -1433,9 +1437,10 @@ func pickArgs(streamed, done string) string {
 
 func (d *responsesDecoder) decode(data string, emit func(Event)) error {
 	var ev struct {
-		Type  string `json:"type"`
-		Delta string `json:"delta"`
-		Item  rItem  `json:"item"`
+		Type        string `json:"type"`
+		Delta       string `json:"delta"`
+		OutputIndex int    `json:"output_index"`
+		Item        rItem  `json:"item"`
 		// function_call_arguments.done's
 		Arguments string `json:"arguments"`
 		Response  struct {
@@ -1479,6 +1484,10 @@ func (d *responsesDecoder) decode(data string, emit func(Event)) error {
 		if ev.Item.Type == "reasoning" {
 			// an item of its own, by the id the upstream gave it (#1445)
 			emit(Event{Kind: KThinkStart, ID: ev.Item.ID})
+			if d.addedID == nil {
+				d.addedID = map[int]string{}
+			}
+			d.addedID[ev.OutputIndex] = ev.Item.ID
 		}
 	case "response.output_text.delta":
 		d.endCall(emit)
@@ -1505,7 +1514,12 @@ func (d *responsesDecoder) decode(data string, emit func(Event)) error {
 		}
 		if ev.Item.Type == "reasoning" && ev.Item.EncryptedContent != "" {
 			// sealed: the item as the upstream wrote it, for a Responses
-			// client and for its next request (#1445)
+			// client and for its next request (#1445). An encoder knows
+			// the item by the id it went out added by, so when the ids
+			// change per event the done one is told by its own (#2974)
+			if a := d.addedID[ev.OutputIndex]; a != "" {
+				ev.Item.ID = a
+			}
 			var whole struct {
 				Item json.RawMessage `json:"item"`
 			}
@@ -1612,8 +1626,11 @@ type responsesEncoder struct {
 	text    strings.Builder // text of the open message / reasoning
 	// a reasoning item began upstream (KThinkStart): the next thinking
 	// opens an item of its own, by thinkID when the upstream named it
+	// rs_ … . thinkUp is the id it came with whatever its shape: the
+	// sealed item done by it is the one that streamed, not another (#2974)
 	thinkNew bool
 	thinkID  string
+	thinkUp  string
 	output   []any
 	col      collector
 	named    map[string]nsTool // the request's namespaced tools
@@ -1795,7 +1812,8 @@ func (e *responsesEncoder) closeAs(sealed json.RawMessage) {
 	}
 	e.send("response.output_item.done", map[string]any{"output_index": e.item, "item": item})
 	e.output = append(e.output, item)
-	e.open, e.text = "", strings.Builder{}
+	// the open item's upstream id went with it
+	e.open, e.text, e.thinkUp = "", strings.Builder{}, ""
 }
 
 func (e *responsesEncoder) openItem(k Kind, prefix string, item map[string]any) {
@@ -1844,7 +1862,7 @@ func (e *responsesEncoder) event(ev Event) {
 		e.text.WriteString(ev.Text)
 		e.send("response.reasoning_summary_text.delta", map[string]any{"item_id": e.itemID, "output_index": e.item, "summary_index": 0, "delta": ev.Text})
 	case KThinkStart:
-		e.thinkNew, e.thinkID = true, ""
+		e.thinkNew, e.thinkID, e.thinkUp = true, "", ev.ID
 		if strings.HasPrefix(ev.ID, "rs_") {
 			e.thinkID = ev.ID
 		}
@@ -1853,7 +1871,7 @@ func (e *responsesEncoder) event(ev Event) {
 			break // another API's, which a Responses client can't read
 		}
 		raw := json.RawMessage(ev.Text)
-		if e.open == Thinking && !e.thinkNew && (ev.ID == "" || ev.ID == e.itemID) {
+		if e.open == Thinking && !e.thinkNew && (ev.ID == "" || ev.ID == e.itemID || ev.ID == e.thinkUp) {
 			// the item streamed so far, done as the upstream wrote it
 			e.closeAs(raw)
 			break
-- 
2.50.1 (Apple Git-155)

```

</details>
