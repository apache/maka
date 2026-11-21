Reproduced standalone on `dee5c9d7` — with one twist that turned out to be the whole answer: the test is red only under Go 1.27. Verdict: **(c) a test bug — the test, not the product, is what drifted**. The test and the byte-budget cache it pins landed together in `11173c8a` ("gateway: a long Computer Use turn fits each screenshot once, not every turn") and neither file has been touched since (`git log -- internal/gateway/codex_images.go internal/gateway/codex_images_test.go` shows only that commit and its predecessor; `git log -S "made"` on the test finds only `11173c8a`). There is no product regression and no product commit to cite: the product behaves to its contract on both toolchains, and what moved is the standard library's PNG encoder.

The test budgeted `10.5 × one` where `one` is the fitted size of `shots[0]` alone, assuming all thirty fitted shots are the same size. They never were — a few bytes of PNG apart — and where the cache's LRU boundary falls is decided by those bytes. Measured on this tree (`fitKeyEntry` on each of the 30 shots):

- go1.26.8 / go1.26.9: sizes 278–282, `one = 280`, budget 2940, last-eleven sum 3088 → 11 does not fit → 10 kept → the test passes;
- go1.27.0: sizes 336–387, `one = 384`, budget 4032, last-eleven sum 4008 → 11 fits → 11 kept → turn 2 remakes 19, exactly the output filed here.

Branch: [`hunt52-d-codex-images-red`](https://github.com/ggbdpq/magpie/tree/hunt52-d-codex-images-red), one commit on top of upstream `dee5c9d7`; the patch below applies with `git am`.

## What changed

Only `internal/gateway/codex_images_test.go`, only `TestCodexFittedImagesPastTheBudget`. The budget is now counted on the shots as they actually fit: it measures all thirty fitted sizes and takes the last ten plus half of the eleventh from the end. With that budget, ten kept and no eleven is true by construction on any toolchain — the last ten always fit it, and the last eleven always overflow it by exactly half of the eleventh — instead of being true only where the encoder's bytes happen to leave the boundary on the right side. The pinned expectations (turn 1 makes 30, later turns make 20, held bytes stay within budget) are unchanged.

## Red before the fix

On `dee5c9d7`, before the patch, with `GOTOOLCHAIN=go1.27.0` (go.mod asks for go ≥ 1.26.8, which a local 1.27 satisfies directly, so this is what a 1.27 machine runs):

```
--- FAIL: TestCodexFittedImagesPastTheBudget (0.02s)
    codex_images_test.go:359: turn 2 made 19 of 30 images, with 10 kept
    codex_images_test.go:359: turn 3 made 19 of 30 images, with 10 kept
FAIL
```

— byte for byte the output in the issue. On the same tree with go1.26.8 or go1.26.9 the same standalone command passes, which is why the test looked healthy on 1.26 machines. After the patch it passes on all three toolchains.

## Verification

| Check | Command | Result |
| --- | --- | --- |
| Red, pre-fix (go1.27.0) | `GOTOOLCHAIN=go1.27.0 go test -tags nogui -count=1 -run '^TestCodexFittedImagesPastTheBudget$' ./internal/gateway/` | FAIL as filed, exit 1 |
| Green, pre-fix (go1.26.8 / 1.26.9) | same, without GOTOOLCHAIN | `ok`, exit 0 — explains why not everyone saw it |
| Fixed test alone, ×2 (go1.26.8) | `go test -tags nogui -count=1 -run '^TestCodexFittedImagesPastTheBudget$' ./internal/gateway/` | `ok`, `ok`, exit 0 |
| Fixed test alone (go1.27.0) | same with `GOTOOLCHAIN=go1.27.0` | `ok`, exit 0 |
| Codex family (go1.26.8) | `go test -tags nogui -count=1 -run TestCodex -v ./internal/gateway/` | all pass (incl. all 9 tests of codex_images_test.go), exit 0 |
| Image tests (go1.27.0) | `GOTOOLCHAIN=go1.27.0 go test -tags nogui -run 'TestCodexImage\|TestCodexImages\|TestCodexScreenshot\|TestCodexScreenshots\|TestCodexFitted' -v ./internal/gateway/` | 8/8 pass, exit 0 |
| Full gateway package | `go test -tags nogui -count=1 ./internal/gateway/` | `ok 317.86s`, exit 0 |
| Format | `gofmt -l internal/gateway/codex_images_test.go` | clean |
| Vet | `go vet -tags nogui ./internal/gateway/` and `GOOS=linux` / `GOOS=windows` | clean on all three |

## Siblings

The other tests in `codex_images_test.go` don't share the defect: `TestCodexScreenshotsAreNotFittedAgainEachTurn` and `TestCodexFittedImagesLetGoWhenIdle` run against the full 256 MiB budget (nothing evicts, so no boundary to land on) and the latter asserts against an entry size it measures itself; `TestCodexImageSizeAsCodex`, `TestCodexScreenshotSizedAsCodex`, `TestCodexImagesSizedInEveryPlace`, `TestCodexImagesThatFitGoAsTheyCame`, `TestCodexImagesOnlyForChatGPT` and `TestCodexAccountGetsScreenshotAtCodexSize` do no cache-budget arithmetic at all. All were run under both toolchains; only the budget test was sensitive.

## Not verified

- I did not bisect which standard-library change in Go 1.27 (image/png filtering vs compress/flate) moved the encoded bytes; the flip between toolchains is demonstrated, the culprit CL is not identified.
- Only three toolchains were exercised (go1.26.8, go1.26.9, go1.27.0). The new budget makes 10-vs-11 exact by construction from the measured sizes, but I cannot run every release.
- GitHub CI on its runners: nothing was pushed, per the hunt's ground rules.
- No product code changed, so no product build was exercised beyond `go vet` compiling the package with its tests.

**AI**: written with an AI coding agent; I've read the whole diff and can answer questions on it myself. The model name is in the commit's trailer.
**Attribution**: If you apply the patch, please keep its author (ggbdpq) or add a `Co-authored-by: ggbdpq <ggbdpq@gmail.com>` line.

<details><summary>patch (git am) — 0001-gateway-the-past-the-budget-images-test-counts-its-b.patch</summary>

```patch
From 9fe9a64276eacc893dc3718976ce3dd08d3863a8 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Tue, 20 Oct 2026 21:39:27 +0800
Subject: [PATCH] gateway: the past-the-budget images test counts its budget on
 the shots as they fit
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

TestCodexFittedImagesPastTheBudget went red standalone on machines whose
Go is 1.27: "turn 2 made 19 of 30 images, with 10 kept", twice, with no
product change in sight — the test and the byte-budget cache it pins came
together in 11173c8a and neither has moved since.

What changed: the test measured one fitted screenshot (the first) and
budgeted 10.5 of that size. The thirty fitted shots are not one size —
a few bytes of PNG each way — and the standard library's encoder shifts
them between releases: past a budget counted on the first shot alone,
go1.26 kept 10 of these and go1.27 kept 11 (one 384 bytes, sizes 336 to
387, the last eleven 4008 bytes against a 4032 budget). The budget is
now counted on the shots as they fit: the last ten plus half of the
eleventh from the end, which keeps ten and no eleven on any release, by
construction rather than by where the encoder's noise happens to fall.

Run (go1.26.8 unless said otherwise):
- the test alone, twice: ok, ok
- the test alone under GOTOOLCHAIN=go1.27.0: red as filed before the
  change, ok after it
- go test -tags nogui -run TestCodex ./internal/gateway/: all pass
- go test -tags nogui -count=1 ./internal/gateway/: ok 317.9s
- gofmt clean; go vet -tags nogui on darwin, GOOS=linux, GOOS=windows

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/codex_images_test.go | 17 +++++++++++++++--
 1 file changed, 15 insertions(+), 2 deletions(-)

diff --git a/internal/gateway/codex_images_test.go b/internal/gateway/codex_images_test.go
index 4c0e815c..a157716b 100644
--- a/internal/gateway/codex_images_test.go
+++ b/internal/gateway/codex_images_test.go
@@ -347,8 +347,21 @@ func TestCodexScreenshotsAreNotFittedAgainEachTurn(t *testing.T) {
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
