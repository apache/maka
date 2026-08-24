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
  isMcpStdioConfig,
  type McpConfigAddResult,
  type McpConfigFile,
  type McpServerConfig,
  type McpServerStatus,
} from '@maka/core/mcp';
import type { McpClientManager } from '@maka/mcp';
import { McpServerExistsError, normalizeMcpConfig, type McpConfigStore } from '@maka/storage';
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
    'sync' | 'statuses' | 'test' | 'cancelConnect' | 'forgetServerCredentials'
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

export function registerMcpIpcMain(deps: McpIpcMainDeps): void {
  const installs = new Map<
    string,
    { cancelled: boolean; committed?: string; settled: Promise<void>; settle(): void }
  >();
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
  // Every config mutation is one transaction on one lane:
  //   read the authoritative snapshot → restore sentinels and apply the
  //   active-login gate against it → erase the credentials this commit
  //   orphans (removed servers, repointed endpoints) → persist.
  // The credential erasure is asynchronous, so it cannot live inside the
  // store's synchronous transform; the lane serializes the whole sequence
  // instead, and the final transform still fails closed if the snapshot
  // drifted under an out-of-band writer. Credentials go first so a failed
  // erase aborts the commit while everything is still configured and
  // retryable — never a persisted removal whose token a same-id re-add
  // could inherit after a restart.
  const inMutationLane = deps.exclusiveLane ?? createMcpExclusiveLane();
  const commitConfig = async (
    mutate: (current: McpConfigFile) => McpConfigFile,
  ): Promise<McpConfigFile> => {
    const current = await deps.store.get();
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
    // Erases are per-server and not transactional as a set: if one fails
    // partway, the commit aborts with the EARLIER servers already logged
    // out. That partial effect is deliberately in the fail-closed direction
    // — a re-login is recoverable, a credential outliving its removed or
    // repointed config is not.
    for (const serverId of credentialRetirements(current, next)) {
      await deps.manager.forgetServerCredentials(serverId);
    }
    const snapshot = JSON.stringify(current);
    return deps.store.transform((actual) => {
      if (JSON.stringify(actual) !== snapshot) {
        throw new Error(
          'MCP configuration changed while this update was being prepared — retry the operation',
        );
      }
      return next;
    });
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
    return deps.manager.statuses();
  });
  deps.ipcMain.handle('mcp:setConfig', async (_event, config: McpConfigFile) =>
    inMutationLane(async () => {
      // Sentinels restore BEFORE the gate compares anything: the renderer's
      // copy of an untouched secret-bearing server still carries sentinels,
      // and comparing those against the stored real values would make every
      // such server look modified — vetoing a bulk edit that only touches
      // an unrelated server while some other login runs. commitConfig's
      // in-lane gate does the semantic comparison on the restored config.
      const next = await commitConfig((current) => restoreMcpConfigSecrets(config, current));
      await deps.manager.sync(next);
      changed(deps);
      return redactMcpConfigSecrets(next);
    }),
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
  deps.ipcMain.handle('mcp:upsert', async (_event, serverId: string, config: McpServerConfig) => {
    assertNoActiveLogin(serverId);
    const next = await inMutationLane(() =>
      commitConfig((current) => ({
        ...current,
        mcpServers: {
          ...current.mcpServers,
          [serverId]: restoreMcpServerSecret(serverId, config, current),
        },
      })),
    );
    await deps.manager.sync(next);
    changed(deps);
    return redactMcpConfigSecrets(next);
  });
  deps.ipcMain.handle('mcp:install', async (_event, serverId: string, config: McpServerConfig) => {
    assertNoActiveLogin(serverId);
    if (installs.has(serverId)) throw new Error(`MCP install already in progress: ${serverId}`);
    let settle!: () => void;
    const operation = {
      cancelled: false,
      committed: undefined as string | undefined,
      settled: new Promise<void>((resolve) => { settle = resolve; }),
      settle: () => settle(),
    };
    installs.set(serverId, operation);
    try {
      const next = await inMutationLane(() =>
        commitConfig((current) => {
          const installed = restoreMcpServerSecret(serverId, config, current);
          // What THIS install committed, for the cancellation to compare
          // against: a cancel must only roll back its own write, never a
          // newer same-id configuration that landed after it. Recorded in
          // the STORE's normal form — the real store normalizes on write
          // (key order, defaulted enabled/transport, WHATWG URL), so the
          // raw restored shape would mismatch its own persisted entry and
          // the rollback would silently no-op.
          operation.committed = JSON.stringify(
            normalizeMcpConfig({
              version: MCP_CONFIG_VERSION,
              mcpServers: { [serverId]: installed },
            }).mcpServers[serverId],
          );
          return {
            ...current,
            mcpServers: { ...current.mcpServers, [serverId]: installed },
          };
        }),
      );
      if (operation.cancelled) return redactMcpConfigSecrets(next);
      // The connect runs OUTSIDE the mutation lane: a cancellation must be
      // able to interrupt it, and its own removal transaction needs the lane.
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
  deps.ipcMain.handle('mcp:cancelInstall', async (_event, serverId: string) => {
    assertNoActiveLogin(serverId);
    const operation = installs.get(serverId);
    if (operation) operation.cancelled = true;
    deps.manager.cancelConnect(serverId);
    await operation?.settled;
    // Roll back only the install's OWN write. While the cancel waited, an
    // upsert can have replaced the entry with a newer same-id config —
    // removing whatever is current would delete that newer server and
    // retire its credentials.
    const next = await inMutationLane(() =>
      commitConfig((current) => {
        const entry = current.mcpServers[serverId];
        if (entry === undefined) return current;
        if (operation?.committed !== undefined && JSON.stringify(entry) !== operation.committed) {
          return current;
        }
        const { [serverId]: _removed, ...mcpServers } = current.mcpServers;
        return { ...current, mcpServers };
      }),
    );
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
}

/** Servers whose stored credentials this commit orphans: removed outright,
 * repointed to a different endpoint, or converted away from remote. An
 * unchanged endpoint keeps its credentials. Removals retire regardless of
 * kind — a stale record under a formerly-remote id must not survive the id
 * being freed for reuse. */
function credentialRetirements(current: McpConfigFile, next: McpConfigFile): string[] {
  const retired: string[] = [];
  for (const [serverId, server] of Object.entries(current.mcpServers)) {
    const incoming = Object.hasOwn(next.mcpServers, serverId)
      ? next.mcpServers[serverId]
      : undefined;
    if (!incoming) {
      retired.push(serverId);
      continue;
    }
    if (isMcpStdioConfig(server)) continue;
    if (isMcpStdioConfig(incoming) || incoming.url !== server.url) retired.push(serverId);
  }
  return retired;
}

function changed(deps: McpIpcMainDeps): void {
  deps.emitChanged(deps.manager.statuses());
  void Promise.resolve()
    .then(() => deps.publishCapabilities())
    .catch(deps.onPublicationError);
}
