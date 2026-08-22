import { createHash } from 'node:crypto';
import { access, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runCommand } from './package-windows-x64.mjs';
import { parseProductReleaseVersion } from './release-version.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const desktopRoot = join(repoRoot, 'apps', 'desktop');
const rootManifestPath = join(repoRoot, 'package.json');
const desktopManifestPath = join(desktopRoot, 'package.json');

/**
 * The version the auto-update harness serves as "newer than the candidate".
 * A stable successor keeps the loopback feed independent from prerelease
 * channel behavior: a prerelease advances to its stable core, while a stable
 * candidate advances to the next patch.
 */
export function bumpedAutoupdateVersion(candidateVersion) {
  const { core, prerelease } = parseProductReleaseVersion(candidateVersion);
  const [major, minor, patch] = core;
  return prerelease.length > 0 ? `${major}.${minor}.${patch}` : `${major}.${minor}.${patch + 1n}`;
}

/**
 * Minimal parser for the handful of flat keys the assertions need. electron-
 * builder writes plain `key: value` lines for these; a format drift makes the
 * assertions below fail loudly rather than letting a malformed feed pass.
 */
function readFlatYamlValue(source, key) {
  const match = new RegExp(`^${key}:\\s*(.+)\\s*$`, 'm').exec(source);
  return match ? match[1].trim() : undefined;
}

/**
 * Build the version-bumped NSIS installer the auto-update harness serves as
 * the "next" release.
 *
 * Runs only after a full `package:windows-x64`: it reuses the existing
 * workspace build (`apps/desktop/dist`) and injects the bumped version via
 * electron-builder's `extraMetadata`, which rewrites the packaged
 * `package.json` so the upgraded app really reports the new version through
 * `app.getVersion()`. Output goes to a dedicated directory outside
 * `apps/desktop/release`, so the release upload globs can never pick up the
 * fake-versioned artifacts.
 */
export async function packageWindowsAutoupdateNext({
  platform = process.platform,
  arch = process.arch,
  run = runCommand,
} = {}) {
  if (platform !== 'win32' || arch !== 'x64') {
    throw new Error('The auto-update installer build requires a Windows x64 host.');
  }

  const manifest = JSON.parse(await readFile(desktopManifestPath, 'utf8'));
  const nextVersion = bumpedAutoupdateVersion(manifest.version);
  const outputDirectory = join(desktopRoot, 'release-autoupdate-next');
  const exeName = `Maka-${nextVersion}-win-x64.exe`;
  const exePath = join(outputDirectory, exeName);
  const latestYmlPath = join(outputDirectory, 'latest.yml');
  const blockmapPath = join(outputDirectory, `${exeName}.blockmap`);

  // Prerequisites from the full packaging run; failing here beats a confusing
  // electron-builder error half-way through.
  await access(join(desktopRoot, 'dist'));
  await access(join(desktopRoot, 'release', 'win-unpacked'));

  await rm(outputDirectory, { recursive: true, force: true });
  // electron-builder requires the root and Desktop manifests to have the same
  // version. `extraMetadata` only changes the packaged app manifest, so
  // temporarily update both source manifests for the build and restore them
  // even when electron-builder fails.
  const [originalRootManifest, originalDesktopManifest] = await Promise.all([
    readFile(rootManifestPath),
    readFile(desktopManifestPath),
  ]);
  const bumpedRootManifest = JSON.parse(originalRootManifest);
  const bumpedDesktopManifest = JSON.parse(originalDesktopManifest);
  bumpedRootManifest.version = nextVersion;
  bumpedDesktopManifest.version = nextVersion;
  try {
    await Promise.all([
      writeFile(rootManifestPath, `${JSON.stringify(bumpedRootManifest, null, 2)}\n`),
      writeFile(desktopManifestPath, `${JSON.stringify(bumpedDesktopManifest, null, 2)}\n`),
    ]);
    await run('npm', [
      '--workspace',
      '@maka/desktop',
      'exec',
      '--',
      'electron-builder',
      '--config',
      'electron-builder.config.mjs',
      '--win',
      'nsis',
      '--x64',
      '--publish',
      'never',
      `-c.extraMetadata.version=${nextVersion}`,
      '-c.directories.output=release-autoupdate-next',
    ]);
  } finally {
    await Promise.all([
      writeFile(rootManifestPath, originalRootManifest),
      writeFile(desktopManifestPath, originalDesktopManifest),
    ]);
  }

  // Assert the properties the harness depends on, not just process exit 0.
  await access(exePath);
  await access(blockmapPath);
  const latestYml = await readFile(latestYmlPath, 'utf8');
  const feedVersion = readFlatYamlValue(latestYml, 'version');
  if (feedVersion !== nextVersion) {
    throw new Error(
      `latest.yml advertises version ${JSON.stringify(feedVersion)}, expected ${nextVersion}`,
    );
  }
  const feedPath = readFlatYamlValue(latestYml, 'path');
  if (feedPath !== exeName) {
    throw new Error(`latest.yml path points at ${JSON.stringify(feedPath)}, expected ${exeName}`);
  }
  const feedSha512 = readFlatYamlValue(latestYml, 'sha512');
  const actualSha512 = createHash('sha512')
    .update(await readFile(exePath))
    .digest('base64');
  if (feedSha512 !== actualSha512) {
    throw new Error(
      'latest.yml sha512 does not match the built installer; the feed would fail integrity checks',
    );
  }

  return { version: nextVersion, exePath, latestYmlPath, blockmapPath, directory: outputDirectory };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await packageWindowsAutoupdateNext();
  console.log(
    JSON.stringify({
      version: result.version,
      exePath: result.exePath,
      directory: result.directory,
    }),
  );
}
