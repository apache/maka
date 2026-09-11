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
import { expect, test } from './fixtures';

const SCROLLER = '[data-chat-scroll-container="true"]';
const TURN = '.maka-transcript-turn';

/**
 * The mounted range is now a band of pixels, not a Host constant: useChatScroll
 * keeps the Turns within four screens of the reader and drops what sits beyond
 * six, so what bounds this count is the viewport these tests set (700px) and
 * how tall a fixture Turn is — no number the Main tail cache owns.
 *
 * Generous on purpose. The property worth guarding is that paging through 120
 * Turns stops adding Turns; a range that kept everything it paged in would
 * mount all 120, and a band that quietly doubled would pass no threshold that
 * left this much room.
 */
const MOUNTED_TURNS_MAX = 40;

/**
 * How far a range boundary is allowed to move the reader, in CSS pixels.
 *
 * A boundary both installs a page and drops the far side of the band, and the
 * two settle within the same quiet frame, so what is measurable is their sum.
 * Not a tolerance for "close enough" motion: anchoring holds that sum to a
 * fraction of a Turn — 18px here, unchanged by this work — where a frame that
 * lost the reader lands a Turn away or more.
 */
const BOUNDARY_DISPLACEMENT_MAX_PX = 40;

declare global {
  interface Window {
    __makaTranscriptCost?: {
      transitionRuns: number;
      animationStarts: number;
      skipped: WeakSet<Element>;
      skippedCount: number;
    };
    __makaTranscriptDisplacement?: {
      boundaries: TranscriptBoundary[];
      peakMounted: number;
      stop(): void;
    };
  }
}

/**
 * One frame where the mounted range changed: a page installed, or the band
 * trimmed, or both.
 */
interface TranscriptBoundary {
  readonly firstBefore: string;
  readonly firstAfter: string;
  readonly mountedBefore: number;
  readonly mountedAfter: number;
  readonly grewPx: number;
  readonly scrolledPx: number;
  /** Turns present in both frames, so a reader position can be compared. */
  readonly carried: number;
  readonly worstTurnId: string | null;
  readonly worstPx: number;
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

/**
 * Watch every frame for a change in the mounted range, and measure what that
 * change did to the reader.
 *
 * What must not move is where a Turn sits ON SCREEN, so the measurement is its
 * viewport `top` and nothing else. Its position in the DOCUMENT is expected to
 * move — installing a page above the reader is exactly what shifts it — and
 * scroll anchoring answers that by adding the same amount to `scrollTop`, which
 * is why the reader sees nothing. Measuring the document position instead would
 * report every correctly absorbed page as a displacement the size of the page.
 *
 * Sampled per frame rather than per gesture: the frame that installs a page is
 * the only one where the reader can be lost, and a per-gesture reading would
 * subtract the reader's own scrolling back out and see nothing.
 */
async function observeDisplacement(page: Page): Promise<void> {
  await page.evaluate((scrollerSelector) => {
    const scroller = document.querySelector(scrollerSelector);
    if (!scroller) throw new Error('the chat scroll container is missing');
    const read = () => {
      const tops = new Map<string, number>();
      for (const turn of document.querySelectorAll<HTMLElement>('[data-turn-id]')) {
        const turnId = turn.dataset.turnId;
        if (turnId) tops.set(turnId, turn.getBoundingClientRect().top);
      }
      return {
        scrollTop: scroller.scrollTop,
        scrollHeight: scroller.scrollHeight,
        tops,
        key: [...tops.keys()].join(','),
      };
    };
    const state: { boundaries: unknown[]; peakMounted: number; stop(): void } = {
      boundaries: [],
      peakMounted: 0,
      stop: () => { running = false; },
    };
    let running = true;
    // Only frames the reader is not currently scrolling through can be
    // compared: a wheel tick moves every Turn on screen by its own delta, which
    // is indistinguishable from a page that moved them. The reader's hand stops
    // between gestures, and a page that lands then is exactly the one they see
    // jump.
    let lastWheelAt = -Infinity;
    const QUIET_MS = 250;
    document.addEventListener('wheel', () => { lastWheelAt = performance.now(); }, true);
    let previous = read();
    // The last frame before the range started changing. Held across a run of
    // changing frames so the measurement spans settled state to settled state:
    // scroll anchoring corrects after layout, so a reading taken inside the
    // change would report a correction that never reached the screen.
    let settled: ReturnType<typeof read> | null = null;
    let peakMounted = 0;
    const tick = (): void => {
      if (!running) return;
      const current = read();
      peakMounted = Math.max(peakMounted, current.tops.size);
      state.peakMounted = peakMounted;
      if (performance.now() - lastWheelAt < QUIET_MS) {
        settled = null;
        previous = current;
        requestAnimationFrame(tick);
        return;
      }
      if (current.key !== previous.key) {
        if (!settled) settled = previous;
      } else if (settled) {
        const before = settled;
        settled = null;
        const scrolled = current.scrollTop - before.scrollTop;
        let carried = 0;
        let worstPx = 0;
        let worstTurnId: string | null = null;
        for (const [turnId, top] of current.tops) {
          const wasAt = before.tops.get(turnId);
          if (wasAt === undefined) continue;
          carried += 1;
          const displaced = Math.abs(top - wasAt);
          if (displaced > worstPx) {
            worstPx = displaced;
            worstTurnId = turnId;
          }
        }
        state.boundaries.push({
          firstBefore: before.key.split(',')[0] ?? '',
          firstAfter: current.key.split(',')[0] ?? '',
          mountedBefore: before.tops.size,
          mountedAfter: current.tops.size,
          grewPx: current.scrollHeight - before.scrollHeight,
          scrolledPx: scrolled,
          carried,
          worstTurnId,
          worstPx,
        });
      }
      previous = current;
      requestAnimationFrame(tick);
    };
    window.__makaTranscriptDisplacement = state as never;
    requestAnimationFrame(tick);
  }, SCROLLER);
}

async function displacement(page: Page): Promise<{
  boundaries: readonly TranscriptBoundary[];
  peakMounted: number;
}> {
  return page.evaluate(() => {
    const state = window.__makaTranscriptDisplacement;
    if (!state) throw new Error('the transcript displacement probe is missing');
    state.stop();
    return { boundaries: state.boundaries, peakMounted: state.peakMounted };
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

/**
 * A transcript opened at its tail keeps fetching older history until two
 * screens of it sit above the reader, and trims what falls outside the band it
 * retains, so the mounted rows churn for as long as that runs. Wait for the
 * window to stop moving before touching a row: a locator resolved mid-churn
 * points at an element the Renderer has already unmounted.
 *
 * Timed out against that ramp rather than the suite's 10s default, which is
 * sized for UI already on screen: how many pages the ramp reads is how tall the
 * viewport happens to be against the fixture, and a loaded CI runner measured
 * past it where this machine finishes in under two seconds.
 */
async function settled(page: Page): Promise<void> {
  const mounted = async (): Promise<string> => page.evaluate(() => {
    const turns = document.querySelectorAll('[data-turn-id]');
    return `${turns.length}:${turns[0]?.getAttribute('data-turn-id')}`;
  });
  let previous = await mounted();
  await expect
    .poll(async () => {
      await page.waitForTimeout(250);
      const current = await mounted();
      const stable = current === previous;
      previous = current;
      return stable;
    }, { timeout: 30_000 })
    .toBe(true);
}

async function moveToTail(page: Page): Promise<void> {
  await settled(page);
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
  await returnLatest.click();
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
 * far longer than the retained band mounts a bounded number of Turns, not a
 * growing one. Sampled at every page rather than only at the end, because the
 * regression is a range that grows while the reader travels and is only trimmed
 * once they stop.
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
    // gesture that pages is the gesture a reader makes. How many gestures it
    // takes is how tall the resident range happens to be, which is not what
    // this test is about — keep scrolling until the range moves.
    await expect
      .poll(async () => {
        await wheel(page, cdp, { ticks: 12, deltaY: -120 });
        return turns.first().getAttribute('data-turn-id');
      })
      .not.toBe(firstBefore);
    pages += 1;
    mountedMax = Math.max(mountedMax, await turns.count());
  }

  expect(pages).toBeGreaterThan(0);
  await expect(turns.first()).toHaveAttribute('data-turn-id', 'turn-prompt-rail-1');
  expect(mountedMax).toBeLessThanOrEqual(MOUNTED_TURNS_MAX);

  // Coming back from the far end reads the tail page and rebuilds the window
  // around it, so it is slower than the scrolling above. The suite's 10s expect
  // timeout is sized for UI that is already on screen, and this step measured
  // past it on a loaded CI runner.
  await returnToLatest(page);
  await expect(page.locator(`[data-turn-id="turn-prompt-rail-${PROMPT_RAIL_PROMPT_COUNT}"]`))
    .toHaveCount(1, { timeout: 30_000 });
  expect(await turns.count()).toBeLessThanOrEqual(MOUNTED_TURNS_MAX);
});

/**
 * The scenario #5163 was reported from: quit Desktop, start it again, open a
 * long Session, and scroll upward through history without stopping. The reader
 * perceives stalls or jumps around range boundaries.
 *
 * The tests above establish that paging works and stays bounded. Neither says
 * where the reader ended up while a page was installing, which is the whole of
 * what that report is about. This one measures it: every frame the mounted
 * range changes, whatever Turn the reader can still see must hold its document
 * position.
 *
 * Displacement in pixels rather than frame timings on purpose — see this file's
 * header for what happened to the timing assertions this suite replaced. A
 * stall and a jump have the same cause here (a page boundary that moves
 * content out from under the reader) and only one of them can be asserted
 * without a clock.
 */
test('paging back never moves the reader at a range boundary', async ({
  promptRailWindow: page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1_000, height: 700 });
  await expect(page.locator(`[data-turn-id="turn-prompt-rail-${PROMPT_RAIL_PROMPT_COUNT}"]`))
    .toHaveCount(1);
  const cdp = await page.context().newCDPSession(page);
  const turns = page.locator('[data-turn-id]');
  await moveToTail(page);
  await observeDisplacement(page);

  for (let iteration = 0; iteration < PROMPT_RAIL_PROMPT_COUNT; iteration += 1) {
    const firstBefore = await turns.first().getAttribute('data-turn-id');
    if (firstBefore === 'turn-prompt-rail-1') break;
    await expect
      .poll(async () => {
        await wheel(page, cdp, { ticks: 12, deltaY: -120 });
        // Let the hand come off the wheel. A page requested by this gesture
        // lands here, in the quiet the probe measures across — which is also
        // when a reader would see it move.
        await page.waitForTimeout(150);
        return turns.first().getAttribute('data-turn-id');
      })
      .not.toBe(firstBefore);
  }

  const { boundaries, peakMounted } = await displacement(page);
  // The probe has to have seen the thing it measures: a run that paged nothing,
  // or one where every boundary replaced the range wholesale and carried no
  // Turn across, proves nothing about the reader.
  expect(boundaries.length).toBeGreaterThan(0);
  expect(boundaries.filter((boundary) => boundary.carried > 0).length).toBeGreaterThan(0);

  const displaced = boundaries.filter((boundary) => boundary.worstPx > BOUNDARY_DISPLACEMENT_MAX_PX);
  expect(displaced, `range boundaries moved the reader: ${JSON.stringify(displaced)}`)
    .toEqual([]);
  // What the window holds is bounded in pixels, and the tests above already
  // hold it to that. Reported here only so a boundary that moved the reader can
  // be read against how much the range was carrying when it did.
  expect(peakMounted).toBeGreaterThan(0);
});
