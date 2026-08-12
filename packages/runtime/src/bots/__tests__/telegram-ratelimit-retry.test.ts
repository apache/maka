import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { __TEST__ } from '../simple-bridge.js';

const { classifyTelegramSendResponse } = __TEST__;

describe('classifyTelegramSendResponse', () => {
  it('returns the optional message id on successful responses', () => {
    assert.deepEqual(classifyTelegramSendResponse({ ok: true, result: { message_id: 12345 } }), {
      kind: 'ok',
      messageId: '12345',
    });
    assert.deepEqual(classifyTelegramSendResponse({ ok: true, result: {} }), {
      kind: 'ok',
      messageId: null,
    });
  });

  it('clamps Telegram retry hints to the bounded retry window', () => {
    for (const [retryAfter, expected] of [
      [5, 5_000],
      [3600, 30_000],
      ['wat', 1_000],
    ] as const) {
      const result = classifyTelegramSendResponse({
        ok: false,
        error_code: 429,
        parameters: { retry_after: retryAfter },
      });
      assert.equal(result.kind, 'retry');
      if (result.kind === 'retry') assert.equal(result.delayMs, expected, String(retryAfter));
    }
  });

  it('classifies permanent and malformed failures with stable descriptions', () => {
    const cases: Array<[unknown, string]> = [
      [{ ok: false, error_code: 400, description: 'Bad Request' }, 'Bad Request'],
      [null, 'send-failed'],
    ];
    for (const [payload, description] of cases) {
      assert.deepEqual(classifyTelegramSendResponse(payload), { kind: 'fatal', description });
    }
  });
});
