import { test, expect } from './fixtures';

/**
 * Scroll-geometry contract for content-visibility chat turns.
 *
 * `.maka-turn` renders off-screen turns at a 250px contain-intrinsic-size
 * placeholder. On a fresh mount of a long session that geometry is a ~25x
 * underestimate, which used to (a) strand the pinned viewport mid-document
 * once turns inflated (inflation fires no mutation and no scroll event) and
 * (b) make upward scrolling "endless": the document grew turn by turn while
 * scroll anchoring kept repositioning. The idle warm-up + the pinned-bottom
 * ResizeObserver channel fix both; this spec locks the two user-visible
 * invariants.
 *
 * Probes read only scroller metrics. Per-turn getBoundingClientRect would
 * force-render skipped turns and mask the regression being tested.
 */

const probeScroller = `(() => {
  const scroller = document.querySelector('[data-chat-scroll-container="true"]');
  return {
    scrollHeight: scroller.scrollHeight,
    clientHeight: scroller.clientHeight,
    distanceFromBottom: Math.round(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight),
  };
})()`;

// The fixture's 24 turns are 60 filler lines each (>1000px real, 250px as a
// placeholder), so the whole transcript is ~15k px un-warmed vs ~40k warmed.
// Asserted once the walk reports itself done, as a guard that it actually
// rewrote the placeholder geometry rather than finishing over nothing.
const WARMED_HEIGHT_FLOOR = 24 * 800;

/**
 * Wait for the warm-up's own terminal state, which the scroller publishes as
 * `data-turn-warmup="settled"`.
 *
 * This used to be inferred: no chunk currently forced, final-scale height, and
 * two consecutive 500ms reads agreeing. The walk is chunked and pauses between
 * chunks, so that describes an idle gap just as well as the end — under 50x CPU
 * throttling this suite reports two 29068px reads in a row with 8 of 24 turns
 * still un-warmed and a final height of 40452px, i.e. a "settled" that is a
 * third short. The same guess fails the other way whenever the sampler keeps
 * straddling chunk boundaries: every read differs from the last, the predicate
 * is false for all 30 samples, and the poll dies on its budget while the
 * warm-up is working normally.
 *
 * Neither is a slow machine; both are the criterion. The walk knows when it is
 * done, so ask it.
 */
async function settleGeometry(page: import('@playwright/test').Page, options: { pinned: boolean }): Promise<void> {
  await expect(page.locator('[data-chat-scroll-container="true"][data-turn-warmup="settled"]')).toBeAttached({ timeout: 15_000 });
  const settled = await page.evaluate(probeScroller) as { scrollHeight: number };
  expect(settled.scrollHeight, JSON.stringify(settled)).toBeGreaterThan(WARMED_HEIGHT_FLOOR);
  // The last chunk's inflation reaches the pinned follower through a
  // ResizeObserver, one layout after the walk hands back. A fully pinned
  // scroller can read distance 1 rather than 0: Chromium keeps sub-pixel
  // scrollTop values (observed 30106.5), so the rounded distance lands on 1
  // even though the content is flush. The contract is "flush", so accept both.
  if (options.pinned) {
    await expect.poll(async () => (await page.evaluate(probeScroller)).distanceFromBottom).toBeLessThanOrEqual(1);
  }
}

// Column centerline / empty-chat flush used to live here as live box metrics.
// Those outcomes are owned by `.maka-chat-layout` flex contracts
// (chat-shell-layout-contract.test.ts). This file only keeps content-visibility
// pin/warm-up behaviour that a static CSS read cannot prove.

test('long session opens pinned to bottom and stays pinned while geometry settles', async ({ longTranscriptWindow: page }) => {
  await expect(page.locator('.maka-turn')).toHaveCount(24);

  // Pinned from the start: the session-open pin must hold. During the idle
  // warm-up the document grows by thousands of pixels with no mutation and
  // no scroll event — the follower must ride every growth step, so the
  // distance stays within 1px (sub-pixel scrollTop; see settleGeometry)
  // while scrollHeight rises to its final value.
  await expect.poll(async () => (await page.evaluate(probeScroller)).distanceFromBottom).toBeLessThanOrEqual(1);

  // And the pin still holds once the walk reports itself done, which is what
  // makes the poll above a contract rather than a lucky early read.
  await settleGeometry(page, { pinned: true });

  const bottomBoundary = await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('[data-chat-scroll-container="true"]');
    const lastTurn = scroller?.querySelector<HTMLElement>('.maka-turn:last-of-type');
    const dock = scroller?.lastElementChild;
    if (!lastTurn || !dock) throw new Error('Expected the final turn and Astryx dock');
    return {
      dockTop: dock.getBoundingClientRect().top,
      lastTurnBottom: lastTurn.getBoundingClientRect().bottom,
    };
  });
  expect(
    bottomBoundary.lastTurnBottom,
    JSON.stringify(bottomBoundary),
  ).toBeLessThanOrEqual(bottomBoundary.dockTop + 1);
  expect(
    bottomBoundary.dockTop - bottomBoundary.lastTurnBottom,
    JSON.stringify(bottomBoundary),
  ).toBeLessThanOrEqual(48);
});

test('the composer card rests above the window edge at every window height', async ({ longTranscriptWindow: page }) => {
  // Which density tier the dock runs at is a unit contract
  // (`chat-surface-layout.test.tsx`); the px it resolves to belongs to Astryx.
  // What only a live window can answer is whether the card stays inside the
  // frame: the dock is sticky-bottom, so a short window is exactly where a
  // wrong flex or min-height contract lets it render past the edge — and the
  // gutter alone cannot see that, because it is measured against the layout
  // box that would be overflowing.
  const probe = () =>
    page.evaluate(() => {
      const composer = document.querySelector<HTMLElement>('.maka-composer');
      const layout = composer?.closest<HTMLElement>('.maka-chat-layout');
      if (!composer || !layout) return null;
      const card = composer.getBoundingClientRect().bottom;
      return {
        gutter: Math.round(layout.getBoundingClientRect().bottom - card),
        belowWindowEdge: Math.round(card - window.innerHeight),
      };
    });

  const gutters: number[] = [];
  for (const height of [860, 617, 500]) {
    await page.setViewportSize({ width: 915, height });
    // Wait for the renderer to have laid out against the new viewport before
    // reading geometry, or the first sample is the previous height's.
    await expect.poll(() => page.evaluate(() => window.innerHeight)).toBe(height);
    await expect
      .poll(async () => (await probe())?.belowWindowEdge)
      // Zero or less: the card is inside the window, not merely inside a layout
      // box that has itself overflowed.
      .toBeLessThanOrEqual(0);
    const reading = await probe();
    // Positive, so the card's rounded bottom edge never touches the frame.
    expect(reading!.gutter, `gutter at ${height}px`).toBeGreaterThan(0);
    gutters.push(reading!.gutter);
  }
  // Height-invariant: the gutter is the dock's own padding, so all three agree.
  expect(new Set(gutters).size, JSON.stringify(gutters)).toBe(1);
});

test('graph status stays docked above the composer while transcript history scrolls', async ({ longTranscriptWindow: page }) => {
  await settleGeometry(page, { pinned: true });
  const graphPanel = page.locator('.maka-agent-graph-panel');
  await expect(graphPanel).toBeVisible();

  const before = await graphPanel.boundingBox();
  expect(before).not.toBeNull();
  await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('[data-chat-scroll-container="true"]');
    if (!scroller) throw new Error('Expected the Astryx chat scroller');
    scroller.scrollTop = 0;
  });
  const after = await graphPanel.boundingBox();
  expect(after).not.toBeNull();
  if (before && after) {
    expect(Math.abs(after.y - before.y), JSON.stringify({ before, after })).toBeLessThanOrEqual(1);
  }
});

async function climbToTop(page: import('@playwright/test').Page) {
  return await page.evaluate(async () => {
    const scroller = document.querySelector('[data-chat-scroll-container="true"]') as HTMLElement;
    const started = performance.now();
    // Self-imposed deadline well under the 60s test timeout: a stalled or
    // crawling compositor must produce a diagnosable assertion failure with
    // the numbers below, never a test-timeout hang inside this evaluate
    // ("Target page ... closed" says nothing).
    const deadline = started + 30_000;
    let frames = 0;
    let maxFrameGapMs = 0;
    const frame = () => new Promise<void>((resolve) => {
      const t0 = performance.now();
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        maxFrameGapMs = Math.max(maxFrameGapMs, performance.now() - t0);
        resolve();
      };
      requestAnimationFrame(() => requestAnimationFrame(() => { frames += 2; finish(); }));
      // Watchdog: never wait on a compositor that stopped ticking.
      setTimeout(finish, 2_000);
    });
    scroller.scrollTop = scroller.scrollHeight;
    await frame();
    const heights = new Set<number>([scroller.scrollHeight]);
    let steps = 0;
    // Viewport-sized steps, like a fast user scroll. The cap is a runaway
    // guard far above the honest step count.
    for (; steps < 120; steps++) {
      if (performance.now() > deadline) break;
      scroller.scrollBy(0, -scroller.clientHeight);
      await frame();
      heights.add(scroller.scrollHeight);
      if (scroller.scrollTop === 0) break;
    }
    return {
      atTop: scroller.scrollTop === 0,
      distinctHeights: [...heights],
      steps,
      honestSteps: Math.ceil(scroller.scrollHeight / scroller.clientHeight),
      frames,
      maxFrameGapMs: Math.round(maxFrameGapMs),
      elapsedMs: Math.round(performance.now() - started),
      timedOut: performance.now() > deadline,
    };
  });
}

function expectHonestClimb(run: Awaited<ReturnType<typeof climbToTop>>): void {
  const diagnostics = JSON.stringify(run);
  // A climb that hit the deadline or was paced by the watchdog instead of
  // real frames proves nothing about geometry — fail with the frame stats.
  expect(run.timedOut, diagnostics).toBe(false);
  expect(run.maxFrameGapMs, diagnostics).toBeLessThan(2_000);
  expect(run.atTop, diagnostics).toBe(true);
  // One height for the whole climb: no placeholder inflated mid-scroll.
  expect(run.distinctHeights, diagnostics).toHaveLength(1);
  // And the climb took the honest number of steps — the "endless scroll"
  // symptom was precisely needing ~2x more.
  expect(run.steps, diagnostics).toBeLessThanOrEqual(run.honestSteps + 2);
}

test('scrolling a settled long session to the top never inflates the document', async ({ longTranscriptWindow: page }) => {
  await expect(page.locator('.maka-turn')).toHaveCount(24);

  // Wait for the warm-up to settle so this test isolates invariant (b);
  // the pinned test above owns the during-warm-up behavior.
  await settleGeometry(page, { pinned: false });

  expectHonestClimb(await climbToTop(page));
});

test('returning to the session after visiting skills re-settles the new transcript DOM', async ({ longTranscriptWindow: page }) => {
  await expect(page.locator('.maka-turn')).toHaveCount(24);
  await settleGeometry(page, { pinned: true });

  // A mode switch unmounts the chat scroller; coming back rebuilds every
  // `.maka-turn` node with no remembered size, so the warm-up must walk the
  // NEW DOM. Fixture windows don't pass OS hit-testing — dispatch clicks.
  await page.locator('button[aria-label="展开侧边栏"]').dispatchEvent('click');
  await page
    .getByRole('navigation', { name: '对话列表' })
    .getByRole('button', { name: '扩展', exact: true })
    .dispatchEvent('click');
  await expect(page.locator('.maka-turn')).toHaveCount(0);
  await page.getByText('超长会话滚动几何').first().dispatchEvent('click');
  await expect(page.locator('.maka-turn')).toHaveCount(24);

  await settleGeometry(page, { pinned: true });
  expectHonestClimb(await climbToTop(page));
});
