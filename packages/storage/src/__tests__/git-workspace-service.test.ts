import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  GitWorkspaceServiceError,
  createGitWorkspaceService,
  type GitWorkspaceService,
  type ManagedWorkspaceBinding,
} from '../git-workspace-service.js';

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

describe('Git workspace service', () => {
  test('fails before creating storage when the explicit Git artifact digest is wrong', async () => {
    const root = await temporaryRoot();
    const storageRoot = join(root, 'storage');
    const sourceRoot = await createEligibleSource(join(root, 'source'));
    const service = createGitWorkspaceService({
      storageRoot,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: `sha256:${'0'.repeat(64)}`,
      },
    });

    await assert.rejects(
      service.openManagedWorkspace(openRequest(sourceRoot)),
      isWorkspaceError('git_runtime_integrity_mismatch'),
    );
    assert.equal(existsSync(storageRoot), false);
  });

  test('imports only the clean source HEAD tree into an independent fixed-config workspace', async () => {
    const root = await temporaryRoot();
    const sourceRoot = await createEligibleSource(join(root, 'source'));
    const sourceSnapshot = await snapshotSource(sourceRoot);
    const service = await serviceAt(join(root, 'storage'));

    const binding = await service.openManagedWorkspace(openRequest(sourceRoot));
    const inspection = await service.inspectManagedWorkspace(binding);

    assert.equal(inspection.state, 'ready');
    assert.equal(inspection.commitOid, binding.baselineCommitOid);
    assert.equal(inspection.treeOid, binding.baselineTreeOid);
    assert.equal(binding.sourceHeadCommitOid, sourceSnapshot.head);
    assert.equal(binding.sourceTreeOid, sourceSnapshot.tree);
    assert.equal(binding.baselineTreeOid, sourceSnapshot.tree);
    assert.match(binding.materializationProfileDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.notEqual(normalize(binding.repositoryPath), normalize(sourceSnapshot.commonDir));
    assert.equal(await readFile(join(binding.worktreePath, 'tracked.txt'), 'utf8'), 'tracked\n');
    assert.equal(existsSync(join(binding.worktreePath, 'ignored.env')), false);
    assert.equal(existsSync(join(binding.worktreePath, '.maka-workspace.json')), false);
    assert.equal(await git(binding.worktreePath, 'status', '--porcelain=v1'), '');
    assert.equal(
      await gitBare(
        binding.repositoryPath,
        'rev-list',
        '--parents',
        '-n',
        '1',
        binding.baselineCommitOid,
      ),
      binding.baselineCommitOid,
    );
    assert.equal(
      await gitBare(binding.repositoryPath, 'config', '--local', '--get', 'core.autocrlf'),
      'false',
    );
    assert.equal(
      await gitBare(binding.repositoryPath, 'config', '--local', '--get', 'core.hooksPath'),
      binding.hooksPath,
    );
    assert.equal(existsSync(join(binding.repositoryPath, 'objects', 'info', 'alternates')), false);
    await assert.rejects(gitBare(binding.repositoryPath, 'cat-file', '-e', sourceSnapshot.head));
    await assertSourceUnchanged(sourceRoot, sourceSnapshot);
  });

  test('adopts the same binding across service restart and concurrent duplicate opens', async () => {
    const root = await temporaryRoot();
    const sourceRoot = await createEligibleSource(join(root, 'source'));
    const storageRoot = join(root, 'storage');
    const request = openRequest(sourceRoot);
    const firstService = await serviceAt(storageRoot);
    const [left, right] = await Promise.all([
      firstService.openManagedWorkspace(request),
      firstService.openManagedWorkspace(request),
    ]);
    const restarted = await serviceAt(storageRoot);
    const adopted = await restarted.openManagedWorkspace(request);

    assert.deepEqual(right, left);
    assert.deepEqual(adopted, left);
    assert.equal((await restarted.inspectManagedWorkspace(adopted)).state, 'ready');
  });

  test('repairs a real-process crash after worktree materialization without accepting residue', {
    timeout: 60_000,
  }, async () => {
    const root = await temporaryRoot();
    const sourceRoot = await createEligibleSource(join(root, 'source'));
    const sourceSnapshot = await snapshotSource(sourceRoot);
    const storageRoot = join(root, 'storage');
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('./fixtures/git-workspace-service-crash-child.js', import.meta.url))],
      {
        env: {
          ...process.env,
          MAKA_GIT_WORKSPACE_STORAGE: storageRoot,
          MAKA_GIT_WORKSPACE_SOURCE: sourceRoot,
          MAKA_GIT_WORKSPACE_EXECUTABLE: gitExecutablePath,
          MAKA_GIT_WORKSPACE_SHA256: gitExecutableSha256,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    try {
      await waitForReady(child, 30_000);
      child.kill('SIGKILL');
      await waitForExit(child);

      const service = await serviceAt(storageRoot);
      const binding = await service.openManagedWorkspace(openRequest(sourceRoot));
      assert.equal((await service.inspectManagedWorkspace(binding)).state, 'ready');
      const quarantineEntries = await readdir(
        join(storageRoot, 'managed-workspaces', 'quarantine'),
      );
      assert.ok(quarantineEntries.some((entry) => entry.startsWith('incomplete-')));
      await assertSourceUnchanged(sourceRoot, sourceSnapshot);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });

  test('rejects dirty or unsupported source state without falling back to attached execution', async () => {
    const root = await temporaryRoot();
    const sourceRoot = await createEligibleSource(join(root, 'source'));
    await writeFile(join(sourceRoot, 'untracked.txt'), 'not committed\n', 'utf8');
    const service = await serviceAt(join(root, 'storage'));

    await assert.rejects(
      service.openManagedWorkspace(openRequest(sourceRoot)),
      isWorkspaceError('repository_ineligible'),
    );
  });

  test('rejects nested attributes that could change fixed Git materialization', async () => {
    const root = await temporaryRoot();
    const sourceRoot = await createEligibleSource(join(root, 'source'));
    await mkdir(join(sourceRoot, 'nested'));
    await writeFile(join(sourceRoot, 'nested', '.gitattributes'), '*.txt filter=custom\n', 'utf8');
    await git(sourceRoot, 'add', 'nested/.gitattributes');
    await git(
      sourceRoot,
      '-c',
      'user.name=Maka Test',
      '-c',
      'user.email=test@maka.invalid',
      'commit',
      '--quiet',
      '-m',
      'unsupported attributes',
    );
    const service = await serviceAt(join(root, 'storage'));

    await assert.rejects(
      service.openManagedWorkspace(openRequest(sourceRoot)),
      isWorkspaceError('repository_ineligible'),
    );
  });

  test('detects external managed-worktree drift and quarantines it without touching source', async () => {
    const root = await temporaryRoot();
    const sourceRoot = await createEligibleSource(join(root, 'source'));
    const sourceSnapshot = await snapshotSource(sourceRoot);
    const service = await serviceAt(join(root, 'storage'));
    const binding = await service.openManagedWorkspace(openRequest(sourceRoot));
    await writeFile(join(binding.worktreePath, 'tracked.txt'), 'external writer\n', 'utf8');

    const drifted = await service.inspectManagedWorkspace(binding);
    assert.equal(drifted.state, 'drifted');
    const quarantined = await service.quarantineManagedWorkspace(binding, 'external_drift');

    assert.equal(existsSync(binding.worktreePath), false);
    assert.equal((await stat(quarantined.quarantinePath)).isDirectory(), true);
    assert.equal(
      await readFile(join(quarantined.quarantinePath, 'tracked.txt'), 'utf8'),
      'external writer\n',
    );
    await assertSourceUnchanged(sourceRoot, sourceSnapshot);
    await assert.rejects(
      service.inspectManagedWorkspace(binding),
      isWorkspaceError('managed_workspace_unavailable'),
    );
  });

  test('fails closed when a durable binding gains unknown or self-authenticating fields', async () => {
    const root = await temporaryRoot();
    const sourceRoot = await createEligibleSource(join(root, 'source'));
    const service = await serviceAt(join(root, 'storage'));
    const binding = await service.openManagedWorkspace(openRequest(sourceRoot));
    const bindingPath = join(dirname(binding.worktreePath), 'binding.json');
    const corrupted = {
      ...JSON.parse(await readFile(bindingPath, 'utf8')),
      acceptedByCaller: true,
    };
    await writeFile(bindingPath, `${JSON.stringify(corrupted)}\n`, 'utf8');

    await assert.rejects(
      service.inspectManagedWorkspace(binding),
      isWorkspaceError('managed_workspace_identity_conflict'),
    );
  });
});

async function serviceAt(storageRoot: string): Promise<GitWorkspaceService> {
  return createGitWorkspaceService({
    storageRoot,
    gitRuntime: {
      executablePath: gitExecutablePath,
      expectedSha256: gitExecutableSha256,
    },
  });
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

async function createEligibleSource(sourceRoot: string): Promise<string> {
  await mkdir(sourceRoot, { recursive: true });
  await git(sourceRoot, 'init', '--quiet');
  await writeFile(join(sourceRoot, 'tracked.txt'), 'tracked\n', 'utf8');
  await writeFile(join(sourceRoot, '.gitignore'), 'ignored.env\n.maka-workspace.json\n', 'utf8');
  await writeFile(join(sourceRoot, 'ignored.env'), 'SECRET=not-imported\n', 'utf8');
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

interface SourceSnapshot {
  readonly root: string;
  readonly commonDir: string;
  readonly head: string;
  readonly tree: string;
  readonly branch: string;
  readonly status: string;
  readonly refs: string;
  readonly indexDigest: `sha256:${string}`;
  readonly trackedContents: string;
}

async function snapshotSource(sourceRoot: string): Promise<SourceSnapshot> {
  const commonDirRaw = await git(sourceRoot, 'rev-parse', '--git-common-dir');
  const commonDir = await realpath(join(sourceRoot, commonDirRaw));
  return {
    root: await realpath(sourceRoot),
    commonDir,
    head: await git(sourceRoot, 'rev-parse', 'HEAD'),
    tree: await git(sourceRoot, 'rev-parse', 'HEAD^{tree}'),
    branch: await git(sourceRoot, 'branch', '--show-current'),
    status: await git(sourceRoot, 'status', '--porcelain=v1', '--untracked-files=all'),
    refs: await git(sourceRoot, 'for-each-ref', '--format=%(refname) %(objectname)'),
    indexDigest: await sha256File(join(commonDir, 'index')),
    trackedContents: await readFile(join(sourceRoot, 'tracked.txt'), 'utf8'),
  };
}

async function assertSourceUnchanged(sourceRoot: string, before: SourceSnapshot): Promise<void> {
  const after = await snapshotSource(sourceRoot);
  assert.deepEqual(after, before);
}

function isWorkspaceError(code: string): (error: unknown) => boolean {
  return (error) => error instanceof GitWorkspaceServiceError && error.code === code;
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'maka-git-workspace-service-'));
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

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.trim();
}

async function gitBare(repositoryPath: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['--git-dir', repositoryPath, ...args], {
    cwd: dirname(repositoryPath),
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.trim();
}

function waitForReady(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      cleanupListeners();
      reject(new Error(`Git workspace crash child did not become ready: ${stderr}`));
    }, timeoutMs);
    const onStdout = (chunk: unknown) => {
      stdout += String(chunk);
      if (stdout.includes('READY\n')) {
        cleanupListeners();
        resolve();
      }
    };
    const onStderr = (chunk: unknown) => {
      stderr += String(chunk);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanupListeners();
      reject(new Error(`Git workspace crash child exited early: ${code}/${signal} ${stderr}`));
    };
    const onError = (error: Error) => {
      cleanupListeners();
      reject(error);
    };
    const cleanupListeners = () => {
      clearTimeout(timeout);
      child.stdout?.off('data', onStdout);
      child.stderr?.off('data', onStderr);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    child.once('exit', () => resolve());
    child.once('error', reject);
  });
}
