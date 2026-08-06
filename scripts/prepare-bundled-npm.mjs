import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const EXPECTED_NPM_VERSION = '12.0.2';
const EXPECTED_SOURCE_TAR_VERSION = '7.5.19';
const PATCHED_TAR_VERSION = '7.5.22';
const SECURITY_PATCHES = Object.freeze([
  Object.freeze({
    packageName: 'tar',
    fromVersion: EXPECTED_SOURCE_TAR_VERSION,
    toVersion: PATCHED_TAR_VERSION,
    advisory: 'GHSA-r292-9mhp-454m',
  }),
]);

export async function prepareBundledNpm({
  sourceNpmRoot = join(repoRoot, 'node_modules', 'npm'),
  patchedTarRoot = join(repoRoot, 'node_modules', 'tar'),
  runtimeOutputRoot = join(repoRoot, 'apps', 'desktop', '.generated', 'bundled-npm', 'npm'),
  outputPath = join(repoRoot, 'apps', 'desktop', '.generated', 'bundled-npm', 'bundled-npm.json'),
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const packageManifest = JSON.parse(await readFile(join(sourceNpmRoot, 'package.json'), 'utf8'));
  if (
    packageManifest.name !== 'npm' ||
    packageManifest.version !== EXPECTED_NPM_VERSION ||
    packageManifest.license !== 'Artistic-2.0'
  ) {
    throw new Error(
      `Bundled npm preparation requires npm ${EXPECTED_NPM_VERSION} under Artistic-2.0.`,
    );
  }
  await requirePackageVersion(
    join(sourceNpmRoot, 'node_modules', 'tar', 'package.json'),
    'tar',
    EXPECTED_SOURCE_TAR_VERSION,
    'npm source tar',
  );
  await requirePackageVersion(
    join(patchedTarRoot, 'package.json'),
    'tar',
    PATCHED_TAR_VERSION,
    'patched tar',
  );
  // Validate the immutable inputs before copying so symlink/junction failures
  // have one stable policy error on every platform.
  await inventoryFiles(sourceNpmRoot);
  await inventoryFiles(patchedTarRoot);
  await rm(runtimeOutputRoot, { recursive: true, force: true });
  await mkdir(dirname(runtimeOutputRoot), { recursive: true });
  await cp(sourceNpmRoot, runtimeOutputRoot, {
    recursive: true,
    force: false,
    errorOnExist: true,
    verbatimSymlinks: true,
  });
  const runtimeTarRoot = join(runtimeOutputRoot, 'node_modules', 'tar');
  await rm(runtimeTarRoot, { recursive: true, force: true });
  await cp(patchedTarRoot, runtimeTarRoot, {
    recursive: true,
    force: false,
    errorOnExist: true,
    verbatimSymlinks: true,
  });
  await requireRegularFile(join(runtimeOutputRoot, 'LICENSE'), 'npm license');
  await requireRegularFile(join(runtimeOutputRoot, 'bin', 'npm-cli.js'), 'npm CLI');
  const files = await inventoryFiles(runtimeOutputRoot);
  const identity = JSON.stringify({
    protocol: 'maka_bundled_npm_runtime_identity_v1',
    npmVersion: EXPECTED_NPM_VERSION,
    platform,
    arch,
    securityPatches: SECURITY_PATCHES,
    files,
  });
  const manifest = {
    schemaVersion: 1,
    protocol: 'maka_bundled_npm_runtime_v1',
    provider: 'desktop/npm-cli',
    npmVersion: EXPECTED_NPM_VERSION,
    platform,
    arch,
    securityPatches: SECURITY_PATCHES,
    runtimeRootRelativePath: 'npm',
    cliRelativePath: 'npm/bin/npm-cli.js',
    files,
    runtimeIdentitySha256: sha256(Buffer.from(identity)),
    distributionReady: true,
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

async function requirePackageVersion(path, name, version, label) {
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  if (manifest.name !== name || manifest.version !== version) {
    throw new Error(`${label} must be ${name}@${version}.`);
  }
}

async function inventoryFiles(root) {
  const files = [];
  await walk(root, root, files);
  files.sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
  return files;
}

async function walk(root, directory, files) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = join(directory, entry.name);
    const info = await lstat(absolutePath);
    if (entry.isDirectory() && !info.isSymbolicLink()) {
      await walk(root, absolutePath, files);
      continue;
    }
    if (!entry.isFile() || info.isSymbolicLink()) {
      throw new Error('Bundled npm runtime may contain only regular files and directories.');
    }
    files.push({
      path: relative(root, absolutePath).replaceAll('\\', '/'),
      bytes: info.size,
      sha256: await sha256File(absolutePath),
    });
  }
}

async function requireRegularFile(path, label) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file: ${path}`);
  }
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const manifest = await prepareBundledNpm();
  console.log(
    `Prepared bundled npm ${manifest.npmVersion} for ${manifest.platform}-${manifest.arch}.`,
  );
}
