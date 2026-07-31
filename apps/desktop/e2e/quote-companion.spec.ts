import { test, expect } from './fixtures';

test('quote companion removes one staged quote, forks, answers, and cleans up on exit', async ({
  window: page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const mainComposer = page.locator('.maka-composer-textarea');
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
  await expect(panel.locator('.maka-composer .maka-quote-chip')).toHaveCount(2);
  await panel.getByRole('button', { name: '移除引用' }).first().click();
  await expect(panel.locator('.maka-composer .maka-quote-chip')).toHaveCount(1);
  await expect(panel.locator('.maka-composer .maka-quote-chip')).toContainText(
    'Fake backend received: quote companion source two',
  );
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
