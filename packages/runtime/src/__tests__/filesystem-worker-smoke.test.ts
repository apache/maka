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
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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

describe('macOS filesystem worker smoke', { skip: process.platform !== 'darwin' }, () => {
  let workspace: string;
  let outside: string;
  let client: FilesystemWorkerClient;

  before(async () => {
    workspace = await realpath(await mkdtemp(join(tmpdir(), 'maka-worker-smoke-workspace-')));
    outside = await realpath(await mkdtemp(join(homedir(), '.maka-worker-smoke-outside-')));
    client = new FilesystemWorkerClient({
      sandboxManager: createDefaultSandboxManager(),
      platform: 'darwin',
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

  test('allows workspace writes and fails closed for unapproved outside paths', async () => {
    const insidePath = join(workspace, 'inside.txt');
    const outsidePath = join(outside, 'blocked.txt');
    await client.execute({
      operation: { kind: 'write', path: insidePath, content: 'inside-ok' },
      cwd: workspace,
      mode: 'ask',
    });
    assert.equal(await readFile(insidePath, 'utf8'), 'inside-ok');

    await assert.rejects(
      client.execute({
        operation: { kind: 'write', path: outsidePath, content: 'blocked' },
        cwd: workspace,
        mode: 'ask',
      }),
      (error: unknown) =>
        error instanceof FilesystemWorkerClientError && error.reason === 'path_denied',
    );
  });

  test('creates a nested patch file inside the workspace', async () => {
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

  test('deletes an entry through the absolute macOS path alias', async () => {
    const target = join(workspace, 'aliased.txt');
    const aliasedTarget = target.replace(/^\/private(?=\/)/, '');
    assert.notEqual(aliasedTarget, target);
    await writeFile(target, 'delete me', 'utf8');
    // Capture the identity at T0 (the boundary executor does this in production).
    const { lstat } = await import('node:fs/promises');
    const meta = await lstat(target, { bigint: true });
    const expectedIdentity = { dev: String(meta.dev), ino: String(meta.ino) };

    await client.execute({
      operation: { kind: 'apply_patch', path: aliasedTarget, action: 'delete' },
      cwd: workspace,
      mode: 'ask',
      expectedIdentity,
    });

    await assert.rejects(readFile(target, 'utf8'), { code: 'ENOENT' });
  });

  test('applies one exact boundary expansion without opening a sibling path', async () => {
    const allowedPath = join(outside, 'allowed.txt');
    const siblingPath = join(outside, 'sibling.txt');
    const executionBoundary = boundaryFor(allowedPath);
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

  test('runs file and directory Grep inside the operation-scoped sandbox', async () => {
    const sourceDirectory = join(workspace, 'src');
    const sourceFile = join(sourceDirectory, 'health.ts');
    await mkdir(sourceDirectory);
    await writeFile(sourceFile, 'export const healthSignal = true;\n', 'utf8');

    const fileResult = await client.execute({
      operation: grepOperation(sourceFile, 'healthSignal'),
      cwd: workspace,
      mode: 'ask',
    });
    assert.equal(fileResult.kind, 'grep');
    if (fileResult.kind === 'grep') {
      assert.equal(fileResult.matches.length, 1);
      assert.match(fileResult.matches[0] ?? '', /healthSignal/);
    }

    const directoryResult = await client.execute({
      operation: grepOperation(sourceDirectory, 'healthSignal'),
      cwd: workspace,
      mode: 'ask',
    });
    assert.equal(directoryResult.kind, 'grep');
    if (directoryResult.kind === 'grep') {
      assert.equal(directoryResult.matches.length, 1);
      assert.match(directoryResult.matches[0] ?? '', /healthSignal/);
    }

    const emptyResult = await client.execute({
      operation: grepOperation(sourceDirectory, 'does-not-exist'),
      cwd: workspace,
      mode: 'ask',
    });
    assert.deepEqual(emptyResult, { kind: 'grep', matches: [] });
  });
});

function grepOperation(path: string, pattern: string) {
  return {
    kind: 'grep' as const,
    path,
    pattern,
    maxCountPerFile: 50,
    limit: 200,
    timeoutMs: 10_000,
  };
}

function boundaryFor(path: string): ExecutionBoundary {
  return {
    kind: 'managed',
    revision: 1,
    profile: applySandboxBoundaryExpansion(createWorkspaceWritePermissionProfile(), {
      filesystem: { entries: [{ path, access: 'write', scope: 'exact' }] },
    }),
  };
}
