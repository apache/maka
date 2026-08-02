import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { __TEST__ } from '../simple-bridge.js';

const { telegramAttachmentKind } = __TEST__;

describe('telegramAttachmentKind', () => {
  it('maps supported attachment fields and rejects non-attachments', () => {
    const cases: Array<[unknown, string | undefined]> = [
      [{ text: 'hello' }, undefined],
      [{ caption: 'hi' }, undefined],
      [{ photo: [] }, undefined],
      [undefined, undefined],
      [null, undefined],
      ['text', undefined],
      [{ photo: [{ file_id: 'a' }], caption: 'look' }, 'photo'],
      [{ voice: { file_id: 'v' } }, 'voice'],
      [{ audio: { file_id: 'a' } }, 'audio'],
      [{ sticker: { file_id: 's' } }, 'sticker'],
      [{ animation: { file_id: 'g' } }, 'animation'],
      [{ video: { file_id: 'v' } }, 'video'],
      [{ video_note: { file_id: 'vn' } }, 'video'],
      [{ document: { file_id: 'd' } }, 'document'],
    ];
    for (const [message, expected] of cases) {
      assert.equal(telegramAttachmentKind(message), expected, JSON.stringify(message));
    }
  });

  it('classifies less common Telegram payloads as unknown so they still receive an ack', () => {
    for (const message of [
      { location: { latitude: 0, longitude: 0 } },
      { contact: { phone_number: '+1' } },
      { poll: { question: 'q' } },
      { dice: { emoji: '🎲', value: 4 } },
      { venue: { title: 'v' } },
    ]) {
      assert.equal(telegramAttachmentKind(message), 'unknown');
    }
  });
});
