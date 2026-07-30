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
  const selectionStyles = await Promise.all([
    selectedOption.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        backgroundColor: style.backgroundColor,
        borderColor: style.borderColor,
        boxShadow: style.boxShadow,
        dotBackgroundColor: getComputedStyle(element.querySelector('.maka-question-radio')!).backgroundColor,
        dotBoxShadow: getComputedStyle(element.querySelector('.maka-question-radio')!).boxShadow,
      };
    }),
    unselectedOption.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        backgroundColor: style.backgroundColor,
        borderColor: style.borderColor,
        boxShadow: style.boxShadow,
        dotBackgroundColor: getComputedStyle(element.querySelector('.maka-question-radio')!).backgroundColor,
        dotBoxShadow: getComputedStyle(element.querySelector('.maka-question-radio')!).boxShadow,
      };
    }),
  ]);
  expect(selectionStyles[0].backgroundColor).not.toBe(selectionStyles[1].backgroundColor);
  expect(selectionStyles[0].borderColor).not.toBe(selectionStyles[1].borderColor);
  expect(selectionStyles[0].boxShadow).not.toBe('none');
  expect(selectionStyles[0].dotBackgroundColor).not.toBe(selectionStyles[1].dotBackgroundColor);
  expect(selectionStyles[0].dotBoxShadow).not.toBe('none');
  await prompt.getByRole('button', { name: '下一题' }).click();

  await expect(prompt.getByText('2 / 3', { exact: true })).toBeVisible();
  await expect(prompt.getByRole('radio', { name: '本周' })).toBeFocused();
  await prompt.getByRole('button', { name: '下一题' }).click();

  await expect(prompt.getByText('3 / 3', { exact: true })).toBeVisible();
  await expect(prompt.getByRole('radio', { name: '是' })).toBeFocused();
  await expect(prompt.getByRole('radio', { name: /其他/ })).toHaveCount(0);
  const otherField = prompt.locator('.maka-question-other-field');
  const other = prompt.getByRole('textbox', { name: '其他答案' });
  await expect(otherField).toBeVisible();
  await expect(otherField.locator('.maka-question-other-icon')).toBeVisible();
  await expect(other).toBeVisible();
  await expect(other).toHaveValue('');
  const geometryBeforeInput = await Promise.all([
    prompt.boundingBox(),
    otherField.boundingBox(),
  ]);
  expect(geometryBeforeInput.every(Boolean)).toBe(true);
  expect(
    await otherField.evaluate((field) => {
      const input = field.querySelector<HTMLElement>('.maka-question-other-input');
      if (!input) return false;
      const row = field.getBoundingClientRect();
      const points = [0.1, 0.5, 0.9].flatMap((xRatio) =>
        [0.1, 0.5, 0.9].map((yRatio) => [
          row.left + row.width * xRatio,
          row.top + row.height * yRatio,
        ] as const)
      );
      return points.every(([x, y]) => {
        const target = document.elementFromPoint(x, y);
        return target === field || Boolean(target && field.contains(target));
      });
    }),
  ).toBe(true);

  const preset = prompt.getByRole('radio', { name: '是' });
  const submit = prompt.getByRole('button', { name: '提交答案' });
  await preset.click();
  await expect(preset).toBeChecked();
  await expect(submit).toBeEnabled();
  await preset.press('Tab');
  await expect(other).toBeFocused();
  await expect(preset).toBeChecked();
  await expect(otherField).not.toHaveAttribute('data-selected');
  await expect(submit).toBeEnabled();
  await other.pressSequentially('自');
  await expect(preset).not.toBeChecked();
  await expect(otherField).toHaveAttribute('data-selected', '');
  expect(
    await otherField.evaluate((field) => getComputedStyle(field).boxShadow),
  ).not.toBe('none');
  expect(
    await other.evaluate((input) => input.closest('[role="radiogroup"]') === null),
  ).toBe(true);
  await other.fill('');
  await expect(submit).toBeDisabled();
  await preset.click();
  await expect(otherField).not.toHaveAttribute('data-selected');
  await otherField.click({ position: { x: 8, y: 8 } });
  await expect(other).toBeFocused();
  await expect(preset).toBeChecked();
  await expect(otherField).not.toHaveAttribute('data-selected');
  await expect(submit).toBeEnabled();
  await other.fill('自定义节奏');
  await expect(preset).not.toBeChecked();
  await expect(otherField).toHaveAttribute('data-selected', '');
  const geometryAfterInput = await Promise.all([
    prompt.boundingBox(),
    otherField.boundingBox(),
  ]);
  expect(geometryAfterInput).toEqual(geometryBeforeInput);
  await other.press('Home');
  await other.press('ArrowLeft');
  await expect(other).toBeFocused();
  await expect(other).toHaveValue('自定义节奏');
  await prompt.getByRole('button', { name: '提交答案' }).click();

  await expect(prompt).toHaveCount(0);
  await expect(page.getByText(/Fake question answers: 邀请制 \/ 未回答 \/ 自定义节奏/)).toBeVisible();
  await expect(page.locator('.maka-composer')).toBeVisible();
});
