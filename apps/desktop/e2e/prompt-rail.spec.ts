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
import { expect, test } from './fixtures';
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

async function loadPromptRailBeyondVirtualWindow(page: Page): Promise<void> {
  const transcript = page.locator('.maka-chat-message-list');
  await scrollTranscriptTo(page, 'top');
  await transcript.hover();
  await page.mouse.wheel(0, -100);
  await expect.poll(async () => Number(await transcript.getAttribute('data-turn-source-count')))
    .toBeGreaterThan(100);
}

async function scrollTranscriptUntilTurn(page: Page, turnId: string): Promise<void> {
  // One programmatic jump is not enough on a shown macOS window: a
  // ResizeObserver can restore a top-of-transcript scroll anchor after we
  // set scrollTop, and the virtualizer then keeps the head window. Re-apply
  // the jump until the tail turn is actually mounted.
  await expect.poll(async () => {
    await scrollTranscriptTo(page, 'bottom');
    await notifyTranscriptScrolled(page);
    return page.evaluate((id) => {
      const root = document.querySelector<HTMLElement>('[data-chat-scroll-container="true"]');
      const mounted = [...document.querySelectorAll<HTMLElement>('[data-virtual-turn-id]')]
        .map((turn) => turn.dataset.virtualTurnId ?? '');
      return {
        hasTurn: mounted.includes(id),
        scrollTop: root ? Math.round(root.scrollTop) : -1,
        lastMounted: mounted.at(-1) ?? null,
      };
    }, turnId);
  }, { message: `the transcript mounts ${turnId} at the bottom` }).toMatchObject({ hasTurn: true });
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
  // effect drops out and picks up again every few pixels of travel. Walk the
  // fractional CSS-pixel path as well as every box centre and seam: integer
  // rounding can place a narrow rail's x coordinate on its outside edge, while
  // sparse midpoint sampling could miss an intercept elsewhere.
  // A bounded rail is an intentional scroller. Hidden ticks outside its clip
  // are not unreachable; they become visible when the reader scrolls the rail.
  // Check the painted column at both edges and in the middle so every group of
  // ticks is covered without mistaking clipped DOM boxes for viewport overflow.
  for (const position of [
    { name: 'top', ratio: 0 },
    { name: 'middle', ratio: 0.5 },
    { name: 'bottom', ratio: 1 },
  ] as const) {
    await expect
      .poll(async () => page.evaluate(async ({ ratio }) => {
        const rail = document.querySelector<HTMLElement>('.maka-prompt-rail');
        const ticks = [...document.querySelectorAll<HTMLElement>('.maka-prompt-rail-tick')];
        if (!rail || ticks.length < 2) throw new Error('the prompt rail needs at least two ticks');

        const maxScroll = Math.max(0, rail.scrollHeight - rail.clientHeight);
        const targetScroll = maxScroll * ratio;
        rail.scrollTop = targetScroll;
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });

        const railBox = rail.getBoundingClientRect();
        const boxes = ticks.map((tick) => tick.getBoundingClientRect());
        const visible = boxes
          .map((box, index) => ({ box, index, tick: ticks[index]! }))
          .filter(({ box }) => {
            const center = box.top + box.height / 2;
            return center >= railBox.top && center <= railBox.bottom;
          });
        const first = visible[0];
        const last = visible.at(-1);
        if (!first || !last) throw new Error('the prompt rail has no visible ticks');

        const describe = (found: Element | null) =>
          found instanceof Element
            ? `${found.tagName.toLowerCase()}.${found.className.toString().trim().replace(/\s+/g, '.')}`
            : 'null';
        type Miss = {
          index: number;
          kind: 'center' | 'seam' | 'path';
          hit: string;
          y?: number;
        };
        let missCount = 0;
        const sample: Miss[] = [];
        const recordMiss = (miss: Miss) => {
          missCount += 1;
          if (sample.length < 3) sample.push(miss);
        };

        for (const { box, index, tick } of visible) {
          const found = document.elementFromPoint(
            box.left + box.width / 2,
            box.top + box.height / 2,
          );
          if (found?.closest('.maka-prompt-rail-tick') !== tick) {
            recordMiss({ index, kind: 'center', hit: describe(found) });
          }
        }
        for (let index = 0; index < visible.length - 1; index += 1) {
          const before = visible[index]!;
          const after = visible[index + 1]!;
          const found = document.elementFromPoint(
            before.box.left + before.box.width / 2,
            (before.box.bottom + after.box.top) / 2,
          );
          const landed = found?.closest('.maka-prompt-rail-tick');
          if (landed !== before.tick && landed !== after.tick) {
            recordMiss({ index: before.index, kind: 'seam', hit: describe(found) });
          }
        }
        const x = first.box.left + first.box.width / 2;
        const startY = first.box.top + first.box.height / 2;
        const endY = last.box.top + last.box.height / 2;
        for (let y = startY, index = 0; y <= endY; y += 0.25, index += 1) {
          const found = document.elementFromPoint(x, y);
          if (!found?.closest('.maka-prompt-rail-tick')) {
            recordMiss({ index, kind: 'path', y, hit: describe(found) });
          }
        }

        const gaps = boxes.slice(1).map((box, index) => box.top - boxes[index]!.bottom);
        return {
          railInsideViewport: railBox.top >= 0 && railBox.bottom <= window.innerHeight,
          scrollSettled: Math.abs(rail.scrollTop - targetScroll) <= 1,
          enoughVisibleTicks: visible.length >= 2,
          edgeReached:
            ratio === 0
              ? first.index === 0
              : ratio === 1
                ? last.index === ticks.length - 1
                : true,
          misses: missCount,
          hasSpan: endY > startY,
          continuousBoxes: Math.max(...gaps) <= 0.25,
          sample,
        };
      }, position), {
        message: `the visible prompt rail column is continuously user-reachable at ${position.name}`,
      })
      .toMatchObject({
        railInsideViewport: true,
        scrollSettled: true,
        enoughVisibleTicks: true,
        edgeReached: true,
        misses: 0,
        hasSpan: true,
        continuousBoxes: true,
        sample: [],
      });
  }
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
  // A normal Playwright click goes through Electron's native pointer path, so
  // this assertion covers both titlebar reachability and the jump contract.
  await page.locator('.maka-prompt-rail-tick').first().click();

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
    .poll(async () => (await landing())?.offset, { message: 'the clicked prompt reaches the top' })
    .toBeGreaterThan(-24);
  expect((await landing())?.offset).toBeLessThan(24);
  expect((await landing())?.tickIsCurrent).toBe(true);

  // And stays: the fill runs on idle callbacks after the jump, so a jump that
  // only wins the first frame reads as landing and then sliding away.
  await page.waitForTimeout(1_200);
  const settled = await landing();
  expect(settled?.offset).toBeGreaterThan(-24);
  expect(settled?.offset).toBeLessThan(24);
  expect(settled?.tickIsCurrent).toBe(true);
});

test('long transcripts keep a bounded mounted turn window', async ({
  promptRailWindow: page,
}) => {
  const count = async () => page.locator('[data-virtual-turn-id]').count();
  await page.locator('[data-chat-scroll-container="true"][data-turn-window="ready"]').waitFor();
  await loadPromptRailBeyondVirtualWindow(page);
  expect(await page.evaluate(() => {
    const transcript = document.querySelector<HTMLElement>('.maka-chat-message-list');
    const rows = transcript?.firstElementChild;
    const turn = document.querySelector<HTMLElement>('[data-virtual-turn-id]');
    if (!rows || !turn) throw new Error('the virtual transcript is missing');
    return {
      list: Number.parseFloat(getComputedStyle(rows).rowGap),
      turn: Number.parseFloat(getComputedStyle(turn).rowGap),
    };
  })).toEqual({ list: 16, turn: 16 });
  expect(await count()).toBeGreaterThan(0);
  expect(await count()).toBeLessThanOrEqual(100);
  await page.locator('.maka-prompt-rail-tick').first().click();
  await expect(page.locator('[data-turn-id="turn-prompt-rail-1"]')).toHaveCount(1);
  expect(await count()).toBeGreaterThan(0);
  expect(await count()).toBeLessThanOrEqual(100);
});

test('evicting a turn-owned sibling interaction hands focus back to the transcript', async ({
  promptRailWindow: page,
}) => {
  const scroller = page.locator('[data-chat-scroll-container="true"][data-turn-window="ready"]');
  await scroller.waitFor();
  await loadPromptRailBeyondVirtualWindow(page);
  await scrollTranscriptUntilTurn(page, 'turn-prompt-rail-120');
  const retainedTurnId = await page.evaluate(() => {
    const turns = document.querySelectorAll<HTMLElement>('[data-virtual-turn-id]');
    const turn = turns.item(turns.length - 1);
    if (!turn?.dataset.virtualTurnId) throw new Error('the mounted turn is missing');
    const turnOwnedAction = document.createElement('button');
    turnOwnedAction.textContent = 'Turn-owned action';
    turn.append(turnOwnedAction);
    turnOwnedAction.focus();
    const range = document.createRange();
    range.selectNodeContents(turnOwnedAction);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return turn.dataset.virtualTurnId;
  });

  // The injected control resizes the tail Turn. That can queue a scroll-anchor
  // restore captured at the bottom. Let that setup-only restore finish before
  // the one-shot jump so the assertion still catches any later restore that
  // would pin the viewport back on the retained Turn (#3121).
  await waitForPaintedFrames(page);
  await scrollTranscriptTo(page, 'top');
  await notifyTranscriptScrolled(page);
  await expect.poll(async () => page.evaluate((turnId) => {
    const root = document.querySelector<HTMLElement>('[data-chat-scroll-container="true"]');
    if (!root) throw new Error('the chat scroll container is missing');
    const mounted = [...document.querySelectorAll<HTMLElement>('[data-virtual-turn-id]')]
      .map((turn) => turn.dataset.virtualTurnId ?? '');
    const active = document.activeElement;
    return {
      retained: mounted.includes(turnId),
      scrollTop: Math.round(root.scrollTop),
      firstMounted: mounted[0] ?? null,
      lastMounted: mounted.at(-1) ?? null,
      focusOnTranscript: active instanceof HTMLElement
        && active.classList.contains('maka-chat-message-list'),
      selectionCollapsed: document.getSelection()?.isCollapsed ?? true,
    };
  }, retainedTurnId), {
    message: 'the retained tail turn leaves after one jump to the top',
  }).toMatchObject({
    retained: false,
    scrollTop: 0,
    focusOnTranscript: true,
    selectionCollapsed: true,
  });
});

test('a tick is what the pointer lands on, not the scrollbar', async ({
  promptRailWindow: page,
}) => {
  // `elementFromPoint`, not `hover()`: dispatched events cannot see occlusion,
  // and macOS's overlay scrollbar occludes without taking layout space.
  const hit = await page.evaluate(() => {
    const ticks = [...document.querySelectorAll('.maka-prompt-rail-tick')];
    if (ticks.length === 0) throw new Error('the prompt rail has no ticks');
    // Same X as every tick, so the overlay contract does not depend on which
    // one we pick. The first tick's centre can sit under the titlebar overlay,
    // where `elementFromPoint` is null and `?.closest(...) !== null` would
    // false-pass. Probe the middle of the column, inside the viewport.
    const tick = ticks[Math.floor(ticks.length / 2)]!;
    const box = tick.getBoundingClientRect();
    const x = Math.round(box.left + box.width / 2);
    const y = Math.round(box.top + box.height / 2);
    const found = document.elementFromPoint(x, y);
    return {
      insideRail: Boolean(found?.closest('.maka-prompt-rail')),
      x,
      y,
      hit: found instanceof Element
        ? `${found.tagName.toLowerCase()}.${found.className.toString().trim().replace(/\s+/g, '.')}`
        : 'null',
    };
  });

  expect(hit, `tick center hit ${hit.hit} at ${hit.x},${hit.y}`).toMatchObject({ insideRail: true });
});
