import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { parseProductReleaseVersion } from './release-version.mjs';

const execFileAsync = promisify(execFile);

function validateInputs(tag, source) {
  if (!tag.startsWith('v')) {
    throw new Error(`Product tag must be an exact version tag; found ${tag}`);
  }
  try {
    parseProductReleaseVersion(tag.slice(1));
  } catch (error) {
    throw new Error(`Product tag must be an exact version tag; found ${tag}`, { cause: error });
  }
  if (!/^[0-9a-f]{40}$/u.test(source)) {
    throw new Error(`Product tag source must be an exact commit SHA; found ${source}`);
  }
}

async function remoteTagCommit({ cwd, remote, tag }) {
  const { stdout } = await execFileAsync(
    'git',
    ['ls-remote', '--tags', '--refs', remote, `refs/tags/${tag}`],
    { cwd },
  );
  const line = stdout.trim();
  if (!line) return undefined;
  const [commit, ref, ...extra] = line.split(/\s+/u);
  if (extra.length > 0 || ref !== `refs/tags/${tag}` || !/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error(`Remote returned an invalid product tag reference for ${tag}`);
  }
  return commit;
}

export async function ensureProductTag({ cwd = process.cwd(), remote = 'origin', tag, source }) {
  validateInputs(tag, source);
  const { stdout: resolvedSource } = await execFileAsync(
    'git',
    ['rev-parse', `${source}^{commit}`],
    {
      cwd,
    },
  );
  if (resolvedSource.trim() !== source) {
    throw new Error(`Product source ${source} is not the exact checked-out commit`);
  }

  const existing = await remoteTagCommit({ cwd, remote, tag });
  if (existing) {
    if (existing !== source) {
      throw new Error(`Product tag ${tag} points to ${existing} instead of ${source}`);
    }
    return 'existing';
  }

  try {
    await execFileAsync('git', ['push', remote, `${source}:refs/tags/${tag}`], { cwd });
    return 'created';
  } catch (error) {
    const raced = await remoteTagCommit({ cwd, remote, tag });
    if (raced === source) return 'existing';
    if (raced) throw new Error(`Product tag ${tag} points to ${raced} instead of ${source}`);
    throw new Error(`Could not create product tag ${tag}`, { cause: error });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, tag, source, remote = 'origin'] = process.argv.slice(2);
  if (command !== 'ensure' || !tag || !source) {
    throw new Error('usage: product-release-tag.mjs ensure <tag> <source-commit> [remote]');
  }
  const result = await ensureProductTag({ tag, source, remote });
  console.log(`Product tag ${tag}: ${result} at ${source}`);
}
