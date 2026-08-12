import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentGraphIdForRootSession } from '@maka/runtime/stream-graph-coordinator';
import {
  notifySandboxBoundaryGraphWake,
  sandboxBoundaryGraphWakeRoot,
} from '../server/sandbox-boundary-graph-wake.js';

test('routes sandbox boundary graph wakes to the durable root Session', () => {
  assert.equal(sandboxBoundaryGraphWakeRoot({ id: 'root-session' }), 'root-session');
  assert.equal(
    sandboxBoundaryGraphWakeRoot({
      id: 'ordinary-child',
      subagentParent: subagentParent('root-session'),
    }),
    undefined,
  );
  assert.equal(
    sandboxBoundaryGraphWakeRoot({
      id: 'graph-operator',
      subagentParent: {
        ...subagentParent('root-session'),
        graph: {
          graphId: agentGraphIdForRootSession('root-session'),
          workId: 'work-1',
          operatorId: 'operator-1',
        },
      },
    }),
    'root-session',
  );
});

test('rejects graph operator lineage that is not owned by its parent Session', () => {
  assert.throws(
    () =>
      sandboxBoundaryGraphWakeRoot({
        id: 'graph-operator',
        subagentParent: {
          ...subagentParent('root-session'),
          graph: {
            graphId: agentGraphIdForRootSession('another-root'),
            workId: 'work-1',
            operatorId: 'operator-1',
          },
        },
      }),
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

  await notifySandboxBoundaryGraphWake('graph-operator', reader, notify);
  await notifySandboxBoundaryGraphWake('ordinary-child', reader, notify);

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
