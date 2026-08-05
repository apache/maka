import type { ipcMain as electronIpcMain } from "electron";
import {
  buildHealthSnapshot,
  healthSignalFromCapability,
  healthSignalFromConnection,
  healthSignalFromConnectionRuntime,
  type AppSettings,
  type LlmConnection,
} from "@maka/core";
import type { UsageLogRow } from "@maka/core/usage-stats/types";
import type { BotRegistry } from "@maka/runtime";
import {
  buildCapabilitySnapshotCollection,
  buildPermissionSnapshot,
} from "./capability-snapshot.js";
import { openSystemPermissionPane, requestPermissionAccess } from "./permissions-actions.js";
import { permissionSnapshotE2eFixture } from "./permission-snapshot-e2e-fixture.js";
import type { DesktopRuntimeHostClient } from "./runtime-host-client.js";

type ComputerUseCapabilityInput = NonNullable<
  Parameters<typeof buildCapabilitySnapshotCollection>[0]["computerUse"]
>;

interface RuntimeHostPermissionsIpcDeps {
  readonly ipcMain: Pick<typeof electronIpcMain, "handle">;
  readonly client: DesktopRuntimeHostClient;
  readonly getSettings: () => Promise<AppSettings>;
  readonly listConnections: () => Promise<LlmConnection[]>;
  readonly botRegistry: BotRegistry;
  readonly getComputerUseCapabilityInput: () => ComputerUseCapabilityInput;
}

export function registerRuntimeHostPermissionsIpc(
  deps: RuntimeHostPermissionsIpcDeps,
): void {
  const permissions = (now = Date.now()) =>
    permissionSnapshotE2eFixture(now) ?? buildPermissionSnapshot(now);

  deps.ipcMain.handle("permissions:getSnapshot", () => permissions());
  deps.ipcMain.handle(
    "permissions:openSystemSettings",
    (_event, permissionId: unknown) => openSystemPermissionPane(permissionId),
  );
  deps.ipcMain.handle(
    "permissions:requestAccess",
    (_event, permissionId: unknown) => requestPermissionAccess(permissionId),
  );
  deps.ipcMain.handle("capabilities:getSnapshot", async () => {
    const snapshot = permissions();
    return buildCapabilitySnapshotCollection({
      settings: await deps.getSettings(),
      permissions: snapshot,
      botStatuses: deps.botRegistry.allStatuses(),
      computerUse: deps.getComputerUseCapabilityInput(),
      now: snapshot.checkedAt,
    });
  });
  deps.ipcMain.handle("health:getSnapshot", async () => {
    const now = Date.now();
    const permissionSnapshot = permissions(now);
    const [settings, connections] = await Promise.all([
      deps.getSettings(),
      deps.listConnections(),
    ]);
    const capabilities = buildCapabilitySnapshotCollection({
      settings,
      permissions: permissionSnapshot,
      botStatuses: deps.botRegistry.allStatuses(),
      computerUse: deps.getComputerUseCapabilityInput(),
      now,
    });
    const connectionSignals = (
      await Promise.all(
        connections.map(async (connection) => [
          healthSignalFromConnection(connection, now),
          healthSignalFromConnectionRuntime(
            connection,
            await latestRuntimeProbe(deps.client, connection),
            now,
          ),
        ]),
      )
    ).flatMap((signals) =>
      signals.filter(
        (signal): signal is NonNullable<typeof signal> => signal !== undefined,
      ),
    );
    return buildHealthSnapshot(now, [
      ...connectionSignals,
      ...capabilities.capabilities.map(healthSignalFromCapability),
    ]);
  });
}

async function latestRuntimeProbe(
  client: DesktopRuntimeHostClient,
  connection: LlmConnection,
): Promise<UsageLogRow | undefined> {
  const result = await client.queryUsage({
    kind: "logs",
    source: "llm",
    query: {
      range: "all",
      connectionSlug: connection.slug,
      ...(connection.defaultModel ? { modelId: connection.defaultModel } : {}),
    },
    offset: 0,
    limit: 1,
  });
  return result.kind === "logs" && result.source === "llm"
    ? result.rows[0]
    : undefined;
}
