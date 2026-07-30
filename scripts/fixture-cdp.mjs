// Boot an e2e-fixture window and talk to its renderer over CDP.
//
// Extracted from audit-alignment.mjs, which proved the approach: spawn the
// real Electron app with MAKA_E2E_FIXTURE, wait for a page target, evaluate
// in the renderer. The migration contract harness needs the same boot for a
// different question, so the boot lives here and each script brings its own
// expression.
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP_DIR = join(ROOT, 'apps', 'desktop');

export const DEFAULT_BOOT_TIMEOUT_MS = Number(process.env.FIXTURE_CDP_BOOT_TIMEOUT_MS ?? 30_000);
export const DEFAULT_SETTLE_MS = Number(process.env.FIXTURE_CDP_SETTLE_MS ?? 2_500);
export const DEFAULT_EVALUATE_TIMEOUT_MS = Number(
  process.env.FIXTURE_CDP_EVALUATE_TIMEOUT_MS ?? 60_000,
);

let nextPort = Number(process.env.FIXTURE_CDP_PORT_BASE ?? 14_600);

export async function resolveElectronBin() {
  try {
    const bin = (await import('electron')).default;
    if (typeof bin === 'string') return bin;
  } catch (err) {
    console.error('[fixture-cdp] electron not resolvable (run `npm install`):', err);
    process.exit(2);
  }
  console.error('[fixture-cdp] electron resolved but exposed no binary path; run `npm install`.');
  process.exit(2);
}

// Chromium/Electron switches must come before the app path. Mirror the
// Playwright e2e launch: cwd=apps/desktop, app='.'.
function launchArgs(debugPort, userDataDir) {
  const args = [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${userDataDir}`];
  // Headless Linux runners need these; macOS/Windows pass without them.
  // Playwright's chromium launcher adds the same set — raw electron spawn
  // does not.
  if (process.platform === 'linux') {
    args.push('--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage');
  }
  args.push('.');
  return args;
}

function ringBuffer(limit = 8_000) {
  return {
    s: '',
    push(chunk) {
      this.s += chunk;
      if (this.s.length > limit) this.s = this.s.slice(-limit / 2);
    },
    tail(n = 600) {
      return this.s.length <= n ? this.s : this.s.slice(-n);
    },
  };
}

/** Poll CDP until a page target appears, or the process exits / times out. */
async function waitForPageTarget(debugPort, child, stderr, stdout, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `electron exited code=${child.exitCode} signal=${child.signalCode}` +
          ` stderr=${JSON.stringify(stderr.tail())} stdout=${JSON.stringify(stdout.tail())}`,
      );
    }
    try {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `CDP timeout after ${timeoutMs}ms` +
      ` stderr=${JSON.stringify(stderr.tail())} stdout=${JSON.stringify(stdout.tail())}`,
  );
}

function cdpSend(ws) {
  let id = 0;
  return (method, params) =>
    new Promise((resolve, reject) => {
      const i = ++id;
      const onMessage = (event) => {
        let payload;
        try {
          payload = JSON.parse(event.data);
        } catch (err) {
          reject(err);
          return;
        }
        if (payload.id !== i) return;
        ws.removeEventListener('message', onMessage);
        if (payload.error)
          reject(new Error(payload.error.message ?? JSON.stringify(payload.error)));
        else resolve(payload.result);
      };
      ws.addEventListener('message', onMessage);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
}

// Freeze everything that would otherwise make two captures of the same build
// differ: in-flight transitions and animations, caret blink, and text that
// reflows when a webfont swaps in. Returns once the renderer has painted
// twice with all of that settled.
const SETTLE_EXPR = `(async () => {
  const style = document.createElement('style');
  style.id = 'maka-contract-freeze';
  style.textContent = '*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important;scroll-behavior:auto!important}';
  if (!document.getElementById('maka-contract-freeze')) document.head.appendChild(style);
  try { await document.fonts.ready; } catch {}
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return true;
})()`;

/**
 * Boot one fixture window, hand a renderer evaluator to `fn`, then tear the
 * window down. `fn` receives `{ evaluate, dispatch }`: evaluate(expression)
 * returns the expression's value (awaited if it is a promise), and dispatch
 * is the raw CDP channel, for domains like Input where a real event has to
 * travel the browser's own path rather than be synthesized in the page.
 */
export async function withFixtureWindow(scenario, options, fn) {
  const {
    theme = 'light',
    width,
    height,
    // A fixture window stays hidden for its whole lifecycle unless this is
    // set. Reading computed style works either way, but anything that depends
    // on the compositor — hit testing, real input — needs a mapped window.
    showWindow = false,
    settleMs = DEFAULT_SETTLE_MS,
    bootTimeoutMs = DEFAULT_BOOT_TIMEOUT_MS,
    evaluateTimeoutMs = DEFAULT_EVALUATE_TIMEOUT_MS,
  } = options ?? {};
  const electronBin = await resolveElectronBin();
  const debugPort = nextPort++;
  const userDataDir = join(tmpdir(), `maka-fixture-cdp-${debugPort}-${process.pid}`);
  const stderr = ringBuffer();
  const stdout = ringBuffer();
  const child = spawn(electronBin, launchArgs(debugPort, userDataDir), {
    cwd: DESKTOP_DIR,
    env: {
      ...process.env,
      MAKA_E2E_FIXTURE: scenario,
      MAKA_E2E_FIXTURE_THEME: theme,
      ...(showWindow ? { MAKA_E2E_SHOW_WINDOW: '1' } : {}),
      ...(width ? { MAKA_E2E_FIXTURE_WIDTH: String(width) } : {}),
      ...(height ? { MAKA_E2E_FIXTURE_HEIGHT: String(height) } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Own the process group so teardown can take Electron's renderer and GPU
    // helpers with it. Killing only the main process leaves them orphaned,
    // and enough of those accumulate to starve later windows.
    detached: true,
  });
  child.stderr?.on('data', (d) => stderr.push(String(d)));
  child.stdout?.on('data', (d) => stdout.push(String(d)));
  // Surface spawn failures (ENOENT etc.) as a rejection instead of an
  // unhandled 'error' event that would kill the process mid-run.
  const launchError = new Promise((_, reject) => child.once('error', reject));
  let ws;
  try {
    const page = await Promise.race([
      waitForPageTarget(debugPort, child, stderr, stdout, bootTimeoutMs),
      launchError,
    ]);
    // The fixture keeps painting after the page target appears.
    await new Promise((r) => setTimeout(r, settleMs));
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('cdp websocket error')), { once: true });
    });
    const send = cdpSend(ws);
    const evaluate = async (expression) => {
      // Without a deadline a wedged renderer hangs the whole run: CDP simply
      // never answers, and the caller waits forever with nothing to report.
      const result = await Promise.race([
        send('Runtime.evaluate', {
          expression,
          returnByValue: true,
          awaitPromise: true,
        }),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`renderer did not answer within ${evaluateTimeoutMs}ms`)),
            evaluateTimeoutMs,
          ),
        ),
      ]);
      if (result.exceptionDetails) {
        throw new Error(
          result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
        );
      }
      return result.result.value;
    };
    await evaluate(SETTLE_EXPR);
    return await fn({ evaluate, dispatch: send });
  } finally {
    try {
      ws?.close();
    } catch {
      // ignore
    }
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // group already gone, or the platform refused it
      child.kill('SIGKILL');
    }
    // Wait for the process to actually go. Returning while Electron's helper
    // processes are still alive lets them pile up across a multi-route run
    // and starve the next window — that showed up as the last route timing
    // out while the same route passed on its own.
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => {
        const done = () => resolve();
        child.once('exit', done);
        setTimeout(done, 5_000);
      });
    }
  }
}
