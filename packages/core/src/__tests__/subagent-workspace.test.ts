import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  SUBAGENT_WORKSPACE_BINDING_SCHEMA_VERSION,
  isSubagentWorkspaceBinding,
  type SubagentWorkspaceBinding,
} from '../subagent-workspace.js';

describe('subagent workspace binding', () => {
  test('rejects unknown fields, unsafe leases, and malformed commits', () => {
    assert.equal(isSubagentWorkspaceBinding({ ...binding(), extra: true }), false);
    assert.equal(isSubagentWorkspaceBinding({ ...binding(), leaseId: '../shared' }), false);
    assert.equal(isSubagentWorkspaceBinding({ ...binding(), baseCommit: 'HEAD' }), false);
  });
});

function binding(): SubagentWorkspaceBinding {
  return {
    schemaVersion: SUBAGENT_WORKSPACE_BINDING_SCHEMA_VERSION,
    kind: 'git_worktree',
    leaseId: `subagent_worktree_${'a'.repeat(32)}`,
    gitCommonDir: '/workspace/repository/.git',
    worktreePath: '/workspace/state/subagent-worktrees/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    branch: 'maka/subagent/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    baseCommit: 'b'.repeat(40),
  };
}
