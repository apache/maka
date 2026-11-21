A balance part asked as a percent now reads the way every window does: Left says what is left of it and fills the bar with that, Used keeps the share the reply reported.

**Summary**

With the Left/Used switch on Left, subscription windows read "… left", but a custom provider's balance meter stayed on the used share, its figure and its bar alike: `balance.path` "Daily: windows.0.used / 100%" gave "Daily 8.9%" with an 8.9% bar while every window showed what is left of it. The two places that render a balance part — the tray panel's balance card (`panelBalances`) and the Usage page's balance row (`balanceRow`) — handed `percent` to `balanceMeter` and drew the part's figure as the reply had it; neither reads the switch.

**What changed**

`balanceMeter` fills with `quotaLeft ? 100 - used : used`, the same share `quotaFill` gives a window, and keeps its nearly-full colour keyed to the used share, the meter warning either way. A new `balanceText` beside it says a percent part's figure: on Left, "91.1% left" through the "{n} left" wording every language already has; on Used, the figure as the reply had it. `panelBalances` and `balanceRow` put their parts through the two. A part without a `percent` (money, counts) is untouched, and the Go side's `BalancePart` keeps its `Text` and `Percent` as they were — the balance line, the tooltip and the history still say the reply's number; the switch is a rendering choice, so it is made where the windows' own one is.

**The test**

`balance-quota-left.test.cjs`, new, on the house style (Node's test runner and Playwright, no backend, the API faked): the reporter's percent balance, credits beside windows nearly full, and a money part, on the Usage page and the panel's Allowances tab, in English and Chinese, Left and Used — the figure, the bar's fill, the nearly-full colour by the used share in both displays, and money's figure and absent meter unchanged.

**Verification**

| Check | Result |
| --- | --- |
| `balance-quota-left.test.cjs` (new), Chromium, en and zh, Left and Used, Usage page and panel | 4/4 green |
| The same test at this fix's parent | red: the Left run waited 5 s for "91.1% left" and timed out on the figure the page never showed |
| The fix reverted at the tree, then restored | red again, then green |
| `panel-balance-order`, `quota-balance-error`, `balance-parts`, `panel-usage`, `routing-quota-left`, `usage-quota-head`, `quota-pools` (Chromium) | 30/30 green |
| `go test -tags nogui ./internal/gui` | `TestProxyCheckSaysAProxyPassedBy` red, pre-existing (red at the parent too); the rest of the package ok |
| `gofmt -l` | clean |
| `go vet ./...`; `GOOS=linux go vet -tags nogui ./...`; `GOOS=windows go vet -tags nogui ./...` | exit 0 (a pre-existing cgo enum warning in `trayimage_darwin.go`, at the parent too) |
| `go build -tags nogui`, darwin, linux/amd64, windows/amd64 | exit 0 |

**Not verified**

WebKit, the suite's other engine: only Chromium is installed on this machine, so every browser run here is Chromium. No real provider's balance endpoint: the meters read the reporter's reproduction shape, mocked at the API. The Go suites beyond `internal/gui` were not run; no Go file changes.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: usage: a custom provider's balance percent reads as Left or Used, as a window's does (#3193) — git am applies it as is; SHA-256 first 16: ecc4e6b2b6a0e830</summary>

```patch
From 579942e679de66090299ba73f8c071a9f9bfb89c Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Thu, 22 Oct 2026 06:07:56 +0800
Subject: [PATCH] usage: a custom provider's balance percent reads as Left or
 Used, as a window's does

The Left/Used switch turned every subscription window, but a custom
provider's balance meter stayed on the used share, its figure and its
bar alike (#3193): with balance.path "Daily: windows.0.used / 100%" the
card read "Daily 8.9%" with an 8.9% bar while Left showed every window
as what is left of it. Windows go through quotaFill/quotaText, which do
quotaLeft ? 100 - used : used; the two places that render a balance part
handed the percent to balanceMeter and drew the part's figure as the
reply had it, and neither reads the switch.

A part asked as a percent now reads the way a window does: on Left the
figure says what is left of it ("91.1% left", the "{n} left" wording
every language already has) and the bar fills with that; on Used the
figure and the bar are as the reply had them. The nearly-full colour
keeps to the used share, the meter warning either way. A part without a
percent (money, counts) is untouched, and the Go side's BalancePart
keeps its Text and Percent as they were: the balance line, the tooltip
and the history still say the reply's number, and the switch is a
rendering choice, so it is made where the windows' own one is.

balanceMeter fills with the switched share and colours by the used one;
balanceText, beside it, says a percent part's figure. panelBalances and
balanceRow, the tray panel's balance card and the Usage page's balance
row, put their parts through them.

Ran: balance-quota-left.test.cjs, new, on Chromium, en and zh, Left and
Used, the Usage page and the panel's Allowances tab. At this fix's
parent, red: the Left run waited 5s for "91.1% left" and timed out on
the figure the page never showed. At this head, green: the figure, the
bar's fill, the nearly-full colour on by the used share in both
displays, and a money part's figure and absent meter unchanged. With the
fix reverted at the tree the run went red again, and green once more
when restored. panel-balance-order, quota-balance-error, balance-parts,
panel-usage, routing-quota-left, usage-quota-head and quota-pools, 30
tests, green. go test -tags nogui ./internal/gui: TestProxyCheckSays
AProxyPassedBy red, as it is at the parent; the rest of the package ok.
gofmt -l clean. go vet ./... and GOOS=linux and GOOS=windows go vet
-tags nogui ./... clean (a cgo enum warning in trayimage_darwin.go, at
the parent too). go build -tags nogui on darwin, linux/amd64 and
windows/amd64 ok.

Fixes #3193

Reported by pc418 in #3193.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gui/assets/app.js                    |  29 +++--
 .../gui/tests/balance-quota-left.test.cjs     | 123 ++++++++++++++++++
 2 files changed, 144 insertions(+), 8 deletions(-)
 create mode 100644 internal/gui/tests/balance-quota-left.test.cjs

diff --git a/internal/gui/assets/app.js b/internal/gui/assets/app.js
index 1d6fdbdd..6e6d0648 100644
--- a/internal/gui/assets/app.js
+++ b/internal/gui/assets/app.js
@@ -16987,14 +16987,14 @@ function panelBalances(bals) {
     const parts = balanceShown(q) || [{ text: q.balance }];
     for (const [i, p] of parts.entries()) {
       let amount;
-      if (!i && !p.label) card.append(amount = el("b", "pq-amt", p.text));
+      if (!i && !p.label) card.append(amount = el("b", "pq-amt", balanceText(p)));
       else if (!i) {
         amount = el("span", "pq-lead");
-        amount.append(el("b", "pq-amt", p.text), el("span", "", p.label));
+        amount.append(el("b", "pq-amt", balanceText(p)), el("span", "", p.label));
         card.append(amount);
       } else {
         amount = el("span", "pq-sub pq-bp");
-        amount.append(el("span", "", p.label || ""), el("b", "", p.text));
+        amount.append(el("span", "", p.label || ""), el("b", "", balanceText(p)));
         card.append(amount);
       }
       // an amount the reply hadn't, "—": why, on hover (#1993)
@@ -17800,7 +17800,7 @@ function balanceRow(sub, why, when = true) {
   if (!parts?.length) b.append(el("span", "", t("Balance")), el("b", "", sub.balance));
   for (const [i, p] of (parts || []).entries()) {
     const row = el("div", "bal-part" + (i ? "" : " lead"));
-    row.append(el("span", "", p.label || (i ? "" : t("Balance"))), el("b", "", p.text));
+    row.append(el("span", "", p.label || (i ? "" : t("Balance"))), el("b", "", balanceText(p)));
     // an amount the reply hadn't, "—": why, on hover (#1993)
     if (p.error) row.title = p.error;
     if (p.percent != null) row.append(balanceMeter(p.percent));
@@ -17821,16 +17821,29 @@ function balanceShown(q) {
   return [{ text: q.balance }, ...q.balanceSplit.map((p) => ({ ...p, label: t(p.label) }))];
 }
 
-// balanceMeter: a balance field's percent, as a meter.
+// balanceMeter: a balance field's percent, as a meter. The bar fills the
+// way every window's does (#3193): what is left when the display says
+// Left, the share used on Used; the nearly-full colour keeps to the used
+// share, the meter warning either way.
 function balanceMeter(percent) {
-  const share = Math.max(0, Math.min(100, percent));
-  const track = el("div", "quota-track" + (share >= 90 ? " full" : ""));
+  const used = Math.max(0, Math.min(100, percent));
+  const track = el("div", "quota-track" + (used >= 90 ? " full" : ""));
   const fill = el("i");
-  fill.style.width = share + "%";
+  fill.style.width = (quotaLeft ? 100 - used : used) + "%";
   track.append(fill);
   return track;
 }
 
+// balanceText: a balance part's figure. One asked as a percent reads as a
+// window's does (#3193): Left says what is left of it, "91.1% left", Used
+// the share used as the reply had it. An amount without a percent (money,
+// counts) is as it was.
+function balanceText(p) {
+  if (p.percent == null || !quotaLeft) return p.text;
+  const n = 100 - Math.max(0, Math.min(100, p.percent));
+  return t("{n} left", { n: (Number.isInteger(n) ? n : n.toFixed(1)) + "%" });
+}
+
 // readWhen: when a card's figures were read, quietly under them: "As of
 // …" for one standing in for a reading that failed just now, else how
 // long ago, kept current. On the Usage page (refresh) the card's own
diff --git a/internal/gui/tests/balance-quota-left.test.cjs b/internal/gui/tests/balance-quota-left.test.cjs
new file mode 100644
index 00000000..4f4a122a
--- /dev/null
+++ b/internal/gui/tests/balance-quota-left.test.cjs
@@ -0,0 +1,123 @@
+// Run with Node's test runner and Playwright on the module path; see README.md.
+// A balance part asked as a percent reads as every window does (#3193, にとり):
+// with Allowance display on Left its figure says what is left of it and its
+// bar fills with that, on Used the share used; the nearly-full colour keeps
+// to the used share either way; an amount without a percent (money) is as it
+// was. The tray panel's balance card and the Usage page's balance row alike.
+// No backend, the API is faked here.
+const assert = require("node:assert/strict");
+const fs = require("node:fs/promises");
+const path = require("node:path");
+const { test } = require("node:test");
+const { chromium, webkit } = require("playwright");
+
+const assets = path.resolve(__dirname, "../assets");
+
+const quotas = [
+  // the reporter's: a custom provider whose balance path reads a daily
+  // allowance as a percent used
+  { provider: "custom", name: "Custom", icon: "generic", user: "me@example.com", balance: "Daily 8.9%",
+    balanceParts: [{ label: "Daily", text: "8.9%", percent: 8.9 }], windows: [] },
+  // credits beside windows, nearly full: the bar's colour stays keyed to
+  // the used share
+  { provider: "cc", name: "Command Code", icon: "generic", user: "cc@example.com", balance: "Credits 95%",
+    balanceParts: [{ label: "Credits", text: "95%", percent: 95 }], windows: [{ name: "5-hour", used: 30 }] },
+  // money: no percent, the switch leaves it as it is
+  { provider: "money", name: "Money", icon: "generic", user: "m@example.com", balance: "$12.00",
+    balanceParts: [{ label: "Credit", text: "$12.00" }], windows: [] },
+];
+
+function serve(lang, left) {
+  const settings = { theme: "light", lang, tray: "panel", quotaLeft: left, currency: "usd" };
+  return async (route) => {
+    const url = new URL(route.request().url());
+    const json = (body) => route.fulfill({ json: body });
+    if (url.pathname === "/boot.js") return route.fulfill({ contentType: "text/javascript", body: `window.bootPrefs = {lang:"${lang}",theme:"light",web:true};` });
+    if (url.pathname === "/wails/runtime.js") return route.fulfill({ contentType: "text/javascript", body: "export const Window = {};" });
+    if (url.pathname === "/api/state") return json({ agents: [], profiles: [], settings });
+    if (url.pathname === "/api/settings") return json(settings);
+    if (url.pathname === "/api/providers") return json({ providers: [], presets: [], excluded: [], gateway: { running: true, window: true } });
+    if (url.pathname === "/api/usage/quotas") return json(quotas);
+    if (url.pathname === "/api/usage/quotas/history") return json([]);
+    if (url.pathname === "/api/usage") return json({ days: [] });
+    if (url.pathname === "/api/groups") return json({ groups: [], models: [] });
+    if (url.pathname === "/api/plugins") return json({ plugins: [] });
+    if (url.pathname.startsWith("/api/")) return json({});
+    const file = path.join(assets, url.pathname === "/" ? "index.html" : url.pathname);
+    const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(file)];
+    try { await route.fulfill({ body: await fs.readFile(file), contentType }); } catch { await route.fulfill({ status: 404, body: "" }); }
+  };
+}
+
+// said: the figure a part shows, en and zh, by the display and the share used
+const said = {
+  en: {
+    true: { daily: "91.1% left", credits: "5% left" },
+    false: { daily: "8.9%", credits: "95%" },
+  },
+  zh: {
+    true: { daily: "剩余 91.1%", credits: "剩余 5%" },
+    false: { daily: "8.9%", credits: "95%" },
+  },
+};
+
+const width = {
+  true: { daily: "91.1%", credits: "5%" },
+  false: { daily: "8.9%", credits: "95%" },
+};
+
+for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"])) {
+  for (const lang of ["en", "zh"]) {
+    for (const left of [true, false]) {
+      test(`${engine} ${lang}: a balance part asked as a percent reads ${left ? "left" : "used"}`, async (t) => {
+        const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
+        t.after(() => browser.close());
+        const errors = [];
+        const part = (page, card, word) => page.locator(card, { hasText: word }).locator(".bal-part", { hasText: word.split(" ")[0] }).first();
+        const figure = (row) => row.locator("b").textContent();
+        const fill = (row) => row.locator(".quota-track i").evaluate((i) => i.style.width);
+        const nearlyFull = (row) => row.locator(".quota-track").evaluate((track) => track.classList.contains("full"));
+
+        // the Usage page: every balance row
+        const page = await (await browser.newContext({ viewport: { width: 900, height: 800 }, reducedMotion: "reduce" })).newPage();
+        page.setDefaultTimeout(5000);
+        page.on("pageerror", (e) => errors.push(e.message));
+        await page.route("**/*", serve(lang, left));
+        await page.goto("http://magpie.test/?view=usage&tab=usage");
+        await page.waitForFunction(() => document.querySelectorAll("#subscriptionUsage > [data-key]").length >= 3);
+        assert.equal(await figure(part(page, ".subscription-card", said[lang][left].daily)), said[lang][left].daily);
+        assert.equal(await fill(part(page, ".subscription-card", said[lang][left].daily)), width[left].daily);
+        assert.equal(await figure(part(page, ".subscription-card", said[lang][left].credits)), said[lang][left].credits);
+        assert.equal(await fill(part(page, ".subscription-card", said[lang][left].credits)), width[left].credits);
+        // nearly full by the used share, whichever way the meter reads
+        assert.equal(await nearlyFull(part(page, ".subscription-card", said[lang][left].credits)), true);
+        const money = page.locator(".subscription-card", { hasText: "Money" }).locator(".bal-part", { hasText: "Credit" });
+        assert.equal(await figure(money), "$12.00");
+        assert.equal(await money.locator(".quota-track").count(), 0, "money takes no meter");
+
+        // the tray panel's Allowances tab: the same words
+        const context = await browser.newContext({ viewport: { width: 380, height: 640 }, reducedMotion: "reduce" });
+        await context.addInitScript(() => { try { localStorage.setItem("magpie.panelTab", "usage"); } catch {} });
+        const panel = await context.newPage();
+        panel.setDefaultTimeout(5000);
+        panel.on("pageerror", (e) => errors.push(e.message));
+        await panel.route("**/*", serve(lang, left));
+        await panel.goto("http://magpie.test/?mode=panel");
+        const daily = panel.locator(".pq-card.bal", { hasText: "Custom" });
+        await daily.waitFor();
+        assert.equal(await figure(daily.locator(".pq-lead")), said[lang][left].daily);
+        assert.equal(await fill(daily), width[left].daily);
+        // the panel's card shows the account, its name only in the tooltip
+        const credits = panel.locator(".pq-card", { hasText: "cc@example.com" }).locator(".quota-balance .bal-part", { hasText: "Credits" });
+        await credits.waitFor();
+        assert.equal(await figure(credits), said[lang][left].credits);
+        assert.equal(await fill(credits), width[left].credits);
+        const cash = panel.locator(".pq-card.bal", { hasText: "Money" });
+        assert.equal(await cash.locator(".pq-lead b").textContent(), "$12.00");
+        assert.equal(await cash.locator(".quota-track").count(), 0, "money takes no meter");
+        assert.deepEqual(errors, []);
+        await context.close();
+      });
+    }
+  }
+}
-- 
2.50.1 (Apple Git-155)

```

</details>

Branch with the commit: [hunt60-a-3193-balance-toggle](https://github.com/ggbdpq/magpie/tree/hunt60-a-3193-balance-toggle) (head `579942e679de66090299ba73f8c071a9f9bfb89c`).
