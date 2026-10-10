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

import { test, expect, type CDPSession, type Locator, type Page } from '@playwright/test';
import { withE2eWindow, COMPOSER_INPUT } from '../../apps/desktop/e2e/fixtures';
import { report, summarize } from './report.mjs';

const warmups = 30;
const streams = 5;
const idleSeconds = 5;
const rows: Array<Record<string, unknown>> = [];

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
}
function row(scenario: string, metric: string, values: number[]) {
  rows.push({ scenario, metric, ...summarize(values) });
}

type Metrics = Record<string, number>;
async function metrics(cdp: CDPSession): Promise<Metrics> {
  const { metrics } = await cdp.send('Performance.getMetrics');
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
}
/** Per-second rates between two CDP samples, normalized by their own timestamps. */
function rates(before: Metrics, after: Metrics) {
  const seconds = after.Timestamp - before.Timestamp;
  const per = (name: string, scale = 1) => ((after[name] - before[name]) * scale) / seconds;
  return {
    'style-recalcs-per-second': per('RecalcStyleCount'),
    'layouts-per-second': per('LayoutCount'),
    'renderer-task-ms-per-second': per('TaskDuration', 1000),
    'script-ms-per-second': per('ScriptDuration', 1000),
  };
}

test.afterEach(async ({}, info) => {
  if (rows.length)
    await report(
      'frontend-streaming-render',
      {
        status: info.status,
        fixture: `fresh seeded session with ${warmups} short prompts, normal fake stream (9 characters/45ms)`,
        repetitions: streams,
        viewport: '1400x900',
        theme: 'light',
        motion: 'no-preference',
        conditions: `One fresh Electron + real Host. Sidebar expanded. ${warmups} short prompts build the prompt rail, then ${streams} sequential streams of the same 679-character prompt, each measured from the first delta until the streaming bubble is gone; then ${idleSeconds} one-second idle samples.`,
        limits:
          'Counts and CDP renderer-thread time, not power, GPU frames or wakeups. xvfb drives frames at 60Hz; a 120Hz display doubles per-frame costs. Compositor-only animations do not show in style recalcs, hence the separate running-animation count.',
      },
      rows,
    );
});

test('streaming in a session with a long prompt rail, then idle', {
  annotation: { type: 'perf-report', description: 'frontend-streaming-render' },
}, async () => {
  test.setTimeout(180_000);
  await withE2eWindow(
    {
      seed: true,
      readinessSelector: COMPOSER_INPUT,
      locale: 'zh-CN',
      showWindow: true,
    },
    async (page) => {
      await page.setViewportSize({ width: 1400, height: 900 });
      await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
      expect(
        await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches),
      ).toBe(false);
      const expand = page.getByRole('button', { name: '展开侧边栏', exact: true });
      if (await expand.isVisible()) await activate(expand);
      const send = async (text: string) => {
        await input(page, text);
        await activate(page.getByRole('button', { name: '发送', exact: true }));
      };
      const streaming = page.locator('.maka-bubble-streaming');
      for (let i = 0; i < warmups; i++) {
        await send('performance warmup ' + i);
        await expect(page.getByRole('log')).toContainText(
          'Fake backend received: performance warmup ' + i,
          { timeout: 20_000 },
        );
        await expect(streaming).toHaveCount(0);
      }
      await expect(page.locator('.maka-prompt-rail-tick')).toHaveCount(warmups);
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Performance.enable');
      await page.evaluate(() => {
        const counts = { style: 0, railStyle: 0 };
        (window as any).__perfStyleWrites = counts;
        new MutationObserver((records) => {
          for (const record of records) {
            counts.style++;
            if ((record.target as Element).closest('.maka-prompt-rail')) counts.railStyle++;
          }
        }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['style'] });
      });
      const styleWrites = () =>
        page.evaluate(
          () => ({ ...(window as any).__perfStyleWrites }) as { style: number; railStyle: number },
        );
      const infiniteAnimations = () =>
        page.evaluate(
          () =>
            document
              .getAnimations()
              .filter(
                (animation) =>
                  animation.playState === 'running' &&
                  animation.effect?.getComputedTiming().endTime === Infinity,
              ).length,
        );

      const prompt = ('performance fixture ' + 'abcdefghij '.repeat(60)).trimEnd();
      const perStream: Record<string, number[]> = {};
      const push = (metric: string, value: number) => (perStream[metric] ??= []).push(value);
      for (let i = 0; i < streams; i++) {
        await send(prompt);
        await expect(streaming).toContainText('Fake backend received');
        const before = await metrics(cdp);
        const writesBefore = await styleWrites();
        let animations = 0;
        while (await streaming.count()) {
          animations = Math.max(animations, await infiniteAnimations());
          await page.waitForTimeout(250);
        }
        const after = await metrics(cdp);
        const writesAfter = await styleWrites();
        const seconds = after.Timestamp - before.Timestamp;
        expect(seconds).toBeGreaterThan(1);
        for (const [metric, value] of Object.entries(rates(before, after))) push(metric, value);
        push(
          'style-attribute-writes-per-second',
          (writesAfter.style - writesBefore.style) / seconds,
        );
        push(
          'prompt-rail-style-writes-per-second',
          (writesAfter.railStyle - writesBefore.railStyle) / seconds,
        );
        push('max-running-infinite-animations', animations);
        await expect(page.locator('[data-turn-id]').last()).toContainText(
          'renderer loop are connected.',
        );
      }
      for (const [metric, values] of Object.entries(perStream)) row('streaming', metric, values);

      await page.waitForTimeout(1000);
      const idle: Record<string, number[]> = {};
      let before = await metrics(cdp);
      for (let sample = 0; sample < idleSeconds; sample++) {
        await page.waitForTimeout(1000);
        const after = await metrics(cdp);
        for (const [metric, value] of Object.entries(rates(before, after)))
          (idle[metric] ??= []).push(value);
        before = after;
      }
      idle['running-infinite-animations'] = [await infiniteAnimations()];
      for (const [metric, values] of Object.entries(idle))
        row('idle-after-streaming', metric, values);
      await cdp.detach();
    },
  );
});
