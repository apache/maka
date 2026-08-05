import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { bundledGitEnvironment } from '../dugite-native-environment.js';
import { createGitWorkspaceService } from '../git-workspace-service.js';

const execFileAsync = promisify(execFile);

test('opens a managed workspace using only the installed dugite-native runtime', async () => {
  const repoRoot = resolve(import.meta.dirname, '..', '..', '..', '..');
  const gitRoot = join(repoRoot, 'node_modules', 'dugite', 'git');
  const executablePath =
    process.platform === 'win32' ? join(gitRoot, 'cmd', 'git.exe') : join(gitRoot, 'bin', 'git');
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
      rootPath: gitRoot,
      executablePath,
    }),
  };
  try {
    await runGit(executablePath, env, ['-C', sourceRoot, 'init', '--quiet']);
    await runGit(executablePath, env, ['-C', sourceRoot, 'config', 'user.name', 'Maka Test']);
    await runGit(executablePath, env, [
      '-C',
      sourceRoot,
      'config',
      'user.email',
      'test@maka.invalid',
    ]);
    await writeFile(join(sourceRoot, 'README.md'), 'bundled Git runtime\n');
    await runGit(executablePath, env, ['-C', sourceRoot, 'add', 'README.md']);
    await runGit(executablePath, env, ['-C', sourceRoot, 'commit', '--quiet', '-m', 'baseline']);

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
  } finally {
    await Promise.all(
      [sourceRoot, storageRoot, homePath].map((path) => rm(path, { recursive: true, force: true })),
    );
  }
});

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
