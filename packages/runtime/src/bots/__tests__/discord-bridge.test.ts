import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { __TEST__ } from '../discord-bridge.js';

const {
  decideDiscordClose,
  buildDiscordSendBody,
  normalizeDiscordReplyToMessageId,
  normalizeDiscordChannelId,
  classifyDiscordSendResponse,
  discordMessageToEvent,
  splitDiscordContent,
} = __TEST__;

describe('Discord gateway helpers', () => {
  it('classifies stopped, fatal, resumable, and non-resumable closes', () => {
    assert.deepEqual(decideDiscordClose(1000, true), { kind: 'stopped' });
    for (const code of [4004, 4014, 4013, 4012, 4010, 4011]) {
      assert.deepEqual(decideDiscordClose(code, false), { kind: 'fatal', code });
    }
    for (const code of [1000, 1001]) {
      assert.deepEqual(decideDiscordClose(code, false), { kind: 'reconnect', resumable: false });
    }
    assert.deepEqual(decideDiscordClose(4000, false), { kind: 'reconnect', resumable: true });
  });
});

describe('Discord send payloads', () => {
  it('threads only the first chunk under a valid originating message', () => {
    assert.deepEqual(buildDiscordSendBody('hello', undefined, 0), { content: 'hello' });
    assert.deepEqual(buildDiscordSendBody('hello', { replyToMessageId: ' 123 ' }, 0), {
      content: 'hello',
      message_reference: { message_id: '123', fail_if_not_exists: false },
    });
    assert.deepEqual(buildDiscordSendBody('tail', { replyToMessageId: '123' }, 1), {
      content: 'tail',
    });
  });

  it('normalizes positive reply and channel snowflakes only', () => {
    assert.equal(normalizeDiscordReplyToMessageId(' 123456789012345678 '), '123456789012345678');
    assert.equal(normalizeDiscordChannelId(' 123456789012345678 '), '123456789012345678');
    assert.equal(normalizeDiscordReplyToMessageId('0'), undefined);
    assert.equal(normalizeDiscordChannelId('0'), undefined);
    assert.equal(normalizeDiscordReplyToMessageId(undefined), undefined);
  });
});

describe('classifyDiscordSendResponse', () => {
  it('returns the optional message id on successful responses', () => {
    for (const [status, payload, messageId] of [
      [200, { id: '999' }, '999'],
      [201, { id: 123 }, '123'],
      [200, null, null],
    ] as const) {
      assert.deepEqual(classifyDiscordSendResponse(status, payload), { kind: 'ok', messageId });
    }
  });

  it('clamps rate-limit delays to the bounded retry window', () => {
    for (const [retryAfter, expected] of [
      [2, 2_000],
      [0, 1_000],
      [600, 30_000],
    ]) {
      const result = classifyDiscordSendResponse(429, { retry_after: retryAfter });
      assert.equal(result.kind, 'retry');
      if (result.kind === 'retry') assert.equal(result.delayMs, expected, String(retryAfter));
    }
  });

  it('returns fatal classifications for permanent HTTP failures', () => {
    assert.deepEqual(classifyDiscordSendResponse(403, { message: 'Missing Permissions' }), {
      kind: 'fatal',
      description: 'Missing Permissions',
    });
    assert.deepEqual(classifyDiscordSendResponse(502, null), {
      kind: 'fatal',
      description: 'HTTP 502',
    });
  });
});

describe('discordMessageToEvent', () => {
  it('maps guild and direct messages without retaining Discord transport shape', () => {
    const guild = discordMessageToEvent(
      {
        id: 'msg-1',
        channel_id: 'chan-1',
        guild_id: 'guild-1',
        content: 'hello',
        author: { id: 'user-1', username: 'alice', global_name: 'Alice' },
      },
      1_700_000_000_000,
    );
    assert.deepEqual(guild, {
      platform: 'discord',
      userId: 'user-1',
      userName: 'Alice',
      chatId: 'chan-1',
      isGroup: true,
      text: 'hello',
      sourceMessageId: 'msg-1',
      receivedAt: 1_700_000_000_000,
    });
    const direct = discordMessageToEvent(
      {
        id: 'msg-2',
        channel_id: 'dm-1',
        content: 'hi',
        author: { id: 'user-2', username: 'bob' },
      },
      1_700_000_000_001,
    );
    assert.equal(direct?.isGroup, false);
    assert.equal(direct?.userName, 'bob');
  });

  it('drops bot echoes and messages without an author', () => {
    assert.equal(
      discordMessageToEvent(
        {
          id: 'msg-3',
          channel_id: 'chan-3',
          content: 'beep',
          author: { id: 'other-bot', username: 'OtherBot', bot: true },
        },
        1,
      ),
      null,
    );
    assert.equal(discordMessageToEvent({ id: 'msg-4', channel_id: 'chan-4' }, 1), null);
  });
});

describe('splitDiscordContent', () => {
  it('preserves content while splitting only above Discord limits', () => {
    const boundary = 'a'.repeat(2000);
    assert.deepEqual(splitDiscordContent(boundary), [boundary]);

    const oversized = 'x'.repeat(5000);
    const chunks = splitDiscordContent(oversized);
    assert.equal(chunks.join(''), oversized);
    assert.ok(chunks.every((chunk) => chunk.length <= 2000));
  });
});
