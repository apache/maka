import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { createManagedExecutionBoundary } from '@maka/core/sandbox-boundary';
import { createWorkspaceWritePermissionProfile } from '@maka/core/permission-profile';
import { createReadOnlyPermissionProfile } from '@maka/core/permission-profile';

import { buildBuiltinTools } from '../builtin-tools.js';
import type { FilesystemWorkerExecuteInput } from '../filesystem-worker/client.js';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('builtin file tools use the sandboxed worker', () => {
  test('fails closed for managed file operations when the worker is unavailable', async () => {
    const cwd = await temporaryDirectory('maka-file-worker-unavailable-');
    const tools = buildBuiltinTools();

    await assert.rejects(
      runTool(tools, 'Write', { path: 'blocked.txt', content: 'must not be written' }, cwd),
      (error: unknown) =>
        error instanceof Error &&
        Object.assign(error, {}) &&
        (error as Error & { domain?: string; reason?: string }).domain === 'filesystem' &&
        (error as Error & { reason?: string }).reason === 'requires_bypass',
    );
  });

  for (const kind of ['bypass', 'external'] as const) {
    test(`uses the host filesystem path for an authoritative ${kind} boundary`, async () => {
      const cwd = await temporaryDirectory(`maka-file-${kind}-`);
      let workerCalled = false;
      const tools = buildBuiltinTools({
        filesystemWorker: {
          execute: async () => {
            workerCalled = true;
            throw new Error('sandbox worker must not receive non-managed execution');
          },
        },
      });
      const tool = tools.find((candidate) => candidate.name === 'Write');
      if (!tool) throw new Error('Write tool missing');

      await tool.impl(
        { path: 'written.txt', content: kind },
        {
          sessionId: 'session-1',
          turnId: 'turn-1',
          toolCallId: `tool-${kind}`,
          cwd,
          permissionMode: 'explore',
          executionBoundary: { kind, revision: 1 },
          abortSignal: new AbortController().signal,
          emitOutput: () => {},
        },
      );

      assert.equal(workerCalled, false);
      assert.equal(await readFile(join(cwd, 'written.txt'), 'utf8'), kind);
    });
  }

  test('forwards the current session boundary to every worker operation', async () => {
    const cwd = await temporaryDirectory('maka-file-worker-cwd-');
    const calls: FilesystemWorkerExecuteInput[] = [];
    const permissionProfile = createReadOnlyPermissionProfile();
    const tools = buildBuiltinTools({
      filesystemWorker: {
        execute: async (input) => {
          calls.push(input);
          switch (input.operation.kind) {
            case 'read':
              return { kind: 'read', content: 'worker-content' };
            case 'write':
              return { kind: 'write', ok: true, path: input.operation.path, bytes: 7 };
            case 'apply_patch':
              return { kind: 'apply_patch', ok: true, path: input.operation.path };
            case 'edit':
              return {
                kind: 'edit',
                ok: true,
                path: input.operation.path,
                replacements: 1,
                matchedVia: 'exact',
                startLine: 1,
                endLine: 1,
              };
            case 'format_json':
              return {
                kind: 'format_json',
                ok: true,
                valid: true,
                path: input.operation.path,
                bytesBefore: 2,
                bytesAfter: 3,
                byteDelta: 1,
                changed: true,
              };
            case 'glob':
              return { kind: 'glob', files: ['worker.ts'] };
            case 'grep':
              return { kind: 'grep', matches: ['worker.ts:1:value'] };
          }
        },
      },
      permissionProfile,
      sandboxPlatform: 'darwin',
    });

    await runTool(tools, 'Read', { path: 'read.txt' }, cwd);
    await writeFile(join(cwd, 'patch.txt'), 'old\n', 'utf8');
    await runTool(
      tools,
      'apply_patch',
      {
        callId: 'patch-1',
        operation: { type: 'update_file', path: 'patch.txt', diff: '@@\n-old\n+new\n' },
      },
      cwd,
    );
    await runTool(tools, 'Write', { path: 'write.txt', content: 'content' }, cwd);
    await runTool(tools, 'Edit', { path: 'edit.txt', old_string: 'a', new_string: 'b' }, cwd);
    await runTool(tools, 'FormatJson', { path: 'data.json' }, cwd);
    await runTool(tools, 'Glob', { pattern: '**/*.ts' }, cwd);
    await runTool(tools, 'Grep', { pattern: 'value' }, cwd);

    assert.deepEqual(
      calls.map((call) => call.operation.kind),
      ['read', 'apply_patch', 'write', 'edit', 'format_json', 'glob', 'grep'],
    );
    assert.equal(
      calls.every((call) => call.executionBoundary?.kind === 'managed'),
      true,
    );
    assert.equal(
      calls.every((call) => call.mode === 'ask' && call.cwd === cwd),
      true,
    );
    assert.equal(
      calls.every((call) => call.permissionProfile === permissionProfile),
      true,
    );
  });

  test('uses one worker read operation for image paths', async () => {
    const cwd = await temporaryDirectory('maka-file-worker-cwd-');
    const calls: FilesystemWorkerExecuteInput[] = [];
    const tools = buildBuiltinTools({
      filesystemWorker: {
        execute: async (input) => {
          calls.push(input);
          return { kind: 'read_image', base64: 'iVBORw0KGgo=', mimeType: 'image/png' };
        },
      },
      snapshotImage: async () => ({
        kind: 'session_file',
        sessionId: 'session-1',
        relativePath: 'artifact-1',
      }),
      sandboxPlatform: 'darwin',
    });

    await runTool(tools, 'Read', { path: 'image.png', offset: 1, limit: 1 }, cwd);

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.operation, { kind: 'read', path: 'image.png', offset: 1, limit: 1 });
  });

  test('serializes writes through real and symlinked cwd paths', async () => {
    const root = await temporaryDirectory('maka-file-lock-alias-');
    const workspace = join(root, 'workspace');
    const alias = join(root, 'workspace-alias');
    await mkdir(workspace);
    await writeFile(join(workspace, 'shared.txt'), 'before', 'utf8');
    await symlink(workspace, alias, 'dir');
    let active = 0;
    let maxActive = 0;
    const calls: FilesystemWorkerExecuteInput[] = [];
    const tools = buildBuiltinTools({
      filesystemWorker: {
        execute: async (input) => {
          calls.push(input);
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 20));
          active -= 1;
          return {
            kind: 'edit',
            ok: true,
            path: input.operation.path,
            replacements: 1,
            matchedVia: 'exact',
            startLine: 1,
            endLine: 1,
          };
        },
      },
      sandboxPlatform: 'darwin',
    });

    await Promise.all([
      runTool(
        tools,
        'Edit',
        { path: 'shared.txt', old_string: 'before', new_string: 'real' },
        workspace,
      ),
      runTool(
        tools,
        'Edit',
        { path: 'shared.txt', old_string: 'before', new_string: 'alias' },
        alias,
      ),
    ]);

    assert.equal(maxActive, 1);
    assert.deepEqual(
      calls.map((call) => call.cwd),
      [workspace, workspace],
    );
  });
});

describe('file tools surface a file_diff result', () => {
  const DIFF = ['--- a/a.ts', '+++ b/a.ts', '@@ -1,2 +1,2 @@', ' keep', '-old', '+new'].join('\n');

  function toolsWithWorkerResult(result: Record<string, unknown>) {
    return buildBuiltinTools({
      filesystemWorker: { execute: async () => result as never },
      sandboxPlatform: 'darwin',
    });
  }

  test('Edit returns a file_diff content when the worker reports a diff', async () => {
    const cwd = await temporaryDirectory('maka-edit-diff-');
    const tools = toolsWithWorkerResult({
      kind: 'edit',
      ok: true,
      path: 'a.ts',
      replacements: 1,
      matchedVia: 'exact',
      startLine: 1,
      endLine: 2,
      diff: DIFF,
    });

    const result = await runTool(
      tools,
      'Edit',
      { path: 'a.ts', old_string: 'old', new_string: 'new' },
      cwd,
    );

    assert.deepEqual(result, { kind: 'file_diff', paths: ['a.ts'], diff: DIFF });
  });

  test('Edit keeps the fact summary when the worker reports no diff', async () => {
    const cwd = await temporaryDirectory('maka-edit-nodiff-');
    const tools = toolsWithWorkerResult({
      kind: 'edit',
      ok: true,
      path: 'a.ts',
      replacements: 1,
      matchedVia: 'exact',
      startLine: 1,
      endLine: 2,
    });

    const result = await runTool(
      tools,
      'Edit',
      { path: 'a.ts', old_string: 'old', new_string: 'new' },
      cwd,
    );

    assert.deepEqual(result, {
      ok: true,
      path: 'a.ts',
      replacements: 1,
      matchedVia: 'exact',
      startLine: 1,
      endLine: 2,
    });
  });

  test('Write returns a file_diff content when the worker reports a diff', async () => {
    const cwd = await temporaryDirectory('maka-write-diff-');
    const tools = toolsWithWorkerResult({
      kind: 'write',
      ok: true,
      path: 'new.md',
      bytes: 12,
      diff: ['--- /dev/null', '+++ b/new.md', '@@ -0,0 +1,2 @@', '+alpha', '+beta'].join('\n'),
    });

    const result = await runTool(tools, 'Write', { path: 'new.md', content: 'alpha\nbeta\n' }, cwd);

    assert.deepEqual(result, {
      kind: 'file_diff',
      paths: ['new.md'],
      diff: ['--- /dev/null', '+++ b/new.md', '@@ -0,0 +1,2 @@', '+alpha', '+beta'].join('\n'),
    });
  });

  test('Write degrades to a file_write descriptor when the worker reports no diff', async () => {
    const cwd = await temporaryDirectory('maka-write-nodiff-');
    const tools = toolsWithWorkerResult({
      kind: 'write',
      ok: true,
      path: 'huge.bin',
      bytes: 70000,
    });

    const result = await runTool(tools, 'Write', { path: 'huge.bin', content: 'x' }, cwd);

    assert.deepEqual(result, { kind: 'file_write', path: 'huge.bin', bytes: 70000 });
  });

  test('FormatJson returns a file_diff content and never leaks the diff as json', async () => {
    const cwd = await temporaryDirectory('maka-format-diff-');
    const tools = toolsWithWorkerResult({
      kind: 'format_json',
      ok: true,
      valid: true,
      path: 'data.json',
      bytesBefore: 12,
      bytesAfter: 20,
      byteDelta: 8,
      changed: true,
      diff: DIFF,
    });

    const result = await runTool(tools, 'FormatJson', { path: 'data.json' }, cwd);

    assert.deepEqual(result, { kind: 'file_diff', paths: ['data.json'], diff: DIFF });
  });

  test('the model output for an edit is a bounded summary, not the diff', async () => {
    const tools = buildBuiltinTools();
    const tool = tools.find((candidate) => candidate.name === 'Edit');
    if (!tool) throw new Error('Edit tool missing');
    if (!tool.toModelOutput) throw new Error('Edit toModelOutput missing');

    const output = await tool.toModelOutput({
      toolCallId: 'tool-1',
      input: { path: 'a.ts', old_string: 'old', new_string: 'new' },
      output: { kind: 'file_diff', paths: ['a.ts'], diff: DIFF },
    });

    assert.deepEqual(output, { type: 'text', value: 'Edited a.ts (+1 -1)' });
  });

  test('the model output counts additions whose content starts with ++', async () => {
    const tools = buildBuiltinTools();
    const tool = tools.find((candidate) => candidate.name === 'Edit');
    if (!tool?.toModelOutput) throw new Error('Edit toModelOutput missing');

    const output = await tool.toModelOutput({
      toolCallId: 'tool-1',
      input: { path: 'a.ts', old_string: 'let i = 0;', new_string: 'let i = 0;\n++i;' },
      output: {
        kind: 'file_diff',
        paths: ['a.ts'],
        diff: '@@ -1,1 +1,2 @@\n let i = 0;\n+++i;',
      },
    });

    assert.deepEqual(output, { type: 'text', value: 'Edited a.ts (+1 -0)' });
  });

  test('the model output for a new-file write names it created with its line count', async () => {
    const tools = buildBuiltinTools();
    const tool = tools.find((candidate) => candidate.name === 'Write');
    if (!tool?.toModelOutput) throw new Error('Write toModelOutput missing');

    const output = await tool.toModelOutput({
      toolCallId: 'tool-1',
      input: { path: 'new.md', content: 'alpha\nbeta\n' },
      output: {
        kind: 'file_diff',
        paths: ['new.md'],
        diff: '--- /dev/null\n+++ b/new.md\n@@ -0,0 +1,2 @@\n+alpha\n+beta',
      },
    });

    assert.deepEqual(output, { type: 'text', value: 'Created new.md (+2)' });
  });
});

async function runTool(
  tools: ReturnType<typeof buildBuiltinTools>,
  name: string,
  args: unknown,
  cwd: string,
): Promise<unknown> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`${name} tool missing`);
  return await tool.impl(args as never, {
    sessionId: 'session-1',
    turnId: 'turn-1',
    toolCallId: `tool-${name}`,
    cwd,
    permissionMode: 'ask',
    executionBoundary: createManagedExecutionBoundary(createWorkspaceWritePermissionProfile(), 0),
    abortSignal: new AbortController().signal,
    emitOutput: () => {},
  });
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(path);
  return await realpath(path);
}
