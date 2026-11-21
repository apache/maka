Fix on a branch, `git am` ready: [`hunt-20261112-t1-6320`](https://github.com/ggbdpq/magpie/tree/hunt-20261112-t1-6320) @ `bb236afa1`, one commit on today's `upstream/main` (`4e0026661`). Patch below, SHA-256 first 16: `0e49844f8f526b99`.

**The gap, confirmed on main** — exactly as the report pins it: a `store:false` request with no `previous_response_id` returns from `previousResponse` before any ask is hung (internal/gateway/prev_response.go:272), so `prevAskOf` is nil, `prevHeld` is false, and the cross-resource retry gate (internal/gateway/gateway.go:6817) never opens — the 400 reaches the client even though `prevForeign` recognizes its text. And opening the gate alone wouldn't do: `prevElsewhere` also requires a known ask and computes `n = total − fresh` (only magpie's own recovered prior), so a client-replayed whole history was untouched on every path.

**The fix** — the store-off request now hangs a marked ask when its input reads as a replayed conversation: more than one item, and one before the last naming an id that may go without one (`idOptional`) or a reasoning's — ids the upstream handed out for earlier turns, echoed back. One id'd item alone is the client's own new input and goes as it came, which keeps the line `TestPreviousResponseOtherResourceWholeSentWithoutIDs` already draws. On the `prevForeign` refusal the existing `prevElsewhere` (forced) takes those ids out of the replay — reasoning only with its `encrypted_content`, the calls' `call_id` pairing kept, required-id kinds as they were — and the request is asked again once, only with a body that differs. Nothing is recorded for a store-off request, and a known conversation's recovery is untouched (the mark is never set on an ask magpie answered, so `n = total − fresh` still bounds its treatment).

**Red without the fix** (base `873b4987e`, the new tests kept): `TestClientWholeReplayForeignIDsAskedWithoutThem` fails `client given 400: ...The requested item was created under a different Azure OpenAI resource...` — the report's error reaching the client over the `foreignUp` fixture, with the request built as the report prescribes (store:false, full `input[]`, no `previous_response_id`). With the fix: 200 after exactly 2 upstream calls (the refusal, then the replay without ids), and the sent input keeps the turns in order with `sealed9`'s encrypted reasoning, the message text, and `"call_id":"call_1"` pairing both ends, no `previous_response_id`, no `msg_1`/`rs_9`/`fc_1`/`fco_1` ids. `TestClientWholeSingleIDedItemStaysAsItCame` (one store-off id'd item → 400 after one call) is green at base and after. Ablation: the three hunks reverted (ask hang, the gate's `prevClientWhole` disjunct, `prevElsewhere`'s client-whole treatment), tests kept → the replay test red as above; restored → green.

**Suite** — `internal/gateway` whole package on the final pushed head `bb236afa1`: `ok` 872.470s (zero failures); the prev family with `-race -count=3` green; `gofmt`/`vet` clean; `go build -tags nogui` clean on linux/amd64 and windows/amd64. `git am` of the patch onto `4e0026661` replays with a byte-identical tree. The commit ran the same suite on its pre-rebase head first (ok 933.720s), rebased when main moved, re-ran on the final head.

**Scope notes** — a `store:true` request that replays a whole history without `previous_response_id` still goes as it came (its ask hangs, known=false, but no client-whole mark is set): no report of that face, and the store-on flow normally rides `previous_response_id`. A replay carrying a reasoning item *without* `encrypted_content` loses that item on the retry, as `prevElsewhere` already does for magpie's own items — what it held lives only where it was made. The upstream that refuses cross-resource ids is the fixture; the real relay of the report is the live evidence, as in #5812's recovery on the same family.

**Siblings checked**: `prevLost` (needs a named id — stays "" for a marked ask), `prevDelta` (needs known), `noteAnswered` (harmless), the unforced `prevElsewhere` at the relay site (unchanged by the guard), and `remoteTurnFor` (kept-turn requests don't take this path — the mark sits behind the `!keepsTurnFor` condition).

**Not verified**: a real Azure-behind-a-relay upstream or the report's gateway (fixture-level, like the report's own compat-proxy probe); Windows runtime (build only).

**Attribution**: AI-written; I've read the whole diff and can answer questions on it myself. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

**Patch**: <details><summary>patch: gateway: a client's own whole replay is asked once more without the ids another resource refuses (#6320) — git am applies it as is; SHA-256 first 16: `0e49844f8f526b99`</summary>

```patch
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Thu, 12 Nov 2026 22:14:27 +0800
Subject: [PATCH] gateway: a client's own whole replay is asked once more
 without the ids another resource refuses
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

A Codex replaying its whole conversation itself (store false, no
previous_response_id) echoes ids the upstream handed out for earlier
turns. When an upstream turns one away as another of its resources' —
the prevForeign refusal — the recovery that strips such ids from a
conversation magpie gave back never ran: the store-off request hung no
ask, so the retry gate stayed shut and the 400 reached the client
(#6320). x1051445024's report; the reporter's own compat proxy stripped
whitelisted optional ids as a workaround.

The store-off request now carries a marked ask when its input reads as a
replayed conversation: more than one item, and one before the last
naming an id that may go without one, or a reasoning's. One id'd item
alone is the client's own new input and goes as it came, as
TestPreviousResponseOtherResourceWholeSentWithoutIDs already holds the
line. On the foreign refusal the same prevElsewhere run takes those ids
out of the replay — reasoning only with its encrypted_content, calls'
call_id pairing kept — and the request is asked again once, only with a
body that differs. Nothing is recorded for a store-off request, and a
known conversation's recovery is exactly as before (the mark is never
set on an ask magpie answered).

Verification on darwin/arm64, upstream/main 873b4987e + this commit:
- New TestClientWholeReplayForeignIDsAskedWithoutThem fails on the
  unmodified base with the 400 reaching the client, passes with this
  commit (2 upstream calls: the refusal, then the replay without ids);
  TestClientWholeSingleIDedItemStaysAsItCame holds the single-item line.
- The existing prev family stays green, the two boundary tests included.
- Ablation: the three hunks reverted (ask hang, prevClientWhole gate,
  prevElsewhere's client-whole treatment), tests kept, the replay test
  red again; restored, green.
- internal/gateway whole package green; gofmt/vet clean.

Fixes #6320

Generated-by: GLM-5.3-Flash (ZCode)
---
 docs/subsystems/gateway-routing.md     | 14 +++--
 internal/gateway/gateway.go            |  7 +--
 internal/gateway/prev_response.go      | 74 ++++++++++++++++++++++----
 internal/gateway/prev_response_test.go | 58 ++++++++++++++++++++
 4 files changed, 136 insertions(+), 17 deletions(-)

diff --git a/docs/subsystems/gateway-routing.md b/docs/subsystems/gateway-routing.md
index c86d81040..7c7ddeeba 100644
--- a/docs/subsystems/gateway-routing.md
+++ b/docs/subsystems/gateway-routing.md
@@ -3008,10 +3008,16 @@ included). `previousResponse` in
   its resources (`prevForeign`: Azure OpenAI behind a relay that spreads
   one key over several resources, hykql's report; the text was not
   reproduced against Azure) is asked once more with the conversation
-  whole and those ids taken out. Only a request whose conversation magpie
-  holds is asked again, and only with a body that differs: an id magpie
-  doesn't hold, or a refusal with nothing of magpie's to take out, is
-  passed on as before.
+  whole and those ids taken out. A conversation the client replayed whole
+  itself (Codex's store-off history, no `previous_response_id`) goes the
+  same way: the ids it echoes, of the kinds that may go without one and
+  reasonings with their `encrypted_content`, are taken out on that one
+  more ask, the turns and the calls' pairing kept; an input that is one
+  id'd item of the client's own is not a replay, and goes as it came.
+  Only a request whose conversation magpie holds, or one that brought a
+  whole replayed conversation, is asked again, and only with a body that
+  differs: an id magpie doesn't hold, or a refusal with nothing to take
+  out, is passed on as before.
 - A ChatGPT account's streamed turn goes on its conversation's kept
   socket as a delta after the backend's own `previous_response_id`
   (`codexKept`, see [Providers and accounts](providers-accounts.md)).
diff --git a/internal/gateway/gateway.go b/internal/gateway/gateway.go
index f14bf99a7..0cf5f03e8 100644
--- a/internal/gateway/gateway.go
+++ b/internal/gateway/gateway.go
@@ -6814,11 +6814,12 @@ func (s *Server) passthrough(w http.ResponseWriter, r *http.Request, p provider.
 			}
 		}
 	}
-	if (delta || proto == provider.Responses && prevHeld(r)) && (badRequest(res.StatusCode) || res.StatusCode == http.StatusNotFound) {
+	if (delta || proto == provider.Responses && (prevHeld(r) || prevClientWhole(r))) && (badRequest(res.StatusCode) || res.StatusCode == http.StatusNotFound) {
 		// one it no longer holds: the conversation whole; and one another
 		// of its resources made (prevForeign): the whole, with the items
-		// magpie brought back naming nothing. Asked again once, and only
-		// with a body that differs.
+		// magpie brought back naming nothing — or, for a conversation the
+		// client replayed whole itself, the ids it echoes taken out
+		// (#6320). Asked again once, and only with a body that differs.
 		b, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
 		res.Body.Close()
 		res.Body = io.NopCloser(bytes.NewReader(b))
diff --git a/internal/gateway/prev_response.go b/internal/gateway/prev_response.go
index a22afd753..424538e9b 100644
--- a/internal/gateway/prev_response.go
+++ b/internal/gateway/prev_response.go
@@ -177,6 +177,10 @@ type prevAsk struct {
 	upstreamID   string // the id the provider that answered it keeps it under
 	route        string
 	made         string // the route whose reply the named response was
+	// the client replayed the conversation whole itself (store false, no
+	// previous_response_id), so nothing of it is magpie's to take back;
+	// a cross-resource refusal of an id it echoes is still recoverable
+	clientWhole bool
 	// which try answered: its route if it was relayed to a provider
 	// that keeps what it is sent, empty otherwise; and by, its route
 	// for any relayed try
@@ -198,6 +202,14 @@ func prevHeld(r *http.Request) bool {
 	return a != nil && a.known
 }
 
+// prevClientWhole is whether the client replayed the conversation whole
+// itself (store false, no previous_response_id), nothing of it magpie's
+// to take back.
+func prevClientWhole(r *http.Request) bool {
+	a := prevAskOf(r.Context())
+	return a != nil && a.clientWhole
+}
+
 // prevLost is the id a request named that magpie doesn't hold, which a
 // try that doesn't relay it to a provider as written can't honour.
 func prevLost(r *http.Request) string {
@@ -270,6 +282,15 @@ func previousResponse(w http.ResponseWriter, r *http.Request, from provider.Prot
 	}
 	var store bool
 	if json.Unmarshal(q["store"], &store) == nil && !store && !keepsTurnFor(r) {
+		// a client replaying its whole conversation itself (Codex's
+		// store-off history) echoes ids the upstream handed out for
+		// earlier turns: a cross-resource refusal of one is still
+		// recoverable without a store (#6320), so the ask goes along
+		// marked, never recorded
+		if !ask.known && clientWholeHistory(fresh) {
+			ask.clientWhole = true
+			r = r.WithContext(context.WithValue(r.Context(), prevAskKey{}, ask))
+		}
 		return w, r, body, nothing // the client asked that nothing be kept
 	}
 	if keepsTurnFor(r) {
@@ -350,6 +371,33 @@ func prevInput(raw json.RawMessage) (all, fresh []json.RawMessage) {
 	return items, items
 }
 
+// clientWholeHistory is whether an input reads as a conversation the
+// client brought back whole: more than one item, and one before the last
+// naming an id that may go without one, or a reasoning's — ids the
+// upstream handed out for earlier turns, echoed back with the history.
+// One item with an id alone is the client's own new input, and goes as it
+// came (#6320, TestPreviousResponseOtherResourceWholeSentWithoutIDs).
+func clientWholeHistory(fresh []json.RawMessage) bool {
+	if len(fresh) < 2 {
+		return false
+	}
+	for _, raw := range fresh[:len(fresh)-1] {
+		var it map[string]json.RawMessage
+		if json.Unmarshal(raw, &it) != nil {
+			continue
+		}
+		if _, has := it["id"]; !has {
+			continue
+		}
+		var typ string
+		json.Unmarshal(it["type"], &typ)
+		if typ == "reasoning" || idOptional[typ] {
+			return true
+		}
+	}
+	return false
+}
+
 // prevReply is a Responses reply's id and output items, a stream's or a
 // whole body's; ok false for one that didn't complete.
 func prevReply(ctype string, reply []byte) (id string, output []json.RawMessage, ok bool) {
@@ -466,20 +514,21 @@ func prevForeign(status int, b []byte) bool {
 // whole, with the items it brought back no longer naming what the
 // upstream that made them keeps them under, when they go to another
 // provider or key than the one whose reply they were (or always, when
-// force: one upstream said they are another resource's). An item that
-// can go without its id (idOptional) goes without it, its text and
-// call_id kept; reasoning keeps its place only with its encrypted_content,
-// as Codex sends it, since what it held lives only where it was made. Any
-// other kind, and the client's own new input, stay as they were. A body
-// whose items the tries changed in number is left as it is, as prevDelta
-// leaves it.
+// force: one upstream said they are another resource's — a conversation
+// the client replayed whole itself goes the same way, its echoed ids
+// taken out, #6320). An item that can go without its id (idOptional) goes
+// without it, its text and call_id kept; reasoning keeps its place only
+// with its encrypted_content, as Codex sends it, since what it held lives
+// only where it was made. Any other kind, and the client's own new input
+// of a conversation magpie gave, stay as they were. A body whose items
+// the tries changed in number is left as it is, as prevDelta leaves it.
 func prevElsewhere(r *http.Request, p provider.Provider, body []byte, force bool) []byte {
 	a := prevAskOf(r.Context())
-	if a == nil || !a.known || !force && a.made == prevRoute(p) {
+	if a == nil || !a.known && !force || !force && a.made == prevRoute(p) {
 		return body
 	}
 	n := a.total - a.fresh
-	if n <= 0 || !bytes.Contains(body, []byte(`"id"`)) {
+	if !a.clientWhole && n <= 0 || !bytes.Contains(body, []byte(`"id"`)) {
 		return body
 	}
 	var q map[string]json.RawMessage
@@ -487,9 +536,14 @@ func prevElsewhere(r *http.Request, p provider.Provider, body []byte, force bool
 		return body
 	}
 	items, ok := inputList(q["input"])
-	if !ok || len(items) != a.total {
+	if !ok || !a.clientWhole && len(items) != a.total {
 		return body
 	}
+	if a.clientWhole {
+		// the whole conversation is the client's own replay: every item
+		// is history, none of it is the turn being asked now (#6320)
+		n = len(items)
+	}
 	out := make([]json.RawMessage, 0, len(items))
 	changed := false
 	for i, raw := range items {
diff --git a/internal/gateway/prev_response_test.go b/internal/gateway/prev_response_test.go
index 426b4689b..31c8f90f8 100644
--- a/internal/gateway/prev_response_test.go
+++ b/internal/gateway/prev_response_test.go
@@ -377,6 +377,64 @@ func TestPreviousResponseOtherResourceWholeSentWithoutIDs(t *testing.T) {
 	}
 }
 
+// A client that replays its whole conversation itself, store false and no
+// previous_response_id (Codex's store-off history), meets the same
+// cross-resource refusal of the ids it echoes back: the ids that can go
+// without one go, the conversation and its call pairing kept, asked again
+// once (#6320).
+func TestClientWholeReplayForeignIDsAskedWithoutThem(t *testing.T) {
+	var foreign atomic.Bool
+	up := foreignUp(t, &foreign)
+	s := prevSandbox(t, provider.Provider{ID: "fake", Name: "Fake", Key: "k", Models: []string{"m1"}, Responses: up.srv.URL + "/v1"})
+	foreign.Store(true)
+	replay := `{"model":"fake/m1","store":false,"stream":true,"input":[` +
+		`{"role":"user","content":"Remember 47."},` +
+		`{"type":"reasoning","id":"rs_9","summary":[],"encrypted_content":"sealed9"},` +
+		`{"type":"message","id":"msg_1","role":"assistant","content":[{"type":"output_text","text":"Remembered."}]},` +
+		`{"type":"function_call","id":"fc_1","call_id":"call_1","name":"lookup","arguments":"{}"},` +
+		`{"type":"function_call_output","id":"fco_1","call_id":"call_1","output":"47"},` +
+		`{"role":"user","content":"What was the number?"}]}`
+	rec := askResponses(t, s, "", replay)
+	if rec.Code != 200 {
+		t.Fatalf("client given %d: %s", rec.Code, rec.Body.String())
+	}
+	if n := up.calls(); n != 2 {
+		t.Fatalf("%d upstream calls, want the refusal and the replay without ids", n)
+	}
+	in, _ := json.Marshal(up.last()["input"])
+	sent := string(in)
+	if _, has := up.last()["previous_response_id"]; has {
+		t.Fatalf("previous_response_id still sent: %.400s", sent)
+	}
+	for _, gone := range []string{`"id":"msg_1"`, `"id":"rs_9"`, `"id":"fc_1"`, `"id":"fco_1"`} {
+		if strings.Contains(sent, gone) {
+			t.Fatalf("%s still sent: %.500s", gone, sent)
+		}
+	}
+	for _, want := range []string{"Remember 47.", "sealed9", "Remembered.", `"call_id":"call_1"`, "What was the number?"} {
+		if !strings.Contains(sent, want) {
+			t.Fatalf("%q missing from the replay: %.500s", want, sent)
+		}
+	}
+	if got := strings.Count(sent, `"call_id":"call_1"`); got != 2 {
+		t.Fatalf("call pairing %d times, want the call and its output: %.500s", got, sent)
+	}
+}
+
+// One item of the client's own with an id is not a replayed conversation:
+// it goes as it came, the refusal with it (#6320, beside
+// TestPreviousResponseOtherResourceWholeSentWithoutIDs).
+func TestClientWholeSingleIDedItemStaysAsItCame(t *testing.T) {
+	var foreign atomic.Bool
+	up := foreignUp(t, &foreign)
+	s := prevSandbox(t, provider.Provider{ID: "fake", Name: "Fake", Key: "k", Models: []string{"m1"}, Responses: up.srv.URL + "/v1"})
+	foreign.Store(true)
+	rec := askResponses(t, s, "", `{"model":"fake/m1","store":false,"input":[{"type":"message","id":"msg_mine","role":"user","content":"hi"}]}`)
+	if rec.Code != 400 || up.calls() != 1 {
+		t.Fatalf("client given %d after %d calls, want the 400 after one", rec.Code, up.calls())
+	}
+}
+
 // A conversation going on with another provider than the one whose reply
 // it holds goes without that reply's ids at once: the other never made
 // them. The same provider and key is sent them as before.
-- 
2.50.1 (Apple Git-155)
```

</details>
