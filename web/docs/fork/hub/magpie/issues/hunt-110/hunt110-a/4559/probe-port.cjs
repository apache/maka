const { webkit } = require("playwright");
const TOK = "1".repeat(32);
const directives = (own) => [
  "sandbox allow-scripts", "default-src 'none'", `script-src ${own}`, `style-src ${own} 'unsafe-inline'`,
  `img-src ${own} data:`, `font-src ${own}`, `media-src ${own}`, "connect-src 'none'", "frame-src 'none'",
  "worker-src 'none'", "object-src 'none'", "form-action 'none'", "base-uri 'none'", "frame-ancestors 'self'",
].join("; ");
(async () => {
  const browser = await webkit.launch();
  const page = await (await browser.newContext()).newPage();
  const lines = [];
  page.on("console", (m) => lines.push(m.text()));
  const own = `127.0.0.1:3437/_magpie/plugin/${TOK}/`;
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const head = (type) => ({ status: 200, headers: { "Content-Security-Policy": directives(own), "Content-Type": type } });
    if (url.pathname === "/") return route.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><iframe sandbox="allow-scripts" src="/_magpie/plugin/${TOK}/index.html"></iframe><script>addEventListener("message",(e)=>{window.__got=(window.__got||[]).concat(e.data&&e.data.ran?["ran"]:[])});</script>` });
    if (url.pathname === `/_magpie/plugin/${TOK}/index.html`) return route.fulfill({ ...head("text/html"), body: `<!doctype html><script src="app.js"></script>` });
    if (url.pathname === `/_magpie/plugin/${TOK}/app.js`) return route.fulfill({ ...head("text/javascript"), body: `parent.postMessage({ran:true},"*");` });
    return route.fulfill({ status: 404, body: "" });
  });
  await page.goto("http://127.0.0.1:3437/");
  let out = "no-message";
  try { await page.waitForFunction(() => (window.__got || []).length > 0, undefined, { timeout: 3000 }); out = "script-ran"; } catch {}
  console.log(`webkit own=<${own}> sandboxAttr=true: ${out}`);
  for (const l of lines) console.log(`  console: ${l}`);
  await browser.close();
})();
