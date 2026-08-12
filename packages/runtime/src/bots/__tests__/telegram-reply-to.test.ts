import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { __TEST__ } from '../simple-bridge.js';

const { buildTelegramSendBody, normalizeTelegramReplyToMessageId } = __TEST__;

describe('buildTelegramSendBody', () => {
  it('threads only the first chunk under a valid originating message', () => {
    assert.deepEqual(buildTelegramSendBody('chat-1', 'hello', undefined, 0), {
      chat_id: 'chat-1',
      text: 'hello',
    });
    assert.deepEqual(buildTelegramSendBody('chat-1', 'hello', { replyToMessageId: '42' }, 0), {
      chat_id: 'chat-1',
      text: 'hello',
      reply_to_message_id: 42,
      allow_sending_without_reply: true,
    });
    assert.deepEqual(
      buildTelegramSendBody('chat-1', '[2/3]\ntail', { replyToMessageId: '42' }, 1),
      { chat_id: 'chat-1', text: '[2/3]\ntail' },
    );
  });
});

describe('normalizeTelegramReplyToMessageId', () => {
  it('accepts positive safe integers and rejects malformed or unsafe values', () => {
    assert.equal(normalizeTelegramReplyToMessageId(' 42 '), 42);
    for (const value of [undefined, '0', '9007199254740992']) {
      assert.equal(normalizeTelegramReplyToMessageId(value), undefined, String(value));
    }
  });
});
