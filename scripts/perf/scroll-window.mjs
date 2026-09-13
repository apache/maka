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

// A/B experiment: identical native input and frame observations on both refs.
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
await mkdir(outputDir, { recursive: true });
try {
  for (const scene of ['history-window-traversal', 'geometry-mixed-24-turns']) {
    for (let trial = 0; trial < 3; trial++) {
      const page = await browser.newPage({ viewport: { width: 1352, height: 932 } });
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
        let previous;
        const frame = () => {
          const turns = [...root.querySelectorAll('[data-turn-id]')];
          const top = root.getBoundingClientRect().top;
          const anchor = turns.find((turn) => turn.getBoundingClientRect().bottom > top);
          const old = previous && root.querySelector(`[data-turn-id="${previous.id}"]`);
          const sample = {
            ms: performance.now(),
            top: root.scrollTop,
            height: root.scrollHeight,
            viewport: root.clientHeight,
            count: root.querySelectorAll('.maka-turn[data-turn-id]').length,
            first: turns[0]?.dataset.turnId,
            last: turns.at(-1)?.dataset.turnId,
            phase: probe.phase,
            anchorDelta: old ? old.getBoundingClientRect().top - previous.top : null,
          };
          probe.frames.push(sample);
          previous = anchor
            ? { id: anchor.dataset.turnId, top: anchor.getBoundingClientRect().top }
            : undefined;
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
        return delta < -1 ? [{ ...frame, delta }] : [];
      });
      const blankFrames = data.frames.filter((frame) => frame.count === 0);
      const revisitShrink = shrink.filter((frame) => frame.phase.startsWith('up-repeat'));
      const row = {
        scene,
        trial,
        shrinkCount: shrink.length,
        blankFrames: blankFrames.length,
        revisitShrinkCount: revisitShrink.length,
        shrinkPx: -shrink.reduce((sum, frame) => sum + frame.delta, 0),
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
      await page.close();
    }
  }
  await report(
    'frontend-scroll-window',
    {
      browser: browser.version(),
      samples,
      viewport: '1352x932',
      conditions:
        'Three fresh documents per scene; native wheel, 24 ticks of 450px with >=16ms spacing and 350ms pauses. Full up/down traversal; fonts and Markdown ready. Same driver on baseline and experiment refs.',
      limits:
        'Simulated history callbacks, not real Host/store timing or exact touchpad replay. Geometry and long tasks are separate outcomes. Three samples are not a robust timing distribution. No performance threshold.',
    },
    ['history-window-traversal', 'geometry-mixed-24-turns'].flatMap((scene) =>
      [
        'shrinkCount',
        'shrinkPx',
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
