import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DUGITE_VERSION = '3.2.2';
const DUGITE_NATIVE_RELEASE = 'v2.53.0-3';
const DUGITE_NATIVE_COMMIT = 'f49d0098409aa243de8b9162127025ab0bb07a88';
const DUGITE_NATIVE_BUILD = DUGITE_NATIVE_COMMIT.slice(0, 7);

export const BUNDLED_GIT_SOURCE_COMPONENTS = Object.freeze([
  component('dugite-native', 'desktop/dugite-native', DUGITE_NATIVE_COMMIT, 'GPL-2.0-only'),
  component('git', 'git/git', '67ad42147a7acc2af6074753ebd03d904476118f', 'GPL-2.0-only'),
  component(
    'git-for-windows',
    'git-for-windows/git',
    'f8165afd89b0c190677a093f20894f5fce12f97a',
    'GPL-2.0-only',
  ),
  component('git-lfs', 'git-lfs/git-lfs', 'b84b33847fe6458f36ef521534dc0eac953cb379', 'MIT'),
  component(
    'git-credential-manager',
    'git-ecosystem/git-credential-manager',
    '5fa7116896c82164996a609accd1c5ad90fe730a',
    'MIT',
  ),
  component(
    'sha1collisiondetection',
    'cr-marcstevens/sha1collisiondetection',
    '855827c583bc30645ba427885caa40c5b81764d2',
    'MIT',
  ),
]);

export async function prepareBundledGitSourceMaterials({
  dugiteRoot,
  outputDirectory,
  fetchImpl = globalThis.fetch,
}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('A Fetch implementation is required to prepare bundled Git source materials.');
  }
  const packageJson = JSON.parse(await readFile(join(dugiteRoot, 'package.json'), 'utf8'));
  if (packageJson.version !== DUGITE_VERSION) {
    throw new Error(`Expected dugite ${DUGITE_VERSION}, found ${String(packageJson.version)}.`);
  }
  const embeddedGit = JSON.parse(
    await readFile(join(dugiteRoot, 'script', 'embedded-git.json'), 'utf8'),
  );
  assertRuntimeProvenance(embeddedGit);

  const finalDirectory = resolve(outputDirectory);
  assertSafeOutputDirectory(finalDirectory);
  await assertReplaceableOutputDirectory(finalDirectory);
  const stagingDirectory = `${finalDirectory}.staging-${process.pid}`;
  await rm(stagingDirectory, { recursive: true, force: true });
  await mkdir(stagingDirectory, { recursive: true });

  try {
    const materialized = [];
    for (const source of BUNDLED_GIT_SOURCE_COMPONENTS) {
      const response = await fetchImpl(source.sourceUrl);
      if (!response?.ok) {
        throw new Error(
          `Unable to download ${source.name} source (${response?.status ?? 'unknown status'}).`,
        );
      }
      const content = Buffer.from(await response.arrayBuffer());
      await writeFile(join(stagingDirectory, source.archiveFile), content);
      materialized.push({
        ...source,
        sha256: `sha256:${createHash('sha256').update(content).digest('hex')}`,
        bytes: content.byteLength,
      });
    }

    const manifest = {
      protocol: 'maka_bundled_git_source_materials_v1',
      dugiteVersion: DUGITE_VERSION,
      dugiteNativeRelease: DUGITE_NATIVE_RELEASE,
      dugiteNativeCommit: DUGITE_NATIVE_COMMIT,
      components: materialized,
    };
    await writeFile(
      join(stagingDirectory, 'SOURCE_MANIFEST.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    await writeFile(join(stagingDirectory, 'README.txt'), sourceReadme());
    await rm(finalDirectory, { recursive: true, force: true });
    await rename(stagingDirectory, finalDirectory);
    return manifest;
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}

function component(name, repository, commit, license) {
  return Object.freeze({
    name,
    repository: `https://github.com/${repository}`,
    commit,
    license,
    sourceUrl: `https://codeload.github.com/${repository}/tar.gz/${commit}`,
    archiveFile: `${name}-${commit}.tar.gz`,
  });
}

function assertRuntimeProvenance(embeddedGit) {
  const records = Object.values(embeddedGit);
  if (records.length === 0) {
    throw new Error('dugite embedded-git.json contains no runtime archives.');
  }
  const expectedReleaseSegment = `/releases/download/${DUGITE_NATIVE_RELEASE}/`;
  for (const record of records) {
    if (
      typeof record?.name !== 'string' ||
      typeof record?.url !== 'string' ||
      !record.name.includes(`-${DUGITE_NATIVE_BUILD}-`) ||
      !record.url.includes(expectedReleaseSegment)
    ) {
      throw new Error('Bundled Git runtime provenance does not match source-material pins.');
    }
  }
}

function assertSafeOutputDirectory(outputDirectory) {
  if (!isAbsolute(outputDirectory) || outputDirectory === parse(outputDirectory).root) {
    throw new Error(`Unsafe bundled Git source output directory: ${outputDirectory}`);
  }
  if (dirname(outputDirectory) === outputDirectory) {
    throw new Error(`Unsafe bundled Git source output directory: ${outputDirectory}`);
  }
}

async function assertReplaceableOutputDirectory(outputDirectory) {
  let info;
  try {
    info = await lstat(outputDirectory);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  try {
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('not an owned directory');
    const manifest = JSON.parse(
      await readFile(join(outputDirectory, 'SOURCE_MANIFEST.json'), 'utf8'),
    );
    if (manifest.protocol !== 'maka_bundled_git_source_materials_v1') {
      throw new Error('unexpected source-material protocol');
    }
  } catch (error) {
    throw new Error(
      `Bundled Git source output is not owned by the bundled Git source-material protocol: ${outputDirectory}`,
      { cause: error },
    );
  }
}

function sourceReadme() {
  return `Maka bundled Git source materials\n=================================\n\nThese archives are pinned, machine-readable source materials for the Git runtime\nshipped with Maka. Their component licenses are recorded in SOURCE_MANIFEST.json.\nBundling separate Git command-line programs does not change Maka's Apache-2.0 license.\n\nThese convenience archives do not replace Maka's written GPL source offer. See the\nSOURCE_OFFER.txt distributed with the application for the request procedure and the\ncomplete-corresponding-source commitment.\n`;
}

async function main() {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const outputDirectory = resolve(
    process.argv[2] ?? join(repositoryRoot, 'apps', 'desktop', 'release-sources', 'bundled-git'),
  );
  const manifest = await prepareBundledGitSourceMaterials({
    dugiteRoot: join(repositoryRoot, 'node_modules', 'dugite'),
    outputDirectory,
  });
  console.log(
    `[bundled-git-source] wrote ${manifest.components.length} source archives to ${outputDirectory}`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
