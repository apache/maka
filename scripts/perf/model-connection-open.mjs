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

// Build Storybook first, then run from the repository root. No provider key or Host is used.
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { startStaticServer } from '../storybook-visual-smoke.mjs';

const server = await startStaticServer('apps/desktop/storybook-static');
const browser = await chromium.launch(
  process.env.MAKA_PERF_CHROME_CHANNEL ? { channel: process.env.MAKA_PERF_CHROME_CHANNEL } : {},
);
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await page.addInitScript(() => {
    const probe = (window.__modelOpenProbe = { started: 0, completed: 0, longTasks: [] });
    new PerformanceObserver((list) => {
      probe.longTasks.push(
        ...list.getEntries().map((entry) => ({
          start: entry.startTime,
          duration: entry.duration,
        })),
      );
    }).observe({ type: 'longtask', buffered: true });
    document.addEventListener(
      'click',
      (event) => {
        if (!event.target.closest('[data-connection-slug="openrouter-large"]')) return;
        probe.started = performance.now();
        const afterPaint = () =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              probe.completed = performance.now();
              probe.rows = document.querySelectorAll('button[aria-label*="Fixture model"]').length;
              probe.nodes = document.querySelectorAll('*').length;
            }),
          );
        const waitForRows = () => {
          if (document.querySelectorAll('button[aria-label*="Fixture model"]').length === 444) {
            afterPaint();
          } else {
            requestAnimationFrame(waitForRows);
          }
        };
        requestAnimationFrame(waitForRows);
      },
      { capture: true },
    );
  });

  const samples = [];
  for (let i = 0; i < 5; i++) {
    await page.goto(
      `${server.baseUrl}/iframe.html?id=product-settings-providers--large-connection-detail&viewMode=story`,
    );
    await page.waitForFunction(() => window.__modelOpenProbe?.completed > 0, null, {
      timeout: 30_000,
    });
    const sample = await page.evaluate(() => {
      const { started, completed, longTasks, rows, nodes } = window.__modelOpenProbe;
      const duringOpen = longTasks.filter(
        (task) => task.start + task.duration >= started && task.start <= completed,
      );
      return {
        openMs: Math.round(completed - started),
        longestTaskMs: Math.round(Math.max(0, ...duringOpen.map((task) => task.duration))),
        rows,
        nodes,
      };
    });
    assert.equal(sample.rows, 444);
    samples.push(sample);
  }
  const filter = page.getByRole('textbox', { name: /搜索模型|Search models/ });
  await filter.fill('fixture/model-444');
  const action = page.getByRole('button', { name: /Fixture model 444/ });
  const enabled = page.getByRole('switch', { name: /Fixture model 444/ });
  await expect(action).toHaveCount(1);
  await expect(enabled).not.toBeChecked();
  await enabled.click();
  await expect(enabled).toBeChecked();
  await action.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await filter.fill('Fixture model 001');
  await expect(page.getByRole('button', { name: /Fixture model 001/ })).toHaveCount(1);
  await filter.fill('');
  await expect(page.locator('button[aria-label*="Fixture model"]')).toHaveCount(444);
  if (process.env.MAKA_PERF_SCREENSHOT) {
    await page.screenshot({ path: process.env.MAKA_PERF_SCREENSHOT });
  }
  await page.setViewportSize({ width: 480, height: 800 });
  await filter.fill('fixture/model-444');
  await expect(action).toBeVisible();
  const actionBounds = await action.boundingBox();
  const switchBounds = await enabled.boundingBox();
  assert.ok(actionBounds && switchBounds);
  assert.ok(
    actionBounds.x + actionBounds.width <= switchBounds.x ||
      actionBounds.y + actionBounds.height <= switchBounds.y,
    'the parameter action must not overlap its enable switch',
  );
  if (process.env.MAKA_PERF_MOBILE_SCREENSHOT) {
    await page.screenshot({ path: process.env.MAKA_PERF_MOBILE_SCREENSHOT });
  }
  console.log(JSON.stringify(samples, null, 2));
} finally {
  await browser.close();
  await server.close();
}
