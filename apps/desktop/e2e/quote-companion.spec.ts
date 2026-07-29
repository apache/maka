import { test, expect } from './fixtures';

test('quote companion forks, answers, and removes its session on exit', async ({
  window: page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const mainComposer = page.locator('.maka-composer-textarea');
  await mainComposer.fill('quote companion source');
  await mainComposer.press('Enter');

  const sourceReply = page.getByText(/Fake backend received: quote companion source/);
  await expect(sourceReply).toBeVisible();
  const [sourceSession] = await page.evaluate(() => window.maka.sessions.list());
  expect(sourceSession).toBeDefined();

  // Create the same real DOM Range a drag selection would produce, then fire
  // mouseup — the selection hook intentionally captures only finalized ranges.
  await sourceReply.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.getByRole('button', { name: '在侧栏追问' }).click();

  const panel = page.locator('.maka-quote-companion');
  await expect(panel).toBeVisible();
  await expect(
    panel.locator('.maka-quote-panel-quote', {
      hasText: 'Fake backend received: quote companion source',
    }),
  ).toBeVisible();
  await expect(panel.locator('.maka-composer .maka-quote-chip')).toHaveCount(1);

  const companionComposer = panel.locator('.maka-composer-textarea');
  await companionComposer.fill('explain this quote');
  await companionComposer.press('Enter');
  await expect(panel.getByText(/Fake backend received: explain this quote/)).toBeVisible();
  await expect(panel.locator('.maka-composer .maka-quote-chip')).toHaveCount(0);

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
