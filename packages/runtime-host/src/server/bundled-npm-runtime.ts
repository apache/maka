import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative } from 'node:path';

import {
  isManagedNpmNodeVersionSupported,
  issueManagedNpmRuntimeCapabilityInternal,
  type ManagedNpmRuntimeCapability,
} from './managed-dependency-producer-process.js';

const MANIFEST_KEYS = [
  'arch',
  'cliRelativePath',
  'distributionReady',
  'files',
  'npmVersion',
  'platform',
  'protocol',
  'provider',
  'runtimeRootRelativePath',
  'schemaVersion',
  'securityPatches',
] as const;
const FILE_KEYS = ['bytes', 'path', 'sha256'] as const;
const SECURITY_PATCH_KEYS = ['advisories', 'fromVersion', 'packageName', 'toVersion'] as const;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_RUNTIME_FILES = 100_000;
const MAX_RUNTIME_BYTES = 128 * 1024 * 1024;

export type BundledNpmRuntimeErrorCode =
  | 'bundled_npm_unavailable'
  | 'bundled_npm_manifest_invalid'
  | 'bundled_npm_platform_mismatch'
  | 'bundled_npm_integrity_mismatch'
  | 'bundled_npm_node_unsupported';

export class BundledNpmRuntimeError extends Error {
  constructor(
    readonly code: BundledNpmRuntimeErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'BundledNpmRuntimeError';
  }
}

export interface ResolveBundledNpmRuntimeInput {
  readonly resourcesRoot: string;
}

export async function resolveBundledNpmRuntime(
  input: ResolveBundledNpmRuntimeInput,
): Promise<ManagedNpmRuntimeCapability> {
  const platform = process.platform;
  const arch = process.arch;
  try {
    if (!isManagedNpmNodeVersionSupported(process.versions.node)) {
      throw new BundledNpmRuntimeError(
        'bundled_npm_node_unsupported',
        `Host Node ${process.versions.node} is outside the attested npm execution profile`,
      );
    }
    const nodeExecutablePath = await canonicalRegularFile(process.execPath, 'Host Node executable');
    const nodeExecutableSha256 = await sha256File(nodeExecutablePath);
    const resourcesRoot = normalize(await realpath(input.resourcesRoot));
    const manifestPath = normalize(await realpath(join(resourcesRoot, 'bundled-npm.json')));
    assertWithinRoot(resourcesRoot, manifestPath, 'Bundled npm manifest');
    const manifestInfo = await lstat(manifestPath);
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) {
      throw invalidManifest('Bundled npm manifest must be a regular non-symlink file');
    }
    if (manifestInfo.size > MAX_MANIFEST_BYTES) {
      throw invalidManifest('Bundled npm manifest exceeds its size limit');
    }
    const manifest = decodeManifest(parseManifestJson(await readFile(manifestPath, 'utf8')));
    if (manifest.platform !== platform || manifest.arch !== arch) {
      throw new BundledNpmRuntimeError(
        'bundled_npm_platform_mismatch',
        `Bundled npm targets ${manifest.platform}-${manifest.arch}, not ${platform}-${arch}`,
      );
    }
    const npmRuntimeRoot = normalize(
      await realpath(join(resourcesRoot, ...manifest.runtimeRootRelativePath.split('/'))),
    );
    assertWithinRoot(resourcesRoot, npmRuntimeRoot, 'Bundled npm runtime');
    const runtimeInfo = await lstat(npmRuntimeRoot);
    if (!runtimeInfo.isDirectory() || runtimeInfo.isSymbolicLink()) {
      throw invalidManifest('Bundled npm runtime root must be a regular directory');
    }
    const npmCliPath = normalize(
      await realpath(join(resourcesRoot, ...manifest.cliRelativePath.split('/'))),
    );
    assertWithinRoot(npmRuntimeRoot, npmCliPath, 'Bundled npm CLI');
    const cliInfo = await lstat(npmCliPath);
    if (!cliInfo.isFile() || cliInfo.isSymbolicLink()) {
      throw invalidManifest('Bundled npm CLI must be a regular non-symlink file');
    }
    await assertRuntimeTreeMatchesManifest(manifest, npmRuntimeRoot);
    const capability = issueManagedNpmRuntimeCapabilityInternal(
      {
        npmVersion: manifest.npmVersion,
        nodeVersion: process.versions.node,
        nodeAbi: process.versions.modules ?? 'unknown',
        platform,
        arch,
        nodeExecutablePath,
        npmRuntimeRoot,
        npmCliPath,
        runtimeIdentitySha256: runtimeIdentity(manifest, nodeExecutableSha256),
      },
      async () => {
        const currentNodeExecutable = await canonicalRegularFile(
          process.execPath,
          'Host Node executable',
        );
        if (
          currentNodeExecutable !== nodeExecutablePath ||
          (await sha256File(currentNodeExecutable)) !== nodeExecutableSha256
        ) {
          throw new BundledNpmRuntimeError(
            'bundled_npm_integrity_mismatch',
            'Host Node executable changed after npm runtime attestation',
          );
        }
        await assertRuntimeTreeMatchesManifest(manifest, npmRuntimeRoot);
      },
    );
    return capability;
  } catch (error) {
    if (error instanceof BundledNpmRuntimeError) throw error;
    throw new BundledNpmRuntimeError(
      'bundled_npm_unavailable',
      'Bundled npm runtime is unavailable',
      { cause: error },
    );
  }
}

interface BundledNpmManifestFileV1 {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: `sha256:${string}`;
}

interface BundledNpmManifestV1 {
  readonly schemaVersion: 1;
  readonly protocol: 'maka_bundled_npm_runtime_v1';
  readonly provider: 'desktop/npm-cli';
  readonly npmVersion: '12.0.2';
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly runtimeRootRelativePath: 'npm';
  readonly cliRelativePath: 'npm/bin/npm-cli.js';
  readonly files: readonly BundledNpmManifestFileV1[];
  readonly securityPatches: readonly BundledNpmSecurityPatchV1[];
  readonly distributionReady: true;
}

interface BundledNpmSecurityPatchV1 {
  readonly packageName: string;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly advisories: readonly string[];
}

function decodeManifest(input: unknown): BundledNpmManifestV1 {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw invalidManifest('Bundled npm manifest must be an object');
  }
  const value = input as Record<string, unknown>;
  if (
    !hasExactKeys(value, MANIFEST_KEYS) ||
    value.schemaVersion !== 1 ||
    value.protocol !== 'maka_bundled_npm_runtime_v1' ||
    value.provider !== 'desktop/npm-cli' ||
    value.npmVersion !== '12.0.2' ||
    (value.platform !== 'win32' && value.platform !== 'darwin' && value.platform !== 'linux') ||
    typeof value.arch !== 'string' ||
    !/^[a-z0-9_]+$/u.test(value.arch) ||
    value.runtimeRootRelativePath !== 'npm' ||
    value.cliRelativePath !== 'npm/bin/npm-cli.js' ||
    !Array.isArray(value.files) ||
    value.files.length === 0 ||
    value.files.length > MAX_RUNTIME_FILES ||
    !Array.isArray(value.securityPatches) ||
    !matchesApprovedSecurityPatches(value.securityPatches) ||
    value.distributionReady !== true
  ) {
    throw invalidManifest('Bundled npm manifest is invalid');
  }
  let previousPath = '';
  for (const entry of value.files) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw invalidManifest('Bundled npm file entry must be an object');
    }
    const file = entry as Record<string, unknown>;
    if (
      !hasExactKeys(file, FILE_KEYS) ||
      typeof file.path !== 'string' ||
      !isSafeRelativePath(file.path) ||
      (previousPath !== '' &&
        Buffer.compare(Buffer.from(file.path), Buffer.from(previousPath)) <= 0) ||
      !Number.isSafeInteger(file.bytes) ||
      (file.bytes as number) < 0 ||
      typeof file.sha256 !== 'string' ||
      !SHA256_PATTERN.test(file.sha256)
    ) {
      throw invalidManifest('Bundled npm file entry is invalid');
    }
    previousPath = file.path;
  }
  return value as unknown as BundledNpmManifestV1;
}

function decodeNpmPackageManifest(input: unknown): { readonly version: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new BundledNpmRuntimeError(
      'bundled_npm_integrity_mismatch',
      'Bundled npm package manifest is invalid',
    );
  }
  const value = input as Record<string, unknown>;
  if (
    value.name !== 'npm' ||
    typeof value.version !== 'string' ||
    value.license !== 'Artistic-2.0'
  ) {
    throw new BundledNpmRuntimeError(
      'bundled_npm_integrity_mismatch',
      'Bundled npm package manifest is not the approved npm distribution',
    );
  }
  return { version: value.version };
}

async function inventoryRegularFiles(root: string): Promise<BundledNpmManifestFileV1[]> {
  const files: BundledNpmManifestFileV1[] = [];
  let totalBytes = 0;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) break;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const info = await lstat(path);
      if (entry.isDirectory() && !info.isSymbolicLink()) {
        pending.push(path);
        continue;
      }
      if (!entry.isFile() || info.isSymbolicLink()) {
        throw new BundledNpmRuntimeError(
          'bundled_npm_integrity_mismatch',
          'Bundled npm runtime may contain only regular files and directories',
        );
      }
      totalBytes += info.size;
      if (files.length >= MAX_RUNTIME_FILES || totalBytes > MAX_RUNTIME_BYTES) {
        throw new BundledNpmRuntimeError(
          'bundled_npm_integrity_mismatch',
          'Bundled npm runtime exceeds its bounded inventory policy',
        );
      }
      files.push({
        path: relative(root, path).replaceAll('\\', '/'),
        bytes: info.size,
        sha256: await sha256File(path),
      });
    }
  }
  files.sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
  return files;
}

async function assertRuntimeTreeMatchesManifest(
  manifest: BundledNpmManifestV1,
  npmRuntimeRoot: string,
): Promise<void> {
  const actualFiles = await inventoryRegularFiles(npmRuntimeRoot);
  if (JSON.stringify(actualFiles) !== JSON.stringify(manifest.files)) {
    throw new BundledNpmRuntimeError(
      'bundled_npm_integrity_mismatch',
      'Bundled npm runtime tree does not match its manifest',
    );
  }
  let packageManifestInput: unknown;
  try {
    packageManifestInput = JSON.parse(await readFile(join(npmRuntimeRoot, 'package.json'), 'utf8'));
  } catch (error) {
    throw new BundledNpmRuntimeError(
      'bundled_npm_integrity_mismatch',
      'Bundled npm package manifest is unreadable',
      { cause: error },
    );
  }
  const packageManifest = decodeNpmPackageManifest(packageManifestInput);
  if (packageManifest.version !== manifest.npmVersion) {
    throw new BundledNpmRuntimeError(
      'bundled_npm_integrity_mismatch',
      'Bundled npm package version does not match its runtime manifest',
    );
  }
}

function runtimeIdentity(
  manifest: BundledNpmManifestV1,
  nodeExecutableSha256: `sha256:${string}`,
): `sha256:${string}` {
  const identity = JSON.stringify({
    protocol: 'maka_bundled_npm_runtime_identity_v1',
    manifest: {
      schemaVersion: manifest.schemaVersion,
      protocol: manifest.protocol,
      provider: manifest.provider,
      npmVersion: manifest.npmVersion,
      platform: manifest.platform,
      arch: manifest.arch,
      runtimeRootRelativePath: manifest.runtimeRootRelativePath,
      cliRelativePath: manifest.cliRelativePath,
      files: manifest.files.map((file) => ({
        path: file.path,
        bytes: file.bytes,
        sha256: file.sha256,
      })),
      securityPatches: manifest.securityPatches.map((patch) => ({
        packageName: patch.packageName,
        fromVersion: patch.fromVersion,
        toVersion: patch.toVersion,
        advisories: [...patch.advisories],
      })),
      distributionReady: manifest.distributionReady,
    },
    nodeVersion: process.versions.node,
    nodeAbi: process.versions.modules ?? 'unknown',
    electronVersion: process.versions.electron ?? null,
    nodeExecutableSha256,
  });
  return `sha256:${createHash('sha256').update(identity).digest('hex')}`;
}

async function canonicalRegularFile(path: string, label: string): Promise<string> {
  const sourceInfo = await lstat(path);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
    throw new BundledNpmRuntimeError('bundled_npm_unavailable', `${label} is unavailable`);
  }
  const canonical = normalize(await realpath(path));
  const info = await lstat(canonical);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new BundledNpmRuntimeError('bundled_npm_unavailable', `${label} is unavailable`);
  }
  return canonical;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function matchesApprovedSecurityPatches(input: readonly unknown[]): boolean {
  const approved = [
    ['tar', '7.5.19', '7.5.22', ['GHSA-r292-9mhp-454m']],
    ['brace-expansion', '5.0.7', '5.0.9', ['GHSA-mh99-v99m-4gvg', 'GHSA-rgw5-rvv9-x895']],
    [
      'ip-address',
      '10.2.0',
      '10.4.0',
      ['GHSA-mwp4-54f8-5fhr', 'GHSA-4xrf-jv44-h6hh', 'GHSA-22jq-vg5j-6vgg'],
    ],
    [
      'undici',
      '6.27.0',
      '6.28.0',
      ['GHSA-8xcm-r25x-g524', 'GHSA-m8rv-5g2x-5cg5', 'GHSA-v3r7-h72x-cjcm'],
    ],
  ] as const;
  return (
    input.every((candidate, index) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
      const value = candidate as Record<string, unknown>;
      const expected = approved[index];
      return (
        expected !== undefined &&
        hasExactKeys(value, SECURITY_PATCH_KEYS) &&
        value.packageName === expected[0] &&
        value.fromVersion === expected[1] &&
        value.toVersion === expected[2] &&
        Array.isArray(value.advisories) &&
        JSON.stringify(value.advisories) === JSON.stringify(expected[3])
      );
    }) && input.length === approved.length
  );
}

function isSafeRelativePath(value: string): boolean {
  if (!value || isAbsolute(value) || value.includes('\\')) return false;
  return value
    .split('/')
    .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function assertWithinRoot(root: string, target: string, label: string): void {
  const rel = relative(root, target);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return;
  throw invalidManifest(`${label} escapes its packaged authority root`);
}

function invalidManifest(message: string): BundledNpmRuntimeError {
  return new BundledNpmRuntimeError('bundled_npm_manifest_invalid', message);
}

function parseManifestJson(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch (error) {
    throw invalidManifest(`Bundled npm manifest is not valid JSON: ${String(error)}`);
  }
}

async function sha256File(path: string): Promise<`sha256:${string}`> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
}
