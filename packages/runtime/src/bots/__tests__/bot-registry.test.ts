import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createDefaultBotChannel } from '@maka/core/settings';
import type { BotChatSettings, BotProvider } from '@maka/core/bot-chat-settings';
import { BotRegistry } from '../bot-registry.js';
import type { BotStatus } from '../types.js';

describe('BotRegistry', () => {
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
    assert.equal(registry.getStatus('wecom').reason, 'no-credentials');
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
    assert.equal(registry.getStatus('wecom').reason, 'no-credentials');
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
