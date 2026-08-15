import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { releaseToolchainFromManifest } from './release-identity.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export function npmVersionFromUserAgent(userAgent) {
  const match = /^npm\/([^\s]+)/u.exec(userAgent ?? '');
  return match?.[1];
}

export async function assertReleaseNpm({
  rootManifest,
  env = process.env,
  inspect = execFileAsync,
  platform = process.platform,
} = {}) {
  const manifest =
    rootManifest ?? JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
  const expectedVersion = releaseToolchainFromManifest(manifest).npmVersion;
  const parentVersion = npmVersionFromUserAgent(env.npm_config_user_agent);
  if (parentVersion !== expectedVersion) {
    throw new Error(
      `Release command requires npm ${expectedVersion}, parent npm is ${parentVersion ?? 'unknown'}.`,
    );
  }
  const actual = await inspect('npm', ['--version'], {
    cwd: repoRoot,
    env,
    shell: platform === 'win32',
  });
  const nestedVersion = actual.stdout.trim();
  if (nestedVersion !== expectedVersion) {
    throw new Error(
      `Release command requires nested npm ${expectedVersion}, found ${nestedVersion}.`,
    );
  }
  return expectedVersion;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const version = await assertReleaseNpm();
  console.log(`Release npm ${version} is authoritative for parent and nested commands.`);
}
