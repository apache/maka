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

it('turns missing model configuration into setup guidance', () => {
  const event = {
    id: 'error-no-connection',
    turnId: 'turn-2',
    ts: 2,
    type: 'error' as const,
    recoverable: false,
    code: 'NO_REAL_CONNECTION',
    reason: 'connection_missing',
    message: 'NO_REAL_CONNECTION:connection_missing: unavailable',
  };

  assert.equal(
    sessionEventErrorMessage(event, 'zh'),
    '该会话依赖的模型连接已删除，请到 设置 · 模型 重新选择或重建连接。',
  );
  assert.equal(
    sessionEventErrorMessage(event, 'en'),
    'The model connection used by this conversation was deleted. Select or create one in Settings · Models.',
  );
});
