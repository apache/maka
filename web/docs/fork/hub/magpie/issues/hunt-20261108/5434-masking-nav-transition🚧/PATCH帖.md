@yetone The masking tab in the nav is left out of the layout morph: when the sidebar and the header's tabs trade places, every other tab flies from its row to its place on its own, while the masking tab only fades with the whole sidebar — reported by @invzhi in #5434, with the exact spot in `app.css` pointed out.

**Root cause**: the morph gives every moving piece a `view-transition-name` of its own, so the browser animates it from its old place to its new one (`internal/gui/assets/app.css`, the `.nav-morph` block, lines 543–556 at the parent tip). The list held one rule per nav tab — but only for the eight tabs that existed when the morph landed (17a2b00ef). The groups and masking tabs came to the nav later (80ae904c2, e698a688f) and never got a rule, so during the morph they have no snapshot of their own and only fade with the sidebar as a whole.

**The fix**: following the reporter's own analysis, `nav-groups` and `nav-masking` join the list, in the nav's order. The morph's test in `internal/gui/tests/side-toggle.test.cjs` now reads every nav tab's computed `view-transition-name` while the morph plays and holds them each to a name of their own, all different, and to the masking tab's group actually animating — so the next tab added to the nav can't be left out either.

<details><summary>patch: gui: the nav's groups and masking tabs fly with the rest as the layouts trade places (#5434) — git am applies it as is; SHA-256 first 16: 50d90d224dfff65b</summary>

```text
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sun, 8 Nov 2026 14:20:09 +0800
Subject: [PATCH] gui: the nav's groups and masking tabs fly with the rest as
 the layouts trade places (#5434)

The morph gives every tab in the nav a view-transition-name of its own
(app.css .nav-morph), so each flies from its row in the sidebar to its
place in the header's tabs and back. The groups and masking tabs came
to the nav after the morph did and were left out of that list: while
the other tabs flew, they only faded with the whole sidebar (#5434).
They are in the list now, in the nav's order, and the morph's test
holds every tab in the nav to a name of its own, so the next tab added
there can't be left out.
---
 internal/gui/assets/app.css             |  2 ++
 internal/gui/tests/side-toggle.test.cjs | 12 +++++++++++-
 2 files changed, 13 insertions(+), 1 deletion(-)

diff --git a/internal/gui/assets/app.css b/internal/gui/assets/app.css
index 82eb95480..4fef2a1ad 100644
--- a/internal/gui/assets/app.css
+++ b/internal/gui/assets/app.css
@@ -551,8 +551,10 @@ body:not(.side-nav) .side-toggle .st-pane { opacity: 0; }
 .nav-morph #nav button[data-view="library"] { view-transition-name: nav-library; }
 .nav-morph #nav button[data-view="providers"] { view-transition-name: nav-providers; }
 .nav-morph #nav button[data-view="routing"] { view-transition-name: nav-routing; }
+.nav-morph #nav button[data-view="groups"] { view-transition-name: nav-groups; }
 .nav-morph #nav button[data-view="gateway"] { view-transition-name: nav-gateway; }
 .nav-morph #nav button[data-view="usage"] { view-transition-name: nav-usage; }
+.nav-morph #nav button[data-view="masking"] { view-transition-name: nav-masking; }
 .nav-morph #nav button[data-view="plugins"] { view-transition-name: nav-plugins; }
 ::view-transition-group(*) { z-index: 1; animation-duration: var(--morph-t); animation-timing-function: var(--morph-ease); }
 ::view-transition-old(*), ::view-transition-new(*) { inline-size: auto; block-size: auto; }
diff --git a/internal/gui/tests/side-toggle.test.cjs b/internal/gui/tests/side-toggle.test.cjs
index 79b552225..8b8e7c733 100644
--- a/internal/gui/tests/side-toggle.test.cjs
+++ b/internal/gui/tests/side-toggle.test.cjs
@@ -202,7 +202,8 @@ for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium",
       // what plays, read as the button is clicked: the old drawn, the new laid out
       const playing = () => page.evaluate(() => new Promise((r) => {
         const at = () => document.getAnimations().map((a) => a.effect?.pseudoElement).filter(Boolean);
-        requestAnimationFrame(() => requestAnimationFrame(() => r({ anims: at(), morph: document.documentElement.classList.contains("nav-morph") })));
+        const named = () => [...document.querySelectorAll("#nav button[data-view]")].map((b) => [b.dataset.view, getComputedStyle(b).viewTransitionName]);
+        requestAnimationFrame(() => requestAnimationFrame(() => r({ anims: at(), names: named(), morph: document.documentElement.classList.contains("nav-morph") })));
       }));
       await page.locator("#sideToggle").click();
       let p = await playing();
@@ -210,6 +211,15 @@ for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium",
       assert.ok(p.anims.includes("::view-transition-old(side)"), `the sidebar slides away: ${p.anims}`);
       assert.ok(p.anims.includes("::view-transition-group(nav-usage)"), "each tab flies to the header");
       assert.ok(p.anims.includes("::view-transition-group(page)"), "the page moves over");
+      // every tab in the nav flies with the others, the masking one too
+      // (#5434): the groups and masking tabs came to the nav after the morph
+      // and had no view-transition-name of their own, so while the rest flew
+      // they only faded with the whole sidebar
+      const seen = Object.fromEntries(p.names);
+      const views = await page.evaluate(() => [...document.querySelectorAll("#nav button[data-view]")].map((b) => b.dataset.view));
+      for (const v of views) assert.ok(seen[v] && seen[v] !== "none", `the ${v} tab has a view-transition-name of its own (${seen[v] || "none"})`);
+      assert.equal(new Set(Object.values(seen)).size, views.length, "the tabs' names are all different");
+      assert.ok(p.anims.includes("::view-transition-group(nav-masking)"), "the masking tab flies too");
       // off from rest and settling, in a third of a second, as a Mac's
       // sidebar: a curve leaving at speed made a frame the webview drops at
       // the start a visible jerk (wangye1644294 on X), and every piece, the
-- 
2.50.1 (Apple Git-155)

```

</details>

**Branch with the commit**: [`fix/5434-masking-nav-transition`](https://github.com/ggbdpq/magpie/tree/fix/5434-masking-nav-transition) (head `5ca5b8f909d7114aec9f31123fd152cf3ea3c9d2`), created on current `upstream/main` (`c736906b1`); on a fresh checkout `git am` applies clean (verified: the am'd tree matches the committing tree byte-for-byte).

| Check | Result |
| --- | --- |
| `chromium: the sidebar's button › the two trade places as one motion` (extended in this patch; `node --test internal/gui/tests/side-toggle.test.cjs`, Playwright Chromium 153.0.8010.12 served from the repo's assets with a stub API layer) | red before the fix — `the groups tab has a view-transition-name of its own (none)`, and with the rule ablated `the masking tab … (none)` — pass after |
| same test on WebKit (`BROWSER=webkit`, WebKit 26.6) | pass, 13/13 |
| neighbour nav/morph tests: `sidebar-glide.test.cjs`, `sidebar.test.cjs`, `routing-idle-frame.test.cjs` (chromium, 24 tests) | pass |
| `go test ./internal/gui/ -tags nogui -timeout 30m -count=1` | FAIL: `TestProxyCheckSaysAProxyPassedBy` — fails the same at upstream/main `c736906b1` on this machine (no proxy reachable, "the proxy asked 0 times"), pre-existing, not a baseline; every other test in the package passes |
| `go test -tags nogui ./...` (whole repo) | not run — the patch touches only `internal/gui` assets and a test of that package |
| targeted `-race` (`go test -race -tags nogui ./internal/gui/`) | pass except the same pre-existing `TestProxyCheckSaysAProxyPassedBy` |
| `gofmt -l internal/gui/` | prints nothing |
| `go vet ./internal/gui/`; `GOOS=linux go vet -tags nogui ./internal/gui/`; `GOOS=windows go vet ./internal/gui/` | clean |
| `go build ./...` (darwin/arm64); `GOOS=windows GOARCH=amd64 go build ./...` | clean |
| `GOOS=linux GOARCH=amd64 go build ./...` | fails inside `wails v3.0.0-beta.24` (`undefined: pointer` in `pkg/application`) — fails the same on upstream/main, dependency-side, not a baseline |
| Ablation | removing the `nav-masking` rule turns "the two trade places as one motion" red (`the masking tab has a view-transition-name of its own (none)`); restored, green |
| Re-verified on upstream/main `c736906b1` | the branch was created on it (no rebase needed); `git am` of the posted patch on a fresh checkout of `c736906b1` reproduces the tree exactly |

**Not verified**: how the morph actually looks on the desktop shells (macOS WebKit / Windows WebView2) — the Playwright runs cover the engines through a stub API layer, not the packaged apps; the reporter's eye on their machine is the last word. The Linux app runs no morph by design (`body.linux`), so there is nothing to see there.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

Generated-by: GLM-5.3-Flash (ZCode)
