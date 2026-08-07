import { test, expect, COMPOSER_INPUT } from './fixtures';

/**
 * Quote companion lifecycle: stage selection → side panel → remove one staged
 * quote → fork explore session → send → exit cleans up.
 * Composer chrome only needs token *count* here; full quote text lives in the
 * panel list (Token labels truncate and must not be the source of truth).
 */
test('quote companion removes one staged quote, forks, answers, and cleans up on exit', async ({
  window: page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const mainComposer = page.locator(COMPOSER_INPUT);
  await mainComposer.fill('quote companion source one');
  await mainComposer.press('Enter');

  const firstSourceReply = page.getByText(/Fake backend received: quote companion source one/);
  await expect(firstSourceReply).toBeVisible();
  await mainComposer.fill('quote companion source two');
  await mainComposer.press('Enter');
  const secondSourceReply = page.getByText(/Fake backend received: quote companion source two/);
  await expect(secondSourceReply).toBeVisible();
  const [sourceSession] = await page.evaluate(() => window.maka.sessions.list());
  expect(sourceSession).toBeDefined();

  // Create the same real DOM Range a drag selection would produce. Mutating
  // the selection fires `selectionchange` on its own, which is the hook's only
  // trigger; the click below absorbs the settle delay before the layer shows.
  const stageReply = async (reply: typeof firstSourceReply) => {
    await reply.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    await page.getByRole('button', { name: '在侧栏追问' }).click();
  };
  await stageReply(firstSourceReply);
  await stageReply(secondSourceReply);

  const panel = page.locator('.maka-quote-companion');
  await expect(panel).toBeVisible();

  // Quiet composer stages quotes as drawer Tokens (Astryx Token + remove).
  const quoteTokens = panel.locator('.maka-composer-context-drawer .astryx-token');
  await expect(quoteTokens).toHaveCount(2);
  await quoteTokens.first().getByRole('button', { name: /^移除/ }).click();
  await expect(quoteTokens).toHaveCount(1);

  // Full text authority is the companion panel list, not truncated token labels.
  await expect(
    panel.locator('.maka-quote-panel-quote', {
      hasText: 'Fake backend received: quote companion source one',
    }),
  ).toHaveCount(0);
  await expect(
    panel.locator('.maka-quote-panel-quote', {
      hasText: 'Fake backend received: quote companion source two',
    }),
  ).toBeVisible();

  const companionComposer = panel.locator(COMPOSER_INPUT);
  await companionComposer.fill('explain this quote');
  await companionComposer.press('Enter');
  await expect(panel.getByText(/Fake backend received: explain this quote/)).toBeVisible();
  await expect(quoteTokens).toHaveCount(0);

  await expect
    .poll(async () => (await page.evaluate(() => window.maka.sessions.list())).length)
    .toBe(2);
  const companionSession = (
    await page.evaluate(() => window.maka.sessions.list())
  ).find(({ id }) => id !== sourceSession?.id);
  expect(companionSession?.parentSessionId).toBe(sourceSession?.id);
  expect(companionSession?.permissionMode).toBe('explore');

  await panel.getByRole('button', { name: '退出' }).click();
  await expect(panel).toBeHidden();
  await expect
    .poll(async () => (await page.evaluate(() => window.maka.sessions.list())).length)
    .toBe(1);
});

/**
 * The selection affordance's timing contract. Selecting text is not the same
 * as wanting to quote it — most selections mean "copy" or are a reading habit
 * — so the layer is owed to a settled selection inside a turn, and only that.
 */
test('the quote layer waits for the selection to settle, stays closed after Escape, and ignores the composer', async ({
  window: page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('selection timing source');
  await composer.press('Enter');

  const reply = page.getByText(/Fake backend received: selection timing source/);
  await expect(reply).toBeVisible();

  const quoteLayer = page.locator('.maka-quote-actions');
  const selectContents = (locator: typeof reply) =>
    locator.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });

  // Real drag-select with real mouse events. A drag emits a burst of
  // `selectionchange`, and the gesture below lasts well past the settle delay,
  // so a layer that appeared mid-drag — the original complaint — shows up here.
  const replyBox = (await reply.boundingBox())!;
  const dragY = replyBox.y + replyBox.height / 2;
  await page.mouse.move(replyBox.x + 20, dragY);
  await page.mouse.down();
  for (const dx of [60, 120, 180, 240, 300]) {
    await page.mouse.move(replyBox.x + 20 + dx, dragY);
    await page.waitForTimeout(90);
    await expect(quoteLayer).toBeHidden();
  }
  await page.mouse.up();
  await expect(quoteLayer).toBeVisible();

  // Back to no selection, so the measurement below times a fresh appearance
  // rather than finding the layer this drag already raised.
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await expect(quoteLayer).toBeHidden();

  // Timed inside the page: measuring across the driver would fold IPC latency
  // into the delay and make the assertion depend on host load.
  const appearedAfterMs = await reply.evaluate(async (element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    const startedAt = performance.now();
    selection?.addRange(range);
    await new Promise<void>((resolve, reject) => {
      const deadline = startedAt + 3000;
      const poll = () => {
        if (document.querySelector('.maka-quote-actions')) resolve();
        else if (performance.now() > deadline) reject(new Error('quote layer never appeared'));
        else requestAnimationFrame(poll);
      };
      poll();
    });
    return performance.now() - startedAt;
  });
  // A selection that is still moving has not earned the layer yet: this delay
  // is the whole fix for "it appears the instant I select something".
  expect(appearedAfterMs).toBeGreaterThan(300);
  await expect(quoteLayer).toBeVisible();

  // Escape dismisses, and the dismissal holds: the layer used to come back on
  // the next unrelated keystroke because any keyup re-captured the selection.
  await page.keyboard.press('Escape');
  await expect(quoteLayer).toBeHidden();
  await page.keyboard.press('Shift');
  await page.waitForTimeout(500);
  await expect(quoteLayer).toBeHidden();

  // Selecting inside the composer must not surface a transcript affordance —
  // and must not leave the previous selection's layer standing either.
  await composer.fill('drafted text to select');
  await selectContents(composer);
  await page.waitForTimeout(500);
  await expect(quoteLayer).toBeHidden();
});

/**
 * Scrolling moves the selection, so it must move the layer. The layer used to
 * be cleared on scroll because its position was a snapshot; deriving the
 * position from the live selection instead is what makes following possible.
 */
test('the quote layer follows the selection while the transcript scrolls', async ({
  window: page,
}) => {
  await page.setViewportSize({ width: 1400, height: 700 });
  const composer = page.locator(COMPOSER_INPUT);
  // Long enough that the selected turn can be scrolled clear of the scroller.
  for (let i = 0; i < 14; i += 1) {
    await composer.fill(`scroll follow source ${i}`);
    await composer.press('Enter');
    await expect(
      page.getByText(new RegExp(`Fake backend received: scroll follow source ${i}`)).last(),
    ).toBeVisible();
  }

  await page
    .getByText(/Fake backend received: scroll follow source 11/)
    .last()
    .evaluate((element) => {
      // Centred first: the affordance is owed only to a selection inside the
      // scroller's visible band, and where turn 11 lands depends on the host's
      // font metrics. Without this the test asserts on layout luck.
      element.scrollIntoView({ block: 'center' });
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });

  const quoteLayer = page.locator('.maka-quote-actions');
  await expect(quoteLayer).toBeVisible();

  /**
   * The whole measurement runs inside the page. Scrolling and reading across
   * the driver interleaves round-trips with frames the renderer is still
   * settling in, which pairs a fresh layer position with a stale selection one
   * — the flake this test kept hitting. In here the scroll and both rects are
   * one synchronous layout, and the wait for the layer to catch up is by frame.
   *
   * Writing `scrollTop` rather than sending a wheel: wheel delivery is a
   * host-level detail (it landed nowhere on CI's Linux runner), while what this
   * test is about is the `scroll` event the hook listens to, which a scrollTop
   * write raises just the same.
   */
  const follow = await page.evaluate(async () => {
    let scroller = document.querySelector('.maka-chat-message-list')?.parentElement ?? null;
    while (scroller && scroller.scrollHeight <= scroller.clientHeight) {
      scroller = scroller.parentElement;
    }
    if (!scroller) throw new Error('no scrollable transcript ancestor');

    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    const selectionTop = () =>
      window.getSelection()?.getRangeAt(0).getBoundingClientRect().top ?? null;
    const layerTop = () =>
      document.querySelector('.maka-quote-actions')?.getBoundingClientRect().top ?? null;

    const before = { selection: selectionTop(), layer: layerTop() };
    scroller.scrollTop -= 220;
    const selectionShift = selectionTop()! - before.selection!;

    for (let frame = 0; frame < 120; frame += 1) {
      await nextFrame();
      const now = layerTop();
      if (now !== null && Math.abs(now - before.layer! - selectionShift) <= 1) {
        return { selectionShift, layerShift: now - before.layer! };
      }
    }
    return { selectionShift, layerShift: layerTop() === null ? null : layerTop()! - before.layer! };
  });

  // A scroll that moved nothing would make the assertion below vacuous.
  expect(follow.selectionShift).not.toBe(0);
  // The layer tracks the selection rather than merely surviving the scroll.
  // Sub-pixel tolerance, not exactness: the layer is positioned in CSS pixels
  // and rounded to the device grid, so it lands within a pixel of the anchor.
  expect(Math.abs(follow.layerShift! - follow.selectionShift)).toBeLessThanOrEqual(1);

  // Following stops at the edge of the scroller. Once the anchor leaves the
  // visible band there is nothing to point at, and a bar clamped to the top of
  // the window pointing at off-screen text is the noise this feature exists to
  // avoid. `getBoundingClientRect()` still reports a full-size rect for an
  // off-screen range, so this cannot be left to the zero-size guard.
  await page.evaluate(() => {
    let scroller = document.querySelector('.maka-chat-message-list')?.parentElement ?? null;
    while (scroller && scroller.scrollHeight <= scroller.clientHeight) {
      scroller = scroller.parentElement;
    }
    if (scroller) scroller.scrollTop = 0;
  });
  await expect(quoteLayer).toBeHidden();
});

/**
 * A new selection must not leave the layer standing on the previous one's
 * anchor while the new one settles. Asserted within a frame: the settle timer
 * would clear it ~350ms later anyway, so any auto-waiting assertion passes
 * whether or not the code hides it up front.
 */
test('a new selection hides the layer immediately, not when the next one settles', async ({
  window: page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const composer = page.locator(COMPOSER_INPUT);
  for (const label of ['hide first alpha', 'hide first beta']) {
    await composer.fill(label);
    await composer.press('Enter');
    await expect(page.getByText(new RegExp(`Fake backend received: ${label}`)).last()).toBeVisible();
  }

  const select = (pattern: RegExp) =>
    page
      .getByText(pattern)
      .last()
      .evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      });

  await select(/Fake backend received: hide first alpha/);
  await expect(page.locator('.maka-quote-actions')).toBeVisible();

  const stillVisibleNextFrame = await page
    .getByText(/Fake backend received: hide first beta/)
    .last()
    .evaluate(async (element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return !!document.querySelector('.maka-quote-actions');
    });
  expect(stillVisibleNextFrame).toBe(false);
});
