import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { applySandboxBoundaryExpansion, type ExecutionBoundary } from '@maka/core/sandbox-boundary';

import { createWorkspaceWritePermissionProfile } from '@maka/core/permission-profile';

import {
  FilesystemWorkerClient,
  FilesystemWorkerClientError,
} from '../filesystem-worker/client.js';
import { createFilesystemWorkerLaunchSpecProvider } from '../filesystem-worker/launch-spec.js';
import { createDefaultSandboxManager } from '../sandbox/default-sandbox-manager.js';
import { detectLinuxSandboxCapability } from '../sandbox/linux-capability.js';

const linuxCapability = detectLinuxSandboxCapability();
const skip =
  process.platform !== 'linux'
    ? 'Linux-only filesystem worker smoke'
    : linuxCapability.available
      ? false
      : `bubblewrap unavailable: ${linuxCapability.reason}`;

describe('Linux filesystem worker smoke', { skip }, () => {
  let workspace: string;
  let outside: string;
  let client: FilesystemWorkerClient;

  before(async () => {
    workspace = await realpath(await mkdtemp(join(tmpdir(), 'maka-linux-worker-workspace-')));
    outside = await realpath(await mkdtemp(join(homedir(), '.maka-linux-worker-outside-')));
    client = new FilesystemWorkerClient({
      sandboxManager: createDefaultSandboxManager(),
      platform: 'linux',
      getLaunchSpec: createFilesystemWorkerLaunchSpecProvider({
        runtime: 'node',
        resourceLocation: { kind: 'runtime' },
      }),
    });
  });

  after(async () => {
    await Promise.all([
      rm(workspace, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  });

  test('runs Read, Write, Edit, Glob, and Grep inside bubblewrap', async () => {
    const sourceDirectory = join(workspace, 'src');
    const sourceFile = join(sourceDirectory, 'health.ts');
    await mkdir(sourceDirectory);

    await client.execute({
      operation: {
        kind: 'write',
        path: sourceFile,
        content: 'export const healthSignal = true;\n',
      },
      cwd: workspace,
      mode: 'ask',
    });
    assert.equal(await readFile(sourceFile, 'utf8'), 'export const healthSignal = true;\n');

    const read = await client.execute({
      operation: { kind: 'read', path: sourceFile },
      cwd: workspace,
      mode: 'ask',
    });
    assert.deepEqual(read, {
      kind: 'read',
      content: 'export const healthSignal = true;\n',
    });

    const edit = await client.execute({
      operation: {
        kind: 'edit',
        path: sourceFile,
        oldString: 'healthSignal = true',
        newString: 'healthSignal = "healthy"',
      },
      cwd: workspace,
      mode: 'ask',
    });
    assert.equal(edit.kind, 'edit');
    assert.equal(await readFile(sourceFile, 'utf8'), 'export const healthSignal = "healthy";\n');

    const glob = await client.execute({
      operation: {
        kind: 'glob',
        path: sourceDirectory,
        pattern: '*.ts',
        limit: 20,
      },
      cwd: workspace,
      mode: 'ask',
    });
    assert.deepEqual(glob, { kind: 'glob', files: ['health.ts'] });

    const grep = await client.execute({
      operation: {
        kind: 'grep',
        path: sourceDirectory,
        pattern: 'healthy',
        maxCountPerFile: 50,
        limit: 200,
        timeoutMs: 10_000,
      },
      cwd: workspace,
      mode: 'ask',
    });
    assert.equal(grep.kind, 'grep');
    if (grep.kind === 'grep') {
      assert.equal(grep.matches.length, 1);
      assert.match(grep.matches[0] ?? '', /healthy/);
    }
  });

  test('creates a nested patch file inside bubblewrap', async () => {
    const target = join(workspace, 'nested', 'created.txt');

    await client.execute({
      operation: {
        kind: 'apply_patch',
        path: target,
        action: 'create',
        diff: '+created\n',
      },
      cwd: workspace,
      mode: 'ask',
    });

    assert.equal(await readFile(target, 'utf8'), 'created');
  });

  test('applies one exact outside grant without opening its sibling', async () => {
    const allowedPath = join(outside, 'allowed.txt');
    const siblingPath = join(outside, 'sibling.txt');
    const executionBoundary = boundaryFor(allowedPath);

    await assert.rejects(
      client.execute({
        operation: { kind: 'write', path: allowedPath, content: 'blocked' },
        cwd: workspace,
        mode: 'ask',
      }),
      isPathDenied,
    );
    await assert.rejects(
      client.execute({
        operation: { kind: 'write', path: siblingPath, content: 'blocked' },
        cwd: workspace,
        mode: 'ask',
        executionBoundary,
      }),
      (error: unknown) => {
        assert.ok(error instanceof FilesystemWorkerClientError);
        assert.equal(error.reason, 'sandbox_boundary_required');
        assert.deepEqual(error.requiredExpansion, {
          filesystem: {
            entries: [{ path: siblingPath, access: 'write', scope: 'exact' }],
          },
        });
        return true;
      },
    );

    await client.execute({
      operation: { kind: 'write', path: allowedPath, content: 'outside-ok' },
      cwd: workspace,
      mode: 'ask',
      executionBoundary,
    });
    assert.equal(await readFile(allowedPath, 'utf8'), 'outside-ok');
  });
});

function boundaryFor(path: string): ExecutionBoundary {
  return {
    kind: 'managed',
    revision: 1,
    profile: applySandboxBoundaryExpansion(createWorkspaceWritePermissionProfile(), {
      filesystem: { entries: [{ path, access: 'write', scope: 'exact' }] },
    }),
  };
}

function isPathDenied(error: unknown): boolean {
  return error instanceof FilesystemWorkerClientError && error.reason === 'path_denied';
}
