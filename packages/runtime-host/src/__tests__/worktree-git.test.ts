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
import { waitFor, withTimeout } from '@maka/core/test-only/async-primitives';
import { git } from '../server/worktree-git.js';
import { fixture, testScript } from './worktree-fixture.js';

test('Git timeout can be overridden or disabled', async (t) => {
  const f = await fixture(t);
  t.after(() => f.manager.close());
  const command = await testScript(
    f.root,
    "setTimeout(() => process.stdout.write('finished'), 300);",
  );
  await f.git('config', 'alias.delayed', `!${command}`);
  await assert.rejects(git(f.repo, ['delayed'], { timeoutMs: 100 }), { killed: true });
  await assert.rejects(
    git(f.repo, ['delayed'], {
      timeoutMs: 100,
      abortSignal: new AbortController().signal,
    }),
    { killed: true },
  );
  assert.equal(await git(f.repo, ['delayed'], { timeoutMs: 0 }), 'finished');
});

async function configureSmudge(f: Awaited<ReturnType<typeof fixture>>, script: string) {
  await writeFile(join(f.repo, '.gitattributes'), 'tracked.txt filter=slow\n');
  await f.git('add', '.gitattributes');
  await f.git('commit', '-m', 'Add smudge filter');
  await f.git('config', 'filter.slow.smudge', await testScript(f.root, script));
  await f.git('config', 'filter.slow.required', 'true');
}

test('worktree checkout can exceed the query timeout', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t, 'slow-checkout');
  t.after(() => f.manager.close());
  await configureSmudge(
    f,
    "const input = require('node:fs').readFileSync(0); setTimeout(() => process.stdout.write(input), 31_000);",
  );
  const worktree = await f.create();
  assert.equal(worktree.initialization, 'ready');
  assert.equal(await readFile(join(worktree.path, 'tracked.txt'), 'utf8'), 'committed\n');
});

for (const decision of ['main', 'cancel', 'shutdown'] as const) {
  test(`slow checkout terminates its filter on ${decision}`, { timeout: 20_000 }, async (t) => {
    const f = await fixture(t, 'cancel-checkout');
    t.after(() => f.manager.close());
    const marker = join(f.root, 'filter.pid');
    await configureSmudge(
      f,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);`,
    );
    const creating = f.manager.prepareTask(f.project.id, { kind: 'new' }, 'slow', 'Task');
    // Observe rejection immediately, including when the Host drains.
    const outcome = creating.then(
      (target) => ({ target }),
      (error: unknown) => ({ error }),
    );
    await waitFor(async () => !!(await readFile(marker, 'utf8').catch(() => '')), {
      timeoutMs: 5000,
      pollMs: 20,
      message: 'Smudge filter did not start',
    });
    const pid = Number(await readFile(marker, 'utf8'));
    if (decision === 'shutdown') f.manager.beginDrain();
    else
      await f.manager.mutate({
        kind: 'resolve_preparation',
        projectId: f.project.id,
        operationId: 'slow',
        decision,
      });
    const result = await withTimeout(outcome, 5000, 'Preparation did not settle');
    if (decision === 'main')
      assert.deepEqual(result, {
        target: { kind: 'project', projectId: f.project.id },
      });
    else assert.ok('error' in result);
    await withTimeout(f.manager.close(), 5000, 'Checkout lane did not drain');
    await waitFor(
      () => {
        try {
          process.kill(pid, 0);
          return false;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
          throw error;
        }
      },
      { timeoutMs: 3000, pollMs: 20, message: 'Smudge filter survived cancellation' },
    );
  });
}
