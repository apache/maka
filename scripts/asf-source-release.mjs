import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRepoRoot = resolve(import.meta.dirname, '..');
const archivePattern = /^apache-maka-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-incubating-src\.tar\.gz$/;
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const requiredReleaseDocuments = ['DISCLAIMER-WIP', 'LICENSE', 'NOTICE'];
const requiredRootFiles = [...requiredReleaseDocuments, 'package.json', 'package-lock.json'];
const forbiddenSegments = new Set(['.agents', '.claude', '.git', '.maka-shots', 'node_modules']);
const forbiddenRootFiles = new Set(['maka-proposal-zh-review.txt']);
const maxCommandBuffer = 64 * 1024 * 1024;

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

  for (const entry of entries) {
    if (!entry) continue;
    if (seen.has(entry)) throw new Error(`Duplicate archive entry: ${entry}`);
    seen.add(entry);

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

  return seen;
}

export async function createSourceCandidate({
  outputDirectory = join(defaultRepoRoot, 'release/asf'),
  repositoryRoot = defaultRepoRoot,
  revision = 'HEAD',
  version,
}) {
  const identity = sourceCandidateIdentity(version);
  const commit = git(repositoryRoot, ['rev-parse', '--verify', `${revision}^{commit}`]).trim();
  const packageJson = JSON.parse(git(repositoryRoot, ['show', `${commit}:package.json`]));
  if (packageJson.version !== version) {
    throw new Error(
      `Version ${version} does not match package.json at ${commit}: ${packageJson.version}`,
    );
  }

  validateTrackedNames(repositoryRoot, commit);
  mkdirSync(outputDirectory, { recursive: true, mode: 0o755 });
  const archivePath = resolve(outputDirectory, identity.archiveName);
  const checksumPath = `${archivePath}.sha512`;
  for (const outputPath of [archivePath, checksumPath, `${archivePath}.asc`]) {
    if (existsSync(outputPath)) {
      throw new Error(`Refusing to overwrite existing release output: ${outputPath}`);
    }
  }

  const temporaryRoot = mkdtempSync(join(tmpdir(), 'maka-asf-source-'));
  try {
    const tarPath = join(temporaryRoot, 'source.tar');
    git(repositoryRoot, [
      'archive',
      '--format=tar',
      `--prefix=${identity.rootDirectory}/`,
      `--output=${tarPath}`,
      commit,
    ]);
    execFileSync('gzip', ['-n', '-9', tarPath], { stdio: 'inherit' });
    copyFileSync(`${tarPath}.gz`, archivePath);
    chmodSync(archivePath, 0o644);
    await writeSha512File(archivePath, checksumPath);
    await verifySourceCandidate({ archivePath });
  } catch (error) {
    rmSync(archivePath, { force: true });
    rmSync(checksumPath, { force: true });
    throw error;
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }

  return { ...identity, archivePath, checksumPath, commit };
}

export async function verifySourceCandidate({
  archivePath,
  keysPath,
  requireSignature = false,
  signaturePath = `${archivePath}.asc`,
}) {
  const archiveName = basename(archivePath);
  const match = archivePattern.exec(archiveName);
  if (!match) throw new Error(`Unexpected ASF source archive name: ${archiveName}`);
  if (!existsSync(archivePath)) throw new Error(`Source archive does not exist: ${archivePath}`);

  const identity = sourceCandidateIdentity(match[1]);
  const checksumPath = `${archivePath}.sha512`;
  if (!existsSync(checksumPath)) throw new Error(`SHA-512 file does not exist: ${checksumPath}`);
  const expectedDigest = parseSha512File(readFileSync(checksumPath, 'utf8'), archiveName);
  const actualDigest = await sha512(archivePath);
  if (actualDigest !== expectedDigest) {
    throw new Error(`SHA-512 mismatch for ${archiveName}`);
  }

  const entries = execFileSync('tar', ['-tzf', archivePath], {
    encoding: 'utf8',
    maxBuffer: maxCommandBuffer,
  }).split(/\r?\n/);
  validateArchiveEntries(entries, identity.rootDirectory);
  validateArchiveContents(archivePath, identity);

  if (requireSignature || keysPath) {
    if (!keysPath) throw new Error('--keys is required when verifying a signature');
    if (!existsSync(signaturePath)) {
      throw new Error(`Detached signature does not exist: ${signaturePath}`);
    }
    verifyDetachedSignature({ archivePath, keysPath, signaturePath });
  }

  return { ...identity, archivePath, checksumPath, digest: actualDigest, signaturePath };
}

export async function signSourceCandidate({ archivePath, keyFingerprint }) {
  if (!/^[0-9a-fA-F]{16,64}$/.test(keyFingerprint)) {
    throw new Error('A full or long-form hexadecimal PGP key fingerprint is required');
  }
  await verifySourceCandidate({ archivePath });
  const signaturePath = `${archivePath}.asc`;
  if (existsSync(signaturePath)) {
    throw new Error(`Refusing to overwrite existing detached signature: ${signaturePath}`);
  }
  execFileSync(
    'gpg',
    [
      '--armor',
      '--detach-sign',
      '--local-user',
      keyFingerprint,
      '--output',
      signaturePath,
      archivePath,
    ],
    { stdio: 'inherit' },
  );
  chmodSync(signaturePath, 0o644);
  execFileSync('gpg', ['--verify', signaturePath, archivePath], { stdio: 'inherit' });
  return signaturePath;
}

function git(repositoryRoot, arguments_, options = {}) {
  return execFileSync('git', arguments_, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: maxCommandBuffer,
    ...options,
  });
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

async function writeSha512File(archivePath, checksumPath) {
  const digest = await sha512(archivePath);
  writeFileSync(checksumPath, `${digest}  ${basename(archivePath)}\n`, {
    encoding: 'utf8',
    mode: 0o644,
  });
}

async function sha512(path) {
  const hash = createHash('sha512');
  hash.update(readFileSync(path));
  return hash.digest('hex');
}

function validateArchiveContents(archivePath, identity) {
  for (const requiredFile of requiredReleaseDocuments) {
    const contents = execFileSync(
      'tar',
      ['-xOzf', archivePath, `${identity.rootDirectory}/${requiredFile}`],
      { encoding: 'utf8', maxBuffer: maxCommandBuffer },
    );
    if (!contents.trim()) throw new Error(`${requiredFile} is empty`);
  }
  const disclaimer = execFileSync(
    'tar',
    ['-xOzf', archivePath, `${identity.rootDirectory}/DISCLAIMER-WIP`],
    { encoding: 'utf8', maxBuffer: maxCommandBuffer },
  );
  if (!disclaimer.includes('Apache Maka') || !disclaimer.includes('incubation')) {
    throw new Error('DISCLAIMER-WIP does not identify Apache Maka as an incubating project');
  }

  const packageJson = JSON.parse(
    execFileSync('tar', ['-xOzf', archivePath, `${identity.rootDirectory}/package.json`], {
      encoding: 'utf8',
      maxBuffer: maxCommandBuffer,
    }),
  );
  if (packageJson.version !== identity.version) {
    throw new Error(
      `Archive version ${identity.version} does not match package.json: ${packageJson.version}`,
    );
  }
}

function verifyDetachedSignature({ archivePath, keysPath, signaturePath }) {
  if (!existsSync(keysPath)) throw new Error(`KEYS file does not exist: ${keysPath}`);
  const temporaryHome = mkdtempSync(join(tmpdir(), 'maka-gpg-'));
  chmodSync(temporaryHome, 0o700);
  try {
    execFileSync('gpg', ['--batch', '--homedir', temporaryHome, '--import', keysPath], {
      stdio: 'inherit',
    });
    execFileSync(
      'gpg',
      ['--batch', '--homedir', temporaryHome, '--verify', signaturePath, archivePath],
      { stdio: 'inherit' },
    );
  } finally {
    rmSync(temporaryHome, { force: true, recursive: true });
  }
}

function parseCommandLine(arguments_) {
  const [command, ...tokens] = arguments_;
  const options = new Map();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    if (token === '--require-signature') {
      if (options.has('require-signature')) throw new Error(`Duplicate option: ${token}`);
      options.set('require-signature', true);
      continue;
    }
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
    validateOptions(options, new Set(['output', 'revision', 'version']));
    const result = await createSourceCandidate({
      outputDirectory: options.get('output')
        ? resolve(options.get('output'))
        : join(defaultRepoRoot, 'release/asf'),
      revision: options.get('revision') ?? 'HEAD',
      version: requireOption(options, 'version'),
    });
    console.log(`Created ${result.archivePath}`);
    console.log(`Commit ${result.commit}`);
    return;
  }
  if (command === 'verify') {
    validateOptions(options, new Set(['artifact', 'keys', 'require-signature']));
    const result = await verifySourceCandidate({
      archivePath: resolve(requireOption(options, 'artifact')),
      keysPath: options.get('keys') ? resolve(options.get('keys')) : undefined,
      requireSignature: options.get('require-signature') === true,
    });
    console.log(`Verified ${result.archivePath}`);
    console.log(`SHA-512 ${result.digest}`);
    return;
  }
  if (command === 'sign') {
    validateOptions(options, new Set(['artifact', 'key']));
    const signaturePath = await signSourceCandidate({
      archivePath: resolve(requireOption(options, 'artifact')),
      keyFingerprint: requireOption(options, 'key'),
    });
    console.log(`Created ${signaturePath}`);
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
