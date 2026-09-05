/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  createReadStream,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRepoRoot = resolve(import.meta.dirname, '..');
const archivePattern = /^apache-maka-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-incubating-src\.tar\.gz$/;
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const requiredReleaseDocuments = ['DISCLAIMER-WIP', 'LICENSE', 'NOTICE'];
const requiredRootFiles = [...requiredReleaseDocuments, 'package.json', 'package-lock.json'];
const forbiddenSegments = new Set(['.agents', '.claude', '.git', '.maka-shots', 'node_modules']);
const forbiddenRootFiles = new Set(['maka-proposal-zh-review.txt']);
const knownNonCategoryXLicenses = new Set([
  '(AFL-2.1 OR BSD-3-Clause)',
  '(MIT OR CC0-1.0)',
  '(MPL-2.0 OR Apache-2.0)',
  '(WTFPL OR MIT)',
  '0BSD',
  'Apache-2.0',
  'BSD',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BlueOak-1.0.0',
  'CC-BY-4.0',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT OR Apache-2.0',
  'MPL-2.0',
  'OFL-1.1',
  'Public Domain',
  'Python-2.0',
  'Unlicense',
  'WTFPL',
  'WTFPL OR ISC',
]);
const categoryXLicensePattern = /(?:^|[^A-Za-z])(?:A?GPL|LGPL)-?\d/i;
const packageDependencyFields = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];
const bundledDependencyFields = ['bundleDependencies', 'bundledDependencies'];
const textSourceExtensions = new Set([
  '.cjs',
  '.css',
  '.csv',
  '.html',
  '.js',
  '.json',
  '.jsonc',
  '.jsonl',
  '.lock',
  '.md',
  '.mjs',
  '.mts',
  '.nsh',
  '.patch',
  '.paths',
  '.plist',
  '.ps1',
  '.py',
  '.rs',
  '.sh',
  '.sql',
  '.svg',
  '.swift',
  '.toml',
  '.ts',
  '.tsv',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
]);
const textSourceBasenames = new Set([
  '.git-blame-ignore-revs',
  '.gitattributes',
  '.gitignore',
  '.mailmap',
  'DISCLAIMER-WIP',
  'Dockerfile',
  'LICENSE',
  'NOTICE',
  'network-policy',
]);
const maxCommandBuffer = 64 * 1024 * 1024;
const rejectedGpgStatuses = new Set([
  'BADSIG',
  'ERRSIG',
  'EXPKEYSIG',
  'EXPSIG',
  'FAILURE',
  'KEYEXPIRED',
  'KEYREVOKED',
  'NODATA',
  'NO_PUBKEY',
  'REVKEYSIG',
]);
const allowedGpgHashAlgorithms = new Set([8, 9, 10]);
const rsaPublicKeyAlgorithms = new Set([1, 2, 3]);
const asciiArmoredSignaturePattern =
  /^-----BEGIN PGP SIGNATURE-----\r?\n(?:[\x20-\x7e]*\r?\n)+-----END PGP SIGNATURE-----\r?\n?$/;

export function sourceCandidateIdentity(version) {
  if (!versionPattern.test(version) || version.includes('incubating')) {
    throw new Error(`Invalid release version: ${version}`);
  }
  const rootDirectory = `apache-maka-${version}-incubating`;
  return {
    archiveName: `${rootDirectory}-src.tar.gz`,
    rootDirectory,
    version,
  };
}

export function parseSha512File(contents, expectedArchiveName) {
  const match = /^([0-9a-fA-F]{128})[ \t]+\*?([^\r\n]+)\r?\n?$/.exec(contents);
  if (!match) throw new Error('The SHA-512 file is not in sha512sum format');
  if (match[2] !== expectedArchiveName) {
    throw new Error(`The SHA-512 file names ${match[2]}, expected ${expectedArchiveName}`);
  }
  return match[1].toLowerCase();
}

export function validateArchiveEntries(entries, rootDirectory) {
  const rootPrefix = `${rootDirectory}/`;
  const seen = new Set();
  const portableEntries = new Map();

  for (const entry of entries) {
    if (!entry) continue;
    if (seen.has(entry)) throw new Error(`Duplicate archive entry: ${entry}`);
    seen.add(entry);
    const portableEntry = entry.normalize('NFC').toLowerCase();
    const conflictingEntry = portableEntries.get(portableEntry);
    if (conflictingEntry && conflictingEntry !== entry) {
      throw new Error(`Cross-platform archive entry collision: ${conflictingEntry}, ${entry}`);
    }
    portableEntries.set(portableEntry, entry);

    if (entry.startsWith('/') || entry.includes('\\')) {
      throw new Error(`Unsafe archive entry: ${entry}`);
    }
    const segments = entry.split('/').filter(Boolean);
    if (segments.includes('..') || segments.includes('.')) {
      throw new Error(`Unsafe archive entry: ${entry}`);
    }
    if (entry !== rootDirectory && !entry.startsWith(rootPrefix)) {
      throw new Error(`Archive entry is outside ${rootDirectory}: ${entry}`);
    }
    if (segments.some((segment) => forbiddenSegments.has(segment))) {
      throw new Error(`Forbidden archive entry: ${entry}`);
    }
    if (segments.length === 2 && forbiddenRootFiles.has(segments[1])) {
      throw new Error(`Forbidden archive entry: ${entry}`);
    }
    if (segments.at(-1) === '.DS_Store') {
      throw new Error(`Forbidden archive entry: ${entry}`);
    }
  }

  for (const requiredFile of requiredRootFiles) {
    const requiredEntry = `${rootPrefix}${requiredFile}`;
    if (!seen.has(requiredEntry)) {
      throw new Error(`Required release document is missing: ${requiredFile}`);
    }
  }
}

export async function createSourceCandidate({
  outputDirectory = join(defaultRepoRoot, 'release/asf'),
  repositoryRoot = defaultRepoRoot,
  revision = 'HEAD',
  version,
}) {
  const identity = sourceCandidateIdentity(version);
  const commit = resolveCandidateCommit({ repositoryRoot, revision, version });
  mkdirSync(outputDirectory, { recursive: true, mode: 0o755 });
  const archivePath = resolve(outputDirectory, identity.archiveName);
  const checksumPath = `${archivePath}.sha512`;
  for (const outputPath of [archivePath, checksumPath, `${archivePath}.asc`]) {
    if (existsSync(outputPath)) {
      throw new Error(`Refusing to overwrite existing release output: ${outputPath}`);
    }
  }

  const temporaryRoot = mkdtempSync(join(dirname(archivePath), '.maka-asf-source-'));
  try {
    const tarPath = join(temporaryRoot, 'source.tar');
    const temporaryArchivePath = join(temporaryRoot, identity.archiveName);
    const temporaryChecksumPath = `${temporaryArchivePath}.sha512`;
    writeSourceTar({ commit, identity, repositoryRoot, tarPath, temporaryRoot });
    execFileSync('gzip', ['-n', '-9', tarPath], {
      env: controlledProcessEnvironment({ excludedNames: ['GZIP'] }),
      stdio: 'inherit',
    });
    renameSync(`${tarPath}.gz`, temporaryArchivePath);
    chmodSync(temporaryArchivePath, 0o644);
    await writeSha512File(temporaryArchivePath, temporaryChecksumPath);
    await verifySourceCandidate({ archivePath: temporaryArchivePath });
    publishSourceCandidate({
      archivePath,
      checksumPath,
      temporaryArchivePath,
      temporaryChecksumPath,
    });
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }

  return { archivePath, commit };
}

export async function verifySourceCandidate({ archivePath, keysPath }) {
  const archiveName = basename(archivePath);
  const match = archivePattern.exec(archiveName);
  if (!match) throw new Error(`Unexpected ASF source archive name: ${archiveName}`);
  if (!existsSync(archivePath)) throw new Error(`Source archive does not exist: ${archivePath}`);
  const identity = sourceCandidateIdentity(match[1]);
  const signaturePath = `${archivePath}.asc`;
  const checksumPath = `${archivePath}.sha512`;
  if (keysPath) {
    if (!existsSync(signaturePath)) {
      throw new Error(`Detached signature does not exist: ${signaturePath}`);
    }
    if (!existsSync(keysPath)) throw new Error(`KEYS file does not exist: ${keysPath}`);
  }
  if (!existsSync(checksumPath)) throw new Error(`SHA-512 file does not exist: ${checksumPath}`);

  if (keysPath) verifyDetachedSignature({ archivePath, keysPath, signaturePath });

  const digest = await verifySha512File(archivePath);
  const entries = execTar(archivePath, ['-tzf'], {
    encoding: 'utf8',
    maxBuffer: maxCommandBuffer,
  }).split(/\r?\n/);
  validateArchiveEntries(entries, identity.rootDirectory);
  validateArchiveContents(archivePath, identity, entries);

  return { archivePath, digest, rootDirectory: identity.rootDirectory, version: identity.version };
}

export async function reproduceSourceCandidate({
  archivePath,
  repositoryRoot = defaultRepoRoot,
  revision,
}) {
  if (!revision) throw new Error('An immutable revision is required to reproduce a candidate');
  const candidate = await verifySourceCandidate({ archivePath });
  const commit = resolveCandidateCommit({
    repositoryRoot,
    revision,
    version: candidate.version,
  });
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'maka-asf-reproduce-'));
  try {
    const candidateTarPath = join(temporaryRoot, 'candidate.tar');
    const reproducedTarPath = join(temporaryRoot, 'reproduced.tar');
    decompressSourceArchive(archivePath, candidateTarPath);
    writeSourceTar({
      commit,
      identity: candidate,
      repositoryRoot,
      tarPath: reproducedTarPath,
      temporaryRoot,
    });
    const [candidateDigest, reproducedDigest] = await Promise.all([
      sha512(candidateTarPath),
      sha512(reproducedTarPath),
    ]);
    if (candidateDigest !== reproducedDigest) {
      throw new Error(`Candidate source payload does not match ${commit} rebuilt on this machine`);
    }
    return { commit };
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
}

export async function signSourceCandidate({
  archivePath,
  gpgHome,
  keyFingerprint,
  repositoryRoot = defaultRepoRoot,
  revision,
}) {
  if (!/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(keyFingerprint)) {
    throw new Error('A complete hexadecimal PGP key fingerprint is required');
  }
  const normalizedFingerprint = keyFingerprint.toUpperCase();
  const selectedFingerprint = resolveSigningKeyFingerprint(normalizedFingerprint, gpgHome);
  if (selectedFingerprint !== normalizedFingerprint) {
    throw new Error(
      `Selected signing key ${selectedFingerprint} does not match ${normalizedFingerprint}`,
    );
  }
  const reproduced = await reproduceSourceCandidate({ archivePath, repositoryRoot, revision });
  const signaturePath = `${archivePath}.asc`;
  if (existsSync(signaturePath)) {
    throw new Error(`Refusing to overwrite existing detached signature: ${signaturePath}`);
  }
  const temporaryRoot = mkdtempSync(join(dirname(archivePath), '.maka-asf-signature-'));
  const temporarySignaturePath = join(temporaryRoot, basename(signaturePath));
  try {
    execFileSync(
      'gpg',
      [
        '--armor',
        '--detach-sign',
        '--digest-algo',
        'SHA512',
        '--local-user',
        normalizedFingerprint,
        '--output',
        temporarySignaturePath,
        archivePath,
      ],
      { stdio: 'inherit', ...gpgHomeOption(gpgHome) },
    );
    chmodSync(temporarySignaturePath, 0o644);
    verifyGpgSignature({ archivePath, gpgHome, signaturePath: temporarySignaturePath });
    linkSync(temporarySignaturePath, signaturePath);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error(`Refusing to overwrite existing detached signature: ${signaturePath}`, {
        cause: error,
      });
    }
    throw error;
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
  return { commit: reproduced.commit, signaturePath };
}

function publishSourceCandidate({
  archivePath,
  checksumPath,
  temporaryArchivePath,
  temporaryChecksumPath,
}) {
  let publishedArchive = false;
  let publishedChecksum = false;
  try {
    linkSync(temporaryChecksumPath, checksumPath);
    publishedChecksum = true;
    linkSync(temporaryArchivePath, archivePath);
    publishedArchive = true;
  } catch (error) {
    if (publishedArchive) rmSync(archivePath, { force: true });
    if (publishedChecksum) rmSync(checksumPath, { force: true });
    if (error?.code === 'EEXIST') {
      const outputPath = publishedChecksum ? archivePath : checksumPath;
      throw new Error(`Refusing to overwrite existing release output: ${outputPath}`, {
        cause: error,
      });
    }
    throw error;
  }
}

function git(repositoryRoot, arguments_, options = {}) {
  const { env, ...execOptions } = options;
  return execFileSync('git', arguments_, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: maxCommandBuffer,
    ...execOptions,
    env: controlledProcessEnvironment({
      excludedPrefixes: ['GIT_'],
      overrides: env,
    }),
  });
}

function resolveCandidateCommit({ repositoryRoot, revision, version }) {
  const commit = git(repositoryRoot, ['rev-parse', '--verify', `${revision}^{commit}`]).trim();
  const packageJson = JSON.parse(git(repositoryRoot, ['show', `${commit}:package.json`]));
  const packageLock = JSON.parse(git(repositoryRoot, ['show', `${commit}:package-lock.json`]));
  validatePackageVersions({ packageJson, packageLock, version, source: `commit ${commit}` });
  validateTrackedNames(repositoryRoot, commit);
  return commit;
}

function writeSourceTar({ commit, identity, repositoryRoot, tarPath, temporaryRoot }) {
  // git archive otherwise consults repository-local, user, and system attributes.
  // The isolated Git directory makes the committed .gitattributes the only policy input.
  const isolatedGitDirectory = join(temporaryRoot, 'git');
  const emptyGitTemplate = join(temporaryRoot, 'git-template');
  const emptyGlobalConfig = join(temporaryRoot, 'gitconfig');
  mkdirSync(emptyGitTemplate);
  writeFileSync(emptyGlobalConfig, '');

  const isolatedEnvironment = {
    GIT_ATTR_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: emptyGlobalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
  };
  git(
    repositoryRoot,
    ['init', '--quiet', '--bare', `--template=${emptyGitTemplate}`, isolatedGitDirectory],
    { env: isolatedEnvironment },
  );

  const gitObjectPath = git(repositoryRoot, ['rev-parse', '--git-path', 'objects']).trim();
  const objectDirectory = realpathSync(resolve(repositoryRoot, gitObjectPath));
  if (objectDirectory.includes('\n') || objectDirectory.includes('\r')) {
    throw new Error(`Git object directory contains an unsupported newline: ${objectDirectory}`);
  }
  writeFileSync(join(isolatedGitDirectory, 'objects/info/alternates'), `${objectDirectory}\n`);

  git(
    repositoryRoot,
    [
      `--git-dir=${isolatedGitDirectory}`,
      '-c',
      `core.attributesFile=${emptyGlobalConfig}`,
      '-c',
      'tar.umask=0002',
      'archive',
      '--format=tar',
      `--prefix=${identity.rootDirectory}/`,
      `--output=${tarPath}`,
      commit,
    ],
    { env: isolatedEnvironment },
  );
}

function decompressSourceArchive(archivePath, tarPath) {
  const output = openSync(tarPath, 'wx', 0o600);
  try {
    try {
      execFileSync('gzip', ['-dc', basename(archivePath)], {
        cwd: dirname(archivePath),
        env: controlledProcessEnvironment({ excludedNames: ['GZIP'] }),
        stdio: ['ignore', output, 'inherit'],
      });
    } finally {
      closeSync(output);
    }
  } catch (error) {
    rmSync(tarPath, { force: true });
    throw error;
  }
}

function validateTrackedNames(repositoryRoot, commit) {
  const names = git(repositoryRoot, ['ls-tree', '-r', '-z', '--name-only', commit])
    .split('\0')
    .filter(Boolean);
  for (const name of names) {
    if (name.includes('\n') || name.includes('\r')) {
      throw new Error(`Release archives do not support newline characters in paths: ${name}`);
    }
  }
}

export function validatePackageVersions({ packageJson, packageLock, source, version }) {
  const versions = [
    ['package.json', packageJson.version],
    ['package-lock.json', packageLock.version],
    ['package-lock.json packages[""]', packageLock.packages?.['']?.version],
  ];
  for (const [name, actualVersion] of versions) {
    if (actualVersion !== version) {
      throw new Error(
        `Version ${version} does not match ${name} in ${source}: ${String(actualVersion)}`,
      );
    }
  }
}

async function writeSha512File(archivePath, checksumPath) {
  const digest = await sha512(archivePath);
  writeFileSync(checksumPath, `${digest}  ${basename(archivePath)}\n`, {
    encoding: 'utf8',
    mode: 0o644,
  });
}

function readSha512File(archivePath) {
  const archiveName = basename(archivePath);
  const checksumPath = `${archivePath}.sha512`;
  if (!existsSync(checksumPath)) throw new Error(`SHA-512 file does not exist: ${checksumPath}`);
  return parseSha512File(readFileSync(checksumPath, 'utf8'), archiveName);
}

async function verifySha512File(archivePath) {
  const expected = readSha512File(archivePath);
  const digest = await sha512(archivePath);
  if (digest !== expected) {
    throw new Error(`SHA-512 mismatch for ${basename(archivePath)}`);
  }
  return digest;
}

async function sha512(path) {
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function validateArchiveContents(archivePath, identity, entries) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'maka-asf-contents-'));
  try {
    execTar(archivePath, ['-xzf', '-C', temporaryRoot], { stdio: 'ignore' });
    const candidateRoot = join(temporaryRoot, identity.rootDirectory);
    for (const entry of entries.filter(Boolean)) {
      const path = join(temporaryRoot, entry);
      const type = lstatSync(path);
      if (!type.isDirectory() && !type.isFile()) {
        throw new Error(`Unsupported archive entry type: ${entry}`);
      }
    }

    for (const requiredFile of requiredReleaseDocuments) {
      const contents = readFileSync(join(candidateRoot, requiredFile), 'utf8');
      if (!contents.trim()) throw new Error(`${requiredFile} is empty`);
      if (
        requiredFile === 'DISCLAIMER-WIP' &&
        (!contents.includes('Apache Maka') || !contents.includes('incubation'))
      ) {
        throw new Error('DISCLAIMER-WIP does not identify Apache Maka as an incubating project');
      }
    }

    const packageJson = JSON.parse(readFileSync(join(candidateRoot, 'package.json'), 'utf8'));
    const packageLock = JSON.parse(readFileSync(join(candidateRoot, 'package-lock.json'), 'utf8'));
    validatePackageVersions({
      packageJson,
      packageLock,
      source: basename(archivePath),
      version: identity.version,
    });
    validateNodePackageInputs(candidateRoot, identity, entries);
    validateNonTextInputs(candidateRoot, identity, entries);
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
}

function validateNodePackageInputs(candidateRoot, identity, entries) {
  const files = entries.filter((entry) => entry && !entry.endsWith('/'));
  const rootPrefix = `${identity.rootDirectory}/`;
  const readEntry = (entry) =>
    readFileSync(join(candidateRoot, entry.slice(rootPrefix.length)), 'utf8');
  const noticeLicenses = new Map();
  const generatedNpmNotice = `${rootPrefix}apps/desktop/resources/licenses/npm/THIRD_PARTY_NOTICES.txt`;
  if (files.includes(generatedNpmNotice)) {
    const entry = generatedNpmNotice;
    for (const block of readEntry(entry).split(/\n={20,}\n/u)) {
      const packageKey = /^Package: (.+)$/mu.exec(block)?.[1];
      const license = /^Selected license: (.+)$/mu.exec(block)?.[1];
      if (!packageKey || !license) continue;
      const previous = noticeLicenses.get(packageKey);
      if (previous && previous !== license) {
        throw new Error(`Conflicting license inventory for ${packageKey}: ${previous}, ${license}`);
      }
      noticeLicenses.set(packageKey, license);
    }
  }

  const lockEntries = files.filter((name) =>
    /\/(?:package-lock|npm-shrinkwrap)\.json$/u.test(name),
  );
  const parsedLocks = new Map();
  const readLock = (entry) => {
    if (parsedLocks.has(entry)) return parsedLocks.get(entry);
    const lock = parseArchiveJson(readEntry(entry), entry);
    if (lock.lockfileVersion !== 3 || Object.hasOwn(lock, 'dependencies')) {
      throw new Error(
        `Unsupported npm lockfile version ${lock.lockfileVersion} or schema: ${entry}`,
      );
    }
    if (!lock.packages || typeof lock.packages !== 'object' || Array.isArray(lock.packages)) {
      throw new Error(`Cannot safely classify package lockfile without packages: ${entry}`);
    }
    parsedLocks.set(entry, lock);
    return lock;
  };

  const manifests = new Map(
    files
      .filter((name) => name.endsWith('/package.json'))
      .map((entry) => [entry, parseArchiveJson(readEntry(entry), entry)]),
  );
  const rootLockEntry = `${rootPrefix}package-lock.json`;
  for (const [entry, manifest] of manifests) {
    if (manifest.license) validateReleaseLicense(manifest.license, entry);
    else if (manifest.private !== true) {
      throw new Error(`Cannot safely classify package manifest without a license: ${entry}`);
    }
    const dependencyNames = declaredPackageDependencies(manifest, entry);
    if (dependencyNames.length > 0) {
      const directory = dirname(entry);
      const lockEntry = [
        `${directory}/npm-shrinkwrap.json`,
        `${directory}/package-lock.json`,
        rootLockEntry,
      ].find((name) => lockEntries.includes(name));
      if (!lockEntry) {
        throw new Error(`Cannot safely classify package manifest ${entry} without lock provenance`);
      }
      const lock = readLock(lockEntry);
      for (const name of dependencyNames) {
        if (
          !Object.keys(lock.packages).some(
            (lockPath) =>
              lockPath === `node_modules/${name}` || lockPath.endsWith(`/node_modules/${name}`),
          )
        ) {
          throw new Error(
            `Cannot safely classify ${name} declared by ${entry} without matching lock provenance`,
          );
        }
      }
    }
  }

  for (const entry of files.filter((name) => /\/(?:pnpm-lock\.yaml|yarn\.lock)$/u.test(name))) {
    throw new Error(`Cannot safely classify unsupported package lockfile: ${entry}`);
  }
  for (const entry of lockEntries) {
    const lock = readLock(entry);
    for (const [lockPath, dependency] of Object.entries(lock.packages)) {
      if (!lockPath) continue;
      if (dependency?.link === true) {
        const name = lockPath.slice(lockPath.lastIndexOf('node_modules/') + 13);
        const targetManifestEntry = join(dirname(entry), dependency.resolved ?? '', 'package.json');
        const targetManifest = manifests.get(targetManifestEntry);
        const targetLockPath = dependency.resolved;
        const targetLock = targetLockPath ? lock.packages[targetLockPath] : undefined;
        if (
          !targetManifest ||
          targetManifest.name !== name ||
          !targetLock ||
          targetLock.name !== targetManifest.name ||
          targetLock.version !== targetManifest.version
        ) {
          throw new Error(`Cannot safely classify workspace link ${name} in ${entry}`);
        }
        continue;
      }
      if (!lockPath.includes('node_modules/')) {
        const manifestEntry = join(dirname(entry), lockPath, 'package.json');
        const manifest = manifests.get(manifestEntry);
        if (!manifest || manifest.name !== dependency.name) {
          throw new Error(`Cannot safely classify workspace package ${lockPath} in ${entry}`);
        }
        if (dependency.version !== manifest.version) {
          throw new Error(`Workspace version mismatch for ${lockPath} in ${entry}`);
        }
        if (dependency.license) {
          validateReleaseLicense(dependency.license, `${lockPath} in ${entry}`);
        }
        continue;
      }
      const name = dependency.name ?? lockPath.slice(lockPath.lastIndexOf('node_modules/') + 13);
      const version = dependency.version;
      const packageKey = version ? `${name}@${version}` : undefined;
      const license =
        (packageKey ? noticeLicenses.get(packageKey) : undefined) ?? dependency.license;
      if (!license) {
        throw new Error(
          `Cannot safely classify ${name}${version ? `@${version}` : ''} in ${entry}`,
        );
      }
      validateReleaseLicense(license, `${name}${version ? `@${version}` : ''} in ${entry}`);
    }
  }
}

function declaredPackageDependencies(manifest, entry) {
  const names = new Set();
  for (const field of packageDependencyFields) {
    const dependencies = manifest[field];
    if (dependencies === undefined) continue;
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
      throw new Error(`Invalid ${field} in package manifest: ${entry}`);
    }
    for (const name of Object.keys(dependencies)) names.add(name);
  }
  for (const field of bundledDependencyFields) {
    const dependencies = manifest[field];
    if (dependencies === undefined) continue;
    if (!Array.isArray(dependencies) || dependencies.some((name) => typeof name !== 'string')) {
      throw new Error(`Invalid ${field} in package manifest: ${entry}`);
    }
    for (const name of dependencies) names.add(name);
  }
  return [...names];
}

function parseArchiveJson(contents, entry) {
  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new Error(`Invalid JSON release input: ${entry}`, { cause: error });
  }
}

function validateReleaseLicense(license, source) {
  if (typeof license !== 'string' || !license.trim()) {
    throw new Error(`Cannot safely classify the license for ${source}`);
  }
  if (categoryXLicensePattern.test(license)) {
    throw new Error(`Category X dependency ${source} declares ${license}`);
  }
  if (!knownNonCategoryXLicenses.has(license)) {
    throw new Error(`Cannot safely classify license ${license} for ${source}`);
  }
}

function validateNonTextInputs(candidateRoot, identity, entries) {
  const files = entries.filter((entry) => entry && !entry.endsWith('/'));
  const readEntry = (entry) =>
    readFileSync(join(candidateRoot, entry.slice(`${identity.rootDirectory}/`.length)));
  const provenanceEntry = `${identity.rootDirectory}/docs/code-origin-audit.md`;
  const provenancePatterns = files.includes(provenanceEntry)
    ? sourceNonTextProvenancePatterns(readEntry(provenanceEntry).toString('utf8'))
    : [];
  const decoder = new TextDecoder('utf-8', { fatal: true });

  for (const entry of files) {
    const contents = readEntry(entry);
    const compiledFormat = compiledArtifactFormat(contents);
    if (compiledFormat) {
      throw new Error(`Compiled artifact ${entry} has forbidden ${compiledFormat} content`);
    }
    try {
      const text = decoder.decode(contents);
      const basename = entry.slice(entry.lastIndexOf('/') + 1);
      const extension = extname(basename).toLowerCase();
      if (
        !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text) &&
        (textSourceExtensions.has(extension) || textSourceBasenames.has(basename))
      ) {
        continue;
      }
    } catch {
      // Invalid UTF-8 continues to the candidate-owned provenance inventory.
    }
    const imageFormat = sourceImageFormat(contents);
    const relativePath = entry.slice(`${identity.rootDirectory}/`.length);
    if (
      provenancePatterns.some((pattern) => sourceInventoryPatternMatches(pattern, relativePath))
    ) {
      continue;
    }
    throw new Error(
      `Cannot safely classify non-text release input ${entry}${imageFormat ? ` (${imageFormat})` : ''}`,
    );
  }
}

function compiledArtifactFormat(contents) {
  const prefix = contents.subarray(0, 8);
  if (prefix.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return 'ELF';
  if (prefix.subarray(0, 2).equals(Buffer.from('MZ'))) return 'PE';
  if (prefix.subarray(0, 4).equals(Buffer.from([0x00, 0x61, 0x73, 0x6d]))) return 'WASM';
  if (prefix.subarray(0, 4).equals(Buffer.from([0xbe, 0xba, 0xfe, 0xca]))) {
    return 'Mach-O fat little-endian';
  }
  if (prefix.subarray(0, 4).equals(Buffer.from([0xbf, 0xba, 0xfe, 0xca]))) {
    return 'Mach-O fat64 little-endian';
  }
  if (
    [
      [0xfe, 0xed, 0xfa, 0xce],
      [0xfe, 0xed, 0xfa, 0xcf],
      [0xce, 0xfa, 0xed, 0xfe],
      [0xcf, 0xfa, 0xed, 0xfe],
      [0xca, 0xfe, 0xba, 0xbe],
      [0xca, 0xfe, 0xba, 0xbf],
    ].some((magic) => prefix.subarray(0, 4).equals(Buffer.from(magic)))
  ) {
    return 'Mach-O';
  }
  if (
    [
      [0x50, 0x4b, 0x03, 0x04],
      [0x50, 0x4b, 0x05, 0x06],
      [0x50, 0x4b, 0x07, 0x08],
    ].some((magic) => contents.indexOf(Buffer.from(magic)) !== -1)
  ) {
    return 'ZIP/JAR';
  }
  if (prefix.equals(Buffer.from('!<arch>\n'))) return 'ar archive';
  if (prefix.equals(Buffer.from('!<thin>\n'))) return 'thin ar archive';
  return undefined;
}

function sourceImageFormat(contents) {
  const prefix = contents.subarray(0, 12);
  if (prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'PNG';
  if (prefix.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'JPEG';
  if (
    prefix
      .subarray(0, 6)
      .toString('ascii')
      .match(/^GIF8[79]a$/u)
  )
    return 'GIF';
  if (
    prefix.subarray(0, 4).toString('ascii') === 'RIFF' &&
    prefix.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'WebP';
  }
  return undefined;
}

function sourceNonTextProvenancePatterns(provenance) {
  const section = provenance
    .split('### Source archive non-text inventory\n', 2)[1]
    ?.split(/\n#{1,3} /u, 1)[0];
  if (!section) return [];
  return [...section.matchAll(/^- `([^`]+)`:/gmu)].map((match) => {
    const pattern = match[1];
    if (
      pattern.startsWith('/') ||
      pattern.startsWith('*') ||
      pattern.startsWith('?') ||
      pattern.split('/').includes('..')
    ) {
      throw new Error(`Unsafe source archive inventory pattern: ${pattern}`);
    }
    return pattern;
  });
}

function sourceInventoryPatternMatches(pattern, path) {
  let expression = '';
  for (let index = 0; index < pattern.length; index += 1) {
    if (pattern.slice(index, index + 3) === '**/') {
      expression += '(?:.*/)?';
      index += 2;
    } else if (pattern.slice(index, index + 2) === '**') {
      expression += '.*';
      index += 1;
    } else if (pattern[index] === '*') {
      expression += '[^/]*';
    } else {
      expression += pattern[index].replace(/[.+?^${}()|[\]\\]/u, '\\$&');
    }
  }
  return new RegExp(`^${expression}$`, 'u').test(path);
}

function verifyDetachedSignature({ archivePath, keysPath, signaturePath }) {
  if (!existsSync(keysPath)) throw new Error(`KEYS file does not exist: ${keysPath}`);
  const temporaryHome = mkdtempSync(join(tmpdir(), 'maka-gpg-'));
  chmodSync(temporaryHome, 0o700);
  try {
    execFileSync('gpg', ['--batch', '--homedir', temporaryHome, '--import', keysPath], {
      stdio: 'inherit',
    });
    verifyGpgSignature({
      archivePath,
      gpgHome: temporaryHome,
      signaturePath,
    });
  } finally {
    rmSync(temporaryHome, { force: true, recursive: true });
  }
}

function validateAsciiArmoredSignature(signaturePath) {
  const contents = readFileSync(signaturePath);
  const isAscii = contents.every(
    (byte) => byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126),
  );
  const text = contents.toString('utf8');
  const beginMarkers = text.match(/-----BEGIN PGP SIGNATURE-----/g)?.length ?? 0;
  const endMarkers = text.match(/-----END PGP SIGNATURE-----/g)?.length ?? 0;
  if (
    !isAscii ||
    beginMarkers !== 1 ||
    endMarkers !== 1 ||
    !asciiArmoredSignaturePattern.test(text)
  ) {
    throw new Error('Detached signature must be exactly one ASCII-armored PGP signature block');
  }
}

function execTar(archivePath, arguments_, options) {
  return execFileSync('tar', [arguments_[0], basename(archivePath), ...arguments_.slice(1)], {
    cwd: dirname(archivePath),
    ...options,
    env: controlledProcessEnvironment({
      excludedNames: ['GZIP', 'TAR_OPTIONS', 'TAR_READER_OPTIONS'],
    }),
  });
}

export function controlledProcessEnvironment({
  excludedNames = [],
  excludedPrefixes = [],
  overrides = {},
} = {}) {
  const normalizedExcludedNames = new Set(excludedNames.map((name) => name.toUpperCase()));
  const normalizedExcludedPrefixes = excludedPrefixes.map((prefix) => prefix.toUpperCase());
  const environment = {};
  for (const [name, value] of Object.entries(process.env)) {
    const normalizedName = name.toUpperCase();
    if (normalizedExcludedNames.has(normalizedName)) continue;
    if (normalizedExcludedPrefixes.some((prefix) => normalizedName.startsWith(prefix))) continue;
    environment[name] = value;
  }
  return { ...environment, ...overrides };
}

function gpgHomeOption(gpgHome) {
  return gpgHome ? { env: { ...process.env, GNUPGHOME: gpgHome } } : {};
}

function resolveSigningKeyFingerprint(keyFingerprint, gpgHome) {
  const output = execFileSync(
    'gpg',
    ['--batch', '--with-colons', '--fingerprint', '--list-secret-keys', keyFingerprint],
    { encoding: 'utf8', maxBuffer: maxCommandBuffer, ...gpgHomeOption(gpgHome) },
  );
  let expectsPrimaryFingerprint = false;
  const primaryFingerprints = [];
  for (const line of output.split(/\r?\n/)) {
    const fields = line.split(':');
    if (fields[0] === 'sec') {
      expectsPrimaryFingerprint = true;
      continue;
    }
    if (fields[0] === 'fpr' && expectsPrimaryFingerprint) {
      primaryFingerprints.push(fields[9]?.toUpperCase());
      expectsPrimaryFingerprint = false;
    }
  }
  if (primaryFingerprints.length !== 1 || !primaryFingerprints[0]) {
    throw new Error(`Expected exactly one secret key for fingerprint ${keyFingerprint}`);
  }
  return primaryFingerprints[0];
}

export function validateGpgVerificationStatus(statusOutput) {
  const statuses = statusOutput
    .split(/\r?\n/)
    .filter((line) => line.startsWith('[GNUPG:] '))
    .map((line) => line.slice('[GNUPG:] '.length).split(' '));
  const rejected = statuses.find(([status]) => rejectedGpgStatuses.has(status));
  if (rejected) throw new Error(`GPG rejected the signature with status ${rejected[0]}`);
  const goodSignatures = statuses.filter(([status]) => status === 'GOODSIG');
  const validSignatures = statuses.filter(([status]) => status === 'VALIDSIG');
  if (goodSignatures.length !== 1 || validSignatures.length !== 1) {
    throw new Error('GPG did not report exactly one good, valid signature');
  }
  return {
    fingerprint: validSignatures[0][1],
    hashAlgorithm: Number(validSignatures[0][8]),
  };
}

function validateSigningKeyPolicy({ fingerprint, gpgHome, hashAlgorithm }) {
  if (!allowedGpgHashAlgorithms.has(hashAlgorithm)) {
    throw new Error(
      `Signature from ${fingerprint} must use SHA-256, SHA-384, or SHA-512; found hash algorithm ${hashAlgorithm}`,
    );
  }
  const output = execFileSync(
    'gpg',
    ['--batch', '--with-colons', '--with-fingerprint', '--list-keys', fingerprint],
    { encoding: 'utf8', maxBuffer: maxCommandBuffer, ...gpgHomeOption(gpgHome) },
  );
  let key;
  for (const line of output.split(/\r?\n/)) {
    const fields = line.split(':');
    if (fields[0] === 'pub' || fields[0] === 'sub') {
      key = {
        bits: Number(fields[2]),
        publicKeyAlgorithm: Number(fields[3]),
      };
      continue;
    }
    if (fields[0] !== 'fpr' || fields[9]?.toUpperCase() !== fingerprint.toUpperCase()) continue;
    if (
      !key ||
      !rsaPublicKeyAlgorithms.has(key.publicKeyAlgorithm) ||
      !Number.isInteger(key.bits) ||
      key.bits < 2048
    ) {
      throw new Error(
        `Signing key ${fingerprint} must be RSA with at least 2048 bits; found algorithm ${String(key?.publicKeyAlgorithm)}, ${String(key?.bits)} bits`,
      );
    }
    return;
  }
  throw new Error(`Could not resolve signing key ${fingerprint} in the selected keyring`);
}

function verifyGpgSignature({ archivePath, gpgHome, signaturePath }) {
  validateAsciiArmoredSignature(signaturePath);
  const result = spawnSync(
    'gpg',
    ['--batch', '--status-fd', '1', '--verify', signaturePath, archivePath],
    {
      encoding: 'utf8',
      maxBuffer: maxCommandBuffer,
      ...gpgHomeOption(gpgHome),
    },
  );
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  const signature = validateGpgVerificationStatus(result.stdout);
  if (result.status !== 0)
    throw new Error(`GPG verification failed with exit code ${result.status}`);
  validateSigningKeyPolicy({
    fingerprint: signature.fingerprint,
    gpgHome,
    hashAlgorithm: signature.hashAlgorithm,
  });
}

function parseCommandLine(arguments_) {
  const [command, ...tokens] = arguments_;
  const options = new Map();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const value = tokens[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${token}`);
    const name = token.slice(2);
    if (options.has(name)) throw new Error(`Duplicate option: ${token}`);
    options.set(name, value);
    index += 1;
  }
  return { command, options };
}

function validateOptions(options, allowed) {
  for (const name of options.keys()) {
    if (!allowed.has(name)) throw new Error(`Unsupported option: --${name}`);
  }
}

function requireOption(options, name) {
  const value = options.get(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

async function main() {
  const { command, options } = parseCommandLine(process.argv.slice(2));
  if (command === 'create') {
    validateOptions(options, new Set(['revision', 'version']));
    const result = await createSourceCandidate({
      revision: options.get('revision') ?? 'HEAD',
      version: requireOption(options, 'version'),
    });
    console.log(`Created ${result.archivePath}`);
    console.log(`Commit ${result.commit}`);
    return;
  }
  if (command === 'verify') {
    validateOptions(options, new Set(['artifact', 'keys']));
    const result = await verifySourceCandidate({
      archivePath: resolve(requireOption(options, 'artifact')),
      keysPath: options.get('keys') ? resolve(options.get('keys')) : undefined,
    });
    console.log(`Verified ${result.archivePath}`);
    console.log(`SHA-512 ${result.digest}`);
    return;
  }
  if (command === 'sign') {
    validateOptions(options, new Set(['artifact', 'key', 'revision']));
    const result = await signSourceCandidate({
      archivePath: resolve(requireOption(options, 'artifact')),
      keyFingerprint: requireOption(options, 'key'),
      revision: requireOption(options, 'revision'),
    });
    console.log(`Reproduced commit ${result.commit}`);
    console.log(`Created ${result.signaturePath}`);
    return;
  }
  throw new Error('Usage: asf-source-release.mjs <create|verify|sign> [options]');
}

if (
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
