import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { createProjectCatalog, resolveProjectLocation } from '../project-catalog.js';

const execFileAsync = promisify(execFile);

test('a repository and its linked worktree resolve to one project identity', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-project-location-'));
  try {
    const repository = join(base, 'repository');
    const linkedWorktree = join(base, 'linked');
    await mkdir(repository);
    await execFileAsync('git', ['init', '--quiet'], { cwd: repository });
    await writeFile(join(repository, 'tracked.txt'), 'tracked\n', 'utf8');
    await execFileAsync('git', ['add', 'tracked.txt'], { cwd: repository });
    await execFileAsync(
      'git',
      [
        '-c',
        'user.name=Maka Test',
        '-c',
        'user.email=test@maka.invalid',
        'commit',
        '--quiet',
        '-m',
        'init',
      ],
      { cwd: repository },
    );
    await execFileAsync(
      'git',
      ['worktree', 'add', '--quiet', '-b', 'project-catalog-test', linkedWorktree],
      { cwd: repository },
    );

    const main = await resolveProjectLocation({ path: repository });
    const linked = await resolveProjectLocation({ path: linkedWorktree });

    assert.equal(main.kind, 'git');
    assert.equal(linked.kind, 'git');
    assert.equal(main.identity, linked.identity);
    assert.notEqual(main.canonicalPath, linked.canonicalPath);
    assert.equal(main.git?.isWorktree, false);
    assert.equal(linked.git?.isWorktree, true);
    assert.equal(linked.git?.branch, 'project-catalog-test');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('registering a repository and its linked worktree creates one project with two locations', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-project-catalog-'));
  try {
    const repository = join(base, 'repository');
    const linkedWorktree = join(base, 'linked');
    await mkdir(repository);
    await execFileAsync('git', ['init', '--quiet'], { cwd: repository });
    await writeFile(join(repository, 'tracked.txt'), 'tracked\n', 'utf8');
    await execFileAsync('git', ['add', 'tracked.txt'], { cwd: repository });
    await execFileAsync(
      'git',
      [
        '-c',
        'user.name=Maka Test',
        '-c',
        'user.email=test@maka.invalid',
        'commit',
        '--quiet',
        '-m',
        'init',
      ],
      { cwd: repository },
    );
    await execFileAsync(
      'git',
      ['worktree', 'add', '--quiet', '-b', 'catalog-linked', linkedWorktree],
      { cwd: repository },
    );
    const catalog = createProjectCatalog(join(base, 'storage'), {
      now: () => 1_000,
      createId: () => 'project-1',
    });

    const first = await catalog.register(repository);
    const second = await catalog.register(linkedWorktree);
    const expectedPaths = [await realpath(linkedWorktree), await realpath(repository)].sort();

    assert.equal(first.id, 'project-1');
    assert.equal(second.id, first.id);
    assert.deepEqual(
      (await catalog.list()).map((project) => ({
        id: project.id,
        name: project.name,
        paths: project.locations.map((location) => location.path).sort(),
        worktrees: project.locations.map((location) => location.isWorktree).sort(),
      })),
      [
        {
          id: 'project-1',
          name: 'repository',
          paths: expectedPaths,
          worktrees: [false, true],
        },
      ],
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('archiving a project preserves it with an archive timestamp', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-project-archive-'));
  try {
    const workspace = join(base, 'workspace');
    await mkdir(workspace);
    let now = 1_000;
    const catalog = createProjectCatalog(join(base, 'storage'), {
      now: () => now,
      createId: () => 'project-1',
    });
    const project = await catalog.register(workspace);

    now = 2_000;
    const archived = await catalog.archive(project.id);

    assert.equal(archived.archivedAt, 2_000);
    assert.equal((await catalog.list())[0]?.id, project.id);
    assert.equal((await catalog.list())[0]?.archivedAt, 2_000);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('restoring an archived project makes the same project active again', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-project-restore-'));
  try {
    const workspace = join(base, 'workspace');
    await mkdir(workspace);
    let now = 1_000;
    const catalog = createProjectCatalog(join(base, 'storage'), {
      now: () => now,
      createId: () => 'project-1',
    });
    const project = await catalog.register(workspace);
    now = 2_000;
    await catalog.archive(project.id);

    now = 3_000;
    const restored = await catalog.restore(project.id);

    assert.equal(restored.id, project.id);
    assert.equal(restored.archivedAt, undefined);
    assert.equal(restored.updatedAt, 3_000);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('renaming a project stores the trimmed display name without changing its identity', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-project-rename-'));
  try {
    const workspace = join(base, 'workspace');
    await mkdir(workspace);
    let now = 1_000;
    const catalog = createProjectCatalog(join(base, 'storage'), {
      now: () => now,
      createId: () => 'project-1',
    });
    const project = await catalog.register(workspace);

    now = 2_000;
    const renamed = await catalog.rename(project.id, '  Design System  ');

    assert.equal(renamed.id, project.id);
    assert.equal(renamed.name, 'Design System');
    assert.equal(renamed.updatedAt, 2_000);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a missing project directory remains in the catalog as unavailable', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-project-unavailable-'));
  try {
    const workspace = join(base, 'workspace');
    const storage = join(base, 'storage');
    await mkdir(workspace);
    const catalog = createProjectCatalog(storage, {
      now: () => 1_000,
      createId: () => 'project-1',
    });
    const project = await catalog.register(workspace);
    await rm(workspace, { recursive: true, force: true });

    const restoredCatalog = createProjectCatalog(storage);
    const [unavailable] = await restoredCatalog.list();

    assert.equal(unavailable?.id, project.id);
    assert.equal(unavailable?.available, false);
    assert.equal(unavailable?.preferredPath, undefined);
    assert.equal(unavailable?.locations.length, 1);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('relinking an unavailable project preserves its id and adopts the new directory', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-project-relink-'));
  try {
    const workspace = join(base, 'workspace');
    const relocated = join(base, 'relocated');
    await mkdir(workspace);
    let now = 1_000;
    const catalog = createProjectCatalog(join(base, 'storage'), {
      now: () => now,
      createId: () => 'project-1',
    });
    const project = await catalog.register(workspace);
    await rm(workspace, { recursive: true, force: true });
    await mkdir(relocated);

    now = 2_000;
    const relinked = await catalog.relink(project.id, relocated);

    assert.equal(relinked.id, project.id);
    assert.equal(relinked.available, true);
    assert.equal(relinked.preferredPath, await realpath(relocated));
    assert.deepEqual(
      relinked.locations.map((location) => location.path),
      [await realpath(relocated)],
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('projects are listed by most recent use', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-project-recency-'));
  try {
    const firstPath = join(base, 'first');
    const secondPath = join(base, 'second');
    await mkdir(firstPath);
    await mkdir(secondPath);
    let now = 1_000;
    let id = 0;
    const catalog = createProjectCatalog(join(base, 'storage'), {
      now: () => now,
      createId: () => `project-${++id}`,
    });
    await catalog.register(firstPath);
    now = 2_000;
    await catalog.register(secondPath);

    assert.deepEqual(
      (await catalog.list()).map((project) => project.name),
      ['second', 'first'],
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('touching a project moves it to the front of the recent list', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-project-touch-'));
  try {
    const firstPath = join(base, 'first');
    const secondPath = join(base, 'second');
    await mkdir(firstPath);
    await mkdir(secondPath);
    let now = 1_000;
    let id = 0;
    const catalog = createProjectCatalog(join(base, 'storage'), {
      now: () => now,
      createId: () => `project-${++id}`,
    });
    const first = await catalog.register(firstPath);
    now = 2_000;
    await catalog.register(secondPath);

    now = 3_000;
    await catalog.touch(first.id);

    assert.deepEqual(
      (await catalog.list()).map((project) => project.id),
      [first.id, 'project-2'],
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a malformed project catalog fails closed without overwriting it', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-project-corrupt-'));
  try {
    const workspace = join(base, 'workspace');
    const storage = join(base, 'storage');
    const catalogPath = join(storage, 'projects.json');
    await mkdir(workspace);
    await mkdir(storage);
    const original = '{"schemaVersion":1,"projects":[{}]}\n';
    await writeFile(catalogPath, original, 'utf8');
    const catalog = createProjectCatalog(storage);

    await assert.rejects(() => catalog.register(workspace), /Invalid project catalog/);
    assert.equal(await readFile(catalogPath, 'utf8'), original);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
