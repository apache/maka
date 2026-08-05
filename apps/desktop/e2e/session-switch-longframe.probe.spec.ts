import { test } from './fixtures';

// Local measurement probe for #2052, not part of the committed suite: measures
// the longest main-thread task after switching back to the 24-turn fixture
// session. Run on main and on the fix branch with the same command; the
// numbers go into the PR's Verification section.
const SCROLLER = '[data-chat-scroll-container="true"]';
const LONG_ROW = '[data-session-id="e2e-fixture-long-transcript"]';

test('probe: switch-back long frame', async ({ longTranscriptWindow: page }) => {
  test.setTimeout(240_000);
  await page.locator(`${SCROLLER}[data-turn-warmup="settled"]`).waitFor({ timeout: 30_000 });

  const throttle = Number(process.env.PROBE_CPU_THROTTLE ?? '6');
  if (throttle > 1) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
    console.log('CPU_THROTTLE_RATE', throttle);
  }

  await page.evaluate(`(() => {
    window.__lt = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.__lt.push([entry.startTime, entry.duration]);
    }).observe({ entryTypes: ['longtask'] });
  })()`);

  const row = page.locator(LONG_ROW);
  if (!(await row.isVisible().catch(() => false))) {
    await page.locator('.maka-titlebar-action[aria-expanded="false"]').first().click();
    await row.waitFor({ state: 'visible', timeout: 10_000 });
  }

  const results: number[] = [];
  for (let round = 0; round < 5; round += 1) {
    await page.getByRole('button', { name: '新任务', exact: true }).click();
    await page.waitForTimeout(1000);
    const t0 = (await page.evaluate('performance.now()')) as number;
    await row.click();
    await page.locator(`${SCROLLER} .maka-turn`).first().waitFor({ timeout: 15_000 });
    await page.waitForTimeout(1800);
    const tasks = (await page.evaluate('window.__lt')) as Array<[number, number]>;
    const afterClick = tasks
      .filter(([startTime]) => startTime >= t0)
      .map(([startTime, duration]) => [Math.round(startTime - t0), Math.round(duration)]);
    console.log(`ROUND_${round}_TASKS`, JSON.stringify(afterClick));
    const max = Math.max(0, ...afterClick.map(([, duration]) => duration));
    results.push(Math.round(max));
  }
  console.log('SWITCH_BACK_MAX_LONGTASK_MS', JSON.stringify(results));
});
