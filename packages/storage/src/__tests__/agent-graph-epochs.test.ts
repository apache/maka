/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { AgentGraphEpochConflictError } from '@maka/core/agent-graph-epoch';
import { createSqliteSessionMetadataStore } from '../sqlite-session-metadata-store.js';

describe('SQLite Agent Graph epochs', () => {
  test('resolves legacy epoch 1 without persisting state for an unused graph', async () => {
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
          schemaVersion: 1,
          rootSessionId: 'root-1',
          epoch: 1,
          graphId: 'agent_graph_legacy',
          createdAt: 0,
        },
      );
      assert.deepEqual(await store.listAgentGraphEpochs('root-1'), []);
      store.close();

      const reopened = createSqliteSessionMetadataStore(path, { now: () => 200 });
      assert.deepEqual(
        await reopened.resolveCurrentAgentGraphEpoch({
          rootSessionId: 'root-1',
          legacyGraphId: 'agent_graph_legacy',
        }),
        {
          schemaVersion: 1,
          rootSessionId: 'root-1',
          epoch: 1,
          graphId: 'agent_graph_legacy',
          createdAt: 0,
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

    assert.equal((await store.advanceAgentGraphEpoch(request)).graphId, 'agent_graph_2');
    assert.equal((await store.advanceAgentGraphEpoch(request)).graphId, 'agent_graph_2');
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
    assert.equal((await store.readAgentGraphEpochByGraphId('agent_graph_1'))?.epoch, 1);
    assert.deepEqual(await store.listAgentGraphEpochPage({ rootSessionId: 'root-1', limit: 1 }), {
      epochs: [
        {
          schemaVersion: 1,
          rootSessionId: 'root-1',
          epoch: 2,
          graphId: 'agent_graph_2',
          createdAt: 100,
        },
      ],
      nextBeforeEpoch: 2,
      currentEpoch: 2,
    });
    assert.deepEqual(
      await store.listAgentGraphEpochPage({
        rootSessionId: 'root-1',
        beforeEpoch: 2,
        limit: 1,
      }),
      {
        epochs: [
          {
            schemaVersion: 1,
            rootSessionId: 'root-1',
            epoch: 1,
            graphId: 'agent_graph_1',
            createdAt: 0,
          },
        ],
        nextBeforeEpoch: null,
        currentEpoch: 2,
      },
    );
    // A root Session without durable rows reports no current epoch, letting the
    // caller fall back to the legacy virtual identity.
    assert.deepEqual(await store.listAgentGraphEpochPage({ rootSessionId: 'root-2', limit: 1 }), {
      epochs: [],
      nextBeforeEpoch: null,
      currentEpoch: null,
    });
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
    await store.advanceAgentGraphEpoch({
      rootSessionId: 'root-1',
      expectedEpoch: 1,
      expectedGraphId: 'agent_graph_1',
      nextGraphId: 'agent_graph_2',
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

  test('retains the epoch directory until root-scoped retirement cleanup commits', async () => {
    const store = createSqliteSessionMetadataStore(':memory:');
    await store.advanceAgentGraphEpoch({
      rootSessionId: 'root-1',
      expectedEpoch: 1,
      expectedGraphId: 'agent_graph_1',
      nextGraphId: 'agent_graph_2',
    });

    await store.purgeAgentGraphControlState('agent_graph_1');
    assert.deepEqual(
      (await store.listAgentGraphEpochs('root-1')).map(({ graphId }) => graphId),
      ['agent_graph_1', 'agent_graph_2'],
    );
    assert.equal(await store.purgeAgentGraphEpochs('root-1'), 2);
    assert.deepEqual(await store.listAgentGraphEpochs('root-1'), []);
    assert.equal(await store.purgeAgentGraphEpochs('root-1'), 0);
    store.close();
  });
});

function nextNow(start: number): () => number {
  let value = start;
  return () => value++;
}
