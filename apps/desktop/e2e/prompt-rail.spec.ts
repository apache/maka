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

import { PROMPT_RAIL_PROMPT_COUNT } from '../src/main/e2e-fixture/seed-helpers';
import { DESKTOP_TRANSCRIPT_ACTIVE_RANGE_MAX_TURNS } from '../src/preload/transcript-contract';
import { ensureSidebarExpanded, expect, test } from './fixtures';
import type { Page } from '@playwright/test';

const MAX_PROMPT_RAIL_TICKS = 64;

/**
 * The prompt anchor rail (#563) has failed three times in a row in the same
 * way: the code kept working and the pixels stopped. #2161 pinned it against
 * `.maka-chat-shell` while Astryx's ChatLayout owned the scroll container, so
 * the rail laid out across the whole conversation and scrolled off screen.
 * #2338 parked it under macOS's overlay scrollbar, which takes no layout space
 * but still swallows the pointer, so every tick rendered and none could be
 * clicked. #2580 moved the tick onto Astryx's `Button`, whose label span put
 * the tick's bar back into normal flow — an inline box takes no width or
 * height, so the bars computed to 0x0 and the rail shipped invisible in 0.1.9
 * and 0.1.10.
 *
 * None of the three is visible to a static read of the CSS, and none is
 * reachable from jsdom, which has no layout. Only a real scroller with a real
 * transcript can see them, so this file keeps one test per failure and nothing
 * else. It is deliberately much smaller than the suite deleted in #2462.
 *
 * Two boundaries worth knowing before adding to it:
 *  - e2e-fixture renders carry `data-maka-e2e-fixture`, and `base.css` gives
 *    that `animation: none` plus a 0.01ms transition cap, so a fixture's state
 *    never depends on when it settles. Assert the end states motion resolves
 *    to; there is no way to assert that anything animated.
 *  - the reachability test is load-bearing on macOS only. Linux's in-flow
 *    scrollbar moves the content column left instead of overlaying it, so the
 *    #2338 regression goes green on CI. Run this spec on macOS before merging
 *    anything that touches the rail's right edge.
 */

const RAIL_PROBE = `(() => {
  const scroller = document.querySelector('[data-chat-scroll-container="true"]');
  const rail = document.querySelector('.maka-prompt-rail');
  if (!scroller || !rail) return null;
  const s = scroller.getBoundingClientRect();
  const r = rail.getBoundingClientRect();
  // Astryx renders the composer dock as the scroll container's last child;
  // the rail measures it the same way, for want of a published hook.
  const dock = scroller.lastElementChild.getBoundingClientRect();
  return {
    // Positive on all four = the rail's box is inside the scrollport and clear
    // of the band the sticky dock occupies at the bottom.
    insetTop: Math.round(r.top - s.top),
    insetBottom: Math.round(s.bottom - r.bottom),
    insetRight: Math.round(s.right - r.right),
    dockClearance: Math.round(dock.top - r.bottom),
    railWidth: Math.round(r.width),
    scrollTop: Math.round(scroller.scrollTop),
  };
})()`;

interface RailProbe {
  insetTop: number;
  insetBottom: number;
  insetRight: number;
  dockClearance: number;
  railWidth: number;
  scrollTop: number;
}

function probeRail(page: Page): Promise<RailProbe | null> {
  return page.evaluate(RAIL_PROBE) as Promise<RailProbe | null>;
}

async function scrollTranscriptTo(page: Page, position: 'top' | 'bottom'): Promise<void> {
  await page.evaluate((where) => {
    const scroller = document.querySelector('[data-chat-scroll-container="true"]');
    if (!scroller) throw new Error('the chat scroll container is missing');
    scroller.scrollTop = where === 'top' ? 0 : scroller.scrollHeight;
  }, position);
  await notifyTranscriptScrolled(page);
  await waitForPaintedFrames(page);
}

async function scrollTranscriptAwayFromTail(page: Page): Promise<void> {
  await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('[data-chat-scroll-container="true"]');
    if (!root) throw new Error('the chat scroll container is missing');
    const historyLoadBand = Math.max(640, root.clientHeight * 2);
    root.scrollTop = Math.min(
      root.scrollHeight - root.clientHeight - 100,
      historyLoadBand + 200,
    );
    root.dispatchEvent(new Event('scroll'));
  });
  await waitForPaintedFrames(page);
}

async function waitForPaintedFrames(page: Page, count = 2): Promise<void> {
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

function notifyTranscriptScrolled(page: Page): Promise<void> {
  return page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('[data-chat-scroll-container="true"]');
    if (!root) throw new Error('the chat scroll container is missing');
    root.dispatchEvent(new Event('scroll'));
  });
}

test('every tick paints a bar with a real box', async ({ promptRailWindow: page }) => {
  // Measured over ALL ticks, not a sample: a helper that skips what it cannot
  // evaluate creates its blind spot exactly where a regression lives.
  const bars = await page.evaluate(() =>
    [...document.querySelectorAll('.maka-prompt-rail-tick-bar')].map((bar) => {
      const box = bar.getBoundingClientRect();
      return { width: Math.round(box.width), height: Math.round(box.height) };
    }),
  );

  expect(bars).toHaveLength(Math.min(PROMPT_RAIL_PROMPT_COUNT, MAX_PROMPT_RAIL_TICKS));
  // #2580 shipped bars at 0x0 — present in the DOM, painting nothing.
  expect(Math.min(...bars.map((bar) => bar.width))).toBeGreaterThan(0);
  expect(Math.min(...bars.map((bar) => bar.height))).toBeGreaterThan(0);
});

test('the rail stays inside the scrollport at both scroll extremes', async ({
  promptRailWindow: page,
}) => {
  const scroll = await page.evaluate(() => {
    const scroller = document.querySelector('[data-chat-scroll-container="true"]');
    if (!scroller) throw new Error('the chat scroll container is missing');
    return { height: scroller.scrollHeight, client: scroller.clientHeight };
  });
  // Without an overflowing transcript the rail has nothing to be pinned
  // against and the rest of this test proves nothing.
  expect(scroll.height).toBeGreaterThan(scroll.client);

  for (const position of ['top', 'bottom'] as const) {
    await scrollTranscriptTo(page, position);
    // The bottom is where it bites: a sticky offset is clamped by its
    // containing block, and the chat shell ends a dock-height above the
    // scrollport's bottom edge (CI caught -62px insetTop that way).
    await expect
      .poll(async () => {
        const probe = await probeRail(page);
        if (!probe) return null;
        return {
          insetTop: probe.insetTop >= 0,
          insetBottom: probe.insetBottom >= 0,
          insetRight: probe.insetRight >= 0,
          dockClearance: probe.dockClearance >= 0,
        };
      }, { message: `rail geometry at the ${position} of the transcript` })
      .toEqual({
        insetTop: true,
        insetBottom: true,
        insetRight: true,
        dockClearance: true,
      });
  }
});

test('the pointer is always on a tick while it travels down the rail', async ({
  promptRailWindow: page,
}) => {
  // The hover falloff reads which tick the pointer entered. A gap between the
  // hit boxes is a band where it is over the rail and over no tick, so the
  // effect drops out and picks up again every few pixels of travel. Walked a
  // pixel at a time rather than sampled between two ticks: a single midpoint
  // would pass on a rail whose gaps sat anywhere else.
  const travel = await page.evaluate(() => {
    const bars = [...document.querySelectorAll('.maka-prompt-rail-tick-bar')];
    if (bars.length < 2) throw new Error('the prompt rail needs at least two ticks');
    const first = bars[0]!.getBoundingClientRect();
    const last = bars[bars.length - 1]!.getBoundingClientRect();
    const x = Math.round(first.left + first.width / 2);
    const misses: number[] = [];
    for (let y = Math.round(first.top + first.height / 2); y <= Math.round(last.top + last.height / 2); y += 1) {
      const found = document.elementFromPoint(x, y);
      if (!found?.closest('.maka-prompt-rail-tick')) misses.push(y);
    }
    return { misses: misses.length, span: Math.round(last.bottom - first.top) };
  });

  expect(travel.span).toBeGreaterThan(0);
  expect(travel.misses).toBe(0);
});

test('the first click of a session lands on its prompt and holds', async ({
  promptRailMotionWindow: page,
}) => {
  // Clicked before anything else touches the transcript, which is the case
  // that used to fail: the head of a 30-prompt session is not mounted yet, so
  // the jump has to mount it, and the fill that follows changes scrollHeight
  // under Astryx's auto-follow lock. The lock ignores scroll-ups that arrive
  // with a changed height, so it stayed on and pulled the transcript back to
  // the bottom — the click looked dead until the reader scrolled by hand.
  //
  // This window is the only one in the suite that scrolls smoothly, which is
  // why it is its own fixture. Every capture otherwise collapses scroll
  // motion, and a jump that finishes in one frame is never in flight long
  // enough to meet the lock at all. `emulateMedia` cannot arrange it: the
  // collapse is keyed on `data-maka-e2e-fixture`, not on the media query.
  expect(await page.evaluate(() => document.documentElement.dataset.makaScrollMotion)).toBe(
    'smooth',
  );

  // The first tick's turn, named rather than inferred: the first mounted
  // `[data-turn-id]` is whatever the tail window happens to hold, and at the
  // opening scroll position its top is already above the scrollport, which
  // passes an upper-bound-only check without the jump doing anything at all.
  const targetTurnId = 'turn-prompt-rail-1';
  await page.locator('.maka-prompt-rail-tick').first().click({ force: true });

  const landing = async () =>
    page.evaluate((turnId) => {
      const scroller = document.querySelector('[data-chat-scroll-container="true"]')!;
      const turn = document.querySelector(`[data-turn-id="${turnId}"]`);
      if (!turn) return null;
      const tick = document.querySelector('.maka-prompt-rail-tick');
      return {
        offset: Math.round(
          turn.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
        ),
        tickIsCurrent: tick?.getAttribute('aria-current') === 'true',
      };
    }, targetTurnId);

  // Bounded on both sides: below is the turn never arriving, above is it
  // arriving and then being pulled off the top of the scrollport.
  await expect
    .poll(async () => {
      const offset = (await landing())?.offset;
      return offset === undefined ? Number.POSITIVE_INFINITY : Math.abs(offset);
    }, { message: 'the clicked prompt reaches the top' })
    .toBeLessThan(24);
  expect((await landing())?.tickIsCurrent).toBe(true);

  // And stays: turns keep resolving their content and remeasuring after the
  // jump, so a jump that only wins the first frame reads as landing and then
  // sliding away.
  await page.waitForTimeout(1_200);
  const settled = await landing();
  expect(settled?.offset).toBeGreaterThan(-24);
  expect(settled?.offset).toBeLessThan(24);
  expect(settled?.tickIsCurrent).toBe(true);
});

test('active transcript Turns keep stable DOM identities while scrolling', async ({
  promptRailWindow: page,
}) => {
  const sourceCount = Number(
    await page.locator('.maka-chat-message-list').getAttribute('data-turn-source-count'),
  );
  expect(sourceCount).toBe(DESKTOP_TRANSCRIPT_ACTIVE_RANGE_MAX_TURNS);
  expect(await page.locator('[data-turn-id]').count()).toBe(sourceCount);
  await page.evaluate(() => {
    for (const turn of document.querySelectorAll<HTMLElement>('[data-turn-id]')) {
      turn.dataset.stableMountProbe = turn.dataset.turnId;
    }
  });

  await scrollTranscriptTo(page, 'bottom');
  await scrollTranscriptAwayFromTail(page);

  expect(await page.locator('[data-turn-id]').count()).toBe(sourceCount);
  expect(await page.locator('[data-turn-id][data-stable-mount-probe]').count()).toBe(sourceCount);
});

test('scrolling away preserves a turn-owned focus and selection', async ({
  promptRailWindow: page,
}) => {
  await scrollTranscriptTo(page, 'bottom');
  await expect(page.locator('[data-turn-id="turn-prompt-rail-120"]')).toHaveCount(1);
  await page.evaluate(() => {
    const turn = document.querySelector<HTMLElement>('[data-turn-id="turn-prompt-rail-120"]');
    if (!turn) throw new Error('the tail Turn is missing');
    const turnOwnedAction = document.createElement('button');
    turnOwnedAction.dataset.turnOwnedAction = 'true';
    turnOwnedAction.textContent = 'Turn-owned action';
    turn.append(turnOwnedAction);
    turnOwnedAction.focus();
    const range = document.createRange();
    range.selectNodeContents(turnOwnedAction);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await scrollTranscriptAwayFromTail(page);

  await expect.poll(async () => page.evaluate(() => {
    const active = document.activeElement;
    return {
      retained: document.querySelector('[data-turn-id="turn-prompt-rail-120"]') !== null,
      focusRetained: active instanceof HTMLElement
        && active.dataset.turnOwnedAction === 'true',
      selectionRetained: document.getSelection()?.isCollapsed === false,
    };
  })).toEqual({
    retained: true,
    focusRetained: true,
    selectionRetained: true,
  });
});

test('offscreen active Turns remain findable and accessible', async ({
  promptRailWindow: page,
}) => {
  const firstTurnId = await page.locator('[data-turn-id]').first().getAttribute('data-turn-id');
  const turnNumber = Number(firstTurnId?.split('-').at(-1));
  expect(turnNumber).toBeGreaterThan(0);
  const needle = `第 ${turnNumber} 个问题`;
  await scrollTranscriptTo(page, 'bottom');

  const found = await page.evaluate((text) => {
    document.getSelection()?.removeAllRanges();
    return (window as Window & { find(text: string): boolean }).find(text);
  }, needle);
  expect(found).toBe(true);
  expect(await page.evaluate(() => document.getSelection()?.toString() ?? '')).toContain(needle);

  const cdp = await page.context().newCDPSession(page);
  const tree = await cdp.send('Accessibility.getFullAXTree');
  expect(tree.nodes.some((node) => node.name?.value?.includes(needle))).toBe(true);
});

test('switching sessions reconstructs only the Host active range', async ({
  promptRailWindow: page,
}) => {
  await ensureSidebarExpanded(page);
  const rows = page.locator('.maka-session-row');
  const selected = rows.locator('button.astryx-side-nav-item.selected');
  const originalId = await selected
    .evaluate((button) => button.closest('.maka-session-row')?.getAttribute('data-session-id'));
  if (!originalId) throw new Error('the prompt-rail Session is not selected');
  const otherId = await rows.evaluateAll(
    (rows, selected) => rows
      .map((row) => row.getAttribute('data-session-id'))
      .find((sessionId) => sessionId !== selected) ?? null,
    originalId,
  );
  if (!otherId) throw new Error('the fixture has no second Session');
  await page.locator(`.maka-session-row[data-session-id=${JSON.stringify(otherId)}] button`)
    .first()
    .click();
  await expect(page.locator(
    `.maka-session-row[data-session-id=${JSON.stringify(otherId)}] button.selected`,
  ))
    .toHaveCount(1);

  await page.locator(`.maka-session-row[data-session-id=${JSON.stringify(originalId)}] button`)
    .first()
    .click();
  await expect(page.locator('[data-turn-id="turn-prompt-rail-120"]')).toHaveCount(1);
  expect(await page.locator('[data-turn-id]').count())
    .toBe(DESKTOP_TRANSCRIPT_ACTIVE_RANGE_MAX_TURNS);
});

test('a tick is what the pointer lands on, not the scrollbar', async ({
  promptRailWindow: page,
}) => {
  // `elementFromPoint`, not `hover()`: dispatched events cannot see occlusion,
  // and macOS's overlay scrollbar occludes without taking layout space.
  const hit = await page.evaluate(() => {
    const tick = document.querySelector('.maka-prompt-rail-tick');
    if (!tick) throw new Error('the prompt rail has no ticks');
    const box = tick.getBoundingClientRect();
    const found = document.elementFromPoint(
      Math.round(box.left + box.width / 2),
      Math.round(box.top + box.height / 2),
    );
    return { insideRail: found?.closest('.maka-prompt-rail') !== null };
  });

  expect(hit.insideRail).toBe(true);
});
