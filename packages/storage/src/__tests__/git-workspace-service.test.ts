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
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  GitWorkspaceServiceError,
  createGitWorkspaceService,
  type GitWorkspaceService,
  type ManagedWorkspaceBinding,
} from '../git-workspace-service.js';

const execFileAsync = promisify(execFile);
const cleanup: string[] = [];
let gitExecutablePath: string;
let gitExecutableSha256: `sha256:${string}`;

// These probes fork a second Node process, stop it at a durable failpoint, and
// kill it to verify restart convergence. Keep the full crash matrix on this
// service's owning stress route; the default suite still covers recovery,
// quarantine, corruption, ownership, and symlink boundaries in-process.
const RUN_REAL_PROCESS_CRASH_TESTS = process.env.MAKA_STORAGE_STRESS === '1';

before(async () => {
  gitExecutablePath = await findGitExecutable();
  gitExecutableSha256 = await sha256File(gitExecutablePath);
});

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('Git workspace service', () => {
  test('fails before creating storage when the explicit Git artifact digest is wrong', async () => {
    const root = await temporaryRoot();
    const storageRoot = join(root, 'storage');
    const sourceRoot = await createEligibleSource(join(root, 'source'));
    const service = createGitWorkspaceService({
      storageRoot,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: `sha256:${'0'.repeat(64)}`,
      },
    });

    await assert.rejects(
      service.createManagedWorkspaceFromSource(openRequest(sourceRoot)),
      isWorkspaceError('git_runtime_integrity_mismatch'),
    );
    assert.equal(existsSync(storageRoot), false);
  });

  test('imports only the clean source HEAD tree into an independent fixed-config workspace', async () => {
    const root = await temporaryRoot();
    const sourceRoot = await createEligibleSource(join(root, 'source'));
    await git(sourceRoot, 'config', 'core.hooksPath', join(root, 'attacker-hooks'));
    await git(sourceRoot, 'config', 'core.sshCommand', 'attacker-ssh-command');
    await git(sourceRoot, 'config', 'credential.helper', '!attacker-credential-helper');
    const sourceSnapshot = await snapshotSource(sourceRoot);
    const service = await serviceAt(join(root, 'storage'));

    const binding = await service.createManagedWorkspaceFromSource(openRequest(sourceRoot));
    const inspection = await service.inspectManagedWorkspace(binding);

    assert.equal(inspection.state, 'ready');
    assert.equal(inspection.commitOid, binding.baselineCommitOid);
    assert.equal(inspection.treeOid, binding.baselineTreeOid);
    assert.equal(binding.sourceHeadCommitOid, sourceSnapshot.head);
    assert.equal(binding.sourceTreeOid, sourceSnapshot.tree);
    assert.equal(binding.baselineTreeOid, sourceSnapshot.tree);
    assert.match(binding.materializationProfileDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.notEqual(normalize(binding.repositoryPath), normalize(sourceSnapshot.commonDir));
    assert.equal(await readFile(join(binding.worktreePath, 'tracked.txt'), 'utf8'), 'tracked\n');
    assert.equal(existsSync(join(binding.worktreePath, 'ignored.env')), false);
    assert.equal(existsSync(join(binding.worktreePath, '.maka-workspace.json')), false);
    assert.equal(await git(binding.worktreePath, 'status', '--porcelain=v1'), '');
    assert.equal(
      await gitBare(
        binding.repositoryPath,
        'rev-list',
        '--parents',
        '-n',
        '1',
        binding.baselineCommitOid,
      ),
      binding.baselineCommitOid,
    );
    assert.equal(
      await gitBare(binding.repositoryPath, 'config', '--local', '--get', 'core.autocrlf'),
      'false',
    );
    assert.equal(
      await gitBare(binding.repositoryPath, 'config', '--local', '--get', 'core.hooksPath'),
      binding.hooksPath,
    );
    assert.equal(
      await gitBare(binding.repositoryPath, 'config', '--local', '--get', 'core.sshCommand'),
      '',
    );
    assert.equal(
      await gitBare(binding.repositoryPath, 'config', '--local', '--get', 'protocol.allow'),
      'never',
    );
    assert.equal(existsSync(join(binding.repositoryPath, 'objects', 'info', 'alternates')), false);
    await assert.rejects(gitBare(binding.repositoryPath, 'cat-file', '-e', sourceSnapshot.head));
    await assertSourceUnchanged(sourceRoot, sourceSnapshot);
  });

  test('does not inherit a poisoned process-level Git config path', async () => {
    const root = await temporaryRoot();
    const sourceRoot = await createEligibleSource(join(root, 'source'));
    const poisonedConfig = join(root, 'poisoned-global-gitconfig');
    await writeFile(poisonedConfig, 'this is not valid Git config\n');
    const previous = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = poisonedConfig;
    try {
      const service = await serviceAt(join(root, 'storage'));
      const binding = await service.createManagedWorkspaceFromSource(openRequest(sourceRoot));
      assert.equal((await service.inspectManagedWorkspace(binding)).state, 'ready');
    } finally {
      if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previous;
    }
  });

  test('adopts the same binding across service restart and concurrent duplicate opens', async () => {
    const root = await temporaryRoot();
    const sourceRoot = await createEligibleSource(join(root, 'source'));
    const storageRoot = join(root, 'storage');
    const request = openRequest(sourceRoot);
    const firstService = await serviceAt(storageRoot);
    const [left, right] = await Promise.all([
      firstService.createManagedWorkspaceFromSource(request),
      firstService.createManagedWorkspaceFromSource(request),
    ]);
    const restarted = await serviceAt(storageRoot);
    const adopted = await restarted.openManagedWorkspaceFromBinding(left);

    assert.deepEqual(right, left);
    assert.deepEqual(adopted, left);
    assert.equal((await restarted.inspectManagedWorkspace(adopted)).state, 'ready');
  });

  test('reopens an existing managed epoch after the source checkout advances', async () => {
    const root = await temporaryRoot();
    const sourceRoot = await createEligibleSource(join(root, 'source'));
    const storageRoot = join(root, 'storage');
    const request = openRequest(sourceRoot);
    const firstService = await serviceAt(storageRoot);
    const created = await firstService.createManagedWorkspaceFromSource(request);

    await writeFile(join(sourceRoot, 'tracked.txt'), 'source advanced\n', 'utf8');
    await git(sourceRoot, 'add', 'tracked.txt');
    await git(
      sourceRoot,
      '-c',
      'user.name=Maka Test',
      '-c',
      'user.email=test@maka.invalid',
      'commit',
      '--quiet',
      '-m',
      'advance source after managed epoch creation',
    );

    const restarted = await serviceAt(storageRoot);
    const reopened = await restarted.openManagedWorkspaceFromBinding(created);

    assert.deepEqual(reopened, created);
    assert.equal((await restarted.inspectManagedWorkspace(reopened)).state, 'ready');
    assert.equal(await readFile(join(reopened.worktreePath, 'tracked.txt'), 'utf8'), 'tracked\n');
  });

  test('creates a second epoch with a different baseline in the same managed repository', async () => {
    const root = await temporaryRoot();
    const sourceRoot = await createEligibleSource(join(root, 'source'));
    const service = await serviceAt(join(root, 'storage'));
    const first = await service.createManagedWorkspaceFromSource(openRequest(sourceRoot));

    await writeFile(join(sourceRoot, 'tracked.txt'), 'second epoch\n', 'utf8');
    await git(sourceRoot, 'add', 'tracked.txt');
    await git(
      sourceRoot,
      '-c',
      'user.name=Maka Test',
      '-c',
      'user.email=test@maka.invalid',
      'commit',
      '--quiet',
      '-m',
      'second epoch source',
    );
    const secondRequest = {
      ...openRequest(sourceRoot),
      workspaceEpochId: 'epoch_55555555555555555555555555555555',
      workspaceInstanceId: 'instance_66666666666666666666666666666666',
    } as const;

    const second = await service.createManagedWorkspaceFromSource(secondRequest);

    assert.equal(second.repositoryId, first.repositoryId);
    assert.equal(second.repositoryPath, first.repositoryPath);
    assert.notEqual(second.baselineCommitOid, first.baselineCommitOid);
    assert.notEqual(second.baselineTreeOid, first.baselineTreeOid);
    assert.equal(await readFile(join(first.worktreePath, 'tracked.txt'), 'utf8'), 'tracked\n');
    assert.equal(
      await readFile(join(second.worktreePath, 'tracked.txt'), 'utf8'),
      'second epoch\n',
    );
    assert.equal((await service.inspectManagedWorkspace(first)).state, 'ready');
    assert.equal((await service.inspectManagedWorkspace(second)).state, 'ready');
  });

  test('removes an unpublished baseline ref when the source changes and permits retry', async () => {
    const root = await temporaryRoot();
    const sourceRoot = await createEligibleSource(join(root, 'source'));
    const storageRoot = join(root, 'storage');
    let changed = false;
    const service = createGitWorkspaceService({
      storageRoot,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
      failpoint: async (point) => {
        if (point !== 'after_baseline_ref_created' || changed) return;
        changed = true;
        await writeFile(join(sourceRoot, 'tracked.txt'), 'raced source\n', 'utf8');
        await git(sourceRoot, 'add', 'tracked.txt');
        await git(
          sourceRoot,
          '-c',
          'user.name=Maka Test',
          '-c',
          'user.email=test@maka.invalid',
          'commit',
          '--quiet',
          '-m',
          'source changed during import',
        );
      },
    });

    await assert.rejects(
      service.createManagedWorkspaceFromSource(openRequest(sourceRoot)),
      isWorkspaceError('source_changed_during_baseline_import'),
    );
    const repositoryPath = await onlyManagedRepositoryPath(storageRoot);
    await assert.rejects(
      gitBare(
        repositoryPath,
        'rev-parse',
        '--verify',
        'refs/maka/baselines/epoch_33333333333333333333333333333333',
      ),
    );

    const retried = await service.createManagedWorkspaceFromSource(openRequest(sourceRoot));
    assert.equal(
      await readFile(join(retried.worktreePath, 'tracked.txt'), 'utf8'),
      'raced source\n',
    );
    assert.equal((await service.inspectManagedWorkspace(retried)).state, 'ready');
  });

  test('repairs a crash after baseline ref publication even when the source later advances', {
    skip: !RUN_REAL_PROCESS_CRASH_TESTS,
    timeout: 60_000,
  }, async () => {
    const root = await temporaryRoot();
    const sourceRoot = await createEligibleSource(join(root, 'source'));
    const storageRoot = join(root, 'storage');
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('./fixtures/git-workspace-service-crash-child.js', import.meta.url))],
      {
        env: {
          ...process.env,
          MAKA_GIT_WORKSPACE_STORAGE: storageRoot,
          MAKA_GIT_WORKSPACE_SOURCE: sourceRoot,
          MAKA_GIT_WORKSPACE_EXECUTABLE: gitExecutablePath,
          MAKA_GIT_WORKSPACE_SHA256: gitExecutableSha256,
          MAKA_GIT_WORKSPACE_FAILPOINT: 'after_baseline_ref_created',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    try {
      await waitForReady(child, 30_000);
      child.kill('SIGKILL');
      await waitForExit(child);
      await writeFile(join(sourceRoot, 'tracked.txt'), 'advanced after crash\n', 'utf8');
      await git(sourceRoot, 'add', 'tracked.txt');
      await git(
        sourceRoot,
        '-c',
        'user.name=Maka Test',
        '-c',
        'user.email=test@maka.invalid',
        'commit',
        '--quiet',
        '-m',
        'advance after baseline publication crash',
      );

      const service = await serviceAt(storageRoot);
      const binding = await service.createManagedWorkspaceFromSource(openRequest(sourceRoot));
      assert.equal(
        await readFile(join(binding.worktreePath, 'tracked.txt'), 'utf8'),
        'advanced after crash\n',
      );
      assert.equal((await service.inspectManagedWorkspace(binding)).state, 'ready');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });

  for (const failpoint of [
    'after_worktree_materialized',
    'after_worktree_locked',
    'after_head_ref_updated',
  ] as const) {
    test(`repairs a real-process crash at ${failpoint} without accepting residue`, {
      skip: !RUN_REAL_PROCESS_CRASH_TESTS,
      timeout: 60_000,
    }, async () => {
      const root = await temporaryRoot();
      const sourceRoot = await createEligibleSource(join(root, 'source'));
      const sourceSnapshot = await snapshotSource(sourceRoot);
      const storageRoot = join(root, 'storage');
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(
            new URL('./fixtures/git-workspace-service-crash-child.js', import.meta.url),
          ),
        ],
        {
          env: {
            ...process.env,
            MAKA_GIT_WORKSPACE_STORAGE: storageRoot,
            MAKA_GIT_WORKSPACE_SOURCE: sourceRoot,
            MAKA_GIT_WORKSPACE_EXECUTABLE: gitExecutablePath,
            MAKA_GIT_WORKSPACE_SHA256: gitExecutableSha256,
            MAKA_GIT_WORKSPACE_FAILPOINT: failpoint,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      try {
        await waitForReady(child, 30_000);
        child.kill('SIGKILL');
        await waitForExit(child);

        const service = await serviceAt(storageRoot);
        const binding = await service.createManagedWorkspaceFromSource(openRequest(sourceRoot));
        assert.equal((await service.inspectManagedWorkspace(binding)).state, 'ready');
        const quarantineEntries = await readdir(
          join(storageRoot, 'managed-workspaces', 'quarantine'),
        );
        assert.ok(quarantineEntries.some((entry) => entry.startsWith('incomplete-')));
        await assertSourceUnchanged(sourceRoot, sourceSnapshot);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    });
  }

  for (const failpoint of [
    'after_quarantine_intent',
    'after_quarantine_unlock',
    'after_quarantine_move',
    'after_quarantine_binding_removed',
    'after_quarantine_pruned',
  ] as const) {
    test(`converges quarantine after a real-process crash at ${failpoint}`, {
      skip: !RUN_REAL_PROCESS_CRASH_TESTS,
      timeout: 60_000,
    }, async () => {
      const root = await temporaryRoot();
      const sourceRoot = await createEligibleSource(join(root, 'source'));
      const sourceSnapshot = await snapshotSource(sourceRoot);
      const storageRoot = join(root, 'storage');
      const bindingOutput = join(root, 'binding.json');
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(
            new URL('./fixtures/git-workspace-service-crash-child.js', import.meta.url),
          ),
        ],
        {
          env: {
            ...process.env,
            MAKA_GIT_WORKSPACE_STORAGE: storageRoot,
            MAKA_GIT_WORKSPACE_SOURCE: sourceRoot,
            MAKA_GIT_WORKSPACE_EXECUTABLE: gitExecutablePath,
            MAKA_GIT_WORKSPACE_SHA256: gitExecutableSha256,
            MAKA_GIT_WORKSPACE_FAILPOINT: failpoint,
            MAKA_GIT_WORKSPACE_ACTION: 'quarantine',
            MAKA_GIT_WORKSPACE_BINDING_OUTPUT: bindingOutput,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      try {
        await waitForReady(child, 30_000);
        child.kill('SIGKILL');
        await waitForExit(child);
        const binding = JSON.parse(
          await readFile(bindingOutput, 'utf8'),
        ) as ManagedWorkspaceBinding;
        const service = await serviceAt(storageRoot);

        await assert.rejects(
          service.openManagedWorkspaceFromBinding(binding),
          isWorkspaceError('managed_workspace_unavailable'),
        );
        const first = await service.quarantineManagedWorkspace(binding, 'crash_convergence_test');
        const retry = await service.quarantineManagedWorkspace(binding, 'crash_convergence_test');

        assert.deepEqual(retry, first);
        assert.equal((await stat(first.quarantinePath)).isDirectory(), true);
        assert.equal(existsSync(binding.worktreePath), false);
        await assertSourceUnchanged(sourceRoot, sourceSnapshot);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    });
  }

  test('rejects dirty or unsupported source state without falling back to attached execution', async () => {
    const root = await temporaryRoot();
    const sourceRoot = await createEligibleSource(join(root, 'source'));
    await writeFile(join(sourceRoot, 'untracked.txt'), 'not committed\n', 'utf8');
    const service = await serviceAt(join(root, 'storage'));

    await assert.rejects(
      service.createManagedWorkspaceFromSource(openRequest(sourceRoot)),
      isWorkspaceError('repository_ineligible'),
    );
  });

  test('rejects nested attributes that could change fixed Git materialization', async () => {
    const root = await temporaryRoot();
    const sourceRoot = await createEligibleSource(join(root, 'source'));
    await mkdir(join(sourceRoot, 'nested'));
    await writeFile(join(sourceRoot, 'nested', '.gitattributes'), '*.txt filter=custom\n', 'utf8');
    await git(sourceRoot, 'add', 'nested/.gitattributes');
    await git(
      sourceRoot,
      '-c',
      'user.name=Maka Test',
      '-c',
      'user.email=test@maka.invalid',
      'commit',
      '--quiet',
      '-m',
      'unsupported attributes',
    );
    const service = await serviceAt(join(root, 'storage'));

    await assert.rejects(
      service.createManagedWorkspaceFromSource(openRequest(sourceRoot)),
      isWorkspaceError('repository_ineligible'),
    );
  });

  test('detects external managed-worktree drift and quarantines it without touching source', async () => {
    const root = await temporaryRoot();
    const sourceRoot = await createEligibleSource(join(root, 'source'));
    const sourceSnapshot = await snapshotSource(sourceRoot);
    const service = await serviceAt(join(root, 'storage'));
    const binding = await service.createManagedWorkspaceFromSource(openRequest(sourceRoot));
    await writeFile(join(binding.worktreePath, 'tracked.txt'), 'external writer\n', 'utf8');

    const drifted = await service.inspectManagedWorkspace(binding);
    assert.equal(drifted.state, 'drifted');
    const quarantined = await service.quarantineManagedWorkspace(binding, 'external_drift');

    assert.equal(existsSync(binding.worktreePath), false);
    assert.equal((await stat(quarantined.quarantinePath)).isDirectory(), true);
    assert.equal(
      await readFile(join(quarantined.quarantinePath, 'tracked.txt'), 'utf8'),
      'external writer\n',
    );
    await assertSourceUnchanged(sourceRoot, sourceSnapshot);
    await assert.rejects(
      service.inspectManagedWorkspace(binding),
      isWorkspaceError('managed_workspace_unavailable'),
    );
  });

  test('rejects quarantine resume when its owned root is replaced by a symlink', async () => {
    const root = await temporaryRoot();
    const storageRoot = join(root, 'storage');
    const sourceRoot = await createEligibleSource(join(root, 'source'));
    let interruptOnce = true;
    const interrupted = createGitWorkspaceService({
      storageRoot,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
      failpoint(point) {
        if (point === 'after_quarantine_intent' && interruptOnce) {
          interruptOnce = false;
          throw new Error('stop after durable quarantine intent');
        }
      },
    });
    const binding = await interrupted.createManagedWorkspaceFromSource(openRequest(sourceRoot));
    await assert.rejects(
      interrupted.quarantineManagedWorkspace(binding, 'owned_root_symlink'),
      /stop after durable quarantine intent/u,
    );
    const quarantineRoot = join(storageRoot, 'managed-workspaces', 'quarantine');
    const externalRoot = join(root, 'external-quarantine');
    await rm(quarantineRoot, { recursive: true, force: true });
    await mkdir(externalRoot, { recursive: true });
    await symlink(externalRoot, quarantineRoot, process.platform === 'win32' ? 'junction' : 'dir');

    const service = await serviceAt(storageRoot);
    await assert.rejects(
      service.quarantineManagedWorkspace(binding, 'owned_root_symlink'),
      isWorkspaceError('managed_workspace_identity_conflict'),
    );
    assert.equal(existsSync(binding.worktreePath), true);
    assert.deepEqual(await readdir(externalRoot), []);
  });

  test('rejects control records reached through a replaced instance-root symlink', async () => {
    const root = await temporaryRoot();
    const storageRoot = join(root, 'storage');
    const sourceRoot = await createEligibleSource(join(root, 'source'));
    const service = await serviceAt(storageRoot);
    const binding = await service.createManagedWorkspaceFromSource(openRequest(sourceRoot));
    const instanceRoot = dirname(binding.worktreePath);
    const externalRoot = join(root, 'external-instance');
    await mkdir(externalRoot, { recursive: true });
    const movedInstance = join(externalRoot, 'instance');
    await rename(instanceRoot, movedInstance);
    await symlink(movedInstance, instanceRoot, process.platform === 'win32' ? 'junction' : 'dir');

    await assert.rejects(
      service.inspectManagedWorkspace(binding),
      isWorkspaceError('managed_workspace_identity_conflict'),
    );
  });

  test('rejects a source repository that delegates object lookup through alternates', async () => {
    const root = await temporaryRoot();
    const sourceRoot = await createEligibleSource(join(root, 'source'));
    const commonDirRaw = await git(sourceRoot, 'rev-parse', '--git-common-dir');
    const commonDir = await realpath(join(sourceRoot, commonDirRaw));
    const alternateObjects = join(root, 'alternate-objects');
    await mkdir(alternateObjects, { recursive: true });
    await mkdir(join(commonDir, 'objects', 'info'), { recursive: true });
    await writeFile(
      join(commonDir, 'objects', 'info', 'alternates'),
      `${alternateObjects}\n`,
      'utf8',
    );
    const service = await serviceAt(join(root, 'storage'));

    await assert.rejects(
      service.createManagedWorkspaceFromSource(openRequest(sourceRoot)),
      isWorkspaceError('repository_ineligible'),
    );
  });

  test('rejects unsafe worktree-scoped source configuration', async () => {
    const root = await temporaryRoot();
    const sourceRoot = await createEligibleSource(join(root, 'source'));
    await git(sourceRoot, 'config', 'extensions.worktreeConfig', 'true');
    await git(sourceRoot, 'config', '--worktree', 'core.fsmonitor', 'untrusted-monitor');
    const service = await serviceAt(join(root, 'storage'));

    await assert.rejects(
      service.createManagedWorkspaceFromSource(openRequest(sourceRoot)),
      isWorkspaceError('repository_ineligible'),
    );
  });

  test('rejects a local includeIf source configuration after Git key normalization', async () => {
    const root = await temporaryRoot();
    const sourceRoot = await createEligibleSource(join(root, 'source'));
    await git(
      sourceRoot,
      'config',
      '--local',
      'includeIf.gitdir:/definitely-never/.path',
      '../untrusted-config',
    );
    const service = await serviceAt(join(root, 'storage'));

    await assert.rejects(
      service.createManagedWorkspaceFromSource(openRequest(sourceRoot)),
      isWorkspaceError('repository_ineligible'),
    );
  });

  test('rejects a worktree partial-clone source configuration after key normalization', async () => {
    const root = await temporaryRoot();
    const sourceRoot = await createEligibleSource(join(root, 'source'));
    await git(sourceRoot, 'config', 'extensions.worktreeConfig', 'true');
    await git(sourceRoot, 'config', '--worktree', 'extensions.partialClone', 'origin');
    const service = await serviceAt(join(root, 'storage'));

    await assert.rejects(
      service.createManagedWorkspaceFromSource(openRequest(sourceRoot)),
      isWorkspaceError('repository_ineligible'),
    );
  });

  test('rejects adoption when the Maka worktree ownership lock is removed', async () => {
    const root = await temporaryRoot();
    const sourceRoot = await createEligibleSource(join(root, 'source'));
    const service = await serviceAt(join(root, 'storage'));
    const binding = await service.createManagedWorkspaceFromSource(openRequest(sourceRoot));
    await gitBare(binding.repositoryPath, 'worktree', 'unlock', binding.worktreePath);

    await assert.rejects(
      service.inspectManagedWorkspace(binding),
      isWorkspaceError('managed_workspace_identity_conflict'),
    );
  });

  test('does not overwrite a conflicting managed head ref', async () => {
    const root = await temporaryRoot();
    const sourceRoot = await createEligibleSource(join(root, 'source'));
    const service = await serviceAt(join(root, 'storage'));
    const first = await service.createManagedWorkspaceFromSource(openRequest(sourceRoot));
    const conflictingEpochId = 'epoch_55555555555555555555555555555555';
    const conflictingHeadRef = `refs/maka/workspaces/${first.workspaceId}/epochs/${conflictingEpochId}/head`;
    await gitBare(first.repositoryPath, 'update-ref', conflictingHeadRef, first.baselineCommitOid);
    await writeFile(join(sourceRoot, 'tracked.txt'), 'conflicting second epoch\n', 'utf8');
    await git(sourceRoot, 'add', 'tracked.txt');
    await git(
      sourceRoot,
      '-c',
      'user.name=Maka Test',
      '-c',
      'user.email=test@maka.invalid',
      'commit',
      '--quiet',
      '-m',
      'conflicting second epoch source',
    );
    const secondRequest = {
      ...openRequest(sourceRoot),
      workspaceEpochId: conflictingEpochId,
      workspaceInstanceId: 'instance_66666666666666666666666666666666',
    } as const;

    await assert.rejects(
      service.createManagedWorkspaceFromSource(secondRequest),
      isWorkspaceError('managed_workspace_identity_conflict'),
    );
    assert.equal(
      await gitBare(first.repositoryPath, 'rev-parse', '--verify', conflictingHeadRef),
      first.baselineCommitOid,
    );
  });

  test('fails closed when a durable binding gains unknown or self-authenticating fields', async () => {
    const root = await temporaryRoot();
    const sourceRoot = await createEligibleSource(join(root, 'source'));
    const service = await serviceAt(join(root, 'storage'));
    const binding = await service.createManagedWorkspaceFromSource(openRequest(sourceRoot));
    const bindingPath = join(dirname(binding.worktreePath), 'binding.json');
    const corrupted = {
      ...JSON.parse(await readFile(bindingPath, 'utf8')),
      acceptedByCaller: true,
    };
    await writeFile(bindingPath, `${JSON.stringify(corrupted)}\n`, 'utf8');

    await assert.rejects(
      service.inspectManagedWorkspace(binding),
      isWorkspaceError('managed_workspace_identity_conflict'),
    );
  });
});

async function serviceAt(storageRoot: string): Promise<GitWorkspaceService> {
  return createGitWorkspaceService({
    storageRoot,
    gitRuntime: {
      executablePath: gitExecutablePath,
      expectedSha256: gitExecutableSha256,
    },
  });
}

async function onlyManagedRepositoryPath(storageRoot: string): Promise<string> {
  const repositoryRoots = await readdir(join(storageRoot, 'managed-workspaces', 'r'));
  assert.equal(repositoryRoots.length, 1);
  return join(storageRoot, 'managed-workspaces', 'r', repositoryRoots[0]!, 'repository.git');
}

function openRequest(sourceRoot: string) {
  return {
    repositoryId: 'repository_11111111111111111111111111111111',
    workspaceId: 'workspace_22222222222222222222222222222222',
    workspaceEpochId: 'epoch_33333333333333333333333333333333',
    workspaceInstanceId: 'instance_44444444444444444444444444444444',
    sourceRoot,
  } as const;
}

async function createEligibleSource(sourceRoot: string): Promise<string> {
  await mkdir(sourceRoot, { recursive: true });
  await git(sourceRoot, 'init', '--quiet');
  await writeFile(join(sourceRoot, 'tracked.txt'), 'tracked\n', 'utf8');
  await writeFile(join(sourceRoot, '.gitignore'), 'ignored.env\n.maka-workspace.json\n', 'utf8');
  await writeFile(join(sourceRoot, 'ignored.env'), 'SECRET=not-imported\n', 'utf8');
  await writeFile(join(sourceRoot, '.maka-workspace.json'), '{"host":"metadata"}\n', 'utf8');
  await git(sourceRoot, 'add', 'tracked.txt', '.gitignore');
  await git(
    sourceRoot,
    '-c',
    'user.name=Maka Test',
    '-c',
    'user.email=test@maka.invalid',
    'commit',
    '--quiet',
    '-m',
    'source baseline',
  );
  return realpath(sourceRoot);
}

interface SourceSnapshot {
  readonly root: string;
  readonly commonDir: string;
  readonly head: string;
  readonly tree: string;
  readonly branch: string;
  readonly status: string;
  readonly refs: string;
  readonly indexDigest: `sha256:${string}`;
  readonly trackedContents: string;
}

async function snapshotSource(sourceRoot: string): Promise<SourceSnapshot> {
  const commonDirRaw = await git(sourceRoot, 'rev-parse', '--git-common-dir');
  const commonDir = await realpath(join(sourceRoot, commonDirRaw));
  return {
    root: await realpath(sourceRoot),
    commonDir,
    head: await git(sourceRoot, 'rev-parse', 'HEAD'),
    tree: await git(sourceRoot, 'rev-parse', 'HEAD^{tree}'),
    branch: await git(sourceRoot, 'branch', '--show-current'),
    status: await git(sourceRoot, 'status', '--porcelain=v1', '--untracked-files=all'),
    refs: await git(sourceRoot, 'for-each-ref', '--format=%(refname) %(objectname)'),
    indexDigest: await sha256File(join(commonDir, 'index')),
    trackedContents: await readFile(join(sourceRoot, 'tracked.txt'), 'utf8'),
  };
}

async function assertSourceUnchanged(sourceRoot: string, before: SourceSnapshot): Promise<void> {
  const after = await snapshotSource(sourceRoot);
  assert.deepEqual(after, before);
}

function isWorkspaceError(code: string): (error: unknown) => boolean {
  return (error) => error instanceof GitWorkspaceServiceError && error.code === code;
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'maka-git-workspace-service-'));
  cleanup.push(root);
  return root;
}

async function findGitExecutable(): Promise<string> {
  const command = process.platform === 'win32' ? 'where.exe' : 'which';
  const { stdout } = await execFileAsync(command, ['git'], {
    encoding: 'utf8',
  });
  const first = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
  if (!first) throw new Error('Git executable is unavailable for integration tests');
  return realpath(first);
}

async function sha256File(path: string): Promise<`sha256:${string}`> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.trim();
}

async function gitBare(repositoryPath: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    'git',
    ['-c', 'core.longpaths=true', '--git-dir', repositoryPath, ...args],
    {
      cwd: dirname(repositoryPath),
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  return stdout.trim();
}

function waitForReady(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      cleanupListeners();
      reject(new Error(`Git workspace crash child did not become ready: ${stderr}`));
    }, timeoutMs);
    const onStdout = (chunk: unknown) => {
      stdout += String(chunk);
      if (stdout.includes('READY\n')) {
        cleanupListeners();
        resolve();
      }
    };
    const onStderr = (chunk: unknown) => {
      stderr += String(chunk);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanupListeners();
      reject(new Error(`Git workspace crash child exited early: ${code}/${signal} ${stderr}`));
    };
    const onError = (error: Error) => {
      cleanupListeners();
      reject(error);
    };
    const cleanupListeners = () => {
      clearTimeout(timeout);
      child.stdout?.off('data', onStdout);
      child.stderr?.off('data', onStderr);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    child.once('exit', () => resolve());
    child.once('error', reject);
  });
}
