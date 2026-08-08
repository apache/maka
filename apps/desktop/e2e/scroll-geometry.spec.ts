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

// A switched-to transcript must be AT its latest turn the first time it is
// painted, not travel there. Astryx positions the first fill of its scroller
// instantly and springs every later growth, and that one-shot belongs to the
// hook instance — ChatSurfaceLayout mounts once for the whole shell, so it is
// spent on whichever session was open at boot. Every switch afterwards arrived
// as "later growth" (mount window, fill chunks, warm-up inflation) and the
// scroller spring-flew ~10k px over ~1.2s in front of the reader.
//
// Sampled per frame rather than polled: the regression is an animation, and a
// poll reads it as a sequence of positions that each look reasonable.
test('a session switch lands on the latest turn instead of flying to it', async ({ longTranscriptWindow: page }) => {
  await expect(page.locator('.maka-turn')).toHaveCount(24);
  await settleGeometry(page, { pinned: true });

  // Leave for another seeded session, so returning is a real session switch
  // rather than a section change. Fixture windows don't pass OS hit-testing —
  // dispatch clicks.
  await page.locator('button[aria-label="展开侧边栏"]').dispatchEvent('click');
  await page.getByText('模型管理与工具调用示例').first().dispatchEvent('click');
  await expect(page.locator('[data-turn-id^="long-transcript-turn"]')).toHaveCount(0);

  const watchPromise = page.evaluate(
    () =>
      new Promise<{ maxDistance: number; growthSteps: number; frames: number }>((resolve, reject) => {
        const root = document.querySelector('[data-chat-scroll-container="true"]') as HTMLElement;
        const heights = new Set<number>();
        let maxDistance = 0;
        let frames = 0;
        let settled = false;
        // Assigned below; `fail` and the watchdog reference each other, and
        // neither runs before both exist.
        let watchdog = 0;
        const deadline = performance.now() + 30_000;
        const fail = (why: string) => {
          if (settled) return;
          settled = true;
          clearTimeout(watchdog);
          reject(new Error(`${why} (frames=${frames}, heights=${heights.size}, maxDistance=${maxDistance})`));
        };
        // Watchdog off the frame clock, like climbToTop's: the deadline below
        // is only reached if frames keep arriving, so a compositor that stops
        // ticking would otherwise hang here until the 60s test timeout, whose
        // "Target page closed" says nothing about what the scroller did.
        watchdog = window.setTimeout(() => fail('The frame clock stopped while watching the arrival'), 35_000);
        const finish = (result: { maxDistance: number; growthSteps: number; frames: number }) => {
          if (settled) return;
          settled = true;
          clearTimeout(watchdog);
          resolve(result);
        };
        const sample = () => {
          // Both exits set `settled`, so neither leaves this loop running in a
          // page that is about to close.
          if (settled) return;
          const turns = root.querySelectorAll('[data-turn-id^="long-transcript-turn"]').length;
          if (turns > 0) {
            frames += 1;
            heights.add(root.scrollHeight);
            maxDistance = Math.max(
              maxDistance,
              Math.round(root.scrollHeight - root.scrollTop - root.clientHeight),
            );
          }
          // The arrival is over when the warm-up says the geometry settled and
          // the pin has handed following back to Astryx.
          const arrived =
            turns > 0 &&
            root.dataset.turnWarmup === 'settled' &&
            root.dataset.arrivalPin !== 'pinned';
          if (arrived) {
            finish({ maxDistance, growthSteps: heights.size, frames });
            return;
          }
          if (performance.now() > deadline) {
            fail('The transcript never finished arriving');
            return;
          }
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }),
  );

  await page.getByText('超长会话滚动几何').first().dispatchEvent('click');
  const watch = await watchPromise;
  const diagnostics = JSON.stringify(watch);
  // The document has to have grown under the watch for the distance below to
  // mean anything: the mount window, the idle fill chunks and the warm-up each
  // move it, and a run that observed one height measured nothing.
  expect(watch.growthSteps, diagnostics).toBeGreaterThanOrEqual(3);
  // And the watch has to have looked BETWEEN those steps. A run whose frames
  // all landed on a change never observed a quiet frame — which is precisely
  // where a spring mid-flight would be caught — so the flush assertion below
  // would be reading only the moments the document moved.
  expect(watch.frames, diagnostics).toBeGreaterThan(watch.growthSteps);
  // Flush in EVERY frame the transcript existed, not merely once it settled.
  // Sub-pixel scrollTop leaves the rounded distance on 1 (see settleGeometry).
  expect(watch.maxDistance, diagnostics).toBeLessThanOrEqual(2);
});

// The empty surface is back here as a live metric, unlike the flush contract
// the header notes moved out to static CSS. What centres the hero is the
// ABSENCE of Astryx's push-to-bottom spacer, and the rule that collapses it
// keys on ChatMessageList's internal DOM — a CSS read can only prove the
// selector is written, never that it still matches. Shipped uncollapsed, the
// hero sat 172px below this centre.
test('the empty-chat hero centres in the reading column', async ({ window: page }) => {
  await expect(page.locator('.maka-hero-empty-chat')).toBeVisible();
  const offset = await page.evaluate(() => {
    const hero = document.querySelector('.maka-hero-empty-chat');
    const column = hero?.closest('.maka-chat-message-list');
    if (!hero || !column) throw new Error('Expected the empty-chat hero inside the message list');
    const heroBox = hero.getBoundingClientRect();
    const columnBox = column.getBoundingClientRect();
    return Math.abs((heroBox.top + heroBox.bottom) / 2 - (columnBox.top + columnBox.bottom) / 2);
  });
  expect(offset).toBeLessThanOrEqual(1);
});

// #2052: switching back mounts only the transcript tail; earlier turns arrive
// in idle chunks. The compensation contract: a historical turn the reader is
// anchored on must not move in the viewport while chunks mount above it. The
// unit tests pin the arithmetic; this pins the real Chromium layout and
// timing behind it. The bottom-lock path (re-pin instead of preserve) is
// already covered by the pinned settles above.
test('progressive fill preserves the reading anchor while earlier turns mount', async ({ longTranscriptWindow: page }) => {
  await expect(page.locator('.maka-turn')).toHaveCount(24);
  // Geometry measured under one width is deliberately invalid under another
  // (#2224), and it is only recorded when the width held still from fill to
  // record. The sidebar expansion below finishes AFTER the boot warm-up
  // settles, so the boot visit refuses to record. One priming round trip
  // rebuilds the transcript under the expanded width; that visit records,
  // and the measured journey below returns to a seeded session.
  await page.locator('button[aria-label="展开侧边栏"]').dispatchEvent('click');
  await page.locator('[data-session-id="e2e-fixture-long-transcript"]').waitFor({ timeout: 10_000 });
  await page.getByRole('button', { name: '新任务', exact: true }).dispatchEvent('click');
  await expect(page.locator('.maka-turn')).toHaveCount(0);
  await page.getByText('超长会话滚动几何').first().dispatchEvent('click');
  await expect(page.locator('.maka-turn')).toHaveCount(24);
  await settleGeometry(page, { pinned: true });
  // data-turn-geometry carries the layout key of the record it announces;
  // ask for the record covering the width the return trip will run under.
  await page.waitForFunction(() => {
    const root = document.querySelector<HTMLElement>('[data-chat-scroll-container="true"]');
    if (!root) return false;
    const column = root.querySelector<HTMLElement>('.maka-chat-message-list');
    return root.dataset.turnGeometry === `${(column ?? root).clientWidth}:${root.dataset.density ?? ''}`;
  }, undefined, { timeout: 10_000 });

  // Widen the fill window so the anchor is sampled while chunks are still
  // mounting; unthrottled, an M-series host can finish the whole fill before
  // the first sample.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 20 });

  await page.getByRole('button', { name: '新任务', exact: true }).dispatchEvent('click');
  await expect(page.locator('.maka-turn')).toHaveCount(0);
  // Release the bottom follower the way any upward scroll does (Astryx
  // unlocks on scroll direction, any source), then PROVE the reading state
  // holds before measuring anything: an in-flight spring finishes its
  // current animation regardless of the unlock, and fixture windows swallow
  // real wheel input, so a held position is the only trustworthy signal
  // that the follower is out of the picture. Once held, the anchor is
  // sampled after every fill step and the watch settles the moment the fill
  // completes, so turn-size warm-up inflation (out of scope here, #827
  // machinery) never enters the measurement. A completion observed with
  // zero fill steps proves nothing and fails loudly instead of passing
  // empty.
  const watchPromise = page.evaluate(
    () =>
      new Promise<{ maxDrift: number; fillSteps: number; heightRange: number }>((resolveWatch, rejectWatch) => {
        const root = document.querySelector('[data-chat-scroll-container="true"]') as HTMLElement;
        const guard = window.setTimeout(() => {
          rejectWatch(new Error('Fill did not complete while watching the anchor'));
        }, 45_000);
        const fail = (why: string) => {
          window.clearTimeout(guard);
          rejectWatch(new Error(why));
        };
        const beginWatch = () => {
          // The turn being read: the first whose box still reaches below
          // the topbar.
          const anchor = [...root.querySelectorAll('[data-turn-id]')].find(
            (el) => el.getBoundingClientRect().bottom > 120,
          );
          if (!anchor) {
            fail('Expected a visible turn to anchor on');
            return;
          }
          const baseTop = anchor.getBoundingClientRect().top;
          let turnCount = root.querySelectorAll('[data-turn-id]').length;
          let fillSteps = 0;
          let drift = 0;
          let minHeight = root.scrollHeight;
          let maxHeight = root.scrollHeight;
          const noteHeight = () => {
            minHeight = Math.min(minHeight, root.scrollHeight);
            maxHeight = Math.max(maxHeight, root.scrollHeight);
          };
          const observer = new MutationObserver(() => {
            if (root.dataset.progressiveFill === 'complete') {
              observer.disconnect();
              window.clearTimeout(guard);
              if (fillSteps === 0) {
                rejectWatch(new Error('Fill completed with no step observed; raise the throttle'));
                return;
              }
              noteHeight();
              resolveWatch({ maxDrift: drift, fillSteps, heightRange: maxHeight - minHeight });
              return;
            }
            const count = root.querySelectorAll('[data-turn-id]').length;
            if (count > turnCount) {
              turnCount = count;
              fillSteps += 1;
              drift = Math.max(drift, Math.abs(anchor.getBoundingClientRect().top - baseTop));
              noteHeight();
            }
          });
          observer.observe(root, {
            attributes: true,
            attributeFilter: ['data-progressive-fill'],
            childList: true,
            subtree: true,
          });
        };
        // Armed before the session switch is dispatched: the hold begins in
        // the same task that sets data-progressive-fill, with no protocol
        // round-trip inside the fill window.
        const armed = () => {
          if (root.dataset.progressiveFill === 'filling') {
            tryHold();
            return;
          }
          const armObserver = new MutationObserver(() => {
            if (root.dataset.progressiveFill === 'filling') {
              armObserver.disconnect();
              tryHold();
            }
          });
          armObserver.observe(root, { attributes: true, attributeFilter: ['data-progressive-fill'] });
        };
        let attempts = 0;
        const tryHold = () => {
          if (root.dataset.progressiveFill === 'complete') {
            fail('Fill completed before the anchor held; raise the throttle');
            return;
          }
          attempts += 1;
          if (attempts > 20) {
            fail('The scroller never held an unpinned position');
            return;
          }
          // Astryx's scroll handler skips direction detection whenever
          // scrollHeight changed in the same event, and the fill grows the
          // document every step, so an upward write alone rarely unlocks.
          // The wheel fast path unlocks unconditionally while the spring is
          // animating, and a dispatched WheelEvent reaches that listener
          // even though fixture windows swallow real wheel input.
          //
          // Dispatched at the message list, not the scroller root: the arrival
          // pin's eager release requires the gesture to have started inside the
          // transcript, and a wheel targeting the root is not that. It would
          // still release through the upward write below, but only on a scroll
          // event that no growth shares a rendering update with — a coin flip
          // under CPU throttling, and this loop only gets 20 of them.
          (root.querySelector('.maka-chat-message-list') ?? root).dispatchEvent(
            new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }),
          );
          root.scrollTop = Math.max(0, (root.scrollHeight - root.clientHeight) / 2);
          let held = 0;
          let last = root.scrollTop;
          const check = () => {
            if (root.dataset.progressiveFill === 'complete') {
              fail('Fill completed before the anchor held; raise the throttle');
              return;
            }
            if (root.scrollHeight - root.scrollTop - root.clientHeight < 200) {
              tryHold();
              return;
            }
            if (Math.abs(root.scrollTop - last) < 1) held += 1;
            else {
              held = 0;
              last = root.scrollTop;
            }
            if (held >= 4) {
              beginWatch();
              return;
            }
            requestAnimationFrame(check);
          };
          requestAnimationFrame(check);
        };
        armed();
      }),
  );
  await page.getByText('超长会话滚动几何').first().dispatchEvent('click');
  const watch = await watchPromise;
  expect(watch.fillSteps).toBeGreaterThan(0);
  expect(watch.maxDrift).toBeLessThanOrEqual(2);
  // #2224: the first visit measured every turn, so the return trip holds the
  // unmounted prefix with a spacer and the document's total height stays
  // put while chunks replace it. The bound is sub-pixel rounding at the
  // spacer boundary, far below anything a scrollbar thumb can show.
  expect(watch.heightRange, JSON.stringify(watch)).toBeLessThanOrEqual(8);

  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
});
