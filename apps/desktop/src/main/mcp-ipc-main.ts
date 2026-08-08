import type { IpcMain } from 'electron';
import type { McpConfigFile, McpServerConfig, McpServerStatus } from '@maka/core/mcp';
import type { McpClientManager } from '@maka/mcp';
import type { McpConfigStore } from '@maka/storage';

export interface McpIpcMainDeps {
  ipcMain: Pick<IpcMain, 'handle'>;
  store: McpConfigStore;
  manager: Pick<McpClientManager, 'sync' | 'statuses' | 'test' | 'reconnect' | 'cancelConnect'>;
  ensureReady(): Promise<void>;
  publishCapabilities(): Promise<void>;
  onPublicationError(error: unknown): void;
  emitChanged(statuses: McpServerStatus[]): void;
}

export function registerMcpIpcMain(deps: McpIpcMainDeps): void {
  const installs = new Map<string, { cancelled: boolean; settled: Promise<void>; settle(): void }>();
  deps.ipcMain.handle('mcp:getConfig', async () => {
    await deps.ensureReady();
    return deps.store.get();
  });
  deps.ipcMain.handle('mcp:listStatuses', async () => {
    await deps.ensureReady();
    return deps.manager.statuses();
  });
  deps.ipcMain.handle('mcp:setConfig', async (_event, config: McpConfigFile) => {
    const next = await deps.store.set(config);
    await deps.manager.sync(next);
    changed(deps);
    return next;
  });
  deps.ipcMain.handle('mcp:upsert', async (_event, serverId: string, config: McpServerConfig) => {
    const next = await deps.store.upsert(serverId, config);
    await deps.manager.sync(next);
    changed(deps);
    return next;
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
      const next = await deps.store.upsert(serverId, config);
      if (operation.cancelled) return next;
      try {
        await deps.manager.sync(next);
      } catch (error) {
        if (!operation.cancelled) throw error;
      }
      if (!operation.cancelled) changed(deps);
      return next;
    } finally {
      if (installs.get(serverId) === operation) installs.delete(serverId);
      operation.settle();
    }
  });
  deps.ipcMain.handle('mcp:remove', async (_event, serverId: string) => {
    const next = await deps.store.remove(serverId);
    await deps.manager.sync(next);
    changed(deps);
    return next;
  });
  deps.ipcMain.handle('mcp:cancelInstall', async (_event, serverId: string) => {
    const operation = installs.get(serverId);
    if (operation) operation.cancelled = true;
    deps.manager.cancelConnect(serverId);
    await operation?.settled;
    const next = await deps.store.remove(serverId);
    await deps.manager.sync(next);
    changed(deps);
    return next;
  });
  deps.ipcMain.handle('mcp:test', async (_event, serverId: string) => {
    await deps.ensureReady();
    const result = await deps.manager.test(serverId);
    deps.emitChanged(deps.manager.statuses());
    return result;
  });
  deps.ipcMain.handle('mcp:reconnect', async (_event, serverId: string) => {
    await deps.ensureReady();
    const result = await deps.manager.reconnect(serverId);
    changed(deps);
    return result;
  });
}

function changed(deps: McpIpcMainDeps): void {
  deps.emitChanged(deps.manager.statuses());
  void Promise.resolve()
    .then(() => deps.publishCapabilities())
    .catch(deps.onPublicationError);
}
