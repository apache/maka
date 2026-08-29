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

import { expect, test, COMPOSER_INPUT } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * Where the transcript is looking, in a real Chromium with a real scroller.
 *
 * Two rounds of this work shipped green and wrong, both times because the
 * instrument could not see the property being claimed: a CLS measurement is
 * blind to scroll position, and a linkedom harness decides the effect ordering
 * its own assertions then confirm. Nothing below reads a ref or a flag — each
 * test states where an element or the viewport ended up, and the app has to put
 * it there.
 *
 * Positions are asserted against an element or against the scroller's own end,
 * never as a pixel delta: a delta is satisfiable by two wrongs (the content
 * grew by as much as the view moved), which is the bug class that produced the
 * `scrollHeight`-difference compensation this replaces.
 */

const SCROLLER = '[data-chat-scroll-container="true"]';
const REGENERATE = /^重新生成回答/;
/** Astryx's dock affordance, relabelled by `ChatSurfaceLayout`. */
const SCROLL_TO_BOTTOM = /^滚动主对话到底部$/;

/** Sixty lines: more than one viewport once the fake backend echoes it back. */
const LONG_PROMPT = Array.from(
  { length: 60 },
  (_, index) => `第 ${index} 行：这一段用来把转录推过滚动视口的高度。`,
).join('\n');

function distanceToTail(page: Page): Promise<number> {
  return page.evaluate((selector) => {
    const root = document.querySelector(selector);
    if (!root) throw new Error('the chat scroll container is missing');
    return Math.round(root.scrollHeight - root.scrollTop - root.clientHeight);
  }, SCROLLER);
}

/**
 * Whether the dock affordance is actually offered. It is always in the DOM —
 * Astryx toggles opacity and pointer-events — so presence proves nothing and
 * `toBeVisible` passes on the transparent one.
 */
function scrollButtonOffered(page: Page): Promise<boolean> {
  return page.evaluate((name) => {
    const button = [...document.querySelectorAll('button')].find(
      (candidate) => candidate.getAttribute('aria-label') === name
        || candidate.textContent?.trim() === name,
    );
    if (!button) throw new Error(`the "${name}" affordance is missing`);
    const style = getComputedStyle(button);
    return style.pointerEvents !== 'none' && Number(style.opacity) > 0.5;
  }, '滚动主对话到底部');
}

function turnTop(page: Page, turnId: string): Promise<number> {
  return page.evaluate((id) => {
    const turn = document.querySelector(`[data-turn-id="${CSS.escape(id)}"]`);
    if (!turn) throw new Error(`turn ${id} is not mounted`);
    return Math.round(turn.getBoundingClientRect().top);
  }, turnId);
}

/**
 * Sample the tail through the frames a growing transcript produces.
 *
 * Read at the start of each frame, which is one frame behind the pin: the
 * content commits, the next frame's layout delivers the resize, and the write
 * lands before that frame paints. So the view can only ever be behind by what
 * arrived since the last delivery — never more, and never cumulatively. That is
 * what `worstLag` against `worstFrameGrowth` states, and it is a property no
 * fixed pixel budget can express: a transcript that stopped following instead
 * falls behind by the whole of `grewBy`.
 */
function measureTailLag(page: Page, frames: number): Promise<{
  worstLag: number;
  worstFrameGrowth: number;
  grewBy: number;
  viewportHeight: number;
}> {
  return page.evaluate(([selector, frameCount]) => new Promise<{
    worstLag: number;
    worstFrameGrowth: number;
    grewBy: number;
    viewportHeight: number;
  }>((resolve) => {
    const root = document.querySelector(selector as string);
    if (!root) throw new Error('the chat scroll container is missing');
    const startedAt = root.scrollHeight;
    let previousScrollHeight = startedAt;
    let worstLag = 0;
    let worstFrameGrowth = 0;
    let left = frameCount as number;
    const tick = (): void => {
      const settledTail = previousScrollHeight - root.clientHeight;
      worstLag = Math.max(worstLag, Math.abs(root.scrollTop - settledTail));
      worstFrameGrowth = Math.max(worstFrameGrowth, root.scrollHeight - previousScrollHeight);
      previousScrollHeight = root.scrollHeight;
      // Stops on the content, not on a frame count: when the answer starts
      // arriving is the backend's business, and a fixed window can expire
      // before it does.
      const enough = root.scrollHeight - startedAt > root.clientHeight;
      if (enough || --left <= 0) {
        resolve({
          worstLag: Math.round(worstLag),
          worstFrameGrowth: Math.round(worstFrameGrowth),
          grewBy: Math.round(root.scrollHeight - startedAt),
          viewportHeight: root.clientHeight,
        });
      } else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }), [SCROLLER, frames] as const);
}

async function sendPrompt(page: Page, text: string): Promise<void> {
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill(text);
  await composer.press('Enter');
}

/** Answered turns, so a second send can be waited for without a stale match. */
function answeredTurns(page: Page) {
  return page.getByRole('button', { name: REGENERATE });
}

async function scrollTranscriptTo(page: Page, top: number): Promise<void> {
  await page.evaluate(([selector, position]) => {
    const root = document.querySelector(selector as string);
    if (!root) throw new Error('the chat scroll container is missing');
    root.scrollTop = position as number;
  }, [SCROLLER, top] as const);
  await waitForPaintedFrames(page);
}

async function waitForPaintedFrames(page: Page, count = 3): Promise<void> {
  await page.evaluate((frames) => new Promise<void>((resolve) => {
    const tick = (left: number) => {
      if (left <= 0) {
        resolve();
        return;
      }
      requestAnimationFrame(() => tick(left - 1));
    };
    tick(frames);
  }), count);
}

test('a streaming answer keeps the viewport at the tail', async ({ window: page }) => {
  // A full fake-backend turn, streamed nine characters at a time.
  test.slow();
  await page.setViewportSize({ width: 900, height: 700 });
  await sendPrompt(page, LONG_PROMPT);

  // Measured through the stream, not only at the end: the failure this guards
  // against is the tail slipping away *while* content arrives, which a single
  // reading afterwards cannot tell apart from a view dragged back at the last
  // delta.
  const lag = await measureTailLag(page, 1_200);
  await expect(answeredTurns(page)).toHaveCount(1, { timeout: 30_000 });

  // The samples have to have covered more than a viewport of real growth, or
  // every reading above is a stationary transcript and proves nothing.
  expect(lag.grewBy).toBeGreaterThan(lag.viewportHeight);
  expect(lag.worstLag).toBeLessThanOrEqual(lag.worstFrameGrowth + 8);
  expect(await distanceToTail(page)).toBeLessThanOrEqual(4);
  expect(await scrollButtonOffered(page)).toBe(false);
});

test('content that arrives after the reader scrolls up does not pull them back', async ({
  window: page,
}) => {
  test.slow();
  await page.setViewportSize({ width: 900, height: 700 });
  await sendPrompt(page, LONG_PROMPT);
  await expect(answeredTurns(page)).toHaveCount(1, { timeout: 30_000 });

  const transcript = page.locator('.maka-chat-message-list');
  await transcript.hover();
  await page.mouse.wheel(0, -500);
  await waitForPaintedFrames(page);
  const before = await distanceToTail(page);
  expect(before).toBeGreaterThan(100);
  expect(await scrollButtonOffered(page)).toBe(true);

  const anchorTurnId = await page.evaluate(() => {
    const turn = document.querySelector<HTMLElement>('[data-turn-id]');
    const turnId = turn?.dataset.turnId;
    if (!turnId) throw new Error('the transcript has no mounted turn');
    return turnId;
  });
  const anchorTop = await turnTop(page, anchorTurnId);

  await sendPrompt(page, LONG_PROMPT);
  await expect(answeredTurns(page)).toHaveCount(2, { timeout: 30_000 });
  await waitForPaintedFrames(page);

  // The turn the reader was on is still where it was. Everything that arrived,
  // arrived below them.
  expect(Math.abs((await turnTop(page, anchorTurnId)) - anchorTop)).toBeLessThanOrEqual(4);
  expect(await distanceToTail(page)).toBeGreaterThan(before);
});

test('a gesture a nested scroller consumed does not release the tail', async ({
  window: page,
}) => {
  test.slow();
  await page.setViewportSize({ width: 900, height: 700 });
  await sendPrompt(page, LONG_PROMPT);
  await expect(answeredTurns(page)).toHaveCount(1, { timeout: 30_000 });
  expect(await distanceToTail(page)).toBeLessThanOrEqual(4);

  // A real scroller inside the transcript, standing in for a tool-output box
  // (`.maka-tool-output-body`, `max-height: 256px; overflow-y: auto`) or a pty
  // terminal. Built here rather than fixtured because what is under test is
  // Chromium's scroll chain, which does not care where the element came from,
  // and no fixture reliably produces an output tall enough to overflow.
  const nested = await page.evaluate(() => {
    const turns = document.querySelectorAll<HTMLElement>('[data-turn-id]');
    const turn = turns[turns.length - 1];
    if (!turn) throw new Error('the transcript has no mounted turn');
    const box = document.createElement('div');
    box.dataset.nestedScroller = 'true';
    box.style.cssText = 'max-height:120px;overflow-y:auto';
    const filler = document.createElement('div');
    filler.style.height = '2000px';
    box.append(filler);
    turn.append(box);
    // Away from both ends, so scrolling up inside it never reaches a boundary
    // and never chains to the transcript.
    box.scrollTop = 600;
    return box.scrollTop;
  });

  // Appending is growth like any other, so the pin brings the new box into
  // view — which also keeps Playwright's hover from scrolling to reach it.
  await waitForPaintedFrames(page);
  expect(await distanceToTail(page)).toBeLessThanOrEqual(4);

  // The real input pipeline, over the nested element: the gesture crosses the
  // transcript on its way up the tree, the nested element consumes it, and the
  // transcript never moves — so no `scroll` follows. A tail-follow that watches
  // gestures reads this as the reader leaving; one that watches position cannot
  // see it at all. Astryx's stock predicate is the former, and its
  // `animatingRef` was measured sitting at `true` on a resting transcript, so
  // an upward wheel here released the tail with nothing having scrolled.
  await page.locator('[data-nested-scroller="true"]').hover();
  await page.mouse.wheel(0, -400);
  await waitForPaintedFrames(page);
  const nestedAfter = await page.evaluate(
    () => document.querySelector<HTMLElement>('[data-nested-scroller="true"]')?.scrollTop ?? -1,
  );
  // The nested box moved, which is what makes this a gesture the transcript
  // never saw. Without this the test would pass on a wheel that did nothing.
  expect(nestedAfter).toBeLessThan(nested);
  expect(await distanceToTail(page)).toBeLessThanOrEqual(4);

  // The touch equivalent, which no synthetic-free path can produce here.
  await page.evaluate(() => {
    const target = document.querySelector('[data-turn-id]');
    if (!target) throw new Error('the transcript has no mounted turn');
    target.dispatchEvent(new Event('touchmove', { bubbles: true }));
  });
  await waitForPaintedFrames(page);

  // Following is unharmed: a whole further answer lands and the tail is still
  // under the reader. A release would have left them a screen and a half up,
  // with no gesture of their own to explain it.
  await sendPrompt(page, LONG_PROMPT);
  await expect(answeredTurns(page)).toHaveCount(2, { timeout: 30_000 });
  await waitForPaintedFrames(page);
  expect(await distanceToTail(page)).toBeLessThanOrEqual(4);
  expect(await scrollButtonOffered(page)).toBe(false);
});

test('the dock affordance returns the reader to the tail', async ({ window: page }) => {
  test.slow();
  await page.setViewportSize({ width: 900, height: 700 });
  await sendPrompt(page, LONG_PROMPT);
  await expect(answeredTurns(page)).toHaveCount(1, { timeout: 30_000 });

  await scrollTranscriptTo(page, 0);
  // Offered at all is the assertion: with Astryx's scroll layer off, its
  // `isScrolledUp` never updates again, so the stock button would stay
  // transparent forever. This one reads Maka's pin.
  expect(await scrollButtonOffered(page)).toBe(true);

  await page.getByRole('button', { name: SCROLL_TO_BOTTOM }).click();
  await waitForPaintedFrames(page);
  expect(await distanceToTail(page)).toBeLessThanOrEqual(4);
  expect(await scrollButtonOffered(page)).toBe(false);
});

test('earlier history lands above the turn the reader is on', async ({
  promptRailWindow: page,
}) => {
  const loadedTurns = () =>
    page.locator('.maka-chat-message-list').getAttribute('data-turn-source-count').then((value) => Number(value));
  const loadedBefore = await loadedTurns();

  // Just short of the band that asks for more, so the virtual window has
  // mounted turns around the reader before the load starts. Landing straight on
  // zero puts the viewport inside the leading spacer, where there is no turn to
  // be reading and nothing to hold still.
  await page.evaluate((selector) => {
    const root = document.querySelector(selector);
    if (!root) throw new Error('the chat scroll container is missing');
    root.scrollTop = Math.max(640, root.clientHeight * 2) + 400;
  }, SCROLLER);
  await waitForPaintedFrames(page, 6);

  // The move that asks for earlier history, and the reading of where the
  // reader is, in one task: the scroll event that starts the load is dispatched
  // afterwards, so the app anchors on the same position this reads.
  const anchor = await page.evaluate((selector) => {
    const root = document.querySelector(selector);
    if (!root) throw new Error('the chat scroll container is missing');
    root.scrollTop = Math.max(640, root.clientHeight * 2) - 100;
    const rootTop = root.getBoundingClientRect().top;
    const turn = [...root.querySelectorAll<HTMLElement>('[data-turn-id]')].find(
      (candidate) => candidate.getBoundingClientRect().bottom > rootTop,
    );
    const turnId = turn?.dataset.turnId;
    if (!turn || !turnId) throw new Error('no turn is on screen');
    return { turnId, top: Math.round(turn.getBoundingClientRect().top) };
  }, SCROLLER);

  await expect.poll(loadedTurns, { timeout: 20_000 }).toBeGreaterThan(loadedBefore);
  await waitForPaintedFrames(page);

  // The turns that arrived went above the reader, and the reader did not go
  // with them. Asserting the element rather than a `scrollTop` delta is the
  // point: a compensation computed from `scrollHeight` satisfies the delta
  // while putting the reader somewhere else entirely.
  expect(Math.abs((await turnTop(page, anchor.turnId)) - anchor.top)).toBeLessThanOrEqual(4);
});
