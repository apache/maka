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
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deferred, waitFor, withTimeout } from '@maka/core/test-only/async-primitives';
import { HostWorktreeManager } from '../server/worktree-manager.js';
import { fixture, testScript } from './worktree-fixture.js';

for (const decision of ['main', 'cancel'] as const) {
  test(`interruption after checkout (${decision}) remains recoverable after restart`, async (t) => {
    const f = await fixture(t, 'interrupted-checkout');
    const registered = deferred<void>();
    const release = deferred<void>();
    const register = f.options.catalog.register;
    f.options.catalog.register = async (path) => {
      if (path !== f.repo) {
        registered.resolve();
        await release.promise;
      }
      return register(path);
    };
    const creating = f.manager.prepareTask(f.project.id, { kind: 'new' }, 'interrupted', 'Task');
    const outcome = creating.catch((error: unknown) => error);
    try {
      await withTimeout(registered.promise, 3000, 'Checkout did not reach registration');
      await f.manager.mutate({
        kind: 'resolve_preparation',
        projectId: f.project.id,
        operationId: 'interrupted',
        decision,
      });
      await withTimeout(outcome, 2000, 'Cancellation did not resolve');
    } finally {
      release.resolve();
      await f.manager.close();
      await outcome;
    }
    const restarted = new HostWorktreeManager(f.options);
    t.after(() => restarted.close());
    const item = (await restarted.snapshot()).projects[0]!.worktrees[0]!;
    assert.equal(
      item.initialization,
      'failed',
      'Stopped preparation must offer retry/skip, never remain pending',
    );
    const retried = await restarted.mutate({
      kind: 'initialize',
      projectId: f.project.id,
      path: item.path,
    });
    assert.equal(retried.kind, 'worktree');
    await restarted.assertReady('recovered', item.path);
  });
}

test('two worktrees in the same repository initialize independently', {
  timeout: 30000,
}, async (t) => {
  const f = await fixture(t, 'parallel-checkout');
  const marker = join(f.root, 'setup-started');
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
  const first = f.create('first');
  let second: ReturnType<typeof f.create> | undefined;
  try {
    await waitFor(
      () =>
        readFile(marker).then(
          () => true,
          () => false,
        ),
      { timeoutMs: 3000 },
    );
    await f.manager.mutate({ kind: 'configure', projectId: f.project.id, config: {} });
    second = f.create('second');
    // The first setup stays blocked until finally; a longer deadline tolerates
    // busy CI workers while still detecting a repository-wide script lock.
    const result = await withTimeout(second, 10000, 'Second checkout blocked by first setup');
    assert.equal(result.initialization, 'ready');
    assert.equal(
      (await f.manager.snapshot()).projects[0]!.worktrees.find(
        (item) => item.operationId === 'first',
      )?.initialization,
      'running',
    );
  } finally {
    await f.manager.close();
    await Promise.allSettled([first, second]);
  }
});

for (const initialization of ['pending', 'running'] as const) {
  test(`legacy created ${initialization} journals recover without rerunning setup`, async (t) => {
    const f = await fixture(t, 'legacy-interruption');
    const item = await f.create();
    await f.manager.close();
    const file = join(f.options.stateRoot, 'worktrees.json');
    const stored = JSON.parse(await readFile(file, 'utf8'));
    stored.version = 1;
    delete stored.worktrees[0].phase;
    Object.assign(stored.worktrees[0], { created: true, initialization });
    await writeFile(file, JSON.stringify(stored));
    const restarted = new HostWorktreeManager(f.options);
    t.after(() => restarted.close());
    assert.deepEqual(await restarted.preparation(item.operationId!), {
      phase: 'blocked',
      path: item.path,
    });
    assert.deepEqual(await restarted.workspaceBlocker(item.path), {
      kind: 'worktree_initialization',
      path: item.path,
    });
    const result = await restarted.mutate({
      kind: 'initialize',
      projectId: f.project.id,
      path: item.path,
      skip: true,
    });
    assert.equal(result.kind, 'worktree');
    assert.equal(await restarted.workspaceBlocker(item.path), undefined);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).version, 2);
  });
}

test('preparation observation reads only the operation journal, not project discovery', async (t) => {
  const f = await fixture(t, 'operation-status');
  const item = await f.create('observed');
  f.options.catalog.list = async () => {
    throw new Error('Discovery unavailable');
  };
  assert.deepEqual(await f.manager.preparation('observed'), {
    phase: 'finalizing',
    path: item.path,
  });
  assert.deepEqual(await f.manager.preparation('unrelated'), { phase: 'inactive' });
  assert.equal(await f.manager.workspaceBlocker(item.path), undefined);
  await f.manager.close();
});
