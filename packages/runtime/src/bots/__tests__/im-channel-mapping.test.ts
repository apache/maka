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
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { TextMessage, WsFrame } from '@wecom/aibot-node-sdk';
import { closeLarkChannel, feishuMessageToEvent } from '../feishu-bridge.js';
import { closeWeComClient, wecomTextFrameToEvent } from '../wecom-bridge.js';

describe('IM channel event mapping', () => {
  it('maps a normalized Feishu group message without retaining the raw SDK payload', () => {
    const message = {
      messageId: 'om_1',
      chatId: 'oc_1',
      chatType: 'group',
      senderId: 'ou_1',
      senderName: 'Alice',
      content: 'hello',
      rawContentType: 'text',
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: true,
      createTime: 123,
      raw: { private: 'must-not-cross-runtime-boundary' },
    } satisfies NormalizedMessage;
    const event = feishuMessageToEvent(message, 456);
    assert.deepEqual(event, {
      platform: 'feishu',
      userId: 'ou_1',
      userName: 'Alice',
      chatId: 'oc_1',
      isGroup: true,
      text: 'hello',
      sourceMessageId: 'om_1',
      receivedAt: 456,
    });
    assert.equal(JSON.stringify(event).includes('must-not-cross'), false);
  });

  it('drops Feishu group messages outside the local allowlist', () => {
    // PR1197 review: the Lark SDK dmAllowlist is DM-only, so a group message
    // from an unauthorized sender must be dropped by the bridge's own local
    // allowlist. Empty/absent list allows all (asserted implicitly by the
    // mapping test above, which passes no allowlist and returns an event).
    const message = {
      messageId: 'om_2',
      chatId: 'oc_2',
      chatType: 'group',
      senderId: 'ou_blocked',
      senderName: 'Mallory',
      content: 'hello',
      rawContentType: 'text',
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: true,
      createTime: 123,
      raw: {},
    } satisfies NormalizedMessage;
    assert.equal(feishuMessageToEvent(message, 456, ['ou_allowed']), null);
  });

  it('maps a WeCom direct text message to the sender conversation', () => {
    const frame = {
      headers: { req_id: 'req_1' },
      body: {
        msgid: 'msg_1',
        aibotid: 'bot_1',
        chattype: 'single',
        from: { userid: 'user_1' },
        msgtype: 'text',
        text: { content: 'question' },
      },
    } as WsFrame<TextMessage>;
    assert.deepEqual(wecomTextFrameToEvent(frame, 789), {
      platform: 'wecom',
      userId: 'user_1',
      userName: 'user_1',
      chatId: 'user_1',
      isGroup: false,
      text: 'question',
      sourceMessageId: 'msg_1',
      receivedAt: 789,
    });
  });

  it('drops WeCom messages outside the local allowlist', () => {
    const frame = {
      headers: { req_id: 'req_2' },
      body: {
        msgid: 'msg_2',
        aibotid: 'bot_1',
        chatid: 'group_1',
        chattype: 'group',
        from: { userid: 'blocked_user' },
        msgtype: 'text',
        text: { content: 'question' },
      },
    } as WsFrame<TextMessage>;
    assert.equal(wecomTextFrameToEvent(frame, 789, ['allowed_user']), null);
  });

  it('force-closes a Feishu raw socket even when the channel handshake never completed', async () => {
    const calls: string[] = [];
    await closeLarkChannel({
      rawWsClient: {
        close(options?: { force?: boolean }) {
          calls.push(`raw:${String(options?.force)}`);
        },
      } as never,
      async disconnect() {
        calls.push('channel');
      },
    });
    assert.deepEqual(calls, ['raw:true', 'channel']);
  });

  it('detaches WeCom listeners before disconnecting the client', () => {
    const calls: string[] = [];
    closeWeComClient({
      removeAllListeners() {
        calls.push('listeners');
        return undefined as never;
      },
      disconnect() {
        calls.push('disconnect');
      },
    });
    assert.deepEqual(calls, ['listeners', 'disconnect']);
  });
});
