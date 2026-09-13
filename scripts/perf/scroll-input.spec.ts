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

// Measures real Host page delivery through preload while the Renderer holds
// publication. A callback-only Storybook fixture cannot exercise that path.
import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { withE2eWindow } from '../../apps/desktop/e2e/fixtures';
import { outputDir, report, summarize } from './report.mjs';

test('dense upward input with real Host history', async () => {
  test.setTimeout(180_000);
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
      const diagnose = process.env.MAKA_PERF_DIAGNOSE === '1';
      for (let trial = 0; trial < (diagnose ? 1 : 3); trial++) {
        await page.reload();
        await expect(page.locator('.maka-turn[data-turn-id="turn-prompt-rail-120"]')).toHaveCount(
          1,
        );
        if (process.env.MAKA_PERF_NO_HAS === '1') {
          const removed = await page.evaluate(() => {
            const removed: string[] = [];
            const strip = (sheet: CSSStyleSheet | CSSGroupingRule) => {
              for (let i = sheet.cssRules.length - 1; i >= 0; i--) {
                const rule = sheet.cssRules[i];
                if (rule instanceof CSSStyleRule && rule.selectorText.includes(':has(')) {
                  removed.push(rule.cssText);
                  sheet.deleteRule(i);
                } else if (rule instanceof CSSGroupingRule) strip(rule);
              }
            };
            for (const sheet of document.styleSheets) strip(sheet);
            return removed;
          });
          await writeFile(
            path.join(outputDir, `removed-has-${trial}.json`),
            JSON.stringify(removed),
          );
        }
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
        if (diagnose) {
          await cdp.send('Tracing.start', {
            categories:
              'devtools.timeline,disabled-by-default-devtools.timeline.stack,v8.execute,blink.user_timing' +
              (process.env.MAKA_PERF_INVALIDATIONS === '1'
                ? ',disabled-by-default-devtools.timeline.invalidationTracking'
                : ''),
            transferMode: 'ReturnAsStream',
          });
          await cdp.send('Profiler.enable');
          await cdp.send('Profiler.start');
        }
        // Release follow through native input, then locate the existing top edge.
        // This setup is not counted as user travel or input latency.
        await cdp.send('Input.dispatchMouseEvent', input);
        await page.evaluate(() => {
          const root = document.querySelector<HTMLElement>('[data-chat-scroll-container]')!;
          root.scrollTo({ top: 0, behavior: 'instant' });
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
        const targetTurn = Number(process.env.MAKA_PERF_TARGET_TURN ?? 0);
        let reachedTurn = 120;
        let ticks = 0;
        for (; ticks < (targetTurn ? 300 : 120); ticks++) {
          await cdp.send('Input.dispatchMouseEvent', input);
          await page.waitForTimeout(16);
          if (targetTurn && (ticks + 1) % 20 === 0) {
            reachedTurn = await page.evaluate(() => {
              const root = document.querySelector<HTMLElement>('[data-chat-scroll-container]')!;
              const top = root.getBoundingClientRect().top;
              const row = [...root.querySelectorAll<HTMLElement>('[data-turn-id]')].find(
                (el) => el.getBoundingClientRect().bottom > top,
              );
              return Number(row?.dataset.turnId?.split('-').at(-1));
            });
            if (reachedTurn <= targetTurn) {
              ticks++;
              break;
            }
          }
        }
        if (targetTurn)
          expect(reachedTurn, 'same visible history landmark must be reached').toBeLessThanOrEqual(
            targetTurn,
          );
        const releasedAt = await page.evaluate(() => {
          (window as any).__denseScroll.phase = 'released';
          return performance.now();
        });
        await page.waitForTimeout(1200);
        const raw = await page.evaluate(() => {
          (window as any).__denseScroll.running = false;
          return {
            ...(window as any).__denseScroll,
            marks: performance
              .getEntriesByType('mark')
              .filter((entry) => entry.name.startsWith('perf:transcript-'))
              .map((entry) => ({
                name: entry.name,
                ms: entry.startTime,
                detail: (entry as PerformanceMark).detail,
              })),
          };
        });
        if (diagnose) {
          const profile = await cdp.send('Profiler.stop');
          await writeFile(
            path.join(outputDir, 'scroll.cpuprofile'),
            JSON.stringify(profile.profile),
          );
          const completed = new Promise<any>((resolve) =>
            cdp.once('Tracing.tracingComplete', resolve),
          );
          await cdp.send('Tracing.end');
          const { stream } = await completed;
          let trace = '';
          for (;;) {
            const chunk = await cdp.send('IO.read', { handle: stream });
            trace += chunk.base64Encoded
              ? Buffer.from(chunk.data, 'base64').toString()
              : chunk.data;
            if (chunk.eof) break;
          }
          await cdp.send('IO.close', { handle: stream });
          await writeFile(path.join(outputDir, 'scroll.timeline.json'), trace);
        }
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
        if (process.env.MAKA_PERF_VARIANT === 'V') {
          expect(
            row.maxMounted,
            'a fetched page must not mount all of its Turn bodies',
          ).toBeLessThan(Math.max(...raw.ranges.map((frame: any) => frame.ids.length)) / 2);
        }
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
          variant: process.env.MAKA_PERF_VARIANT,
          sourceCommit: process.env.MAKA_PERF_SOURCE_COMMIT,
          browser,
          diagnose,
          targetTurn: process.env.MAKA_PERF_TARGET_TURN,
          invalidationTracking: process.env.MAKA_PERF_INVALIDATIONS === '1',
          samples,
          viewport: '1352x932',
          conditions:
            (diagnose
              ? 'One diagnostic trial with CPU profile and browser timeline. '
              : 'Three timing trials without profiler or trace. ') +
            'Real Desktop + Host. Native CDP input at >=16ms driver spacing. 120 ticks, or up to 300 ticks to reach the requested visible Turn, checked every 20 ticks. Frame timestamps only; DOM ranges sampled on child-list mutation without layout reads. Landmark checks read layout equally on both variants.',
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
