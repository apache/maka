import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';

// `nsh`'s `Storage` on the web, end to end: the built site's player runs demo
// `mod-storage` (a launch counter) in headless Chrome. Needs `bun run build`
// (website/dist with the player) and Chrome or Chromium (`CHROME`, or one on
// PATH); without either the tests are skipped with the reason.

const DIST = join(import.meta.dir, '..', 'dist');
const PLAYER = join(DIST, 'play', 'index.html');
const DEMO = join(DIST, 'play', 'demos', 'mod-storage.nshc');

function findChrome(): string | null {
  if (process.env.CHROME) return process.env.CHROME;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const path = Bun.which(name);
    if (path) return path;
  }
  return null;
}

const chrome = findChrome();
const missing = !existsSync(PLAYER) || !existsSync(DEMO)
  ? 'website/dist has no player with demo mod-storage (run `bun run build`)'
  : !chrome
    ? 'no Chrome or Chromium found (set CHROME, or put google-chrome / chromium on PATH)'
    : null;
if (missing) console.warn(`[storage.test] skipped: ${missing}`);

// A page beside the player (the same directory, so the same storage prefix):
// it puts keys of its own in localStorage, runs the demo in a frame, then
// presses its Reset button, and writes what localStorage held at each step
// into its DOM, which `--dump-dom` prints.
const CHECK_PAGE = `<!doctype html>
<meta charset="utf-8">
<pre id="result">pending</pre>
<iframe id="app" src="index.html#mod-storage" style="width:390px;height:700px;border:0"></iframe>
<script>
  localStorage.setItem("other", "x");
  localStorage.setItem("nsh:/elsewhere/:opened", "7");
  const result = document.getElementById("result");
  const frame = document.getElementById("app");
  const text = () => frame.contentDocument?.body?.innerText ?? "";
  const wait = (want, ms) => new Promise((resolve, reject) => {
    const until = Date.now() + ms;
    const poll = () => want() ? resolve() : Date.now() > until ? reject(new Error("timed out; frame: " + text())) : setTimeout(poll, 50);
    poll();
  });
  const snapshot = () => ({ keys: Object.keys(localStorage).sort(), other: localStorage.getItem("other"), text: text() });
  (async () => {
    const out = {};
    try {
      await wait(() => text().includes("Opened 1 times"), 6000);
      out.started = snapshot();
      const win = frame.contentWindow;
      const reset = [...frame.contentDocument.querySelectorAll("*")]
        .find((e) => e.childElementCount === 0 && e.textContent.trim() === "Reset");
      const r = reset.getBoundingClientRect();
      const at = { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0,
        clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
      reset.dispatchEvent(new win.PointerEvent("pointerdown", { ...at, buttons: 1 }));
      reset.dispatchEvent(new win.PointerEvent("pointerup", at));
      await wait(() => text().includes("Opened 0 times"), 4000);
      out.reset = snapshot();
    } catch (e) {
      out.error = String(e.message ?? e);
    }
    result.textContent = JSON.stringify(out);
  })();
</script>`;

/** Serves website/dist; `headers` are added to every response. */
function serve(headers: Record<string, string>) {
  return Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const path = decodeURIComponent(new URL(req.url).pathname);
      if (path === '/play/storage-check.html') {
        return new Response(CHECK_PAGE, { headers: { ...headers, 'content-type': 'text/html; charset=utf-8' } });
      }
      let file = normalize(join(DIST, path));
      if (!file.startsWith(DIST)) return new Response('forbidden', { status: 403, headers });
      if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
      if (!existsSync(file)) return new Response('not found', { status: 404, headers });
      return new Response(Bun.file(file), { headers });
    },
  });
}

/** Loads `url` in headless Chrome with the profile in `profile`; the DOM after the scripts ran. */
async function dumpDom(url: string, profile: string): Promise<string> {
  const proc = Bun.spawn(
    [
      chrome!,
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${profile}`,
      '--virtual-time-budget=8000',
      '--dump-dom',
      url,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`chrome exited with ${code}: ${err}`);
  return out;
}

/** The demo's counter text in a dumped player page ("Opened N times"). */
const counter = (dom: string) => dom.match(/Opened \d+ times/)?.[0] ?? `no counter in: ${dom.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 300)}`;

describe.skipIf(!!missing)('Storage in the browser', () => {
  let profiles: string;
  const profile = (name: string) => join(profiles, name);

  beforeAll(() => {
    profiles = mkdtempSync(join(tmpdir(), 'nsh-storage-test-'));
  });
  afterAll(() => {
    rmSync(profiles, { recursive: true, force: true });
  });

  test('entries persist across page loads', async () => {
    using server = serve({});
    const url = `http://127.0.0.1:${server.port}/play/index.html#mod-storage`;
    expect(counter(await dumpDom(url, profile('persist')))).toBe('Opened 1 times');
    expect(counter(await dumpDom(url, profile('persist')))).toBe('Opened 2 times');
  }, 60_000);

  test("entries are kept under the page's prefix, and clear removes only those", async () => {
    using server = serve({});
    const dom = await dumpDom(`http://127.0.0.1:${server.port}/play/storage-check.html`, profile('prefix'));
    const json = dom.match(/<pre id="result">([\s\S]*?)<\/pre>/)?.[1] ?? '';
    const result = JSON.parse(json.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
    expect(result.error).toBeUndefined();
    expect(result.started.keys).toEqual(['nsh:/elsewhere/:opened', 'nsh:/play/:lastOpened', 'nsh:/play/:opened', 'other']);
    expect(result.started.other).toBe('x');
    // keys() sees the app's own keys, without their prefix.
    expect(result.started.text).toContain('Keys: lastOpened, opened');
    expect(result.reset.keys).toEqual(['nsh:/elsewhere/:opened', 'other']);
    expect(result.reset.other).toBe('x');
    expect(result.reset.text).toContain('Keys: none');
  }, 60_000);

  test('without localStorage the app keeps its entries in memory', async () => {
    // An opaque origin: localStorage throws. The player's own requests
    // then come from origin "null", hence the CORS header.
    using server = serve({ 'content-security-policy': 'sandbox allow-scripts', 'access-control-allow-origin': '*' });
    const url = `http://127.0.0.1:${server.port}/play/index.html#mod-storage`;
    expect(counter(await dumpDom(url, profile('blocked')))).toBe('Opened 1 times');
    expect(counter(await dumpDom(url, profile('blocked')))).toBe('Opened 1 times');
  }, 60_000);
});

// A packaged app (`nsh package --target web`) keeps its entries under its
// `nsh.json` id, wherever its site is served. Needs the CLI built
// (`cargo build -p nsh-cli`; `NSH` names another) and Chrome; packaging
// builds the release web runtime first if it is not built yet.
const NSH = process.env.NSH ?? join(import.meta.dir, '..', '..', 'target', 'debug', 'nsh');
const packageMissing = !existsSync(NSH)
  ? `no nsh CLI at ${NSH} (run \`cargo build -p nsh-cli\`, or set NSH)`
  : !chrome
    ? 'no Chrome or Chromium found (set CHROME, or put google-chrome / chromium on PATH)'
    : null;
if (packageMissing) console.warn(`[storage.test] packaged app skipped: ${packageMissing}`);

const KEPT_APP = `import { mount, signal, Text } from "nsh";
import { Storage } from "nsh";

function App() {
  const opened = signal<number | null>(null);
  (async () => {
    const count = Number((await Storage.getItem("opened")) ?? "0") + 1;
    await Storage.setItem("opened", String(count));
    opened.set(count);
  })();
  return <Text>{opened() === null ? "Reading" : \`Opened \${opened()} times\`}</Text>;
}

mount(App);
`;

// Beside the site's page: runs it in a frame and writes the localStorage
// keys into its DOM once the app counted its launch.
const KEPT_CHECK = `<!doctype html>
<meta charset="utf-8">
<pre id="result">pending</pre>
<iframe id="app" src="index.html" style="width:390px;height:700px;border:0"></iframe>
<script>
  const frame = document.getElementById("app");
  const text = () => frame.contentDocument?.body?.innerText ?? "";
  const until = Date.now() + 6000;
  (function poll() {
    if (text().includes("Opened") || Date.now() > until) {
      document.getElementById("result").textContent = JSON.stringify({ keys: Object.keys(localStorage).sort(), text: text() });
    } else setTimeout(poll, 50);
  })();
</script>`;

describe.skipIf(!!packageMissing)('Storage in a packaged web app', () => {
  let work: string;

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'nsh-storage-package-'));
  });
  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
  });

  test("entries are kept under the app's id", async () => {
    const app = join(work, 'app');
    mkdirSync(app);
    writeFileSync(join(app, 'App.tsx'), KEPT_APP);
    writeFileSync(join(app, 'nsh.json'), JSON.stringify({ name: 'Kept', id: 'com.nsh.kept' }));
    const proc = Bun.spawn([NSH, 'package', app, '--target', 'web', '-o', join(work, 'out')], { stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(`nsh package exited with ${code}: ${out}${err}`);
    const site = join(work, 'out', 'Kept');
    using server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const path = decodeURIComponent(new URL(req.url).pathname);
        // Served under a path of its own: the id, not the path, names the entries.
        if (path === '/apps/kept/check.html') return new Response(KEPT_CHECK, { headers: { 'content-type': 'text/html; charset=utf-8' } });
        const file = normalize(join(site, path.replace(/^\/apps\/kept\//, '/')));
        if (!file.startsWith(site) || !existsSync(file) || statSync(file).isDirectory()) return new Response('not found', { status: 404 });
        return new Response(Bun.file(file));
      },
    });
    const dom = await dumpDom(`http://127.0.0.1:${server.port}/apps/kept/check.html`, join(work, 'profile'));
    const json = dom.match(/<pre id="result">([\s\S]*?)<\/pre>/)?.[1] ?? '';
    const result = JSON.parse(json.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
    expect(result.text).toContain('Opened 1 times');
    expect(result.keys).toEqual(['nsh:com.nsh.kept:opened']);
  }, 600_000);
});
