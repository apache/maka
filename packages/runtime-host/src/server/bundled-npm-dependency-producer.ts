import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative } from 'node:path';
import { promisify } from 'node:util';
import type {
  ManagedDependencyEnvironmentProducer,
  ManagedDependencyEnvironmentProducerInput,
} from '@maka/storage/managed-workspace-owner';

const execFileAsync = promisify(execFile);
const EXPECTED_NPM_VERSION = '12.0.2';
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const MANIFEST_KEYS = [
  'schemaVersion',
  'protocol',
  'provider',
  'npmVersion',
  'platform',
  'arch',
  'securityPatches',
  'runtimeRootRelativePath',
  'cliRelativePath',
  'files',
  'runtimeIdentitySha256',
  'distributionReady',
] as const;

export interface ResolveBundledNpmDependencyProducerInput {
  readonly resourcesRoot: string;
  readonly cacheRoot: string;
  readonly nodeExecutablePath: string;
  readonly manifestPath?: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
}

export async function resolveBundledNpmDependencyProducer(
  input: ResolveBundledNpmDependencyProducerInput,
): Promise<ManagedDependencyEnvironmentProducer> {
  const resourcesRoot = normalize(await realpath(input.resourcesRoot));
  const cacheRoot = await ensureCanonicalDirectory(input.cacheRoot);
  const nodeExecutablePath = normalize(await realpath(input.nodeExecutablePath));
  await requireRegularFile(nodeExecutablePath, 'Node runtime');
  const nodeRuntime = await inspectNodeRuntime(nodeExecutablePath);
  if (!isBundledNpmNodeVersionSupported(nodeRuntime.version)) {
    throw new Error(`Bundled npm does not support Node ${nodeRuntime.version}`);
  }
  const manifestPath = normalize(
    await realpath(input.manifestPath ?? join(resourcesRoot, 'bundled-npm.json')),
  );
  assertWithin(resourcesRoot, manifestPath, 'Bundled npm manifest');
  const manifest = decodeManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
  if (
    manifest.platform !== (input.platform ?? nodeRuntime.platform) ||
    manifest.arch !== (input.arch ?? nodeRuntime.arch) ||
    manifest.platform !== nodeRuntime.platform ||
    manifest.arch !== nodeRuntime.arch
  ) {
    throw new Error('Bundled npm runtime platform does not match this process');
  }
  const npmRoot = normalize(join(resourcesRoot, ...manifest.runtimeRootRelativePath.split('/')));
  const cliPath = normalize(join(resourcesRoot, ...manifest.cliRelativePath.split('/')));
  assertWithin(resourcesRoot, npmRoot, 'Bundled npm root');
  assertWithin(npmRoot, cliPath, 'Bundled npm CLI');
  await verifyRuntime(npmRoot, manifest);

  return Object.freeze({
    packageManagerName: 'npm' as const,
    packageManagerVersion: manifest.npmVersion,
    nodeRuntime,
    async provision(provisionInput: ManagedDependencyEnvironmentProducerInput) {
      await verifyRuntime(npmRoot, manifest);
      await provisionWithNpm({
        input: provisionInput,
        nodeExecutablePath,
        cliPath,
        cacheRoot,
      });
    },
  });
}

export function isBundledNpmNodeVersionSupported(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (major >= 26) return true;
  if (major === 24) return minor > 15 || (minor === 15 && patch >= 0);
  if (major === 22) return minor > 22 || (minor === 22 && patch >= 2);
  return false;
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
  readonly npmVersion: typeof EXPECTED_NPM_VERSION;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly securityPatches: readonly [
    {
      readonly packageName: 'tar';
      readonly fromVersion: '7.5.19';
      readonly toVersion: '7.5.22';
      readonly advisory: 'GHSA-r292-9mhp-454m';
    },
  ];
  readonly runtimeRootRelativePath: 'npm';
  readonly cliRelativePath: 'npm/bin/npm-cli.js';
  readonly files: readonly BundledNpmManifestFileV1[];
  readonly runtimeIdentitySha256: `sha256:${string}`;
  readonly distributionReady: true;
}

function decodeManifest(value: unknown): BundledNpmManifestV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Bundled npm manifest is invalid');
  }
  const input = value as Record<string, unknown>;
  const files = input.files;
  if (
    Object.keys(input).sort().join('\0') !== [...MANIFEST_KEYS].sort().join('\0') ||
    input.schemaVersion !== 1 ||
    input.protocol !== 'maka_bundled_npm_runtime_v1' ||
    input.provider !== 'desktop/npm-cli' ||
    input.npmVersion !== EXPECTED_NPM_VERSION ||
    (input.platform !== 'win32' && input.platform !== 'darwin' && input.platform !== 'linux') ||
    typeof input.arch !== 'string' ||
    !/^[a-z0-9_]+$/u.test(input.arch) ||
    !isExpectedSecurityPatches(input.securityPatches) ||
    input.runtimeRootRelativePath !== 'npm' ||
    input.cliRelativePath !== 'npm/bin/npm-cli.js' ||
    !Array.isArray(files) ||
    files.length === 0 ||
    files.length > 20_000 ||
    typeof input.runtimeIdentitySha256 !== 'string' ||
    !SHA256_PATTERN.test(input.runtimeIdentitySha256) ||
    input.distributionReady !== true
  ) {
    throw new Error('Bundled npm manifest is invalid');
  }
  const decodedFiles = files.map(decodeManifestFile);
  const sorted = [...decodedFiles].sort((left, right) =>
    Buffer.from(left.path).compare(Buffer.from(right.path)),
  );
  if (decodedFiles.some((file, index) => file.path !== sorted[index]?.path)) {
    throw new Error('Bundled npm file manifest is not canonical');
  }
  if (new Set(decodedFiles.map((file) => file.path)).size !== decodedFiles.length) {
    throw new Error('Bundled npm file manifest contains duplicate paths');
  }
  const manifest = { ...input, files: decodedFiles } as unknown as BundledNpmManifestV1;
  const identity = JSON.stringify({
    protocol: 'maka_bundled_npm_runtime_identity_v1',
    npmVersion: manifest.npmVersion,
    platform: manifest.platform,
    arch: manifest.arch,
    securityPatches: manifest.securityPatches,
    files: manifest.files,
  });
  if (sha256(Buffer.from(identity)) !== manifest.runtimeIdentitySha256) {
    throw new Error('Bundled npm runtime identity is invalid');
  }
  return Object.freeze(manifest);
}

function isExpectedSecurityPatches(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== 1) return false;
  const patch = value[0];
  return (
    Boolean(patch) &&
    typeof patch === 'object' &&
    !Array.isArray(patch) &&
    Object.keys(patch as object)
      .sort()
      .join('\0') === 'advisory\0fromVersion\0packageName\0toVersion' &&
    (patch as Record<string, unknown>).packageName === 'tar' &&
    (patch as Record<string, unknown>).fromVersion === '7.5.19' &&
    (patch as Record<string, unknown>).toVersion === '7.5.22' &&
    (patch as Record<string, unknown>).advisory === 'GHSA-r292-9mhp-454m'
  );
}

function decodeManifestFile(value: unknown): BundledNpmManifestFileV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Bundled npm file manifest is invalid');
  }
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).sort().join('\0') !== 'bytes\0path\0sha256' ||
    typeof input.path !== 'string' ||
    !safeRelativePath(input.path) ||
    typeof input.bytes !== 'number' ||
    !Number.isSafeInteger(input.bytes) ||
    input.bytes < 0 ||
    typeof input.sha256 !== 'string' ||
    !SHA256_PATTERN.test(input.sha256)
  ) {
    throw new Error('Bundled npm file manifest is invalid');
  }
  return input as unknown as BundledNpmManifestFileV1;
}

async function verifyRuntime(root: string, manifest: BundledNpmManifestV1): Promise<void> {
  const actualPaths: string[] = [];
  await inventoryRuntimePaths(root, root, actualPaths);
  actualPaths.sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  const expectedPaths = manifest.files.map((file) => file.path);
  if (actualPaths.join('\0') !== expectedPaths.join('\0')) {
    throw new Error('Bundled npm runtime integrity mismatch: file inventory changed');
  }
  for (const file of manifest.files) {
    const path = join(root, ...file.path.split('/'));
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== file.bytes) {
      throw new Error(`Bundled npm runtime integrity mismatch: ${file.path}`);
    }
    if ((await sha256File(path)) !== file.sha256) {
      throw new Error(`Bundled npm runtime integrity mismatch: ${file.path}`);
    }
  }
}

async function inventoryRuntimePaths(root: string, directory: string, output: string[]) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const info = await lstat(path);
    if (entry.isDirectory() && !info.isSymbolicLink()) {
      await inventoryRuntimePaths(root, path, output);
    } else if (entry.isFile() && !info.isSymbolicLink()) {
      output.push(relative(root, path).replaceAll('\\', '/'));
    } else {
      throw new Error('Bundled npm runtime integrity mismatch: unsupported entry');
    }
  }
}

async function provisionWithNpm(input: {
  readonly input: ManagedDependencyEnvironmentProducerInput;
  readonly nodeExecutablePath: string;
  readonly cliPath: string;
  readonly cacheRoot: string;
}) {
  assertSafeNpmInputs(input.input);
  const projectRoot = dirname(input.input.outputRoot);
  const homeRoot = join(input.cacheRoot, 'home');
  const npmCache = join(input.cacheRoot, 'cache');
  await mkdir(homeRoot, { recursive: true });
  await mkdir(npmCache, { recursive: true });
  const userConfig = join(homeRoot, 'npmrc');
  const globalConfig = join(homeRoot, 'global-npmrc');
  const exactConfig = 'registry=https://registry.npmjs.org/\n';
  await ensureExactConfigFile(userConfig, exactConfig);
  await ensureExactConfigFile(globalConfig, exactConfig);
  await writeFile(join(projectRoot, 'package.json'), input.input.manifestBytes, { flag: 'wx' });
  await writeFile(join(projectRoot, 'package-lock.json'), input.input.lockfileBytes, {
    flag: 'wx',
  });
  await execFileAsync(
    input.nodeExecutablePath,
    [
      input.cliPath,
      'ci',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=true',
      `--cache=${npmCache}`,
      `--userconfig=${userConfig}`,
      `--globalconfig=${globalConfig}`,
    ],
    {
      cwd: projectRoot,
      env: hermeticNpmEnvironment(homeRoot, userConfig, globalConfig),
      timeout: 10 * 60 * 1_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    },
  );
}

function assertSafeNpmInputs(input: ManagedDependencyEnvironmentProducerInput): void {
  if (
    input.identity.packageManagerName !== 'npm' ||
    input.identity.packageManagerVersion !== EXPECTED_NPM_VERSION
  ) {
    throw new Error('Bundled npm producer identity mismatch');
  }
  if (
    input.manifestBytes.byteLength > 1024 * 1024 ||
    input.lockfileBytes.byteLength > 64 * 1024 * 1024
  ) {
    throw new Error('Bundled npm producer input exceeds its bounded size policy');
  }
  const manifest = JSON.parse(Buffer.from(input.manifestBytes).toString('utf8')) as {
    packageManager?: unknown;
    workspaces?: unknown;
  };
  const lockfile = JSON.parse(Buffer.from(input.lockfileBytes).toString('utf8')) as {
    lockfileVersion?: unknown;
    packages?: unknown;
  };
  if (
    manifest.packageManager !== `npm@${EXPECTED_NPM_VERSION}` ||
    manifest.workspaces !== undefined ||
    lockfile.lockfileVersion !== 3 ||
    !lockfile.packages ||
    typeof lockfile.packages !== 'object'
  ) {
    throw new Error('Bundled npm producer accepts only exact non-workspace package-lock v3 input');
  }
  for (const [packagePath, value] of Object.entries(lockfile.packages as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const entry = value as {
      resolved?: unknown;
      integrity?: unknown;
      link?: unknown;
      hasInstallScript?: unknown;
    };
    if (
      entry.link === true ||
      entry.hasInstallScript === true ||
      (typeof entry.resolved === 'string' &&
        !entry.resolved.startsWith('https://registry.npmjs.org/'))
    ) {
      throw new Error('Bundled npm producer rejected an unsafe dependency entry');
    }
    if (
      packagePath !== '' &&
      (!packagePath.startsWith('node_modules/') ||
        typeof entry.resolved !== 'string' ||
        typeof entry.integrity !== 'string' ||
        !/^sha(?:1|256|384|512)-[A-Za-z0-9+/=]+$/u.test(entry.integrity))
    ) {
      throw new Error('Bundled npm producer rejected an unsafe dependency entry');
    }
  }
}

function hermeticNpmEnvironment(
  homeRoot: string,
  userConfig: string,
  globalConfig: string,
): NodeJS.ProcessEnv {
  return {
    HOME: homeRoot,
    USERPROFILE: homeRoot,
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_ignore_scripts: 'true',
    npm_config_update_notifier: 'false',
    npm_config_registry: 'https://registry.npmjs.org/',
    npm_config_userconfig: userConfig,
    npm_config_globalconfig: globalConfig,
    ...(process.platform === 'win32'
      ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP }
      : { TMPDIR: process.env.TMPDIR ?? '/tmp' }),
    ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
  };
}

async function inspectNodeRuntime(
  nodeExecutablePath: string,
): Promise<ManagedDependencyEnvironmentProducer['nodeRuntime']> {
  const { stdout } = await execFileAsync(
    nodeExecutablePath,
    [
      '-p',
      'JSON.stringify({version:process.versions.node,abi:process.versions.modules,platform:process.platform,arch:process.arch})',
    ],
    {
      env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {},
      timeout: 15_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    },
  );
  const value = JSON.parse(stdout.trim()) as Record<string, unknown>;
  if (
    typeof value.version !== 'string' ||
    typeof value.abi !== 'string' ||
    (value.platform !== 'win32' && value.platform !== 'darwin' && value.platform !== 'linux') ||
    typeof value.arch !== 'string'
  ) {
    throw new Error('Bundled npm Node runtime identity is invalid');
  }
  return Object.freeze({
    version: value.version,
    abi: value.abi,
    platform: value.platform,
    arch: value.arch,
  });
}

async function ensureExactConfigFile(path: string, content: string): Promise<void> {
  try {
    await writeFile(path, content, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if ((await readFile(path, 'utf8')) !== content) {
      throw new Error('Bundled npm hermetic configuration was modified');
    }
  }
}

async function ensureCanonicalDirectory(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  return normalize(await realpath(path));
}

async function requireRegularFile(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} is unavailable`);
}

function safeRelativePath(path: string): boolean {
  return (
    Boolean(path) &&
    !isAbsolute(path) &&
    !path.includes('\\') &&
    path.split('/').every((segment) => segment && segment !== '.' && segment !== '..')
  );
}

function assertWithin(root: string, path: string, label: string): void {
  const rel = relative(root, path);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return;
  throw new Error(`${label} escapes its authority root`);
}

async function sha256File(path: string): Promise<`sha256:${string}`> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
}

function sha256(value: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
