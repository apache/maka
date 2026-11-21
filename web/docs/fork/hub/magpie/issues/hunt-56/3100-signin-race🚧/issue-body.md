## Summary

`TestSignInDoneOnceTheAccountIsBack` swaps the global `catalog.Changed` in to watch a removed account come back, and the fakeco subtest's plugin work answers in the background: the answer tells the agents (`catalog.Touched`, through `plugin.tell`) in a goroutine that reads `catalog.Changed`. One of those goroutines was still running when the subtest wrote the global, and read it as it was written — a data race in 1 of 30 runs. The subtest now waits the plugin's background ask (`plugin.Refreshed`) and the telling it fires (`plugin.Told`) out before the hook is swapped in and before the cleanup swaps it back out. The test's own observations are unchanged, and nothing locks the global.

## Cause

- `internal/provider/hold.go:98` registers `catalog.Touched` as a plugin hook (`plugin.OnChange`, `plugin.OnListed`), package-level, for the whole test binary.
- A plugin's providers are asked in the background: `plugin.Cached` starts `refreshProvidersInBackground` (`internal/plugin/providers.go:649`); when the answer lands, `commitProviders` calls `listed` (`internal/plugin/providers.go:287`), which tells the hooks in goroutines (`internal/plugin/host.go:671`).
- Each told hook reads `catalog.Changed` (`internal/catalog/live.go:202`). The fakeco subtest installs the plugin, signs in, and then — a few lines later — writes `catalog.Changed` (`internal/provider/signin_removed_test.go:112`) while such a goroutine is still in flight. Nothing had waited the background ask out: the subtest's `t.Cleanup(plugin.Settle)` runs only at the very end, after the swap window, and the cleanup that restores the global ran before it.
- Reproduced with the subtest alone (`-run 'TestSignInDoneOnceTheAccountIsBack/fakeco'`), so the racing goroutine is the test's own plugin work, not another test's; the broken rule is the same one the maintainer named — what a test starts ends before what it observes, and here the swap window opened while the plugin's answer was still on its way.

## Fix

Test-side only, in `internal/provider/signin_removed_test.go`: `plugin.Refreshed()` then `plugin.Told()` right before `catalog.Changed` is set, and the same two in the restore cleanup before `catalog.Changed = was`. `Refreshed` waits the background refresh (the host stays running, so the sign-in the subtest then starts is served as before); the refresh counts its tells before it ends, so the `Told` after it waits those hooks too. No lock on `catalog.Changed`, no change to `catalog.Touched`, no change to what the test asserts.

## Verification

| Check | Command | Result |
|---|---|---|
| Red, as reported | `go test -race -run TestSignInDoneOnceTheAccountIsBack -count=30 ./internal/provider/` | race, 1 of 30 |
| Red, subtest alone | `-run 'TestSignInDoneOnceTheAccountIsBack/fakeco'`, `-race -count=30` | race, 1 of 30 |
| Red, fix reverted | same command, `-count=60` | race, 1 of 60 |
| Green, fix in | same command, `-count=60` | ok |
| Green, fix restored after the ablation | same command, `-count=60` | ok |
| Whole package under the detector | `go test -race ./internal/provider/ -count=1` | ok |
| Provider, no detector | `go test ./internal/provider/... -count=1` | ok |
| Plugin, no detector | `go test ./internal/plugin/... -count=1` | ok |
| Format | `gofmt -l internal/provider/` | empty |
| Vet | `go vet ./internal/provider/... ./internal/plugin/...` | clean |
| Builds | `darwin/arm64`; `linux/amd64 -tags nogui`; `windows/amd64 -tags nogui` | all ok |

## Not verified

Not run on Linux or Windows. The race is probabilistic: the green `-count=60` runs make the window closed under the detector, they don't prove no other window exists. Seventeen other provider test files start plugin work without waiting it out; none of them swaps `catalog.Changed`, so none holds both sides of this race, and they are left as they are.

---
**Source**: the maintainer's issue #3100 (race seen 1 of 30 under `-race -count=30`); reproduced here with the same command.

**Red without the fix** (base `62a1df80`): with the fix reverted, `-race -count=60` reports the same race:
```
WARNING: DATA RACE
Write at 0x000105119c18 by goroutine 71:
  github.com/yetone/magpie/internal/provider.TestSignInDoneOnceTheAccountIsBack.func9()
      internal/provider/signin_removed_test.go:112 +0x3d4
  testing.tRunner()

Previous read at 0x000105119c18 by goroutine 98:
  github.com/yetone/magpie/internal/catalog.Touched()
      internal/catalog/live.go:202 +0x5c
  github.com/yetone/magpie/internal/plugin.tell.func1()
      internal/plugin/host.go:671 +0x44

Goroutine 98 (finished) created at:
  github.com/yetone/magpie/internal/plugin.tell()
      internal/plugin/host.go:663 +0xcc
  github.com/yetone/magpie/internal/plugin.listed()
      internal/plugin/host.go:631 +0x170
  github.com/yetone/magpie/internal/plugin.commitProviders()
      internal/plugin/providers.go:287 +0x314
  github.com/yetone/magpie/internal/plugin.init.func8()
      internal/plugin/providers.go:323 +0x164
  github.com/yetone/magpie/internal/plugin.refreshProvidersWithRetry()
      internal/plugin/providers.go:342 +0x144
  github.com/yetone/magpie/internal/plugin.refreshProvidersInBackground()
      internal/plugin/providers.go:364 +0xf0
  github.com/yetone/magpie/internal/plugin.Cached.gowrap1()
      internal/plugin/providers.go:649 +0x40
==================
--- FAIL: TestSignInDoneOnceTheAccountIsBack/fakeco (0.11s)
```
With the fix: `ok`.

**Siblings**: about twenty tests in this package swap `catalog.Changed` the same way; the fakeco subtest was the only one that both swaps it and starts plugin work, so it was the only one that could race. `TestSignInCanceledWhileTheAccountComesBack` swaps it too but starts no plugin work. Left alone: seventeen test files start plugin work without waiting it out (`account_order_plugin_test.go`, `factory_key_test.go`, `plugin_fetch_lapse_test.go`, `pluginsignin_paste_test.go`, `account_names_test.go`, `plugin_usage_test.go`, `migrate_lapse_test.go`, `docker_signin_test.go`, `forget_account_test.go`, `migrate_handover_test.go`, `plugin_checkin_test.go`, `migrate_ux_test.go`, `plugin_id_reserved_test.go`, `plugin_id_custom_test.go`, `migrate_test.go`, `signin_proxy_test.go`, `pluginsignin_test.go`) — none of them swaps `catalog.Changed`, and none was raced here.

**When the read fails**: if a told hook still reads `catalog.Changed` mid-swap after this, something told it after the `Told` wait — read the race report's created-at chain top down before touching the test.

**Not verified**: not run on Linux or Windows; the detector runs are probabilistic evidence, not proof of absence.

Branch with the commit: [hunt56-c-signin-race](https://github.com/ggbdpq/magpie/tree/hunt56-c-signin-race) (head `47f78b99`).

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

**Patch**: <details><summary>patch: provider: the sign-in test swaps catalog.Changed only once the plugins' background ask and telling are over (#3100) — git am applies it as is; SHA-256 first 16: aef1af7a425c0614</summary>

```patch
From 47f78b9900c96d0282683600882b7f6001d4595a Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 21 Oct 2026 07:32:33 +0800
Subject: [PATCH] provider: the sign-in test swaps catalog.Changed only once
 the plugins' background ask and telling are over (#3100)

What changed: the fakeco half of TestSignInDoneOnceTheAccountIsBack has
the plugin's providers asked in the background, and the answer tells the
agents (catalog.Touched, reached through plugin.tell) in a goroutine that
reads the catalog.Changed global. One of those goroutines was still
running when the subtest swapped catalog.Changed in to watch a removed
account come back, and read it as the subtest wrote it: a data race in 1
of 30 runs of `go test -race -run TestSignInDoneOnceTheAccountIsBack
-count=30 ./internal/provider/`. The subtest now waits the asking
(plugin.Refreshed) and the telling (plugin.Told) out before the hook is
swapped in, and before the cleanup swaps it back out; the host stays
running, so the sign-in the subtest then starts is served as before. No
lock on catalog.Changed, and the test's own observations are unchanged.

Run: with the fix reverted, the same command reported the same race
(write at signin_removed_test.go:112, read at catalog/live.go:202 through
plugin/host.go:671). With the fix, -race -count=60 is ok, as are
go test -race ./internal/provider/ -count=1, go test
./internal/provider/... -count=1, go test ./internal/plugin/... -count=1,
gofmt, go vet, and builds for darwin/arm64, linux/amd64 -tags nogui and
windows/amd64 -tags nogui.

Fixes #3100
Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/provider/signin_removed_test.go | 15 +++++++++++++--
 1 file changed, 13 insertions(+), 2 deletions(-)

diff --git a/internal/provider/signin_removed_test.go b/internal/provider/signin_removed_test.go
index 4673d7b8..f4e5d2a0 100644
--- a/internal/provider/signin_removed_test.go
+++ b/internal/provider/signin_removed_test.go
@@ -105,7 +105,14 @@ func TestSignInDoneOnceTheAccountIsBack(t *testing.T) {
 				t.Fatal("removed account still listed")
 			}
 
-			// what the sign-in reads as the moment its account is shown again
+			// what the sign-in reads as the moment its account is shown again.
+			// The plugins' providers are asked in the background, and the
+			// answer tells the agents (catalog.Touched) in a goroutine that
+			// reads catalog.Changed; the asking and the telling are over
+			// before the hook is swapped in here and before it is swapped
+			// back, so none of them reads it as it is written (#3100)
+			plugin.Refreshed()
+			plugin.Told()
 			var mu sync.Mutex
 			id, back := "", ""
 			was := catalog.Changed
@@ -117,7 +124,11 @@ func TestSignInDoneOnceTheAccountIsBack(t *testing.T) {
 					back = st.State
 				}
 			}
-			t.Cleanup(func() { catalog.Changed = was })
+			t.Cleanup(func() {
+				plugin.Refreshed()
+				plugin.Told()
+				catalog.Changed = was
+			})
 
 			st := c.signIn(t)
 			mu.Lock()
-- 
2.50.1 (Apple Git-155)
```

</details>
