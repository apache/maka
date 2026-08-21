import { execFile } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { parseProductReleaseVersion } from './release-version.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const execFileAsync = promisify(execFile);

export function releaseToolchainFromManifest(rootManifest) {
  const appleTeamIdentifier = rootManifest.releaseToolchain?.appleTeamIdentifier;
  const nodeVersion = rootManifest.releaseToolchain?.node;
  const nodeArchiveSha256 = rootManifest.releaseToolchain?.nodeDarwinArm64Sha256;
  const npmMatch = /^npm@(\d+\.\d+\.\d+)$/u.exec(rootManifest.packageManager ?? '');
  if (typeof nodeVersion !== 'string' || !/^\d+\.\d+\.\d+$/u.test(nodeVersion)) {
    throw new Error('package.json must define an exact releaseToolchain.node version');
  }
  if (typeof appleTeamIdentifier !== 'string' || !/^[A-Z0-9]{10}$/u.test(appleTeamIdentifier)) {
    throw new Error('releaseToolchain.appleTeamIdentifier must be an exact Apple Team ID');
  }
  const nodeArchive = `node-v${nodeVersion}-darwin-arm64.tar.xz`;
  if (typeof nodeArchiveSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(nodeArchiveSha256)) {
    throw new Error('releaseToolchain.nodeDarwinArm64Sha256 must be an exact SHA-256 digest');
  }
  if (!npmMatch) throw new Error('package.json packageManager must pin an exact npm version');
  return {
    appleTeamIdentifier,
    nodeVersion,
    nodeArchive,
    nodeArchiveSha256,
    nodeSourceUrl: `https://nodejs.org/download/release/v${nodeVersion}/${nodeArchive}`,
    npmVersion: npmMatch[1],
  };
}

export function parseAsfSourceReferenceTag(tag) {
  const match = typeof tag === 'string' ? /^v(.+)-incubating-rc([1-9]\d*)$/u.exec(tag) : undefined;
  if (!match) {
    throw new Error('ASF source reference must match v<version>-incubating-rc<positive-integer>');
  }
  try {
    parseProductReleaseVersion(match[1]);
  } catch {
    throw new Error('ASF source reference must match v<version>-incubating-rc<positive-integer>');
  }
  return { rcNumber: match[2], tag, version: match[1] };
}

export function resolveProductManifestIdentity({ rootManifest, desktopManifest, cliManifest }) {
  const { version } = parseProductReleaseVersion(rootManifest.version);
  for (const [label, manifest] of [
    ['Desktop', desktopManifest],
    ['CLI', cliManifest],
  ]) {
    if (manifest.version !== version) {
      throw new Error(
        `${label} version ${manifest.version ?? 'missing'} does not match root ${version}`,
      );
    }
  }
  if (JSON.stringify(cliManifest.bin) !== JSON.stringify({ maka: './dist/cli.js' })) {
    throw new Error('The only public CLI command must be maka');
  }

  return {
    version,
    runtimeHostSetupPackage: `maka-agent@${version}`,
    publicCommands: ['maka'],
  };
}

export function resolveProductReleaseIdentity({
  rootManifest,
  desktopManifest,
  cliManifest,
  sha,
  sourceReferenceTag,
}) {
  const manifestIdentity = resolveProductManifestIdentity({
    rootManifest,
    desktopManifest,
    cliManifest,
  });
  const { version } = manifestIdentity;
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/u.test(sha)) {
    throw new Error('Product releases require an exact 40-character source commit SHA');
  }
  if (sourceReferenceTag !== undefined) {
    const sourceReference = parseAsfSourceReferenceTag(sourceReferenceTag);
    if (sourceReference.version !== version) {
      throw new Error(
        `ASF source reference version ${sourceReference.version} does not match product ${version}`,
      );
    }
  }

  const toolchain = releaseToolchainFromManifest(rootManifest);
  const cliArchive = `Maka-${version}-cli-mac-arm64.zip`;

  return {
    ...toolchain,
    ...manifestIdentity,
    tag: `v${version}`,
    sourceCommit: sha,
    sourceReferenceTag,
    dmg: `Maka-${version}-mac-arm64.dmg`,
    exe: `Maka-${version}-win-x64.exe`,
    cliArchive,
    cliChecksum: `${cliArchive}.sha256`,
    sourceArchive: `Maka-${version}-bundled-git-source.tar.gz`,
  };
}

export function assertProductReleaseExpectation(identity, { version, tag, sourceCommit }) {
  if (
    identity.version !== version ||
    identity.tag !== tag ||
    identity.sourceCommit !== sourceCommit
  ) {
    throw new Error(
      `Checked source ${identity.tag} at ${identity.sourceCommit} does not match product release ${tag} at ${sourceCommit}`,
    );
  }
  return identity;
}

async function readProductManifests() {
  const [rootManifest, desktopManifest, cliManifest] = await Promise.all([
    readFile(join(repoRoot, 'package.json'), 'utf8').then(JSON.parse),
    readFile(join(repoRoot, 'apps/desktop/package.json'), 'utf8').then(JSON.parse),
    readFile(join(repoRoot, 'packages/cli/package.json'), 'utf8').then(JSON.parse),
  ]);
  return { rootManifest, desktopManifest, cliManifest };
}

export async function readProductManifestIdentity() {
  return resolveProductManifestIdentity(await readProductManifests());
}

export async function readProductReleaseIdentity({
  sha,
  sourceReferenceTag = process.env.SOURCE_REFERENCE_TAG,
} = {}) {
  const { rootManifest, desktopManifest, cliManifest } = await readProductManifests();
  const sourceCommit =
    sha ??
    process.env.GITHUB_SHA ??
    (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })).stdout.trim();
  return resolveProductReleaseIdentity({
    rootManifest,
    desktopManifest,
    cliManifest,
    sha: sourceCommit,
    sourceReferenceTag,
  });
}

function githubOutputEntries(identity) {
  return {
    version: identity.version,
    tag: identity.tag,
    source_commit: identity.sourceCommit,
    source_reference_tag: identity.sourceReferenceTag,
    dmg: identity.dmg,
    exe: identity.exe,
    cli_archive: identity.cliArchive,
    cli_checksum: identity.cliChecksum,
    source_archive: identity.sourceArchive,
    node_version: identity.nodeVersion,
    node_archive: identity.nodeArchive,
    node_archive_sha256: identity.nodeArchiveSha256,
    node_source_url: identity.nodeSourceUrl,
    npm_version: identity.npmVersion,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const identity = await readProductReleaseIdentity();
  if (
    process.env.EXPECTED_PRODUCT_VERSION ||
    process.env.EXPECTED_PRODUCT_TAG ||
    process.env.EXPECTED_PRODUCT_SOURCE_COMMIT
  ) {
    assertProductReleaseExpectation(identity, {
      version: process.env.EXPECTED_PRODUCT_VERSION,
      tag: process.env.EXPECTED_PRODUCT_TAG,
      sourceCommit: process.env.EXPECTED_PRODUCT_SOURCE_COMMIT,
    });
  }
  if (process.env.GITHUB_OUTPUT) {
    const output = Object.entries(githubOutputEntries(identity))
      .filter(([, value]) => value !== undefined)
      .map(([name, value]) => `${name}=${value}`)
      .join('\n');
    await appendFile(process.env.GITHUB_OUTPUT, `${output}\n`, 'utf8');
  }
  console.log(`Product release ${identity.tag} from ${identity.sourceCommit}`);
}
