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
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { createSqliteSessionMetadataStore } from '@maka/storage/sqlite-session-metadata-store';
import {
  AgentGraphCoordinator,
  type AgentGraphCoordinatorInput,
} from '../stream-graph-coordinator.js';
import {
  compileAgentGraphScheduleUpdate,
  UPDATE_AGENT_GRAPH_TOOL_NAME,
} from '../stream-graph-supervisor-tools.js';
import type { MakaTool, MakaToolContext } from '../tool-runtime.js';

const rootSessionId = 'retirement-root';
const suppressWakes = async (operation: () => Promise<void>) => operation();

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((release) => {
    resolve = release;
  });
  return { promise, resolve };
}

function context(toolCallId: string): MakaToolContext {
  return {
    sessionId: rootSessionId,
    runId: 'root-run',
    turnId: 'root-turn',
    toolCallId,
    cwd: '/workspace',
    abortSignal: new AbortController().signal,
    emitOutput() {},
  };
}

async function fixture(
  overrides: (
    store: ReturnType<typeof createSqliteSessionMetadataStore>,
  ) => Partial<AgentGraphCoordinatorInput> = () => ({}),
) {
  const store = createSqliteSessionMetadataStore(':memory:');
  await store.create({
    id: rootSessionId,
    workspaceRoot: '/workspace',
    cwd: '/workspace',
    createdAt: 1,
    name: 'Graph retirement',
    titleIsManual: false,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: 'fake',
    connectionLocked: false,
    model: 'fake',
    permissionMode: 'ask',
    collaborationMode: 'agent',
    orchestrationMode: 'graph',
    schemaVersion: 1,
  });
  const coordinator = new AgentGraphCoordinator({
    sessionStore: {
      listForRecovery: async () => [],
      readHeader: async (id) => ({ id, status: 'active', isArchived: false }) as never,
    },
    runtimeEventStore: {
      listSessionInvocations: async () => [],
      readImmutableRuntimeEvents: async () => [],
    },
    controlStore: store,
    epochStore: store,
    runtime: {
      provisionAgentGraphOperator: async () => {
        throw new Error('Unexpected provision');
      },
      runClaimedAgentGraphIntent: async () => {
        throw new Error('Unexpected dispatch');
      },
      stopSession: async () => {},
    },
    newId: randomUUID,
    ...overrides(store),
  });
  return {
    coordinator,
    store,
    async finish() {
      const graphId = await coordinator.currentGraphId(rootSessionId);
      await store.commitAgentGraphScheduleUpdate(
        compileAgentGraphScheduleUpdate({
          graphId,
          input: {
            operation: 'finish',
            finish: { result_ids: ['result-1'], reason: 'No work remains.' },
          },
          context: context(`finish-${graphId}`),
        }),
      );
      return graphId;
    },
    async close() {
      await coordinator.close();
      store.close();
    },
  };
}

test('releases completed epoch snapshots even while old supervisor tools remain reachable', {
  skip: !global.gc && 'Run with --expose-gc to verify snapshot collection',
}, async () => {
  const snapshots: WeakRef<object>[] = [];
  const f = await fixture(() => ({
    onReconciliation: (_root, result) => {
      snapshots.push(new WeakRef(result));
    },
  }));
  const retainedTools: MakaTool[][] = [];
  try {
    for (let epoch = 0; epoch < 12; epoch += 1) {
      retainedTools.push(await f.coordinator.toolsForSession(rootSessionId));
      const graphId = await f.finish();
      await f.coordinator.reconcile(rootSessionId);
      await f.coordinator.beginNextGraphEpoch(rootSessionId, suppressWakes);
      const historical = await f.coordinator.getGraphSnapshot(rootSessionId, graphId);
      assert.equal(historical.closed, true);
      assert.equal(historical.scheduleRevision, 1);
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await setImmediate();
      global.gc!();
    }
    assert.equal(snapshots.length, 12);
    assert.equal(snapshots.filter((reference) => reference.deref()).length, 0);
    assert.equal(retainedTools.length, 12);
    assert.ok(retainedTools.every((tools) => tools.some((tool) => tool.impl)));
    assert.equal(
      (await f.coordinator.listGraphEpochPage(rootSessionId, { limit: 32 })).epochs.length,
      13,
    );
  } finally {
    await f.close();
  }
});

test('a failed epoch commit leaves the current driver usable for reconciliation and retry', async () => {
  let failAdvance = true;
  let reconciliations = 0;
  const f = await fixture((store) => ({
    epochStore: new Proxy(store, {
      get(target, property) {
        if (property === 'advanceAgentGraphEpoch') {
          return async (...args: Parameters<typeof store.advanceAgentGraphEpoch>) => {
            if (failAdvance) throw new Error('epoch commit failed');
            return store.advanceAgentGraphEpoch(...args);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }),
    onReconciliation: () => {
      reconciliations += 1;
    },
  }));
  try {
    const graphId = await f.finish();
    await f.coordinator.reconcile(rootSessionId);
    await assert.rejects(
      f.coordinator.beginNextGraphEpoch(rootSessionId, suppressWakes),
      /epoch commit failed/,
    );
    assert.equal((await f.coordinator.reconcile(rootSessionId)).schedule.graphId, graphId);
    assert.equal(reconciliations, 2);
    failAdvance = false;
    assert.equal((await f.coordinator.beginNextGraphEpoch(rootSessionId, suppressWakes)).epoch, 2);
  } finally {
    await f.close();
  }
});

test('concurrent explicit reconciliations retain their epoch result through handover', async () => {
  const entered = deferred();
  const release = deferred();
  const f = await fixture(() => ({
    onReconciliation: async () => {
      entered.resolve();
      await release.promise;
    },
  }));
  try {
    const graphId = await f.finish();
    const first = f.coordinator.reconcile(rootSessionId);
    await entered.promise;
    const second = f.coordinator.reconcile(rootSessionId);
    const handover = f.coordinator.beginNextGraphEpoch(rootSessionId, suppressWakes);
    await setImmediate();
    release.resolve();
    const [left, right, next] = await Promise.all([first, second, handover]);
    assert.equal(left.schedule.graphId, graphId);
    assert.equal(right.schedule.graphId, graphId);
    assert.equal(next.epoch, 2);
    assert.equal((await f.coordinator.getGraphSnapshot(rootSessionId, graphId)).closed, true);
  } finally {
    release.resolve();
    await f.close();
  }
});

test('a delayed old schedule commit callback cannot wake its retired epoch', async () => {
  const committed = deferred();
  const release = deferred();
  let reconciliations = 0;
  let acquisitions = 0;
  const f = await fixture((store) => ({
    controlStore: new Proxy(store, {
      get(target, property) {
        if (property === 'commitAgentGraphScheduleUpdate') {
          return async (...args: Parameters<typeof store.commitAgentGraphScheduleUpdate>) => {
            const result = await store.commitAgentGraphScheduleUpdate(...args);
            committed.resolve();
            await release.promise;
            return result;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }),
    onReconciliation: () => {
      reconciliations += 1;
    },
    acquireResidency: () => {
      acquisitions += 1;
      return { release() {} };
    },
  }));
  try {
    const tools = await f.coordinator.toolsForSession(rootSessionId);
    const update = tools.find((tool) => tool.name === UPDATE_AGENT_GRAPH_TOOL_NAME)!;
    const delayed = update.impl(
      {
        operation: 'stop',
        stop: [{ target_id: 'old-work', reason: 'Stop requested.' }],
      },
      context('delayed-stop'),
    );
    await committed.promise;
    await f.finish();
    await f.coordinator.reconcile(rootSessionId);
    await f.coordinator.beginNextGraphEpoch(rootSessionId, suppressWakes);
    release.resolve();
    // Its final view is stale, but the already committed callback still ran.
    await assert.rejects(Promise.resolve(delayed), /observation belongs to another graph/);
    await setImmediate();
    assert.equal(reconciliations, 1);
    assert.equal(acquisitions, 1);
  } finally {
    release.resolve();
    await f.close();
  }
});
