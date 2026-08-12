import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, test } from 'node:test';
import { createDefaultBotChannel } from '@maka/core/bot-chat-settings';
import { botReadinessFromSettings, botSettingsRequireRestart } from '../base-adapter.js';
import {
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
