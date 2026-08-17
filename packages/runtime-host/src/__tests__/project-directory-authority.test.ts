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
  await Promise.all([
    mkdir(project, { recursive: true }),
    mkdir(hidden, { recursive: true }),
    mkdir(outside, { recursive: true }),
  ]);
  await symlink(outside, join(home, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const authority = new HostProjectDirectoryAuthority(home);

  try {
    assert.deepEqual(await authority.query({ kind: 'directory_roots' }), {
      kind: 'directory_roots',
      roots: [{ id: 'home' }],
    });
    assert.deepEqual(
      await authority.query({
        kind: 'directory_list_start',
        rootId: 'home',
        segments: [],
      }),
      {
        kind: 'directory_page',
        rootId: 'home',
        segments: [],
        entries: [{ name: 'work' }],
        nextCursor: null,
      },
    );
    assert.equal(
      await authority.resolveRegistration({
        rootId: 'home',
        segments: ['work', 'project'],
      }),
      await realpath(project),
    );
    await assert.rejects(
      () => authority.resolveRegistration({ rootId: 'home', segments: ['escape'] }),
      TypeError,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
