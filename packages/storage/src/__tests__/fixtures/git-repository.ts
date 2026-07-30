import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function createGitRepositoryWithWorktree(
  repository: string,
  linkedWorktree: string,
  branch: string,
): Promise<void> {
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
  await execFileAsync('git', ['worktree', 'add', '--quiet', '-b', branch, linkedWorktree], {
    cwd: repository,
  });
}
