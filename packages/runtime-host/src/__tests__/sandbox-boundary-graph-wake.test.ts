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
import { test } from 'node:test';
import { agentGraphIdForRootSession } from '@maka/runtime/stream-graph-coordinator';
import {
  notifySandboxBoundaryGraphWake,
  sandboxBoundaryGraphWakeRoot,
} from '../server/sandbox-boundary-graph-wake.js';

test('routes sandbox boundary graph wakes to the durable root Session', async () => {
  const graphIds = idsFor('root-session');
  assert.equal(
    await sandboxBoundaryGraphWakeRoot({ id: 'root-session' }, graphIds),
    'root-session',
  );
  assert.equal(
    await sandboxBoundaryGraphWakeRoot(
      { id: 'ordinary-child', subagentParent: subagentParent('root-session') },
      graphIds,
    ),
    undefined,
  );
  assert.equal(
    await sandboxBoundaryGraphWakeRoot(
      {
        id: 'graph-operator',
        subagentParent: {
          ...subagentParent('root-session'),
          graph: {
            graphId: agentGraphIdForRootSession('root-session'),
            workId: 'work-1',
            operatorId: 'operator-1',
          },
        },
      },
      graphIds,
    ),
    'root-session',
  );
});

test('rejects graph operator lineage that is not owned by its parent Session', async () => {
  await assert.rejects(
    () =>
      sandboxBoundaryGraphWakeRoot(
        {
          id: 'graph-operator',
          subagentParent: {
            ...subagentParent('root-session'),
            graph: {
              graphId: agentGraphIdForRootSession('another-root'),
              workId: 'work-1',
              operatorId: 'operator-1',
            },
          },
        },
        idsFor('root-session'),
      ),
    /does not match root Session/,
  );
});

test('reads durable operator lineage before notifying only its root graph', async () => {
  const reads: string[] = [];
  const wakes: string[] = [];
  const headers = new Map([
    [
      'graph-operator',
      {
        id: 'graph-operator',
        subagentParent: {
          ...subagentParent('root-session'),
          graph: {
            graphId: agentGraphIdForRootSession('root-session'),
            workId: 'work-1',
            operatorId: 'operator-1',
          },
        },
      },
    ],
    ['ordinary-child', { id: 'ordinary-child', subagentParent: subagentParent('root-session') }],
  ]);
  const reader = {
    readHeaderSnapshot: async (sessionId: string) => {
      reads.push(sessionId);
      const header = headers.get(sessionId);
      if (!header) throw new Error(`Missing Session header: ${sessionId}`);
      return header;
    },
  };
  const notify = async (sessionId: string) => {
    wakes.push(sessionId);
  };

  const graphIds = idsFor('root-session');
  await notifySandboxBoundaryGraphWake('graph-operator', reader, graphIds, notify);
  await notifySandboxBoundaryGraphWake('ordinary-child', reader, graphIds, notify);

  assert.deepEqual(reads, ['graph-operator', 'ordinary-child']);
  assert.deepEqual(wakes, ['root-session']);
});

function idsFor(rootSessionId: string) {
  return {
    listGraphIds: async (requestedRootSessionId: string) =>
      requestedRootSessionId === rootSessionId ? [agentGraphIdForRootSession(rootSessionId)] : [],
  };
}

function subagentParent(parentSessionId: string) {
  return {
    kind: 'subagent' as const,
    parentSessionId,
    spawnedBy: {
      parentRunId: 'parent-run',
      parentTurnId: 'parent-turn',
      toolCallId: 'tool-call',
    },
    lifecycle: 'foreground' as const,
  };
}
