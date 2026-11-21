## Summary

The read in the issue is confirmed. The test sampled `getAnimations()` once after the click to see the list's unroll still playing. The nav-sub's unroll is Web Animations — `navSubEnter` (app.js) animates the box for 460 ms and its rows one after another for 636 ms in all — and those clocks run on the document timeline, so a loaded machine does not slow the play down; it slows the test's own round trip (click → element wait → sample) instead. Once that round trip lands past the end of the play, every animation is finished and out of `getAnimations()` (the box's is `fill: none`, the rows' `backwards`), and the one sample reads "not animating". A machine at load ~175 explains the round trip; 8be402816 touching nothing in the sidebar and the rerun passing both fit it. Credit for reading the cause out of the test goes to yetone — this patch just follows that read.

## What changed

In "the list opens and folds as it plays" only: `Element.prototype.animate` is wrapped ahead of the click, and the assert reads that the nav-sub's own unroll was among the animations made (`window.navAnims.includes(box)`), with the message unchanged. An animation made is a fact that stays put, so the sampling race is gone — the whole play being over before any sample is no longer a red. The assert is not looser: an opening that plays nothing still fails it with the same "the list unrolls" message, because nothing was recorded for its box. Folding half of the test is untouched — its "out of reach at once" assertions read state that the click sets synchronously, and its "gone once it has played" is already a `waitForFunction`.

## The injected red, and the ablation

The load was not reproducible here (idle machine), so the busy round trip was stood in for directly. A 700 ms wait between the click and the old sample (longer than the whole 636 ms play) turns the old test red with the reported signature verbatim: `AssertionError [ERR_ASSERTION]: the list unrolls`, `getAnimations().length > 0` false with the list open. With this change the same wait passes. Ablation: cutting `navSubEnter`'s animations off in app.js (a bare `return`) turns the new assert red again with the same message — so the assert still has teeth, and an app regression that drops the animation is still caught.

## Verification

| Run | Result |
|---|---|
| sidebar.test.cjs with the change, Chromium and WebKit, 10 consecutive full runs (playwright 1.62.0, idle) | 16/16 each, fail 0 |
| nav-sub-unroll.test.cjs + sidebar-glide.test.cjs + sidebar-tab-top.test.cjs, untouched, both engines, 2 combined runs | 68/68 each, fail 0 |
| old test + 700 ms wait injected after the click, Chromium | red, `AssertionError [ERR_ASSERTION]: the list unrolls` (the reported signature) |
| new test + the same 700 ms wait, Chromium | green |
| ablation: navSubEnter's animations cut off, new test, Chromium | red, same "the list unrolls" message; restored, green |
| clean tree at upstream/main dabb5722f, `git am -3`, sidebar.test.cjs | applies clean, 2/2 runs green |

Not verified: a real machine at load ~175 — the load figure is the report's; the delay injection above is the pinned repro in its place.

**Siblings**: `rg` finds one more single-sample read of the same shape — `provider-advanced-fold.test.cjs`'s `boxMoves()` (`getAnimations().length > 0` once after its own click, lines 139 and 152). It has no observed red, so this patch leaves it as it is. The other `getAnimations()` uses across the GUI tests wait for animations to end (length 0, `finished`), which a busy machine only delays, not breaks.

Branch with the commit: [fix/2950-sidebar-anim-sampling](https://github.com/ggbdpq/magpie/tree/fix/2950-sidebar-anim-sampling) (head `f7ee701492a240181d174fab68e8aa8c37048757`).

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: gui tests: sidebar's unroll is counted as its animations are made — git am applies it as is; SHA-256 first 16: 3e26b91102c977f4</summary>

```text
From f7ee701492a240181d174fab68e8aa8c37048757 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Thu, 5 Nov 2026 06:48:13 +0800
Subject: [PATCH] gui tests: sidebar's unroll is counted as its animations are
 made

"the list opens and folds as it plays" sampled getAnimations() once
after the click to see the list's unroll still playing. Under a machine
load of ~175 that one sample landed after the whole play was over: a
finished animation is out of getAnimations(), so the test read "not
animating" and went red once (8be402816's GUI run; it passed on rerun).
The list unrolls for 460 ms and its rows come one after another for 636
ms in all - the round trip from the click through the element wait to
that one sample is not bound to that window.

The animations made are counted instead: Element.prototype.animate is
wrapped ahead of the click, and the assert reads that the nav-sub's own
unroll was among them. An animation made is a fact that stays put, so
the sampling race is gone. The assert is not looser: an opening with no
animation still fails it.

Run (playwright 1.62.0, idle machine):
- this file: 10 runs, 160/160 ok (Chromium and WebKit)
- nav-sub-unroll, sidebar-glide and sidebar-tab-top together: 2 runs,
  136/136 ok
- a 700 ms wait put between the click and the old sample turned it red
  with the reported "the list unrolls" assertion; with this change the
  same wait passes, and cutting navSubEnter's animations off turns it
  red again
Not tried: a machine at load ~175 (the load figure is the report's; the
delay injection stands in for it).

Siblings: provider-advanced-fold's boxMoves() reads getAnimations()
once after its own click the same way; it has no observed red, so it
stays as it is.

Fixes #2950

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gui/tests/sidebar.test.cjs | 15 ++++++++++++++-
 1 file changed, 14 insertions(+), 1 deletion(-)

diff --git a/internal/gui/tests/sidebar.test.cjs b/internal/gui/tests/sidebar.test.cjs
index 71a91969c..b170ba98a 100644
--- a/internal/gui/tests/sidebar.test.cjs
+++ b/internal/gui/tests/sidebar.test.cjs
@@ -201,10 +201,23 @@ for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium",
       await page.route("**/*", serve("en", []));
       await page.goto("http://magpie.test/");
       await page.waitForSelector("#nav button.on");
+      // the unroll is counted as its animations are made, ahead of the
+      // click (#2950): on a busy machine the whole play is over before
+      // the one sample after the click lands, and a finished animation
+      // is out of getAnimations(); an animation made is a fact that
+      // stays put, so the assert reads that, not the moment sampled
+      await page.evaluate(() => {
+        window.navAnims = [];
+        const animate = Element.prototype.animate;
+        Element.prototype.animate = function (frames, options) {
+          window.navAnims.push(this);
+          return animate.call(this, frames, options);
+        };
+      });
       await page.locator("#prefs").click();
       const box = page.locator("#side .nav-sub").first();
       await box.waitFor();
-      assert.ok(await box.evaluate((b) => b.getAnimations().length > 0), "the list unrolls");
+      assert.ok(await box.evaluate((b) => window.navAnims.includes(b)), "the list unrolls");
       await page.locator('#nav button[data-view="agents"]').click();
       // folding: out of reach at once, gone once it has played
       assert.equal(await page.locator(".nav-sub:not(.leaving)").count(), 0);
-- 
2.50.1 (Apple Git-155)

```

</details>
