import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { whatsappMessageToEvent, whatsappTimestampMs } from '../whatsapp-bridge.js';

describe('WhatsApp bridge message mapping', () => {
  test('maps group text with participant identity and seconds timestamp', () => {
    assert.deepEqual(
      whatsappMessageToEvent(
        {
          key: {
            id: 'wamid-1',
            remoteJid: 'group@g.us',
            participant: '8613800000000@s.whatsapp.net',
            fromMe: false,
          },
          pushName: 'Alice',
          messageTimestamp: 1_720_000_000,
          message: { conversation: 'hello from WhatsApp' },
        },
        9,
      ),
      {
        platform: 'whatsapp',
        userId: '8613800000000@s.whatsapp.net',
        userName: 'Alice',
        chatId: 'group@g.us',
        isGroup: true,
        text: 'hello from WhatsApp',
        sourceMessageId: 'wamid-1',
        receivedAt: 1_720_000_000_000,
      },
    );
  });

  test('supports Long-like timestamps and media captions', () => {
    assert.equal(whatsappTimestampMs({ toNumber: () => 42 }, 7), 42_000);
    assert.equal(whatsappTimestampMs({ low: 43 }, 7), 43_000);
    assert.equal(whatsappTimestampMs(null, 7), 7);
    const event = whatsappMessageToEvent(
      {
        key: {
          id: 'wamid-2',
          remoteJid: '8613800000000@s.whatsapp.net',
          fromMe: false,
        },
        message: { imageMessage: { caption: 'caption' } },
      },
      11,
    );
    assert.equal(event?.text, 'caption');
    assert.equal(event?.isGroup, false);
    assert.equal(event?.receivedAt, 11);
  });

  test('drops own messages and status broadcasts', () => {
    assert.equal(
      whatsappMessageToEvent(
        {
          key: {
            id: 'wamid-own',
            remoteJid: 'chat@s.whatsapp.net',
            fromMe: true,
          },
        },
        1,
      ),
      null,
    );
    assert.equal(
      whatsappMessageToEvent(
        {
          key: {
            id: 'wamid-status',
            remoteJid: 'status@broadcast',
            fromMe: false,
          },
        },
        1,
      ),
      null,
    );
  });
});
