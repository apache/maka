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

// Fixed-range geometry gate and performance samples, fresh DOM per trial.
// Uses production ComposedShell stories; no Host, paging or streaming here.
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

if (process.versions.electron) {
  const { app, BrowserWindow } = await import('electron');
  // Electron waits for ESM evaluation before ready: awaiting ready at module
  // scope would deadlock startup.
  void app.whenReady().then(async () => {
    const window = new BrowserWindow({
      width: 1200,
      height: 900,
      show: true,
      webPreferences: {
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    await window.loadURL('about:blank');
  });
} else {
  const { _electron, expect } = await import('@playwright/test');
  const { startStaticServer } = await import('../storybook-visual-smoke.mjs');
  const { report, summarize } = await import('./report.mjs');
  const server = await startStaticServer('apps/desktop/storybook-static');
  let app;
  const output = path.resolve(process.env.GEOMETRY_OUTPUT ?? 'perf-results/geometry-ablation.json');
  const repetitions = Number(process.env.GEOMETRY_REPETITIONS ?? 3);
  const scenes = [
    ['geometry-mixed-24-turns', 24],
    ['performance-45-tools', 1],
    ['geometry-long-code', 1],
  ].filter(([id]) => !process.env.GEOMETRY_SCENE || id === process.env.GEOMETRY_SCENE);
  if (!scenes.length || !Number.isInteger(repetitions) || repetitions < 1) {
    await server.close();
    throw new Error('Invalid geometry scene or repetition count');
  }
  const rows = [];
  try {
    app = await _electron.launch({ args: [fileURLToPath(import.meta.url)], timeout: 30_000 });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
    const cdp = await page.context().newCDPSession(page);
    const browser = await cdp.send('Browser.getVersion');
    await cdp.send('Performance.enable');
    await page.addInitScript(() => {
      const style = document.createElement('style');
      style.textContent = `*, *::before, *::after { transition:none !important; animation:none !important; }
        [data-chat-scroll-container] { scroll-behavior:auto !important; }`;
      const attach = () => {
        if (document.documentElement) document.documentElement.append(style);
      };
      if (document.documentElement) attach();
      else
        new MutationObserver((_, observer) => {
          if (document.documentElement) {
            attach();
            observer.disconnect();
          }
        }).observe(document, { childList: true });
      const probe = (window.__geometry = {
        frames: [],
        tasks: [],
        phase: 'mount',
        firstRootMs: null,
      });
      new PerformanceObserver((list) =>
        probe.tasks.push(
          ...list
            .getEntries()
            .map((e) => ({ start: e.startTime, duration: e.duration, phase: probe.phase })),
        ),
      ).observe({ type: 'longtask', buffered: true });
      const frame = () => {
        const root = document.querySelector('[data-chat-scroll-container]');
        if (root) {
          probe.firstRootMs ??= performance.now();
          probe.frames.push({
            ms: performance.now(),
            h: root.scrollHeight,
            t: root.scrollTop,
            v: root.clientHeight,
            phase: probe.phase,
          });
        }
        if (probe.phase !== 'done') requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
    const paint = () =>
      page.evaluate(
        () =>
          new Promise((resolve) => {
            let frames = 4;
            const step = () => (--frames ? requestAnimationFrame(step) : resolve());
            requestAnimationFrame(step);
          }),
      );
    const metrics = () =>
      page.evaluate(() => {
        const root = document.querySelector('[data-chat-scroll-container]');
        const origin = root.getBoundingClientRect().top;
        const mounted = [...root.querySelectorAll('.maka-transcript-turn')];
        return {
          h: root.scrollHeight,
          t: root.scrollTop,
          v: root.clientHeight,
          count: mounted.length,
          tops: Object.fromEntries(
            mounted.map((turn) => [
              turn.dataset.transcriptTurnId,
              turn.getBoundingClientRect().top - origin,
            ]),
          ),
        };
      });
    for (const [scene, turns] of scenes) {
      for (let trial = 0; trial < repetitions; trial++) {
        await page.goto(
          `${server.baseUrl}/iframe.html?id=product-shell-official-appshell--${scene}&viewMode=story`,
        );
        // Only the rows near the viewport are mounted, so the fixture's
        // membership is checked across the sweep instead of here.
        await expect(page.locator('.maka-transcript-turn').first()).toBeAttached();
        const seen = new Set();
        // Completed process content is collapsed by default. Measure its
        // expanded reading state, otherwise the 45-tool scene has no overflow.
        // Clicked from inside the page: opening one can unmount a row, which
        // Playwright's own click retries as a detached element until it times
        // out.
        const expandProcesses = () =>
          page.evaluate(() => {
            const collapsed = [
              ...document.querySelectorAll('.maka-processing-sequence:not([open]) > summary'),
            ];
            for (const summary of collapsed) summary.click();
            return collapsed.length;
          });
        const expandedProcess = (await expandProcesses()) > 0;
        for (let round = 0; round < 10 && (await expandProcesses()) > 0; round++);
        await page.evaluate(() => document.fonts.ready);
        await expect(page.locator('.maka-markdown-pending')).toHaveCount(0);
        if (expandedProcess) {
          await page.locator('[data-chat-scroll-container]').evaluate((root) => {
            root.scrollTo({ top: root.scrollHeight, behavior: 'instant' });
          });
        }
        await expect
          .poll(async () => {
            const m = await metrics();
            return m.h - m.v - m.t;
          })
          .toBeLessThanOrEqual(4);
        const { tops: _mountedAtRest, ...initial } = await metrics();
        expect(initial.h).toBeGreaterThan(initial.v * 3);
        const start = await page.evaluate(() => {
          window.__geometry.phase = 'cold-up';
          return performance.now();
        });
        const beforeCpu = await cdp.send('Performance.getMetrics');
        const box = await page.locator('[data-chat-scroll-container]').boundingBox();
        // The row the reader's eye is on: the last one whose top has passed the
        // viewport edge, or the first row when none has. A row measured for the
        // first time inside the viewport necessarily pushes what is below it,
        // so this anchor — not every mounted row — is what must hold still.
        const anchorOf = (m) => {
          const rows = Object.entries(m.tops);
          const passed = rows.filter(([, top]) => top <= 0.5);
          return passed.length
            ? passed.reduce((a, b) => (b[1] > a[1] ? b : a))
            : rows.reduce((a, b) => (b[1] < a[1] ? b : a), rows[0]);
        };
        // Returns how far the reader's anchor moved away from what the wheel
        // asked for, how many ticks moved it at all, and every scrollHeight the
        // sweep passed through.
        const sweep = async (phase, deltaY) => {
          await page.evaluate((phase) => {
            window.__geometry.phase = phase;
          }, phase);
          let displacement = 0;
          let slips = 0;
          const heights = [];
          for (let tick = 0; tick < 350; tick++) {
            const before = await metrics();
            heights.push(before.h);
            for (const id of Object.keys(before.tops)) seen.add(id);
            const room = deltaY < 0 ? before.t : before.h - before.v - before.t;
            if (room <= 1) return { displacement, slips, heights };
            await cdp.send('Input.dispatchMouseEvent', {
              type: 'mouseWheel',
              x: box.x + box.width / 2,
              y: box.y + box.height / 2,
              deltaX: 0,
              deltaY,
            });
            await paint();
            const after = await metrics();
            heights.push(after.h);
            for (const id of Object.keys(after.tops)) seen.add(id);
            expect(after.count, 'the transcript unmounted under the reader').toBeGreaterThan(0);
            // The wheel asks for `deltaY`, or for whatever is left at the edge.
            // Content must travel exactly that far: a virtualizer correcting a
            // row's size above the reader is free to move `scrollTop`, but not
            // the words the reader is looking at.
            const asked = -Math.sign(deltaY) * Math.min(Math.abs(deltaY), room);
            const anchor = anchorOf(before);
            if (anchor && anchor[0] in after.tops) {
              const moved = Math.abs(after.tops[anchor[0]] - anchor[1] - asked);
              displacement = Math.max(displacement, moved);
              if (moved > 1) slips += 1;
            }
          }
          throw new Error(`${scene}/${phase} did not reach the edge within 350 wheel ticks`);
        };
        const cold = await sweep('cold-up', -600);
        // A sweep from the tail to the head passes every row, so the whole
        // fixture must have been mounted at some point and nothing beyond it.
        expect(seen.size, 'fixed fixture membership changed').toBe(turns);
        const afterCpu = await cdp.send('Performance.getMetrics');
        // Every row has now been measured, so the document's height is no
        // longer an estimate. Reading back over it must not resize it at all —
        // that is the difference between the cost of estimating and a defect.
        const warmDown = await sweep('warm-down', 600);
        const warmUp = await sweep('warm-up', -600);
        await page.evaluate(() => {
          window.__geometry.phase = 'done';
        });
        const state = await page.evaluate(() => {
          const root = document.querySelector('[data-chat-scroll-container]');
          return {
            ...window.__geometry,
            liveNodes: root.querySelectorAll('*').length,
            remainingAuto: [...root.querySelectorAll('*')].filter(
              (el) => getComputedStyle(el).contentVisibility === 'auto',
            ).length,
          };
        });
        expect(state.remainingAuto, 'missed a lazy boundary').toBe(0);
        const spread = (list) => Math.max(...list) - Math.min(...list);
        const metric = (list, name) => list.metrics.find((m) => m.name === name)?.value ?? 0;
        const row = {
          scene,
          trial,
          initial,
          readyMs: start,
          // CDP duration counters reset on document navigation.
          mountLayoutMs: metric(beforeCpu, 'LayoutDuration') * 1000,
          mountTaskMs: metric(beforeCpu, 'TaskDuration') * 1000,
          firstRootMs: state.firstRootMs,
          coldHeightDrift: spread([initial.h, ...cold.heights]),
          warmHeightDrift: spread([...warmDown.heights, ...warmUp.heights]),
          coldReaderDisplacement: cold.displacement,
          coldReaderSlips: cold.slips,
          warmReaderDisplacement: Math.max(warmDown.displacement, warmUp.displacement),
          warmReaderSlips: warmDown.slips + warmUp.slips,
          maxTaskMs: Math.max(0, ...state.tasks.map((t) => t.duration)),
          scrollMaxTaskMs: Math.max(
            0,
            ...state.tasks.filter((t) => t.start >= start).map((t) => t.duration),
          ),
          layoutMs:
            (metric(afterCpu, 'LayoutDuration') - metric(beforeCpu, 'LayoutDuration')) * 1000,
          ...state,
        };
        rows.push(row);
        await mkdir(path.dirname(output), { recursive: true });
        await writeFile(
          output,
          JSON.stringify(
            {
              browser,
              viewport: '1200x900',
              repetitions,
              conditions:
                'Same Electron; fresh DOM per trial; fonts and Markdown ready; no offscreen box reads; real CDP wheel, once up over unmeasured rows and then down and up again over measured ones. Synthetic fixed-range production stories, no Host or paging.',
              rows,
            },
            null,
            2,
          ),
        );
        console.log(
          JSON.stringify({
            scene,
            trial,
            coldHeightDrift: row.coldHeightDrift,
            warmHeightDrift: row.warmHeightDrift,
            coldReaderDisplacement: row.coldReaderDisplacement,
            coldReaderSlips: row.coldReaderSlips,
            warmReaderSlips: row.warmReaderSlips,
            readyMs: Math.round(start),
            maxTaskMs: row.maxTaskMs,
            scrollMaxTaskMs: row.scrollMaxTaskMs,
            layoutMs: Math.round(row.layoutMs),
          }),
        );
        if (process.argv.includes('--assert-stable')) {
          // Once every row has been measured there is nothing left to correct,
          // so a measured transcript owes the reader an exact ride.
          expect(row.warmReaderSlips, `${scene}: measured transcript moved the reader`).toBe(0);
          expect(row.warmHeightDrift, `${scene}: measured height drift`).toBeLessThanOrEqual(1);
          // Reading over unmeasured rows costs at most one slip: a Turn taller
          // than the measure-ahead margin cannot be measured before it reaches
          // the reader, and a correction to a row already straddling the
          // viewport edge is the one virtua does not absorb. More than one and
          // rows are being measured too late again.
          expect(
            row.coldReaderSlips,
            `${scene}: unmeasured rows moved the reader, worst ${row.coldReaderDisplacement}px`,
          ).toBeLessThanOrEqual(1);
        }
      }
    }
    await report(
      'frontend-geometry-ablation',
      {
        browser,
        repetitions,
        viewport: '1200x900',
        conditions:
          'One Electron process, production layout, fresh DOM per trial. Mount metrics include document navigation and readiness polling; not disk-cold startup or screen presentation.',
        limits:
          'Synthetic fixed-range production components, no Host or paging. Three samples per scene by default; p95 is the maximum. --assert-stable gates a measured transcript exactly — no reader slip, no height drift — and allows the first read over unmeasured rows one slip, for a Turn taller than the measure-ahead margin. How far that one slip moves the reader, and how much the document resizes while it is being measured, are recorded without thresholds, like the timing measurements. Scroll layout/task samples cover only the cold upward sweep.',
      },
      scenes.flatMap(([scene]) => {
        const group = rows.filter((r) => r.scene === scene);
        return [
          'readyMs',
          'mountLayoutMs',
          'mountTaskMs',
          'maxTaskMs',
          'scrollMaxTaskMs',
          'layoutMs',
          'coldHeightDrift',
          'warmHeightDrift',
          'coldReaderDisplacement',
          'coldReaderSlips',
          'warmReaderSlips',
        ].map((metric) => ({
          scenario: scene,
          metric,
          ...summarize(group.map((r) => r[metric])),
        }));
      }),
    );
    console.log(`Report: ${output}`);
  } finally {
    await app?.close();
    await server.close();
  }
}
