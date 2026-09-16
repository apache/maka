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
import type { CDPSession, ElectronApplication, Page } from '@playwright/test';
import { expect, test } from './fixtures';

const TICK = '.maka-prompt-rail-tick';
interface SessionUnderTest {
  name: string;
  turnPrefix: string;
  /** Whether opening this Session stops at the budget and offers the rest. */
  offersMoreHistory?: boolean;
}

const LARGE_SESSION: SessionUnderTest = {
  name: '大历史内存基准会话',
  turnPrefix: 'turn-large-history-',
  offersMoreHistory: true,
};
const SMALL_SESSION: SessionUnderTest = {
  name: '模型管理与工具调用示例',
  turnPrefix: 'turn-fixture-',
};
const MIB = 1024 * 1024;

/**
 * How much more the renderer may be holding after a second visit to the same
 * Session than after the first. Dropping the window's eviction means nothing
 * trims a loaded transcript while its Session is open, so the question this
 * spec exists to answer is whether leaving gives the memory back — and the
 * failure that would matter is not a held transcript but a growing pile of
 * them. Slack for allocator noise in a ~500 MiB renderer, not for a leak.
 */
const RETAINED_GROWTH_MIB = 8;

async function heapBytes(cdp: CDPSession): Promise<number> {
  const { metrics } = await cdp.send('Performance.getMetrics');
  return metrics.find((metric) => metric.name === 'JSHeapUsedSize')?.value ?? 0;
}

/** Collect first: an uncollected transcript is indistinguishable from a retained one. */
async function settledHeapBytes(cdp: CDPSession, page: Page): Promise<number> {
  await cdp.send('HeapProfiler.collectGarbage');
  await page.waitForTimeout(250);
  await cdp.send('HeapProfiler.collectGarbage');
  return heapBytes(cdp);
}

async function rendererResidentBytes(app: ElectronApplication): Promise<number> {
  const metrics = await app.evaluate(({ app: electron }) => electron.getAppMetrics());
  return metrics
    .filter((entry) => entry.type === 'Tab' || entry.type === 'renderer')
    .reduce((total, entry) => total + entry.memory.workingSetSize * 1024, 0);
}

/** The earliest prompt the rail names — the loaded transcript's head. */
async function earliestPrompt(page: Page): Promise<string> {
  return (await page.locator(TICK).first().getAttribute('aria-label')) ?? '';
}

async function openSession(page: Page, { name, turnPrefix, offersMoreHistory }: SessionUnderTest): Promise<number> {
  const expand = page.getByRole('button', { name: '展开侧边栏' });
  if ((await expand.count()) > 0) await expand.first().click();
  // Scoped to the list: the titlebar carries the active Session's name too.
  const row = page
    .getByRole('navigation', { name: '任务列表' })
    .getByRole('button', { name: new RegExp(`^${name}\\s`) })
    .first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  const started = Date.now();
  await row.click();
  // The titlebar renames before the transcript arrives, and a mounted Turn on
  // its own can still belong to the Session being left, so wait for both.
  await expect(
    page.getByRole('button', { name: new RegExp(`^${name} — `) }),
  ).toBeVisible({ timeout: 120_000 });
  await expect(page.locator(`[data-turn-id^="${turnPrefix}"]`).first()).toBeVisible({
    timeout: 300_000,
  });
  // A Turn is on screen from the Main replica's cache long before the budgeted
  // read has finished arriving, and the load-earlier control appears with it.
  // What marks the end is the transcript's head no longer moving.
  if (offersMoreHistory) {
    await expect(page.getByRole('button', { name: '载入更早的记录' })).toHaveCount(1, {
      timeout: 300_000,
    });
    let head = await earliestPrompt(page);
    for (let still = 0; still < 4; still += 1) {
      await page.waitForTimeout(500);
      const next = await earliestPrompt(page);
      if (next !== head) still = -1;
      head = next;
    }
  }
  return Date.now() - started;
}

test('a transcript past the history budget gives its memory back when the reader leaves', async ({
  largeHistoryWindow: { page, app },
}) => {
  test.setTimeout(900_000);
  await page.setViewportSize({ width: 1_400, height: 800 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const ticks = page.locator(TICK);
  const loadEarlier = page.getByRole('button', { name: '载入更早的记录' });
  const samples: Record<string, unknown>[] = [];
  const sample = async (stage: string, extra: Record<string, unknown> = {}): Promise<number> => {
    const heap = await settledHeapBytes(cdp, page);
    const row = {
      stage,
      heapMiB: Number((heap / MIB).toFixed(1)),
      rendererResidentMiB: Number(((await rendererResidentBytes(app)) / MIB).toFixed(1)),
      loadedTurns: await ticks.count(),
      ...extra,
    };
    samples.push(row);
    console.log(JSON.stringify(row));
    return heap;
  };

  await expect(page.locator('[data-turn-id]').first()).toBeVisible({ timeout: 120_000 });
  // Read the baseline from a small Session in the same renderer, so the
  // comparison is the transcript's own cost and not the shell's.
  await openSession(page, SMALL_SESSION);
  const baseline = await sample('baseline (small session)');

  const openMs = await openSession(page, LARGE_SESSION);
  const opened = await sample('opened at the budget', { openMs });
  // The read stops at the budget, so the control is on offer rather than the
  // whole transcript being resident.
  await expect(loadEarlier).toHaveCount(1);

  let loads = 0;
  while ((await loadEarlier.count()) > 0 && loads < 40) {
    // The rail samples a fixed number of ticks however much is loaded, so
    // progress is the earliest prompt it names, not how many it names.
    const before = await earliestPrompt(page);
    const started = Date.now();
    await loadEarlier.first().click();
    await expect.poll(() => earliestPrompt(page), { timeout: 120_000 }).not.toBe(before);
    loads += 1;
    await sample(`after load ${loads}`, { loadMs: Date.now() - started });
  }
  const full = await sample('whole transcript loaded', { loads });

  await openSession(page, SMALL_SESSION);
  const released = await sample('reader moved to another session');
  // Once more, to tell a cache of the Session just left — which costs a fixed
  // amount — from a renderer that keeps every transcript it has ever opened.
  const reopenMs = await openSession(page, LARGE_SESSION);
  await sample('reopened at the budget', { reopenMs });
  await openSession(page, SMALL_SESSION);
  const releasedAgain = await sample('moved away a second time');

  const output = path.resolve('perf-results/transcript-memory.json');
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(
    output,
    JSON.stringify(
      {
        conditions:
          'Real Electron, real Host, real storage. One renderer throughout; every sample is taken after two forced collections. The baseline is a small Session open in the same renderer.',
        samples,
      },
      null,
      2,
    ),
  );

  expect(full, 'loading earlier history has to cost something to be worth measuring')
    .toBeGreaterThan(opened);
  // Reading the same Session twice must not cost twice. What survives a switch
  // is the Session just left; it is replaced, not added to.
  expect(
    (releasedAgain - released) / MIB,
    `a second visit left ${((releasedAgain - released) / MIB).toFixed(1)} MiB more behind`,
  ).toBeLessThanOrEqual(RETAINED_GROWTH_MIB);
});
