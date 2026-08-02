import { test, expect, COMPOSER_INPUT } from './fixtures';

test('shows text-selection actions as one raised top-layer control', async ({ window: page }) => {
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('quote action surface');
  await composer.press('Enter');

  const reply = page.getByText(/Fake backend received: quote action surface/);
  await expect(reply).toBeVisible();
  await reply.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });

  const selectionActions = page.getByRole('group', { name: '引用 / 在侧栏追问' });
  await expect(selectionActions).toBeVisible();
  await expect(selectionActions.locator(':scope > button')).toHaveCount(2);
  const surface = await selectionActions.evaluate((element) => {
    const buttons = [...element.querySelectorAll(':scope > button')];
    const first = buttons[0]?.getBoundingClientRect();
    const second = buttons[1]?.getBoundingClientRect();
    return {
      gap: first && second ? second.left - first.right : Number.NaN,
      shadow: getComputedStyle(element).boxShadow,
      inTopLayer: element.closest('[popover]')?.matches(':popover-open') ?? false,
    };
  });
  expect(surface.gap).toBeCloseTo(0, 5);
  expect(surface.shadow).not.toBe('none');
  expect(surface.inTopLayer).toBe(true);
});

test('keeps a captured selection available through action activation', async ({
  window: page,
}) => {
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('selection action activation');
  await composer.press('Enter');

  const reply = page.getByText(/Fake backend received: selection action activation/);
  await expect(reply).toBeVisible();
  await reply.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });

  const askInSidebar = page.getByRole('button', { name: '在侧栏追问' });
  await askInSidebar.focus();
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await page.evaluate(() =>
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Tab', bubbles: true })),
  );
  await expect(askInSidebar).toBeVisible();
  await askInSidebar.click();

  await expect(page.locator('.maka-quote-companion')).toBeVisible();
});

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

  // Create the same real DOM Range a drag selection would produce, then fire
  // mouseup — the selection hook intentionally captures only finalized ranges.
  const stageReply = async (reply: typeof firstSourceReply) => {
    await reply.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
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
  await quoteTokens.first().getByRole('button', { name: /^Remove / }).click();
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
