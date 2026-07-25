import { ipcMain } from 'electron';
import {
  buildHealthSnapshot,
  healthSignalFromCapability,
  healthSignalFromConnection,
  healthSignalFromConnectionRuntime,
} from '@maka/core';
import type { BotRegistry } from '@maka/runtime';
import type { ConnectionStore, SettingsStore } from '@maka/storage';
import type { createTelemetryRepo } from '@maka/storage';
import { buildCapabilitySnapshotCollection, buildPermissionSnapshot } from './capability-snapshot.js';
import { openSystemPermissionPane, requestPermissionAccess } from './permissions-actions.js';
import { permissionSnapshotE2eFixture } from './permission-snapshot-e2e-fixture.js';
import { probeOfficeCli } from './officecli-probe.js';

/**
 * #1361: the `settings-permissions` e2e fixture pins a typed OS-permission
 * snapshot so the Permission Center's narrow-layout contract exercises rows
 * that actually carry grant buttons. Returns the real host snapshot otherwise —
 * see `permission-snapshot-e2e-fixture.ts`.
 */
function resolvePermissionSnapshot(now = Date.now()) {
  return permissionSnapshotE2eFixture(now) ?? buildPermissionSnapshot(now);
}

type TelemetryRepo = ReturnType<typeof createTelemetryRepo>;
type ComputerUseCapabilityInput = NonNullable<
  Parameters<typeof buildCapabilitySnapshotCollection>[0]['computerUse']
>;

export interface PermissionsIpcDeps {
  settingsStore: SettingsStore;
  connectionStore: ConnectionStore;
  telemetryRepo: TelemetryRepo;
  botRegistry: BotRegistry;
  getComputerUseCapabilityInput: () => ComputerUseCapabilityInput;
}

export function registerPermissionsIpc(deps: PermissionsIpcDeps): void {
  const { settingsStore, connectionStore, telemetryRepo, botRegistry, getComputerUseCapabilityInput } = deps;

  ipcMain.handle('permissions:getSnapshot', () => resolvePermissionSnapshot());
  ipcMain.handle('permissions:openSystemSettings', async (_event, permId: unknown) => {
    return openSystemPermissionPane(permId);
  });
  ipcMain.handle('permissions:requestAccess', async (_event, permId: unknown) => {
    return requestPermissionAccess(permId);
  });
  ipcMain.handle('capabilities:getSnapshot', async () => {
    const permissions = resolvePermissionSnapshot();
    const settings = await settingsStore.get();
    const officeCliProbe = await probeOfficeCli({ now: permissions.checkedAt });
    return buildCapabilitySnapshotCollection({
      settings,
      permissions,
      botStatuses: botRegistry.allStatuses(),
      officeCliProbe,
      computerUse: getComputerUseCapabilityInput(),
      now: permissions.checkedAt,
    });
  });
  ipcMain.handle('health:getSnapshot', async () => {
    const now = Date.now();
    const permissions = resolvePermissionSnapshot(now);
    const settings = await settingsStore.get();
    const officeCliProbe = await probeOfficeCli({ now });
    const capabilitySnapshot = buildCapabilitySnapshotCollection({
      settings,
      permissions,
      botStatuses: botRegistry.allStatuses(),
      officeCliProbe,
      computerUse: getComputerUseCapabilityInput(),
      now,
    });
    const connections = await connectionStore.list();
    const connectionSignals = connections.flatMap((connection) => [
      healthSignalFromConnection(connection, now),
      healthSignalFromConnectionRuntime(
        connection,
        telemetryRepo.latestLlmRuntimeProbe(connection.slug, connection.defaultModel),
        now,
      ),
    ].filter((signal): signal is NonNullable<typeof signal> => Boolean(signal)));
    return buildHealthSnapshot(now, [
      ...connectionSignals,
      ...capabilitySnapshot.capabilities.map(healthSignalFromCapability),
    ]);
  });
}
