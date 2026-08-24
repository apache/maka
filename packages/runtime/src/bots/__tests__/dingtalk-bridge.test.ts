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
  it('routes group and direct targets while rejecting empty ids', () => {
    assert.deepEqual(pickDingTalkSendRoute(' cidp-abc ', 'app-key-1', 'hello'), {
      path: '/v1.0/robot/groupMessages/send',
      body: {
        robotCode: 'app-key-1',
        openConversationId: 'cidp-abc',
        msgKey: 'sampleText',
        msgParam: '{"content":"hello"}',
      },
    });
    assert.deepEqual(pickDingTalkSendRoute(' user-99 ', 'app-key-1', 'hi'), {
      path: '/v1.0/robot/oToMessages/batchSend',
      body: {
        robotCode: 'app-key-1',
        userIds: ['user-99'],
        msgKey: 'sampleText',
        msgParam: '{"content":"hi"}',
      },
    });
    assert.equal(pickDingTalkSendRoute('   ', 'app-key-1', 'hi'), null);
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
  it('maps direct and group messages with stable identity fallbacks', () => {
    const event = dingTalkPayloadToEvent(
      {
        senderId: 'user-1',
        senderNick: 'Alice',
        conversationId: 'cidp-single',
        conversationType: '1',
        text: { content: 'hello' },
        robotCode: 'app-key-1',
      },
      1_700_000_000_000,
    );
    assert.ok(event);
    assert.equal(event!.platform, 'dingtalk');
    assert.equal(event!.userId, 'user-1');
    assert.equal(event!.userName, 'Alice');
    assert.equal(event!.chatId, 'cidp-single');
    assert.equal(event!.isGroup, false);
    assert.equal(event!.text, 'hello');
    assert.equal(event!.sourceMessageId, 'cidp-single:1700000000000');
    const groupEvent = dingTalkPayloadToEvent(
      {
        senderId: 'user-2',
        conversationId: 'cidp-group',
        conversationType: '2',
        text: { content: 'hi' },
      },
      1,
    );
    assert.equal(groupEvent!.isGroup, true);
    assert.equal(groupEvent!.userName, 'user-2');
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
