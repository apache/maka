/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import {
  FAKE_HOLD_OPEN_PROMPT,
  FAKE_HOLD_OPEN_REWRITE_PROMPT,
  FAKE_WAIT_FOR_STEERING_LARGE_RESPONSE_PROMPT,
} from '@maka/runtime/test-only/fake-backend';
import type { Locator } from '@playwright/test';
import { expect, COMPOSER_INPUT, test } from './fixtures';

function sessionRow(sidebar: Locator, sessionId: string): Locator {
  return sidebar.locator(`[data-session-id=${JSON.stringify(sessionId)}]`);
}

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

  const sidebar = page.getByRole('navigation', { name: '任务列表' });
  await sidebar.getByRole('button', { name: '扩展' }).click();
  await expect(page.locator('[data-module="skills"]')).toBeVisible();
  await expect(liveBubble).toHaveCount(0);
  // Back the way the product actually offers: the rail is collapsed here, so
  // the task rows are not rendered and there is no 任务 row to press (#2984).
  // Widening it is the titlebar's job, and the task left behind is still
  // `activeId`, so it comes back marked and one click away.
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  const currentTaskRow = sidebar.locator(
    '[data-maka-contract="session-row"] [aria-current="page"]',
  );
  await expect(currentTaskRow).toHaveCount(1);
  await currentTaskRow.click();
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

test('keeps a completed reply after an interrupted turn and conversation remount', async ({
  window: page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(false);
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('temporary conversation');
  await composer.press('Enter');
  await expect(page.getByRole('log')).toContainText('Fake backend received: temporary conversation');
  await expect(page.getByRole('button', { name: '重新生成' })).toHaveCount(1, {
    timeout: 20_000,
  });
  const sidebar = page.getByRole('navigation', { name: '任务列表' });
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await expect(page.locator('[data-agents-page]')).toHaveAttribute(
    'data-sidebar-state',
    'expanded',
  );
  const temporarySessionId = await sidebar
    .locator('[data-session-id]:has([aria-current="page"])')
    .getAttribute('data-session-id');
  expect(temporarySessionId).toBeTruthy();
  await composer.fill('draft before starting the interrupted conversation');
  await sidebar.getByRole('button', { name: '新任务', exact: true }).click();
  await expect(composer).toHaveText('');

  await composer.fill(FAKE_HOLD_OPEN_PROMPT);
  await composer.press('Enter');
  await expect(page.locator('.maka-bubble-streaming')).toContainText(
    'Fake backend waiting for the test to stop the Turn.',
  );
  const originalSessionId = await sidebar
    .locator('[data-session-id]:has([aria-current="page"])')
    .getAttribute('data-session-id');
  expect(originalSessionId).toBeTruthy();
  expect(originalSessionId).not.toBe(temporarySessionId);
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
  await expect(page.locator('.maka-bubble-streaming')).toHaveCount(0, {
    timeout: 20_000,
  });

  const temporarySessionRow = sessionRow(sidebar, temporarySessionId!);
  await temporarySessionRow.click();
  await expect(temporarySessionRow.locator('[aria-current="page"]')).toHaveCount(1, {
    timeout: 20_000,
  });
  await expect(page.getByRole('log')).toContainText('Fake backend received: temporary conversation');
  const originalSessionRow = sessionRow(sidebar, originalSessionId!);
  await originalSessionRow.click();
  await expect(originalSessionRow.locator('[aria-current="page"]')).toHaveCount(1, {
    timeout: 20_000,
  });
  await expect(page.getByRole('log')).toContainText(completedReply);
});

test('returning to a live conversation settles output accumulated while away', async ({
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

  const sidebar = page.getByRole('navigation', { name: '任务列表' });
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
  await page.evaluate(() => {
    // Painted frames only. A MutationObserver on `document.body` fires on every
    // shell mutation during the remount, including React commit intermediates
    // that never paint. Those samples made this assertion machine-load
    // dependent (#3061): the same restore passed in isolation and failed when
    // the rest of the file had already warmed the compositor.
    const observed = {
      texts: [] as string[],
      maxActiveAnimations: 0,
      stop() {},
    };
    let stopped = false;
    const sample = () => {
      if (stopped) return;
      const bubble = document.querySelector<HTMLElement>('.maka-bubble-streaming');
      if (bubble) {
        const text = bubble.textContent ?? '';
        if (observed.texts.at(-1) !== text) observed.texts.push(text);
        observed.maxActiveAnimations = Math.max(
          observed.maxActiveAnimations,
          bubble
            .getAnimations({ subtree: true })
            .filter((animation) => animation.playState !== 'finished').length,
        );
      }
      window.requestAnimationFrame(sample);
    };
    observed.stop = () => {
      stopped = true;
    };
    (
      window as typeof window & {
        __makaBackgroundRestoreObserved?: typeof observed;
      }
    ).__makaBackgroundRestoreObserved = observed;
    window.requestAnimationFrame(sample);
  });
  await sessionRow(sidebar, originalSessionId!).click();
  await liveBubble.waitFor({ state: 'attached' });
  await expect(liveBubble).toContainText(backgroundSteering);

  expect((await liveBubble.textContent())?.split(accumulatedOutput)).toHaveLength(2);
  // Playwright's toContainText is a DOM check. Stop on the next animation
  // frame so the already-queued sample() records that settled paint first.
  const backgroundRestoreObserved = await page.evaluate(
    () =>
      new Promise<{
        texts: string[];
        maxActiveAnimations: number;
      } | undefined>((resolve) => {
        window.requestAnimationFrame(() => {
          const observed = (
            window as typeof window & {
              __makaBackgroundRestoreObserved?: {
                texts: string[];
                maxActiveAnimations: number;
                stop(): void;
              };
            }
          ).__makaBackgroundRestoreObserved;
          observed?.stop();
          resolve(observed);
        });
      }),
  );
  expect(
    backgroundRestoreObserved?.texts.some((text) => text.includes(backgroundSteering)),
  ).toBe(true);
  expect(backgroundRestoreObserved?.texts.some((text) =>
    text.includes('background output') && !text.includes(backgroundSteering)
  )).toBe(false);
  expect(backgroundRestoreObserved?.maxActiveAnimations).toBe(0);
});
