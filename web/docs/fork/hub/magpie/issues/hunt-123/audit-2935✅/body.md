The test sampled the row's height once per `requestAnimationFrame` for 800ms and wanted `>= 3` samples strictly between the shut and open heights. Under load WebKit starves rAF and drew the whole slide in one frame, so the sampler saw only the final height (208) and the count came up short while the slide itself was drawn correctly — the drawn frames are not a stable witness of the slide on a busy machine. That the same leg alone passes 3 of 3 at the same load matches it: a timing assumption, not a broken slide.

Branch: [`fix/2935-agent-expand-steady`](https://github.com/ggbdpq/magpie/tree/fix/2935-agent-expand-steady), one commit on top of upstream/main `4164edce6`, head `360e436abf431517c7994a99fb64db0edd1a938d`; the patch below applies with `git am` (verified on a clean tree at that base).

## What changed

- The drawn heights stay as an ordering check (`grew only` / `shrank only`), but the `>= 3` mid-height counts are gone. The slide itself is now checked where it lives: the click drives a height animation on the row's opened part (`sheet()` animates it through the Web Animations API, 460ms open / 340ms shut), and the sampler reads that animation in the same tick as the click, before any frame is drawn — `getAnimations()` on the opened part, and a keyframe animation carrying `height` is the witness. Whatever number of frames the machine goes on to draw, the animation is the slide's proof.
- The same evidence answers for the slide shut; the reduced-motion leg is untouched (no animation comes, and none is wanted there).
- The sampler (`heights()` → `slide()`) now returns `{ hs, animated }`; the assertion messages keep printing the drawn heights, so a future red still shows them.

## Verification

(playwright 1.62.0, macOS arm64, `node --test`, at 4164edce6)

| Check | Result |
| --- | --- |
| `agent-expand-steady.test.cjs`, Chromium + WebKit, 980px + 560px | 40/40 over ten rounds |
| starvation probe: rAF held past the sampling window — one drawn frame, the final height | old assertions red (`slid open: 746`), new ones green; probe then removed |
| neighbouring agent-row files (`agent-connected-unfolded`, `agent-models`) | 8/8, two rounds |

The probe reproduces the reported run by signature, not by load (this machine sits far below load ~115), but it is the same world the issue describes: one drawn frame carrying only the final height, exactly where the old count went red. Thank you for the report, yetone — the one-frame observation is what pointed at the animation instead of the sampler.

**AI**: written with an AI coding agent; I've read the whole diff and can answer questions on it myself. The model name is in the commit's trailer.

**Attribution**: If you apply the patch, please keep its author (ggbdpq) or add a `Co-authored-by: ggbdpq <ggbdpq@gmail.com>` line.

<details><summary>patch: gui tests: agent-expand-steady checks the slide's animation, not the frames drawn (#2935) — git am applies it as is; SHA-256 first 16: f36cb75e7c00f1b3</summary>

```patch
From 360e436abf431517c7994a99fb64db0edd1a938d Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Thu, 5 Nov 2026 06:37:27 +0800
Subject: [PATCH] gui tests: agent-expand-steady checks the slide's animation,
 not the frames drawn (#2935)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

yetone reported the webkit 980px leg going red once under load: "slid
open: 208". The test sampled the row's height every frame for 800ms and
wanted at least three heights between shut and open. A busy machine
drops frames — WebKit drew the whole slide in one frame, the sampler saw
only the final height (208), and the count came up short while the slide
itself was drawn correctly. Alone, the same test passed 3 of 3 at the
same load: a timing assumption, not a broken slide.

The drawn heights stay as an ordering check only; the slide itself is
now checked where it lives. A click drives a height animation on the
row's opened part (sheet() animates it through the Web Animations API),
so the sampler reads the opened part's animations in the same tick as
the click, before any frame is drawn: a keyframe animation carrying
height is the slide's witness, whatever number of frames the machine
went on to draw. The same evidence answers for the slide shut.

Run (playwright 1.62.0, darwin/arm64, node --test):
- agent-expand-steady: 40/40, ten rounds, Chromium and WebKit, 980px
  and 560px.
- A probe that starves requestAnimationFrame past the sampling window
  (the reported shape: one drawn frame, the final height) is red on the
  old assertions ("slid open: 746") and green on the new ones, then
  removed.
- agent-connected-unfolded and agent-models, the neighbouring agent-row
  files: green, two rounds.

Generated-by: GLM-5.3-Flash (ZCode)
---
 .../gui/tests/agent-expand-steady.test.cjs    | 41 ++++++++++++-------
 1 file changed, 27 insertions(+), 14 deletions(-)

diff --git a/internal/gui/tests/agent-expand-steady.test.cjs b/internal/gui/tests/agent-expand-steady.test.cjs
index 1a2b7ac11..393fe63c8 100644
--- a/internal/gui/tests/agent-expand-steady.test.cjs
+++ b/internal/gui/tests/agent-expand-steady.test.cjs
@@ -4,7 +4,10 @@
 // instead of moving as iOS does. Opened, the name and the switch stay where
 // they were and the opened part starts right where the shut row ended; it
 // slides open and shut through the heights between, and no step at either
-// end. With reduced motion it opens at once. Wide and narrow windows; no
+// end — the slide is the opened part's height animation, and that animation
+// is what the test checks for: on a busy machine frames are dropped, and the
+// drawn heights may show only the ends (#2935). With reduced motion it opens
+// at once. Wide and narrow windows; no
 // backend, the API is faked here.
 const assert = require("node:assert/strict");
 const fs = require("node:fs/promises");
@@ -51,11 +54,20 @@ const where = (page) => page.evaluate((r) => {
   const at = (s) => Math.round((el.querySelector(s)?.getBoundingClientRect().top - top) * 4) / 4;
   return { height: Math.round(el.getBoundingClientRect().height), line: parseFloat(getComputedStyle(el).borderBottomWidth), who: at(":scope > .who"), sw: at(":scope > .ag-conn"), exp: el.querySelector(".ag-exp") ? at(":scope > .ag-exp") : null };
 }, row);
-// the row's height every frame for a while, from a click on its link
-const heights = (page, ms) => page.evaluate(([r, ms]) => new Promise((done) => {
+// the row's height every frame for a while, from a click on its link, and
+// whether the click drove a height animation on the row's opened part: on a
+// busy machine frames are dropped (WebKit once drew the whole slide in one
+// frame, #2935), so the drawn heights alone can't tell a slide from a jump —
+// the animation on the opened part can
+const slide = (page, ms) => page.evaluate(([r, ms]) => new Promise((done) => {
   const hs = [], t0 = performance.now();
-  const f = () => { hs.push(Math.round(document.querySelector(r).getBoundingClientRect().height)); if (performance.now() - t0 < ms) requestAnimationFrame(f); else done(hs); };
+  const f = () => { hs.push(Math.round(document.querySelector(r).getBoundingClientRect().height)); if (performance.now() - t0 < ms) requestAnimationFrame(f); else done({ hs, animated }); };
   document.querySelector(r + " .ag-link").click();
+  // the click drove the slide before it returned: the opened part carries a
+  // height animation (none comes when motion is reduced, and none is wanted
+  // there)
+  const exp = document.querySelector(r + " > .ag-exp");
+  const animated = !!exp && exp.getAnimations().some((a) => a.effect.getKeyframes().some((k) => "height" in k));
   requestAnimationFrame(f);
 }), [row, ms]);
 
@@ -74,7 +86,7 @@ for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium",
       await page.locator(`${row} .ag-conn`).waitFor();
 
       const shut = await where(page);
-      const opening = await heights(page, 800);
+      const opening = await slide(page, 800);
       const open = await where(page);
       assert.equal(open.who, shut.who, "the name moved");
       assert.equal(open.sw, shut.sw, "the switch moved");
@@ -82,13 +94,14 @@ for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium",
       assert.equal(open.exp, shut.height - shut.line, "the opened part starts where the shut row ended");
       const full = open.height;
       assert.ok(full > shut.height + 60, `opened: ${full}`);
-      // the heights between, growing, no step bigger than a frame's worth
-      const mid = opening.filter((h) => h > shut.height && h < full);
-      assert.ok(mid.length >= 3, "slid open: " + opening);
-      for (let i = 1; i < opening.length; i++) assert.ok(opening[i] >= opening[i - 1], "grew only: " + opening);
-      const closing = await heights(page, 700);
-      assert.ok(closing.filter((h) => h > shut.height && h < full).length >= 3, "slid shut: " + closing);
-      for (let i = 1; i < closing.length; i++) assert.ok(closing[i] <= closing[i - 1], "shrank only: " + closing);
+      // the slide, not a jump: the opened part was animated through the
+      // heights between, whatever number of frames the machine drew (#2935),
+      // and the frames it did draw kept the order
+      assert.ok(opening.animated, "slid open: " + opening.hs);
+      for (let i = 1; i < opening.hs.length; i++) assert.ok(opening.hs[i] >= opening.hs[i - 1], "grew only: " + opening.hs);
+      const closing = await slide(page, 700);
+      assert.ok(closing.animated, "slid shut: " + closing.hs);
+      for (let i = 1; i < closing.hs.length; i++) assert.ok(closing.hs[i] <= closing.hs[i - 1], "shrank only: " + closing.hs);
       assert.deepEqual(await where(page), shut, "shut again as it was");
 
       // another row open: the one open slides shut, this one opens
@@ -108,8 +121,8 @@ for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium",
       await reach(page, goose);
       await goose.click();
       await page.waitForTimeout(500);
-      const now = await heights(page, 120);
-      assert.equal(now[0], full, "opened at once: " + now);
+      const now = await slide(page, 120);
+      assert.equal(now.hs[0], full, "opened at once: " + now.hs);
       assert.deepEqual(errors, []);
     });
   }
-- 
2.50.1 (Apple Git-155)
```
</details>
