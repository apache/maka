import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { __TEST__ } from '../qq-bridge.js';

const {
  decideQQClose,
  classifyQQSendResponse,
  qqChannelMessageToEvent,
  qqGroupMessageToEvent,
  qqC2CMessageToEvent,
  pickQQSendRoute,
  pickQQTypingRoute,
} = __TEST__;

describe('QQ gateway helpers', () => {
  it('classifies stopped, fatal, resumable, and non-resumable closes', () => {
    assert.deepEqual(decideQQClose(1000, true), { kind: 'stopped' });
    for (const code of [4004, 4014]) {
      assert.deepEqual(decideQQClose(code, false), { kind: 'fatal', code });
    }
    for (const code of [1000, 1001]) {
      assert.deepEqual(decideQQClose(code, false), { kind: 'reconnect', resumable: false });
    }
    assert.deepEqual(decideQQClose(4000, false), { kind: 'reconnect', resumable: true });
  });
});

describe('classifyQQSendResponse', () => {
  it('returns ids from either QQ success response shape', () => {
    for (const [payload, messageId] of [
      [{ id: '999' }, '999'],
      [{ msg_id: 'mid-1' }, 'mid-1'],
      [{}, null],
    ] as const) {
      assert.deepEqual(classifyQQSendResponse(200, payload), { kind: 'ok', messageId });
    }
  });

  it('retries only rate-limited sends', () => {
    assert.equal(classifyQQSendResponse(429, null).kind, 'retry');
  });

  it('returns stable fatal descriptions for permanent failures', () => {
    for (const [status, payload, description] of [
      [403, { message: 'Forbidden' }, 'Forbidden'],
      [400, { code: 304023 }, 'code 304023'],
      [502, null, 'HTTP 502'],
    ] as const) {
      assert.deepEqual(classifyQQSendResponse(status, payload), { kind: 'fatal', description });
    }
  });
});

describe('QQ message mapping', () => {
  it('maps channel, group, and C2C identities to prefixed chat ids', () => {
    const channel = qqChannelMessageToEvent(
      {
        id: 'm-1',
        channel_id: 'chan-1',
        guild_id: 'guild-1',
        content: '@bot hello',
        author: { id: 'u-1', username: 'Alice' },
      },
      1_700_000_000_000,
    );
    assert.deepEqual(
      {
        platform: channel?.platform,
        userId: channel?.userId,
        userName: channel?.userName,
        chatId: channel?.chatId,
        isGroup: channel?.isGroup,
        text: channel?.text,
        sourceMessageId: channel?.sourceMessageId,
      },
      {
        platform: 'qq',
        userId: 'u-1',
        userName: 'Alice',
        chatId: 'channel:chan-1',
        isGroup: true,
        text: '@bot hello',
        sourceMessageId: 'm-1',
      },
    );

    const group = qqGroupMessageToEvent(
      { id: 'gm-1', group_openid: 'g-1', author: { member_openid: 'mo-1' } },
      1,
    );
    assert.deepEqual(
      { chatId: group?.chatId, userId: group?.userId, isGroup: group?.isGroup },
      { chatId: 'group:g-1', userId: 'mo-1', isGroup: true },
    );
    assert.equal(
      qqGroupMessageToEvent({ id: 'gm-2', group_openid: 'g-2', author: { user_openid: 'uo-2' } }, 1)
        ?.userId,
      'uo-2',
    );
    assert.equal(
      qqGroupMessageToEvent({ id: 'gm-3', group_openid: 'g-3', author: { id: 'i-3' } }, 1)?.userId,
      'i-3',
    );
    const c2c = qqC2CMessageToEvent(
      { id: 'c2c-1', content: 'hi', author: { user_openid: 'uo-1' } },
      1,
    );
    assert.equal(c2c?.chatId, 'c2c:uo-1');
    assert.equal(c2c?.isGroup, false);
    assert.equal(c2c?.userId, 'uo-1');
  });

  it('drops bot echoes and messages without required identities', () => {
    assert.equal(
      qqChannelMessageToEvent({ id: 'm-2', channel_id: 'c', author: { id: 'b', bot: true } }, 1),
      null,
    );
    assert.equal(qqChannelMessageToEvent({ id: 'm-3', channel_id: 'c' }, 1), null);
    assert.equal(
      qqGroupMessageToEvent(
        { id: 'gm-4', group_openid: '' as string, author: { id: 'x' } } as any,
        1,
      ),
      null,
    );
    assert.equal(qqGroupMessageToEvent({ id: 'gm-5', group_openid: 'g', author: {} }, 1), null);
  });
});

describe('QQ REST routing', () => {
  it('routes channel, group, and C2C sends with trimmed targets and optional replies', () => {
    for (const [chatId, path] of [
      ['channel: chan-1 ', '/channels/chan-1/messages'],
      ['group: g-1 ', '/v2/groups/g-1/messages'],
      ['c2c: uo-1 ', '/v2/users/uo-1/messages'],
    ]) {
      const route = pickQQSendRoute(chatId, 'hi');
      assert.equal(route?.path, path, chatId);
      assert.equal(route?.body.content, 'hi');
      assert.equal(route?.body.msg_type, 0);
    }
    assert.equal(
      pickQQSendRoute('group:g-1', 'hi', { replyToMessageId: 'm-99' })?.body.msg_id,
      'm-99',
    );
  });

  it('rejects unknown or empty send targets and restricts typing to channels', () => {
    for (const chatId of ['unknown:foo', 'channel:   ', 'group:   ', 'c2c:   ']) {
      assert.equal(pickQQSendRoute(chatId, 'hi'), null, chatId);
    }
    for (const [chatId, expected] of [
      ['channel: c-1 ', '/channels/c-1/typing'],
      ['channel:   ', null],
      ['group:g-1', null],
    ] as const) {
      assert.equal(pickQQTypingRoute(chatId), expected, chatId);
    }
  });
});
