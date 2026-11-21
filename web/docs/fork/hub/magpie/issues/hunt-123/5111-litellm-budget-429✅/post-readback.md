Taken — here is the analysis, the fix and its proof.

## What's wrong

`failure()` reads the LiteLLM refusal as a short rate limit, so the key rests on the backoff ladder (1 min doubled each time, capped at 30 min — the report's `"by":"backoff","failures":7`) and is probed again every ≤30 min for a budget that doesn't come back in 30 minutes. The user's `quota-rest` never applies: the used-up channel is never entered.

## Root cause

`failure()`'s used-up list (`usedUpWords`, `internal/gateway/routing.go`) knew a budget spent only as the adjacent pair `budget (exceeded|exhausted)` (or `out of budget`). LiteLLM's sentence — "Budget **has been** exceeded! Key=… (sk-…), Current cost: …, Max budget: …" — puts "has been" between the two words, and the rest of the body names none of `quota` / `insufficient` / `billing` / `limit` / `plan`, so every quota branch misses: `creditWords` doesn't match (and at 429 a credit reading needs `brokeWords` anyway), `minuteLimit`, `backSoon` and `rateWords` find nothing, and the refusal falls through to the last case, `status == 429` → `failRate`. Reproduced against the tip before touching anything: both the JSON-enveloped body and the bare sentence classified `rate`.

## The fix

One widened word: the adjacent pair becomes a windowed pair, `budget.{0,32}(exceeded|exhausted)` — covers "Budget has been exceeded" (twelve characters between) with room for "for this key" / "has already been", and keeps every wording the pair matched before. The ladder's earlier branches still take a per-minute limit first, so LiteLLM's own `LiteLLM: Rate limit exceeded`, which names no budget, keeps its rate backoff. Out of quota, the rest is the user's `quota-rest` (`OwnQuotaRest`, exactly the expected behavior) and it is lifted when a reading finds the budget back.

<details>
<summary>Patch (ba42bfcd5)</summary>

```diff
From ba42bfcd52e460d69d2ec6eb655838bdd6f6f3b7 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 4 Nov 2026 01:19:14 +0800
Subject: [PATCH] gateway: a LiteLLM "Budget has been exceeded" 429 is out of
 quota, and the user's quota-rest holds the key (wuxiaoqiang12)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

failure()'s used-up list knew a budget spent only as the adjacent pair
"budget (exceeded|exhausted)" (or "out of budget"). LiteLLM's spent key
answers 429 "Budget has been exceeded! Key=… (sk-…), Current cost: …,
Max budget: …", whose "has been" sits between the two words, and the
rest of the body names none of quota, insufficient, billing, limit or
plan, so the refusal fell through minuteLimit, backSoon and rateWords
to the last case and read as a rate limit: rested a minute doubled each
time, capped at half an hour (the report's "by":"backoff","failures":7),
asked again every half an hour for a budget that doesn't come back in
half an hour, and OwnQuotaRest — the quota-rest the user set for the
budget's daily reset — never consulted.

Widen the pair into a window, budget.{0,32}(exceeded|exhausted): it
covers "Budget has been exceeded" (twelve characters between) with room
for "for this key" and "has already been", and keeps every wording the
pair matched. The ladder's earlier branches still take a per-minute
limit first, so LiteLLM's own "LiteLLM: Rate limit exceeded", which
names no budget, keeps its rate backoff. fallback.go's quotaWords, used
where no status is known, already matches this body through its bare
"exceeded", and draw.go reuses usedUpWords and inherits. Out of quota,
the rest is the user's quota-rest (TestOwnQuotaRest pins that) and is
lifted when a reading finds the budget back, as the issue asks.

TestOutOfBudgetIsntRetriedInPlace's two new rows — the JSON-enveloped
refusal a relay passes on, and the bare sentence — read "rate" and were
asked again in place on the old list, and pass now; the list reverted to
the parent's, they fail again. go test -tags nogui -count=1
./internal/gateway/... , the same with -race on this test, go vet, gofmt
and go build ./... are quiet.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/routing.go      |  9 +++++++--
 internal/gateway/toolong_test.go | 10 ++++++++++
 2 files changed, 17 insertions(+), 2 deletions(-)

diff --git a/internal/gateway/routing.go b/internal/gateway/routing.go
index 694a71394..b414dbdee 100644
--- a/internal/gateway/routing.go
+++ b/internal/gateway/routing.go
@@ -279,8 +279,13 @@ var (
 	// WorkBuddy's 429 14018 "Credits exhausted. Please visit the link
 	// below to purchase add-on packs…" too (Creat.wu on Discord)
 	brokeWords = regexp.MustCompile(`(?i)insufficient.?(balance|credit|fund)|\bcredits? (are )?exhausted\b|余额不足|欠费|请充值`)
-	// quotaWords: it has used up what its plan allows for now.
-	usedUpWords = regexp.MustCompile(`(?i)quota|usage.?limit|out of budget|budget (exceeded|exhausted)|limit.?reached|hit your .*limit|limit.{0,24}resets|exceeded.*(plan|limit)|额度|用量|套餐|上限`)
+	// quotaWords: it has used up what its plan allows for now. The budget's
+	// words needn't sit beside each other: LiteLLM's spent key answers 429
+	// "Budget has been exceeded! Key=… (sk-…), Current cost: …, Max budget:
+	// …" (#5111, wuxiaoqiang12) — its "has been" broke the pair, and read
+	// as a plain rate limit the key was asked again every half an hour, the
+	// user's quota-rest never read
+	usedUpWords = regexp.MustCompile(`(?i)quota|usage.?limit|out of budget|budget.{0,32}(exceeded|exhausted)|limit.?reached|hit your .*limit|limit.{0,24}resets|exceeded.*(plan|limit)|额度|用量|套餐|上限`)
 	// rateWords: a 429 that is a short rate limit — requests or tokens per
 	// minute — which usedUpWords took for a used-up plan ("Rate limit
 	// exceeded", "reached"): as magpie words an upstream error, with
diff --git a/internal/gateway/toolong_test.go b/internal/gateway/toolong_test.go
index fc4d869f8..7168aaf6d 100644
--- a/internal/gateway/toolong_test.go
+++ b/internal/gateway/toolong_test.go
@@ -146,6 +146,10 @@ func TestChineseNotTooLong(t *testing.T) {
 // A spent budget, like a used-up plan (pi's retry.ts lists both as not to
 // be retried), goes to the next account at once rather than being asked
 // again in place: "out of budget" was a rate limit, asked three times.
+// LiteLLM's spent key answers 429 "Budget has been exceeded! Key=… (sk-…),
+// Current cost: …, Max budget: …" (#5111, wuxiaoqiang12): its "has been"
+// sat between the two words the list knew, and the key was asked again
+// every half an hour, the user's quota-rest never read.
 func TestOutOfBudgetIsntRetriedInPlace(t *testing.T) {
 	for _, tc := range []struct {
 		status int
@@ -153,6 +157,8 @@ func TestOutOfBudgetIsntRetriedInPlace(t *testing.T) {
 	}{
 		{429, "out of budget"},
 		{400, "Budget exceeded for this key"},
+		{429, `{"error":{"message":"Budget has been exceeded! Key=sk-1234 (my-relay), Current cost: 0.0023, Max budget: 0.002"}}`},
+		{429, "Budget has been exceeded! Current cost: 0.0023, Max budget: 0.002"},
 		{429, `{"error":{"type":"GoUsageLimitError","message":"Monthly usage limit reached"}}`},
 		{429, `{"error":{"code":"subscription_sharing_usage_limit_exceeded"}}`},
 	} {
@@ -169,4 +175,8 @@ func TestOutOfBudgetIsntRetriedInPlace(t *testing.T) {
 	if _, again := passing(429, nil, []byte("Rate limit reached for requests"), 0); !again {
 		t.Error("a rate limit isn't asked again")
 	}
+	// the relay's own per-minute limit names no budget, and stays a rate
+	if f := failure(429, []byte("LiteLLM: Rate limit exceeded")); f != failRate {
+		t.Errorf(`"LiteLLM: Rate limit exceeded" is a %s failure`, f)
+	}
 }
-- 
2.50.1 (Apple Git-155)
```

Patch file SHA-256 (first 16): `cc9d8111b5a477a4`

</details>

## Verification

| Check | Result |
| --- | --- |
| RED: the two new LiteLLM rows on the parent's word list | fail — read `rate`, asked again in place |
| GREEN: same test after the one-word fix | pass |
| Ablation: word list reverted to the parent's, tests kept | red again on the same rows; restored, green |
| Negative control: `LiteLLM: Rate limit exceeded` | still `failRate` (asserted) |
| `go test -tags nogui -count=1 -timeout 25m ./internal/gateway/...` | ok, 629.6s |
| `go test -tags nogui -race` (this test, `TestOwnQuotaRest`, `TestChineseNotTooLong`) | ok |
| `gofmt -l` on the two files, `go vet ./internal/gateway/`, `go build ./...` | clean |
| Sibling face: `fallback.go` `quotaWords` (same bigram) | checked, unchanged — it also carries a bare `exceeded`, so this body already matched where it is used (`quotaSaid`, no status known); `draw.go` reuses `usedUpWords` and inherits; #5006's reverse shape ("inference exceeds tpm/rpm limit") names no `budget`, so the widened window can't catch it |

## Not verified

No live LiteLLM relay at hand: the classification is pinned against the body the report quotes, and the rest side (a `failQuota` refusal resting as long as the user's `quota-rest` set) is pinned by the existing `TestOwnQuotaRest` — a real relay's exact body (key alias spelling, envelope) may vary around that sentence. The rest-lift reading (a probe finding the budget back) is the channel's existing behavior, not re-tested here.

AI use: written by GLM-5.3-Flash (ZCode); keep the author as ggbdpq <ggbdpq@gmail.com>.

**Branch with the commit**: [fix/5111-litellm-budget-429](https://github.com/ggbdpq/magpie/tree/fix/5111-litellm-budget-429) (head `ba42bfcd52e460d69d2ec6eb655838bdd6f6f3b7`).

