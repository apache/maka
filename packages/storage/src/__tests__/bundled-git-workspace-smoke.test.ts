import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { bundledGitEnvironment } from '../dugite-native-environment.js';
import { createGitWorkspaceService } from '../git-workspace-service.js';

const execFileAsync = promisify(execFile);

test('uses the installed runtime and rejects entry-binary replacement before the next operation', async () => {
  const repoRoot = resolve(import.meta.dirname, '..', '..', '..', '..');
  const installedGitRoot = join(repoRoot, 'node_modules', 'dugite', 'git');
  const installedExecutablePath =
    process.platform === 'win32'
      ? join(installedGitRoot, 'cmd', 'git.exe')
      : join(installedGitRoot, 'bin', 'git');
  const gitRoot = await mkdtemp(join(tmpdir(), 'maka-bundled-git-runtime-'));
  const executablePath = await materializeIsolatedRuntime(
    installedGitRoot,
    gitRoot,
    process.platform === 'win32' ? 'cmd/git.exe' : 'bin/git',
  );
  const sourceRoot = await mkdtemp(join(tmpdir(), 'maka-bundled-git-source-'));
  const storageRoot = await mkdtemp(join(tmpdir(), 'maka-bundled-git-storage-'));
  const homePath = await mkdtemp(join(tmpdir(), 'maka-bundled-git-home-'));
  const env = {
    HOME: homePath,
    XDG_CONFIG_HOME: join(homePath, 'xdg'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    ...bundledGitEnvironment({
      platform: process.platform,
      arch: process.arch,
      rootPath: installedGitRoot,
      executablePath: installedExecutablePath,
    }),
  };
  try {
    await runGit(installedExecutablePath, env, ['-C', sourceRoot, 'init', '--quiet']);
    await runGit(installedExecutablePath, env, [
      '-C',
      sourceRoot,
      'config',
      'user.name',
      'Maka Test',
    ]);
    await runGit(installedExecutablePath, env, [
      '-C',
      sourceRoot,
      'config',
      'user.email',
      'test@maka.invalid',
    ]);
    await writeFile(join(sourceRoot, 'README.md'), 'bundled Git runtime\n');
    await runGit(installedExecutablePath, env, ['-C', sourceRoot, 'add', 'README.md']);
    await runGit(installedExecutablePath, env, [
      '-C',
      sourceRoot,
      'commit',
      '--quiet',
      '-m',
      'baseline',
    ]);

    const service = createGitWorkspaceService({
      storageRoot,
      gitRuntime: {
        executablePath,
        expectedSha256: await sha256File(executablePath),
        runtimeIdentitySha256: `sha256:${'1'.repeat(64)}`,
        distribution: { kind: 'dugite_native_v1', rootPath: gitRoot },
      },
    });
    const binding = await service.createManagedWorkspaceFromSource({
      repositoryId: 'repository_11111111111111111111111111111111',
      workspaceId: 'workspace_22222222222222222222222222222222',
      workspaceEpochId: 'epoch_33333333333333333333333333333333',
      workspaceInstanceId: 'instance_44444444444444444444444444444444',
      sourceRoot,
    });

    assert.equal(
      await readFile(join(binding.worktreePath, 'README.md'), 'utf8'),
      'bundled Git runtime\n',
    );
    assert.equal(binding.gitRuntimeSha256, `sha256:${'1'.repeat(64)}`);

    await writeFile(executablePath, 'tampered after successful workspace creation\n');
    await assert.rejects(
      service.inspectManagedWorkspace(binding),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'git_runtime_integrity_mismatch',
    );
  } finally {
    await Promise.all(
      [sourceRoot, storageRoot, homePath, gitRoot].map((path) =>
        rm(path, { recursive: true, force: true }),
      ),
    );
  }
});

async function materializeIsolatedRuntime(
  sourceRoot: string,
  targetRoot: string,
  executableRelativePath: string,
): Promise<string> {
  const executablePath = join(targetRoot, ...executableRelativePath.split('/'));
  const executableDirectory = executableRelativePath.split('/')[0] ?? '';
  await mkdir(dirname(executablePath), { recursive: true });
  await copyFile(join(sourceRoot, ...executableRelativePath.split('/')), executablePath);
  if (process.platform !== 'win32') {
    await chmod(
      executablePath,
      (await stat(join(sourceRoot, ...executableRelativePath.split('/')))).mode & 0o7777,
    );
  }
  for (const entry of await readdir(sourceRoot, { withFileTypes: true })) {
    if (entry.name === executableDirectory) continue;
    const source = join(sourceRoot, entry.name);
    const target = join(targetRoot, entry.name);
    if (entry.isDirectory()) {
      await symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir');
    } else if (entry.isFile()) {
      await copyFile(source, target);
    }
  }
  return executablePath;
}

async function runGit(
  executablePath: string,
  env: NodeJS.ProcessEnv,
  args: readonly string[],
): Promise<void> {
  await execFileAsync(executablePath, args, {
    env,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  });
}

async function sha256File(path: string): Promise<`sha256:${string}`> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
}
