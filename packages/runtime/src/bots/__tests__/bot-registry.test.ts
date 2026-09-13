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
