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
  const scroller = document.querySelector('.maka-chatViewport');
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

type ColumnGeometry = {
  hostLeft: number;
  viewportLeft: number;
  hostViewportLeftDelta: number;
  turnCenter: number;
  composerCenter: number;
  turnComposerCenterDelta: number;
  hostDisplay: string;
  hostFlexDirection: string;
  hostGap: string;
};

async function probeColumnGeometry(page: import('@playwright/test').Page): Promise<ColumnGeometry> {
  return await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('.maka-chat.messages');
    const viewport = document.querySelector<HTMLElement>('.maka-chatViewport');
    const turn = document.querySelector<HTMLElement>('.maka-turn');
    const composer = document.querySelector<HTMLElement>('.composer .maka-composer-inner');
    if (!host || !viewport || !turn || !composer) {
      throw new Error('Expected the active chat host, viewport, turn, and composer to be mounted');
    }

    const hostRect = host.getBoundingClientRect();
    const viewportRect = viewport.getBoundingClientRect();
    const turnRect = turn.getBoundingClientRect();
    const composerRect = composer.getBoundingClientRect();
    const hostStyle = getComputedStyle(host);
    return {
      hostLeft: hostRect.left,
      viewportLeft: viewportRect.left,
      hostViewportLeftDelta: viewportRect.left - hostRect.left,
      turnCenter: turnRect.left + turnRect.width / 2,
      composerCenter: composerRect.left + composerRect.width / 2,
      turnComposerCenterDelta:
        (turnRect.left + turnRect.width / 2) - (composerRect.left + composerRect.width / 2),
      hostDisplay: hostStyle.display,
      hostFlexDirection: hostStyle.flexDirection,
      hostGap: hostStyle.gap,
    };
  });
}

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
  await expect(page.locator('.maka-chatViewport[data-turn-warmup="settled"]')).toBeAttached({ timeout: 15_000 });
  const settled = await page.evaluate(probeScroller) as { scrollHeight: number };
  expect(settled.scrollHeight, JSON.stringify(settled)).toBeGreaterThan(WARMED_HEIGHT_FLOOR);
  // The last chunk's inflation reaches the pinned follower through a
  // ResizeObserver, one layout after the walk hands back.
  if (options.pinned) {
    await expect.poll(async () => (await page.evaluate(probeScroller)).distanceFromBottom).toBe(0);
  }
}

test('chat viewport and message column share the composer centerline', async ({ longTranscriptWindow: page }) => {
  await expect(page.locator('.maka-turn')).toHaveCount(24);

  for (const width of [900, 1180, 1440]) {
    await page.setViewportSize({ width, height: 760 });
    const geometry = await probeColumnGeometry(page);
    const diagnostics = JSON.stringify({ width, ...geometry });
    expect(Math.abs(geometry.hostViewportLeftDelta), diagnostics).toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.turnComposerCenterDelta), diagnostics).toBeLessThanOrEqual(1);
  }
});

test('empty chat keeps its grid content flush with the viewport', async ({ window: page }) => {
  const content = page.locator('.mainColumn[data-home-surface="true"] .maka-chatContent');
  await expect(content).toBeVisible();

  for (const width of [900, 1180, 1440]) {
    await page.setViewportSize({ width, height: 760 });
    const geometry = await page.evaluate(() => {
      const host = document.querySelector<HTMLElement>('.maka-chat.messages');
      const viewport = document.querySelector<HTMLElement>('.maka-chatViewport');
      const content = document.querySelector<HTMLElement>('.maka-chatContent');
      if (!host || !viewport || !content) throw new Error('Expected the empty chat scroll surface');
      const hostRect = host.getBoundingClientRect();
      const viewportRect = viewport.getBoundingClientRect();
      const contentStyle = getComputedStyle(content);
      return {
        hostViewportLeftDelta: viewportRect.left - hostRect.left,
        contentDisplay: contentStyle.display,
        contentGap: contentStyle.gap,
      };
    });
    const diagnostics = JSON.stringify({ width, ...geometry });
    expect(Math.abs(geometry.hostViewportLeftDelta), diagnostics).toBeLessThanOrEqual(1);
    expect(geometry.contentDisplay, diagnostics).toBe('grid');
    expect(geometry.contentGap, diagnostics).toBe('0px');
  }
});

test('chat turns keep twelve pixels of vertical separation', async ({ longTranscriptWindow: page }) => {
  await expect(page.locator('.maka-turn')).toHaveCount(24);

  const gap = await page.evaluate(() => {
    const turns = document.querySelectorAll<HTMLElement>('.maka-turn');
    const first = turns[0]?.getBoundingClientRect();
    const second = turns[1]?.getBoundingClientRect();
    if (!first || !second) throw new Error('Expected two chat turns');
    return second.top - first.bottom;
  });
  expect(gap).toBe(12);
});

test('long session opens pinned to bottom and stays pinned while geometry settles', async ({ longTranscriptWindow: page }) => {
  await expect(page.locator('.maka-turn')).toHaveCount(24);

  // Pinned from the start: the session-open pin must hold. During the idle
  // warm-up the document grows by thousands of pixels with no mutation and
  // no scroll event — the follower must ride every growth step, so the
  // distance stays 0 while scrollHeight rises to its final value.
  await expect.poll(async () => (await page.evaluate(probeScroller)).distanceFromBottom).toBe(0);

  // And the pin is still 0 once the walk reports itself done, which is what
  // makes the poll above a contract rather than a lucky early read.
  await settleGeometry(page, { pinned: true });
});

async function climbToTop(page: import('@playwright/test').Page) {
  return await page.evaluate(async () => {
    const scroller = document.querySelector('.maka-chatViewport') as HTMLElement;
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
  await page.locator('button[aria-label="扩展"]').dispatchEvent('click');
  await expect(page.locator('.maka-turn')).toHaveCount(0);
  await page.getByText('超长会话滚动几何').first().dispatchEvent('click');
  await expect(page.locator('.maka-turn')).toHaveCount(24);

  await settleGeometry(page, { pinned: true });
  expectHonestClimb(await climbToTop(page));
});
