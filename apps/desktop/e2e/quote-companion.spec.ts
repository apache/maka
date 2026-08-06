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
  for (let i = 0; i < 6; i += 1) {
    await composer.fill(`scroll follow source ${i}`);
    await composer.press('Enter');
    await expect(
      page.getByText(new RegExp(`Fake backend received: scroll follow source ${i}`)).last(),
    ).toBeVisible();
  }

  await page
    .getByText(/Fake backend received: scroll follow source 4/)
    .last()
    .evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });

  const quoteLayer = page.locator('.maka-quote-actions');
  await expect(quoteLayer).toBeVisible();
  const selectionTop = () =>
    page.evaluate(() => window.getSelection()?.getRangeAt(0).getBoundingClientRect().top ?? null);
  const layerBefore = await quoteLayer.boundingBox();
  const selectionBefore = await selectionTop();

  await page.mouse.move(700, 350);
  await page.mouse.wheel(0, -220);

  // The layer tracks the selection rather than merely surviving the scroll.
  await expect
    .poll(async () => {
      const layerAfter = await quoteLayer.boundingBox();
      const selectionAfter = await selectionTop();
      if (!layerAfter || !layerBefore || selectionAfter === null || selectionBefore === null) {
        return null;
      }
      const selectionShift = selectionAfter - selectionBefore;
      if (selectionShift === 0) return null;
      return Math.abs(layerAfter.y - layerBefore.y - selectionShift) <= 1;
    })
    .toBe(true);
});
