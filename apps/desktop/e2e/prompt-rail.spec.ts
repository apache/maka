import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * The prompt anchor rail (#563) has to stay on screen — and reachable — at
 * every scroll position. It was pinned with `position: absolute` against
 * `.maka-chat-shell` back when the chat view owned a viewport-sized scroll
 * box. Astryx's ChatLayout owns the scroll container now and the whole
 * transcript renders inside it, so that containing block became as tall as the
 * conversation: the rail laid out across ~32000px, centred itself somewhere in
 * the middle of the document, and scrolled away with the content — visibly
 * gone.
 *
 * A static CSS read cannot see any of that. Only a real scroller with a real
 * transcript can, which is what these fixtures give us.
 *
 * One boundary worth knowing before adding to this file: e2e-fixture renders
 * carry `data-maka-e2e-fixture`, and `base.css` gives that `animation: none`
 * and a 0.01ms transition cap so a fixture's rendered state never depends on
 * the millisecond it settles. So the tests below assert the *end states* the
 * motion resolves to — where the highlight lands, how wide each bar computes —
 * and cannot assert that anything animated on the way there. The tick entrance
 * has no end state to check and therefore no coverage here at all.
 */

const RAIL_PROBE = `(() => {
  const scroller = document.querySelector('[data-chat-scroll-container="true"]');
  const rail = document.querySelector('.maka-prompt-rail');
  if (!scroller || !rail) return null;
  const s = scroller.getBoundingClientRect();
  const r = rail.getBoundingClientRect();
  const dock = scroller.lastElementChild.getBoundingClientRect();
  const anchor = document.querySelector('.maka-prompt-rail-anchor');
  return {
    ticks: rail.querySelectorAll('.maka-prompt-rail-tick').length,
    // 0 = the sticky anchor is holding the scrollport's top edge, i.e. its
    // offset has not been clamped by the end of the chat shell.
    anchorFromScrollportTop: Math.round(anchor.getBoundingClientRect().top - s.top),
    // Where the rail's centre is, against the centre of the band above the dock.
    railCentre: Math.round(r.top + r.height / 2 - s.top),
    bandCentre: Math.round((dock.top - s.top) / 2),
    // Positive on all = the rail's box is inside the scrollport's box, and
    // clear of the band the sticky composer dock occupies at the bottom.
    insetTop: Math.round(r.top - s.top),
    insetBottom: Math.round(s.bottom - r.bottom),
    insetRight: Math.round(s.right - r.right),
    dockClearance: Math.round(dock.top - r.bottom),
    railHeight: Math.round(r.height),
    scrollportHeight: Math.round(s.height),
    scrollTop: Math.round(scroller.scrollTop),
  };
})()`;

type RailProbe = {
  ticks: number;
  anchorFromScrollportTop: number;
  railCentre: number;
  bandCentre: number;
  insetTop: number;
  insetBottom: number;
  insetRight: number;
  dockClearance: number;
  railHeight: number;
  scrollportHeight: number;
  scrollTop: number;
};

/**
 * Which element a real pointer would land on at each tick's centre, reported
 * for every tick that is not its own hit target.
 *
 * Only ticks inside the rail's visible box count. Once the rail is past its cap
 * it scrolls internally, and a tick scrolled out of that box is legitimately
 * not on screen — the contract here is that a tick you can see is a tick you
 * can hit.
 *
 * That exemption is also this helper's blind spot: it cannot see an *active*
 * tick that has been left outside the rail's viewport, because it skips the
 * tick instead of failing on it. `activeTickVisibility` below is what covers
 * that, and the overflowing-rail test is where it matters.
 */
async function unreachableTicks(page: Page): Promise<Array<{ index: number; hit: string | null }>> {
  return await page.evaluate(() => {
    const rail = document.querySelector<HTMLElement>('.maka-prompt-rail');
    if (!rail) throw new Error('Expected the prompt rail');
    const railBox = rail.getBoundingClientRect();
    const ticks = [...document.querySelectorAll<HTMLElement>('.maka-prompt-rail-tick')];
    return ticks.flatMap((tick, index) => {
      const rect = tick.getBoundingClientRect();
      const centre = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      if (centre.y < railBox.top || centre.y > railBox.bottom) return [];
      const hit = document.elementFromPoint(centre.x, centre.y);
      if (hit && (hit === tick || tick.contains(hit))) return [];
      return [{ index, hit: hit ? `${hit.tagName.toLowerCase()}.${String(hit.className).split(' ')[0]}` : null }];
    });
  });
}

/**
 * Where the active tick sits relative to the rail's own viewport, and whether
 * a pointer at its centre would reach it.
 */
async function activeTickVisibility(page: Page): Promise<{
  found: boolean;
  fullyInsideRail: boolean;
  hit: string | null;
  hitsActiveTick: boolean;
  railScrollTop: number;
  railScrollHeight: number;
  railClientHeight: number;
}> {
  return await page.evaluate(() => {
    const rail = document.querySelector<HTMLElement>('.maka-prompt-rail');
    if (!rail) throw new Error('Expected the prompt rail');
    const active = rail.querySelector<HTMLElement>('.maka-prompt-rail-tick[data-active="true"]');
    const railBox = rail.getBoundingClientRect();
    const base = {
      railScrollTop: Math.round(rail.scrollTop),
      railScrollHeight: Math.round(rail.scrollHeight),
      railClientHeight: Math.round(rail.clientHeight),
    };
    if (!active) return { found: false, fullyInsideRail: false, hit: null, hitsActiveTick: false, ...base };
    const box = active.getBoundingClientRect();
    const hitEl = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return {
      found: true,
      fullyInsideRail: box.top >= railBox.top - 1 && box.bottom <= railBox.bottom + 1,
      hit: hitEl ? `${hitEl.tagName.toLowerCase()}.${String(hitEl.className).split(' ')[0]}` : null,
      hitsActiveTick: Boolean(hitEl && (hitEl === active || active.contains(hitEl))),
      ...base,
    };
  });
}

async function scrollToRatio(page: Page, ratio: number): Promise<void> {
  await page.evaluate((value) => {
    const scroller = document.querySelector<HTMLElement>('[data-chat-scroll-container="true"]');
    if (!scroller) throw new Error('Expected the Astryx chat scroller');
    scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) * value;
  }, ratio);
  // One settled frame, so the read is against the post-scroll layout.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function settled(page: Page, turns: number): Promise<void> {
  await expect(page.locator('.maka-turn')).toHaveCount(turns);
  await expect(page.locator('[data-chat-scroll-container="true"][data-turn-warmup="settled"]')).toBeAttached({ timeout: 15_000 });
}

test('the prompt rail stays inside the scrollport at every scroll position', async ({ longTranscriptWindow: page }) => {
  await settled(page, 24);

  for (const ratio of [0, 0.5, 1]) {
    await scrollToRatio(page, ratio);
    const probe = (await page.evaluate(RAIL_PROBE)) as RailProbe | null;
    const where = `at scroll ratio ${ratio}: ${JSON.stringify(probe)}`;
    expect(probe, where).not.toBeNull();
    expect(probe!.ticks, where).toBe(24);
    // The regression this locks: the rail's own height tracked the transcript
    // (~32000px against a ~780px scrollport), not the ticks it holds.
    expect(probe!.railHeight, where).toBeLessThanOrEqual(probe!.scrollportHeight);
    expect(probe!.insetTop, where).toBeGreaterThanOrEqual(0);
    expect(probe!.insetBottom, where).toBeGreaterThanOrEqual(0);
    expect(probe!.insetRight, where).toBeGreaterThanOrEqual(0);
  }
});

/**
 * The rail centres itself on the usable band, which is the scrollport minus
 * the sticky composer dock. Centring on the bare scrollport put the lower
 * ticks over the dock — 122px of overlap at 1240x617 — where they sit on top
 * of the frosted blur and the composer card.
 *
 * Window height is the variable, not width: the dock's height is fixed by its
 * content while the scrollport shrinks around it, so a short window is where
 * the band runs out first.
 */
test('the rail clears the composer dock at every window height', async ({ longTranscriptWindow: page }) => {
  await settled(page, 24);

  for (const height of [860, 700, 617, 500]) {
    await page.setViewportSize({ width: 1240, height });
    await expect.poll(() => page.evaluate(() => window.innerHeight)).toBe(height);

    // Both ends of the scroll. The bottom is the load-bearing one: a sticky
    // offset is clamped by its containing block, and the chat shell ends above
    // the scrollport's bottom edge (the dock's box follows it in flow), so an
    // anchor parked mid-scrollport gets dragged upward exactly there — off the
    // top of the scrollport at short window heights.
    for (const ratio of [0, 1]) {
      await scrollToRatio(page, ratio);
      // The dock measurement reaches the rail through a ResizeObserver, one
      // layout after the resize lands.
      await expect
        .poll(async () => ((await page.evaluate(RAIL_PROBE)) as RailProbe | null)?.dockClearance)
        .toBeGreaterThanOrEqual(0);

      const probe = (await page.evaluate(RAIL_PROBE)) as RailProbe;
      const where = `at ${height}px tall, scroll ratio ${ratio}: ${JSON.stringify(probe)}`;
      // The outcome, not the mechanism: the rail sits on the centreline of the
      // band above the dock, at both ends of the scroll. `anchorFromScrollportTop`
      // rides along in the diagnostics because a non-zero reading here is the
      // sticky clamp, which is what dragged the rail off the top before.
      expect(probe.railCentre, where).toBe(probe.bandCentre);
      expect(probe.insetTop, where).toBeGreaterThanOrEqual(0);
      // And every tick is the topmost element at its own centre — the rail is
      // not merely visible over the dock, it is what a pointer would hit.
      expect(await unreachableTicks(page), where).toEqual([]);
    }
  }
});

test('clicking a tick jumps to that prompt', async ({ longTranscriptWindow: page }) => {
  await settled(page, 24);
  await scrollToRatio(page, 1);

  // Fixture windows don't pass OS hit-testing, so a synthesised mouse move
  // never lands — hence `dispatchEvent` here, as elsewhere in this suite.
  // What that leaves untested is whether anything covers the tick, which is
  // what `unreachableTicks` (a real `elementFromPoint` at the tick's centre)
  // answers, including for the last tick at the bottom of the transcript.
  expect(await unreachableTicks(page)).toEqual([]);
  const firstTick = page.locator('.maka-prompt-rail-tick').first();
  await firstTick.dispatchEvent('click');

  // The first prompt's turn comes to rest at the top of the scrollport, which
  // is a scroll the smooth behaviour has to finish first.
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const scroller = document.querySelector<HTMLElement>('[data-chat-scroll-container="true"]');
        const firstTurn = scroller?.querySelector<HTMLElement>('.maka-turn');
        if (!scroller || !firstTurn) return null;
        return Math.round(firstTurn.getBoundingClientRect().top - scroller.getBoundingClientRect().top);
      }),
    )
    .toBeLessThanOrEqual(1);

  await expect(firstTick).toHaveAttribute('aria-current', 'true');
});

/**
 * A turn only becomes current once it reaches the top third of the scrollport.
 * A conversation that ends on a one-line answer has no scroll left to bring
 * its last turn up there, so the end of the scroller has to be resolved
 * explicitly — otherwise the reader sits at the bottom with `aria-current`
 * stranded on the previous prompt.
 */
test('the last prompt is current once the transcript is scrolled to the end', async ({ shortFinalTurnWindow: page }) => {
  await settled(page, 6);
  const ticks = page.locator('.maka-prompt-rail-tick');
  await expect(ticks).toHaveCount(6);

  await scrollToRatio(page, 0);
  await expect(ticks.last()).not.toHaveAttribute('aria-current', 'true');

  await scrollToRatio(page, 1);
  await expect(ticks.last()).toHaveAttribute('aria-current', 'true');
  // The final turn really is short enough to never cross the activation band,
  // so the assertion above is about the end-of-scroller rule and not about a
  // tall turn that happened to climb into it.
  const finalTurnTop = await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('[data-chat-scroll-container="true"]')!;
    const turns = [...scroller.querySelectorAll<HTMLElement>('.maka-turn')];
    const last = turns[turns.length - 1]!;
    const s = scroller.getBoundingClientRect();
    return {
      fromTop: Math.round(last.getBoundingClientRect().top - s.top),
      activationBand: Math.round(s.height * 0.34),
    };
  });
  expect(finalTurnTop.fromTop, JSON.stringify(finalTurnTop)).toBeGreaterThan(finalTurnTop.activationBand);
});

/**
 * The rail shares the right edge with the session workbar, and the sidebar
 * takes width off the left. Both change the chat column's box rather than the
 * rail's own rules, which is exactly the kind of thing a fixed-viewport test
 * never sees.
 */
test('the rail survives the sidebar and workbar being open', async ({ longTranscriptWindow: page }) => {
  await settled(page, 24);
  await page.locator('button[aria-label="展开侧边栏"]').dispatchEvent('click');
  await expect(page.locator('[data-sidebar-state="expanded"]')).toBeAttached();

  const workbar = page.getByRole('complementary', { name: '会话工作栏' });
  if (!(await workbar.isVisible())) {
    await page.getByRole('button', { name: '展开会话工作栏' }).dispatchEvent('click');
  }
  await expect(workbar).toBeVisible();

  await scrollToRatio(page, 1);
  const probe = (await page.evaluate(RAIL_PROBE)) as RailProbe;
  const where = `sidebar + workbar open: ${JSON.stringify(probe)}`;
  expect(probe.ticks, where).toBe(24);
  expect(probe.insetTop, where).toBeGreaterThanOrEqual(0);
  expect(probe.insetBottom, where).toBeGreaterThanOrEqual(0);
  expect(probe.insetRight, where).toBeGreaterThanOrEqual(0);
  expect(probe.dockClearance, where).toBeGreaterThanOrEqual(0);
  expect(await unreachableTicks(page), where).toEqual([]);
});

/**
 * Past its cap the rail is a scroller in its own right, and marking a tick
 * active is then not enough: the tick can sit outside the rail's own viewport,
 * where it is neither visible nor clickable. Scrolling a 90-prompt transcript
 * to the end put the last tick exactly there while the rail stayed at
 * scrollTop 0.
 */
test('the active tick stays visible once the rail overflows', async ({ overflowingRailWindow: page }) => {
  await settled(page, 90);
  await expect(page.locator('.maka-prompt-rail-tick')).toHaveCount(90);

  // The premise: this fixture exists to put the rail past its cap. If it ever
  // stops overflowing, the rest of this test proves nothing.
  const capped = await activeTickVisibility(page);
  expect(capped.railScrollHeight, JSON.stringify(capped)).toBeGreaterThan(capped.railClientHeight);

  await scrollToRatio(page, 1);
  await expect(page.locator('.maka-prompt-rail-tick').last()).toHaveAttribute('aria-current', 'true');

  const atEnd = await activeTickVisibility(page);
  const where = JSON.stringify(atEnd);
  expect(atEnd.found, where).toBe(true);
  // Visible inside the rail, and what a pointer at its centre would land on —
  // the two halves of "reachable" that a bare `aria-current` does not imply.
  expect(atEnd.fullyInsideRail, where).toBe(true);
  expect(atEnd.hitsActiveTick, where).toBe(true);
  // And the rail had to scroll to get there, so this is the fix working rather
  // than the tick happening to start on screen.
  expect(atEnd.railScrollTop, where).toBeGreaterThan(0);

  // Symmetrically, going back to the top brings the first tick back into the
  // rail's viewport instead of stranding it above.
  await scrollToRatio(page, 0);
  await expect(page.locator('.maka-prompt-rail-tick').first()).toHaveAttribute('aria-current', 'true');
  const atStart = await activeTickVisibility(page);
  const back = JSON.stringify({ atStart, atEnd });
  expect(atStart.fullyInsideRail, back).toBe(true);
  expect(atStart.hitsActiveTick, back).toBe(true);
  // Scrolled back up, not merely still wherever the end left it. Not asserted
  // as exactly 0: bringing the first tick flush leaves the rail's own top
  // padding scrolled through.
  expect(atStart.railScrollTop, back).toBeLessThan(atEnd.railScrollTop);
});

/**
 * The highlight for the prompt being read is one bar that travels, anchored to
 * the active tick with CSS anchor positioning. That fails silently — an
 * unresolved anchor still renders the bar, just parked at a fixed offset — and
 * it broke exactly that way first time round, because Astryx's HoverCard sets
 * its own inline `anchor-name` on the trigger it wraps (hence the anchor
 * living on the tick's inner bar). Only a live window can tell a tracking
 * highlight from a stuck one.
 */
test('the highlight travels with the prompt being read', async ({ longTranscriptWindow: page }) => {
  await settled(page, 24);

  const readHighlight = () =>
    page.evaluate(() => {
      const indicator = document.querySelector<HTMLElement>('.maka-prompt-rail-indicator');
      const active = document.querySelector<HTMLElement>('.maka-prompt-rail-tick[data-active="true"]');
      if (!indicator || !active) return null;
      const i = indicator.getBoundingClientRect();
      const a = active.getBoundingClientRect();
      return {
        centreDrift: Math.round(Math.abs(i.top + i.height / 2 - (a.top + a.height / 2))),
        rightDrift: Math.round(Math.abs(i.right - a.right)),
        activeIndex: [...document.querySelectorAll('.maka-prompt-rail-tick')].indexOf(active),
      };
    });

  const seen: number[] = [];
  for (const ratio of [0, 0.35, 0.7]) {
    await scrollToRatio(page, ratio);
    // The glide is a transition on `top`; wait for it to land before reading.
    await page.waitForTimeout(600);
    const highlight = await readHighlight();
    const where = `at scroll ratio ${ratio}: ${JSON.stringify(highlight)}`;
    expect(highlight, where).not.toBeNull();
    expect(highlight!.centreDrift, where).toBeLessThanOrEqual(1);
    expect(highlight!.rightDrift, where).toBeLessThanOrEqual(1);
    seen.push(highlight!.activeIndex);
  }
  // And it actually moved, rather than agreeing with a highlight that never
  // left the first tick.
  expect(new Set(seen).size, JSON.stringify(seen)).toBe(seen.length);
});

/**
 * The rail scrolls itself once it is past its cap, and the highlight is
 * anchored to a tick inside that scroller. Anchor positioning resolves against
 * the anchor's actual box, so the two must stay together through the rail's own
 * scrolling — the case the 24-turn fixture never reaches.
 */
test('the highlight stays on the active tick while the rail scrolls itself', async ({ overflowingRailWindow: page }) => {
  await settled(page, 90);
  await scrollToRatio(page, 1);
  await expect(page.locator('.maka-prompt-rail-tick').last()).toHaveAttribute('aria-current', 'true');
  await page.waitForTimeout(600);

  const reading = await page.evaluate(() => {
    const rail = document.querySelector<HTMLElement>('.maka-prompt-rail')!;
    const indicator = document.querySelector<HTMLElement>('.maka-prompt-rail-indicator')!;
    const active = rail.querySelector<HTMLElement>('.maka-prompt-rail-tick[data-active="true"]')!;
    const i = indicator.getBoundingClientRect();
    const a = active.getBoundingClientRect();
    const railBox = rail.getBoundingClientRect();
    return {
      railScrollTop: Math.round(rail.scrollTop),
      centreDrift: Math.round(Math.abs(i.top + i.height / 2 - (a.top + a.height / 2))),
      indicatorInsideRail: i.top >= railBox.top - 1 && i.bottom <= railBox.bottom + 1,
    };
  });
  const where = JSON.stringify(reading);
  // The rail really did scroll, so the highlight had something to keep up with.
  expect(reading.railScrollTop, where).toBeGreaterThan(0);
  expect(reading.centreDrift, where).toBeLessThanOrEqual(1);
  expect(reading.indicatorInsideRail, where).toBe(true);
});

test('hovering a tick swells its neighbours and settles back', async ({ longTranscriptWindow: page }) => {
  await settled(page, 24);

  const barWidths = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.maka-prompt-rail-tick-bar')].map((bar) =>
        Math.round(Number.parseFloat(getComputedStyle(bar).width)),
      ),
    );

  const rest = await barWidths();
  expect(new Set(rest).size, JSON.stringify(rest)).toBe(1);

  // A real mouse move never lands on a fixture window (no OS hit-testing), but
  // React synthesises the enter/leave pair this reads from bubbling
  // pointerover/pointerout, which do.
  const hovered = 12;
  await page.locator('.maka-prompt-rail-tick').nth(hovered).dispatchEvent('pointerover');
  await page.waitForTimeout(500);

  const swollen = await barWidths();
  const note = JSON.stringify(swollen);
  // A falloff, not a single fat tick: widest under the pointer, then stepping
  // down on both sides until it meets the resting width.
  expect(swollen[hovered], note).toBeGreaterThan(swollen[hovered - 1]!);
  expect(swollen[hovered - 1], note).toBeGreaterThan(swollen[hovered - 2]!);
  expect(swollen[hovered], note).toBeGreaterThan(swollen[hovered + 1]!);
  expect(swollen[hovered + 1], note).toBeGreaterThan(swollen[hovered + 2]!);
  expect(swollen[hovered - 3], note).toBe(rest[0]);
  expect(swollen[hovered + 3], note).toBe(rest[0]);

  await page.evaluate((index) => {
    const tick = document.querySelectorAll('.maka-prompt-rail-tick')[index]!;
    tick.dispatchEvent(
      new PointerEvent('pointerout', { bubbles: true, composed: true, relatedTarget: document.body }),
    );
  }, hovered);
  await page.waitForTimeout(500);
  expect(await barWidths()).toEqual(rest);
});
