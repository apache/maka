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
