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

import type { IpcMain } from 'electron';
import {
  MCP_CONFIG_VERSION,
  type McpConfigAddResult,
  type McpConfigFile,
  type McpConfigImportResult,
  type McpConfigUpdateResult,
  type McpServerConfig,
  type McpServerStatus,
} from '@maka/core/mcp';
import type { McpClientManager } from '@maka/mcp';
import {
  AtomicFileWriteCommitUnknownError,
  McpServerExistsError,
  McpConfigSourceError,
  updateMcpConfiguration,
  normalizeMcpImport,
  type McpConfigStore,
} from '@maka/storage/mcp-config-store';
import type { McpOAuthController } from './mcp-oauth-controller.js';
import {
  redactMcpConfigSecrets,
  restoreMcpConfigSecrets,
  restoreMcpServerSecret,
} from './mcp-secret-guard.js';

export interface McpIpcMainDeps {
  ipcMain: Pick<IpcMain, 'handle'>;
  store: McpConfigStore;
  manager: Pick<
    McpClientManager,
    'sync' | 'statuses' | 'test' | 'forgetServerCredentials'
  >;
  oauth: McpOAuthController;
  /** Shared with the OAuth controller (see createMcpExclusiveLane). Falls
   * back to a private lane when not provided. */
  exclusiveLane?: McpExclusiveLane;
  ensureReady(): Promise<void>;
  publishCapabilities(): Promise<void>;
  onPublicationError(error: unknown): void;
  emitChanged(statuses: McpServerStatus[]): void;
}

/** One serialized slot at a time. Config transactions AND the OAuth
 * controller's login claims run through the same lane, so "no login is
 * active" checked inside a transaction cannot be invalidated by a claim
 * landing between the check and the write — and a claim never lands while
 * a transaction is mid-flight. */
export type McpExclusiveLane = <T>(work: () => Promise<T>) => Promise<T>;

export function createMcpExclusiveLane(): McpExclusiveLane {
  let lane: Promise<unknown> = Promise.resolve();
  return (work) => {
    const run = lane.then(work, work);
    lane = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

export function registerMcpIpcMain(deps: McpIpcMainDeps): () => void {
  // Main is the authority on operation exclusivity, not the renderer's
  // advisory locks: while a login round owns a server, a config mutation
  // would race the browser callback against a changed or absent server.
  const assertNoActiveLogin = (serverId: string) => {
    if (deps.oauth.isActive(serverId)) {
      throw new Error(
        `MCP server "${serverId}" has a login in progress — wait for it to finish before changing its configuration`,
      );
    }
  };
  // Every config mutation is one transaction on one lane and one shared file
  // lock:
  //   read the authoritative snapshot → restore sentinels and apply the
  //   active-login gate against it → erase the credentials this commit
  //   orphans (removed servers, repointed endpoints) → persist.
  // The lane also excludes Desktop OAuth claims; the store transaction makes
  // the same sequence linearizable against TUI and other process writers.
  // Credentials go first so a failed erase aborts the commit while everything
  // is still configured and retryable — never a persisted removal whose token
  // a same-id re-add could inherit after a restart.
  const inMutationLane = deps.exclusiveLane ?? createMcpExclusiveLane();
  const commitConfig = async (
    mutate: (current: McpConfigFile) => McpConfigFile,
  ): Promise<McpConfigFile> => {
    try {
      return await updateMcpConfiguration(deps.store, (current) => {
        const next = mutate(current);
        // The authoritative gate: every server this commit semantically touches
        // is re-checked INSIDE the lane. The handler-entry checks are advisory
        // fast-fails; this one cannot race a login claim, because claims travel
        // the same lane.
        for (const serverId of new Set([
          ...Object.keys(current.mcpServers),
          ...Object.keys(next.mcpServers),
        ])) {
          const before = current.mcpServers[serverId];
          const after = next.mcpServers[serverId];
          if (JSON.stringify(before) !== JSON.stringify(after)) assertNoActiveLogin(serverId);
        }
        return next;
      }, (serverId, previous) => deps.manager.forgetServerCredentials(serverId, previous));
    } catch (error) {
      if (!(error instanceof AtomicFileWriteCommitUnknownError)) throw error;
      // Rename has already published a file even though its durability fence
      // failed. Read the authority again rather than replaying the mutation
      // or assuming our proposed snapshot is still current. Keep this in the
      // mutation lane so another local mutation or OAuth claim cannot pass
      // the reconciliation, and retain the original durability failure.
      try {
        const authoritative = await deps.store.get();
        await deps.manager.sync(authoritative);
        changed(deps);
      } catch (reconciliationError) {
        throw new AggregateError(
          [error, reconciliationError],
          'MCP write durability is uncertain and runtime state is out of sync; reload before retrying',
          { cause: error },
        );
      }
      throw error;
    }
  };
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
    return deps.manager.statuses().map((status) => ({
      ...status,
      ...(deps.oauth.isActive(status.serverId) ? { authorizationPending: true } : {}),
    }));
  });
  deps.ipcMain.handle(
    'mcp:importConfig',
    async (_event, source: string): Promise<McpConfigImportResult> => {
      let imported: McpConfigFile;
      try {
        imported = normalizeMcpImport(source);
      } catch (error) {
        if (error instanceof McpConfigSourceError) {
          return {
            status: 'invalid',
            reason: error.reason,
            ...(error.version === undefined ? {} : { version: error.version }),
          };
        }
        throw error;
      }
      const importedCount = Object.keys(imported.mcpServers).length;
      return inMutationLane(async () => {
        const next = await commitConfig((current) =>
          restoreMcpConfigSecrets(
            {
              version: MCP_CONFIG_VERSION,
              mcpServers: { ...current.mcpServers, ...imported.mcpServers },
            },
            current,
          ),
        );
        await deps.manager.sync(next);
        changed(deps);
        return { status: 'imported', config: redactMcpConfigSecrets(next), importedCount };
      });
    },
  );
  deps.ipcMain.handle(
    'mcp:add',
    async (_event, serverId: string, config: McpServerConfig): Promise<McpConfigAddResult> => {
      assertNoActiveLogin(serverId);
      try {
        const next = await inMutationLane(() =>
          commitConfig((current) => {
            // Existence check and write are one serialized step, and the
            // restore reads the same current snapshot the write commits over.
            if (Object.hasOwn(current.mcpServers, serverId)) {
              throw new McpServerExistsError(serverId);
            }
            return {
              ...current,
              mcpServers: {
                ...current.mcpServers,
                [serverId]: restoreMcpServerSecret(serverId, config, current),
              },
            };
          }),
        );
        await deps.manager.sync(next);
        changed(deps);
        return { status: 'added', config: redactMcpConfigSecrets(next) };
      } catch (error) {
        if (error instanceof McpServerExistsError) return { status: 'exists' };
        throw error;
      }
    },
  );
  const updateServer = async (
    serverId: string,
    change: (current: McpConfigFile, previous: McpServerConfig) => McpServerConfig,
  ): Promise<McpConfigUpdateResult> => {
    assertNoActiveLogin(serverId);
    let next: McpConfigFile;
    try {
      next = await inMutationLane(() =>
        commitConfig((current) => {
          const previous = current.mcpServers[serverId];
          if (!previous) throw new McpServerChangedError();
          return {
            ...current,
            mcpServers: { ...current.mcpServers, [serverId]: change(current, previous) },
          };
        }),
      );
    } catch (error) {
      if (error instanceof McpServerChangedError) return { status: 'stale' };
      throw error;
    }
    await deps.manager.sync(next);
    changed(deps);
    return { status: 'updated', config: redactMcpConfigSecrets(next) };
  };
  // `basis` is the server as the renderer last showed it, secrets redacted. A
  // server that no longer matches it was changed elsewhere (the TUI edits the
  // same file), and saving over it would silently drop that change.
  deps.ipcMain.handle(
    'mcp:update',
    (_event, serverId: string, config: McpServerConfig, basis: McpServerConfig) =>
      updateServer(serverId, (current, previous) => {
        const seen = redactMcpConfigSecrets({
          version: MCP_CONFIG_VERSION,
          mcpServers: { [serverId]: previous },
        }).mcpServers[serverId];
        if (JSON.stringify(seen) !== JSON.stringify(basis)) throw new McpServerChangedError();
        return restoreMcpServerSecret(serverId, config, current);
      }),
  );
  // Flips the switch on what is on disk, so a toggle never writes back the
  // rest of an older copy.
  deps.ipcMain.handle('mcp:setEnabled', (_event, serverId: string, enabled: boolean) =>
    updateServer(serverId, (_current, previous) => ({ ...previous, enabled })),
  );
  const removeServer = async (serverId: string): Promise<McpConfigFile> =>
    inMutationLane(() =>
      commitConfig((current) => {
        const { [serverId]: _removed, ...mcpServers } = current.mcpServers;
        return { ...current, mcpServers };
      }),
    );
  deps.ipcMain.handle('mcp:remove', async (_event, serverId: string) => {
    assertNoActiveLogin(serverId);
    const next = await removeServer(serverId);
    await deps.manager.sync(next);
    changed(deps);
    // Still a full config crossing toward the renderer: the remaining
    // servers' secrets must leave as sentinels here too.
    return redactMcpConfigSecrets(next);
  });
  deps.ipcMain.handle('mcp:test', async (_event, serverId: string) => {
    await deps.ensureReady();
    const result = await deps.manager.test(serverId);
    deps.emitChanged(deps.manager.statuses());
    return result;
  });
  deps.ipcMain.handle('mcp:login', async (_event, serverId: string) => {
    // No preflight here: readiness and the callback-port lookup run INSIDE
    // the controller under its round deadline, so a stalled store cannot
    // park this promise (and the renderer's login lock) forever.
    try {
      return await deps.oauth.login(serverId);
    } finally {
      // Success and failure both may have moved the connection state
      // (needs-auth → connected, or a fresh needs-auth after a refused
      // consent screen) — the renderer needs whichever it is.
      changed(deps);
    }
  });
  deps.ipcMain.handle('mcp:cancelLogin', async (_event, serverId: string) => {
    const cancelled = deps.oauth.cancelLogin(serverId);
    // The round's own rejection path abandons the persisted pending state;
    // the renderer just needs the resulting statuses.
    if (cancelled) changed(deps);
    return cancelled;
  });
  deps.ipcMain.handle('mcp:logout', async (_event, serverId: string) => {
    // Like mcp:login, no preflight here: readiness runs INSIDE the
    // controller under its round deadline, so a stalled store cannot park
    // the renderer's logout lock forever.
    try {
      return await deps.oauth.logout(serverId);
    } finally {
      changed(deps);
    }
  });
  // Another process (the TUI, another window) replacing mcp.json is followed
  // the way a change made here is. A login in flight needs nothing: the
  // manager binds each round to the URL it started against.
  return deps.store.subscribeChanges((error) => {
    if (error) {
      console.error('[mcp] stopped following mcp.json changes:', error);
      return;
    }
    void deps.ensureReady()
      .then(() => inMutationLane(async () => deps.manager.sync(await deps.store.get())))
      .then(
        () => changed(deps),
        (failure: unknown) => console.error('[mcp] could not apply an mcp.json change:', failure),
      );
  });
}

class McpServerChangedError extends Error {}

function changed(deps: McpIpcMainDeps): void {
  deps.emitChanged(deps.manager.statuses());
  void Promise.resolve()
    .then(() => deps.publishCapabilities())
    .catch(deps.onPublicationError);
}
