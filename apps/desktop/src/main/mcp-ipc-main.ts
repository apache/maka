import type { IpcMain } from 'electron';
import type { McpConfigFile, McpServerConfig, McpServerStatus } from '@maka/core/mcp';
import type { McpClientManager } from '@maka/mcp';
import type { McpConfigStore } from '@maka/storage/mcp-config-store';
import {
  redactMcpConfigSecrets,
  restoreMcpConfigSecrets,
  restoreMcpServerSecret,
} from './mcp-secret-guard.js';

export interface McpIpcMainDeps {
  ipcMain: Pick<IpcMain, 'handle'>;
  store: McpConfigStore;
  manager: Pick<McpClientManager, 'sync' | 'statuses' | 'test' | 'cancelConnect'>;
  ensureReady(): Promise<void>;
  publishCapabilities(): Promise<void>;
  onPublicationError(error: unknown): void;
  emitChanged(statuses: McpServerStatus[]): void;
}

export function registerMcpIpcMain(deps: McpIpcMainDeps): void {
  const installs = new Map<string, { cancelled: boolean; settled: Promise<void>; settle(): void }>();
  // The renderer is semi-trusted (SECURITY.md §3): every config that crosses
  // toward it leaves with clientSecret replaced by the sentinel, and every
  // config it sends back has sentinels restored from disk before the store
  // and the manager (which needs the real secret) see it.
  deps.ipcMain.handle('mcp:getConfig', async () => {
    await deps.ensureReady();
    return redactMcpConfigSecrets(await deps.store.get());
  });
  deps.ipcMain.handle('mcp:listStatuses', async () => {
    await deps.ensureReady();
    return deps.manager.statuses();
  });
  // Restore runs INSIDE the store's serialized transform: reading a
  // snapshot first and writing later would let a concurrent update commit a
  // rotated secret in between, and the marker-bearing write would then
  // restore the OLD secret over it.
  deps.ipcMain.handle('mcp:setConfig', async (_event, config: McpConfigFile) => {
    const next = await deps.store.transform((current) =>
      restoreMcpConfigSecrets(config, current),
    );
    await deps.manager.sync(next);
    changed(deps);
    return redactMcpConfigSecrets(next);
  });
  deps.ipcMain.handle('mcp:upsert', async (_event, serverId: string, config: McpServerConfig) => {
    const next = await deps.store.transform((current) => ({
      ...current,
      mcpServers: {
        ...current.mcpServers,
        [serverId]: restoreMcpServerSecret(serverId, config, current),
      },
    }));
    await deps.manager.sync(next);
    changed(deps);
    return redactMcpConfigSecrets(next);
  });
  deps.ipcMain.handle('mcp:install', async (_event, serverId: string, config: McpServerConfig) => {
    if (installs.has(serverId)) throw new Error(`MCP install already in progress: ${serverId}`);
    let settle!: () => void;
    const operation = {
      cancelled: false,
      settled: new Promise<void>((resolve) => { settle = resolve; }),
      settle: () => settle(),
    };
    installs.set(serverId, operation);
    try {
      const next = await deps.store.transform((current) => ({
        ...current,
        mcpServers: {
          ...current.mcpServers,
          [serverId]: restoreMcpServerSecret(serverId, config, current),
        },
      }));
      if (operation.cancelled) return redactMcpConfigSecrets(next);
      try {
        await deps.manager.sync(next);
      } catch (error) {
        if (!operation.cancelled) throw error;
      }
      if (!operation.cancelled) changed(deps);
      return redactMcpConfigSecrets(next);
    } finally {
      if (installs.get(serverId) === operation) installs.delete(serverId);
      operation.settle();
    }
  });
  deps.ipcMain.handle('mcp:remove', async (_event, serverId: string) => {
    const next = await deps.store.remove(serverId);
    await deps.manager.sync(next);
    changed(deps);
    // Still a full config crossing toward the renderer: the remaining
    // servers' secrets must leave as sentinels here too.
    return redactMcpConfigSecrets(next);
  });
  deps.ipcMain.handle('mcp:cancelInstall', async (_event, serverId: string) => {
    const operation = installs.get(serverId);
    if (operation) operation.cancelled = true;
    deps.manager.cancelConnect(serverId);
    await operation?.settled;
    const next = await deps.store.remove(serverId);
    await deps.manager.sync(next);
    changed(deps);
    return redactMcpConfigSecrets(next);
  });
  deps.ipcMain.handle('mcp:test', async (_event, serverId: string) => {
    await deps.ensureReady();
    const result = await deps.manager.test(serverId);
    deps.emitChanged(deps.manager.statuses());
    return result;
  });
}

function changed(deps: McpIpcMainDeps): void {
  deps.emitChanged(deps.manager.statuses());
  void Promise.resolve()
    .then(() => deps.publishCapabilities())
    .catch(deps.onPublicationError);
}
