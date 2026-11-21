### What's wrong

With Claude kept `switchOnly=true` and then switched off (`off=true`) — and Codex just `off=true` — the Usage page loses the Claude/Codex quota cards and `magpie quota claude|codex --json` returns no windows at all, exactly as real-jacket's matrix says. A provider you only want for account switching looks as if its account were gone.

### Root cause

`visibleQuotas` (internal/provider/subscription_usage.go) dropped every card of a provider with `Off` set (`hidden[p.ID] = p.Hidden || p.Off`, since efed70706), and nothing stood the card back in: `fetchSubscriptionUsage` asks no switched-off vendor (left_alone, #2226 — kept as is here), so the cache never holds a card of it to filter. `left_alone.go`'s own comment says "What was last known of it is still shown"; the card is the one thing that isn't.

### The fix

Display only, no background read comes back:

- `visibleQuotas` keeps a removed account (`Hidden`) dropped, but stands in what was last read of a switched-off provider: `keepLast` already keeps each good reading on disk (`quotas.json`, across restarts), so `lastReadingsOf(id)` (internal/provider/quota_last.go) hands those back and `visibleQuotas` appends them when the provider shows no card of its own. Each comes dated (`AsOf`) and marked `ReadDeferred` — the Usage page and `magpie quota` already render that as "As of … — not refreshed this time" / "as of … (cached)", so a paused provider shows its last reading without pretending it is fresh. A provider switched off before it was ever read still has no card (nothing to show).
- `magpie quota wait` waits on fresh readings alone: `readable` already skips an `AsOf` card, and `Allotted` now leaves a switched-off provider's cards out entirely, so a wait for a provider with no account on still says "none of codex's accounts is on in magpie" instead of spinning on a stale card.
- `magpie quota refresh <provider>` on a switched-off provider now says "switched off in magpie: its allowance isn't read, its card is what was last read · switch it on to read it again", instead of reading nothing and answering "no subscription, plan or key balance".
- docs/subsystems/providers-accounts.md says the card's standing.

`switchOnly` itself is untouched, and #2226's background silence is untouched: not one request is added. This is report point 3 (show the last reading, marked as paused) as the smallest decoupling; the report's other points (a one-click "switch and show" preset, Codex's switchOnly wording, a last balance for keys) are product calls I did not guess at — a maintainer's eye welcome.

### Verification

| check | result |
| --- | --- |
| reproduction | real-jacket's matrix as a fixture (Claude `switchOnly=true`, then `SetOff`): `TestOffProviderKeepsLastCard` red on the parent (`a switched-off provider's last reading is not shown: []`), green with the fix; the quota `--json` json carries the card with `asOf` and `readDeferred:true` |
| boundaries | `TestOffProviderCardBoundaries`: a removed (`Hidden`) account with a kept reading shows no card; a switched-off provider never read shows no card |
| quota wait | the same fixture: `Allotted` keeps the card out, so the "none of its accounts is on" path is as before |
| tests | internal/provider whole (`-tags nogui`, 134s), internal/cli `-run Quota`, internal/gateway `-run "Quota\|Usage"`: ok; the named set and cli Quota also with `-race`: ok |
| ablation | the stand-in loop taken out of `visibleQuotas`: `TestOffProviderKeepsLastCard` red again ("last reading is not shown: []"); restored, green |
| siblings | `rg "leftAlone\("` — 12 sites, all background silence (no CLI, no reading, no switching, no warm, no check-in, no reset spend): untouched. `visibleQuotas`' three callers (`SubscriptionUsage`, `CachedCards`, the remote chain) get the same stand-in; the gateway's `GET /v1/magpie/quotas` goes through `QuotaReport` and now tells the card like `quota --json`. Key-balance and key-plan cards (`KeyBalances`, `PlanQuotas`) still skip a switched-off provider and get no stand-in — same family, left for a maintainer's call. `magpie quota refresh`'s 30-second kept path and its direct path now agree (both refuse a switched-off provider). The same-domain commits since 2026-11-08 (#5770, #5721, #3174, the remote-chain one) touch none of the three functions changed |
| git am | zero-conflict on a clean checkout of `ca7a39291`; author/committer `ggbdpq <ggbdpq@gmail.com>`; branch `fix/5863-quota-visible-when-off` at `973b5cd8d22ee58499caba43778cfe802cd6026b` |

NOT-RUNNABLE here: the real GUI's Usage page (the web asset's renderer already draws `asOf` and `readDeferred` — "As of {when} — not refreshed this time" — read in the source, internal/gui/assets/app.js).

---
**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

**Patch**: <details><summary>patch: provider: a subscription switched off keeps its last quota card, dated as of then (#5863) — git am applies it as is; SHA-256 first 16: 835d43f035fb87c9</summary>

```patch
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Tue, 10 Nov 2026 22:25:03 +0800
Subject: [PATCH] provider: a subscription switched off keeps its last quota
 card, dated as of then (#5863)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

A provider switched off (Off) is read no more in the background
(left_alone), and visibleQuotas dropped its card too: with Claude kept
to switch-only (switchOnly) and switched off to say so — real-jacket's
matrix — the Usage page's card and every quota --json window vanished,
as if the account were gone. Removed (Hidden) is that other thing and
stays gone.

What was last known of a switched-off provider is shown again: keepLast
already keeps each good reading on disk, and visibleQuotas stands the
provider's last readings in (AsOf dates them, ReadDeferred says no
request was made), which the Usage page and magpie quota render as
"as of … — not refreshed this time". A provider never read has no card
still. magpie quota wait waits on fresh readings alone: readable skips
an AsOf card, and Allotted leaves a switched-off provider's cards out
entirely, so "none of its accounts is on" is said as before. magpie
quota refresh says a switched-off provider isn't read, instead of
reading nothing and denying its card. docs/subsystems/
providers-accounts.md says the card's standing.

Run at upstream/main ca7a39291 + this commit, macOS (darwin/arm64):
- internal/provider -run "TestOffProviderKeepsLastCard|
  TestOffProviderCardBoundaries": red on the parent ("a switched-off
  provider's last reading is not shown: []"), ok here; -race ok
- internal/provider whole, internal/cli -run Quota, internal/gateway
  -run "Quota|Usage": ok (-race on the named set and cli Quota)
- internal/cli -run TestQuotaRefreshRefusesASwitchedOffProvider: ok
Broken by hand (visibleQuotas' stand-in loop taken out): the new test
red again ("last reading is not shown: []"), restored, ok.

Fixes #5863

Generated-by: GLM-5.3-Flash (ZCode)
---
 docs/subsystems/providers-accounts.md    |   2 +-
 internal/cli/quota_refresh_cli.go        |   6 +
 internal/cli/quota_refresh_cli_test.go   |  13 ++
 internal/provider/off_quota_card_test.go | 144 +++++++++++++++++++++++
 internal/provider/quota_last.go          |  27 +++++
 internal/provider/quotas.go              |  11 +-
 internal/provider/subscription_usage.go  |  23 ++++
 7 files changed, 223 insertions(+), 3 deletions(-)
 create mode 100644 internal/provider/off_quota_card_test.go

diff --git a/docs/subsystems/providers-accounts.md b/docs/subsystems/providers-accounts.md
index 514c1d88d..55293ed67 100644
--- a/docs/subsystems/providers-accounts.md
+++ b/docs/subsystems/providers-accounts.md
@@ -370,7 +370,7 @@ and `TestHistoricalWindowHoldsUsesEachWindowsOwnReading`.
 - The gateway and a magpie run from a terminal change the same files (#1674). `loginsMu` is a [`filelock.Mutex`](../../internal/filelock/filelock.go): besides the mutex it holds an OS lock on `logins.json.lock` (flock, `LockFileEx` on Windows), and taking it has `logins.json` read afresh (`filememo.Look`), so every read a change is made from sees what another magpie wrote, and a refresh the gateway wrote is never written back over. `savedTokenMu` holds `logins.json.renew.lock` the same way, so two magpies never spend one refresh token. `caller-keys.json` (`access`) and `mcp-signins.json` (`mcpauth`, with `mcp-signins.json.renew.lock` around a renewal) are changed under such locks too; `plugin-auth.json` already was, under `plugin-auth.json.lock`, which `host.js` takes too. A lock another magpie holds is waited for up to `filelock.Wait` (10s), then gone on without, as before there was one. `rememberLogins` writes nothing when only `Seen` would move on and the saved one is less than `seenEvery` (10 minutes) old, so a run that only lists accounts (`magpie ls`, `providers`, `sessions`, `usage`) leaves `logins.json` as it is. [`logins_lock_test.go`](../../internal/provider/logins_lock_test.go) covers both, the second with another test process writing between this one's read and write.
 - The account Codex or Claude Code is signed in to can be paused (`SetLoginOn` off, #263) only while another of its accounts is on. The gateway then sends it nothing: Codex's own-model turns go through routing, which passes over it (`OwnPaused`), and a native compaction (`/responses/compact`) goes to the first account on that isn't resting, signed as that account (`compactOn` in [codex_backend.go](../../internal/gateway/codex_backend.go)). The last other account off, the paused one is used again. A switched-off Codex provider is not a pause: Codex's own-model requests still relay on its sign-in as they came.
 - A switched-off provider (`Off`, #163) stays saved. The gateway says it is off instead of saying the model is unknown.
-- A subscription switched off (`Off`) or whose account was removed from magpie (`Hidden`) is left alone in the background (`leftAlone` in [`left_alone.go`](../../internal/provider/left_alone.go); Riko on Discord, whose Claude switched off still ran `claude auth status --json` every minute). No CLI is asked who is signed in (`claudeIdentity`, `cliIdentity.get` for Cursor and Devin): what it said last, in memory or `cli-identity.json`, is served, so the account stays listed to switch on again. Nor is its allowance read (`fetchSubscriptionUsage`, `loginUsageAt`), a saved ChatGPT sign-in renewed (`RenewLogins`), the agent's account switched (`NextLogin`), a window warmed (`keepWarm`), its model list fetched (`newDue`), a daily check-in made by the loop (`checkinNow` with `soon` false; a press still checks in), a plugin's idle sign-in renewed (`KeepPluginsSignedIn`, #5080), or a Codex reset about to run out read and spent (`SpendExpiringCodexResets`, #2226; `TestExpiringResetLeftAlone`). A Cursor switched off that was never asked who is signed in isn't listed until it is switched on. `TestLeftAloneRunsNoCLI` runs those paths with fake `claude`, `cursor-agent` and `devin` CLIs on PATH and checks none ran. Plugins' model lists (`KeepPluginsListed`, and every listing after a sign-in or a plugin changes) are asked of the plugin host all at once, and a plugin provider switched off in magpie is named in the call (`plugin.ListingOff`, `pluginsOff` in [`plugins.go`](../../internal/provider/plugins.go)): `host.js` runs no models hook for it, nor the sign-in renewal before one, and tells its list as fallen back, so the list told last is kept (ChangQiu on Discord: `TestOffPluginProviderAskedNoModels`, `TestPluginsOffNamesThePluginsOwnIDs`). Refreshing every list (the window's Refresh, `POST /api/sync`, and `magpie sync`) goes through `RefreshLists`, which asks no provider switched off, and a key added to one isn't given its own list (`PrefillNewKeys`), nor is a provider switched off asked for its list when it is saved or a key is switched on in its editor (`TestRefreshListsAsksNoProviderSwitchedOff`, `TestPrefillAsksNoProviderSwitchedOff`).
+- A subscription switched off (`Off`) or whose account was removed from magpie (`Hidden`) is left alone in the background (`leftAlone` in [`left_alone.go`](../../internal/provider/left_alone.go); Riko on Discord, whose Claude switched off still ran `claude auth status --json` every minute). No CLI is asked who is signed in (`claudeIdentity`, `cliIdentity.get` for Cursor and Devin): what it said last, in memory or `cli-identity.json`, is served, so the account stays listed to switch on again. Nor is its allowance read (`fetchSubscriptionUsage`, `loginUsageAt`) — what it last read still stands on the Usage page and in `magpie quota`, dated as of then and marked as not refreshed (`visibleQuotas`, #5863; a card never read has nothing to stand there; `magpie quota wait` still waits on fresh readings alone, `Allotted`) — a saved ChatGPT sign-in renewed (`RenewLogins`), the agent's account switched (`NextLogin`), a window warmed (`keepWarm`), its model list fetched (`newDue`), a daily check-in made by the loop (`checkinNow` with `soon` false; a press still checks in), a plugin's idle sign-in renewed (`KeepPluginsSignedIn`, #5080), or a Codex reset about to run out read and spent (`SpendExpiringCodexResets`, #2226; `TestExpiringResetLeftAlone`). A Cursor switched off that was never asked who is signed in isn't listed until it is switched on. `TestLeftAloneRunsNoCLI` runs those paths with fake `claude`, `cursor-agent` and `devin` CLIs on PATH and checks none ran. Plugins' model lists (`KeepPluginsListed`, and every listing after a sign-in or a plugin changes) are asked of the plugin host all at once, and a plugin provider switched off in magpie is named in the call (`plugin.ListingOff`, `pluginsOff` in [`plugins.go`](../../internal/provider/plugins.go)): `host.js` runs no models hook for it, nor the sign-in renewal before one, and tells its list as fallen back, so the list told last is kept (ChangQiu on Discord: `TestOffPluginProviderAskedNoModels`, `TestPluginsOffNamesThePluginsOwnIDs`). Refreshing every list (the window's Refresh, `POST /api/sync`, and `magpie sync`) goes through `RefreshLists`, which asks no provider switched off, and a key added to one isn't given its own list (`PrefillNewKeys`), nor is a provider switched off asked for its list when it is saved or a key is switched on in its editor (`TestRefreshListsAsksNoProviderSwitchedOff`, `TestPrefillAsksNoProviderSwitchedOff`).
 - *Warm up now*, the last row of Settings › Usage's Codex and Claude Code warm-up tabs (`renderWarmNow` in `app.js`, `POST /api/warm-now`), sends one account the request the scheduled warm-up sends, whatever the warm-up settings say ([`warm_now.go`](../../internal/provider/warm_now.go)): `warmCodexLogin` for a ChatGPT account, then `StaleAllowance`; for a Claude account Claude Code's own run, `warmClaudeLogin` over the gateway's `warmClaude` (`WarmClaudeVia`), in the saved account's directory, then `claudeWarmedNow`, which has the account read again on its next look while its last reading keeps its own time, so the old windows never show as just read (`TestClaudeWarmedReadAgain`). With several accounts the press opens the app's menu of them. An account whose sign-in lapsed is sent nothing and says so, and the vendor's refusal comes back as the row's line, in red. The scheduled warm-up's file (`codex-warmup.json`) isn't written: its next look reads the window as started. `TestWarmNowSendsTheScheduledWarmUp` checks the body and headers equal the scheduled warm-up's; `warm-now.test.cjs` covers the GUI.
 - The scheduled warm-up warms each window a Claude account is expected to have (`withExpected`), the 5-hour and the week, also one its reading left out: Anthropic leaves a window out until the request that starts it. A window left out while a shorter one is running is one the account doesn't have, since any use starts every window it has (a Claude Enterprise account with only the 5-hour, koohoko5924 on Discord, whose week was warmed over and over and its state read Idle): the warmer marks it `Absent` in `codex-warmup.json` and sends it nothing, and `usageRead` doesn't count it as due (`windowAbsent`, `shorterRunning` in [`codex_warmup.go`](../../internal/provider/codex_warmup.go)). A week once seen running, or left out of a reading that is only part of the plan's, is still warmed; one never read before is not. `TestClaudeWarmLeavesAWeekTheAccountHasnt`, `TestClaudeWarmStartsAWeekThatReset`, `TestUsageReadLeavesAWeekTheAccountHasnt`.
 - An Antigravity subscription offers the union of its On accounts' models (`antigravityPoolModels` in [`antigravity_pool.go`](../../internal/provider/antigravity_pool.go)), each account's own list kept beside it (`accountModels`, read by `Account.Lists` for routing). The lists are fetched at the first listing, a probe, a sync or a Refetch, and also at each account's quota reading, which asks `fetchAvailableModels` anyway: a reading whose models differ from the account's saved list saves it and merges the pooled list again from every On account's own (`noteAntigravityList`), so a model Google gives one account of several later (01huadalang on Discord: Gemini 4) is offered, routed to and given its bar without that account made preferred or probed. A switched-off account's reading changes nothing. `TestAntigravityQuotaReadingListsNewModels`. Each `fetchAvailableModels` names the account's paid and current tier first (`entitlement.userTier`, `askTiers`), then none; a tier Google answers 400 (a Google AI Pro account's g1-pro-tier, #1553) is left out of that account's lists and quota readings for `tierRefusedFor` (a day), and the refused request is no row of the request log.
diff --git a/internal/cli/quota_refresh_cli.go b/internal/cli/quota_refresh_cli.go
index f40f82b3e..eade5675a 100644
--- a/internal/cli/quota_refresh_cli.go
+++ b/internal/cli/quota_refresh_cli.go
@@ -53,6 +53,12 @@ func quotaRefreshCmd(args []string) error {
 	}
 	if p, err := provider.Find(id); err == nil && !provider.IsRemoteCard(id) {
 		id = p.ID
+		// A provider switched off in magpie is read no more, asking or not
+		// (left_alone.go): its card on the Usage page is what was last
+		// read, and there is nothing a refresh would ask (#5863)
+		if p.Off {
+			return fmt.Errorf("%s is switched off in magpie: its allowance isn't read, its card is what was last read · switch it on to read it again", id)
+		}
 	} else {
 		id = strings.ToLower(id)
 	}
diff --git a/internal/cli/quota_refresh_cli_test.go b/internal/cli/quota_refresh_cli_test.go
index a922fefa6..d863d8e7b 100644
--- a/internal/cli/quota_refresh_cli_test.go
+++ b/internal/cli/quota_refresh_cli_test.go
@@ -135,3 +135,16 @@ func TestQuotaRefreshGapPerCard(t *testing.T) {
 		t.Error("the provider's refresh didn't hold its account")
 	}
 }
+
+// A provider switched off in magpie is read no more, asking or not: the
+// refresh says so, instead of reading nothing and saying it has no card
+// (#5863).
+func TestQuotaRefreshRefusesASwitchedOffProvider(t *testing.T) {
+	groupsHome(t)
+	if err := provider.SetOff("a", true); err != nil {
+		t.Fatal(err)
+	}
+	if err := quotaRefreshCmd([]string{"a"}); err == nil || !strings.Contains(err.Error(), "switched off in magpie") {
+		t.Fatalf("not refused as switched off: %v", err)
+	}
+}
diff --git a/internal/provider/off_quota_card_test.go b/internal/provider/off_quota_card_test.go
new file mode 100644
index 000000000..1ca72e698
--- /dev/null
+++ b/internal/provider/off_quota_card_test.go
@@ -0,0 +1,144 @@
+package provider
+
+import (
+	"context"
+	"encoding/json"
+	"path/filepath"
+	"strings"
+	"testing"
+	"time"
+)
+
+// Switched off, a provider is read no more in the background
+// (left_alone.go), but what was last known of it is still shown: the Usage
+// page and magpie quota keep its card, dated as of the last read and
+// marked as not refreshed (#5863: a subscription switched off to only
+// switch its account, whose quota card and quota --json windows vanished
+// altogether). What magpie quota wait waits on is a fresh reading still,
+// so Allotted keeps the card out.
+func TestOffProviderKeepsLastCard(t *testing.T) {
+	home := claudeHome(t)
+	claudeSignIn(t, home, time.Now().Add(time.Hour))
+	writeFile(t, filepath.Join(home, ".claude.json"), map[string]any{"oauthAccount": map[string]any{"emailAddress": "a@example.com", "accountUuid": "u-a"}})
+	rememberLogins(true)
+	if err := SetSwitchOnly("claude", true); err != nil {
+		t.Fatal(err)
+	}
+	if err := SetOff("claude", true); err != nil {
+		t.Fatal(err)
+	}
+	later := time.Now().Add(time.Hour)
+	keepLast(SubscriptionQuota{Provider: "claude", Name: "Claude Code", User: "a@example.com", Windows: []QuotaWindow{
+		{Name: "5 hours", Used: 40, ResetsAt: &later, Span: 5 * time.Hour},
+	}}, "")
+	forgetQuotas(t)
+
+	c := &subscriptionUsageCache
+	c.Lock()
+	c.data, c.at, c.asked, c.pending = nil, time.Time{}, false, nil
+	c.Unlock()
+	t.Cleanup(clearUsageCache)
+
+	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
+	defer cancel()
+	got := SubscriptionUsage(ctx)
+	if len(got) != 1 || got[0].Provider != "claude" {
+		t.Fatalf("a switched-off provider's last reading is not shown: %+v", got)
+	}
+	q := got[0]
+	if q.AsOf == nil || !q.ReadDeferred || q.Name != "Claude Code" || q.User != "a@example.com" || len(q.Windows) != 1 || q.Windows[0].Used != 40 {
+		t.Fatalf("not the last reading, dated and marked: %+v", q)
+	}
+
+	// magpie quota --json tells the same card
+	b, err := json.Marshal(QuotaReport(context.Background(), time.Now()))
+	if err != nil {
+		t.Fatal(err)
+	}
+	if s := string(b); !strings.Contains(s, `"provider":"claude"`) || !strings.Contains(s, `"asOf":"`) || !strings.Contains(s, `"readDeferred":true`) {
+		t.Fatalf("quota report's json lost the off provider's card: %s", s)
+	}
+
+	// what magpie quota wait waits on is a fresh reading: the card stays
+	// out of Allotted
+	for _, r := range Allotted(context.Background()) {
+		if r.Provider == "claude" {
+			t.Fatalf("quota wait would wait on the switched-off provider's last card: %+v", r)
+		}
+	}
+}
+
+// An account removed from magpie (Hidden) has no card at all, even one
+// read before; a provider switched off that was never read has nothing to
+// show.
+func TestOffProviderCardBoundaries(t *testing.T) {
+	home := claudeHome(t)
+	claudeSignIn(t, home, time.Now().Add(time.Hour))
+	writeFile(t, filepath.Join(home, ".claude.json"), map[string]any{"oauthAccount": map[string]any{"emailAddress": "a@example.com", "accountUuid": "u-a"}})
+	rememberLogins(true)
+	if err := Delete("claude"); err != nil {
+		t.Fatal(err)
+	}
+	later := time.Now().Add(time.Hour)
+	keepLast(SubscriptionQuota{Provider: "claude", Name: "Claude Code", User: "a@example.com", Windows: []QuotaWindow{
+		{Name: "5 hours", Used: 40, ResetsAt: &later, Span: 5 * time.Hour},
+	}}, "")
+	forgetQuotas(t)
+
+	c := &subscriptionUsageCache
+	c.Lock()
+	c.data, c.at, c.asked, c.pending = nil, time.Time{}, false, nil
+	c.Unlock()
+	t.Cleanup(clearUsageCache)
+
+	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
+	defer cancel()
+	for _, q := range SubscriptionUsage(ctx) {
+		if q.Provider == "claude" {
+			t.Fatalf("a removed account's card is shown: %+v", q)
+		}
+	}
+
+	// Codex switched off without ever having been read: nothing to show
+	writeFile(t, filepath.Join(home, ".codex", "auth.json"), map[string]any{
+		"tokens": map[string]any{"access_token": "x", "account_id": "acct-1"},
+	})
+	if err := SetOff("codex", true); err != nil {
+		t.Fatal(err)
+	}
+	for _, q := range SubscriptionUsage(ctx) {
+		if q.Provider == "codex" {
+			t.Fatalf("a card out of nothing for a provider never read: %+v", q)
+		}
+	}
+}
+
+// forgetQuotas drops what keepLast and the tests before it kept, as after
+// a restart: the readings are on disk, and the next read loads them again.
+// The test ends on the same footing.
+func forgetQuotas(t *testing.T) {
+	t.Helper()
+	resetQuotas()
+	t.Cleanup(resetQuotas)
+}
+
+func resetQuotas() {
+	lastQuotas.Lock()
+	lastQuotas.m, lastQuotas.loaded = nil, false
+	lastQuotas.Unlock()
+}
+
+func clearUsageCache() {
+	c := &subscriptionUsageCache
+	for {
+		c.Lock()
+		p := c.pending
+		if p == nil {
+			c.data, c.at = nil, time.Time{}
+			c.Unlock()
+			return
+		}
+		c.Unlock()
+		<-p
+	}
+}
diff --git a/internal/provider/quota_last.go b/internal/provider/quota_last.go
index b011cb4d6..92ee12e53 100644
--- a/internal/provider/quota_last.go
+++ b/internal/provider/quota_last.go
@@ -9,8 +9,10 @@ import (
 	"crypto/sha256"
 	"encoding/hex"
 	"encoding/json"
+	"maps"
 	"os"
 	"path/filepath"
+	"slices"
 	"strings"
 	"sync"
 	"time"
@@ -200,6 +202,31 @@ func (c *lastQuotasT) reported(key string) (SubscriptionQuota, bool) {
 	return out, true
 }
 
+// lastReadingsOf is what was last read of provider id's accounts, oldest
+// user first: for a provider switched off, which is read no more
+// (left_alone.go), its cards keep standing with what it last reported,
+// dated as of then (#5863). A provider never read has nothing.
+func lastReadingsOf(id string) []SubscriptionQuota {
+	if id == "" {
+		return nil
+	}
+	c := &lastQuotas
+	c.Lock()
+	defer c.Unlock()
+	c.load()
+	prefix := id + "/"
+	var out []SubscriptionQuota
+	for _, k := range slices.Sorted(maps.Keys(c.m)) {
+		if !strings.HasPrefix(k, prefix) {
+			continue
+		}
+		if q, ok := c.reading(k); ok {
+			out = append(out, q)
+		}
+	}
+	return out
+}
+
 // lastAllowances is each of an agent's accounts' allowance as it last
 // read, kept on disk: what routing goes by while the first reading since
 // magpie started is still out, rather than by none — with none, every
diff --git a/internal/provider/quotas.go b/internal/provider/quotas.go
index 7c44b9a9d..c05762d30 100644
--- a/internal/provider/quotas.go
+++ b/internal/provider/quotas.go
@@ -42,10 +42,17 @@ func InProviderOrder(qs []SubscriptionQuota) []SubscriptionQuota {
 
 // Allotted is Quotas without the keys' balances: the accounts and plans
 // whose allowance runs out and starts again, which is what magpie quota
-// wait waits on; no key's balance is asked for.
+// wait waits on; no key's balance is asked for. A provider switched off
+// in magpie stays out: it is read no more, and what its last card (as of
+// then) says is not an allowance the agent would ever be moved to
+// (#5863).
 func Allotted(ctx context.Context) []SubscriptionQuota {
 	plans, subs := seatCards(PlanQuotas(ctx), SubscriptionUsage(ctx))
-	return append(withAccountNames(subs), plans...)
+	qs := append(withAccountNames(subs), plans...)
+	return slices.DeleteFunc(qs, func(q SubscriptionQuota) bool {
+		p, err := Find(q.Provider)
+		return err == nil && p.Off
+	})
 }
 
 func quotas(ctx context.Context) (subs, plans, balances []SubscriptionQuota) {
diff --git a/internal/provider/subscription_usage.go b/internal/provider/subscription_usage.go
index 695ccaa31..550ad6b9e 100644
--- a/internal/provider/subscription_usage.go
+++ b/internal/provider/subscription_usage.go
@@ -395,10 +395,20 @@ func SubscriptionUsageReading() bool {
 }
 
 // visibleQuotas drops accounts removed from magpie since the last refresh.
+// A provider switched off is asked no more in the background
+// (left_alone.go), but what was last known of it is still shown: its last
+// readings stand in, dated as of when they were made and marked as not
+// being refreshed (#5863: switched off to only switch its account, its
+// card and quota's windows vanished altogether). A removed account
+// (Hidden) stays gone.
 func visibleQuotas(all []SubscriptionQuota) []SubscriptionQuota {
 	hidden := map[string]bool{}
+	off := map[string]bool{}
 	for _, p := range load().Providers {
 		hidden[p.ID] = p.Hidden || p.Off // switched off: not asked either
+		if p.Off && !p.Hidden {
+			off[p.ID] = true
+		}
 	}
 	var chosen map[string]map[string]bool
 	out := []SubscriptionQuota{}
@@ -425,6 +435,19 @@ func visibleQuotas(all []SubscriptionQuota) []SubscriptionQuota {
 		}
 		out = append(out, q)
 	}
+	shown := map[string]bool{}
+	for _, q := range out {
+		shown[q.Provider] = true
+	}
+	for id := range off {
+		if shown[id] {
+			continue
+		}
+		for _, q := range lastReadingsOf(id) {
+			q.ReadDeferred = true
+			out = append(out, q)
+		}
+	}
 	return out
 }
 
-- 
2.50.1 (Apple Git-155)

```

</details>
