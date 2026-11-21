Thank you for the three checks, and for re-running the guard on Windows — all three are addressed in this revision.

**1. The unchanged model-name path.** You are right, and "changes the error contract, not just the number of writes" is exactly what the first version did: the same-name check moved inside `Update`, but returning nil from the callback still reached save, so a no-op came back as the write's error. The callback now returns a sentinel, `settings.ErrUnchanged`, and `Update` answers it by skipping the save and returning nil: nothing is written when nothing changed, and callers that do change something are unaffected (none of them returns the sentinel, so their path through `Update` is byte for byte what it was). `setModelName`'s same-name path is a true no-op again. Guard: `TestSetModelNameUnchangedStaysNoOp` — a/sol set to its own name on a read-only settings.json: on the first version it failed with `permission denied`; now it returns nil with changed=false and the file byte-identical, and a real name change on the same file still writes once the file is writable again.

**2. SetCodexAutoResetCase reading week/expiring before the transaction.** Agreed — an existing defect the migration walked straight past, as you say. The case it keeps is now read inside the same update: `SetCodexAutoResetCase` validates `when`, then computes both flags from the `*Settings` the callback is handed (`codexAutoResetWhenOf`, the same answer `CodexAutoResetWhen` gives from a fresh `Load`), so the second of two racing calls always reads what the first saved. Guard: `TestSetCodexAutoResetCaseConcurrentKeepsBothCases` — one account, both cases initially off, two goroutines each turn one case on, 100 rounds: on the first version it lost a case in 98 to 100 of 100 rounds, 5 of 5 runs red (your 100/100 on both parent and patch matches); with the fix, 0 of 100, also under -race.

**3. Update dropping a failed-read error.** Agreed too — the other existing weakness the migration inherited from `load()`. `Update` now reads with `loadChecked` and stops before the callback on a read error, the shape `EditCheckinOff` already has in that file. Guard: `TestUpdateRefusesUnreadableSettings` — a settings.json holding a real theme, a synthetic token and an allow list, made unreadable for the call (permissions put back inside the callback, the same window your handle probe opened): the first version ran the callback and saved the defaults plus the requested change over the real file, returning nil; now it returns the read error before the callback runs, and the file is byte-identical after.

## Source & environment

This is the revised patch of the transactional update posted above (fork branch `hunt45-a-settings-update`, commit ffbddc4e, based on upstream `1a3b9268`), reworked per your three points and replayed onto current upstream `main` at `f5b0157420a4491f6e707b49a8af8e87ea8050a1`. Between the two baselines the settings area moved (9329c89c added the parse-once memo and `Shared()`, 28bec150 and c627652e changed lightweight mode, and `fileMu` became a RWMutex); the original patch applied onto the new base with no conflict, its semantics held, and the review's fixes are one further commit on top of it — one commit total, `git am` applies it as is. Everything below ran on darwin/arm64, Go 1.26 (`-tags nogui` throughout, as the repo standard goes).

## Reproduction

- Point 1: set a/sol to the name it already has, make settings.json read-only, call the setter. First version: `permission denied` with changed=false; parent: nil. Test `TestSetModelNameUnchangedStaysNoOp` red on the first version:
  ```
  --- FAIL: TestSetModelNameUnchangedStaysNoOp (0.76s)
      modelprefs_noop_test.go:33: setting the same name on a read-only settings file: open .../.config/magpie/settings.json: permission denied
  ```
- Point 2: one account with both cases off, two goroutines turn one case on each, 100 rounds. Test `TestSetCodexAutoResetCaseConcurrentKeepsBothCases` red on the first version, 5 of 5 runs:
  ```
  --- FAIL: TestSetCodexAutoResetCaseConcurrentKeepsBothCases (1.86s)
      codex_autoreset_concurrent_test.go:45: 100 of 100 rounds lost a case
  --- FAIL: TestSetCodexAutoResetCaseConcurrentKeepsBothCases (1.91s)
      codex_autoreset_concurrent_test.go:45: 98 of 100 rounds lost a case
  --- FAIL: TestSetCodexAutoResetCaseConcurrentKeepsBothCases (1.83s)
      codex_autoreset_concurrent_test.go:45: 99 of 100 rounds lost a case
  --- FAIL: TestSetCodexAutoResetCaseConcurrentKeepsBothCases (1.79s)
      codex_autoreset_concurrent_test.go:45: 100 of 100 rounds lost a case
  --- FAIL: TestSetCodexAutoResetCaseConcurrentKeepsBothCases (1.78s)
      codex_autoreset_concurrent_test.go:45: 99 of 100 rounds lost a case
  ```
- Point 3: settings.json made unreadable, permissions restored inside the callback so the save can go through. Test `TestUpdateRefusesUnreadableSettings` red on the first version:
  ```
  --- FAIL: TestUpdateRefusesUnreadableSettings (0.02s)
      update_test.go:45: the callback ran on a file that could not be read
      update_test.go:48: Update saved over settings it could not read, and said nothing
  ```

## Root cause

- Point 1: `fn` returning nil still falls through to `save(s, false)` in `Update`; whether the callback changed anything is not something `Update` can see, so the no-op path paid for a write it did not need.
- Point 2: `SetCodexAutoResetCase` computed `week, expiring` from a `Load` of its own and passed both into the update; two calls at once for the same account each read "both off", each saved its own case alone, and the second write dropped the first case — the update held the lock around the write, but the decision was made before it.
- Point 3: `load()` is `loadChecked` with the error discarded; on a failed read it hands the callback the defaults, and whatever `fn` leaves is then saved over a file whose contents were never known.

## Fix

- `internal/settings/settings.go` — `Update` reads with `loadChecked` and returns the error before `fn` runs; `fn` may return `ErrUnchanged` (new), which makes `Update` skip the save and return nil. Everything else about `Update` is as posted: `fileMu` held across read, change and save; `fn`'s error leaves the file as it was; and like any save but the consent one, recording consent is kept (`save(s, false)` — a generic update still cannot turn `GatewayConversations` on).
- `internal/provider/modelprefs.go` — `setModelName`'s same-name path returns `settings.ErrUnchanged` from the callback, so it writes nothing and returns nil, changed=false.
- `internal/provider/codex_autoreset.go` — `CodexAutoResetWhen`'s answer comes from a from-settings helper (`codexAutoResetWhenOf`); `SetCodexAutoResetCase` calls it inside the update on the `*Settings` in hand, applies its one case, and the shared mutation body is `keepCodexAutoReset`. `SetCodexAutoReset` (both times at once) is unchanged in behavior.
- `internal/provider/codex_credits.go` — as posted: `SetCodexCredits` mutates inside `Update`.
- Guards: `internal/provider/modelprefs_noop_test.go`, `internal/provider/codex_autoreset_concurrent_test.go`, `internal/settings/update_test.go`, plus the first version's `codex_credits_concurrent_test.go`.

## Verification

| Check | Command | Result |
|---|---|---|
| Guards, green (final head) | `go test -tags nogui -count=5 -run 'TestSetModelNameUnchangedStaysNoOp|TestSetCodexAutoResetCaseConcurrentKeepsBothCases|TestUpdateRefusesUnreadableSettings|TestSetCodexCreditsConcurrentKeepsBothAccounts' ./internal/provider/ ./internal/settings/` | ok, both packages, exit 0 |
| Guards under race | same with `-race -count=2` | ok, both packages, exit 0 |
| Point 1 red on the first version | `go test -tags nogui -count=1 -run 'TestSetModelNameUnchangedStaysNoOp' ./internal/provider/` | FAIL, `permission denied` (excerpt above) |
| Point 2 red on the first version | `go test -tags nogui -count=5 -run 'TestSetCodexAutoResetCaseConcurrentKeepsBothCases' ./internal/provider/` | FAIL 5/5, 98-100 of 100 rounds lost a case (excerpts above) |
| Point 3 red on the first version | `go test -tags nogui -count=1 -run 'TestUpdateRefusesUnreadableSettings' ./internal/settings/` | FAIL, callback ran and save said nothing (excerpt above) |
| Ablation, point 1 alone removed (2 and 3 kept) | point 1's command | FAIL, `permission denied`; fix restored, green |
| Ablation, point 2 alone removed (1 and 3 kept) | point 2's command, `-count=2` | FAIL, 100 and 98 of 100 rounds lost a case; fix restored, green |
| Ablation, point 3 alone removed (1 and 2 kept) | point 3's command | FAIL, callback ran and save said nothing; fix restored, green |
| Ablation, all three removed (the first version's files) | all three guard commands in one run | all three FAIL (97 of 100 rounds; `permission denied`; callback ran); restored, green |
| Credits setter re-broken to Load/Save (test sensitivity) | `go test -tags nogui -count=2 -run 'TestSetCodexCreditsConcurrentKeepsBothAccounts' ./internal/provider/` | FAIL 2/2, 98 of 100 rounds lost an update; restored, green |
| settings suite | `go test -tags nogui -count=1 ./internal/settings/` | ok, 25.9s, exit 0 |
| provider suite (full) | `go test -tags nogui -count=1 ./internal/provider/` | ok, 80.1s, exit 0 |
| gofmt | `gofmt -l internal/settings/ internal/provider/` | empty |
| go vet | `go vet -tags nogui ./internal/settings/ ./internal/provider/`, then `GOOS=linux` and `GOOS=windows` again | clean, exit 0 on all three |
| build | `go build -tags nogui ./...` (darwin, linux); `GOOS=windows go build -o /dev/null .` | all exit 0; the pre-existing cgo warning in `internal/gui/trayimage_darwin.go:112` (a file this change does not touch) is the only output on darwin |
| patch applies | `git apply --check` of the format-patch against `f5b01574` | clean |

## Not verified

- Windows and Linux runs of the new guards: the verification above is darwin/arm64 only. `TestUpdateRefusesUnreadableSettings` skips on Windows (as `TestSaveKeepsUnreadableSettings` already does) — your handle-based read-denial probe is the Windows shape of it, and it is not added to the suite here. `TestSetModelNameUnchangedStaysNoOp` does not skip on Windows (chmod 0o444 is the read-only attribute there) but has not been run on one.
- A full-repository suite: on darwin the provider suite passes whole (80.1s), so the nine pre-existing Windows failures you saw did not reproduce here; nothing beyond the two touched packages was run.
- Cross-process lost update and the remaining snapshot writers (the 52 functions in 28 files listed in the first version's Siblings section) are untouched, as you say — this issue should stay open for that scope. Among the paths that now go through `Update`, the only callers are `SetCodexCredits`, `setCodexAutoReset`, `SetCodexAutoResetCase` and `setModelName`, and none of the others feeds the callback anything read from settings outside it; `setModelName`'s `serves` check reads the provider catalog, not settings.json, before the update, as it did on the parent.

This repository takes changes from collaborators only and does not accept pull requests from outside, so the patch keeps the form the first one had: a fork branch plus the format-patch below for `git am`, authorship unchanged.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: settings: a settings update holds the file's lock across read and write (#2813) — git am applies it as is; SHA-256 first 16: f3f53b0b351a84a1</summary>
```
From 7f8c8d4e97fd08f3db8eb262d969bb9be8fc9787 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Mon, 19 Oct 2026 06:50:15 +0800
Subject: [PATCH] settings: a settings update holds the file's lock across read
 and write (#2813)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

A setter that reads, changes and writes the whole file did so without
holding the lock across the three steps: s := settings.Load(), change
one field, settings.Save(s). Load and Save each take settings' fileMu
on their own, so two setters that ran at once each saved their own
snapshot, and the second write dropped the first one's change.

What changed

settings.Update holds fileMu across load, the change, and save — the
shape of the one setter that was already correct,
SetGatewayConversations. fn's error leaves the file as it was, and
like any save but the consent one, recording consent is kept. The
three setters the report names move onto it: SetCodexCredits,
setCodexAutoReset and setModelName.

Three cases from the patch's review, on top of its first version:

- An update that finds the file already as wanted writes nothing:
  fn returns ErrUnchanged, and Update skips the save and returns nil.
  setModelName's same-name path is that no-op again — on a read-only
  settings.json it returns nil, not the write's permission error.
- SetCodexAutoResetCase reads the case it keeps inside the update's
  lock: read before it, two calls that each turned one case on for
  the same account, at once, each saved the account with its own
  case alone, and the second lost the first.
- Update reads the file checked (loadChecked): a settings.json that
  cannot be read is unknown, never empty, and the update stops
  before fn instead of saving the defaults plus the asked-for change
  over the real one.

This revision sits on current main (f5b01574), where settings.go grew
a parse-once memo and Shared(); the patch carries over as it was
written there, with no conflict.

Run

TestSetCodexCreditsConcurrentKeepsBothAccounts (100 rounds of two
SetCodexCredits calls at once, one account each) passed -count=20 and
-race on the patch's first version, and passes -count=5 and
-race -count=2 here. The review's guards, each red before its fix and
green after:

- TestSetModelNameUnchangedStaysNoOp: on the first version, setting
  a/sol to its name on a read-only settings.json answered "permission
  denied"; now nil, the file byte for byte as it was, changed=false.
- TestSetCodexAutoResetCaseConcurrentKeepsBothCases: on the first
  version, 98 to 100 of 100 rounds lost a case, 5 of 5 runs; now 0,
  also under -race.
- TestUpdateRefusesUnreadableSettings: on the first version, Update
  ran the callback on an unreadable settings.json and saved the
  defaults plus the change over it, returning nil; now it stops
  before the callback with the read error, the file untouched.

Each of the three fixes, removed on its own with the other two kept,
turns its test red again; with all three removed they are red
together, and restored, green.

The settings and provider suites pass (-tags nogui -count=1), gofmt
-l is empty, go vet -tags nogui is clean on darwin, linux and
windows, and go build -tags nogui ./... goes through on darwin and
linux, GOOS=windows on the main package too.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/provider/codex_autoreset.go          | 44 +++++++++++----
 .../codex_autoreset_concurrent_test.go        | 47 ++++++++++++++++
 internal/provider/codex_credits.go            | 13 +++--
 .../provider/codex_credits_concurrent_test.go | 50 +++++++++++++++++
 internal/provider/modelprefs.go               | 29 +++++-----
 internal/provider/modelprefs_noop_test.go     | 52 +++++++++++++++++
 internal/settings/settings.go                 | 34 +++++++++++
 internal/settings/update_test.go              | 56 +++++++++++++++++++
 8 files changed, 296 insertions(+), 29 deletions(-)
 create mode 100644 internal/provider/codex_autoreset_concurrent_test.go
 create mode 100644 internal/provider/codex_credits_concurrent_test.go
 create mode 100644 internal/provider/modelprefs_noop_test.go
 create mode 100644 internal/settings/update_test.go

diff --git a/internal/provider/codex_autoreset.go b/internal/provider/codex_autoreset.go
index cccc9c6e..546fdaa6 100644
--- a/internal/provider/codex_autoreset.go
+++ b/internal/provider/codex_autoreset.go
@@ -38,8 +38,15 @@ const (
 // CodexAutoResetWhen says at which of those times the Codex account user
 // spends a reset by itself: both unless the user kept it to one.
 func CodexAutoResetWhen(user string) (week, expiring bool) {
-	user = strings.ToLower(user)
 	s := settings.Load()
+	return codexAutoResetWhenOf(&s, user)
+}
+
+// codexAutoResetWhenOf is CodexAutoResetWhen for settings already in hand:
+// the same answer from s, so a setter reads the time it keeps inside the
+// update that writes it.
+func codexAutoResetWhenOf(s *settings.Settings, user string) (week, expiring bool) {
+	user = strings.ToLower(user)
 	if user == "" || !slices.Contains(s.CodexAutoReset, user) {
 		return false, false
 	}
@@ -105,23 +112,40 @@ func SetCodexAutoReset(user string, on bool) error {
 }
 
 // SetCodexAutoResetCase turns one of the two times (ResetCaseWeek or
-// ResetCaseExpiring) on or off for user, the other kept as it is.
+// ResetCaseExpiring) on or off for user, the other kept as it is. The other
+// time is read inside the update's lock: read before it, two calls that
+// each turned one time on for the same account, at once, each saved the
+// account with its own time alone, and the second lost the first (#2813).
 func SetCodexAutoResetCase(user, when string, on bool) error {
-	week, expiring := CodexAutoResetWhen(strings.TrimSpace(user))
 	switch when {
-	case ResetCaseWeek:
-		week = on
-	case ResetCaseExpiring:
-		expiring = on
+	case ResetCaseWeek, ResetCaseExpiring:
 	default:
 		return fmt.Errorf("a reset is used by itself when the week runs out (%s) or before one expires (%s), not %q", ResetCaseWeek, ResetCaseExpiring, when)
 	}
-	return setCodexAutoReset(user, week, expiring)
+	user = strings.ToLower(strings.TrimSpace(user))
+	return settings.Update(func(s *settings.Settings) error {
+		week, expiring := codexAutoResetWhenOf(s, user)
+		switch when {
+		case ResetCaseWeek:
+			week = on
+		case ResetCaseExpiring:
+			expiring = on
+		}
+		return keepCodexAutoReset(s, user, week, expiring)
+	})
 }
 
 func setCodexAutoReset(user string, week, expiring bool) error {
 	user = strings.ToLower(strings.TrimSpace(user))
-	s := settings.Load()
+	return settings.Update(func(s *settings.Settings) error {
+		return keepCodexAutoReset(s, user, week, expiring)
+	})
+}
+
+// keepCodexAutoReset leaves user spending its reset at the times week and
+// expiring say, in the settings an update holds: the account is kept with
+// the one time the user left it to, or with both when kept to neither.
+func keepCodexAutoReset(s *settings.Settings, user string, week, expiring bool) error {
 	s.CodexAutoReset = slices.DeleteFunc(slices.Clone(s.CodexAutoReset), func(u string) bool { return u == user })
 	only := map[string]string{}
 	for u, c := range s.CodexAutoResetOnly {
@@ -139,7 +163,7 @@ func setCodexAutoReset(user string, week, expiring bool) error {
 		}
 	}
 	s.CodexAutoResetOnly = only
-	return settings.Save(s)
+	return nil
 }
 
 var autoReset = autoResets{file: "codex-autoreset.json"}
diff --git a/internal/provider/codex_autoreset_concurrent_test.go b/internal/provider/codex_autoreset_concurrent_test.go
new file mode 100644
index 00000000..eb52b571
--- /dev/null
+++ b/internal/provider/codex_autoreset_concurrent_test.go
@@ -0,0 +1,47 @@
+package provider
+
+import (
+	"errors"
+	"fmt"
+	"sync"
+	"testing"
+)
+
+// The two times an account spends its reset at are set one by one, and
+// SetCodexAutoResetCase read the other time before the update's lock: two
+// calls that each turned one time on for the same account, at once, lost
+// one of them — each save was built from the flags as they read before
+// either call (#2813). Round after round, both must be kept.
+func TestSetCodexAutoResetCaseConcurrentKeepsBothCases(t *testing.T) {
+	signIn(t)
+	const rounds = 100
+	lost := 0
+	for i := range rounds {
+		u := fmt.Sprintf("both%d@example.com", i)
+		start := make(chan struct{})
+		var wg sync.WaitGroup
+		var errs []error
+		var mu sync.Mutex
+		for _, when := range []string{ResetCaseWeek, ResetCaseExpiring} {
+			wg.Go(func() {
+				<-start
+				if err := SetCodexAutoResetCase(u, when, true); err != nil {
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
+		if week, expiring := CodexAutoResetWhen(u); !week || !expiring {
+			lost++
+		}
+	}
+	if lost != 0 {
+		t.Fatalf("%d of %d rounds lost a case", lost, rounds)
+	}
+}
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
index ea04f648..a48ff412 100644
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
+			return settings.ErrUnchanged
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
diff --git a/internal/provider/modelprefs_noop_test.go b/internal/provider/modelprefs_noop_test.go
new file mode 100644
index 00000000..f8728260
--- /dev/null
+++ b/internal/provider/modelprefs_noop_test.go
@@ -0,0 +1,52 @@
+package provider
+
+import (
+	"bytes"
+	"os"
+	"testing"
+
+	"github.com/yetone/magpie/internal/settings"
+)
+
+// Setting a name to what it already is stays a no-op: nothing is written,
+// so a settings.json that cannot be written leaves the setter silent
+// (#2813 — the update path saved the file's own contents back, and a
+// read-only file answered permission denied where the parent said nil).
+func TestSetModelNameUnchangedStaysNoOp(t *testing.T) {
+	prefsHome(t)
+	if err := SetModelName("a/sol", "My Sol"); err != nil {
+		t.Fatal(err)
+	}
+	original, err := os.ReadFile(settings.Path())
+	if err != nil {
+		t.Fatal(err)
+	}
+	if err := os.Chmod(settings.Path(), 0o444); err != nil {
+		t.Fatal(err)
+	}
+	t.Cleanup(func() { os.Chmod(settings.Path(), 0o600) })
+	if _, err := os.OpenFile(settings.Path(), os.O_WRONLY, 0o600); err == nil {
+		t.Skip("this process can write a read-only settings file")
+	}
+	changed, err := setModelName("a/sol", "My Sol")
+	if err != nil {
+		t.Fatalf("setting the same name on a read-only settings file: %v", err)
+	}
+	if changed {
+		t.Error("setting the same name reported a change")
+	}
+	if after, err := os.ReadFile(settings.Path()); err != nil || !bytes.Equal(after, original) {
+		t.Errorf("the no-op changed the file: %v", err)
+	}
+	// an update that finds the file already as wanted is silent on a file
+	// that cannot be written, and one that changes it still is not
+	if err := os.Chmod(settings.Path(), 0o600); err != nil {
+		t.Fatal(err)
+	}
+	if _, err := setModelName("a/sol", "Other Sol"); err != nil {
+		t.Fatalf("setting a new name: %v", err)
+	}
+	if got := settings.Load().ModelNames["a/sol"]; got != "Other Sol" {
+		t.Fatalf("settings hold %q", got)
+	}
+}
diff --git a/internal/settings/settings.go b/internal/settings/settings.go
index 9fd09e1b..7cb582ff 100644
--- a/internal/settings/settings.go
+++ b/internal/settings/settings.go
@@ -10,6 +10,7 @@ package settings
 import (
 	"bytes"
 	"encoding/json"
+	"errors"
 	"fmt"
 	"math"
 	"net/url"
@@ -1283,6 +1284,39 @@ func Save(s Settings) error {
 	return save(s, false)
 }
 
+// ErrUnchanged is what an update's fn returns when it changed nothing:
+// Update then skips the save and returns nil, so an update that finds the
+// file already as wanted writes nothing — a settings file that cannot be
+// written is never asked about a change that did not happen.
+var ErrUnchanged = errors.New("settings: nothing changed")
+
+// Update changes the settings under the file's lock: fn is handed what the
+// file holds now, and what fn leaves is what is saved (fn returns
+// ErrUnchanged to say nothing changed, and nothing is written). The file is
+// read checked: one that cannot be read is unknown, never empty, and the
+// update stops before fn instead of saving the defaults over it. Load and
+// Save each take the lock on their own, so a setter that loads a snapshot,
+// changes it and saves it drops whatever another setter wrote in between
+// (#2813); a setter that reads, changes and writes the whole file goes
+// through this, the way SetGatewayConversations does. fn's error leaves the
+// file as it was, and like any save but the consent one, recording consent
+// is kept.
+func Update(fn func(*Settings) error) error {
+	fileMu.Lock()
+	defer fileMu.Unlock()
+	s, err := loadChecked()
+	if err != nil {
+		return err
+	}
+	if err := fn(&s); err != nil {
+		if errors.Is(err, ErrUnchanged) {
+			return nil
+		}
+		return err
+	}
+	return save(s, false)
+}
+
 // SetGatewayConversations changes local recording consent without overwriting
 // other settings from an earlier snapshot.
 func SetGatewayConversations(on bool) error {
diff --git a/internal/settings/update_test.go b/internal/settings/update_test.go
new file mode 100644
index 00000000..9b496e57
--- /dev/null
+++ b/internal/settings/update_test.go
@@ -0,0 +1,56 @@
+package settings
+
+import (
+	"bytes"
+	"errors"
+	"os"
+	"runtime"
+	"testing"
+)
+
+// An update reads the file checked: a settings.json that cannot be read is
+// unknown, never empty, and the update stops before its callback instead of
+// saving the defaults plus the asked-for change over the real one (#2813).
+func TestUpdateRefusesUnreadableSettings(t *testing.T) {
+	if runtime.GOOS == "windows" {
+		t.Skip("Windows read restrictions are covered by TestSaveKeepsReadBlockedSettings's handle shape")
+	}
+	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
+	if err := os.MkdirAll(Dir(), 0o755); err != nil {
+		t.Fatal(err)
+	}
+	original := []byte(`{"theme":"dark","githubToken":"SYNTHETIC_PRIVATE_TOKEN","allowIPs":["203.0.113.7"]}`)
+	if err := os.WriteFile(Path(), original, 0o600); err != nil {
+		t.Fatal(err)
+	}
+	if err := os.Chmod(Path(), 0o000); err != nil {
+		t.Fatal(err)
+	}
+	t.Cleanup(func() { os.Chmod(Path(), 0o600) })
+	if _, err := os.ReadFile(Path()); !errors.Is(err, os.ErrPermission) {
+		t.Skipf("this process can read an unreadable file: %v", err)
+	}
+	ran := false
+	err := Update(func(s *Settings) error {
+		// the read failed and the callback ran anyway: put the file back so
+		// the save goes through, which is how the real settings were lost
+		ran = true
+		if cerr := os.Chmod(Path(), 0o600); cerr != nil {
+			return cerr
+		}
+		s.NoAutoUpdate = true
+		return nil
+	})
+	if ran {
+		t.Error("the callback ran on a file that could not be read")
+	}
+	if err == nil {
+		t.Fatal("Update saved over settings it could not read, and said nothing")
+	}
+	if err := os.Chmod(Path(), 0o600); err != nil {
+		t.Fatal(err)
+	}
+	if after, err := os.ReadFile(Path()); err != nil || !bytes.Equal(after, original) {
+		t.Errorf("the unreadable settings were overwritten: %v", err)
+	}
+}
-- 
2.50.1 (Apple Git-155)

```

</details>

Branch with the commit: [hunt58-e-2813-settings-update](https://github.com/ggbdpq/magpie/tree/hunt58-e-2813-settings-update) (head `7f8c8d4e97fd08f3db8eb262d969bb9be8fc9787`).
