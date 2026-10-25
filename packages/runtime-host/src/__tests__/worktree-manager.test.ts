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
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import type { ProjectRecord } from '@maka/core/project';
import { createProjectCatalog } from '@maka/storage/project-catalog';
import { deferred, waitFor, withTimeout } from '@maka/core/test-only/async-primitives';
import { HostWorktreeManager } from '../server/worktree-manager.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';
import { HostWorkspaceResolver } from '../server/workspace-resolver.js';
import { HostProjectMembershipGate } from '../server/project-membership-gate.js';
import type { WorktreeName } from '../server/worktree-naming.js';
const exec = promisify(execFile);
import { createWorktree, fixture, testScript } from './worktree-fixture.js';

test('draining keeps workspace validation available for admitted turns but rejects new bindings', async (t) => {
  const f = await fixture(t, 'draining-readiness');
  const worktree = await createWorktree(f.manager, f.project.id, 'draining-readiness');
  await f.manager.bind('admitted-session', worktree.path);
  f.manager.beginDrain();

  await f.manager.assertReady('admitted-session', worktree.path);
  await assert.rejects(f.manager.assertReady('admitted-session', f.repo), /binding has changed/);
  await assert.rejects(f.manager.bind('new-session', worktree.path), /shutting down/);
  await rm(worktree.path, { recursive: true });
  await assert.rejects(f.manager.assertReady('admitted-session', worktree.path));
});

async function relinkFixture(t: TestContext) {
  const cleanup: Array<() => Promise<void>> = [];
  const f = await fixture({ after: (dispose) => cleanup.push(dispose) }, 'relinked-checkout');
  const catalog = createProjectCatalog(join(f.root, 'project-catalog'));
  const originalPath = join(f.root, 'original-project');
  await mkdir(originalPath);
  const original = await catalog.register(originalPath);
  await rm(originalPath, { recursive: true });
  const repository = await catalog.register(f.repo);
  const options = {
    ...f.options,
    stateRoot: join(f.root, 'relink-state'),
    catalog,
  };
  const manager = new HostWorktreeManager(options);
  t.after(async () => {
    await manager.close();
    catalog.close();
    await f.manager.close();
    for (const dispose of cleanup) await dispose();
  });
  await manager.mutate({
    kind: 'configure',
    config: { rootDirectory: join(f.root, 'relink-worktree-root') },
  });
  return { ...f, options, manager, catalog, original, repository };
}

test('relinking projects preserves worktree discovery and initialization recovery', async (t) => {
  const { manager, catalog, original, repository, ...f } = await relinkFixture(t);
  await manager.mutate({
    kind: 'configure',
    projectId: repository.id,
    config: { rootDirectory: join(f.root, 'relinked-worktrees'), setupScript: 'exit 1' },
  });
  const retry = await createWorktree(manager, repository.id, 'retry-after-relink');
  const skip = await createWorktree(manager, repository.id, 'skip-after-relink');
  await manager.bind('relinked-session', retry.path);

  const { project } = await catalog.relinkWithSessions(original.id, f.repo);
  assert.ok(project.aliases?.includes(repository.id));
  for (const id of [project.id, repository.id]) {
    const snapshot = await manager.snapshot(id);
    assert.deepEqual(
      snapshot.projects[0]!.worktrees.map((item) => item.path).sort(),
      [retry.path, skip.path].sort(),
    );
  }
  await manager.mutate({ kind: 'configure', projectId: project.id, config: { setupScript: '' } });
  await manager.mutate({ kind: 'initialize', projectId: repository.id, path: retry.path });
  await manager.mutate({ kind: 'initialize', projectId: project.id, path: skip.path, skip: true });
  await manager.assertReady('relinked-session', retry.path);
  assert.equal(await manager.workspaceBlocker(skip.path), undefined);
  assert.equal(
    (await manager.mutate({ kind: 'remove', projectId: project.id, path: skip.path })).kind,
    'removed',
  );
});

test('relinked identities retain configuration, directory allocations and operation reservations', async (t) => {
  const { manager, catalog, original, repository, ...f } = await relinkFixture(t);
  const config = {
    rootDirectory: join(f.root, 'relinked-worktrees'),
    defaultMode: 'new' as const,
    setupScript: 'exit 1',
    cleanupScript: 'exit 1',
  };
  await manager.mutate({ kind: 'configure', projectId: repository.id, config });
  const originalCheckout = await createWorktree(manager, repository.id, 'original-operation');
  await manager.bind('original-session', originalCheckout.path);
  const { project } = await catalog.relinkWithSessions(original.id, f.repo);
  for (const id of [project.id, repository.id]) {
    assert.equal(await manager.defaultMode(id), 'new');
    assert.deepEqual((await manager.snapshot(id)).projects[0]!.config, config);
    assert.equal(
      (await createWorktree(manager, id, 'original-operation')).path,
      originalCheckout.path,
    );
  }
  const next = await createWorktree(manager, project.id, 'after-relink');
  assert.equal(dirname(next.path), dirname(originalCheckout.path));
  assert.equal(next.initialization, 'failed');
  const cleanup = await manager.mutate({ kind: 'remove', projectId: project.id, path: next.path });
  assert.equal(cleanup.kind, 'cleanup_failed');
  if (cleanup.kind !== 'cleanup_failed') throw new Error('Expected inherited cleanup script');
  await manager.mutate({
    kind: 'remove',
    projectId: repository.id,
    path: next.path,
    confirmation: cleanup.confirmation,
  });
  await manager.mutate({
    kind: 'configure',
    projectId: project.id,
    config: { rootDirectory: config.rootDirectory, defaultMode: 'main' },
  });
  assert.equal(await manager.defaultMode(repository.id), 'main');
  const replacement = await createWorktree(manager, repository.id, 'replacement');
  assert.equal(replacement.initialization, 'ready');
  assert.equal(dirname(replacement.path), dirname(originalCheckout.path));
  assert.notEqual(replacement.path, next.path, 'Removed directories remain reserved');
  await assert.rejects(manager.bind('original-session', replacement.path), /cannot be changed/);
});

test('relinking during preparation preserves cancellation decisions across project identities', async (t) => {
  const { manager, catalog, original, repository, ...f } = await relinkFixture(t);
  const started = deferred<void>();
  const naming = deferred<WorktreeName | undefined>();
  f.options.generateName = async () => {
    started.resolve();
    return naming.promise;
  };
  const creating = manager.prepareTask(
    repository.id,
    { kind: 'new' },
    'relinked-preparation',
    'Task',
  );
  await started.promise;
  const { project } = await catalog.relinkWithSessions(original.id, f.repo);
  try {
    await manager.mutate({
      kind: 'resolve_preparation',
      projectId: project.id,
      operationId: 'relinked-preparation',
      decision: 'main',
    });
    assert.deepEqual(await creating, { kind: 'project', projectId: project.id });
    for (const id of [repository.id, project.id]) {
      assert.deepEqual(
        await manager.prepareTask(id, { kind: 'new' }, 'relinked-preparation', 'Task'),
        { kind: 'project', projectId: project.id },
      );
    }
  } finally {
    naming.resolve(undefined);
    await creating.catch(() => {});
  }
});

test('ordinary project directories round-trip through session workspace queries', async (t) => {
  const f = await fixture(t);
  await rm(join(f.repo, '.git'), { recursive: true });
  const resolver = new HostWorkspaceResolver(
    { ...f.options.catalog, touch: async () => f.project },
    new HostProjectMembershipGate(),
    () => {},
    f.manager,
  );
  const initial = await resolver.resolve({ kind: 'project', projectId: f.project.id });
  const returned = { kind: 'project' as const, projectId: f.project.id, worktreePath: initial.cwd };
  assert.equal((await resolver.resolve(returned)).cwd, f.repo);
  assert.equal(await f.manager.canCreateFrom(f.project.id, f.repo), false);
  await assert.rejects(resolver.resolve({ ...returned, worktreePath: f.root }));
  await assert.rejects(resolver.resolve({ ...returned, worktreePath: join(f.root, 'missing') }));
});

test('folder projects inside a repository retain their selected directory and cannot select its worktrees', async (t) => {
  const cleanup: Array<() => Promise<void>> = [];
  const f = await fixture({ after: (dispose) => cleanup.push(dispose) }, 'nested-project');
  const path = join(f.repo, 'packages', 'my-app');
  await mkdir(path, { recursive: true });
  const catalog = createProjectCatalog(join(f.root, 'nested-project-catalog'));
  const project = await catalog.register(path);
  const manager = new HostWorktreeManager({
    ...f.options,
    stateRoot: join(f.root, 'nested-worktree-state'),
    catalog,
  });
  t.after(async () => {
    await manager.close();
    catalog.close();
    await f.manager.close();
    for (const dispose of cleanup) await dispose();
  });
  const resolver = new HostWorkspaceResolver(
    catalog,
    new HostProjectMembershipGate(),
    () => {},
    manager,
  );
  const target = { kind: 'project' as const, projectId: project.id };
  const initial = await resolver.runWithUsageRecorded(target, async (workspace) => workspace);
  assert.equal(initial.cwd, path);
  assert.equal(await manager.mainPath(project.id), path);
  assert.equal((await resolver.resolve({ ...target, worktreePath: path })).cwd, path);
  assert.deepEqual((await manager.snapshot(project.id)).projects, []);
  assert.equal(await manager.canCreateFrom(project.id, path), false);
  assert.equal(await manager.canCreateFrom(project.id, f.repo), false);
  await assert.rejects(resolver.resolve({ ...target, worktreePath: f.repo }));
  await assert.rejects(createWorktree(manager, project.id));
  assert.deepEqual(
    (await catalog.list()).map((entry) => entry.id),
    [project.id],
  );
});

for (const recovery of ['retry', 'skip', 'remove'] as const) {
  test(`a failed post-checkout hook preserves a recoverable checkout across restart (${recovery})`, async (t) => {
    const f = await fixture(t, 'failed-checkout-hook');
    const marker = join(f.root, 'setup-ran');
    await f.manager.mutate({
      kind: 'configure',
      projectId: f.project.id,
      config: {
        setupScript: await testScript(
          f.root,
          `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'initialized');`,
        ),
      },
    });
    await writeFile(
      join(f.repo, '.git', 'hooks', 'post-checkout'),
      [
        '#!/bin/sh',
        ...(recovery === 'remove'
          ? []
          : [
              'printf "hook edit\\n" >> tracked.txt',
              'git add tracked.txt',
              'printf "unstaged edit\\n" >> tracked.txt',
            ]),
        'printf "post-checkout failed\\n" >&2',
        'exit 1',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    await assert.rejects(f.create(), /post-checkout failed/);
    const failed = (await f.manager.snapshot()).projects[0]!.worktrees[0]!;
    assert.equal(failed.available, true);
    assert.equal(failed.initialization, 'failed');
    assert.match(failed.log!, /post-checkout failed/);
    const expectedContent =
      recovery === 'remove' ? 'committed\n' : 'committed\nhook edit\nunstaged edit\n';
    assert.equal(await readFile(join(failed.path, 'tracked.txt'), 'utf8'), expectedContent);
    await assert.rejects(readFile(marker));
    await f.manager.close();

    const restarted = new HostWorktreeManager(f.options);
    t.after(() => restarted.close());
    const retained = await createWorktree(restarted, f.project.id, 'operation-1');
    assert.equal(retained.path, failed.path);
    assert.equal(retained.initialization, 'failed');
    assert.match(retained.log!, /post-checkout failed/);
    await assert.rejects(restarted.assertReady('pending-session', retained.path));
    await assert.rejects(readFile(marker));
    const result = await restarted.mutate(
      recovery === 'remove'
        ? { kind: 'remove', projectId: f.project.id, path: retained.path }
        : {
            kind: 'initialize',
            projectId: f.project.id,
            path: retained.path,
            skip: recovery === 'skip',
          },
    );
    if (recovery === 'remove') {
      assert.equal(result.kind, 'removed');
      await assert.rejects(readFile(join(retained.path, 'tracked.txt')));
    } else {
      assert.equal(result.kind, 'worktree');
      if (result.kind !== 'worktree') throw new Error('Expected recovered worktree');
      assert.equal(result.worktree.initialization, recovery === 'retry' ? 'ready' : 'skipped');
      await restarted.assertReady('pending-session', retained.path);
      assert.equal(await readFile(join(retained.path, 'tracked.txt'), 'utf8'), expectedContent);
    }
    if (recovery === 'retry') assert.equal(await readFile(marker, 'utf8'), 'initialized');
    else await assert.rejects(readFile(marker));
    assert.equal(await f.git('rev-parse', retained.branch!), retained.head);
  });
}

for (const recovery of ['retry', 'skip', 'remove'] as const) {
  test(`a completed checkout recovered from a reservation waits for explicit initialization (${recovery})`, async (t) => {
    const f = await fixture(t, 'interrupted-checkout');
    const item = await f.create();
    const marker = join(f.root, 'setup-ran');
    await f.manager.mutate({
      kind: 'configure',
      projectId: f.project.id,
      config: {
        setupScript: await testScript(
          f.root,
          `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'initialized');`,
        ),
      },
    });
    await f.manager.close();
    // Git populated the checkout, but the Host exited before journaling checked_out.
    const journalFile = join(f.options.stateRoot, 'worktrees.json');
    const journal = JSON.parse(await readFile(journalFile, 'utf8'));
    journal.worktrees[0].phase = 'reserved';
    await writeFile(journalFile, JSON.stringify(journal));

    const restarted = new HostWorktreeManager(f.options);
    t.after(() => restarted.close());
    // Settings must recover without replaying the lost creation/fork request.
    const retained = (await restarted.snapshot(f.project.id)).projects[0]!.worktrees[0]!;
    assert.equal(retained.initialization, 'failed');
    assert.match(retained.log!, /interrupted/i);
    await assert.rejects(readFile(marker));
    await assert.rejects(restarted.assertReady('pending-session', item.path));
    if (recovery === 'remove') {
      const removed = await restarted.mutate({
        kind: 'remove',
        projectId: f.project.id,
        path: item.path,
      });
      assert.equal(removed.kind, 'removed');
      await assert.rejects(readFile(marker));
      return;
    }
    const result = await restarted.mutate({
      kind: 'initialize',
      projectId: f.project.id,
      path: item.path,
      skip: recovery === 'skip',
    });
    assert.equal(result.kind, 'worktree');
    if (result.kind !== 'worktree') throw new Error('Expected recovered worktree');
    assert.equal(result.worktree.initialization, recovery === 'retry' ? 'ready' : 'skipped');
    await restarted.assertReady('pending-session', item.path);
    if (recovery === 'retry') assert.equal(await readFile(marker, 'utf8'), 'initialized');
    else await assert.rejects(readFile(marker));
  });
}

test('an interrupted partial checkout cannot run or skip initialization', async (t) => {
  const f = await fixture(t, 'partial-checkout');
  await writeFile(join(f.repo, '.gitattributes'), 'tracked.txt filter=broken\n');
  await f.git('add', '.gitattributes');
  await f.git('commit', '-m', 'filter');
  await f.git('config', 'filter.broken.smudge', 'false');
  await f.git('config', 'filter.broken.required', 'true');
  await assert.rejects(f.create(), /smudge filter.*failed/);
  const reserved = (await f.manager.snapshot()).projects[0]!.worktrees[0]!;
  await f.git('config', 'filter.broken.smudge', 'cat');
  await f.git('config', 'filter.broken.clean', 'cat');
  // Git has registered the checkout and HEAD, but has not populated its index/files.
  await f.git('worktree', 'add', '--no-checkout', reserved.path, reserved.branch!);
  await f.manager.close();
  const restarted = new HostWorktreeManager(f.options);
  t.after(() => restarted.close());
  await assert.rejects(createWorktree(restarted, f.project.id, 'operation-1'), /checkout/i);
  await assert.rejects(
    restarted.mutate({
      kind: 'initialize',
      projectId: f.project.id,
      path: reserved.path,
      skip: true,
    }),
  );
  await assert.rejects(restarted.assertReady('partial-session', reserved.path));
  assert.equal((await restarted.snapshot()).projects[0]!.worktrees[0]!.initialization, 'pending');
});

for (const conflict of ['none', 'moved', 'occupied'] as const) {
  test(`failed checkout retries reconcile the reserved branch (${conflict})`, async (t) => {
    const f = await fixture(t, 'retry-checkout');
    await writeFile(join(f.repo, '.gitattributes'), 'tracked.txt filter=broken\n');
    await f.git('add', '.gitattributes');
    await f.git('commit', '-m', 'filter');
    await f.git('config', 'filter.broken.smudge', 'false');
    await f.git('config', 'filter.broken.required', 'true');
    await assert.rejects(f.create(), /smudge filter.*failed/);
    assert.equal(await f.git('branch', '--list', 'feat/retry-checkout'), 'feat/retry-checkout');
    await f.git('config', 'filter.broken.smudge', 'cat');
    await f.git('config', 'filter.broken.clean', 'cat');
    if (conflict === 'moved') {
      await f.git('commit', '--allow-empty', '-m', 'another commit');
      await f.git('branch', '-f', 'feat/retry-checkout', 'HEAD');
    } else if (conflict === 'occupied') {
      await f.git('worktree', 'add', join(f.root, 'external'), 'feat/retry-checkout');
    }
    const branchHead = await f.git('rev-parse', 'feat/retry-checkout');
    // Recovery must also work after the in-memory manager is gone.
    const restarted = new HostWorktreeManager(f.options);
    const retry = () => createWorktree(restarted, f.project.id, 'operation-1');
    if (conflict === 'none') {
      const checkout = await retry();
      assert.equal(checkout.branch, 'feat/retry-checkout');
      assert.equal(checkout.initialization, 'ready');
      assert.equal(await readFile(join(checkout.path, 'tracked.txt'), 'utf8'), 'committed\n');
    } else {
      await assert.rejects(retry(), /reserved branch|already checked out/i);
    }
    assert.equal(await f.git('rev-parse', 'feat/retry-checkout'), branchHead);
  });
}

test('AI names create a branch at current HEAD, without copying dirty files; retries and restart reuse the checkout', async (t) => {
  const f = await fixture(t, 'search-field');
  await writeFile(join(f.repo, 'tracked.txt'), 'dirty\n');
  await writeFile(join(f.repo, 'untracked.txt'), 'untracked\n');
  const first = await f.create();
  assert.equal(first.branch, 'feat/search-field');
  assert.equal(first.name, 'search-field');
  assert.equal(first.path, join(f.root, 'worktrees', 'Example', 'search-field'));
  assert.equal(
    await exec('git', ['-C', first.path, 'branch', '--show-current']).then((r) => r.stdout.trim()),
    first.branch,
  );
  assert.equal(first.initialization, 'ready');
  assert.equal(await readFile(join(first.path, 'tracked.txt'), 'utf8'), 'committed\n');
  await assert.rejects(readFile(join(first.path, 'untracked.txt')));
  assert.equal((await f.create()).path, first.path);
  assert.equal(f.calls(), 1);
  const restarted = new HostWorktreeManager(f.options);
  const retry = await restarted.mutate({
    kind: 'create',
    operationId: 'operation-1',
    projectId: f.project.id,
    description: 'Add a search field',
  });
  assert.equal(retry.kind, 'worktree');
  if (retry.kind === 'worktree') assert.equal(retry.worktree.path, first.path);
  assert.equal(f.calls(), 1);
});

test('absent or blank setup scripts become ready without publishing running initialization', async (t) => {
  const f = await fixture(t);
  const states: string[] = [];
  f.options.changed = () => {
    const journal = JSON.parse(readFileSync(join(f.options.stateRoot, 'worktrees.json'), 'utf8'));
    for (const item of journal.worktrees) states.push(item.phase);
  };
  for (const [index, setupScript] of [undefined, '', ' \n\t '].entries()) {
    if (setupScript !== undefined) {
      await f.manager.mutate({
        kind: 'configure',
        projectId: f.project.id,
        config: { setupScript },
      });
    }
    states.length = 0;
    const item = await f.create(`no-script-${index}`);
    assert.equal(item.initialization, 'ready');
    assert.equal(item.log, '');
    assert.ok(states.includes('reserved'));
    assert.ok(states.includes('checked_out'));
    assert.ok(states.includes('ready'));
    assert.ok(!states.includes('initializing'));
  }
});

test('repeated generated names add numbers to both branch and directory only on conflict', async (t) => {
  const f = await fixture(t, 'search-field');
  const checkouts = await Promise.all([f.create('first'), f.create('second'), f.create('third')]);
  // Naming runs concurrently; allocation order is not invocation order.
  const sorted = [...checkouts].sort((a, b) => a.path.localeCompare(b.path));
  for (const [index, slug] of ['search-field', 'search-field-2', 'search-field-3'].entries()) {
    const item = sorted[index]!;
    assert.equal(item.branch, `feat/${slug}`);
    assert.equal(item.path, join(f.root, 'worktrees', 'Example', slug));
  }
  assert.equal((await f.create('second')).path, checkouts[1]!.path);
  await f.manager.close();
  const restarted = new HostWorktreeManager(f.options);
  const fourth = await createWorktree(restarted, f.project.id);
  assert.equal(fourth.branch, 'feat/search-field-4');
  assert.equal(fourth.path, join(f.root, 'worktrees', 'Example', 'search-field-4'));
});

test('existing branches, including hierarchical refs, are retained when assigning a worktree name', async (t) => {
  const f = await fixture(t, 'search-field');
  await f.git('branch', 'feat/search-field/subtask');
  await f.git('branch', 'feat/search-field-2');
  await f.git('branch', 'FEAT/search-field-3/nested/subtask');
  await f.git('branch', 'fix/search-field-4');
  await f.git('branch', 'feat/search-field-4-extra');
  const item = await f.create();
  assert.equal(item.branch, 'feat/search-field-4');
  assert.equal(item.path, join(f.root, 'worktrees', 'Example', 'search-field'));
  assert.equal(await f.git('rev-parse', 'feat/search-field/subtask'), item.head);
  assert.equal(await f.git('rev-parse', 'feat/search-field-2'), item.head);
  assert.equal(await f.git('rev-parse', 'FEAT/search-field-3/nested/subtask'), item.head);
});

test('an interrupted creation reserves its branch and retries at the original path', async (t) => {
  const f = await fixture(t, 'search-field');
  const first = await f.create();
  await f.manager.close();
  await f.git('worktree', 'remove', first.path);
  await f.git('branch', '-D', first.branch!);
  const journalFile = join(f.options.stateRoot, 'worktrees.json');
  const journal = JSON.parse(await readFile(journalFile, 'utf8'));
  journal.worktrees[0].phase = 'reserved';
  await writeFile(journalFile, JSON.stringify(journal));

  const restarted = new HostWorktreeManager(f.options);
  const second = await createWorktree(restarted, f.project.id);
  assert.equal(second.branch, 'feat/search-field-2');
  assert.equal(basename(second.path), 'search-field-2');
  const retry = await createWorktree(restarted, f.project.id, 'operation-1');
  assert.equal(retry.path, first.path);
  assert.equal(retry.branch, first.branch);
  assert.equal(retry.initialization, 'ready');
});

test('occupied worktree names are skipped without adopting or overwriting their files', async (t) => {
  const f = await fixture(t, 'reserved');
  await f.create();
  const branchRoot = join(f.root, 'worktrees', 'Example');
  await writeFile(join(branchRoot, 'SEARCH-FIELD'), 'unrelated file');
  await mkdir(join(branchRoot, 'search-field-2'));
  await writeFile(join(branchRoot, 'search-field-2', 'keep.txt'), 'unrelated directory');
  f.options.generateName = async () => ({ type: 'feat', slug: 'search-field' });
  const item = await createWorktree(f.manager, f.project.id);
  assert.equal(item.branch, 'feat/search-field');
  assert.equal(item.path, join(branchRoot, 'search-field-3'));
  assert.equal(await readFile(join(branchRoot, 'SEARCH-FIELD'), 'utf8'), 'unrelated file');
  assert.equal(
    await readFile(join(branchRoot, 'search-field-2', 'keep.txt'), 'utf8'),
    'unrelated directory',
  );
});

test('existing unprefixed branches do not block typed worktree branches', async (t) => {
  const f = await fixture(t, 'search-field');
  await f.git('branch', 'maka');
  await f.git('branch', 'search-field');
  const item = await f.create();
  assert.equal(item.branch, 'feat/search-field');
  assert.equal(item.path, join(f.root, 'worktrees', 'Example', 'search-field'));
  assert.equal(await f.git('rev-parse', 'maka'), item.head);
});

test('different change types share the slug but allocate directories independently', async (t) => {
  const f = await fixture(t, 'login-redirect', 'feat');
  const first = await f.create();
  f.options.generateName = async () => ({ type: 'fix', slug: 'login-redirect' });
  const second = await f.create('fix-login');
  assert.equal(first.branch, 'feat/login-redirect');
  assert.equal(second.branch, 'fix/login-redirect');
  assert.equal(basename(first.path), 'login-redirect');
  assert.equal(basename(second.path), 'login-redirect-2');
  assert.equal(
    (await exec('git', ['-C', second.path, 'branch', '--show-current'])).stdout.trim(),
    'fix/login-redirect',
  );
});

test('a branch occupying the type prefix leaves it intact and creates a detached checkout', async (t) => {
  const f = await fixture(t, 'search-field');
  await f.git('branch', 'feat');
  const item = await f.create();
  assert.equal(item.branch, undefined);
  assert.equal(basename(item.path), 'search-field');
  assert.equal(await f.git('rev-parse', 'feat'), item.head);
  assert.equal(
    (await exec('git', ['-C', item.path, 'branch', '--show-current'])).stdout.trim(),
    '',
  );
});

test('removed directory names remain reserved for old bindings even when the new branch type differs', async (t) => {
  const f = await fixture(t, 'login-redirect');
  const first = await f.create();
  await f.manager.bind('old-session', first.path);
  await f.manager.mutate({ kind: 'remove', projectId: f.project.id, path: first.path });
  await f.manager.close();
  f.options.generateName = async () => ({ type: 'fix', slug: 'login-redirect' });
  const restarted = new HostWorktreeManager(f.options);
  const second = await createWorktree(restarted, f.project.id);
  assert.equal(second.branch, 'fix/login-redirect');
  assert.equal(basename(second.path), 'login-redirect-2');
  await restarted.bind('new-session', second.path);
  await restarted.assertReady('new-session', second.path);
  await assert.rejects(restarted.assertReady('old-session', first.path));
});

test('invalid generated directory slugs fall back to detached checkouts inside the project', async (t) => {
  const f = await fixture(t, '../outside');
  const item = await f.create();
  assert.equal(item.branch, undefined);
  assert.match(item.name, /^[a-f0-9]{8}$/);
  assert.equal(dirname(item.path), join(f.root, 'worktrees', 'Example'));
});

test('project folder names persist across rename, restart and root configuration changes', async (t) => {
  const f = await fixture(t);
  const first = await f.create();
  assert.equal(dirname(first.path), join(f.root, 'worktrees', 'Example'));
  const journalFile = join(f.options.stateRoot, 'worktrees.json');
  const journal = JSON.parse(await readFile(journalFile, 'utf8'));
  assert.equal(journal.projectDirectories[f.project.id], 'Example');
  await f.manager.close();

  f.project.name = 'Renamed project';
  const restarted = new HostWorktreeManager(f.options);
  const second = await createWorktree(restarted, f.project.id);
  assert.equal(dirname(second.path), dirname(first.path));
  await restarted.mutate({
    kind: 'configure',
    projectId: f.project.id,
    config: { defaultMode: 'new' },
  });
  const newRoot = join(f.root, 'another root');
  await restarted.mutate({ kind: 'configure', config: { rootDirectory: newRoot } });
  const third = await createWorktree(restarted, f.project.id);
  assert.equal(dirname(third.path), join(newRoot, 'Example'));
  assert.equal(await readFile(join(first.path, 'tracked.txt'), 'utf8'), 'committed\n');
  await restarted.close();
  const again = new HostWorktreeManager(f.options);
  assert.equal(dirname((await createWorktree(again, f.project.id)).path), dirname(third.path));
});

test('same-name projects get separate persistent folders without changing the first allocation', async (t) => {
  const f = await fixture(t);
  const first = await f.create();
  await f.manager.mutate({ kind: 'remove', projectId: f.project.id, path: first.path });
  await rm(dirname(first.path), { recursive: true });
  const secondRepo = join(f.root, 'second repo');
  await exec('git', ['clone', '--quiet', f.repo, secondRepo]);
  const secondProject: ProjectRecord = {
    ...f.project,
    id: randomUUID(),
    name: 'example',
    preferredPath: secondRepo,
    locations: [{ path: secondRepo, isWorktree: false }],
  };
  f.options.catalog.list = async () => [f.project, secondProject];
  f.options.catalog.register = async (path: string) => {
    const gitDir = (await exec('git', ['-C', path, 'rev-parse', '--git-common-dir'])).stdout.trim();
    const project = gitDir === join(secondRepo, '.git') ? secondProject : f.project;
    if (!project.locations.some((entry) => entry.path === path))
      project.locations.push({ path, isWorktree: true });
    return project;
  };
  const second = await createWorktree(f.manager, secondProject.id);
  assert.match(basename(dirname(second.path)), /^example-[a-f0-9]{8}$/);
  assert.notEqual(dirname(second.path).toLowerCase(), dirname(first.path).toLowerCase());
  assert.equal(dirname((await createWorktree(f.manager, f.project.id)).path), dirname(first.path));
  await f.manager.close();
  secondProject.name = 'Renamed second project';
  const restarted = new HostWorktreeManager(f.options);
  assert.equal(
    dirname((await createWorktree(restarted, secondProject.id)).path),
    dirname(second.path),
  );
});

test('project folder allocation leaves occupied names and suffixes untouched', async (t) => {
  const f = await fixture(t);
  const root = join(f.root, 'worktrees');
  await mkdir(root);
  // Match case-insensitively even on a case-sensitive filesystem.
  await writeFile(join(root, 'example'), 'unrelated file');
  const suffix = createHash('sha256').update(f.project.id).digest('hex').slice(0, 8);
  const occupiedSuffix = join(root, `Example-${suffix}`);
  await mkdir(occupiedSuffix);
  await writeFile(join(occupiedSuffix, 'keep.txt'), 'unrelated directory');
  const item = await f.create();
  assert.equal(dirname(item.path), join(root, `Example-${suffix}-2`));
  assert.equal(await readFile(join(root, 'example'), 'utf8'), 'unrelated file');
  assert.equal(await readFile(join(occupiedSuffix, 'keep.txt'), 'utf8'), 'unrelated directory');
});

test('project names remain readable and cannot escape their worktree root', async (t) => {
  const f = await fixture(t);
  for (const [name, expected] of [
    ['中文项目', '中文项目'],
    ['../outside\\project', '-outside-project'],
    ['..', 'project'],
    ['NUL.txt', '_NUL.txt'],
    ['x'.repeat(100), 'x'.repeat(50)],
  ]) {
    f.project.id = randomUUID();
    f.project.name = name!;
    const item = await createWorktree(f.manager, f.project.id);
    assert.equal(dirname(item.path), join(f.root, 'worktrees', expected!));
  }
});

for (const layout of ['flat-random', 'prefixed', 'unprefixed'] as const) {
  test(`legacy ${layout} checkouts keep their paths and bindings while new checkouts use generated names`, async (t) => {
    const f = await fixture(t, 'search-field');
    f.project.name = 'Example-30e78fd4';
    const legacy = await f.create();
    await f.manager.bind('legacy-session', legacy.path);
    await f.manager.close();
    const oldBranch =
      layout === 'unprefixed'
        ? 'search-field'
        : layout === 'prefixed'
          ? 'maka/search-field'
          : 'maka/search-field-deadbeef';
    const oldPath = join(
      f.root,
      'worktrees',
      f.project.name,
      layout === 'flat-random' ? 'search-field-deadbeef' : oldBranch,
    );
    await mkdir(dirname(oldPath), { recursive: true });
    if (legacy.path !== oldPath) await f.git('worktree', 'move', legacy.path, oldPath);
    await exec('git', ['-C', oldPath, 'branch', '-m', oldBranch]);
    legacy.path = oldPath;
    const journalFile = join(f.options.stateRoot, 'worktrees.json');
    const journal = JSON.parse(await readFile(journalFile, 'utf8'));
    journal.worktrees[0].path = oldPath;
    journal.worktrees[0].branch = oldBranch;
    journal.bindings['legacy-session'].path = oldPath;
    delete journal.bindings['legacy-session'].gitRoot;
    if (layout === 'flat-random') delete journal.projectDirectories;
    await writeFile(journalFile, JSON.stringify(journal));
    f.project.name = 'Example';

    const restarted = new HostWorktreeManager(f.options);
    const retried = await createWorktree(restarted, f.project.id, 'operation-1');
    assert.equal(retried.path, legacy.path);
    assert.equal(retried.branch, oldBranch);
    await restarted.assertReady('legacy-session', legacy.path);
    const fresh = await createWorktree(restarted, f.project.id);
    const projectFolder = layout === 'flat-random' ? 'Example' : 'Example-30e78fd4';
    assert.equal(fresh.branch, 'feat/search-field');
    assert.equal(
      fresh.path,
      join(
        f.root,
        'worktrees',
        projectFolder,
        layout === 'unprefixed' ? 'search-field-2' : 'search-field',
      ),
    );
    const saved = JSON.parse(await readFile(journalFile, 'utf8'));
    assert.equal(saved.projectDirectories[f.project.id], projectFolder);
    assert.equal(saved.worktrees[0].path, legacy.path);
    assert.equal(saved.bindings['legacy-session'].path, legacy.path);
    assert.equal(await readFile(join(legacy.path, 'tracked.txt'), 'utf8'), 'committed\n');
    assert.equal(
      (await restarted.mutate({ kind: 'remove', projectId: f.project.id, path: legacy.path })).kind,
      'removed',
    );
  });
}

test('snapshots list only Maka-created worktrees, retaining the main path separately across restarts', async (t) => {
  const f = await fixture(t);
  const initial = (await f.manager.snapshot()).projects[0]!;
  assert.equal(initial.mainPath, f.repo);
  assert.deepEqual(initial.worktrees, []);
  const first = await f.create();
  assert.match(first.name, /^[a-f0-9]{8}$/);
  assert.equal(first.branch, undefined);
  // A matching branch prefix and configured root do not prove Maka ownership.
  const external = join(dirname(first.path), 'external checkout');
  await f.git('worktree', 'add', '-b', 'maka/external', external, 'HEAD');
  f.project.preferredPath = external;
  for (const snapshot of [
    await f.manager.snapshot(),
    await f.manager.snapshot(f.project.id),
    await new HostWorktreeManager(f.options).snapshot(),
  ]) {
    const project = snapshot.projects[0]!;
    assert.equal(project.mainPath, f.repo);
    assert.deepEqual(project.worktrees, [first]);
    assert.equal(project.worktrees[0]?.managed, true);
  }
  await assert.rejects(
    f.manager.mutate({ kind: 'remove', projectId: f.project.id, path: external }),
    /Only worktrees created by Maka/,
  );
  await f.manager.mutate({ kind: 'remove', projectId: f.project.id, path: first.path });
  await f.git('worktree', 'add', '--detach', first.path, 'HEAD');
  assert.deepEqual((await f.manager.snapshot()).projects[0]!.worktrees, []);
});

test('snapshots preserve Git order, append missing checkouts and refresh session counts and availability', async (t) => {
  const f = await fixture(t, 'snapshot');
  const first = await f.create('first');
  const second = await f.create('second');
  const third = await f.create('third');
  f.sessions.push(
    { id: 'main-session', cwd: f.repo },
    { id: 'first-session', cwd: first.path },
    { id: 'second-session', cwd: second.path },
    { id: 'another-second-session', cwd: second.path },
  );
  await f.git('worktree', 'remove', first.path);
  await f.git('worktree', 'lock', second.path);
  const snapshot = (await f.manager.snapshot()).projects[0]!;
  assert.equal(snapshot.mainPath, f.repo);
  assert.deepEqual(snapshot.worktrees, [
    { ...second, locked: true, sessionCount: 2 },
    third,
    { ...first, available: false, sessionCount: 1 },
  ]);

  await f.git('worktree', 'add', first.path, first.branch!);
  await f.git('worktree', 'unlock', second.path);
  f.sessions.splice(0, f.sessions.length, { id: 'third-session', cwd: third.path });
  assert.deepEqual((await f.manager.snapshot()).projects[0]!.worktrees, [
    first,
    second,
    { ...third, sessionCount: 1 },
  ]);
});

test('failed setup is retained, never automatically rerun, and can be skipped or explicitly retried', async (t) => {
  const f = await fixture(t);
  const marker = join(f.root, 'attempts');
  await f.manager.mutate({
    kind: 'configure',
    projectId: f.project.id,
    config: {
      setupScript: await testScript(
        f.root,
        `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'x'); console.error('setup failed'); process.exit(2);`,
      ),
    },
  });
  const item = await f.create();
  assert.equal(item.initialization, 'failed');
  assert.match(item.log!, /setup failed/);
  await f.manager.bind('session-1', item.path);
  await assert.rejects(
    f.manager.assertReady('session-1', item.path),
    /initialization has not completed/,
  );
  await f.create();
  assert.equal(await readFile(marker, 'utf8'), 'x');
  await f.manager.mutate({
    kind: 'initialize',
    projectId: f.project.id,
    path: item.path,
    skip: true,
  });
  await f.manager.assertReady('session-1', item.path);
  assert.equal(await readFile(marker, 'utf8'), 'x');
});

test('setup retries use the current project configuration in the same directory', async (t) => {
  const f = await fixture(t);
  await f.manager.mutate({
    kind: 'configure',
    projectId: f.project.id,
    config: { setupScript: 'exit 1' },
  });
  const item = await f.create();
  await f.manager.mutate({
    kind: 'configure',
    projectId: f.project.id,
    config: { setupScript: await testScript(f.root, `process.stdout.write('initialized');`) },
  });
  const retried = await f.manager.mutate({
    kind: 'initialize',
    projectId: f.project.id,
    path: item.path,
  });
  assert.equal(retried.kind, 'worktree');
  if (retried.kind === 'worktree') {
    assert.equal(retried.worktree.path, item.path);
    assert.equal(retried.worktree.initialization, 'ready');
    assert.equal(retried.worktree.log, 'initialized');
  }
});

test('bindings persist and cannot change; a deleted checkout cannot fall back to the main directory', async (t) => {
  const f = await fixture(t);
  const item = await f.create();
  await f.manager.bind('session-1', item.path);
  const restarted = new HostWorktreeManager(f.options);
  assert.equal(await restarted.isBound('session-1'), true);
  await assert.rejects(restarted.bind('session-1', f.repo), /cannot be changed/);
  await assert.rejects(restarted.assertReady('session-1', f.repo), /binding has changed/);
  await f.git('worktree', 'remove', item.path);
  await assert.rejects(restarted.assertReady('session-1', item.path));
  assert.equal(
    (await restarted.snapshot()).projects[0]?.worktrees.find((w) => w.path === item.path)
      ?.available,
    false,
  );
  await assert.rejects(restarted.validatePath(f.project.id, f.root));
});

test('an unmanaged nested worktree cannot fall back to its parent repository after restart', async (t) => {
  const f = await fixture(t);
  const path = join(f.repo, 'external');
  await f.git('worktree', 'add', '-b', 'external', path, 'HEAD');
  await f.manager.validatePath(f.project.id, path);
  await f.manager.bind('external-session', path);
  await f.manager.assertReady('external-session', path);
  await f.manager.close();
  await rm(join(path, '.git'));
  assert.equal(await f.git('-C', path, 'rev-parse', '--show-toplevel'), f.repo);

  const restarted = new HostWorktreeManager(f.options);
  t.after(() => restarted.close());
  await assert.rejects(restarted.assertReady('external-session', path), /identity has changed/);
});

test('ordinary Git subdirectory bindings remain usable after restart', async (t) => {
  const f = await fixture(t);
  const path = join(f.repo, 'subdirectory');
  await mkdir(path);
  await f.manager.bind('subdirectory-session', path);
  await f.manager.close();
  const restarted = new HostWorktreeManager(f.options);
  t.after(() => restarted.close());
  await restarted.assertReady('subdirectory-session', path);
});

for (const removal of ['git', 'filesystem'] as const) {
  test(`a nested checkout replaced by an ordinary directory is unavailable (${removal})`, async (t) => {
    const f = await fixture(t, 'nested-checkout');
    await f.manager.mutate({
      kind: 'configure',
      config: { rootDirectory: join(f.repo, '.worktrees') },
    });
    const item = await f.create();
    await f.manager.bind('session-1', item.path);
    await f.manager.close();
    if (removal === 'git') await f.git('worktree', 'remove', item.path);
    else await rm(item.path, { recursive: true });
    await mkdir(item.path, { recursive: true });
    assert.equal(await f.git('-C', item.path, 'rev-parse', '--show-toplevel'), f.repo);

    const restarted = new HostWorktreeManager(f.options);
    t.after(() => restarted.close());
    await assert.rejects(restarted.assertReady('session-1', item.path), /worktree/i);
    await assert.rejects(restarted.assertReady('unbound-session', item.path), /worktree/i);
    await assert.rejects(restarted.bind('new-session', item.path), /worktree/i);
    assert.equal((await restarted.snapshot()).projects[0]!.worktrees[0]!.available, false);

    await f.git('worktree', 'prune');
    await f.git('worktree', 'add', item.path, item.branch!);
    await restarted.assertReady('session-1', item.path);
    assert.equal((await restarted.snapshot()).projects[0]!.worktrees[0]!.available, true);
  });
}

test('cleanup script failure requires a one-use confirmation and retains the branch and session binding', async (t) => {
  const f = await fixture(t, 'search-field');
  const item = await f.create();
  f.sessions.push({ id: 'session-1', cwd: item.path });
  await f.manager.bind('session-1', item.path);
  await f.manager.mutate({
    kind: 'configure',
    projectId: f.project.id,
    config: {
      cleanupScript: await testScript(f.root, `console.error('cleanup-error'); process.exit(1);`),
    },
  });
  const failed = await f.manager.mutate({
    kind: 'remove',
    projectId: f.project.id,
    path: item.path,
  });
  assert.equal(failed.kind, 'cleanup_failed');
  assert.equal(
    (await f.manager.snapshot()).projects[0]!.worktrees.some((w) => w.path === item.path),
    true,
  );
  if (failed.kind !== 'cleanup_failed') return;
  assert.match(failed.log, /cleanup-error/);
  const result = await f.manager.mutate({
    kind: 'remove',
    projectId: f.project.id,
    path: item.path,
    confirmation: failed.confirmation,
  });
  assert.equal(result.kind, 'removed');
  assert.equal(await f.git('rev-parse', item.branch!), item.head);
  assert.equal(await f.manager.isBound('session-1'), true);
  await assert.rejects(f.manager.assertReady('session-1', item.path));
});

test('cleanup blocks running sessions, dirty files and detached commits without another retaining branch', async (t) => {
  const f = await fixture(t);
  const item = await f.create();
  f.sessions.push({ id: 'session-1', cwd: item.path });
  f.setActive(true);
  await assert.rejects(
    f.manager.mutate({ kind: 'remove', projectId: f.project.id, path: item.path }),
    /still running/,
  );
  f.setActive(false);
  await writeFile(join(item.path, 'new.txt'), 'new\n');
  await assert.rejects(
    f.manager.mutate({ kind: 'remove', projectId: f.project.id, path: item.path }),
    /uncommitted/,
  );
  await exec('git', ['-C', item.path, 'add', '.']);
  await exec('git', ['-C', item.path, 'commit', '-m', 'detached work']);
  await assert.rejects(
    f.manager.mutate({ kind: 'remove', projectId: f.project.id, path: item.path }),
    /commits not retained/,
  );
  await exec('git', ['-C', item.path, 'branch', 'retained-work']);
  assert.equal(
    (await f.manager.mutate({ kind: 'remove', projectId: f.project.id, path: item.path })).kind,
    'removed',
  );
});

test('cleanup checks live resources after acquiring the session gate', async (t) => {
  const f = await fixture(t);
  const item = await f.create();
  const sessionId = 'starting-shell-session';
  f.sessions.push({ id: sessionId, cwd: item.path });
  const gate = new SessionAdmissionGate();
  const startupEntered = deferred<void>();
  const releaseStartup = deferred<void>();
  const cleanupQueued = deferred<void>();
  f.options.withSessions = (ids, operation) => {
    cleanupQueued.resolve();
    return gate.runMany(ids, operation);
  };
  const startup = gate.run(sessionId, async () => {
    startupEntered.resolve();
    await releaseStartup.promise;
    f.liveResources.add(sessionId);
  });
  let removal: Promise<unknown> | undefined;
  try {
    await startupEntered.promise;
    removal = f.manager.mutate({ kind: 'remove', projectId: f.project.id, path: item.path });
    const rejected = assert.rejects(removal, /still running/);
    await cleanupQueued.promise;
    releaseStartup.resolve();
    await startup;
    await rejected;
    assert.equal(await readFile(join(item.path, 'tracked.txt'), 'utf8'), 'committed\n');
    f.liveResources.clear();
    assert.equal(
      (await f.manager.mutate({ kind: 'remove', projectId: f.project.id, path: item.path })).kind,
      'removed',
    );
  } finally {
    releaseStartup.resolve();
    await Promise.allSettled([startup, removal]);
  }
});

test('setup receives Host paths and cleanup can remove ignored setup artifacts without deleting the branch', async (t) => {
  const f = await fixture(t, 'setup-environment');
  await writeFile(join(f.repo, '.gitignore'), 'dependencies/\n');
  await f.git('add', '.gitignore');
  await f.git('commit', '-m', 'ignore dependencies');
  const output = join(f.root, 'script-paths');
  await f.manager.mutate({
    kind: 'configure',
    projectId: f.project.id,
    config: {
      setupScript: await testScript(
        f.root,
        `const fs = require('node:fs'); fs.mkdirSync('dependencies'); fs.writeFileSync(${JSON.stringify(output)}, [process.env.MAKA_PROJECT_PATH, process.env.MAKA_SOURCE_WORKTREE_PATH, process.env.MAKA_WORKTREE_PATH].join('\\n'));`,
      ),
    },
  });
  const item = await f.create();
  assert.equal(item.initialization, 'ready');
  assert.equal(await readFile(output, 'utf8'), `${f.repo}\n${f.repo}\n${item.path}`);
  assert.equal(
    (await f.manager.mutate({ kind: 'remove', projectId: f.project.id, path: item.path })).kind,
    'removed',
  );
  assert.equal(await f.git('rev-parse', item.branch!), item.head);
});

test('a cleanup failure confirmation cannot be reused after its expiry', async (t) => {
  const f = await fixture(t);
  const item = await f.create();
  await f.manager.mutate({
    kind: 'configure',
    projectId: f.project.id,
    config: { cleanupScript: 'exit 1' },
  });
  const failed = await f.manager.mutate({
    kind: 'remove',
    projectId: f.project.id,
    path: item.path,
  });
  assert.equal(failed.kind, 'cleanup_failed');
  if (failed.kind !== 'cleanup_failed') return;
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 6 * 60_000 });
  await assert.rejects(
    f.manager.mutate({
      kind: 'remove',
      projectId: f.project.id,
      path: item.path,
      confirmation: failed.confirmation,
    }),
    /confirmation has expired/,
  );
  assert.equal(
    (await f.manager.snapshot()).projects[0]!.worktrees.some((w) => w.path === item.path),
    true,
  );
});

test('cleanup reacquires gates when a session binds during admission, including sessions not yet catalogued', async (t) => {
  const f = await fixture(t);
  const item = await f.create();
  await f.manager.bind('first-session', item.path);
  const acquisitions: string[][] = [];
  f.options.withSessions = async <T>(ids: readonly string[], operation: () => Promise<T>) => {
    acquisitions.push([...ids]);
    if (acquisitions.length === 1) await f.manager.bind('new-session', item.path);
    return operation();
  };
  const result = await f.manager.mutate({
    kind: 'remove',
    projectId: f.project.id,
    path: item.path,
  });
  assert.equal(result.kind, 'removed');
  assert.deepEqual(acquisitions, [['first-session'], ['first-session', 'new-session']]);
});

test('slow naming does not block unrelated bindings or configuration', {
  timeout: 10_000,
}, async (t) => {
  const f = await fixture(t);
  const naming = deferred<WorktreeName>();
  const started = deferred<void>();
  f.options.generateName = () => {
    started.resolve();
    return naming.promise;
  };
  const creating = f.create();
  await started.promise;
  const unrelated = Promise.all([
    f.manager.bind('unrelated-task', f.repo),
    f.manager.mutate({ kind: 'configure', config: { rootDirectory: join(f.root, 'next-root') } }),
  ]);
  try {
    await withTimeout(unrelated, 2000, 'Unrelated operations blocked by naming');
    assert.equal(await f.manager.isBound('unrelated-task'), true);
  } finally {
    naming.resolve({ type: 'chore', slug: 'slow-task' });
    await creating;
    await unrelated;
    await f.manager.close();
  }
});

test('setup leaves other projects usable and shutdown waits for the interrupted script journal', {
  timeout: 15_000,
}, async (t) => {
  const f = await fixture(t, 'slow-setup');
  const marker = join(f.root, 'started');
  await f.manager.mutate({
    kind: 'configure',
    projectId: f.project.id,
    config: {
      setupScript: await testScript(
        f.root,
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started'); setInterval(() => {}, 1000);`,
      ),
    },
  });
  const creating = f.create();
  try {
    await waitFor(
      () =>
        readFile(marker).then(
          () => true,
          () => false,
        ),
      { timeoutMs: 5000, pollMs: 10 },
    );
    const otherRepo = join(f.root, 'other-repo');
    await exec('git', ['clone', '--quiet', f.repo, otherRepo]);
    const other: ProjectRecord = {
      ...f.project,
      id: 'other-project',
      preferredPath: otherRepo,
      locations: [{ path: otherRepo, isWorktree: false }],
    };
    f.options.catalog.list = async () => [f.project, other];
    const [checkout] = await withTimeout(
      Promise.all([
        createWorktree(f.manager, other.id, 'other-operation'),
        f.manager.bind('main-task', f.repo),
        f.manager.mutate({
          kind: 'configure',
          projectId: other.id,
          config: { defaultMode: 'new' },
        }),
      ]),
      3000,
      'Setup blocked another project',
    );
    assert.equal(checkout.initialization, 'ready');
  } finally {
    await f.manager.close();
    await creating;
  }
  const restarted = new HostWorktreeManager(f.options);
  const slow = (await restarted.snapshot(f.project.id)).projects[0]!.worktrees[0]!;
  assert.equal(slow.initialization, 'failed');
  assert.match(slow.log!, /interrupted/);
  assert.equal(await restarted.isBound('main-task'), true);
  await restarted.close();
});

test('checkout cleanup excludes new bindings and a queued binding cannot adopt the removed directory', {
  timeout: 15_000,
}, async (t) => {
  const f = await fixture(t);
  const checkout = await f.create();
  const marker = join(f.root, 'cleaning');
  const release = join(f.root, 'release');
  await f.manager.mutate({
    kind: 'configure',
    projectId: f.project.id,
    config: {
      cleanupScript: await testScript(
        f.root,
        `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(marker)}, 'started'); const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) clearInterval(timer); }, 10);`,
      ),
    },
  });
  const removing = f.manager.mutate({
    kind: 'remove',
    projectId: f.project.id,
    path: checkout.path,
  });
  let binding: Promise<void> | undefined;
  try {
    await waitFor(
      () =>
        readFile(marker).then(
          () => true,
          () => false,
        ),
      { timeoutMs: 5000, pollMs: 10 },
    );
    binding = assert.rejects(f.manager.bind('late-session', checkout.path));
    await withTimeout(
      f.manager.bind('unrelated', f.repo),
      2000,
      'Cleanup blocked another checkout',
    );
  } finally {
    await writeFile(release, 'continue');
    await removing;
    await binding;
    await f.manager.close();
  }
  assert.equal(await f.manager.isBound('late-session'), false);
});

test('fork capability validates main and external source checkouts independently of the managed list', async (t) => {
  const f = await fixture(t);
  const external = join(f.root, 'external');
  await f.git('worktree', 'add', '--detach', external, 'HEAD');
  assert.deepEqual((await f.manager.snapshot()).projects[0]!.worktrees, []);
  assert.equal(await f.manager.canCreateFrom(f.project.id, f.repo), true);
  assert.equal(await f.manager.canCreateFrom(f.project.id, external), true);
  assert.equal(f.project.locations.length, 1, 'capability queries do not register paths');
  await f.git('worktree', 'lock', external);
  assert.equal(await f.manager.canCreateFrom(f.project.id, external), false);
  assert.equal(await f.manager.canCreateFrom(f.project.id, join(f.root, 'missing')), false);
  assert.equal(await f.manager.canCreateFrom(f.project.id, f.root), false);
  assert.equal(await f.manager.canCreateFrom(null, f.repo), false);
  const unborn = join(f.root, 'unborn');
  await mkdir(unborn);
  await exec('git', ['-C', unborn, 'init']);
  f.project.preferredPath = unborn;
  assert.equal(await f.manager.canCreateFrom(f.project.id, unborn), false);
});

for (const decision of ['main', 'cancel'] as const) {
  test(`preparation ${decision} interrupts naming and survives replay without creating a checkout`, async (t) => {
    const f = await fixture(t);
    const naming = deferred<WorktreeName | undefined>();
    let namingStarted = false;
    f.options.generateName = async () => {
      namingStarted = true;
      return naming.promise;
    };
    const preparing = f.manager.prepareTask(
      f.project.id,
      { kind: 'new' },
      'pending-task',
      'Build it',
    );
    const outcome = preparing.then(
      (target) => ({ target }),
      (error: unknown) => ({ error }),
    );
    await waitFor(() => namingStarted, { timeoutMs: 5000 });
    await assert.rejects(
      f.manager.mutate({
        kind: 'resolve_preparation',
        projectId: 'other-project',
        operationId: 'pending-task',
        decision,
      }),
    );
    const command = {
      kind: 'resolve_preparation' as const,
      projectId: f.project.id,
      operationId: 'pending-task',
      decision,
    };
    assert.deepEqual(await f.manager.mutate(command), { kind: 'preparation_resolved' });
    const result = await withTimeout(outcome, 2000, 'Preparation did not resolve');
    if (decision === 'main')
      assert.deepEqual(result, { target: { kind: 'project', projectId: f.project.id } });
    else assert.match(String('error' in result && result.error), /cancelled/);
    assert.deepEqual(await f.manager.mutate(command), { kind: 'preparation_resolved' });
    await f.manager.close();
    const restarted = new HostWorktreeManager(f.options);
    t.after(() => restarted.close());
    if (decision === 'main')
      assert.deepEqual(
        await restarted.prepareTask(f.project.id, { kind: 'new' }, 'pending-task', 'Build it'),
        { kind: 'project', projectId: f.project.id },
      );
    else
      await assert.rejects(
        restarted.prepareTask(f.project.id, { kind: 'new' }, 'pending-task', 'Build it'),
        /cancelled/,
      );
    naming.resolve({ type: 'feat', slug: 'must-not-create' });
    assert.equal(
      (await restarted.snapshot()).projects[0]!.worktrees.filter((item) => !item.isMain).length,
      0,
    );
    await assert.rejects(
      restarted.mutate({ ...command, operationId: 'already-finished' }),
      /already finished/,
    );
  });
}

test('continuing in the main directory interrupts a running setup script', async (t) => {
  const f = await fixture(t, 'slow-setup');
  const script = await testScript(f.root, 'setInterval(() => {}, 1000);');
  await f.manager.mutate({
    kind: 'configure',
    projectId: f.project.id,
    config: { setupScript: script },
  });
  const preparing = f.manager.prepareTask(f.project.id, { kind: 'new' }, 'setup-task', 'Build it');
  await waitFor(
    async () =>
      (await f.manager.snapshot()).projects[0]!.worktrees.some(
        (w) => w.initialization === 'running',
      ),
    { timeoutMs: 10000 },
  );
  await f.manager.mutate({
    kind: 'resolve_preparation',
    projectId: f.project.id,
    operationId: 'setup-task',
    decision: 'main',
  });
  assert.deepEqual(await withTimeout(preparing, 2000, 'Main directory is blocked by setup'), {
    kind: 'project',
    projectId: f.project.id,
  });
  await withTimeout(f.manager.close(), 5000, 'Setup script was not interrupted');
});

test('cleanup protects active sessions rooted in a checkout subdirectory', async (t) => {
  const f = await fixture(t, 'subdirectory-cleanup');
  await mkdir(join(f.repo, 'nested'));
  await writeFile(join(f.repo, 'nested', 'tracked.txt'), 'nested\n');
  await f.git('add', '.');
  await f.git('commit', '-m', 'track nested directory');
  const item = await f.create();
  f.sessions.push({ id: 'nested-session', cwd: join(item.path, 'nested') });
  f.setActive(true);
  await assert.rejects(
    f.manager.mutate({ kind: 'remove', projectId: f.project.id, path: item.path }),
    /still running/,
  );
});
