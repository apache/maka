import { ipcMain } from 'electron';
import {
  buildHealthSnapshot,
  healthSignalFromCapability,
  healthSignalFromConnection,
  healthSignalFromConnectionRuntime,
} from '@maka/core';
import type { BotRegistry } from '@maka/runtime';
import {
  projectModelCallUsageLogs,
  resolveUsageRange,
} from '@maka/core/model-call-usage-projection';
import type { UsageLogRow } from '@maka/core/usage-stats/types';
import type {
  ConnectionStore,
  createSqliteModelCallLedger,
  SettingsStore,
  TelemetryRepo,
} from '@maka/storage';
import { buildCapabilitySnapshotCollection, buildPermissionSnapshot } from './capability-snapshot.js';
import { openSystemPermissionPane, requestPermissionAccess } from './permissions-actions.js';
import { permissionSnapshotE2eFixture } from './permission-snapshot-e2e-fixture.js';

/**
 * #1361: the `settings-permissions` e2e fixture pins a typed OS-permission
 * snapshot so the Permission Center's narrow-layout contract exercises rows
 * that actually carry grant buttons. Returns the real host snapshot otherwise —
 * see `permission-snapshot-e2e-fixture.ts`.
 */
function resolvePermissionSnapshot(now = Date.now()) {
  return permissionSnapshotE2eFixture(now) ?? buildPermissionSnapshot(now);
}

type ModelCallLedger = ReturnType<typeof createSqliteModelCallLedger>;
type ComputerUseCapabilityInput = NonNullable<
  Parameters<typeof buildCapabilitySnapshotCollection>[0]['computerUse']
>;

export interface PermissionsIpcDeps {
  settingsStore: SettingsStore;
  connectionStore: ConnectionStore;
  telemetryRepo: TelemetryRepo;
  modelCallLedger: ModelCallLedger;
  ensureUsageReady: () => Promise<void>;
  botRegistry: BotRegistry;
  getComputerUseCapabilityInput: () => ComputerUseCapabilityInput;
}

export function registerPermissionsIpc(deps: PermissionsIpcDeps): void {
  const {
    settingsStore,
    connectionStore,
    telemetryRepo,
    modelCallLedger,
    ensureUsageReady,
    botRegistry,
    getComputerUseCapabilityInput,
  } = deps;

  /**
   * Newest real call for a connection, across both metering sources (#1679).
   * Main sends settle only into the canonical ledger now, so the frozen table
   * alone would report a connection as silent while it is actively in use.
   */
  const latestRuntimeProbe = (
    connectionSlug: string,
    modelId?: string,
  ): UsageLogRow | undefined => {
    const query = { range: 'all' as const, connectionSlug, ...(modelId ? { modelId } : {}) };
    const now = Date.now();
    const legacy = telemetryRepo.latestLlmRuntimeProbe(connectionSlug, modelId);
    const canonical = projectModelCallUsageLogs(
      modelCallLedger.read(resolveUsageRange(query.range, now)).attempts,
      query,
      now,
      0,
      1,
    ).rows[0];
    if (!legacy) return canonical;
    if (!canonical) return legacy;
    return canonical.ts >= legacy.ts ? canonical : legacy;
  };

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
    return buildCapabilitySnapshotCollection({
      settings,
      permissions,
      botStatuses: botRegistry.allStatuses(),
      computerUse: getComputerUseCapabilityInput(),
      now: permissions.checkedAt,
    });
  });
  ipcMain.handle('health:getSnapshot', async () => {
    await ensureUsageReady();
    const now = Date.now();
    const permissions = resolvePermissionSnapshot(now);
    const settings = await settingsStore.get();
    const capabilitySnapshot = buildCapabilitySnapshotCollection({
      settings,
      permissions,
      botStatuses: botRegistry.allStatuses(),
      computerUse: getComputerUseCapabilityInput(),
      now,
    });
    const connections = await connectionStore.list();
    const connectionSignals = connections.flatMap((connection) => [
      healthSignalFromConnection(connection, now),
      healthSignalFromConnectionRuntime(
        connection,
        latestRuntimeProbe(connection.slug, connection.defaultModel),
        now,
      ),
    ].filter((signal): signal is NonNullable<typeof signal> => Boolean(signal)));
    return buildHealthSnapshot(now, [
      ...connectionSignals,
      ...capabilitySnapshot.capabilities.map(healthSignalFromCapability),
    ]);
  });
}
