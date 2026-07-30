import { test, expect } from './fixtures';

/**
 * Core chat loop: type a message, send it, see the deterministic fake backend
 * stream a reply back into the transcript. Depends on the E2E seam: the
 * fixture's MAKA_E2E=1 forces sessions:create onto the fake backend, and the
 * seeded 'e2e' connection clears onboarding so the composer is usable.
 */
test('send a message and see the fake backend stream a reply', async ({ window: page }) => {
  const composer = page.locator('.maka-composer-textarea');
  // #1433: the deleted first-run panel had its own input, and the spec that
  // covered the handoff between the two asserted this accessible name. With
  // one composer left, the name is what a screen-reader user has to find the
  // send target by — assert it on the path that exercises it.
  await expect(composer).toHaveAttribute('aria-label', '消息输入框');
  await composer.fill('hello e2e');
  await composer.press('Enter');

  await expect(page.getByText(/Fake backend received: hello e2e/)).toBeVisible();
  await expect(
    page.locator('.maka-model-switcher-trigger .maka-composer-provider-mark[data-provider="anthropic"] svg'),
  ).toBeVisible();
});

test('copies Markdown code and reports a clipboard failure', async ({ window: page }) => {
  const composer = page.locator('.maka-composer-textarea');
  await composer.fill([
    'show code',
    '',
    '```ts',
    'const answer = 42;',
    '```',
  ].join('\n'));
  await composer.press('Enter');

  const codeBlock = page.locator('[data-maka-contract="markdown"] .astryx-codeblock').last();
  const copyStatus = codeBlock
    .locator('xpath=ancestor::*[@data-maka-contract="markdown"]')
    .getByRole('status');
  await expect(codeBlock).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, 'writeText', {
      configurable: true,
      value: async (text: string) => {
        (window as typeof window & { __copiedCode?: string }).__copiedCode = text;
      },
    });
  });

  await codeBlock.getByRole('button', { name: '复制代码' }).click();
  await expect(copyStatus).toHaveText('已复制代码');
  expect(await page.evaluate(
    () => (window as typeof window & { __copiedCode?: string }).__copiedCode,
  )).toBe('const answer = 42;');

  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, 'writeText', {
      configurable: true,
      value: async () => {
        throw new Error('clipboard denied by test');
      },
    });
  });

  await codeBlock.getByRole('button', { name: '复制代码' }).click();
  await expect(copyStatus).toHaveText('复制代码失败');
});
