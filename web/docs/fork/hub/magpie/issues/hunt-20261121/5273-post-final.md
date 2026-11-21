Rebased onto current main (`18cfe278b`) and re-verified — the branch was moved to today's tip and every claim below re-runs on the new head.

Adaptation disclosure (one semantic merge, test-file constant only; no product code touched):

- 0001 (Select none, `elio`'s fix carried in the first commit) rebases with **zero drift** — `git range-diff 705d67efc..73b82dc3e upstream/main..479478d44` reports `1: abf99ff4d = 1: ef186933f`, content identical.
- 0002 (the budget gate) conflicts on `internal/gui/core_budget_test.go`: upstream's window grew `coreScriptBudget` from `1_270_709` (the Nov 15 re-merge) to `1_277_555` on the same line (four upstream GUI commits' growth). The constant re-merges as `1_277_833` = upstream's value + our `+278` for Select none, with our phrase appended after upstream's. `appScriptBudget` is upstream's own growth alone (ours never touches it); it takes upstream's side unchanged.

<details><summary>patch series: providers Select none under a filter + core script budget (#5273) — git am applies both as is; SHA-256 first 16: 4fed9d59f9c7a454</summary>

````tFrom 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: elio <elioq9352@gmail.com>
Date: Thu, 5 Nov 2026 00:01:25 +0800
Subject: [PATCH 1/2] providers: Select none under a filter unpicks only the
 models it shows, as Select all picks only those

In a provider's model list with a filter typed, Select all picked the
models the filter showed, while Select none unpicked every model, those
the filter hid too. Select none now unpicks only what the filter shows
and leaves the other picks. With nothing picked yet, it unpicks those
from what the vendor's list serves (dashed), so the rest of that list
stays picked, as Select all picks beside it. With no filter it unpicks
every model and a Save serves none, as before.

Select all, Select none and Free only share one match (shownBy), the
same rule the chips are drawn by; Free only's behaviour is unchanged.
Select none's tooltip says it acts on what the filter shows, in every
language.

Run, at e3ed21c7a plus this change:
- go test -run TestCoreScriptBudget ./internal/gui/: ok (within budget,
  no raise).
- go test ./internal/gui/ (whole package) before rebasing onto
  e3ed21c7a: TestCoreScriptBudget was over budget at the older base
  (fixed by 5910b5124 on main), TestProxyCheckSaysAProxyPassedBy and
  TestMainWindowCorners red; not run whole again at this head.
- node --check on app.js and the new test.

Not tried: the new GUI test, models-select-none-filter.test.cjs
(Chromium and WebKit, five languages, 1100 and 420 wide), and the GUI
files that press these buttons (models-free-only, models-works-only,
provider-draft-picks, models-select-all-api). This machine has no
Playwright browsers, and installing them was not allowed.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
---
 internal/gui/assets/app.js                    |  25 +++-
 internal/gui/assets/i18n.js                   |   8 +-
 .../tests/models-select-none-filter.test.cjs  | 140 ++++++++++++++++++
 3 files changed, 164 insertions(+), 9 deletions(-)
 create mode 100644 internal/gui/tests/models-select-none-filter.test.cjs

diff --git a/internal/gui/assets/app.js b/internal/gui/assets/app.js
index bab3abb03..aafecaf73 100644
--- a/internal/gui/assets/app.js
+++ b/internal/gui/assets/app.js
@@ -12223,20 +12223,35 @@ function renderModels(p) {
     for (const b of servesOpts) { b.classList.toggle("on", b.dataset.serves === now); b.setAttribute("aria-pressed", b.dataset.serves === now); }
     if (serves.isConnected) slide(serves, "serves");
   };
-  // every model at once (those the filter shows, when there is one), or none
+  // every model at once, or none: with a filter, both act on the models it
+  // shows only, and leave the others as they are
   const bulk = el("div", "mbulk");
+  const shownBy = (f, id) => {
+    if (!f) return true;
+    const m = p.models.find((x) => x.id === id) || { id };
+    return m.id.toLowerCase().includes(f) || (m.name || "").toLowerCase().includes(f) || (m.default || "").toLowerCase().includes(f);
+  };
   const allOn = el("button", "text action", t("Select all"));
   allOn.title = t("Pick every model listed that this provider can serve (those the filter shows)");
   allOn.onclick = () => {
     const f = (q?.value || "").trim().toLowerCase();
-    const ids = p.models.filter((m) => !noAPI(m)).filter((m) => !f || m.id.toLowerCase().includes(f) || (m.name || "").toLowerCase().includes(f) || (m.default || "").toLowerCase().includes(f)).map((m) => m.id);
+    const ids = p.models.filter((m) => !noAPI(m) && shownBy(f, m.id)).map((m) => m.id);
     draft.chosen = [...draft.chosen, ...ids.filter((id) => !draft.chosen.includes(id))];
     draft.none = true;
     draw();
   };
   const allOff = el("button", "text action", t("Select none"));
-  allOff.title = t("Unpick every model");
-  allOff.onclick = () => { draft.chosen = []; draft.none = true; draft.picking = false; draw(); };
+  allOff.title = t("Unpick every model (those the filter shows)");
+  allOff.onclick = () => {
+    const f = (q?.value || "").trim().toLowerCase();
+    // nothing picked yet: what the vendor's list serves (dashed) is what
+    // the filter unpicks from, as Select all picks beside it
+    const from = draft.chosen.length || !f || draft.picking || draft.none || decideOnly(p) ? draft.chosen : dashed();
+    draft.chosen = from.filter((id) => !shownBy(f, id));
+    draft.none = true;
+    if (!draft.chosen.length) draft.picking = false;
+    draw();
+  };
   bulk.append(allOn, allOff);
   // just the free ones, offered when the list has free and paid
   const isFree = (m) => m.free || m.zero || namedFree(m.id, m.name);
@@ -12245,7 +12260,7 @@ function renderModels(p) {
     freeOn.title = t("Pick only the free models (those the filter shows), unpicking the others");
     freeOn.onclick = () => {
       const f = (q?.value || "").trim().toLowerCase();
-      draft.chosen = p.models.filter((m) => isFree(m) && !noAPI(m) && (!f || m.id.toLowerCase().includes(f) || (m.name || "").toLowerCase().includes(f) || (m.default || "").toLowerCase().includes(f))).map((m) => m.id);
+      draft.chosen = p.models.filter((m) => isFree(m) && !noAPI(m) && shownBy(f, m.id)).map((m) => m.id);
       draft.none = true;
       draw();
     };
diff --git a/internal/gui/assets/i18n.js b/internal/gui/assets/i18n.js
index a42d83f9f..a7e371a61 100644
--- a/internal/gui/assets/i18n.js
+++ b/internal/gui/assets/i18n.js
@@ -3239,7 +3239,7 @@ const I18N = {
     "Test stopped": "已停止测试",
     "Pick every model listed that this provider can serve (those the filter shows)": "选中列出的、这个供应商能提供的所有模型（有筛选时只选筛出来的）",
     "{p} has no URL for the API its list serves it on ({apis}), so agents aren't offered it. Add that URL, or set the API it is asked on in Model settings.": "{p} 没有它的列表所说接口（{apis}）的地址，所以 Agent 看不到它。填上那个地址，或在「模型设置」里设定它走的接口。",
-    "Unpick every model": "取消选中所有模型",
+    "Unpick every model (those the filter shows)": "取消选中所有模型（有筛选时只取消筛出来的）",
     "Send a tiny request to each model agents see, to find the ones that don't answer": "向 Agent 可见的每个模型发一个极小请求，找出无响应的模型",
     "{n} of {all} models didn't answer; {model}: {error}": "{all} 个模型中有 {n} 个没有响应；{model}：{error}",
     "All {n} models answered": "{n} 个模型全部可用",
@@ -8761,7 +8761,7 @@ const I18N = {
     "Test stopped": "已停止測試",
     "Pick every model listed that this provider can serve (those the filter shows)": "選中列出的、這個供應商能提供的所有模型（有篩選時只選篩出來的）",
     "{p} has no URL for the API its list serves it on ({apis}), so agents aren't offered it. Add that URL, or set the API it is asked on in Model settings.": "{p} 沒有它的列表所說介面（{apis}）的位址，所以 Agent 看不到它。填上那個位址，或在「模型設定」裡設定它走的介面。",
-    "Unpick every model": "取消選中所有模型",
+    "Unpick every model (those the filter shows)": "取消選中所有模型（有篩選時只取消篩出來的）",
     "Send a tiny request to each model agents see, to find the ones that don't answer": "向 Agent 可見的每個模型發一個極小請求，找出無回應的模型",
     "{n} of {all} models didn't answer; {model}: {error}": "{all} 個模型中有 {n} 個沒有回應；{model}：{error}",
     "All {n} models answered": "{n} 個模型全部可用",
@@ -14298,7 +14298,7 @@ const I18N = {
     "Test stopped": "テストを停止しました",
     "Pick every model listed that this provider can serve (those the filter shows)": "このプロバイダーが提供できる一覧のすべてのモデルを選択（フィルター中は表示中のもの）",
     "{p} has no URL for the API its list serves it on ({apis}), so agents aren't offered it. Add that URL, or set the API it is asked on in Model settings.": "{p} には、一覧が示す API（{apis}）の URL がないため、エージェントには表示されません。その URL を追加するか、「モデル設定」で使う API を設定してください。",
-    "Unpick every model": "すべてのモデルの選択を解除",
+    "Unpick every model (those the filter shows)": "すべてのモデルの選択を解除（フィルター中は表示中のもの）",
     "Send a tiny request to each model agents see, to find the ones that don't answer": "エージェントに見える各モデルに小さなリクエストを送り、応答しないモデルを見つけます",
     "{n} of {all} models didn't answer; {model}: {error}": "{all} 個中 {n} 個のモデルが応答しませんでした。{model}：{error}",
     "All {n} models answered": "{n} 個のモデルすべてが応答しました",
@@ -19856,7 +19856,7 @@ const I18N = {
     "Test stopped": "Test gestoppt",
     "Pick every model listed that this provider can serve (those the filter shows)": "Alle aufgeführten Modelle auswählen, die dieser Anbieter bedienen kann (die der Filter zeigt)",
     "{p} has no URL for the API its list serves it on ({apis}), so agents aren't offered it. Add that URL, or set the API it is asked on in Model settings.": "{p} hat keine URL für die API, auf der die Liste es anbietet ({apis}), daher sehen Agenten es nicht. Füge diese URL hinzu oder lege unter „Modelleinstellungen“ die API fest, über die es angefragt wird.",
-    "Unpick every model": "Auswahl aller Modelle aufheben",
+    "Unpick every model (those the filter shows)": "Auswahl aller Modelle aufheben (die der Filter zeigt)",
     "Send a tiny request to each model agents see, to find the ones that don't answer": "Eine winzige Anfrage an jedes Modell senden, das Agenten sehen, um die nicht antwortenden zu finden",
     "{n} of {all} models didn't answer; {model}: {error}": "{n} von {all} Modellen haben nicht geantwortet; {model}: {error}",
     "All {n} models answered": "Alle {n} Modelle haben geantwortet",
diff --git a/internal/gui/tests/models-select-none-filter.test.cjs b/internal/gui/tests/models-select-none-filter.test.cjs
new file mode 100644
index 000000000..1a0beff47
--- /dev/null
+++ b/internal/gui/tests/models-select-none-filter.test.cjs
@@ -0,0 +1,140 @@
+// Run with Node's test runner and Playwright on the module path; see README.md.
+// With a filter, Select all picked only the models the filter shows, while
+// Select none unpicked every model, those the filter hid too. Now both act
+// on what the filter shows: Select none unpicks those and leaves the other
+// picks; with nothing picked yet it unpicks them from what the vendor's
+// list serves (dashed), as Select all picks beside it. With no filter it
+// unpicks every model and a Save serves none, as before. Every language,
+// Chromium and WebKit, 1100 and 420 wide.
+const assert = require("node:assert/strict");
+const fs = require("node:fs/promises");
+const path = require("node:path");
+const { test } = require("node:test");
+const { chromium, webkit } = require("playwright");
+const { strings } = require("./strings.cjs");
+
+const assets = path.resolve(__dirname, "../assets");
+const { I18N } = strings();
+const fetched = new Date(Date.now() - 3600e3).toISOString();
+const relay = (id, name, models, chosen) => ({
+  id, name, icon: "generic", host: id + ".example.com", chat: `https://${id}.example.com/v1`, responses: "", anthropic: "", catalog: "",
+  speaks: ["chat"], models, chosen, fetched, agents: [], fallback: [], headers: {},
+  key: { set: true, masked: "sk-…one" }, keyList: [], balanceToken: { takes: false, set: false }, proxy: "",
+});
+// 30 models, so the filter is drawn (over 24); the vendor's list serves the
+// first 24 (dashed): qwen-0..14 and glm-0..8
+const QWEN = Array.from({ length: 15 }, (_, i) => `qwen-${i}`);
+const GLM = Array.from({ length: 15 }, (_, i) => `glm-${i}`);
+const ALL = [...QWEN, ...GLM];
+const models = (chosen) => ALL.map((id, i) => ({ id, name: id, on: chosen.length ? chosen.includes(id) : i < 24 }));
+const PICKED = ["qwen-1", "qwen-2", "glm-1", "glm-2"];
+const picked = relay("picked-relay", "Picked Relay", models(PICKED), PICKED);
+const listed = relay("listed-relay", "Listed Relay", models([]), []);
+
+function serve(lang, posts) {
+  const providers = { providers: [picked, listed], presets: [], excluded: [], gateway: { running: true, window: true } };
+  const state = { agents: [], profiles: [], settings: { lang, theme: "light" } };
+  return async (route) => {
+    const req = route.request(), url = new URL(req.url());
+    const json = (data) => route.fulfill({ json: data });
+    if (url.pathname === "/boot.js") return route.fulfill({ contentType: "text/javascript", body: `window.bootPrefs = {lang:"${lang}",theme:"light",web:true};` });
+    if (url.pathname === "/wails/runtime.js") return route.fulfill({ contentType: "text/javascript", body: "export const Window = {};" });
+    if (req.method() === "POST" && url.pathname.startsWith("/api/")) posts.push({ path: url.pathname, body: req.postDataJSON() || {} });
+    if (url.pathname === "/api/state") return json(state);
+    if (url.pathname === "/api/plugins") return json({ plugins: [] });
+    if (url.pathname === "/api/providers") return json(providers);
+    if (url.pathname === "/api/groups") return json({ groups: [] });
+    if (url.pathname.startsWith("/api/")) return json({});
+    const file = path.join(assets, url.pathname === "/" ? "index.html" : url.pathname);
+    const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(file)];
+    await route.fulfill({ body: await fs.readFile(file), contentType });
+  };
+}
+
+const LANGS = ["en", "zh", "zh-TW", "ja", "de"];
+const NONE_TIP = "Unpick every model (those the filter shows)";
+const sorted = (a) => [...a].sort();
+
+for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"])) {
+  for (const lang of LANGS) {
+    for (const width of [1100, 420]) {
+      const tr = (k) => (lang === "en" ? k : I18N[lang][k]);
+      test(`${engine} ${lang} ${width}: Select none unpicks only what the filter shows`, async (t) => {
+        for (const k of [NONE_TIP, "Select all", "Select none", "Save"]) assert(tr(k), `${lang} lacks ${k}`);
+        const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
+        const page = await (await browser.newContext({ viewport: { width, height: 760 }, reducedMotion: "reduce" })).newPage();
+        t.after(async () => {
+          if (process.env.ARTIFACT_DIR) {
+            await fs.mkdir(process.env.ARTIFACT_DIR, { recursive: true });
+            await page.screenshot({ path: path.join(process.env.ARTIFACT_DIR, `${engine}-${lang}-${width}-select-none-filter.png`) });
+          }
+          await browser.close();
+        });
+        page.setDefaultTimeout(5000);
+        page.setDefaultNavigationTimeout(60000);
+        const errors = [];
+        page.on("pageerror", (e) => errors.push(e.message));
+        const posts = [];
+        await page.route("**/*", serve(lang, posts));
+
+        const editor = page.locator("#modal:not([hidden]) .editor");
+        const open = async (name) => {
+          await page.goto("http://magpie.test/?view=providers");
+          await page.locator(".row.provider", { hasText: name }).click();
+          await editor.locator(".ehead b", { hasText: name }).waitFor();
+          await editor.locator(".mchips .mchip").first().waitFor();
+        };
+        const bulk = (name) => editor.locator(".mbulk").getByRole("button", { name, exact: true });
+        const q = editor.locator(".mbulk input");
+        const chips = (cls) => editor.locator(`.mchips .mchip${cls}`).evaluateAll((cs) => cs.map((c) => c.querySelector("span").textContent).sort());
+        const save = async () => {
+          await editor.locator(".bar").getByRole("button", { name: tr("Save"), exact: true }).click();
+          for (let i = 0; i < 100 && !posts.some((p) => p.path === "/api/provider/save"); i++) await page.waitForTimeout(30);
+          const saved = posts.find((p) => p.path === "/api/provider/save");
+          assert(saved, "nothing saved");
+          posts.length = 0;
+          return saved.body;
+        };
+
+        // picks on both sides of the filter: Select none under "glm" leaves
+        // the qwen picks, and Select all under it picks every glm beside them
+        await open("Picked Relay");
+        assert.equal(await bulk(tr("Select none")).getAttribute("title"), tr(NONE_TIP));
+        await q.fill("glm");
+        await bulk(tr("Select none")).click();
+        assert.deepEqual(await chips(".on"), [], "a glm pick left under the filter");
+        await q.fill("");
+        assert.deepEqual(await chips(".on"), ["qwen-1", "qwen-2"]);
+        await q.fill("glm");
+        await bulk(tr("Select all")).click();
+        await q.fill("");
+        assert.deepEqual(await chips(".on"), sorted(["qwen-1", "qwen-2", ...GLM]));
+        await q.fill("qwen");
+        await bulk(tr("Select none")).click();
+        await q.fill("");
+        assert.deepEqual(sorted((await save()).models), sorted(GLM));
+
+        // nothing picked: the filter unpicks from what the vendor's list
+        // serves, and the rest of it stays picked
+        await open("Listed Relay");
+        assert.deepEqual(await chips(".auto"), sorted(ALL.slice(0, 24)));
+        await q.fill("glm");
+        await bulk(tr("Select none")).click();
+        await q.fill("");
+        assert.deepEqual(await chips(".on"), sorted(QWEN));
+        assert.deepEqual(await chips(".auto"), []);
+        assert.deepEqual(sorted((await save()).models), sorted(QWEN));
+
+        // no filter: every model unpicked, and a Save serves none
+        await open("Picked Relay");
+        await bulk(tr("Select none")).click();
+        assert.deepEqual(await chips(".on"), []);
+        assert.deepEqual(await chips(".auto"), []);
+        const none = await save();
+        assert.deepEqual(none.models, []);
+        assert.equal(none.noModels, true);
+        assert.deepEqual(errors, []);
+      });
+    }
+  }
+}
-- 
2.50.1 (Apple Git-155)


From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Thu, 12 Nov 2026 19:47:50 +0800
Subject: [PATCH 2/2] core: the script budget goes to what the core's scripts
 weigh now
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

Elio9352's #5273 fix — Select none under a filter unpicks only the
models it shows, as Select all picks only those, through one shared
match — costs 278 bytes of core script on this tip. coreScriptBudget
goes from 1,264,422 to 1,264,700, exactly its current weight with the
fix in, so the next change pays for itself again.

Run: TestCoreScriptBudget red with the fix alone on ea3a00adc ("the
core's scripts are 1,264,700 bytes of code, over their budget of
1,264,422"), green at 1,264,700. The four GUI tests pressing these
buttons ran against the patched assets: models-free-only 4/4,
provider-draft-picks 10/10, models-select-all-api 20/20 green;
models-works-only red 8/8 on the fix and the same 8/8 on the
unpatched tip (pre-existing, a 5-second locator timeout, not this
change).

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gui/core_budget_test.go | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)

diff --git a/internal/gui/core_budget_test.go b/internal/gui/core_budget_test.go
index 04fb29827..5cf547695 100644
--- a/internal/gui/core_budget_test.go
+++ b/internal/gui/core_budget_test.go
@@ -18,7 +18,7 @@ import (
 // `git log -L` of this file.
 const (
 	appScriptBudget  = 1_092_569 // app.js: 1,080,614 at 8016205e3, with the 5,653 of room it had; +123 for a sidebar list folded from its page's row (hkwok06 on X), its chevron and fold in navicons.js, imported with the first list; +57 for each account of a provider's Usage card in a card of its own (normalcoder_ on X), past the 24 of room left; +17 for an allowance card's wallet line under its rings (apple_test_src on X), the one filter shared with its text line; +338 for the Daily update channel (fishmagic80 on X): its segment, its line under Update channel and the version row's two Up to date on Daily words, packed to the shortest form (one t() per choice); Settings › About and renderUpdate draw them on every window, so there is no page to move them to; +35 for Baidu Qianfan's Token Plan sign-in (yuushabu_buyinn on X, #5860): its field in qianfanplan.js, imported when such a provider's editor opens, drawn by renderStepPlan now told whose sign-in it brings, and what is left is the import and two quotaError lines, past the room there was; quotaError reads every card's error, so there is no page to move it to; +27 for Windows' title bar (258a14 on X): the caption buttons, their clicks, the bar's double click and what keeps them over a dialog in wincap.js, imported in Windows' window alone, the header's room for them in app.css, and what is left is the one line that imports it, past the 29 of room there was; that window's frame is drawn on every start, so there is no page to move it to; +107 for the pages in the reader's own order (chet030714 on X): the order, the sidebar and tab bar put in it, and the menu's drag and keys in navorder.js and navpages.js, imported once an order is kept or Settings draws, and what is left is the one line in navHides that imports it; navHides runs on every start, so there is no page to move it to; +275 for the grants Alibaba's Token Plan asks of a RAM user's AccessKey in the reader's language (MetalHqa on X): one string (ALI_RAM) shown under the editor's AccessKey ID and on the card that names them, less the 48 of the wrong "a RAM user that may use Model Studio is enough" it replaces; the editor and quotaError draw them on every window, so there is no page to move them to; +135 for a model test its vendor queued shown queued and not green (sufeng1894 on X): queuedSaid, one string shared by the chip's title, Test models' and Test this model's status, and the chip's amber dot; renderModels draws the provider editor's chips, so there is no page to move it to; +66 for AstrLink Guard's row saying an x64 magpie runs it under Windows on Arm's emulation until the next update installs the Arm build (EV_John_Liu on X), the Rosetta line's sibling, one line in pmSub; the Privacy rows draw it, so there is no page to move it to; +864 for Use on a Claude setup-token account, which switches Claude Code itself to it in its settings.json, and Use back on its signed-in account (liukaybee on X): one swUse helper shared by both buttons, packed to the shortest form; renderAccounts draws every account row, so there is no page to move it to; +1 for the classifier timeout's unset default, 15 and not 8 (ESern29751 on X): its second digit in the Settings row's fallback, which renderReplies draws, so there is no page to move it to; +457 for Kimi Code's subagent pool and its effort (XiaoLing_Arisa on X): the Subagents line and its pool menu in kimisub.js, imported before a Kimi Code row's Details first slides open so it measures the line, and what is left is that import, the line's place, the three fields kept out of the row's squares and the picker's note that Kimi's subagents run on the lead's model, packed to the shortest form; renderAgents draws every row, so there is no page to move it to; +354 for Images per request (#6849, Yuu_jiang_ on X): its field and parse are in maximages.js, imported as the editor draws Max output, and what stays is the import, the two saves' lines and the check that the editor is still open when it and keyrates.js land, no page to move them to; +499 for Speed beside Model and Effort in an agent's opened row (Tengs999 on X): the line, its menu and what decides the speed in agentspeed.js, imported before a fast model's Details first slides open so it measures the line, and what is left is that import and the line's place in the panel's and the window's rows, packed to one helper; renderAgents draws every row, so there is no page to move it to; -1,529: each ChatGPT account's own warm-up time (renderWarmAtOwn) moved into autoresetown.js, imported when its rows first draw, paying for a provider's editor opening Advanced when its warm-up or check-in is on (ChrisYagao on X), and the room left over given back; +103 for the sidebar foot that holds Settings' tabs marked by a class, not :has(), which Safari before 15.4 can't parse (#5919): no page's code small enough to move was left (modelInfo serves two plugins); +52 for a proxy's failure said in the reader's language (laiuuui on X): proxyWhy is in proxies.js, imported when Settings draws its saved proxies, and what is left is api()'s one line handing the reply to it; api() reads every error, so there is no page to move it to; +485 for which effort a Claude Code tier runs at (lightwlh on X): an unset tier's effort reads follows session, a set one's title says the session's effort and /effort don't change it, and New sessions' effort says a tier with its own runs at that one, one ownSaid shared by both titles, packed to the shortest form; connectPanel and the effort slider draw every agent's Details, so there is no page to move it to; -165: the provider editor's WebSocket row moved into socketrow.js, imported as the editor draws, paying for its tick opening ticked on OpenAI's own API (KawaiiZapic on X), and the room left over given back; +68 for the version row saying a version newer than its channel's waits until the channel passes it (realfxw on X): one t() for both channels and the Every version tail shared with Up to date, packed to the shortest form; renderUpdate draws it on every window, so there is no page to move it to; +5 for the Version row's Restart named Restart only (realfxw on X restarted again and again on a bare Restart beside Check, waiting for an update): the one word more, short enough that the row's line doesn't wrap at 420; renderUpdate draws it on every window, so there is no page to move it to; +611 for the Usage page's cards kept still as they come in (liuzhengdong99 on X: 滑到上面看某张卡片，视图会被拽回下面): keepInView finding a card drawn anew by its data-key and leaving the browser's own anchoring to a view with none kept, unpin letting cards arranged by hand land where they were dropped, loadQuotas saying a read is under way, and an empty first history answer counted as come; which cards wait and the heights they keep went to the usage plugin, and what is left is the scroll guard every page goes through, so there is no page to move it to; +228 for an icon button at work showing the spinner every other button turns in place of its glyph, not the glyph turning on itself (wiirhan on X: a Library skill's Update spun its own up arrow): glyphBusy, shared by that Update and an agent row's Apply again and Restart, packed to the shortest form; renderAgents and the Library's rows draw them on every window, so there is no page to move it to; +182 for Show settings file in an agent row's menu (InkCoalW on X): its whole settings file at hand, as CC Switch has it, shown in the file manager by agents/reveal from the id alone, one item packed to the shortest form; openAgentMenu draws every agent's menu, so there is no page to move it to; +222 for a partner's tagline under its name in the Add sheet (the owner's variant A, 7d369c217): partnerTile puts partnerNote's words in a second span beside the name; the Add sheet draws its partners on every open of Providers' Add, and addfloat.js loads only after the sheet is up, so there is no page to move it to; +430 for a rate limit or quota refusal kept on its row till the vendor's reset, or till the account answers (eachg0 on X): restShown, one helper shared by the key rows, the account lines and the filters, and restLineOf's notice wording with no Try now, packed to the shortest form; renderKeyAccounts and the account rows draw every Providers row, so there is no page to move it to; +770 for Sidrune AI's keys (Axo, 11-20): an endpoint a key's group refuses shown Not served for this key and not red, the editor moving to the region a key is of after Test, and Save saying the region it was saved at, packed to the shortest form with no room left; renderEndpoints, the region picker and providerAction draw them in every provider editor, so there is no page to move them to; +670 for Claude Desktop's subagent model unset read as Lead's pick (mathfournity on X): a line saying the lead names opus, sonnet, haiku or fable and the subagent runs on that tier's model in Tiers, and the picker's Lead's pick option with its note, shared with Codex's Lead's pick and its set line, packed to the shortest form; renderAgents draws every row, so there is no page to move it to; +461 for a routing group an agent's picker lacks listed in its Routing groups with why (CHENGJIAHEGOXIS on X: DeepSeek-API-Agents was in no section of Codex's picker): unservedRows, the row's greyed class and aria-disabled, no star, commit refusing it, and setPick putting a pickable one back in the agent's lists first, packed to the shortest form; openPicker and renderList draw every agent's picker, so there is no page to move it to
-	coreScriptBudget = 1_277_555 // every core script at 8016205e3, the old measure 682 over its cap there (#5918); +367 for the model test on a chosen account (tmr11235), no page left to move it to; +151 for the provider menu's "Only on this device" item and its four translations; +458 for Settings › About's Report a problem row and its translations; +113 for withScheme, the one rule every typed address goes through (eachg0 on X), cut to the shortest form that keeps it whole; +10 for the kept whole's tooltip (Musikrv77852 on X), the past-cycle line reused for it, no page left to move it to; +1,112 for Codex's Open button and its Open Codex with menu (Yink88564391 on X), packed to the shortest form, no page left to move them to; +168 for Discover's long lists drawn in part (the owner, 11-13), after the rest of its hook moved into plugingrid.js, imported when Plugins first draws; +296 for the cap toggle and Smart sentences that say what they do and the Sign in on another computer row (Wing8Aqua on X), packed to the shortest form, no page left to move them to; +333 for In turn's figure in a provider's editor and its words naming the message that goes round (Wing8Aqua on X), the figure itself in rotfig.js, imported when In turn is first shown, the hook packed to the shortest form; +236 for a lone capped Codex account's row saying its turns go to the fallbacks when Codex is connected (not_4O4 on X), the two helpers inlined, no page left to move it to; +717 for omp's advisor (Awad_Yoo on X, #6408): its three rows moved into ompadvisor.js, imported when an omp's settings show, and what is left is the import, the role's " · off" and the Settings line's name, packed to the shortest form; +468 for a plugin's own file import (auth.import) in the import sheet, in the plugin's words (marchen_cc on X), packed to one statement; importSay is read as the Providers rows draw, so it has no lazy page to go to, and nothing else was moved out; +180 for Claude Magpie's own Claude Code folder (xMopf7RF on X, #6459): its Advanced fold in claudemagpie.js, imported when it first shows, and what is left is the import and the fold's place in the Separate app line, 216 bytes packed to the shortest form, less the 36 of room there was; +81 for the Use Claude Magpie button on Claude Desktop's row (xMopf7RF on X), drawn by claudemagpie.js too, what is left the one line that places it (#2710); +225 for the Hermes row's Other profiles lines (Norethcy on X), which 1d60b165c took out while each profile had a row and c96f33d65 left with no place at all, packed to the shortest form; the dead hermes# Default note went with it, and the Agents rows draw it, so there is no page to move it to; +397 for a key's own price rate (tnt12231 on X): its lines, check and placeholder in keyrates.js, imported when a provider with two or more keys opens, and what is left is the import, the draft's copy, Advanced opening for it, the save's one line and proxyLines drawing another kind of line; +316 for an image or video model's chip saying what it makes from its right-click (iceloon on X): the chat chip's Makes… now shared with it, and the media chip's Copy model ID left out, packed to the shortest form; the provider's editor draws it, so there is no page to move it to; +67 for the Claude Code · Claude Magpie row saying it is on magpie through Claude Magpie (xMopf7RF on X), one line in connectLine with the shortest words that say it; the Agents rows draw it, so there is no page to move it to; +12 for AIGoCode's logo in pngIcons (MindfulReturn on X), the list every drawn icon is looked up in; +491 for each cost in the tray panel's and Requests' chart and ranking in its own provider's currency (onkashiko on X): ledProv and the provider passed through, packed to the shortest form; drawLedColumns and drawLedRank are shared by the panel, so there is no page to move it to; +326 for the Qwen AI platform's Token Plan sign-in (imthe99galaxy on X): its field, sign-in and wait in qianwenplan.js, imported when such a provider's editor opens, and what is left is the import and one quotaError line for its two refusals, packed to the shortest form; quotaError reads every card's error, so there is no page to move it to; +72 for Copy all keys (emilochen on X): its row in keyrates.js, imported when a provider with two or more keys opens through keyRateField, now told which of its parts to draw, and what is left is the one line that places it; +83 for the page saying it has gone from view, so what its Sessions and Usage pages keep goes in 30 s and not 7 minutes (P0 memory): folded into the visibilitychange listener every window has, packed to the shortest form, so there is no page to move it to; +270 for Providers' Select, to remove several at once (eiyuuzaki2333 on X): its rows, bar, removal and keys in pvpick.js, imported when Select is first clicked, and what is left is pvSel, the button's click and two lines in renderProviders, which draws the list, so there is no page to move it to; +81 for each account of a provider's Usage card in a card of its own (normalcoder_ on X): one line that makes the box, its brief look left to CSS, and renderQuotas, which draws every card, so there is no page to move it to; +17 for Kimi Code's booster balance under an allowance card's rings in the tray panel (apple_test_src on X): the card's text line and the wallet line share one filter, packed to the shortest form; panelQuotaCard draws every card, so there is no page to move it to; +51 for what a failed plugin install left in plugins/, listed under Installed with a Remove (CHENGJIAHEGOXIS on X): its section in plugininstalled.js as pmLeftovers, imported when Plugins first draws, and what is left is the one call after drawInstalled; draw is what draws the page, so there is no page to move it to; +123 for a sidebar list folded from its page's row (hkwok06 on X): the chevron, its click and the fold kept per page in navicons.js, imported with the first list, and what is left is the folded list read beside the hidden pages' (navList, which navMine now shares) and the two rows' clicks asking navFold first; navSubs draws every list, so there is no page to move it to; +338 for the Daily update channel (fishmagic80 on X): its segment, its line under Update channel and the version row's two Up to date on Daily words, packed to the shortest form (one t() per choice); Settings › About and renderUpdate draw them on every window, so there is no page to move them to; +35 for Baidu Qianfan's Token Plan sign-in (yuushabu_buyinn on X, #5860): its field in qianfanplan.js, imported when such a provider's editor opens, drawn by renderStepPlan now told whose sign-in it brings, and what is left is the import and two quotaError lines, past the room there was; quotaError reads every card's error, so there is no page to move it to; +27 for Windows' title bar (258a14 on X): the caption buttons, their clicks, the bar's double click and what keeps them over a dialog in wincap.js, imported in Windows' window alone, the header's room for them in app.css, and what is left is the one line that imports it, past the 29 of room there was; that window's frame is drawn on every start, so there is no page to move it to; +107 for the pages in the reader's own order (chet030714 on X): the order, the sidebar and tab bar put in it, and the menu's drag and keys in navorder.js and navpages.js, imported once an order is kept or Settings draws, and what is left is the one line in navHides that imports it; navHides runs on every start, so there is no page to move it to; +275 for the grants Alibaba's Token Plan asks of a RAM user's AccessKey in the reader's language (MetalHqa on X): one string (ALI_RAM) shown under the editor's AccessKey ID and on the card that names them, less the 48 of the wrong "a RAM user that may use Model Studio is enough" it replaces; the editor and quotaError draw them on every window, so there is no page to move them to; +135 for a model test its vendor queued shown queued and not green (sufeng1894 on X): queuedSaid, one string shared by the chip's title, Test models' and Test this model's status, and the chip's amber dot; renderModels draws the provider editor's chips, so there is no page to move it to; +66 for AstrLink Guard's row saying an x64 magpie runs it under Windows on Arm's emulation until the next update installs the Arm build (EV_John_Liu on X), the Rosetta line's sibling, one line in pmSub; the Privacy rows draw it, so there is no page to move it to; +189 for Let magpie set it on a Codex card locked by config.toml's own compact limit or background threshold (sufeng1894 on X), and Undo for a background share taken over: the shared send posts it, packed to the shortest form; adviceRow draws every card, so there is no page to move it to; +864 for Use on a Claude setup-token account, which switches Claude Code itself to it in its settings.json, and Use back on its signed-in account (liukaybee on X): one swUse helper shared by both buttons, packed to the shortest form; renderAccounts draws every account row, so there is no page to move it to; +1 for the classifier timeout's unset default, 15 and not 8 (ESern29751 on X): its second digit in the Settings row's fallback, which renderReplies draws, so there is no page to move it to; +457 for Kimi Code's subagent pool and its effort (XiaoLing_Arisa on X): the Subagents line and its pool menu in kimisub.js, imported before a Kimi Code row's Details first slides open so it measures the line, and what is left is that import, the line's place, the three fields kept out of the row's squares and the picker's note that Kimi's subagents run on the lead's model, packed to the shortest form; renderAgents draws every row, so there is no page to move it to; +354 for Images per request (#6849, Yuu_jiang_ on X): its field and parse are in maximages.js, imported as the editor draws Max output, and what stays is the import, the two saves' lines and the check that the editor is still open when it and keyrates.js land, no page to move them to; +499 for Speed beside Model and Effort in an agent's opened row (Tengs999 on X): the line, its menu and what decides the speed in agentspeed.js, imported before a fast model's Details first slides open so it measures the line, and what is left is that import and the line's place in the panel's and the window's rows, packed to one helper; renderAgents draws every row, so there is no page to move it to; -1,529: each ChatGPT account's own warm-up time moved into autoresetown.js, paying for Advanced opening on a warm-up or check-in that is on (ChrisYagao on X), the room left over given back; +103 for the same .with-sub foot (#5919); +52 for the Advisor kind of an advisor call's own usage row (#6977, Refeccd on Discord): its entry in the generated purposes.js; the kinds are read wherever Usage and Routing draw a row, so there is no page to move it to; +54 for a proxy's failure said in the reader's language (laiuuui on X): proxyWhy is in proxies.js, imported when Settings draws its saved proxies, and what is left is api()'s one line handing the reply to it; api() reads every error, so there is no page to move it to; +843 for which effort a Claude Code tier runs at (lightwlh on X): an unset tier's effort reads follows session, a set one's title says the session's effort and /effort don't change it, and New sessions' effort says a tier with its own runs at that one, one ownSaid shared by both titles, packed to the shortest form; connectPanel and the effort slider draw every agent's Details, so there is no page to move it to; -165: the provider editor's WebSocket row moved into socketrow.js, imported as the editor draws, paying for its tick opening ticked on OpenAI's own API (KawaiiZapic on X), and the room left over given back; +68 for the version row saying a version newer than its channel's waits until the channel passes it (realfxw on X): one t() for both channels and the Every version tail shared with Up to date, packed to the shortest form; renderUpdate draws it on every window, so there is no page to move it to; +5 for the Version row's Restart named Restart only (realfxw on X restarted again and again on a bare Restart beside Check, waiting for an update): the one word more, short enough that the row's line doesn't wrap at 420; renderUpdate draws it on every window, so there is no page to move it to; +611 for the Usage page's cards kept still as they come in (liuzhengdong99 on X: 滑到上面看某张卡片，视图会被拽回下面): keepInView finding a card drawn anew by its data-key and leaving the browser's own anchoring to a view with none kept, unpin letting cards arranged by hand land where they were dropped, loadQuotas saying a read is under way, and an empty first history answer counted as come; which cards wait and the heights they keep went to the usage plugin, and what is left is the scroll guard every page goes through, so there is no page to move it to; +228 for an icon button at work showing the spinner every other button turns in place of its glyph, not the glyph turning on itself (wiirhan on X: a Library skill's Update spun its own up arrow): glyphBusy, shared by that Update and an agent row's Apply again and Restart, packed to the shortest form; renderAgents and the Library's rows draw them on every window, so there is no page to move it to; +182 for Show settings file in an agent row's menu (InkCoalW on X): its whole settings file at hand, as CC Switch has it, shown in the file manager by agents/reveal from the id alone, one item packed to the shortest form; openAgentMenu draws every agent's menu, so there is no page to move it to; +222 for a partner's tagline under its name in the Add sheet (the owner's variant A, 7d369c217): partnerTile puts partnerNote's words in a second span beside the name; the Add sheet draws its partners on every open of Providers' Add, and addfloat.js loads only after the sheet is up, so there is no page to move it to; +295 for Partners first in Plugins' Discover (the owner: 有些合作方…适合在插件页的赞助位): the section, its rows and its counts in pluginpartners.js, imported when Plugins first draws, and what is left is the import, the call that hands it the page's picks and helpers, and the reset of what was counted shown on each load; drawBody draws Discover, so there is no page to move it to; +430 for a rate limit or quota refusal kept on its row till the vendor's reset, or till the account answers (eachg0 on X): restShown, one helper shared by the key rows, the account lines and the filters, and restLineOf's notice wording with no Try now, packed to the shortest form; renderKeyAccounts and the account rows draw every Providers row, so there is no page to move it to; +770 for Sidrune AI's keys (Axo, 11-20): an endpoint a key's group refuses shown Not served for this key and not red, the editor moving to the region a key is of after Test, and Save saying the region it was saved at, packed to the shortest form with no room left; renderEndpoints, the region picker and providerAction draw them in every provider editor, so there is no page to move them to; +670 for Claude Desktop's subagent model unset read as Lead's pick (mathfournity on X): a line saying the lead names opus, sonnet, haiku or fable and the subagent runs on that tier's model in Tiers, and the picker's Lead's pick option with its note, shared with Codex's Lead's pick and its set line, packed to the shortest form; renderAgents draws every row, so there is no page to move it to; +461 for a routing group an agent's picker lacks listed in its Routing groups with why (CHENGJIAHEGOXIS on X: DeepSeek-API-Agents was in no section of Codex's picker): unservedRows, the row's greyed class and aria-disabled, no star, commit refusing it, and setPick putting a pickable one back in the agent's lists first, packed to the shortest form; openPicker and renderList draw every agent's picker, so there is no page to move it to
+	coreScriptBudget = 1_277_833 // every core script at 8016205e3, the old measure 682 over its cap there (#5918); +367 for the model test on a chosen account (tmr11235), no page left to move it to; +151 for the provider menu's "Only on this device" item and its four translations; +458 for Settings › About's Report a problem row and its translations; +113 for withScheme, the one rule every typed address goes through (eachg0 on X), cut to the shortest form that keeps it whole; +10 for the kept whole's tooltip (Musikrv77852 on X), the past-cycle line reused for it, no page left to move it to; +1,112 for Codex's Open button and its Open Codex with menu (Yink88564391 on X), packed to the shortest form, no page left to move them to; +168 for Discover's long lists drawn in part (the owner, 11-13), after the rest of its hook moved into plugingrid.js, imported when Plugins first draws; +296 for the cap toggle and Smart sentences that say what they do and the Sign in on another computer row (Wing8Aqua on X), packed to the shortest form, no page left to move them to; +333 for In turn's figure in a provider's editor and its words naming the message that goes round (Wing8Aqua on X), the figure itself in rotfig.js, imported when In turn is first shown, the hook packed to the shortest form; +236 for a lone capped Codex account's row saying its turns go to the fallbacks when Codex is connected (not_4O4 on X), the two helpers inlined, no page left to move it to; +717 for omp's advisor (Awad_Yoo on X, #6408): its three rows moved into ompadvisor.js, imported when an omp's settings show, and what is left is the import, the role's " · off" and the Settings line's name, packed to the shortest form; +468 for a plugin's own file import (auth.import) in the import sheet, in the plugin's words (marchen_cc on X), packed to one statement; importSay is read as the Providers rows draw, so it has no lazy page to go to, and nothing else was moved out; +180 for Claude Magpie's own Claude Code folder (xMopf7RF on X, #6459): its Advanced fold in claudemagpie.js, imported when it first shows, and what is left is the import and the fold's place in the Separate app line, 216 bytes packed to the shortest form, less the 36 of room there was; +81 for the Use Claude Magpie button on Claude Desktop's row (xMopf7RF on X), drawn by claudemagpie.js too, what is left the one line that places it (#2710); +225 for the Hermes row's Other profiles lines (Norethcy on X), which 1d60b165c took out while each profile had a row and c96f33d65 left with no place at all, packed to the shortest form; the dead hermes# Default note went with it, and the Agents rows draw it, so there is no page to move it to; +397 for a key's own price rate (tnt12231 on X): its lines, check and placeholder in keyrates.js, imported when a provider with two or more keys opens, and what is left is the import, the draft's copy, Advanced opening for it, the save's one line and proxyLines drawing another kind of line; +316 for an image or video model's chip saying what it makes from its right-click (iceloon on X): the chat chip's Makes… now shared with it, and the media chip's Copy model ID left out, packed to the shortest form; the provider's editor draws it, so there is no page to move it to; +67 for the Claude Code · Claude Magpie row saying it is on magpie through Claude Magpie (xMopf7RF on X), one line in connectLine with the shortest words that say it; the Agents rows draw it, so there is no page to move it to; +12 for AIGoCode's logo in pngIcons (MindfulReturn on X), the list every drawn icon is looked up in; +491 for each cost in the tray panel's and Requests' chart and ranking in its own provider's currency (onkashiko on X): ledProv and the provider passed through, packed to the shortest form; drawLedColumns and drawLedRank are shared by the panel, so there is no page to move it to; +326 for the Qwen AI platform's Token Plan sign-in (imthe99galaxy on X): its field, sign-in and wait in qianwenplan.js, imported when such a provider's editor opens, and what is left is the import and one quotaError line for its two refusals, packed to the shortest form; quotaError reads every card's error, so there is no page to move it to; +72 for Copy all keys (emilochen on X): its row in keyrates.js, imported when a provider with two or more keys opens through keyRateField, now told which of its parts to draw, and what is left is the one line that places it; +83 for the page saying it has gone from view, so what its Sessions and Usage pages keep goes in 30 s and not 7 minutes (P0 memory): folded into the visibilitychange listener every window has, packed to the shortest form, so there is no page to move it to; +270 for Providers' Select, to remove several at once (eiyuuzaki2333 on X): its rows, bar, removal and keys in pvpick.js, imported when Select is first clicked, and what is left is pvSel, the button's click and two lines in renderProviders, which draws the list, so there is no page to move it to; +81 for each account of a provider's Usage card in a card of its own (normalcoder_ on X): one line that makes the box, its brief look left to CSS, and renderQuotas, which draws every card, so there is no page to move it to; +17 for Kimi Code's booster balance under an allowance card's rings in the tray panel (apple_test_src on X): the card's text line and the wallet line share one filter, packed to the shortest form; panelQuotaCard draws every card, so there is no page to move it to; +51 for what a failed plugin install left in plugins/, listed under Installed with a Remove (CHENGJIAHEGOXIS on X): its section in plugininstalled.js as pmLeftovers, imported when Plugins first draws, and what is left is the one call after drawInstalled; draw is what draws the page, so there is no page to move it to; +123 for a sidebar list folded from its page's row (hkwok06 on X): the chevron, its click and the fold kept per page in navicons.js, imported with the first list, and what is left is the folded list read beside the hidden pages' (navList, which navMine now shares) and the two rows' clicks asking navFold first; navSubs draws every list, so there is no page to move it to; +338 for the Daily update channel (fishmagic80 on X): its segment, its line under Update channel and the version row's two Up to date on Daily words, packed to the shortest form (one t() per choice); Settings › About and renderUpdate draw them on every window, so there is no page to move them to; +35 for Baidu Qianfan's Token Plan sign-in (yuushabu_buyinn on X, #5860): its field in qianfanplan.js, imported when such a provider's editor opens, drawn by renderStepPlan now told whose sign-in it brings, and what is left is the import and two quotaError lines, past the room there was; quotaError reads every card's error, so there is no page to move it to; +27 for Windows' title bar (258a14 on X): the caption buttons, their clicks, the bar's double click and what keeps them over a dialog in wincap.js, imported in Windows' window alone, the header's room for them in app.css, and what is left is the one line that imports it, past the 29 of room there was; that window's frame is drawn on every start, so there is no page to move it to; +107 for the pages in the reader's own order (chet030714 on X): the order, the sidebar and tab bar put in it, and the menu's drag and keys in navorder.js and navpages.js, imported once an order is kept or Settings draws, and what is left is the one line in navHides that imports it; navHides runs on every start, so there is no page to move it to; +275 for the grants Alibaba's Token Plan asks of a RAM user's AccessKey in the reader's language (MetalHqa on X): one string (ALI_RAM) shown under the editor's AccessKey ID and on the card that names them, less the 48 of the wrong "a RAM user that may use Model Studio is enough" it replaces; the editor and quotaError draw them on every window, so there is no page to move them to; +135 for a model test its vendor queued shown queued and not green (sufeng1894 on X): queuedSaid, one string shared by the chip's title, Test models' and Test this model's status, and the chip's amber dot; renderModels draws the provider editor's chips, so there is no page to move it to; +66 for AstrLink Guard's row saying an x64 magpie runs it under Windows on Arm's emulation until the next update installs the Arm build (EV_John_Liu on X), the Rosetta line's sibling, one line in pmSub; the Privacy rows draw it, so there is no page to move it to; +189 for Let magpie set it on a Codex card locked by config.toml's own compact limit or background threshold (sufeng1894 on X), and Undo for a background share taken over: the shared send posts it, packed to the shortest form; adviceRow draws every card, so there is no page to move it to; +864 for Use on a Claude setup-token account, which switches Claude Code itself to it in its settings.json, and Use back on its signed-in account (liukaybee on X): one swUse helper shared by both buttons, packed to the shortest form; renderAccounts draws every account row, so there is no page to move it to; +1 for the classifier timeout's unset default, 15 and not 8 (ESern29751 on X): its second digit in the Settings row's fallback, which renderReplies draws, so there is no page to move it to; +457 for Kimi Code's subagent pool and its effort (XiaoLing_Arisa on X): the Subagents line and its pool menu in kimisub.js, imported before a Kimi Code row's Details first slides open so it measures the line, and what is left is that import, the line's place, the three fields kept out of the row's squares and the picker's note that Kimi's subagents run on the lead's model, packed to the shortest form; renderAgents draws every row, so there is no page to move it to; +354 for Images per request (#6849, Yuu_jiang_ on X): its field and parse are in maximages.js, imported as the editor draws Max output, and what stays is the import, the two saves' lines and the check that the editor is still open when it and keyrates.js land, no page to move them to; +499 for Speed beside Model and Effort in an agent's opened row (Tengs999 on X): the line, its menu and what decides the speed in agentspeed.js, imported before a fast model's Details first slides open so it measures the line, and what is left is that import and the line's place in the panel's and the window's rows, packed to one helper; renderAgents draws every row, so there is no page to move it to; -1,529: each ChatGPT account's own warm-up time moved into autoresetown.js, paying for Advanced opening on a warm-up or check-in that is on (ChrisYagao on X), the room left over given back; +103 for the same .with-sub foot (#5919); +52 for the Advisor kind of an advisor call's own usage row (#6977, Refeccd on Discord): its entry in the generated purposes.js; the kinds are read wherever Usage and Routing draw a row, so there is no page to move it to; +54 for a proxy's failure said in the reader's language (laiuuui on X): proxyWhy is in proxies.js, imported when Settings draws its saved proxies, and what is left is api()'s one line handing the reply to it; api() reads every error, so there is no page to move it to; +843 for which effort a Claude Code tier runs at (lightwlh on X): an unset tier's effort reads follows session, a set one's title says the session's effort and /effort don't change it, and New sessions' effort says a tier with its own runs at that one, one ownSaid shared by both titles, packed to the shortest form; connectPanel and the effort slider draw every agent's Details, so there is no page to move it to; -165: the provider editor's WebSocket row moved into socketrow.js, imported as the editor draws, paying for its tick opening ticked on OpenAI's own API (KawaiiZapic on X), and the room left over given back; +68 for the version row saying a version newer than its channel's waits until the channel passes it (realfxw on X): one t() for both channels and the Every version tail shared with Up to date, packed to the shortest form; renderUpdate draws it on every window, so there is no page to move it to; +5 for the Version row's Restart named Restart only (realfxw on X restarted again and again on a bare Restart beside Check, waiting for an update): the one word more, short enough that the row's line doesn't wrap at 420; renderUpdate draws it on every window, so there is no page to move it to; +611 for the Usage page's cards kept still as they come in (liuzhengdong99 on X: 滑到上面看某张卡片，视图会被拽回下面): keepInView finding a card drawn anew by its data-key and leaving the browser's own anchoring to a view with none kept, unpin letting cards arranged by hand land where they were dropped, loadQuotas saying a read is under way, and an empty first history answer counted as come; which cards wait and the heights they keep went to the usage plugin, and what is left is the scroll guard every page goes through, so there is no page to move it to; +228 for an icon button at work showing the spinner every other button turns in place of its glyph, not the glyph turning on itself (wiirhan on X: a Library skill's Update spun its own up arrow): glyphBusy, shared by that Update and an agent row's Apply again and Restart, packed to the shortest form; renderAgents and the Library's rows draw them on every window, so there is no page to move it to; +182 for Show settings file in an agent row's menu (InkCoalW on X): its whole settings file at hand, as CC Switch has it, shown in the file manager by agents/reveal from the id alone, one item packed to the shortest form; openAgentMenu draws every agent's menu, so there is no page to move it to; +222 for a partner's tagline under its name in the Add sheet (the owner's variant A, 7d369c217): partnerTile puts partnerNote's words in a second span beside the name; the Add sheet draws its partners on every open of Providers' Add, and addfloat.js loads only after the sheet is up, so there is no page to move it to; +295 for Partners first in Plugins' Discover (the owner: 有些合作方…适合在插件页的赞助位): the section, its rows and its counts in pluginpartners.js, imported when Plugins first draws, and what is left is the import, the call that hands it the page's picks and helpers, and the reset of what was counted shown on each load; drawBody draws Discover, so there is no page to move it to; +430 for a rate limit or quota refusal kept on its row till the vendor's reset, or till the account answers (eachg0 on X): restShown, one helper shared by the key rows, the account lines and the filters, and restLineOf's notice wording with no Try now, packed to the shortest form; renderKeyAccounts and the account rows draw every Providers row, so there is no page to move it to; +770 for Sidrune AI's keys (Axo, 11-20): an endpoint a key's group refuses shown Not served for this key and not red, the editor moving to the region a key is of after Test, and Save saying the region it was saved at, packed to the shortest form with no room left; renderEndpoints, the region picker and providerAction draw them in every provider editor, so there is no page to move them to; +670 for Claude Desktop's subagent model unset read as Lead's pick (mathfournity on X): a line saying the lead names opus, sonnet, haiku or fable and the subagent runs on that tier's model in Tiers, and the picker's Lead's pick option with its note, shared with Codex's Lead's pick and its set line, packed to the shortest form; renderAgents draws every row, so there is no page to move it to; +461 for a routing group an agent's picker lacks listed in its Routing groups with why (CHENGJIAHEGOXIS on X: DeepSeek-API-Agents was in no section of Codex's picker): unservedRows, the row's greyed class and aria-disabled, no star, commit refusing it, and setPick putting a pickable one back in the agent's lists first, packed to the shortest form; openPicker and renderList draw every agent's picker, so there is no page to move it to; +278 for Select none under a filter sharing Select all's match (#5273, Elio9352)
 )
 
 // codeBytes is how many bytes of b are code: its blank lines, its lines
-- 
2.50.1 (Apple Git-155)

````

</details>


| Element | Evidence at `18cfe278b` (head `479478d44`) |
| --- | --- |
| Rebase | `hunt-20261112-t1-5273` = `18cfe278b` + the series: 0001 range-diff identical; 0002 re-merges the constant as above (details in the disclosure) |
| git am | the series (`git format-patch -2 --zero-commit`) replays on a detached tree at `18cfe278b`, both commits apply in order to a byte-identical tree: amtest tree `44560eeb735baa033a4a7b38367687fb65c1b852` == branch tree `44560eeb735baa033a4a7b38367687fb65c1b852`; authors kept (`elio` on 0001, `ggbdpq` on 0002) |
| Tests | the browser regression `models-select-none-filter.test.cjs`: **20/20 pass** on this machine (Chromium and WebKit × en/zh/zh-TW/ja/de × 1100/420, `node --test`, playwright 1.57.0, 28s); `TestCoreScriptBudget`: ok plain and under `-race`; `internal/gui` in full (`-tags nogui -timeout 45m -count=1`): two reds on the head — `TestProxyCheckSaysAProxyPassedBy` and `TestSessionReadsRoutes` — and the bare base fails exactly the same two (the standing reds documented in the Nov 15 post; the proxy one is this box's proxy environment, the routes one a full-run interaction); zero tip-only failures |
| Ablation | 0001: content-identical to the Nov 15 post, whose ablation stands (assets reverted, the browser test went 0/20; restored, green) — re-confirmed positively here by the fresh 20/20. 0002: at upstream's own gate `1_277_555` the test passes — the scripts measure **1,277,351 bytes** on this tip (upstream's gate holds with 204 bytes of room, so our +278 is headroom rather than a required raise here, same as the Nov 15 finding), and the gate's teeth re-verified at a `1_000_000` gate: `the core's scripts are 1277351 bytes of code, over their budget`. Kept as-written for the maintainers to keep or drop |
| Siblings | the Select-none face (`noneChosen`/`servedIds`, the Select none button) and Select all's picker path stand as scanned in the earlier posts; upstream's window grew app.js in other areas (0001 rebased clean); the budget line's upstream growth is accounted in the re-merge above; no new sibling face |
| Real path | the fresh 20/20 browser run on this machine is the real-path reproduction (real pages, both engines, five languages, two widths) |

Branch with the commits: [hunt-20261112-t1-5273](https://github.com/ggbdpq/magpie/tree/hunt-20261112-t1-5273) (head `479478d4402fc23f62ecc16dad71a252182a25be`). Series SHA-256 first 16: `4fed9d59f9c7a454`.

Attribution: AI-written; I've read the whole diff and can answer questions on it myself. 0001 is the reporter's fix carried with the author (`elio`) kept. Please keep the authors or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

Generated-by: GLM-5.3-Flash (ZCode)
