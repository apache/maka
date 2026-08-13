import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentGraphIdForRootSession } from '@maka/runtime/stream-graph-coordinator';
import {
  notifySandboxBoundaryGraphWake,
  sandboxBoundaryGraphWakeRoot,
} from '../server/sandbox-boundary-graph-wake.js';

test('routes sandbox boundary graph wakes to the durable root Session', async () => {
  const graphInstances = instanceStore('root-session');
  assert.equal(await sandboxBoundaryGraphWakeRoot({ id: 'root-session' }), 'root-session');
  assert.equal(
    await sandboxBoundaryGraphWakeRoot({
      id: 'ordinary-child',
      subagentParent: subagentParent('root-session'),
    }),
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
      graphInstances,
    ),
    'root-session',
  );
});

test('rejects graph operator lineage that is not owned by its parent Session', async () => {
  await assert.rejects(
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
      instanceStore('root-session'),
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

  const graphInstances = instanceStore('root-session');
  await notifySandboxBoundaryGraphWake('graph-operator', reader, graphInstances, notify);
  await notifySandboxBoundaryGraphWake('ordinary-child', reader, graphInstances, notify);

  assert.deepEqual(reads, ['graph-operator', 'ordinary-child']);
  assert.deepEqual(wakes, ['root-session']);
});

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

function instanceStore(rootSessionId: string) {
  return {
    listAgentGraphInstances: async (requestedRootSessionId: string) =>
      requestedRootSessionId === rootSessionId
        ? [
            {
              schemaVersion: 1 as const,
              graphId: agentGraphIdForRootSession(rootSessionId),
              rootSessionId,
              sequence: 1,
              status: 'open' as const,
              createdAt: 1,
            },
          ]
        : [],
  };
}
