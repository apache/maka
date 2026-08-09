import assert from 'node:assert/strict';
import test from 'node:test';
import type { MakaToolContext } from '@maka/runtime';
import {
  createManagedWorkspaceInspectionTool,
  type ManagedWorkspaceInspectionToolResult,
} from '../server/managed-workspace-inspection-tool.js';
import type {
  RuntimeHostWorkspaceExecutionComposition,
  RuntimeHostWorkspaceExecutionProfile,
} from '../server/workspace-execution-composition.js';

test('opens an owner-bound dependency profile from the session cwd before inspecting', async () => {
  const opens: unknown[] = [];
  const executions: unknown[] = [];
  const profile = Object.freeze({
    kind: 'managed_worktree_v1',
    executionHandle: Object.freeze({ kind: 'managed_workspace_execution_handle_v1' as const }),
    provisioning: 'dependency_environment_v1' as const,
  });
  const composition: RuntimeHostWorkspaceExecutionComposition = {
    state: 'ready',
    async openManagedWorkspace(input, options) {
      opens.push({ input, options });
      return profile;
    },
    async executeReadOnly(actualProfile, operation, abortSignal) {
      executions.push({ profile: actualProfile, operation, abortSignal });
      return { kind: 'read', content: 'isolated' };
    },
    beginDrain() {},
    async close() {},
  };
  const tool = createManagedWorkspaceInspectionTool(composition, {
    canonicalizeSourceRoot: async () => '/canonical/source',
  });
  const abort = new AbortController();
  const context = toolContext(abort.signal);

  const result = (await tool.impl(
    { kind: 'read', path: 'node_modules/fixture/index.js' },
    context,
  )) as ManagedWorkspaceInspectionToolResult;

  assert.deepEqual(result, {
    kind: 'managed_workspace_inspection_v1',
    result: { kind: 'read', content: 'isolated' },
  });
  assert.equal(opens.length, 1);
  const opened = opens[0] as {
    input: {
      repositoryId: string;
      workspaceId: string;
      workspaceEpochId: string;
      workspaceInstanceId: string;
      sourceRoot: string;
    };
    options: unknown;
  };
  assert.match(opened.input.repositoryId, /^repository_[a-f0-9]{32}$/u);
  assert.match(opened.input.workspaceId, /^workspace_[a-f0-9]{32}$/u);
  assert.match(opened.input.workspaceEpochId, /^epoch_[a-f0-9]{32}$/u);
  assert.match(opened.input.workspaceInstanceId, /^instance_[a-f0-9]{32}$/u);
  assert.equal(opened.input.sourceRoot, '/canonical/source');
  assert.deepEqual(opened.options, { provisioning: 'dependency_environment_v1' });
  assert.deepEqual(executions, [
    {
      profile,
      operation: { kind: 'read', path: 'node_modules/fixture/index.js' },
      abortSignal: abort.signal,
    },
  ]);
});

test('keeps one stable managed workspace identity for the same session and source', async () => {
  const identities: unknown[] = [];
  const profile = Object.freeze({
    kind: 'managed_worktree_v1',
    executionHandle: Object.freeze({ kind: 'managed_workspace_execution_handle_v1' as const }),
    provisioning: 'dependency_environment_v1' as const,
  }) satisfies RuntimeHostWorkspaceExecutionProfile;
  const composition: RuntimeHostWorkspaceExecutionComposition = {
    state: 'ready',
    async openManagedWorkspace(input) {
      identities.push(input);
      return profile;
    },
    async executeReadOnly() {
      return { kind: 'glob', files: ['src/index.ts'] };
    },
    beginDrain() {},
    async close() {},
  };
  const tool = createManagedWorkspaceInspectionTool(composition, {
    canonicalizeSourceRoot: async () => '/canonical/source',
  });
  const context = toolContext(new AbortController().signal);

  await tool.impl({ kind: 'glob', path: '.', pattern: '**/*.ts', limit: 10 }, context);
  await tool.impl({ kind: 'grep', path: '.', pattern: 'needle', limit: 10 }, context);

  assert.deepEqual(identities[0], identities[1]);
});

test('schema rejects mutation and caller-owned workspace authority fields', () => {
  const tool = createManagedWorkspaceInspectionTool({} as never);
  const schema = tool.parameters as {
    safeParse(value: unknown): { success: boolean };
  };

  assert.equal(
    schema.safeParse({ kind: 'write', path: 'src/a.ts', content: 'unsafe' }).success,
    false,
  );
  assert.equal(
    schema.safeParse({
      kind: 'read',
      path: 'README.md',
      sourceRoot: '/forged',
      workspaceId: 'workspace_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    }).success,
    false,
  );
});

test('pre-aborted task never opens a managed workspace', async () => {
  let canonicalizeCalls = 0;
  let openCalls = 0;
  const tool = createManagedWorkspaceInspectionTool(
    {
      state: 'ready',
      async openManagedWorkspace() {
        openCalls += 1;
        throw new Error('must not open');
      },
      async executeReadOnly() {
        throw new Error('must not execute');
      },
      beginDrain() {},
      async close() {},
    },
    {
      async canonicalizeSourceRoot() {
        canonicalizeCalls += 1;
        return '/canonical/source';
      },
    },
  );
  const abort = new AbortController();
  abort.abort(new DOMException('Task cancelled', 'AbortError'));

  await assert.rejects(
    async () => await tool.impl({ kind: 'read', path: 'README.md' }, toolContext(abort.signal)),
    { name: 'AbortError' },
  );
  assert.equal(canonicalizeCalls, 0);
  assert.equal(openCalls, 0);
});

function toolContext(abortSignal: AbortSignal): MakaToolContext {
  return {
    sessionId: 'session_11111111111111111111111111111111',
    turnId: 'turn_22222222222222222222222222222222',
    toolCallId: 'call_33333333333333333333333333333333',
    cwd: '/attached/source',
    abortSignal,
    emitOutput() {},
  };
}
