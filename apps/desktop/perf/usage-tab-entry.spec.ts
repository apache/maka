/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, test as base, withE2eWindow } from '../e2e/fixtures';

// #4677 item 4: weigh leaving and re-entering the Usage settings section with
// a ledger that would once have mounted every activity row. The table is a
// native <table> (BaseTable), the section tabs render as buttons inside a
// plain <nav> (no ARIA tabs pattern), and the nav items carry stable
// assistant targets — so the measurement never leans on the tabs' roles.
const ACTIVITY_TABLE = '[aria-label="使用统计活动记录表"]';
const ACTIVITY_TABLE_LOCATOR = `${ACTIVITY_TABLE} tbody tr`;
const USAGE_NAV = '[data-maka-assistant-target="settings.usage"]';
const GENERAL_NAV = '[data-maka-assistant-target="settings.general"]';
const TABS_NAV = '[aria-label="使用统计视图"]';
const REQUESTS_TAB = /活动记录/;
/** #4677 item 4: the fixture pads the handcrafted turns to exactly this many activity rows. */
const EXPECTED_ACTIVITY_ROWS = 409;
/** usage-settings-view's USAGE_REQUESTS_PAGE_SIZE. */
const PAGE_SIZE = 50;
const ROUNDS = 12;
/**
 * Frames the in-renderer poll may wait per phase before giving up. Playwright
 * serializes page.evaluate callbacks without their Node-side closure, so this
 * must be passed into each callback as an argument.
 */
const MOUNT_POLL_FRAMES = 600;

interface UsageWindow {
  page: Page;
  app: ElectronApplication;
}

const test = base.extend<{ usageWindow: UsageWindow }>({
  usageWindow: async ({}, use, testInfo) => {
    await withE2eWindow(
      {
        testInfo,
        seed: false,
        readinessSelector: '[data-maka-contract="settings-sidebar"]',
        readinessTimeoutMs: 60_000,
        e2eFixtureScenario: 'settings-usage',
        locale: 'zh-CN',
        // rAF is throttled in hidden windows, and the entry sample ends on a
        // painted frame, so the window must be visible.
        showWindow: true,
      },
      async (page, { app }) => use({ page, app }),
    );
  },
});

test('usage activity tab entry mounts one bounded page of 409 total rows', async ({
  usageWindow: { page },
}) => {
  await page.setViewportSize({ width: 1_400, height: 900 });

  // The fixture's settings.json enables usage details and the 'all' range, so
  // the activity table renders as soon as the Usage section is open. Navigate
  // there explicitly anyway: the section can drift after mount, and every
  // measured entry below re-clicks the same nav item regardless of where the
  // shell currently sits.
  await page.locator(USAGE_NAV).first().click();
  const table = page.locator(ACTIVITY_TABLE);
  await expect(table).toBeVisible({ timeout: 30_000 });

  // Bounded mount: paginateData puts only the current page's rows in the DOM,
  // however many rows the ledger holds; the tab badge carries the total.
  const domRows = await page.locator(ACTIVITY_TABLE_LOCATOR).count();
  console.log(JSON.stringify({ stage: 'bounded mount', domRows, expectedTotal: EXPECTED_ACTIVITY_ROWS }));
  expect(domRows, 'the activity table must not mount more than one page').toBeLessThanOrEqual(
    PAGE_SIZE,
  );
  const badge = page.locator(TABS_NAV).getByRole('button', { name: REQUESTS_TAB });
  const badgeDigits = ((await badge.textContent({ timeout: 10_000 })) ?? '').replace(/\D/g, '');
  expect(badgeDigits, 'the tab badge must still report every activity row').toBe(
    String(EXPECTED_ACTIVITY_ROWS),
  );

  // #4531's repro: leave the Usage section and come back. Each round runs
  // entirely inside the renderer — the clock starts at the synthetic click and
  // stops at the mounted table's next painted frame — so it excludes
  // Playwright round-trips and waits only for what the user would wait for.
  // Clicking the same nav items every round keeps the measurement immune to
  // whatever section the shell drifted to between rounds.
  const entries: number[] = [];
  for (let round = 1; round <= ROUNDS; round += 1) {
    const leftMs = await page.evaluate(
      ([tableSelector, navSelector, pollBudgetFrames]) =>
        new Promise<number>((resolve, reject) => {
          const t0 = performance.now();
          const nav = document.querySelector(navSelector);
          if (!(nav instanceof HTMLElement)) {
            reject(new Error('general nav item not found'));
            return;
          }
          nav.click();
          let frames = 0;
          const poll = () => {
            if (!document.querySelector(tableSelector)) {
              requestAnimationFrame(() => resolve(performance.now() - t0));
              return;
            }
            frames += 1;
            if (frames > pollBudgetFrames) {
              reject(new Error('activity table never unmounted'));
              return;
            }
            requestAnimationFrame(poll);
          };
          requestAnimationFrame(poll);
        }),
      [ACTIVITY_TABLE, GENERAL_NAV, MOUNT_POLL_FRAMES],
    );
    const entryMs = await page.evaluate(
      ([tableSelector, navSelector, pollBudgetFrames]) =>
        new Promise<number>((resolve, reject) => {
          const t0 = performance.now();
          const nav = document.querySelector(navSelector);
          if (!(nav instanceof HTMLElement)) {
            reject(new Error('usage nav item not found'));
            return;
          }
          nav.click();
          let frames = 0;
          const poll = () => {
            if (document.querySelector(tableSelector)) {
              requestAnimationFrame(() => resolve(performance.now() - t0));
              return;
            }
            frames += 1;
            if (frames > pollBudgetFrames) {
              reject(new Error('activity table did not mount within the poll budget'));
              return;
            }
            requestAnimationFrame(poll);
          };
          requestAnimationFrame(poll);
        }),
      [ACTIVITY_TABLE, USAGE_NAV, MOUNT_POLL_FRAMES],
    );
    entries.push(entryMs);
    console.log(JSON.stringify({
      stage: `re-entry ${round}`,
      leaveMs: Number(leftMs.toFixed(1)),
      entryMs: Number(entryMs.toFixed(1)),
    }));
  }

  const sorted = [...entries].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  // Even sample: the median is the mean of the two middle values, not the
  // upper one.
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
  const summary = {
    condition:
      'Real Electron, real Host, real storage. Warm re-entry: click off the Usage settings section (wait for the table to unmount), click back in; the clock runs from the click to the activity table’s next painted frame, sampled inside the renderer. Fixture: 409 activity rows (399 model + 10 tool) on the fixed clock; table page size 50.',
    rounds: ROUNDS,
    entriesMs: entries.map((value) => Number(value.toFixed(1))),
    medianMs: Number(median.toFixed(1)),
    p95Ms: Number(p95.toFixed(1)),
    domRowsAfterFirstEntry: domRows,
    expectedActivityRows: EXPECTED_ACTIVITY_ROWS,
  };
  const output = path.join(process.env.TEMP ?? 'perf-results', 'usage-tab-entry-results.json');
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
});
