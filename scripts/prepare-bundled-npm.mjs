import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const EXPECTED_NPM_VERSION = '12.0.2';
const EXPECTED_APPROVED_RUNTIME_TREE_SHA256 =
  'sha256:930e2370422a82f7650387d37a4c6148bbf185e5def442ba8669550252b468e8';
const SECURITY_PATCHES = Object.freeze([
  Object.freeze({
    packageName: 'tar',
    fromVersion: '7.5.19',
    toVersion: '7.5.22',
    advisories: Object.freeze(['GHSA-r292-9mhp-454m']),
  }),
  Object.freeze({
    packageName: 'brace-expansion',
    fromVersion: '5.0.7',
    toVersion: '5.0.9',
    advisories: Object.freeze(['GHSA-mh99-v99m-4gvg', 'GHSA-rgw5-rvv9-x895']),
  }),
  Object.freeze({
    packageName: 'ip-address',
    fromVersion: '10.2.0',
    toVersion: '10.4.0',
    advisories: Object.freeze([
      'GHSA-mwp4-54f8-5fhr',
      'GHSA-4xrf-jv44-h6hh',
      'GHSA-22jq-vg5j-6vgg',
    ]),
  }),
  Object.freeze({
    packageName: 'undici',
    fromVersion: '6.27.0',
    toVersion: '6.28.0',
    advisories: Object.freeze(['GHSA-8xcm-r25x-g524', 'GHSA-m8rv-5g2x-5cg5', 'GHSA-v3r7-h72x-cjcm']),
  }),
]);

export async function prepareBundledNpm({
  sourceNpmRoot = join(repoRoot, 'node_modules', 'npm'),
  patchedPackagesRoot = join(repoRoot, 'node_modules'),
  runtimeOutputRoot = join(repoRoot, 'apps', 'desktop', '.generated', 'bundled-npm', 'npm'),
  outputPath = join(repoRoot, 'apps', 'desktop', '.generated', 'bundled-npm', 'bundled-npm.json'),
  auditRoot = join(dirname(outputPath), 'audit'),
  sourceLockPath = join(repoRoot, 'package-lock.json'),
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
  for (const patch of SECURITY_PATCHES) {
    await requirePackageVersion(
      join(sourceNpmRoot, 'node_modules', patch.packageName, 'package.json'),
      patch.packageName,
      patch.fromVersion,
      `npm source ${patch.packageName}`,
    );
    await requirePackageVersion(
      join(patchedPackagesRoot, patch.packageName, 'package.json'),
      patch.packageName,
      patch.toVersion,
      `patched ${patch.packageName}`,
    );
  }
  // Validate the immutable inputs before copying so symlink/junction failures
  // have one stable policy error on every platform.
  await inventoryFiles(sourceNpmRoot);
  for (const patch of SECURITY_PATCHES) {
    await inventoryFiles(join(patchedPackagesRoot, patch.packageName));
  }
  await rm(runtimeOutputRoot, { recursive: true, force: true });
  await mkdir(dirname(runtimeOutputRoot), { recursive: true });
  await cp(sourceNpmRoot, runtimeOutputRoot, {
    recursive: true,
    force: false,
    errorOnExist: true,
    verbatimSymlinks: true,
  });
  for (const patch of SECURITY_PATCHES) {
    const runtimePackageRoot = join(runtimeOutputRoot, 'node_modules', patch.packageName);
    await rm(runtimePackageRoot, { recursive: true, force: true });
    await cp(join(patchedPackagesRoot, patch.packageName), runtimePackageRoot, {
      recursive: true,
      force: false,
      errorOnExist: true,
      verbatimSymlinks: true,
    });
  }
  await requireRegularFile(join(runtimeOutputRoot, 'LICENSE'), 'npm license');
  await requireRegularFile(join(runtimeOutputRoot, 'bin', 'npm-cli.js'), 'npm CLI');
  const files = await inventoryFiles(runtimeOutputRoot);
  const runtimeTreeSha256 = sha256(Buffer.from(JSON.stringify(files)));
  const usesRepositoryRuntimeInputs =
    sourceNpmRoot === join(repoRoot, 'node_modules', 'npm') &&
    patchedPackagesRoot === join(repoRoot, 'node_modules');
  if (
    usesRepositoryRuntimeInputs &&
    runtimeTreeSha256 !== EXPECTED_APPROVED_RUNTIME_TREE_SHA256
  ) {
    throw new Error(
      `Bundled npm approved runtime tree mismatch: expected ${EXPECTED_APPROVED_RUNTIME_TREE_SHA256}, received ${runtimeTreeSha256}.`,
    );
  }
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
  await writeBundledRuntimeAuditLock({ auditRoot, sourceLockPath });
  return manifest;
}

async function writeBundledRuntimeAuditLock({ auditRoot, sourceLockPath }) {
  const sourceLock = JSON.parse(await readFile(sourceLockPath, 'utf8'));
  const packages = Object.fromEntries(
    Object.entries(sourceLock.packages ?? {})
      .filter(([path]) => path === 'node_modules/npm' || path.startsWith('node_modules/npm/'))
      .map(([path, value]) => [path, { ...value, dev: false }]),
  );
  for (const patch of SECURITY_PATCHES) {
    const patchedEntry = sourceLock.packages?.[`node_modules/${patch.packageName}`];
    if (!patchedEntry || patchedEntry.version !== patch.toVersion) {
      throw new Error(
        `Bundled npm audit requires ${patch.packageName} ${patch.toVersion} in the root lockfile.`,
      );
    }
    packages[`node_modules/npm/node_modules/${patch.packageName}`] = {
      ...patchedEntry,
      dev: false,
    };
  }
  packages[''] = {
    name: 'maka-bundled-npm-audit',
    version: '1.0.0',
    dependencies: { npm: EXPECTED_NPM_VERSION },
  };
  const auditPackage = {
    name: 'maka-bundled-npm-audit',
    version: '1.0.0',
    private: true,
    dependencies: { npm: EXPECTED_NPM_VERSION },
  };
  const auditLock = {
    name: auditPackage.name,
    version: auditPackage.version,
    lockfileVersion: 3,
    requires: true,
    packages,
  };
  await rm(auditRoot, { recursive: true, force: true });
  await mkdir(auditRoot, { recursive: true });
  await Promise.all([
    writeFile(join(auditRoot, 'package.json'), `${JSON.stringify(auditPackage, null, 2)}\n`, 'utf8'),
    writeFile(
      join(auditRoot, 'package-lock.json'),
      `${JSON.stringify(auditLock, null, 2)}\n`,
      'utf8',
    ),
  ]);
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
