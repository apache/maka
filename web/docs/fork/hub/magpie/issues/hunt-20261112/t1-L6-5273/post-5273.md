Verified @Elio9352's fix independently on today's main (`ea3a00adc`). The fix cherry-picks onto it as-is, and it does what the report asks: with a filter typed, Select none now unpicks only the models the filter shows, as Select all picks only those.

**Red without the fix** (base `ea3a00adc`): driving the real page — qwen-1, qwen-2, glm-1, glm-2 picked, `glm` typed, Select none, filter cleared — nothing stays picked (`still picked after Select none under 'glm': []`). With the fix: `["qwen-1","qwen-2"]`. The reporter's new `models-select-none-filter.test.cjs` fails 10/10 on the unpatched assets and runs 20/20 green with the fix (Chromium and WebKit × en/zh/zh-TW/ja/de × 1100/420; `node --test`, playwright 1.57.0).

**Branch with both commits**: [hunt-20261112-t1-5273](https://github.com/ggbdpq/magpie/tree/hunt-20261112-t1-5273) (head `b0c80a5b45a0fe11`) — the first commit is Elio9352's fix, the second pays for it on today's main: the fix costs 278 bytes of core script, and `coreScriptBudget` (already raised three times today by main's own work, now 1,264,422) goes to 1,264,700 — exactly what the core weighs with the fix in, with the reason in the commit.

**What else ran**, at the final head unless noted:

- `go test ./internal/gui`, whole package: - on this tip: only `TestProxyCheckSaysAProxyPassedBy` and `TestSessionReadsRoutes` red — both red on the unpatched tip here too; `TestCoreScriptBudget` red with the fix alone on the tip ("the core's scripts are 1,264,700 bytes of code, over their budget of 1,264,422"), green at the final head.
- The four GUI tests pressing these buttons, against the patched assets: `models-free-only` 4/4, `provider-draft-picks` 10/10, `models-select-all-api` 20/20 green; `models-works-only` red 8/8 with the fix and the same 8/8 without it on this machine (a 5 s locator timeout, not this change).
- `gofmt` and `go vet` clean; GOOS=linux and windows build (nogui) ok; `node --check` on `app.js` and `i18n.js` ok.
- `git am` of the two patches onto `ea3a00adc` replays to the identical tree.

**Siblings**: Select all and Free only already went through the filter's match; the fix shares one match (`shownBy`) between the three, and Free only's behaviour is unchanged. The removed `Unpick every model` key had no other consumer (`rg` over assets and tests); the four tests above are the buttons' other pressers.

**Not verified**: WebKit on Linux/Windows (my WebKit run is macOS), a real Docker/web deployment, providers with far more than the test's 30 models.

---
**Source**: reported in #5273 with a fix branch; my verification on macOS.

**Attribution**: AI-written (this comment and the budget commit; the fix is Elio9352's, kept as author with their own Co-authored-by line). Please keep the author (`Elio9352`) for the first commit.

**Patch**: <details><summary>patches: 0001 providers: Select none under a filter unpicks only the models it shows (Elio9352) · 0002 core: the script budget goes to what the core's scripts weigh now — git am applies them as is; SHA-256 first 16: e39aff392ca8f808 / 883d799e9a7b96f5</summary>

````
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
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
index 01f2c0d71..a6d70bf8a 100644
--- a/internal/gui/assets/app.js
+++ b/internal/gui/assets/app.js
@@ -11968,20 +11968,35 @@ function renderModels(p) {
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
@@ -11990,7 +12005,7 @@ function renderModels(p) {
     freeOn.title = t("Pick only the free models (those the filter shows), unpicking the others");
     freeOn.onclick = () => {
       const f = (q?.value || "").trim().toLowerCase();
-      draft.chosen = p.models.filter((m) => isFree(m) && !noAPI(m) && (!f || m.id.toLowerCase().includes(f) || (m.name || "").toLowerCase().includes(f) || (m.default || "").toLowerCase().includes(f))).map((m) => m.id);
+      draft.chosen = p.models.filter((m) => isFree(m) && !noAPI(m) && shownBy(f, m.id)).map((m) => m.id);
       draft.none = true;
       draw();
     };
diff --git a/internal/gui/assets/i18n.js b/internal/gui/assets/i18n.js
index 3fea31ac9..ea2f78122 100644
--- a/internal/gui/assets/i18n.js
+++ b/internal/gui/assets/i18n.js
@@ -2993,7 +2993,7 @@ const I18N = {
     "Test stopped": "已停止测试",
     "Pick every model listed that this provider can serve (those the filter shows)": "选中列出的、这个供应商能提供的所有模型（有筛选时只选筛出来的）",
     "{p} has no URL for the API its list serves it on ({apis}), so agents aren't offered it. Add that URL, or set the API it is asked on in Model settings.": "{p} 没有它的列表所说接口（{apis}）的地址，所以 Agent 看不到它。填上那个地址，或在「模型设置」里设定它走的接口。",
-    "Unpick every model": "取消选中所有模型",
+    "Unpick every model (those the filter shows)": "取消选中所有模型（有筛选时只取消筛出来的）",
     "Send a tiny request to each model agents see, to find the ones that don't answer": "向 Agent 可见的每个模型发一个极小请求，找出无响应的模型",
     "{n} of {all} models didn't answer; {model}: {error}": "{all} 个模型中有 {n} 个没有响应；{model}：{error}",
     "All {n} models answered": "{n} 个模型全部可用",
@@ -8097,7 +8097,7 @@ const I18N = {
     "Test stopped": "已停止測試",
     "Pick every model listed that this provider can serve (those the filter shows)": "選中列出的、這個供應商能提供的所有模型（有篩選時只選篩出來的）",
     "{p} has no URL for the API its list serves it on ({apis}), so agents aren't offered it. Add that URL, or set the API it is asked on in Model settings.": "{p} 沒有它的列表所說介面（{apis}）的位址，所以 Agent 看不到它。填上那個位址，或在「模型設定」裡設定它走的介面。",
-    "Unpick every model": "取消選中所有模型",
+    "Unpick every model (those the filter shows)": "取消選中所有模型（有篩選時只取消篩出來的）",
     "Send a tiny request to each model agents see, to find the ones that don't answer": "向 Agent 可見的每個模型發一個極小請求，找出無回應的模型",
     "{n} of {all} models didn't answer; {model}: {error}": "{all} 個模型中有 {n} 個沒有回應；{model}：{error}",
     "All {n} models answered": "{n} 個模型全部可用",
@@ -13223,7 +13223,7 @@ const I18N = {
     "Test stopped": "テストを停止しました",
     "Pick every model listed that this provider can serve (those the filter shows)": "このプロバイダーが提供できる一覧のすべてのモデルを選択（フィルター中は表示中のもの）",
     "{p} has no URL for the API its list serves it on ({apis}), so agents aren't offered it. Add that URL, or set the API it is asked on in Model settings.": "{p} には、一覧が示す API（{apis}）の URL がないため、エージェントには表示されません。その URL を追加するか、「モデル設定」で使う API を設定してください。",
-    "Unpick every model": "すべてのモデルの選択を解除",
+    "Unpick every model (those the filter shows)": "すべてのモデルの選択を解除（フィルター中は表示中のもの）",
     "Send a tiny request to each model agents see, to find the ones that don't answer": "エージェントに見える各モデルに小さなリクエストを送り、応答しないモデルを見つけます",
     "{n} of {all} models didn't answer; {model}: {error}": "{all} 個中 {n} 個のモデルが応答しませんでした。{model}：{error}",
     "All {n} models answered": "{n} 個のモデルすべてが応答しました",
@@ -18358,7 +18358,7 @@ const I18N = {
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
````

````
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
index 73bf52f2d..50eccfed3 100644
--- a/internal/gui/core_budget_test.go
+++ b/internal/gui/core_budget_test.go
@@ -18,7 +18,7 @@ import (
 // `git log -L` of this file.
 const (
 	appScriptBudget  = 1_086_267 // app.js: 1,080,614 at 8016205e3, with the 5,653 of room it had
-	coreScriptBudget = 1_264_422 // every core script at 8016205e3, the old measure 682 over its cap there (#5918); +367 for the model test on a chosen account (tmr11235), no page left to move it to; +151 for the provider menu's "Only on this device" item and its four translations; +458 for Settings › About's Report a problem row and its translations; +113 for withScheme, the one rule every typed address goes through (eachg0 on X), cut to the shortest form that keeps it whole
+	coreScriptBudget = 1_264_700 // every core script at 8016205e3, the old measure 682 over its cap there (#5918); +367 for the model test on a chosen account (tmr11235), no page left to move it to; +151 for the provider menu's "Only on this device" item and its four translations; +458 for Settings › About's Report a problem row and its translations; +113 for withScheme, the one rule every typed address goes through (eachg0 on X), cut to the shortest form that keeps it whole; +278 for Select none under a filter sharing Select all's match (#5273, Elio9352)
 )
 
 // codeBytes is how many bytes of b are code: its blank lines, its lines
-- 
2.50.1 (Apple Git-155)
````

</details>
