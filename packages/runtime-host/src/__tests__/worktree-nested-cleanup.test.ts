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
import { promisify } from 'node:util';
import { access, readFile, symlink, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { deferred, waitFor, withTimeout } from '@maka/core/test-only/async-primitives';
import { fixture, testScript } from './worktree-fixture.js';

for (const contents of [
  'uncommitted files',
  'unretained detached commits',
  'clean files',
] as const) {
  test(`cleanup preserves an ignored nested managed checkout with ${contents}`, async (t) => {
    const f = await fixture(t, 'nested-checkout');
    t.after(() => f.manager.close());
    await writeFile(join(f.repo, '.gitignore'), 'nested/\n');
    await f.git('add', '.gitignore');
    await f.git('commit', '-m', 'ignore nested checkouts');
    const parent = await f.create('parent');
    await f.manager.mutate({
      kind: 'configure',
      config: { rootDirectory: join(parent.path, 'nested') },
    });
    f.options.generateName = async () => undefined;
    const child = await f.create('child');
    if (contents !== 'clean files') {
      await writeFile(join(child.path, 'uncommitted.txt'), 'keep this work\n');
      if (contents === 'unretained detached commits') {
        await exec('git', ['-C', child.path, 'add', '.']);
        await exec('git', ['-C', child.path, 'commit', '-m', 'detached child work']);
      }
    }

    await assert.rejects(
      f.manager.mutate({ kind: 'remove', projectId: f.project.id, path: parent.path }),
      /nested.*(?:repository|worktree|checkout)/i,
    );
    if (contents !== 'clean files')
      assert.equal(await readFile(join(child.path, 'uncommitted.txt'), 'utf8'), 'keep this work\n');
    await f.manager.assertReady('child-session', child.path);
  });
}

const exec = promisify(execFile);
for (const kind of ['external-worktree', 'repository', 'bare-repository'] as const) {
  test(`cleanup preserves an ignored nested ${kind}`, async (t) => {
    const f = await fixture(t, 'nested-checkout');
    t.after(() => f.manager.close());
    await writeFile(join(f.repo, '.gitignore'), 'nested/\n');
    await f.git('add', '.gitignore');
    await f.git('commit', '-m', 'ignore nested checkouts');
    const parent = await f.create('parent');
    const child = join(parent.path, 'nested');
    if (kind === 'external-worktree') await f.git('worktree', 'add', '--detach', child);
    else
      await exec('git', [
        'clone',
        ...(kind === 'bare-repository' ? ['--bare'] : []),
        f.repo,
        child,
      ]);

    await assert.rejects(
      f.manager.mutate({ kind: 'remove', projectId: f.project.id, path: parent.path }),
      /nested.*(?:repository|worktree|checkout)/i,
    );
    assert.equal(
      (await exec('git', ['-C', child, 'rev-parse', 'HEAD'])).stdout.trim(),
      parent.head,
    );
  });
}

test('a delayed nested creation cannot resurrect a removed parent through a symlink root', async (t) => {
  const f = await fixture(t, 'nested-checkout');
  t.after(() => f.manager.close());
  const parent = await f.create('parent');
  const linkedRoot = join(f.root, 'root-link');
  await symlink(f.root, linkedRoot, 'junction');
  const linkedParent = join(linkedRoot, relative(f.root, parent.path));
  await f.manager.mutate({
    kind: 'configure',
    config: { rootDirectory: join(linkedParent, 'nested') },
  });
  const naming = deferred<void>();
  const release = deferred<void>();
  f.options.generateName = async () => {
    naming.resolve();
    await release.promise;
    return { type: 'feat', slug: 'child' };
  };
  const creating = f.create('child');
  const rejected = assert.rejects(creating, /removed|unavailable|identity/i);
  try {
    await withTimeout(naming.promise, 3000, 'Creation never reached naming');
    assert.equal(
      (await f.manager.mutate({ kind: 'remove', projectId: f.project.id, path: parent.path })).kind,
      'removed',
    );
  } finally {
    release.resolve();
    await rejected;
  }
  await assert.rejects(access(parent.path), { code: 'ENOENT' });
});

test('a missing nested checkout does not prevent parent cleanup or resurrect it on replay', async (t) => {
  const f = await fixture(t, 'nested-checkout');
  t.after(() => f.manager.close());
  await writeFile(join(f.repo, '.gitignore'), 'nested/\n');
  await f.git('add', '.gitignore');
  await f.git('commit', '-m', 'ignore nested checkouts');
  const parent = await f.create('parent');
  await f.manager.mutate({
    kind: 'configure',
    config: { rootDirectory: join(parent.path, 'nested') },
  });
  const child = await f.create('child');
  await f.git('worktree', 'remove', child.path);
  assert.equal(
    (await f.manager.mutate({ kind: 'remove', projectId: f.project.id, path: parent.path })).kind,
    'removed',
  );
  await assert.rejects(f.create('child'), /removed|unavailable|identity/i);
  await assert.rejects(access(parent.path), { code: 'ENOENT' });
});

test('cleanup unlinks ignored directory symlinks without scanning or deleting their targets', async (t) => {
  const f = await fixture(t, 'nested-checkout');
  t.after(() => f.manager.close());
  await writeFile(join(f.repo, '.gitignore'), 'nested/\nnested\n');
  await f.git('add', '.gitignore');
  await f.git('commit', '-m', 'ignore nested links');
  const parent = await f.create('parent');
  await symlink(f.repo, join(parent.path, 'nested'), 'junction');
  assert.equal(
    (await f.manager.mutate({ kind: 'remove', projectId: f.project.id, path: parent.path })).kind,
    'removed',
  );
  assert.equal(await f.git('rev-parse', 'HEAD'), parent.head);
});

test('an uncreated nested reservation does not prevent parent cleanup or resurrect it on retry', async (t) => {
  const f = await fixture(t, 'nested-checkout');
  t.after(() => f.manager.close());
  await writeFile(join(f.repo, '.gitignore'), 'nested/\n');
  await writeFile(join(f.repo, '.gitattributes'), 'tracked.txt filter=broken\n');
  await f.git('add', '.');
  await f.git('commit', '-m', 'configure filter and ignore nested checkouts');
  const parent = await f.create('parent');
  await f.manager.mutate({
    kind: 'configure',
    config: { rootDirectory: join(parent.path, 'nested') },
  });
  await f.git('config', 'filter.broken.smudge', 'false');
  await f.git('config', 'filter.broken.required', 'true');
  await assert.rejects(f.create('child'), /smudge filter.*failed/);
  await f.git('config', 'filter.broken.smudge', 'cat');
  await f.git('config', 'filter.broken.clean', 'cat');
  assert.equal(
    (await f.manager.mutate({ kind: 'remove', projectId: f.project.id, path: parent.path })).kind,
    'removed',
  );
  await assert.rejects(f.create('child'), /removed|unavailable|identity/i);
  await assert.rejects(access(parent.path), { code: 'ENOENT' });
});

test('nested creation waits for parent cleanup and cannot create inside the removed checkout', {
  timeout: 15_000,
}, async (t) => {
  const f = await fixture(t, 'nested-checkout');
  t.after(() => f.manager.close());
  await writeFile(join(f.repo, '.gitignore'), 'nested/\n');
  await f.git('add', '.gitignore');
  await f.git('commit', '-m', 'ignore nested checkouts');
  const parent = await f.create('parent');
  const marker = join(f.root, 'cleaning');
  const release = join(f.root, 'release-cleanup');
  await f.manager.mutate({
    kind: 'configure',
    config: { rootDirectory: join(parent.path, 'nested') },
  });
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
  const removing = f.manager.mutate({ kind: 'remove', projectId: f.project.id, path: parent.path });
  let creating: Promise<void> | undefined;
  try {
    await waitFor(
      () =>
        access(marker).then(
          () => true,
          () => false,
        ),
      { timeoutMs: 5000, pollMs: 10 },
    );
    const naming = deferred<void>();
    f.options.generateName = async () => {
      naming.resolve();
      return { type: 'feat', slug: 'child' };
    };
    creating = assert.rejects(f.create('child'), /removed|unavailable|identity/i);
    await withTimeout(naming.promise, 3000, 'Nested creation never reached naming');
    await withTimeout(
      f.manager.bind('unrelated', f.repo),
      3000,
      'Cleanup blocked an unrelated workspace',
    );
  } finally {
    await writeFile(release, 'continue');
    assert.equal((await removing).kind, 'removed');
    await creating;
  }
  await assert.rejects(access(parent.path), { code: 'ENOENT' });
});
