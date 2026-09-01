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
  const panel = page.getByRole('region', { name: 'Agent Graph' });
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
});

test('Agent Graph CSS contract keeps its heading visible without covering scrolled content', async ({ window: page }) => {
  const geometry = await page.evaluate(() => {
    const panel = document.createElement('section');
    panel.className = 'maka-agent-graph-panel';

    const heading = document.createElement('header');
    heading.className = 'maka-agent-graph-heading';
    heading.textContent = 'Agent Graph';

    const content = document.createElement('div');
    content.className = 'maka-agent-graph-content';

    const operators = document.createElement('ul');
    operators.className = 'maka-agent-graph-operators';
    for (let index = 0; index < 24; index += 1) {
      const operator = document.createElement('li');
      operator.textContent = `operator-${index + 1}`;
      operators.append(operator);
    }
    content.append(operators);
    panel.append(heading, content);
    // Give the fixture the bounded viewport production gets from max-height.
    // The explicit height keeps the overflow contract deterministic when the
    // surrounding E2E shell has an unconstrained body height.
    panel.style.height = '295px';
    document.body.append(panel);

    const panelStyle = getComputedStyle(panel);
    const panelOverflow = panelStyle.overflow;
    const contentStyle = getComputedStyle(content);
    const headingStyle = getComputedStyle(heading);
    const panelMaxHeight = panelStyle.maxHeight;
    const panelRectBefore = panel.getBoundingClientRect();
    const headingRectBefore = heading.getBoundingClientRect();
    const contentRectBefore = content.getBoundingClientRect();
    content.scrollTop = content.scrollHeight;
    const panelRectAfter = panel.getBoundingClientRect();
    const headingRectAfter = heading.getBoundingClientRect();
    const contentRectAfter = content.getBoundingClientRect();
    const beforeOffset = headingRectBefore.top - panelRectBefore.top;
    const afterOffset = headingRectAfter.top - panelRectAfter.top;
    panel.dataset.collapsed = 'true';
    const collapsedStyle = getComputedStyle(panel);

    return {
      panelOverflow,
      contentOverflow: contentStyle.overflow,
      panelMaxHeight,
      headingPosition: headingStyle.position,
      panelScrollTop: panel.scrollTop,
      contentScrollTop: content.scrollTop,
      panelScrollHeight: panel.scrollHeight,
      panelClientHeight: panel.clientHeight,
      contentScrollHeight: content.scrollHeight,
      contentClientHeight: content.clientHeight,
      headingOffsetBefore: beforeOffset,
      headingOffsetAfter: afterOffset,
      contentTopBefore: contentRectBefore.top,
      contentTopAfter: contentRectAfter.top,
      headingBottom: headingRectAfter.bottom,
      collapsedOverflow: collapsedStyle.overflow,
      collapsedMaxHeight: collapsedStyle.maxHeight,
    };
  });
  expect(geometry.panelOverflow).toBe('hidden');
  expect(geometry.contentOverflow).toBe('auto');
  expect(geometry.headingPosition).toBe('static');
  expect(geometry.panelScrollTop).toBe(0);
  expect(geometry.contentScrollTop).toBeGreaterThan(0);
  expect(geometry.contentScrollHeight).toBeGreaterThan(geometry.contentClientHeight);
  expect(geometry.panelScrollHeight).toBe(geometry.panelClientHeight);
  expect(Math.abs(geometry.headingOffsetAfter - geometry.headingOffsetBefore)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.contentTopAfter - geometry.contentTopBefore)).toBeLessThanOrEqual(1);
  expect(geometry.contentTopAfter).toBeGreaterThanOrEqual(geometry.headingBottom);
  expect(geometry.collapsedOverflow).toBe('visible');
  expect(geometry.collapsedMaxHeight).toBe('none');
});
