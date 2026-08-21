import type { IpcMain } from 'electron';
import type { RuntimeHostServiceManagementFrame } from '@maka/runtime-host/operator';
import type {
  DesktopRuntimeHostManagementAction,
  DesktopRuntimeHostManagementResponse,
} from '../preload/bridge-contract.js';
import type { DesktopRuntimeHostProfileService } from './runtime-host-profile-service.js';
import type {
  DesktopRuntimeHostSshManagementInput,
} from './runtime-host-ssh-terminal.js';

const MANAGEMENT_ACTIONS = new Set<DesktopRuntimeHostManagementAction>([
  'status',
  'start',
  'restart',
  'logs',
  'repair',
  'uninstall',
]);

export function createDesktopRuntimeHostManagement(input: {
  readonly ipcMain: Pick<IpcMain, 'handle' | 'removeHandler'>;
  readonly profiles: Pick<
    DesktopRuntimeHostProfileService,
    | 'resolveManagedService'
    | 'markManagedServiceUninstalling'
    | 'clearManagedServiceBinding'
  >;
  readonly runServiceManagement: (
    input: DesktopRuntimeHostSshManagementInput,
  ) => Promise<RuntimeHostServiceManagementFrame>;
}): { close(): void } {
  const resolveManagedService = async (value: unknown) => {
    if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
      throw new Error('Runtime Host profile ID is invalid');
    }
    const managed = await input.profiles.resolveManagedService(value);
    if (!managed) throw new Error('This Runtime Host profile is not bound to a managed service');
    return managed;
  };

  const run = async (
    profileId: unknown,
    action: unknown,
  ): Promise<DesktopRuntimeHostManagementResponse> => {
    if (!MANAGEMENT_ACTIONS.has(action as DesktopRuntimeHostManagementAction)) {
      throw new Error('Runtime Host service management action is invalid');
    }
    const managed = await resolveManagedService(profileId);
    const { profile, service } = managed;
    if (profile.transport.kind !== 'ssh') {
      throw new Error('This Runtime Host profile is not bound to a managed service');
    }
    if (managed.state === 'uninstalling' && action !== 'uninstall') {
      throw new Error('Finish uninstalling this Runtime Host service before managing it');
    }
    const managementInput: DesktopRuntimeHostSshManagementInput = {
      destination: profile.transport.destination,
      ...(profile.transport.sshPort === undefined ? {} : { sshPort: profile.transport.sshPort }),
      operatorPath: service.operatorPath,
      action: action === 'repair'
        ? 'install'
        : action as Exclude<DesktopRuntimeHostManagementAction, 'repair'>,
      expectedTarget: {
        serviceId: service.id,
        rootPath: service.rootPath,
        rootId: profile.rootId,
      },
      ...(action === 'repair'
        ? {
            rootPath: service.rootPath,
            websocketPort: profile.transport.remotePort,
            websocketPath: profile.transport.websocketPath,
          }
        : {}),
    };
    if (action !== 'uninstall') {
      const response = await input.runServiceManagement(managementInput);
      if (isOperatorMissingError(response)) {
        throw new Error('The Runtime Host operator disappeared during service management');
      }
      return response;
    }

    let pending = managed;
    if (managed.state === 'active') {
      const response = await input.runServiceManagement({
        ...managementInput,
        retainManagedDeployment: true,
      });
      if (isOperatorMissingError(response)) {
        throw new Error('The Runtime Host operator disappeared before uninstall began');
      }
      if (response.kind === 'error') return response;
      pending = await input.profiles.markManagedServiceUninstalling(managed);
    }
    const response = await input.runServiceManagement({
      ...managementInput,
      allowMissingOperator: true,
      resumeManagedDeploymentCleanup: true,
    });
    if (response.kind === 'error' && !isOperatorMissingError(response)) return response;
    await input.profiles.clearManagedServiceBinding(pending);
    return { kind: 'uninstalled', retainedStateRoot: service.rootPath };
  };

  const channel = 'runtime-host-management:run';
  input.ipcMain.handle(channel, (_event, profileId: unknown, action: unknown) =>
    run(profileId, action));

  return {
    close() {
      input.ipcMain.removeHandler(channel);
    },
  };
}

function isOperatorMissingError(frame: RuntimeHostServiceManagementFrame): boolean {
  return frame.kind === 'error' && frame.error.code === 'operator_missing';
}
