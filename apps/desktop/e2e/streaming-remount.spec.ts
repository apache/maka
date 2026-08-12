import {
  FAKE_HOLD_OPEN_PROMPT,
  FAKE_REWRITE_HOLD_OPEN_PROMPT,
} from '@maka/runtime/fake-backend';
import { expect, COMPOSER_INPUT, test } from './fixtures';

test('returning to a live conversation leaves accumulated output settled', async ({
  window: page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(false);

  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill(FAKE_HOLD_OPEN_PROMPT);
  await composer.press('Enter');

  const accumulatedOutput = 'Fake backend waiting for the test to stop the Turn.';
  const liveBubble = page.locator('.maka-bubble-streaming');
  await expect(liveBubble).toContainText(accumulatedOutput);

  const sidebar = page.getByRole('navigation', { name: '对话列表' });
  await sidebar.getByRole('button', { name: '扩展' }).click();
  await expect(page.locator('[data-module="skills"]')).toBeVisible();
  await sidebar.getByRole('button', { name: '会话', exact: true }).click();
  await liveBubble.waitFor({ state: 'attached' });

  expect((await liveBubble.textContent())?.split(accumulatedOutput)).toHaveLength(2);
  expect(
    await liveBubble.evaluate(
      (element) =>
        element
          .getAnimations({ subtree: true })
          .filter((animation) => animation.playState !== 'finished').length,
    ),
  ).toBe(0);

  await page.getByRole('button', { name: '展开侧边栏' }).click();
  const originalSessionId = await sidebar.locator('[data-session-id]').first()
    .getAttribute('data-session-id');
  expect(originalSessionId).toBeTruthy();
  await sidebar.getByRole('button', { name: '新任务', exact: true }).click();
  await composer.fill('temporary second conversation');
  await composer.press('Enter');
  await expect(page.getByRole('log')).toContainText(
    'Fake backend received: temporary second conversation',
  );
  await expect(page.getByRole('button', { name: '重新生成' })).toHaveCount(1, {
    timeout: 20_000,
  });
  await sidebar.locator(`[data-session-id="${originalSessionId}"]`).click();
  await liveBubble.waitFor({ state: 'attached' });

  expect((await liveBubble.textContent())?.split(accumulatedOutput)).toHaveLength(2);
  expect(
    await liveBubble.evaluate(
      (element) =>
        element
          .getAnimations({ subtree: true })
          .filter((animation) => animation.playState !== 'finished').length,
    ),
  ).toBe(0);

  await liveBubble.evaluate((element) => {
    const observed = {
      texts: [] as string[],
      maxActiveAnimations: 0,
    };
    (window as typeof window & { __makaStreamingRemountObserved?: typeof observed })
      .__makaStreamingRemountObserved = observed;
    new MutationObserver(() => {
      observed.texts.push(element.textContent ?? '');
      observed.maxActiveAnimations = Math.max(
        observed.maxActiveAnimations,
        element
          .getAnimations({ subtree: true })
          .filter((animation) => animation.playState !== 'finished').length,
      );
    }).observe(element, { childList: true, characterData: true, subtree: true });
  });

  const steering = 'continue after returning to this conversation';
  await composer.fill(steering);
  await composer.press('Enter');
  await expect(liveBubble).toContainText(steering);

  const observed = await page.evaluate(() => (
    window as typeof window & {
      __makaStreamingRemountObserved?: {
        texts: string[];
        maxActiveAnimations: number;
      };
    }
  ).__makaStreamingRemountObserved);
  expect(observed?.texts.some((text) =>
    text.includes('continue after') && !text.includes(steering)
  )).toBe(true);
  expect(observed?.maxActiveAnimations).toBeGreaterThan(0);
});

test('rewritten live text reveals only the suffix beyond its verified prefix', async ({
  window: page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill(FAKE_REWRITE_HOLD_OPEN_PROMPT);
  await composer.press('Enter');

  const liveBubble = page.locator('.maka-bubble-streaming');
  await expect(liveBubble).toContainText('prefix sk-123456789012345');
  await liveBubble.evaluate((element) => {
    const observed = {
      texts: [] as string[],
      maxActiveAnimations: 0,
    };
    (window as typeof window & { __makaStreamingRewriteObserved?: typeof observed })
      .__makaStreamingRewriteObserved = observed;
    new MutationObserver(() => {
      observed.texts.push(element.textContent ?? '');
      observed.maxActiveAnimations = Math.max(
        observed.maxActiveAnimations,
        element
          .getAnimations({ subtree: true })
          .filter((animation) => animation.playState !== 'finished').length,
      );
    }).observe(element, { childList: true, characterData: true, subtree: true });
  });

  await composer.fill('trigger rewrite');
  await composer.press('Enter');
  await expect(liveBubble).toContainText('prefix <redacted> NEW');

  const observed = await page.evaluate(() => (
    window as typeof window & {
      __makaStreamingRewriteObserved?: {
        texts: string[];
        maxActiveAnimations: number;
      };
    }
  ).__makaStreamingRewriteObserved);
  expect(observed?.texts.some((text) =>
    text.startsWith('prefix ') && !text.includes('NEW')
  )).toBe(true);
  expect(observed?.maxActiveAnimations).toBeGreaterThan(0);
});
