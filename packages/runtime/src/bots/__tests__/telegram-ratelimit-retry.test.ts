import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { __TEST__ } from '../simple-bridge.js';

const { classifyTelegramSendResponse, TELEGRAM_RETRY_MIN_MS, TELEGRAM_RETRY_MAX_MS } = __TEST__;

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
      [0, TELEGRAM_RETRY_MIN_MS],
      [3600, TELEGRAM_RETRY_MAX_MS],
      ['wat', TELEGRAM_RETRY_MIN_MS],
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
      [{ ok: false, error_code: 502, description: 'Bad Gateway' }, 'Bad Gateway'],
      [null, 'send-failed'],
      [{}, 'send-failed'],
    ];
    for (const [payload, description] of cases) {
      assert.deepEqual(classifyTelegramSendResponse(payload), { kind: 'fatal', description });
    }
  });
});
