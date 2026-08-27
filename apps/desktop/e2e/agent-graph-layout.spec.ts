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

test('Agent Graph keeps its heading fixed while the content scrolls', async ({ window: page }) => {
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
    const headingStyle = getComputedStyle(heading);
    const panelMaxHeight = panelStyle.maxHeight;
    const panelRectBefore = panel.getBoundingClientRect();
    const headingRectBefore = heading.getBoundingClientRect();
    panel.scrollTop = panel.scrollHeight;
    const panelRectAfter = panel.getBoundingClientRect();
    const headingRectAfter = heading.getBoundingClientRect();
    const beforeOffset = headingRectBefore.top - panelRectBefore.top;
    const afterOffset = headingRectAfter.top - panelRectAfter.top;
    panel.dataset.collapsed = 'true';
    const collapsedStyle = getComputedStyle(panel);

    return {
      panelOverflow,
      panelMaxHeight,
      headingPosition: headingStyle.position,
      headingZIndex: headingStyle.zIndex,
      headingBackground: headingStyle.backgroundColor,
      headingBoxShadow: headingStyle.boxShadow,
      panelScrollHeight: panel.scrollHeight,
      panelClientHeight: panel.clientHeight,
      headingOffsetBefore: beforeOffset,
      headingOffsetAfter: afterOffset,
      collapsedOverflow: collapsedStyle.overflow,
      collapsedMaxHeight: collapsedStyle.maxHeight,
    };
  });
  expect(geometry.panelOverflow).toBe('auto');
  expect(geometry.headingPosition).toBe('sticky');
  expect(geometry.headingZIndex).toBe('20');
  expect(geometry.headingBackground).not.toBe('rgba(0, 0, 0, 0)');
  expect(geometry.headingBoxShadow).not.toBe('none');
  expect(geometry.panelScrollHeight).toBeGreaterThan(geometry.panelClientHeight);
  expect(Math.abs(geometry.headingOffsetAfter - geometry.headingOffsetBefore)).toBeLessThanOrEqual(1);
  expect(geometry.collapsedOverflow).toBe('visible');
  expect(geometry.collapsedMaxHeight).toBe('none');
});
