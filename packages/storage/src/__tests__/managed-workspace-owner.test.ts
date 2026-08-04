import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { afterEach, before, test } from 'node:test';
import {
  ManagedWorkspaceOwnerError,
  openManagedWorkspaceOwner,
} from '../managed-workspace-owner.js';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '../root-authority.js';
import { createSqliteRuntimeStore } from '../sqlite-runtime-store.js';

const execFileAsync = promisify(execFile);
const cleanup: string[] = [];
let gitExecutablePath: string;
let gitExecutableSha256: `sha256:${string}`;

before(async () => {
  gitExecutablePath = await findGitExecutable();
  gitExecutableSha256 = await sha256File(gitExecutablePath);
});

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test('admits exactly one managed workspace owner for an interactive root owner', async () => {
  const storageRoot = await temporaryRoot();
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  try {
    const managedOwner = await openManagedWorkspaceOwner({
      rootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
    });

    await assert.rejects(
      openManagedWorkspaceOwner({
        rootOwner,
        gitRuntime: {
          executablePath: gitExecutablePath,
          expectedSha256: gitExecutableSha256,
        },
      }),
      isOwnerError('managed_workspace_owner_conflict'),
    );
    await managedOwner.close();
    await managedOwner.close();
  } finally {
    await rootOwner.close();
  }
});

test('releases a partial owner claim when pinned Git initialization fails', async () => {
  const storageRoot = await temporaryRoot();
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  try {
    await assert.rejects(
      openManagedWorkspaceOwner({
        rootOwner,
        gitRuntime: {
          executablePath: gitExecutablePath,
          expectedSha256: `sha256:${'0'.repeat(64)}`,
        },
      }),
      isOwnerError('managed_workspace_owner_unavailable'),
    );

    const retry = await openManagedWorkspaceOwner({
      rootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
    });
    assert.equal(retry.state, 'ready');
    await retry.close();
  } finally {
    await rootOwner.close();
  }
});

test('creates an accepted managed baseline only through the active owner', async () => {
  const root = await temporaryRoot();
  const storageRoot = join(root, 'storage');
  const sourceRoot = await createEligibleSource(join(root, 'source'));
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  const runtimeStore = createSqliteRuntimeStore(join(storageRoot, 'runtime.sqlite'));
  try {
    const owner = await openManagedWorkspaceOwner({
      rootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
    });

    const { binding } = await owner.openManagedWorkspaceBaseline(
      runtimeStore,
      openRequest(sourceRoot),
    );

    assert.equal(binding.sourceTreeOid, binding.baselineTreeOid);
    assert.equal(existsSync(join(binding.worktreePath, '.maka-workspace.json')), false);
    await owner.close();
  } finally {
    runtimeStore.close();
    await rootOwner.close();
  }
});

test('drains an admitted workspace operation before closing and rejects new work', async () => {
  const root = await temporaryRoot();
  const storageRoot = join(root, 'storage');
  const sourceRoot = await createEligibleSource(join(root, 'source'));
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  const runtimeStore = createSqliteRuntimeStore(join(storageRoot, 'runtime.sqlite'));
  let releaseOperation!: () => void;
  const operationMayFinish = new Promise<void>((resolve) => {
    releaseOperation = resolve;
  });
  let operationAdmitted!: () => void;
  const operationReachedFailpoint = new Promise<void>((resolve) => {
    operationAdmitted = resolve;
  });
  let creating:
    | ReturnType<
        Awaited<ReturnType<typeof openManagedWorkspaceOwner>>['openManagedWorkspaceBaseline']
      >
    | undefined;
  let closing: Promise<void> | undefined;
  let rootClosing: Promise<void> | undefined;
  try {
    const owner = await openManagedWorkspaceOwner({
      rootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
      failpoint: async (point) => {
        if (point !== 'after_worktree_materialized') return;
        operationAdmitted();
        await operationMayFinish;
      },
    });
    creating = owner.openManagedWorkspaceBaseline(runtimeStore, openRequest(sourceRoot));
    await operationReachedFailpoint;

    let closeSettled = false;
    closing = owner.close().then(() => {
      closeSettled = true;
    });
    let rootCloseSettled = false;
    rootClosing = rootOwner.close().then(() => {
      rootCloseSettled = true;
    });
    const rootCloseDisposition = await Promise.race([
      rootClosing.then(() => 'closed' as const),
      delay(250, 'pending' as const),
    ]);

    assert.equal(owner.state, 'closing');
    assert.equal(closeSettled, false);
    assert.equal(rootCloseSettled, false);
    assert.equal(rootCloseDisposition, 'pending');
    await assert.rejects(
      owner.openManagedWorkspaceBaseline(runtimeStore, openRequest(sourceRoot)),
      isOwnerError('managed_workspace_owner_closing'),
    );

    releaseOperation();
    await creating;
    await closing;
    await rootClosing;
    assert.equal(owner.state, 'closed');
  } finally {
    releaseOperation();
    await Promise.allSettled(
      [creating, closing, rootClosing].filter((value) => value !== undefined),
    );
    runtimeStore.close();
    await rootOwner.close();
  }
});

test('rejects external drift instead of reopening a non-ready workspace', async () => {
  const root = await temporaryRoot();
  const storageRoot = join(root, 'storage');
  const sourceRoot = await createEligibleSource(join(root, 'source'));
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  const runtimeStore = createSqliteRuntimeStore(join(storageRoot, 'runtime.sqlite'));
  try {
    const owner = await openManagedWorkspaceOwner({
      rootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
    });
    const { binding } = await owner.openManagedWorkspaceBaseline(
      runtimeStore,
      openRequest(sourceRoot),
    );
    await writeFile(join(binding.worktreePath, 'tracked.txt'), 'external drift\n', 'utf8');

    await assert.rejects(
      owner.openManagedWorkspaceBaseline(runtimeStore, openRequest(sourceRoot)),
      (error: unknown) =>
        error instanceof Error &&
        error.name === 'GitWorkspaceServiceError' &&
        'code' in error &&
        error.code === 'managed_workspace_drifted',
    );

    assert.equal(existsSync(binding.worktreePath), true);
    await owner.close();
  } finally {
    runtimeStore.close();
    await rootOwner.close();
  }
});

function isOwnerError(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ManagedWorkspaceOwnerError && error.code === code;
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'maka-managed-workspace-owner-'));
  cleanup.push(root);
  return root;
}

async function findGitExecutable(): Promise<string> {
  const command = process.platform === 'win32' ? 'where.exe' : 'which';
  const { stdout } = await execFileAsync(command, ['git'], { encoding: 'utf8' });
  const first = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
  if (!first) throw new Error('Git executable is unavailable for integration tests');
  return realpath(first);
}

async function sha256File(path: string): Promise<`sha256:${string}`> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
}

async function createEligibleSource(sourceRoot: string): Promise<string> {
  await mkdir(sourceRoot, { recursive: true });
  await git(sourceRoot, 'init', '--quiet');
  await writeFile(join(sourceRoot, 'tracked.txt'), 'tracked\n', 'utf8');
  await writeFile(join(sourceRoot, '.gitignore'), '.maka-workspace.json\n', 'utf8');
  await writeFile(join(sourceRoot, '.maka-workspace.json'), '{"host":"metadata"}\n', 'utf8');
  await git(sourceRoot, 'add', 'tracked.txt', '.gitignore');
  await git(
    sourceRoot,
    '-c',
    'user.name=Maka Test',
    '-c',
    'user.email=test@maka.invalid',
    'commit',
    '--quiet',
    '-m',
    'source baseline',
  );
  return realpath(sourceRoot);
}

function openRequest(sourceRoot: string) {
  return {
    repositoryId: 'repository_11111111111111111111111111111111',
    workspaceId: 'workspace_22222222222222222222222222222222',
    workspaceEpochId: 'epoch_33333333333333333333333333333333',
    workspaceInstanceId: 'instance_44444444444444444444444444444444',
    sourceRoot,
  } as const;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.trim();
}
