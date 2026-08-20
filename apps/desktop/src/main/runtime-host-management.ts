import type { IpcMain } from 'electron';
import type { RuntimeHostServiceManagementFrame } from '@maka/runtime-host/client';
import type {
  DesktopRuntimeHostManagementAction,
} from '../preload/bridge-contract.js';
import type { DesktopRuntimeHostProfileService } from './runtime-host-profile-service.js';
import type {
  DesktopRuntimeHostSetupPackage,
  DesktopRuntimeHostSshManagementInput,
} from './runtime-host-ssh-terminal.js';

const MANAGEMENT_ACTIONS = new Set<DesktopRuntimeHostManagementAction>([
  'status',
  'start',
  'restart',
  'logs',
  'uninstall',
]);

export function createDesktopRuntimeHostManagement(input: {
  readonly ipcMain: Pick<IpcMain, 'handle' | 'removeHandler'>;
  readonly clientInstanceId: string;
  readonly profiles: Pick<DesktopRuntimeHostProfileService, 'getSnapshot'>;
  readonly runServiceManagement: (
    input: DesktopRuntimeHostSshManagementInput,
  ) => Promise<RuntimeHostServiceManagementFrame>;
  readonly setupPackage: DesktopRuntimeHostSetupPackage;
}): { close(): void } {
  const resolveProfile = async (value: unknown) => {
    if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
      throw new Error('Runtime Host profile ID is invalid');
    }
    const snapshot = await input.profiles.getSnapshot();
    const entry = snapshot.entries.find((candidate) => candidate.profile.id === value);
    if (!entry || entry.profile.kind !== 'remote') {
      throw new Error('Remote Runtime Host profile was not found');
    }
    return entry.profile;
  };

  const run = async (profileId: unknown, action: unknown) => {
    if (!MANAGEMENT_ACTIONS.has(action as DesktopRuntimeHostManagementAction)) {
      throw new Error('Runtime Host service management action is invalid');
    }
    const profile = await resolveProfile(profileId);
    if (profile.transport.kind !== 'ssh' || !profile.managedService) {
      throw new Error('This Runtime Host profile is not bound to a managed service');
    }
    return input.runServiceManagement({
      destination: profile.transport.destination,
      ...(profile.transport.sshPort === undefined ? {} : { sshPort: profile.transport.sshPort }),
      setupPackage: input.setupPackage,
      principalId: `desktop:${input.clientInstanceId}`,
      action: action as DesktopRuntimeHostManagementAction,
      expectedServiceId: profile.managedService.id,
      expectedRootPath: profile.managedService.rootPath,
      expectedRootId: profile.rootId,
    });
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
