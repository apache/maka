// Boot an e2e-fixture window and evaluate in its renderer.
//
// This is the same launch the Playwright E2E suite performs, driven from a
// plain script so the migration contract harness can run outside the test
// runner (its baselines are host-specific, so it must not sit in CI). The
// environment builder is shared with that suite rather than restated; the
// launch, readiness wait, and teardown go through Playwright's Electron
// support rather than a second hand-rolled CDP client.
//
// An earlier version of this file did roll its own: fixed debug ports, a
// `/json/list` poll, a raw WebSocket, and a process-group kill. It attached to
// whatever was listening on the port, which meant a leftover Electron from a
// previous run was captured instead of the window this call launched — a
// silent wrong-window pass on a contract whose entire value is "no diff means
// the migration did not move this element".
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';
import { buildFixtureEnv } from './fixture-env.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP_DIR = join(ROOT, 'apps', 'desktop');

export const DEFAULT_READY_TIMEOUT_MS = Number(process.env.FIXTURE_READY_TIMEOUT_MS ?? 30_000);
export const DEFAULT_SETTLE_MS = Number(process.env.FIXTURE_SETTLE_MS ?? 1_000);
/**
 * Pinned so a capture taken here matches one taken anywhere else. Any IANA
 * name works; UTC is the one nobody has to look up.
 */
export const CAPTURE_TIMEZONE = process.env.FIXTURE_TIMEZONE ?? 'UTC';

// Freeze everything that would otherwise make two captures of the same build
// differ: in-flight transitions and animations, caret blink, and text that
// reflows when a webfont swaps in. Returns once the renderer has painted twice
// with all of that settled.
// Durations go to zero rather than the animation being removed. `animation:
// none` cancels the animation and leaves the element at its static value —
// for an entry animation that starts at `opacity: 0` and fills forwards, that
// static value is invisible, so freezing that way would hide the very surface
// a capture is meant to look at. Zero duration runs the animation to its final
// frame instantly instead.
const SETTLE_EXPR = `(async () => {
  if (!document.getElementById('maka-contract-freeze')) {
    const style = document.createElement('style');
    style.id = 'maka-contract-freeze';
    style.textContent = '*,*::before,*::after{transition-duration:0s!important;transition-delay:0s!important;animation-duration:0s!important;animation-delay:0s!important;caret-color:transparent!important;scroll-behavior:auto!important}';
    document.head.appendChild(style);
  }
  try { await document.fonts.ready; } catch {}
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return true;
})()`;

/**
 * Boot one fixture window, hand a renderer evaluator to `fn`, then tear the
 * window down.
 *
 * `fn` receives `{ evaluate, page }`. `evaluate(expression)` returns the
 * expression's value, awaited if it is a promise. `page` is the Playwright
 * page, for the cases that want a selector wait or an input event rather than
 * an expression.
 *
 * @param {string} scenario MAKA_E2E_FIXTURE scenario name.
 * @param {{
 *   theme?: 'light' | 'dark',
 *   showWindow?: boolean,
 *   readySelector?: string,
 *   readyTimeoutMs?: number,
 *   settleMs?: number,
 * }} [options]
 * @param {(ctx: { evaluate: (expression: string) => Promise<any>, page: import('@playwright/test').Page }) => Promise<any>} fn
 */
export async function withFixtureWindow(scenario, options, fn) {
  const {
    theme = 'light',
    // A fixture window stays hidden for its whole lifecycle unless this is
    // set. Reading computed style works either way, but anything that depends
    // on the compositor — hit testing, real input — needs a mapped window.
    showWindow = false,
    // Every route names the element that means "this surface has rendered".
    // Without one the only alternative is a fixed sleep, which reports a
    // half-mounted route as a clean one on a slow machine.
    readySelector = '#root',
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
    settleMs = DEFAULT_SETTLE_MS,
  } = options ?? {};

  const userDataDir = await mkdtemp(join(tmpdir(), 'maka-fixture-'));
  // Inside the throwaway userData dir so the same teardown removes it; there
  // is no second path to leak.
  const homeDir = join(userDataDir, 'home');
  await mkdir(homeDir, { recursive: true });
  /** @type {import('@playwright/test').ElectronApplication | undefined} */
  let app;
  const rendererLogs = [];
  try {
    app = await electron.launch({
      args: ['.'],
      cwd: DESKTOP_DIR,
      env: buildFixtureEnv(userDataDir, homeDir, {
        scenario,
        theme,
        showWindow,
        timezone: CAPTURE_TIMEZONE,
      }),
    });
    const page = await app.firstWindow();
    page.on('console', (message) => {
      rendererLogs.push(`[console:${message.type()}] ${message.text()}`);
      if (rendererLogs.length > 30) rendererLogs.shift();
    });
    page.on('pageerror', (error) => {
      rendererLogs.push(`[pageerror] ${error.stack ?? error.message}`);
      if (rendererLogs.length > 30) rendererLogs.shift();
    });
    try {
      await page.waitForSelector(readySelector, { timeout: readyTimeoutMs });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const logs = rendererLogs.length > 0 ? `\nRenderer console:\n${rendererLogs.join('\n')}` : '';
      throw new Error(
        `${scenario}: readiness selector ${readySelector} never appeared${logs}\n${detail}`,
      );
    }
    // Readiness says the surface mounted; this covers the paint after it.
    if (settleMs > 0) await page.waitForTimeout(settleMs);
    const evaluate = (expression) => page.evaluate(expression);
    await evaluate(SETTLE_EXPR);
    return await fn({ evaluate, page });
  } finally {
    try {
      if (app) await app.close();
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  }
}
