import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { SessionSummary, SubagentSessionParent, SubagentSessionSpawn } from '../session.js';
import {
  childSessionsForParent,
  isLinkedSubagentSession,
  isSubagentSessionParent,
  isSubagentSessionRuntime,
  isSubagentSessionSpawn,
  linkedSubagentParentSessionId,
  projectLinkedSessionTree,
  subagentSessionRuntimeSummary,
} from '../session.js';
import { isPermissionModeWithinCeiling } from '../permission.js';

const relation: SubagentSessionParent = {
  kind: 'subagent',
  parentSessionId: 'parent-session',
  spawnedBy: {
    parentRunId: 'parent-run',
    parentTurnId: 'parent-turn',
    toolCallId: 'tool-call',
  },
  lifecycle: 'foreground',
};

const spawn: SubagentSessionSpawn = {
  schemaVersion: 1,
  requestFingerprint: 'a'.repeat(64),
  initialTurnId: 'child-turn',
  initialRunId: 'child-run',
};

describe('subagent session parent relation', () => {
  test('strictly decodes standalone and swarm relations', () => {
    assert.equal(isSubagentSessionParent(relation), true);
    assert.equal(
      isSubagentSessionParent({
        ...relation,
        swarm: { swarmId: 'swarm-1', itemId: 'item-1' },
      }),
      true,
    );
    assert.equal(
      isSubagentSessionParent({
        ...relation,
        graph: {
          graphId: 'graph-1',
          workId: `graph_work_${'a'.repeat(32)}`,
          operatorId: `graph_operator_${'b'.repeat(32)}`,
        },
      }),
      true,
    );
    assert.equal(
      isSubagentSessionParent({
        ...relation,
        swarm: { swarmId: 'swarm-1', itemId: 'item-1' },
        graph: {
          graphId: 'graph-1',
          workId: `graph_work_${'a'.repeat(32)}`,
          operatorId: `graph_operator_${'b'.repeat(32)}`,
        },
      }),
      false,
    );
  });

  test('rejects malformed, unsupported, or extended persisted relations', () => {
    assert.equal(isSubagentSessionParent({ ...relation, lifecycle: 'detached' }), false);
    assert.equal(
      isSubagentSessionParent({
        ...relation,
        spawnedBy: { parentRunId: 'parent-run', parentTurnId: 'parent-turn' },
      }),
      false,
    );
    assert.equal(isSubagentSessionParent({ ...relation, parentSessionId: 'bad\nid' }), false);
    assert.equal(isSubagentSessionParent({ ...relation, unexpected: true }), false);
  });

  test('strictly decodes the initial child-spawn identity', () => {
    assert.equal(isSubagentSessionSpawn(spawn), true);
    assert.equal(isSubagentSessionSpawn({ ...spawn, requestFingerprint: 'not-a-hash' }), false);
    assert.equal(isSubagentSessionSpawn({ ...spawn, schemaVersion: 2 }), false);
    assert.equal(isSubagentSessionSpawn({ ...spawn, extra: true }), false);
  });

  test('derives reverse children without conflating ordinary branches', () => {
    const childA = summary('child-a', { subagentParent: relation });
    const branch = summary('branch', {
      parentSessionId: 'parent-session',
      branchOfTurnId: 'parent-turn',
    });
    const childB = summary('child-b', {
      subagentParent: { ...relation, swarm: { swarmId: 'swarm-1', itemId: 'item-1' } },
    });
    const otherChild = summary('other-child', {
      subagentParent: { ...relation, parentSessionId: 'other-parent' },
    });
    const hostChild = summary('host-child', {
      subagent: { parentSessionId: 'parent-session', agentName: 'Worker' },
    });

    assert.deepEqual(
      childSessionsForParent([childA, branch, childB, otherChild, hostChild], 'parent-session').map(
        (session) => session.id,
      ),
      ['child-a', 'child-b', 'host-child'],
    );
    assert.equal(isLinkedSubagentSession(childA), true);
    assert.equal(isLinkedSubagentSession(hostChild), true);
    assert.equal(isLinkedSubagentSession(branch), false);
    assert.equal(linkedSubagentParentSessionId(childA), 'parent-session');
    assert.equal(linkedSubagentParentSessionId(hostChild), 'parent-session');
    assert.equal(linkedSubagentParentSessionId(branch), undefined);
  });

  test('projects linked children beneath parents while preserving branches and orphans', () => {
    const parent = summary('parent');
    const child = summary('child', {
      subagentParent: { ...relation, parentSessionId: parent.id },
    });
    const grandchild = summary('grandchild', {
      subagentParent: { ...relation, parentSessionId: child.id },
    });
    const branch = summary('branch', {
      parentSessionId: parent.id,
      branchOfTurnId: 'parent-turn',
    });
    const orphan = summary('orphan', {
      subagentParent: { ...relation, parentSessionId: 'deleted-parent' },
    });

    const tree = projectLinkedSessionTree([parent, child, grandchild, branch, orphan]);

    assert.deepEqual(
      tree.roots.map((session) => session.id),
      ['parent', 'branch', 'orphan'],
    );
    assert.deepEqual(
      tree.childrenByParentId.get(parent.id)?.map((session) => session.id),
      ['child'],
    );
    assert.deepEqual(
      tree.childrenByParentId.get(child.id)?.map((session) => session.id),
      ['grandchild'],
    );
  });

  test('keeps cyclic linked relations visible as roots', () => {
    const childA = summary('child-a', {
      subagent: { parentSessionId: 'child-b' },
    });
    const childB = summary('child-b', {
      subagent: { parentSessionId: 'child-a' },
    });

    const tree = projectLinkedSessionTree([childA, childB]);

    assert.deepEqual(
      tree.roots.map((session) => session.id),
      ['child-a', 'child-b'],
    );
    assert.equal(tree.childrenByParentId.size, 0);
  });
});

function summary(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    cwd: '/tmp',
    name: id,
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    status: 'active',
    backend: 'fake',
    llmConnectionSlug: 'fake',
    connectionLocked: false,
    model: 'fake-model',
    permissionMode: 'ask',
    collaborationMode: 'agent',
    orchestrationMode: 'default',
    ...overrides,
  };
}
