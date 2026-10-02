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
import { registerHooks } from 'node:module';
import { describe, test } from 'node:test';
import { createDefaultBotChannel } from '@maka/core/settings';
import type { BotChatSettings, BotProvider } from '@maka/core/bot-chat-settings';
import { BotRegistry } from '../bot-registry.js';
import type { BotIncomingMessage, BotStatus } from '../types.js';
import { WeComBotBridge } from '../wecom-bridge.js';

describe('BotRegistry', () => {
  for (const action of ['disable', 'stopAll', 'restart'] as const) {
    test(`${action} ignores retired bridge events during and after stop`, async (t) => {
      const messages: BotIncomingMessage[] = [];
      const statuses: BotStatus[] = [];
      const bridges: WeComBotBridge[] = [];
      const registry = new BotRegistry({
        onIncomingMessage: (message) => messages.push(message),
        onStatusChange: (status) => statuses.push(status),
      });
      let markStopping!: () => void;
      let finishStop!: () => void;
      const stopping = new Promise<void>((resolve) => {
        markStopping = resolve;
      });
      const stopped = new Promise<void>((resolve) => {
        finishStop = resolve;
      });
      t.mock.method(WeComBotBridge.prototype, 'start', async function (this: WeComBotBridge) {
        bridges.push(this);
      });
      t.mock.method(WeComBotBridge.prototype, 'stop', async () => {
        markStopping();
        await stopped;
      });
      const enabled = settingsWith({
        wecom: { enabled: true, appId: 'test-bot', appSecret: 'old' },
      });
      await registry.applySettings(enabled);
      const retired = bridges[0];
      const message: BotIncomingMessage = {
        platform: 'wecom',
        userId: 'test-user',
        chatId: 'test-chat',
        userName: 'test-user',
        sourceMessageId: 'test-message',
        isGroup: false,
        text: 'late message',
        receivedAt: 1,
      };
      const status: BotStatus = {
        platform: 'wecom',
        running: true,
        readiness: 'operational',
        connection: 'gateway',
      };
      const onMessage = retired.listeners('message')[0];
      const onStatus = retired.listeners('statusChange')[0];
      const otherMessageListener = () => {};
      const otherStatusListener = () => {};
      retired.on('message', otherMessageListener);
      retired.on('statusChange', otherStatusListener);
      retired.emit('message', message);
      retired.emit('statusChange', status);
      assert.deepEqual(messages, [message]);
      assert.equal(statuses.at(-1), status);

      const retirement =
        action === 'stopAll'
          ? registry.stopAll()
          : registry.applySettings(
              action === 'disable'
                ? settingsWith({})
                : settingsWith({
                    wecom: { enabled: true, appId: 'test-bot', appSecret: 'new' },
                  }),
            );
      await stopping;
      const assertRetiredEventsIgnored = () => {
        const messageCount = messages.length;
        const statusCount = statuses.length;
        retired.emit('message', message);
        retired.emit('statusChange', status);
        // EventEmitter may already have captured a listener before it was detached.
        onMessage(message);
        onStatus(status);
        assert.equal(messages.length, messageCount);
        assert.equal(statuses.length, statusCount);
      };
      try {
        assertRetiredEventsIgnored();
      } finally {
        finishStop();
        await retirement;
      }
      assertRetiredEventsIgnored();
      assert.deepEqual(retired.listeners('message'), [otherMessageListener]);
      assert.deepEqual(retired.listeners('statusChange'), [otherStatusListener]);

      if (action === 'restart') {
        assert.equal(bridges.length, 2);
        bridges[1].emit('message', message);
        bridges[1].emit('statusChange', status);
        assert.deepEqual(messages, [message, message]);
        assert.equal(statuses.at(-1), status);
      } else {
        assert.equal(registry.getStatus('wecom').reason, 'disabled');
        await registry.applySettings(enabled);
        bridges[1].emit('message', message);
        assert.deepEqual(messages, [message, message]);
        assertRetiredEventsIgnored();
      }
      await registry.stopAll();
    });
  }

  test('reports lazy SDK loading failures through bot status', async () => {
    const statuses: BotStatus[] = [];
    const registry = new BotRegistry({
      onIncomingMessage: () => {},
      onStatusChange: (status) => statuses.push(status),
    });
    const sdkNames = new Set([
      '@slack/web-api',
      '@larksuiteoapi/node-sdk',
      '@wecom/aibot-node-sdk',
    ]);
    const hooks = registerHooks({
      resolve(specifier, context, nextResolve) {
        if (sdkNames.has(specifier)) throw new Error('SDK unavailable');
        return nextResolve(specifier, context);
      },
    });
    try {
      await registry.applySettings(
        settingsWith(
          Object.fromEntries(
            (['slack', 'feishu', 'wecom'] as const).map((platform) => [
              platform,
              {
                enabled: true,
                token: 'test-token',
                appId: 'test-app',
                appSecret: 'test-secret',
              },
            ]),
          ),
        ),
      );
      for (const platform of ['slack', 'feishu', 'wecom'] as const) {
        assert.equal(registry.getStatus(platform).running, false);
        assert.equal(registry.getStatus(platform).reason, 'connection_failed');
        assert.equal(
          registry.getStatus(platform).readiness,
          platform === 'slack' ? 'degraded' : 'configured',
        );
        assert.ok(
          statuses.some(
            (status) => status.platform === platform && status.reason === 'connection_failed',
          ),
        );
      }
    } finally {
      hooks.deregister();
      await registry.stopAll();
    }
  });

  test('reports disabled and missing-credential statuses without opening network connections', async () => {
    const statuses: BotStatus[] = [];
    const registry = new BotRegistry({
      onIncomingMessage: () => {},
      onStatusChange: (status) => statuses.push(status),
    });

    await registry.applySettings(
      settingsWith({
        wecom: {
          enabled: true,
          token: '',
          appId: undefined,
          appSecret: undefined,
          readiness: 'operational',
        },
      }),
    );

    assert.equal(registry.getStatus('telegram').reason, 'disabled');
    assert.equal(registry.getStatus('telegram').readiness, 'scaffolded');
    assert.equal(registry.getStatus('wecom').reason, 'wecom_credentials_missing');
    assert.equal(registry.getStatus('wecom').running, false);
    assert.equal(registry.getStatus('wecom').readiness, 'scaffolded');
    assert.equal(
      statuses.some((status) => status.platform === 'wecom' && status.readiness === 'scaffolded'),
      true,
    );
    assert.equal(
      statuses.some((status) => status.platform === 'wecom' && status.readiness === 'operational'),
      false,
    );

    await registry.applySettings(
      settingsWith({
        wecom: { enabled: false, token: '' },
      }),
    );

    assert.equal(registry.getStatus('wecom').running, false);
    assert.equal(registry.getStatus('wecom').reason, 'disabled');
    assert.equal(
      statuses.some((status) => status.platform === 'wecom' && status.reason === 'disabled'),
      true,
    );
  });

  test('keeps the newest settings when overlapping updates disable and re-enable a bot', async () => {
    const registry = new BotRegistry({
      onIncomingMessage: () => {},
      onStatusChange: () => {},
    });

    await Promise.all([
      registry.applySettings(settingsWith({ wecom: { enabled: true, token: 'old-token' } })),
      registry.applySettings(settingsWith({ wecom: { enabled: false, token: 'old-token' } })),
      registry.applySettings(settingsWith({ wecom: { enabled: true, token: 'new-token' } })),
    ]);

    assert.equal(registry.getStatus('wecom').running, false);
    assert.equal(registry.getStatus('wecom').reason, 'wecom_credentials_missing');
    assert.equal(registry.getStatus('wecom').readiness, 'scaffolded');
  });

  test('stopAll waits behind any pending applySettings call and clears bridges', async () => {
    const registry = new BotRegistry({
      onIncomingMessage: () => {},
      onStatusChange: () => {},
    });

    await Promise.all([
      registry.applySettings(settingsWith({ wecom: { enabled: true, token: 'wecom-token' } })),
      registry.stopAll(),
    ]);

    assert.equal(registry.getStatus('wecom').running, false);
    assert.equal(registry.getStatus('wecom').reason, 'disabled');
  });
});

function settingsWith(
  overrides: Partial<Record<BotProvider, Partial<ReturnType<typeof createDefaultBotChannel>>>>,
): BotChatSettings {
  const providers: BotProvider[] = [
    'telegram',
    'feishu',
    'wecom',
    'wechat',
    'discord',
    'dingtalk',
    'qq',
    'slack',
  ];
  return {
    channels: Object.fromEntries(
      providers.map((provider) => [
        provider,
        {
          ...createDefaultBotChannel(provider),
          ...(overrides[provider] ?? {}),
        },
      ]),
    ) as BotChatSettings['channels'],
  };
}
