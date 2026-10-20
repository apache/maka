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

import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { RequestError, type McpServer } from '@agentclientprotocol/sdk';
import { MCP_CONFIG_VERSION, type McpConfigFile } from '@maka/core/mcp';
import { stableJsonStringify } from '@maka/core/canonical-json';
import { McpClientManager } from '@maka/mcp';
import { normalizeMcpConfig } from '@maka/storage/mcp-config-store';
import {
  RuntimeHostOperationError,
  abortable,
  type RuntimeHostConnectionAvailability,
  type RuntimeHostReconnectingConnection,
} from '@maka/runtime-host/client';
import { createMcpCapabilityProvider } from '../mcp-capability-provider.js';
import { McpCapabilityPublication } from '../mcp-capability-publication.js';

export type AcpMcpConnection = Pick<
  RuntimeHostReconnectingConnection,
  'replaceClientCapabilities' | 'unregisterClientCapabilities' | 'subscribeConnectionAvailability'
>;

/** Validates before any process or Host work; never writes a user MCP configuration. */
export function createAcpMcpConfig<
  T extends {
    readonly cwd: string;
    readonly mcpServers: readonly McpServer[];
  },
>(params: T): McpConfigFile {
  const servers: Record<string, unknown> = Object.create(null);
  if (!Array.isArray(params.mcpServers)) throw invalidMcpInput('invalid_servers');
  for (const server of params.mcpServers) {
    if (!server || typeof server !== 'object' || 'type' in server || !('command' in server)) {
      throw invalidMcpInput('unsupported_transport');
    }
    if (typeof server.name !== 'string' || Object.hasOwn(servers, server.name)) {
      throw invalidMcpInput('duplicate_or_invalid_name');
    }
    if (
      typeof server.command !== 'string' ||
      !isAbsolute(server.command) ||
      server.command.includes('\0')
    ) {
      throw invalidMcpInput('command_must_be_absolute');
    }
    if (
      !Array.isArray(server.args) ||
      server.args.some((arg: unknown) => typeof arg !== 'string' || arg.includes('\0'))
    ) {
      throw invalidMcpInput('invalid_arguments');
    }
    if (!Array.isArray(server.env)) throw invalidMcpInput('invalid_environment');
    const env: Record<string, string> = Object.create(null);
    for (const variable of server.env) {
      if (
        !variable ||
        typeof variable.name !== 'string' ||
        variable.name.length === 0 ||
        variable.name.includes('\0') ||
        variable.name.includes('=') ||
        Object.hasOwn(env, variable.name) ||
        typeof variable.value !== 'string' ||
        variable.value.includes('\0')
      ) {
        throw invalidMcpInput('duplicate_or_invalid_environment');
      }
      env[variable.name] = variable.value;
    }
    servers[server.name] = {
      command: server.command,
      args: server.args,
      env,
      cwd: params.cwd,
      protocol: 'auto',
    };
  }
  try {
    return normalizeMcpConfig({ version: MCP_CONFIG_VERSION, mcpServers: servers });
  } catch {
    throw invalidMcpInput('invalid_configuration');
  }
}

/** Owns one Session's in-memory MCP processes and publication on the shared Host connection. */
export class AcpSessionMcp {
  readonly #sessionId: string;
  #config: McpConfigFile;
  #configurationTail: Promise<unknown> = Promise.resolve();
  #manager = new McpClientManager({
    clientName: 'maka-acp',
    excludedStdioEnvironmentKeys: ['MAKA_RUNTIME_HOST_ACCESS_CREDENTIAL'],
  });
  readonly #publication: McpCapabilityPublication;
  #unsubscribeManager: () => void;
  readonly #unsubscribeConnection: () => void;
  #pendingManager: McpClientManager | undefined;
  readonly #retainedManagers = new Set<McpClientManager>();
  readonly #retirementTasks = new Set<Promise<void>>();
  #publicationRevision = 0;
  #requireIdlePublication = false;
  #availability: RuntimeHostConnectionAvailability | undefined;
  #prepared = false;
  #closed = false;
  #authoritativelyRetired = false;
  #closeTask: Promise<void> | undefined;

  constructor(sessionId: string, config: McpConfigFile, connection: AcpMcpConnection) {
    this.#sessionId = sessionId;
    this.#config = config;
    this.#publication = new McpCapabilityPublication({
      connectionIdentity: () =>
        this.#availability?.kind === 'connected'
          ? this.#availability.hostEpoch + '\0' + this.#availability.connectionId
          : undefined,
      revision: () => this.#publicationRevision,
      createProvider: () =>
        createMcpCapabilityProvider(this.#manager, {
          admission: 'mcp',
          onCurrentRegistrationRetired: () => this.#retire(),
        }) ?? {
          // Empty is still an authoritative Session snapshot. Publish it on a
          // new connection to clear lost Host contracts, and retain retirement
          // notification even while every configured server has no tools.
          offers: () => [],
          currentRegistrationRetired: () => this.#retire(),
        },
      replace: (provider) =>
        connection.replaceClientCapabilities(provider, {
          sessionId,
          sessionConfigurationId: `sha256:${createHash('sha256').update(stableJsonStringify(this.#config)).digest('hex')}`,
          ...(this.#requireIdlePublication ? { requireIdleSession: true } : {}),
        }),
      unregister: () => connection.unregisterClientCapabilities({ sessionId }),
      onState: (state) => {
        if (
          (state === 'published' || state === 'not_published') &&
          this.#publication.publishedRevision === this.#publicationRevision
        ) {
          this.#requireIdlePublication = false;
          this.#retireRetainedManagers();
        }
      },
    });
    this.#unsubscribeManager = this.#observeManager(this.#manager);
    this.#unsubscribeConnection = connection.subscribeConnectionAvailability((availability) => {
      this.#availability = availability;
      if (availability.kind !== 'connected') this.#publication.invalidate();
      if (this.#prepared && !this.#closed) this.#publication.request();
    });
  }

  async prepare(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const cancel = () => {
      void this.close().catch(() => undefined);
    };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      await this.#manager.sync(this.#config);
      signal?.throwIfAborted();
      this.#assertConnected();
      this.#prepared = true;
      await this.ready(signal);
      this.#assertConnected();
    } catch (error) {
      await this.close().catch(() => undefined);
      if (error instanceof RequestError) throw error;
      throw mcpUnavailable(this.#sessionId, 'mcp.prepare', 'mcp_preparation_failed');
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  }

  get config(): McpConfigFile {
    return structuredClone(this.#config);
  }

  reconfigure(
    config: McpConfigFile,
    signal?: AbortSignal,
    assertCanChange?: () => Promise<void>,
  ): Promise<void> {
    const task = this.#configurationTail
      .catch(() => undefined)
      .then(async () => {
        this.#assertOpen('mcp.prepare');
        signal?.throwIfAborted();
        if (sameMcpConfig(this.#config, config)) return this.#settlePublication(signal);
        if (this.#retainedManagers.size > 0) await this.#settlePublication(signal);
        await assertCanChange?.();
        signal?.throwIfAborted();
        const previous = this.#manager;
        const previousConfig = this.#config;
        const staged = new McpClientManager({
          clientName: 'maka-acp',
          excludedStdioEnvironmentKeys: ['MAKA_RUNTIME_HOST_ACCESS_CREDENTIAL'],
        });
        this.#pendingManager = staged;
        let swapped = false;
        let previousRevision = this.#publicationRevision;
        try {
          await staged.sync(config);
          signal?.throwIfAborted();
          this.#assertConnected(config, staged);
          previousRevision = this.#publicationRevision;
          this.#unsubscribeManager();
          this.#manager = staged;
          this.#config = config;
          this.#unsubscribeManager = this.#observeManager(staged);
          this.#retainedManagers.add(previous);
          this.#pendingManager = undefined;
          swapped = true;
          this.#requireIdlePublication = true;
          this.#publicationRevision += 1;
          this.#publication.request();
          await this.#settlePublication(signal);
          this.#requireIdlePublication = false;
          this.#retireRetainedManagers();
          await Promise.allSettled([...this.#retirementTasks]);
        } catch (error) {
          if (swapped && !this.#closed) {
            // Cancellation can win after the Host committed a new provider but
            // before its response arrived. Resolve the in-flight publication
            // before deciding which manager may be released.
            await this.#publication.waitForPending();
            if (
              this.#publication.publishedRevision === previousRevision &&
              this.#publication.lastError instanceof RuntimeHostOperationError
            ) {
              this.#unsubscribeManager();
              this.#manager = previous;
              this.#config = previousConfig;
              this.#unsubscribeManager = this.#observeManager(previous);
              this.#retainedManagers.delete(previous);
              this.#publicationRevision = previousRevision;
              this.#requireIdlePublication = false;
              this.#publication.request();
              await this.#publication.settle().catch(() => undefined);
              await staged.close().catch(() => undefined);
            } else {
              // A committed or unknown outcome may already be serving a Turn.
              // Keep that provider and its manager; the previous manager stays
              // available until a definitive publication or Session close.
              this.#retireRetainedManagers();
            }
          } else if (!swapped) {
            this.#pendingManager = undefined;
            await staged.close().catch(() => undefined);
          }
          if (error instanceof RequestError) throw error;
          throw mcpUnavailable(this.#sessionId, 'mcp.prepare', 'mcp_reconfiguration_failed');
        }
      });
    this.#configurationTail = task;
    return task;
  }

  async ready(signal?: AbortSignal): Promise<void> {
    await abortable(() => this.#configurationTail.catch(() => undefined), signal);
    await this.#settlePublication(signal);
  }

  async #settlePublication(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.#assertOpen('mcp.ready');
    const state = await abortable(() => this.#publication.settle(), signal);
    signal?.throwIfAborted();
    this.#assertOpen('mcp.ready');
    if (state !== 'published' && state !== 'not_published') {
      if (
        this.#publication.lastError instanceof RuntimeHostOperationError &&
        this.#publication.lastError.code === 'session_binding_conflict'
      ) {
        throw RequestError.internalError(
          {
            source: 'runtime_host',
            operation: 'mcp.prepare',
            sessionId: this.#sessionId,
            code: 'session_binding_conflict',
          },
          'Session MCP configuration conflicts with an active or frozen provider; restore with the same configuration or close the active attachment',
        );
      }
      if (
        this.#requireIdlePublication &&
        this.#publication.lastError instanceof RuntimeHostOperationError &&
        this.#publication.lastError.code === 'session_busy'
      ) {
        throw RequestError.internalError(
          {
            source: 'runtime_host',
            operation: 'mcp.prepare',
            sessionId: this.#sessionId,
            code: 'session_busy',
          },
          'Cannot replace Session MCP configuration during an active Turn',
        );
      }
      throw mcpUnavailable(this.#sessionId, 'mcp.ready', 'mcp_publication_failed');
    }
  }

  close(): Promise<void> {
    return this.#close(true);
  }

  #retire(): Promise<void> {
    this.#authoritativelyRetired = true;
    return this.#close(false);
  }

  #close(unregister: boolean): Promise<void> {
    if (this.#closeTask) return this.#closeTask;
    this.#closed = true;
    this.#unsubscribeManager();
    this.#unsubscribeConnection();
    const managerClose = Promise.allSettled([
      this.#manager.close(),
      this.#pendingManager?.close(),
      ...[...this.#retainedManagers].map((manager) => manager.close()),
      ...this.#retirementTasks,
    ]);
    this.#closeTask = (async () => {
      try {
        try {
          await (unregister ? this.#publication.close() : this.#publication.retire());
        } catch (error) {
          // Session retirement is authoritative. If it wins the race with a local
          // unregister, the obsolete unregister may reject even though withdrawal
          // has already completed on the Host.
          if (!this.#authoritativelyRetired) throw error;
        }
      } finally {
        await managerClose;
      }
    })();
    return this.#closeTask;
  }

  #observeManager(manager: McpClientManager): () => void {
    return manager.onChange(() => {
      this.#publicationRevision += 1;
      if (this.#prepared && !this.#closed) this.#publication.request();
    });
  }

  #retireRetainedManagers(): void {
    if (this.#publication.publishedRevision !== this.#publicationRevision) return;
    for (const manager of this.#retainedManagers) {
      this.#retainedManagers.delete(manager);
      if (manager === this.#manager) continue;
      const task = manager.close().catch((error: unknown) => {
        console.error('[acp] Previous Session MCP cleanup failed:', error);
      });
      this.#retirementTasks.add(task);
      void task.finally(() => this.#retirementTasks.delete(task));
    }
  }

  #assertConnected(config = this.#config, manager = this.#manager): void {
    this.#assertOpen('mcp.prepare');
    if (
      Object.keys(config.mcpServers).some(
        (serverId) => manager.status(serverId)?.state !== 'connected',
      )
    ) {
      throw mcpUnavailable(this.#sessionId, 'mcp.prepare', 'mcp_not_ready');
    }
  }

  #assertOpen(operation: 'mcp.prepare' | 'mcp.ready'): void {
    if (this.#closed) throw mcpUnavailable(this.#sessionId, operation, 'mcp_not_ready');
  }
}

function sameMcpConfig(left: McpConfigFile, right: McpConfigFile): boolean {
  return stableJsonStringify(left) === stableJsonStringify(right);
}

function invalidMcpInput(reason: string): RequestError {
  return RequestError.invalidParams(
    { field: 'mcpServers', reason },
    'Invalid ACP stdio MCP configuration',
  );
}

function mcpUnavailable(
  sessionId: string,
  operation: 'mcp.prepare' | 'mcp.ready',
  code: string,
): RequestError {
  return RequestError.internalError(
    { source: 'adapter', operation, sessionId, code },
    'Session MCP tools are unavailable',
  );
}
