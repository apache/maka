import assert from 'node:assert/strict';
import test from 'node:test';

import {
  installWithRetry,
  isTransientElectronInstallFailure,
} from './install-electron-with-retry.mjs';

test('classifies transport and retryable HTTP failures as transient', () => {
  assert.equal(isTransientElectronInstallFailure('TypeError: fetch failed'), true);
  assert.equal(isTransientElectronInstallFailure('cause: ETIMEDOUT'), true);
  assert.equal(
    isTransientElectronInstallFailure(
      'Response code 503 (Service Unavailable) for https://example.invalid/electron.zip',
    ),
    true,
  );
  assert.equal(
    isTransientElectronInstallFailure(
      'Response code 404 (Not Found) for https://example.invalid/electron.zip',
    ),
    false,
  );
});

test('retries transient failures with bounded exponential backoff', async () => {
  const attempts = [];
  const delays = [];
  const warnings = [];

  const result = await installWithRetry(
    async (attempt) => {
      attempts.push(attempt);
      return attempt < 3 ? { status: 1, stderr: 'fetch failed' } : { status: 0, stderr: '' };
    },
    {
      wait: async (delay) => delays.push(delay),
      warn: (message) => warnings.push(message),
    },
  );

  assert.equal(result.status, 0);
  assert.deepEqual(attempts, [1, 2, 3]);
  assert.deepEqual(delays, [1_000, 2_000]);
  assert.equal(warnings.length, 2);
});

test('does not retry permanent failures', async () => {
  let attempts = 0;
  const result = await installWithRetry(async () => {
    attempts += 1;
    return { status: 1, stderr: 'Response code 404 (Not Found)' };
  });

  assert.equal(result.status, 1);
  assert.equal(attempts, 1);
});

test('stops after the configured number of attempts', async () => {
  let attempts = 0;
  const result = await installWithRetry(
    async () => {
      attempts += 1;
      return { status: 1, stderr: 'ECONNRESET' };
    },
    { maxAttempts: 2, baseDelayMs: 0, wait: async () => {}, warn: () => {} },
  );

  assert.equal(result.status, 1);
  assert.equal(attempts, 2);
});
