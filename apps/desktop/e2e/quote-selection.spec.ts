import { expect, test, COMPOSER_INPUT } from './fixtures';

test('a transcript drag settles when its Turn loses capture or releases outside the window', async ({
  window: page,
}) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('pointer capture source');
  await composer.press('Enter');

  const reply = page.getByText(/Fake backend received: pointer capture source/);
  await expect(reply).toBeVisible();
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
    owner.addEventListener('lostpointercapture', () => {
      owner.dataset.e2eLostPointerCapture = 'true';
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
  const startX = bounds.x + bounds.width - 2;
  const selectedX = bounds.x + 2;

  // Exercise the fallback itself with a browser-generated
  // lostpointercapture event while the selection pointer is still down.
  await page.mouse.move(startX, y);
  await page.mouse.down();
  await page.mouse.move(selectedX, y, { steps: 5 });
  await expect(turn).toHaveAttribute('data-e2e-captured-pointer', /\d+/);
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.isCollapsed === false))
    .toBe(true);
  // Reading Selection state can observe Chromium's new Range before the
  // selectionchange task reaches the hook. Wait for that event so releasing
  // capture cannot race the gesture's changedDuringPointer flag.
  await expect(turn).toHaveAttribute('data-e2e-selection-changed', 'true');
  await turn.evaluate((element) => {
    const owner = element as HTMLElement;
    owner.releasePointerCapture(Number(owner.dataset.e2eCapturedPointer));
  });
  await expect(turn).toHaveAttribute('data-e2e-lost-pointer-capture', 'true');
  await expect(quoteLayer).toBeVisible();
  await page.mouse.up();

  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await expect(quoteLayer).toBeHidden();
  await turn.evaluate((element) => {
    const owner = element as HTMLElement;
    delete owner.dataset.e2eCapturedPointer;
    delete owner.dataset.e2eCapturedPointerUp;
    delete owner.dataset.e2eLostPointerCapture;
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
  await page.mouse.move(-20, y, { steps: 5 });
  await page.mouse.up();

  await expect(turn).toHaveAttribute('data-e2e-captured-pointer-up', 'true');
  await expect(turn).toHaveAttribute('data-e2e-lost-pointer-capture', 'true');
  await expect(quoteLayer).toBeVisible();
});
