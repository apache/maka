import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import {
  createProjectCatalog,
  type ResolvedProjectLocation,
  resolveProjectLocation,
} from '../project-catalog.js';
import { createGitRepositoryWithWorktree } from './fixtures/git-repository.js';

const execFileAsync = promisify(execFile);

test('a plain folder resolves without requiring the Git executable', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-project-folder-no-git-'));
  try {
    const folder = join(base, 'folder');
    await mkdir(folder);

    assert.deepEqual(await resolveProjectLocationWithoutGit(folder), {
      canonicalPath: await realpath(folder),
      identity: `folder:${await realpath(folder)}`,
      kind: 'folder',
    });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a Git probe failure cannot persistently downgrade a repository to a folder', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-project-repository-no-git-'));
  try {
    const repository = join(base, 'repository');
    const storage = join(base, 'storage');
    await mkdir(repository);
    await execFileAsync('git', ['init', '--quiet'], { cwd: repository });

    await assert.rejects(() => registerProjectWithoutGit(repository, storage));
    await assert.rejects(() => readFile(join(storage, 'projects.json')), { code: 'ENOENT' });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a repository and its linked worktree resolve to one project identity', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-project-location-'));
  try {
    const repository = join(base, 'repository');
    const linkedWorktree = join(base, 'linked');
    await createGitRepositoryWithWorktree(repository, linkedWorktree, 'project-catalog-test');

    const main = await resolveProjectLocation({ path: repository });
    const linked = await resolveProjectLocation({ path: linkedWorktree });

    assert.equal(main.kind, 'git');
    assert.equal(linked.kind, 'git');
    assert.equal(main.identity, linked.identity);
    assert.notEqual(main.canonicalPath, linked.canonicalPath);
    assert.equal(main.git?.isWorktree, false);
    assert.equal(linked.git?.isWorktree, true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

async function resolveProjectLocationWithoutGit(path: string): Promise<ResolvedProjectLocation> {
  const stdout = await runProjectCatalogWithoutGit(
    'const [moduleUrl, path] = process.argv.slice(1); const { resolveProjectLocation } = await import(moduleUrl); console.log(JSON.stringify(await resolveProjectLocation({ path })));',
    path,
  );
  return JSON.parse(stdout) as ResolvedProjectLocation;
}

async function registerProjectWithoutGit(path: string, storage: string): Promise<void> {
  await runProjectCatalogWithoutGit(
    'const [moduleUrl, path, storage] = process.argv.slice(1); const { createProjectCatalog } = await import(moduleUrl); await createProjectCatalog(storage).register(path);',
    path,
    storage,
  );
}

async function runProjectCatalogWithoutGit(source: string, ...args: string[]): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: '' };
  delete env.Path;
  const moduleUrl = new URL('../project-catalog.js', import.meta.url).href;
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--input-type=module', '-e', source, moduleUrl, ...args],
    { env, encoding: 'utf8' },
  );
  return stdout;
}

test('registering a repository and its linked worktree creates one project with two locations', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-project-catalog-'));
  try {
    const repository = join(base, 'repository');
    const linkedWorktree = join(base, 'linked');
    await createGitRepositoryWithWorktree(repository, linkedWorktree, 'catalog-linked');
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

test('conflicting relink waits for a retryable merge before removing the duplicate project', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-project-relink-merge-'));
  try {
    const relocated = join(base, 'relocated');
    await mkdir(relocated);
    let id = 0;
    const catalog = createProjectCatalog(join(base, 'storage'), {
      now: () => 1_000,
      createId: () => `project-${++id}`,
    });
    const originalPath = join(base, 'original');
    await mkdir(originalPath);
    const original = await catalog.register(originalPath);
    await rm(originalPath, { recursive: true, force: true });
    const duplicate = await catalog.register(relocated);
    const interrupted = new Error('session reassignment interrupted');

    await assert.rejects(
      () =>
        catalog.relink(original.id, relocated, async () => {
          throw interrupted;
        }),
      (error) => error === interrupted,
    );
    assert.deepEqual(
      (await catalog.list()).map((project) => project.id).sort(),
      [original.id, duplicate.id].sort(),
    );

    let mergedProjectId: string | undefined;
    const merged = await catalog.relink(original.id, relocated, async (context) => {
      mergedProjectId = context.conflictingProjectId;
    });

    assert.equal(mergedProjectId, duplicate.id);
    assert.equal(merged.id, original.id);
    assert.equal(merged.name, original.name);
    assert.deepEqual((merged as typeof merged & { aliases?: string[] }).aliases, [duplicate.id]);
    assert.deepEqual(
      (await catalog.list()).map((project) => project.id),
      [original.id],
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('conflicting relink preserves every available worktree location from the merged project', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-project-relink-worktrees-'));
  try {
    const repository = join(base, 'repository');
    const linkedWorktree = join(base, 'linked');
    await createGitRepositoryWithWorktree(repository, linkedWorktree, 'relink-linked');
    let id = 0;
    const catalog = createProjectCatalog(join(base, 'storage'), {
      now: () => 1_000,
      createId: () => `project-${++id}`,
    });
    const originalPath = join(base, 'original');
    await mkdir(originalPath);
    const original = await catalog.register(originalPath);
    await rm(originalPath, { recursive: true, force: true });
    await catalog.register(repository);
    await catalog.register(linkedWorktree);

    const relinked = await catalog.relink(original.id, repository, async () => {});

    assert.deepEqual(
      relinked.locations.map((location) => location.path).sort(),
      [await realpath(repository), await realpath(linkedWorktree)].sort(),
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

test('selecting a project returns its most recent available location and rejects inactive projects', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-project-select-'));
  try {
    const availablePath = join(base, 'available');
    const missingPath = join(base, 'missing');
    await mkdir(availablePath);
    let now = 1_000;
    let id = 0;
    const catalog = createProjectCatalog(join(base, 'storage'), {
      now: () => now,
      createId: () => `project-${++id}`,
    });
    const available = await catalog.register(availablePath);
    await mkdir(missingPath);
    const missing = await catalog.register(missingPath);
    await rm(missingPath, { recursive: true, force: true });

    now = 2_000;
    const selected = await catalog.select(available.id);
    assert.equal(selected.path, await realpath(availablePath));
    assert.equal(selected.project.id, available.id);

    await assert.rejects(() => catalog.select(missing.id), /unavailable/i);
    await catalog.archive(available.id);
    await assert.rejects(() => catalog.select(available.id), /archived/i);
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

test('registering a filesystem root writes a project that a fresh catalog can read', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-project-root-'));
  const storage = join(base, 'storage');
  try {
    const root = parse(base).root;
    const catalog = createProjectCatalog(storage, {
      createId: () => 'project-root',
    });

    const project = await catalog.register(root);
    const reopened = createProjectCatalog(storage);

    assert.ok(project.name.length > 0);
    assert.equal((await reopened.list())[0]?.id, project.id);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('catalog validates generated state before publishing it', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-project-write-validation-'));
  const workspace = join(base, 'workspace');
  await mkdir(workspace);
  try {
    const catalog = createProjectCatalog(join(base, 'storage'), {
      createId: () => '',
    });

    await assert.rejects(() => catalog.register(workspace), /Invalid project catalog/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
