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

/**
 * What one scroll through the transcript COSTS, asserted as counts.
 *
 * The suite this replaces asserted wall-clock frame timings, and a timing
 * assertion on a shared runner either flakes or gets switched off — that one
 * was switched off behind an env var nothing ever set, so it never ran at all
 * and every regression it existed to catch shipped. These assertions are
 * structural: a number that does not move between runs on the same code, and
 * does move when the thing it guards regresses. They run in ordinary CI.
 *
 * Gestures are RELATIVE input — a real wheel through CDP, which is also what
 * the product's own history paging listens for. The replaced suite drove
 * scrolling by writing absolute `scrollTop` values per frame, which erases the
 * scroll-anchoring correction the browser applied since the previous frame, so
 * the probe fought the scroller and produced displacement that looked like a
 * product bug.
 */

import type { CDPSession, Page } from '@playwright/test';
import { PROMPT_RAIL_PROMPT_COUNT } from '../src/main/e2e-fixture/seed-helpers';
import { DESKTOP_TRANSCRIPT_ACTIVE_RANGE_MAX_TURNS } from '../src/preload/transcript-contract';
import { expect, test } from './fixtures';

const SCROLLER = '[data-chat-scroll-container="true"]';
const TURN = '.maka-transcript-turn';

declare global {
  interface Window {
    __makaTranscriptCost?: {
      transitionRuns: number;
      animationStarts: number;
      skipped: WeakSet<Element>;
      skippedCount: number;
    };
  }
}

/**
 * Real wheel input at the centre of the scroller. Relative by construction: a
 * wheel tick asks the compositor to move by a delta from wherever the scroller
 * currently is, so an anchoring correction between ticks survives instead of
 * being overwritten.
 */
async function wheel(
  page: Page,
  cdp: CDPSession,
  options: { ticks: number; deltaY: number },
): Promise<void> {
  const box = await page.locator(SCROLLER).boundingBox();
  if (!box) throw new Error('the chat scroll container has no box');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  for (let tick = 0; tick < options.ticks; tick += 1) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x,
      y,
      deltaX: 0,
      deltaY: options.deltaY,
    });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  }
  await page.evaluate(() => new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  ));
}

/**
 * Count every transition and animation the page starts, and track which Turns
 * the browser is currently skipping.
 *
 * `contentvisibilityautostatechange` rather than
 * `checkVisibility({ contentVisibilityAuto: true })`: the flag that method
 * reads is updated during rendering, so a synchronous call right after a
 * scroll reports every Turn visible even when the browser is skipping most of
 * them. Measured on this fixture, the method returned 0 skipped Turns in every
 * position the event reported between 1 and 8.
 */
async function observe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = {
      transitionRuns: 0,
      animationStarts: 0,
      skipped: new WeakSet<Element>(),
      skippedCount: 0,
    };
    window.__makaTranscriptCost = state;
    document.addEventListener('transitionrun', () => { state.transitionRuns += 1; }, true);
    document.addEventListener('animationstart', () => { state.animationStarts += 1; }, true);
    const bound = new WeakSet<Element>();
    const bind = (): void => {
      for (const turn of document.querySelectorAll('.maka-transcript-turn')) {
        if (bound.has(turn)) continue;
        bound.add(turn);
        turn.addEventListener('contentvisibilityautostatechange', (event) => {
          const skipped = (event as Event & { skipped: boolean }).skipped;
          if (skipped === state.skipped.has(turn)) return;
          if (skipped) state.skipped.add(turn);
          else state.skipped.delete(turn);
          state.skippedCount += skipped ? 1 : -1;
        });
      }
    };
    bind();
    new MutationObserver(bind).observe(document.body, { childList: true, subtree: true });
  });
}

interface CostSample {
  transitionRuns: number;
  animationStarts: number;
  unfinished: number;
  skippedTurns: number;
  mountedTurns: number;
}

async function sample(page: Page): Promise<CostSample> {
  return page.evaluate(() => {
    const state = window.__makaTranscriptCost;
    if (!state) throw new Error('the transcript cost observer is missing');
    return {
      transitionRuns: state.transitionRuns,
      animationStarts: state.animationStarts,
      unfinished: document.body
        .getAnimations({ subtree: true })
        .filter((animation) => animation.playState !== 'finished').length,
      skippedTurns: state.skippedCount,
      mountedTurns: document.querySelectorAll('[data-turn-id]').length,
    };
  });
}

async function moveToTail(page: Page): Promise<void> {
  await page.locator(TURN).last().scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  ));
}

/**
 * The affordance a reader who has paged away uses to come back. Waited for
 * rather than probed: `isVisible()` answers about this instant, so a probe on
 * a loaded runner falls through to whatever the else branch was before the
 * button has rendered — which is how the suite this replaces carried an
 * untested fallback through a prompt-rail tick that no run ever reached.
 */
async function returnToLatest(page: Page): Promise<void> {
  const returnLatest = page.getByRole('button', {
    name: /^(?:滚动主对话到底部|Scroll main conversation to bottom)$/,
  });
  await expect(returnLatest).toBeVisible();
  // Range loading now reuses the existing transcript dock action. Its fixed
  // layer's pointer hit testing is covered separately from this range-cost
  // test, so invoke the action without introducing that unrelated dependency.
  await returnLatest.evaluate((button: HTMLButtonElement) => button.click());
}

/**
 * The fixture's own motion contract, asserted as the count it is.
 *
 * `[data-maka-e2e-fixture]` collapses motion so a fixture render does not
 * depend on the millisecond it settles. It used to do that with
 * `transition-duration: 0.01ms`, which is not "no transition": the initial
 * `transition-property` is `all`, so every element kept a live transition on
 * every animatable property and fired transitionrun/start/end on every style
 * recalculation — measured here, ~1,200 transitions for one sweep over ten
 * mounted Turns, and tens of thousands over a long one. Every timing number
 * the replaced suite reported was mostly that.
 *
 * Nothing downstream can measure the product while the harness generates work
 * of its own, so the harness asserts zero.
 */
test('a scroll through the fixture transcript starts no transitions', async ({
  promptRailWindow: page,
}) => {
  await page.setViewportSize({ width: 1_000, height: 700 });
  await expect(page.locator(`[data-turn-id="turn-prompt-rail-${PROMPT_RAIL_PROMPT_COUNT}"]`))
    .toHaveCount(1);
  const cdp = await page.context().newCDPSession(page);
  await observe(page);
  await moveToTail(page);
  await wheel(page, cdp, { ticks: 40, deltaY: -120 });
  await wheel(page, cdp, { ticks: 40, deltaY: 120 });

  const cost = await sample(page);
  expect(cost.transitionRuns).toBe(0);
  expect(cost.animationStarts).toBe(0);
  // The reason the declaration exists: a fixture render is a settled state,
  // never an entry frame. `none` serves that strictly better than a near-zero
  // duration did — that one left transitions still running at sample time.
  expect(cost.unfinished).toBe(0);
});

/**
 * Containment is engaging at all. A `content-visibility: auto` that stops
 * skipping — a Turn that gains a property forcing layout, a container query,
 * an ancestor that breaks the containment chain — costs nothing that a timing
 * threshold would notice on a ten-Turn range, and everything on a long one.
 */
test('the browser skips the Turns the reader has scrolled past', async ({
  promptRailWindow: page,
}) => {
  await page.setViewportSize({ width: 1_000, height: 700 });
  await expect(page.locator(`[data-turn-id="turn-prompt-rail-${PROMPT_RAIL_PROMPT_COUNT}"]`))
    .toHaveCount(1);
  const cdp = await page.context().newCDPSession(page);
  await observe(page);
  await moveToTail(page);
  // Two viewports up and back: enough for the Turns at the far end of the
  // mounted range to leave the browser's relevance margin in both directions.
  await wheel(page, cdp, { ticks: 20, deltaY: -120 });
  await wheel(page, cdp, { ticks: 20, deltaY: 120 });

  expect((await sample(page)).skippedTurns).toBeGreaterThan(0);
});

/**
 * The bound the Desktop transcript is built on: paging back through a history
 * far longer than the active range mounts a bounded number of Turns, not a
 * growing one. Sampled at every page rather than only at the end, because a
 * range that overshoots and is trimmed afterwards is the regression.
 */
test('paging back through the whole history keeps the mounted range bounded', async ({
  promptRailWindow: page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1_000, height: 700 });
  await expect(page.locator(`[data-turn-id="turn-prompt-rail-${PROMPT_RAIL_PROMPT_COUNT}"]`))
    .toHaveCount(1);
  const cdp = await page.context().newCDPSession(page);
  const turns = page.locator('[data-turn-id]');
  let mountedMax = 0;
  let pages = 0;

  for (let iteration = 0; iteration < PROMPT_RAIL_PROMPT_COUNT; iteration += 1) {
    const firstBefore = await turns.first().getAttribute('data-turn-id');
    if (firstBefore === 'turn-prompt-rail-1') break;
    // The product asks for history on an upward wheel near the start, so the
    // gesture that pages is the gesture a reader makes.
    await wheel(page, cdp, { ticks: 12, deltaY: -120 });
    await expect
      .poll(async () => turns.first().getAttribute('data-turn-id'))
      .not.toBe(firstBefore);
    pages += 1;
    mountedMax = Math.max(mountedMax, await turns.count());
  }

  expect(pages).toBeGreaterThan(0);
  await expect(turns.first()).toHaveAttribute('data-turn-id', 'turn-prompt-rail-1');
  expect(mountedMax).toBeLessThanOrEqual(DESKTOP_TRANSCRIPT_ACTIVE_RANGE_MAX_TURNS);

  // Coming back from the far end is a range reload, not a scroll: the Host
  // resolves a new window around the tail and the renderer mounts it. The
  // suite's 10s expect timeout is sized for UI that is already on screen, and
  // this step measured past it on a CI runner with four workers competing.
  await returnToLatest(page);
  await expect(page.locator(`[data-turn-id="turn-prompt-rail-${PROMPT_RAIL_PROMPT_COUNT}"]`))
    .toHaveCount(1, { timeout: 30_000 });
  expect(await turns.count()).toBeLessThanOrEqual(DESKTOP_TRANSCRIPT_ACTIVE_RANGE_MAX_TURNS);
});
