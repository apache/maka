Most settings setters read, change and write the whole file — `s := settings.Load()`, change one field, `settings.Save(s)` — with nothing held across the three steps: `Load` and `Save` each take `settings.fileMu` on their own (`internal/settings/settings.go`). Two setters that run at once each save their own snapshot, and the second write drops the first one's change. Reproduced on base `1a3b9268` with the guard test below: turning the credits switch off for two accounts at once lost an update in 98 to 100 of every 100 rounds (and the reporter's own repro lost 200 of 200 runs). The fix is the direction the report suggests: a `settings.Update(func(*Settings) error) error` that holds `fileMu` across load, the change, and save — the shape of the one setter that was already correct, `SetGatewayConversations` — and the three setters the report names moved onto it.

Branch: [`hunt45-a-settings-update`](https://github.com/ggbdpq/magpie/tree/hunt45-a-settings-update), one commit on top of upstream `1a3b9268860263f263a2c832b1f9b6d1b57e3fa0`; the patch below applies with `git am`.

## What changed

- `internal/settings/settings.go:1174` — new `Update(fn func(*Settings) error) error`: holds `fileMu` across `load()` -> `fn(&s)` -> `save(s, false)`. `fn`'s error leaves the file as it was; like every save but the consent one, recording consent is kept (a generic save still cannot enable `GatewayConversations`).
- `internal/provider/codex_credits.go:36` — `SetCodexCredits` mutates inside `Update` (was `settings.Load()` and `settings.Save(s)` in the same function).
- `internal/provider/codex_autoreset.go:122` — `setCodexAutoReset` likewise.
- `internal/provider/modelprefs.go:78` — `setModelName` likewise. One behavior nuance, called out honestly: the no-op path (a name set to what it already was) used to return without saving; it now lets `Update` write what the file holds back to it. Nothing else changes by it.
- `internal/provider/codex_credits_concurrent_test.go` — the guard test (`TestSetCodexCreditsConcurrentKeepsBothAccounts`), described under *Red before the fix*.

**The remaining Load->Save sites, honestly:** on base, 84 `settings.Save(...)` call sites sat outside `internal/settings`, in 55 functions across 30 files. In every one of those 55 functions, the snapshot saved comes from `settings.Load()` or `settings.LoadChecked()` in the same function — that is, all of them are whole-settings read-modify-write with the same race (none is a read-only use, and `settings.Save` only ever writes `settings.json`, so none writes a different file). This commit moves the three the report names; **52 functions in 28 files (81 call sites) are left untouched** — the full list is under *Siblings*.

## Red before the fix

Base `1a3b9268860263f263a2c832b1f9b6d1b57e3fa0`, test `TestSetCodexCreditsConcurrentKeepsBothAccounts` (`internal/provider/codex_credits_concurrent_test.go`): 100 rounds per run; each round releases two goroutines past a start gate, each turning the credits switch off for its own fresh account, and the round fails if either account is missing afterwards. Single rounds are not deterministic on a quiet machine (an earlier single-round version failed 11 of 20 runs — the two goroutines do not always overlap), so the test amplifies over 100 rounds; the fsync+rename inside the save keeps the window wide, and the amplified test went red in every run tried.

```
$ go test -tags nogui -count=5 -run 'TestSetCodexCreditsConcurrentKeepsBothAccounts' ./internal/provider/
--- FAIL: TestSetCodexCreditsConcurrentKeepsBothAccounts (1.63s)
    codex_credits_concurrent_test.go:46: 100 of 100 rounds lost an update
--- FAIL: TestSetCodexCreditsConcurrentKeepsBothAccounts (1.57s)
    codex_credits_concurrent_test.go:46: 98 of 100 rounds lost an update
--- FAIL: TestSetCodexCreditsConcurrentKeepsBothAccounts (1.55s)
    codex_credits_concurrent_test.go:46: 100 of 100 rounds lost an update
--- FAIL: TestSetCodexCreditsConcurrentKeepsBothAccounts (1.58s)
    codex_credits_concurrent_test.go:46: 100 of 100 rounds lost an update
--- FAIL: TestSetCodexCreditsConcurrentKeepsBothAccounts (1.65s)
    codex_credits_concurrent_test.go:46: 100 of 100 rounds lost an update
FAIL
FAIL    github.com/yetone/magpie/internal/provider 8.309s
FAIL
```

5 of 5 runs failed, each losing 98 to 100 of its 100 rounds. With the fix, the same command passed 20 of 20 (`-count=20`, `ok ... 37.970s`, exit 0).

## Verification

| Check | Command | Result |
|---|---|---|
| Guard test after the fix | `go test -tags nogui -count=20 -run 'TestSetCodexCreditsConcurrentKeepsBothAccounts' ./internal/provider/` | ok, 20/20 runs, exit 0 |
| Ablation (product files restored from base, test kept) | same, `-count=5` | fail 5/5, 95-100 of 100 rounds lost per run; fix restored, green again (5/5) |
| Mutation (a): `Update` releases the lock between load and save, like `Load`/`Save` | same, `-count=20` | fail 4/20 runs (1 of 100 rounds each) — the broken form's window is much narrower (a woken waiter usually loses the race back to the unlocking goroutine), but the test still catches it |
| Mutation (b): consent setter guard | `go test -tags nogui -count=1 ./internal/settings/` (includes `TestGatewayConversationConsentSurvivesStaleSettings` and friends) | ok |
| settings suite | `go test -tags nogui -count=1 ./internal/settings/` | ok, 20.4s, exit 0 |
| provider suite (full) | `go test -tags nogui -count=1 ./internal/provider/` | ok, 72.4s, exit 0, no failures |
| race, guard test | `go test -race -tags nogui -count=1 -run 'TestSetCodexCreditsConcurrentKeepsBothAccounts' ./internal/provider/` | ok, 3.4s |
| race, settings package | `go test -race -tags nogui -count=1 ./internal/settings/` | ok, 21.6s |
| gofmt | `gofmt -l internal/settings/ internal/provider/` | empty |
| vet | `go vet -tags nogui ./internal/settings/ ./internal/provider/`, then `GOOS=linux` and `GOOS=windows` again | clean on all three |
| build | `go build -tags nogui ./...` (darwin and linux); `GOOS=windows go build -o /dev/null .` | all exit 0; one pre-existing cgo warning in `internal/gui/trayimage_darwin.go:112`, a file this change does not touch |

## Siblings — the Load->Save sites left as they are

Scope: this change is the reported, repro'd paths plus the helper. Moving the other 52 functions is mechanical once the direction is accepted — each becomes `return settings.Update(func(s *settings.Settings) error { ... })` with its mutations carried over — but that is a wide, mostly mechanical diff across gui, cli, provider, access, backup and tui, better reviewed on its own than smuggled into this one. Counted here so the follow-up can be picked up by anyone; happy to do it as a follow-up PR if the direction is accepted.

The full enumeration (52 functions in 28 files, 81 `settings.Save(` call sites; every one loads its snapshot in the same function):

- `internal/access/access.go` — `Update` (:461), `migrateLegacyLANKey` (:556), `configureLAN` (:593, 2 sites)
- `internal/backup/backup.go` — `Restore` (:462, 2 sites)
- `internal/cli/account_discovery_cli.go` — `accountsDiscoveryCmd` (:21)
- `internal/cli/quota_cli.go` — `quotaAlertCmd` (:481)
- `internal/cli/update_cli.go` — `updateAutoCmd` (:50), `updateMirrorCmd` (:93)
- `internal/cli/visible_cli.go` — `visibleCmd` (:120)
- `internal/gui/api.go` — `Handler` (:1275, 26 sites across its settings routes)
- `internal/gui/archive.go` — `archiveRoutes` (:106)
- `internal/gui/gatewaymode.go` — `gatewayModeRoutes` (:73)
- `internal/gui/lightweight.go` — `makeMain` (:81)
- `internal/gui/plugins.go` — `setChinaMirror` (:750)
- `internal/gui/port.go` — `setPort` (:91, 3 sites)
- `internal/provider/agenteffort.go` — `SetAgentEffort` (:47)
- `internal/provider/bare.go` — `SetBareModelIDs` (:38)
- `internal/provider/codex_subagent.go` — `SetCodexSubagentModel` (:90)
- `internal/provider/codex_warmup.go` — `SetCodexWarmAt` (:520)
- `internal/provider/compact.go` — `SetModelCompacts` (:207), `SetCompactAt` (:229)
- `internal/provider/desktop_subagent.go` — `SetDesktopSubagentModel` (:55), `SetDesktopSubagentEffort` (:94)
- `internal/provider/disabled.go` — `SetDisabledModels` (:214, via `LoadChecked`)
- `internal/provider/fastpick.go` — `SetFastTier` (:132)
- `internal/provider/group.go` — `renameGroupPicks` (:1642)
- `internal/provider/modelkind.go` — `setModelKind` (:123)
- `internal/provider/modellist.go` — `SetModelLists` (:64)
- `internal/provider/modelprefs.go` — `SetModelPrice` (:159), `DropModelPrice` (:232), `setModelEfforts` (:291), `setModelReasonless` (:329), `setModelImage` (:406), `setModelAPI` (:455), `setModelSame` (:619), `SetSuffixMode` (:787), `SetCodexAgentsV1` (:802), `SetCodexAutoReview` (:818), `SetCodexAsyncCompact` (:837), `SetFullContext` (:852), `SetUpstreamName` (:1154), `DropUpstreamName` (:1188)
- `internal/provider/models.go` — `SetModelOutput` (:2740), `SetModelOutputs` (:2802), `DropModelOutput` (:2841)
- `internal/provider/rename.go` — `Rename` (:118)
- `internal/provider/visible.go` — `SetOnlyPicked` (:171), `SetPickedModels` (:212), `SetHiddenModels` (:259), `SetOwnModelsHidden` (:289), `SetModelOrder` (:342)
- `internal/tui/pages.go` — `updateUsage` (:1041)

(`internal/backup`'s `Restore` and `internal/gui/port.go`'s rollback deserve a look before moving: they save a snapshot on purpose — a backup's contents, or the port going back — and `Update` still serves them, but the reviewers may prefer they stay explicit.)

## Not verified

Cross-process lost update. `fileMu` is in-process only, so the CLI (`magpie model ...`, `magpie provider ...`) writing while a gateway or the app is running can still drop a change, and nothing here fixes that. The reporter's point stands; a lock file beside `settings.json`, taken inside `Update`, would be the direction, and it is not tried in this change.

**AI**: written with an AI coding agent; I've read the whole diff and can answer questions on it myself. The model name is in the commit's trailer.

**Attribution**: If you apply the patch, please keep its author (ggbdpq) or add a `Co-authored-by: ggbdpq <ggbdpq@gmail.com>` line.

<details><summary>patch — applies with `git am` (format-patch of ffbddc4e14a91d86818d7471a164e12d1bc221c8)</summary>

```patch
From ffbddc4e14a91d86818d7471a164e12d1bc221c8 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Mon, 19 Oct 2026 06:50:15 +0800
Subject: [PATCH] settings: a settings update holds the file's lock across read
 and write (#2813)

A setter that reads, changes and writes the whole file did so without
holding the lock across the three steps: s := settings.Load(), change
one field, settings.Save(s). Load and Save each take settings' fileMu
on their own, so two setters that ran at once each saved their own
snapshot, and the second write dropped the first one's change. The one
setter already correct was SetGatewayConversations, which holds fileMu
across load, the change, and save.

settings.Update is that shape, for every setter: fn is handed what the
file holds now, and what fn leaves is what is saved. fn's error leaves
the file as it was, and like any save but the consent one, recording
consent is kept. The three setters the report names move onto it:
SetCodexCredits, setCodexAutoReset and setModelName. The no-op path of
setModelName (a name set to what it already was) now writes the file's
own contents back instead of leaving it untouched; what is written is
what the file holds, so nothing else changes.

Fifty-five more Load-then-Save sites in thirty files follow the same
shape (access, backup, cli, gui, provider, tui) and are left as they
are: this fix is the reported repro and the helper, so the rest are
mechanical follow-ups if the direction is accepted.

Test: TestSetCodexCreditsConcurrentKeepsBothAccounts, 100 rounds of two
SetCodexCredits calls at once, one account each. On base 1a3b9268 it
failed 5 of 5 runs, each run losing 98 to 100 of its 100 rounds; with
the fix it passed -count=20 and -race -count=1. The settings and
provider suites pass (-tags nogui -count=1), gofmt -l is empty, go vet
-tags nogui is clean on darwin, linux and windows, and go build -tags
nogui ./... goes through on darwin and linux, GOOS=windows on the main
package too.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/provider/codex_autoreset.go          | 35 ++++++-------
 internal/provider/codex_credits.go            | 13 ++---
 .../provider/codex_credits_concurrent_test.go | 50 +++++++++++++++++++
 internal/provider/modelprefs.go               | 29 ++++++-----
 internal/settings/settings.go                 | 17 +++++++
 5 files changed, 108 insertions(+), 36 deletions(-)
 create mode 100644 internal/provider/codex_credits_concurrent_test.go

diff --git a/internal/provider/codex_autoreset.go b/internal/provider/codex_autoreset.go
index cccc9c6e..960e1ca9 100644
--- a/internal/provider/codex_autoreset.go
+++ b/internal/provider/codex_autoreset.go
@@ -121,25 +121,26 @@ func SetCodexAutoResetCase(user, when string, on bool) error {
 
 func setCodexAutoReset(user string, week, expiring bool) error {
 	user = strings.ToLower(strings.TrimSpace(user))
-	s := settings.Load()
-	s.CodexAutoReset = slices.DeleteFunc(slices.Clone(s.CodexAutoReset), func(u string) bool { return u == user })
-	only := map[string]string{}
-	for u, c := range s.CodexAutoResetOnly {
-		if u != user {
-			only[u] = c
+	return settings.Update(func(s *settings.Settings) error {
+		s.CodexAutoReset = slices.DeleteFunc(slices.Clone(s.CodexAutoReset), func(u string) bool { return u == user })
+		only := map[string]string{}
+		for u, c := range s.CodexAutoResetOnly {
+			if u != user {
+				only[u] = c
+			}
 		}
-	}
-	if user != "" && (week || expiring) {
-		s.CodexAutoReset = append(s.CodexAutoReset, user)
-		switch {
-		case !expiring:
-			only[user] = ResetCaseWeek
-		case !week:
-			only[user] = ResetCaseExpiring
+		if user != "" && (week || expiring) {
+			s.CodexAutoReset = append(s.CodexAutoReset, user)
+			switch {
+			case !expiring:
+				only[user] = ResetCaseWeek
+			case !week:
+				only[user] = ResetCaseExpiring
+			}
 		}
-	}
-	s.CodexAutoResetOnly = only
-	return settings.Save(s)
+		s.CodexAutoResetOnly = only
+		return nil
+	})
 }
 
 var autoReset = autoResets{file: "codex-autoreset.json"}
diff --git a/internal/provider/codex_credits.go b/internal/provider/codex_credits.go
index b3cdc46e..3ab14faa 100644
--- a/internal/provider/codex_credits.go
+++ b/internal/provider/codex_credits.go
@@ -35,12 +35,13 @@ func CodexCredits(user string) bool {
 // SetCodexCredits turns that on or off for user.
 func SetCodexCredits(user string, on bool) error {
 	user = accountKey(user)
-	s := settings.Load()
-	s.CodexNoCredits = slices.DeleteFunc(s.CodexNoCredits, func(u string) bool { return u == user })
-	if !on && user != "" {
-		s.CodexNoCredits = append(s.CodexNoCredits, user)
-	}
-	return settings.Save(s)
+	return settings.Update(func(s *settings.Settings) error {
+		s.CodexNoCredits = slices.DeleteFunc(s.CodexNoCredits, func(u string) bool { return u == user })
+		if !on && user != "" {
+			s.CodexNoCredits = append(s.CodexNoCredits, user)
+		}
+		return nil
+	})
 }
 
 // HoldCaps is the shares of its windows at which routing holds the
diff --git a/internal/provider/codex_credits_concurrent_test.go b/internal/provider/codex_credits_concurrent_test.go
new file mode 100644
index 00000000..f07f38fa
--- /dev/null
+++ b/internal/provider/codex_credits_concurrent_test.go
@@ -0,0 +1,50 @@
+package provider
+
+import (
+	"errors"
+	"fmt"
+	"slices"
+	"sync"
+	"testing"
+
+	"github.com/yetone/magpie/internal/settings"
+)
+
+// Two setters that run at once each saved their own snapshot: Load and Save
+// take settings' file lock on their own, so the second write dropped the
+// first one's change (#2813). Round after round, each of two accounts turned
+// off together must still be kept.
+func TestSetCodexCreditsConcurrentKeepsBothAccounts(t *testing.T) {
+	signIn(t)
+	const rounds = 100
+	lost := 0
+	for i := range rounds {
+		a, b := fmt.Sprintf("a%d@example.com", i), fmt.Sprintf("b%d@example.com", i)
+		start := make(chan struct{})
+		var wg sync.WaitGroup
+		var errs []error
+		var mu sync.Mutex
+		for _, u := range []string{a, b} {
+			wg.Go(func() {
+				<-start
+				if err := SetCodexCredits(u, false); err != nil {
+					mu.Lock()
+					errs = append(errs, err)
+					mu.Unlock()
+				}
+			})
+		}
+		close(start)
+		wg.Wait()
+		if len(errs) != 0 {
+			t.Fatal(errors.Join(errs...))
+		}
+		got := settings.Load().CodexNoCredits
+		if !slices.Contains(got, a) || !slices.Contains(got, b) {
+			lost++
+		}
+	}
+	if lost != 0 {
+		t.Fatalf("%d of %d rounds lost an update", lost, rounds)
+	}
+}
diff --git a/internal/provider/modelprefs.go b/internal/provider/modelprefs.go
index 5b4120b5..ef1fb0ca 100644
--- a/internal/provider/modelprefs.go
+++ b/internal/provider/modelprefs.go
@@ -87,23 +87,26 @@ func setModelName(ref, name string) (bool, error) {
 	if name != "" && !p.serves(model) {
 		return false, fmt.Errorf("%s has no model %s (magpie provider %s lists them)", p.ID, model, p.ID)
 	}
-	s := settings.Load()
 	key := p.ID + "/" + model
-	if s.ModelNames[key] == name {
-		return false, nil
-	}
-	if name == "" {
-		delete(s.ModelNames, key)
-	} else {
-		if s.ModelNames == nil {
-			s.ModelNames = map[string]string{}
+	changed := false
+	if err := settings.Update(func(s *settings.Settings) error {
+		if s.ModelNames[key] == name {
+			return nil
 		}
-		s.ModelNames[key] = name
-	}
-	if err := settings.Save(s); err != nil {
+		if name == "" {
+			delete(s.ModelNames, key)
+		} else {
+			if s.ModelNames == nil {
+				s.ModelNames = map[string]string{}
+			}
+			s.ModelNames[key] = name
+		}
+		changed = true
+		return nil
+	}); err != nil {
 		return false, err
 	}
-	return true, nil
+	return changed, nil
 }
 
 // SetModelPrice is what a provider's model costs the user, in USD per million
diff --git a/internal/settings/settings.go b/internal/settings/settings.go
index c94e91fa..75232ded 100644
--- a/internal/settings/settings.go
+++ b/internal/settings/settings.go
@@ -1164,6 +1164,23 @@ func Save(s Settings) error {
 	return save(s, false)
 }
 
+// Update changes the settings under the file's lock: fn is handed what the
+// file holds now, and what fn leaves is what is saved. Load and Save each
+// take the lock on their own, so a setter that loads a snapshot, changes it
+// and saves it drops whatever another setter wrote in between (#2813); a
+// setter that reads, changes and writes the whole file goes through this,
+// the way SetGatewayConversations does. fn's error leaves the file as it
+// was, and like any save but the consent one, recording consent is kept.
+func Update(fn func(*Settings) error) error {
+	fileMu.Lock()
+	defer fileMu.Unlock()
+	s := load()
+	if err := fn(&s); err != nil {
+		return err
+	}
+	return save(s, false)
+}
+
 // SetGatewayConversations changes local recording consent without overwriting
 // other settings from an earlier snapshot.
 func SetGatewayConversations(on bool) error {
-- 
2.50.1 (Apple Git-155)

```

</details>
