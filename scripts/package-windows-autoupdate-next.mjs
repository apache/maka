import { createHash } from 'node:crypto';
import { access, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runCommand } from './package-windows-x64.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const desktopRoot = join(repoRoot, 'apps', 'desktop');

/**
 * The version the auto-update harness serves as "newer than the candidate".
 * A plain patch bump keeps the artifact name matching the release regex and
 * avoids every channel/prerelease ambiguity: `allowPrerelease` only affects
 * the GitHub provider, but a stable version never depends on that behavior.
 */
export function bumpedAutoupdateVersion(candidateVersion) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(candidateVersion);
  if (!match) {
    throw new Error(
      `Cannot bump a non-stable x.y.z candidate version: ${JSON.stringify(candidateVersion)}`,
    );
  }
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
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

  const manifest = JSON.parse(await readFile(join(desktopRoot, 'package.json'), 'utf8'));
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
