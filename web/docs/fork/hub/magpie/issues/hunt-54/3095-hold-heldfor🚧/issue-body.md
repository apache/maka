## Summary

`TestHoldReadsMigrationsOnce` measured wall time instead of the hold: on a loaded machine its two reads of migrations.json landed more than `heldFor` (1s, hold.go:108) apart, the held copy expired, the file was read again, and the test died on `hold_test.go:316: migrations.json read again while held`. The fix raises `heldFor` for the test's duration, exactly as its two sibling tests in the same file already do. Test-only, two lines; the production hold is untouched.

## Cause

Inside a hold, `Moved` is served by `heldOf("migrations", ...)` (migrate.go:364), which reuses the held copy only while `time.Since(h.at) < heldFor` (hold.go:189). The test reads `Moved("held-sub")`, writes migrations.json raw (standing for another process's write), then expects `Moved("other-sub")` to come from the held copy. A raw write to migrations.json is not one of the stat'ed roots (hold.go:62 stats only the providers' and the settings' files), so expiry of the held copy is the only way the file is read again mid-hold — and under load 25–57 the 2.70s the test took says the second read came more than a second after the first. The held copy expired, the rebuild saw the raw write, `Moved("other-sub")` returned true.

## Fix

Raise `heldFor` to a minute for the test's duration with the established in-file pattern (`defer` restore + assign), as `TestHoldKeptForTheNextRequest` (hold_test.go:56-57) and `TestHoldKeptUntilAWrite` (hold_test.go:95-96) — both added with the hold itself in ed3a46d0 — already do; this test, added later in 2a4042a9, is the only one of the family left without it. `heldFor` is a package-level `var`, so no product code changes and the production value stays 1s.

Of the maintainer's two directions, counting reads was not taken: a read count does not decouple the test from the wall clock — when the held copy expires under load the count becomes 2 and the test still fails — so it would have to be combined with a raised `heldFor` anyway, and then it adds nothing the value assertion doesn't already say. The guard is the raised hold itself: the two reads are adjacent statements, and a minute cannot pass between them on any machine, so no artificial delay is committed (a committed `time.Sleep` would be meaningless with a minute hold — it could no longer fail on the old form — and would only slow every run; the delay stays in the verification below instead).

## Verification

| Check | Command | Result |
|---|---|---|
| Baseline, alone | `go test ./internal/provider -run TestHoldReadsMigrationsOnce -count=1` | ok (0.03s) |
| Red by injection, before the fix | same test with `time.Sleep(1200*time.Millisecond)` between the two reads | FAIL: `migrations.json read again while held` |
| Fix, injection still in | same injection, `-count=5` | ok, 5 of 5 (each 1.2s: the pause runs, the hold doesn't expire) |
| Fix as committed | `-count=10` | ok |
| Fix as committed, race detector | `-race -count=2` | ok, no races |
| Full package | `go test ./internal/provider/... -count=1 -timeout 20m` | ok 80.1s |
| gofmt | `gofmt -l internal/provider/` | empty |
| go vet | `go vet ./internal/provider/...` | ok |
| Builds | darwin/arm64; linux/amd64 `-tags nogui`; windows/amd64 | ok |

## Not verified

Not rerun under the maintainer's load (load average 25–57); the mechanism is shown by the injected 1.2s pause, which fails deterministically on the old form. An optional `yes`-driven load simulation was not run. `TestHoldReadsSettingsOnce` and `TestHoldBuildsProvidersOnce` share the same exposure but are not named in the issue and did not fail in the reported run, so they are left as they are.

---
**Source**: the maintainer's full-suite run in #3095 (load 25–57); the mechanism is confirmed by injecting a delay between the two reads, as the issue suggests, not by rerunning.

**Red without the fix** (base `c922225f`): with the test's fix reverted and a 1.2s delay injected between the reads, `go test ./internal/provider -run TestHoldReadsMigrationsOnce` fails:
```
=== RUN   TestHoldReadsMigrationsOnce
    hold_test.go:317: migrations.json read again while held
--- FAIL: TestHoldReadsMigrationsOnce (1.20s)
FAIL
FAIL	github.com/yetone/magpie/internal/provider	1.430s
```
(The injected line moves the assertion from :316 to :317; same assertion.) With the fix: `ok`.

**Siblings**: already guarded with a raised `heldFor` — `TestHoldKeptForTheNextRequest` and `TestHoldKeptUntilAWrite` (a minute, hold_test.go:56-57 and :95-96) and the held-groups test (an hour, group_held_test.go:289-290); this fix adds `TestHoldReadsMigrationsOnce` to them. Left, same exposure but not named here: `TestHoldReadsSettingsOnce` (same shape, a raw settings.json write between two held reads) and `TestHoldBuildsProvidersOnce` (counts exactly one build across two `All` calls). Left, not exposed: `TestHoldBuildsOnce`, `TestHeldGoesWithAPluginChange`, `TestHoldSeesWrites`, `TestHeldGroupsAreTheCallers` (their assertions welcome a rebuild), `TestAllReadsNoSettingsPerLookWhileHeld` (its budget already allows one rebuild: "the held catalog is kept 1s"), `TestCursorKeychainReadOnce` (its own memo, not `heldFor`).

**When the read fails**: when the hold expires the file is read again and a raw write that landed mid-hold becomes visible before the hold ends — that rebuild is the hold working as designed (`heldOf` reuses a copy only within `heldFor`), so the red was the assertion tripping on wall-clock noise, not a product fault.

**Not verified**: the maintainer's load 25–57 was not reproduced on real hardware (shown by injection instead); `yes`-driven load simulation not run; the two same-shaped siblings above not changed.

Branch with the commit: [hunt54-c-hold-heldfor](https://github.com/ggbdpq/magpie/tree/hunt54-c-hold-heldfor) (head `de90e3ea`).

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

**Patch**: <details><summary>patch: provider: TestHoldReadsMigrationsOnce holds past the wall clock (#3095) — git am applies it as is; SHA-256 first 16: 7589b02dff15dad4</summary>

```patch
From de90e3eaf61693d5432583f38e2d183aecb335f1 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 21 Oct 2026 05:01:11 +0800
Subject: [PATCH] provider: TestHoldReadsMigrationsOnce holds past the wall
 clock (#3095)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

The test went red in a full-suite run on a loaded machine (load average
25 to 57): its two reads of migrations.json were more than heldFor (1s)
apart, the held copy expired, the file was read again, and the move
written between the reads was seen mid-hold — "migrations.json read
again while held". The test measures wall time rather than the hold.

Raise heldFor for the test's duration, as its two siblings in this file
(TestHoldKeptForTheNextRequest, TestHoldKeptUntilAWrite) already do: a
loaded machine's pause between the reads isn't the change the test
looks for. The production heldFor is untouched.

Confirmed by injecting a 1.2s pause between the two reads: the test
fails on the old form and passes with the fix, pause still in.

Fixes #3095

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/provider/hold_test.go | 2 ++
 1 file changed, 2 insertions(+)

diff --git a/internal/provider/hold_test.go b/internal/provider/hold_test.go
index 6b5c415e..55426a04 100644
--- a/internal/provider/hold_test.go
+++ b/internal/provider/hold_test.go
@@ -305,6 +305,8 @@ func TestCursorKeychainReadOnce(t *testing.T) {
 // and a move written meanwhile, even one read from the file as it was
 // before, is seen at once.
 func TestHoldReadsMigrationsOnce(t *testing.T) {
+	defer func(d time.Duration) { heldFor = d }(heldFor)
+	heldFor = time.Minute                    // a loaded machine's pause between reads isn't the change
 	t.Setenv("XDG_CONFIG_HOME", t.TempDir()) // a run starts from no files, not the last run's
 	defer Hold()()
 	if Moved("held-sub") {
-- 
2.50.1 (Apple Git-155)

```

</details>
