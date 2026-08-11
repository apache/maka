import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createDefaultBotChannel } from '@maka/core/settings';
import {
  BaseBotAdapter,
  botReadinessFromSettings,
  botSettingsRequireRestart,
} from '../base-adapter.js';
import type { BotIncomingMessage, BotStatus } from '../types.js';

class TestAdapter extends BaseBotAdapter {
  async start(): Promise<void> {
    this.running = true;
    this.startedAt = 100;
    this.reason = undefined;
    this.readiness = 'credentials_valid';
    this.emitStatusChange();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.reason = 'stopped';
    this.emitStatusChange();
  }

  publish(message: BotIncomingMessage): void {
    this.emitIncomingMessage(message);
    this.emitStatusChange();
  }

  protected override connectionKind(): BotStatus['connection'] {
    return 'webhook';
  }
}

describe('BaseBotAdapter', () => {
  test('centralizes status shape for platform bridges', async () => {
    const adapter = new TestAdapter('telegram', createDefaultBotChannel('telegram'));
    const statuses: ReturnType<TestAdapter['getStatus']>[] = [];
    adapter.on('statusChange', (status) => statuses.push(status));

    await adapter.start();

    assert.equal(adapter.isRunning(), true);
    assert.deepEqual(adapter.getStatus(), {
      platform: 'telegram',
      running: true,
      readiness: 'credentials_valid',
      reason: undefined,
      startedAt: 100,
      lastEventAt: undefined,
      connection: 'webhook',
      identity: undefined,
    });
    assert.equal(statuses.at(-1)?.readiness, 'credentials_valid');
  });

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

  test('does NOT restart when only allowedUserIds changes (runtime filter, not connection parameter)', () => {
    const base = createDefaultBotChannel('telegram');
    assert.equal(
      botSettingsRequireRestart(
        { ...base, allowedUserIds: ['123'] },
        { ...base, allowedUserIds: undefined },
      ),
      false,
    );
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
