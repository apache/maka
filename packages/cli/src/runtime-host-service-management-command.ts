import {
  manageRuntimeHostService,
  resolveRuntimeHostManagedServiceId,
  RuntimeHostServiceManagerError,
  type RuntimeHostManagedServiceInput,
  type RuntimeHostManagedServiceResult,
  type RuntimeHostServiceBackend,
} from './runtime-host-service-manager.js';
import { createSystemdUserRuntimeHostService } from './runtime-host-systemd-service.js';

export interface RuntimeHostServiceManagementCliOptions extends RuntimeHostManagedServiceInput {
  readonly json: boolean;
}

export interface RuntimeHostServiceManagementCliDeps {
  readonly manage: typeof manageRuntimeHostService;
  readonly createBackend: (serviceId: string) => RuntimeHostServiceBackend;
  readonly writeOutput: (value: string) => unknown;
  readonly writeError: (value: string) => unknown;
}

export async function runManagedRuntimeHostServiceCli(
  options: RuntimeHostServiceManagementCliOptions,
  overrides: Partial<RuntimeHostServiceManagementCliDeps> = {},
): Promise<number> {
  const deps: RuntimeHostServiceManagementCliDeps = {
    manage: manageRuntimeHostService,
    createBackend: createPlatformRuntimeHostServiceBackend,
    writeOutput: (value) => process.stdout.write(value),
    writeError: (value) => process.stderr.write(value),
    ...overrides,
  };
  try {
    const { json: _json, ...input } = options;
    const serviceId = resolveRuntimeHostManagedServiceId(options.clientDataRoot);
    const result = await deps.manage(input, deps.createBackend(serviceId));
    deps.writeOutput(
      options.json ? `${JSON.stringify({ ...result, ok: true })}\n` : formatHumanResult(result),
    );
    return 0;
  } catch (error) {
    const code =
      error instanceof RuntimeHostServiceManagerError ? error.code : 'internal_service_error';
    const message = error instanceof Error ? error.message : String(error);
    if (options.json) {
      deps.writeOutput(
        `${JSON.stringify({ schemaVersion: 1, ok: false, action: options.action, error: { code, message } })}\n`,
      );
    } else {
      deps.writeError(`${message}\n`);
    }
    return 1;
  }
}

function formatHumanResult(result: RuntimeHostManagedServiceResult): string {
  const service = result.service;
  if (result.action === 'uninstall') {
    return result.retainedStateRoot
      ? `Runtime Host service is uninstalled. Data was retained at ${result.retainedStateRoot}\n`
      : 'Runtime Host service is uninstalled.\n';
  }
  if (result.action === 'install') {
    return service.active
      ? `Runtime Host service is installed and running at ${websocketUrl(service)}\n`
      : 'Runtime Host service is installed but is not running. Check its status and journal.\n';
  }
  if (result.action === 'status') {
    if (!service.installed) return 'Runtime Host service is not installed.\n';
    return `Runtime Host service is ${service.state} at ${websocketUrl(service)}\n`;
  }
  return `Runtime Host service is ${service.state}.\n`;
}

export function createPlatformRuntimeHostServiceBackend(
  serviceId: string,
): RuntimeHostServiceBackend {
  if (process.platform === 'linux') return createSystemdUserRuntimeHostService(serviceId);
  throw new RuntimeHostServiceManagerError(
    'unsupported_platform',
    'Managed Runtime Host services currently require Linux',
  );
}

function websocketUrl(service: RuntimeHostManagedServiceResult['service']): string {
  const websocket = service.config?.websocket;
  return websocket
    ? `ws://${websocket.host}:${websocket.port}${websocket.path}`
    : 'an unknown endpoint';
}
