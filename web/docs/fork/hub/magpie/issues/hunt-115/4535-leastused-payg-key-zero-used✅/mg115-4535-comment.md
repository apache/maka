### What changed

`LeastUsed` (the `usage` routing) no longer treats a seat whose allowance share was never told as 0% used. A pay-as-you-go API key, a prepaid wallet, or a subscription whose usage wasn't read has `Seat.Used` read 0, and the comparator's `sa.Used != sb.Used` ranked that 0 ahead of every subscription that had used more than nothing — paid balance burned while subscription quota sat idle. The comparator now places seats first: a learning account goes first, once (as Smart and Pace do); then seats with room whose share was told, by `Used` as before; then the shareless; then those running low; then those spent. Among the shareless nothing changes in kind: a wallet goes by what it has left (`Seat.Left`) and a key by the tokens magpie sent it lately — which is what the UI's own description of this routing already promised. Pools whose seats all tell a share, or all tell none, are ordered exactly as before.

### Root cause

`weighRouted` leaves `l.used` at Go's zero value for a candidate with no allowance record or with one that has no percentage windows, and `LeastUsed` compared that 0 directly. `Smart` keeps a seat whose renewal isn't known behind those whose share was told (`x.IsZero() || y.IsZero(): // not known: after those known`), and `Pace` sinks keys to the lowest pace band; `LeastUsed` had no such guard. The fix stays at that one comparison in `internal/routes/strategies.go`; `weighRouted`'s data filling is untouched.

### Verification
| Check | Result |
|---|---|
| `go test ./internal/routes/ -run TestLeastUsed -count=1` on parent `1fac66c0` | FAIL: `a key with no share went first: [key sub]` |
| same, with the fix | ok |
| `go test -tags nogui ./internal/routes/ -count=1` | ok (wallet tiers #3950, credits-first, Smart/Pace suites pass) |
| ablation: parent's `strategies.go`, test kept | FAIL again: `[key sub]` |
| gateway directed: `TestKeysWeighedByTheirWindows`, `TestWeeklyPace`, `TestRouting`, `TestRoutingKeepsModelAllowancesSeparate`, `TestSpreadsSessionsOnlyWhenKeptAndRoutedByWhatIsLeft`, `TestWeighedRankIsDraggedOrder`, `TestArrangedKeysAreGatewayCandidates` | ok |
| `go vet` darwin / linux / windows, `gofmt -l` | clean |
| `go build -tags nogui ./...` darwin / linux / windows | ok |

### Notes

- Where a shareless key lands is the one product-shaped choice: it goes after subscriptions with room and before those running low (>= 90%) or spent (>= 98%), mirroring Smart and Pace. The issue's first reading — a known share always ahead, even a spent sub ahead of a key — would retry an exhausted subscription ahead of the key on every request, since nothing but `Weighted` consumes `Seat.Resting`. Say the word if the tiers should sit differently.
- The frontend trace's "why" lines were not touched; `client.js`'s routing description already says "a key by the tokens magpie sent it lately".

### Not verified

- No live vendor here mixes a real subscription with a real pay-as-you-go key; the ordering is covered by unit tests on `routes.Seat` directly.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: routing: LeastUsed sends a key with no share behind subs with room, not first (#4535) — git am applies it as is; SHA-256 first 16: a57c323c84fdaca2</summary>

````
From 5ab5f109cc3dfeaa7844f9bfca1df370cab81d4b Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sun, 1 Nov 2026 18:15:32 +0800
Subject: [PATCH] routing: LeastUsed sends a key with no share behind subs with
 room, not first (#4535)

A pay-as-you-go key, a prepaid wallet, or an account whose use wasn't
read has Seat.Used read 0, and LeastUsed compared that 0 as if it were a
share of 0%: any subscription that had used more than nothing went after
every such key, so paid balance burned while subscription quota sat
idle. Smart and Pace already keep a seat whose allowance isn't known
behind those whose share was told; LeastUsed now does too: the shareless
go after subscriptions with room and before those running low or spent,
ordered among themselves by what a wallet has left and what magpie sent
a key lately. A learning account still goes first, once, as in Smart
and Pace. Pools of seats that all tell a share, or all tell none, are
ordered as before.

What changed:
- internal/routes/strategies.go: LeastUsed places seats by whether their
  share was told (Known with a use past 0 or a renewal known) before the
  Used comparison; its comment says so.
- internal/routes/routes_test.go: TestLeastUsedSeatsWithNoShare locks a
  key behind subs with room, a wallet behind a told share and before a
  key, keys past low and spent subs, a learning account first, and told
  shares ordered by use as before.

Run:
- go test ./internal/routes/ -count=1 (fails on the parent at
  TestLeastUsedSeatsWithNoShare: [key sub], passes with the fix)
- go vet ./internal/routes/, gofmt clean

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/routes/routes_test.go | 43 +++++++++++++++++++++++++++++++++
 internal/routes/strategies.go  | 44 +++++++++++++++++++++++++++++++++-
 2 files changed, 86 insertions(+), 1 deletion(-)

diff --git a/internal/routes/routes_test.go b/internal/routes/routes_test.go
index 5a0575a8c..40ecb2599 100644
--- a/internal/routes/routes_test.go
+++ b/internal/routes/routes_test.go
@@ -122,6 +122,49 @@ func TestLeastUsedAndOrdered(t *testing.T) {
 	}
 }
 
+// A seat that tells no share of its allowance — a pay-as-you-go key, a
+// prepaid wallet, an account whose use wasn't read — has Used read 0, and
+// by that 0 alone it went first, burning paid balance while subscription
+// quota sat idle (#4535). It goes after those whose share was told and has
+// room, and before those running low or spent, as Smart and Pace keep the
+// unknown; a learning account still goes first, once. Of the shareless, a
+// wallet goes by what it has left and a key by what magpie sent it lately.
+func TestLeastUsedSeatsWithNoShare(t *testing.T) {
+	now := time.Now()
+	sub := func(key string, used float64) Seat {
+		return Seat{Key: key, Known: true, Used: used, Soon: []time.Time{now.Add(48 * time.Hour)}}
+	}
+	key := Seat{Key: "key"} // a pay-as-you-go key: no window, so Used reads 0
+	s := []Seat{key, sub("sub", 5)}
+	if got := keys(s, Apply(LeastUsed, "p", s)); !slices.Equal(got, []string{"sub", "key"}) {
+		t.Fatalf("a key with no share went first: %v", got)
+	}
+	// a wallet has no share either, but what it has left still orders it
+	// behind a told share, and before a key that told nothing at all
+	wallet := Seat{Key: "wallet", Known: true, Left: 50, LeftIn: "prov\x00usd"}
+	s = []Seat{key, wallet, sub("sub", 5)}
+	if got := keys(s, Apply(LeastUsed, "p", s)); !slices.Equal(got, []string{"sub", "wallet", "key"}) {
+		t.Fatalf("wallet: %v, want [sub wallet key]", got)
+	}
+	// one running low or spent is kept for when the others can't, past a
+	// key: its share is nearly gone, but it isn't gone
+	s = []Seat{key, sub("fine", 5), sub("low", 92), sub("spent", 99)}
+	if got := keys(s, Apply(LeastUsed, "p", s)); !slices.Equal(got, []string{"fine", "key", "low", "spent"}) {
+		t.Fatalf("low and spent: %v, want [fine key low spent]", got)
+	}
+	// one learning goes first, once, as in Smart and Pace
+	learns := Seat{Key: "learns", Learns: true}
+	s = []Seat{key, learns, sub("sub", 5)}
+	if got := keys(s, Apply(LeastUsed, "p", s)); !slices.Equal(got, []string{"learns", "sub", "key"}) {
+		t.Fatalf("learns: %v, want [learns sub key]", got)
+	}
+	// those with a told share go by it as before
+	s = []Seat{sub("much", 80), sub("little", 10)}
+	if got := keys(s, Apply(LeastUsed, "p", s)); !slices.Equal(got, []string{"little", "much"}) {
+		t.Fatalf("told shares: %v, want [little much]", got)
+	}
+}
+
 // Weekly pace: the most of a week left per hour first; one running low
 // after, whatever its pace.
 func TestPace(t *testing.T) {
diff --git a/internal/routes/strategies.go b/internal/routes/strategies.go
index 18ed9cb0f..69fbb6c6d 100644
--- a/internal/routes/strategies.go
+++ b/internal/routes/strategies.go
@@ -261,12 +261,54 @@ var Rotate = Strategy{Order: func(pool string, seats []Seat) []int {
 // share of its allowance used, as the vendor says; then, and for other
 // keys, by what magpie sent it lately; prepaid wallets, which have no
 // share, by what they have left first (Seat.Left). Of those all but used up, one that
-// goes on on its credits goes first (spentBefore).
+// goes on on its credits goes first (spentBefore). A seat that tells no
+// share — a pay-as-you-go key, a wallet, an account whose use wasn't read
+// — has Used read 0, and by that 0 alone it went first, burning paid
+// balance while subscription quota sat idle (#4535): it goes after those
+// whose share was told and has room, and before those running low or
+// spent, as Smart and Pace keep the unknown. One not known that tells
+// what it has left as it answers goes first, once, as in Smart and Pace.
 var LeastUsed = Strategy{ByUse: true, Order: func(_ string, seats []Seat) []int {
 	left := byLeft(seats, fewerTokens)
+	// shared: the seat's share of its allowance was told — a use past 0
+	// read from it, or a window it renews by. Without one, Used reads 0
+	// because it isn't known, not because there is room.
+	shared := func(s Seat) bool {
+		if !s.Known {
+			return false
+		}
+		if s.Used > 0 {
+			return true
+		}
+		for _, at := range s.Soon {
+			if !at.IsZero() {
+				return true
+			}
+		}
+		return false
+	}
+	// where the seat lands: a learning account first, once, as in Smart
+	// and Pace; then those with room whose share was told; then the
+	// shareless, kept for their cost before a share nearly gone; then
+	// those running low, then spent
+	place := func(s Seat) int {
+		switch t := tier(s.Used); {
+		case s.Learns:
+			return 0
+		case t == 0 && shared(s):
+			return 1
+		case t == 0:
+			return 2
+		default:
+			return t + 2
+		}
+	}
 	idx := identity(len(seats))
 	sort.SliceStable(idx, func(a, b int) bool {
 		sa, sb := seats[idx[a]], seats[idx[b]]
+		if pa, pb := place(sa), place(sb); pa != pb {
+			return pa < pb
+		}
 		if ta, tb := tier(sa.Used), tier(sb.Used); ta == 2 && tb == 2 && sa.Credits != sb.Credits {
 			return sa.Credits
 		}
-- 
2.50.1 (Apple Git-155)

````

</details>

Branch with the commit: [hunt115-a4-4535](https://github.com/ggbdpq/magpie/tree/hunt115-a4-4535) (head `5ab5f109cc3dfeaa7844f9bfca1df370cab81d4b`).
