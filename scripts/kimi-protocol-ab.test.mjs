import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseKimiProtocolAbEnv } from '../packages/headless/harbor/run-kimi-protocol-ab.mjs';

describe('Kimi protocol A/B launcher', () => {
  test('rejects missing or duplicate task ids before any benchmark work', () => {
    assert.throws(
      () =>
        parseKimiProtocolAbEnv({ MAKA_KIMI_PROTOCOL_AB_OUT_DIR: '/tmp/kimi-protocol-ab' }, '/repo'),
      /MAKA_KIMI_PROTOCOL_AB_TASK_IDS is required/,
    );
    assert.throws(
      () =>
        parseKimiProtocolAbEnv(
          {
            MAKA_KIMI_PROTOCOL_AB_OUT_DIR: '/tmp/kimi-protocol-ab',
            MAKA_KIMI_PROTOCOL_AB_TASK_IDS: 'task-a,task-a',
          },
          '/repo',
        ),
      /duplicate task id/,
    );
  });
});
