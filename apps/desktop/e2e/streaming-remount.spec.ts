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
} from '@maka/runtime/test-only/fake-backend';
import type { Locator } from '@playwright/test';
import {
  awaitSendReady,
  COMPOSER_INPUT,
  ensureSidebarExpanded,
  expect,
  test,
} from './fixtures';

interface SessionObservationLatchWindow extends Window {
  /** E2E-only preload affordance; see the MAKA_E2E block in preload.ts. */
  makaE2eLatch?: {
    rejectNextSessionObservation(message: string): void;
    rejectNextTranscriptOpen(message: string): void;
  };
}

function sessionRow(sidebar: Locator, sessionId: string): Locator {
  return sidebar.locator(`[data-session-id=${JSON.stringify(sessionId)}]`);
}

async function steerActiveTurn(composer: Locator, text: string): Promise<void> {
  // Mid-turn steering is Shift+Enter: the one Send stays Send, and the shifted
  // submit hands the draft to the active Turn once.
  await composer.fill(text);
  await composer.press('Shift+Enter');
}

test('a failed first observation seed reconnects to the live Turn', async ({ window: page }) => {
  const latchInstalled = await page.evaluate(() => {
    const latch = (window as SessionObservationLatchWindow).makaE2eLatch;
    if (!latch) return false;
    latch.rejectNextSessionObservation('forced first observation failure');
    return true;
  });
  expect(latchInstalled, 'the preload E2E latch is installed').toBe(true);

  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill(FAKE_HOLD_OPEN_PROMPT);
  await awaitSendReady(page);
  await composer.press('Enter');

  await expect(page.locator('.maka-bubble-streaming')).toContainText(
    'Fake backend waiting',
    { timeout: 20_000 },
  );
  await page.getByRole('button', { name: '停止' }).click();
  await expect(page.getByRole('button', { name: '重新生成' })).toHaveCount(1, {
    timeout: 20_000,
  });
});

test('a failed transcript open recovers when its Session observation becomes ready', async ({
  window: page,
}) => {
  const originalPrompt = 'transcript recovery source';
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill(originalPrompt);
  await awaitSendReady(page);
  await composer.press('Enter');
  await expect(page.getByRole('log')).toContainText(`Fake backend received: ${originalPrompt}`, {
    timeout: 20_000,
  });

  const sidebar = page.getByRole('navigation', { name: '任务列表' });
  await ensureSidebarExpanded(page);
  const originalSessionId = await sidebar
    .locator('[data-session-id]:has([aria-current="page"])')
    .getAttribute('data-session-id');
  expect(originalSessionId).toBeTruthy();

  await sidebar.getByRole('button', { name: '新任务', exact: true }).click();

  const latchInstalled = await page.evaluate(() => {
    const latch = (window as SessionObservationLatchWindow).makaE2eLatch;
    if (!latch) return false;
    latch.rejectNextTranscriptOpen('forced first transcript failure');
    return true;
  });
  expect(latchInstalled, 'the preload E2E latch is installed').toBe(true);

  await sessionRow(sidebar, originalSessionId!).click();
  await expect(page.getByRole('log')).toContainText(`Fake backend received: ${originalPrompt}`, {
    timeout: 20_000,
  });
});

test('remounting a live surface leaves accumulated output settled', async ({
  window: page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(false);

  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill(FAKE_HOLD_OPEN_REWRITE_PROMPT);
  await awaitSendReady(page);
  await composer.press('Enter');

  const accumulatedOutput = 'prefix sk-123456789012345';
  const liveBubble = page.locator('.maka-bubble-streaming');
  await expect(liveBubble).toContainText(accumulatedOutput, { timeout: 20_000 });

  const sidebar = page.getByRole('navigation', { name: '任务列表' });
  await ensureSidebarExpanded(page);
  await sidebar.getByRole('button', { name: '扩展' }).click();
  await expect(page.locator('[data-module="skills"]')).toBeVisible();
  await expect(liveBubble).toHaveCount(0);
  // Return through the task row the product exposes. Module navigation can
  // preserve either sidebar state, so restore it only when it is collapsed.
  await ensureSidebarExpanded(page);
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
  await steerActiveTurn(composer, steering);
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

test('returning to a live conversation settles output accumulated while away', async ({
  window: page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(false);
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill(FAKE_HOLD_OPEN_PROMPT);
  await awaitSendReady(page);
  await composer.press('Enter');

  const accumulatedOutput = 'Fake backend waiting for the test to stop the Turn.';
  const liveBubble = page.locator('.maka-bubble-streaming');
  await expect(liveBubble).toContainText(accumulatedOutput, { timeout: 20_000 });

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
  await awaitSendReady(page);
  await composer.press('Enter');
  await expect(page.getByRole('log')).toContainText(
    'Fake backend received: temporary second conversation',
    { timeout: 20_000 },
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
      // Runtime Host decides what this Message becomes; the test only needs it
      // to reach the running Turn, so anything short of an accepted admission
      // fails closed rather than waiting out the timeout.
      void window.maka.sessions
        .submitMessage(sessionId, 'current_turn', {
          messageId: crypto.randomUUID(),
          text: steering,
        })
        .then((result) => {
          if (result.ok) return;
          window.clearTimeout(timeout);
          unsubscribe();
          reject(new Error(`Runtime Host refused the steering Message: ${result.reason}`));
        })
        .catch((error) => {
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
