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
import { FeishuBotBridge } from '../feishu-bridge.js';
import { BotRegistry } from '../bot-registry.js';
import type { BotStatus } from '../types.js';

describe('BotRegistry', () => {
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

test('Feishu inherits global routing, updates it live, and preserves explicit channel overrides', async (t) => {
  const incoming: unknown[] = [];
  const handlers = new Map<string, (message: unknown) => void>();
  let connections = 0;
  const channel = {
    async connect() {
      connections++;
    },
    async disconnect() {},
    updatePolicy() {},
    on(name: string, handler: (message: unknown) => void) {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
  };
  const start = FeishuBotBridge.prototype.start;
  t.mock.method(FeishuBotBridge.prototype, 'start', function (this: FeishuBotBridge) {
    // Replace only the external SDK, retaining real registry resolution and bridge filtering.
    Object.assign(this, {
      loadSdk: () => ({
        createLarkChannel: () => channel,
        Domain: { Feishu: 'feishu', Lark: 'lark' },
        LoggerLevel: { error: 1 },
      }),
    });
    return start.call(this);
  });
  const registry = new BotRegistry({
    onIncomingMessage: (message) => incoming.push(message),
    onStatusChange() {},
  });
  const receive = (chatType: string, senderId = 'ou_owner') =>
    handlers.get('message')!({
      messageId: `om_${incoming.length}`,
      chatId: 'oc_chat',
      chatType,
      senderId,
      content: 'hello',
      resources: [],
      rawContentType: 'text',
      mentions: [],
      mentionAll: false,
      mentionedBot: false,
      createTime: 1,
    });
  try {
    for (const global of ['task', 'workhub', 'assistant'] as const) {
      for (const override of [undefined, 'task', 'workhub', 'assistant'] as const) {
        for (const allowedUserIds of [[], ['ou_owner'], ['ou_owner', 'ou_other']]) {
          const settings = {
            ...settingsWith({
              feishu: {
                enabled: true,
                appId: 'app',
                appSecret: 'secret',
                messageHandling: override,
                allowedUserIds,
              },
            }),
            messageHandling: global,
          };
          await registry.applySettings(settings);
          assert.equal(
            settings.channels.feishu.messageHandling,
            override,
            'do not rewrite persisted inheritance',
          );
          const before = incoming.length;
          receive('p2p');
          receive('group');
          receive('p2p', 'ou_stranger');
          const mode = override ?? global;
          const expected =
            mode === 'assistant'
              ? allowedUserIds.length === 1
                ? 1
                : 0
              : allowedUserIds.length
                ? 2
                : 3;
          assert.equal(
            incoming.length - before,
            expected,
            JSON.stringify({ global, override, allowedUserIds }),
          );
        }
      }
    }
    assert.equal(
      connections,
      1,
      'routing-only changes must update the running bridge without restart',
    );
  } finally {
    await registry.stopAll();
  }
});
