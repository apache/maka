import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HostProjectDirectoryAuthority } from '../server/project-directory-authority.js';

test('Project directory authority exposes folders without crossing its published root', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-project-directory-'));
  const home = join(base, 'home');
  const project = join(home, 'work', 'project');
  const hidden = join(home, '.hidden');
  const outside = join(base, 'outside');
  const shared = join(outside, 'shared');
  await Promise.all([
    mkdir(project, { recursive: true }),
    mkdir(hidden, { recursive: true }),
    mkdir(shared, { recursive: true }),
  ]);
  await symlink(outside, join(home, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const authority = new HostProjectDirectoryAuthority([
    { label: 'Home', path: home },
    { label: 'Shared', path: outside },
  ]);

  try {
    const roots = await authority.query({ kind: 'directory_roots' });
    assert.equal(roots.kind, 'directory_roots');
    assert.deepEqual(
      roots.roots.map((root) => root.label),
      ['Home', 'Shared'],
    );
    assert.equal(new Set(roots.roots.map((root) => root.id)).size, 2);
    const homeRoot = roots.roots[0];
    const sharedRoot = roots.roots[1];
    assert.ok(homeRoot && sharedRoot);
    assert.deepEqual(
      await authority.query({
        kind: 'directory_list_start',
        rootId: homeRoot.id,
        segments: [],
      }),
      {
        kind: 'directory_page',
        rootId: homeRoot.id,
        segments: [],
        entries: [{ name: '.hidden' }, { name: 'work' }],
        nextCursor: null,
      },
    );
    assert.equal(
      await authority.resolveRegistration({
        rootId: homeRoot.id,
        segments: ['work', 'project'],
      }),
      await realpath(project),
    );
    assert.equal(
      await authority.resolveRegistration({
        rootId: sharedRoot.id,
        segments: ['shared'],
      }),
      await realpath(shared),
    );
    await assert.rejects(
      () => authority.resolveRegistration({ rootId: homeRoot.id, segments: ['escape'] }),
      TypeError,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
