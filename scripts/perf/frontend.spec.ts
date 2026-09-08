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

import { test, expect, type Page, type Locator } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { withE2eWindow, COMPOSER_INPUT } from '../../apps/desktop/e2e/fixtures';
import { outputDir, report, summarize } from './report.mjs';

const rows: Array<Record<string, unknown>> = [];
let browserVersion: unknown;
const repetitions = 10;
async function activate(locator: Locator) {
  await expect(locator).toBeVisible();
  await locator.evaluate((el) => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  });
}
async function input(page: Page, text: string) {
  await page.locator(COMPOSER_INPUT).evaluate((el, value) => {
    (el as HTMLElement).focus();
    el.textContent = value;
    el.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }),
    );
  }, text);
  await expect(page.locator(COMPOSER_INPUT)).toHaveText(text);
  await expect(page.locator(COMPOSER_INPUT)).toBeFocused();
}
async function measure(scenario: string, action: () => Promise<void>) {
  const start = performance.now();
  await action();
  return { scenario, ms: performance.now() - start };
}
async function setup(page: Page) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  const cdp = await page.context().newCDPSession(page);
  browserVersion = await cdp.send('Browser.getVersion');
  await cdp.send('Performance.enable');
  await cdp.send('Profiler.enable');
  await page.evaluate(() => {
    const samples: number[] = [];
    (window as any).__perfLongTasks = samples;
    new PerformanceObserver((list) =>
      samples.push(...list.getEntries().map((e) => e.duration)),
    ).observe({ type: 'longtask', buffered: false });
    const frames: number[] = [];
    (window as any).__perfLongFrames = frames;
    if (PerformanceObserver.supportedEntryTypes.includes('long-animation-frame')) {
      new PerformanceObserver((list) =>
        frames.push(...list.getEntries().map((e) => e.duration)),
      ).observe({ type: 'long-animation-frame' });
    }
  });
  return cdp;
}
function row(scenario: string, metric: string, values: number[]) {
  rows.push({ scenario, metric, ...summarize(values) });
}
async function blocking(page: Page, scenario: string) {
  const samples = await page.evaluate(() => ({
    tasks: (window as any).__perfLongTasks as number[],
    frames: (window as any).__perfLongFrames as number[],
    supportsFrames: PerformanceObserver.supportedEntryTypes.includes('long-animation-frame'),
  }));
  row(scenario, 'long-task-count-over-50ms', [samples.tasks.length]);
  if (samples.tasks.length) row(scenario, 'long-task-ms', samples.tasks);
  if (samples.supportsFrames) {
    row(scenario, 'long-animation-frame-count', [samples.frames.length]);
    if (samples.frames.length) row(scenario, 'long-animation-frame-ms', samples.frames);
  }
}
test.afterAll(async () => {
  if (rows.length)
    await report(
      'frontend-electron',
      {
        browserVersion,
        fixture: 'existing chat-prompt-rail (120 turns), fake hold-open backend',
        repetitions,
        viewport: '1400x900',
        theme: 'light',
        motion: 'reduce',
        conditions:
          'One fresh Electron + real Host per case; first action separately recorded, ten warm repetitions.',
        limits:
          'DOM-event and preload admission probes, not native input or INP. Latency ends at verified DOM state (includes driver polling), not screen presentation. Stream lag begins at renderer subscription delivery, not provider send. CPU task duration is not power. No wakeup counter on CDP.',
      },
      rows,
    );
});
test('long session switch, older history and idle retention', async () => {
  test.setTimeout(180_000);
  await withE2eWindow(
    {
      seed: false,
      readinessSelector: '[data-turn-id]',
      e2eFixtureScenario: 'chat-prompt-rail',
      locale: 'zh-CN',
      showWindow: true,
    },
    async (page) => {
      const cdp = await setup(page);
      const tail = '[data-turn-id="turn-prompt-rail-120"]';
      await expect(page.locator(tail)).toHaveCount(1);
      const expand = page.getByRole('button', { name: '展开侧边栏', exact: true });
      if (await expand.isVisible()) await activate(expand);
      const active = page
        .locator('[data-session-id]')
        .filter({ has: page.locator('[aria-current="page"]') });
      const id = await active.first().getAttribute('data-session-id');
      expect(id).toBeTruthy();
      const sessions = page.locator('[data-session-id]');
      const other = await sessions.evaluateAll(
        (els, selected) =>
          els.map((el) => el.getAttribute('data-session-id')).find((value) => value !== selected),
        id,
      );
      expect(other).toBeTruthy();
      const switchTo = async (sessionId: string, hasTail: boolean) => {
        const target = page.locator('[data-session-id="' + sessionId + '"]');
        const button = target.locator('button, a, [role="button"]').first();
        await activate(button);
        await expect(target.locator('[aria-current="page"]')).toHaveCount(1);
        await expect(page.locator(tail)).toHaveCount(hasTail ? 1 : 0);
      };
      const samples: number[] = [],
        nodes: number[] = [],
        heaps: number[] = [];
      for (let i = 0; i <= repetitions; i++) {
        const result = await measure('session-roundtrip', async () => {
          await switchTo(other!, false);
          await switchTo(id!, true);
        });
        if (i) samples.push(result.ms);
        else row('session-roundtrip', 'first-action-ms', [result.ms]);
        const counters = await cdp.send('Memory.getDOMCounters');
        const heap = await cdp.send('Runtime.getHeapUsage');
        nodes.push(counters.nodes);
        heaps.push(heap.usedSize);
      }
      row('session-roundtrip', 'warm-dom-ready-ms', samples);
      row('session-roundtrip', 'dom-nodes', nodes);
      row('session-roundtrip', 'heap-bytes-no-forced-gc', heaps);
      const paging: number[] = [];
      for (let i = 0; i < repetitions; i++) {
        const result = await measure('older-history', async () => {
          await activate(
            page.locator('.maka-prompt-rail-tick[data-prompt-turn-id="turn-prompt-rail-1"]'),
          );
          await expect(page.locator('[data-turn-id="turn-prompt-rail-1"]')).toHaveCount(1);
          await activate(
            page.getByRole('button', {
              name: /^(滚动主对话到底部|Scroll main conversation to bottom)$/,
            }),
          );
          await expect(page.locator(tail)).toHaveCount(1);
        });
        paging.push(result.ms);
      }
      row('older-history', 'roundtrip-dom-ready-ms', paging);
      await cdp.send('Profiler.start');
      const before = await cdp.send('Performance.getMetrics');
      await page.waitForTimeout(3000);
      const after = await cdp.send('Performance.getMetrics');
      const { profile } = await cdp.send('Profiler.stop');
      await mkdir(outputDir, { recursive: true });
      await writeFile(path.join(outputDir, 'idle.cpuprofile'), JSON.stringify(profile));
      const task = (value: typeof before) =>
        value.metrics.find((m) => m.name === 'TaskDuration')!.value;
      row('idle-after-repeated-navigation', 'renderer-task-ms-per-3s', [
        (task(after) - task(before)) * 1000,
      ]);
      await blocking(page, 'navigation');
      await cdp.detach();
    },
  );
});
test('streaming input, background output and stop', async () => {
  test.setTimeout(180_000);
  await withE2eWindow(
    {
      seed: true,
      readinessSelector: COMPOSER_INPUT,
      locale: 'zh-CN',
      showWindow: true,
      railRenderSessions: true,
    },
    async (page) => {
      const cdp = await setup(page);
      await input(page, '__e2e_hold_open__');
      await activate(page.getByRole('button', { name: '发送', exact: true }));
      await expect(page.locator('.maka-bubble-streaming')).toContainText('Fake backend waiting', {
        timeout: 20_000,
      });
      const expand = page.getByRole('button', { name: '展开侧边栏', exact: true });
      if (await expand.isVisible()) await activate(expand);
      const id = await page
        .locator('[data-session-id]')
        .filter({ has: page.locator('[aria-current="page"]') })
        .first()
        .getAttribute('data-session-id');
      expect(id).toBeTruthy();
      await page.evaluate((sessionId) => {
        const state = { deliveries: [] as { text: string; at: number }[], lags: [] as number[] };
        (window as any).__perfStream = state;
        (window as any).__perfUnsubscribe = window.maka.sessions.subscribeEvents(
          sessionId!,
          (event) => {
            if (event.type === 'text_delta')
              state.deliveries.push({ text: event.text, at: performance.now() });
          },
        );
        new MutationObserver(() => {
          const text = document.querySelector('.maka-bubble-streaming')?.textContent ?? '';
          const pending = state.deliveries[0];
          if (pending && text.includes(pending.text)) {
            state.lags.push(performance.now() - pending.at);
            state.deliveries.shift();
          }
        }).observe(document.body, { subtree: true, childList: true, characterData: true });
      }, id);
      const times: number[] = [];
      for (let i = 0; i < repetitions; i++) {
        const marker = 'perf-chunk-' + i + '-中文';
        await page.evaluate(
          async ({ sessionId, text }) => {
            const result = await window.maka.sessions.submitMessage(sessionId!, 'current_turn', {
              messageId: crypto.randomUUID(),
              text,
            });
            if (!result.ok) throw new Error('Steering rejected');
          },
          { sessionId: id, text: marker },
        );
        const result = await measure('input-during-stream', () => input(page, 'draft-' + i));
        times.push(result.ms);
        await expect(page.locator('.maka-bubble-streaming')).toContainText(marker);
        await page.waitForTimeout(100);
      }
      row('input-during-stream', 'dom-ready-ms', times);
      const lags = await page.evaluate(() => (window as any).__perfStream.lags as number[]);
      expect(lags.length).toBe(repetitions);
      row('streaming', 'delivery-to-dom-mutation-ms', lags);
      // Existing hold-open sessions accept steering through the real Host. Start two
      // background runs and verify their deliveries while the foreground draft stays selected.
      const background = await page
        .locator('[data-session-id]')
        .evaluateAll(
          (els, selected) =>
            [...new Set(els.map((el) => el.getAttribute('data-session-id')!))]
              .filter((value) => value !== selected)
              .slice(0, 2),
          id,
        );
      expect(background.length).toBe(2);
      await page.evaluate(async (ids) => {
        for (const sessionId of ids) {
          const result = await window.maka.sessions.submitMessage(sessionId, 'next_turn', {
            messageId: crypto.randomUUID(),
            text: '__e2e_hold_open__',
          });
          if (!result.ok) throw new Error('Background start rejected');
        }
      }, background);
      await blocking(page, 'stream-and-background');
      const backgroundTimes: number[] = [];
      for (let i = 0; i < repetitions; i++) {
        const output = page.evaluate(
          async ({ ids, marker }) => {
            await Promise.all(
              ids.map(
                (sessionId) =>
                  new Promise<void>((resolve, reject) => {
                    const timer = setTimeout(() => {
                      unsubscribe();
                      reject(new Error('Missing background output'));
                    }, 10000);
                    const unsubscribe = window.maka.sessions.subscribeEvents(sessionId, (event) => {
                      if (event.type === 'text_delta' && event.text.includes(marker)) {
                        clearTimeout(timer);
                        unsubscribe();
                        resolve();
                      }
                    });
                    window.maka.sessions
                      .submitMessage(sessionId, 'current_turn', {
                        messageId: crypto.randomUUID(),
                        text: marker,
                      })
                      .then((result) => {
                        if (!result.ok) {
                          clearTimeout(timer);
                          unsubscribe();
                          reject(new Error('Steering rejected'));
                        }
                      }, reject);
                  }),
              ),
            );
          },
          { ids: background, marker: 'background-' + i },
        );
        backgroundTimes.push(
          (await measure('background-input', () => input(page, 'foreground-' + i))).ms,
        );
        await output;
      }
      row('background-output', 'foreground-input-dom-ms', backgroundTimes);
      await expect(
        page.locator('[data-session-id="' + id + '"] [aria-current="page"]'),
      ).toHaveCount(1);
      for (let i = 0; i < repetitions; i++)
        await expect(page.locator('.maka-bubble-streaming')).toContainText(
          'perf-chunk-' + i + '-中文',
        );
      const stop = await measure('stop', async () => {
        await activate(page.getByRole('button', { name: /^(停止|Stop)$/ }));
        await expect(page.locator('.maka-bubble-streaming')).toHaveCount(0);
      });
      row('stop', 'dom-settled-ms', [stop.ms]);
      await page.evaluate(async (ids) => {
        for (const sessionId of ids) await window.maka.sessions.stop(sessionId);
        (window as any).__perfUnsubscribe();
      }, background);
      await cdp.detach();
    },
  );
});
