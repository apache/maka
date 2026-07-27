import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createDefaultBotChannel } from '@maka/core/settings';
import type { BotChatSettings, BotProvider } from '@maka/core';
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
        wecom: { enabled: true, token: '', appId: undefined, appSecret: undefined },
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
  });

  // PR-BOT-DISCORD-OPERATIONAL-0: Discord is now an implemented platform
  // (DiscordBotBridge), so the "scaffold-only" assertions moved off Discord
  // onto WeCom which still has credentials-only (no live bridge).
  test('does not mark a missing-credential WeCom bridge as operational', async () => {
    const statuses: BotStatus[] = [];
    const registry = new BotRegistry({
      onIncomingMessage: () => {},
      onStatusChange: (status) => statuses.push(status),
    });

    await registry.applySettings(
      settingsWith({
        wecom: { enabled: true, token: '', appId: undefined, appSecret: undefined },
      }),
    );

    assert.equal(registry.getStatus('wecom').running, false);
    assert.equal(registry.getStatus('wecom').reason, 'no-credentials');
    assert.equal(registry.getStatus('wecom').readiness, 'scaffolded');
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

  test('queues overlapping applySettings calls so the newest settings win deterministically', async () => {
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

  // PR-HEALTH-1 (xuan msg `e4887ffd`, I1 — read-path single-authority):
  // Previously `scaffoldStatus` inherited the persisted
  // `settings.readiness === 'credentials_valid'` directly into
  // `BotStatus.readiness`. That let stale credential claims survive across
  // settings reloads even after a live bridge had never probed. Post-fix,
  // unimplemented platforms ONLY use `readinessFromSettings` (computed
  // fresh from the channel's CURRENT facts). Credential-valid / operational
  // are reserved for the live bridge write path (SimpleBotBridge etc.).
  test('implemented platform with no credentials downgrades persisted credentials_valid to scaffolded', () => {
    const registry = new BotRegistry({
      onIncomingMessage: () => {},
      onStatusChange: () => {},
    });

    return registry
      .applySettings(
        settingsWith({
          wecom: {
            enabled: true,
            token: '',
            appId: undefined,
            appSecret: undefined,
            connected: true,
            readiness: 'credentials_valid',
          },
        }),
      )
      .then(() => {
        const status = registry.getStatus('wecom');
        assert.equal(status.running, false);
        assert.equal(
          status.readiness,
          'scaffolded',
          'persisted credentials_valid must NOT survive when current credentials are empty',
        );
        assert.notEqual(status.readiness, 'operational');
      });
  });

  test('implemented platform with no credentials reports scaffolded (regardless of persisted state)', async () => {
    // F1 in audit catalog. Even with a stale persisted credentials_valid,
    // an empty credential trio means scaffoldStatus must return scaffolded.
    const registry = new BotRegistry({
      onIncomingMessage: () => {},
      onStatusChange: () => {},
    });

    await registry.applySettings(
      settingsWith({
        wecom: {
          enabled: true,
          token: '',
          appId: undefined,
          appSecret: undefined,
          readiness: 'credentials_valid',
        },
      }),
    );

    const status = registry.getStatus('wecom');
    assert.equal(status.readiness, 'scaffolded');
    assert.equal(status.reason, 'no-credentials');
  });

  // PR-BOT-TYPING-INDICATOR-0 — `sendTypingIndicator` is best-effort and
  // must never throw, even when the platform has no bridge or no send
  // capability. The actual Telegram API call is exercised separately at
  // the simple-bridge layer; here we pin the contract that no bridge =
  // returns false silently.
  test('sendTypingIndicator returns false (without throwing) when no bridge is registered', async () => {
    const registry = new BotRegistry({
      onIncomingMessage: () => {},
      onStatusChange: () => {},
    });

    const result = await registry.sendTypingIndicator('telegram', 'chat-1');
    assert.equal(result, false);
  });

  test('sendTypingIndicator returns false for WeCom because the SDK has no typing capability', async () => {
    const registry = new BotRegistry({
      onIncomingMessage: () => {},
      onStatusChange: () => {},
    });

    await registry.applySettings(
      settingsWith({
        wecom: { enabled: true, token: '', appId: undefined, appSecret: undefined },
      }),
    );

    // A bridge is registered, but the official SDK has no typing API.
    const result = await registry.sendTypingIndicator('wecom', 'chat-x');
    assert.equal(result, false);
  });

  test('unimplemented platform with persisted operational + no credentials reports scaffolded', async () => {
    // Tighter coercion: even operational is downgraded for the read path
    // when credentials are absent. Live bridge would write its own
    // operational state on a per-reconcile basis; persisted operational
    // alone is not honored.
    const registry = new BotRegistry({
      onIncomingMessage: () => {},
      onStatusChange: () => {},
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

    const status = registry.getStatus('wecom');
    assert.equal(
      status.readiness,
      'scaffolded',
      'persisted operational with no credentials must NOT survive into read path',
    );
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
    'whatsapp',
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
