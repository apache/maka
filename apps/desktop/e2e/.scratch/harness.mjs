import { _electron as electron } from '@playwright/test';

/** Launches the real (non-E2E) app against a copy of the user's own userData. */
export async function launchReal({ userData, timeout = 60_000 } = {}) {
  const app = await electron.launch({
    args: ['.'],
    cwd: process.cwd(),
    env: {
      ...process.env,
      MAKA_UPDATE_TEST_FEED: 'http://127.0.0.1:59999/no-such-feed',
      MAKA_UPDATE_TEST_USER_DATA_DIR: userData ?? process.env.REAL_USER_DATA,
    },
    timeout,
  });
  const mainLog = [];
  const rendererLog = [];
  const proc = app.process();
  proc.stdout?.on('data', (d) => mainLog.push(String(d).trimEnd()));
  proc.stderr?.on('data', (d) => mainLog.push(String(d).trimEnd()));
  app.on('window', (w) => {
    w.on('console', (m) => rendererLog.push(`${m.type()} ${m.text().slice(0, 400)}`));
    w.on('pageerror', (e) => rendererLog.push(`pageerror ${e.message.split('\n')[0]}`));
  });
  const deadline = Date.now() + timeout;
  let page;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    const live = app.windows().filter((w) => !w.isClosed());
    for (const candidate of live) {
      const turns = await candidate.locator('[data-turn-id]').count().catch(() => 0);
      const composer = await candidate.locator('.maka-composer-editor').count().catch(() => 0);
      if (turns > 0 || composer > 0) { page = candidate; break; }
    }
    if (page) break;
  }
  if (!page) throw new Error(`no shell window mounted\n${mainLog.slice(-20).join('\n')}`);
  return { app, page, mainLog, rendererLog };
}
