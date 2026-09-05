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

import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';

async function expandComputerUse(page: Page): Promise<Locator> {
  const row = page.locator('[data-readiness]').first();
  const trigger = row.locator('button[aria-expanded]').first();
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  return row;
}

async function metadataTextRows(row: Locator) {
  return row.evaluate((element) => {
    const firstTextMetrics = (root: HTMLElement) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node && !node.textContent?.trim()) node = walker.nextNode();
      if (!node?.parentElement) throw new Error('Metadata cell has no text');
      const range = document.createRange();
      range.selectNodeContents(node);
      return {
        bottom: range.getBoundingClientRect().bottom,
        fontSize: getComputedStyle(node.parentElement).fontSize,
      };
    };

    return Array.from(
      element.querySelectorAll<HTMLElement>('.settingsCapabilityMetadata > dl'),
    ).flatMap((grid) => {
      const terms = Array.from(grid.querySelectorAll<HTMLElement>(':scope > dt'));
      const values = Array.from(grid.querySelectorAll<HTMLElement>(':scope > dd'));
      if (terms.length !== values.length) throw new Error('Metadata pairs are incomplete');
      return terms.map((term, index) => {
        const value = values[index]!;
        const labelMetrics = firstTextMetrics(term);
        const valueMetrics = firstTextMetrics(value);
        return {
          label: term.textContent?.trim() ?? '',
          value: value.textContent?.trim() ?? '',
          labelTextBottom: labelMetrics.bottom,
          valueTextBottom: valueMetrics.bottom,
          labelFontSize: labelMetrics.fontSize,
          valueFontSize: valueMetrics.fontSize,
        };
      });
    });
  });
}

test('Permission Center gives each metadata label and value consistent body typography', async ({
  permissionCenterWindow: page,
}) => {
  await page.setViewportSize({ width: 1490, height: 900 });
  const rows = await metadataTextRows(await expandComputerUse(page));

  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(
      Math.abs(row.labelTextBottom - row.valueTextBottom),
      `${row.label} and ${row.value} should share a text baseline`,
    ).toBeLessThanOrEqual(1);
    expect(
      row.valueFontSize,
      `${row.label} and ${row.value} should use the same body text size`,
    ).toBe(row.labelFontSize);
  }
});
