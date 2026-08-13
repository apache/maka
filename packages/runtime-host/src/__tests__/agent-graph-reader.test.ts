import assert from 'node:assert/strict';
import test from 'node:test';
import { readRuntimeHostAgentGraphEpochs } from '../client/agent-graph-reader.js';

test('collects Agent Graph epoch pages newest-first', async () => {
  const inputs: unknown[] = [];
  const epochs = await readRuntimeHostAgentGraphEpochs(
    {
      request: async (_operation, input) => {
        inputs.push(input);
        return (input as { beforeEpoch?: number }).beforeEpoch === undefined
          ? {
              rootSessionId: 'session-1',
              epochs: [{ epoch: 2, graphId: 'graph-2', createdAt: 2, current: true }],
              nextBeforeEpoch: 2,
            }
          : {
              rootSessionId: 'session-1',
              epochs: [{ epoch: 1, graphId: 'graph-1', createdAt: 1, current: false }],
              nextBeforeEpoch: null,
            };
      },
    },
    'session-1',
  );

  assert.deepEqual(
    epochs.map(({ graphId }) => graphId),
    ['graph-2', 'graph-1'],
  );
  assert.deepEqual(inputs, [
    { rootSessionId: 'session-1' },
    { rootSessionId: 'session-1', beforeEpoch: 2 },
  ]);
});

test('rejects a repeated Agent Graph epoch cursor', async () => {
  await assert.rejects(
    readRuntimeHostAgentGraphEpochs(
      {
        request: async () => ({
          rootSessionId: 'session-1',
          epochs: [],
          nextBeforeEpoch: 2,
        }),
      },
      'session-1',
    ),
    /repeated cursor/,
  );
});
