import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { createManagedExecutionBoundary, createWorkspaceWritePermissionProfile } from '@maka/core';
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

  test('uses a sandboxed worker without one-call permission metadata', () => {
    const linuxTools = buildBuiltinTools({
      filesystemWorker: { execute: async () => ({ kind: 'read', content: '' }) },
      sandboxPlatform: 'linux',
    });
    assert.ok(linuxTools.find((tool) => tool.name === 'Write'));
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
    await runTool(tools, 'Write', { path: 'write.txt', content: 'content' }, cwd);
    await runTool(tools, 'Edit', { path: 'edit.txt', old_string: 'a', new_string: 'b' }, cwd);
    await runTool(tools, 'FormatJson', { path: 'data.json' }, cwd);
    await runTool(tools, 'Glob', { pattern: '**/*.ts' }, cwd);
    await runTool(tools, 'Grep', { pattern: 'value' }, cwd);

    assert.deepEqual(
      calls.map((call) => call.operation.kind),
      ['read', 'write', 'edit', 'format_json', 'glob', 'grep'],
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
