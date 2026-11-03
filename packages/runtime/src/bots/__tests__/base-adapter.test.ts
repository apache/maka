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
import { BOT_PROVIDERS, createDefaultBotChannel } from '@maka/core/settings';
import {
  BaseBotAdapter,
  botReadinessFromSettings,
  botSettingsRequireRestart,
} from '../base-adapter.js';
import type { BotIncomingMessage } from '../types.js';

class TestAdapter extends BaseBotAdapter {
  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  publish(message: BotIncomingMessage): void {
    this.emitIncomingMessage(message);
    this.emitStatusChange();
  }
}

describe('BaseBotAdapter', () => {
  test('emits normalized incoming messages and updates lastEventAt', () => {
    const adapter = new TestAdapter('telegram', createDefaultBotChannel('telegram'));
    const messages: BotIncomingMessage[] = [];
    adapter.on('message', (message) => messages.push(message));

    const message: BotIncomingMessage = {
      platform: 'telegram',
      userId: 'u1',
      userName: 'Ada',
      chatId: 'c1',
      isGroup: false,
      text: 'hello',
      sourceMessageId: 'm1',
      receivedAt: 42,
    };
    adapter.publish(message);

    assert.deepEqual(messages, [message]);
    assert.equal(adapter.getStatus().lastEventAt, 42);
  });

  test('detects restart boundaries from channel settings', () => {
    const base = createDefaultBotChannel('telegram');
    assert.equal(
      botSettingsRequireRestart(base, { ...base, domain: 'https://bot.example.test' }),
      true,
    );

    const adapter = new TestAdapter('telegram', { ...base, enabled: true, token: 'old-token' });
    assert.deepEqual(adapter.updateSettings({ ...base, enabled: true, token: 'old-token' }), {
      needsRestart: false,
    });
    assert.deepEqual(adapter.updateSettings({ ...base, enabled: true, token: 'new-token' }), {
      needsRestart: true,
    });
    assert.equal(adapter.getStatus().readiness, 'configured');
  });

  test('admits only listed senders in every channel and applies policy updates without restarting', () => {
    for (const platform of BOT_PROVIDERS) {
      const settings = { ...createDefaultBotChannel(platform), allowedUserIds: ['owner'] };
      const adapter = new TestAdapter(platform, settings);
      const messages: BotIncomingMessage[] = [];
      adapter.on('message', (message) => messages.push(message));
      const incoming = (userId: string, receivedAt: number): BotIncomingMessage => ({
        platform,
        userId,
        userName: 'owner',
        chatId: 'owner',
        isGroup: true,
        text: 'hello',
        sourceMessageId: String(receivedAt),
        receivedAt,
      });
      const owner = incoming('owner', 1);
      adapter.publish(owner);
      for (const userId of ['outsider', 'owner-extra', '']) adapter.publish(incoming(userId, 2));
      assert.deepEqual(messages, [owner], platform);
      assert.equal(adapter.getStatus().lastEventAt, 1, platform);

      assert.deepEqual(adapter.updateSettings({ ...settings, allowedUserIds: ['outsider'] }), {
        needsRestart: false,
      });
      adapter.publish(incoming('owner', 3));
      const nextOwner = incoming('outsider', 4);
      adapter.publish(nextOwner);
      assert.deepEqual(messages, [owner, nextOwner], platform);

      for (const allowedUserIds of [[], undefined]) {
        adapter.updateSettings({ ...settings, allowedUserIds });
        const unrestricted = incoming('any-user', messages.length + 5);
        adapter.publish(unrestricted);
        assert.equal(messages.at(-1), unrestricted, platform);
      }
    }
  });

  test('derives readiness only from current credential facts', () => {
    assert.equal(botReadinessFromSettings(createDefaultBotChannel('telegram')), 'scaffolded');
    assert.equal(
      botReadinessFromSettings({ ...createDefaultBotChannel('telegram'), enabled: true }),
      'scaffolded',
    );
    assert.equal(
      botReadinessFromSettings({
        ...createDefaultBotChannel('telegram'),
        enabled: true,
        token: 'token',
      }),
      'configured',
    );
    assert.equal(
      botReadinessFromSettings({
        ...createDefaultBotChannel('feishu'),
        enabled: true,
        appId: 'app',
        appSecret: 'secret',
      }),
      'configured',
    );
  });
});
