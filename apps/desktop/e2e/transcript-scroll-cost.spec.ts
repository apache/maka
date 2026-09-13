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
 * Generous on purpose: the property worth guarding is that paging through the
 * whole history stops adding Turns, and a range that kept everything it paged
 * in would mount all of them.
 */
const MOUNTED_TURNS_MAX = 40;

/**
 * How far a range boundary is allowed to move the reader, in CSS pixels.
 *
 * A boundary both installs a page and drops the far side of the band, and the
 * two settle within the same quiet frame, so what is measurable is their sum.
 * Not a tolerance for "close enough" motion: anchoring holds that sum to a
 * fraction of a Turn, where a frame that lost the reader lands a Turn away or
 * more.
 */
const BOUNDARY_DISPLACEMENT_MAX_PX = 40;

declare global {
  interface Window {
    __makaTranscriptDisplacement?: {
      boundaries: TranscriptBoundary[];
      isSettled(): boolean;
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
    // Arm in the page's native event dispatch, before the authority's deferred
    // publication. Arming from Playwright after wheel() returns races the same
    // rendering frames that publish the range and can miss every boundary.
    let recording = false;
    const record = (on: boolean): void => {
      if (recording === on) return;
      recording = on;
      previous = read();
      settled = null;
    };
    const onWheel = (event: Event): void => {
      const { deltaY } = event as WheelEvent;
      const remaining = deltaY < 0 ? scroller.scrollTop
        : scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
      // Edge input cannot move the viewport and may never emit scrollend.
      record(remaining <= 0);
    };
    const onScrollEnd = (): void => record(true);
    scroller.addEventListener('wheel', onWheel, { capture: true, passive: true });
    scroller.addEventListener('scrollend', onScrollEnd, { capture: true });
    const state: {
      boundaries: unknown[];
      isSettled(): boolean;
      stop(): void;
    } = {
      boundaries: [],
      isSettled: () => recording && settled === null,
      stop: () => {
        running = false;
        scroller.removeEventListener('wheel', onWheel, true);
        scroller.removeEventListener('scrollend', onScrollEnd, true);
      },
    };
    let running = true;
    let previous = read();
    // The last frame before the range started changing. Held across a run of
    // changing frames so the measurement spans settled state to settled state:
    // scroll anchoring corrects after layout, so a reading taken inside the
    // change would report a correction that never reached the screen.
    let settled: ReturnType<typeof read> | null = null;
    const tick = (): void => {
      if (!running) return;
      const current = read();
      if (!recording) {
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

async function displacement(page: Page): Promise<readonly TranscriptBoundary[]> {
  return page.evaluate(() => {
    const state = window.__makaTranscriptDisplacement;
    if (!state) throw new Error('the transcript displacement probe is missing');
    state.stop();
    return state.boundaries;
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
 * sized for UI already on screen.
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
 * The scenario #5163 was reported from: quit Desktop, start it again, open a
 * long Session, and scroll upward through history without stopping. The reader
 * perceives stalls or jumps around range boundaries.
 *
 * A mounted-range bound alone does not say
 * where the reader ended up while a page was installing, which is the whole of
 * what that report is about. This one measures it: every frame the mounted
 * range changes, whatever Turn the reader can still see must hold its viewport
 * position.
 *
 * Each burst contains consecutive native wheel ticks. Publication boundaries
 * are sampled after scrollend, separately from the reader's own movement.
 *
 * Displacement in pixels rather than frame timings on purpose — see this file's
 * header for what happened to the timing assertions this suite replaced. A
 * stall and a jump have the same cause here (a page boundary that moves
 * content out from under the reader) and only one of them can be asserted
 * without a clock.
 */
test('Host history paging stays bounded, preserves the reader and returns to latest', async ({
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
  let pages = 0;
  let mountedMax = await turns.count();

  for (let iteration = 0; iteration < PROMPT_RAIL_PROMPT_COUNT; iteration += 1) {
    const firstBefore = await turns.first().getAttribute('data-turn-id');
    if (firstBefore === 'turn-prompt-rail-1') break;
    await expect
      .poll(async () => {
        await wheel(page, cdp, { ticks: 12, deltaY: -120 });
        await page.waitForFunction(() => window.__makaTranscriptDisplacement?.isSettled());
        return turns.first().getAttribute('data-turn-id');
      })
      .not.toBe(firstBefore);
    pages += 1;
    mountedMax = Math.max(mountedMax, await turns.count());
    // Let the probe compare the changed range with its next rendered frame
    // before another wheel closes the measurement interval.
    await page.evaluate(() => new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    ));
  }

  expect(pages).toBeGreaterThan(0);
  await expect(turns.first()).toHaveAttribute('data-turn-id', 'turn-prompt-rail-1');
  expect(mountedMax).toBeLessThanOrEqual(MOUNTED_TURNS_MAX);

  const boundaries = await displacement(page);
  // The probe has to have seen the thing it measures: a run that paged nothing,
  // or one where every boundary replaced the range wholesale and carried no
  // Turn across, proves nothing about the reader.
  expect(boundaries.length).toBeGreaterThan(0);
  expect(boundaries.filter((boundary) => boundary.carried > 0).length).toBeGreaterThan(0);

  const displaced = boundaries.filter((boundary) => boundary.worstPx > BOUNDARY_DISPLACEMENT_MAX_PX);
  expect(displaced, `range boundaries moved the reader: ${JSON.stringify(displaced)}`)
    .toEqual([]);

  await returnToLatest(page);
  await expect(page.locator(`[data-turn-id="turn-prompt-rail-${PROMPT_RAIL_PROMPT_COUNT}"]`))
    .toHaveCount(1, { timeout: 30_000 });
  expect(await turns.count()).toBeLessThanOrEqual(MOUNTED_TURNS_MAX);
});
