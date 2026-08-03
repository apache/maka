import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentGraphIdForRootSession } from '@maka/runtime';
import { sandboxBoundaryGraphWakeRoot } from '../server/sandbox-boundary-graph-wake.js';

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
