@yetone — and @1007cordon-ux, whose write-ups above pin the whole mechanism. A Codex compaction whose summary request overflows the model's window never reached the plain-text / local fallback when the refusal arrived in the stream: the thread failed every compaction and was held for good (20+ of the same oversized ask in app.log, none asked again as text). Patch attached.

**Root cause**: exactly as reported. A summary request for a long thread is too big to even start inside `keepHeldAfter` (3s), so the hold's keepalive says the stream's 200, and the overflow then arrives in it, as the `response.failed` the ChatGPT backend answers an over-window input with. In `codexCompact`'s ask (`internal/gateway/codex_backend.go:3610`), `compactReply` says that refusal in `err` while the recorder's status stays 200 — where `summaryTooLarge` looks for a 413 or a 400/413/422 saying it (`overflowed`), and the only `err` branch matched `protectionWords` (#1270's shape). So the ask never joined the text-retry ladder, the failure counted toward `compactFails`, and Codex was told 502 "so there is no summary" — the stuck app.log line.

**The fix**: following the reporter's own analysis — the refusal's words are read in `err` too (`tooLargeSaid` in `codex_backend.go`, beside `summaryTooLarge`): `tooLong(400, err.Error())`, the same wording check a 400's body goes through, with its guards (max_tokens, rate wording) intact. The classification is the refusal's words, not the keepalive: an overflow that arrives in the stream at once, the keepalive never having fired, is asked again as text the same (test 3). A failure saying nothing of size is no answer to it, and one said in its status was already asked again as text (`summaryTooLarge`, tests 4-5).

Boundaries, as offered: #5134's shape — a relay's 4xx that arrives past the keepalive, released as a stream error whose words may name no size ("Upstream request failed") — is **not** covered. In-stream that refusal has no status to read, and classifying it by its words alone would take the text ask on failures whose 401/403/429 the `upstreamFailed` status check deliberately excludes (masking a spent sign-in as a silent local summary). That one wants the failed status carried through the hold (`holdWriter.release`) into the recorder — a shared-machinery change I've left out of this. #3106 is a different face again (a Chat upstream refusing the summary's message shape).

<details><summary>patch: gateway: an overflow in a compaction's stream is asked again as text (#5686) — git am applies it as is; SHA-256 first 16: e8fc114170b14117</summary>

```patch
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sun, 8 Nov 2026 22:10:02 +0800
Subject: [PATCH] gateway: an overflow in a compaction's stream is asked again
 as text (#5686)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

A summary request for a long thread is too big to even start inside
keepHeldAfter, so the hold's keepalive says the stream's 200, and the
overflow refusal arrives in it, as the response.failed the ChatGPT
backend answers an over-window input with. compactReply says it in
err, and the recorder's status stays 200, where summaryTooLarge looks
for a 413 or a 400/413/422 saying it — so the summary was never asked
again as text, nor compacted locally, the failure counted toward the
guard, and Codex asked the same oversized summary over, 20+ times in
app.log, until the conversation was held for good (1007cordon-ux).

Now the refusal's words are read in err too (tooLargeSaid), as a
400's would be: the summary is asked again with the conversation as
text, and magpie makes its own when that is refused too — a thread
far over the window stays over it as text. The classification is the
refusal's words, not the keepalive: an overflow that arrives in the
stream at once is asked again as text the same. A failure saying
nothing of size is no answer to it, and one said in its status was
already asked again as text (summaryTooLarge).

The same gap has a second face where the refusal's status itself is
lost: a relay's 4xx that arrives past the keepalive goes out as a
stream error whose words may name no size (upstreamFailed, #5134).
Classifying that by its words alone would take the text ask on
failures whose 401/403/429 the status check excludes, so it is left
to carrying the failed status through the hold, not to this.

Test: TestCodexCompactOverflowAfterKeepaliveAsksAsText, TestCodexCompactOverflowAfterKeepaliveCompactsLocally,
TestCodexCompactOverflowInStreamAsksAsText (red before the fix: the
compaction answered 502 "so there is no summary"),
TestCodexCompactOverflowStatusBeforeHoldAsksAsText,
TestCodexCompactOtherBrokenOffStays.

Attribution: 分析与补丁由 GLM-5.3-Flash (ZCode) 协助完成
Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/codex_backend.go             |  16 +-
 .../codex_compact_overflow_keepalive_test.go  | 196 ++++++++++++++++++
 2 files changed, 211 insertions(+), 1 deletion(-)
 create mode 100644 internal/gateway/codex_compact_overflow_keepalive_test.go

diff --git a/internal/gateway/codex_backend.go b/internal/gateway/codex_backend.go
index 8f268a140..3ff45c042 100644
--- a/internal/gateway/codex_backend.go
+++ b/internal/gateway/codex_backend.go
@@ -3625,7 +3625,7 @@ func (s *Server) codexCompact(w http.ResponseWriter, r *http.Request, body []byt
 		local = lateSummary()
 		rec, res, err = &recorder{header: http.Header{}, status: 200}, compactResult{}, nil
 	} else if first := rec.status; lacksEndpoint(first) || itemNotFound(rec) || inputKindRefused(rec, err) || upstreamFailed(rec) || protectionRefused(first, rec.body.Bytes()) ||
-		summaryTooLarge(rec) || err != nil && protectionWords.MatchString(err.Error()) {
+		summaryTooLarge(rec) || tooLargeSaid(err) || err != nil && protectionWords.MatchString(err.Error()) {
 		who, msg := compactFailure(body, rec)
 		if err != nil {
 			msg = "broken off: " + err.Error()
@@ -3859,6 +3859,20 @@ func summaryTooLarge(rec *recorder) bool {
 	return rec.status == http.StatusRequestEntityTooLarge || overflowed(rec.status, rec.body.Bytes())
 }
 
+// tooLargeSaid is the same refusal arriving after the reply began: a
+// summary request too big to start inside keepHeldAfter has its stream's
+// 200 said by the keepalive, and the overflow comes in it as a
+// response.failed (#5686) — compactReply says it in err, and the
+// recorder's status stays 200, where summaryTooLarge looks for a 413 or
+// a 400/413/422 saying it. So the summary was never asked again as text,
+// the failure counted toward the guard, and Codex asked the same
+// oversized summary over until the conversation was held. The words an
+// overflow goes by are the refusal's, read as a 400's would be
+// (tooLong); a failure saying nothing of size is no answer to this.
+func tooLargeSaid(err error) bool {
+	return err != nil && tooLong(http.StatusBadRequest, err.Error())
+}
+
 // itemNotFound is a 400 refusing an item of the input by its id, as Azure
 // OpenAI's and OpenAI's API answer one they never stored ("Item with id
 // 'rs_…' not found", #1008), which a relay in front of them passes on.
diff --git a/internal/gateway/codex_compact_overflow_keepalive_test.go b/internal/gateway/codex_compact_overflow_keepalive_test.go
new file mode 100644
index 000000000..85956a9e8
--- /dev/null
+++ b/internal/gateway/codex_compact_overflow_keepalive_test.go
@@ -0,0 +1,196 @@
+package gateway
+
+import (
+	"io"
+	"net/http"
+	"net/http/httptest"
+	"strings"
+	"sync"
+	"testing"
+	"time"
+
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// #5686 (1007cordon-ux): a summary request for a long thread is big, so
+// the member doesn't answer within keepHeldAfter (3s), and the hold's
+// keepalive has said the stream's 200 by the time the refusal comes. The
+// overflow then reaches the compaction inside the stream, as the
+// response.failed the ChatGPT backend answers an over-window input with:
+// compactReply says it in err, and the recorder's status stays 200, where
+// summaryTooLarge looks for a 413 or a 400/413/422 saying it. So the
+// summary as text and magpie's own were both skipped, the failure counted
+// toward the guard, and Codex asked the same oversized summary over — 20+
+// times in app.log, none asked again as text, the thread stuck for good.
+
+// chatgptOverflow is the ChatGPT backend's overflow refusal, the
+// reporter's words.
+const chatgptOverflow = "Your input exceeds the context window of this model. Please adjust your input and try again."
+
+// slowOverflow answers a summary request only after a wait well past
+// keepHeldAfter, with the overflow stream, as a member answers one too
+// big to even start inside keepHeldAfter; when withSummary is set, an
+// ask that carries the conversation as text is answered with a whole
+// summary instead. Every body it is sent is kept.
+type slowOverflow struct {
+	t           *testing.T
+	withSummary bool
+	atOnce      bool // answers inside keepHeldAfter: the keepalive never fires
+	mu          sync.Mutex
+	got         [][]byte
+}
+
+func (s *slowOverflow) ServeHTTP(w http.ResponseWriter, r *http.Request) {
+	b, _ := io.ReadAll(r.Body)
+	s.mu.Lock()
+	s.got = append(s.got, b)
+	s.mu.Unlock()
+	if s.withSummary && strings.Contains(string(b), "This is the conversation so far") {
+		w.Header().Set("Content-Type", "text/event-stream")
+		io.WriteString(w, wholeSummary(provider.Responses))
+		return
+	}
+	if !s.atOnce {
+		time.Sleep(40 * time.Millisecond) // past the keepHeldAfter these tests shrink
+	}
+	w.Header().Set("Content-Type", "text/event-stream")
+	io.WriteString(w, sse(overflowStream...))
+}
+
+func (s *slowOverflow) calls() [][]byte {
+	s.mu.Lock()
+	defer s.mu.Unlock()
+	return append([][]byte(nil), s.got...)
+}
+
+func (s *slowOverflow) last() []byte {
+	s.mu.Lock()
+	defer s.mu.Unlock()
+	return s.got[len(s.got)-1]
+}
+
+// overflowOn saves provider "fake" (model m1) on s, as setup does.
+func overflowOn(t *testing.T, s *slowOverflow) {
+	t.Helper()
+	noRests()
+	t.Cleanup(noRests)
+	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
+	t.Setenv("XDG_CACHE_HOME", t.TempDir())
+	up := httptest.NewServer(s)
+	t.Cleanup(up.Close)
+	p := provider.Provider{ID: "fake", Name: "Fake", Key: "k", Models: []string{"m1"}, Responses: up.URL + "/v1"}
+	if err := provider.Save(p); err != nil {
+		t.Fatal(err)
+	}
+}
+
+// holdFast shrinks the hold's timers, so the keepalive says the stream's
+// 200 while slowOverflow still says nothing.
+func holdFast(t *testing.T) {
+	t.Helper()
+	k, w := keepHeldAfter, watchEvery
+	keepHeldAfter, watchEvery = 2*time.Millisecond, time.Millisecond
+	t.Cleanup(func() { keepHeldAfter, watchEvery = k, w })
+}
+
+// An overflow that arrives in the stream, after the keepalive has said
+// its 200, is a summary request too large all the same: it is asked again
+// as text, and the whole summary that writes is the compaction.
+func TestCodexCompactOverflowAfterKeepaliveAsksAsText(t *testing.T) {
+	up := &slowOverflow{t: t, withSummary: true}
+	overflowOn(t, up)
+	holdFast(t)
+	code, body := codexPost(t, codexCompactOf("fake/m1", "thread-ov1"))
+	if code != 200 {
+		t.Fatalf("Codex's compaction failed: %d %s", code, body)
+	}
+	if got := compactedText(t, body); got != "SUMMARY" {
+		t.Fatalf("summary %q", got)
+	}
+	if calls := up.calls(); len(calls) != 2 {
+		t.Fatalf("asked %d times", len(calls))
+	}
+	if !strings.Contains(string(up.last()), "This is the conversation so far") {
+		t.Errorf("the summary wasn't asked again as text: %.200s", up.last())
+	}
+}
+
+// The conversation as text is refused the same way — a thread far over
+// the window stays over it as text — and the summary is magpie's own, so
+// the compaction still completes and Codex goes on, instead of asking the
+// same oversized summary until the guard held the conversation.
+func TestCodexCompactOverflowAfterKeepaliveCompactsLocally(t *testing.T) {
+	up := &slowOverflow{t: t}
+	overflowOn(t, up)
+	holdFast(t)
+	code, body := codexPost(t, codexCompactOf("fake/m1", "thread-ov2"))
+	if code != 200 {
+		t.Fatalf("Codex's compaction failed: %d %s", code, body)
+	}
+	sum := compactedText(t, body)
+	for _, want := range []string{"fix the login bug", "now add a test", "I fixed main.go", chatgptOverflow} {
+		if !strings.Contains(sum, want) {
+			t.Errorf("local summary lacks %q:\n%s", want, sum)
+		}
+	}
+	if calls := up.calls(); len(calls) != 2 {
+		t.Fatalf("asked %d times", len(calls))
+	}
+}
+
+// The classification is the refusal's words, not the keepalive: an
+// overflow that arrives in the stream at once, the keepalive never
+// having fired, is asked again as text too.
+func TestCodexCompactOverflowInStreamAsksAsText(t *testing.T) {
+	up := &slowOverflow{t: t, withSummary: true, atOnce: true}
+	overflowOn(t, up)
+	code, body := codexPost(t, codexCompactOf("fake/m1", "thread-ov3"))
+	if code != 200 {
+		t.Fatalf("Codex's compaction failed: %d %s", code, body)
+	}
+	if got := compactedText(t, body); got != "SUMMARY" {
+		t.Fatalf("summary %q", got)
+	}
+	if calls := up.calls(); len(calls) != 2 {
+		t.Fatalf("asked %d times", len(calls))
+	}
+}
+
+// A refusal that says its size in its status, as a 400 before the hold,
+// was already asked again as text, and stays so.
+func TestCodexCompactOverflowStatusBeforeHoldAsksAsText(t *testing.T) {
+	f := &fake{t: t, reply: wholeSummary(provider.Responses),
+		refuse: func(body []byte) (int, string) {
+			if strings.Contains(string(body), "This is the conversation so far") {
+				return 0, ""
+			}
+			return http.StatusBadRequest, `{"error":{"message":"` + chatgptOverflow + `","type":"invalid_request_error"}}`
+		}}
+	setup(t, provider.Responses, f)
+	code, body := codexPost(t, codexCompactOf("fake/m1", "thread-ov4"))
+	if code != 200 {
+		t.Fatalf("Codex's compaction failed: %d %s", code, body)
+	}
+	if got := compactedText(t, body); got != "SUMMARY" {
+		t.Fatalf("summary %q", got)
+	}
+	if f.calls != 2 {
+		t.Fatalf("asked %d times", f.calls)
+	}
+}
+
+// An in-stream failure that says nothing of size is no summary and no
+// text ask, as before: only an overflow is asked again smaller.
+func TestCodexCompactOtherBrokenOffStays(t *testing.T) {
+	f := &fake{t: t, reply: sse(
+		`data: {"type":"response.created","response":{"id":"r1","status":"in_progress","output":[]}}`,
+		`data: {"type":"response.failed","response":{"id":"r1","status":"failed","error":{"code":"rate_limit_exceeded","message":"Individual quota reached"}}}`)}
+	setup(t, provider.Responses, f)
+	code, body := codexPost(t, codexCompactOf("fake/m1", "thread-ov5"))
+	if code < 400 || strings.Contains(body, magpieCompaction) {
+		t.Fatalf("%d %s", code, body)
+	}
+	if f.calls != 1 {
+		t.Errorf("asked %d times", f.calls)
+	}
+}
-- 
2.50.1 (Apple Git-155)
```

</details>

**Branch with the commit**: [`fix/5686-compact-overflow-keepalive`](https://github.com/ggbdpq/magpie/tree/fix/5686-compact-overflow-keepalive) (head `f2ae6ddb53059e2b9c38af53d9a64db87e477946`), rebased onto current `upstream/main` (`9730e0199`); on a fresh checkout of `9730e0199` `git am` applies clean.

| Check | Result |
| --- | --- |
| `TestCodexCompactOverflowAfterKeepaliveAsksAsText` (new; member silent past `keepHeldAfter`, the #1944 capture's overflow stream, then the text ask answered) | red before the fix (`502 … so there is no summary`), pass after |
| `TestCodexCompactOverflowAfterKeepaliveCompactsLocally` (new; text ask refused the same way → magpie's own summary, 2 asks, no guard hold) | red before the fix, pass after |
| `TestCodexCompactOverflowInStreamAsksAsText` (new; same overflow at once, keepalive never fired) | red before the fix, pass after |
| `TestCodexCompactOverflowStatusBeforeHoldAsksAsText` (new; fast 400 overflow — the pre-existing `summaryTooLarge` face — unchanged) | pass before and after |
| `TestCodexCompactOtherBrokenOffStays` (new; in-stream failure saying nothing of size → 502, no text ask, 1 ask) | pass before and after |
| Compaction/overflow family targeted (`CodexCompact\|CompactTooLarge\|TooLarge\|Overflow\|ByteCap\|…`) | ok (33.3s) |
| `go test ./internal/gateway/ -tags nogui -timeout 25m -count=1` | ok (813.9s), zero failures |
| targeted `-race`, same families | ok (11.0s) |
| `gofmt -l` (changed files) | prints nothing |
| `go vet -tags nogui ./internal/gateway/`; `GOOS=linux`; `GOOS=windows` | clean |
| `go build ./...` plain and `-tags nogui`; `GOOS=linux`; `GOOS=windows` | clean |
| Ablation | reverting `internal/gateway/codex_backend.go` to the parent (tests kept) turns the three new mains red; restored, green (`-count=1`) |
| Re-verified on upstream/main `9730e0199` | rebased (7cce4b4d7 → 9730e0199), the new tests, the family, and targeted `-race` re-run green on the rebased head |

**Not verified**: a real Codex CLI with `remote_compaction = "v2"` against the reporter's three-member group — NOT-RUNNABLE here; the fake answers the backend's own captured overflow stream (the #1944 frames, the reporter's wording) held past `keepHeldAfter`, which is the deterministic shape the report pins. #5134's relay face and #3106's message-shape face are out of this patch's scope as said above.

**Attribution**: AI-written (GLM-5.3-Flash via ZCode); I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

Generated-by: GLM-5.3-Flash (ZCode)
