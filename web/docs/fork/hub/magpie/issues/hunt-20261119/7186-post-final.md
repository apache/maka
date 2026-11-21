Following the reporter's routing trace, this patch takes an account whose sign-in the vendor has refused out of the routing's front ranks: a plugin account marked `Lapsed` is asked after the healthy ones, and only when none healthy can take the model is it asked at all. The stand-in and the group then fall through to the providers the agent actually asked, instead of every turn of the conversation dying on one dead account's 401.

**Root cause:** the refusal was already recorded — a plugin answering 401 about the sign-in marks the account `Lapsed` (`notePluginLapseOf`, and the reporter's WorkBuddy error is exactly that refusal, `sign-in` words in the body so `modelOnly401` keeps it an account matter) — but `Lapsed` was read by the pages and the account listing only. `AccountsFor`, where routing picks the accounts, never looked at it: the dead account kept its rank, stood first in the stand-in's `order`, and answered 105 requests with the same 401 in seven minutes while `haoai-claude` and `ai-router` were never tried.

**The fix:** `AccountsFor` now splits the accounts it has screened by the served model and the caps once more by `lapsedUsers()` (the flag read under `loginsMu` without copying the list, so the hot path pays a scan, not the 61 MB of copies `loginsCopied` was taught by), and asks the healthy ones first — the refused ones ride at the tail of the plan, tried only when no healthy account can take the model, which is also where they come back once another computer has signed the vendor in again. With none healthy left they are asked as before, in their places: the refusal they answer is all there is to say. A built-in account keeps its rank — its auth failure is told as `failAuth` and the next account is asked at once with no rest and no login run again, a shape its own tests lock; the account a stand-in conversation died on is a plugin's.

The reporter's second ask (a switch for the stand-in itself) and third (a visible word for a substituted model) stay with the maintainer, as #4991 and #3337 already carry them; this patch changes only who is asked, not that a stand-in happens.

**Two tests moved with the behavior**, both in the plugin face the fix is for: `TestPluginFailover`'s gone round leaves `a` genuinely lapsed (its refresh renewed and it was refused again), so the rounds after it now run `b` and then `full` — `a` is no longer tried on the way, and when the group's other accounts are all out the group falls to its next member (`ko`) after two tries, not three; the none-healthy branches of that test still ask the lapsed accounts, unchanged. `TestClaudeAuthFailureFallsBackWithoutRetryingTheLogin` is untouched, and passes: a built-in's refused account keeps its rank.

**Source:** reported in #7186 with the routing records, the gateway log's 105 lines, and the app.log excerpts; the fix is the reporter's first ask, at the routing's own table.

**Red without the fix:** `TestAccountsForSendsLapsedLast` (new) — `out = [a@fake b@fake c@fake], want the healthy ones only`.

| Check | Result |
| --- | --- |
| `TestAccountsForSendsLapsedLast` | Green at final head: two healthy, one refused → out is the healthy pair and the refused one rides last; none healthy → all asked as before; without the fix: `out = [a@fake b@fake c@fake], want the healthy ones only` |
| Ablation (the split reverted, test kept) | Same failure; restored, green |
| `TestPluginFailover` | Pass with its two rounds updated to the new order (the gone round's lapse now keeps `a` out of the later rounds' way); the failover, no-rest, and refresh-renewal semantics it locks are unchanged |
| `TestClaudeAuthFailureFallsBackWithoutRetryingTheLogin` | Pass unchanged (built-ins keep their rank) |
| `go test -tags nogui -timeout=45m -count=1 ./internal/provider/` | Exit 1 with `TestResolveVia` alone (132.6s) — the documented local proxy-isolation environment failure, the same test the #7190 and earlier verifications attribute to this machine; no failure in the accounts or routing tests |
| `go test -tags nogui -timeout=45m -count=1 ./internal/gateway/` | Exit 1 with the three pre-existing failures the #7182 verification lists (`TestOpenCodeGoOwnFreeModelGetsNothingOfOpenCodes` and the two `TestOpenAIProvider` socket tests, all three failing on the bare base); nothing else, 894.3s |
| Targeted `-race` (`TestAccountsFor*`, `TestAccountOrder*`) | Pass |
| `gofmt -l` changed files, `git diff --check` | No output / clean |
| `go vet` darwin; `GOOS=linux go vet -tags nogui`; `GOOS=windows go vet` | All exit 0 |
| darwin/windows `go build ./…`; linux `go build -tags nogui ./…` | All exit 0 |
| Actual rebase onto `6d153bffc` | Clean; `git range-diff` `=` (no drift) |
| Strict `git am` on `6d153bffc` | Applies cleanly; resulting tree equals final head; author remains `ggbdpq <ggbdpq@gmail.com>` |

**Not verified:** the reporter's WorkBuddy desktop end-to-end (the plugin fixture stands in for the refused sign-in; the 401 the reporter saw is the same `notePluginLapseOf` path the flag comes from); how a mixed provider behaves when the lapsed account is the only one that lists a model the healthy ones lack — the model screening (`AccountServes`, the plans) runs before the lapse split, so a model only the dead account serves still reaches it.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

**Branch with the commit**: [fix/7186-standin-skip-dead](https://github.com/ggbdpq/magpie/tree/fix/7186-standin-skip-dead), head `924d6002d96b2c28d86532af571d2aa689b9f234`.

<details><summary>patch: provider: routing asks a refused account only when no healthy one can go (#7186) — git am applies it as is; SHA-256 first 16: b9ac6873461abeb8</summary>

```patch
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Fri, 20 Nov 2026 01:04:21 +0800
Subject: [PATCH] provider: routing asks a refused account only when no healthy
 one can go (#7186)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

What changed: AccountsFor asked an account whose sign-in the vendor
refused (Lapsed) in its rank, like any other. Tried in its place, its
401 came back as the conversation's own while the providers the agent
asked were never tried — three Codex conversations, 105 requests, all on
one dead WorkBuddy stand-in account in seven minutes. The Lapsed flag
was read by the pages and the app's account listing, never by routing.
A refused account now rides at the tail of the plan (left), tried only
when no healthy account can take the model — with none healthy left,
they are asked as before, in their places, the refusal they answer
being all there is to say. lapsedUsers reads the flag under loginsMu
without copying the list, so the hot path pays a scan, not 61 MB of
copies (loginsCopied's lesson).

Run: TestAccountsForSendsLapsedLast (new) fails without the fix (out =
[a@fake b@fake c@fake], want the healthy ones only) and passes with it,
the none-healthy case included. See the issue post for the matrix.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/plugin_failover_test.go | 10 ++-
 internal/provider/account_lapsed_test.go | 83 ++++++++++++++++++++++++
 internal/provider/logins.go              | 17 +++++
 internal/provider/route_accounts.go      | 24 +++++++
 4 files changed, 132 insertions(+), 2 deletions(-)
 create mode 100644 internal/provider/account_lapsed_test.go

diff --git a/internal/gateway/plugin_failover_test.go b/internal/gateway/plugin_failover_test.go
index 81b751f0a..f578b65e7 100644
--- a/internal/gateway/plugin_failover_test.go
+++ b/internal/gateway/plugin_failover_test.go
@@ -238,7 +238,11 @@ func TestPluginFailover(t *testing.T) {
 		}
 	}
 	reset(map[string]string{"a": "quota", "b": "quota"})
-	if code, body, seen := ask("fakeco/fake-claude"); code != 200 || !strings.Contains(body, "claude from full") || strings.Join(seen, " ") != "a b full" {
+	// a was left lapsed by the gone round above (its refresh renewed and
+	// it was refused again): routing asks the healthy ones first (#7186),
+	// so the quota round now runs b and then full, a no longer tried on
+	// the way
+	if code, body, seen := ask("fakeco/fake-claude"); code != 200 || !strings.Contains(body, "claude from full") || strings.Join(seen, " ") != "b full" {
 		t.Fatalf("fake-claude with the others out: %d %s (tried %v)", code, body, seen)
 	}
 	reset(map[string]string{})
@@ -258,8 +262,10 @@ func TestPluginFailover(t *testing.T) {
 		t.Fatalf("the group's first member: %d %s (tried %v, other %v)", code, body, seen, other.tried)
 	}
 	reset(map[string]string{"a": "quota", "b": "stream", "full": "quota"})
+	// a is still lapsed from the gone round, so the group's first member
+	// is asked for b and full alone before ko takes it (#7186)
 	code, body, seen := ask("group/mixed")
-	if code != 200 || !strings.Contains(body, "from ko") || len(seen) != 3 {
+	if code != 200 || !strings.Contains(body, "from ko") || len(seen) != 2 {
 		t.Fatalf("with the plugin's accounts out: %d %s (tried %v, other %v)", code, body, seen, other.tried)
 	}
 }
diff --git a/internal/provider/account_lapsed_test.go b/internal/provider/account_lapsed_test.go
new file mode 100644
index 000000000..04d90aeae
--- /dev/null
+++ b/internal/provider/account_lapsed_test.go
@@ -0,0 +1,83 @@
+package provider
+
+import (
+	"context"
+	"path/filepath"
+	"reflect"
+	"slices"
+	"testing"
+	"time"
+
+	"github.com/yetone/magpie/internal/plugin"
+	"github.com/yetone/magpie/internal/testenv"
+)
+
+// A plugin account whose sign-in the vendor refused (Lapsed) is asked
+// after the healthy ones, not in its rank: tried in its place, its 401
+// came back as the conversation's own while the providers the agent
+// asked were never tried — three Codex conversations, 105 requests, all
+// on one dead WorkBuddy account in seven minutes (#7186). With no
+// healthy account left they are asked as before, in their places: the
+// refusal they answer is all there is to say.
+func TestAccountsForSendsLapsedLast(t *testing.T) {
+	lapsedPluginAccounts(t, map[string]string{"a@fake": "refused", "b@fake": "", "c@fake": ""})
+	id := PluginID("fakeco")
+	p, err := Find(id)
+	if err != nil {
+		t.Fatal(err)
+	}
+	out, left, barred := p.AccountsFor("fake-claude", nil)
+	if barred != nil {
+		t.Fatalf("barred %v", loginUsersOf(barred))
+	}
+	if got := loginUsersOf(out); !reflect.DeepEqual(got, []string{"b@fake", "c@fake"}) {
+		t.Fatalf("out = %v, want the healthy ones only", got)
+	}
+	if got := loginUsersOf(left); !reflect.DeepEqual(got, []string{"a@fake"}) {
+		t.Fatalf("left = %v, want the lapsed one alone", got)
+	}
+	// and with none healthy, they are asked as before, in their places
+	lapsedPluginAccounts(t, map[string]string{"a@fake": "refused", "b@fake": "refused", "c@fake": "refused"})
+	p, _ = Find(id)
+	out, left, barred = p.AccountsFor("fake-claude", nil)
+	if got := loginUsersOf(out); !slices.Equal(got, []string{"a@fake", "b@fake", "c@fake"}) {
+		t.Fatalf("with none healthy, out = %v, want them all", got)
+	}
+	if len(left)+len(barred) != 0 {
+		t.Fatalf("left %v barred %v", loginUsersOf(left), loginUsersOf(barred))
+	}
+}
+
+func lapsedPluginAccounts(t *testing.T, lapsed map[string]string) {
+	t.Helper()
+	bun := testenv.Bun(t)
+	claudeHome(t)
+	t.Setenv("MAGPIE_BUN", bun)
+	t.Cleanup(plugin.Settle)
+	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
+	defer cancel()
+	abs, _ := filepath.Abs("../plugin/testdata/fake/index.js")
+	if _, err := plugin.Add(ctx, abs); err != nil {
+		t.Fatal(err)
+	}
+	var rows []savedLogin
+	for user, why := range lapsed {
+		k, err := plugin.Import(ctx, "fakeco", map[string]any{"type": "oauth", "refresh": "r-" + user, "access": "a", "expires": 9e15, "accountId": user})
+		if err != nil {
+			t.Fatal(err)
+		}
+		rows = append(rows, savedLogin{Agent: "plugin:fakeco", User: user, Home: k, On: true, Lapsed: why})
+	}
+	saveLogins(t, rows...)
+	if _, err := plugin.Providers(ctx); err != nil {
+		t.Fatal(err)
+	}
+}
+
+func loginUsersOf(as []AccountOn) []string {
+	out := make([]string, 0, len(as))
+	for _, a := range as {
+		out = append(out, a.Account.User)
+	}
+	return out
+}
diff --git a/internal/provider/logins.go b/internal/provider/logins.go
index 433930788..b3fb437e5 100644
--- a/internal/provider/logins.go
+++ b/internal/provider/logins.go
@@ -256,6 +256,23 @@ func readLogins() []savedLogin {
 // loginsCopied counts readLogins' copies, for a test.
 var loginsCopied atomic.Int64
 
+// lapsedUsers are the accounts a vendor refused to refresh (Lapsed), by
+// the user each is signed in as: routing asks the healthy ones first and
+// these only when there are none left, for tried in their places their
+// 401 came back as the conversation's own while the providers the agent
+// asked were never tried (#7186).
+func lapsedUsers() map[string]bool {
+	loginsMu.Lock()
+	defer loginsMu.Unlock()
+	out := map[string]bool{}
+	for _, l := range sharedLogins() {
+		if l.Lapsed != "" {
+			out[strings.ToLower(l.User)] = true
+		}
+	}
+	return out
+}
+
 // sharedLogins is readLogins without the caller's own copy: the accounts
 // as kept, read only. A page's state lists a dozen agents' accounts, and
 // a copy of the whole list for each was 61 MB of what twenty window polls
diff --git a/internal/provider/route_accounts.go b/internal/provider/route_accounts.go
index 130065175..9d170c9f3 100644
--- a/internal/provider/route_accounts.go
+++ b/internal/provider/route_accounts.go
@@ -78,6 +78,30 @@ func (p Provider) AccountsFor(model string, held func(AccountOn) bool) (out, lef
 			return true
 		})
 	}
+	// an account whose sign-in the vendor refused (Lapsed) is asked after
+	// the healthy ones, not in its rank: tried in its place, its 401 came
+	// back as the conversation's own while the providers the agent asked
+	// were never tried — three Codex conversations, 105 requests, all on
+	// one dead WorkBuddy account in seven minutes (#7186). With no
+	// healthy account left they are asked as before, in their places:
+	// the refusal they answer is all there is to say.
+	// a built-in's refused account keeps its rank: its auth failure is
+	// told as failAuth and the next account is asked at once, with no
+	// rest and no login run again — a shape its own tests lock. A
+	// plugin's is the one a stand-in conversation died on (#7186).
+	if lapsed := lapsedUsers(); p.IsPlugin() && len(lapsed) > 0 {
+		var kept, resting []AccountOn
+		for _, a := range all {
+			if lapsed[strings.ToLower(a.Account.User)] {
+				resting = append(resting, a)
+			} else {
+				kept = append(kept, a)
+			}
+		}
+		if len(kept) > 0 && len(resting) > 0 {
+			all, left = kept, append(left, resting...)
+		}
+	}
 	own := p.OwnModelID(model)
 	var lacking []AccountOn
 	for _, a := range all {
-- 
2.50.1 (Apple Git-155)

```

</details>

