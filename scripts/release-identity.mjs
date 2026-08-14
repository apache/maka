import { appendFile, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function exactVersion(value, label) {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error(`${label} must be an exact product version.`);
  }
  return value;
}

export function releaseToolchainFromManifest(rootManifest) {
  const nodeVersion = rootManifest.releaseToolchain?.node;
  const nodeArchive = rootManifest.releaseToolchain?.nodeDarwinArm64Archive;
  const nodeArchiveSha256 = rootManifest.releaseToolchain?.nodeDarwinArm64Sha256;
  const npmMatch = /^npm@(\d+\.\d+\.\d+)$/.exec(rootManifest.packageManager ?? '');
  if (typeof nodeVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(nodeVersion)) {
    throw new Error('package.json must define an exact releaseToolchain.node version.');
  }
  const expectedArchive = `node-v${nodeVersion}-darwin-arm64.tar.xz`;
  if (nodeArchive !== expectedArchive) {
    throw new Error(`releaseToolchain.nodeDarwinArm64Archive must be ${expectedArchive}.`);
  }
  if (typeof nodeArchiveSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(nodeArchiveSha256)) {
    throw new Error('releaseToolchain.nodeDarwinArm64Sha256 must be an exact SHA-256 digest.');
  }
  if (!npmMatch) {
    throw new Error('package.json packageManager must pin an exact npm version.');
  }
  return {
    nodeArchive,
    nodeArchiveSha256,
    nodeSourceUrl: `https://nodejs.org/download/release/v${nodeVersion}/${nodeArchive}`,
    nodeVersion,
    npmVersion: npmMatch[1],
  };
}

export function resolveReleaseIdentity({ rootManifest, desktopManifest, cliManifest, ref, sha }) {
  const version = exactVersion(rootManifest.version, 'Root package version');
  for (const [label, manifest] of [
    ['Desktop', desktopManifest],
    ['CLI', cliManifest],
  ]) {
    if (manifest.version !== version) {
      throw new Error(
        `${label} version ${manifest.version ?? 'missing'} does not match root ${version}.`,
      );
    }
  }
  if (JSON.stringify(cliManifest.bin) !== JSON.stringify({ maka: './dist/cli.js' })) {
    throw new Error('The only public CLI command must be maka.');
  }
  if (ref !== 'refs/heads/main') {
    throw new Error(`Release identity requires refs/heads/main, found ${ref ?? 'missing'}.`);
  }
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error('Release identity requires an exact 40-character source commit SHA.');
  }
  const toolchain = releaseToolchainFromManifest(rootManifest);
  const tag = `v${version}`;
  return {
    ...toolchain,
    version,
    tag,
    sourceCommit: sha,
    dmg: `apps/desktop/release/Maka-${version}-mac-arm64.dmg`,
    exe: `apps/desktop/release/Maka-${version}-win-x64.exe`,
    cliArchive: `apps/desktop/release/Maka-${version}-cli-mac-arm64.zip`,
    cliChecksum: `apps/desktop/release/Maka-${version}-cli-mac-arm64.zip.sha256`,
  };
}

export async function readReleaseIdentity({
  ref = process.env.GITHUB_REF,
  sha = process.env.GITHUB_SHA,
} = {}) {
  const [rootManifest, desktopManifest, cliManifest] = await Promise.all([
    readFile(join(repoRoot, 'package.json'), 'utf8').then(JSON.parse),
    readFile(join(repoRoot, 'apps', 'desktop', 'package.json'), 'utf8').then(JSON.parse),
    readFile(join(repoRoot, 'packages', 'cli', 'package.json'), 'utf8').then(JSON.parse),
  ]);
  return resolveReleaseIdentity({ rootManifest, desktopManifest, cliManifest, ref, sha });
}

function githubOutputEntries(identity) {
  const outputs = {
    version: identity.version,
    tag: identity.tag,
    source_commit: identity.sourceCommit,
    dmg: identity.dmg,
    exe: identity.exe,
    cli_archive: identity.cliArchive,
    cli_checksum: identity.cliChecksum,
    node_version: identity.nodeVersion,
    npm_version: identity.npmVersion,
    node_archive: identity.nodeArchive,
    node_archive_sha256: identity.nodeArchiveSha256,
    node_source_url: identity.nodeSourceUrl,
  };
  return Object.entries(outputs).map(([name, value]) => `${name}=${value}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const identity = await readReleaseIdentity();
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `${githubOutputEntries(identity).join('\n')}\n`,
      'utf8',
    );
  }
  console.log(
    `Release ${identity.tag} from ${identity.sourceCommit}; CLI runtime ${basename(identity.nodeArchive)}.`,
  );
}
