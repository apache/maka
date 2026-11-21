@zxxvGW's read is right, and the third leg of it was the one to fix. A Claude Code call through the gateway and its session file's copy of the same call share no request id: the file names the reply's message id (`message.id`) and no request id of the gateway's own, so the two logs met only in the ±2s window's fallback — which a copy whose end lies 5s apart, or whose token counts split differently, misses. The file's call stayed behind as a second, local one (`session-unknown`, counted as "not through magpie"), and the call was counted twice. Codex doesn't see this: its pairing goes by the reply's id (`codexResponseMatches`), and its session file carries that id.

**Root cause**: the reply's id never entered the request-id matching. `matchedBlocks` (internal/usage/request_page.go:2005 at v0.1.3302) matches by the request id (Text slot 11), and `logRecord` (internal/usage/ledger.go:389) keeps `ResponseID` a Codex-only field (`TestLogRecordResponseIDRemainsCodexOnly` locks that, rightly — the Codex identity work keys on it). Meanwhile the gateway had recorded Claude's `message.id` as the reply's id all along (the sniffer's `v.Message.ID`), and the session file's copy sits on the local row as its message id (Text slot 35) — two names of one call, and the matcher knew neither pairing.

**The fix**: the reply's id is now the gateway call's other name. A gateway call's group is filed under both of its ids, and a local call looks its request id up and, if none answers, its message id; the ledger's matching (`gatewayMatchesDetails`), the page's (`pairRowsIn`) and the direct calls' (`directRows`) all sit on `matchedBlocks`, so one change covers the three. A file whose message ids the reply ids name is now among the chunks matching decodes (`hintsOf` keeps the message ids beside the request ids — the #2278 shortcut would otherwise have skipped it). The request ids' matching is untouched, and so is the fallback for the calls neither log names an id of: the window, the uniqueness and the agy special-casing all stand. `logRecord`'s Codex-only `ResponseID` stands too — nothing is written into any row's fields; only the matcher reads two names where it read one.

<details><summary>patch: usage: a Claude call's message id is matched to the gateway's reply's id — git am applies it as is; SHA-256 first 16: cc0e545402695e98; also as [`​.patch`](https://github.com/ggbdpq/magpie/commit/2dca1d1fcb06958c607df942baa954edcbae0d66.patch)</summary>

```text
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Mon, 9 Nov 2026 05:50:32 +0800
Subject: [PATCH] usage: a Claude call's message id is matched to the gateway's
 reply's id (#5674)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

A Claude call through the gateway and its session file's copy share no
request id: Claude Code's file names the reply's message id, and no
request id of the gateway's own, so the two logs met only in the ±2s
window's fallback, which a copy 5s apart or of other token counts
misses — the call stayed behind as a second, local one, counted twice,
once through magpie and once as not.

The reply's id is now the gateway call's other name: the local calls
naming either id find the call's group, on the ledger's, the page's and
the direct calls' matching alike. The request ids' matching, and the
fallback for the calls neither log names an id of, are as they were.

Attribution: 分析与补丁由 GLM-5.3-Flash (ZCode) 协助完成
Generated-by: GLM-5.3-Flash (ZCode)
---
 .../usage/claude_responseid_match_test.go     | 144 ++++++++++++++++++
 internal/usage/match_chunks.go                |   5 +
 internal/usage/request_page.go                |  32 +++-
 3 files changed, 177 insertions(+), 4 deletions(-)
 create mode 100644 internal/usage/claude_responseid_match_test.go

diff --git a/internal/usage/claude_responseid_match_test.go b/internal/usage/claude_responseid_match_test.go
new file mode 100644
index 000000000..a582b7309
--- /dev/null
+++ b/internal/usage/claude_responseid_match_test.go
@@ -0,0 +1,144 @@
+package usage
+
+import (
+	"testing"
+	"time"
+
+	"github.com/yetone/magpie/internal/sessions"
+)
+
+// A Claude call through the gateway and the session file's copy of that
+// call share no request id: Claude Code's file names the API's message id,
+// which the gateway recorded as the reply's id, and names no request id of
+// the gateway's own (#5674). Matching the two logs by that id tells one
+// call, where the ±2s fallback alone matched neither a copy whose end lies
+// beyond the window (#5674, case A) nor one whose token counts differ
+// (#5674, case B), and left it behind as a second, local call.
+func claudePair(at time.Time, localEnd time.Duration, gwOut, localOut int) ([]Record, []sessions.Call) {
+	recs := []Record{{
+		Time: at, Agent: "claude", Provider: "anthropic", Model: "claude-sonnet-4-5",
+		Input: 100, Output: gwOut, Millis: 1000, Status: 200,
+		RequestID: "mgp-1", ResponseID: "msg_abc", Session: "s",
+	}}
+	logs := []sessions.Call{{
+		Time: at.Add(localEnd), Agent: "claude", Session: "s", Model: "claude-sonnet-4-5",
+		Tokens: sessions.Tokens{Input: 100, Output: localOut}, Millis: 1000, Msg: "msg_abc",
+	}}
+	return recs, logs
+}
+
+// The gateway's reply id and the session file's message id are one call's
+// two names: matched even where the ±2s window's fallback is not, and
+// counted once, not once through magpie and once as a local call.
+func TestClaudeMessageIDMatchesGatewayResponseID(t *testing.T) {
+	now := time.Date(2026, 10, 1, 13, 0, 0, 0, time.UTC)
+	recs, logs := claudePair(now, 5*time.Second, 50, 50) // case A: 5s apart, the same tokens
+	matched := gatewayMatches(recs, logs)
+	if !matched[0] {
+		t.Fatal("the file's call of the reply's id was left as a second, local call")
+	}
+	rows, _, _, _ := ledgerWith(time.Time{}, Filter{}, recs, logs)
+	if len(rows) != 1 {
+		t.Fatalf("one call told %d rows apart", len(rows))
+	}
+	if len(rows) == 1 && rows[0].Source == "log" {
+		t.Fatal("the gateway's own call was read away as a local one")
+	}
+}
+
+// The same reply id tells the call though its two logs split the tokens
+// differently, as the window's fallback, which matches on the counts, did
+// not.
+func TestClaudeMessageIDMatchesDespiteTokenMismatch(t *testing.T) {
+	now := time.Date(2026, 10, 1, 13, 0, 0, 0, time.UTC)
+	recs, logs := claudePair(now, time.Second, 50, 60) // case B: within the window, tokens apart
+	matched := gatewayMatches(recs, logs)
+	if !matched[0] {
+		t.Fatal("the file's call of the reply's id was left as a second, local call")
+	}
+	rows, _, _, _ := ledgerWith(time.Time{}, Filter{}, recs, logs)
+	if len(rows) != 1 {
+		t.Fatalf("one call told %d rows apart", len(rows))
+	}
+}
+
+// A call the gateway and the file name by the same request id is matched as
+// it was, whatever the reply ids say.
+func TestCodexRequestIDMatchUnchanged(t *testing.T) {
+	now := time.Date(2026, 10, 1, 13, 0, 0, 0, time.UTC)
+	recs := []Record{{
+		Time: now, Agent: "codex", Provider: "openai", Model: "gpt-5.2",
+		Input: 10, Output: 2, Millis: 1000, Status: 200, RequestID: "req-1",
+	}}
+	logs := []sessions.Call{{
+		Time: now.Add(time.Second), Agent: "codex", Session: "native", Model: "gpt-5.2",
+		Tokens: sessions.Tokens{Input: 10, Output: 2}, Millis: 1000, RequestID: "req-1",
+	}}
+	if !gatewayMatches(recs, logs)[0] {
+		t.Fatal("the request id's match was lost")
+	}
+	// Codex's own pairing, by the reply's id, is Codex's still, and the
+	// message id a Claude call names is no Codex reply's.
+	pairs := codexResponseMatches(recs, logs, nil)
+	if len(pairs) != 0 {
+		t.Fatal("a call with no reply id of its own was paired by one")
+	}
+	recs[0].ResponseID = "resp-1"
+	logs[0].ResponseID = "resp-1"
+	if pairs = codexResponseMatches(recs, logs, nil); len(pairs) != 1 {
+		t.Fatal("Codex's reply-id pairing was lost")
+	}
+	if !gatewayMatches(recs, logs)[0] {
+		t.Fatal("Codex's reply-id pairing stopped matching the call")
+	}
+}
+
+// A call neither log names an id of is matched as it was, by its session,
+// tokens and end within the window.
+func TestNoIDFallbackMatchUnchanged(t *testing.T) {
+	now := time.Date(2026, 10, 1, 13, 0, 0, 0, time.UTC)
+	recs := []Record{{
+		Time: now, Agent: "claude", Provider: "anthropic", Model: "claude-sonnet-4-5",
+		Input: 100, Output: 50, Millis: 1000, Status: 200, Session: "s",
+	}}
+	logs := []sessions.Call{{
+		Time: now.Add(time.Second), Agent: "claude", Session: "s", Model: "claude-sonnet-4-5",
+		Tokens: sessions.Tokens{Input: 100, Output: 50}, Millis: 1000,
+	}}
+	if !gatewayMatches(recs, logs)[0] {
+		t.Fatal("the window's fallback match was lost")
+	}
+	recs[0].Time = now.Add(5 * time.Second)
+	if gatewayMatches(recs, logs)[0] {
+		t.Fatal("a call 5s apart matched without an id or the window")
+	}
+}
+
+// The page's own pairing matches the two names too, and reads the file it
+// would have skipped: the chunk's message ids are among what the gateway's
+// reply ids name.
+func TestClaudeMessageIDMatchOpensNamedChunk(t *testing.T) {
+	now := time.Date(2026, 10, 1, 13, 0, 0, 0, time.UTC)
+	recs, logs := claudePair(now, 5*time.Second, 50, 50)
+	gateway := &rowChunk{}
+	gateway.add(Row{Record: recs[0]}, "", 0, false)
+	local := &rowChunk{Source: sessions.CallSource{Path: "/local/cc-session"}}
+	local.add(Row{Record: logRecord(logs[0]), Source: "log"}, logs[0].Msg, 0, false)
+	local.serial = nextChunkSerial()
+	var opened []*rowChunk
+	matchOpening = func(c *rowChunk) { opened = append(opened, c) }
+	t.Cleanup(func() { matchOpening = nil })
+	ps := pairRows(All, now, []*rowChunk{gateway}, []*rowChunk{local}, nil, nil)
+	matched := false
+	for chunk := range ps.matched {
+		if chunk.Source.Path == "/local/cc-session" && ps.matched.has(rowRef{chunk, 0}) {
+			matched = true
+		}
+	}
+	if !matched {
+		t.Fatal("the page's pairing left the file's call as a second, local one")
+	}
+	if len(opened) == 0 {
+		t.Fatal("matching never read the file whose message id the gateway's reply names")
+	}
+}
diff --git a/internal/usage/match_chunks.go b/internal/usage/match_chunks.go
index 7a69bb4d7..30c104ebc 100644
--- a/internal/usage/match_chunks.go
+++ b/internal/usage/match_chunks.go
@@ -69,6 +69,11 @@ func hintsOf(chunks []*rowChunk, rows *chunkRows) []*chunkHints {
 			if id := open.Strings[open.text(p, 11)]; id != "" {
 				h.ids = append(h.ids, uint32(matchHash(id)))
 			}
+			// A Claude call's message id names the gateway's reply (#5674):
+			// a file of such calls is one the reply ids open.
+			if id := open.Strings[open.text(p, rowMsg)]; id != "" {
+				h.ids = append(h.ids, uint32(matchHash(id)))
+			}
 			if p.Tokens[0]+p.Tokens[1]+p.Tokens[2]+p.Tokens[3] == 0 && p.Flags&16 == 0 {
 				continue
 			}
diff --git a/internal/usage/request_page.go b/internal/usage/request_page.go
index 8223e9ad6..443ccacd2 100644
--- a/internal/usage/request_page.go
+++ b/internal/usage/request_page.go
@@ -2026,8 +2026,10 @@ func matchedBlocks(gateways []*rowChunk, chunks []*rowChunk, skip refSet, respon
 	withID := 0
 	for _, gateway := range gateways {
 		for i := range gateway.Rows {
-			if gateway.text(&gateway.Rows[i], 11) != 0 && matchable(gateway, i) {
-				withID++
+			if gateway.text(&gateway.Rows[i], 11) != 0 || gateway.text(&gateway.Rows[i], 25) != 0 {
+				if matchable(gateway, i) {
+					withID++
+				}
 			}
 		}
 	}
@@ -2042,14 +2044,30 @@ func matchedBlocks(gateways []*rowChunk, chunks []*rowChunk, skip refSet, respon
 				continue
 			}
 			p := &gateway.Rows[i]
+			// The reply's id is the call's other name (a Claude reply's
+			// message id is, its session file names the same id, and no
+			// request id of the gateway's own, #5674): the local calls
+			// naming either find this call's group.
+			group := int32(-1)
 			if id := gateway.Strings[gateway.text(p, 11)]; id != "" {
 				if k, ok := byID[id]; ok {
 					calls[k].more = append(calls[k].more, ref)
+					group = k
 				} else {
-					byID[id] = int32(len(calls))
+					group = int32(len(calls))
+					byID[id] = group
 					calls = append(calls, idCalls{first: ref})
 				}
 			}
+			if id := gateway.Strings[gateway.text(p, 25)]; id != "" {
+				if _, ok := byID[id]; !ok {
+					if group < 0 {
+						group = int32(len(calls))
+						calls = append(calls, idCalls{first: ref})
+					}
+					byID[id] = group
+				}
+			}
 		}
 	}
 	// the local calls that name an id, chained from its calls[k].last in
@@ -2078,12 +2096,18 @@ func matchedBlocks(gateways []*rowChunk, chunks []*rowChunk, skip refSet, respon
 			if skip.has(ref) || reserved.has(ref) || p.Time().Before(since) {
 				continue
 			}
-			if open.text(p, 11) == 0 {
+			// A call names the request id the gateway made its own and, a
+			// Claude call, the message's id, which is the gateway's reply's
+			// id (#5674).
+			if open.text(p, 11) == 0 && open.text(p, rowMsg) == 0 {
 				continue
 			}
 			if k, ok := byID[open.Strings[open.text(p, 11)]]; ok {
 				found = append(found, idLocal{calls[k].last, timedOf(ref, p)})
 				calls[k].last = int32(len(found))
+			} else if k, ok := byID[open.Strings[open.text(p, rowMsg)]]; ok {
+				found = append(found, idLocal{calls[k].last, timedOf(ref, p)})
+				calls[k].last = int32(len(found))
 			}
 		}
 	}
-- 
2.50.1 (Apple Git-155)
```

</details>

**Branch with the commit**: [`fix/5674-claude-responseid-match`](https://github.com/ggbdpq/magpie/tree/fix/5674-claude-responseid-match) (head `2dca1d1fcb06958c607df942baa954edcbae0d66`), rebased onto current `upstream/main` (`aa3d11d5b`); on a fresh checkout `git am` applies clean (the ammed tree is identical to the branch's).

The two cases the report sketches, made into tests:

| Check | Result |
| --- | --- |
| `TestClaudeMessageIDMatchesGatewayResponseID` (case A: same reply id, ends 5s apart) | red before the fix (the file's call left as a second, local one; the ledger told the one call as two rows), pass after (matched, one row) |
| `TestClaudeMessageIDMatchesDespiteTokenMismatch` (case B: same reply id, token counts apart) | red before, pass after |
| `TestClaudeMessageIDMatchOpensNamedChunk` (new; the page's own pairing) | red before (the pairing left the file's call, and matching never even read the file), pass after (matched, and the file read — the `hintsOf` half of the fix held no other test) |
| `TestCodexRequestIDMatchUnchanged` (new) | pass: a request id's match, and Codex's reply-id pairing (`codexResponseMatches`), as they were |
| `TestNoIDFallbackMatchUnchanged` (new) | pass: the ±2s window's fallback matches as before, and a call 5s apart still matches neither way without an id |
| `TestLogRecordResponseIDRemainsCodexOnly` | pass (`logRecord`'s ResponseID stays Codex's; the fix writes no row's fields) |
| `go test ./internal/usage/ -race -count=1` | ok (67.0s), zero failures — the matching families (`match_chunks`, `pair_scratch`, `codex_pairs_ids`, `codex_identity`, the agy pairing) among them |
| `go test ./internal/sessions/ -count=1` | ok |
| `go vet ./internal/usage/`, `gofmt -l` on the changed files, `go build ./...` (darwin) and `GOOS=linux go build ./internal/usage/` | clean |
| Ablation | reverting the two product files alone turns cases A and B and the page's test red again; restoring them, green (`git diff --stat` clean). A one-line mutation of the new branch's fork (the local lookup reading slot 11 instead of the message id's slot 35) turns them red too — both halves are load-bearing |

**Sweep of the same-family sites, left as they are**: `codexResponseMatches` and the Codex identity work (`codex_identity.go`) key on `Agent == "codex"` beside the id, so a Claude row carrying a reply id changes nothing there — and the fix changes no row's fields, only what the matcher pairs; `sniff.go`'s reply-id capture is the fact the fix stands on, not a defect; `visibleLocal`'s message-id de-duplication reads the same slot for a different job and is untouched; the `session-unknown` consumers (TUI, usageapi, cli) group by the provider string and need no change — the fix only lets fewer through-gateway calls into that group; and the ±2s window itself stays, as the report notes, the right fallback for the calls with no id at all.

**Not verified**: the reporter's own machine (NOT-RUNNABLE here) — what is reproduced is the matcher's shape: both sketch cases red before the change and green after, the two negative controls unchanged, and the whole matching suite green with the fix in.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

Generated-by: GLM-5.3-Flash (ZCode)