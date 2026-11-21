@yetone Following up on the sweep from this issue: the guard `nav-timeout.test.cjs` is red on `main` again (46b10af87, and still at today's 30b7a1732). Five test files added or reworked after the sweep set a short default timeout without a navigation timeout, so the guard lists all five under "every page with a short default timeout loads with a minute's room": `accounts-own-signin`, `accounts-switch-alone`, `agent-details-ready`, `icon-one-tone`, `provider-retrieval-only`.

**Root cause**: the guard (`internal/gui/tests/nav-timeout.test.cjs:16-26`) scans every `.cjs` in `internal/gui/tests/` and requires each page whose `setDefaultTimeout` is under 60s to also carry a `setDefaultNavigationTimeout` of at least 60s. The five files set the short default (`accounts-own-signin.test.cjs:57`, `accounts-switch-alone.test.cjs:55`, `agent-details-ready.test.cjs:24`, `icon-one-tone.test.cjs:118`, `provider-retrieval-only.test.cjs:51`) but none carries the navigation line, so on a busy machine their first `page.goto`/reload dies at the 5s (or 8s) bar.

**The fix**: the same one line the sweep's own commits (5b1709eee, fcf87a785) added everywhere else — `page.setDefaultNavigationTimeout(60000);` beside each short default. Test-only, five insertions, no product code touched.

<details><summary>patch: test(gui): five newer pages get the navigation's minute (#4470) — git am applies it as is; SHA-256 first 16: 47b98fdae251a017</summary>

```text
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sun, 8 Nov 2026 02:36:16 +0800
Subject: [PATCH] test(gui): five newer pages get the navigation's minute
 (#4470)

nav-timeout.test.cjs (ce8b67de3) holds every page with a short
default timeout to a 60s navigation timeout, and it is red on main
(46b10af87): accounts-own-signin, accounts-switch-alone,
agent-details-ready, icon-one-tone and provider-retrieval-only were
added after the sweep without one, so the guard lists all five
("every page with a short default timeout loads with a minute's
room"). Each now sets setDefaultNavigationTimeout(60000) beside its
short default, the same one line the sweep's own commits
(5b1709eee, fcf87a785) added elsewhere.

Test-only, so no tag. Follow-up to #4470's sweep.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gui/tests/accounts-own-signin.test.cjs     | 1 +
 internal/gui/tests/accounts-switch-alone.test.cjs   | 1 +
 internal/gui/tests/agent-details-ready.test.cjs     | 1 +
 internal/gui/tests/icon-one-tone.test.cjs           | 1 +
 internal/gui/tests/provider-retrieval-only.test.cjs | 1 +
 5 files changed, 5 insertions(+)

diff --git a/internal/gui/tests/accounts-own-signin.test.cjs b/internal/gui/tests/accounts-own-signin.test.cjs
index aeeb09ee7..9a01b176d 100644
--- a/internal/gui/tests/accounts-own-signin.test.cjs
+++ b/internal/gui/tests/accounts-own-signin.test.cjs
@@ -55,6 +55,7 @@ for (const engine of engines) {
         t.after(() => browser.close());
         const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
         page.setDefaultTimeout(5000);
+        page.setDefaultNavigationTimeout(60000);
         const errors = [];
         page.on("pageerror", (e) => errors.push(e.message));
         await page.route("**/*", serve(lang));
diff --git a/internal/gui/tests/accounts-switch-alone.test.cjs b/internal/gui/tests/accounts-switch-alone.test.cjs
index 0581921f6..476efd5a9 100644
--- a/internal/gui/tests/accounts-switch-alone.test.cjs
+++ b/internal/gui/tests/accounts-switch-alone.test.cjs
@@ -53,6 +53,7 @@ for (const engine of engines) {
         t.after(() => browser.close());
         const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
         page.setDefaultTimeout(5000);
+        page.setDefaultNavigationTimeout(60000);
         const errors = [];
         page.on("pageerror", (e) => errors.push(e.message));
         await page.route("**/*", serve(lang));
diff --git a/internal/gui/tests/agent-details-ready.test.cjs b/internal/gui/tests/agent-details-ready.test.cjs
index 881ebf611..3c03a258e 100644
--- a/internal/gui/tests/agent-details-ready.test.cjs
+++ b/internal/gui/tests/agent-details-ready.test.cjs
@@ -22,6 +22,7 @@ async function openPage(t, engine, lang = "en", width = 1180, reducedMotion = "n
   const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
   const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion });
   page.setDefaultTimeout(8000);
+  page.setDefaultNavigationTimeout(60000);
   const errors = [], settingsAsked = held(), settings = held(), compactAsked = held(), compact = held();
   t.after(async () => { settings.release(); compact.release(); await browser.close(); });
   let reads = 0, fail = false;
diff --git a/internal/gui/tests/icon-one-tone.test.cjs b/internal/gui/tests/icon-one-tone.test.cjs
index d076913c3..080eb29d5 100644
--- a/internal/gui/tests/icon-one-tone.test.cjs
+++ b/internal/gui/tests/icon-one-tone.test.cjs
@@ -116,6 +116,7 @@ for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium",
       await t.test(`${theme} ${lang} ${width}`, async () => {
         const page = await (await browser.newContext({ viewport: { width, height: 820 } })).newPage();
         page.setDefaultTimeout(5000);
+        page.setDefaultNavigationTimeout(60000);
         const errors = [];
         page.on("pageerror", (e) => errors.push(e.message));
         await page.route("**/*", server(lang, theme));
diff --git a/internal/gui/tests/provider-retrieval-only.test.cjs b/internal/gui/tests/provider-retrieval-only.test.cjs
index 1e07c0dfb..8e273287e 100644
--- a/internal/gui/tests/provider-retrieval-only.test.cjs
+++ b/internal/gui/tests/provider-retrieval-only.test.cjs
@@ -49,6 +49,7 @@ for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium",
       await t.test(`${lang}, ${retrieval} retrieval`, async () => {
         const page = await (await browser.newContext({ viewport: { width: 900, height: 760 }, reducedMotion: "reduce" })).newPage();
         page.setDefaultTimeout(5000);
+        page.setDefaultNavigationTimeout(60000);
         const errors = [];
         page.on("pageerror", (e) => errors.push(e.message));
         await page.route("**/*", server(lang, [relay(retrieval)], retrieval));
-- 
2.50.1 (Apple Git-155)

```

</details>

**Branch with the commit**: [`fix/nav-guards-5files`](https://github.com/ggbdpq/magpie/tree/fix/nav-guards-5files) (head `0a4788f1f6ae7cf98020877122eb2eb61459185e`), rebased onto current `upstream/main` (30b7a1732); on a fresh checkout `git am` applies clean.

| Check | Result |
| --- | --- |
| `every page with a short default timeout loads with a minute's room` (nav-timeout.test.cjs, the guard itself) | red before the fix (all five files listed), pass after; re-run green after the rebase |
| `icon-one-tone.test.cjs` (chromium and webkit, both themes, every language, 980px and 420px) | 48/48 pass |
| `provider-retrieval-only.test.cjs` (chromium and webkit) | 23/23 pass |
| `accounts-own-signin.test.cjs` (chromium and webkit, every language, 1000px and 560px) | 20/20 pass |
| `accounts-switch-alone.test.cjs` (chromium and webkit, every language, 1000px and 560px) | 20/20 pass |
| `agent-details-ready.test.cjs` (chromium and webkit) | 36/36 pass |
| `go test -tags nogui ./...`, `gofmt`, `go vet`, `go build` | not run — the patch touches five `.cjs` test files only, no Go code |
| Ablation | reverting the five files to their pre-fix state turns the guard red again (all five listed); restored, green |
| Re-verified on upstream/main `30b7a1732` | rebased onto it and re-ran the guard, green at the new head |

**Not verified**: the guard's own scenario — a whole-suite run on a busy machine where app.js serves late — was not reproduced here (macOS, playwright 1.57.0, chromium and webkit headless); the guard test itself is what locks that behavior, and it is red before the patch and green after. The WSL/Linux full-suite run the original sweep used was not run.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

Generated-by: GLM-5.3-Flash (ZCode)
