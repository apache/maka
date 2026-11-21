Refresh of my patch above, not a redesign: the same commit rebased onto current `upstream/main` (`4b29709ec`) and the verification re-run. `newAPIKeyPath` (the built-in default field for `/api/usage/token`) is unchanged on main and the default still reads the token-scoped `total_available`, so the unlimited-key face stands as reported.

Unchanged, as delivered: when the key-usage reply says `unlimited_quota: true` and carries `user_quota.total_available`, the default field yields to the account's own figure (`$data.user_quota.total_available / 500000`); a key with a quota of its own keeps reading its own `total_available`, and a Balance field the user set by hand is never second-guessed — the reporter's `balance.path` workaround keeps working exactly as it did.

<details><summary>patch: provider: an unlimited key's relay balance is the account's own (#5436) — git am applies it as is; SHA-256 first 16: dc37ea11290e5c1f</summary>

```text
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sun, 8 Nov 2026 00:22:18 +0800
Subject: [PATCH] provider: an unlimited key's relay balance is the account's
 own (#5436)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

A new-api relay's /api/usage/token left on its default field reads
$data.total_available, and on a key issued with unlimited_quota: true
that figure is what the key has spent, not what is left — it goes
negative once use passes the token's grant, and the card showed $-4.38
where the account held $106.44 (#5436, AnxForever). The account's own
total_available sits in the same reply under user_quota, in the same
units, and that is the balance then.

The default field only is corrected: a key with a quota of its own keeps
reading its own total_available, and a Balance field the user set by
hand is never second-guessed.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/provider/balance.go                | 37 +++++++++++++-
 internal/provider/balance_unlimited_test.go | 54 +++++++++++++++++++++
 2 files changed, 90 insertions(+), 1 deletion(-)
 create mode 100644 internal/provider/balance_unlimited_test.go

diff --git a/internal/provider/balance.go b/internal/provider/balance.go
index b7c6a651c..5b13eeea0 100644
--- a/internal/provider/balance.go
+++ b/internal/provider/balance.go
@@ -29,6 +29,28 @@ import (
 	"github.com/yetone/magpie/internal/lazyre"
 )
 
+// unlimitedQuotaBalance is the account-level field a new-api key-usage
+// reply carries when the key has no quota of its own (unlimited_quota:
+// true): its token-scoped total_available is what the key has spent, not
+// what is left, and it goes negative once use passes the token's grant
+// (#5436, AnxForever: $-4.38 shown where the account held $106.44). The
+// account's own total_available, under user_quota in the same reply, in
+// the same units, is the balance then.
+func unlimitedQuotaBalance(b []byte) (string, bool) {
+	var r struct {
+		Data struct {
+			UnlimitedQuota bool `json:"unlimited_quota"`
+			UserQuota      *struct {
+				TotalAvailable *float64 `json:"total_available"`
+			} `json:"user_quota"`
+		} `json:"data"`
+	}
+	if json.Unmarshal(b, &r) != nil || !r.Data.UnlimitedQuota || r.Data.UserQuota == nil || r.Data.UserQuota.TotalAvailable == nil {
+		return "", false
+	}
+	return "$data.user_quota.total_available / 500000", true
+}
+
 // balanceSource is where one provider's balance is asked and how the
 // reply reads.
 type balanceSource struct {
@@ -54,7 +76,20 @@ func balanceSourceOf(p Provider) (balanceSource, bool) {
 		// a token saved beside it (a new-api relay's access token, its
 		// /api/user/self telling the account's quota) is asked with
 		// instead of the key
-		return balanceSource{p.BalanceURL, func(b []byte) (string, error) { return readBalancePath(b, path) }, p.BalanceToken, nil, nil}, true
+		// a new-api key-usage query left on its default field reads the
+		// account's own figure when the key has no quota of its own
+		// (#5436): the key's total_available is what an unlimited key has
+		// spent, not what is left, and the user's hand-set field is never
+		// second-guessed
+		mind := strings.TrimSpace(p.BalancePath) == "" && balanceURLPath(p.BalanceURL) == newAPIKeyUsage
+		return balanceSource{p.BalanceURL, func(b []byte) (string, error) {
+			if mind {
+				if alt, ok := unlimitedQuotaBalance(b); ok {
+					return readBalancePath(b, alt)
+				}
+			}
+			return readBalancePath(b, path)
+		}, p.BalanceToken, nil, nil}, true
 	}
 	if src, ok := zhipuBalanceSource(p); ok {
 		return src, true
diff --git a/internal/provider/balance_unlimited_test.go b/internal/provider/balance_unlimited_test.go
new file mode 100644
index 000000000..81cd55365
--- /dev/null
+++ b/internal/provider/balance_unlimited_test.go
@@ -0,0 +1,54 @@
+package provider
+
+import (
+	"testing"
+)
+
+// TestUnlimitedQuotaBalance: a new-api relay's key-usage reply, asked for
+// what is left on the key, says "unlimited_quota": true on a key with no
+// quota of its own — its total_available is what the key has spent, and it
+// goes negative once use passes the token's grant, so the balance magpie
+// shows went negative where the account held money (#5436, AnxForever:
+// $-4.33 shown, $106.44 held). The account's own total_available, under
+// user_quota in the same reply, in the same units, is the balance then.
+// A key with a quota of its own keeps reading the key's field, and a
+// Balance field the user set by hand is never second-guessed.
+func TestUnlimitedQuotaBalance(t *testing.T) {
+	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
+	t.Setenv("XDG_CACHE_HOME", t.TempDir())
+	payload := []byte(`{"code":true,"data":{"total_available":-2192414,"total_granted":0,"total_used":2192414,"unlimited_quota":true,"user_quota":{"total_available":53222012,"total_used":6778929}}}`)
+	p := Provider{ID: "arm", Name: "Arm", Chat: "https://ai.armclouding.com/v1", Key: "sk-a", BalanceURL: "https://ai.armclouding.com/api/usage/token"}
+	src, ok := balanceSourceOf(p)
+	if !ok {
+		t.Fatal("no balance source")
+	}
+	got, err := src.read(payload)
+	if err != nil {
+		t.Fatalf("read: %v", err)
+	}
+	if got != "$106.44" {
+		t.Fatalf("balance %q, want $106.44 (the account's own, not the unlimited key's spent)", got)
+	}
+
+	limited := []byte(`{"code":true,"data":{"total_available":2500000,"total_granted":5000000,"total_used":2500000,"unlimited_quota":false}}`)
+	got, err = src.read(limited)
+	if err != nil {
+		t.Fatalf("read limited: %v", err)
+	}
+	if got != "$5.00" {
+		t.Fatalf("limited key's balance %q, want $5.00", got)
+	}
+
+	byHand := Provider{ID: "arm", Name: "Arm", Chat: "https://ai.armclouding.com/v1", Key: "sk-a", BalanceURL: "https://ai.armclouding.com/api/usage/token", BalancePath: "$data.total_available / 500000"}
+	src, ok = balanceSourceOf(byHand)
+	if !ok {
+		t.Fatal("no balance source by hand")
+	}
+	got, err = src.read(payload)
+	if err != nil {
+		t.Fatalf("read by hand: %v", err)
+	}
+	if got != "$-4.38" {
+		t.Fatalf("a hand-set field was second-guessed: %q (want the key's own negative)", got)
+	}
+}
-- 
2.50.1 (Apple Git-155)

```

</details>

**Branch with the commit**: [`hunt-20261111-rf-5436`](https://github.com/ggbdpq/magpie/tree/hunt-20261111-rf-5436) (head `b9450bdf97df3ad6d50b5407fa7b160d4403fe25`), rebased onto current `upstream/main` (`4b29709ec`); on a fresh checkout at that tip `git am` applies it as is (replayed on a detached worktree, resulting tree identical to the branch head, checked by tree hash).

Verification this round (on `4b29709ec` + this commit, `GOCACHE` pinned):

| Check | Result |
| --- | --- |
| `TestUnlimitedQuotaBalance` | green with the patch |
| Ablation: the unlimited yield disabled (`return "", false` past the guard, build intact) | red with the report's own numbers: `balance "$-4.38", want $106.44 (the account's own, not the unlimited key's spent)`; restored: green |
| `go test -tags nogui -timeout 12m -count=1 ./internal/provider/` (whole package) | ok (148.4s), zero failures |
| `Unlimited\|Balance` neighbors | ok |
| `gofmt -l` on the two touched files | prints nothing |
| `go vet -tags nogui ./internal/provider/` | clean |
| `go build -tags nogui ./...` darwin / `GOOS=linux` | clean |

**Siblings**: `rg unlimitedQuotaBalance` — one producer (`balance.go`), read only where the built-in default field resolves (`balanceSourceOf`); a hand-set `Balance` field never reaches it (the yield is inside the default-field branch only). The same reply's other readers (the account-token balance path, `/api/user/self`) are untouched — they already read the account's own figure.

**When the read fails**: a reply without `unlimited_quota` or without `user_quota.total_available` yields nothing — the default field reads as it always did; nothing is invented from a partial reply.

**Not verified**: a real new-api relay issuing an unlimited key (the tests use a captured reply shape from the report); the GUI card's rendering.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.
