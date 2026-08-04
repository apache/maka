import { FAKE_ASK_USER_QUESTION_PROMPT } from '@maka/runtime';
import { test, expect, COMPOSER_INPUT } from './fixtures.js';

test('rehydrates a prompt the surface never received live', async ({ window: page }) => {
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill(FAKE_ASK_USER_QUESTION_PROMPT);
  await composer.press('Enter');

  const prompt = page.locator('.maka-user-question-prompt');
  await expect(prompt).toBeVisible();

  // Reloading throws away every event this surface ever saw while the runtime
  // keeps the turn parked on the question. Without a read-back the prompt is
  // gone for good and the run can never be answered (#2072).
  await page.reload();
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page
    .getByRole('navigation', { name: '对话列表' })
    .locator('[data-session-id]')
    .first()
    .click();

  await expect(prompt).toBeVisible();
  await expect(prompt.getByText('1 / 3', { exact: true })).toBeVisible();
});

test('answers three questions and continues the same fake-backend turn', async ({ window: page }) => {
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill(FAKE_ASK_USER_QUESTION_PROMPT);
  await composer.press('Enter');

  const prompt = page.locator('.maka-user-question-prompt');
  await expect(prompt).toBeVisible();
  await expect(page.locator('.maka-composer')).toBeHidden();
  await expect(prompt.getByText('1 / 3', { exact: true })).toBeVisible();
  await expect(prompt.getByText('先验证核心流程，再逐步扩大范围。')).toBeVisible();

  const selectedOption = prompt.getByRole('radio', { name: /邀请制/ });
  const unselectedOption = prompt.getByRole('radio', { name: /公开测试/ });
  await selectedOption.click();
  await expect(selectedOption).toBeChecked();
  await expect(unselectedOption).not.toBeChecked();
  const next = prompt.getByRole('button', { name: '下一题' });
  await next.click();

  await expect(prompt.getByText('2 / 3', { exact: true })).toBeVisible();
  await expect(next).toBeFocused();
  const thisWeek = prompt.getByRole('radio', { name: '本周' });
  const nextWeek = prompt.getByRole('radio', { name: '下周' });
  await thisWeek.focus();
  await thisWeek.press('ArrowDown');
  await expect(nextWeek).toBeFocused();
  await expect(nextWeek).toBeChecked();
  await nextWeek.press('ArrowUp');
  await expect(thisWeek).toBeFocused();
  await expect(thisWeek).toBeChecked();
  await next.click();

  await expect(prompt.getByText('3 / 3', { exact: true })).toBeVisible();

  const preset = prompt.getByRole('radio', { name: '是' });
  const customChoice = prompt.getByRole('radio', { name: /其他/ });
  const submit = prompt.getByRole('button', { name: '提交答案' });
  await preset.click();
  await expect(preset).toBeChecked();
  await expect(submit).toBeEnabled();
  await customChoice.click();
  await expect(customChoice).toBeChecked();
  await expect(preset).not.toBeChecked();
  const other = prompt.getByRole('textbox', { name: '其他答案' });
  await expect(other).toBeFocused();
  await expect(submit).toBeDisabled();
  await other.fill('自定义节奏');
  await expect(submit).toBeEnabled();
  await other.press('Home');
  await other.press('ArrowLeft');
  await expect(other).toBeFocused();
  await expect(other).toHaveValue('自定义节奏');
  await prompt.getByRole('button', { name: '提交答案' }).click();

  await expect(prompt).toHaveCount(0);
  await expect(page.getByText(/Fake question answers: 邀请制 \/ 本周 \/ 自定义节奏/)).toBeVisible();
  await expect(page.locator('.maka-composer')).toBeVisible();
});
