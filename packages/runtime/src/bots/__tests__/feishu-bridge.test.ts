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
import test from 'node:test';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { createDefaultBotChannel } from '@maka/core/bot-chat-settings';
import {
  FeishuBotBridge,
  feishuAssistantMessages,
  feishuMessageToEvent,
  feishuHttpTransport,
} from '../feishu-bridge.js';

const message = (patch = {}) =>
  ({
    messageId: 'om_in',
    chatId: 'oc_private',
    chatType: 'p2p',
    senderId: 'ou_owner',
    content: 'hello',
    resources: [],
    rawContentType: 'text',
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: 1,
    ...patch,
  }) as NormalizedMessage;
async function fixture() {
  const handlers = new Map<string, (v: any) => void>();
  const sends: any[] = [],
    reactions: string[] = [],
    incoming: any[] = [];
  let fail = false;
  let readers: any = { code: 0, data: { items: [{ user_id: 'ou_owner' }] } };
  const settings = {
    ...createDefaultBotChannel('feishu'),
    enabled: true,
    messageHandling: 'assistant' as const,
    appId: 'app',
    appSecret: 'secret',
    allowedUserIds: ['ou_owner'],
  };
  const channel = {
    async connect() {},
    async disconnect() {},
    updatePolicy() {},
    on(name: string, fn: (v: any) => void) {
      handlers.set(name, fn);
      return () => handlers.delete(name);
    },
    rawClient: {
      im: {
        v1: {
          message: {
            async create(request: any) {
              sends.push(request);
              return fail ? { code: 999 } : { code: 0, data: { message_id: 'om_out' } };
            },
            async readUsers() {
              return readers;
            },
          },
        },
      },
    },
    async send(...args: any[]) {
      sends.push(args);
      return { messageId: 'om_legacy' };
    },
    async addReaction(id: string, emoji: string) {
      reactions.push(`add:${id}:${emoji}`);
      return `reaction-${id}`;
    },
    async removeReaction(id: string, reaction: string) {
      reactions.push(`remove:${id}:${reaction}`);
    },
  };
  const bridge = new FeishuBotBridge(
    settings,
    () =>
      ({
        createLarkChannel: () => channel,
        Domain: { Feishu: 'feishu', Lark: 'lark' },
        LoggerLevel: { error: 1 },
      }) as never,
  );
  bridge.on('message', (event) => incoming.push(event));
  await bridge.start();
  return {
    bridge,
    settings,
    sends,
    incoming,
    reactions,
    receive: (patch = {}) => handlers.get('message')!(message(patch)),
    setFail: () => {
      fail = true;
    },
    setReaders: (v: unknown) => {
      readers = v;
    },
  };
}

test('assistant DM policy rejects groups and strangers; empty media produces an acknowledgement event', async () => {
  const f = await fixture();
  try {
    f.receive({ chatType: 'group' });
    f.receive({ senderId: 'ou_stranger' });
    assert.equal(f.incoming.length, 0);
    f.receive();
    assert.equal(f.incoming[0].chatId, 'oc_private');
    f.receive({
      content: '<image key="img_key"/>',
      rawContentType: 'image',
      resources: [{ type: 'image', fileKey: 'img_key' }],
    });
    assert.equal(f.incoming[1].attachmentKind, 'photo');
    assert.equal(f.incoming[1].text, '');
    f.bridge.updateSettings({ ...f.settings, messageHandling: 'task' });
    f.receive({ chatType: 'group' });
    assert.equal(f.incoming.length, 3);
    assert.equal(feishuMessageToEvent(message({ content: '' }), 1), null);
  } finally {
    await f.bridge.stop();
  }
});

test('assistant uses open_id, Markdown fold cards and stable provider UUIDs for retries', async () => {
  const f = await fixture();
  try {
    const options = { summary: '**结果**', clientMessageId: 'stable-input' };
    assert.equal(
      await f.bridge.sendMessage('ou_owner', '正文 **加粗**\n- 内容', options),
      'om_out',
    );
    await f.bridge.sendMessage('ou_owner', '正文 **加粗**\n- 内容', options);
    assert.deepEqual(f.sends[0], f.sends[1]);
    assert.equal(f.sends[0].params.receive_id_type, 'open_id');
    assert.equal(f.sends[0].data.msg_type, 'interactive');
    const card = JSON.parse(f.sends[0].data.content);
    assert.equal(card.body.elements[0].content, '**结果**');
    assert.equal(card.body.elements[1].expanded, false);
    assert.match(card.body.elements[1].elements[0].content, /加粗/);
    await f.bridge.sendMessage('oc_group', 'legacy', { replyToMessageId: 'om_parent' });
    assert.deepEqual(f.sends[2], ['oc_group', { markdown: 'legacy' }, { replyTo: 'om_parent' }]);
    f.setFail();
    assert.equal(await f.bridge.sendMessage('ou_owner', 'oops', options), null);
  } finally {
    await f.bridge.stop();
  }
});

test('messages without a summary use ordinary Markdown posts, including empty summaries', async () => {
  const f = await fixture();
  try {
    const text = '你好 **重点**\n- 第一项\n- 第二项';
    for (const summary of [undefined, '', '  \n ']) {
      const options = { clientMessageId: `post-${String(summary)}`, summary };
      await f.bridge.sendMessage('ou_owner', text, options);
      await f.bridge.sendMessage('ou_owner', text, options);
      const [first, retry] = f.sends.slice(-2);
      assert.deepEqual(first, retry);
      assert.equal(first.data.msg_type, 'post');
      assert.deepEqual(JSON.parse(first.data.content), {
        zh_cn: { title: '', content: [[{ tag: 'md', text }]] },
      });
    }
  } finally {
    await f.bridge.stop();
  }
});

test('long posts and cards preserve Unicode content and distinct stable chunk identities', () => {
  const text = '你好😀\n'.repeat(9000);
  for (const summary of [undefined, '长消息摘要']) {
    const messages = feishuAssistantMessages(text, { clientMessageId: 'x', summary });
    assert.ok(messages.length > 1);
    assert.ok(messages.every((m) => m.msg_type === (summary ? 'interactive' : 'post')));
    assert.equal(
      messages
        .map((m) => {
          const content = JSON.parse(m.content);
          return summary
            ? content.body.elements[1].elements[0].content
            : content.zh_cn.content[0][0].text;
        })
        .join(''),
      text,
    );
    assert.equal(new Set(messages.map((m) => m.uuid)).size, messages.length);
    assert.ok(messages.every((m) => Buffer.byteLength(m.content) < 28000 && m.uuid.length <= 50));
  }
});

test('processing reaction is not re-added on polling and is removed on change, sleep and stop', async () => {
  const f = await fixture();
  f.receive();
  await Promise.all([
    f.bridge.sendTypingIndicator('ou_owner'),
    f.bridge.sendTypingIndicator('ou_owner'),
  ]);
  assert.deepEqual(f.reactions, ['add:om_in:Typing']);
  f.receive({ messageId: 'om_next' });
  await f.bridge.sendTypingIndicator('ou_owner');
  assert.deepEqual(f.reactions.slice(1), ['remove:om_in:reaction-om_in', 'add:om_next:Typing']);
  await f.bridge.cancelTypingIndicator('ou_owner');
  await f.bridge.sendTypingIndicator('ou_owner');
  await f.bridge.stop();
  assert.equal(f.reactions.at(-1), 'remove:om_next:reaction-om_next');
});

test('read status distinguishes actual reader, unread and unavailable permission', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await f.bridge.getMessageReadStatus('om_out', 'ou_owner'), { state: 'read' });
    f.setReaders({ code: 0, data: { items: [] } });
    assert.deepEqual(await f.bridge.getMessageReadStatus('om_out', 'ou_owner'), {
      state: 'unread',
    });
    f.setReaders({ code: 99991672 });
    assert.deepEqual(await f.bridge.getMessageReadStatus('om_out', 'ou_owner'), {
      state: 'unknown',
    });
  } finally {
    await f.bridge.stop();
  }
});

test('auxiliary API requests are bounded without imposing Agent time limits', async () => {
  const requests: any[] = [];
  const http = feishuHttpTransport({
    async request(options: unknown) {
      requests.push(options);
    },
  } as never);
  await http.request({ url: 'https://open.feishu.cn/open-apis/im/v1/messages/om_1/reactions' });
  await http.request({ url: 'https://open.feishu.cn/open-apis/im/v1/messages/om_1/read_users' });
  await http.request({ url: 'https://open.feishu.cn/open-apis/im/v1/messages' });
  assert.deepEqual(
    requests.map((r) => r.timeout),
    [3000, 3000, 15000],
  );
});
