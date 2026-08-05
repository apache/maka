import { createHash } from 'node:crypto';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative } from 'node:path';
import type { VerifiedGitRuntimeInput } from '@maka/storage/managed-workspace-owner';

const MANIFEST_KEYS = [
  'arch',
  'distributionReady',
  'executableRelativePath',
  'executableSha256',
  'gitVersion',
  'platform',
  'protocol',
  'provider',
  'schemaVersion',
  'sourceArchiveSha256',
] as const;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const VERSION_PATTERN = /^[1-9][0-9]*\.[0-9]+\.[0-9]+(?:[-.][A-Za-z0-9]+)*$/u;

export type BundledGitRuntimeErrorCode =
  | 'bundled_git_unavailable'
  | 'bundled_git_manifest_invalid'
  | 'bundled_git_platform_mismatch'
  | 'bundled_git_integrity_mismatch';

export class BundledGitRuntimeError extends Error {
  constructor(
    readonly code: BundledGitRuntimeErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'BundledGitRuntimeError';
  }
}

export interface ResolveBundledGitRuntimeInput {
  readonly resourcesRoot: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly manifestPath?: string;
}

export async function resolveBundledGitRuntime(
  input: ResolveBundledGitRuntimeInput,
): Promise<VerifiedGitRuntimeInput> {
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  try {
    const resourcesRoot = normalize(await realpath(input.resourcesRoot));
    const manifestPath = normalize(
      await realpath(input.manifestPath ?? join(resourcesRoot, 'bundled-git.json')),
    );
    assertWithinRoot(resourcesRoot, manifestPath, 'Bundled Git manifest');
    const manifestInfo = await lstat(manifestPath);
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) {
      throw invalidManifest('Bundled Git manifest must be a regular non-symlink file');
    }
    const manifest = decodeManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
    if (manifest.platform !== platform || manifest.arch !== arch) {
      throw new BundledGitRuntimeError(
        'bundled_git_platform_mismatch',
        `Bundled Git targets ${manifest.platform}-${manifest.arch}, not ${platform}-${arch}`,
      );
    }
    const executablePath = normalize(
      join(resourcesRoot, ...manifest.executableRelativePath.split('/')),
    );
    assertWithinRoot(resourcesRoot, executablePath, 'Bundled Git executable');
    const executableInfo = await lstat(executablePath);
    if (!executableInfo.isFile() || executableInfo.isSymbolicLink()) {
      throw new BundledGitRuntimeError(
        'bundled_git_unavailable',
        'Bundled Git executable must be a regular non-symlink file',
      );
    }
    const canonicalExecutable = normalize(await realpath(executablePath));
    assertWithinRoot(resourcesRoot, canonicalExecutable, 'Bundled Git executable');
    const actualSha256 = await sha256File(canonicalExecutable);
    if (actualSha256 !== manifest.executableSha256) {
      throw new BundledGitRuntimeError(
        'bundled_git_integrity_mismatch',
        `Bundled Git executable digest mismatch: ${canonicalExecutable}`,
      );
    }
    return {
      executablePath: canonicalExecutable,
      expectedSha256: manifest.executableSha256,
      runtimeIdentitySha256: bundledGitRuntimeIdentity(manifest),
      distribution: {
        kind: 'dugite_native_v1',
        rootPath: normalize(await realpath(join(resourcesRoot, 'git'))),
      },
    };
  } catch (error) {
    if (error instanceof BundledGitRuntimeError) throw error;
    throw new BundledGitRuntimeError(
      'bundled_git_unavailable',
      'Bundled Git runtime is unavailable',
      { cause: error },
    );
  }
}

function bundledGitRuntimeIdentity(manifest: BundledGitManifestV1): `sha256:${string}` {
  const identity = JSON.stringify({
    protocol: 'maka_git_runtime_identity_v1',
    manifestProtocol: manifest.protocol,
    provider: manifest.provider,
    gitVersion: manifest.gitVersion,
    platform: manifest.platform,
    arch: manifest.arch,
    executableRelativePath: manifest.executableRelativePath,
    executableSha256: manifest.executableSha256,
    sourceArchiveSha256: manifest.sourceArchiveSha256,
  });
  return `sha256:${createHash('sha256').update(identity).digest('hex')}`;
}

interface BundledGitManifestV1 {
  readonly schemaVersion: 1;
  readonly protocol: 'maka_bundled_git_runtime_v1';
  readonly provider: 'desktop/dugite-native';
  readonly gitVersion: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly executableRelativePath: string;
  readonly executableSha256: `sha256:${string}`;
  readonly sourceArchiveSha256: `sha256:${string}`;
  readonly distributionReady: true;
}

function decodeManifest(input: unknown): BundledGitManifestV1 {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw invalidManifest('Bundled Git manifest must be an object');
  }
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).sort().join('\0') !== [...MANIFEST_KEYS].sort().join('\0') ||
    value.schemaVersion !== 1 ||
    value.protocol !== 'maka_bundled_git_runtime_v1' ||
    value.provider !== 'desktop/dugite-native' ||
    typeof value.gitVersion !== 'string' ||
    !VERSION_PATTERN.test(value.gitVersion) ||
    (value.platform !== 'win32' && value.platform !== 'darwin' && value.platform !== 'linux') ||
    typeof value.arch !== 'string' ||
    !/^[a-z0-9_]+$/u.test(value.arch) ||
    typeof value.executableRelativePath !== 'string' ||
    !isSafeRelativePath(value.executableRelativePath) ||
    typeof value.executableSha256 !== 'string' ||
    !SHA256_PATTERN.test(value.executableSha256) ||
    typeof value.sourceArchiveSha256 !== 'string' ||
    !SHA256_PATTERN.test(value.sourceArchiveSha256) ||
    value.distributionReady !== true
  ) {
    throw invalidManifest('Bundled Git manifest is invalid');
  }
  return value as unknown as BundledGitManifestV1;
}

function isSafeRelativePath(value: string): boolean {
  if (!value || isAbsolute(value) || value.includes('\\')) return false;
  const segments = value.split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function assertWithinRoot(root: string, target: string, label: string): void {
  const rel = relative(root, target);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return;
  throw invalidManifest(`${label} escapes the packaged resources root`);
}

function invalidManifest(message: string): BundledGitRuntimeError {
  return new BundledGitRuntimeError('bundled_git_manifest_invalid', message);
}

async function sha256File(path: string): Promise<`sha256:${string}`> {
  const hash = createHash('sha256');
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return `sha256:${hash.digest('hex')}`;
  } finally {
    await file.close();
  }
}
