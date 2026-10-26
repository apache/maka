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
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { deferred, withTimeout } from '@maka/core/test-only/async-primitives';
import { HostWorktreeManager } from '../server/worktree-manager.js';
import { fixture } from './worktree-fixture.js';

for (const id of ['constructor', '__proto__']) {
  test(`preparation decision for ${id} remains durable after restart`, async (t) => {
    const f = await fixture(t);
    const naming = deferred<void>();
    const release = deferred<void>();
    f.options.generateName = async () => {
      naming.resolve();
      await release.promise;
      return undefined;
    };
    const preparing = f.manager.prepareTask(f.project.id, { kind: 'new' }, id, 'Task');
    const outcome = preparing.catch((error: unknown) => error);
    try {
      await withTimeout(naming.promise, 3000, 'Preparation did not reach naming');
      await f.manager.mutate({
        kind: 'resolve_preparation',
        projectId: f.project.id,
        operationId: id,
        decision: 'main',
      });
      assert.deepEqual(await outcome, { kind: 'project', projectId: f.project.id });
    } finally {
      release.resolve();
      await f.manager.close();
      await outcome;
    }
    const restarted = new HostWorktreeManager(f.options);
    t.after(() => restarted.close());
    assert.deepEqual(await restarted.prepareTask(f.project.id, { kind: 'new' }, id, 'Task'), {
      kind: 'project',
      projectId: f.project.id,
    });
    assert.deepEqual((await restarted.snapshot()).projects[0]?.worktrees, []);
  });

  for (const restartBeforeOperation of [false, true]) {
    test(`protocol identity ${id} works ${restartBeforeOperation ? 'after restart' : 'on a new Host'}`, async (t) => {
      const f = await fixture(t, 'identity-checkout');
      const manager = restartBeforeOperation ? new HostWorktreeManager(f.options) : f.manager;
      t.after(() => manager.close());

      assert.equal(await manager.isBound(id), false);
      const target = await manager.prepareTask(f.project.id, { kind: 'new' }, id, 'Task');
      assert.equal(target.kind, 'project');
      assert.ok('worktreePath' in target && target.worktreePath);
      const path = target.worktreePath;
      await manager.bind(id, path);
      await manager.assertReady(id, path);
      assert.equal(await manager.isBound(id), true);
      await manager.close();

      const stored = JSON.parse(
        await readFile(join(f.options.stateRoot, 'worktrees.json'), 'utf8'),
      );
      assert.equal(Object.hasOwn(stored.bindings, id), true);
      assert.equal(stored.bindings[id].path, path);
      const restarted = new HostWorktreeManager(f.options);
      t.after(() => restarted.close());
      assert.equal(await restarted.isBound(id), true);
      await restarted.assertReady(id, path);
      await assert.rejects(restarted.bind(id, f.repo), /bindings cannot be changed/);
    });
  }
}
