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

import { test, expect } from '@playwright/test';
import { withE2eWindow } from '../../apps/desktop/e2e/fixtures';
import { outputDir, report, summarize } from './report.mjs';
import path from 'node:path';

test('production layout: document mount and older history', async () => {
  test.setTimeout(180_000);
  const samples: Array<{
    trial: number;
    action: string;
    ms: number;
    taskMs: number;
    layoutMs: number;
    maxLongTaskMs: number;
    longTaskCount: number;
  }> = [];
  await withE2eWindow(
    {
      seed: false,
      readinessSelector: '[data-turn-id]',
      e2eFixtureScenario: 'chat-prompt-rail',
      locale: 'zh-CN',
      showWindow: true,
      tracePath: path.join(outputDir, 'geometry-navigation.trace.zip'),
    },
    async (page) => {
      await page.setViewportSize({ width: 1400, height: 900 });
      await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Performance.enable');
      const browser = await cdp.send('Browser.getVersion');
      await page.addInitScript(() => {
        const tasks: Array<{ start: number; duration: number }> = [];
        (window as any).__mountTasks = tasks;
        new PerformanceObserver((list) =>
          tasks.push(
            ...list.getEntries().map((e) => ({ start: e.startTime, duration: e.duration })),
          ),
        ).observe({ type: 'longtask', buffered: true });
      });
      const ready = async (turn: number) => {
        await expect(page.locator(`[data-turn-id="turn-prompt-rail-${turn}"]`)).toHaveCount(1);
        await page.evaluate(() => document.fonts.ready);
        await expect(page.locator('.maka-markdown-pending')).toHaveCount(0);
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            ),
        );
      };
      const metric = (m: { metrics: Array<{ name: string; value: number }> }, name: string) =>
        m.metrics.find((v) => v.name === name)!.value;
      for (let trial = 0; trial < 3; trial++) {
        const measure = async (action: string, run: () => Promise<void>) => {
          const before = await cdp.send('Performance.getMetrics');
          const from = action === 'mount' ? 0 : await page.evaluate(() => performance.now());
          const start = performance.now();
          await run();
          const ms = performance.now() - start;
          const after = await cdp.send('Performance.getMetrics');
          const tasks = await page.evaluate(
            (from) =>
              (window as any).__mountTasks
                .filter((t: { start: number }) => t.start >= from)
                .map((t: { duration: number }) => t.duration) as number[],
            from,
          );
          const sample = {
            trial,
            action,
            ms,
            // Navigation resets CDP counters; only same-document actions use deltas.
            taskMs:
              (metric(after, 'TaskDuration') -
                (action === 'mount' ? 0 : metric(before, 'TaskDuration'))) *
              1000,
            layoutMs:
              (metric(after, 'LayoutDuration') -
                (action === 'mount' ? 0 : metric(before, 'LayoutDuration'))) *
              1000,
            maxLongTaskMs: Math.max(0, ...tasks),
            longTaskCount: tasks.length,
          };
          expect(sample.taskMs).toBeGreaterThanOrEqual(0);
          expect(sample.layoutMs).toBeGreaterThanOrEqual(0);
          samples.push(sample);
          console.log(JSON.stringify(sample));
        };
        await measure('mount', async () => {
          await page.reload();
          await ready(120);
        });
        {
          expect(
            await page
              .locator('[data-chat-scroll-container]')
              .evaluate(
                (root) =>
                  [...root.querySelectorAll('*')].filter(
                    (el) => getComputedStyle(el).contentVisibility === 'auto',
                  ).length,
              ),
          ).toBe(0);
        }
        await measure('older', async () => {
          await page
            .locator('.maka-prompt-rail-tick[data-prompt-turn-id="turn-prompt-rail-1"]')
            .click();
          await ready(1);
          await expect(page.locator('[data-turn-id="turn-prompt-rail-120"]')).toHaveCount(0);
          await expect(
            page.getByRole('button', {
              name: /^(滚动主对话到底部|Scroll main conversation to bottom)$/,
            }),
          ).toBeVisible();
        });
        await measure('latest', async () => {
          await page
            .getByRole('button', {
              name: /^(滚动主对话到底部|Scroll main conversation to bottom)$/,
            })
            .click();
          await ready(120);
        });
      }
      // Prove the observer works without contaminating any measured operation.
      const control = await page.evaluate(async () => {
        const from = performance.now();
        await new Promise<void>((resolve) =>
          setTimeout(() => {
            const start = performance.now();
            while (performance.now() - start < 100) {
              /* observer control */
            }
            setTimeout(resolve, 100);
          }, 0),
        );
        return (window as any).__mountTasks
          .filter((t: { start: number }) => t.start >= from)
          .map((t: { duration: number }) => t.duration) as number[];
      });
      expect(control.some((duration) => duration >= 90)).toBe(true);
      await report(
        'frontend-geometry-navigation',
        {
          browser,
          control,
          samples,
          viewport: '1400x900',
          conditions:
            'One real Desktop + Host, three fresh renderer documents using production layout. Existing 120-turn fixture; three measurements per action.',
          limits:
            'Mount is renderer reload in a warm application, not disk-cold process startup. DOM readiness includes driver polling, fonts and two rendering frames, not screen presentation. Older/latest uses prompt-rail navigation, not wheel-triggered paging. Trace overhead included; no performance threshold imposed.',
        },
        ['mount', 'older', 'latest'].flatMap((action) => {
          const group = samples.filter((s) => s.action === action);
          return (['ms', 'taskMs', 'layoutMs', 'maxLongTaskMs', 'longTaskCount'] as const).map(
            (metric) => ({
              scenario: action,
              metric,
              ...summarize(group.map((s) => s[metric])),
            }),
          );
        }),
      );
    },
  );
});
