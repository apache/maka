## Summary

The small copy patch for the setting's scope, as offered above: option C. The Long conversations line now says what its delivery path is — the threshold rides the model list magpie serves — so a reader can tell why a subscription's own models don't follow it. This states today's behavior as traced in the diagnosis above; it decides nothing. It stays true under A, and under B it is the first line to update, which is what a scope note is for. @yetone it doesn't wait on the A/B call, per the joint comment above.

## What changed

One sentence, five places. Before (the sub of the `fullContextRow` in index.html):

> Codex and Claude Code compact at 272K (non-Claude [1m] too) or the size typed; full window: slower, costlier

After:

> Codex and Claude Code compact at 272K (non-Claude [1m] too) or the size typed, on magpie's models only; a subscription's own models keep their own window and compaction; full window: slower, costlier

The same sentence's key and values move in i18n.js for all four languages (zh, zh-TW, ja, de), keeping the file's established terms for "magpie's models" and "subscription". The key is the English itself, so the key moves with the copy; the old sentence is said nowhere else in the repo (checked with `rg`), so nothing else needed the edit. No `.go` file, no test, no behavior — the list magpie serves is what it was (#674 semantics untouched).

## Verification

| Run | Result |
|---|---|
| `i18n-keys.test.cjs` (node --test) on the branch head (main `63c0c354` + this commit) | ok 4/4 |
| `compact-at.test.cjs`, chromium, en and zh | ok 4/4 |
| `compact-at.test.cjs`, webkit, en and zh | ok 4/4 |
| byte check: the index.html line equals the i18n.js key; old string gone; key once per language | ok |
| `git apply --check` of the patch below on main `63c0c354` | clean |
| gofmt, go vet, go build | not run — nothing but an .html line and i18n.js values changed |
| the rest of the GUI suite | not run |

## Notes

- Base: the branch was first cut at `4683a0382`; upstream moved today (the async-compaction wording and the Codex app/WSL keys land right beside this line in i18n.js), so the commit was re-based onto main `63c0c354` and the specs re-run there — the patch applies as is on current main.
- The line renders as one line with an ellipsis (`.row .sub` is nowrap in app.css), so the tail truncates on a narrow window as it does today; the scope costs about 90 characters in English. If you want it shorter, the "(non-Claude [1m] too)" parenthetical is the trimmable part — the scope clause is the point.
- This does not fix the compaction miss itself: the threshold still rides the served list (A), and extending its scope stays open (B). It answers the reporter's second ask — say the setting's coverage in the interface — while the decision is open.

---

**Source**: issue #3440; the diagnosis and the joint comment above, where C was put as compatible with both readings and the place to start, and the reporter's second ask: if the setting only covers the models magpie provides, the interface should say so.

**Siblings**: the sentence lives in one element (index.html) and one key per language in i18n.js; no plugin file says it (the i18n-keys walk covers that), and no `.go` file or test pins the old text — `rg 'compact at 272K'` over the repo returns exactly the five lines this patch rewrites.

Branch with the commit: [hunt78-d2-compact-copy](https://github.com/ggbdpq/magpie/tree/hunt78-d2-compact-copy) (head `3b01d77ef04e1aa800f86419e030696998d0c772`).

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: hunt78-d2-compact-copy (#3440) — git am applies it as is; SHA-256 first 16: ac73c6b75fe1ac88</summary>

```text
From 3b01d77ef04e1aa800f86419e030696998d0c772 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sat, 24 Oct 2026 22:47:38 +0800
Subject: [PATCH] =?UTF-8?q?gui:=20Long=20conversations=20says=20its=20scop?=
 =?UTF-8?q?e=20=E2=80=94=20magpie's=20models=20only=20(#3440)?=
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

The line said Codex and Claude Code compact at 272K (or the size
typed) with no word on which models: the threshold rides the model
list magpie serves, so a subscription's own models (the ChatGPT or
Claude account's own entries, #674) never see it — they keep their
own window and the agent's own compaction. The reporter asked for
exactly this in #3440: say the scope in the interface. The line and
its four translations (zh, zh-TW, ja, de) now do. No behavior
changes — the list magpie serves is what it was.

What changed: the sub line of #fullContextRow (index.html) and the
matching key and values in i18n.js, all four languages. The key is
the English itself, so the key moves with the copy.

Run: i18n-keys.test.cjs 4/4 pass; compact-at.test.cjs 8/8 pass
(chromium and webkit, en and zh). gofmt / go vet / go build not run —
nothing but an .html line and i18n.js values changed.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gui/assets/i18n.js    | 8 ++++----
 internal/gui/assets/index.html | 2 +-
 2 files changed, 5 insertions(+), 5 deletions(-)

diff --git a/internal/gui/assets/i18n.js b/internal/gui/assets/i18n.js
index a315b18e..4d110109 100644
--- a/internal/gui/assets/i18n.js
+++ b/internal/gui/assets/i18n.js
@@ -1042,7 +1042,7 @@ const I18N = {
     "Codex app": "Codex 应用",
     "Codex editor extension": "编辑器里的 Codex 扩展",
     "Codex in WSL": "WSL 里的 Codex",
-    "Codex and Claude Code compact at 272K (non-Claude [1m] too) or the size typed; full window: slower, costlier": "Codex 和 Claude Code 在 272K（非 Claude 的 [1m] 模型也是）或这里填的大小时压缩；完整窗口每轮更慢更贵",
+    "Codex and Claude Code compact at 272K (non-Claude [1m] too) or the size typed, on magpie's models only; a subscription's own models keep their own window and compaction; full window: slower, costlier": "Codex 和 Claude Code 在 272K（非 Claude 的 [1m] 模型也是）或这里填的大小时压缩，只作用于 magpie 的模型；订阅自带的模型保留自己的窗口和压缩行为；完整窗口每轮更慢更贵",
     "Compact at {n}": "{n} 时压缩",
     "Codex thread titles": "Codex 会话标题",
     "Codex thread descriptions": "Codex 会话描述",
@@ -4975,7 +4975,7 @@ const I18N = {
     "Codex app": "Codex 應用程式",
     "Codex editor extension": "編輯器裡的 Codex 擴充功能",
     "Codex in WSL": "WSL 裡的 Codex",
-    "Codex and Claude Code compact at 272K (non-Claude [1m] too) or the size typed; full window: slower, costlier": "Codex 和 Claude Code 在 272K（非 Claude 的 [1m] 模型也是）或這裡填的大小時壓縮；完整視窗每輪更慢更貴",
+    "Codex and Claude Code compact at 272K (non-Claude [1m] too) or the size typed, on magpie's models only; a subscription's own models keep their own window and compaction; full window: slower, costlier": "Codex 和 Claude Code 在 272K（非 Claude 的 [1m] 模型也是）或這裡填的大小時壓縮，只作用於 magpie 的模型；訂閱自帶的模型保留自己的視窗和壓縮行為；完整視窗每輪更慢更貴",
     "Compact at {n}": "{n} 時壓縮",
     "Codex thread titles": "Codex 會話標題",
     "Codex’s own (ChatGPT)": "Codex 自帶（ChatGPT）",
@@ -8870,7 +8870,7 @@ const I18N = {
     "Codex app": "Codex アプリ",
     "Codex editor extension": "エディタの Codex 拡張機能",
     "Codex in WSL": "WSL の Codex",
-    "Codex and Claude Code compact at 272K (non-Claude [1m] too) or the size typed; full window: slower, costlier": "Codex と Claude Code は 272K（Claude 以外の [1m] モデルも）か入力したサイズで圧縮。ウィンドウ全体は遅く高価",
+    "Codex and Claude Code compact at 272K (non-Claude [1m] too) or the size typed, on magpie's models only; a subscription's own models keep their own window and compaction; full window: slower, costlier": "Codex と Claude Code は 272K（Claude 以外の [1m] モデルも）か入力したサイズで圧縮。対象は magpie のモデルのみで、サブスクリプション自身のモデルはそれぞれのウィンドウと圧縮に従う。ウィンドウ全体は遅く高価",
     "Compact at {n}": "{n} で圧縮",
     "Codex thread titles": "Codex のスレッドタイトル",
     "Codex thread descriptions": "Codex のスレッド説明",
@@ -12799,7 +12799,7 @@ const I18N = {
     "Codex app": "Codex-App",
     "Codex editor extension": "Codex-Erweiterung im Editor",
     "Codex in WSL": "Codex in WSL",
-    "Codex and Claude Code compact at 272K (non-Claude [1m] too) or the size typed; full window: slower, costlier": "Codex/Claude Code komprimieren bei 272K (auch [1m] außer Claude) oder hier; volles Fenster: teurer",
+    "Codex and Claude Code compact at 272K (non-Claude [1m] too) or the size typed, on magpie's models only; a subscription's own models keep their own window and compaction; full window: slower, costlier": "Codex/Claude Code komprimieren bei 272K (auch [1m] außer Claude) oder hier, nur für magpie-Modelle; Modelle eines Abos behalten ihr eigenes Fenster und ihre eigene Komprimierung; volles Fenster: teurer",
     "Compact at {n}": "Bei {n} komprimieren",
     "Codex thread titles": "Codex-Thread-Titel",
     "Codex thread descriptions": "Codex-Thread-Beschreibungen",
diff --git a/internal/gui/assets/index.html b/internal/gui/assets/index.html
index 74791fe1..a233e8f1 100644
--- a/internal/gui/assets/index.html
+++ b/internal/gui/assets/index.html
@@ -440,7 +440,7 @@
     <div id="codexAgentsV1Segs"></div>
   </div>
   <div class="row pref" id="fullContextRow">
-    <div class="who"><div class="name" data-t>Long conversations</div><div class="sub" data-t>Codex and Claude Code compact at 272K (non-Claude [1m] too) or the size typed; full window: slower, costlier</div></div>
+    <div class="who"><div class="name" data-t>Long conversations</div><div class="sub" data-t>Codex and Claude Code compact at 272K (non-Claude [1m] too) or the size typed, on magpie's models only; a subscription's own models keep their own window and compaction; full window: slower, costlier</div></div>
     <div id="fullContextSegs"></div>
   </div>
   <div class="row pref" id="codexAsyncRow">
-- 
2.50.1 (Apple Git-155)

```

</details>
