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

// Native history geometry gate with raw frame and browser timing evidence.
// History storage is simulated; real Host admission is measured separately.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { startStaticServer } from '../storybook-visual-smoke.mjs';
import { outputDir, report, summarize } from './report.mjs';

const server = await startStaticServer('apps/desktop/storybook-static');
const browser = await chromium.launch({ headless: true });
const samples = [];
const scenes = (
  process.env.SCROLL_WINDOW_SCENES ?? 'history-window-traversal,virtual-history-mixed-content'
).split(',');
const trials = Number(process.env.SCROLL_WINDOW_TRIALS ?? 3);
assert(Number.isInteger(trials) && trials > 0);

await mkdir(outputDir, { recursive: true });
try {
  for (const scene of scenes) {
    for (let trial = 0; trial < trials; trial++) {
      const page = await browser.newPage({ viewport: { width: 1352, height: 932 } });
      if (process.env.SCROLL_WINDOW_CPU_RATE) {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Emulation.setCPUThrottlingRate', {
          rate: Number(process.env.SCROLL_WINDOW_CPU_RATE),
        });
      }
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(
        `${server.baseUrl}/iframe.html?id=product-shell-official-appshell--${scene}&viewMode=story`,
      );
      await page.locator('[data-chat-scroll-container]').waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.waitForFunction(() => !document.querySelector('.maka-markdown-pending'));
      await page.waitForTimeout(1200);
      await page.evaluate(() => {
        const root = document.querySelector('[data-chat-scroll-container]');
        const probe = (window.__scrollWindow = {
          frames: [],
          events: [],
          tasks: [],
          longAnimationFrames: [],
          running: true,
          phase: 'start',
        });
        for (const type of ['wheel', 'scroll', 'scrollend']) {
          root.addEventListener(
            type,
            (event) =>
              probe.events.push({
                type,
                ms: performance.now(),
                top: root.scrollTop,
                height: root.scrollHeight,
                delta: event.deltaY,
                phase: probe.phase,
              }),
            { passive: true },
          );
        }
        new PerformanceObserver((list) =>
          probe.tasks.push(
            ...list.getEntries().map((entry) => ({
              ms: entry.startTime,
              duration: entry.duration,
            })),
          ),
        ).observe({ type: 'longtask' });
        // Keep browser attribution beside the geometry samples. Storybook's
        // own observers also run here; a long task alone is not evidence that
        // mounting a Turn or parsing Markdown caused it. This observer only
        // records completed long frames and performs no DOM measurements.
        if (!PerformanceObserver.supportedEntryTypes.includes('long-animation-frame')) {
          throw new Error('The performance browser must support long animation frame attribution');
        }
        new PerformanceObserver((list) =>
          probe.longAnimationFrames.push(...list.getEntries().map((entry) => entry.toJSON())),
        ).observe({ type: 'long-animation-frame' });
        let previousText;
        // Follow an actual visible glyph, not the top of a provisional shell
        // or a tall Turn whose beginning can be far outside the viewport.
        const readingText = (top) => {
          const box = root.getBoundingClientRect();
          for (let y = top + 8; y < top + root.clientHeight; y += 48) {
            const caret = document.caretRangeFromPoint(box.left + box.width / 2, y);
            const node = caret?.startContainer;
            if (
              !node ||
              node.nodeType !== Node.TEXT_NODE ||
              !node.parentElement?.closest('.maka-turn') ||
              !node.textContent.length
            )
              continue;
            const start = Math.min(caret.startOffset, node.textContent.length - 1);
            const range = document.createRange();
            range.setStart(node, start);
            range.setEnd(node, start + 1);
            const rect = range.getBoundingClientRect();
            if (rect.height > 0 && rect.top >= top && rect.bottom <= top + root.clientHeight) {
              return { range, node, top: rect.top };
            }
          }
        };
        const frame = () => {
          const top = root.getBoundingClientRect().top;
          const sample = {
            ms: performance.now(),
            top: root.scrollTop,
            height: root.scrollHeight,
            viewport: root.clientHeight,
            count: root.querySelectorAll('.maka-turn[data-turn-id]').length,
            visibleCount: [...root.querySelectorAll('.maka-turn[data-turn-id]')].filter((turn) => {
              const box = turn.getBoundingClientRect();
              return box.bottom > top && box.top < top + root.clientHeight;
            }).length,
            phase: probe.phase,
            readerDelta:
              previousText?.node.isConnected && previousText.range.getClientRects().length
                ? previousText.range.getBoundingClientRect().top - previousText.top
                : null,
            membership: [...root.querySelectorAll('[data-transcript-turn-id]')]
              .map((turn) => turn.dataset.transcriptTurnId)
              .join(','),
          };
          probe.frames.push(sample);
          previousText = readingText(top);
          if (probe.running) requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      });
      const box = await page.locator('[data-chat-scroll-container]').boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      for (const [direction, delta] of [
        ['up', -450],
        ['down', 450],
        ['up-repeat', -450],
        ['down-repeat', 450],
      ]) {
        for (let burst = 0; burst < 12; burst++) {
          await page.evaluate((phase) => {
            window.__scrollWindow.phase = phase;
          }, `${direction}-${burst}`);
          for (let tick = 0; tick < 24; tick++) {
            await page.mouse.wheel(0, delta);
            await page.waitForTimeout(16);
          }
          await page.evaluate((phase) => {
            window.__scrollWindow.phase = phase;
          }, `${direction}-pause`);
          await page.waitForTimeout(350);
          const reached = await page.evaluate((direction) => {
            const root = document.querySelector('[data-chat-scroll-container]');
            return direction.startsWith('up')
              ? root.scrollTop <= 1
              : root.scrollHeight - root.scrollTop - root.clientHeight <= 1;
          }, direction);
          if (reached) break;
        }
      }
      await page.waitForTimeout(500);
      const data = await page.evaluate(() => {
        window.__scrollWindow.running = false;
        return window.__scrollWindow;
      });
      assert.equal(errors.length, 0, errors.join('\n'));
      assert(
        data.events.some((event) => event.type === 'scroll'),
        'native input must move the transcript',
      );
      assert(
        data.frames.some((frame) => frame.top <= 1 && frame.phase.startsWith('up')),
        'upward traversal must reach the edge',
      );
      const last = data.frames.at(-1);
      assert(last.height - last.viewport - last.top <= 1, 'return traversal must reach the tail');
      const shrink = data.frames.slice(1).flatMap((frame, i) => {
        const delta = frame.height - data.frames[i].height;
        return delta < -1
          ? [{ ...frame, delta, sameMembership: frame.membership === data.frames[i].membership }]
          : [];
      });
      const blankFrames = data.frames.filter((frame) => frame.visibleCount === 0);
      // Evicting real rows legitimately changes the window extent. Revisited
      // rows must not resize when the window itself has not changed.
      const revisitShrink = shrink.filter(
        (frame) => frame.phase.startsWith('up-repeat') && frame.sameMembership,
      );
      const coldChanges = data.frames.slice(1).flatMap((frame, i) => {
        const previous = data.frames[i];
        if (!frame.phase.startsWith('up-') || frame.phase.startsWith('up-repeat')) return [];
        const delta = frame.height - previous.height;
        return Math.abs(delta) > 1
          ? [{ delta, sameMembership: frame.membership === previous.membership }]
          : [];
      });
      const row = {
        scene,
        trial,
        shrinkCount: shrink.length,
        blankFrames: blankFrames.length,
        revisitShrinkCount: revisitShrink.length,
        shrinkPx: -shrink.reduce((sum, frame) => sum + frame.delta, 0),
        coldStableMembershipChangePx: coldChanges
          .filter((change) => change.sameMembership)
          .reduce((sum, change) => sum + Math.abs(change.delta), 0),
        coldRangeChangePx: coldChanges
          .filter((change) => !change.sameMembership)
          .reduce((sum, change) => sum + Math.abs(change.delta), 0),
        coldGrowthPx: coldChanges
          .filter((change) => change.delta > 0)
          .reduce((sum, change) => sum + change.delta, 0),
        coldMaxReversePx: Math.max(
          0,
          ...data.frames
            .slice(1)
            .flatMap((frame, i) =>
              frame.phase.startsWith('up-') &&
              !frame.phase.startsWith('up-repeat') &&
              frame.phase === data.frames[i].phase &&
              !frame.phase.endsWith('pause') &&
              frame.readerDelta !== null
                ? [-frame.readerDelta]
                : [],
            ),
        ),
        readerSamples: data.frames.filter((frame) => frame.readerDelta !== null).length,
        maxLongTaskMs: Math.max(0, ...data.tasks.map((task) => task.duration)),
        longTaskMs: data.tasks.reduce((sum, task) => sum + task.duration, 0),
        maxMounted: Math.max(...data.frames.map((frame) => frame.count)),
        minMounted: Math.min(...data.frames.map((frame) => frame.count)),
        maxFrameGapMs: Math.max(
          ...data.frames.slice(1).map((frame, i) => frame.ms - data.frames[i].ms),
        ),
      };
      samples.push(row);
      await writeFile(
        path.join(outputDir, `scroll-window-${scene}-${trial}.json`),
        JSON.stringify({ row, shrink, ...data }, null, 2),
      );
      await page.screenshot({ path: path.join(outputDir, `scroll-window-${scene}-${trial}.png`) });
      console.log(JSON.stringify(row));
      assert.equal(blankFrames.length, 0, 'native traversal must not expose an empty transcript');
      assert.equal(revisitShrink.length, 0, 'revisiting measured history must preserve its extent');
      assert(
        data.frames.some(
          (frame) =>
            frame.phase.startsWith('up-') &&
            !frame.phase.startsWith('up-repeat') &&
            frame.readerDelta !== null,
        ),
        'the glyph probe must observe rendered text during the cold upward traversal',
      );
      assert(row.coldMaxReversePx <= 1, 'height corrections must not reverse an upward reader');
      if (scene === 'virtual-history-mixed-content' && trial === 0) {
        // Reuse the real paging/mounting path at a different layout width.
        // Old offscreen boxes remain provisional until visited, then converge;
        // a second visit must not fall back to the previous width's heights.
        const resizeSamples = [];
        for (const width of [900, 1352]) {
          await page.setViewportSize({ width, height: 932 });
          const heights = [];
          for (let visit = 0; visit < 2; visit++) {
            for (const direction of [-1, 1]) {
              let reached = false;
              for (let step = 0; step < 250; step++) {
                reached = await page.evaluate(async (direction) => {
                  const root = document.querySelector('[data-chat-scroll-container]');
                  root.dispatchEvent(
                    new WheelEvent('wheel', { bubbles: true, deltaY: direction * 400 }),
                  );
                  root.scrollTop += direction * root.clientHeight;
                  root.dispatchEvent(new Event('scroll'));
                  for (let frame = 0; frame < 5; frame++) await new Promise(requestAnimationFrame);
                  return direction < 0
                    ? root.scrollTop <= 1
                    : root.scrollHeight - root.clientHeight - root.scrollTop <= 1;
                }, direction);
                if (reached) break;
              }
              assert(reached, 'resized history traversal must reach its edge');
            }
            heights.push(
              await page.evaluate(
                () => document.querySelector('[data-chat-scroll-container]').scrollHeight,
              ),
            );
          }
          resizeSamples.push({ width, heights });
          assert(
            Math.abs(heights[0] - heights[1]) <= 1,
            `remeasured history must converge at width ${width}: ${heights}`,
          );
        }
        assert(
          Math.abs(resizeSamples.at(-1).heights[1] - last.height) <= 1,
          'returning to the original width must recover its measured extent',
        );
        await writeFile(
          path.join(outputDir, 'virtual-history-resize.json'),
          JSON.stringify(resizeSamples, null, 2),
        );
        console.log(JSON.stringify({ scenario: 'virtual-history-resize', samples: resizeSamples }));
      }
      await page.close();
    }
  }
  await report(
    'frontend-scroll-window',
    {
      browser: browser.version(),
      cpuThrottlingRate: Number(process.env.SCROLL_WINDOW_CPU_RATE ?? 1),
      samples,
      viewport: '1352x932',
      conditions: `${trials} fresh documents per scene; native wheel, 24 ticks of 450px with >=16ms spacing and 350ms pauses. Full up/down traversal; fonts and Markdown ready. Same driver on baseline and experiment refs.`,
      limits:
        'Simulated history callbacks, not real Host/store timing or exact touchpad replay. Range-change frames can also contain height corrections, so stable-membership changes are only a lower bound on correction. Geometry and long tasks are separate outcomes. Small samples are not a robust timing distribution. No performance threshold.',
    },
    scenes.flatMap((scene) =>
      [
        'shrinkCount',
        'shrinkPx',
        'coldStableMembershipChangePx',
        'coldRangeChangePx',
        'coldGrowthPx',
        'coldMaxReversePx',
        'maxLongTaskMs',
        'longTaskMs',
        'maxMounted',
        'minMounted',
        'maxFrameGapMs',
      ].map((metric) => ({
        scenario: scene,
        metric,
        ...summarize(samples.filter((row) => row.scene === scene).map((row) => row[metric])),
      })),
    ),
  );
} finally {
  await browser.close();
  await server.close();
}
