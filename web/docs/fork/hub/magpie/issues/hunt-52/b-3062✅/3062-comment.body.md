The relay's refusal now reads as an unreadable item: the thread is asked again without the reasoning the relay can't resolve, instead of 400ing on every turn.

Setup as reported: the magpie gateway on current `main` (checked at `dee5c9d7`) with a Responses passthrough provider in front of OpenAI (opencode.ai's OpenCode Go), Codex CLI/Desktop on the gateway. Codex replays its full item history, reasoning items included, on every turn, and a thread collects `rs_` ids the passthrough cannot resolve two ways: a turn failed over to a provider magpie translates (Chat/Anthropic wire) gives Codex reasoning items magpie minted — an `rs_` id and a summary, nothing sealed — which never existed on the relay's store; and the relay seals its own reasoning only briefly, so after a resume gap (1h50m in the report's logs) ids from its own earlier replies read as expired. Replaying such an id, the relay answers 400 in its own words: `OpenCode Go: Referenced reasoning item 'rs_…' was not found or has expired.` I verified on current `main` that this passes the gateway unread — `unreadableItem` (the matcher behind `refusesInput`) knows only OpenAI's own "Item with id 'rs_…' not found" and "encrypted content for item", and the relay's body names no `param`, so `refusesInput` is false and the 400 is surfaced as is, and the thread dies on every later turn. Nothing in this area changed between the matcher's last touch (`67056512`, the #1008 era) and `dee5c9d7`.

Branch: [`hunt52-b-relay-refusal`](https://github.com/ggbdpq/magpie/tree/hunt52-b-relay-refusal), one commit on top of upstream `dee5c9d7`; the patch below applies with `git am`.

## What changed

One alternative in the `unreadableItem` regexp (`internal/gateway/codex_backend.go`): `referenced reasoning item` joins `item with id` and `encrypted content for item`, generalized the way the matcher already generalizes — stable phrase, the id captured whatever it is, OpenAI's own wordings untouched. The family's three readers then all take the relay's refusal:

- `refusesInput`, the passthrough repair loop (`internal/gateway/gateway.go`): the 400 is recognized and the turn is asked again without the bare reasoning (`withoutBareReasoning`), and once that works the provider's model isn't sent bare reasoning again (`bareReasoningRefused`, the #1044 memory).
- `withoutUnreadable`, the ChatGPT backend loop (`internal/gateway/codex_backend.go`): the named item is dropped by id (`withoutItem`) and the rest asked again.
- `itemNotFound` (compaction): a summary request refused so is asked again with the conversation as text.

Nothing else moved: a 400 over something else (`reasoning.effort`, reasoning with its text in it) is still passed through as the upstream's answer — `TestBareReasoningKeptOverAnotherRefusal` pins that.

## Red before the fix

`TestRelayRefusedReasoningItemReadAsUnreadable` in `internal/gateway/bare_reasoning_test.go`, mirroring the #1044 test beside it: the stub relay refuses any bare reasoning item with the reporter's exact body, naming the id it saw; a compaction and a plain turn go through the gateway. Before the fix, both subtests fail with the 400 surfaced — `Relay: OpenCode Go: Referenced reasoning item 'rs_…' was not found or has expired.` — the reporter's every-turn death; a new `TestRefusesInput` table row for the reporter's body fails with `false` the same way. After the fix: 200 with the reply, two asks (the second without the unresolvable items, every other item kept in place), and the next request goes without them at once.

## Verification

(darwin/arm64, go 1.26.8; commit `895240da`)

| Check | Result |
| --- | --- |
| targeted family after (`TestRelayRefusedReasoningItemReadAsUnreadable`, `TestRefusesInput`, `TestBareReasoning*`, `TestCodexCompactItemNotFoundAsksAgainAsText`, `TestForeignReasoning*`, `TestForeignSeal*`) | ok, 10/10 |
| ablation: same family with the regexp's new alternative reverted, tests kept | FAIL: the e2e surfaces the relay's 400, the new table row reads `false`; the old wordings' rows stay green |
| mutation: the new wording broken (`referenced reasoning itemX`) | the new tests go red; the old OpenAI-wording tests (#1044's param-`input`, item-not-found compaction, foreign reasoning) stay green |
| targeted family with `-race` | ok |
| `gofmt -l internal/gateway/` | clean |
| `go vet ./internal/gateway/` (darwin / linux / windows) | OK |
| `go build -tags nogui` (darwin / linux / windows) | OK |
| full `go test ./internal/gateway/` | green on the third run (511s); a first run hit go test's default 10m timeout, and a second failed only `TestAsyncGatewayResponseDoesNotHoldStream` — a fixed-10s-guard streaming-hook test untouched by this change, green 3/3 alone and in its family on retries |

## Siblings

The other refusal wordings this sits beside, and where the family is matched:

- `unreadableItem` (this matcher): "encrypted content for item" and "Item with id 'rs_…' not found" (OpenAI's own), now "Referenced reasoning item '…' was not found or has expired" (a relay's own, #3062). Read at `withoutUnreadable` (ChatGPT backend, the named item dropped), `refusesInput` (passthrough re-ask without bare reasoning) and `itemNotFound` (compaction asked again as text).
- `foreignReasoning` (`internal/gateway/affinity.go`): `invalid_encrypted_content` / "encrypted content could not be verified/decrypted" — reasoning another account sealed. It reseals on a second account (`gateway.go`), falls back to dropping all reasoning in `withoutUnreadable`, and is asked again without in `responses.go`.
- The passthrough loop's other recognized refusals, each with its own re-ask: `refusesReasoningText` ("Invalid 'input[n].content'…" when the reasoning item really carries text, #1411), `itemIDRefusal` ("Expected an ID that contains letters, numbers, underscores, or dashes", Muse Spark's `echo_ts`), `toolStrictRefusal` (#1980), `rootUnionRefusal` (#1271), `upstreamFailedWords` ("upstream request failed", #866/#1511).

## Not verified

- No real opencode.ai relay was at hand; the wording is quoted from the report and played back word for word by the test relay, which composes the named id from the request, as the report's body shows.
- Other relays may word the same refusal differently. The report's longer-term suggestions — remembering the ids magpie mints in translated replies, or matching an `rs_`-shaped id plus "not found" structurally — would be wording-independent; deliberately not part of this patch.
- Windows and cross-compiled linux are build and vet only, as usual for this repo's matrix.

**AI**: written with an AI coding agent; I've read the whole diff and can answer questions on it myself. The model name is in the commit's trailer.
**Attribution**: If you apply the patch, please keep its author (ggbdpq) or add a `Co-authored-by: ggbdpq <ggbdpq@gmail.com>` line.

<details><summary>patch (git am)</summary>

```patch
From 895240daaa5d6e703fcc0f0344e81d379afb6af9 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Tue, 20 Oct 2026 20:32:04 +0800
Subject: [PATCH] gateway: a relay's "referenced reasoning item" refusal is
 read as an unreadable item (#3062)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

What changed: unreadableItem, the matcher that reads a 400 as "this input
item can't be read", now also takes the wording a Responses passthrough
relay answers in — "Referenced reasoning item 'rs_…' was not found or has
expired" — beside OpenAI's own ("Item with id 'rs_…' not found",
"encrypted content for item"). The refusal is recognized wherever the
matcher is read: the passthrough turn is asked again without the bare
reasoning (and the provider's model isn't sent them again), the ChatGPT
backend drops the named item and asks the rest again, and a compaction
refused so is asked again as text.

Why: a Codex thread behind such a relay (opencode.ai's OpenCode Go)
collects reasoning ids the relay can't resolve, two ways — a turn failed
over to a provider magpie translates leaves Codex reasoning items magpie
minted (an rs_ id and a summary, nothing sealed), which never existed on
the relay's store; and the relay seals its own reasoning only briefly, so
after a resume gap ids from its earlier replies read as expired. Codex
replays the whole history every turn, and the relay's 400, worded by the
relay and naming no input param, passed refusesInput unread — so the
thread 400s on every later turn. The reporter's repro now strips the
named bare item, asks again, and answers 200.

Run: TestRelayRefusedReasoningItemReadAsUnreadable and a TestRefusesInput
row for the reporter's exact body are red before the change and green
after; the bare-reasoning, foreign-seal and item-not-found families stay
green (also with -race, and under an ablation and a mutation of the new
wording, where the old wordings' tests stay green); gofmt clean; go vet
on darwin, linux and windows; builds with -tags nogui on the three. Full
./internal/gateway/ is green on the third run (511s); a first run hit go
test's default 10m timeout and a second failed only
TestAsyncGatewayResponseDoesNotHoldStream — a fixed-10s-guard streaming
hook test unrelated to this change, which passes 3/3 alone.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/bare_reasoning_test.go | 70 ++++++++++++++++++++++---
 internal/gateway/codex_backend.go       |  9 ++--
 2 files changed, 69 insertions(+), 10 deletions(-)

diff --git a/internal/gateway/bare_reasoning_test.go b/internal/gateway/bare_reasoning_test.go
index 55bac1d3..73f35e1b 100644
--- a/internal/gateway/bare_reasoning_test.go
+++ b/internal/gateway/bare_reasoning_test.go
@@ -16,14 +16,17 @@ import (
 // reporter captured it: a request whose input has reasoning with nothing
 // sealed in it is turned away with the relay's own 400, word for word,
 // naming only the input; without such reasoning the turn is answered. With
-// refuse unset it takes the reasoning, as a relay for a DeepSeek model does
-// (#388). With status set, every request gets that error instead.
+// expired set it turns the same reasoning away in an OpenCode Go relay's
+// own words, naming the id it can't resolve (#3062). With refuse unset it
+// takes the reasoning, as a relay for a DeepSeek model does (#388). With
+// status set, every request gets that error instead.
 type relayUpstream struct {
-	mu     sync.Mutex
-	refuse bool
-	status int
-	errMsg string
-	inputs [][]map[string]any
+	mu      sync.Mutex
+	refuse  bool
+	expired bool
+	status  int
+	errMsg  string
+	inputs  [][]map[string]any
 }
 
 func (u *relayUpstream) ServeHTTP(w http.ResponseWriter, r *http.Request) {
@@ -49,6 +52,12 @@ func (u *relayUpstream) ServeHTTP(w http.ResponseWriter, r *http.Request) {
 			io.WriteString(w, `{"error":{"message":"bad response status code 400 (request id: 20261007000605227481978n1OdHdSC)","type":"invalid_request_error","param":"input","code":null}}`)
 			return
 		}
+		if u.expired && it["type"] == "reasoning" && enc == "" {
+			w.Header().Set("Content-Type", "application/json")
+			w.WriteHeader(http.StatusBadRequest)
+			io.WriteString(w, `{"error":{"message":"OpenCode Go: Referenced reasoning item '`+it["id"].(string)+`' was not found or has expired.","type":"invalid_request_error"}}`)
+			return
+		}
 	}
 	w.Header().Set("Content-Type", "text/event-stream")
 	io.WriteString(w, sse(
@@ -169,6 +178,52 @@ func TestBareReasoningLeftOutWhereRefused(t *testing.T) {
 	}
 }
 
+// #3062: a Codex thread behind a Responses passthrough relay collects
+// reasoning ids the relay can't resolve — ones magpie minted in a
+// translated reply, or the relay's own whose seal lapsed after a resume
+// gap — and Codex replays them on every turn. The relay answers 400 in
+// its own words, naming no input ("OpenCode Go: Referenced reasoning item
+// 'rs_…' was not found or has expired."), and the thread stayed broken for
+// good. The refusal is read as OpenAI's own unreadable item: asked once
+// more without the bare reasoning, every other item kept, and that
+// provider's model isn't sent them again.
+func TestRelayRefusedReasoningItemReadAsUnreadable(t *testing.T) {
+	for _, tc := range bareRequests("relay/gpt-5.4") {
+		t.Run(tc.name, func(t *testing.T) {
+			fresh(t)
+			u := &relayUpstream{expired: true}
+			saveRelay(t, u)
+			s := New()
+			rec := codexPostTo(s, tc.body)
+			if rec.Code != 200 || !strings.Contains(rec.Body.String(), "SUMMARY") && !strings.Contains(rec.Body.String(), "U1VNTUFSWQ") {
+				t.Fatalf("%d %s", rec.Code, rec.Body)
+			}
+			got := u.asked()
+			if len(got) != 2 {
+				t.Fatalf("asked the relay %d times, want 2", len(got))
+			}
+			if ids := strings.Join(reasoningIDs(got[0]), ","); ids != "rs_18dbe693b3dce4800000003c,rs_18dbe693b3dce4800000003d,rs_sealed" {
+				t.Errorf("first ask's reasoning: %s", ids)
+			}
+			if ids := strings.Join(reasoningIDs(got[1]), ","); ids != "rs_sealed" {
+				t.Errorf("asked again with reasoning %s, want the sealed only", ids)
+			}
+			before, after := kinds(got[0]), kinds(got[1])
+			for _, k := range []string{"message", "function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output"} {
+				if after[k] == 0 || after[k] != before[k] {
+					t.Errorf("%s: %d asked again, %d first", k, after[k], before[k])
+				}
+			}
+
+			// the next request goes without them at once
+			rec = codexPostTo(s, tc.body)
+			if got = u.asked(); rec.Code != 200 || len(got) != 3 || strings.Join(reasoningIDs(got[2]), ",") != "rs_sealed" {
+				t.Fatalf("again: %d, %d asks, reasoning %v", rec.Code, len(got), reasoningIDs(got[len(got)-1]))
+			}
+		})
+	}
+}
+
 // An upstream that takes reasoning with nothing sealed in it, as a relay
 // for a DeepSeek model wants it back (#388), still gets it as Codex sent
 // it, and is asked once.
@@ -222,6 +277,7 @@ func TestRefusesInput(t *testing.T) {
 		{400, `{"error":{"message":"bad response status code 400 (request id: x)","type":"invalid_request_error","param":"input","code":null}}`, true},
 		{400, `{"error":{"message":"Invalid 'input[3].id'","type":"invalid_request_error","param":"input[3].id"}}`, true},
 		{400, `{"error":{"code":null,"message":"Item with id 'rs_1' not found.","param":null,"type":"invalid_request_error"}}`, true},
+		{400, `{"error":{"message":"OpenCode Go: Referenced reasoning item 'rs_18e02568274e11f100000242' was not found or has expired.","type":"invalid_request_error"}}`, true},
 		{400, `{"error":{"message":"bad response status code 400","type":"invalid_request_error"}}`, false},
 		{400, `{"error":{"message":"Invalid value for 'reasoning.effort'","param":"reasoning.effort"}}`, false},
 		{400, `{"error":{"message":"bad","param":"inputs"}}`, false},
diff --git a/internal/gateway/codex_backend.go b/internal/gateway/codex_backend.go
index 07e4e654..0e67782d 100644
--- a/internal/gateway/codex_backend.go
+++ b/internal/gateway/codex_backend.go
@@ -1404,9 +1404,12 @@ func codexServed(base string, h http.Header, on *provider.Provider) (id, account
 	return p.ID, p.Account.User
 }
 
-// unreadableItem is the item OpenAI's refusal names: sealed content it
-// can't verify, or an id it doesn't have ("Item with id 'rs_…' not found").
-var unreadableItem = regexp.MustCompile(`(?i)(?:encrypted content for item|item with id) '?([A-Za-z]+_[A-Za-z0-9_-]+)'?`)
+// unreadableItem is the item a refusal names: sealed content OpenAI
+// can't verify, or an id it doesn't have ("Item with id 'rs_…' not
+// found"), which a relay in front of one answers in words of its own
+// ("Referenced reasoning item 'rs_…' was not found or has expired",
+// #3062).
+var unreadableItem = regexp.MustCompile(`(?i)(?:encrypted content for item|item with id|referenced reasoning item) '?([A-Za-z]+_[A-Za-z0-9_-]+)'?`)
 
 // withoutUnreadable is body without what OpenAI's refusal msg says it
 // can't read: the item it names, or the reasoning another account sealed.
-- 
2.50.1 (Apple Git-155)

```

</details>
