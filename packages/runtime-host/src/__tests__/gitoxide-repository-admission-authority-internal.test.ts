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
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import {
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
  resolveRootControlNamespace,
  resolveRootOwnershipNamespace,
} from '@maka/storage/root-authority';
import { createGitoxideWorkspaceBaselineOwnerInternal } from '../server/gitoxide-workspace-baseline-owner-internal.js';
import {
  admitGitoxideHelperArtifactInternal,
  GitoxideHelperArtifactAuthorityError,
  type GitoxideHelperOperationInternal,
  type GitoxideHelperInvocationCapability,
  issueGitoxideHelperReleaseArtifactClaimInternal,
} from '../server/gitoxide-helper-artifact-authority-internal.js';
import {
  admitGitoxideRepositoryInternal,
  createGitoxideCandidateInternal,
  GitoxideRepositoryAdmissionAuthorityError,
  importAdmittedGitoxideRepositoryInternal,
  readGitoxideTreeFileInternal,
  requireGitoxideCandidateOutcomeForAcceptedRepositoryInternal,
  requireGitoxideRepositoryAdmissionInternal,
} from '../server/gitoxide-repository-admission-authority-internal.js';
import { GitoxideHelperInvocationError } from '../server/gitoxide-helper-invocation-internal.js';

interface AdmittedHelper {
  readonly invocationOwnerToken: object;
  readonly helperCapability: GitoxideHelperInvocationCapability;
  readonly helperArtifactSha256: `sha256:${string}`;
}

let admittedHelperPromise: Promise<AdmittedHelper | undefined> | undefined;

for (const mode of [
  'runtime-crash-write',
  'runtime-crash-noop',
  'runtime-crash-rejection',
  'runtime-live-write',
  'runtime-live-noop',
  'runtime-live-rejection',
]) {
  test(`Runtime mutation preserves its owner outcome across publication/reopen: ${mode}`, {
    timeout: 30_000,
  }, async (t) => {
    if (!(await admittedHelper())) {
      t.skip('MAKA_GITOXIDE_HELPER_PATH is required');
      return;
    }
    const source = await createRepository(t, 'sha1');
    await writeFile(join(source, 'hello.txt'), 'accepted original\n');
    git(source, ['add', '.']);
    git(source, [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-qm',
      'base',
    ]);
    const stateRoot = await mkdtemp(join(tmpdir(), 'maka-runtime-mutation-'));
    const root = await resolveStorageRoot({ path: stateRoot, kind: 'interactive' });
    const child = fileURLToPath(
      new URL('./fixtures/gitoxide-file-execution-child.js', import.meta.url),
    );
    const run = (mode: string) => {
      const result = spawnSync(process.execPath, [child, mode, stateRoot, source], {
        encoding: 'utf8',
        timeout: 20_000,
        windowsHide: true,
      });
      assert.ifError(result.error);
      return result;
    };
    try {
      const first = run(mode);
      assert.equal(first.status, mode.includes('crash') ? 81 : 0, first.stderr);
      const state = run('read-settlement');
      assert.equal(state.status, 0, state.stderr);
      const durable = JSON.parse(state.stdout);
      assert.equal(durable.outcomes.length, 1);
      assert.equal(durable.successors.length, mode.endsWith('write') ? 1 : 0);
      assert.deepEqual(durable.unsettled, []);
      assert.ok(durable.outcomes[0].content.modelProjection);
      assert.equal(
        durable.outcomes[0].content.isError,
        mode.endsWith('rejection') ? true : undefined,
      );
      if (!mode.endsWith('write'))
        assert.equal(
          durable.outcomes[0].actions.managedMutationTerminal.terminalKind,
          mode.endsWith('noop') ? 'no_workspace_change' : 'operation_failed_no_effect',
        );
      if (mode.includes('live'))
        assert.deepEqual(JSON.parse(first.stdout).published, durable.outcomes[0].content.result);
      const reopened = run('reopen');
      assert.equal(reopened.status, 0, reopened.stderr);
      assert.equal(
        JSON.parse(reopened.stdout).content,
        mode.endsWith('write') ? 'runtime result\n' : 'accepted original\n',
      );
      assert.deepEqual(JSON.parse(run('read-settlement').stdout), durable);
      assert.equal(await readFile(join(source, 'hello.txt'), 'utf8'), 'accepted original\n');
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
      await rm(join(resolveRootControlNamespace(), root.rootId), { recursive: true, force: true });
      await rm(join(resolveRootOwnershipNamespace(), root.rootId + '.lock'), { force: true });
    }
  });
}

for (const mode of [
  'settle-wrong-content',
  'settle-false-no-change',
  'crash-after-settlement',
  'crash-after-new-file',
  'settle-no-change',
  'crash-after-no-change',
  'crash-after-edit-rejection',
  'settle-false-rejection',
]) {
  test(`candidate settlement preserves durable truth: ${mode}`, { timeout: 30_000 }, async (t) => {
    if (!(await admittedHelper())) {
      t.skip('MAKA_GITOXIDE_HELPER_PATH is required');
      return;
    }
    const source = await createRepository(t, 'sha1');
    await writeFile(join(source, 'hello.txt'), 'accepted original\n');
    git(source, ['add', 'hello.txt']);
    git(source, [
      '-c',
      'user.name=Maka Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-qm',
      'fixture',
    ]);
    const stateRoot = await mkdtemp(join(tmpdir(), 'maka-gitoxide-terminal-'));
    const root = await resolveStorageRoot({ path: stateRoot, kind: 'interactive' });
    const child = fileURLToPath(
      new URL('./fixtures/gitoxide-file-execution-child.js', import.meta.url),
    );
    const run = (action: string) => {
      const result = spawnSync(process.execPath, [child, action, stateRoot, source], {
        encoding: 'utf8',
        timeout: 20_000,
        windowsHide: true,
      });
      assert.ifError(result.error);
      return result;
    };
    try {
      const first = run(mode);
      assert.equal(first.status, mode.startsWith('crash-') ? 79 : 0, first.stderr);
      const reopened = run('read-settlement');
      assert.equal(reopened.status, 0, reopened.stderr);
      const state = JSON.parse(reopened.stdout);
      if (
        mode === 'settle-wrong-content' ||
        mode === 'settle-false-no-change' ||
        mode === 'settle-false-rejection'
      ) {
        assert.equal(state.outcomes.length, 0);
        assert.equal(state.successors.length, 0);
        assert.equal(state.unsettled.length, 1);
      } else if (mode === 'crash-after-edit-rejection') {
        assert.equal(
          gitBare(join(stateRoot, 'repository.git'), [
            'for-each-ref',
            '--format=%(refname)',
            'refs/maka/candidates',
          ]),
          '',
        );
        assert.equal(state.outcomes.length, 1);
        assert.equal(state.successors.length, 0);
        assert.deepEqual(state.unsettled, []);
        assert.equal(state.outcomes[0].content.isError, true);
        assert.equal(
          state.outcomes[0].actions.managedMutationTerminal.terminalKind,
          'operation_failed_no_effect',
        );
        assert.deepEqual(state.outcomes[0].content.result, {
          kind: 'text',
          text: "old_string not found in hello.txt; it must match the file's text including whitespace and indentation",
        });
        const reopened = run('reopen');
        assert.equal(reopened.status, 0, reopened.stderr);
        assert.equal(JSON.parse(reopened.stdout).content, 'accepted original\n');
      } else if (mode.endsWith('no-change')) {
        const committed = JSON.parse(first.stdout);
        assert.equal(state.outcomes.length, 1);
        assert.equal(state.successors.length, 0);
        assert.deepEqual(state.unsettled, []);
        assert.equal(state.outcomes[0].content.isError, undefined);
        assert.equal(
          state.outcomes[0].actions.managedMutationTerminal.terminalKind,
          'no_workspace_change',
        );
        assert.equal(committed.accepted.created, true);
        if (mode === 'settle-no-change') assert.equal(committed.retry.created, false);
        const reopened = run('reopen');
        assert.equal(reopened.status, 0, reopened.stderr);
        assert.equal(JSON.parse(reopened.stdout).commit, committed.proof.baseCommitOid);
        assert.equal(JSON.parse(reopened.stdout).content, 'accepted original\n');
      } else {
        const committed = JSON.parse(first.stdout);
        assert.equal(state.outcomes.length, 1);
        assert.equal(state.successors.length, 1);
        assert.deepEqual(state.unsettled, []);
        assert.equal(
          state.successors[0].actions.workspaceFact.payload.commitOid,
          committed.proof.candidateCommitOid,
        );
        assert.equal(state.outcomes[0].content.isError, undefined);
        const expectedPath = mode === 'crash-after-new-file' ? 'new/nested.txt' : 'hello.txt';
        assert.deepEqual(state.successors[0].actions.workspaceFact.payload.changedPaths, [
          expectedPath,
        ]);
        assert.equal(
          gitBare(join(stateRoot, 'repository.git'), [
            'show',
            `${committed.proof.candidateCommitOid}:${expectedPath}`,
          ]),
          'candidate result',
        );
        assert.equal(
          gitBare(join(stateRoot, 'repository.git'), ['rev-parse', 'refs/maka/accepted']),
          committed.proof.baseCommitOid,
        );
        // A fresh process derives repair authority from SQLite, never from the ref.
        if (mode === 'crash-after-settlement') {
          const refPath = join(stateRoot, 'repository.git', 'refs', 'maka', 'accepted');
          const previousBytes = await readFile(refPath);
          await writeFile(refPath, `${'0'.repeat(40)}\n`);
          const unknown = run('reopen');
          assert.equal(unknown.status, 1);
          assert.equal(await readFile(refPath, 'utf8'), `${'0'.repeat(40)}\n`);
          await writeFile(refPath, 'ref: refs/maka/other\n');
          const symbolic = run('reopen');
          assert.equal(symbolic.status, 1);
          assert.match(symbolic.stderr, /accepted_ref_not_direct/);
          assert.equal(await readFile(refPath, 'utf8'), 'ref: refs/maka/other\n');
          await writeFile(refPath, previousBytes);
          const blobOid = committed.proof.resultBlobOid;
          const blobPath = join(
            stateRoot,
            'repository.git',
            'objects',
            blobOid.slice(0, 2),
            blobOid.slice(2),
          );
          const blobBytes = await readFile(blobPath);
          await rm(blobPath);
          const missing = run('reopen');
          assert.equal(missing.status, 1);
          assert.deepEqual(await readFile(refPath), previousBytes);
          await writeFile(blobPath, blobBytes);
          const repairedCrash = run('crash-after-reopen');
          assert.equal(repairedCrash.status, 80, repairedCrash.stderr);
        }
        const stale = run('reopen');
        assert.equal(stale.status, 0, stale.stderr);
        assert.equal(JSON.parse(stale.stdout).commit, committed.proof.candidateCommitOid);
        assert.equal(
          gitBare(join(stateRoot, 'repository.git'), ['rev-parse', 'refs/maka/accepted']),
          committed.proof.candidateCommitOid,
        );
        const again = run('reopen');
        assert.equal(again.status, 0, again.stderr);
        assert.deepEqual(JSON.parse(again.stdout), JSON.parse(stale.stdout));
        const afterRepair = run('read-settlement');
        assert.equal(afterRepair.status, 0, afterRepair.stderr);
        assert.deepEqual(JSON.parse(afterRepair.stdout), state);
      }
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
      await rm(join(resolveRootControlNamespace(), root.rootId), { recursive: true, force: true });
      await rm(join(resolveRootOwnershipNamespace(), root.rootId + '.lock'), { force: true });
    }
  });
}

for (const mode of ['settle-candidate', 'settle-new-file']) {
  test(`accepts a real candidate with T2 exactly once through the execution group: ${mode}`, {
    timeout: 30_000,
  }, async (t) => {
    if (!(await admittedHelper())) {
      t.skip('MAKA_GITOXIDE_HELPER_PATH is required');
      return;
    }
    const source = await createRepository(t, 'sha1');
    await writeFile(join(source, 'hello.txt'), 'accepted original\n');
    git(source, ['add', 'hello.txt']);
    git(source, [
      '-c',
      'user.name=Maka Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-qm',
      'fixture',
    ]);
    const stateRoot = await mkdtemp(join(tmpdir(), 'maka-gitoxide-settlement-'));
    const root = await resolveStorageRoot({ path: stateRoot, kind: 'interactive' });
    try {
      const child = fileURLToPath(
        new URL('./fixtures/gitoxide-file-execution-child.js', import.meta.url),
      );
      const result = spawnSync(process.execPath, [child, mode, stateRoot, source], {
        encoding: 'utf8',
        timeout: 20_000,
        windowsHide: true,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      const outcome = JSON.parse(result.stdout);
      assert.equal(outcome.accepted.created, true);
      assert.equal(outcome.retry.created, false);
      assert.deepEqual(outcome.accepted.committedSuccessor, outcome.retry.committedSuccessor);
      assert.equal(outcome.accepted.committedSuccessor.commitOid, outcome.proof.candidateCommitOid);
      assert.deepEqual(outcome.unsettled, []);
      assert.equal(
        gitBare(join(stateRoot, 'repository.git'), [
          'show',
          `${outcome.proof.candidateCommitOid}:${outcome.proof.path}`,
        ]),
        'candidate result',
      );
      assert.equal(
        gitBare(join(stateRoot, 'repository.git'), ['rev-parse', 'refs/maka/accepted']),
        outcome.proof.baseCommitOid,
      );
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
      await rm(join(resolveRootControlNamespace(), root.rootId), { recursive: true, force: true });
      await rm(join(resolveRootOwnershipNamespace(), root.rootId + '.lock'), { force: true });
    }
  });
}

test('revalidates a published candidate after process exit without advancing accepted truth', {
  timeout: 60_000,
}, async (t) => {
  if (!(await admittedHelper())) {
    t.skip('MAKA_GITOXIDE_HELPER_PATH is required');
    return;
  }
  const source = await createRepository(t, 'sha1');
  await writeFile(join(source, 'hello.txt'), 'accepted original\n');
  git(source, ['add', 'hello.txt']);
  git(source, [
    '-c',
    'user.name=Maka Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-qm',
    'fixture',
  ]);
  const stateRoot = await mkdtemp(join(tmpdir(), 'maka-gitoxide-candidate-crash-'));
  const root = await resolveStorageRoot({ path: stateRoot, kind: 'interactive' });
  const child = fileURLToPath(
    new URL('./fixtures/gitoxide-file-execution-child.js', import.meta.url),
  );
  const run = (mode: string) => {
    const result = spawnSync(process.execPath, [child, mode, stateRoot, source], {
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
    });
    assert.ifError(result.error);
    return result;
  };
  try {
    const baseline = run('crash-after-baseline');
    assert.equal(baseline.status, 77, baseline.stderr);
    const initial = run('reopen');
    assert.equal(initial.status, 0, initial.stderr);
    const crashed = run('crash-after-candidate');
    assert.equal(crashed.status, 78, crashed.stderr);
    const first = JSON.parse(crashed.stdout);
    assert.equal(first.proof.disposition, 'published');
    assert.equal(first.acceptedContent, 'accepted original\n');
    assert.notEqual(first.proof.candidateCommitOid, first.proof.baseCommitOid);
    const retried = run('retry-candidate');
    assert.equal(retried.status, 0, retried.stderr);
    assert.deepEqual(JSON.parse(retried.stdout), first);
    const conflict = run('conflicting-candidate');
    assert.equal(conflict.status, 1);
    assert.match(conflict.stderr, /candidate_request_conflict/u);
    const after = run('reopen');
    assert.equal(after.status, 0, after.stderr);
    assert.deepEqual(JSON.parse(after.stdout), JSON.parse(initial.stdout));
    assert.equal(
      gitBare(join(stateRoot, 'repository.git'), [
        'show',
        `${first.proof.candidateCommitOid}:hello.txt`,
      ]),
      'candidate result',
    );
    assert.equal(
      gitBare(join(stateRoot, 'repository.git'), ['rev-parse', first.proof.candidateRef]),
      first.proof.candidateCommitOid,
    );
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
    await rm(join(resolveRootControlNamespace(), root.rootId), { recursive: true, force: true });
    await rm(join(resolveRootOwnershipNamespace(), root.rootId + '.lock'), { force: true });
  }
});

test('reopens durable baseline in a fresh process after the importing owner exits without cleanup', {
  timeout: 45_000,
}, async (t) => {
  if (!(await admittedHelper())) {
    t.skip('MAKA_GITOXIDE_HELPER_PATH is required');
    return;
  }
  const source = await createRepository(t, 'sha1');
  await writeFile(join(source, 'hello.txt'), 'survives owner exit\n');
  git(source, ['add', 'hello.txt']);
  git(source, [
    '-c',
    'user.name=Maka Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-qm',
    'fixture',
  ]);
  const stateRoot = await mkdtemp(join(tmpdir(), 'maka-gitoxide-reopen-crash-'));
  const root = await resolveStorageRoot({ path: stateRoot, kind: 'interactive' });
  const child = fileURLToPath(
    new URL('./fixtures/gitoxide-file-execution-child.js', import.meta.url),
  );
  const run = (mode: string) =>
    spawnSync(process.execPath, [child, mode, stateRoot, source], {
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
    });
  try {
    const crashed = run('crash-after-baseline');
    assert.ifError(crashed.error);
    assert.equal(crashed.status, 77, crashed.stderr);
    const reopened = run('reopen');
    assert.ifError(reopened.error);
    assert.equal(reopened.status, 0, reopened.stderr);
    const result = JSON.parse(reopened.stdout);
    assert.equal(result.content, 'survives owner exit\n');
    assert.equal(
      result.commit,
      gitBare(join(stateRoot, 'repository.git'), ['rev-parse', 'refs/maka/accepted']),
    );
    const again = run('reopen');
    assert.equal(again.status, 0, again.stderr);
    assert.deepEqual(JSON.parse(again.stdout), result);
    const acceptedRefPath = join(stateRoot, 'repository.git', 'refs', 'maka', 'accepted');
    await writeFile(acceptedRefPath, 'ref: refs/heads/attacker\n');
    const symbolic = run('reopen');
    assert.equal(symbolic.status, 1);
    assert.match(symbolic.stderr, /accepted_ref_not_direct/u);
    await writeFile(acceptedRefPath, `${result.commit}\n`);
    const blob = gitBare(join(stateRoot, 'repository.git'), [
      'rev-parse',
      'refs/maka/accepted:hello.txt',
    ]);
    await rm(join(stateRoot, 'repository.git', 'objects', blob.slice(0, 2), blob.slice(2)));
    const missingBlob = run('reopen');
    assert.equal(missingBlob.status, 1);
    assert.match(missingBlob.stderr, /source_blob_unavailable/u);
    assert.equal((await readFile(acceptedRefPath, 'utf8')).trim(), result.commit);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
    await rm(join(resolveRootControlNamespace(), root.rootId), { recursive: true, force: true });
    await rm(join(resolveRootOwnershipNamespace(), root.rootId + '.lock'), { force: true });
  }
});

test('commits a real imported Gitoxide baseline through the root-owned execution group', async (t) => {
  const helper = await admittedHelper();
  if (!helper) {
    t.skip('MAKA_GITOXIDE_HELPER_PATH is required');
    return;
  }
  const source = await createRepository(t, 'sha1');
  await writeFile(join(source, 'hello.txt'), 'immutable source\n');
  git(source, ['add', 'hello.txt']);
  git(source, [
    '-c',
    'user.name=Maka Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-qm',
    'fixture',
  ]);
  const stateRoot = await mkdtemp(join(tmpdir(), 'maka-gitoxide-baseline-store-'));
  const root = await resolveStorageRoot({ path: stateRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(root);
  assert.ok(rootOwner);
  let stores = await openInteractiveExecutionStoresForWrite(rootOwner.lease);
  try {
    const admissionOwnerToken = {};
    const admission = await admitGitoxideRepositoryInternal({
      ...helper,
      admissionOwnerToken,
      repositoryPath: source,
    });
    assert.equal(admission.kind, 'accepted');
    if (admission.kind !== 'accepted') return;
    const acceptedRepositoryOwnerToken = {};
    const imported = await importAdmittedGitoxideRepositoryInternal({
      admissionOwnerToken,
      repositoryCapability: admission.capability,
      acceptedRepositoryOwnerToken,
      destinationRepositoryPath: join(stateRoot, 'repository.git'),
    });
    const owner = createGitoxideWorkspaceBaselineOwnerInternal(stores);
    const input = {
      workspaceKey: 'session-baseline',
      acceptedRepositoryOwnerToken,
      acceptedRepositoryCapability: imported.acceptedRepositoryCapability,
    };
    assert.equal(createGitoxideWorkspaceBaselineOwnerInternal(stores), owner);
    await assert.rejects(
      owner.acceptImport({ ...input, acceptedRepositoryOwnerToken: {} }),
      GitoxideRepositoryAdmissionAuthorityError,
    );
    await assert.rejects(
      owner.acceptImport({
        ...input,
        acceptedRepositoryCapability: { kind: 'gitoxide_accepted_repository_capability_v1' },
      }),
      GitoxideRepositoryAdmissionAuthorityError,
    );
    const accepted = await owner.acceptImport(input);
    assert.equal(accepted.created, true);
    assert.equal(accepted.head.commitOid, imported.baselineCommitOid);
    assert.equal(accepted.head.treeOid, imported.baselineTreeOid);
    assert.equal((await owner.acceptImport(input)).created, false);
    await stores.sessionStore.close!();
    await assert.rejects(owner.acceptImport(input));
    stores = await openInteractiveExecutionStoresForWrite(rootOwner.lease);
    const reopened = createGitoxideWorkspaceBaselineOwnerInternal(stores);
    // Fresh import must remain strict; reopen is a separate read-only operation.
    await assert.rejects(
      importAdmittedGitoxideRepositoryInternal({
        admissionOwnerToken,
        repositoryCapability: admission.capability,
        acceptedRepositoryOwnerToken,
        destinationRepositoryPath: join(stateRoot, 'repository.git'),
      }),
      (error) =>
        error instanceof GitoxideHelperInvocationError &&
        error.helperReason === 'import_destination_not_fresh',
    );
    const freshOwnerToken = {};
    const reopenedCapability = await reopened.reopen({
      workspaceKey: input.workspaceKey,
      repositoryPath: join(stateRoot, 'repository.git'),
      ...helper,
      acceptedRepositoryOwnerToken: freshOwnerToken,
    });
    assert.equal(
      (
        await readGitoxideTreeFileInternal({
          acceptedRepositoryOwnerToken: freshOwnerToken,
          acceptedRepositoryCapability: reopenedCapability,
          path: 'hello.txt',
        })
      ).content,
      'immutable source\n',
    );
    await assert.rejects(
      reopened.acceptImport({
        ...input,
        acceptedRepositoryOwnerToken: freshOwnerToken,
        acceptedRepositoryCapability: reopenedCapability,
      }),
      GitoxideRepositoryAdmissionAuthorityError,
    );
    const retried = await reopened.acceptImport(input);
    assert.equal(retried.created, false);
    assert.deepEqual(retried.head, accepted.head);

    // A new source observation cannot silently replace the same workspace epoch.
    await writeFile(join(source, 'hello.txt'), 'source advanced\n');
    git(source, ['add', 'hello.txt']);
    git(source, [
      '-c',
      'user.name=Maka Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-qm',
      'advance',
    ]);
    const advanced = await admitGitoxideRepositoryInternal({
      ...helper,
      admissionOwnerToken,
      repositoryPath: source,
    });
    assert.equal(advanced.kind, 'accepted');
    if (advanced.kind !== 'accepted') return;
    const advancedImport = await importAdmittedGitoxideRepositoryInternal({
      admissionOwnerToken,
      repositoryCapability: advanced.capability,
      acceptedRepositoryOwnerToken,
      destinationRepositoryPath: join(stateRoot, 'advanced.git'),
    });
    await assert.rejects(
      reopened.acceptImport({
        ...input,
        acceptedRepositoryCapability: advancedImport.acceptedRepositoryCapability,
      }),
    );
    assert.deepEqual((await reopened.acceptImport(input)).head, accepted.head);
  } finally {
    await stores.sessionStore.close?.();
    await rootOwner.close();
    await rm(stateRoot, { recursive: true, force: true });
    await rm(join(resolveRootControlNamespace(), root.rootId), { recursive: true, force: true });
    await rm(join(resolveRootOwnershipNamespace(), root.rootId + '.lock'), { force: true });
  }
});

test('applies admission cancellation before repository path preflight', async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    admitGitoxideRepositoryInternal({
      invocationOwnerToken: {},
      helperCapability: {} as GitoxideHelperInvocationCapability,
      admissionOwnerToken: {},
      repositoryPath: join(tmpdir(), 'missing-gitoxide-admission-repository'),
      abortSignal: controller.signal,
    }),
    (error) =>
      error instanceof GitoxideHelperInvocationError &&
      error.code === 'gitoxide_helper_invocation_aborted',
  );
});

test('issues an opaque owner-bound admission capability from the exact helper observation', async (t) => {
  const helper = await admittedHelper();
  if (!helper) {
    t.skip('MAKA_GITOXIDE_HELPER_PATH is required for the real helper contract test');
    return;
  }
  const repositoryPath = await createRepository(t, 'sha1');
  await writeFile(join(repositoryPath, 'hello.txt'), 'hello from admission authority\n');
  git(repositoryPath, ['add', 'hello.txt']);
  git(repositoryPath, [
    '-c',
    'user.name=Maka Test',
    '-c',
    'user.email=maka@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  ]);
  const expectedCommit = git(repositoryPath, ['rev-parse', 'HEAD']);
  const expectedTree = git(repositoryPath, ['rev-parse', 'HEAD^{tree}']);
  const admissionOwnerToken = {};

  const result = await admitGitoxideRepositoryInternal({
    ...helper,
    admissionOwnerToken,
    repositoryPath,
  });

  assert.equal(result.kind, 'accepted');
  if (result.kind !== 'accepted') return;
  assert.deepEqual(result.capability, { kind: 'gitoxide_repository_admission_capability_v1' });
  assert.throws(
    () => requireGitoxideRepositoryAdmissionInternal({}, result.capability),
    (error) =>
      error instanceof GitoxideRepositoryAdmissionAuthorityError &&
      error.code === 'gitoxide_repository_admission_capability_invalid',
  );
  assert.deepEqual(
    requireGitoxideRepositoryAdmissionInternal(admissionOwnerToken, result.capability),
    {
      protocolVersion: 1,
      repositoryPath,
      objectFormat: 'sha1',
      headCommitOid: expectedCommit,
      headTreeOid: expectedTree,
      helperArtifactSha256: helper.helperArtifactSha256,
      managedTreePolicyVersion: 3,
    },
  );
});

test('returns a policy rejection without issuing an admission capability', async (t) => {
  const helper = await admittedHelper();
  if (!helper) {
    t.skip('MAKA_GITOXIDE_HELPER_PATH is required for the real helper contract test');
    return;
  }
  const repositoryPath = await createRepository(t, 'sha256');

  assert.deepEqual(
    await admitGitoxideRepositoryInternal({
      ...helper,
      admissionOwnerToken: {},
      repositoryPath,
    }),
    {
      kind: 'repository_rejected',
      protocolVersion: 1,
      reason: 'unsupported_object_format',
      objectFormat: 'sha256',
      supportedObjectFormats: ['sha1'],
    },
  );
});

test('imports only the exact repository identity bound to the admission capability', async (t) => {
  const helper = await admittedHelper();
  if (!helper) {
    t.skip('MAKA_GITOXIDE_HELPER_PATH is required for the real helper contract test');
    return;
  }
  const repositoryPath = await createRepository(t, 'sha1');
  await writeFile(join(repositoryPath, 'hello.txt'), 'hello from source import authority\n');
  git(repositoryPath, ['add', 'hello.txt']);
  git(repositoryPath, [
    '-c',
    'user.name=Maka Test',
    '-c',
    'user.email=maka@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  ]);
  const expectedCommit = git(repositoryPath, ['rev-parse', 'HEAD']);
  const expectedTree = git(repositoryPath, ['rev-parse', 'HEAD^{tree}']);
  const admissionOwnerToken = {};
  const admitted = await admitGitoxideRepositoryInternal({
    ...helper,
    admissionOwnerToken,
    repositoryPath,
  });
  assert.equal(admitted.kind, 'accepted');
  if (admitted.kind !== 'accepted') return;
  const destinationRepositoryPath = join(repositoryPath, 'managed.git');
  const acceptedRepositoryOwnerToken = {};

  const imported = await importAdmittedGitoxideRepositoryInternal({
    admissionOwnerToken,
    repositoryCapability: admitted.capability,
    acceptedRepositoryOwnerToken,
    destinationRepositoryPath,
  });

  assert.equal(imported.sourceHeadCommitOid, expectedCommit);
  assert.equal(imported.sourceTreeOid, expectedTree);
  assert.equal(imported.baselineTreeOid, expectedTree);
  assert.equal(
    gitBare(destinationRepositoryPath, ['rev-parse', 'refs/maka/accepted']),
    imported.baselineCommitOid,
  );
  await assert.rejects(
    importAdmittedGitoxideRepositoryInternal({
      admissionOwnerToken: {},
      repositoryCapability: admitted.capability,
      acceptedRepositoryOwnerToken,
      destinationRepositoryPath: join(repositoryPath, 'forged.git'),
    }),
    (error) =>
      error instanceof GitoxideRepositoryAdmissionAuthorityError &&
      error.code === 'gitoxide_repository_admission_capability_invalid',
  );
});

test('rejects a helper without candidate/read attestation before claiming the import destination', async (t) => {
  const helper = await admittedHelperWithOperations(['inspect_repository', 'import_source_head']);
  if (!helper) {
    t.skip('MAKA_GITOXIDE_HELPER_PATH is required for the real helper contract test');
    return;
  }
  const repositoryPath = await createRepository(t, 'sha1');
  await writeFile(join(repositoryPath, 'hello.txt'), 'feature attestation\n');
  git(repositoryPath, ['add', 'hello.txt']);
  git(repositoryPath, [
    '-c',
    'user.name=Maka Test',
    '-c',
    'user.email=maka@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  ]);
  const admissionOwnerToken = {};
  const admitted = await admitGitoxideRepositoryInternal({
    ...helper,
    admissionOwnerToken,
    repositoryPath,
  });
  assert.equal(admitted.kind, 'accepted');
  if (admitted.kind !== 'accepted') return;
  const destinationRepositoryPath = join(repositoryPath, 'must-not-be-claimed.git');

  await assert.rejects(
    importAdmittedGitoxideRepositoryInternal({
      admissionOwnerToken,
      repositoryCapability: admitted.capability,
      acceptedRepositoryOwnerToken: {},
      destinationRepositoryPath,
    }),
    (error) =>
      error instanceof GitoxideHelperArtifactAuthorityError &&
      error.code === 'gitoxide_helper_release_claim_unsupported',
  );
  await assert.rejects(stat(destinationRepositoryPath), { code: 'ENOENT' });
});

test('publishes an operation-bound candidate without advancing accepted authority', async (t) => {
  const helper = await admittedHelper();
  if (!helper) {
    t.skip('MAKA_GITOXIDE_HELPER_PATH is required for the real helper contract test');
    return;
  }
  const repositoryPath = await createRepository(t, 'sha1');
  await writeFile(join(repositoryPath, 'hello.txt'), 'hello from candidate authority\n');
  git(repositoryPath, ['add', 'hello.txt']);
  git(repositoryPath, [
    '-c',
    'user.name=Maka Test',
    '-c',
    'user.email=maka@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  ]);
  const admissionOwnerToken = {};
  const acceptedRepositoryOwnerToken = {};
  const admitted = await admitGitoxideRepositoryInternal({
    ...helper,
    admissionOwnerToken,
    repositoryPath,
  });
  assert.equal(admitted.kind, 'accepted');
  if (admitted.kind !== 'accepted') return;
  const destinationRepositoryPath = join(repositoryPath, 'managed.git');
  const imported = await importAdmittedGitoxideRepositoryInternal({
    admissionOwnerToken,
    repositoryCapability: admitted.capability,
    acceptedRepositoryOwnerToken,
    destinationRepositoryPath,
  });

  const candidateOwnerToken = {};
  const candidate = await createGitoxideCandidateInternal({
    acceptedRepositoryOwnerToken,
    acceptedRepositoryCapability: imported.acceptedRepositoryCapability,
    candidateOwnerToken,
    operationId: 'operation-1',
    path: 'docs/result.txt',
    content: 'candidate result\n',
  });
  assert.equal(candidate.kind, 'candidate_published');
  if (candidate.kind !== 'candidate_published') return;

  assert.equal(candidate.baseCommitOid, imported.baselineCommitOid);
  assert.equal(candidate.baseTreeOid, imported.baselineTreeOid);
  assert.equal(
    candidate.candidateRef,
    `refs/maka/candidates/${createHash('sha256').update('operation-1').digest('hex')}`,
  );
  assert.equal(
    gitBare(destinationRepositoryPath, ['rev-parse', 'refs/maka/accepted']),
    imported.baselineCommitOid,
  );
  assert.equal(
    gitBare(destinationRepositoryPath, ['rev-parse', candidate.candidateRef]),
    candidate.candidateCommitOid,
  );
  assert.deepEqual(candidate.candidateOutcomeCapability, {
    kind: 'gitoxide_candidate_outcome_capability_v1',
  });
  const candidateProof = requireGitoxideCandidateOutcomeForAcceptedRepositoryInternal({
    acceptedRepositoryOwnerToken,
    acceptedRepositoryCapability: imported.acceptedRepositoryCapability,
    candidateOwnerToken,
    candidateOutcomeCapability: candidate.candidateOutcomeCapability,
  });
  assert.equal(candidateProof.operationId, 'operation-1');
  assert.equal(candidateProof.acceptedRef, 'refs/maka/accepted');
  assert.equal(candidateProof.objectFormat, 'sha1');
  assert.equal(candidateProof.managedTreePolicyVersion, 3);
  assert.match(candidateProof.helperArtifactSha256, /^sha256:[0-9a-f]{64}$/);
  assert.match(candidateProof.requestDigestSha256, /^[0-9a-f]{64}$/);
  assert.equal(
    candidateProof.resultContentSha256,
    `sha256:${createHash('sha256').update('candidate result\n').digest('hex')}`,
  );
  assert.throws(
    () =>
      requireGitoxideCandidateOutcomeForAcceptedRepositoryInternal({
        acceptedRepositoryOwnerToken,
        acceptedRepositoryCapability: imported.acceptedRepositoryCapability,
        candidateOwnerToken: {},
        candidateOutcomeCapability: candidate.candidateOutcomeCapability,
      }),
    GitoxideRepositoryAdmissionAuthorityError,
  );

  const secondAcceptedRepositoryOwnerToken = {};
  const sameContentOtherRepository = await importAdmittedGitoxideRepositoryInternal({
    admissionOwnerToken,
    repositoryCapability: admitted.capability,
    acceptedRepositoryOwnerToken: secondAcceptedRepositoryOwnerToken,
    destinationRepositoryPath: join(repositoryPath, 'managed-other.git'),
  });
  assert.throws(
    () =>
      requireGitoxideCandidateOutcomeForAcceptedRepositoryInternal({
        acceptedRepositoryOwnerToken: secondAcceptedRepositoryOwnerToken,
        acceptedRepositoryCapability: sameContentOtherRepository.acceptedRepositoryCapability,
        candidateOwnerToken,
        candidateOutcomeCapability: candidate.candidateOutcomeCapability,
      }),
    GitoxideRepositoryAdmissionAuthorityError,
  );

  const acceptedRead = await readGitoxideTreeFileInternal({
    acceptedRepositoryOwnerToken,
    acceptedRepositoryCapability: imported.acceptedRepositoryCapability,
    path: 'hello.txt',
  });
  assert.equal(acceptedRead.content, 'hello from candidate authority\n');

  const noChangeOperationId = 'operation-no-change';
  const noChange = await createGitoxideCandidateInternal({
    acceptedRepositoryOwnerToken,
    acceptedRepositoryCapability: imported.acceptedRepositoryCapability,
    candidateOwnerToken,
    operationId: noChangeOperationId,
    path: 'hello.txt',
    content: 'hello from candidate authority\n',
  });
  assert.equal(noChange.kind, 'candidate_no_change');
  assert.equal(
    gitBare(destinationRepositoryPath, ['rev-parse', noChange.candidateRef]),
    noChange.candidateCommitOid,
  );
  assert.equal(noChange.candidateTreeOid, imported.baselineTreeOid);
  assert.equal(
    requireGitoxideCandidateOutcomeForAcceptedRepositoryInternal({
      acceptedRepositoryOwnerToken,
      acceptedRepositoryCapability: imported.acceptedRepositoryCapability,
      candidateOwnerToken,
      candidateOutcomeCapability: noChange.candidateOutcomeCapability,
    }).disposition,
    'no_change',
  );

  const exactRetry = await createGitoxideCandidateInternal({
    acceptedRepositoryOwnerToken,
    acceptedRepositoryCapability: imported.acceptedRepositoryCapability,
    candidateOwnerToken,
    operationId: 'operation-1',
    path: 'docs/result.txt',
    content: 'candidate result\n',
  });
  assert.equal(exactRetry.kind, 'candidate_published');
  if (exactRetry.kind !== 'candidate_published') return;
  assert.equal(exactRetry.candidateCommitOid, candidate.candidateCommitOid);
  assert.equal(exactRetry.candidateTreeOid, candidate.candidateTreeOid);

  const second = await createGitoxideCandidateInternal({
    acceptedRepositoryOwnerToken,
    acceptedRepositoryCapability: imported.acceptedRepositoryCapability,
    candidateOwnerToken,
    operationId: 'operation-2',
    path: 'docs/next.txt',
    content: 'next candidate\n',
  });
  assert.equal(second.kind, 'candidate_published');
  if (second.kind !== 'candidate_published') return;
  assert.equal(second.baseCommitOid, imported.baselineCommitOid);
  assert.notEqual(second.candidateRef, candidate.candidateRef);
  await assert.rejects(
    createGitoxideCandidateInternal({
      acceptedRepositoryOwnerToken: {},
      acceptedRepositoryCapability: imported.acceptedRepositoryCapability,
      candidateOwnerToken,
      operationId: 'forged-operation',
      path: 'forged.txt',
      content: 'forged\n',
    }),
    (error) =>
      error instanceof GitoxideRepositoryAdmissionAuthorityError &&
      error.code === 'gitoxide_repository_admission_capability_invalid',
  );
});

test('reads an immutable accepted-tree file without consulting the projection filesystem', async (t) => {
  const helper = await admittedHelper();
  if (!helper) {
    t.skip('MAKA_GITOXIDE_HELPER_PATH is required for the real helper contract test');
    return;
  }
  const repositoryPath = await createRepository(t, 'sha1');
  await writeFile(join(repositoryPath, 'package.json'), '{"name":"fixture","private":true}\n');
  git(repositoryPath, ['add', 'package.json']);
  git(repositoryPath, [
    '-c',
    'user.name=Maka Test',
    '-c',
    'user.email=maka@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  ]);
  const admissionOwnerToken = {};
  const acceptedRepositoryOwnerToken = {};
  const admitted = await admitGitoxideRepositoryInternal({
    ...helper,
    admissionOwnerToken,
    repositoryPath,
  });
  assert.equal(admitted.kind, 'accepted');
  if (admitted.kind !== 'accepted') return;
  const imported = await importAdmittedGitoxideRepositoryInternal({
    admissionOwnerToken,
    repositoryCapability: admitted.capability,
    acceptedRepositoryOwnerToken,
    destinationRepositoryPath: join(repositoryPath, 'managed-tree-read.git'),
  });

  const result = await readGitoxideTreeFileInternal({
    acceptedRepositoryOwnerToken,
    acceptedRepositoryCapability: imported.acceptedRepositoryCapability,
    path: 'package.json',
  });
  assert.equal(result.content, '{"name":"fixture","private":true}\n');
  assert.equal(result.acceptedCommitOid, imported.baselineCommitOid);
  assert.equal(result.acceptedTreeOid, imported.baselineTreeOid);
  await assert.rejects(
    readGitoxideTreeFileInternal({
      acceptedRepositoryOwnerToken: {},
      acceptedRepositoryCapability: imported.acceptedRepositoryCapability,
      path: 'package.json',
    }),
    GitoxideRepositoryAdmissionAuthorityError,
  );
});

test('reuses the exact helper capability captured by repository admission', async (t) => {
  const helper = await admittedHelper();
  if (!helper) {
    t.skip('MAKA_GITOXIDE_HELPER_PATH is required for the real helper contract test');
    return;
  }
  const repositoryPath = await createRepository(t, 'sha1');
  await writeFile(join(repositoryPath, 'hello.txt'), 'bind helper identity\n');
  git(repositoryPath, ['add', 'hello.txt']);
  git(repositoryPath, [
    '-c',
    'user.name=Maka Test',
    '-c',
    'user.email=maka@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  ]);
  const admissionOwnerToken = {};
  const admitted = await admitGitoxideRepositoryInternal({
    ...helper,
    admissionOwnerToken,
    repositoryPath,
  });
  assert.equal(admitted.kind, 'accepted');
  if (admitted.kind !== 'accepted') return;

  const imported = await importAdmittedGitoxideRepositoryInternal({
    admissionOwnerToken,
    repositoryCapability: admitted.capability,
    acceptedRepositoryOwnerToken: {},
    destinationRepositoryPath: join(repositoryPath, 'captured-helper-import.git'),
  });
  assert.equal(imported.sourceHeadCommitOid, git(repositoryPath, ['rev-parse', 'HEAD']));
});

async function admittedHelper(): Promise<AdmittedHelper | undefined> {
  if (admittedHelperPromise) return admittedHelperPromise;
  admittedHelperPromise = (async () => {
    const configuredHelperPath = process.env.MAKA_GITOXIDE_HELPER_PATH;
    if (!configuredHelperPath) return undefined;
    const helperPath = await realpath(configuredHelperPath);
    const helperBytes = await readFile(helperPath);
    const helperInfo = await stat(helperPath);
    const helperArtifactSha256 =
      `sha256:${createHash('sha256').update(helperBytes).digest('hex')}` as const;
    const releaseOwnerToken = {};
    const invocationOwnerToken = {};
    const claim = issueGitoxideHelperReleaseArtifactClaimInternal(releaseOwnerToken, {
      executablePath: helperPath,
      expectedSha256: helperArtifactSha256,
      expectedBytes: helperInfo.size,
      platform: process.platform,
      arch: process.arch,
      protocolVersion: 1,
      supportedOperations: [
        'inspect_repository',
        'import_source_head',
        'create_candidate',
        'read_tree_file',
        'reopen_repository',
      ],
    });
    const helperCapability = await admitGitoxideHelperArtifactInternal({
      releaseOwnerToken,
      invocationOwnerToken,
      claim,
    });
    return { invocationOwnerToken, helperCapability, helperArtifactSha256 };
  })();
  return admittedHelperPromise;
}

async function admittedHelperWithOperations(
  supportedOperations: readonly GitoxideHelperOperationInternal[],
): Promise<AdmittedHelper | undefined> {
  const configuredHelperPath = process.env.MAKA_GITOXIDE_HELPER_PATH;
  if (!configuredHelperPath) return undefined;
  const helperPath = await realpath(configuredHelperPath);
  const helperBytes = await readFile(helperPath);
  const helperInfo = await stat(helperPath);
  const helperArtifactSha256 =
    `sha256:${createHash('sha256').update(helperBytes).digest('hex')}` as const;
  const releaseOwnerToken = {};
  const invocationOwnerToken = {};
  const claim = issueGitoxideHelperReleaseArtifactClaimInternal(releaseOwnerToken, {
    executablePath: helperPath,
    expectedSha256: helperArtifactSha256,
    expectedBytes: helperInfo.size,
    platform: process.platform,
    arch: process.arch,
    protocolVersion: 1,
    supportedOperations,
  });
  const helperCapability = await admitGitoxideHelperArtifactInternal({
    releaseOwnerToken,
    invocationOwnerToken,
    claim,
  });
  return { invocationOwnerToken, helperCapability, helperArtifactSha256 };
}

async function createRepository(t: TestContext, objectFormat: 'sha1' | 'sha256') {
  const repositoryPath = await realpath(await mkdtemp(join(tmpdir(), 'maka-gitoxide-admission-')));
  t.after(() => rm(repositoryPath, { recursive: true, force: true }));
  git(repositoryPath, ['init', '--quiet', `--object-format=${objectFormat}`]);
  return repositoryPath;
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function gitBare(repositoryPath: string, args: readonly string[]): string {
  return execFileSync('git', [`--git-dir=${repositoryPath}`, ...args], {
    encoding: 'utf8',
  }).trim();
}
