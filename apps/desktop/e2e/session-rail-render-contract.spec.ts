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

import { expect, type Page } from '@playwright/test';
import {
  ensureSidebarExpanded,
  RAIL_RENDER_SESSION_COUNT,
  test,
} from './fixtures.js';

/**
 * Switching a session moves one row's selection. What it must not do is rewrite
 * the rest of the rail.
 *
 * Deliberately a budget on the OUTCOME rather than an assertion about
 * identities or `memo`. The rail's cost has had several independent causes —
 * `setActiveId` changing identity every AppShell render, `Intl` formatters
 * rebuilt per row, catalog refreshes replacing unchanged row objects — and each
 * was invisible to the others. A DOM-write budget catches all of them and the
 * ones not yet found, including anything that raises the number of commits a
 * switch produces (#4109).
 *
 * The counter reads inline `style` writes on rail buttons because that is the
 * dominant term: every Astryx button removes and re-adds its `anchor-name` per
 * render, so one wasted rail render is two style writes per button plus the
 * style recalculation they force.
 *
 * The assertion that carries the contract is `rowsTouched`, not the total.
 * Attributing each write to its row makes the budget independent of how many
 * rows the fixture seeds, and closes the hole a total-only budget leaves: a
 * regression that re-renders the whole rail exactly ONCE stays under any total
 * generous enough not to flake, but it cannot touch two rows. That is also the
 * missing middle of the fix's own claim — identity is fixed so `memo` holds, and
 * `memo` holding means untouched rows produce no DOM work at all.
 *
 * `styleWrites > 0` is the counter's own liveness check. Every write counted
 * here comes from an Astryx ref callback that is not wrapped in `useCallback`;
 * if that upstream detail is ever memoised, both the healthy and the regressed
 * reading collapse to zero and a one-sided budget would pass forever without
 * ever failing again.
 */
const RAIL_ROWS_TOUCHED_BUDGET = 2;
/** The leaving row and the arriving row, two writes each, doubled for slack. */
const RAIL_STYLE_WRITE_BUDGET = 8;

interface RailCounters {
  /** Cumulative since the last `resetRailCounters`; what the budgets read. */
  styleWrites: number;
  rowIds: string[];
  rowRemounts: number;
  /** Drained by every quiet poll, so it reports only the latest interval. */
  delta: number;
}

type RailWindow = Window & { __railCounters: RailCounters };

/**
 * Waits until the rail has been silent for ~300ms.
 *
 * A fixed `waitForTimeout` would be the only thing standing between a slow
 * machine and a red run: `toHaveCount` proves the rows mounted, not that the
 * commits behind them are done, and one late catalog refresh writes more than
 * the whole budget. `retries` is 0 in `playwright.config.ts`, so that failure
 * would land on an unrelated pull request.
 */
async function waitForRailQuiet(page: Page): Promise<void> {
  let quietPolls = 0;
  await expect
    .poll(
      async () => {
        const delta = await page.evaluate(() => {
          const counters = (window as unknown as RailWindow).__railCounters;
          const seen = counters.delta;
          counters.delta = 0;
          return seen;
        });
        quietPolls = delta === 0 ? quietPolls + 1 : 0;
        return quietPolls;
      },
      { timeout: 15_000, intervals: [100] },
    )
    .toBeGreaterThanOrEqual(3);
}

test('switching sessions does not rewrite the whole Session rail', async ({
  railRenderWindow: page,
}) => {
  await ensureSidebarExpanded(page);

  const rows = page.locator('.maka-session-row');
  await expect(rows).toHaveCount(RAIL_RENDER_SESSION_COUNT);

  const target = page.locator('.maka-session-row button.astryx-side-nav-item', {
    hasText: 'Rail row 3',
  });
  const selected = page.locator('.maka-session-row button.astryx-side-nav-item.selected');
  await expect(target).toBeVisible();

  await page.evaluate(() => {
    const counters = { styleWrites: 0, rowIds: [] as string[], rowRemounts: 0, delta: 0 };
    (window as unknown as { __railCounters: typeof counters }).__railCounters = counters;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'childList') {
          for (const node of record.addedNodes) {
            const element = node as Element;
            if (element.nodeType !== 1) continue;
            // A row that unmounts and remounts writes its `anchor-name` once
            // on the way in, from a ref callback that runs AFTER insertion —
            // so an attribute-only counter reads a whole rail remount as
            // cheaper than a rail re-render. Count the remounts directly.
            if (element.classList?.contains('maka-session-row')) counters.rowRemounts += 1;
          }
          continue;
        }
        const row = (record.target as Element).closest?.('.maka-session-row');
        if (!row) continue;
        counters.styleWrites += 1;
        counters.delta += 1;
        const rowId = row.getAttribute('data-session-id');
        if (rowId && !counters.rowIds.includes(rowId)) counters.rowIds.push(rowId);
      }
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['style'],
    });
    (window as unknown as { __railObserver: MutationObserver }).__railObserver = observer;
  });

  // Settle first: the budget is about a switch, not about arriving.
  await waitForRailQuiet(page);
  await page.evaluate(() => {
    const counters = (window as unknown as RailWindow).__railCounters;
    counters.styleWrites = 0;
    counters.rowIds = [];
    counters.rowRemounts = 0;
    counters.delta = 0;
  });

  await target.click();
  await expect(selected).toHaveText(/Rail row 3/);
  // Let the post-switch commit cascade finish before reading the counters.
  await waitForRailQuiet(page);

  const counted = await page.evaluate(() => {
    const scope = window as unknown as RailWindow & { __railObserver: MutationObserver };
    scope.__railObserver.disconnect();
    const { styleWrites, rowIds, rowRemounts } = scope.__railCounters;
    return { styleWrites, rowIds, rowRemounts };
  });

  expect(
    counted.rowIds.length,
    `rail rows touched by one session switch, of ${RAIL_RENDER_SESSION_COUNT} (${counted.rowIds.join(', ')})`,
  ).toBeLessThanOrEqual(RAIL_ROWS_TOUCHED_BUDGET);
  expect(counted.rowRemounts, 'rail rows remounted by one session switch').toBe(0);
  expect(counted.styleWrites, 'the style-write counter never fired').toBeGreaterThan(0);
  expect(counted.styleWrites, 'rail inline-style writes for one session switch').toBeLessThanOrEqual(
    RAIL_STYLE_WRITE_BUDGET,
  );
});
