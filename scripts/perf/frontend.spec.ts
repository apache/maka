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
let longTaskControl: number[];
const repetitions = 10;
async function activate(locator: Locator) {
  await expect(locator).toBeVisible();
  await expect(locator).toBeEnabled();
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
  longTaskControl = await page.evaluate(async () => {
    await new Promise<void>((resolve) =>
      setTimeout(() => {
        const start = performance.now();
        while (performance.now() - start < 100) {
          /* harness-only negative control */
        }
        setTimeout(resolve, 100);
      }, 0),
    );
    (window as any).__perfLongFrames.length = 0;
    return (window as any).__perfLongTasks.splice(0) as number[];
  });
  expect(longTaskControl.some((duration) => duration >= 90)).toBe(true);
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
test.beforeEach(() => {
  rows.length = 0;
});
test.afterEach(async ({}, info) => {
  if (rows.length)
    await report(
      info.title.startsWith('long') ? 'frontend-electron-navigation' : 'frontend-electron-stream',
      {
        status: info.status,
        longTaskControl,
        browserVersion,
        fixture:
          'existing chat-prompt-rail (120 turns), normal fake stream (9 characters/45ms), mid-stream stop',
        repetitions,
        viewport: '1400x900',
        theme: 'light',
        motion: 'reduce',
        conditions:
          'One fresh Electron + real Host per case; first action separately recorded, ten warm repetitions. Streaming uses a fixed 679-character prompt, 9-character deltas/45ms; input checks every 100ms plus driver overhead.',
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
      tracePath: path.join(outputDir, 'navigation.trace.zip'),
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
        const target = page.locator('[data-session-id=' + JSON.stringify(sessionId) + ']');
        const button = target.locator('button, a, [role="button"]').first();
        await activate(button);
        await expect(target.locator('[aria-current="page"]')).toHaveCount(1);
        await expect(page.locator(tail)).toHaveCount(hasTail ? 1 : 0);
      };
      const samples: number[] = [],
        liveNodes: number[] = [],
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
        liveNodes.push(await page.locator('*').count());
      }
      row('session-roundtrip', 'warm-dom-ready-ms', samples);
      row('120-turn-session', 'live-dom-elements', liveNodes);
      row('session-roundtrip', 'retained-dom-nodes-including-detached', nodes);
      row('session-roundtrip', 'heap-bytes-no-forced-gc', heaps);
      await switchTo(other!, false);
      row('small-session', 'live-dom-elements', [await page.locator('*').count()]);
      row('small-session', 'mounted-turns', [await page.locator('.maka-transcript-turn').count()]);
      await switchTo(id!, true);
      const paging: number[] = [];
      for (let i = 0; i < repetitions; i++) {
        const result = await measure('older-history', async () => {
          await activate(
            page.locator('.maka-prompt-rail-tick[data-prompt-turn-id="turn-prompt-rail-1"]'),
          );
          await expect(page.locator('[data-turn-id="turn-prompt-rail-1"]')).toHaveCount(1);
          await expect(page.locator('[data-transcript-gap="newer"]')).toBeVisible();
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
      const idleCpu: number[] = [],
        idleHeap: number[] = [];
      let before = await cdp.send('Performance.getMetrics');
      const task = (value: typeof before) =>
        value.metrics.find((m) => m.name === 'TaskDuration')!.value;
      const timestamp = (value: typeof before) =>
        value.metrics.find((m) => m.name === 'Timestamp')!.value;
      for (let sample = 0; sample < repetitions; sample++) {
        await page.waitForTimeout(1000);
        const after = await cdp.send('Performance.getMetrics');
        idleCpu.push(
          ((task(after) - task(before)) * 1000) / (timestamp(after) - timestamp(before)),
        );
        idleHeap.push((await cdp.send('Runtime.getHeapUsage')).usedSize);
        before = after;
      }
      const { profile } = await cdp.send('Profiler.stop');
      await mkdir(outputDir, { recursive: true });
      await writeFile(path.join(outputDir, 'idle.cpuprofile'), JSON.stringify(profile));
      row('idle-after-repeated-navigation', 'renderer-task-ms-per-second', idleCpu);
      row('idle-after-repeated-navigation', 'heap-bytes-no-gc', idleHeap);
      await blocking(page, 'navigation-case-total');
      await cdp.detach();
    },
  );
});
test('streaming input, background output and stop', async () => {
  test.setTimeout(180_000);
  await withE2eWindow(
    {
      seed: true,
      tracePath: path.join(outputDir, 'stream.trace.zip'),
      readinessSelector: COMPOSER_INPUT,
      locale: 'zh-CN',
      showWindow: true,
    },
    async (page) => {
      const expand = page.getByRole('button', { name: '展开侧边栏', exact: true });
      if (await expand.isVisible()) await activate(expand);
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        if (i)
          await activate(
            page
              .getByRole('navigation', { name: '任务列表' })
              .getByRole('button', { name: '新任务', exact: true }),
          );
        await input(page, 'performance warmup ' + i);
        await activate(page.getByRole('button', { name: '发送', exact: true }));
        await expect(page.getByRole('log')).toContainText('renderer loop are connected.', {
          timeout: 20000,
        });
        await expect(page.locator('.maka-bubble-streaming')).toHaveCount(0);
        ids.push(
          (await page
            .locator('[data-session-id]')
            .filter({ has: page.locator('[aria-current="page"]') })
            .getAttribute('data-session-id'))!,
        );
      }
      expect(new Set(ids).size).toBe(3);
      const cdp = await setup(page);
      const id = ids[0];
      await activate(
        page
          .locator('[data-session-id=' + JSON.stringify(id) + ']')
          .locator('button, a, [role="button"]')
          .first(),
      );
      await expect(
        page.locator('[data-session-id=' + JSON.stringify(id) + '] [aria-current="page"]'),
      ).toHaveCount(1);
      const prompt = ('performance fixture ' + 'abcdefghij '.repeat(60)).trimEnd();
      const expected =
        'Fake backend received: ' +
        prompt +
        '\n\nThis proves the session stream, SQLite storage, and renderer loop are connected.';
      await page.evaluate(
        ({ sessionId, background }) => {
          const state = {
            text: '',
            deliveries: [] as { text: string; at: number }[],
            lags: [] as number[],
            background: Object.fromEntries(
              background.map((id) => [id, { text: '', complete: false, deltas: 0 }]),
            ),
            unsubscribe: [] as (() => void)[],
          };
          (window as any).__perfStream = state;
          state.unsubscribe.push(
            window.maka.sessions.subscribeEvents(sessionId, (event) => {
              if (event.type === 'text_delta') {
                state.text += event.text;
                state.deliveries.push({ text: state.text, at: performance.now() });
              }
            }),
          );
          for (const id of background)
            state.unsubscribe.push(
              window.maka.sessions.subscribeEvents(id, (event) => {
                const target = state.background[id];
                if (event.type === 'text_delta') {
                  target.text += event.text;
                  target.deltas++;
                }
                if (event.type === 'text_complete') {
                  if (target.text !== event.text)
                    throw new Error('Background delta completeness mismatch');
                  target.complete = true;
                }
              }),
            );
          new MutationObserver(() => {
            const text = (document.querySelector('[role="log"]')?.textContent ?? '').replace(
              /\s/g,
              '',
            );
            while (
              state.deliveries[0] &&
              text.includes(state.deliveries[0].text.replace(/\s/g, ''))
            ) {
              state.lags.push(performance.now() - state.deliveries.shift()!.at);
            }
          }).observe(document.body, { subtree: true, childList: true, characterData: true });
        },
        { sessionId: id, background: ids.slice(1, 3) },
      );
      await input(page, prompt);
      await activate(page.getByRole('button', { name: '发送', exact: true }));
      await expect(page.locator('.maka-bubble-streaming')).toContainText('Fake backend received');
      const times: number[] = [];
      for (let i = 0; i < repetitions; i++) {
        await expect(page.locator('.maka-bubble-streaming')).toHaveCount(1);
        times.push((await measure('input-during-stream', () => input(page, 'draft-' + i))).ms);
        await page.waitForTimeout(100);
      }
      await expect(page.locator('.maka-bubble-streaming')).toHaveCount(0, { timeout: 20_000 });
      await expect(page.getByRole('log')).toContainText(expected, { useInnerText: true });
      await expect(page.locator(COMPOSER_INPUT)).toHaveText('draft-9');
      const stream = await page.evaluate(() => {
        const state = (window as any).__perfStream;
        return { text: state.text, lags: state.lags as number[], pending: state.deliveries.length };
      });
      expect(stream.text).toBe(expected);
      expect(stream.pending).toBe(0);
      expect(stream.lags.length).toBeGreaterThan(10);
      row('input-during-stream', 'dom-ready-ms', times);
      row('streaming', 'delivery-to-dom-mutation-ms', stream.lags);
      const background = ids.slice(1, 3);
      await page.evaluate(
        async ({ ids, prompt }) => {
          for (const sessionId of ids) {
            const result = await window.maka.sessions.submitMessage(sessionId, 'next_turn', {
              messageId: crypto.randomUUID(),
              text: prompt,
            });
            if (!result.ok) throw new Error('Background start rejected');
          }
        },
        { ids: background, prompt },
      );
      await page.waitForFunction(() =>
        Object.values((window as any).__perfStream.background).every(
          (s: any) => s.deltas > 0 && !s.complete,
        ),
      );
      const backgroundTimes: number[] = [];
      for (let i = 0; i < repetitions; i++) {
        expect(
          await page.evaluate(() =>
            Object.values((window as any).__perfStream.background).every(
              (s: any) => s.deltas > 0 && !s.complete,
            ),
          ),
        ).toBe(true);
        backgroundTimes.push((await measure('background-input', () => input(page, prompt + i))).ms);
        await page.waitForTimeout(100);
      }
      await page.waitForFunction(
        () => Object.values((window as any).__perfStream.background).every((s: any) => s.complete),
        undefined,
        { timeout: 20_000 },
      );
      const texts = await page.evaluate(() =>
        Object.values((window as any).__perfStream.background).map((s: any) => s.text),
      );
      expect(texts).toEqual([expected, expected]);
      row('background-output', 'foreground-input-dom-ms', backgroundTimes);
      await expect(
        page.locator('[data-session-id=' + JSON.stringify(id) + '] [aria-current="page"]'),
      ).toHaveCount(1);
      await expect(page.locator(COMPOSER_INPUT)).toHaveText(prompt + (repetitions - 1));
      await activate(page.getByRole('button', { name: '发送', exact: true }));
      await expect(page.locator('.maka-bubble-streaming')).toContainText('Fake backend received');
      const stop = await measure('stop', async () => {
        await activate(page.getByRole('button', { name: /^(停止|Stop)$/ }));
        await expect(page.getByRole('log')).toContainText('已中断');
        await expect(page.getByRole('button', { name: /^(停止|Stop)$/ })).toHaveCount(0);
      });
      row('stop', 'dom-settled-ms', [stop.ms]);
      const stoppedText = await page.evaluate(() => (window as any).__perfStream.text as string);
      const stoppedResponse = stoppedText.slice(expected.length);
      const wouldComplete = expected.replace(prompt, prompt + (repetitions - 1));
      expect(stoppedResponse.length).toBeGreaterThan(0);
      expect(stoppedResponse.length).toBeLessThan(wouldComplete.length);
      expect(wouldComplete.startsWith(stoppedResponse)).toBe(true);
      await page.waitForTimeout(200);
      expect(await page.evaluate(() => (window as any).__perfStream.text)).toBe(stoppedText);
      await page.evaluate(() => {
        for (const unsubscribe of (window as any).__perfStream.unsubscribe) unsubscribe();
      });
      await blocking(page, 'stream-and-background-case-total');
      await cdp.detach();
    },
  );
});
