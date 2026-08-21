import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getConversationCopy } from '../conversation-copy.js';

/**
 * A subscription quota window can hand the runtime an hour-scale Retry-After;
 * the banner must count down in humanized d/h/m/s units rather than a raw
 * five-digit second count that reads as a frozen hang.
 */
test('providerRetryScheduled humanizes hour-scale delays in both locales', () => {
  const zh = getConversationCopy('zh').messages.providerRetryScheduled;
  const en = getConversationCopy('en').messages.providerRetryScheduled;

  // Short delays keep the familiar seconds-only form.
  assert.equal(zh(1, 2, 10), '1秒后重试（2/10）');
  assert.equal(en(1, 2, 10), 'Retrying in 1s (2/10)');
  assert.equal(zh(45, 2, 10), '45秒后重试（2/10）');
  assert.equal(en(45, 2, 10), 'Retrying in 45s (2/10)');

  // Minute- and hour-scale delays spell out the units.
  assert.equal(zh(75, 2, 10), '1分 15秒后重试（2/10）');
  assert.equal(en(75, 2, 10), 'Retrying in 1m 15s (2/10)');
  assert.equal(zh(16_083, 2, 10), '4小时 28分 3秒后重试（2/10）');
  assert.equal(en(16_083, 2, 10), 'Retrying in 4h 28m 3s (2/10)');
  assert.equal(zh(90_061, 2, 10), '1天 1小时 1分 1秒后重试（2/10）');
  assert.equal(en(90_061, 2, 10), 'Retrying in 1d 1h 1m 1s (2/10)');
});
