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
import { rmSync } from 'node:fs';
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { createManagedExecutionBoundary } from '@maka/core/sandbox-boundary';
import { createWorkspaceWritePermissionProfile } from '@maka/core/permission-profile';
import { MAX_READ_IMAGE_BYTES } from '@maka/core/attachments';
import {
  canWritePath,
  createReadOnlyPermissionProfile,
  type PermissionProfile,
} from '@maka/core/permission-profile';

import {
  FilesystemWorkerClient,
  FilesystemWorkerClientError,
  filesystemWorkerRuntimeWritableRoots,
} from '../filesystem-worker/client.js';
import {
  FILESYSTEM_WORKER_MAX_RESPONSE_BYTES,
  type FilesystemWorkerProcessRunInput,
} from '../filesystem-worker/process-runner.js';
import {
  FILESYSTEM_WORKER_PROTOCOL_VERSION,
  FilesystemWorkerRequestSchema,
  type FilesystemWorkerErrorCode,
  type FilesystemWorkerRequest,
  type FilesystemWorkerResult,
} from '../filesystem-worker/protocol.js';
import { LinuxBubblewrapBackend } from '../sandbox/linux-sandbox.js';
import { MacosSeatbeltBackend } from '../sandbox/macos-seatbelt.js';
import { SandboxManager } from '../sandbox/sandbox-manager.js';
import type {
  SandboxPlatform,
  SandboxTransformRequest,
  SandboxTransformResult,
} from '../sandbox/types.js';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test('Read image payloads fit within the filesystem worker response limit', () => {
  const base64Bytes = 4 * Math.ceil(MAX_READ_IMAGE_BYTES / 3);
  assert.ok(base64Bytes + 1024 < FILESYSTEM_WORKER_MAX_RESPONSE_BYTES);
});

describe('filesystem worker client permission snapshots', () => {
  test('authorizes delete against the symlink entry', async () => {
    const workspace = await temporaryDirectory('maka-worker-client-delete-link-');
    const target = join(workspace, 'target.txt');
    const link = join(workspace, 'link.txt');
    await writeFile(target, 'keep', 'utf8');
    await symlink(target, link);
    // Capture the symlink entry's own identity (lstat, no follow) as the
    // boundary executor does at T0; a write mutation on an existing target
    // without it is rejected as path_changed.
    const linkMeta = await lstat(link, { bigint: true });
    const { client, requests } = fakeClient();

    await client.execute({
      operation: { kind: 'apply_patch', path: link, action: 'delete' },
      cwd: workspace,
      mode: 'ask',
      expectedIdentity: { dev: String(linkMeta.dev), ino: String(linkMeta.ino) },
    });

    assert.equal(requests[0]?.operation.path, link);
    const expectedTarget = requests[0]?.expectedTarget;
    assert.equal(expectedTarget?.enforcementPath, link);
    assert.equal(expectedTarget?.access, 'write');
    assert.equal(expectedTarget?.scope, 'exact');
    assert.equal(expectedTarget?.targetType, 'symlink');
    // The symlink entry's own identity (lstat, no follow) is captured at T0 and
    // forwarded; only its shape is stable, not its value.
    assert.equal(typeof expectedTarget?.identity?.dev, 'string');
    assert.equal(typeof expectedTarget?.identity?.ino, 'string');
  });

  for (const kind of ['bypass', 'external'] as const) {
    test(`rejects an authoritative ${kind} boundary instead of falling back to legacy mode`, async () => {
      const workspace = await temporaryDirectory(`maka-worker-client-${kind}-`);
      const { client, requests } = fakeClient();

      await assert.rejects(
        client.execute({
          operation: { kind: 'write', path: 'allowed-by-legacy-mode.txt', content: kind },
          cwd: workspace,
          executionBoundary: { kind, revision: 1 },
          mode: 'execute',
        }),
        (error: unknown) => {
          assert.ok(error instanceof FilesystemWorkerClientError);
          assert.equal(error.reason, 'invalid_request');
          assert.equal(error.stage, 'validation');
          return true;
        },
      );
      assert.equal(requests.length, 0);
    });
  }

  test('returns the smallest session boundary expansion for an external path', async () => {
    const workspace = await temporaryDirectory('maka-worker-client-boundary-workspace-');
    const outside = await mkdtemp(join(homedir(), '.maka-worker-client-boundary-outside-'));
    cleanup.push(outside);
    const target = join(outside, 'blocked.txt');
    await writeFile(target, 'blocked', 'utf8');
    const { client, requests } = fakeClient();

    await assert.rejects(
      client.execute({
        operation: { kind: 'read', path: target },
        cwd: workspace,
        executionBoundary: createManagedExecutionBoundary(
          createWorkspaceWritePermissionProfile(),
          0,
        ),
      }),
      (error: unknown) => {
        assert.ok(error instanceof FilesystemWorkerClientError);
        assert.equal(error.reason, 'sandbox_boundary_required');
        assert.deepEqual(error.requiredExpansion, {
          filesystem: {
            entries: [{ path: target, access: 'read', scope: 'exact' }],
          },
        });
        return true;
      },
    );
    assert.equal(requests.length, 0);
  });

  test('rejects a workspace write under an explicit read-only profile', async () => {
    const workspace = await temporaryDirectory('maka-worker-client-read-only-');
    const { client, requests } = fakeClient();

    await assert.rejects(
      client.execute({
        operation: { kind: 'write', path: 'blocked.txt', content: 'blocked' },
        cwd: workspace,
        mode: 'execute',
        permissionProfile: createReadOnlyPermissionProfile(),
      }),
      isPathDenied,
    );
    assert.equal(requests.length, 0);
  });

  test('preserves an explicit exact deny without an additional-permission planner', async () => {
    const workspace = await temporaryDirectory('maka-worker-client-deny-');
    const target = join(workspace, 'denied.txt');
    const profile: PermissionProfile = {
      type: 'managed',
      name: 'custom',
      fileSystem: {
        kind: 'restricted',
        entries: [
          { kind: 'special', access: 'write', special: ':workspace_roots' },
          { kind: 'path', access: 'deny', path: target, match: 'exact' },
        ],
      },
      network: { kind: 'restricted' },
    };
    const { client, requests } = fakeClient();

    await assert.rejects(
      client.execute({
        operation: { kind: 'write', path: target, content: 'blocked' },
        cwd: workspace,
        mode: 'execute',
        permissionProfile: profile,
      }),
      isPathDenied,
    );
    assert.equal(requests.length, 0);
  });

  test('allows an external read granted by an explicit custom profile', async () => {
    const workspace = await temporaryDirectory('maka-worker-client-workspace-');
    const outside = await temporaryDirectory('maka-worker-client-outside-');
    const target = join(outside, 'allowed.txt');
    await writeFile(target, 'external', 'utf8');
    const profile: PermissionProfile = {
      type: 'managed',
      name: 'custom',
      fileSystem: {
        kind: 'restricted',
        entries: [{ kind: 'path', access: 'read', path: target, match: 'exact' }],
      },
      network: { kind: 'restricted' },
    };
    const { client, requests } = fakeClient();

    await assert.rejects(
      client.execute({
        operation: { kind: 'read', path: target },
        cwd: workspace,
        mode: 'explore',
      }),
      isPathDenied,
    );
    const result = await client.execute({
      operation: { kind: 'read', path: target },
      cwd: workspace,
      mode: 'explore',
      permissionProfile: profile,
    });

    assert.deepEqual(result, { kind: 'read', content: 'worker-content' });
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0]?.operationBoundary.filesystem?.entries, [
      {
        path: target,
        access: 'read',
        scope: 'exact',
      },
    ]);
  });
});

describe('filesystem worker client Grep target scope', () => {
  test('uses exact scope for an in-workspace file', async () => {
    const workspace = await temporaryDirectory('maka-worker-client-grep-file-');
    const target = join(workspace, 'file.ts');
    await writeFile(target, 'const value = 1;', 'utf8');
    const { client, requests } = fakeClient();

    const result = await client.execute({
      operation: grepOperation(target),
      cwd: workspace,
      mode: 'ask',
    });

    assert.deepEqual(result, { kind: 'grep', matches: ['file.ts:1:value'] });
    assert.equal(requests[0]?.expectedTarget.scope, 'exact');
  });

  test('uses subtree scope for a directory search', async () => {
    const workspace = await temporaryDirectory('maka-worker-client-grep-directory-');
    const directory = join(workspace, 'src');
    await mkdir(directory);
    const { client, requests } = fakeClient();

    await client.execute({
      operation: grepOperation(directory),
      cwd: workspace,
      mode: 'ask',
    });

    assert.equal(requests[0]?.expectedTarget.scope, 'subtree');
    assert.deepEqual(requests[0]?.operationBoundary.filesystem?.entries, [
      {
        path: directory,
        access: 'read',
        scope: 'subtree',
      },
    ]);
  });
});

describe('filesystem worker operation-scoped Seatbelt profile', () => {
  test('narrows a write worker to the exact target while preserving the base policy', async () => {
    const workspace = await temporaryDirectory('maka-worker-client-operation-profile-');
    const target = join(workspace, 'target.txt');
    const sibling = join(workspace, 'sibling.txt');
    const { client, transforms } = fakeClient();

    await client.execute({
      operation: { kind: 'write', path: target, content: 'target' },
      cwd: workspace,
      mode: 'execute',
    });

    const transform = transforms[0];
    assert.ok(transform);
    assert.equal(
      canWritePath(transform.command.profile, target, transform.command.pathContext),
      true,
    );
    assert.equal(
      canWritePath(transform.command.profile, sibling, transform.command.pathContext),
      false,
    );
    assert.equal(
      transform.command.profile.type === 'managed' &&
        transform.command.profile.fileSystem.kind === 'restricted'
        ? transform.command.profile.fileSystem.protectedMetadata?.names
        : undefined,
      undefined,
    );
  });

  test('preserves sandbox context without changing ordinary filesystem denial semantics', async () => {
    const workspace = await temporaryDirectory('maka-worker-client-denial-context-');
    const target = join(workspace, 'file.ts');
    await writeFile(target, 'const value = 1;', 'utf8');
    const { client } = fakeClient({ operationErrorCode: 'filesystem_denied' });

    await assert.rejects(
      client.execute({
        operation: grepOperation(target),
        cwd: workspace,
        mode: 'ask',
      }),
      (error: unknown) => {
        assert.ok(error instanceof FilesystemWorkerClientError);
        assert.equal(error.reason, 'filesystem_denied');
        assert.equal(error.stage, 'operation');
        assert.equal(error.backend, 'macos-seatbelt');
        assert.equal(error.profileName, 'workspace-write');
        return true;
      },
    );
  });

  test('preserves an explicit sandbox denial from the worker protocol', async () => {
    const workspace = await temporaryDirectory('maka-worker-client-sandbox-denial-');
    const target = join(workspace, 'file.ts');
    await writeFile(target, 'const value = 1;', 'utf8');
    const { client } = fakeClient({ operationErrorCode: 'sandbox_denied' });

    await assert.rejects(
      client.execute({
        operation: grepOperation(target),
        cwd: workspace,
        mode: 'ask',
      }),
      (error: unknown) => {
        assert.ok(error instanceof FilesystemWorkerClientError);
        assert.equal(error.reason, 'sandbox_denied');
        assert.equal(error.stage, 'operation');
        assert.equal(error.backend, 'macos-seatbelt');
        return true;
      },
    );
  });
});

describe('filesystem worker Linux path context', () => {
  test('rejects an existing subtree that disappears before it can be pinned', async () => {
    const workspace = await temporaryDirectory('maka-linux-worker-vanished-');
    const target = join(workspace, 'src');
    await mkdir(target);
    const { client, requests } = fakeClient({
      platform: 'linux',
      beforeLaunchSpecReturn: () => rmSync(target, { recursive: true }),
    });

    await assert.rejects(
      client.execute({
        operation: { kind: 'glob', path: target, pattern: '*.ts', limit: 20 },
        cwd: workspace,
        mode: 'ask',
      }),
      (error: unknown) => {
        assert.ok(error instanceof FilesystemWorkerClientError);
        assert.equal(error.reason, 'path_changed');
        return true;
      },
    );
    assert.equal(requests.length, 0);
  });

  test('pins an existing operation target through an inherited descriptor', async () => {
    const workspace = await temporaryDirectory('maka-linux-worker-pin-');
    const target = join(workspace, 'existing.txt');
    await writeFile(target, 'existing', 'utf8');
    const { client, processInputs } = fakeClient({ platform: 'linux' });

    await client.execute({
      operation: { kind: 'read', path: target },
      cwd: workspace,
      mode: 'ask',
    });

    const processInput = processInputs[0];
    assert.ok(processInput);
    const pinned = processInput.fdInputs?.find(
      (input): input is Extract<typeof input, { sourceFd: number }> => 'sourceFd' in input,
    );
    assert.ok(pinned);
    assert.ok(hasArgTriple(processInput.argv, '--ro-bind', `/proc/self/fd/${pinned.fd}`, target));
  });

  test('pins the writable parent of a missing exact target', async () => {
    const workspace = await temporaryDirectory('maka-linux-worker-parent-pin-');
    const parent = join(workspace, 'output');
    const target = join(parent, 'new.txt');
    await mkdir(parent);
    const { client, processInputs } = fakeClient({ platform: 'linux' });

    await client.execute({
      operation: { kind: 'write', path: target, content: 'new' },
      cwd: workspace,
      mode: 'ask',
    });

    const processInput = processInputs[0];
    assert.ok(processInput);
    const pinned = processInput.fdInputs?.find(
      (input): input is Extract<typeof input, { sourceFd: number }> => 'sourceFd' in input,
    );
    assert.ok(pinned);
    assert.ok(hasArgTriple(processInput.argv, '--bind', `/proc/self/fd/${pinned.fd}`, parent));
    assert.equal(hasArgTriple(processInput.argv, '--bind', parent, parent), false);
  });

  test('requests a trusted parent mount only for a missing write target', () => {
    const target = join(tmpdir(), 'maka-linux-worker-parent', 'new.txt');
    assert.deepEqual(
      filesystemWorkerRuntimeWritableRoots({
        platform: 'linux',
        access: 'write',
        enforcementPath: target,
        targetType: 'missing',
      }),
      [join(tmpdir(), 'maka-linux-worker-parent')],
    );
    assert.equal(
      filesystemWorkerRuntimeWritableRoots({
        platform: 'darwin',
        access: 'write',
        enforcementPath: target,
        targetType: 'missing',
      }),
      undefined,
    );
    assert.equal(
      filesystemWorkerRuntimeWritableRoots({
        platform: 'linux',
        access: 'read',
        enforcementPath: target,
        targetType: 'missing',
      }),
      undefined,
    );
  });
});

function fakeClient(
  options: {
    operationErrorCode?: FilesystemWorkerErrorCode;
    platform?: SandboxPlatform;
    beforeLaunchSpecReturn?: () => void;
  } = {},
): {
  client: FilesystemWorkerClient;
  requests: FilesystemWorkerRequest[];
  transforms: SandboxTransformRequest[];
  processInputs: FilesystemWorkerProcessRunInput[];
} {
  const requests: FilesystemWorkerRequest[] = [];
  const transforms: SandboxTransformRequest[] = [];
  const platform = options.platform ?? 'darwin';
  const sandboxManager =
    platform === 'linux'
      ? new SandboxManager([
          new LinuxBubblewrapBackend({
            capability: { available: true, bwrapPath: '/usr/bin/bwrap' },
          }),
        ])
      : new SandboxManager([new MacosSeatbeltBackend()]);
  const processInputs: FilesystemWorkerProcessRunInput[] = [];
  const client = new FilesystemWorkerClient({
    sandboxManager: Object.assign(Object.create(sandboxManager), {
      transform(request: SandboxTransformRequest): SandboxTransformResult {
        transforms.push(request);
        return sandboxManager.transform(request);
      },
    }) as SandboxManager,
    platform,
    newId: () => `request-${requests.length + 1}`,
    getLaunchSpec: async () => {
      options.beforeLaunchSpecReturn?.();
      return {
        ok: true,
        spec: {
          program: '/usr/bin/node',
          args: ['/runtime/filesystem-worker.js', '--grep-executable', '/usr/bin/rg'],
          env: {},
          runtimeReadableRoots: ['/runtime/filesystem-worker.js'],
          executableRoots: ['/usr/bin/node', '/usr/bin/rg'],
        },
      };
    },
    runProcess: async (input) => {
      processInputs.push(input);
      const request = FilesystemWorkerRequestSchema.parse(JSON.parse(input.stdin));
      requests.push(request);
      return {
        exitCode: 0,
        stdout: JSON.stringify(
          options.operationErrorCode
            ? {
                version: FILESYSTEM_WORKER_PROTOCOL_VERSION,
                requestId: request.requestId,
                ok: false,
                error: {
                  code: options.operationErrorCode,
                  message: 'Sandbox denied the filesystem operation.',
                },
              }
            : {
                version: FILESYSTEM_WORKER_PROTOCOL_VERSION,
                requestId: request.requestId,
                ok: true,
                result: fakeResult(request),
              },
        ),
        stderrTail: '',
        timedOut: false,
        aborted: false,
        responseOverflow: false,
        dispatched: true,
      };
    },
  });
  return { client, requests, transforms, processInputs };
}

function fakeResult(request: FilesystemWorkerRequest): FilesystemWorkerResult {
  switch (request.operation.kind) {
    case 'read':
      return request.operation.path.endsWith('.png')
        ? { kind: 'read_image', base64: 'iVBORw==', mimeType: 'image/png' }
        : { kind: 'read', content: 'worker-content' };
    case 'write':
      return {
        kind: 'write',
        ok: true,
        path: request.operation.path,
        bytes: Buffer.byteLength(request.operation.content, 'utf8'),
      };
    case 'apply_patch':
      return { kind: 'apply_patch', ok: true, path: request.operation.path };
    case 'grep':
      return { kind: 'grep', matches: ['file.ts:1:value'] };
    case 'glob':
      return { kind: 'glob', files: [] };
    default:
      throw new Error(`Unexpected fake worker operation: ${request.operation.kind}`);
  }
}

function grepOperation(path: string) {
  return {
    kind: 'grep' as const,
    path,
    pattern: 'value',
    maxCountPerFile: 50,
    limit: 200,
    timeoutMs: 1_000,
  };
}

function hasArgTriple(
  argv: readonly string[],
  first: string,
  second: string,
  third: string,
): boolean {
  return argv.some(
    (value, index) => value === first && argv[index + 1] === second && argv[index + 2] === third,
  );
}

describe('filesystem worker client dispatch classification', () => {
  // The process-runner attaches a `dispatched` flag to its rejection so the
  // client can tell a never-started spawn from a ran-but-result-lost failure.
  // Only the latter can have written anything, so it gets a distinct reason.
  function clientWithRejectingRunProcess(
    reject: (input: FilesystemWorkerProcessRunInput) => Error,
  ): FilesystemWorkerClient {
    const sandboxManager = new SandboxManager([new MacosSeatbeltBackend()]);
    return new FilesystemWorkerClient({
      sandboxManager,
      platform: 'darwin',
      newId: () => 'request-1',
      getLaunchSpec: async () => ({
        ok: true,
        spec: {
          program: '/usr/bin/node',
          args: ['/runtime/filesystem-worker.js', '--grep-executable', '/usr/bin/rg'],
          env: {},
          runtimeReadableRoots: ['/runtime/filesystem-worker.js'],
          executableRoots: ['/usr/bin/node', '/usr/bin/rg'],
        },
      }),
      runProcess: async (input) => {
        throw reject(input);
      },
    });
  }

  function dispatchedError(message: string, dispatched: boolean): Error {
    const error = new Error(message);
    Object.defineProperty(error, 'dispatched', { value: dispatched, enumerable: true });
    return error;
  }

  test('classifies a post-dispatch runProcess rejection as worker_io_incomplete', async () => {
    const client = clientWithRejectingRunProcess(() =>
      dispatchedError('Filesystem worker output did not drain before lifecycle deadline', true),
    );
    await assert.rejects(
      client.execute({
        operation: { kind: 'write', path: '/tmp/maka-dispatch-incomplete.txt', content: 'x' },
        cwd: '/tmp',
        mode: 'ask',
      }),
      (error: unknown) => {
        assert.ok(error instanceof FilesystemWorkerClientError);
        assert.equal(error.reason, 'worker_io_incomplete');
        assert.equal(error.dispatched, true);
        return true;
      },
    );
  });

  test('classifies a never-dispatched runProcess rejection as spawn_failed', async () => {
    const client = clientWithRejectingRunProcess(() => dispatchedError('spawn ENOENT', false));
    await assert.rejects(
      client.execute({
        operation: { kind: 'write', path: '/tmp/maka-dispatch-spawn.txt', content: 'x' },
        cwd: '/tmp',
        mode: 'ask',
      }),
      (error: unknown) => {
        assert.ok(error instanceof FilesystemWorkerClientError);
        assert.equal(error.reason, 'spawn_failed');
        assert.equal(error.dispatched, false);
        return true;
      },
    );
  });

  test('a rejection without a dispatched flag is treated as never-dispatched', async () => {
    // spawn() itself throwing (before any 'spawn' event) carries no flag.
    const client = clientWithRejectingRunProcess(() => new Error('spawn EACCES'));
    await assert.rejects(
      client.execute({
        operation: { kind: 'write', path: '/tmp/maka-dispatch-noflag.txt', content: 'x' },
        cwd: '/tmp',
        mode: 'ask',
      }),
      (error: unknown) => {
        assert.ok(error instanceof FilesystemWorkerClientError);
        assert.equal(error.reason, 'spawn_failed');
        return true;
      },
    );
  });

  // The missing↔existing transitions while queued (#2600 P2-1): the client
  // reconciles the T0 identity against the T1 reality the normaliser derived,
  // so cooperative lock-ordered changes never surface as invalid_request.
  test('drops a stale identity when the target vanished while queued (delete-then-rewrite)', async () => {
    const workspace = await temporaryDirectory('maka-client-stale-identity-');
    const target = join(workspace, 'file.txt');
    await writeFile(target, 'original', 'utf8');
    const stale = await lstat(target, { bigint: true });
    // The cooperative delete already ran: the target is gone by T1.
    await rm(target);

    const requests: FilesystemWorkerRequest[] = [];
    const sandboxManager = new SandboxManager([new MacosSeatbeltBackend()]);
    const client = new FilesystemWorkerClient({
      sandboxManager,
      platform: 'darwin',
      newId: () => 'request-1',
      getLaunchSpec: async () => ({
        ok: true,
        spec: {
          program: '/usr/bin/node',
          args: ['/runtime/filesystem-worker.js', '--grep-executable', '/usr/bin/rg'],
          env: {},
          runtimeReadableRoots: ['/runtime/filesystem-worker.js'],
          executableRoots: ['/usr/bin/node', '/usr/bin/rg'],
        },
      }),
      runProcess: async (input) => {
        const request = FilesystemWorkerRequestSchema.parse(JSON.parse(input.stdin));
        requests.push(request);
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            version: FILESYSTEM_WORKER_PROTOCOL_VERSION,
            requestId: request.requestId,
            ok: true,
            result: { kind: 'write', ok: true, path: request.operation.path, bytes: 3 },
          }),
          stderrTail: '',
          timedOut: false,
          aborted: false,
          responseOverflow: false,
          dispatched: true,
        };
      },
    });

    // T0 captured an identity; by T1 the target is missing. The stale identity
    // must be dropped — never sent on a missing target — so the write proceeds
    // as a fresh exclusive create instead of failing invalid_request.
    await client.execute({
      operation: { kind: 'write', path: target, content: 'new' },
      cwd: workspace,
      mode: 'ask',
      expectedIdentity: { dev: String(stale.dev), ino: String(stale.ino) },
    });

    assert.equal(requests[0]?.expectedTarget.targetType, 'missing');
    assert.equal(requests[0]?.expectedTarget.identity, undefined);
  });

  test('rejects a write whose target was created while queued (never invalid_request)', async () => {
    const workspace = await temporaryDirectory('maka-client-created-');
    const target = join(workspace, 'file.txt');
    // The target was approved as missing (no identity) and appeared by T1.
    await writeFile(target, 'external-content', 'utf8');

    const sandboxManager = new SandboxManager([new MacosSeatbeltBackend()]);
    const client = new FilesystemWorkerClient({
      sandboxManager,
      platform: 'darwin',
      newId: () => 'request-1',
      getLaunchSpec: async () => ({
        ok: true,
        spec: {
          program: '/usr/bin/node',
          args: ['/runtime/filesystem-worker.js', '--grep-executable', '/usr/bin/rg'],
          env: {},
          runtimeReadableRoots: ['/runtime/filesystem-worker.js'],
          executableRoots: ['/usr/bin/node', '/usr/bin/rg'],
        },
      }),
      runProcess: async () => {
        throw new Error('must not dispatch');
      },
    });

    await assert.rejects(
      client.execute({
        operation: { kind: 'write', path: target, content: 'new' },
        cwd: workspace,
        mode: 'ask',
      }),
      (error: unknown) => {
        assert.ok(error instanceof FilesystemWorkerClientError);
        assert.equal(error.reason, 'path_changed');
        return true;
      },
    );
    // The interloper's content was never touched.
    assert.equal(await readFile(target, 'utf8'), 'external-content');
  });
});

function isPathDenied(error: unknown): boolean {
  return error instanceof FilesystemWorkerClientError && error.reason === 'path_denied';
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(path);
  return await realpath(path);
}
