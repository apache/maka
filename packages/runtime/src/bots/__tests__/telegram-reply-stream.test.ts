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

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createDefaultBotChannel } from '@maka/core/settings';
import { __TEST__, TelegramBotBridge } from '../telegram-bridge.js';

const { createTelegramReplyStream, normalizeTelegramPrivateChatId, telegramDraftId } = __TEST__;

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('Telegram reply streaming', () => {
  test('keeps private-only drafts disabled for Telegram groups', () => {
    class RunningTelegramBridge extends TelegramBotBridge {
      markRunning(): void {
        this.running = true;
      }
    }
    const bridge = new RunningTelegramBridge('telegram', {
      ...createDefaultBotChannel('telegram'),
      enabled: true,
      token: 'token',
    });
    bridge.markRunning();

    assert.equal(bridge.startReplyStream('-100123', { isGroup: true, streamId: 'turn-1' }), null);
    assert.equal(
      bridge.startReplyStream('not-a-chat', { isGroup: false, streamId: 'turn-1' }),
      null,
    );
  });

  test('coalesces snapshots and always persists the final reply', async () => {
    let now = 1_000;
    const timers: Array<{ callback: () => void; delayMs: number }> = [];
    const drafts: Array<{ draftId: number; text: string }> = [];
    const finals: string[] = [];
    const stream = createTelegramReplyStream({
      chatId: 'chat-1',
      streamId: 'turn-1',
      now: () => now,
      setTimer: (callback, delayMs) => {
        timers.push({ callback, delayMs });
        return { unref() {} } as ReturnType<typeof setTimeout>;
      },
      clearTimer() {},
      sendDraft: async (draftId, text) => {
        drafts.push({ draftId, text });
        return true;
      },
      sendFinal: async (text) => {
        finals.push(text);
        return 'message-1';
      },
    });

    stream.update('Hel');
    await settle();
    stream.update('Hello');
    stream.update('Hello world');
    assert.deepEqual(
      drafts.map(({ text }) => text),
      ['Hel'],
    );
    const updateTimer = timers.find(({ delayMs }) => delayMs === 250);
    assert.ok(updateTimer);

    now += 250;
    updateTimer.callback();
    await settle();
    assert.deepEqual(
      drafts.map(({ text }) => text),
      ['Hel', 'Hello world'],
    );
    assert.equal(drafts[0]?.draftId, drafts[1]?.draftId);

    assert.equal(await stream.finish('Hello world!'), 'message-1');
    assert.deepEqual(finals, ['Hello world!']);
  });

  test('falls back to the final send after native draft delivery fails', async () => {
    let draftAttempts = 0;
    const finals: string[] = [];
    const stream = createTelegramReplyStream({
      chatId: 'chat-1',
      streamId: 'turn-1',
      sendDraft: async () => {
        draftAttempts += 1;
        return false;
      },
      sendFinal: async (text) => {
        finals.push(text);
        return 'message-1';
      },
    });

    stream.update('partial');
    await settle();
    stream.update('later');
    assert.equal(await stream.finish('final'), 'message-1');
    assert.equal(draftAttempts, 1);
    assert.deepEqual(finals, ['final']);
  });

  test('does not resend a bounded draft when only hidden overflow changes', async () => {
    const drafts: string[] = [];
    const stream = createTelegramReplyStream({
      chatId: 'chat-1',
      streamId: 'turn-1',
      prepareDraftText: (text) => text.slice(0, 5),
      sendDraft: async (_draftId, text) => {
        drafts.push(text);
        return true;
      },
      sendFinal: async () => 'message-1',
    });

    stream.update('12345');
    await settle();
    stream.update('123456789');
    await settle();
    await stream.finish('123456789');
    assert.deepEqual(drafts, ['12345']);
  });

  test('waits for an in-flight draft before publishing the final message', async () => {
    let releaseDraft = () => {};
    const draftReleased = new Promise<void>((resolve) => {
      releaseDraft = resolve;
    });
    const order: string[] = [];
    const stream = createTelegramReplyStream({
      chatId: 'chat-1',
      streamId: 'turn-1',
      sendDraft: async () => {
        order.push('draft-start');
        await draftReleased;
        order.push('draft-end');
        return true;
      },
      sendFinal: async () => {
        order.push('final');
        return 'message-1';
      },
    });

    stream.update('partial');
    await settle();
    const finished = stream.finish('final');
    await settle();
    assert.deepEqual(order, ['draft-start']);
    releaseDraft();
    assert.equal(await finished, 'message-1');
    assert.deepEqual(order, ['draft-start', 'draft-end', 'final']);
  });

  test('persists the final reply at most once', async () => {
    let finalSends = 0;
    const stream = createTelegramReplyStream({
      chatId: 'chat-1',
      streamId: 'turn-1',
      sendDraft: async () => true,
      sendFinal: async () => {
        finalSends += 1;
        return 'message-1';
      },
    });

    assert.deepEqual(await Promise.all([stream.finish('final'), stream.finish('final')]), [
      'message-1',
      'message-1',
    ]);
    assert.equal(finalSends, 1);
  });

  test('keeps only the latest pending snapshot while a draft request is slow', async () => {
    let now = 1_000;
    let releaseFirst = () => {};
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const timers: Array<{ callback: () => void; delayMs: number }> = [];
    const drafts: string[] = [];
    const stream = createTelegramReplyStream({
      chatId: 'chat-1',
      streamId: 'turn-1',
      now: () => now,
      setTimer: (callback, delayMs) => {
        timers.push({ callback, delayMs });
        return { unref() {} } as ReturnType<typeof setTimeout>;
      },
      clearTimer() {},
      sendDraft: async (_draftId, text) => {
        drafts.push(text);
        if (drafts.length === 1) await firstReleased;
        return true;
      },
      sendFinal: async () => 'message-1',
    });

    stream.update('first');
    await settle();
    stream.update('second');
    stream.update('latest');
    assert.deepEqual(drafts, ['first']);
    assert.equal(timers.filter(({ delayMs }) => delayMs === 250).length, 0);

    releaseFirst();
    await settle();
    const updateTimer = timers.find(({ delayMs }) => delayMs === 250);
    assert.ok(updateTimer);
    now += 250;
    updateTimer.callback();
    await settle();
    assert.deepEqual(drafts, ['first', 'latest']);
    await stream.finish('final');
  });

  test('refreshes an unchanged draft before Telegram expires it', async () => {
    const timers: Array<{ callback: () => void; delayMs: number }> = [];
    const drafts: string[] = [];
    const stream = createTelegramReplyStream({
      chatId: 'chat-1',
      streamId: 'turn-1',
      setTimer: (callback, delayMs) => {
        timers.push({ callback, delayMs });
        return { unref() {} } as ReturnType<typeof setTimeout>;
      },
      clearTimer() {},
      sendDraft: async (_draftId, text) => {
        drafts.push(text);
        return true;
      },
      sendFinal: async () => 'message-1',
    });

    stream.update('waiting for a tool');
    await settle();
    const keepalive = timers.find(({ delayMs }) => delayMs === 20_000);
    assert.ok(keepalive);
    keepalive.callback();
    await settle();
    assert.deepEqual(drafts, ['waiting for a tool', 'waiting for a tool']);
    await stream.abort();
  });

  test('derives a stable non-zero draft identity for one Turn stream', () => {
    const first = telegramDraftId('chat-1', 'turn-1');
    assert.equal(first, telegramDraftId('chat-1', 'turn-1'));
    assert.notEqual(first, telegramDraftId('chat-1', 'turn-2'));
    assert.notEqual(first, telegramDraftId('chat-2', 'turn-1'));
    assert.ok(first > 0);
  });

  test('accepts only safe positive private chat identities', () => {
    assert.equal(normalizeTelegramPrivateChatId(' 123 '), 123);
    for (const value of ['-123', 'chat-name', '9007199254740992']) {
      assert.equal(normalizeTelegramPrivateChatId(value), undefined);
    }
  });
});
