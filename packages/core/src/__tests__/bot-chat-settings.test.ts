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
import {
  createDefaultBotChatSettings,
  BOT_PROVIDERS,
  mergeBotChatSettings,
  normalizeBotChatSettings,
  resolveBotMessageHandling,
  parseAllowedUserIdsFromText,
} from '../bot-chat-settings.js';
import { SENSITIVE_PLACEHOLDER } from '../settings/network-settings.js';

describe('bot chat settings owner', () => {
  test('preserves masked credentials and supports replacement, omission and explicit clearing', () => {
    for (const provider of BOT_PROVIDERS) {
      const configured = mergeBotChatSettings(createDefaultBotChatSettings(), {
        channels: { [provider]: { token: 'stored-token', appSecret: 'stored-secret' } },
      });
      for (const mask of [SENSITIVE_PLACEHOLDER, '••••••']) {
        const saved = mergeBotChatSettings(configured, {
          channels: { [provider]: { enabled: true, token: mask, appSecret: mask } },
        });
        assert.equal(saved.channels[provider].token, 'stored-token', provider);
        assert.equal(saved.channels[provider].appSecret, 'stored-secret', provider);
        assert.equal(saved.channels[provider].enabled, true, provider);
      }
      const omitted = mergeBotChatSettings(configured, {
        channels: { [provider]: { token: undefined, appSecret: undefined } },
      });
      assert.equal(omitted.channels[provider].token, 'stored-token', provider);
      assert.equal(omitted.channels[provider].appSecret, 'stored-secret', provider);
      const replaced = mergeBotChatSettings(configured, {
        channels: { [provider]: { token: 'new-token', appSecret: 'new-secret' } },
      });
      assert.equal(replaced.channels[provider].token, 'new-token', provider);
      assert.equal(replaced.channels[provider].appSecret, 'new-secret', provider);
      const cleared = mergeBotChatSettings(configured, {
        channels: { [provider]: { token: '', appSecret: '' } },
      });
      assert.equal(cleared.channels[provider].token, '', provider);
      assert.ok(!cleared.channels[provider].appSecret, provider);
    }
  });

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

test('remote message handling defaults safely and survives channel edits and reload', () => {
  const defaults = createDefaultBotChatSettings();
  assert.equal(defaults.messageHandling, 'task');
  const configured = mergeBotChatSettings(defaults, { messageHandling: 'workhub' });
  const edited = mergeBotChatSettings(configured, { channels: { qq: { enabled: true } } });
  assert.equal(normalizeBotChatSettings(defaults, edited).messageHandling, 'workhub');
  assert.equal(
    normalizeBotChatSettings(defaults, { channels: edited.channels }).messageHandling,
    'task',
  );
});

test('WeChat inherits the default and preserves explicit legacy routing choices', () => {
  const defaults = createDefaultBotChatSettings();
  assert.equal(defaults.channels.wechat.messageHandling, undefined);
  for (const mode of ['task', 'workhub', 'assistant'] as const) {
    const configured = mergeBotChatSettings(defaults, {
      channels: { wechat: { messageHandling: mode } },
    });
    assert.equal(
      normalizeBotChatSettings(configured, configured).channels.wechat.messageHandling,
      mode,
    );
  }
});

test('Feishu inherits the default and retains explicit per-channel routing', () => {
  const defaults = createDefaultBotChatSettings();
  assert.equal(defaults.channels.feishu.messageHandling, undefined);
  for (const mode of ['assistant', 'task', 'workhub'] as const) {
    const saved = mergeBotChatSettings(defaults, {
      channels: { feishu: { messageHandling: mode } },
    });
    assert.equal(normalizeBotChatSettings(saved, saved).channels.feishu.messageHandling, mode);
  }
});

test('all providers inherit the global target or preserve an explicit channel override', () => {
  for (const provider of BOT_PROVIDERS) {
    for (const mode of ['task', 'workhub', 'assistant'] as const) {
      const defaults = createDefaultBotChatSettings();
      const global = mergeBotChatSettings(defaults, { messageHandling: mode });
      const saved = normalizeBotChatSettings(global, global);
      assert.equal(resolveBotMessageHandling(saved, provider), mode);
      const override = mergeBotChatSettings(saved, {
        channels: { [provider]: { messageHandling: 'task' } },
      });
      assert.equal(
        resolveBotMessageHandling(normalizeBotChatSettings(override, override), provider),
        'task',
      );
      const inherited = mergeBotChatSettings(override, {
        channels: { [provider]: { messageHandling: undefined } },
      });
      assert.equal(
        resolveBotMessageHandling(normalizeBotChatSettings(inherited, inherited), provider),
        mode,
      );
    }
  }
});
