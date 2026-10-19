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
import { createServer } from 'node:http';
import { describe, test } from 'node:test';
import { createDefaultBotChannel } from '@maka/core/bot-chat-settings';
import { botReadinessFromSettings, botSettingsRequireRestart } from '../base-adapter.js';
import {
  WechatBridge,
  getWechatBridgeQrCode,
  mapWechatIlinkMessage,
  mapWechatBridgeMessage,
  normalizeWechatBridgeUrl,
  normalizeWechatIlinkBaseUrl,
  normalizeWechatSendTarget,
  readSseJsonObjects,
} from '../wechat-bridge.js';

describe('WechatBridge', () => {
  test('normalizes only local http bridge URLs', () => {
    assert.equal(normalizeWechatBridgeUrl(undefined), 'http://127.0.0.1:18400');
    assert.equal(normalizeWechatBridgeUrl(' http://localhost:18400/ '), 'http://localhost:18400');
    assert.equal(normalizeWechatBridgeUrl('https://127.0.0.1:18400'), null);
    assert.equal(normalizeWechatBridgeUrl('http://192.168.0.2:18400'), null);
  });

  test('normalizes only the iLink base URL for direct WeChat login', () => {
    assert.equal(normalizeWechatIlinkBaseUrl(undefined), null);
    assert.equal(
      normalizeWechatIlinkBaseUrl(' https://ilinkai.weixin.qq.com/ '),
      'https://ilinkai.weixin.qq.com',
    );
    assert.equal(normalizeWechatIlinkBaseUrl('http://ilinkai.weixin.qq.com'), null);
    assert.equal(normalizeWechatIlinkBaseUrl('https://example.com'), null);
  });

  test('normalizes send targets before direct bridge and iLink sends', () => {
    assert.equal(normalizeWechatSendTarget(' room@chatroom '), 'room@chatroom');
    assert.equal(normalizeWechatSendTarget('   '), null);
  });

  test('bridge URL is a credential fact and a restart boundary', () => {
    const channel = createDefaultBotChannel('wechat');
    assert.equal(channel.webhookUrl, 'http://127.0.0.1:18400');
    assert.equal(botReadinessFromSettings({ ...channel, enabled: true }), 'configured');
    assert.equal(
      botSettingsRequireRestart(channel, { ...channel, webhookUrl: 'http://localhost:18400' }),
      true,
    );
  });

  test('fetches an iLink-compatible QR payload from the local bridge and renders a data URL', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/api/weixin/qrcode') {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            qrcode: 'weixin://scan-login/example-token',
            expired: false,
            loggedIn: false,
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not found' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      assert.equal(typeof address, 'object');
      const port = typeof address === 'object' && address ? address.port : 0;
      const channel = {
        ...createDefaultBotChannel('wechat'),
        webhookUrl: `http://127.0.0.1:${port}`,
      };

      const result = await getWechatBridgeQrCode(channel);

      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.expired, false);
      assert.equal(result.loggedIn, false);
      assert.match(result.qrcode ?? '', /^data:image\/png;base64,/);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  test('rejects QR requests to non-local bridge URLs', async () => {
    const result = await getWechatBridgeQrCode({
      ...createDefaultBotChannel('wechat'),
      webhookUrl: 'https://example.com/wechat-bridge',
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /127\.0\.0\.1|localhost/);
  });

  test('maps live direct bridge messages into bot events', () => {
    const event = mapWechatBridgeMessage({
      chatId: 'wxid_friend',
      senderId: 'wxid_friend',
      senderName: 'Alice',
      messageId: 'msg-1',
      body: 'hello',
      timestamp: 1_700_000_000,
    });

    assert.deepEqual(event, {
      platform: 'wechat',
      userId: 'wxid_friend',
      userName: 'Alice',
      chatId: 'wxid_friend',
      isGroup: false,
      text: 'hello',
      sourceMessageId: 'msg-1',
      receivedAt: 1_700_000_000_000,
    });
  });

  test('drops self messages and unmentioned group messages', () => {
    assert.equal(
      mapWechatBridgeMessage({
        chatId: 'wxid_friend',
        senderId: 'wxid_friend',
        messageId: 'self',
        body: 'loop',
        fromSelf: true,
      }),
      null,
    );

    assert.equal(
      mapWechatBridgeMessage({
        chatId: 'room@chatroom',
        senderId: 'wxid_member',
        messageId: 'group-no-at',
        body: 'not for maka',
      }),
      null,
    );
  });

  test('accepts mentioned group messages and common bridge aliases', () => {
    const event = mapWechatBridgeMessage({
      roomId: 'room@chatroom',
      fromWxid: 'wxid_member',
      nickname: 'Bob',
      msgId: 'group-1',
      content: '@Maka ping',
      isAt: true,
      createTime: 1_700_000_001_234,
    });

    assert.equal(event?.platform, 'wechat');
    assert.equal(event?.chatId, 'room@chatroom');
    assert.equal(event?.userId, 'wxid_member');
    assert.equal(event?.userName, 'Bob');
    assert.equal(event?.isGroup, true);
    assert.equal(event?.sourceMessageId, 'group-1');
    assert.equal(event?.text, '@Maka ping');
    assert.equal(event?.receivedAt, 1_700_000_001_234);
  });

  test('maps iLink text and voice transcript messages into bot events', () => {
    const event = mapWechatIlinkMessage({
      from_user_id: 'wxid_friend',
      client_id: 'client-1',
      create_time: 1_700_000_002,
      item_list: [
        { type: 1, text_item: { text: 'hello' } },
        { type: 3, voice_item: { text: 'voice transcript' } },
      ],
    });

    assert.equal(event?.platform, 'wechat');
    assert.equal(event?.chatId, 'wxid_friend');
    assert.equal(event?.userId, 'wxid_friend');
    assert.equal(event?.sourceMessageId, 'client-1');
    assert.equal(event?.text, 'hello\nvoice transcript');
    assert.equal(event?.receivedAt, 1_700_000_002_000);
  });

  test('maps bridge media kinds and rejects empty non-media messages', () => {
    assert.equal(
      mapWechatBridgeMessage({
        chatId: 'wxid_friend',
        senderId: 'wxid_friend',
        messageId: 'empty',
        body: '',
      }),
      null,
    );

    assert.equal(
      mapWechatBridgeMessage({
        chatId: 'wxid_friend',
        senderId: 'wxid_friend',
        messageId: 'image',
        messageKind: 'image',
      })?.attachmentKind,
      'photo',
    );

    assert.equal(
      mapWechatBridgeMessage({
        chatId: 'wxid_friend',
        senderId: 'wxid_friend',
        messageId: 'voice',
        mediaType: 'voice',
      })?.attachmentKind,
      'voice',
    );

    assert.equal(
      mapWechatBridgeMessage({
        chatId: 'wxid_friend',
        senderId: 'wxid_friend',
        messageId: 'file',
        type: 'file',
      })?.attachmentKind,
      'document',
    );
  });

  test('parses SSE data objects with LF and CRLF event boundaries', async () => {
    const encoder = new TextEncoder();
    async function* chunks(): AsyncGenerator<Uint8Array> {
      yield encoder.encode('event: message\r\ndata: {"id":1}\r\n\r\n');
      yield encoder.encode('data: [{"id":2}');
      yield encoder.encode(',{"id":3}]\n\n');
    }

    const parsed: unknown[] = [];
    for await (const value of readSseJsonObjects(chunks())) parsed.push(value);

    assert.deepEqual(parsed, [{ id: 1 }, [{ id: 2 }, { id: 3 }]]);
  });
});

test('iLink uses the latest per-user reply context, persists it, and rejects HTTP-200 business failures', async () => {
  const { MockAgent, getGlobalDispatcher, setGlobalDispatcher } = await import('undici');
  const { mkdtemp, readFile, readdir, rm, stat } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'wechat-context-'));
  const previous = getGlobalDispatcher();
  const mock = new MockAgent();
  mock.disableNetConnect();
  setGlobalDispatcher(mock);
  const pool = mock.get('https://ilinkai.weixin.qq.com');
  for (const kind of ['start', 'stop'])
    pool
      .intercept({ path: `/ilink/bot/msg/notify${kind}`, method: 'POST' })
      .reply(200, { ret: 0 })
      .persist();
  const posted: any[] = [];
  let fail = false;
  pool
    .intercept({ path: '/ilink/bot/sendmessage', method: 'POST' })
    .reply(200, (req) => {
      posted.push(JSON.parse(String(req.body)));
      return fail ? { ret: -2 } : { ret: 0 };
    })
    .persist();
  pool.intercept({ path: '/ilink/bot/getupdates', method: 'POST' }).reply(200, {
    ret: 0,
    msgs: [
      {
        message_type: 1,
        from_user_id: 'owner',
        context_token: 'latest-owner-context',
        message_id: 'm1',
        item_list: [{ type: 1, text_item: { text: 'hi' } }],
      },
      {
        message_type: 1,
        from_user_id: 'stranger',
        context_token: 'wrong-context',
        message_id: 'm2',
        item_list: [{ type: 1, text_item: { text: 'no' } }],
      },
    ],
  });
  pool
    .intercept({ path: '/ilink/bot/getupdates', method: 'POST' })
    .reply(200, { ret: 0, msgs: [] })
    .persist();
  const config = {
    ...createDefaultBotChannel('wechat'),
    enabled: true,
    token: 'test-token',
    webhookUrl: 'https://ilinkai.weixin.qq.com',
    botUserId: 'bot',
    allowedUserIds: ['owner'],
  };
  let bridge = new WechatBridge(config, dir);
  try {
    const received = new Promise<void>((resolve) => bridge.once('message', () => resolve()));
    await bridge.start();
    await received;
    assert.ok(await bridge.sendMessage('owner', 'reply'));
    assert.equal(posted[0].msg.context_token, 'latest-owner-context');
    assert.ok(await bridge.sendMessage('stranger', 'test-context-isolation'));
    assert.equal(posted[1].msg.context_token, undefined);
    fail = true;
    assert.equal(await bridge.sendMessage('owner', 'rejected'), null);
    assert.equal(bridge.getStatus().readiness, 'degraded');
    const files = await readdir(dir);
    assert.equal(files.length, 1);
    assert.equal((await stat(join(dir, files[0]!))).mode & 0o777, 0o600);
    assert.doesNotMatch(await readFile(join(dir, files[0]!), 'utf8'), /wrong-context/);
    await bridge.stop();
    bridge = new WechatBridge(config, dir);
    fail = false;
    await bridge.start();
    assert.ok(await bridge.sendMessage('owner', 'after restart'));
    assert.equal(posted.at(-1).msg.context_token, 'latest-owner-context');
    assert.equal(
      mapWechatIlinkMessage({
        message_type: 2,
        from_user_id: 'bot',
        item_list: [{ type: 1, text_item: { text: 'echo' } }],
      }),
      null,
    );
  } finally {
    await bridge.stop();
    setGlobalDispatcher(previous);
    await mock.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('iLink typing fetches and caches tickets, cancels, isolates users, and preserves server message IDs', async () => {
  const { MockAgent, getGlobalDispatcher, setGlobalDispatcher } = await import('undici');
  const previous = getGlobalDispatcher();
  const mock = new MockAgent();
  mock.disableNetConnect();
  setGlobalDispatcher(mock);
  const pool = mock.get('https://ilinkai.weixin.qq.com');
  const events: string[] = [];
  const typing: any[] = [];
  let configs = 0;
  let failTyping = false;
  pool
    .intercept({ path: '/ilink/bot/getupdates', method: 'POST' })
    .reply(200, { ret: 0, msgs: [] })
    .persist();
  for (const kind of ['start', 'stop'])
    pool
      .intercept({ path: `/ilink/bot/msg/notify${kind}`, method: 'POST' })
      .reply(200, () => {
        events.push(kind);
        return { ret: -1 }; // Advisory failures must not disable chat.
      })
      .persist();
  pool
    .intercept({ path: '/ilink/bot/getconfig', method: 'POST' })
    .reply(200, (req) => {
      assert.equal(JSON.parse(String(req.body)).ilink_user_id, 'owner');
      configs++;
      return { ret: 0, typing_ticket: 'ticket' };
    })
    .persist();
  pool
    .intercept({ path: '/ilink/bot/sendtyping', method: 'POST' })
    .reply(200, (req) => {
      const body = JSON.parse(String(req.body));
      typing.push(body);
      assert.equal(body.typing_ticket, 'ticket');
      return { ret: failTyping ? -1 : 0 };
    })
    .persist();
  pool
    .intercept({ path: '/ilink/bot/sendmessage', method: 'POST' })
    .reply(200, '{"ret":0,"message_id":18446744073709551614}')
    .persist();
  const bridge = new WechatBridge({
    ...createDefaultBotChannel('wechat'),
    enabled: true,
    token: 'synthetic',
    webhookUrl: 'https://ilinkai.weixin.qq.com',
    botUserId: 'bot',
    allowedUserIds: ['owner'],
  });
  try {
    await bridge.start();
    assert.equal(await bridge.sendTypingIndicator('stranger'), false);
    assert.equal(configs, 0);
    assert.deepEqual(
      await Promise.all([
        bridge.sendTypingIndicator('owner'),
        bridge.sendTypingIndicator('owner'),
        bridge.cancelTypingIndicator('owner'),
      ]),
      [true, true, true],
    );
    assert.equal(configs, 1);
    assert.deepEqual(
      typing.map((x) => x.status),
      [1, 1, 2],
    );
    failTyping = true;
    assert.equal(await bridge.sendTypingIndicator('owner'), false);
    assert.equal(bridge.isRunning(), true);
    failTyping = false;
    assert.equal(await bridge.sendTypingIndicator('owner'), true);
    assert.equal(configs, 2);
    assert.equal(await bridge.sendMessage('owner', 'hi'), '18446744073709551614');
    await bridge.stop();
    assert.equal(typing.at(-1).status, 2);
    assert.deepEqual(events, ['start', 'stop']);
    assert.equal(await bridge.sendTypingIndicator('owner'), false);
  } finally {
    await bridge.stop();
    setGlobalDispatcher(previous);
    await mock.close();
  }
});
