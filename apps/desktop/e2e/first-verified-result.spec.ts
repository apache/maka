import { FIRST_VERIFIED_RESULT_E2E_PROMPT } from '@maka/core/e2e-fixture';
import { COMPOSER_INPUT, expect, test } from './fixtures';

test('a ready user submits work, sees validation, and reviews the real project change', async ({
  firstVerifiedResultWindow: page,
}, testInfo) => {
  const startedAt = Date.now();
  const composer = page.locator(COMPOSER_INPUT);

  await composer.fill(FIRST_VERIFIED_RESULT_E2E_PROMPT);
  await composer.press('Enter');

  await expect(page.getByText('Created verified-result.txt. Validation passed (1/1).')).toBeVisible();
  const validationToolRow = page
    .locator('[data-slot="chat-tool-call-row"]')
    .filter({ hasText: 'Validate verified result' });
  await validationToolRow.focus();
  await validationToolRow.press('Enter');
  await expect(page.getByText(/validation: 1 passed, 0 failed/)).toBeVisible();

  await page.getByRole('button', { name: '展开任务工作栏' }).click();
  await page.getByRole('button', { name: /变更.*查看当前 Git 工作区变化/ }).click();

  const review = page.getByRole('region', { name: 'Git 变更' });
  await expect(review).toBeVisible();
  await expect(review.getByRole('button', { name: /^verified-result\.txt/ })).toBeVisible();
  await expect(review.getByText('1 个文件有变更')).toBeVisible();
  await expect(review.getByText('新增 1 行')).toBeVisible();

  const elapsedMs = Date.now() - startedAt;
  testInfo.annotations.push({
    type: 'first-verified-result-ms',
    description: String(elapsedMs),
  });
  await testInfo.attach('first-verified-result-timing.json', {
    body: Buffer.from(`${JSON.stringify({ elapsedMs }, null, 2)}\n`),
    contentType: 'application/json',
  });
  expect(elapsedMs).toBeLessThan(60_000);
});
