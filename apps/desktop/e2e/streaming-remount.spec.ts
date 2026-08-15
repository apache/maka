import {
  FAKE_HOLD_OPEN_PROMPT,
  FAKE_HOLD_OPEN_REWRITE_PROMPT,
  FAKE_WAIT_FOR_STEERING_LARGE_RESPONSE_PROMPT,
} from '@maka/runtime/fake-backend';
import { expect, COMPOSER_INPUT, test } from './fixtures';

test('remounting a live surface leaves accumulated output settled', async ({
  window: page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(false);

  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill(FAKE_HOLD_OPEN_REWRITE_PROMPT);
  await composer.press('Enter');

  const accumulatedOutput = 'prefix sk-123456789012345';
  const liveBubble = page.locator('.maka-bubble-streaming');
  await expect(liveBubble).toContainText(accumulatedOutput);

  const sidebar = page.getByRole('navigation', { name: '对话列表' });
  await sidebar.getByRole('button', { name: '扩展' }).click();
  await expect(page.locator('[data-module="skills"]')).toBeVisible();
  await expect(liveBubble).toHaveCount(0);
  await sidebar.getByRole('button', { name: '会话', exact: true }).click();
  await expect(liveBubble).toHaveCount(1);
  await expect(liveBubble).toContainText(accumulatedOutput);

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
    const observed = { texts: [] as string[] };
    (window as typeof window & { __makaStreamingRemountObserved?: typeof observed })
      .__makaStreamingRemountObserved = observed;
    new MutationObserver(() => {
      observed.texts.push(element.textContent ?? '');
    }).observe(element, { childList: true, characterData: true, subtree: true });
  });

  const steering = 'trigger rewrite after returning to this conversation';
  await composer.fill(steering);
  await composer.press('Enter');
  const finalText = 'prefix <redacted> NEW streamed after the remount';
  await expect(liveBubble).toContainText(finalText);

  const observed = await page.evaluate(() => (
    window as typeof window & {
      __makaStreamingRemountObserved?: {
        texts: string[];
      };
    }
  ).__makaStreamingRemountObserved);
  expect(observed?.texts.some((text) => text.includes('<redacted>') && !text.includes(finalText)))
    .toBe(true);
});

test('keeps a completed reply after an interrupted turn and surface remount', async ({
  window: page,
}) => {
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill(FAKE_HOLD_OPEN_PROMPT);
  await composer.press('Enter');
  await expect(page.locator('.maka-bubble-streaming')).toContainText(
    'Fake backend waiting for the test to stop the Turn.',
  );
  const originalSessionId = await page.evaluate(async () => (await window.maka.sessions.list())[0]?.id);
  expect(originalSessionId).toBeTruthy();
  await page.getByRole('button', { name: '停止' }).click();
  await expect(page.getByRole('button', { name: '重新生成' })).toHaveCount(1, {
    timeout: 20_000,
  });
  await expect.poll(
    () => page.evaluate(async (sessionId) => (
      (await window.maka.sessions.list()).find((session) => session.id === sessionId)
        ?.runningTurnIds?.length ?? 0
    ), originalSessionId!),
    { timeout: 20_000 },
  ).toBe(0);
  await page.reload();
  await expect(page.getByRole('log')).toContainText(
    'Fake backend waiting for the test to stop the Turn.',
  );
  await composer.fill(FAKE_WAIT_FOR_STEERING_LARGE_RESPONSE_PROMPT);
  await expect(page.getByRole('button', { name: '发送' })).toBeEnabled({
    timeout: 20_000,
  });
  await composer.press('Enter');
  await expect(page.locator('.maka-user-message', {
    hasText: FAKE_WAIT_FOR_STEERING_LARGE_RESPONSE_PROMPT,
  })).toBeVisible();
  await expect(page.getByRole('button', { name: '停止' })).toBeVisible({
    timeout: 20_000,
  });
  const steering = 'use the detailed response';
  const completedReply = 'Large response complete.';
  await composer.fill(steering);
  await composer.press('Enter');
  await expect(page.getByRole('log')).toContainText(completedReply);
  await expect(page.getByRole('button', { name: '停止' })).toHaveCount(0, {
    timeout: 20_000,
  });

  await page.reload();
  await expect(page.getByRole('log')).toContainText(completedReply);
});

test('returning to a live conversation restores output accumulated while away', async ({
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
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await expect(page.locator('[data-agents-page]')).toHaveAttribute(
    'data-sidebar-state',
    'expanded',
  );
  const originalSessionId = await sidebar.locator('[data-session-id]').first()
    .getAttribute('data-session-id');
  expect(originalSessionId).toBeTruthy();
  await composer.fill('draft before switching conversations');
  await sidebar.getByRole('button', { name: '新任务', exact: true }).click();
  await expect(composer).toHaveText('');
  await composer.fill('temporary second conversation');
  await composer.press('Enter');
  await expect(page.getByRole('log')).toContainText(
    'Fake backend received: temporary second conversation',
  );
  await expect(page.getByRole('button', { name: '重新生成' })).toHaveCount(1, {
    timeout: 20_000,
  });
  const backgroundSteering = 'background output accumulated while away';
  await page.evaluate(
    ({ sessionId, steering }) => new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        unsubscribe();
        reject(new Error('Timed out waiting for background stream output'));
      }, 10_000);
      const unsubscribe = window.maka.sessions.subscribeEvents(sessionId, (event) => {
        if (event.type !== 'text_delta' || !event.text.includes(steering)) return;
        window.clearTimeout(timeout);
        unsubscribe();
        resolve();
      });
      void window.maka.sessions.steer(sessionId, steering).catch((error) => {
        window.clearTimeout(timeout);
        unsubscribe();
        reject(error);
      });
    }),
    { sessionId: originalSessionId!, steering: backgroundSteering },
  );
  await sidebar.locator(`[data-session-id="${originalSessionId}"]`).click();
  await liveBubble.waitFor({ state: 'attached' });
  await expect(liveBubble).toContainText(backgroundSteering);

  expect((await liveBubble.textContent())?.split(accumulatedOutput)).toHaveLength(2);
});
