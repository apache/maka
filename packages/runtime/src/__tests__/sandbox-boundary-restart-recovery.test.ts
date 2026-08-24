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
import { describe, it } from 'node:test';
import type { AgentRunEvent, EmittedAgentRunEvent, AgentRunHeader } from '@maka/core/agent-run';
import type { CreateSessionInput } from '@maka/core/runtime-inputs';
import type { SessionHeader, StoredMessage } from '@maka/core/session';
import {
  createSessionStore,
  type DurableAgentRunStore,
  type DurableRuntimeEventStore,
  type SessionAuthorityStore,
} from '@maka/storage';
import { createSqliteAgentRunStore, createWorkspaceRuntimeStore } from '@maka/storage';
import { BackendRegistry, SessionManager } from '../session-manager.js';

/**
 * Restart behaviour against the canonical SQLite stores. Memory stores can
 * model the shapes but not the ordering that makes this bug reachable — the
 * request row commits before its RuntimeEvent, and a recovery pass can die
 * between settling the row and committing the run's terminal fact.
 */
describe('sandbox boundary restart recovery on durable stores', () => {
  it('attributes a closure whose RuntimeEvent never reached the ledger', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-boundary-restart-'));
    try {
      const session = await withStores(root, async ({ sessions, runs }) => {
        const header = await sessions.create(sessionInput(root));
        await sessions.createSandboxBoundaryRequest({
          sessionId: header.id,
          requestId: 'boundary-1',
          turnId: 'turn-1',
          runId: 'run-1',
          expansion: { network: { enabled: true } },
          justification: 'Fetch a dependency.',
        });
        await seedInterruptedTurn(sessions, runs, header.id);
        // Deliberately no boundary RuntimeEvent: the process died in the
        // fail-open window between the row commit and the event append.
        return header;
      });

      await withStores(root, async (stores) => {
        await manager(stores).recoverInterruptedSessions();
      });

      await withStores(root, async ({ sessions, runs }) => {
        assert.deepEqual(await sessions.listPendingSandboxBoundaryRequests(session.id), []);
        const [turn] = await sessions.listTurns(session.id);
        assert.equal(turn?.status, 'failed');
        assert.equal(turn?.errorClass, 'sandbox_boundary_closed_by_restart');
        const [run] = await runs.listSessionRuns(session.id);
        assert.equal(run?.status, 'failed');
        assert.equal(run?.failureClass, 'sandbox_boundary_closed_by_restart');
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('re-reads a closure across a recovery interrupted before the terminal commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-boundary-restart-twice-'));
    try {
      const session = await withStores(root, async ({ sessions, runs }) => {
        const header = await sessions.create(sessionInput(root));
        await sessions.createSandboxBoundaryRequest({
          sessionId: header.id,
          requestId: 'boundary-1',
          turnId: 'turn-1',
          runId: 'run-1',
          expansion: { network: { enabled: true } },
          justification: 'Fetch a dependency.',
        });
        // Exactly the state an interrupted recovery leaves behind: the row is
        // settled with its closure reason, the run is still non-terminal.
        await sessions.settleSandboxBoundaryRequest({
          sessionId: header.id,
          requestId: 'boundary-1',
          decision: 'deny',
          closureReason: 'host_restarted',
        });
        await seedInterruptedTurn(sessions, runs, header.id);
        assert.deepEqual(await sessions.listPendingSandboxBoundaryRequests(header.id), []);
        return header;
      });

      await withStores(root, async (stores) => {
        await manager(stores).recoverInterruptedSessions();
      });

      const failedStatesAfterFirst = await withStores(root, async ({ sessions, runs }) => {
        const [turn] = await sessions.listTurns(session.id);
        assert.equal(turn?.errorClass, 'sandbox_boundary_closed_by_restart');
        const [run] = await runs.listSessionRuns(session.id);
        assert.equal(run?.failureClass, 'sandbox_boundary_closed_by_restart');
        return countFailedTurnStates(await sessions.readMessages(session.id));
      });

      // A later restart re-reads the same durable closure and must change
      // nothing: no second terminal state, no re-litigated attribution.
      await withStores(root, async (stores) => {
        await manager(stores).recoverInterruptedSessions();
      });

      await withStores(root, async ({ sessions, runs }) => {
        const [turn] = await sessions.listTurns(session.id);
        assert.equal(turn?.errorClass, 'sandbox_boundary_closed_by_restart');
        assert.equal(
          countFailedTurnStates(await sessions.readMessages(session.id)),
          failedStatesAfterFirst,
        );
        const [run] = await runs.listSessionRuns(session.id);
        assert.equal(run?.failureClass, 'sandbox_boundary_closed_by_restart');
        const closures = await sessions.listSandboxBoundaryRestartClosures(session.id);
        assert.deepEqual(
          closures.map((closure) => [closure.requestId, closure.turnId, closure.runId]),
          [['boundary-1', 'turn-1', 'run-1']],
        );
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps provenance absent for rows written before the column existed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-boundary-legacy-'));
    try {
      await withStores(root, async ({ sessions }) => {
        const header = await sessions.create(sessionInput(root));
        await sessions.createSandboxBoundaryRequest({
          sessionId: header.id,
          requestId: 'boundary-1',
          turnId: 'turn-1',
          expansion: { network: { enabled: true } },
          justification: 'Fetch a dependency.',
        });
        const [pending] = await sessions.listPendingSandboxBoundaryRequests(header.id);
        assert.equal(pending?.turnId, 'turn-1');
        assert.equal(pending?.runId, undefined);
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

interface DurableStores {
  sessions: SessionAuthorityStore;
  runs: DurableAgentRunStore;
  runtimeEvents: DurableRuntimeEventStore;
}

async function withStores<T>(
  root: string,
  body: (stores: DurableStores) => Promise<T>,
): Promise<T> {
  const sessions = createSessionStore(root);
  const runs = createSqliteAgentRunStore(root);
  const runtimeEvents = createWorkspaceRuntimeStore(root);
  try {
    return await body({ sessions, runs, runtimeEvents });
  } finally {
    await sessions.close?.();
  }
}

function manager(stores: DurableStores): SessionManager {
  return new SessionManager({
    store: stores.sessions,
    runStore: stores.runs,
    runtimeEventStore: stores.runtimeEvents,
    backends: new BackendRegistry(),
    newId: nextId(),
    now: nextNow(),
  });
}

async function seedInterruptedTurn(
  sessions: SessionAuthorityStore,
  runs: DurableAgentRunStore,
  sessionId: string,
): Promise<void> {
  await sessions.appendMessages(sessionId, [
    { type: 'user', id: 'turn-1-user', turnId: 'turn-1', ts: 9, text: 'build it' },
    {
      type: 'turn_state',
      id: 'turn-1-state',
      turnId: 'turn-1',
      ts: 10,
      status: 'running',
      partialOutputRetained: false,
    },
  ]);
  await sessions.updateHeader(sessionId, { status: 'waiting_for_user' });
  await runs.createRun(runHeader(sessionId));
  await runs.appendEvent(sessionId, 'run-1', runEvent(sessionId));
}

function countFailedTurnStates(messages: readonly StoredMessage[]): number {
  return messages.filter((message) => message.type === 'turn_state' && message.status === 'failed')
    .length;
}

function runHeader(sessionId: string): AgentRunHeader {
  return {
    runId: 'run-1',
    sessionId,
    turnId: 'turn-1',
    status: 'waiting_for_user',
    backendKind: 'fake',
    llmConnectionSlug: 'fake',
    modelId: 'fake-model',
    cwd: '/tmp/cwd',
    permissionMode: 'ask',
    createdAt: 10,
    updatedAt: 10,
  };
}

function runEvent(sessionId: string): EmittedAgentRunEvent {
  return {
    type: 'run_started',
    id: 'run-1-run_started-11',
    runId: 'run-1',
    sessionId,
    turnId: 'turn-1',
    ts: 11,
  };
}

function sessionInput(cwd: string): CreateSessionInput {
  return {
    cwd,
    llmConnectionSlug: 'fake',
    model: 'fake-model',
    permissionMode: 'ask',
    name: 'Session',
    labels: [],
  };
}

function nextId(): () => string {
  let value = 0;
  return () => `id-${++value}`;
}

function nextNow(): () => number {
  let value = 1_000;
  return () => ++value;
}

export type { SessionHeader };
