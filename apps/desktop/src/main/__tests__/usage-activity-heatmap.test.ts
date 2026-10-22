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

import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import { parseHTML } from 'linkedom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { AstryxLocaleProvider, LocaleProvider } from '@maka/ui';
import {
  UsageActivityHeatmap,
  buildUsageActivityWeeks,
  mondayIndex,
  usageActivityFocusIndex,
  usageActivityLevel,
  usageActivityThresholds,
  type UsageActivityDay,
} from '../../renderer/features/usage/testing.js';

function daysFrom(start: Date, count: number): UsageActivityDay[] {
  const current = new Date(start);
  return Array.from({ length: count }, (_, index) => {
    const day = { start: current.getTime(), tokens: (index + 1) * 100, successfulRequests: index + 1 };
    current.setDate(current.getDate() + 1);
    return day;
  });
}

describe('Usage activity calendar', () => {
  it('keeps every daily cell in partial columns across a year boundary', () => {
    const days = daysFrom(new Date(2025, 11, 31), 10);
    const weeks = buildUsageActivityWeeks(days);
    assert.equal(weeks.length, 2);
    assert.deepEqual(weeks.map((week) => week.days.length), [5, 5]);
    assert.equal(mondayIndex(weeks[0]!.start), 2);
    assert.equal(mondayIndex(weeks[1]!.start), 0);
    assert.equal(weeks[0]!.start, days[0]!.start);
    assert.deepEqual(weeks.flatMap((week) => week.days), days);
  });

  it('keeps February 29 and can render 54 columns for a leap-year window', () => {
    const days = daysFrom(new Date(2023, 2, 5), 366);
    const weeks = buildUsageActivityWeeks(days);
    assert.equal(weeks.length, 54);
    assert.equal(weeks[0]!.days.length, 1);
    assert.equal(weeks.at(-1)!.days.length, 1);
    const leapDays = daysFrom(new Date(2024, 1, 26), 7);
    assert.equal(new Date(leapDays[3]!.start).getDate(), 29);
    assert.equal(buildUsageActivityWeeks(leapDays).length, 1);
  });

  it('uses local Monday boundaries through daylight-saving transitions', () => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      for (const start of [new Date(2026, 2, 2), new Date(2026, 9, 26)]) {
        const days = daysFrom(start, 14);
        assert.notEqual(days[7]!.start - days[0]!.start, 7 * 24 * 60 * 60 * 1000);
        const weeks = buildUsageActivityWeeks(days);
        assert.deepEqual(weeks.map((week) => week.days.length), [7, 7]);
        assert.equal(mondayIndex(weeks[1]!.start), 0);
        assert.deepEqual(weeks.flatMap((week) => week.days), days);
      }
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
    }
  });

  it('keeps zero days distinct and avoids flattening normal days behind an outlier', () => {
    const days = [0, 10, 20, 30, 1_000_000_000].map((tokens, index) => ({
      start: new Date(2026, 0, index + 1).getTime(), tokens, successfulRequests: tokens > 0 ? 1 : 0,
    }));
    const thresholds = usageActivityThresholds(days);
    assert.deepEqual(days.map((day) => usageActivityLevel(day.tokens, thresholds)), [0, 1, 2, 3, 4]);
    assert.deepEqual(usageActivityThresholds(days.map((day) => ({ ...day, successfulRequests: 10_000 }))), thresholds);
    assert.deepEqual(usageActivityThresholds([]), []);
    assert.equal(usageActivityLevel(0, []), 0);
  });

  it('moves focus in calendar directions and keeps keyboard navigation inside the year', () => {
    assert.equal(usageActivityFocusIndex('ArrowLeft', 20, 365), 13);
    assert.equal(usageActivityFocusIndex('ArrowRight', 20, 365), 27);
    assert.equal(usageActivityFocusIndex('ArrowUp', 20, 365), 19);
    assert.equal(usageActivityFocusIndex('ArrowDown', 20, 365), 21);
    assert.equal(usageActivityFocusIndex('ArrowLeft', 1, 365), 0);
    assert.equal(usageActivityFocusIndex('ArrowRight', 364, 365), 364);
    assert.equal(usageActivityFocusIndex('Home', 20, 365), 0);
    assert.equal(usageActivityFocusIndex('End', 20, 365), 364);
    assert.equal(usageActivityFocusIndex('Tab', 20, 365), null);
  });
});

const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  matchMedia: globalThis.matchMedia,
  HTMLElement: globalThis.HTMLElement,
  getComputedStyle: globalThis.getComputedStyle,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
  CSS: (globalThis as { CSS?: unknown }).CSS,
  IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT,
};
afterEach(() => Object.assign(globalThis, originalGlobals));

/** Install a linkedom DOM + the browser globals React DOM needs, return the root. */
function setupDom() {
  const { document, window } = parseHTML('<html><body><div id="root"></div></body></html>');
  const matchMedia = (media: string) => ({
    matches: false,
    media,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  });
  const getComputedStyle = () => ({
    color: 'currentColor', direction: 'ltr', writingMode: 'horizontal-tb', getPropertyValue: () => '',
  }) as unknown as CSSStyleDeclaration;
  Object.assign(window, { matchMedia, getComputedStyle, scrollTo: () => {} });
  Object.assign(globalThis, {
    document,
    window,
    matchMedia,
    HTMLElement: window.HTMLElement,
    getComputedStyle,
    requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(cb, 0),
    cancelAnimationFrame: (handle: number) => clearTimeout(handle),
    CSS: { supports: () => false, escape: (v: string) => v },
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.querySelector<HTMLElement>('#root');
  assert.ok(container);
  return { container, root: createRoot(container) };
}


function activityTree(heatmap: import('@maka/core/settings').UsageHeatmap | null) {
  return createElement(LocaleProvider, {
    locale: 'en',
    children: createElement(AstryxLocaleProvider, {
      children: createElement(UsageActivityHeatmap, { state: heatmap ? {status: 'ready', value: heatmap} : {status: 'loading'} }),
    }),
  });
}

describe('Usage activity view', () => {
  it('shows daily Token intensity without interval controls and keeps requests in details', async () => {
    const { container, root } = setupDom();
    const days = daysFrom(new Date(2026, 0, 1), 365);
    days[0]!.tokens = 0;
    days[0]!.successfulRequests = 9;
    const heatmap = { days, through: days.at(-1)!.start + 1234, hasIncompleteUsage: false };
    const points = () => [...container.querySelectorAll<HTMLElement>('[data-activity-index]')];
    try {
      await act(async () => root.render(activityTree(heatmap)));
      assert.equal(container.querySelectorAll('[role="radiogroup"]').length, 0);
      assert.equal(points().length, 365);
      assert.equal(points().filter((point) => point.getAttribute('tabindex') === '0').length, 1);
      assert.equal(points()[0]!.getAttribute('data-level'), '0');
      assert.match(points()[0]!.getAttribute('aria-label')!, /Tokens: 0; Requests: 9/);
      const dailyLevels = points().map((point) => point.getAttribute('data-level'));
      const changedRequests = { ...heatmap, days: days.map((day) => ({ ...day, successfulRequests: day.successfulRequests * 1_000 })) };
      await act(async () => root.render(activityTree(changedRequests)));
      assert.deepEqual(points().map((point) => point.getAttribute('data-level')), dailyLevels);
      assert.match(points()[0]!.getAttribute('aria-label')!, /Tokens: 0; Requests: 9,000/);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it('keeps one chart tab stop and opens precise details when exploring with the keyboard', async () => {
    const { container, root } = setupDom();
    const days = daysFrom(new Date(2026, 9, 1), 13);
    const heatmap = { days, through: days.at(-1)!.start, hasIncompleteUsage: false };
    try {
      await act(async () => root.render(activityTree(heatmap)));
      const point = (index: number) => container.querySelector<HTMLElement>(`[data-activity-index="${index}"]`)!;
      const target = point(5);
      let focused = false;
      // linkedom has no browser focus engine; dispatch the real focus event from
      // its focus seam and let React + Astryx install the selected cell/tooltip.
      target.focus = () => {
        focused = true;
        target.dispatchEvent(new window.Event('focusin', { bubbles: true }));
      };
      const originalMatches = target.matches.bind(target);
      target.matches = ((selector: string) => selector === ':focus-visible' || originalMatches(selector)) as typeof target.matches;
      const arrow = new window.Event('keydown', { bubbles: true, cancelable: true });
      Object.defineProperty(arrow, 'key', { value: 'ArrowLeft' });
      await act(async () => point(12).dispatchEvent(arrow));
      assert.ok(focused);
      assert.equal(target.getAttribute('tabindex'), '0');
      assert.equal(container.querySelectorAll('[data-activity-index][tabindex="0"]').length, 1);
      const tooltip = document.getElementById(target.getAttribute('aria-describedby')!);
      assert.ok(tooltip);
      assert.match(tooltip.textContent!, /Tokens600/);
      assert.match(tooltip.textContent!, /Requests6/);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it('distinguishes pending data, actual zero days, and incomplete records', async () => {
    const { container, root } = setupDom();
    try {
      await act(async () => root.render(activityTree(null)));
      assert.ok(container.querySelector('[role="status"][aria-label="Loading usage activity"]'));
      assert.equal(container.querySelectorAll('[data-activity-index]').length, 0);
      const days = daysFrom(new Date(2026, 9, 1), 13).map((day) => ({ ...day, tokens: 0, successfulRequests: 0 }));
      await act(async () => root.render(activityTree({ days, through: days.at(-1)!.start, hasIncompleteUsage: true })));
      assert.equal(container.querySelectorAll('[data-activity-index][data-level="0"]').length, 13);
      assert.match(container.textContent!, /Some records have incomplete usage/);
      assert.equal(container.querySelector('[role="status"][aria-label="Loading usage activity"]'), null);
    } finally {
      await act(async () => root.unmount());
    }
  });
});
