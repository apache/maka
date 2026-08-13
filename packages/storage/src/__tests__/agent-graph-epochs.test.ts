import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { AgentGraphEpochConflictError } from '@maka/core/agent-graph-epoch';
import { createSqliteSessionMetadataStore } from '../sqlite-session-metadata-store.js';

describe('SQLite Agent Graph epochs', () => {
  test('adopts the legacy graph as epoch 1 and reopens it idempotently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-agent-graph-epoch-'));
    const path = join(root, 'state.sqlite');
    try {
      const store = createSqliteSessionMetadataStore(path, { now: () => 100 });
      assert.deepEqual(
        await store.resolveCurrentAgentGraphEpoch({
          rootSessionId: 'root-1',
          legacyGraphId: 'agent_graph_legacy',
        }),
        {
          binding: {
            schemaVersion: 1,
            rootSessionId: 'root-1',
            epoch: 1,
            graphId: 'agent_graph_legacy',
            createdAt: 100,
          },
          created: true,
        },
      );
      store.close();

      const reopened = createSqliteSessionMetadataStore(path, { now: () => 200 });
      assert.deepEqual(
        await reopened.resolveCurrentAgentGraphEpoch({
          rootSessionId: 'root-1',
          legacyGraphId: 'agent_graph_legacy',
        }),
        {
          binding: {
            schemaVersion: 1,
            rootSessionId: 'root-1',
            epoch: 1,
            graphId: 'agent_graph_legacy',
            createdAt: 100,
          },
          created: false,
        },
      );
      reopened.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('advances with compare-and-swap semantics and makes retries idempotent', async () => {
    const store = createSqliteSessionMetadataStore(':memory:', { now: nextNow(100) });
    await store.resolveCurrentAgentGraphEpoch({
      rootSessionId: 'root-1',
      legacyGraphId: 'agent_graph_1',
    });
    const request = {
      rootSessionId: 'root-1',
      expectedEpoch: 1,
      expectedGraphId: 'agent_graph_1',
      nextGraphId: 'agent_graph_2',
    } as const;

    assert.equal((await store.advanceAgentGraphEpoch(request)).created, true);
    assert.equal((await store.advanceAgentGraphEpoch(request)).created, false);
    assert.deepEqual(
      (await store.listAgentGraphEpochs('root-1')).map(({ epoch, graphId }) => ({
        epoch,
        graphId,
      })),
      [
        { epoch: 1, graphId: 'agent_graph_1' },
        { epoch: 2, graphId: 'agent_graph_2' },
      ],
    );
    store.close();
  });

  test('rejects stale writers and graph identities already bound elsewhere', async () => {
    const store = createSqliteSessionMetadataStore(':memory:');
    await store.resolveCurrentAgentGraphEpoch({
      rootSessionId: 'root-1',
      legacyGraphId: 'agent_graph_1',
    });
    await store.advanceAgentGraphEpoch({
      rootSessionId: 'root-1',
      expectedEpoch: 1,
      expectedGraphId: 'agent_graph_1',
      nextGraphId: 'agent_graph_2',
    });

    await assert.rejects(
      () =>
        store.advanceAgentGraphEpoch({
          rootSessionId: 'root-1',
          expectedEpoch: 1,
          expectedGraphId: 'agent_graph_1',
          nextGraphId: 'agent_graph_competing',
        }),
      AgentGraphEpochConflictError,
    );
    await assert.rejects(
      () =>
        store.resolveCurrentAgentGraphEpoch({
          rootSessionId: 'root-2',
          legacyGraphId: 'agent_graph_2',
        }),
      AgentGraphEpochConflictError,
    );
    store.close();
  });

  test('rejects a drifted legacy identity after adoption', async () => {
    const store = createSqliteSessionMetadataStore(':memory:');
    await store.resolveCurrentAgentGraphEpoch({
      rootSessionId: 'root-1',
      legacyGraphId: 'agent_graph_1',
    });
    await assert.rejects(
      () =>
        store.resolveCurrentAgentGraphEpoch({
          rootSessionId: 'root-1',
          legacyGraphId: 'agent_graph_other',
        }),
      AgentGraphEpochConflictError,
    );
    store.close();
  });
});

function nextNow(start: number): () => number {
  let value = start;
  return () => value++;
}
