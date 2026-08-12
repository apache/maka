import { execFile } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { sha256File } from './verify-packaged-app.mjs';

const runFile = promisify(execFile);
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultManifestPath = join(repoRoot, 'scripts', 'windows-upgrade-baseline.json');

function stableVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(value);
  return match ? match.slice(1).map(Number) : undefined;
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

export function validateWindowsUpgradeBaseline(manifest, candidateVersion) {
  const baseline = stableVersion(manifest?.version);
  const candidate = stableVersion(candidateVersion);
  if (!baseline || !candidate) throw new Error('Windows upgrade versions must be stable x.y.z.');
  if (manifest.tag !== `v${manifest.version}`)
    throw new Error('Baseline tag must match its version.');
  if (manifest.assetName !== `Maka-${manifest.version}-win-x64.exe`) {
    throw new Error('Baseline asset name must exactly match its version and architecture.');
  }
  if (!/^[0-9a-f]{64}$/u.test(manifest.sha256)) {
    throw new Error('Baseline SHA-256 must be a lowercase 64-character digest.');
  }
  if (compareVersions(baseline, candidate) >= 0) {
    throw new Error('Windows upgrade baseline must be older than the candidate.');
  }
  return manifest;
}

export async function prepareWindowsUpgradeBaseline(
  candidateVersion,
  outputDirectory,
  {
    manifestPath = defaultManifestPath,
    repository = process.env.GITHUB_REPOSITORY ?? 'maka-agent/maka-agent',
    run = runFile,
    checksum = sha256File,
  } = {},
) {
  const manifest = validateWindowsUpgradeBaseline(
    JSON.parse(await readFile(manifestPath, 'utf8')),
    candidateVersion,
  );
  const directory = resolve(outputDirectory);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  await run('gh', [
    'release',
    'download',
    manifest.tag,
    '--repo',
    repository,
    '--pattern',
    manifest.assetName,
    '--dir',
    directory,
  ]);
  const installer = join(directory, manifest.assetName);
  const actual = await checksum(installer);
  if (actual !== manifest.sha256) {
    throw new Error(
      `Windows upgrade baseline checksum mismatch for ${basename(installer)}: expected ${manifest.sha256}, found ${actual}.`,
    );
  }
  return installer;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const installer = await prepareWindowsUpgradeBaseline(process.argv[2], process.argv[3]);
  process.stdout.write(installer);
}
