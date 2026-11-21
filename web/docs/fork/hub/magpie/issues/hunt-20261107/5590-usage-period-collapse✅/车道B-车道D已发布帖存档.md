@yetone reported by @cgsme: on the Usage page, a card of several Codex accounts reads the same 7-day bar as "100% left" while the account is folded and "57% left" once it is expanded — the fold silently switches the bar between the current quota and the recorded cycle the reader picked on the curve (their expanded view had the Nov 3 – Nov 5 cycle picked, whose last sample reads 57%; their Prolite account, with no pick, stayed at 79% throughout). Folding and unfolding should only change how much of the card is shown, not which readings the bar draws.

**Root cause**: the period an account's meters draw is decided once in `renderQuotas` (internal/gui/assets/app.js, `const history = !brief && quotaHistoryView(sub)` at L15993 on the current tip): `!brief` forces a folded account back onto `familyQuota(sub)`, this week's readings, while the expanded card draws `quotaHistoryCard(sub, history)`, the picked cycle's last samples (#2009). The pick lives in `quotaCyclePicks` and survives the fold — `usageAcctFold`/`usageMore` only toggle `magpie.usageAccounts` — so the same bar reads this week folded and the recorded week expanded, with nothing saying so.

**The fix**: the picked cycle follows the account into brief — `const history = quotaHistoryView(sub)` — so both views draw the same source and the fold only tidies the card, following the reporter's own expectation that the bar keeps the selected period. The brief bars keep their tooltips, which date a history reading as "Last reading {when}" (the brief view's design puts timing in the tooltip). An account with no pick keeps its current figures either way, and returning to this cycle on the curve restores them in both views.

<details><summary>patch: usage: folding an account keeps the recorded cycle its meters picked (#5590) — git am applies it as is; SHA-256 first 16: 1055a08e23db4136</summary>

```text
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sat, 7 Nov 2026 22:12:41 +0800
Subject: [PATCH] usage: folding an account keeps the recorded cycle its meters
 picked (#5590)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

A card of several accounts reads its folded rows off the current quota,
whatever cycle the reader picked on the account's curve: the same bar
said 100% left folded and 57% left expanded, the fold moving between
this week's readings and the recorded cycle's without saying so (the
expanded view's meters, legend and curve all follow the pick, cgsme's
two Codex accounts). The picked cycle follows the account into brief
now — the fold only tidies the card, the bars keep the cycle's last
readings, their tooltips dating them; an account with no pick keeps its
current figures either way. usage-fold-cycle draws the reporter's shape
(two Codex accounts, a recorded week at 57, this week at 100, fold and
unfold, another account unmoved, back to this cycle); it fails on the
old code (the folded bar back at 100%).

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gui/assets/app.js                   |   3 +-
 internal/gui/tests/usage-fold-cycle.test.cjs | 169 +++++++++++++++++++
 2 files changed, 171 insertions(+), 1 deletion(-)
 create mode 100644 internal/gui/tests/usage-fold-cycle.test.cjs

diff --git a/internal/gui/assets/app.js b/internal/gui/assets/app.js
index ba67260c8..a37437e67 100644
--- a/internal/gui/assets/app.js
+++ b/internal/gui/assets/app.js
@@ -15990,7 +15990,8 @@ function renderQuotas(lazy) {
       // "Every model" by the account, or the card's name: where the click
       // was, whichever way the meters under it grow or shrink
       const brief = several && !usageAcctOpen(sub, subs);
-      const history = !brief && quotaHistoryView(sub);
+      // the fold doesn't move a picked cycle's meters back to this week's (#5590)
+      const history = quotaHistoryView(sub);
       const shownSub = history ? quotaHistoryCard(sub, history) : sub;
       const [meters, every] = history ? [quotaWindows(shownSub), null] : familyQuota(sub);
       if (sub.user) {
diff --git a/internal/gui/tests/usage-fold-cycle.test.cjs b/internal/gui/tests/usage-fold-cycle.test.cjs
new file mode 100644
index 000000000..ebb4a95df
--- /dev/null
+++ b/internal/gui/tests/usage-fold-cycle.test.cjs
@@ -0,0 +1,169 @@
+// Run with Node's test runner and Playwright on the module path; see README.md.
+// A card of several accounts, one of them showing a recorded cycle picked on
+// its curve (#5590): folding the account used to switch its meters back to
+// the current quota — the same bar read 100% left folded and 57% left
+// expanded, the fold moving between current and history readings without
+// saying so. The picked cycle now follows the account into brief and back;
+// an account with no pick keeps its current figures either way, and the
+// other account's readings don't move. English; no backend, the API is
+// faked here.
+const assert = require("node:assert/strict");
+const fs = require("node:fs/promises");
+const path = require("node:path");
+const { test } = require("node:test");
+const { chromium, webkit } = require("playwright");
+
+const assets = path.resolve(__dirname, "../assets");
+const H = 3600e3, D = 24 * H;
+const iso = (ms) => new Date(ms).toISOString();
+
+function fixtures(now) {
+  const r5 = now + 2 * H, rw = now + 2 * D;
+  // the reporter's two Codex accounts: Plus (read 100% / 100% now) and
+  // Prolite (79% on the week), one card, so each can fold on its own
+  const quotas = [
+    { provider: "codex", name: "Codex", icon: "openai", plan: "Plus", user: "plus@x.com", readAt: iso(now), windows: [
+      { name: "5 hours", used: 0, resetsAt: iso(r5) },
+      { name: "Weekly", used: 0, resetsAt: iso(rw) },
+    ] },
+    { provider: "codex", name: "Codex", icon: "openai", plan: "Prolite", user: "lite@x.com", lastServedAt: iso(now), readAt: iso(now), windows: [
+      { name: "5 hours", used: 0, resetsAt: iso(r5) },
+      { name: "Weekly", used: 21, resetsAt: iso(rw) },
+    ] },
+  ];
+  // Plus's week: a recorded week that ended at 57 left, then this week at 100
+  const week = [
+    { at: iso(now - 12 * D), left: 90, start: iso(now - 12 * D), resetsAt: iso(now - 5 * D) },
+    { at: iso(now - 8 * D), left: 57, start: iso(now - 12 * D), resetsAt: iso(now - 5 * D) },
+    { at: iso(now - 4 * D), left: 100, start: iso(now - 5 * D), resetsAt: iso(rw) },
+    { at: iso(now - H), left: 100, start: iso(now - 5 * D), resetsAt: iso(rw) },
+  ];
+  // Plus's 5 hours: one reading inside the recorded week, at 100
+  const five = [
+    { at: iso(now - 10 * D), left: 100, start: iso(now - 10 * D - 3 * H), resetsAt: iso(now - 10 * D + 2 * H) },
+    { at: iso(now - H), left: 100, start: iso(r5 - 5 * H), resetsAt: iso(r5) },
+  ];
+  const history = [
+    { provider: "codex", user: "plus@x.com", lines: [{ name: "5 hours", points: five }, { name: "Weekly", points: week }] },
+  ];
+  return { quotas, history };
+}
+
+function serve(lang, data) {
+  // the reporter reads the bars as what is left of each window
+  const settings = { theme: "light", lang, tray: "panel", quotaLeft: true, currency: "usd" };
+  return async (route) => {
+    const url = new URL(route.request().url());
+    const json = (body) => route.fulfill({ json: body });
+    if (url.pathname === "/boot.js") return route.fulfill({ contentType: "text/javascript", body: `window.bootPrefs = {lang:"${lang}",theme:"light",web:true};` });
+    if (url.pathname === "/wails/runtime.js") return route.fulfill({ contentType: "text/javascript", body: "export const Window = {};" });
+    if (url.pathname === "/api/state") return json({ agents: [], profiles: [], settings });
+    if (url.pathname === "/api/settings") return json(settings);
+    if (url.pathname === "/api/providers") return json({ providers: [], presets: [], excluded: [], gateway: { running: true, window: true } });
+    if (url.pathname === "/api/usage/quotas") return json(data.quotas);
+    if (url.pathname === "/api/usage/quotas/history") return json(data.history);
+    if (url.pathname === "/api/usage/quotas/history/holds") return json([]);
+    if (url.pathname.startsWith("/api/")) return json({});
+    const file = path.join(assets, url.pathname === "/" ? "index.html" : url.pathname);
+    const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(file)];
+    try { await route.fulfill({ body: await fs.readFile(file), contentType }); } catch { await route.fulfill({ status: 404, body: "" }); }
+  };
+}
+
+// the Weekly meter (the second quota) of the nth account's meters on the
+// Codex card: which view it is in, its fill, its figure, and whether its
+// reset row speaks of a cycle that ended
+const weekly = (page, n) => page.evaluate((n) => {
+  const m = document.querySelectorAll('.subscription-card[data-key="codex"] .quota-windows')[n];
+  const q = m?.querySelectorAll(".quota")[1];
+  if (!m || !q) return null;
+  return {
+    brief: m.classList.contains("brief"),
+    fill: q.querySelector(".quota-track i")?.style.width ?? "",
+    text: q.querySelector(".quota-n")?.textContent ?? "",
+    ended: (q.querySelector(".quota-reset")?.textContent ?? "").startsWith("Cycle ended"),
+    title: q.title ?? "",
+  };
+}, n);
+const wantWeekly = (brief, fill, left, ended) => ({ brief, fill, text: `${left}% left`, ended });
+const fields = (got) => got && { brief: got.brief, fill: got.fill, text: got.text, ended: got.ended };
+async function settles(page, n, want, what) {
+  try {
+    await page.waitForFunction(([n, want]) => {
+      const m = document.querySelectorAll('.subscription-card[data-key="codex"] .quota-windows')[n];
+      const q = m?.querySelectorAll(".quota")[1];
+      if (!m || !q) return false;
+      return m.classList.contains("brief") === want.brief
+        && (q.querySelector(".quota-track i")?.style.width ?? "") === want.fill
+        && (q.querySelector(".quota-n")?.textContent ?? "").includes(want.text)
+        && (q.querySelector(".quota-reset")?.textContent ?? "").startsWith(want.ended ? "Cycle ended" : "Resets");
+    }, [n, want], { timeout: 4000 });
+  } catch {
+    assert.ok(false, `${what}: expected ${JSON.stringify(want)}, got ${JSON.stringify(await weekly(page, n))}`);
+  }
+  return weekly(page, n);
+}
+
+for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"])) {
+  test(`${engine}: folding an account keeps the recorded cycle it picked (#5590)`, async (t) => {
+    const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
+    t.after(() => browser.close());
+    const context = await browser.newContext({ viewport: { width: 720, height: 900 }, reducedMotion: "reduce" });
+    const page = await context.newPage();
+    page.setDefaultTimeout(5000);
+    const errors = [];
+    page.on("pageerror", (e) => errors.push(e.message));
+    const now = Date.now();
+    await page.route("**/*", serve("en", fixtures(now)));
+    await page.goto("http://magpie.test/?view=usage");
+    const card = page.locator('.subscription-card[data-key="codex"]');
+    await card.locator(".subscription-account").first().waitFor();
+
+    // Plus (first, not the one served last) starts folded, reading this
+    // week: 100% left — the reporter's collapsed baseline
+    assert.deepEqual(fields(await weekly(page, 0)), wantWeekly(true, "100%", 100, false), "Plus folded reads this week at first");
+    assert.deepEqual(fields(await weekly(page, 1)), wantWeekly(false, "79%", 79, false), "Prolite reads its own week");
+
+    // expand Plus: still this week, no cycle picked yet
+    await card.locator(".subscription-account").filter({ hasText: "plus@x.com" }).locator(".quota-acct-fold").click();
+    await settles(page, 0, wantWeekly(false, "100%", 100, false), "expanded with no pick");
+
+    // pick the recorded week on Plus's curve; its meters follow it: 57% left,
+    // the cycle's end said, the reading's date in the tooltip
+    const curve = card.locator(".quota-curve").nth(0);
+    await curve.locator(".qc-range").click();
+    const items = page.locator(".sess-menu .pm-item");
+    assert.equal(await items.count(), 2, "this cycle and the one recorded week");
+    await items.nth(1).click();
+    await settles(page, 0, wantWeekly(false, "57%", 57, true), "expanded on the recorded week");
+    assert.ok((await weekly(page, 0)).title.includes("Last reading"), "the tooltip dates the reading");
+
+    // folding switches nothing about the figures: the brief bars are the
+    // picked cycle's, the fold only tidies the card (#5590)
+    await card.locator(".subscription-account").filter({ hasText: "plus@x.com" }).locator(".quota-acct-fold").click();
+    const brief = await settles(page, 0, wantWeekly(true, "57%", 57, true), "folded keeps the picked cycle");
+    assert.equal(brief.brief, true, "the folded account's meters are the brief ones");
+    assert.deepEqual(fields(await weekly(page, 1)), wantWeekly(false, "79%", 79, false), "Prolite unmoved by the fold");
+
+    // and unfolding reads the same 57% again, folded and unfolded once more
+    await card.locator(".subscription-account").filter({ hasText: "plus@x.com" }).locator(".quota-acct-fold").click();
+    await settles(page, 0, wantWeekly(false, "57%", 57, true), "unfolded keeps the picked cycle");
+    await card.locator(".subscription-account").filter({ hasText: "plus@x.com" }).locator(".quota-acct-fold").click();
+    await settles(page, 0, wantWeekly(true, "57%", 57, true), "folded again keeps the picked cycle");
+
+    // back to this cycle: both views read it, no cycle's end said
+    await card.locator(".subscription-account").filter({ hasText: "plus@x.com" }).locator(".quota-acct-fold").click();
+    await settles(page, 0, wantWeekly(false, "57%", 57, true), "expanded before returning");
+    await card.locator(".quota-curve").nth(0).locator(".qc-range").click();
+    await page.locator(".sess-menu .pm-item").first().click();
+    await settles(page, 0, wantWeekly(false, "100%", 100, false), "back on this cycle, expanded");
+    await card.locator(".subscription-account").filter({ hasText: "plus@x.com" }).locator(".quota-acct-fold").click();
+    await settles(page, 0, wantWeekly(true, "100%", 100, false), "back on this cycle, folded");
+    assert.deepEqual(fields(await weekly(page, 1)), wantWeekly(false, "79%", 79, false), "Prolite unmoved to the end");
+    assert.deepEqual(errors, []);
+    if (process.env.ARTIFACT_DIR) {
+      await fs.mkdir(process.env.ARTIFACT_DIR, { recursive: true });
+      await page.screenshot({ path: path.join(process.env.ARTIFACT_DIR, `${engine}-usage-fold-cycle.png`) });
+    }
+  });
+}
-- 
2.50.1 (Apple Git-155)

```

</details>

**Branch with the commit**: [`fix/5590-usage-period-collapse`](https://github.com/ggbdpq/magpie/tree/fix/5590-usage-period-collapse) (head `a39fc9c1079f22f44e65d6804ad3b69c3c5a49f7`), rebased onto current `upstream/main` (`578053d6a`); on a fresh checkout `git am` applies clean.

| Check | Result |
| --- | --- |
| `usage-fold-cycle.test.cjs` (new, Chromium and WebKit, the reporter's shape: two Codex accounts, this week at 100, a recorded week at 57, fold and unfold twice, the other account unmoved, back to this cycle) | red before the fix (the folded bar back at 100%), pass after — 2/2 at head `a39fc9c10` |
| Neighbor suite, 12 files (quota-curve, usage-accounts-fold, usage-fold, usage-accounts, quota-read-at, quota-holds, usage-keys-fold, usage-card-refresh, usage-quota-head, quota-families, quota-pools, usage-curve-zoom-back) | 136/140 pass; the 4 failures (usage-fold's "17 subscriptions and 29 accounts" first-screen count on both engines, its webkit en/zh "several accounts: one in full, the others in brief, each remembered") fail the same with this change stashed and the parent checked out and re-run — layout/viewport reds of this machine, not from this patch |
| `go test -tags nogui ./internal/gui/ -timeout 25m -count=1` | only `TestProxyCheckSaysAProxyPassedBy` fails; it fails the same on the parent's own app.js, re-run to confirm (proxy port race on this machine); `TestCoreScriptBudget` passes |
| `go test -tags nogui ./...` (pinned GOCACHE) | `TestMothX` (internal/agent), `TestProxyCheckSaysAProxyPassedBy` (internal/gui), `TestHostToldTheGatewayAddress` (internal/plugin) fail — the same machine's proxy/port races, each failing the same without this patch; every other package ok |
| targeted `-race` (`go test -race -tags nogui ./internal/gui/`) | zero DATA RACE; only `TestProxyCheckSaysAProxyPassedBy` fails (as above) |
| `gofmt -l internal/gui/` | prints nothing (no Go files changed; the patch is app.js and the test's .cjs) |
| `go vet ./...`; `GOOS=linux go vet -tags nogui ./...`; `GOOS=windows go vet ./...` | clean |
| `go build`; `GOOS=linux go build -tags nogui`; `GOOS=windows go build` | clean |
| `TestCoreScriptBudget` | green: the one-line comment pays its own bytes (+73; the first draft's three lines went 21 bytes over the core budget, so the comment was cut to one line) |
| Ablation | restoring #2009's `!brief &&` on the fork line — or reverting app.js to the parent whole — turns usage-fold-cycle red ("folded keeps the picked cycle: expected fill 57%, got 100%"), the reporter's own reading; restored, green 2/2 |
| Re-verified on upstream/main `578053d6a` | the worktree opened on `8373aaf14`, rebased clean each time upstream moved (to `784113472`, then `578053d6a`); the checks above ran on the rebased head |

**Not verified**: the reporter's Windows machine with their real Codex accounts; no run against a live account was made here.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

Generated-by: GLM-5.3-Flash (ZCode)

