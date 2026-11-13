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
import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { startStaticServer } from '../storybook-visual-smoke.mjs';
import { outputDir } from './report.mjs';

const server = await startStaticServer('apps/desktop/storybook-static');
let browser;
try {
  browser = await chromium.launch();
  await mkdir(outputDir, { recursive: true });
  for (const touch of [false, true]) {
    const context = await browser.newContext({
      hasTouch: touch,
      viewport: { width: 1000, height: 1000 },
    });
    const page = await context.newPage();
    await page.goto(
      server.baseUrl +
        '/iframe.html?id=design-system-astryx-hover-compatibility--pointer-and-keyboard&viewMode=story',
    );
    const checkbox = page.getByRole('checkbox', { name: 'Enabled checkbox', exact: true });
    const toggle = page.getByRole('switch', { name: 'Enabled switch', exact: true });
    await checkbox.waitFor();
    const activate = async (locator) => (touch ? locator.tap() : locator.click());
    await activate(checkbox);
    await expect(checkbox).toBeChecked();
    await activate(toggle);
    await expect(toggle).toBeChecked();
    await expect(
      page.getByRole('checkbox', { name: 'Disabled checkbox', exact: true }),
    ).toBeDisabled();
    await expect(page.getByRole('switch', { name: 'Disabled switch', exact: true })).toBeDisabled();
    await activate(page.getByRole('tab', { name: 'Second tab', exact: true }));
    await expect(page.getByRole('tabpanel')).toHaveText('Selected: second');
    const header = page.getByRole('columnheader', { name: 'Name' });
    await activate(header);
    await expect(page.getByRole('row').nth(1)).toContainText('Alpha');
    if (!touch) {
      await header.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('row').nth(1)).toContainText('Beta');
      await checkbox.focus();
      await page.keyboard.press('Space');
      await expect(checkbox).not.toBeChecked();
      await toggle.focus();
      await page.keyboard.press('Space');
      await expect(toggle).not.toBeChecked();
      await page.getByRole('tab', { name: 'Second tab', exact: true }).focus();
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('Enter');
      await expect(page.getByRole('tabpanel')).toHaveText('Selected: first');
      const overlay = page.getByRole('button', { name: 'Overlay base', exact: true });
      await overlay.hover();
      await expect(page.getByRole('button', { name: 'Overlay action', exact: true })).toBeVisible();
      assert.ok(
        await page.locator('[data-astryx-hover]').count(),
        'Pointer entry marks actual Astryx roots',
      );
      await page.getByRole('button', { name: 'Overlay action', exact: true }).click();
      await expect(page.getByText('Overlay actions: 1', { exact: true })).toBeVisible();
      await page.mouse.move(990, 990);
      await expect(page.locator('[data-astryx-hover]')).toHaveCount(0);
      await overlay.focus();
      await expect(page.getByRole('button', { name: 'Overlay action', exact: true })).toBeVisible();
      // Compare the same focused/selected/disabled states with the original
      // conditions restored in CSSOM, then return to the actual patched CSS.
      const rewrite = async (original) =>
        page.evaluate((original) => {
          function visit(rules) {
            for (const rule of rules) {
              if (rule.selectorText?.includes('[data-astryx-hover]')) {
                rule.__markerSelector = rule.selectorText;
                if (original)
                  rule.selectorText = rule.selectorText.replaceAll('[data-astryx-hover]', ':hover');
              } else if (!original && rule.__markerSelector)
                rule.selectorText = rule.__markerSelector;
              if (rule.cssRules) visit(rule.cssRules);
            }
          }
          for (const sheet of document.styleSheets) visit(sheet.cssRules);
        }, original);
      await page.waitForTimeout(300);
      await rewrite(true);
      const before = await page.screenshot({ path: outputDir + '/astryx-original.png' });
      await rewrite(false);
      const after = await page.screenshot({ path: outputDir + '/astryx-marker.png' });
      assert.deepEqual(after, before, 'Focused, selected and disabled fixture pixels remain equal');
    } else {
      // The package deliberately excludes interactive children from its
      // clickable-container toggle. Tap the non-interactive overlay surface.
      await page
        .locator('section')
        .first()
        .tap({ position: { x: 500, y: 70 } });
      await expect(page.getByRole('button', { name: 'Overlay action', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Overlay action', exact: true }).tap();
      await expect(page.getByText('Overlay actions: 1', { exact: true })).toBeVisible();
      await expect(page.locator('[data-astryx-hover]')).toHaveCount(0);
    }
    await page.screenshot({
      path: outputDir + '/astryx-' + (touch ? 'touch-emulation' : 'mouse-keyboard') + '.png',
    });
    console.log(
      touch
        ? 'PASS: CDP touch taps; no sticky hover markers (not physical-device validation)'
        : 'PASS: mouse, keyboard, disabled controls, Overlay focus and marker lifecycle',
    );
    await context.close();
  }
} finally {
  await browser?.close();
  await server.close();
}
