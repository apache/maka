import { expect, test, COMPOSER_INPUT } from './fixtures';

test('a transcript drag releases outside the window through its owning Turn', async ({
  window: page,
}) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('pointer capture source');
  await composer.press('Enter');

  const reply = page.getByText(/Fake backend received: pointer capture source/);
  await expect(reply).toBeVisible();
  // Select from a settled answer. Selecting from a streaming one is broken for
  // an unrelated reason — see the fixme below — and this test exists to pin the
  // pointer-capture contract, not Selection survival across a stream close.
  await expect(page.getByRole('button', { name: '重新生成' })).toHaveCount(1, {
    timeout: 20_000,
  });
  const turn = reply.locator('xpath=ancestor::*[@data-turn-id][1]');
  const quoteLayer = page.locator('.maka-quote-actions');
  await turn.evaluate((element) => {
    const owner = element as HTMLElement;
    owner.addEventListener('gotpointercapture', (event) => {
      owner.dataset.e2eCapturedPointer = String((event as PointerEvent).pointerId);
    });
    owner.addEventListener('pointerup', () => {
      owner.dataset.e2eCapturedPointerUp = 'true';
    });
    document.addEventListener('selectionchange', () => {
      owner.dataset.e2eSelectionChanged = 'true';
    });
  });

  const bounds = await reply.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const rect = range.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  if (bounds.width < 8 || bounds.height < 1) {
    throw new Error('quote selection source has no visible text bounds');
  }
  const y = bounds.y + bounds.height / 2;
  const startX = bounds.x + 2;
  const selectedX = bounds.x + bounds.width - 2;

  // Ignore any collapsed selectionchange left by the Composer focus change;
  // the marker below must come from this drag while capture is active.
  await turn.evaluate((element) => {
    const owner = element as HTMLElement;
    delete owner.dataset.e2eSelectionChanged;
  });

  // Pointer capture must route the physical release back to the owning Turn
  // after the mouse leaves the renderer viewport.
  await page.mouse.move(startX, y);
  await page.mouse.down();
  await page.mouse.move(selectedX, y, { steps: 5 });
  await expect(turn).toHaveAttribute('data-e2e-captured-pointer', /\d+/);
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.isCollapsed === false))
    .toBe(true);
  await expect(turn).toHaveAttribute('data-e2e-selection-changed', 'true');
  // Leave through the transcript side of the viewport. Exiting through the
  // left would drag across the navigation rail and correctly turn this into a
  // cross-scope Selection, which the quote resolver must reject.
  await page.mouse.move(1220, y, { steps: 5 });
  await page.mouse.up();

  await expect(turn).toHaveAttribute('data-e2e-captured-pointer-up', 'true');
  await expect(quoteLayer).toBeVisible();
});

// Known broken, kept visible rather than described in a PR nobody re-reads.
// Selecting inside a still-streaming answer loses the Selection when the
// stream closes: the markdown renderer rebuilds the paragraph's inline
// fragments, the browser discards the Selection those nodes held, and it does
// so without a `selectionchange` — so the quote hook, which re-reads the
// Selection 350ms after pointer release, finds nothing to offer.
//
// Not fixable from this repo as it stands: the rebuild is inside
// @astryxdesign/core, and pinning the `isStreaming` / `settledText` props that
// drive it still reproduces. Closing this needs an upstream fix, or a decision
// to snapshot the quote at pointerup — which would show a quote bar over text
// whose highlight the browser has already erased.
test.fixme('a drag begun while the answer streams still offers a quote', async ({
  window: page,
}) => {
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('pointer capture source');
  await composer.press('Enter');

  const reply = page.getByText(/Fake backend received: pointer capture source/);
  await expect(reply).toBeVisible();
  const bounds = await reply.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const rect = range.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  const y = bounds.y + bounds.height / 2;
  await page.mouse.move(bounds.x + 2, y);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width - 2, y, { steps: 5 });
  await page.mouse.up();

  // Assert the contract that is actually broken, not the quote bar: the bar is
  // also reachable while the gap is open, because the hook's 350ms read can win
  // the race against the stream close and leave a bar standing over a Selection
  // the browser has already erased. Wait for the close, then require the
  // Selection to still be there — that is the state the quote hook needs and
  // the one the fragment rebuild destroys.
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.isCollapsed === false))
    .toBe(true);
  await expect(page.getByRole('button', { name: '重新生成' })).toHaveCount(1, {
    timeout: 20_000,
  });
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.isCollapsed === false))
    .toBe(true);
});
