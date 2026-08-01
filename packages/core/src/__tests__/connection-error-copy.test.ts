import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  describeChatConfigurationReason,
  parseNoRealConnectionError,
} from '../connection-error-copy.js';

describe('connection error presentation', () => {
  it('keeps credential and unknown runtime guidance safe', () => {
    assert.match(describeChatConfigurationReason('missing_api_key'), /API key/);
    assert.equal(
      describeChatConfigurationReason('future_reason'),
      describeChatConfigurationReason(undefined),
    );
  });

  it('parses recognized bare, wrapped, and non-Error forms', () => {
    const cases = [
      [
        new Error('NO_REAL_CONNECTION:missing_default_connection'),
        { matched: true, reason: 'missing_default_connection' },
      ],
      [
        new Error(
          "Error invoking remote method 'send': Error: NO_REAL_CONNECTION:missing_api_key: no key",
        ),
        { matched: true, reason: 'missing_api_key' },
      ],
      ['NO_REAL_CONNECTION:fake_backend', { matched: true, reason: 'fake_backend' }],
    ] as const;
    for (const [error, expected] of cases) {
      assert.deepEqual(parseNoRealConnectionError(error), expected);
    }
  });

  it('does not promote malformed or unrelated tokens to known reasons', () => {
    const cases = [
      ['network timeout', { matched: false }],
      ['NO_REAL_CONNECTIONS cache failed', { matched: false }],
      ['NO_REAL_CONNECTION', { matched: true, reason: undefined }],
      ['NO_REAL_CONNECTION:not_a_real_reason', { matched: true, reason: undefined }],
      ['NO_REAL_CONNECTION:missing_api_key2', { matched: true, reason: undefined }],
    ] as const;
    for (const [message, expected] of cases) {
      assert.deepEqual(parseNoRealConnectionError(new Error(message)), expected);
    }
  });
});
