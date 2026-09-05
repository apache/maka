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

import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32, posix } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { isPathInside, realpathAllowMissing } from '../path-containment.js';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('isPathInside', () => {
  test('rejects cross-drive Windows targets (different drive is not inside root)', () => {
    // path.win32.relative returns the target unchanged (absolute) when root
    // and target are on different drives; this is the escape vector the helper
    // must close before the `..` check.
    assert.equal(isPathInside('C:\\repo', 'D:\\secret', win32), false);
  });

  test('rejects same-drive Windows targets outside root', () => {
    assert.equal(isPathInside('C:\\repo', 'C:\\other\\secret', win32), false);
  });

  test('allows same-drive Windows targets under root', () => {
    assert.equal(isPathInside('C:\\repo', 'C:\\repo\\sub', win32), true);
    assert.equal(isPathInside('C:\\repo', 'C:\\repo', win32), true);
  });

  test('rejects parent-directory escape on POSIX', () => {
    assert.equal(isPathInside('/repo', '/etc/passwd', posix), false);
  });

  test('allows POSIX targets under root', () => {
    assert.equal(isPathInside('/repo', '/repo/sub', posix), true);
    assert.equal(isPathInside('/repo', '/repo', posix), true);
  });

  test('allows paths whose first segment starts with ".." but is not a parent reference (e.g. ..rules)', () => {
    assert.equal(isPathInside('/repo', '/repo/..rules/AGENTS.md', posix), true);
    assert.equal(isPathInside('C:\\repo', 'C:\\repo\\..rules\\AGENTS.md', win32), true);
  });
});

describe('realpathAllowMissing', () => {
  test('canonicalises an existing path through a symlinked ancestor', async () => {
    const { workspace, link } = await symlinkedWorkspace('maka-realpath-existing-');
    await writeFile(join(workspace, 'file.txt'), 'x', 'utf8');

    assert.equal(await realpathAllowMissing(join(link, 'file.txt')), join(workspace, 'file.txt'));
  });

  test('appends missing trailing segments to the deepest existing ancestor', async () => {
    const { workspace, link } = await symlinkedWorkspace('maka-realpath-missing-');

    assert.equal(
      await realpathAllowMissing(join(link, 'absent', 'nested', 'file.txt')),
      join(workspace, 'absent', 'nested', 'file.txt'),
    );
  });

  test('follows a dangling symlink to its target, which is where a write would land', async () => {
    // realpath fails ENOENT on a link whose target does not exist. Treating it
    // as a plain missing leaf returns the link's own path, which reads as
    // contained while a write through it escapes.
    const { base, workspace, link } = await symlinkedWorkspace('maka-realpath-dangling-');
    const outside = join(base, 'outside');
    await mkdir(outside);
    await symlink(join(outside, 'not-yet.txt'), join(workspace, 'dangling.txt'));

    assert.equal(
      await realpathAllowMissing(join(link, 'dangling.txt')),
      join(outside, 'not-yet.txt'),
    );
  });

  test('follows a chain of dangling links and keeps the segments below them', async () => {
    const { base, workspace, link } = await symlinkedWorkspace('maka-realpath-chain-');
    const outside = join(base, 'outside');
    await mkdir(outside);
    await symlink(join(outside, 'absent-dir'), join(workspace, 'hop-b'));
    await symlink(join(workspace, 'hop-b'), join(workspace, 'hop-a'));

    assert.equal(
      await realpathAllowMissing(join(link, 'hop-a', 'file.txt')),
      join(outside, 'absent-dir', 'file.txt'),
    );
  });

  test('treats a non-directory ancestor as missing rather than throwing ENOTDIR', async () => {
    const { workspace, link } = await symlinkedWorkspace('maka-realpath-notdir-');
    await writeFile(join(workspace, 'file.txt'), 'x', 'utf8');

    assert.equal(
      await realpathAllowMissing(join(link, 'file.txt', 'child')),
      join(workspace, 'file.txt', 'child'),
    );
  });

  test('rejects a pathological dangling chain instead of walking it forever', async () => {
    const { workspace } = await symlinkedWorkspace('maka-realpath-hops-');
    // Every link resolves to the next and only the last one dangles. The kernel
    // caps its own symlink traversal well below this length, so it answers ELOOP
    // before the helper's hop cap can fire; either way the walk must terminate
    // by rejecting rather than by hopping forever.
    const chain = 64;
    await symlink(join(workspace, 'absent'), join(workspace, `hop-${chain}`));
    for (let index = chain; index > 0; index -= 1) {
      await symlink(join(workspace, `hop-${index}`), join(workspace, `hop-${index - 1}`));
    }

    await assert.rejects(realpathAllowMissing(join(workspace, 'hop-0')), /ELOOP|too many/);
  });

  test('propagates a symlink cycle instead of walking forever', async () => {
    const { workspace } = await symlinkedWorkspace('maka-realpath-cycle-');
    await symlink(join(workspace, 'b'), join(workspace, 'a'));
    await symlink(join(workspace, 'a'), join(workspace, 'b'));

    await assert.rejects(realpathAllowMissing(join(workspace, 'a')), { code: 'ELOOP' });
  });
});

async function symlinkedWorkspace(
  prefix: string,
): Promise<{ base: string; workspace: string; link: string }> {
  const base = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  cleanup.push(base);
  const workspace = join(base, 'workspace');
  const link = join(base, 'link-to-workspace');
  await mkdir(workspace);
  await symlink(workspace, link);
  return { base, workspace, link };
}
