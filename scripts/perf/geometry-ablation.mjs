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

// Manual diagnostic, not a passing substitute for the future geometry CI
// gate. One Electron process, fresh DOM per trial, alternating configurations.
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
  const modes = ['baseline', 'no-turn-skip', 'no-skip'].filter(
    (mode) => !process.env.GEOMETRY_MODE || mode === process.env.GEOMETRY_MODE,
  );
  if (!scenes.length || !modes.length || !Number.isInteger(repetitions) || repetitions < 1) {
    await server.close();
    throw new Error('Invalid geometry scene, mode or repetition count');
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
      const mode = new URL(location.href).searchParams.get('ablation');
      const style = document.createElement('style');
      const turn = '.maka-transcript-turn';
      // The inline intrinsic-size declaration belongs to Astryx CodeChunk.
      const boundaries = `${turn}, [data-maka-transcript-boundary], .astryx-codeblock [style*="contain-intrinsic-block-size"]`;
      style.textContent = `*, *::before, *::after { transition:none !important; animation:none !important; }
        [data-chat-scroll-container] { scroll-behavior:auto !important; }
        ${mode === 'no-turn-skip' ? turn : mode === 'no-skip' ? boundaries : ':not(*)'} {
          content-visibility:visible !important;
          contain:layout style paint !important;
        }`;
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
        loaf: [],
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
      if (PerformanceObserver.supportedEntryTypes.includes('long-animation-frame')) {
        new PerformanceObserver((list) =>
          probe.loaf.push(
            ...list
              .getEntries()
              .map((e) => ({ start: e.startTime, duration: e.duration, phase: probe.phase })),
          ),
        ).observe({ type: 'long-animation-frame', buffered: true });
      }
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
        return {
          h: root.scrollHeight,
          t: root.scrollTop,
          v: root.clientHeight,
          count: root.querySelectorAll('.maka-transcript-turn').length,
        };
      });
    for (const [scene, turns] of scenes) {
      for (let trial = 0; trial < repetitions; trial++) {
        // Rotate the order so a cold module cache cannot always favour one mode.
        for (const mode of [
          ...modes.slice(trial % modes.length),
          ...modes.slice(0, trial % modes.length),
        ]) {
          await page.goto(
            `${server.baseUrl}/iframe.html?id=product-shell-official-appshell--${scene}&viewMode=story&ablation=${mode}`,
          );
          await expect(page.locator('.maka-transcript-turn')).toHaveCount(turns);
          await page.evaluate(() => document.fonts.ready);
          await expect(page.locator('.maka-markdown-pending')).toHaveCount(0);
          await expect
            .poll(async () => {
              const m = await metrics();
              return m.h - m.v - m.t;
            })
            .toBeLessThanOrEqual(4);
          const initial = await metrics();
          expect(initial.h).toBeGreaterThan(initial.v * 3);
          const start = await page.evaluate(() => {
            window.__geometry.phase = 'cold-up';
            return performance.now();
          });
          const beforeCpu = await cdp.send('Performance.getMetrics');
          const box = await page.locator('[data-chat-scroll-container]').boundingBox();
          const steps = [];
          const sweep = async (phase, deltaY) => {
            await page.evaluate((phase) => {
              window.__geometry.phase = phase;
            }, phase);
            for (let tick = 0; tick < 350; tick++) {
              const before = await metrics();
              if (deltaY < 0 ? before.t <= 1 : before.h - before.v - before.t <= 1) return;
              // elementFromPoint selects only an already visible leaf. Never
              // measure the offscreen descendants to find an anchor.
              await page.evaluate(
                ({ x, y }) => {
                  const el = document.elementFromPoint(x, y);
                  window.__anchor = { el, top: el?.getBoundingClientRect().top };
                },
                { x: box.x + box.width / 2, y: box.y + box.height / 2 },
              );
              await cdp.send('Input.dispatchMouseEvent', {
                type: 'mouseWheel',
                x: box.x + box.width / 2,
                y: box.y + box.height / 2,
                deltaX: 0,
                deltaY,
              });
              await paint();
              const after = await metrics();
              const moved = await page.evaluate(() => {
                const a = window.__anchor;
                return a.el?.isConnected ? a.el.getBoundingClientRect().top - a.top : null;
              });
              steps.push({ phase, tick, before, after, moved });
              expect(after.count, 'fixed fixture membership changed').toBe(turns);
            }
            throw new Error(
              `${scene}/${mode}/${phase} did not reach the edge within 350 wheel ticks`,
            );
          };
          await sweep('cold-up', -600);
          await sweep('warm-down', 600);
          await sweep('warm-up', -600);
          const afterCpu = await cdp.send('Performance.getMetrics');
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
          if (mode === 'no-skip') expect(state.remainingAuto, 'missed a lazy boundary').toBe(0);
          const up = state.frames.filter((f) => f.phase === 'cold-up');
          const heights = [initial.h, ...up.map((f) => f.h)];
          const maxReverse = Math.max(0, ...up.slice(1).map((f, i) => f.t - up[i].t));
          const metric = (list, name) => list.metrics.find((m) => m.name === name)?.value ?? 0;
          const row = {
            scene,
            mode,
            trial,
            initial,
            readyMs: start,
            // CDP duration counters reset on document navigation.
            mountLayoutMs: metric(beforeCpu, 'LayoutDuration') * 1000,
            mountTaskMs: metric(beforeCpu, 'TaskDuration') * 1000,
            firstRootMs: state.firstRootMs,
            heightDrift: Math.max(...heights) - Math.min(...heights),
            maxReverse,
            maxTaskMs: Math.max(0, ...state.tasks.map((t) => t.duration)),
            scrollMaxTaskMs: Math.max(
              0,
              ...state.tasks.filter((t) => t.start >= start).map((t) => t.duration),
            ),
            layoutMs:
              (metric(afterCpu, 'LayoutDuration') - metric(beforeCpu, 'LayoutDuration')) * 1000,
            heap: await cdp.send('Runtime.getHeapUsage'),
            steps,
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
                  'Same Electron; alternating fresh DOMs; fonts and Markdown ready; no offscreen box reads before traversal; real CDP wheel. Containment preserved; only skipping removed. Synthetic fixed-range production stories, no Host or paging.',
                rows,
              },
              null,
              2,
            ),
          );
          console.log(
            JSON.stringify({
              scene,
              mode,
              trial,
              heightDrift: row.heightDrift,
              maxReverse,
              readyMs: Math.round(start),
              maxTaskMs: row.maxTaskMs,
              scrollMaxTaskMs: row.scrollMaxTaskMs,
              layoutMs: Math.round(row.layoutMs),
            }),
          );
          if (process.argv.includes('--assert-stable')) {
            expect(
              row.heightDrift,
              `${scene}/${mode}: fixed-range height drift`,
            ).toBeLessThanOrEqual(1);
            expect(maxReverse, `${scene}/${mode}: upward scroll reversed`).toBeLessThanOrEqual(1);
          }
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
          'One Electron process, rotating modes, fresh DOM. Mount metrics include document navigation and readiness polling; not disk-cold startup or screen presentation.',
        limits:
          'Synthetic fixed-range production components, no Host. Three samples per configuration by default; p95 is the maximum. Geometry report is diagnostic, not a default-product correctness gate.',
      },
      scenes.flatMap(([scene]) =>
        modes.flatMap((mode) => {
          const group = rows.filter((r) => r.scene === scene && r.mode === mode);
          return [
            'readyMs',
            'mountLayoutMs',
            'mountTaskMs',
            'maxTaskMs',
            'scrollMaxTaskMs',
            'layoutMs',
            'heightDrift',
            'maxReverse',
          ].map((metric) => ({
            scenario: `${scene}/${mode}`,
            metric,
            ...summarize(group.map((r) => r[metric])),
          }));
        }),
      ),
    );
    console.log(`Report: ${output}`);
  } finally {
    await app?.close();
    await server.close();
  }
}
