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
  FAKE_COMPLETE_HELD_TURN_STEERING,
  FAKE_HOLD_OPEN_COMPLETE_PROMPT,
} from '@maka/runtime/test-only/fake-backend';
import {
  awaitSendReady,
  COMPOSER_INPUT,
  ensureSidebarExpanded,
  expect,
  test,
} from './fixtures';

test('sending from history follows the second Turn through Session switches and durable settlement', async ({
  window: page,
}) => {
  test.setTimeout(90_000);
  const composer = page.locator(COMPOSER_INPUT);
  const log = page.getByRole('log');
  const scroller = page.locator('[data-chat-scroll-container="true"]');
  const distanceToTail = () => scroller.evaluate((element) =>
    element.scrollHeight - element.clientHeight - element.scrollTop);
  // Keep both Turns well below the range budget while making the transcript
  // tall enough that loading the same latest range cannot reveal B by clamping.
  const firstQuestion = 'First question before the live navigation regression.';
  const firstPrompt = [
    firstQuestion,
    ...Array.from({ length: 60 }, (_, index) => `History line ${index + 1}.`),
  ].join('\n\n');
  await composer.fill(firstPrompt);
  await awaitSendReady(page);
  await composer.press('Enter');
  await expect(log).toContainText(`Fake backend received: ${firstQuestion}`, { timeout: 20_000 });
  await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);

  await composer.fill(FAKE_HOLD_OPEN_COMPLETE_PROMPT);
  await awaitSendReady(page);
  const scrollBox = await scroller.boundingBox();
  expect(scrollBox).not.toBeNull();
  await page.mouse.move(scrollBox!.x + scrollBox!.width / 2, scrollBox!.y + scrollBox!.height / 2);
  await page.mouse.wheel(0, -800);
  await expect.poll(distanceToTail).toBeGreaterThan(500);
  await composer.press('Enter');
  const liveText = 'Fake backend waiting for the test to stop the Turn.';
  await expect(page.locator('.maka-bubble-streaming')).toContainText(liveText, { timeout: 20_000 });
  await expect(log).toContainText(firstPrompt);
  await expect.poll(distanceToTail).toBeLessThanOrEqual(3);

  await ensureSidebarExpanded(page);
  const sidebar = page.getByRole('navigation', { name: '任务列表' });
  const activeRow = sidebar.locator('[data-session-id]:has([aria-current="page"])');
  const originalSessionId = await activeRow.getAttribute('data-session-id');
  expect(originalSessionId).toBeTruthy();
  await sidebar.getByRole('button', { name: '新任务', exact: true }).click();
  await composer.fill('Temporary conversation while the original Turn streams.');
  await awaitSendReady(page);
  await composer.press('Enter');
  await expect(log).toContainText('Fake backend received: Temporary conversation', { timeout: 20_000 });
  await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
  const temporarySessionId = await activeRow.getAttribute('data-session-id');
  expect(temporarySessionId).toBeTruthy();
  expect(temporarySessionId).not.toBe(originalSessionId);

  const backgroundText = 'Durable second-turn navigation marker.';
  await page.evaluate(({ sessionId, text }) => new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      unsubscribe();
      reject(new Error('The isolated fake backend did not publish the background text.'));
    }, 10_000);
    const unsubscribe = window.maka.sessions.subscribeEvents(sessionId, (event) => {
      if (event.type !== 'text_delta' || !event.text.includes(text)) return;
      window.clearTimeout(timeout);
      unsubscribe();
      resolve();
    });
    void window.maka.sessions.submitMessage(sessionId, 'current_turn', {
      messageId: crypto.randomUUID(), text,
    }).then((result) => {
      if (result.ok) return;
      window.clearTimeout(timeout);
      unsubscribe();
      reject(new Error(`Background fixture steering was refused: ${result.reason}`));
    }, (error) => {
      window.clearTimeout(timeout);
      unsubscribe();
      reject(error);
    });
  }), { sessionId: originalSessionId!, text: backgroundText });

  const originalRow = sidebar.locator(`[data-session-id=${JSON.stringify(originalSessionId)}]`);
  const temporaryRow = sidebar.locator(`[data-session-id=${JSON.stringify(temporarySessionId)}]`);
  await originalRow.click();
  await expect(page.locator('.maka-bubble-streaming')).toContainText(backgroundText);
  await expect(log).toContainText(firstPrompt);
  const completed = await page.evaluate(({ sessionId, text }) => window.maka.sessions.submitMessage(
    sessionId, 'current_turn', { messageId: crypto.randomUUID(), text },
  ), { sessionId: originalSessionId!, text: FAKE_COMPLETE_HELD_TURN_STEERING });
  expect(completed.ok).toBe(true);
  await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0, { timeout: 20_000 });
  await expect(log).toContainText(backgroundText);

  // Inspect the actual Desktop transcript transport. A rendered settled bubble
  // alone cannot prove that the Host persisted its accumulated overlay.
  const readDurableTranscript = () => page.evaluate(async (sessionId) => {
    const records = new Map<number, Uint8Array>();
    const navigationVersions = new Set<number>();
    let markReady!: () => void;
    const ready = new Promise<void>((resolve) => { markReady = resolve; });
    const handle = await window.maka.transcripts.open(sessionId, (batch) => {
      // The cached bootstrap uses the contract's implicit version zero.
      navigationVersions.add(batch.navigationVersion ?? 0);
      for (const fragment of batch.fragments) {
        if (fragment.source !== 'durable' || typeof fragment.identity !== 'number') continue;
        const bytes = records.get(fragment.identity) ?? new Uint8Array(fragment.totalBytes);
        bytes.set(fragment.data, fragment.byteOffset);
        records.set(fragment.identity, bytes);
      }
      if (batch.ready) markReady();
    });
    try {
      await ready;
      return {
        navigationVersions: [...navigationVersions],
        messages: [...records.values()].map((bytes) => JSON.parse(new TextDecoder().decode(bytes)) as {
          id: string; type: string; text?: string;
        }),
      };
    } finally {
      await handle.close();
    }
  }, originalSessionId!);
  await expect.poll(async () => (await readDurableTranscript()).messages.filter(({ type, text }) =>
    type === 'assistant' && text?.includes(backgroundText)).length, { timeout: 20_000 }).toBe(1);
  const durableTranscript = await readDurableTranscript();
  expect(durableTranscript.navigationVersions).toEqual([0]);

  await temporaryRow.click();
  await expect(log).toContainText('Temporary conversation');
  await originalRow.click();
  await expect(log).toContainText(firstPrompt);
  await expect(log).toContainText(backgroundText);
  await expect(page.locator('.maka-bubble-streaming')).toHaveCount(0);
  const settledAnswer = log.getByRole('article', { name: 'Maka 的回答', exact: true })
    .filter({ hasText: backgroundText });
  await expect(settledAnswer).toHaveCount(1);
  expect((await settledAnswer.textContent())?.split(backgroundText)).toHaveLength(2);
  expect((await settledAnswer.textContent())?.split(liveText)).toHaveLength(2);
  expect(durableTranscript.messages.filter(({ type, text }) =>
    type === 'assistant' && text?.includes(backgroundText))).toHaveLength(1);
});
