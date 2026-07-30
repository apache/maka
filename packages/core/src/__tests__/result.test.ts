import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import * as result from '../result.js';
import * as legacyResult from '../settings/result.js';

describe('Result', () => {
  test('builds success and error envelopes', () => {
    assert.deepEqual(result.ok('value'), { ok: true, data: 'value' });
    assert.deepEqual(result.err('invalid', 'Invalid value'), {
      ok: false,
      error: { code: 'invalid', message: 'Invalid value', details: undefined },
    });
  });

  test('captures thrown values from async operations', async () => {
    const cause = new Error('failed');
    assert.deepEqual(
      await result.tryResult(async () => {
        throw cause;
      }, 'operation_failed'),
      {
        ok: false,
        error: { code: 'operation_failed', message: 'failed', details: cause },
      },
    );
  });

  test('keeps the settings subpath as a compatibility re-export', () => {
    assert.strictEqual(legacyResult.ok, result.ok);
    assert.strictEqual(legacyResult.err, result.err);
    assert.strictEqual(legacyResult.tryResult, result.tryResult);
  });
});
