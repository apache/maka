import { test, expect } from './fixtures.js';

test('sandbox boundary request takes over the composer slot without hiding the workspace', async ({
  sandboxBoundaryWindow,
}) => {
  const prompt = sandboxBoundaryWindow.locator('.maka-sandbox-boundary-prompt');
  const slot = sandboxBoundaryWindow.locator('.maka-composer-interaction-slot');
  const composer = sandboxBoundaryWindow.locator('.maka-composer');
  const draft = '保留这段尚未发送的草稿';

  await expect(slot.locator('.maka-sandbox-boundary-prompt')).toHaveCount(1);
  await expect(composer).toHaveCount(1);
  await expect(composer).toBeHidden();
  const textarea = composer.locator('textarea[aria-label="消息输入框"]');
  await textarea.evaluate((element, value) => {
    const input = element as HTMLTextAreaElement;
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, draft);
  await expect(sandboxBoundaryWindow.locator('.maka-dialog-backdrop')).toHaveCount(0);
  await expect(sandboxBoundaryWindow.locator('[role="dialog"]')).toHaveCount(0);
  await expect(sandboxBoundaryWindow.locator('.app')).not.toHaveAttribute('inert', '');

  await expect(prompt.getByRole('heading', { name: '允许访问工作区以外的内容？' })).toBeVisible();
  await expect(prompt.getByText('/outside/dist')).toBeVisible();
  await expect(prompt.getByText('写入 · 目录及子目录')).toBeVisible();
  await expect(prompt.getByRole('button', { name: '拒绝' })).toBeFocused();
  await expect(prompt.getByRole('button', { name: '本会话允许' })).toBeVisible();

  const promptBox = await prompt.boundingBox();
  const panelBox = await sandboxBoundaryWindow.locator('.maka-panel-detail').boundingBox();
  expect(promptBox).not.toBeNull();
  expect(panelBox).not.toBeNull();
  expect(promptBox!.y + promptBox!.height).toBeGreaterThan(panelBox!.y + panelBox!.height * 0.7);

  await sandboxBoundaryWindow.getByRole('button', { name: '展开侧边栏' }).click();
  await expect(composer).toBeHidden();
  await expect(textarea).toHaveValue(draft);

  await prompt.getByRole('button', { name: '本会话允许' }).click();
  await expect(prompt).toHaveCount(0);
  await expect(composer).toBeVisible();
  await expect(textarea).toHaveValue(draft);
});
