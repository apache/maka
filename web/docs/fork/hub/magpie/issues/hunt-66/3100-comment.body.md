Verified the fork fix on top of `63be4771` (Windows, Go 1.26.8, CGO enabled, race detector on): cherry-picked f85bd166 onto `63be4771` cleanly (no conflicts), ran the sign-in test under `-race -count=5` twice, and reproduced the reported race with the fix's waits reverted.

**What was verified**

- With the fix: `go test -race -run '^TestSignInDoneOnceTheAccountIsBack$' -count=5 ./internal/provider/` is `ok` (10.071s), and `ok` again after the ablation restore (8.223s).
- Attribution in the commit is present and exact: `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`, with "Adapt ggbdpq/magpie 47f78b9900c96d0282683600882b7f6001d4595a" in the message. Author: vincent.
- Fidelity vs `47f78b99`: same waits (`plugin.Refreshed()` then `plugin.Told()` before the swap and again in the restore cleanup); this commit additionally seeds the fake's catalog locally via `catalog.CachePath()`, which removes a real models.dev fetch attempt from the test setup (the reverted run logs `testenv: a test asked models.dev:443, refused`). Comments condensed. Adapted, not verbatim.

**Red with the waits reverted** (`git checkout f85bd166^ -- internal/provider/signin_removed_test.go`, kept under load):

| Check | Command | Result |
|---|---|---|
| Default parallelism, 100 reps | `-race -count=100` (full test) | ok, 117.227s — no race |
| fakeco only, 300 reps | `-race -run '.../fakeco' -count=300 -timeout=25m` | ok, 286.694s — no race |
| fakeco only, pinned cpu | `-race -cpu=1,8 -run '.../fakeco' -count=150 -timeout=30m` | FAIL, 386.867s — 1 race in 300 executions |

The red run reports exactly the reported pair, write in the test, read through the plugin tell chain:

```
WARNING: DATA RACE
Write at 0x000142a66a20 by goroutine 1160:
  github.com/yetone/magpie/internal/provider.TestSignInDoneOnceTheAccountIsBack.func9()
      internal/provider/signin_removed_test.go:112 +0x564
Previous read at 0x000142a66a20 by goroutine 1175:
  github.com/yetone/magpie/internal/catalog.Touched()
      internal/catalog/live.go:180 +0x52
  github.com/yetone/magpie/internal/plugin.tell.func1()
      internal/plugin/host.go:665 +0x44
Goroutine 1175 (finished) created at:
  github.com/yetone/magpie/internal/plugin.tell()
  github.com/yetone/magpie/internal/plugin.listed()
  github.com/yetone/magpie/internal/plugin.commitProviders()
  github.com/yetone/magpie/internal/plugin.refreshProvidersInBackground()
==================
--- FAIL: TestSignInDoneOnceTheAccountIsBack/fakeco (1.62s)
```

With the fix restored: `ok`.

**Drift and landing**: the fork's parent (`665af242`, Oct 23) is 481 commits ahead of `63be4771`; the commit cherry-picks onto `63be4771` with no conflicts, so landing needs nothing extra. Line numbers in the report differ from the issue's only because this base is older (`live.go:180` vs 202, `host.go:665` vs 671) — same functions. Today's main (`e00fbdbb`, checked 2026-10-23) takes the commit clean (`git apply --3way --check`).

**Gaps**: the race is probabilistic and this machine reproduces it at a much lower rate than the 1-in-30 in the report — 1 in 300 here, and zero in about 500 executions at default parallelism, so the red above is one caught instance, not a stable reproducer; the green `-count=5` runs show the window closed, not that no other window exists. Not run on Linux or macOS. `gofmt -l` on the touched file and `go vet` of `internal/provider` and `internal/plugin` are clean.

Thanks — the local catalog fixture is a genuine improvement over my original patch: it keeps the test's setup off the network instead of relying on testenv's refusal.

Verified with AI assistance (GLM-5.3-Flash via ZCode); I've read the diff and re-ran the checks above.
