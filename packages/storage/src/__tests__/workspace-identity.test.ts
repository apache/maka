import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import {
  resolveWorkspaceIdentity,
  WORKSPACE_IDENTITY_PREFIX,
  WORKSPACE_MARKER_FILE,
  WorkspaceIdentityError,
} from '../workspace-identity.js';

const execFileAsync = promisify(execFile);

test('a new workspace marker contains only its schema version and UUID', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'maka-workspace-marker-shape-'));
  try {
    const resolution = await resolveWorkspaceIdentity({ path: workspace });

    assert.deepEqual(JSON.parse(await readFile(join(workspace, WORKSPACE_MARKER_FILE), 'utf8')), {
      schemaVersion: 1,
      workspaceId: resolution.workspaceIdentity.slice(WORKSPACE_IDENTITY_PREFIX.length),
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('creating a workspace identity keeps a Git worktree clean', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'maka-workspace-git-clean-'));
  try {
    await execFileAsync('git', ['init', '--quiet'], { cwd: workspace });

    await resolveWorkspaceIdentity({ path: workspace });

    const { stdout } = await execFileAsync(
      'git',
      ['status', '--porcelain=v1', '--untracked-files=normal'],
      { cwd: workspace, encoding: 'utf8' },
    );
    assert.equal(stdout, '');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('an existing workspace marker becomes locally ignored after Git initialization', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'maka-workspace-git-existing-'));
  try {
    const original = await resolveWorkspaceIdentity({ path: workspace });
    await execFileAsync('git', ['init', '--quiet'], { cwd: workspace });

    const resolved = await resolveWorkspaceIdentity({ path: workspace });

    assert.equal(resolved.workspaceIdentity, original.workspaceIdentity);
    const { stdout } = await execFileAsync(
      'git',
      ['status', '--porcelain=v1', '--untracked-files=normal'],
      { cwd: workspace, encoding: 'utf8' },
    );
    assert.equal(stdout, '');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('a subdirectory workspace stays clean inside a linked Git worktree', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-workspace-git-linked-'));
  try {
    const repository = join(base, 'repository');
    const linkedWorktree = join(base, 'linked');
    const workspace = join(linkedWorktree, 'nested', 'workspace');
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
      ['worktree', 'add', '--quiet', '-b', 'linked-test', linkedWorktree],
      {
        cwd: repository,
      },
    );
    await mkdir(workspace, { recursive: true });

    await resolveWorkspaceIdentity({ path: workspace });

    const { stdout } = await execFileAsync(
      'git',
      ['status', '--porcelain=v1', '--untracked-files=normal'],
      { cwd: linkedWorktree, encoding: 'utf8' },
    );
    assert.equal(stdout, '');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('repeated Git workspace resolution adds one local exclude rule', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'maka-workspace-git-idempotent-'));
  try {
    await execFileAsync('git', ['init', '--quiet'], { cwd: workspace });

    await resolveWorkspaceIdentity({ path: workspace });
    await resolveWorkspaceIdentity({ path: workspace });

    const { stdout } = await execFileAsync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'],
      { cwd: workspace, encoding: 'utf8' },
    );
    const rules = (await readFile(stdout.trim(), 'utf8'))
      .split(/\r?\n/)
      .filter((line) => line === WORKSPACE_MARKER_FILE);
    assert.equal(rules.length, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('concurrent Git workspace resolution returns one clean identity', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'maka-workspace-git-concurrent-'));
  try {
    await execFileAsync('git', ['init', '--quiet'], { cwd: workspace });

    const resolutions = await Promise.all(
      Array.from({ length: 8 }, () => resolveWorkspaceIdentity({ path: workspace })),
    );

    assert.equal(new Set(resolutions.map((resolution) => resolution.workspaceIdentity)).size, 1);
    const { stdout } = await execFileAsync(
      'git',
      ['status', '--porcelain=v1', '--untracked-files=normal'],
      { cwd: workspace, encoding: 'utf8' },
    );
    assert.equal(stdout, '');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('a full Git exclude does not grow when resolving workspace identity', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'maka-workspace-git-exclude-full-'));
  try {
    await execFileAsync('git', ['init', '--quiet'], { cwd: workspace });
    const { stdout } = await execFileAsync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'],
      { cwd: workspace, encoding: 'utf8' },
    );
    const excludePath = stdout.trim();
    const originalContents = '#'.repeat(1024 * 1024);
    await writeFile(excludePath, originalContents, 'utf8');

    await assert.rejects(
      () => resolveWorkspaceIdentity({ path: workspace }),
      (error: unknown) =>
        error instanceof WorkspaceIdentityError && error.code === 'workspace_io_failed',
    );
    assert.equal(await readFile(excludePath, 'utf8'), originalContents);
    await assert.rejects(access(join(workspace, WORKSPACE_MARKER_FILE)), { code: 'ENOENT' });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('a malformed enclosing Git repository prevents publishing a new marker', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'maka-workspace-git-malformed-'));
  try {
    await writeFile(join(workspace, '.git'), 'gitdir: /missing/maka-git-dir\n', 'utf8');

    await assert.rejects(
      () => resolveWorkspaceIdentity({ path: workspace }),
      (error: unknown) =>
        error instanceof WorkspaceIdentityError && error.code === 'workspace_io_failed',
    );
    await assert.rejects(access(join(workspace, WORKSPACE_MARKER_FILE)), { code: 'ENOENT' });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('a non-Git workspace resolves when the Git executable is unavailable', {
  skip: process.platform === 'win32',
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'maka-workspace-no-git-required-'));
  try {
    await resolveWorkspaceIdentityWithoutGit(workspace);

    await access(join(workspace, WORKSPACE_MARKER_FILE));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('a Git workspace does not publish a marker when the Git executable is unavailable', {
  skip: process.platform === 'win32',
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'maka-workspace-git-unavailable-'));
  try {
    await execFileAsync('git', ['init', '--quiet'], { cwd: workspace });

    await assert.rejects(resolveWorkspaceIdentityWithoutGit(workspace));
    await assert.rejects(access(join(workspace, WORKSPACE_MARKER_FILE)), { code: 'ENOENT' });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('an unmarked read-only workspace fails without leaving marker state', {
  skip: process.platform === 'win32',
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'maka-workspace-read-only-'));
  try {
    await chmod(workspace, 0o555);

    await assert.rejects(
      () => resolveWorkspaceIdentity({ path: workspace }),
      (error: unknown) =>
        error instanceof WorkspaceIdentityError && error.code === 'workspace_io_failed',
    );
    await assert.rejects(access(join(workspace, WORKSPACE_MARKER_FILE)), { code: 'ENOENT' });
  } finally {
    await chmod(workspace, 0o755);
    await rm(workspace, { recursive: true, force: true });
  }
});

test('a tar archive round-trip preserves workspace identity', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-workspace-identity-'));
  try {
    const source = join(base, 'source');
    const imported = join(base, 'imported');
    const archive = join(base, 'workspace.tar');
    await mkdir(source);
    const original = await resolveWorkspaceIdentity({ path: source });
    const markerBefore = await readFile(join(source, WORKSPACE_MARKER_FILE), 'utf8');

    await mkdir(imported);
    await execFileAsync('tar', ['-cf', archive, '-C', source, '.']);
    await execFileAsync('tar', ['-xf', archive, '-C', imported]);
    assert.equal(await readFile(join(imported, WORKSPACE_MARKER_FILE), 'utf8'), markerBefore);
    const adopted = await resolveWorkspaceIdentity({ path: imported });

    assert.equal(adopted.workspaceIdentity, original.workspaceIdentity);
    assert.match(adopted.workspaceIdentity, new RegExp(`^${WORKSPACE_IDENTITY_PREFIX}`));
    assert.equal(await readFile(join(imported, WORKSPACE_MARKER_FILE), 'utf8'), markerBefore);
    assert.equal(
      JSON.parse(await readFile(join(imported, WORKSPACE_MARKER_FILE), 'utf8')).workspaceId,
      JSON.parse(markerBefore).workspaceId,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('importing an existing marker into a Git worktree keeps it clean', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-workspace-import-git-'));
  try {
    const source = join(base, 'source');
    const imported = join(base, 'imported');
    await mkdir(source);
    await mkdir(imported);
    const original = await resolveWorkspaceIdentity({ path: source });
    await writeFile(
      join(imported, WORKSPACE_MARKER_FILE),
      await readFile(join(source, WORKSPACE_MARKER_FILE)),
    );
    await execFileAsync('git', ['init', '--quiet'], { cwd: imported });

    const adopted = await resolveWorkspaceIdentity({ path: imported });

    assert.equal(adopted.workspaceIdentity, original.workspaceIdentity);
    const { stdout } = await execFileAsync(
      'git',
      ['status', '--porcelain=v1', '--untracked-files=normal'],
      { cwd: imported, encoding: 'utf8' },
    );
    assert.equal(stdout, '');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

async function resolveWorkspaceIdentityWithoutGit(workspace: string): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: '' };
  delete env.Path;
  const moduleUrl = new URL('../workspace-identity.js', import.meta.url).href;
  await execFileAsync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      'const [moduleUrl, workspace] = process.argv.slice(1); const { resolveWorkspaceIdentity } = await import(moduleUrl); await resolveWorkspaceIdentity({ path: workspace });',
      moduleUrl,
      workspace,
    ],
    { env },
  );
}
