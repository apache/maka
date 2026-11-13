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
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { startStaticServer } from '../storybook-visual-smoke.mjs';
import { outputDir, report } from './report.mjs';

// One document/browser, alternating CSSOM A/B. Restore precisely the 16
// ancestor conditions changed by the dependency patch, without rebuilding or
// replacing product DOM. This measures the selector change, not two app starts.
const server = await startStaticServer('apps/desktop/storybook-static');
let browser;
try {
  browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(
    server.baseUrl +
      '/iframe.html?id=product-shell-official-appshell--performance-45-tools&args=steps:360&viewMode=story',
  );
  const turn = page.locator('[data-turn-id="turn-oversized"]');
  await turn.waitFor();
  // Expand the process through its real disclosure, retaining the production
  // Turn and transcript frame. Fail if this is no longer the 360-step workload.
  const disclosure = turn.locator('summary[aria-expanded="false"]').first();
  if (await disclosure.count()) await disclosure.click();
  await page.waitForFunction(
    () => document.querySelectorAll('[data-slot="chat-tool-call-row"]').length === 360,
  );
  await page.evaluate(() => {
    const rules = [];
    function visit(list) {
      for (const rule of list) {
        if (rule.selectorText?.includes('[data-astryx-hover]'))
          rules.push([rule, rule.selectorText]);
        if (rule.cssRules) visit(rule.cssRules);
      }
    }
    for (const sheet of document.styleSheets) visit(sheet.cssRules);
    window.__hoverRules = rules;
    window.__hoverFrames = [];
    if (!PerformanceObserver.supportedEntryTypes.includes('long-animation-frame'))
      throw new Error('LoAF unsupported');
    new PerformanceObserver((list) =>
      window.__hoverFrames.push(...list.getEntries().map((e) => e.duration)),
    ).observe({ type: 'long-animation-frame' });
  });
  const ruleCount = await page.evaluate(() => window.__hoverRules.length);
  assert.equal(ruleCount, 16, 'Must compare all 16 patched selector rules');
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1000);
  const workload = await page.evaluate(() => {
    const root = document.querySelector('[data-chat-scroll-container]');
    root.scrollTop = root.scrollHeight / 2;
    return { elements: document.querySelectorAll('*').length, scrollHeight: root.scrollHeight };
  });
  await page.waitForTimeout(1000);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const metrics = async () =>
    Object.fromEntries(
      (await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]),
    );
  const samples = [];
  await mkdir(outputDir, { recursive: true });
  for (let trial = 0; trial < 3; trial++) {
    for (const mode of trial % 2 ? ['marker', 'ancestor-hover'] : ['ancestor-hover', 'marker']) {
      await page.mouse.move(1, 1);
      await page.evaluate((mode) => {
        for (const [rule, selector] of window.__hoverRules) {
          rule.selectorText =
            mode === 'marker' ? selector : selector.replaceAll('[data-astryx-hover]', ':hover');
        }
      }, mode);
      await page.waitForTimeout(500);
      const box = await page.locator('[data-chat-scroll-container]').boundingBox();
      assert.ok(box && box.width > 100 && box.height > 100);
      await page.evaluate(() => {
        window.__hoverFrames.length = 0;
      });
      const before = await metrics();
      for (let row = 0; row < 14; row++) {
        for (let col = 0; col < 40; col++) {
          const x = row % 2 ? 39 - col : col;
          await page.mouse.move(
            box.x + 8 + (x * (box.width - 16)) / 39,
            box.y + 8 + (row * (box.height - 16)) / 13,
            { steps: 2 },
          );
        }
      }
      await page.waitForTimeout(200);
      const after = await metrics();
      const frames = await page.evaluate(() => window.__hoverFrames.slice());
      samples.push({
        trial,
        mode,
        loafOver50ms: frames.filter((n) => n > 50).length,
        maxLoafMs: Math.max(0, ...frames),
        styleRecalcMs: (after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000,
        styleRecalcCount: after.RecalcStyleCount - before.RecalcStyleCount,
        layoutMs: (after.LayoutDuration - before.LayoutDuration) * 1000,
      });
      console.log(JSON.stringify(samples.at(-1)));
      if (trial === 0) await page.screenshot({ path: outputDir + '/hover-' + mode + '.png' });
    }
  }
  await report(
    'transcript-hover',
    {
      chromium: browser.version(),
      workload,
      ruleCount,
      fixture: 'static Storybook build, oversizedTurnMessages(360), expanded process',
      grid: '14x40, 2-step CDP mouse moves',
      comparison: 'same document CSSOM restoration of the 16 original ancestor-hover conditions',
      limitations:
        'Current platform and Chromium; not a reproduction of the issue author’s Windows/browser version. Touch emulation is separate from physical-device testing.',
    },
    samples.map((s) => ({
      scenario: s.mode + '-trial-' + s.trial,
      metric: 'style-recalc-ms',
      n: 1,
      median: s.styleRecalcMs,
      p95: s.styleRecalcMs,
      samples: [s.styleRecalcMs],
    })),
  );
  await writeFile(
    outputDir + '/transcript-hover-samples.json',
    JSON.stringify({ workload, samples }, null, 2),
  );
} finally {
  await browser?.close();
  await server.close();
}
