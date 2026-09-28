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
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm as removeTree, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, parse, relative, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';

import {
  createProjectCatalog as createProjectCatalogBase,
  type ProjectCatalog,
  ProjectPathBoundaryError,
  ProjectUnavailableError,
  ProjectPathMismatchError as PathMismatch,
  type ResolvedProjectLocation,
  resolveProjectLocation,
} from '../project-catalog.js';
import { createSessionStore } from '../session-store.js';
import { createGitRepositoryWithWorktree } from './fixtures/git-repository.js';

const execFileAsync = promisify(execFile);
const trackedCatalogs = new Map<ProjectCatalog, string>();

// Every catalog owns a lease on runtime.sqlite. POSIX can unlink that database
// while it is open, but Windows cannot, so test cleanup must release every
// catalog under the temporary root before removing the root itself.
function createProjectCatalog(
  storageRoot: string,
  deps?: Parameters<typeof createProjectCatalogBase>[1],
): ProjectCatalog {
  const catalog = createProjectCatalogBase(storageRoot, deps);
  const close = catalog.close.bind(catalog);
  catalog.close = () => {
    if (!trackedCatalogs.delete(catalog)) return;
    close();
  };
  trackedCatalogs.set(catalog, storageRoot);
  return catalog;
}

async function rm(path: string, options?: Parameters<typeof removeTree>[1]): Promise<void> {
  const removedRoot = resolve(path);
  for (const [catalog, storageRoot] of [...trackedCatalogs].reverse()) {
    const storagePath = resolve(storageRoot);
    const fromRemovedRoot = relative(removedRoot, storagePath);
    if (
      fromRemovedRoot === '' ||
      (!fromRemovedRoot.startsWith('..') && !isAbsolute(fromRemovedRoot))
    ) {
      catalog.close();
    }
  }
  await removeTree(path, options);
}

function sessionInput(cwd: string, projectId: string) {
  return {
    cwd,
    projectId,
    backend: 'fake' as const,
    llmConnectionSlug: 'fake',
    model: 'fake-model',
    permissionMode: 'ask' as const,
  };
}

function createNumberedCatalog(storageRoot: string): ProjectCatalog {
  let nextId = 0;
  return createProjectCatalog(storageRoot, {
    createId: () => `project-${++nextId}`,
    now: () => 1_000,
  });
}
const isRegularFileResolutionFailure = (
  error: unknown,
  canonicalPath: string | undefined,
): boolean =>
  canonicalPath !== undefined &&
  typeof error === 'object' &&
  error !== null &&
  TypeError.prototype.isPrototypeOf(error) &&
  (error as TypeError).message.endsWith(`not a directory: ${canonicalPath}`);

const createRegularFile = async (parent: string) => {
  const file = join(parent, 'project.txt');
  await writeFile(file, 'file, not a folder');
  return Object.freeze({ file, canonical: await realpath(file) });
};

const captureFailure = async (operation: Promise<unknown>): Promise<unknown> =>
  operation.then(
    () => assert.fail('regular file unexpectedly resolved as a Project'),
    (error: unknown) => error,
  );

const withNestedRepository = async (
  label: string,
  run: (layout: {
    base: string;
    nested: readonly [string, string];
    outside: readonly [string, string];
    repository: string;
  }) => Promise<void>,
): Promise<void> => {
  const base = await mkdtemp(join(tmpdir(), `${label}-`));
  const repository = join(base, 'repository');
  const nested = [join(repository, 'nested-a'), join(repository, 'nested-b')] as const;
  const outside = [join(base, 'outside-a'), join(base, 'outside-b')] as const;
  try {
    await Promise.all([...nested, ...outside].map((path) => mkdir(path, { recursive: true })));
    await execFileAsync('git', ['init', '--quiet'], { cwd: repository });
    await run({ base, nested, outside, repository });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
};
const verifyDirectoryAndRegularFilePartition = async (t: TestContext) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-project-path-kind-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const gitRoot = join(base, 'repo');
  await mkdir(gitRoot);
  await execFileAsync('git', ['init', '--quiet'], { cwd: gitRoot });
  const catalog = createProjectCatalog(join(base, 'catalog'));

  const files = await Promise.all([base, gitRoot].map(createRegularFile));
  const resolveFailure = ({ file }: (typeof files)[number]) =>
    captureFailure(resolveProjectLocation({ path: file }));
  const resolutionFailures = await Promise.all(files.map(resolveFailure));
  const failureMatchesPath = (error: unknown, index: number) =>
    isRegularFileResolutionFailure(error, files[index]?.canonical);
  assert.equal(resolutionFailures.every(failureMatchesPath), true);
  await Promise.all(files.map(({ file }) => assert.rejects(catalog.register(file), TypeError)));
  assert.deepEqual(await catalog.list(), []);
  assert.equal((await resolveProjectLocation({ path: gitRoot })).kind, 'git');
};
test(
  'project registration partitions directories from regular files',
  verifyDirectoryAndRegularFilePartition,
);
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
    // Nothing may be recorded: a folder identity written here would outlive the
    // probe failure and permanently split the repository from its worktrees.
    assert.deepEqual(await createProjectCatalog(storage).list(), []);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

const verifyLinkedWorktreeIdentity = async (t: TestContext) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-project-location-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const repository = join(base, 'repository');
  const linkedWorktree = join(base, 'linked');
  await createGitRepositoryWithWorktree(repository, linkedWorktree, 'project-catalog-test');

  const [main, linked] = await Promise.all(
    [repository, linkedWorktree].map((path) => resolveProjectLocation({ path })),
  );

  assert.deepEqual([main.kind, linked.kind], ['git', 'git']);
  assert.equal(main.identity, linked.identity);
  assert.notEqual(main.canonicalPath, linked.canonicalPath);
  assert.deepEqual([main.git?.isWorktree, linked.git?.isWorktree], [false, true]);
};
test(
  'a repository and its linked worktree resolve to one project identity',
  verifyLinkedWorktreeIdentity,
);
const verifySelectionIdentity = async (t: TestContext) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-project-selection-intent-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const repository = join(base, 'repository');
  const linkedWorktree = join(base, 'linked');
  await createGitRepositoryWithWorktree(repository, linkedWorktree, 'selection-intent-test');
  const child = join(linkedWorktree, 'feature');
  await mkdir(child);
  const [selected, historical, worktree, main] = await Promise.all([
    resolveProjectLocation({ path: child, intent: 'selected' }),
    resolveProjectLocation({ path: child }),
    resolveProjectLocation({ path: linkedWorktree, intent: 'selected' }),
    resolveProjectLocation({ path: repository, intent: 'selected' }),
  ]);
  const canonicalChild = await realpath(child);
  assert.deepEqual(selected, {
    canonicalPath: canonicalChild,
    identity: `folder:${canonicalChild}`,
    kind: 'folder',
  });
  assert.deepEqual(
    [historical.kind, historical.identity, worktree.identity],
    ['git', worktree.identity, main.identity],
  );
};
test(
  'selection intent is the only input that splits a nested folder from repository identity',
  verifySelectionIdentity,
);
test('a selected repository subdirectory owns its catalog identity and touch path', async () => {
  await withNestedRepository('maka-selected-subdirectory', async (layout) => {
    const catalog = createNumberedCatalog(join(layout.base, 'storage'));
    const repositoryProject = await catalog.register(layout.repository);
    const nestedProject = await catalog.register(layout.nested[0]);
    const canonicalNested = await realpath(layout.nested[0]);

    assert.notEqual(nestedProject.id, repositoryProject.id);
    assert.equal(nestedProject.name, 'nested-a');
    assert.equal(nestedProject.preferredPath, canonicalNested);
    assert.equal((await catalog.touch(nestedProject.id, canonicalNested)).id, nestedProject.id);
    await assert.rejects(
      () => catalog.touch(nestedProject.id, layout.repository),
      (error: unknown) => error instanceof PathMismatch && error.projectId === nestedProject.id,
    );
  });
});

test('registration validates the final canonical path against its boundary', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-project-boundary-'));
  try {
    const publishedRoot = join(base, 'published');
    const outside = join(base, 'outside');
    await Promise.all([mkdir(publishedRoot), mkdir(outside)]);
    const catalog = createProjectCatalog(join(base, 'storage'));

    await assert.rejects(
      () => catalog.register(outside, { withinRoot: publishedRoot }),
      (error) => error instanceof ProjectPathBoundaryError,
    );
    assert.deepEqual(await catalog.list(), []);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('nested relinks preserve identity and move assigned sessions atomically', async () => {
  await withNestedRepository('maka-nested-relink', async (layout) => {
    const storage = join(layout.base, 'storage');
    const catalog = createNumberedCatalog(storage);
    const sessions = createSessionStore(storage);
    try {
      const repositoryProject = await catalog.register(layout.repository);
      const [plainProject, sessionProject] = await Promise.all(
        layout.outside.map((path) => catalog.register(path)),
      );
      const assigned = await sessions.create(sessionInput(layout.outside[1], sessionProject.id));
      const [plainRelink, sessionRelink] = await Promise.all([
        catalog.relink(plainProject.id, layout.nested[0]),
        catalog.relinkWithSessions(sessionProject.id, layout.nested[1]),
      ]);
      assert.equal(plainRelink.id, plainProject.id);
      assert.equal(plainRelink.preferredPath, await realpath(layout.nested[0]));
      assert.equal(sessionRelink.project.id, sessionProject.id);
      assert.notEqual(sessionRelink.project.id, repositoryProject.id);
      assert.deepEqual(sessionRelink.updatedSessionIds, [assigned.id]);
      const reassigned = await sessions.readHeaderSnapshot(assigned.id);
      assert.equal(reassigned.cwd, await realpath(layout.nested[1]));
      assert.equal(reassigned.projectId, sessionProject.id);
    } finally {
      await sessions.close?.();
    }
  });
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
    let now = 1_000;
    const catalog = createProjectCatalog(join(base, 'storage'), {
      now: () => now,
      createId: () => 'project-1',
    });

    const first = await catalog.register(repository);
    now = 2_000;
    const second = await catalog.register(linkedWorktree);
    const repositoryPath = await realpath(repository);
    const linkedWorktreePath = await realpath(linkedWorktree);
    const expectedPaths = [linkedWorktreePath, repositoryPath].sort();

    assert.equal(first.id, 'project-1');
    assert.equal(first.preferredPath, repositoryPath);
    assert.equal(second.id, first.id);
    assert.equal(second.preferredPath, linkedWorktreePath);
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

test('registering without preference preserves the preferred location until it is touched', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-project-catalog-not-preferred-'));
  try {
    const repository = join(base, 'repository');
    const linkedWorktree = join(base, 'linked');
    await createGitRepositoryWithWorktree(repository, linkedWorktree, 'catalog-not-preferred');
    let now = 1_000;
    const catalog = createProjectCatalog(join(base, 'storage'), {
      now: () => now,
      createId: () => 'project-1',
    });
    const doNotPrefer = { prefer: false } as const;
    const repositoryPath = await realpath(repository);
    const linkedWorktreePath = await realpath(linkedWorktree);

    const first = await catalog.register(repository, doNotPrefer);
    now = 2_000;
    const added = await catalog.register(linkedWorktree, doNotPrefer);
    assert.equal(added.id, first.id);
    assert.equal(added.locations.length, 2);
    assert.equal(added.preferredPath, repositoryPath);

    now = 3_000;
    const registeredAgain = await catalog.register(linkedWorktree, doNotPrefer);
    assert.equal(registeredAgain.preferredPath, repositoryPath);

    now = 4_000;
    const touched = await catalog.touch(first.id, linkedWorktreePath);
    assert.equal(touched.preferredPath, linkedWorktreePath);
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

test('two catalogs changing one project at the same time keep both changes', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-project-concurrent-'));
  try {
    const workspace = join(base, 'workspace');
    const storage = join(base, 'storage');
    await mkdir(workspace);
    const first = createProjectCatalog(storage, { now: () => 1_000 });
    const second = createProjectCatalog(storage, { now: () => 2_000 });
    const project = await first.register(workspace);
    // Each catalog rewrites the whole table; without holding the write lock
    // across its own read, the later writer replays a stale copy and the other
    // window's edit disappears with no error anywhere.
    await Promise.all([second.archive(project.id), first.rename(project.id, 'Renamed')]);

    const [merged] = await first.list();
    assert.equal(merged?.name, 'Renamed', 'the rename must survive the concurrent archive');
    assert.equal(merged?.archivedAt, 2_000, 'the archive must survive the concurrent rename');
    first.close();
    second.close();
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

test('Host relink rolls Project and Session membership back in one transaction', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-project-session-relink-'));
  const storage = join(base, 'storage');
  const originalPath = join(base, 'original');
  const destinationPath = join(base, 'destination');
  await Promise.all([mkdir(originalPath), mkdir(destinationPath)]);
  const injected = new Error('injected atomic relink failure');
  const catalog = createProjectCatalog(storage, {
    createId: (() => {
      let id = 0;
      return () => `project-${++id}`;
    })(),
    relinkFailpoint: () => {
      throw injected;
    },
  });
  const sessions = createSessionStore(storage);
  try {
    const original = await catalog.register(originalPath);
    const duplicate = await catalog.register(destinationPath);
    const originalSession = await sessions.create(sessionInput(originalPath, original.id));
    const duplicateSession = await sessions.create(sessionInput(destinationPath, duplicate.id));

    await assert.rejects(
      () => catalog.relinkWithSessions(original.id, destinationPath),
      (error) => error === injected,
    );

    assert.deepEqual(
      (await catalog.list()).map(({ id }) => id).sort(),
      [original.id, duplicate.id].sort(),
    );
    assert.equal((await sessions.readHeaderSnapshot(originalSession.id)).projectId, original.id);
    assert.equal((await sessions.readHeaderSnapshot(originalSession.id)).cwd, originalPath);
    assert.equal((await sessions.readHeaderSnapshot(duplicateSession.id)).projectId, duplicate.id);
    assert.equal((await sessions.readHeaderSnapshot(duplicateSession.id)).cwd, destinationPath);
  } finally {
    await sessions.close?.();
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

    const { project: relinked } = await catalog.relinkWithSessions(original.id, repository);

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

test('touch reports a Project that disappears before path resolution as unavailable', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-project-touch-missing-'));
  try {
    const path = join(base, 'project');
    await mkdir(path);
    const catalog = createProjectCatalog(join(base, 'storage'));
    const project = await catalog.register(path);
    await removeTree(path, { recursive: true });

    await assert.rejects(
      () => catalog.touch(project.id, path),
      (error) => error instanceof ProjectUnavailableError && error.projectId === project.id,
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
