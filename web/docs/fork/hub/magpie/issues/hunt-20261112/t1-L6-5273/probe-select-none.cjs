// Behavioral probe for #5273: Select none under a filter.
// Usage: node probe-select-none.cjs <assets-dir> [engine=chromium]
// Reads what stays picked after: pick qwen-1,qwen-2,glm-1,glm-2 -> filter
// "glm" -> Select none -> clear filter. Patched assets keep qwen-1,qwen-2;
// assets before the fix lose them too.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright");

const assets = path.resolve(process.argv[2]);
const engine = process.argv[3] || "chromium";

const fetched = new Date(Date.now() - 3600e3).toISOString();
const PICKED = ["qwen-1", "qwen-2", "glm-1", "glm-2"];
const ALL = [...Array.from({ length: 15 }, (_, i) => `qwen-${i}`), ...Array.from({ length: 15 }, (_, i) => `glm-${i}`)];
const relay = {
  id: "picked-relay", name: "Picked Relay", icon: "generic", host: "picked-relay.example.com",
  chat: "https://picked-relay.example.com/v1", responses: "", anthropic: "", catalog: "",
  speaks: ["chat"],
  models: ALL.map((id, i) => ({ id, name: id, on: PICKED.includes(id) })),
  chosen: PICKED, fetched, agents: [], fallback: [], headers: {},
  key: { set: true, masked: "sk-…one" }, keyList: [], balanceToken: { takes: false, set: false }, proxy: "",
};
const providers = { providers: [relay], presets: [], excluded: [], gateway: { running: true, window: true } };
const state = { agents: [], profiles: [], settings: { lang: "en", theme: "light" } };

async function serve(route) {
  const req = route.request(), url = new URL(req.url());
  const json = (data) => route.fulfill({ json: data });
  if (url.pathname === "/boot.js") return route.fulfill({ contentType: "text/javascript", body: `window.bootPrefs = {lang:"en",theme:"light",web:true};` });
  if (url.pathname === "/wails/runtime.js") return route.fulfill({ contentType: "text/javascript", body: "export const Window = {};" });
  if (req.method() === "POST" && url.pathname.startsWith("/api/")) return json({});
  if (url.pathname === "/api/state") return json(state);
  if (url.pathname === "/api/plugins") return json({ plugins: [] });
  if (url.pathname === "/api/providers") return json(providers);
  if (url.pathname === "/api/groups") return json({ groups: [] });
  if (url.pathname.startsWith("/api/")) return json({});
  const file = path.join(assets, url.pathname === "/" ? "index.html" : url.pathname);
  const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(file)];
  await route.fulfill({ body: await fs.readFile(file), contentType });
}

async function main() {
  const browser = await chromium.launch({ channel: engine === "webkit" ? undefined : "chromium" });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1100, height: 760 }, reducedMotion: "reduce" })).newPage();
    page.setDefaultTimeout(5000);
    await page.route("**/*", serve);
    await page.goto("http://magpie.test/?view=providers");
    const editor = page.locator("#modal:not([hidden]) .editor");
    await page.locator(".row.provider", { hasText: "Picked Relay" }).click();
    await editor.locator(".ehead b", { hasText: "Picked Relay" }).waitFor();
    await editor.locator(".mchips .mchip").first().waitFor();
    const q = editor.locator(".mbulk input");
    const noneBtn = editor.locator(".mbulk").getByRole("button", { name: "Select none", exact: true });
    await q.fill("glm");
    await noneBtn.click();
    await q.fill("");
    const on = await editor.locator(".mchips .mchip.on").evaluateAll((cs) => cs.map((c) => c.querySelector("span").textContent).sort());
    console.log("still picked after Select none under 'glm':", JSON.stringify(on));
    console.log(on.length === 2 ? "PATCHED BEHAVIOUR (filter-scoped)" : on.length === 0 ? "PRE-FIX BEHAVIOUR (cleared everything)" : "UNEXPECTED");
  } finally {
    await browser.close();
  }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
