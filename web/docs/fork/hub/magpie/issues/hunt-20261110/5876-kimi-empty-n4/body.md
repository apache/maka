The spent week reads out of quota, and the group moves off it.

kedoupi's routing group (`routing=weight`) has a Kimi Code (China) pool as one member. Once its weekly window is used up (`magpie quota` shows `7d 100%`), every request that lands on it answers `400 "text content is empty"` — in=0 in the usage, and no word of the window in the answer. No word of a quota's is in it either, so nothing read the answer as the spent plan magpie's own reading of the window already said it was: the 400 went to the agent (Codex's five reconnects met it again), and the turn the group kept on the member by its affinity sent it every request of the session — 25 of them in two hours, while new turns skipped the pool all right.

**Fix** (on `db0f2f20d4dd`, v0.1.3434+): the words are read whole, as they are written (the #5089 rule) — a 400 whose message is just that answers a request it gave nothing of. New `emptyContentWords` (`internal/gateway/fallback.go`, `(^|[\s:"])text content is empty(\\?"|\.?\s*$)`), read in two places that agree:

- `failure()` (`internal/gateway/routing.go`) returns `failQuota` for it: the member rests until its windows say it is back (`quotaRest`, else the window's own reset — magpie already reads Kimi Code's `/usages`, so a window that says when it resets names the rest), the Routing page says out of quota as it is, and a conversation kept on the member gives way as any resting one does (`affinity.go`: `pl.order[at].Rest != nil` → `a.Why = "resting"`).
- `retryable()` (`internal/gateway/fallback.go`) returns true: the group's next member is asked, as for the 429 the spent window is.

As #4095's credit refusal at any status: retryable and failure agree. This is the 400-error classification the main's other vendor words live in (`quotaWords`, `creditWords`, `unservedWords`, …), not the per-provider opt-in failWords of #5692 (which read a whole 200 reply, and are not in main).

**Red without the fix** (base `db0f2f20d4dd`): `TestKimiSpentEmpty400FailsOverAndRests` (a group of the spent member and a good one, `go test -tags nogui -count=1 -run TestKimiSpentEmpty400FailsOverAndRests ./internal/gateway/`) fails as the report says:
```
gateway: other's call to group/g on kimipool failed: 400 after 3ms: Kimi Code (China): text content is empty
kimi_empty_400_test.go:66: 400 {"error":{"message":"Kimi Code (China): text content is empty"}}; tried [k-spent]
```
With the fix: `ok` — the first request fails over (`tried [k-spent,k-good]`, 200 from the good member), the spent member's rest is `Why:quota, Status:400`, and the next request goes past it (`tried [k-good]`).

**Ablation**: removing the `failure()` case → red (failover still works, the rest degrades to `Why:other` backoff, the test fails on the rest); removing the `retryable()` case → red (the 400 reaches the client, `tried [k-spent]`); both restored → green. `git diff --stat` checked before each run.

**Siblings**: `rg -n "emptyContentWords" internal/` → definition + the two cases, nothing else reads it. `retryable(` has 7 callers (`holdWriter.failed`, `decideFailed`, a decision-group replan, the Codex backend call's named check, `draw`'s and `video`'s own retries, `refusal_handover`): only `status == 400` with the whole message being these words changes answer, and for each that answer is the one another member may give. `failure()`'s other readers: `tooLongUnsaid` now rules the 400 out early (an empty-content answer was never a prompt too long), and the `failOther` + `modelRefused`/`codeAssistModelMissing` paths never matched these words before, so they are unchanged. The empty-reply family that must not rest an account (#1221, `emptyReply`, a 200 that said nothing) is another status and another path, untouched.

**When the read fails**: an unreadable or empty error body matches none of the words — the 400 stays `failOther` and un-retryable, exactly as before the change.

**Tests**: `TestKimiSpentEmpty400FailsOverAndRests` and the classification family it sits in (`TestCreditRefusalIsRetryableAtAnyStatus`, `TestCredit400MovesToTheNextAccount`, `TestSub2APIKeyLimitIsQuota`, `TestKeyOutOfItsWindowRestsUntilReset`, `TestKeyPoolErrorDoesNotRestForWindow`, `TestRestingKeyReadAgainInAnOrderedGroup`, `TestAllRestingAnswersFromRest`, `TestQuotaHeldOnlyForKeysOutOfAllowance`, `TestShorterRestDoesNotReplaceLongerOne`, `TestNamedQuotaTimeReplacesAGuess`) — all green, as is the wider rest/routing/affinity family of `internal/gateway` (100s run). `go vet -tags nogui ./internal/gateway/` clean. The full package run (928s) fails at `TestClientPathCoversHandler` and `TestReadOnlyKeyEveryRoute` — the `/magpie-ca.crt` route tables, and both fail the same on the base without the change, so they are pre-existing here, not this.

**Not verified**: a real Kimi Code (China) account at 100% of its week — the fixture's shape is kedoupi's report (the `400 Kimi Code (China): text content is empty` magpie put on it, and in=0), not a sample of the vendor's raw body.

---
**Source**: reported in #5876 (kedoupi); the fixture's shape follows the report.

**Red without the fix**: above — the group's Kimi member answers 400 and nothing reads it as the spent plan it is.

**Siblings**: above — 7 `retryable` callers and the `failure` readers walked; changed only the two cases the words belong in.

**When the read fails**: above — an unreadable body stays as before.

**Not verified**: a real spent Kimi Code account; the vendor's raw 400 body (the fixture is the report's shape).

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

**Patch**: <details><summary>patch: gateway: a Kimi Code plan's spent week answers a 400 "text content is empty", read as the spent plan it is (#5876) — git am applies it as is; SHA-256 first 16: b0fac19b0d319051</summary>

```patch
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 11 Nov 2026 00:11:07 +0800
Subject: [PATCH] gateway: a Kimi Code plan's spent week answers a 400 "text
 content is empty", read as the spent plan it is (#5876)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

A routing group's Kimi Code (China) pool, its weekly window used up,
answered every request that landed on it with a 400 whose words say
nothing of the window — "text content is empty", in=0 in the usage
(kedoupi). No word of a quota's is in it, so nothing read the answer as
the spent plan magpie's own reading of the window already said it was:
the 400 went to the agent, whose five reconnects met it again, and the
turn the group kept on the member sent it every request of the session,
25 of them in two hours, while new turns skipped the pool all right.

The words are read whole, as they are written (#5089's rule): a 400
whose message is just that answers a request it gave nothing of. failure
reads it as failQuota — the account rests until its windows say it is
back (quotaRest, else the window's own reset), the Routing page says out
of quota as it is, and a conversation kept on the member gives way as
any resting one does — and retryable asks the group's next member, as
for the 429 the spent window is. As #4095's credit refusal: retryable
and failure agree, whatever the status. TestKimiSpentEmpty400FailsOverAndRests
(a group of the spent member and a good one) fails without the change.

Attribution: 分析与补丁由 GLM-5.3-Flash (ZCode) 协助完成
Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/fallback.go            | 15 +++++
 internal/gateway/kimi_empty_400_test.go | 90 +++++++++++++++++++++++++
 internal/gateway/routing.go             |  8 +++
 3 files changed, 113 insertions(+)
 create mode 100644 internal/gateway/kimi_empty_400_test.go

diff --git a/internal/gateway/fallback.go b/internal/gateway/fallback.go
index 20d769de7..33fb131f7 100644
--- a/internal/gateway/fallback.go
+++ b/internal/gateway/fallback.go
@@ -1612,6 +1612,15 @@ func quotaSaid(msg string) bool {
 	return quotaWords.MatchString(msg) && !tooLong(http.StatusBadRequest, msg)
 }
 
+// emptyContentWords are how a vendor answers a request it gave nothing
+// of: the whole of its words, no error beside them. Kimi Code's plan,
+// its weekly window spent, answers every chat request with a 400 "text
+// content is empty" (#5876, kedoupi) — in=0 in the usage, and no word
+// of the window in it, so nothing read the answer as the spent plan it
+// is there. The words are read whole, as they are written (#5089's
+// rule): an answer of more than them isn't one.
+var emptyContentWords = lazyre.New(`(?i)(^|[\s:"])text content is empty(\\?"|\.?\s*$)`)
+
 // unservedWords are how a vendor says the model isn't one it serves this
 // key, or this way — words another provider, or key, may not answer with.
 // provider.ModelUnserved owns them: a plugin's 401 that says them doesn't
@@ -1992,6 +2001,12 @@ func retryable(status int, body []byte) bool {
 		// 6,467 points and the empty one was never rested (#4095,
 		// mycf_711)
 		return true
+	case status == 400 && emptyContentWords.Match(body):
+		// the vendor answered a request it gave nothing of (#5876): Kimi
+		// Code's plan, its weekly window spent, answers just this, and
+		// the group's next member may answer instead — out of quota, as
+		// failure reads it
+		return true
 	case status == 400, status == 422:
 		return quotaWords.Match(body) || unservedWords.Match(body) || refusedWords.Match(body) || shapeWords.Match(body) || unsaidWords.Match(body) || regionWords.Match(body) || zhipuImageRefusal.Match(body) || wrongEndpoint(status, body) ||
 			// a relay's own word that the provider behind it turned the
diff --git a/internal/gateway/kimi_empty_400_test.go b/internal/gateway/kimi_empty_400_test.go
new file mode 100644
index 000000000..da682b315
--- /dev/null
+++ b/internal/gateway/kimi_empty_400_test.go
@@ -0,0 +1,90 @@
+package gateway
+
+import (
+	"io"
+	"net/http"
+	"net/http/httptest"
+	"strings"
+	"sync"
+	"testing"
+
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// kimiSpentEmpty is Kimi Code's answer to every chat request once its
+// plan's weekly window is spent (#5876, kedoupi): a 400 whose words say
+// nothing of the window, in=0 in the usage.
+const kimiSpentEmpty = `{"error":{"message":"text content is empty"}}`
+
+// A routing group's Kimi Code member, its weekly window spent, answers
+// every request that lands on it with a 400 "text content is empty"
+// (#5876, kedoupi). Nothing of a quota's is in the words, so nothing
+// read them: the 400 went to the agent, whose five reconnects met it
+// again, and the turn kept on the member by its affinity sent it every
+// request of the session, 25 of them in two hours. Read as the spent
+// plan it is, the member rests as out of quota, and the group's next
+// member answers; the next request goes past the resting member.
+func TestKimiSpentEmpty400FailsOverAndRests(t *testing.T) {
+	fresh(t)
+	var mu sync.Mutex
+	var seen []string
+	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		io.ReadAll(r.Body)
+		key := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
+		mu.Lock()
+		seen = append(seen, key)
+		mu.Unlock()
+		w.Header().Set("Content-Type", "application/json")
+		if key == "k-spent" {
+			w.WriteHeader(http.StatusBadRequest)
+			io.WriteString(w, kimiSpentEmpty)
+			return
+		}
+		io.WriteString(w, `{"id":"x","choices":[{"index":0,"message":{"role":"assistant","content":"from-k-good"},"finish_reason":"stop"}],`+
+			`"usage":{"prompt_tokens":5,"completion_tokens":3}}`)
+	}))
+	defer up.Close()
+	for _, p := range []provider.Provider{
+		{ID: "kimipool", Name: "Kimi Code (China)", Chat: up.URL + "/v1", Models: []string{"k3.1-pro"}, Key: "k-spent", KeyName: "Spent"},
+		{ID: "otherpool", Name: "Other", Chat: up.URL + "/v1", Models: []string{"m2"}, Key: "k-good"},
+	} {
+		if err := provider.Save(p); err != nil {
+			t.Fatal(err)
+		}
+	}
+	if err := provider.SaveGroup(provider.Group{Name: "G", Members: []string{"kimipool/k3.1-pro", "otherpool/m2"}, Routing: provider.Ordered}); err != nil {
+		t.Fatal(err)
+	}
+	s := New()
+	send := func() (int, string) {
+		rec := httptest.NewRecorder()
+		s.Handler().ServeHTTP(rec, httptest.NewRequest("POST", "/v1/chat/completions",
+			strings.NewReader(`{"model":"group/g","messages":[{"role":"user","content":"hi"}]}`)))
+		return rec.Code, rec.Body.String()
+	}
+	if code, body := send(); code != 200 || !strings.Contains(body, "from-k-good") {
+		t.Fatalf("%d %s; tried %v", code, body, seen)
+	}
+	mu.Lock()
+	if strings.Join(seen, ",") != "k-spent,k-good" {
+		mu.Unlock()
+		t.Fatalf("tried %v", seen)
+	}
+	seen = nil
+	mu.Unlock()
+	saved, err := provider.Find("kimipool")
+	if err != nil {
+		t.Fatal(err)
+	}
+	if r, ok := RestOf(saved.RestKey(saved.KeyList()[0])); !ok || r.Why != failQuota || r.Status != http.StatusBadRequest {
+		t.Fatalf("the spent member's rest: %+v %v", r, ok)
+	}
+	if code, body := send(); code != 200 || !strings.Contains(body, "from-k-good") {
+		t.Fatalf("next: %d %s", code, body)
+	}
+	mu.Lock()
+	defer mu.Unlock()
+	if strings.Join(seen, ",") != "k-good" {
+		t.Fatalf("next tried %v", seen)
+	}
+}
diff --git a/internal/gateway/routing.go b/internal/gateway/routing.go
index f5e431ad8..c74bf7803 100644
--- a/internal/gateway/routing.go
+++ b/internal/gateway/routing.go
@@ -594,6 +594,14 @@ func failure(status int, body []byte) string {
 		// Kimi's "exceeded model token limit" is the conversation's
 		// length, not the plan's
 		return failOther
+	case status == http.StatusBadRequest && emptyContentWords.Match(body):
+		// the vendor answered a request it gave nothing of: Kimi Code's
+		// plan, its weekly window spent, refuses every chat with a 400
+		// "text content is empty" and no word of the window (#5876,
+		// kedoupi) — the account out of its allowance, as magpie's own
+		// reading of the window already says, though no word of a
+		// quota's is in the answer
+		return failQuota
 	case status == 402 && usedUpWords.Match(body) && !creditWords.Match(body) && !bytes.Contains(body, []byte("insufficient_quota")):
 		// a 402 that says a usage limit and nothing of money is out of
 		// quota, not of credit: Factory's "You've reached your weekly
-- 
2.50.1 (Apple Git-155)
```

</details>

Generated-by: GLM-5.3-Flash (ZCode)
