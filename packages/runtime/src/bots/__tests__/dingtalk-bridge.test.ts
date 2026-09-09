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

// Realistic identifier shapes. Both conversation kinds begin with `cid`,
// which is the whole point: any implementation that infers the route from
// DingTalk's own id format instead of the stamped prefix fails these.
const SINGLE_CONVERSATION_ID = 'cidEXAMPLEsingle0Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8=';
const GROUP_CONVERSATION_ID = 'cidEXAMPLEgroup9Zy8Xw7Vu6Ts5Rq4Po3Nm2Lk1J=';
const SENDER_ID = '$:LWCP_v1:$0Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv';
const SENDER_STAFF_ID = '01234567890123456789';

describe('pickDingTalkSendRoute', () => {
  it('routes a stamped single chat to the 1:1 endpoint by staff id', () => {
    assert.deepEqual(pickDingTalkSendRoute(` oto:${SENDER_STAFF_ID} `, 'app-key-1', 'hi'), {
      path: '/v1.0/robot/oToMessages/batchSend',
      body: {
        robotCode: 'app-key-1',
        userIds: [SENDER_STAFF_ID],
        msgKey: 'sampleText',
        msgParam: '{"content":"hi"}',
      },
    });
  });

  it('routes a stamped group chat to the group endpoint', () => {
    assert.deepEqual(
      pickDingTalkSendRoute(` group:${GROUP_CONVERSATION_ID} `, 'app-key-1', 'hello'),
      {
        path: '/v1.0/robot/groupMessages/send',
        body: {
          robotCode: 'app-key-1',
          openConversationId: GROUP_CONVERSATION_ID,
          msgKey: 'sampleText',
          msgParam: '{"content":"hello"}',
        },
      },
    );
  });

  it('keeps unprefixed ids on the group endpoint for pre-existing delivery targets', () => {
    // Scheduled-task delivery targets persisted before the prefix existed,
    // and ids typed by hand into the scheduled task form.
    const route = pickDingTalkSendRoute(GROUP_CONVERSATION_ID, 'app-key-1', 'hello');
    assert.equal(route?.path, '/v1.0/robot/groupMessages/send');
    assert.equal(route?.body.openConversationId, GROUP_CONVERSATION_ID);
  });

  it('rejects empty and prefix-only ids', () => {
    assert.equal(pickDingTalkSendRoute('   ', 'app-key-1', 'hi'), null);
    assert.equal(pickDingTalkSendRoute('oto:', 'app-key-1', 'hi'), null);
    assert.equal(pickDingTalkSendRoute('oto:   ', 'app-key-1', 'hi'), null);
    assert.equal(pickDingTalkSendRoute('group:', 'app-key-1', 'hi'), null);
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
  it('addresses a single chat by staff id, not by conversation id', () => {
    const event = dingTalkPayloadToEvent(
      {
        senderId: SENDER_ID,
        senderStaffId: SENDER_STAFF_ID,
        senderNick: 'Alice',
        conversationId: SINGLE_CONVERSATION_ID,
        conversationType: '1',
        text: { content: 'hello' },
        robotCode: 'app-key-1',
      },
      1_700_000_000_000,
    );
    assert.ok(event);
    assert.equal(event!.platform, 'dingtalk');
    assert.equal(event!.userId, SENDER_ID);
    assert.equal(event!.userName, 'Alice');
    assert.equal(event!.chatId, `oto:${SENDER_STAFF_ID}`);
    assert.equal(event!.isGroup, false);
    assert.equal(event!.text, 'hello');
    assert.equal(event!.sourceMessageId, `${SINGLE_CONVERSATION_ID}:1700000000000`);
  });

  it('addresses a group chat by conversation id', () => {
    const groupEvent = dingTalkPayloadToEvent(
      {
        senderId: SENDER_ID,
        senderStaffId: SENDER_STAFF_ID,
        conversationId: GROUP_CONVERSATION_ID,
        conversationType: '2',
        text: { content: 'hi' },
      },
      1,
    );
    assert.ok(groupEvent);
    assert.equal(groupEvent!.isGroup, true);
    assert.equal(groupEvent!.chatId, `group:${GROUP_CONVERSATION_ID}`);
    assert.equal(groupEvent!.userName, SENDER_ID);
  });

  it('round-trips a single chat from receive to the 1:1 send body', () => {
    // The regression this guards: a 1:1 conversationId also starts with
    // `cid`, so routing on the raw id sends direct replies to the group
    // endpoint and DingTalk answers 400 resource.not.found.
    const event = dingTalkPayloadToEvent(
      {
        senderId: SENDER_ID,
        senderStaffId: SENDER_STAFF_ID,
        conversationId: SINGLE_CONVERSATION_ID,
        conversationType: '1',
        text: { content: 'ping' },
      },
      1,
    );
    const route = pickDingTalkSendRoute(event!.chatId, 'app-key-1', 'pong');
    assert.equal(route?.path, '/v1.0/robot/oToMessages/batchSend');
    assert.deepEqual(route?.body.userIds, [SENDER_STAFF_ID]);
  });

  it('round-trips a group chat from receive to the group send body', () => {
    const event = dingTalkPayloadToEvent(
      {
        senderId: SENDER_ID,
        senderStaffId: SENDER_STAFF_ID,
        conversationId: GROUP_CONVERSATION_ID,
        conversationType: '2',
        text: { content: 'ping' },
      },
      1,
    );
    const route = pickDingTalkSendRoute(event!.chatId, 'app-key-1', 'pong');
    assert.equal(route?.path, '/v1.0/robot/groupMessages/send');
    assert.equal(route?.body.openConversationId, GROUP_CONVERSATION_ID);
  });

  it('still delivers a single chat that carries no staff id', () => {
    // Nothing to address a 1:1 reply to, but receiving must not depend on
    // being able to reply.
    const event = dingTalkPayloadToEvent(
      {
        senderId: SENDER_ID,
        conversationId: SINGLE_CONVERSATION_ID,
        conversationType: '1',
        text: { content: 'hello' },
      },
      1,
    );
    assert.ok(event);
    assert.equal(event!.isGroup, false);
    assert.equal(event!.chatId, SINGLE_CONVERSATION_ID);
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
