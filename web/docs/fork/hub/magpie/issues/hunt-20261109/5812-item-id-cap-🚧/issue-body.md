@JaxWeng — thank you for the complete chain: the report named all three gaps, and each one checks out on `main` as of `be9dbce02`. The request died where no retry could save it, and every turn of the session after it died the same way.

**Root cause**, restated on today's `main` (your line numbers had drifted; the shapes are yours):

1. **`itemIDRefusal` matches the character refusal's tail alone** (`internal/gateway/codex_backend.go:3111`). Since dae104bfa it is a function — the tail within 1000 characters of the `Invalid 'input[n].id'` head — and the one tail it knows is "Expected an ID that contains letters, numbers, underscores, or dashes". OpenAI's length refusal words itself "string too long. Expected a string with maximum length 64, but got a string with length 428 instead." — no such tail, so the reactive ask-again (`internal/gateway/gateway.go:6759`) never fired, `itemIDsRefused` was never remembered, and on a relay whose host magpie can't tell checks ids, there was no proactive `plainItemIDs` to fall back on either. Your suggested regex had the right tail set; the landed form is a tail list beside it.
2. **A translated request never went out with plain ids** (`forwardTranslated`): your gap 2, and it is narrower than the built request only — `buildResponses` replays a seal carried in a call's id (the reasoning_carry of #4798) as it was minted, and Copilot mints ids of 420 characters and more, so the translation carried the refusal inside it from the first byte.

**The fix**, two pieces at the shared root (the id's passage to an upstream that checks them, not any one call site):

- `itemIDRefusalTails` is the tail list: the character refusal's tail, and `Expected a string with maximum length`, which is OpenAI's own for a string over its schema's bound — the `input[n].id` head holds it to item ids alone (another field's "string too long" carries its own head, `input[n].content` and friends, and matches nothing). This one list is what turns the relayed path's ask-again back on: asked once more with ids it takes, and so from then on — the echo_ts shape, now reaching the length wording too.
- `forwardTranslated` now sends Responses the way `passthrough` does: an upstream known to check ids (`validatesItemIDs`) is asked with plain ids from the first turn; one that refuses is asked again with them and remembered (`markUnfit` + rebuild, where the proactive check reads the refusal), exactly the relayed path's contract. Your suggested fix stopped at the proactive half; on a relay it would still have lost the first turn (and every one after, with nothing remembered) — the reactive half is what makes a relay heal. The weave is: a seal carried in a call's id is an upstream's to have minted, and the build never bound what it replayed.

**Sibling-face scan** of every point an item id or call id is made or passed, each left or changed with its reason:

- `codex_backend.go:215` (Codex's own requests to the ChatGPT backend) and `codex_relay.go:60` (a Codex client relayed): both already go `plainItemIDs(boundCallIDs(callItemIDs(body)))` unconditionally; #4525/#4527 live here. Left.
- `gateway.go:6283`, the relayed path's proactive `plainItemIDs`: the `validatesItemIDs(p) || !s.fits(...)` condition is unchanged. Widening `validatesItemIDs` to relays (host unknown) would rewrite bodies for upstreams that never check them — the shape-checking relay of #292 asks to be passed through as it came — and the reactive-then-remembered path is the architecture's own answer to an upstream it can't classify (echo_ts). Left; healed by the tail list instead.
- `gateway.go:6759`, the relayed path's reactive match: it reads `itemIDRefusal`, which the tail list widens — this is the one match face that changed.
- `gateway.go:7889` and `gateway.go:8061`, the translated path's proactive and reactive: new, the fix itself.
- `boundItemID` (`codex_backend.go:3171`): the collision-safe binding — the whole id's sha256 under the kind's prefix, the same id to the same shorter one every turn, no two ids onto one (the bare-digest 400 of #5266) — is exactly the ">64 needs to be collision-safe" half of this issue's trade, and it already stood. The translated path now reaches it; the function itself is untouched.
- `callItemIDs`/`boundCallIDs` (`codex_backend.go:3045, 3312`): the call_id is another field, the pair a call and its output find each other by; `plainItemIDs` leaves it as it was on purpose, and `boundCallIDs` already holds it to 64. Left.
- every `"call_" + newID()` mint (`chat.go`, `chat_call_ids.go`, `gemini.go`, `responses.go`, `textcalls_relay.go`, `reasoning_carry.go`): `newID()` is ~24 characters of `[0-9a-f]`, under the cap by far. Left.
- `idOptional`/`itemKindPrefix` (`codex_backend.go:3186+`): the three-way disposition of an overlong id (left out, bound, character-swapped) is #4525/#4527's settled shape and is what the translated path now goes through like any relayed one. Left.

**Failure-read semantics**: `itemIDRefusal` reads a response body, and a body that doesn't carry a known tail (truncated, reworded) reads as *no item id refusal* — the ask-again doesn't fire and the 400 goes to the client as it went before this patch; nothing reads a refusal into an absence. The translation's proactive check adds two scans over the built body (`"id"` present, then any item over the cap or off the alphabet) and sends a clean request byte for byte unchanged — the same price the relayed path has paid since #4525.

<details><summary>patch: gateway: an item id refused for its length is asked again, and translated requests go with plain ids — git am applies it as is; SHA-256 first 16: 52796c40e89d82b3</summary>

```text
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Mon, 9 Nov 2026 22:20:16 +0800
Subject: [PATCH] gateway: an item id refused for its length is asked again,
 and translated requests go with plain ids
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

An input item's id that OpenAI turns away comes in two wordings: the id
had a character theirs don't have, or was longer than the 64 an id may
have — "string too long. Expected a string with maximum length 64, but
got a string with length 428 instead" (Copilot mints ids of hundreds of
characters: isnine's 420, #4525, ghjkllasdf-fake's 444, #4527, JaxWeng's
428, #5812). itemIDRefusal read the character refusal's tail alone, so a
relay that checks as OpenAI does was never asked again with ids it takes
and every turn of the session failed the same way. The length refusal's
tail is OpenAI's own for a string over its schema's bound, which the
head's input[n].id holds to item ids alone.

And a translated request (a Chat or Messages client's turn) now goes
with plain ids as a relayed one does. The build never bound what it
replayed: a seal carried in a call's id (#4798) is an upstream's to have
minted, and Copilot's are hundreds of characters long. An upstream
known to check ids is asked with plain ones from the first turn; one
that refuses is asked again and remembered, as a relayed request is.

The relayed path's ask-again itself is unchanged: a refusal of another
field's length, of a head it names no item id at, matches nothing.

Fixes #5812
---
 internal/gateway/codex_backend.go        |  22 ++++-
 internal/gateway/gateway.go              |  21 +++++
 internal/gateway/item_id_refusal_test.go |  29 +++++++
 internal/gateway/item_ids_test.go        | 101 +++++++++++++++++++++++
 4 files changed, 170 insertions(+), 3 deletions(-)

diff --git a/internal/gateway/codex_backend.go b/internal/gateway/codex_backend.go
index e260c0669..918703bda 100644
--- a/internal/gateway/codex_backend.go
+++ b/internal/gateway/codex_backend.go
@@ -3100,18 +3100,25 @@ func callItemIDs(body []byte) []byte {
 // "Invalid 'input[1].id': 'rs_6aca2fc7533c979d5f0e4f7a:rs_01a125caa544754e9a3c70080100b009'.
 // Expected an ID that contains letters, numbers, underscores, or dashes,
 // but this value contained additional characters."
+// or one longer than the 64 an id may have (isnine's 420, #4525,
+// ghjkllasdf-fake's 444, #4527, JaxWeng's 428, #5812), which a relay
+// that checks as OpenAI does turns the whole turn away over — "string
+// too long. Expected a string with maximum length 64, but got a string
+// with length 428 instead." — and, the tail being the character
+// refusal's alone, every turn of the session after it the same way.
 // It is the tail within 1000 characters of the head: the regexp
 // .{0,1000}? it was unrolled to 88kB of program, held from start to exit.
 func itemIDRefusal(b []byte) bool {
-	const tail = "Expected an ID that contains letters, numbers, underscores, or dashes"
 	for _, at := range itemIDRefusalHead.FindAllIndex(b, -1) {
 		rest, end := b[at[1]:], 0
 		for n := 0; n < 1000 && end < len(rest); n++ {
 			_, w := utf8.DecodeRune(rest[end:])
 			end += w
 		}
-		if bytes.Contains(rest[:min(len(rest), end+len(tail))], []byte(tail)) {
-			return true
+		for _, tail := range itemIDRefusalTails {
+			if bytes.Contains(rest[:min(len(rest), end+len(tail))], tail) {
+				return true
+			}
 		}
 	}
 	return false
@@ -3119,6 +3126,15 @@ func itemIDRefusal(b []byte) bool {
 
 var itemIDRefusalHead = regexp.MustCompile(`Invalid 'input\[\d+\]\.id'`)
 
+// itemIDRefusalTails are the tails an item id refusal words itself in:
+// the id had a character OpenAI's don't have, or was longer than they
+// take. The length tail is OpenAI's own for a string over its schema's
+// bound, which the head's input[n].id holds to item ids alone.
+var itemIDRefusalTails = [][]byte{
+	[]byte("Expected an ID that contains letters, numbers, underscores, or dashes"),
+	[]byte("Expected a string with maximum length"),
+}
+
 // itemIDsRefused is how unfit remembers a provider turning away, for
 // model, an input item id with another character in it (plainItemIDs).
 func itemIDsRefused(model string) string { return "item ids\x00" + model }
diff --git a/internal/gateway/gateway.go b/internal/gateway/gateway.go
index 7f0609615..d5f23890d 100644
--- a/internal/gateway/gateway.go
+++ b/internal/gateway/gateway.go
@@ -7886,6 +7886,15 @@ func (s *Server) forwardTranslated(ctx context.Context, p provider.Provider, to
 			// been tried with it
 			body = withoutLoneToolChoice(body)
 		}
+		if to == provider.Responses && (validatesItemIDs(p) || !s.fits(p.ID, itemIDsRefused(model), to)) {
+			// and the input items' ids go as an upstream that checks them
+			// takes them, as a relayed one's do: the built request carries
+			// what it replayed — a seal carried in a call's id is an
+			// upstream's to have minted, and Copilot mints ids of 420
+			// characters and more (#4525, #5812), which the build never
+			// bound. A request of no id to plain goes as it came.
+			body = plainItemIDs(body)
+		}
 		if to == provider.Chat && req.WebSearch && p.IsRemoteMagpie() {
 			// the other magpie searches for it (search_remote.go)
 			body = withFields(body, map[string]any{"web_search_options": map[string]any{}})
@@ -8049,6 +8058,18 @@ func (s *Server) forwardTranslated(ctx context.Context, p provider.Provider, to
 				continue
 			}
 		}
+		if to == provider.Responses && badRequest(res.StatusCode) && itemIDRefusal(b) {
+			// an input item's id with a character OpenAI's don't have, or
+			// longer than they take, turned away by an upstream magpie
+			// couldn't tell checks them (a relay in front of OpenAI,
+			// #5812): asked again with ids it takes, and so from then on —
+			// the build above reads the refusal. One the request carries
+			// no plainable id over is not asked again.
+			if nb := plainItemIDs(body); !bytes.Equal(nb, body) {
+				s.markUnfit(p.ID, itemIDsRefused(model), to)
+				continue
+			}
+		}
 		if req.Format != nil && refusesFormat(res.StatusCode, b) {
 			if to != provider.Anthropic && req.Format.Type == "json_schema" {
 				// a schema turned away by an upstream that takes any
diff --git a/internal/gateway/item_id_refusal_test.go b/internal/gateway/item_id_refusal_test.go
index 83059f53b..4ea46589b 100644
--- a/internal/gateway/item_id_refusal_test.go
+++ b/internal/gateway/item_id_refusal_test.go
@@ -28,3 +28,32 @@ func TestItemIDRefusalAsTheRegexp(t *testing.T) {
 		}
 	}
 }
+
+// TestItemIDRefusalLengthTooLong: a refusal of an id longer than the 64
+// an id may have is an item id refusal as much as one of a character is —
+// word for word as OpenAI's API words it, and a relay in front of it
+// passes on (#4525 isnine's 420, #4527 ghjkllasdf-fake's 444, #5812
+// JaxWeng's 428: "string too long. Expected a string with maximum length
+// 64, but got a string with length 428 instead.", which the character
+// tail alone never matches, so the ask again never fired and every turn
+// of the session failed the same way). A "string too long" anywhere but
+// within the 1000 characters after the head is nobody's item id refusal.
+func TestItemIDRefusalLengthTooLong(t *testing.T) {
+	const head = "Invalid 'input[286].id'"
+	in := []struct {
+		s    string
+		want bool
+	}{
+		{`{"error":{"message":"Invalid 'input[286].id': string too long. Expected a string with maximum length 64, but got a string with length 428 instead.","type":"invalid_request_error","param":"input[286].id","code":"string_too_long"}}`, true},
+		{head + ` string too long. Expected a string with maximum length 64, but got a string with length 420 instead.`, true},
+		// a refusal of another field's length is not an item id's
+		{`{"error":{"message":"Invalid 'input[3].content': string too long. Expected a string with maximum length 4096."}}`, false},
+		// the length tail beyond the 1000 characters after the head
+		{head + strings.Repeat("x", 1001) + " Expected a string with maximum length 64, but got a string with length 428 instead.", false},
+	}
+	for _, c := range in {
+		if g := itemIDRefusal([]byte(c.s)); g != c.want {
+			t.Errorf("%d bytes: %v, want %v", len(c.s), g, c.want)
+		}
+	}
+}
diff --git a/internal/gateway/item_ids_test.go b/internal/gateway/item_ids_test.go
index e0a892be7..af7af8d11 100644
--- a/internal/gateway/item_ids_test.go
+++ b/internal/gateway/item_ids_test.go
@@ -736,3 +736,104 @@ func TestCopilotTakesItsOwnOpaqueSearchCallID(t *testing.T) {
 		}
 	}
 }
+
+// copilotOwnID is an input item's id as Copilot mints them: opaque, of
+// safe characters alone, and of hundreds of them (isnine's 420, #4525,
+// ghjkllasdf-fake's 444, #4527, JaxWeng's 428, #5812). OpenAI's API and
+// every relay in front of it turns an item of one away — "Invalid
+// 'input[286].id': string too long. Expected a string with maximum
+// length 64, but got a string with length 428 instead."
+var copilotOwnID = "msg_" + strings.Repeat("a", 424) // 428 characters
+
+// copilotTurn is a conversation whose answer's item Copilot minted an id
+// of its own for, and the turn after it.
+var copilotTurn = `{"type":"message","id":"` + copilotOwnID + `","role":"assistant","content":[{"type":"output_text","text":"I fixed main.go"}]},
+  {"type":"message","role":"user","content":[{"type":"input_text","text":"now add a test"}]}`
+
+// A relay in front of OpenAI, which magpie can't tell from any other
+// upstream, turns the too-long id away as OpenAI words it: asked once
+// more with ids it takes, and from then on asked that way at once.
+func TestRelayRefusingOverlongItemIDsAskedAgain(t *testing.T) {
+	fresh(t)
+	up := &idChecker{check: true}
+	srv := httptest.NewServer(up)
+	t.Cleanup(srv.Close)
+	if err := provider.Save(provider.Provider{ID: "relay", Name: "Relay", Key: "k", Models: []string{"gpt-6.1"}, Responses: srv.URL + "/v1"}); err != nil {
+		t.Fatal(err)
+	}
+	s := New()
+	for turn := range 2 {
+		rec := codexPostTo(s, `{"model":"relay/gpt-6.1","stream":true,"store":false,"input":[`+copilotTurn+`]}`)
+		if rec.Code != 200 || !strings.Contains(rec.Body.String(), "DONE") {
+			t.Fatalf("turn %d: %d %s", turn, rec.Code, rec.Body.String())
+		}
+	}
+	asked := up.asked()
+	if len(asked) != 3 {
+		t.Fatalf("asked the relay %d times, want 2 for the first turn and 1 for the second", len(asked))
+	}
+	b, _ := json.Marshal(asked[0])
+	if !strings.Contains(string(b), `"`+copilotOwnID+`"`) {
+		t.Errorf("the first ask went without the id it was refused over: %s", b)
+	}
+	for i, input := range asked[1:] {
+		for _, it := range input {
+			if id, ok := it["id"].(string); ok && (len(id) > 64 || !openaiItemID.MatchString(id)) {
+				t.Errorf("ask %d: item id %q sent", i+2, id)
+			}
+		}
+		if b, _ := json.Marshal(input); !strings.Contains(string(b), "I fixed main.go") || !strings.Contains(string(b), "now add a test") {
+			t.Errorf("ask %d: the items' words not kept: %s", i+2, b)
+		}
+	}
+}
+
+// A Chat client's turn that carries a Responses upstream's sealed
+// reasoning in its call's id (reasoning_carry, #4798) goes to another
+// Responses upstream, a relay that checks ids as OpenAI does: the sealed
+// item goes back with its id bound, as the relayed request's would be,
+// and not every turn of the session refused the same way (#5812).
+func TestChatCarriedSealedAskedWithPlainIDs(t *testing.T) {
+	fresh(t)
+	up := &idChecker{check: true}
+	srv := httptest.NewServer(up)
+	t.Cleanup(srv.Close)
+	if err := provider.Save(provider.Provider{ID: "relay", Name: "Relay", Key: "k", Models: []string{"gpt-6.1"}, Responses: srv.URL + "/v1"}); err != nil {
+		t.Fatal(err)
+	}
+	seal := `{"type":"reasoning","id":"rs_` + strings.Repeat("a", 425) + `","summary":[],"encrypted_content":"copilot-sealed"}`
+	carry := reasonedID("call_copilot_1", []json.RawMessage{json.RawMessage(seal)})
+	if carry == "call_copilot_1" {
+		t.Fatal("the call carries no reasoning")
+	}
+	ask := `{"model":"relay/gpt-6.1","stream":true,"messages":[
+		{"role":"user","content":"fix the login bug"},
+		{"role":"assistant","content":"I'll look.","tool_calls":[{"id":"` + carry + `","type":"function","function":{"name":"shell","arguments":"{\"cmd\":\"ls\"}"}}]},
+		{"role":"tool","tool_call_id":"` + carry + `","content":"main.go"}]}`
+	s := New()
+	rec := httptest.NewRecorder()
+	s.Handler().ServeHTTP(rec, httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(ask)))
+	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "DONE") {
+		t.Fatalf("%d %s", rec.Code, rec.Body.String())
+	}
+	asked := up.asked()
+	if len(asked) != 2 {
+		t.Fatalf("asked the relay %d times, want the refusal and the ask again", len(asked))
+	}
+	b, _ := json.Marshal(asked[0])
+	if !strings.Contains(string(b), `"encrypted_content":"copilot-sealed"`) {
+		t.Errorf("the first ask went without the seal it was refused over: %s", b)
+	}
+	var overlong bool
+	for _, it := range asked[1] {
+		if id, ok := it["id"].(string); ok && (len(id) > 64 || !openaiItemID.MatchString(id)) {
+			overlong = true
+			t.Errorf("item id %q sent", id)
+		}
+	}
+	if !overlong {
+		if b, _ := json.Marshal(asked[1]); !strings.Contains(string(b), `"encrypted_content":"copilot-sealed"`) {
+			t.Errorf("the ask again went without the seal: %s", b)
+		}
+	}
+}
-- 
2.50.1 (Apple Git-155)
```

</details>

**Branch with the commit**: [`fix/5812-item-id-length-cap`](https://github.com/ggbdpq/magpie/tree/fix/5812-item-id-length-cap) (head `8b997f76c9e2ef9c7a0a7d0e3c34eddbbc7ce596`), rebased onto current `upstream/main` (`be9dbce02` — fetched again before delivery; dae104bfa, the `itemIDRefusal` rewrite this patch builds its tail list beside, was already in the base). On a fresh checkout `git am` applies clean.

| Check | Result |
| --- | --- |
| `TestItemIDRefusalLengthTooLong` (new) | red before the fix (the length wording read as no refusal), pass after; another field's "string too long" and a tail beyond the 1000 characters read as no refusal, as they should |
| `TestRelayRefusingOverlongItemIDsAskedAgain` (new) | red before (`turn 0: 400 … Invalid 'input[0].id': string too long. Expected a string with maximum length 64, but got a string with length 428 instead.` — the issue's own error, word for word), pass after: asked twice the first turn, once the second, the answer's id gone and its words kept |
| `TestChatCarriedSealedAskedWithPlainIDs` (new) | red before (400, the carried seal's 428-character id replayed by the build), pass after: the refusal read, the seal replayed with its id bound to 64, and the refusal remembered |
| `TestItemIDRefusalAsTheRegexp`, `TestRelayRefusingItemIDsAskedAgain`, `TestCopilotTakesAnotherVendorsItemIDs`, `TestCopilotTakesAnotherVendorsOverlongItemIDs`, `TestCodexOwnModelTakesAnotherVendorsItemIDs`, `TestMuseKeepsItsOwnItemIDs`, `TestPlainItemIDsBoundItemIDs`, `TestPlainItemIDsBindsOtherKinds`, `TestCopilotTakesItsOwnOpaqueCallID`, `TestCopilotTakesItsOwnOpaqueSearchCallID` | pass — the character refusal, the bindings and every deliberate keep keep their pinned behavior |
| `go test -tags nogui -count=1 ./...` (temp HOME, pinned Go caches) | 86 packages ok; the failures fail the same on the clean parent: TestMothX in internal/agent, TestProxyCheckSaysAProxyPassedBy in internal/gui (the 502 through this machine's 7897 proxy), TestHostToldTheGatewayAddress in internal/plugin — the standing reds; internal/gateway as a whole package hit its 10-minute package timeout under the full run's load and passes clean alone (below) |
| `go test -tags nogui -count=1 -timeout 30m ./internal/gateway/` (alone) | ok — the whole package, the three new tests in it |
| `gofmt -l` over the touched files | prints nothing |
| `go vet ./...`; `GOOS=linux go vet -tags nogui ./...`; `GOOS=windows go vet ./...` | clean |
| `go build`; `GOOS=linux go build -tags nogui ./...`; `GOOS=windows go build ./...` | clean (the macOS link prints its usual Xcode version warnings, exits 0) |
| Ablation 1 — the length tail taken out of `itemIDRefusalTails` (product file only, tests kept, parent = branch parent) | all three new tests red again (the wording reads as no refusal, both paths stop asking again); restored, green |
| Ablation 2 — the translated path's two blocks taken out (product file only, tests kept) | only `TestChatCarriedSealedAskedWithPlainIDs` red — the relayed test and the unit stay green on the tail list alone, which is what says the two halves are each carrying their own path; restored, green |

**Not verified**: a real Copilot-minted 420–444-character id against a real OpenAI relay — NOT-RUNNABLE here (no Copilot account on this machine); the mock upstream refuses with OpenAI's own error, word for word, and the reactive contract it exercises is the one echo_ts's relay has run in production since the character refusal landed. Your session of 40+ turns stays with you; the patch makes the first refusal the last.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

Generated-by: GLM-5.3-Flash (ZCode)
