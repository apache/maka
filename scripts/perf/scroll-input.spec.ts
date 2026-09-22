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

// Measures real Host page delivery and publication during native input.
// A callback-only Storybook fixture cannot exercise that path.
import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { withE2eWindow } from '../../apps/desktop/e2e/fixtures';
import { PROMPT_RAIL_PROMPT_COUNT } from '../../apps/desktop/src/main/e2e-fixture/seed-helpers';
import { outputDir, report, summarize } from './report.mjs';

test('dense upward input with real Host history', async () => {
  test.setTimeout(180_000);
  const targetTurn = PROMPT_RAIL_PROMPT_COUNT - 60;
  const samples: Array<Record<string, number>> = [];
  await mkdir(outputDir, { recursive: true });
  await withE2eWindow(
    {
      seed: false,
      readinessSelector: '[data-turn-id]',
      e2eFixtureScenario: 'chat-prompt-rail',
      locale: 'zh-CN',
      showWindow: true,
    },
    async (page) => {
      await page.setViewportSize({ width: 1352, height: 932 });
      const cdp = await page.context().newCDPSession(page);
      const browser = await cdp.send('Browser.getVersion');
      for (let trial = 0; trial < 3; trial++) {
        await page.reload();
        await expect(
          page.locator(`.maka-turn[data-turn-id="turn-prompt-rail-${PROMPT_RAIL_PROMPT_COUNT}"]`),
        ).toHaveCount(1);
        await page.evaluate(() => document.fonts.ready);
        await expect(page.locator('.maka-markdown-pending')).toHaveCount(0);
        await page.waitForTimeout(600);
        const box = (await page.locator('[data-chat-scroll-container]').boundingBox())!;
        const input = {
          type: 'mouseWheel' as const,
          x: box.x + box.width / 2,
          y: box.y + box.height / 2,
          deltaX: 0,
          deltaY: -120,
        };
        // Release follow through native input. This setup is not counted as user
        // travel or input latency.
        await cdp.send('Input.dispatchMouseEvent', input);
        await page.evaluate(() => {
          const root = document.querySelector<HTMLElement>('[data-chat-scroll-container]')!;
          const p = ((window as any).__denseScroll = {
            running: true,
            phase: 'input',
            frames: [] as any[],
            ranges: [] as any[],
            events: [] as any[],
            tasks: [] as any[],
          });
          new PerformanceObserver((list) =>
            p.tasks.push(
              ...list.getEntries().map((entry) => ({
                ms: entry.startTime,
                duration: entry.duration,
              })),
            ),
          ).observe({ type: 'longtask' });
          for (const type of ['wheel', 'scroll', 'scrollend'])
            root.addEventListener(
              type,
              () => p.events.push({ type, ms: performance.now(), phase: p.phase }),
              { passive: true },
            );
          const range = () => {
            const ids = [...root.querySelectorAll<HTMLElement>('[data-turn-id]')].map(
              (el) => el.dataset.turnId,
            );
            const mountedCount = root.querySelectorAll('.maka-turn[data-turn-id]').length;
            if (
              p.ranges.at(-1)?.ids.join(',') === ids.join(',') &&
              p.ranges.at(-1)?.mountedCount === mountedCount
            )
              return;
            p.ranges.push({
              ms: performance.now(),
              phase: p.phase,
              ids,
              mountedCount,
            });
          };
          range();
          const observer = new MutationObserver(range);
          observer.observe(root, { childList: true, subtree: true });
          const frame = () => {
            p.frames.push({ ms: performance.now(), phase: p.phase });
            if (p.running) requestAnimationFrame(frame);
            else observer.disconnect();
          };
          requestAnimationFrame(frame);
        });
        let reachedTurn = PROMPT_RAIL_PROMPT_COUNT;
        let ticks = 0;
        for (; ticks < 300; ticks++) {
          await cdp.send('Input.dispatchMouseEvent', input);
          await page.waitForTimeout(16);
          if ((ticks + 1) % 20 === 0) {
            reachedTurn = await page.evaluate(() => {
              const root = document.querySelector<HTMLElement>('[data-chat-scroll-container]')!;
              const viewport = root.getBoundingClientRect();
              const row = [...root.querySelectorAll<HTMLElement>('.maka-turn[data-turn-id]')].find(
                (el) => {
                  const rect = el.getBoundingClientRect();
                  return (
                    rect.height > 0 &&
                    rect.width > 0 &&
                    rect.bottom > viewport.top &&
                    rect.top < viewport.bottom
                  );
                },
              );
              return Number(row?.dataset.turnId?.split('-').at(-1));
            });
            if (reachedTurn <= targetTurn) {
              ticks++;
              break;
            }
          }
        }
        expect(reachedTurn, 'a mounted history body must reach the viewport').toBeLessThanOrEqual(
          targetTurn,
        );
        const releasedAt = await page.evaluate(() => {
          (window as any).__denseScroll.phase = 'released';
          return performance.now();
        });
        await page.waitForTimeout(1200);
        const raw = await page.evaluate(() => {
          (window as any).__denseScroll.running = false;
          return (window as any).__denseScroll;
        });
        const wheels = raw.events.filter((event: any) => event.type === 'wheel');
        expect(wheels.length, 'the measured gesture must reach the real scroller').toBeGreaterThan(
          20,
        );
        const initial = raw.frames[0];
        const changes = raw.ranges.filter(
          (frame: any, i: number) =>
            i > 0 && frame.ids.join(',') !== raw.ranges[i - 1].ids.join(','),
        );
        expect(
          changes.length,
          'real Host history must publish at least one changed range',
        ).toBeGreaterThan(0);
        const firstReleased = changes.find((frame: any) => frame.ms >= releasedAt);
        const row = {
          trial,
          ticks,
          reachedTurn,
          wheelCount: wheels.length,
          inputDurationMs: releasedAt - initial.ms,
          medianWheelIntervalMs: summarize(
            wheels.slice(1).map((event: any, i: number) => event.ms - wheels[i].ms),
          ).median,
          maxLongTaskMs: Math.max(0, ...raw.tasks.map((task: any) => task.duration)),
          longTaskMs: raw.tasks.reduce((sum: number, task: any) => sum + task.duration, 0),
          maxFrameGapMs: Math.max(
            ...raw.frames.slice(1).map((frame: any, i: number) => frame.ms - raw.frames[i].ms),
          ),
          maxMounted: Math.max(...raw.ranges.map((frame: any) => frame.mountedCount)),
          publicationsDuringInput: changes.filter((frame: any) => frame.ms < releasedAt).length,
          publicationsAfterInput: changes.filter((frame: any) => frame.ms >= releasedAt).length,
          firstPublicationAfterReleaseMs: firstReleased ? firstReleased.ms - releasedAt : -1,
        };
        expect(
          row.maxMounted,
          'scrolling through history must not keep every Turn it passes mounted',
        ).toBeLessThan(PROMPT_RAIL_PROMPT_COUNT - targetTurn);
        samples.push(row);
        console.log(JSON.stringify(row));
        await writeFile(
          path.join(outputDir, `scroll-input-${trial}.json`),
          JSON.stringify({ row, releasedAt, ...raw }, null, 2),
        );
      }
      await report(
        'frontend-scroll-input',
        {
          browser,
          targetTurn,
          samples,
          viewport: '1352x932',
          conditions: `Three trials on the current Desktop + Host build. Native CDP input at >=16ms driver spacing, up to 300 ticks to reach Turn ${targetTurn}, checked every 20 ticks. Frame timestamps only; DOM ranges sampled on child-list mutation without layout reads.`,
          limits:
            'Actual wheel intervals recorded; not exact touchpad replay or end-to-end input latency. DOM range changes are observable, pending store rows are not counted. Mutation observer overhead remains. -1 means no post-release range publication was observed.',
        },
        Object.keys(samples[0])
          .filter((key) => key !== 'trial')
          .map((metric) => ({
            scenario: 'dense-up',
            metric,
            ...summarize(samples.map((row) => row[metric])),
          })),
      );
    },
  );
});
