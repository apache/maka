**What's wrong**

On `copilot/gpt-6-luna`, Codex's first request through magpie to Copilot goes, the tool call goes out, and every request after the tool's result dies with Copilot's bare `{"error":{"message":"","code":"invalid_request_body"}}`, so no tool workflow can finish a second turn. `gpt-6.1-sol` on the same provider, account and client is fine.

**Root cause**

The request that dies is the first one that carries Copilot's own reply items back, their ids with them — and the failure is in how magpie bounds those ids, not in the protocol hop:

- Copilot hands its items ids hundreds of characters long (420 and 444 recorded in #4525/#4527), and for the sessions isnine reproduced the shape is opaque Base64: `+` and `/` in it, no `msg_`/`rs_`/`fc_` prefix. That splits this report's models: Luna's ids of that shape, Sol's not (inferred from the shared refusal shape, not observed here).
- Since dd809ea60 (v0.1.2652, #4525/#4527) magpie bounds every input item id to the 64 characters Copilot's own validator takes. `boundItemID` kept an id's own prefix only when the id carried one; an opaque id went out as a **bare 64-hex digest** — right length, right characters, no kind prefix.
- Copilot's `/responses` checks the kind prefix too. isnine's follow-up on #4525 (2026-11-02) proved it live against Copilot's `gpt-6.1-terra`: id omitted → 200; bare digest → 400, empty message, `invalid_request_body`; `msg_` + hash → 200. That bare 400 is word for word this issue's error, and it names no field, so none of the rewrites magpie asks again with after a learned refusal could ever match it — the 400 passed to Codex as it came.

**The fix**

`boundItemID` now takes the item's type: a message goes under `msg_`, reasoning under `rs_`, a call under the prefix OpenAI takes for its kind (`fc_`/`ctc_`/`tsc_`, `openaiItemPrefix`); only an item of no known kind still takes a prefix from its id. The digest is unchanged, so a bound id stays the same every turn and no two ids land on one. The fake upstream now checks the prefix as Copilot does and answers its lack with the bare 400, word for word; its long message fixture is of the opaque shape; `TestPlainItemIDsOpaqueKinds` bounds each kind's opaque id under its prefix. The derivation rule follows isnine's candidate on #4525 (commit 9008406), credited with the live verification there; ChenxiGao84's repro matrix here pinned the symptom.

Patch (also at [0001-gateway-an-input-item-s-id-of-no-prefix-of-its-own-i.patch](https://github.com/ggbdpq/magpie/raw/fix/4972-copilot-luna-400/0001-gateway-an-input-item-s-id-of-no-prefix-of-its-own-i.patch) as rendered by `git format-patch` on the branch):

<details>
<summary>0001-gateway-an-input-item-s-id-of-no-prefix-of-its-own-i.patch</summary>

```
From ada3dcdc5c1692847b6819b4a07880e9f015d85e Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 4 Nov 2026 01:49:22 +0800
Subject: [PATCH] gateway: an input item's id of no prefix of its own is bound
 under its kind's, which Copilot checks (#4972)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

Copilot hands its items ids hundreds of characters long (#4525, #4527),
and isnine's follow-up on #4525 showed the shape that still stuck after
dd809ea60: an opaque Base64 one, + and / in it, no msg_ at the front.
boundItemID kept an id's own prefix only when the id carried one, so an
opaque one went out a bare 64-hex digest — the length and the characters
an id checker takes, and still the whole request turned away, Copilot's
bare 400 "invalid_request_body" with nothing in the message. The first
turn of a conversation went (it names no id of the vendor's yet); every
turn after a tool call carried the model's items back and died there,
which is what ChenxiGao84 saw on gpt-6-luna while gpt-6.1-sol worked on
(#4972). Nothing could learn from the refusal: it names no field, so
none of the rewrites a learned refusal asks again with matched it.

So typ now says the prefix: a message msg_, a reasoning rs_, a call the
prefix OpenAI takes for its kind (openaiItemPrefix), and only an item of
no kind takes a prefix from its id. The digest alone is unchanged, so
the bound id stays the same every turn and no two ids land on one.

The fake upstream now checks the kind's prefix too and answers its lack
with the bare 400, word for word; its long message fixture is of the
opaque shape. TestPlainItemIDsOpaqueKinds bounds each kind's opaque id
under its prefix, the item's other members as they were, a bound id
staying bound. Fix approach follows isnine's candidate on #4525
(9008406), verified there live through a real account.

Fixes #4972

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/codex_backend.go           | 34 ++++++--
 internal/gateway/codex_rewrite_scan_test.go |  2 +-
 internal/gateway/item_ids_test.go           | 94 +++++++++++++++++++--
 3 files changed, 115 insertions(+), 15 deletions(-)

diff --git a/internal/gateway/codex_backend.go b/internal/gateway/codex_backend.go
index 84236eb94..0fa110de1 100644
--- a/internal/gateway/codex_backend.go
+++ b/internal/gateway/codex_backend.go
@@ -3078,16 +3078,34 @@ const itemIDCap = 64
 
 // boundItemID is id, of at most itemIDCap characters, as an upstream that
 // checks item ids takes it: one longer goes as its kind's prefix ("msg_",
-// "rs_") and the sha256 of the whole of it, cut to fit. The same id goes
-// to the same shorter one every turn, and no two ids land on one (a plain
-// cut could: ids of a vendor can begin alike).
-func boundItemID(id string) string {
+// "rs_") and the sha256 of the whole of it, cut to fit. Copilot's own ids
+// (its /responses checks the prefix as OpenAI's does) can carry none —
+// opaque Base64, + and / in it, no msg_ or rs_ at the front (#4525) — and
+// one of those went out bare, which passed the length and the characters
+// and still had the whole request turned away with nothing said
+// ("invalid_request_body", #4972): so typ says the prefix — a message
+// msg_, a reasoning rs_, a call the prefix OpenAI takes for its kind
+// (openaiItemPrefix) — and only an item of no kind takes one from its id.
+// The same id and type go to the same shorter one every turn, and no two
+// ids land on one (a plain cut could: ids of a vendor can begin alike).
+func boundItemID(id, typ string) string {
 	sum := sha256.Sum256([]byte(id))
 	digest := hex.EncodeToString(sum[:])
-	if i := strings.IndexByte(id, '_'); i > 0 && i <= 4 && safeID([]byte(id[:i])) {
-		return id[:i+1] + digest[:itemIDCap-i-1]
+	prefix := openaiItemPrefix[typ]
+	switch typ {
+	case "", "message":
+		prefix = "msg_"
+	case "reasoning":
+		prefix = "rs_"
+	case "function_call":
+		prefix = "fc_"
+	}
+	if prefix == "" {
+		if i := strings.IndexByte(id, '_'); i > 0 && i <= 4 && safeID([]byte(id[:i])) {
+			prefix = id[:i+1]
+		}
 	}
-	return digest
+	return prefix + digest[:itemIDCap-len(prefix)]
 }
 
 // plainItemIDs is a Responses request whose input items' ids are of
@@ -3139,7 +3157,7 @@ func plainItemIDs(body []byte) []byte {
 			continue
 		}
 		if len(id) > itemIDCap {
-			id = boundItemID(id)
+			id = boundItemID(id, typ)
 		} else {
 			id = unsafeToolID.ReplaceAllString(id, "_")
 		}
diff --git a/internal/gateway/codex_rewrite_scan_test.go b/internal/gateway/codex_rewrite_scan_test.go
index aec44db1b..f30bbfcf9 100644
--- a/internal/gateway/codex_rewrite_scan_test.go
+++ b/internal/gateway/codex_rewrite_scan_test.go
@@ -609,7 +609,7 @@ func wasPlainItemIDs(body []byte) []byte {
 			continue
 		}
 		if len(id) > itemIDCap {
-			id = boundItemID(id)
+			id = boundItemID(id, typ)
 		} else {
 			id = unsafeToolID.ReplaceAllString(id, "_")
 		}
diff --git a/internal/gateway/item_ids_test.go b/internal/gateway/item_ids_test.go
index d2a76bdd5..ed75b68c3 100644
--- a/internal/gateway/item_ids_test.go
+++ b/internal/gateway/item_ids_test.go
@@ -37,8 +37,11 @@ var openaiItemID = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
 
 // idChecker plays OpenAI's /responses as Copilot passes it on: an input
 // item whose id has another character is refused with OpenAI's 400, word
-// for word as echo_ts got it (Copilot's name is magpie's, before it).
-// With check off it takes any id, as OpenCode does its own.
+// for word as echo_ts got it (Copilot's name is magpie's, before it),
+// and one without its kind's prefix with Copilot's bare 400, word for
+// word as ChenxiGao84 got it (#4972): isnine's live matrix (#4525) has a
+// message's id refused bare and taken under msg_. With check off it takes
+// any id, as OpenCode does its own.
 type idChecker struct {
 	mu     sync.Mutex
 	check  bool
@@ -73,6 +76,14 @@ func (u *idChecker) ServeHTTP(w http.ResponseWriter, r *http.Request) {
 			io.WriteString(w, `{"error":{"message":"Invalid 'input[`+mustString(int64(i))+`].id': string too long. Expected a string with maximum length 64, but got a string with length `+mustString(int64(len(id)))+` instead.","type":"invalid_request_error","param":"input[`+mustString(int64(i))+`].id","code":"string_too_long"}}`)
 			return
 		}
+		// and one of no kind's prefix, with Copilot's bare 400, which says
+		// nothing of the field (#4972)
+		if p := idKindPrefix[it["type"].(string)]; p != "" && !strings.HasPrefix(id, p) {
+			w.Header().Set("Content-Type", "application/json")
+			w.WriteHeader(http.StatusBadRequest)
+			io.WriteString(w, `{"error":{"message":"","code":"invalid_request_body"}}`)
+			return
+		}
 	}
 	w.Header().Set("Content-Type", "text/event-stream")
 	io.WriteString(w, sse(
@@ -234,14 +245,19 @@ func TestCodexOwnModelTakesAnotherVendorsItemIDs(t *testing.T) {
 // copilotLongMessageID and copilotLongReasoningID are ids of the lengths
 // Copilot hands out and Codex carries back: 444 as ghjkllasdf-fake
 // recorded from an approval session (#4527), 420 as isnine's three
-// sessions each showed (#4525) — every one of the characters OpenAI
-// takes an id of, so only their length makes an upstream that checks
-// ids turn the request away.
+// sessions each showed (#4525). The message's is of the opaque Base64
+// shape isnine's follow-up reproduced — `+` and `/` in it, no msg_ prefix
+// — so only its kind's prefix makes an upstream that checks ids take it;
+// the reasoning's carries its own.
 var (
-	copilotLongMessageID   = "msg_" + strings.Repeat("A", 440)
+	copilotLongMessageID   = strings.Repeat("Ab+/", 105)
 	copilotLongReasoningID = "rs_" + strings.Repeat("b", 417)
 )
 
+// idKindPrefix is the id prefix OpenAI takes for an input item of each
+// kind, the check behind Copilot's bare 400 (#4972).
+var idKindPrefix = map[string]string{"message": "msg_", "reasoning": "rs_", "function_call": "fc_"}
+
 // copilotOverlongConversation is a conversation Codex sends Copilot on a
 // later turn: the user's ask, Copilot's own reasoning (sealed, its to
 // read), Copilot's answer under its overlong id, and the next ask.
@@ -461,3 +477,69 @@ func TestPlainItemIDsBoundItemIDs(t *testing.T) {
 		}
 	}
 }
+
+// Copilot's opaque ids (#4525's follow-up, #4972) carry no prefix of
+// their own: a message's is Base64 with + and / in it, and Copilot's
+// /responses turns the whole request away over the prefixless bound id
+// with the bare 400 (#4972). Each kind's id goes out under the prefix
+// OpenAI takes for it, everything else in the item as it was, and a
+// bound id stays bound.
+func TestPlainItemIDsOpaqueKinds(t *testing.T) {
+	for _, tt := range []struct{ typ, prefix string }{
+		{"message", "msg_"},
+		{"", "msg_"},
+		{"reasoning", "rs_"},
+		{"function_call", "fc_"},
+		{"custom_tool_call", "ctc_"},
+		{"tool_search_call", "tsc_"},
+	} {
+		t.Run(tt.typ, func(t *testing.T) {
+			item := map[string]any{"id": strings.Repeat("A", 442) + "==", "type": tt.typ}
+			switch tt.typ {
+			case "", "message":
+				item["role"] = "assistant"
+				item["content"] = []any{map[string]any{"type": "output_text", "text": "OK"}}
+			case "reasoning":
+				// Copilot's own reasoning, its id of the characters the
+				// checker takes and none of its prefixes, is its own to
+				// read back: kept, under rs_
+				item["id"] = strings.Repeat("a", 420)
+				item["encrypted_content"] = "gAAAA"
+				item["summary"] = []any{}
+			case "custom_tool_call":
+				item["call_id"], item["name"], item["input"] = "call_keep", "apply_patch", "patch"
+			case "tool_search_call":
+				item["call_id"], item["execution"] = "call_keep", "client"
+				item["arguments"] = map[string]any{"query": "search"}
+			case "function_call":
+				item["call_id"], item["name"], item["arguments"] = "call_keep", "shell", "{}"
+			}
+			if tt.typ == "" {
+				delete(item, "type")
+			}
+			body := mustJSON(map[string]any{"input": []any{item}})
+			got := plainItemIDs(body)
+			var q struct {
+				Input []map[string]any `json:"input"`
+			}
+			if err := json.Unmarshal(got, &q); err != nil || len(q.Input) != 1 {
+				t.Fatalf("item lost: %s (%v)", got, err)
+			}
+			id, _ := q.Input[0]["id"].(string)
+			if !strings.HasPrefix(id, tt.prefix) || len(id) > 64 || !openaiItemID.MatchString(id) {
+				t.Errorf("bounded %s id %q lacks its kind's prefix or the shape an id checker takes", tt.typ, id)
+			}
+			if _, has := q.Input[0]["call_id"]; has && q.Input[0]["call_id"] != "call_keep" {
+				t.Errorf("the call's call_id changed: %s", got)
+			}
+			delete(item, "id")
+			delete(q.Input[0], "id")
+			if !bytes.Equal(mustJSON(item), mustJSON(q.Input[0])) {
+				t.Errorf("an item's other members changed: %s", got)
+			}
+			if next := plainItemIDs(got); !bytes.Equal(got, next) {
+				t.Errorf("a bound id bound again: %s", next)
+			}
+		})
+	}
+}
-- 
2.50.1 (Apple Git-155)

```

</details>

SHA-256 (first 16): `03b331e3e4d28fb0`

**Verification**

| Check | Result |
| --- | --- |
| New tests against the unfixed tip (7785c4278) | red: `TestCopilotTakesAnotherVendorsOverlongItemIDs` dies at turn 0 with Copilot's bare 400 word for word; `TestPlainItemIDsOpaqueKinds` 6/6 subtests bare digest, no prefix |
| New tests with the fix | green, beside the pre-existing id family: `TestPlainItemIDsBoundItemIDs`, `TestCopilotTakesAnotherVendorsItemIDs`, `TestRelayRefusingItemIDsAskedAgain`, `TestMuseKeepsItsOwnItemIDs`, `TestCodexOwnModelTakesAnotherVendorsItemIDs` |
| Ablation (only the prefix derivation reverted to the bare digest, tests kept) | red on both new tests; restored, green |
| A conversation's bound ids across turns | the same id goes to the same bound one every turn (`TestCopilotTakesAnotherVendorsOverlongItemIDs` compares turn 1's ids with turn 2's) |
| Full `internal/gateway` package, `-tags nogui`, one run | ok, 601s, nothing failed — this machine's known reds (`TestCodexPoolSaysTheClientsVersion`, `TestMothX`, `TestEveryRouteHasACommandOrIsNamed`, `TestProxyCheckSaysAProxyPassedBy`, `TestHostToldTheGatewayAddress`) did not fire this run |
| `-race` over the item-id / Codex-rewrite / relay family | ok, 20.4s |
| `gofmt -l` on the three changed files; `go vet -tags nogui ./internal/gateway`; `go build ./...` | clean; clean; ok |

**Not verified + AI use**

Not tried: a live Copilot account — the fake upstream's prefix check is modeled on isnine's live matrix against Copilot's real `gpt-6.1-terra` (#4525 follow-up), which this patch's rule follows; whether Luna's own ids are of the opaque shape is inferred from the shared bare refusal, not observed. A Copilot item id of 64 characters or fewer carrying `+`/`/` still goes with each of those characters as `_` and no prefix added — untouched, not in this report's evidence. Sibling id-shorteners left as they are: `provider.BoundCallID` (a `call_id` — the ChatGPT backend has taken its bare digest since #732 with no complaint, and no evidence says a call_id needs a prefix) and the Chat path's synthesized `call_…` ids. Not run: the rest of the repository's packages (the change is inside `internal/gateway` alone), GUI tests.

Written by GLM-5.3-Flash (ZCode) — AI-written; author is ggbdpq <ggbdpq@gmail.com> alone, no Co-authored-by.

Branch: https://github.com/ggbdpq/magpie/tree/fix/4972-copilot-luna-400 (head `ada3dcdc5c1692847b6819b4a07880e9f015d85e`)

