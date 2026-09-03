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

import {
  awaitSendReady,
  expect,
  test,
  COMPOSER_INPUT,
  ensureSidebarExpanded,
} from './fixtures';
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
  return scrollMetrics(page).then((metrics) => metrics.distance);
}

/**
 * The distance plus the three numbers it came from. A failure that reports only
 * the distance cannot say whether the transcript grew past the reader or the
 * viewport shrank under them, and those have different causes.
 */
function scrollMetrics(page: Page): Promise<{
  distance: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}> {
  return page.evaluate((selector) => {
    const root = document.querySelector(selector);
    if (!root) throw new Error('the chat scroll container is missing');
    return {
      distance: Math.round(root.scrollHeight - root.scrollTop - root.clientHeight),
      scrollTop: Math.round(root.scrollTop),
      scrollHeight: root.scrollHeight,
      clientHeight: root.clientHeight,
    };
  }, SCROLLER);
}

/**
 * Whether the dock affordance is actually offered. It is always in the DOM —
 * Astryx toggles opacity and pointer-events — so presence proves nothing and
 * `toBeVisible` passes on the transparent one.
 */
function scrollButtonOffered(page: Page): Promise<boolean> {
  return page.evaluate((names) => {
    const button = [...document.querySelectorAll('button')].find(
      (candidate) => names.includes(candidate.getAttribute('aria-label') ?? '')
        || names.includes(candidate.textContent?.trim() ?? ''),
    );
    if (!button) throw new Error(`the "${names.join('" / "')}" affordance is missing`);
    const style = getComputedStyle(button);
    return style.pointerEvents !== 'none' && Number(style.opacity) > 0.5;
  }, ['滚动主对话到底部', 'Scroll main conversation to bottom']);
}

function turnTop(page: Page, turnId: string): Promise<number> {
  return page.evaluate((id) => {
    const turn = document.querySelector(`[data-turn-id="${CSS.escape(id)}"]`);
    if (!turn) throw new Error(`turn ${id} is not mounted`);
    return Math.round(turn.getBoundingClientRect().top);
  }, turnId);
}

function turnOffsetFromScroller(page: Page, turnId: string): Promise<number> {
  return page.evaluate(([selector, id]) => {
    const root = document.querySelector(selector);
    const turn = document.querySelector(`[data-turn-id="${CSS.escape(id as string)}"]`);
    if (!root || !turn) return Number.POSITIVE_INFINITY;
    return Math.round(turn.getBoundingClientRect().top - root.getBoundingClientRect().top);
  }, [SCROLLER, turnId] as const);
}

function waitForStableTurnAtScrollerStart(page: Page, turnId: string): Promise<void> {
  return page.evaluate(([selector, id]) => new Promise<void>((resolve, reject) => {
    let previousTop = Number.NaN;
    let previousHeight = Number.NaN;
    let stableFrames = 0;
    const timeout = window.setTimeout(
      () => reject(new Error(`Turn ${id} did not settle at the scroller start`)),
      10_000,
    );
    const measure = (): void => {
      const root = document.querySelector<HTMLElement>(selector);
      const turn = root?.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(id)}"]`);
      if (root && turn) {
        const offset = turn.getBoundingClientRect().top - root.getBoundingClientRect().top;
        stableFrames = Math.abs(offset) <= 4
            && root.scrollTop === previousTop
            && root.scrollHeight === previousHeight
          ? stableFrames + 1
          : 0;
        previousTop = root.scrollTop;
        previousHeight = root.scrollHeight;
        if (stableFrames >= 6) {
          window.clearTimeout(timeout);
          resolve();
          return;
        }
      }
      window.requestAnimationFrame(measure);
    };
    measure();
  }), [SCROLLER, turnId]);
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
  // Switching Session or model restarts asynchronous send admission.
  await awaitSendReady(page);
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
  const settled = await scrollMetrics(page);
  expect(settled.distance, JSON.stringify(settled)).toBeLessThanOrEqual(4);
  expect(await scrollButtonOffered(page)).toBe(false);
});

test('switching Sessions restores a Turn anchor while a tail Session follows background growth', async ({
  promptRailWindow: page,
}) => {
  test.slow();
  await page.setViewportSize({ width: 900, height: 700 });
  await ensureSidebarExpanded(page);
  const rows = page.locator('.maka-session-row');
  const selected = rows.locator('button.astryx-side-nav-item.selected');
  const readingSessionId = await selected.evaluate(
    (button) => button.closest('.maka-session-row')?.getAttribute('data-session-id'),
  );
  if (!readingSessionId) throw new Error('the prompt-rail Session is not selected');
  const tailSessionId = await rows.evaluateAll(
    (items, active) => items
      .map((row) => row.getAttribute('data-session-id'))
      .find((sessionId) => sessionId !== active) ?? null,
    readingSessionId,
  );
  if (!tailSessionId) throw new Error('the fixture has no tail-intent Session');
  const rowButton = (sessionId: string) => page.locator(
    `.maka-session-row[data-session-id=${JSON.stringify(sessionId)}] button`,
  ).first();

  // Move the active bounded range away from the latest window, then establish
  // a reading position through the real scroll event path. Reopening the
  // Session now has to use the saved sequence before the Turn can exist.
  await page.locator('.maka-prompt-rail-tick').first().click({ force: true });
  const readingTurnId = 'turn-prompt-rail-1';
  await expect(page.locator(`[data-turn-id="${readingTurnId}"]`)).toHaveCount(1, {
    timeout: 20_000,
  });
  await expect.poll(
    async () => Math.abs(await turnOffsetFromScroller(page, readingTurnId)),
    { message: 'the unloaded prompt reaches the scroller start' },
  ).toBeLessThanOrEqual(24);
  // The prompt rail holds its target through late content measurement. Six
  // unchanged painted frames exceed its own quiet-frame handoff, so switching
  // after this point cannot carry that release into the next Session. Observe
  // transcript geometry directly: the Astryx dock can be briefly unmounted on
  // a loaded Xvfb worker even though the reading position is already stable.
  await waitForStableTurnAtScrollerStart(page, readingTurnId);
  expect(await distanceToTail(page)).toBeGreaterThan(100);

  await rowButton(tailSessionId).click();
  await expect(rowButton(tailSessionId)).toHaveClass(/selected/);
  await waitForPaintedFrames(page, 6);
  expect(await distanceToTail(page)).toBeLessThanOrEqual(4);
  // The fixture Session predates connection identities. Choosing any current
  // model upgrades it onto the E2E Runtime Host before this test starts a Turn.
  const modelSwitcher = page.locator('.maka-model-switcher-trigger');
  await modelSwitcher.click();
  await page.getByRole('menuitemradio', { name: 'glm-4.5', exact: true }).click();
  await expect(modelSwitcher).toContainText('glm-4.5');

  await page.evaluate((sessionId) => {
    const state = { complete: false, unsubscribe: () => undefined };
    state.unsubscribe = window.maka.sessions.subscribeEvents(sessionId, (event) => {
      if (event.type !== 'complete') return;
      state.complete = true;
      state.unsubscribe();
    });
    (window as typeof window & { __makaBackgroundTailProbe?: typeof state })
      .__makaBackgroundTailProbe = state;
  }, tailSessionId);
  await sendPrompt(page, LONG_PROMPT);
  await expect(page.locator('.maka-user-message', { hasText: '第 1 行' })).toBeVisible({
    timeout: 20_000,
  });

  // The transcript collapses before each async replacement. This round trip
  // therefore exercises the production ordering that made a saved scrollTop
  // become zero, not merely a pre-filled test tree.
  await rowButton(readingSessionId).click();
  await expect.poll(
    async () => Math.abs(await turnOffsetFromScroller(page, readingTurnId)),
    { timeout: 20_000, message: 'the saved reading Turn returns to the scroller start' },
  ).toBeLessThanOrEqual(4);
  expect(await scrollButtonOffered(page)).toBe(true);

  await expect.poll(() => page.evaluate(() => (
    window as typeof window & {
      __makaBackgroundTailProbe?: { complete: boolean };
    }
  ).__makaBackgroundTailProbe?.complete === true), { timeout: 30_000 }).toBe(true);
  await rowButton(tailSessionId).click();
  await expect(rowButton(tailSessionId)).toHaveClass(/selected/);
  await waitForPaintedFrames(page, 6);
  const tail = await scrollMetrics(page);
  expect(tail.distance, JSON.stringify(tail)).toBeLessThanOrEqual(4);
  expect(await scrollButtonOffered(page)).toBe(false);
});

/**
 * The turn wrappers are not the transcript. It also renders the optimistic user
 * message, the no-tail live fallback and orphaned conversation items outside
 * them, so a growth signal that watches turns has a blind spot the size of
 * whatever else gets rendered next.
 *
 * Grown here rather than by sending a Follow Up: whether the optimistic message
 * is ever on screen is the host's timing, and it was measured both appearing
 * and being overtaken by its own answer within the same fixture. What is under
 * test is not that message — it is that `scrollHeight` growing anywhere is
 * enough, which is a property of the scroller and needs no help from the
 * transcript to state.
 */
test('content that grows outside the turn wrappers is followed too', async ({
  window: page,
}) => {
  test.slow();
  await page.setViewportSize({ width: 900, height: 700 });
  await sendPrompt(page, LONG_PROMPT);
  await expect(answeredTurns(page)).toHaveCount(1, { timeout: 30_000 });
  expect(await distanceToTail(page)).toBeLessThanOrEqual(4);

  const outsideTurnWrapper = await page.evaluate(() => {
    const list = document.querySelector('.maka-chat-message-list');
    if (!list) throw new Error('the transcript content box is missing');
    const grown = document.createElement('div');
    grown.dataset.outsideTurnGrowth = 'true';
    grown.style.height = '600px';
    list.append(grown);
    return grown.closest('[data-transcript-turn-id]') === null;
  });
  await waitForPaintedFrames(page);

  // Outside a wrapper is what makes this the uncovered path: growth inside one
  // is what every other test in this file already exercises.
  expect(outsideTurnWrapper, 'the injected box landed inside a turn wrapper').toBe(true);
  const settled = await scrollMetrics(page);
  expect(settled.distance, JSON.stringify(settled)).toBeLessThanOrEqual(4);
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
  // The turn's arrival and the tail-follow write are two steps, so one sample
  // races the follow on a loaded runner. Poll until the reader has provably
  // been carried back to the tail.
  await expect.poll(async () => (await scrollMetrics(page)).distance, {
    message: 'the transcript follows the landed answer to the tail',
  }).toBeLessThanOrEqual(4);

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

test('a nested scroller near the history boundary does not request an earlier range', async ({
  promptRailWindow: page,
}) => {
  await page.setViewportSize({ width: 900, height: 1500 });
  await waitForPaintedFrames(page, 6);
  // The fixture is ready when the transcript exists, before its initial tail
  // positioning necessarily completes. Poll one geometry sample so the pin has
  // provably settled inside the load band and at the tail before the nested
  // scroller exercises it.
  await expect.poll(async () => {
    const metrics = await scrollMetrics(page);
    return {
      insideLoadBand: metrics.scrollTop <= Math.max(640, metrics.clientHeight * 2),
      settledAtTail: metrics.distance <= 4,
      metrics,
    };
  }, {
    message: 'the initial transcript tail positioning settles',
  }).toMatchObject({
    insideLoadBand: true,
    settledAtTail: true,
  });

  const nestedBefore = await page.evaluate((selector) => {
    const root = document.querySelector<HTMLElement>(selector);
    const list = root?.querySelector<HTMLElement>('.maka-chat-message-list');
    if (!root || !list) throw new Error('the active transcript range is missing');
    const box = document.createElement('div');
    box.dataset.nestedHistoryScroller = 'true';
    box.style.cssText = [
      'position:fixed',
      'top:160px',
      'left:160px',
      'width:240px',
      'height:120px',
      'overflow-y:auto',
      'z-index:9999',
    ].join(';');
    const filler = document.createElement('div');
    filler.style.height = '2000px';
    box.append(filler);
    // A Turn uses `content-visibility:auto`, whose paint containment prevents
    // a fixed descendant from reliably winning hit testing over sibling Turns
    // on Linux/Xvfb. Keep the fixture inside the transcript event path without
    // putting it inside the product containment boundary being tested.
    list.append(box);
    box.scrollTop = 600;
    return box.scrollTop;
  }, SCROLLER);

  const nested = page.locator('[data-nested-history-scroller="true"]');
  const box = await nested.boundingBox();
  if (!box) throw new Error('the nested history scroller is not rendered');
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  expect(await page.evaluate(({ x, y }) =>
    document.elementFromPoint(x, y)?.closest('[data-nested-history-scroller="true"]') !== null,
  point)).toBe(true);
  await page.mouse.move(point.x, point.y);
  await page.mouse.wheel(0, -400);
  await waitForPaintedFrames(page);

  const nestedAfter = await page.evaluate(() =>
    document.querySelector<HTMLElement>('[data-nested-history-scroller="true"]')?.scrollTop ?? -1,
  );
  expect(nestedAfter).toBeLessThan(nestedBefore);
  await page.evaluate(() => {
    const list = document.querySelector('.maka-chat-message-list');
    if (!list) throw new Error('the transcript content box is missing');
    const grown = document.createElement('div');
    grown.style.height = '600px';
    list.append(grown);
  });
  await waitForPaintedFrames(page, 6);
  expect(await distanceToTail(page)).toBeLessThanOrEqual(4);
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
  const firstLoadedTurn = () => page
    .locator('[data-transcript-turn-id]')
    .first()
    .getAttribute('data-transcript-turn-id');
  const firstBefore = await firstLoadedTurn();

  // Just short of the band that asks for more, so the active range has painted
  // turns around the reader before the load starts. Landing straight on zero
  // leaves no visible turn above the load boundary to identify as the anchor.
  await page.evaluate((selector) => {
    const root = document.querySelector(selector);
    if (!root) throw new Error('the chat scroll container is missing');
    root.scrollTop = Math.max(640, root.clientHeight * 2) + 400;
  }, SCROLLER);
  await waitForPaintedFrames(page, 6);

  // The move that asks for earlier history, and the reading of where the
  // reader is, in one task. Keep the reader near the active range's head: an
  // anchor near its tail can already have a complete bounded range around it,
  // so a valid load has no reason to move the first resident Turn.
  const anchor = await page.evaluate((selector) => {
    const root = document.querySelector(selector);
    if (!root) throw new Error('the chat scroll container is missing');
    root.scrollTop = Math.min(300, root.scrollHeight - root.clientHeight);
    const rootTop = root.getBoundingClientRect().top;
    const turn = [...root.querySelectorAll<HTMLElement>('[data-turn-id]')].find(
      (candidate) => candidate.getBoundingClientRect().bottom > rootTop,
    );
    const turnId = turn?.dataset.turnId;
    if (!turn || !turnId) throw new Error('no turn is on screen');
    const anchor = { turnId, top: Math.round(turn.getBoundingClientRect().top) };
    root.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }));
    return anchor;
  }, SCROLLER);

  await expect.poll(firstLoadedTurn, { timeout: 20_000 }).not.toBe(firstBefore);
  await waitForPaintedFrames(page);

  // The turns that arrived went above the reader, and the reader did not go
  // with them. Asserting the element rather than a `scrollTop` delta is the
  // point: a compensation computed from `scrollHeight` satisfies the delta
  // while putting the reader somewhere else entirely.
  await expect.poll(
    async () => Math.abs((await turnTop(page, anchor.turnId)) - anchor.top),
  ).toBeLessThanOrEqual(4);
});

test('history asked for at the very top of the scroller still lands above the reader', async ({
  promptRailWindow: page,
}) => {
  const firstLoadedTurn = () => page
    .locator('[data-transcript-turn-id]')
    .first()
    .getAttribute('data-transcript-turn-id');
  const firstBefore = await firstLoadedTurn();

  // The fixture is ready when the transcript exists, before its initial tail
  // positioning necessarily completes. Writing zero while it is still at zero
  // is a no-op, so no reader scroll event asks for earlier history. Require one
  // geometry sample to prove both that the initial pin moved and where it
  // landed before exercising the real move to the top.
  await expect.poll(async () => {
    const metrics = await scrollMetrics(page);
    return {
      positionedAwayFromStart: metrics.scrollTop > 0,
      settledAtTail: metrics.distance <= 4,
      metrics,
    };
  }, {
    message: 'the initial transcript tail positioning settles',
  }).toMatchObject({
    positionedAwayFromStart: true,
    settledAtTail: true,
  });

  // The one position where the browser declines to anchor, and the one the
  // wheel-to-load path puts the reader in.
  await page.evaluate((selector) => {
    const root = document.querySelector(selector);
    if (!root) throw new Error('the chat scroll container is missing');
    root.scrollTop = 0;
    root.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }));
  }, SCROLLER);

  await expect.poll(firstLoadedTurn, { timeout: 20_000 }).not.toBe(firstBefore);
  await waitForPaintedFrames(page);

  // Anchoring resumes at an offset of one pixel, so the offset itself is the
  // evidence: left at zero the browser holds the scroller at the top and every
  // turn that arrives pushes the reader's content down the viewport instead.
  const offset = await page.evaluate((selector) => {
    const root = document.querySelector(selector);
    if (!root) throw new Error('the chat scroll container is missing');
    return root.scrollTop;
  }, SCROLLER);
  expect(offset).toBeGreaterThanOrEqual(1);
});

/**
 * A transcript shorter than about three viewports has its tail inside the band
 * that asks for earlier history, so "near the start" cannot mean the reader
 * wants it.
 *
 * The other half of that rule — a wheel the scroller cannot act on releases the
 * pin, because it is the reader asking for what is above them — has no assertion
 * here, and not for want of trying. Its only observable consequence is that a
 * later arrival does not take the reader back down, and in this fixture the
 * reader who asks is already at the tail: anchoring holds them at the same
 * distance from it, the session takes no new turns, and a viewport change moves
 * them the same way pinned or not. An assertion that passes either way is worse
 * than none. `transcript-scroll-authority.test.ts` covers the state machine it
 * turns on.
 */
test('following the tail does not ask for the history above it', async ({
  promptRailWindow: page,
}) => {
  const firstLoadedTurn = () => page
    .locator('[data-transcript-turn-id]')
    .first()
    .getAttribute('data-transcript-turn-id');
  const firstBefore = await firstLoadedTurn();

  // Tall enough that the tail sits inside `max(640, clientHeight * 2)`. The
  // resize itself is a growth signal, so the pin writes the tail and that write
  // dispatches the scroll event this test is about.
  await page.setViewportSize({ width: 900, height: 1500 });
  await waitForPaintedFrames(page, 6);

  // Same as above: the fixture being ready does not mean the initial tail
  // positioning has completed. Poll until the pin has provably settled at the
  // tail and inside the load band this test's history claim rests on.
  await expect.poll(async () => {
    const settled = await scrollMetrics(page);
    return {
      insideLoadBand: settled.scrollTop <= Math.max(640, settled.clientHeight * 2),
      settledAtTail: settled.distance <= 4,
      settled,
    };
  }, {
    message: 'the initial transcript tail positioning settles',
  }).toMatchObject({
    insideLoadBand: true,
    settledAtTail: true,
  });

  // Nothing arrived that the reader did not ask for.
  await waitForPaintedFrames(page, 12);
  expect(await firstLoadedTurn()).toBe(firstBefore);
});

test('a wheel a short scroller cannot act on still asks for history', async ({
  promptRailWindow: page,
}) => {
  const firstLoadedTurn = () => page
    .locator('[data-transcript-turn-id]')
    .first()
    .getAttribute('data-transcript-turn-id');
  const firstBefore = await firstLoadedTurn();

  await page.setViewportSize({ width: 900, height: 4000 });
  await waitForPaintedFrames(page, 6);
  const asked = await scrollMetrics(page);
  expect(asked.distance, JSON.stringify(asked)).toBeLessThanOrEqual(4);

  // Dispatched rather than driven, and that is the point: the case is a wheel
  // the scroller cannot act on — already at zero, or too short to move — where
  // no scroll follows and the authority never learns the reader asked. A real
  // `mouse.wheel` would scroll, and the scroll alone would carry the request.
  await page.evaluate((selector) => {
    const root = document.querySelector(selector);
    if (!root) throw new Error('the chat scroll container is missing');
    root.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }));
  }, SCROLLER);

  await expect.poll(firstLoadedTurn, { timeout: 20_000 }).not.toBe(firstBefore);
});
