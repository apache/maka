The test's own fixture is what hid the button. It serves an empty providers list, and an empty list opens the add sheet by itself at boot — `loadProvidersNow` sets `adding = true` without any click when `providers.providers` is empty (`app.js`, the `if (!providers.providers.length && editing === null && !providers.fileError)` line), and `renderProviders` → `renderAdd` unhide the sheet on every one of this test's boots. Once the sheet is in sight, the IntersectionObserver on `#addSheet` adds `.away` to the after-list that holds `#addProvider` (`app.css`: `#view-providers .after-list.away { opacity: 0; visibility: hidden; … }` — the button "steps aside while the sheet's head is in sight"), and a probe confirms this lands ~110–145 ms after navigation on every boot and stays: the button reads `visibility: hidden` from then on, empty bounding box and all, until the sheet closes. A click that starts after that flip therefore waits out its full 30 s on a button that is never coming back — hit-testing skips a `visibility: hidden` subtree, which is also where the logged `<main id="view-providers"> intercepts pointer events` line comes from. Whether the click won was a pure race with the boot: green runs are the ones where the click pipeline (stability against the page's `view-in` animation included) lands inside the first ~200 ms window, red runs are the ones where load pushes it past the flip. That is why it is intermittent and why reruns did not pin it.

The fix goes to the sheet's tile directly and drops the racy button click: the sheet is open either way (the button click could only re-open what the boot already opened, or scroll to it), and Playwright's auto-waiting on the tile absorbs the boot's order. Test-only; no product code touched — the product is behaving as designed (first-run auto-open, button stepping aside). The same hazard is already known to the suite: `plugin-replaced.test.cjs` carries the comment "with no provider yet the sheet is open already" and guards its click the same way. A sweep over the 52 specs that click `#addProvider` found no other one pairing that click with an empty providers fixture, so none of them gets this race.

## What changed

- `internal/gui/tests/segment-press-dialog.test.cjs`: the bare `await page.locator("#addProvider").click()` after `page.goto` is replaced by a comment and the existing tile click, which now is the first interaction (`await page.locator("#addSheet .tile", { hasText: "Kimi Code" }).click()`). The comment records why the sheet is already open and why the button must not be clicked. One hunk, +4 −1.

## Verification

(darwin/arm64, Playwright 1.57.0 via `NODE_PATH`, Chromium + WebKit, en + zh)

| Check | Result |
| --- | --- |
| probe (unchanged assets, 5 fresh boots): sheet unhidden, `.away` on the after-list, button computed `visibility: hidden` | 5/5 boots, `.away` at ~110–145 ms, still hidden 800 ms later — the losing state is deterministic, the old click was the race |
| before, with an injected `waitForFunction` that holds until the button's computed visibility turns `hidden` (the losing end of the race, injected between `goto` and the click) | FAIL 4/4, each at `segment-press-dialog.test.cjs`'s `#addProvider` click: `Timeout 30000ms exceeded`, `element is not visible` — the report's signature |
| after, same injection kept | pass 4/4 |
| ablation: fix reverted (bare click restored), same injection kept | FAIL 4/4 again, same signature — the change is what flips it |
| after, injection removed, `node --test internal/gui/tests/segment-press-dialog.test.cjs` × 10 consecutive | pass 40/40 (4 tests × 10) |
| neighbors that walk the Providers page / add sheet: `add-button.test.cjs`, `add-sheet.test.cjs`, `provider-add-gemini.test.cjs` | pass 32/32 |
| sibling sweep, `rg 'locator\("#addProvider"\)'` over `internal/gui/tests` (52 specs), each fixture checked for an empty `providers` array | only this spec pairs the click with an empty list; `plugin-replaced.test.cjs` documents and guards the same behavior; no other spec exposed, none touched |
| gofmt / go vet / go build | not run — the patch touches one `.test.cjs` only, no Go code |
| full GUI suite | not run — this report is about the one spec; the neighbors above stand in for the page |

## Not verified

- The intermittent red itself was not reproduced bare (no injection, unfixed tree): at this machine's idle load the click wins every time — the injected wait stands in for the losing side of the race deterministically, which is what the report's "load ~7" run hit.
- `webkit`'s away timing was not probed separately; the red/green/ablation matrix above ran on both engines and agrees, so the mechanism is taken to be engine-independent.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: hunt75-c-segment-press-dialog (#3416) — git am applies it as is; SHA-256 first 16: 647cc9577f680de0</summary>

```text
From e5b88c2fda93cc18baaa268e48a361a9d0c52094 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sat, 24 Oct 2026 10:23:27 +0800
Subject: [PATCH] gui tests: segment-press-dialog stops racing the add sheet's
 auto-open
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

What changed: the test clicked #addProvider right after opening the
Providers page. Its fixture serves an empty providers list, and an empty
list opens the add sheet by itself at boot (loadProvidersNow sets adding
without a click); once the sheet is in sight the IntersectionObserver
steps the #addProvider button aside (.after-list.away: opacity 0, then
visibility hidden after .18s), so a click that starts after that flip
waits 30s on a button that is never coming back — the reported
"#view-providers intercepts pointer events / element is not visible".
Whether the click won was a race with the sheet's boot, hence the
intermittent red under load. The click went to the sheet's tile directly:
the sheet is open either way, and the tile click waits for it in whatever
order the boot landed. Test-only; no product code touched.

Run: node --test internal/gui/tests/segment-press-dialog.test.cjs, 10
consecutive runs, 40/40 green. With an injected wait for the button's
computed visibility to turn hidden (the losing end of the race) the old
flow fails 4/4 and the new one passes 4/4; reverting the change with the
same injection fails 4/4 again. add-button, add-sheet and
provider-add-gemini still pass (32/32).

Fixes #3416

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gui/tests/segment-press-dialog.test.cjs | 5 ++++-
 1 file changed, 4 insertions(+), 1 deletion(-)

diff --git a/internal/gui/tests/segment-press-dialog.test.cjs b/internal/gui/tests/segment-press-dialog.test.cjs
index 2ed8bd05..eca72d88 100644
--- a/internal/gui/tests/segment-press-dialog.test.cjs
+++ b/internal/gui/tests/segment-press-dialog.test.cjs
@@ -54,7 +54,10 @@ for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium",
       page.on("pageerror", (e) => errors.push(e.message));
       await page.route("**/*", serve(lang));
       await page.goto("http://magpie.test/?view=providers");
-      await page.locator("#addProvider").click();
+      // the list is empty here, so the sheet opens by itself at boot (adding
+      // is set without a click), and the button stands aside (.away, out of
+      // hit-testing) while the sheet is in sight — go to the tile it shows,
+      // in whatever order those landed
       await page.locator("#addSheet .tile", { hasText: "Kimi Code" }).click();
       const d = page.locator("#modal .editor");
       const opts = d.locator(".segs.regions .opt");
-- 
2.50.1 (Apple Git-155)

```

Branch with the commit: [hunt75-c-segment-press-dialog](https://github.com/ggbdpq/magpie/tree/hunt75-c-segment-press-dialog) (head `e5b88c2fda93cc18baaa268e48a361a9d0c52094`).
