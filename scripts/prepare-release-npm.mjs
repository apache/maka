import { execFile } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { releaseToolchainFromManifest } from './release-identity.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export function releaseNpmPaths(prefix) {
  return {
    binDirectory: join(prefix, 'node_modules', '.bin'),
    npmCliPath: join(prefix, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  };
}

export async function prepareReleaseNpm({
  rootManifest,
  env = process.env,
  prefix,
  packageSpec,
  install = execFileAsync,
  inspect = execFileAsync,
  npmCommand = 'npm',
  execPath = process.execPath,
  platform = process.platform,
} = {}) {
  const manifest =
    rootManifest ?? JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
  const expectedVersion = releaseToolchainFromManifest(manifest).npmVersion;
  const installPrefix =
    prefix ?? (env.RUNNER_TEMP ? join(env.RUNNER_TEMP, 'maka-release-npm') : undefined);
  if (!installPrefix) {
    throw new Error('Release npm preparation requires RUNNER_TEMP or an explicit prefix.');
  }
  if (!env.GITHUB_PATH) {
    throw new Error('Release npm preparation requires GITHUB_PATH.');
  }

  await install(
    npmCommand,
    [
      'install',
      '--prefix',
      installPrefix,
      '--no-save',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      packageSpec ?? `npm@${expectedVersion}`,
    ],
    { cwd: repoRoot, env, shell: platform === 'win32' },
  );

  const paths = releaseNpmPaths(installPrefix);
  const actual = await inspect(execPath, [paths.npmCliPath, '--version'], {
    cwd: repoRoot,
    env,
  });
  const actualVersion = actual.stdout.trim();
  if (actualVersion !== expectedVersion) {
    throw new Error(`Prepared release npm must be ${expectedVersion}, found ${actualVersion}.`);
  }
  await appendFile(env.GITHUB_PATH, `${paths.binDirectory}\n`, 'utf8');
  return { ...paths, npmVersion: expectedVersion };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const prepared = await prepareReleaseNpm();
  console.log(`Prepared release npm ${prepared.npmVersion} at ${prepared.binDirectory}.`);
}
