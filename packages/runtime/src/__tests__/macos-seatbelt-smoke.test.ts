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
import { after, describe, it } from 'node:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

import { applySandboxBoundaryExpansion } from '@maka/core/sandbox-boundary';

import {
  createWorkspaceWritePermissionProfile,
  type PermissionProfile,
} from '@maka/core/permission-profile';

import { MACOS_SEATBELT_EXECUTABLE, MacosSeatbeltBackend } from '../sandbox/macos-seatbelt.js';
import { SandboxManager } from '../sandbox/sandbox-manager.js';

const canRunSeatbelt = process.platform === 'darwin' && existsSync(MACOS_SEATBELT_EXECUTABLE);

async function makeWorkspace(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), 'maka-seatbelt-workspace-')));
}

function profileWithDeniedChild(workspaceRoot: string): PermissionProfile {
  return {
    type: 'managed',
    name: 'custom',
    fileSystem: {
      kind: 'restricted',
      entries: [
        {
          kind: 'special',
          access: 'write',
          special: ':workspace_roots',
        },
        {
          kind: 'path',
          access: 'deny',
          path: join(workspaceRoot, 'secret'),
        },
      ],
    },
    network: { kind: 'restricted' },
  };
}

function runSeatbeltCommand(
  workspaceRoot: string,
  command: string,
  profile: PermissionProfile = createWorkspaceWritePermissionProfile(),
) {
  const manager = new SandboxManager([new MacosSeatbeltBackend()]);
  const result = manager.transform({
    platform: 'darwin',
    command: {
      program: '/bin/sh',
      args: ['-c', command],
      cwd: workspaceRoot,
      profile,
      pathContext: {
        workspaceRoots: [workspaceRoot],
      },
    },
  });

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('unreachable');

  return spawnSync(result.exec.argv[0], result.exec.argv.slice(1), {
    cwd: result.exec.cwd,
    env: { ...process.env, ...result.exec.env },
    encoding: 'utf8',
  });
}

describe('macOS Seatbelt smoke', { skip: !canRunSeatbelt }, () => {
  const cleanup: string[] = [];

  after(async () => {
    await Promise.all(cleanup.map((path) => rm(path, { recursive: true, force: true })));
  });

  it('allows ordinary writes inside the workspace root', async () => {
    const workspaceRoot = await makeWorkspace();
    cleanup.push(workspaceRoot);

    const child = runSeatbeltCommand(workspaceRoot, 'printf ok > allowed.txt');

    assert.equal(child.status, 0, child.stderr);
    assert.equal(await readFile(join(workspaceRoot, 'allowed.txt'), 'utf8'), 'ok');
  });

  it('denies writes outside the workspace root', async () => {
    const workspaceRoot = await makeWorkspace();
    const outsideRoot = await realpath(await mkdtemp(join(tmpdir(), 'maka-seatbelt-outside-')));
    cleanup.push(workspaceRoot, outsideRoot);
    const outsideFile = resolve(outsideRoot, 'denied.txt');

    const child = runSeatbeltCommand(workspaceRoot, `printf nope > ${JSON.stringify(outsideFile)}`);

    assert.notEqual(child.status, 0);
  });

  it('allows only the exact outside path in the expanded session boundary', async () => {
    const workspaceRoot = await makeWorkspace();
    const outsideRoot = await realpath(await mkdtemp(join(tmpdir(), 'maka-seatbelt-additional-')));
    cleanup.push(workspaceRoot, outsideRoot);
    const allowedFile = resolve(outsideRoot, 'allowed.txt');
    const siblingFile = resolve(outsideRoot, 'sibling.txt');
    const expandedProfile = applySandboxBoundaryExpansion(createWorkspaceWritePermissionProfile(), {
      filesystem: {
        entries: [{ path: allowedFile, access: 'write', scope: 'exact' }],
      },
    });

    const allowed = runSeatbeltCommand(
      workspaceRoot,
      `printf ok > ${JSON.stringify(allowedFile)}`,
      expandedProfile,
    );
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.equal(await readFile(allowedFile, 'utf8'), 'ok');

    const sibling = runSeatbeltCommand(
      workspaceRoot,
      `printf nope > ${JSON.stringify(siblingFile)}`,
      expandedProfile,
    );
    assert.notEqual(sibling.status, 0);
    assert.equal(existsSync(siblingFile), false);
  });

  it('allows workspace metadata writes in the standard managed boundary', async () => {
    const workspaceRoot = await makeWorkspace();
    cleanup.push(workspaceRoot);

    const child = runSeatbeltCommand(workspaceRoot, 'mkdir .codex');

    assert.equal(child.status, 0, child.stderr);
    assert.equal(existsSync(join(workspaceRoot, '.codex')), true);
  });

  it('denies writes to explicit denied children under a writable workspace root', async () => {
    const workspaceRoot = await makeWorkspace();
    cleanup.push(workspaceRoot);

    const child = runSeatbeltCommand(
      workspaceRoot,
      'mkdir -p secret && printf denied > secret/file.txt',
      profileWithDeniedChild(workspaceRoot),
    );

    assert.notEqual(child.status, 0);
  });

  it('denies direct network access under restricted network policy', async () => {
    const workspaceRoot = await makeWorkspace();
    cleanup.push(workspaceRoot);

    const child = runSeatbeltCommand(
      workspaceRoot,
      '/usr/bin/python3 -c "import socket; socket.create_connection((\\"127.0.0.1\\", 9), 0.2)"',
    );

    assert.notEqual(child.status, 0);
  });
});
