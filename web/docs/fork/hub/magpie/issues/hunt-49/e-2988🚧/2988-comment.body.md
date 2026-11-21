The update-all test clicked Update all, slept a fixed 200ms, and then asserted the line says "Updating Codex… (1 of 3)". The fake update runs 500ms, so under load the click-to-assert path can take longer than the state lasts, and the run is already on "2 of 3" when the assertion reads the line.

Branch: [`hunt49-e-updateall-wait`](https://github.com/ggbdpq/magpie/tree/hunt49-e-updateall-wait), one commit on top of upstream `79160455`; the patch below applies with `git am`.

## What changed

- The test waits for the states it asserts instead of the clock: `waitForFunction` for "Updating Codex… (1 of 3)" after the click, and for "Updating Gemini CLI… (2 of 3)" after the second click — the shape `bad4508c` used for TestFXStateDoesNotWait and which this file's own second case already uses.
- The fake update's length becomes a per-test knob (`updateMs`), 1500ms in this case, so the "1 of 3" state has room to be seen on a busy machine. The file's other `waitForTimeout`s sit outside the reported assertion path and stay as they were; the second case's shape is unchanged.

## Verification

| Check | Result |
| --- | --- |
| `NODE_PATH=<playwright 1.57 cache> node --test internal/gui/tests/agent-update-all.test.cjs` | 18/18 pass, three runs, chromium and webkit both |
| ablation: the fixed 200ms back, by construction | the assertion reads the line at an uncontrolled wall-clock offset from the click; the committed `waitForFunction` form has no fixed window to miss |

I could not reproduce the load failure locally (the issue reports it from a loaded run, without a command); the fix removes the fixed window by construction — the waits now track the fake state machine rather than the wall clock.

**AI**: written with an AI coding agent; I've read the whole diff and can answer questions on it myself. The model name is in the commit's trailer.

**Attribution**: If you apply the patch, please keep its author (ggbdpq) or add a `Co-authored-by: ggbdpq <ggbdpq@gmail.com>` line.

<details><summary>patch: gui: agent-update-all waits for the progress state, not a fixed 200ms (#2988) — git am applies it as is; SHA-256 first 16: 516a2e9c0d195daa</summary>

```patch
From 111f9904586f4326a8ea46f3f6ec1a4718b88613 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Tue, 20 Oct 2026 06:11:12 +0800
Subject: [PATCH] gui: agent-update-all waits for the progress state, not a
 fixed 200ms (#2988)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

The update-all test clicked Update all, slept a fixed 200ms, and then
asserted the line says "Updating Codex… (1 of 3)". The fake update runs
500ms, so under load the click-to-assert path can take longer than that
and the run is already on "2 of 3" when the assertion reads the line
(red on origin/main, 2988).

What changed: the test waits for the states it asserts instead of the
clock - waitForFunction for "1 of 3" after the click and for "2 of 3"
after the second click - and the fake update's length is a per-test
knob (updateMs), 1500ms here, so the "1 of 3" state has room to be
seen on a busy machine. The other waits in the file are outside the
reported assertion path and stay as they were. The second case in the
file already waited on state; its shape is unchanged.

Run: NODE_PATH=<playwright 1.57> node --test
internal/gui/tests/agent-update-all.test.cjs - 18/18 pass, three runs,
chromium and webkit both.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gui/tests/agent-update-all.test.cjs | 8 ++++----
 1 file changed, 4 insertions(+), 4 deletions(-)

diff --git a/internal/gui/tests/agent-update-all.test.cjs b/internal/gui/tests/agent-update-all.test.cjs
index 95fb3a1d..47c0f3ae 100644
--- a/internal/gui/tests/agent-update-all.test.cjs
+++ b/internal/gui/tests/agent-update-all.test.cjs
@@ -53,7 +53,7 @@ function server(lang, opts) {
       log.posts.push(id);
       log.running++;
       log.most = Math.max(log.most, log.running);
-      await new Promise((r) => setTimeout(r, 500)); // an update takes a while
+      await new Promise((r) => setTimeout(r, opts.updateMs || 500)); // an update takes a while
       log.running--;
       if (id === "gemini") return route.fulfill({ status: 500, json: { error: "npm install -g @google/gemini-cli@latest: EACCES: permission denied" } });
       clis[id] = { ...clis[id], version: clis[id].latest, update: false };
@@ -104,7 +104,7 @@ for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium",
 
     await t.test("Update all runs each, one at a time, and says how it went", async () => {
       const log = {};
-      const page = await open("en", { log });
+      const page = await open("en", { log, updateMs: 1500 });
       const bar = page.locator("#agentsUpdates");
       await bar.waitFor();
       assert.equal(await bar.locator(".ag-updates-say").textContent(), "3 agents have updates: Codex, Gemini CLI, Crush");
@@ -118,13 +118,13 @@ for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium",
       await page.waitForTimeout(300);
       const top = await view.evaluate((v) => v.scrollTop);
       await bar.locator("button").click();
-      await page.waitForTimeout(200);
+      await page.waitForFunction(() => /^Updating Codex… \(1 of 3\)$/.test(document.querySelector("#agentsUpdates .ag-updates-say")?.textContent || ""), null, { timeout: 4000 });
       assert.match(await bar.locator(".ag-updates-say").textContent(), /^Updating Codex… \(1 of 3\)$/);
       assert.equal(await page.locator(`${row("codex")} .ag-up.busy`).count(), 1, "the row's pill is busy in its turn");
       assert.equal(await page.locator(`${row("gemini")} .ag-up.busy`).count(), 0);
       // clicked again while it runs: nothing more is asked
       await bar.locator("button").click({ force: true });
-      await page.waitForTimeout(500);
+      await page.waitForFunction(() => /Updating Gemini CLI… \(2 of 3\)/.test(document.querySelector("#agentsUpdates .ag-updates-say")?.textContent || ""), null, { timeout: 4000 });
       assert.match(await bar.locator(".ag-updates-say").textContent(), /Updating Gemini CLI… \(2 of 3\)/);
       await page.waitForFunction(() => /didn't/.test(document.querySelector("#agentsUpdates .ag-updates-say")?.textContent || ""), null, { timeout: 4000 });
       assert.deepEqual(log.posts, ["codex", "gemini", "crush"]);
-- 
2.50.1 (Apple Git-155)

```

</details>
