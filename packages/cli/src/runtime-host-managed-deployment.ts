import { randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { resolveRuntimeHostManagedServiceId } from './runtime-host-service-manager.js';

const PACKAGE_NAME = 'maka-agent';

export class RuntimeHostManagedDeploymentError extends Error {
  constructor(
    readonly code: 'invalid_package' | 'deployment_failed' | 'uninstall_incomplete',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RuntimeHostManagedDeploymentError';
  }
}

export interface RuntimeHostManagedPackageDeployment {
  readonly version: string;
  readonly cliPath: string;
  rollback(): Promise<void>;
}

interface RuntimeHostManagedDeploymentPathOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly platform?: NodeJS.Platform;
}

export async function prepareRuntimeHostManagedPackageDeployment(
  input: {
    readonly clientDataRoot: string;
    readonly sourcePackageRoot: string;
    readonly version: string;
  },
  options: RuntimeHostManagedDeploymentPathOptions = {},
): Promise<RuntimeHostManagedPackageDeployment> {
  assertVersion(input.version);
  const sourcePackageRoot = await validatePackage(input.sourcePackageRoot, input.version);
  const deploymentRoot = resolveRuntimeHostManagedDeploymentRoot(input.clientDataRoot, options);
  const versionsRoot = join(deploymentRoot, 'versions');
  const packageRoot = join(versionsRoot, input.version);
  const cliPath = join(packageRoot, 'dist', 'cli.js');
  if (await pathExists(packageRoot)) {
    await validatePackage(packageRoot, input.version);
    return deployment(input.version, packageRoot, cliPath, false);
  }

  await mkdir(versionsRoot, { recursive: true, mode: 0o700 });
  await removeAbandonedStagingPackages(versionsRoot, input.version);
  const stagingRoot = join(versionsRoot, `.${input.version}.${randomUUID()}.tmp`);
  try {
    await cp(sourcePackageRoot, stagingRoot, {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
    });
    await validatePackage(stagingRoot, input.version);
    try {
      await rename(stagingRoot, packageRoot);
    } catch (error) {
      if (!isNodeError(error, 'EEXIST') && !isNodeError(error, 'ENOTEMPTY')) throw error;
      await validatePackage(packageRoot, input.version);
      await rm(stagingRoot, { recursive: true, force: true });
      return deployment(input.version, packageRoot, cliPath, false);
    }
    return deployment(input.version, packageRoot, cliPath, true);
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof RuntimeHostManagedDeploymentError) throw error;
    throw new RuntimeHostManagedDeploymentError(
      'deployment_failed',
      `Unable to install Maka ${input.version} into the managed Runtime Host deployment`,
      { cause: error },
    );
  }
}

async function removeAbandonedStagingPackages(
  versionsRoot: string,
  version: string,
): Promise<void> {
  const prefix = `.${version}.`;
  await Promise.all(
    (await readdir(versionsRoot, { withFileTypes: true }))
      .filter((entry) => entry.name.startsWith(prefix) && entry.name.endsWith('.tmp'))
      .map((entry) => rm(join(versionsRoot, entry.name), { recursive: true, force: true })),
  );
}

export function resolveRuntimeHostManagedDeploymentRoot(
  clientDataRoot: string,
  options: RuntimeHostManagedDeploymentPathOptions = {},
): string {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const dataHome = resolveManagedDataHome(env, homeDir, options.platform ?? process.platform);
  return join(
    dataHome,
    'Maka',
    'runtime-host-services',
    resolveRuntimeHostManagedServiceId(clientDataRoot),
  );
}

export async function removeRuntimeHostManagedDeployment(
  clientDataRoot: string,
  options: RuntimeHostManagedDeploymentPathOptions = {},
): Promise<void> {
  const deploymentRoot = resolveRuntimeHostManagedDeploymentRoot(clientDataRoot, options);
  try {
    await rm(deploymentRoot, { recursive: true, force: true });
  } catch (error) {
    throw new RuntimeHostManagedDeploymentError(
      'uninstall_incomplete',
      `Unable to remove the managed Runtime Host deployment at ${deploymentRoot}`,
      { cause: error },
    );
  }
}

function resolveManagedDataHome(
  env: NodeJS.ProcessEnv,
  homeDir: string,
  platform: NodeJS.Platform,
): string {
  if (platform === 'darwin') return join(homeDir, 'Library', 'Application Support');
  if (platform === 'win32') {
    return env.LOCALAPPDATA && isAbsolute(env.LOCALAPPDATA)
      ? env.LOCALAPPDATA
      : join(homeDir, 'AppData', 'Local');
  }
  return env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME)
    ? env.XDG_DATA_HOME
    : join(homeDir, '.local', 'share');
}

async function validatePackage(path: string, version: string): Promise<string> {
  let packageRoot: string;
  let manifest: unknown;
  try {
    packageRoot = await realpath(resolve(path));
    manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as unknown;
    const cli = await stat(join(packageRoot, 'dist', 'cli.js'));
    const runtimeHost = await stat(
      join(packageRoot, 'node_modules', '@maka', 'runtime-host', 'package.json'),
    );
    if (!cli.isFile() || !runtimeHost.isFile()) throw new Error('Package payload is incomplete');
  } catch (error) {
    throw new RuntimeHostManagedDeploymentError(
      'invalid_package',
      `Maka ${version} is not a self-contained release package`,
      { cause: error },
    );
  }
  if (!isRecord(manifest) || manifest.name !== PACKAGE_NAME || manifest.version !== version) {
    throw new RuntimeHostManagedDeploymentError(
      'invalid_package',
      `The setup package does not contain ${PACKAGE_NAME}@${version}`,
    );
  }
  return packageRoot;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false;
    throw error;
  }
}

function deployment(
  version: string,
  packageRoot: string,
  cliPath: string,
  created: boolean,
): RuntimeHostManagedPackageDeployment {
  return {
    version,
    cliPath,
    rollback: () =>
      created ? rm(packageRoot, { recursive: true, force: true }) : Promise.resolve(),
  };
}

function assertVersion(version: string): void {
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/u.test(version)) {
    throw new RuntimeHostManagedDeploymentError(
      'invalid_package',
      'The Maka package version cannot be used as a managed deployment identity',
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
