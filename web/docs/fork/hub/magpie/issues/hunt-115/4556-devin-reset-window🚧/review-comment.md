The branch reads well — `spentLonger` is the issue's own rule carried into code, and the Devin cases behave as the proposal says. Two things I hit while reviewing it on today's `main` (`14e351378`):

**1. An aside pool window holds the account's own windows, so a renewal that can be spent is swallowed**

`spentLonger` scans the raw `q.Windows`, and a pool's aside weekly window — the kind `toldAside` keeps reminding of precisely because "using it up doesn't stop the account" — qualifies as a holder: longer span, `Used >= 100`, renewal later than the day's. An account whose reading holds its own day at 10% renewing in 20h, beside a pool week set aside at 100% renewing in 60h, then gets no reminder at all, though the day's renewal brings allowance to spend — the aside week blocks nothing.

Against `382194ba` on `14e351378`:

```go
func TestReview4556AsideWindowMustNotHold(t *testing.T) {
	now := time.Date(2026, 10, 1, 9, 0, 0, 0, time.UTC)
	soon, later := now.Add(20*time.Hour), now.Add(60*time.Hour)
	qs := []SubscriptionQuota{{Provider: "p", Name: "P", User: "u@x.com",
		Windows: []QuotaWindow{
			{Name: "day", Span: 24 * time.Hour, Used: 10, ResetsAt: &soon},
			{Name: "week", Span: 7 * 24 * time.Hour, Used: 100, ResetsAt: &later, Pool: "shared", Aside: true},
		}}}
	got := dueReminders(qs, map[string]alertMark{}, 72*time.Hour, now)
	if len(got) != 1 || got[0].Window != "day" {
		t.Fatalf("an aside pool week spent must not hold the account's day: %+v", got)
	}
}
```

```text
--- FAIL: TestReview4556AsideWindowMustNotHold (0.00s)
    quota_alert_review4556_test.go:26: an aside pool week spent must not hold the account's day: []
```

Elsewhere in the package a spent window holds the account only when it is neither aside nor a per-model one — `codex_switch.go:188` (`w.Aside || w.Model != "" || w.Used < 100`), and the same shape in `codex_autoreset.go:261` and `codex_warmup.go:681`. The aside exclusion is the fix the test above asks for; the per-model one is the same convention applied here for consistency, and Devin has no per-model windows either way:

```diff
-		if o.Span <= w.Span || o.Used < 100 {
+		if o.Aside || o.Model != "" || o.Span <= w.Span || o.Used < 100 {
```

**2. The unknown-renewal hold has no test**

The issue's rule holds the shorter window when the longer one's renewal is "later **or unknown**"; the branch is in (`when == nil` returns true), but all three cases of `TestDueRemindersLongerWindowSpent` carry a `ResetsAt`, so nothing locks it. It behaves correctly today — this keeps it that way:

```go
func TestReview4556LongerUnknownRenewalHolds(t *testing.T) {
	now := time.Date(2026, 10, 1, 9, 0, 0, 0, time.UTC)
	soon := now.Add(20 * time.Hour)
	qs := []SubscriptionQuota{{Provider: "devin", Name: "Devin", User: "u@x.com",
		Windows: []QuotaWindow{
			{Name: "1 day", Span: 24 * time.Hour, Used: 0, ResetsAt: &soon},
			{Name: "7 days", Span: 7 * 24 * time.Hour, Used: 100},
		}}}
	got := dueReminders(qs, map[string]alertMark{}, 72*time.Hour, now)
	if len(got) != 0 {
		t.Fatalf("a longer window spent with an unknown renewal holds: %+v", got)
	}
}
```

Both tests are yours to fold into the suite as you see fit — I'm not sending a competing patch.

| Check | Result |
| --- | --- |
| `TestReview4556AsideWindowMustNotHold` on `382194ba` as is | FAIL — the day is held: `[]` |
| With `o.Aside \|\| o.Model != ""` in the condition | PASS; `TestDueRemindersLongerWindowSpent`, `TestDueReminders`, `TestDueRemindersPoolWeekly` still pass |
| `go test -tags nogui -count=1 ./internal/provider` with the fix | ok |
| `gofmt -l`; `go vet -tags nogui` darwin / `GOOS=linux` / `GOOS=windows` | clean |

Not verified: no Devin or pool-provider account here, so the aside reading is built from the fields' meaning rather than read off a vendor; the three-platform build wasn't run for a one-line boolean condition (vet on all three was).

**Attribution**: AI-written review; posted by `ggbdpq`, who has read the code and run every check above.
