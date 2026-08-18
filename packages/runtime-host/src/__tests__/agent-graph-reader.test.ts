import assert from 'node:assert/strict';
import test from 'node:test';
import { readRuntimeHostAgentGraphEpochs } from '../client/agent-graph-reader.js';

test('collects Agent Graph epoch pages newest-first', async () => {
  const inputs: unknown[] = [];
  const { epochs, truncated } = await readRuntimeHostAgentGraphEpochs(
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

  assert.equal(truncated, false);
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

test('returns a clearly truncated directory at the page bound', async () => {
  let nextEpoch = 10_000;
  const { epochs, truncated } = await readRuntimeHostAgentGraphEpochs(
    {
      request: async (_operation, input) => {
        const before = (input as { beforeEpoch?: number }).beforeEpoch ?? nextEpoch + 1;
        nextEpoch = before - 1;
        return {
          rootSessionId: 'session-1',
          epochs: [
            {
              epoch: nextEpoch,
              graphId: `graph-${nextEpoch}`,
              createdAt: nextEpoch,
              current: false,
            },
          ],
          nextBeforeEpoch: nextEpoch,
        };
      },
    },
    'session-1',
  );

  // The bound stays, but the result says so instead of throwing away a valid
  // directory: 64 pages × 1 entry each.
  assert.equal(truncated, true);
  assert.equal(epochs.length, 64);
});
