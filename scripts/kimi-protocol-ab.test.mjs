import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseKimiProtocolAbEnv } from '../packages/headless/harbor/run-kimi-protocol-ab.mjs';

describe('Kimi protocol A/B launcher', () => {
  test('requires explicit tasks and applies conservative sequential-run defaults', () => {
    const options = parseKimiProtocolAbEnv(
      {
        MAKA_KIMI_PROTOCOL_AB_OUT_DIR: '/tmp/kimi-protocol-ab',
        MAKA_KIMI_PROTOCOL_AB_TASK_IDS: 'task-a, task-b',
        MAKA_KIMI_PROTOCOL_AB_DRY_RUN: '1',
      },
      '/repo',
    );

    assert.deepEqual(options.taskIds, ['task-a', 'task-b']);
    assert.equal(options.model, 'k3');
    assert.equal(options.baseUrl, 'https://api.kimi.com/coding/v1');
    assert.equal(options.reps, 3);
    assert.equal(options.maxConcurrency, 1);
    assert.equal(options.taskBudgetSec, 1_800);
    assert.equal(options.nonInferiorityMargin, 0.1);
    assert.equal(options.dryRun, true);
  });

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

  test('captures inherited Harbor runtime policy in the shared immutable environment', () => {
    const options = parseKimiProtocolAbEnv(
      {
        MAKA_KIMI_PROTOCOL_AB_OUT_DIR: '/tmp/kimi-protocol-ab',
        MAKA_KIMI_PROTOCOL_AB_TASK_IDS: 'task-a',
        MAKA_CONTEXT_SEMANTIC_COMPACT: 'off',
        MAKA_HARBOR_CONTINUATION: 'on',
        MAKA_HARBOR_CONTINUATION_MAX_TURNS: '3',
        MAKA_CELL_COMMAND_TIMEOUT_MS: '300000',
        MAKA_STREAM_CONNECT_TIMEOUT_MS: '1800000',
        MAKA_STREAM_IDLE_TIMEOUT_MS: '1800000',
        MAKA_ECONOMY_TASK_MODE: 'false',
      },
      '/repo',
    );

    assert.deepEqual(options.sharedAgentEnv, {
      MAKA_CELL_COMMAND_TIMEOUT_MS: '300000',
      MAKA_CONTEXT_SEMANTIC_COMPACT: 'off',
      MAKA_ECONOMY_TASK_MODE: 'false',
      MAKA_HARBOR_CONTINUATION: 'on',
      MAKA_HARBOR_CONTINUATION_MAX_TURNS: '3',
      MAKA_STREAM_CONNECT_TIMEOUT_MS: '1800000',
      MAKA_STREAM_IDLE_TIMEOUT_MS: '1800000',
    });
  });
});
