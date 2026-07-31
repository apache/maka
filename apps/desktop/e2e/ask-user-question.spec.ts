import { FAKE_ASK_USER_QUESTION_PROMPT } from '@maka/runtime';
import { test, expect } from './fixtures.js';

test('answers three questions and continues the same fake-backend turn', async ({ window: page }) => {
  const composer = page.locator('.maka-composer-textarea');
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
  await prompt.getByRole('button', { name: '下一题' }).click();

  await expect(prompt.getByText('2 / 3', { exact: true })).toBeVisible();
  await expect(prompt.getByRole('radio', { name: '本周' })).toBeFocused();
  await prompt.getByRole('button', { name: '下一题' }).click();

  await expect(prompt.getByText('3 / 3', { exact: true })).toBeVisible();
  await expect(prompt.getByRole('radio', { name: '是' })).toBeFocused();

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
  await expect(page.getByText(/Fake question answers: 邀请制 \/ 未回答 \/ 自定义节奏/)).toBeVisible();
  await expect(page.locator('.maka-composer')).toBeVisible();
});
