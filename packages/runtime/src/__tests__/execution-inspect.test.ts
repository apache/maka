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
import type { AgentRunEvent, AgentRunEventType, EmittedAgentRunEvent } from '@maka/core/agent-run';
import { buildInvocationOpenedEvent } from '@maka/core/runtime-invocation';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { createSessionStore } from '@maka/storage/session-store';
import { createSqliteAgentRunStore } from '@maka/storage/agent-run-store';
import { createWorkspaceRuntimeStore } from '@maka/storage/runtime-event-persistence';
import { inspectAgentRunDocument, renderAgentRunInspectTree } from '../execution-inspect.js';
import { testInvocationOpening } from './invocation-fixture.js';

describe('versioned execution inspect documents', () => {
  test('reports unknown tool outcomes without copying Runtime payloads', async () => {
    await withWorkspace(async (root) => {
      const sessionStore = createSessionStore(root);
      const runStore = createSqliteAgentRunStore(root);
      const runtimeStore = createWorkspaceRuntimeStore(root);
      const session = await sessionStore.create({
        cwd: '/tmp/workspace',
        llmConnectionSlug: 'fake',
        model: 'fake-model',
        permissionMode: 'ask',
      });
      await runtimeStore.appendRuntimeEvent(session.id, RUN_ID, openingEvent(session.id));
      await runStore.appendEvent(
        session.id,
        RUN_ID,
        runEvent(session.id, 'model_stream_completed'),
      );
      await runtimeStore.appendRuntimeEvent(
        session.id,
        RUN_ID,
        runtimeEvent(session.id, 'call', {
          role: 'model',
          author: 'agent',
          content: {
            kind: 'function_call',
            id: 'tool-pending',
            name: 'Write',
            args: { path: 'private.txt', content: 'DO_NOT_COPY' },
          },
        }),
      );
      await runtimeStore.appendRuntimeEvent(
        session.id,
        RUN_ID,
        runtimeEvent(session.id, 'terminal', {
          role: 'system',
          author: 'system',
          status: 'completed',
          actions: { endInvocation: true },
        }),
      );

      const document = await inspectAgentRunDocument(runStore, runtimeStore, {
        sessionId: session.id,
        agentRunId: RUN_ID,
      });

      assert.equal(document.schemaVersion, 'maka.agent_run_inspect.v1');
      assert.deepEqual(document.tools.callsWithoutResponse, [
        {
          toolCallId: 'tool-pending',
          toolName: 'Write',
          eventId: 'call',
        },
      ]);
      // The opening fact is the run's first runtime event, so the call and the
      // terminal event that follow it sit at sequences 1 and 2.
      assert.equal(document.sources.runtimeCoverage?.highWater.sequence, 2);
      assert.equal(
        document.diagnostics.some((item) => item.code === 'tool_response_missing'),
        true,
      );
      const json = JSON.stringify(document);
      assert.equal(json.includes('private.txt'), false);
      assert.equal(json.includes('DO_NOT_COPY'), false);
      assert.match(
        renderAgentRunInspectTree(document),
        /outcome and external side effects are unknown/,
      );
    });
  });
});

const RUN_ID = 'run-1';
const TURN_ID = 'turn-1';
const TS = 1_800_000_000_000;

function openingEvent(sessionId: string) {
  return buildInvocationOpenedEvent({
    id: 'rt-open',
    run: { sessionId, invocationId: 'invocation-1', runId: RUN_ID, turnId: TURN_ID },
    openedAt: TS,
    opening: testInvocationOpening({
      route: {
        provenance: 'runtime',
        backendKind: 'fake',
        llmConnectionId: 'fake-connection',
        llmConnectionSlug: 'fake',
        modelId: 'fake-model',
      },
      configuration: { cwd: '/tmp/workspace' },
    }),
  });
}

function runEvent(sessionId: string, type: AgentRunEventType): EmittedAgentRunEvent {
  return { id: `op-${type}`, type, runId: RUN_ID, sessionId, turnId: TURN_ID, ts: TS + 1 };
}

function runtimeEvent(
  sessionId: string,
  id: string,
  overrides: Partial<RuntimeEvent>,
): RuntimeEvent {
  return {
    id,
    invocationId: 'invocation-1',
    runId: RUN_ID,
    sessionId,
    turnId: TURN_ID,
    ts: TS,
    partial: false,
    role: 'system',
    author: 'system',
    ...overrides,
  };
}

async function withWorkspace(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-execution-inspect-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
