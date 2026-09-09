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

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { __TEST__ } from '../dingtalk-bridge.js';

const {
  decideDingTalkClose,
  pickDingTalkSendRoute,
  classifyDingTalkSendResponse,
  dingTalkPayloadToEvent,
  buildDingTalkAckFrame,
} = __TEST__;

describe('decideDingTalkClose (PR-BOT-DINGTALK-OPERATIONAL-0)', () => {
  it('only treats explicit stops as terminal', () => {
    assert.deepEqual(decideDingTalkClose(1000, true), { kind: 'stopped' });
    assert.deepEqual(decideDingTalkClose(1000, false), { kind: 'reconnect' });
  });
});

describe('pickDingTalkSendRoute', () => {
  it('routes stamped group and 1:1 chatIds to their own endpoints (#5111)', () => {
    // Real 1:1 and group conversationIds share the same `cid` prefix, so
    // the stamped route is the only reliable discriminator.
    assert.deepEqual(pickDingTalkSendRoute('group:cidXXyy==', 'app-key-1', 'hello'), {
      path: '/v1.0/robot/groupMessages/send',
      body: {
        robotCode: 'app-key-1',
        openConversationId: 'cidXXyy==',
        msgKey: 'sampleText',
        msgParam: '{"content":"hello"}',
      },
    });
    assert.deepEqual(pickDingTalkSendRoute('oto:01234567890123456789', 'app-key-1', 'hi'), {
      path: '/v1.0/robot/oToMessages/batchSend',
      body: {
        robotCode: 'app-key-1',
        userIds: ['01234567890123456789'],
        msgKey: 'sampleText',
        msgParam: '{"content":"hi"}',
      },
    });
    assert.equal(pickDingTalkSendRoute('   ', 'app-key-1', 'hi'), null);
    assert.equal(pickDingTalkSendRoute('group:', 'app-key-1', 'hi'), null);
    assert.equal(pickDingTalkSendRoute('oto:', 'app-key-1', 'hi'), null);
  });

  it('fails closed on unstamped ids instead of guessing prefixes (#5111)', () => {
    // A bare real 1:1 conversationId starts with `cid` — the old
    // startsWith('cid') guess routed it to the group endpoint and DingTalk
    // rejected every direct reply. Both shapes below are unstamped.
    assert.equal(pickDingTalkSendRoute('cidZz9wYq==', 'app-key-1', 'hi'), null);
    assert.equal(pickDingTalkSendRoute('cidp-group', 'app-key-1', 'hi'), null);
  });
});

describe('classifyDingTalkSendResponse', () => {
  it('accepts successful responses with or without a message id', () => {
    assert.deepEqual(classifyDingTalkSendResponse(200, { processQueryKey: 'pk-1' }), {
      kind: 'ok',
      messageId: 'pk-1',
    });
    assert.deepEqual(classifyDingTalkSendResponse(200, {}), { kind: 'ok', messageId: null });
  });

  it('distinguishes API errors, retryable throttling, and fatal HTTP errors', () => {
    assert.deepEqual(
      classifyDingTalkSendResponse(200, { errcode: 80001, errmsg: 'token invalid' }),
      { kind: 'fatal', description: 'token invalid' },
    );
    assert.deepEqual(classifyDingTalkSendResponse(200, { errcode: 99999 }), {
      kind: 'fatal',
      description: 'errcode 99999',
    });
    const result = classifyDingTalkSendResponse(429, null);
    assert.equal(result.kind, 'retry');
    assert.deepEqual(classifyDingTalkSendResponse(403, { errmsg: 'Forbidden' }), {
      kind: 'fatal',
      description: 'Forbidden',
    });
    assert.deepEqual(classifyDingTalkSendResponse(502, null), {
      kind: 'fatal',
      description: 'HTTP 502',
    });
  });
});

describe('dingTalkPayloadToEvent', () => {
  it('stamps the send route from conversationType, not from id shapes (#5111)', () => {
    // Real DingTalk 1:1 and group conversationIds BOTH start with `cid`;
    // conversationType is the only authoritative discriminator, and the
    // 1:1 endpoint addresses by senderStaffId.
    const direct = dingTalkPayloadToEvent(
      {
        senderId: '$:LWCP_v1:$AbCdEf',
        senderNick: 'Alice',
        senderStaffId: '01234567890123456789',
        conversationId: 'cidZz9wYq==',
        conversationType: '1',
        text: { content: 'hello' },
        robotCode: 'app-key-1',
      },
      1_700_000_000_000,
    );
    assert.ok(direct);
    assert.equal(direct.platform, 'dingtalk');
    assert.equal(direct.userId, '$:LWCP_v1:$AbCdEf');
    assert.equal(direct.userName, 'Alice');
    assert.equal(direct.chatId, 'oto:01234567890123456789');
    assert.equal(direct.isGroup, false);
    assert.equal(direct.text, 'hello');
    assert.equal(direct.sourceMessageId, 'oto:01234567890123456789:1700000000000');

    const group = dingTalkPayloadToEvent(
      {
        senderId: 'user-2',
        conversationId: 'cidZz9wYq==',
        conversationType: '2',
        text: { content: 'hi' },
      },
      1,
    );
    assert.ok(group);
    assert.equal(group.chatId, 'group:cidZz9wYq==');
    assert.equal(group.isGroup, true);
    assert.equal(group.userName, 'user-2');
  });

  it('keeps the bare conversationId when no staffId is available (#5111)', () => {
    // Graceful fallback: the message still arrives, but the send side
    // fails closed on the unstamped id rather than guessing a route.
    const event = dingTalkPayloadToEvent(
      {
        senderId: 'u1',
        conversationId: 'cidNoStaff==',
        conversationType: '1',
        text: { content: 'hello' },
      },
      1,
    );
    assert.ok(event);
    assert.equal(event.chatId, 'cidNoStaff==');
  });

  it('drops payloads missing text or routing identity', () => {
    assert.equal(dingTalkPayloadToEvent({ senderId: 'u', conversationId: 'c' }, 1), null);
    assert.equal(dingTalkPayloadToEvent({ conversationId: 'c', text: { content: 'x' } }, 1), null);
    assert.equal(dingTalkPayloadToEvent({ senderId: 'u', text: { content: 'x' } }, 1), null);
  });
});

describe('buildDingTalkAckFrame', () => {
  it('builds default and data-bearing acknowledgements', () => {
    const ack = buildDingTalkAckFrame('msg-99');
    assert.equal(ack.code, 200);
    assert.equal(ack.headers.contentType, 'application/json');
    assert.equal(ack.headers.messageId, 'msg-99');
    assert.equal(ack.data, '{}');
    assert.equal(buildDingTalkAckFrame('msg-100', { received: true }).data, '{"received":true}');
  });
});
