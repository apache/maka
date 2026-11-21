package provider

// Review checks for #4556's proposed hold (yhong91's 382194ba), kept out
// of the patch's own test file.

import (
	"testing"
	"time"
)

// an account window of a day beside an aside pool week spent at 100: using
// a pool aside up doesn't stop the account (toldAside's own note), so the
// day's renewal brings allowance to spend and is told of. spentLonger as
// proposed reads the raw q.Windows and holds the day on the aside week —
// a renewal the account could spend is swallowed.
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

// the rule the issue itself states: a longer window fully spent whose
// renewal is unknown holds too. No test of 382194ba covers this branch.
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
