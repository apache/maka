Reproduced and fixed on current main `f5b0157420a` (fetched today). This supersedes the patch in [my comment from 10-20](https://github.com/yetone/magpie/issues/3045#issuecomment-6292337079) — same count, re-derived on today's tree and re-verified end to end; please apply this one. The verdict is unchanged: **(c) a test bug — the test, not the product, is what drifted.**

## Source & environment

- The filed output reproduces byte for byte at `f5b0157` (upstream main), macOS darwin/arm64.
- The flip is the toolchain, not the tree: `go.mod` pins `go 1.26.8`, and there the test passes standalone — which is why it looks healthy on 1.26 machines. Under `GOTOOLCHAIN=go1.27.0` it fails standalone. (Local launcher go1.25.5; toolchains resolved per go.mod / `GOTOOLCHAIN`.)
- The test and the byte-budget cache it pins landed together in `11173c8a` and neither file has moved since its introduction (`git log -- internal/gateway/codex_images.go internal/gateway/codex_images_test.go`; `git log -S "made"` on the test finds only `11173c8a`). There is no product commit to cite: the product behaves to its contract on both toolchains. What moved is the standard library's PNG encoder.

## Reproduction

    GOTOOLCHAIN=go1.27.0 go test -tags nogui -count=1 -run '^TestCodexFittedImagesPastTheBudget$' ./internal/gateway/

    --- FAIL: TestCodexFittedImagesPastTheBudget (0.02s)
        codex_images_test.go:362: turn 2 made 19 of 30 images, with 10 kept
        codex_images_test.go:362: turn 3 made 19 of 30 images, with 10 kept
    FAIL

— exit 1. (The issue's `:359` is the same assertion; the file shifted three lines since it was filed.) The same command without `GOTOOLCHAIN` prints `ok`, exit 0.

## Root cause

The test budgeted `10.5 × one`, where `one` is the fitted size of `shots[0]` alone, assuming all thirty fitted shots are the same size. They never were — a few bytes of PNG apart — and where the cache's LRU boundary falls is decided by those bytes. Measured on this tree (`fitKeyEntry` on each of the 30 shots):

- go1.26.8: sizes 278–282, `one = 280`, budget 2940, last-eleven sum 3088 → 11 does not fit → 10 kept → the test passes;
- go1.27.0: sizes 336–387, `one = 384`, budget 4032, last-eleven sum 4008 → 11 fits → 11 kept → turn 2 remakes 19, exactly the output filed here.

## Fix

Only `internal/gateway/codex_images_test.go`, only `TestCodexFittedImagesPastTheBudget`. The budget is now counted on the shots as they actually fit: it measures all thirty fitted sizes and takes the last ten plus half of the eleventh from the end. With that budget, ten kept and no eleven is true by construction on any toolchain — the last ten always fit it, and the last eleven always overflow it by exactly half of the eleventh — instead of being true only where the encoder's bytes happen to leave the boundary on the right side. The pinned expectations (turn 1 makes 30, later turns make 20, held bytes stay within budget) are unchanged. Sensitivity survives the fix: with the budget raised by hand to a full eleventh, the test goes red again (`turn 3 made 19 of 30 images, with 10 kept`). The other fifteen tests in the file don't share the defect: the two other long-conversation tests run against the full 256 MiB budget (nothing evicts, so no boundary to land on) and the idle one asserts against an entry size it measures itself; the header/heap tests compare live measurements against limits in the same run; `TestCodexFittingHoldsTheBudget` feeds a pure batching function synthetic values; the rest do no cache-budget arithmetic at all. All were run under both toolchains (the `TestCodex` family): only the budget test was sensitive.

## Verification

| Check | Command | Result |
| --- | --- | --- |
| Red, pre-fix (go1.27.0) | `GOTOOLCHAIN=go1.27.0 go test -tags nogui -count=1 -run '^TestCodexFittedImagesPastTheBudget$' ./internal/gateway/` | FAIL as filed, exit 1 |
| Green, pre-fix (go1.26.8) | same, without `GOTOOLCHAIN` | `ok`, exit 0 — explains why not everyone saw it |
| Fixed test alone, ×2 (go1.26.8) | same, without `GOTOOLCHAIN` | `ok`, `ok`, exit 0 |
| Fixed test alone, ×2 (go1.27.0) | same with `GOTOOLCHAIN=go1.27.0` | `ok`, `ok`, exit 0 |
| Fixed test, race | `go test -tags nogui -race -count=5 -run '^TestCodexFittedImagesPastTheBudget$' ./internal/gateway/` | `ok`, exit 0 |
| Still bites after the fix (go1.27.0) | budget raised by hand to a full eleventh | FAIL (`turn 3 made 19 of 30 images, with 10 kept`), exit 1; restored |
| Codex family (go1.26.8) | `go test -tags nogui -count=1 -run TestCodex ./internal/gateway/` | `ok 28.134s`, exit 0 |
| Codex family (go1.27.0) | same with `GOTOOLCHAIN=go1.27.0` | `ok 24.451s`, exit 0 |
| Full gateway package (go1.26.8) | temp HOME with `GOPATH`/`GOMODCACHE`/`GOCACHE` pinned: `go test -tags nogui -count=1 ./internal/gateway/` | `ok 552.980s`, exit 0 (the package's `TestMain` isolates HOME for every test besides) |
| Format | `gofmt -l internal/gateway/codex_images_test.go` | clean |
| Vet | `go vet ./...`; `GOOS=linux go vet -tags nogui ./...`; `GOOS=windows go vet ./...` | exit 0 on all three (a pre-existing cgo warning in `internal/gui/trayimage_darwin.go` stays; the file is not touched) |
| Build | `go build ./...`; `GOOS=linux go build -tags nogui ./...`; `GOOS=windows go build ./...` | exit 0 on all three |

## Not verified

- I did not bisect which standard-library change in Go 1.27 (image/png filtering vs compress/flate) moved the encoded bytes; the flip between toolchains is demonstrated, the culprit CL is not identified.
- Only two toolchains were exercised (go1.26.8, go1.27.0). The new budget makes 10-vs-11 exact by construction from the measured sizes, but I cannot run every release.
- The whole-repo suite (`go test -tags nogui ./...`) was not run; the hunt's matrix asked for the touched package in full, and the change touches only one test in `internal/gateway`.
- GitHub CI on its runners: nothing was pushed, per the hunt's ground rules.
- No product code changed, so no product behavior was exercised beyond the tests, vet and builds above.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: gateway: the past-the-budget images test counts its budget on the shots as they fit (#3045) — git am applies it as is; SHA-256 first 16: 9d00b064fd563e89</summary>

```patch
From 86f9707e8058848662e35db0b85462e35751122a Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 21 Oct 2026 23:23:33 +0800
Subject: [PATCH] gateway: the past-the-budget images test counts its budget on
 the shots as they fit

TestCodexFittedImagesPastTheBudget went red standalone on machines whose
Go is 1.27 ("turn 2 made 19 of 30 images, with 10 kept", twice), with no
product change in sight: the test and the byte-budget cache it pins came
together in 11173c8a, and the test passes on go1.26. What moved is the
standard library's PNG encoder. The test measured one fitted screenshot
(the first) and budgeted 10.5 of that size; the thirty fitted shots are
not one size, a few bytes of PNG each way, and the encoder shifts them
between releases. On this tree, go1.26.8 fits them at 278-282 bytes
(budget 2940, the last eleven 3088: eleven does not fit, ten kept) and
go1.27.0 at 336-387 (budget 4032, the last eleven 4008: eleven fits, so
eleven are kept and a turn remakes 19).

What changed: only the test. The budget is counted on the shots as they
fit - the last ten, and half of the eleventh from the end - so ten kept
and no eleven holds by construction on any toolchain, instead of by
where the encoder's bytes happen to leave the boundary. The pinned
expectations (the first turn makes 30, later turns 20, what is held
stays within the budget) are unchanged.

Run (go1.26.8 unless said otherwise):
- the test alone under GOTOOLCHAIN=go1.27.0, before the change: red as
  filed, exit 1; after it: ok
- the test alone, twice: ok, ok; under GOTOOLCHAIN=go1.27.0: ok, ok
- the test alone with -race -count=5: ok
- go test -tags nogui -run TestCodex ./internal/gateway/: ok on go1.26.8
  and go1.27.0
- go test -tags nogui -count=1 ./internal/gateway/ under a temp HOME
  with the Go caches pinned: ok 552.980s
- gofmt -l on the changed file: clean
- go vet ./..., GOOS=linux go vet -tags nogui ./..., GOOS=windows go
  vet ./...: clean (a pre-existing cgo warning in
  internal/gui/trayimage_darwin.go stays; the file is not touched)
- go build ./..., GOOS=linux go build -tags nogui ./..., GOOS=windows
  go build ./...: ok

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/codex_images_test.go | 17 +++++++++++++++--
 1 file changed, 15 insertions(+), 2 deletions(-)

diff --git a/internal/gateway/codex_images_test.go b/internal/gateway/codex_images_test.go
index c0e58478..dce1e284 100644
--- a/internal/gateway/codex_images_test.go
+++ b/internal/gateway/codex_images_test.go
@@ -350,8 +350,21 @@ func TestCodexScreenshotsAreNotFittedAgainEachTurn(t *testing.T) {
 // What is held stays within the budget.
 func TestCodexFittedImagesPastTheBudget(t *testing.T) {
 	shots := wideShots(t, 30)
-	one := len(fitKeyEntry(t, shots[0]).data)
-	made := freshFitted(t, 10*one+one/2)
+	// The shots fit to no one size: a few bytes of PNG each way, and the
+	// standard library's encoder shifts them from release to release
+	// (past a budget counted on the first shot alone, go1.26 kept 10 of
+	// these and go1.27 kept 11). The budget is counted on the shots as
+	// they fit: the last ten, and half of the eleventh from the end past
+	// it, which keeps ten and no eleven on any release.
+	sizes := make([]int, len(shots))
+	for i, shot := range shots {
+		sizes[i] = len(fitKeyEntry(t, shot).data)
+	}
+	budget := sizes[len(sizes)-11] / 2
+	for _, one := range sizes[len(sizes)-10:] {
+		budget += one
+	}
+	made := freshFitted(t, budget)
 	body := computerUseRequest(shots)
 	was := int64(0)
 	for turn := 1; turn <= 3; turn++ {
-- 
2.50.1 (Apple Git-155)
```

</details>

Branch with the commit: [hunt58-d-3045-codex-images-budget](https://github.com/ggbdpq/magpie/tree/hunt58-d-3045-codex-images-budget) (head `86f9707e8058848662e35db0b85462e35751122a`).
