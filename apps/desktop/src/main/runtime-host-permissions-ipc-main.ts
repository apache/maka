/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import {
  buildHealthSnapshot,
  healthSignalFromCapability,
  healthSignalFromConnection,
  healthSignalFromConnectionRuntime,
  workspaceHasDefaultModelTarget,
} from '@maka/core/health';
import { type AppSettings } from '@maka/core/settings';
import { type LlmConnection } from '@maka/core/llm-connections';
import type { UsageLogRow } from "@maka/core/usage-stats/types";
import type { BotRegistry } from '@maka/runtime/bots';
import {
  buildCapabilitySnapshotCollection,
  buildPermissionSnapshot,
} from "./capability-snapshot.js";
import { openSystemPermissionPane, requestPermissionAccess } from "./permissions-actions.js";
import { permissionSnapshotE2eFixture } from "./permission-snapshot-e2e-fixture.js";
import type { DesktopRuntimeHostClient } from "./runtime-host-client.js";
import {
  handleReconnectableRead,
  type ReconnectableReadIpcMain,
} from "./ipc-reconnect-policy.js";

type ComputerUseCapabilityInput = NonNullable<
  Parameters<typeof buildCapabilitySnapshotCollection>[0]["computerUse"]
>;

interface RuntimeHostPermissionsIpcDeps {
  readonly ipcMain: ReconnectableReadIpcMain;
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
  handleReconnectableRead(deps.ipcMain, "capabilities:getSnapshot", async () => {
    const snapshot = permissions();
    return buildCapabilitySnapshotCollection({
      settings: await deps.getSettings(),
      permissions: snapshot,
      botStatuses: deps.botRegistry.allStatuses(),
      computerUse: deps.getComputerUseCapabilityInput(),
      now: snapshot.checkedAt,
    });
  });
  handleReconnectableRead(deps.ipcMain, "health:getSnapshot", async () => {
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
    // The catalog projects `defaultModel` onto exactly one connection (the
    // default target): with a default configured somewhere, other enabled
    // connections carry an empty `defaultModel` by construction, and their
    // signal must say "not the default source", not "misconfigured". The
    // derivation (which requires the holder to be ENABLED — a disabled
    // holder cannot serve a new chat) lives in core beside the signal.
    const workspaceHasDefaultTarget = workspaceHasDefaultModelTarget(connections);
    const connectionSignals = (
      await Promise.all(
        connections.map(async (connection) => [
          healthSignalFromConnection(connection, now, { workspaceHasDefaultTarget }),
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
