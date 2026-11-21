A fix is ready. Branch: [`fix/3078-lightweight-test`](https://github.com/ggbdpq/magpie/tree/fix/3078-lightweight-test) - head `03d2c9d49762eedab255289f5e8b4df81ce65853`, one commit on top of `f24829636`. The patch in `git am` format is in the collapsed block at the end.

**What's wrong**

The red @yetone reported: `lightweight.test.cjs` run alone on origin/main `75e769a9f` fails 4 of 8 subtests (chromium and webkit, en and zh) with `posted []` at lightweight.test.cjs:86:14 - the switch was flipped, but no save was ever posted.

**Root cause**

The product was never broken - the click landed on nothing. Rows added above Settings - General had pushed the Off/On options past the 1000px viewport (the On option's middle at y about 1008 of 1000), so the helper's raw `page.mouse.click` pressed empty space; no save came, and after the 2.5 s poll the test read `posted []`. Main has been green since the page grew to 1200 tall (`28bec1507`, kept by `c627652e9`), but the trap stayed: rows keep being added to General, and the On option's middle sits at y 974 of 1200 now - about four rows of headroom before the same silent no-op click reads as `posted []` again.

**The fix**

The click helper now asserts, before the mouse click, that the option is wholly inside `#view-settings` and nothing drawn over takes the point pressed - the same check segs-glide's reveal has had since #2683. A row grown under the window's foot now fails at once with where the option is, instead of `posted []` after the poll. Broken by hand to compare: with this file's viewport at 900 (the option's middle at y 974), main's file fails `posted []`; this file fails at once with "the option is out of sight at (851, 974) of 900", in English and Chinese.

**Verification**

All runs today at `03d2c9d49762eedab255289f5e8b4df81ce65853` (base `f24829636`), macOS, playwright 1.62.0, Node v24.21.0:

| Check | Result |
| --- | --- |
| `node --test lightweight.test.cjs`, 5 rounds | 8/8 pass in every round, exit 0 - including the four subtests that exercise the changed click helper: `chromium en`, `chromium zh`, `webkit en`, `webkit zh` ("lightweight mode is turned on and off in Settings - General") |
| `git am` apply test | the patch am-applies onto `f24829636`; the applied commit's patch-id equals the branch commit's (`9d19baef0eb196e5266bf4f8fb489991a00de756`) |
| latest upstream/main | the file under the patch is byte-identical between the patch's base and current upstream/main (11 commits since the base, none touch this file), so it still applies cleanly |

**Not verified**

- macOS with playwright 1.62.0 only; no other OS or playwright version was run.
- In this re-run I ran only `lightweight.test.cjs`. The adjacent suites run earlier in this lane at this commit (`settings-general`, `segs-glide`, `segs-press-redraw`, two rounds each, green) are recorded in the commit message.
- The API is faked in these tests (local fixtures; user settings and live gateways are never touched).

**AI use**

The patch was written by an AI agent (GLM-5.3-Flash via ZCode) under my direction; I ran and checked every item in the table above. The commit author stays `ggbdpq`, with the `Generated-by: GLM-5.3-Flash (ZCode)` trailer in the commit.

Thanks @yetone for the sharp report - the `posted []` excerpt and the run-alone recipe pinned the failing save down.

<details>
<summary>Patch, <code>git am</code> format - sha256 starts with <code>030aa071972573d8</code></summary>

```diff
From 03d2c9d49762eedab255289f5e8b4df81ce65853 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Thu, 5 Nov 2026 02:58:11 +0800
Subject: [PATCH] gui tests: the lightweight click fails at once on an option
 out of sight (#3078)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

The red reported on origin/main 75e769a9f ("posted []", 4 of 8, chromium
and webkit) was the row under the window's foot: rows added above
Settings › General had put the Off/On options past the 1000px viewport
(y about 1008 of 1000), where a mouse click lands on nothing. No save
ever came, and the failure read as an empty posted list. The product was
never broken: 28bec1507 raised this test's page to 1200 tall (with the
on-by-default change) and c627652e9 kept it, so the file has been green
on main since. The trap stayed, though: rows keep being added to
General, and one more row grown above puts the option under the foot
once more, where the same silent no-op click reads as "posted []"
again - the On option's middle sits at y 974 of 1200 now, about four
rows of room.

What changed: the click helper asserts, before the mouse click, that
the option is wholly inside #view-settings and nothing drawn over takes
the point pressed - the check segs-glide's reveal has had since #2683.
A row grown under the foot now fails at once with where the option is,
instead of "posted []" after the 2.5s poll.

Broken by hand: with this file's viewport at 900 (the option's middle
at y 974), main's file fails "posted []"; this file fails "the option
is out of sight at (851, 974) of 900" at once, in English and Chinese.

Run at origin/main f24829636 + this commit, macOS, playwright 1.62.0:
- lightweight.test.cjs 10 rounds (chromium and webkit): 9 all-green;
  the one red round was settingsDrawn's 5s wait timing out on a box at
  load about 8, in a subtest that makes no click at all (the wait bar
  #4470 leaves at the click's 5s on purpose), green again on a rerun.
- settings-general, segs-glide, segs-press-redraw: green, two rounds
  each.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gui/tests/lightweight.test.cjs | 11 ++++++++++-
 1 file changed, 10 insertions(+), 1 deletion(-)

diff --git a/internal/gui/tests/lightweight.test.cjs b/internal/gui/tests/lightweight.test.cjs
index cc4f894e4..b33479ec7 100644
--- a/internal/gui/tests/lightweight.test.cjs
+++ b/internal/gui/tests/lightweight.test.cjs
@@ -81,7 +81,16 @@ for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium",
         // one measured before that is gone (null) by the time it is clicked
         await page.waitForFunction(() => prefsBusy === 0);
         const b = await loc.boundingBox();
-        await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
+        // wholly in sight and on nothing drawn over: rows grown above put the
+        // row under the window's foot, the press landed on nothing, no save
+        // ever came, and the test read "posted []" (#3078)
+        const x = b.x + b.width / 2, y = b.y + b.height / 2;
+        const clear = await loc.evaluate((o, [x, y]) => {
+          const v = o.closest("#view-settings").getBoundingClientRect(), r = o.getBoundingClientRect();
+          return r.top >= v.top && r.bottom <= v.bottom && o.contains(document.elementFromPoint(x, y));
+        }, [x, y]);
+        assert.ok(clear, `the option is out of sight at (${Math.round(x)}, ${Math.round(y)}) of ${page.viewportSize().height}`);
+        await page.mouse.click(x, y);
       };
       // another setting saved while it was never chosen leaves it unchosen,
       // so the default goes on applying
-- 
2.50.1 (Apple Git-155)

```

</details>
