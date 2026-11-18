import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const chromium = [process.env.CHROME, 'chromium', 'chromium-browser', 'google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean).find((name) => {
  try { execFileSync(name, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
});

async function inChromium(prefix, html) {
  const generated = fileURLToPath(new URL('../../../../.nsh/', import.meta.url));
  await mkdir(generated, { recursive: true });
  const dir = await mkdtemp(join(generated, prefix));
  try {
    await writeFile(join(dir, 'index.html'), html);
    let result;
    try {
      result = execFileSync(chromium, ['--headless', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
        // Keep virtual time shared with a sandboxed frame. Its opaque origin remains enforced.
        '--disable-site-isolation-trials', '--allow-file-access-from-files', '--window-size=640,480', '--virtual-time-budget=5000',
        '--user-data-dir=' + join(dir, 'profile'), '--dump-dom', pathToFileURL(join(dir, 'index.html')).href],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
    } catch (error) {
      throw Error(`${chromium} failed: ${error.message}\n${error.stderr ?? ''}`, { cause: error });
    }
    return result.match(/data-result="([^"]*)"/)?.[1];
  } finally { await rm(dir, { recursive: true, force: true }); }
}

// A page that keeps one player for its whole life (a player has no way to be disposed) moves it from view to view:
// `player.root` goes into each view's container, and the container the player was made in leaves the document with
// its view. Every app `runModule` starts there must still get a realm of its own; none may run in the page's realm.
test('apps started after the player\'s first container left the document each run in a realm of their own',
  { skip: !chromium }, async () => {
    const runtime = pathToFileURL(fileURLToPath(new URL('./browser/runtime.js', import.meta.url))).href;
    // The engine is a stub that fails as the app starts: by then the runtime has made the app's realm and loaded the
    // browser facade into it, which is all this test looks at.
    const html = `<!doctype html><body><script type="module">
      import { createBrowserHost } from '${runtime}';
      const STARTED = 'the stub engine was reached';
      const check = (ok, message) => { if (!ok) throw Error(message); };
      const view = () => document.body.appendChild(document.createElement('div'));
      const player = {
        container: view(), baseURL: location.href, reset: () => [320, 240], requestPump() {}, showError() {},
        wasm: { nsh_browser_trace() {}, nsh_browser_initialize() { throw Error(STARTED); } },
      };
      const host = createBrowserHost(player);
      const facadesInPage = () => document.querySelectorAll('script[src$="/bootstrap.js"]').length;
      try {
        for (let run = 1; run <= 3; run++) {
          let error;
          try { await host.run(new URL('./app.js', location.href).href); } catch (e) { error = e; }
          check(error?.message === STARTED, 'run ' + run + ' did not start its app: ' + (error?.message ?? 'no error'));
          check(facadesInPage() === 0, 'run ' + run + ' ran its app in the page\\'s realm');
          // The page shows its next view; the player's first container went with the one before.
          if (run === 1) player.container.remove();
        }
        document.body.dataset.result = 'passed';
      } catch (e) { document.body.dataset.result = 'failed: ' + e.message; }
      </script></body>`;
    assert.equal(await inChromium('realm-browser-', html), 'passed');
  });

// What tells an opaque origin from a frame without a window: a page that is a `sandbox` without
// `allow-same-origin` gets a SecurityError from its own frame's document.
test('a sandboxed page reaching its own frame gets a SecurityError', { skip: !chromium }, async () => {
  const child = `<!doctype html><body><script>
    let name = 'no error';
    try {
      const frame = document.body.appendChild(document.createElement('iframe'));
      try { frame.contentWindow.document; } catch (e) { name = e.name; }
    } catch (e) { name = 'setup failed: ' + e.message; }
    parent.postMessage(name, '*');
    </script></body>`;
  const html = `<!doctype html><body><iframe sandbox="allow-scripts"></iframe><script>
    addEventListener('message', (e) => {
      document.body.dataset.result = e.data === 'SecurityError' ? 'passed' : 'failed: ' + e.data;
    });
    document.querySelector('iframe').srcdoc = ${JSON.stringify(child).replaceAll('</script', '<\\/script')};
    </script></body>`;
  assert.equal(await inChromium('realm-sandbox-browser-', html), 'passed');
});
