import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  PROJECT_DIRECTORY_MAX_ROOTS,
  PROJECT_DIRECTORY_ROOT_LABEL_MAX_BYTES,
} from '@maka/runtime-host/protocol';

const SERVICE_CONFIG_FILE = 'runtime-host-service.json';
const DEFAULT_WEBSOCKET_PATH = '/runtime-host';

export interface RuntimeHostManagedServiceConfig {
  readonly schemaVersion: 1;
  readonly rootPath: string;
  readonly projectDirectoryRoots: readonly {
    readonly label: string;
    readonly path: string;
  }[];
  readonly websocket: {
    readonly host: '127.0.0.1';
    readonly port: number;
    readonly path: string;
  };
  readonly launch: {
    readonly nodePath: string;
    readonly cliPath: string;
    readonly packageVersion: string;
  };
}

export type RuntimeHostServiceState =
  | 'not_installed'
  | 'stopped'
  | 'starting'
  | 'running'
  | 'failed';

export interface RuntimeHostServiceBackendStatus {
  readonly manager: 'systemd_user' | 'launch_agent';
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly active: boolean;
  readonly state: RuntimeHostServiceState;
  readonly pid: number | null;
  readonly lastExitCode: number | null;
}

export interface RuntimeHostServiceBackend {
  preflightInstall(): Promise<void>;
  install(config: RuntimeHostManagedServiceConfig): Promise<void>;
  status(): Promise<RuntimeHostServiceBackendStatus>;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  uninstall(): Promise<void>;
}

export interface RuntimeHostManagedServiceStatus extends RuntimeHostServiceBackendStatus {
  readonly configured: boolean;
  readonly config: RuntimeHostManagedServiceConfig | null;
}

export type RuntimeHostManagedServiceAction =
  | 'install'
  | 'status'
  | 'start'
  | 'stop'
  | 'restart'
  | 'uninstall';

export interface RuntimeHostManagedServiceResult {
  readonly schemaVersion: 1;
  readonly action: RuntimeHostManagedServiceAction;
  readonly service: RuntimeHostManagedServiceStatus;
  readonly retainedStateRoot?: string;
}

export interface RuntimeHostManagedServiceInput {
  readonly action: RuntimeHostManagedServiceAction;
  readonly clientDataRoot: string;
  readonly defaultRootPath: string;
  readonly rootPath?: string;
  readonly projectDirectoryRoots?: readonly { readonly label: string; readonly path: string }[];
  readonly websocketPort?: number;
  readonly websocketPath?: string;
  readonly nodePath: string;
  readonly cliPath: string;
  readonly packageVersion: string;
}

interface RuntimeHostServiceManagerDeps {
  readonly allocateLoopbackPort: () => Promise<number>;
}

export class RuntimeHostServiceManagerError extends Error {
  constructor(
    readonly code:
      | 'unsupported_platform'
      | 'service_manager_unavailable'
      | 'linger_disabled'
      | 'not_installed'
      | 'invalid_config'
      | 'invalid_launch'
      | 'service_manager_operation_failed'
      | 'uninstall_incomplete',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RuntimeHostServiceManagerError';
  }
}

export async function manageRuntimeHostService(
  input: RuntimeHostManagedServiceInput,
  backend: RuntimeHostServiceBackend,
  overrides: Partial<RuntimeHostServiceManagerDeps> = {},
): Promise<RuntimeHostManagedServiceResult> {
  const deps: RuntimeHostServiceManagerDeps = {
    allocateLoopbackPort,
    ...overrides,
  };
  const configPath = resolveRuntimeHostManagedServiceConfigPath(input.clientDataRoot);

  if (input.action === 'install') {
    await backend.preflightInstall();
    const previous = await readServiceConfigForRepair(configPath);
    const config = await prepareServiceConfig(input, previous, deps);
    await writeRuntimeHostServiceFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 0o600);
    await backend.install(config);
    return result(input.action, await readServiceStatus(configPath, backend));
  }

  if (input.action === 'status') {
    return result(input.action, await readServiceStatus(configPath, backend));
  }

  if (input.action === 'uninstall') {
    const before = await readServiceConfigForRepair(configPath);
    await backend.uninstall();
    await removeRuntimeHostServiceFile(configPath, 'service config');
    const service = await readServiceStatus(configPath, backend);
    if (service.installed || service.active || service.enabled || service.configured) {
      throw new RuntimeHostServiceManagerError(
        'uninstall_incomplete',
        `Runtime Host service still has managed state: ${service.state}`,
      );
    }
    return result(input.action, service, before?.rootPath);
  }

  const config = await readServiceConfig(configPath);
  if (!config) {
    throw new RuntimeHostServiceManagerError(
      'not_installed',
      'Runtime Host service is not installed',
    );
  }
  await backend[input.action]();
  return result(input.action, await readServiceStatus(configPath, backend));
}

export function resolveRuntimeHostManagedServiceConfigPath(clientDataRoot: string): string {
  return join(clientDataRoot, SERVICE_CONFIG_FILE);
}

export async function writeRuntimeHostServiceFile(
  path: string,
  contents: string,
  mode: number,
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporaryPath, 'wx', mode);
    try {
      await file.writeFile(contents, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporaryPath, path);
    const parent = await open(directory, 'r');
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function removeRuntimeHostServiceFile(path: string, label: string): Promise<void> {
  try {
    await rm(path, { force: true });
  } catch (error) {
    throw new RuntimeHostServiceManagerError(
      'uninstall_incomplete',
      `Unable to remove Runtime Host ${label} at ${path}`,
      { cause: error },
    );
  }
}

async function prepareServiceConfig(
  input: RuntimeHostManagedServiceInput,
  previous: RuntimeHostManagedServiceConfig | null,
  deps: RuntimeHostServiceManagerDeps,
): Promise<RuntimeHostManagedServiceConfig> {
  if (!input.cliPath) {
    throw new RuntimeHostServiceManagerError(
      'invalid_launch',
      'The current Maka CLI entry point could not be resolved',
    );
  }
  const requestedRoot = resolve(input.rootPath ?? previous?.rootPath ?? input.defaultRootPath);
  const projectDirectoryRoots = await Promise.all(
    (input.projectDirectoryRoots ?? previous?.projectDirectoryRoots ?? []).map(
      async ({ label, path }) => ({ label, path: await realpath(path) }),
    ),
  );
  const [nodePath, cliPath] = await Promise.all([
    realpath(input.nodePath),
    realpath(input.cliPath),
  ]).catch((error) => {
    throw new RuntimeHostServiceManagerError(
      'invalid_launch',
      'The current Node.js or Maka CLI installation is unavailable',
      { cause: error },
    );
  });
  await mkdir(requestedRoot, { recursive: true, mode: 0o700 });
  const rootPath = await realpath(requestedRoot);
  const port =
    input.websocketPort ?? previous?.websocket.port ?? (await deps.allocateLoopbackPort());
  const websocketPath = input.websocketPath ?? previous?.websocket.path ?? DEFAULT_WEBSOCKET_PATH;
  const config: RuntimeHostManagedServiceConfig = {
    schemaVersion: 1,
    rootPath,
    projectDirectoryRoots,
    websocket: { host: '127.0.0.1', port, path: websocketPath },
    launch: { nodePath, cliPath, packageVersion: input.packageVersion },
  };
  validateServiceConfig(config);
  return config;
}

async function readServiceStatus(
  configPath: string,
  backend: RuntimeHostServiceBackend,
): Promise<RuntimeHostManagedServiceStatus> {
  const [config, backendStatus] = await Promise.all([
    readServiceConfig(configPath),
    backend.status(),
  ]);
  return { ...backendStatus, configured: config !== null, config };
}

async function readServiceConfig(path: string): Promise<RuntimeHostManagedServiceConfig | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null;
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    validateServiceConfig(parsed);
    return parsed;
  } catch (error) {
    throw new RuntimeHostServiceManagerError(
      'invalid_config',
      `Invalid Runtime Host service config at ${path}`,
      { cause: error },
    );
  }
}

async function readServiceConfigForRepair(
  path: string,
): Promise<RuntimeHostManagedServiceConfig | null> {
  try {
    return await readServiceConfig(path);
  } catch (error) {
    if (error instanceof RuntimeHostServiceManagerError && error.code === 'invalid_config') {
      return null;
    }
    throw error;
  }
}

function validateServiceConfig(value: unknown): asserts value is RuntimeHostManagedServiceConfig {
  if (!isRecord(value) || value.schemaVersion !== 1) throw new TypeError('Invalid schemaVersion');
  if (!isSafeAbsolutePath(value.rootPath)) throw new TypeError('Invalid rootPath');
  if (
    !Array.isArray(value.projectDirectoryRoots) ||
    value.projectDirectoryRoots.length > PROJECT_DIRECTORY_MAX_ROOTS
  ) {
    throw new TypeError('Invalid projectDirectoryRoots');
  }
  for (const root of value.projectDirectoryRoots) {
    if (
      !isRecord(root) ||
      typeof root.label !== 'string' ||
      root.label.length === 0 ||
      Buffer.byteLength(root.label, 'utf8') > PROJECT_DIRECTORY_ROOT_LABEL_MAX_BYTES ||
      hasControlCharacters(root.label) ||
      !isSafeAbsolutePath(root.path)
    ) {
      throw new TypeError('Invalid project directory root');
    }
  }
  if (
    new Set(value.projectDirectoryRoots.map(({ label }) => label)).size !==
    value.projectDirectoryRoots.length
  ) {
    throw new TypeError('Duplicate project directory root label');
  }
  const websocket = value.websocket;
  if (
    !isRecord(websocket) ||
    websocket.host !== '127.0.0.1' ||
    typeof websocket.port !== 'number' ||
    !Number.isInteger(websocket.port) ||
    websocket.port < 1 ||
    websocket.port > 65_535 ||
    typeof websocket.path !== 'string' ||
    !websocket.path.startsWith('/') ||
    websocket.path.includes('?') ||
    websocket.path.includes('#') ||
    hasControlCharacters(websocket.path)
  ) {
    throw new TypeError('Invalid websocket config');
  }
  const launch = value.launch;
  if (
    !isRecord(launch) ||
    !isSafeAbsolutePath(launch.nodePath) ||
    !isSafeAbsolutePath(launch.cliPath) ||
    typeof launch.packageVersion !== 'string' ||
    launch.packageVersion.length === 0 ||
    hasControlCharacters(launch.packageVersion)
  ) {
    throw new TypeError('Invalid launch config');
  }
}

async function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Unable to allocate a loopback port'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolvePort(address.port)));
    });
  });
}

function result(
  action: RuntimeHostManagedServiceAction,
  service: RuntimeHostManagedServiceStatus,
  retainedStateRoot?: string,
): RuntimeHostManagedServiceResult {
  return {
    schemaVersion: 1,
    action,
    service,
    ...(retainedStateRoot ? { retainedStateRoot } : {}),
  };
}

function isSafeAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' && isAbsolute(value) && !hasControlCharacters(value);
}

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
