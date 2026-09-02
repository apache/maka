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

import { expect, test } from './fixtures';

test('production AgentGraphPanel keeps its heading visible without covering scrolled content', async ({ agentGraphWindow: page }) => {
  const panel = page.getByRole('region', { name: 'Agent Graph', exact: true });
  await expect(panel).toBeVisible();
  await expect(panel.locator('.maka-agent-graph-operators > li')).toHaveCount(24);
  const content = panel.locator('.maka-agent-graph-content');
  const before = await panel.evaluate((element) => {
    const heading = element.querySelector('.maka-agent-graph-heading');
    const content = element.querySelector('.maka-agent-graph-content');
    if (!(heading instanceof HTMLElement) || !(content instanceof HTMLElement)) {
      throw new Error('Agent Graph production panel structure is incomplete');
    }
    const panelRect = element.getBoundingClientRect();
    const headingRect = heading.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    return {
      panelHeight: panelRect.height,
      headingTop: headingRect.top,
      headingBottom: headingRect.bottom,
      contentTop: contentRect.top,
      contentScrollHeight: content.scrollHeight,
      contentClientHeight: content.clientHeight,
      contentScrollTop: content.scrollTop,
    };
  });
  expect(before.contentScrollHeight).toBeGreaterThan(before.contentClientHeight);
  await content.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const after = await panel.evaluate((element) => {
    const heading = element.querySelector('.maka-agent-graph-heading');
    const content = element.querySelector('.maka-agent-graph-content');
    if (!(heading instanceof HTMLElement) || !(content instanceof HTMLElement)) {
      throw new Error('Agent Graph production panel structure is incomplete');
    }
    const headingRect = heading.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    return {
      headingTop: headingRect.top,
      headingBottom: headingRect.bottom,
      contentTop: contentRect.top,
      contentScrollTop: content.scrollTop,
    };
  });
  expect(after.contentScrollTop).toBeGreaterThan(0);
  expect(Math.abs(after.headingTop - before.headingTop)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.contentTop - before.contentTop)).toBeLessThanOrEqual(1);
  expect(after.contentTop).toBeGreaterThanOrEqual(after.headingBottom);
  const collapse = page.getByRole('button', { name: '收起 Agent Graph', exact: true });
  await collapse.click();
  await expect(panel).toHaveAttribute('data-collapsed', 'true');
  // The data attribute is committed before a newly loaded stylesheet has
  // necessarily completed its first style recalculation. Wait for the
  // collapsed contract rather than sampling that transient pre-CSS value.
  await expect
    .poll(async () => panel.locator('.maka-agent-graph-heading').evaluate((element) => {
      const style = getComputedStyle(element);
      return { paddingBottom: style.paddingBottom, borderBottomWidth: style.borderBottomWidth };
    }))
    .toEqual({ paddingBottom: '0px', borderBottomWidth: '0px' });
  const collapsedHeading = await panel.locator('.maka-agent-graph-heading').evaluate((element) => {
    const style = getComputedStyle(element);
    return { paddingBottom: style.paddingBottom, borderBottomWidth: style.borderBottomWidth };
  });
  expect(collapsedHeading.paddingBottom).toBe('0px');
  expect(collapsedHeading.borderBottomWidth).toBe('0px');
});
