import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { slackMessageToEvent } from '../slack-bridge.js';

describe('Slack bridge message mapping', () => {
  test('maps a user message into the shared bot event contract', () => {
    assert.deepEqual(
      slackMessageToEvent(
        {
          type: 'message',
          user: 'U123',
          channel: 'C456',
          channel_type: 'channel',
          text: 'hello from Slack',
          ts: '1720000000.123456',
        },
        1_720_000_001_000,
      ),
      {
        platform: 'slack',
        userId: 'U123',
        userName: 'U123',
        chatId: 'C456',
        isGroup: true,
        text: 'hello from Slack',
        sourceMessageId: '1720000000.123456',
        receivedAt: 1_720_000_001_000,
      },
    );
  });

  test('treats direct messages as private and drops bot/subtype echoes', () => {
    const direct = slackMessageToEvent(
      {
        type: 'message',
        user: 'U123',
        channel: 'D456',
        channel_type: 'im',
        ts: '1720000000.1',
      },
      5,
    );
    assert.equal(direct?.isGroup, false);
    assert.equal(direct?.text, '');
    assert.equal(
      slackMessageToEvent(
        {
          type: 'message',
          bot_id: 'B123',
          user: 'U123',
          channel: 'D456',
          ts: '1720000000.2',
        },
        5,
      ),
      null,
    );
    assert.equal(
      slackMessageToEvent(
        {
          type: 'message',
          subtype: 'message_changed',
          user: 'U123',
          channel: 'D456',
          ts: '1720000000.3',
        },
        5,
      ),
      null,
    );
  });

  test('keeps replies in the originating Slack thread', () => {
    const event = slackMessageToEvent(
      {
        type: 'message',
        user: 'U123',
        channel: 'C456',
        channel_type: 'channel',
        text: 'follow-up',
        ts: '1720000001.2',
        thread_ts: '1720000000.1',
      },
      5,
    );
    assert.equal(event?.sourceMessageId, '1720000000.1');
  });
});
