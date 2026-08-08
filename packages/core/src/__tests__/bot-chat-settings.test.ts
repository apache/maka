import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  createDefaultBotChatSettings,
  mergeBotChatSettings,
  normalizeBotChatSettings,
  parseAllowedUserIdsFromText,
} from '../bot-chat-settings.js';

describe('bot chat settings owner', () => {
  test('normalizes an explicitly patched allowlist without touching it on unrelated patches', () => {
    const defaults = createDefaultBotChatSettings();
    const withAllowlist = mergeBotChatSettings(defaults, {
      channels: {
        telegram: { allowedUserIds: [' 123 ', '456', '123', ''] },
      },
    });
    const tokenPatched = mergeBotChatSettings(withAllowlist, {
      channels: { telegram: { token: 'telegram-token' } },
    });

    assert.deepEqual(withAllowlist.channels.telegram.allowedUserIds, ['123', '456']);
    assert.strictEqual(
      tokenPatched.channels.telegram.allowedUserIds,
      withAllowlist.channels.telegram.allowedUserIds,
    );
  });

  test('preserves legacy readiness derivation and downgrade-only coercion', () => {
    const legacy = createDefaultBotChatSettings();
    delete (legacy.channels.telegram as Partial<typeof legacy.channels.telegram>).readiness;
    legacy.channels.telegram.enabled = true;
    legacy.channels.telegram.connected = true;
    legacy.channels.telegram.token = 'telegram-token';

    const legacyNormalized = normalizeBotChatSettings(legacy, legacy);
    assert.equal(legacyNormalized.channels.telegram.readiness, 'credentials_valid');

    legacyNormalized.channels.telegram.token = '';
    legacyNormalized.channels.telegram.readiness = 'operational';
    const cleared = normalizeBotChatSettings(legacyNormalized, legacyNormalized);
    assert.equal(cleared.channels.telegram.readiness, 'scaffolded');

    cleared.channels.telegram.token = 'new-token';
    cleared.channels.telegram.readiness = 'scaffolded';
    const credentialed = normalizeBotChatSettings(cleared, cleared);
    assert.equal(credentialed.channels.telegram.readiness, 'scaffolded');
  });

  test('parses textarea allowlists with trim, deduplication, and the defensive cap', () => {
    const raw = [
      ' 123 ',
      '456',
      '123',
      '',
      ...Array.from({ length: 60 }, (_, i) => `user-${i}`),
    ].join('\n');
    const parsed = parseAllowedUserIdsFromText(raw);

    assert.equal(parsed.length, 50);
    assert.deepEqual(parsed.slice(0, 3), ['123', '456', 'user-0']);
    assert.equal(parsed.at(-1), 'user-47');
  });
});
