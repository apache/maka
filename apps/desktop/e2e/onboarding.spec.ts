import { COMPOSER_INPUT, test, expect } from './fixtures';

test('first run connects a provider and starts the first task without workspace defaults', async ({ firstRunWindow: page }) => {
  const onboarding = page.locator('[data-maka-contract="onboarding-card"]');

  await expect(onboarding.getByRole('heading', { name: '接入一个 AI，开始第一项任务。' })).toBeVisible();
  await expect(onboarding.locator('.maka-onboarding-provider-row')).toHaveCount(4);

  await page.setViewportSize({ width: 480, height: 900 });
  const cardRect = await onboarding.boundingBox();
  const layoutRect = await page.locator('[data-chat-scroll-container="true"]').boundingBox();
  expect(cardRect).not.toBeNull();
  expect(layoutRect).not.toBeNull();
  expect(cardRect?.x).toBeGreaterThanOrEqual(layoutRect?.x ?? 0);
  expect((cardRect?.x ?? 0) + (cardRect?.width ?? 0)).toBeLessThanOrEqual(
    (layoutRect?.x ?? 0) + (layoutRect?.width ?? 0),
  );

  await onboarding.locator('.maka-onboarding-provider-row[data-provider="opencode-free"]').click();

  await expect(page.locator('[data-maka-contract="provider-setup"]')).toBeVisible();
  await expect(page.getByLabel('设置内容')).toBeVisible();

  await page.getByRole('button', { name: '保存供应商', exact: true }).click();
  await expect(page.locator('[data-maka-contract="connection-detail"]')).toBeVisible();

  // The production migration is removing workspace defaults. Reproduce that
  // boundary deterministically while preserving the provider's enabled model
  // inventory: the old onboarding state machine gets stuck here even though a
  // new session can name this connection and model explicitly.
  await page.evaluate(async () => {
    await window.maka.connections.update('opencode-free', { defaultModel: '' });
  });
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const connection = (await window.maka.connections.list()).find(
          (candidate) => candidate.slug === 'opencode-free',
        );
        return {
          defaultSlug: await window.maka.connections.getDefault(),
          defaultModel: connection?.defaultModel,
          enabledModelIds: connection?.enabledModelIds,
        };
      }),
    )
    .toEqual({
      defaultSlug: null,
      defaultModel: '',
      enabledModelIds: ['nemotron-3-ultra-free'],
    });
  await page.getByRole('button', { name: '返回应用', exact: true }).click();

  await expect(onboarding).toHaveCount(0);
  await expect(page.locator(COMPOSER_INPUT)).toBeVisible();
  await expect(page.getByRole('button', { name: /选择新对话模型/ })).toHaveAccessibleName(
    /Nemotron 3 Ultra Free/,
  );

  await page.locator(COMPOSER_INPUT).fill('完成首次任务');
  await page.locator(COMPOSER_INPUT).press('Enter');
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const sessions = await window.maka.sessions.list();
        return sessions.map((session) => ({
          connectionSlug: session.llmConnectionSlug,
          model: session.model,
        }));
      }),
    )
    .toContainEqual({ connectionSlug: 'opencode-free', model: 'nemotron-3-ultra-free' });
});
