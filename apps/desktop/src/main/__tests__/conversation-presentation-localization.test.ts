import { strict as assert } from 'node:assert';
import { it } from 'node:test';
import { sessionEventErrorMessage } from '../../renderer/model-connection-errors.js';

it('generalizes unknown conversation failures without leaking provider details', () => {
  const event = {
    id: 'error-future-provider',
    turnId: 'turn-1',
    ts: 1,
    type: 'error' as const,
    recoverable: false,
    reason: 'future_provider_failure',
    message: 'Provider failed with token=provider-secret',
  };

  const messages = [
    sessionEventErrorMessage(event, 'zh'),
    sessionEventErrorMessage(event, 'en'),
  ];
  assert.deepEqual(messages, [
    '对话运行失败，请稍后重试。',
    'The conversation run failed. Try again later.',
  ]);
  assert.equal(JSON.stringify(messages).includes('provider-secret'), false);
});
