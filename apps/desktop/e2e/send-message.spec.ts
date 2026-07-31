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
    '',
    'return answer;',
    '```',
  ].join('\n'));
  await composer.press('Enter');

  const codeBlock = page.locator('[data-maka-contract="markdown"] .astryx-codeblock').last();
  const copyStatus = codeBlock
    .locator('xpath=ancestor::*[@data-maka-contract="markdown"]')
    .locator('[data-copy-feedback]');
  const astryxPoliteRegion = page.locator(
    '[data-astryx-live-region="polite"]',
  );
  await expect(codeBlock).toBeVisible();
  await expect(page.getByRole('button', { name: '重新生成' })).toBeVisible();
  await expect(page.locator('.maka-bubble-streaming')).toHaveCount(0);
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, 'writeText', {
      configurable: true,
      value: async (text: string) => {
        (window as typeof window & { __copiedCode?: string }).__copiedCode = text;
      },
    });
  });

  await codeBlock.getByRole('button', { name: '复制代码' }).click();
  await expect(codeBlock.getByRole('button', { name: '已复制代码' })).toBeVisible();
  await expect(copyStatus).toBeVisible();
  await expect(copyStatus).toHaveText('已复制代码');
  await expect(astryxPoliteRegion).toHaveText('已复制代码');
  await expect(page.getByText('Copied', { exact: true })).toHaveCount(0);
  const copiedCode = await page.evaluate(
    () => (window as typeof window & { __copiedCode?: string }).__copiedCode,
  );
  // The fenced-code AST may retain its closing newline. The regression
  // boundary is the exact internal blank line without DOM-only U+200B fillers.
  expect(copiedCode?.replace(/\n$/, '')).toBe(
    'const answer = 42;\n\nreturn answer;',
  );
  expect(copiedCode).not.toContain('\u200B');

  await expect(codeBlock.getByRole('button', { name: '复制代码' })).toBeVisible();

  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, 'writeText', {
      configurable: true,
      value: () => new Promise<void>((resolve) => {
        (window as typeof window & {
          __completeClipboardWrite?: () => void;
        }).__completeClipboardWrite = resolve;
      }),
    });
  });
  await codeBlock.getByRole('button', { name: '复制代码' }).click();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await page.evaluate(() => {
    const complete = (window as typeof window & {
      __completeClipboardWrite?: () => void;
    }).__completeClipboardWrite;
    if (!complete) throw new Error('clipboard write did not start');
    complete();
  });
  await expect(astryxPoliteRegion).toHaveText('已复制代码');
  await expect(page.getByText('Copied', { exact: true })).toHaveCount(0);
  await expect(codeBlock.getByRole('button', { name: '复制代码' })).toBeVisible();

  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, 'writeText', {
      configurable: true,
      value: async () => {
        throw new Error('clipboard denied by test');
      },
    });
  });

  await codeBlock.getByRole('button', { name: '复制代码' }).click();
  await expect(copyStatus).toBeVisible();
  await expect(copyStatus).toHaveText('复制代码失败');
  await expect(astryxPoliteRegion).toHaveText('复制代码失败');

  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, 'writeText', {
      configurable: true,
      value: () => new Promise<void>((resolve) => {
        (window as typeof window & {
          __completeClipboardWriteAfterUnmount?: () => void;
        }).__completeClipboardWriteAfterUnmount = resolve;
      }),
    });
  });
  await codeBlock.getByRole('button', { name: '复制代码' }).click();
  await page.getByRole('button', { name: '新任务' }).click();
  await expect(page.getByRole('region', { name: '开始对话' })).toBeVisible();

  await page.evaluate(async () => {
    const liveRegion = document.querySelector<HTMLElement>(
      '[data-astryx-live-region="polite"]',
    );
    if (!liveRegion) throw new Error('Astryx polite live region is missing');
    liveRegion.textContent = 'Copied';
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  });
  await expect(astryxPoliteRegion).toHaveText('Copied');

  await page.evaluate(async () => {
    const liveRegion = document.querySelector<HTMLElement>(
      '[data-astryx-live-region="polite"]',
    );
    const complete = (window as typeof window & {
      __completeClipboardWriteAfterUnmount?: () => void;
    }).__completeClipboardWriteAfterUnmount;
    if (!liveRegion || !complete) {
      throw new Error('pending clipboard write was not captured');
    }
    liveRegion.textContent = 'after-unmount';
    complete();
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  });
  await expect(astryxPoliteRegion).toHaveText('after-unmount');
});
