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
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

import { applySandboxBoundaryExpansion } from '@maka/core/sandbox-boundary';

import {
  createWorkspaceWritePermissionProfile,
  type PermissionProfile,
} from '@maka/core/permission-profile';

import {
  MACOS_SEATBELT_EXECUTABLE,
  MacosSeatbeltBackend,
  macosBashExecutableRoots,
  resolveMacosDeveloperToolchainRoot,
} from '../sandbox/macos-seatbelt.js';
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
  includeTempRoots = false,
  executableRoots: readonly string[] = [],
  env: NodeJS.ProcessEnv = process.env,
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
        ...(includeTempRoots ? { tmpdir: tmpdir(), slashTmp: '/tmp' } : {}),
        ...(executableRoots.length > 0 ? { executableRoots } : {}),
      },
    },
  });

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('unreachable');

  return spawnSync(result.exec.argv[0], result.exec.argv.slice(1), {
    cwd: result.exec.cwd,
    env: { ...env, ...result.exec.env },
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

  it('allows ancestor directory reads without exposing ancestor file contents', async () => {
    const ancestorRoot = await realpath(await mkdtemp(join(tmpdir(), 'maka-seatbelt-ancestors-')));
    const workspaceRoot = join(ancestorRoot, 'level-one', 'level-two');
    const ancestorFile = join(ancestorRoot, 'private.txt');
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(ancestorFile, 'private');
    cleanup.push(ancestorRoot);

    const listAncestor = runSeatbeltCommand(workspaceRoot, '/bin/ls ..');
    assert.equal(listAncestor.status, 0, listAncestor.stderr);

    const readAncestorFile = runSeatbeltCommand(
      workspaceRoot,
      `/bin/cat ${JSON.stringify(ancestorFile)}`,
    );
    assert.notEqual(readAncestorFile.status, 0);
    assert.match(readAncestorFile.stderr, /Operation not permitted/);
  });

  it('allows temp writes when workspace and temp roots use symlinked paths', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-seatbelt-temp-workspace-'));
    const slashTmpFile = join('/tmp', `maka-seatbelt-slash-tmp-${process.pid}-${Date.now()}`);
    cleanup.push(workspaceRoot, slashTmpFile);

    const child = runSeatbeltCommand(
      workspaceRoot,
      `created=$(/usr/bin/mktemp -d "$TMPDIR/maka-seatbelt.XXXXXX") && /usr/bin/touch ${JSON.stringify(slashTmpFile)} && /bin/rm -rf "$created" ${JSON.stringify(slashTmpFile)}`,
      createWorkspaceWritePermissionProfile(),
      true,
    );

    assert.equal(child.status, 0, child.stderr);
  });

  it('runs a repository-local Homebrew Git command with its runtime dependencies', {
    skip: !existsSync('/opt/homebrew/bin/git'),
  }, async () => {
    const workspaceRoot = await makeWorkspace();
    cleanup.push(workspaceRoot);
    const gitEnvironment = {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    };
    for (const args of [
      ['init'],
      ['config', 'user.name', 'Maka Test'],
      ['config', 'user.email', 'maka@example.test'],
    ]) {
      const setup = spawnSync('/opt/homebrew/bin/git', args, {
        cwd: workspaceRoot,
        env: gitEnvironment,
        encoding: 'utf8',
      });
      assert.equal(setup.status, 0, setup.stderr);
    }
    await writeFile(join(workspaceRoot, 'fixture.txt'), 'fixture\n');
    for (const args of [
      ['add', 'fixture.txt'],
      ['commit', '-m', 'fixture commit'],
    ]) {
      const setup = spawnSync('/opt/homebrew/bin/git', args, {
        cwd: workspaceRoot,
        env: gitEnvironment,
        encoding: 'utf8',
      });
      assert.equal(setup.status, 0, setup.stderr);
    }
    const executableRoots = macosBashExecutableRoots({
      execPath: process.execPath,
      path: '/opt/homebrew/bin:/usr/bin:/bin',
    });

    const child = runSeatbeltCommand(
      workspaceRoot,
      '/opt/homebrew/bin/git log -1 --pretty=format:"%s"',
      createWorkspaceWritePermissionProfile(),
      true,
      executableRoots,
      gitEnvironment,
    );

    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, 'fixture commit');
  });

  it('allows Apple Git to load the selected developer toolchain', async () => {
    const workspaceRoot = await makeWorkspace();
    cleanup.push(workspaceRoot);
    const executableRoots = macosBashExecutableRoots({
      execPath: process.execPath,
      path: '/usr/bin:/bin',
    });

    const child = runSeatbeltCommand(
      workspaceRoot,
      '/usr/bin/git --version',
      createWorkspaceWritePermissionProfile(),
      true,
      executableRoots,
      {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
      },
    );

    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /^git version /);
  });

  it('admits an alternate selected Xcode application root', async () => {
    const workspaceRoot = await makeWorkspace();
    const alternateRoot = await realpath(
      await mkdtemp(join(tmpdir(), 'maka-seatbelt-xcode-beta-')),
    );
    cleanup.push(workspaceRoot, alternateRoot);
    const contents = join(alternateRoot, 'Xcode-beta.app', 'Contents');
    const developer = join(contents, 'Developer');
    const marker = join(contents, 'SharedFrameworks', 'marker.txt');
    await mkdir(developer, { recursive: true });
    await mkdir(join(contents, 'SharedFrameworks'), { recursive: true });
    await writeFile(marker, 'alternate developer root\n');
    const developerRoot = resolveMacosDeveloperToolchainRoot(undefined, () => developer);
    assert.ok(developerRoot);
    const executableRoots = macosBashExecutableRoots({
      execPath: process.execPath,
      path: '/usr/bin:/bin',
      developerRoot,
    });

    const child = runSeatbeltCommand(
      workspaceRoot,
      `/bin/cat ${JSON.stringify(marker)}`,
      createWorkspaceWritePermissionProfile(),
      false,
      executableRoots,
    );

    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, 'alternate developer root\n');
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
