// [DEBUG-h101] timeline probe: sample card class / map size / overlap / getAnimations
// every 100ms from just before the read-wait clears to +2.5s after.
const fs = require("node:fs/promises");
const path = require("node:path");
const { webkit } = require("playwright");

const assets = path.resolve("/tmp/magpie-hunt101-a-3488-base/internal/gui/assets");
const now = Date.now();
const ago = (m) => new Date(now - m * 60000).toISOString();

const latest = {
  window: 272000, tokens: 21400, counted: true, turns: 3,
  parts: [
    { kind: "system", tokens: 5200, items: [{ name: "prompt", tokens: 4900 }, { name: "environment_context", tokens: 300 }] },
    { kind: "tools", tokens: 5000, items: [{ name: "multi_agent_v1", tag: "namespace", n: 5, tokens: 2900 }, { name: "exec_command", tokens: 2100 }] },
    { kind: "skills", tokens: 2600, items: [{ name: "skills", tag: "skills", tokens: 2600 }] },
    { kind: "memory", tokens: 700, items: [{ name: "/work/app/AGENTS.md", tag: "project", tokens: 700 }] },
    { kind: "files", tokens: 5900, items: [{ name: "/work/app/prompt.go", tag: "shell", tokens: 2950 }, { name: "/work/app/context.go", tag: "shell", tokens: 2950 }] },
    { kind: "results", tokens: 1200, items: [{ name: "exec_command", tag: "result", n: 4, tokens: 1200 }] },
    { kind: "chat", tokens: 800, items: [{ name: "turn", tag: "turn", n: 3, tokens: 800 }] },
  ],
};
const context = (days) => ({
  days,
  agents: [
    { agent: "codex", requests: 9, sessions: 1, errors: 0, calls: 9, median: 17700, p90: 21400, baseline: 13300, window: 272000, cache: 0.74, growth: 228, peakFill: 0.08, compacts: 0,
      shares: { system: 0.29, tools: 0.28, memory: 0.18, files: 0.18, results: 0.04, chat: 0.03 }, mcp: 0,
      score: 94, scores: [{ key: "cache", points: 29, most: 35 }, { key: "lean", points: 25, most: 25 }, { key: "pace", points: 20, most: 20 }, { key: "reliable", points: 20, most: 20 }],
      tags: [{ key: "lean", tone: "good", value: 13300 }, { key: "memory-heavy", tone: "info", value: 0.18 }],
      models: ["live/codex/gpt-5.6-luna"], latestId: 19, latestTime: ago(4) },
    { agent: "claude", requests: 12, sessions: 2, errors: 3, calls: 15, median: 140000, p90: 180000, baseline: 70000, window: 200000, cache: 0.2, growth: 9000, peakFill: 0.9, compacts: 1,
      shares: { system: 0.1, tools: 0.6, memory: 0.05, files: 0.1, results: 0.1, chat: 0.05 }, mcp: 28000,
      score: 31, scores: [{ key: "cache", points: 8, most: 35 }, { key: "lean", points: 3, most: 25 }, { key: "pace", points: 10, most: 20 }, { key: "reliable", points: 10, most: 20 }],
      tags: [{ key: "cache-misses", tone: "warn", value: 0.2 }, { key: "heavy-start", tone: "warn", value: 70000 }, { key: "mcp-heavy", tone: "info", value: 28000 }],
      models: ["claude-sonnet-5"], latestId: 30, latestTime: ago(9) },
  ],
  sessions: [
    { agent: "codex", key: "01a117b1-aecd-76e2-9b2f-3c1d", title: "Port the parser", model: "live/codex/gpt-5.6-luna", first: ago(12), last: ago(4), requests: 3, peak: 21400, window: 272000,
      latest, latestId: 19, points: [{ id: 17, time: ago(12), tokens: 13000, cache: 0 }, { id: 18, time: ago(8), tokens: 17700, cache: 12000 }, { id: 19, time: ago(4), tokens: 21400, cache: 20900 }] },
    { agent: "claude", key: "ce0c93f6-1111-2222-3333-444444444444", model: "claude-sonnet-5", first: ago(30), last: ago(9), requests: 1, peak: 180000, window: 200000,
      latest: { ...latest, window: 200000, tokens: 180000 }, latestId: 30, points: [{ id: 30, time: ago(9), tokens: 180000 }] },
  ],
});

function serve(lang) {
  const state = { agents: [{ id: "claude", name: "Claude Code", path: "/test/claude", fields: [] }, { id: "codex", name: "Codex", path: "/test/codex", fields: [] }], profiles: [], settings: { lang, theme: "light" } };
  return async (r) => {
    const url = new URL(r.request().url());
    const json = (data) => r.fulfill({ json: data });
    if (url.pathname === "/boot.js") return r.fulfill({ contentType: "text/javascript", body: `window.bootPrefs = {lang:"${lang}",theme:"light",web:true};` });
    if (url.pathname === "/wails/runtime.js") return r.fulfill({ contentType: "text/javascript", body: "export const Window = {};" });
    if (url.pathname === "/api/state") return json(state);
    if (url.pathname === "/api/context") return json(context(+url.searchParams.get("days")));
    if (url.pathname === "/api/context/text") { await new Promise((ok) => setTimeout(ok, 200)); return r.fulfill({ json: { id: 19, kind: url.searchParams.get("kind"), items: [], kept: 10 } }); }
    if (url.pathname.startsWith("/api/")) return json({});
    const file = path.join(assets, url.pathname === "/" ? "index.html" : url.pathname);
    const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(file)];
    await r.fulfill({ body: await fs.readFile(file).catch(() => ""), contentType, status: 200 });
  };
}

(async () => {
  const browser = await webkit.launch();
  const page = await (await browser.newContext({ viewport: { width: 420, height: 900 } })).newPage();
  page.setDefaultTimeout(5000);
  await page.route("**/*", serve("en"));
  await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem("magpie.usageTab", "context"); } catch {} });
  await page.goto("http://magpie.test/?view=usage");
  const row = page.locator(".ctx-sess-row", { hasText: "Port the parser" });
  await row.waitFor();
  await row.click();
  const card = page.locator(".ctx-sess.open .ctx-card");
  await card.waitFor();
  const map = card.locator(".ctx-map");
  await map.locator(".ctx-tile.k-tools").first().waitFor();
  const t0 = Date.now();

  const sample = () => map.evaluate((m) => {
    const rc = (n) => { const r = n.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; };
    const rects = [...m.querySelectorAll(".ctx-tile")].map(rc);
    let bad = 0;
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      if (!(a[2] <= b[0] + 0.5 || b[2] <= a[0] + 0.5 || a[3] <= b[1] + 0.5 || b[3] <= a[1] + 0.5)) bad++;
    }
    const card = m.closest(".ctx-card");
    const anims = document.getAnimations();
    const tileAnims = anims.filter((a) => a.effect?.target?.closest?.(".ctx-map"));
    return {
      bad, cardCls: card.className.replace("ctx-card", "").trim(),
      w: m.clientWidth, h: m.clientHeight, size: m.dataset.size || "",
      animsAll: anims.length, tileAnims: tileAnims.length,
      tileAnimDetail: tileAnims.slice(0, 4).map((a) => ({ c: a.constructor.name, ps: a.playState, tr: a.transitionProperty || a.animationName || "" })),
    };
  });

  // mimic the test's wait, note when it clears
  await page.waitForFunction(() => !document.getAnimations().some((a) => a.playState === "running" && a.effect?.target?.closest?.(".ctx-sess.open")));
  console.log(`[DEBUG-h101] wait cleared at +${Date.now() - t0}ms`);
  for (let i = 0; i < 26; i++) {
    const s = await sample();
    console.log(`[DEBUG-h101] +${Date.now() - t0}ms overlap=${s.bad} card="${s.cardCls}" map=${s.w}x${s.h} data-size=${s.size} anims=${s.animsAll} tileAnims=${s.tileAnims} ${JSON.stringify(s.tileAnimDetail)}`);
    if (i === 3) await page.screenshot({ path: "/tmp/magpie-hunt101-a-3488/probe-t1.png" });
    if (i === 20) await page.screenshot({ path: "/tmp/magpie-hunt101-a-3488/probe-t2.png" });
    await page.waitForTimeout(100);
  }
  await browser.close();
})().catch((e) => { console.error("PROBE FAIL", e); process.exit(1); });
