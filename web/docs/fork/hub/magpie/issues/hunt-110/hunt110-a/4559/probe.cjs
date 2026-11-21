// #4559 probe: does the engine run the frame's script when the frame's CSP
// names the page's folder with no scheme (the web route's shape, pagePolicy)
// — and with the scheme named (the native shape)? With and without the
// sandbox attribute (the window's frames are sandboxed without
// allow-same-origin, so the frame's origin is opaque).
const { chromium, webkit } = require("playwright");

const TOK = "0".repeat(32);
const directives = (own) => [
  "sandbox allow-scripts", "default-src 'none'", `script-src ${own}`, `style-src ${own} 'unsafe-inline'`,
  `img-src ${own} data:`, `font-src ${own}`, `media-src ${own}`, "connect-src 'none'", "frame-src 'none'",
  "worker-src 'none'", "object-src 'none'", "form-action 'none'", "base-uri 'none'", "frame-ancestors 'self'",
].join("; ");

const WINDOW_HTML = (sandboxed) => `<!doctype html><iframe ${sandboxed ? `sandbox="allow-scripts"` : ""} src="/_magpie/plugin/${TOK}/index.html"></iframe>
<script>addEventListener("message", (e) => { window.__got = (window.__got || []).concat(e.data && e.data.ran ? ["ran"] : []); });</script>`;

async function once(engineName, launcher, own, sandboxed) {
  const browser = await launcher.launch();
  const page = await (await browser.newContext()).newPage();
  const consoleLines = [];
  page.on("console", (m) => consoleLines.push(m.text()));
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const head = (type) => ({
      status: 200,
      headers: { "Content-Security-Policy": directives(own), "Content-Type": type },
    });
    if (url.pathname === "/") return route.fulfill({ status: 200, contentType: "text/html", body: WINDOW_HTML(sandboxed) });
    if (url.pathname === `/_magpie/plugin/${TOK}/index.html`) return route.fulfill({ ...head("text/html"), body: `<!doctype html><script src="app.js"></script>` });
    if (url.pathname === `/_magpie/plugin/${TOK}/app.js`) return route.fulfill({ ...head("text/javascript"), body: `parent.postMessage({ran:true},"*");` });
    return route.fulfill({ status: 404, body: "" });
  });
  await page.goto("http://magpie.test/");
  let out = "no-message";
  try {
    await page.waitForFunction(() => (window.__got || []).length > 0, undefined, { timeout: 3000 });
    out = "script-ran";
  } catch { out = "script-blocked-or-timeout"; }
  console.log(`${engineName} own=<${own}> sandboxAttr=${sandboxed}: ${out}`);
  if (out !== "script-ran") for (const l of consoleLines) console.log(`  console: ${l}`);
  await browser.close();
}

(async () => {
  const schemeless = `magpie.test/_magpie/plugin/${TOK}/`;
  const withScheme = `http://magpie.test/_magpie/plugin/${TOK}/`;
  for (const [name, launcher] of [["webkit", webkit], ["chromium", chromium]]) {
    for (const sandboxed of [true, false]) {
      await once(name, launcher, schemeless, sandboxed);
      await once(name, launcher, withScheme, sandboxed);
    }
  }
})();
