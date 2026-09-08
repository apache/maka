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

import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startStaticServer } from '../storybook-visual-smoke.mjs';
import { outputDir, report, summarize } from './report.mjs';

const server = await startStaticServer('apps/desktop/storybook-static');
const browser = await chromium.launch({ headless: false });
const rows = [];
async function scrollSteps(page) {
  return page.evaluate(async () => {
    const root = document.querySelector('[data-chat-scroll-container]');
    root.scrollTo({ top: root.scrollHeight, behavior: 'instant' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const result = [];
    for (let i = 0; i < 8; i++) {
      const box = root.getBoundingClientRect();
      const anchor = [...root.querySelectorAll('[data-maka-transcript-boundary]')].find((el) => {
        const rect = el.getBoundingClientRect();
        return rect.top >= box.top && rect.top < box.bottom;
      });
      if (!anchor) throw new Error('Missing visible reading anchor');
      const before = anchor.getBoundingClientRect().top;
      const intended = Math.min(240, root.scrollTop);
      if (!intended) throw new Error('Empty scrolling workload');
      root.scrollBy({ top: -intended, behavior: 'instant' });
      root.dispatchEvent(new Event('scroll'));
      await new Promise((resolve) => setTimeout(resolve, 100));
      result.push({ intended, moved: anchor.getBoundingClientRect().top - before });
    }
    return result;
  });
}
try {
  const page = await browser.newPage({
    viewport: { width: 1400, height: 900 },
    colorScheme: 'light',
    reducedMotion: 'reduce',
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const samples = [],
    coldAnchors = [],
    anchors = [],
    nodes = [],
    heaps = [];
  for (let trial = 0; trial < 10; trial++) {
    await page.goto(
      server.baseUrl +
        '/iframe.html?id=product-shell-official-appshell--performance-45-tools&viewMode=story',
    );
    await page.locator('[data-turn-id="turn-oversized"]').waitFor();
    await page.waitForFunction(
      () => document.querySelector('[data-chat-scroll-container]')?.scrollHeight > 2700,
    );
    const coldSteps = await scrollSteps(page);
    coldAnchors.push(...coldSteps.map((s) => Math.abs(s.moved - s.intended)));
  }
  for (let trial = 0; trial < 10; trial++) {
    const started = performance.now();
    const tools = page.getByRole('button', { name: /合成检查 \d+/ });
    assert.equal(await tools.count(), 45, 'All 45 tool disclosures must exist');
    for (let i = 0; i < 45; i++) {
      const button = tools.nth(i);
      await button.evaluate((el) =>
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })),
      );
      await page
        .getByText('第 ' + (i + 1) + ' 组：确定性、可重放，无回归。', { exact: true })
        .waitFor({ state: 'visible' });
    }
    samples.push(performance.now() - started);
    const steps = await scrollSteps(page);
    anchors.push(...steps.map((s) => Math.abs(s.moved - s.intended)));
    for (let i = 0; i < 45; i++) {
      await tools
        .nth(i)
        .evaluate((el) =>
          el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })),
        );
      await page
        .getByText('第 ' + (i + 1) + ' 组：确定性、可重放，无回归。', { exact: true })
        .waitFor({ state: 'hidden' });
    }
    nodes.push((await cdp.send('Memory.getDOMCounters')).nodes);
    heaps.push((await cdp.send('Runtime.getHeapUsage')).usedSize);
  }
  for (const [metric, values] of Object.entries({
    'expand-45-dom-ms': samples,
    'cold-collapsed-unexpected-anchor-px': coldAnchors,
    'expanded-unexpected-anchor-px': anchors,
    'dom-nodes-after-close': nodes,
    'heap-bytes-no-gc': heaps,
  }))
    rows.push({ scenario: 'storybook-45-tools', metric, ...summarize(values) });
  // Harness-only negative control proves the long-task observer is active.
  const control = await page.evaluate(async () => {
    const durations = [];
    const observer = new PerformanceObserver((list) =>
      durations.push(...list.getEntries().map((e) => e.duration)),
    );
    observer.observe({ type: 'longtask' });
    await new Promise((resolve) =>
      setTimeout(() => {
        const start = performance.now();
        while (performance.now() - start < 100) {
          /* calibration */
        }
        setTimeout(resolve, 100);
      }, 0),
    );
    observer.disconnect();
    return durations;
  });
  assert(
    control.some((n) => n >= 90),
    'Long-task negative control was not detected',
  );
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, 'frontend-control.json'), JSON.stringify(control));
  await report(
    'frontend-storybook',
    {
      fixture: 'Performance45Tools, existing oversizedTurnMessages generator',
      chromium: browser.version(),
      viewport: '1400x900',
      theme: 'light',
      motion: 'reduce',
      repetitions: 10,
      conditions:
        'Ten fresh story navigations for cold scrolling, then ten expand/scroll/close cycles in the final mounted story. Synthetic ComposedShell, no Host. Relative programmatic scrolling, 100ms geometry settling.',
      limits:
        'DOM completion and anchor geometry are not screen-present timestamps or native wheel acceptance. Heap includes uncollected objects and previous document garbage; short repeated cycles alone do not prove a leak.',
    },
    rows,
  );
} finally {
  await browser.close();
  await server.close();
}
