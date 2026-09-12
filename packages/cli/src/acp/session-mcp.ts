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

import { isAbsolute } from 'node:path';
import { RequestError, type NewSessionRequest } from '@agentclientprotocol/sdk';
import { MCP_CONFIG_VERSION, type McpConfigFile } from '@maka/core/mcp';
import { McpClientManager } from '@maka/mcp';
import { normalizeMcpConfig } from '@maka/storage/mcp-config-store';
import type {
  RuntimeHostConnectionAvailability,
  RuntimeHostReconnectingConnection,
} from '@maka/runtime-host/client';
import { abortable } from '@maka/runtime-host/client';
import { createMcpCapabilityProvider } from '../mcp-capability-provider.js';
import { McpCapabilityPublication } from '../mcp-capability-publication.js';

export type AcpMcpConnection = Pick<
  RuntimeHostReconnectingConnection,
  'replaceClientCapabilities' | 'unregisterClientCapabilities' | 'subscribeConnectionAvailability'
>;

/** Validates before any process or Host work; never writes a user MCP configuration. */
export function createAcpMcpConfig(params: NewSessionRequest): McpConfigFile {
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
      server.args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))
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
  readonly #config: McpConfigFile;
  readonly #manager = new McpClientManager({
    clientName: 'maka-acp',
    excludedStdioEnvironmentKeys: ['MAKA_RUNTIME_HOST_ACCESS_CREDENTIAL'],
  });
  readonly #publication: McpCapabilityPublication;
  readonly #unsubscribeManager: () => void;
  readonly #unsubscribeConnection: () => void;
  #availability: RuntimeHostConnectionAvailability | undefined;
  #prepared = false;
  #closed = false;
  #closeTask: Promise<void> | undefined;

  constructor(sessionId: string, config: McpConfigFile, connection: AcpMcpConnection) {
    this.#sessionId = sessionId;
    this.#config = config;
    this.#publication = new McpCapabilityPublication({
      connectionIdentity: () =>
        this.#availability?.kind === 'connected'
          ? this.#availability.hostEpoch + '\0' + this.#availability.connectionId
          : undefined,
      revision: () => this.#manager.toolSnapshot().revision,
      createProvider: () => createMcpCapabilityProvider(this.#manager, { admission: 'mcp' }),
      replace: (provider) => connection.replaceClientCapabilities(provider, { sessionId }),
      unregister: () => connection.unregisterClientCapabilities({ sessionId }),
      onState: () => undefined,
    });
    this.#unsubscribeManager = this.#manager.onChange(() => {
      if (this.#prepared && !this.#closed) this.#publication.request();
    });
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
    } catch (error) {
      await this.close().catch(() => undefined);
      if (error instanceof RequestError) throw error;
      throw mcpUnavailable(this.#sessionId, 'mcp_preparation_failed');
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  }

  async ready(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.#assertConnected();
    const state = await abortable(() => this.#publication.settle(), signal);
    signal?.throwIfAborted();
    this.#assertConnected();
    if (state !== 'published' && state !== 'not_published') {
      throw mcpUnavailable(this.#sessionId, 'mcp_publication_failed');
    }
  }

  close(): Promise<void> {
    if (this.#closeTask) return this.#closeTask;
    this.#closed = true;
    this.#unsubscribeManager();
    this.#unsubscribeConnection();
    const managerClose = this.#manager.close();
    this.#closeTask = (async () => {
      try {
        await this.#publication.close();
      } finally {
        await managerClose;
      }
    })();
    return this.#closeTask;
  }

  #assertConnected(): void {
    if (
      this.#closed ||
      Object.keys(this.#config.mcpServers).some(
        (serverId) => this.#manager.status(serverId)?.state !== 'connected',
      )
    ) {
      throw mcpUnavailable(this.#sessionId, 'mcp_not_ready');
    }
  }
}

function invalidMcpInput(reason: string): RequestError {
  return RequestError.invalidParams(
    { field: 'mcpServers', reason },
    'Invalid ACP stdio MCP configuration',
  );
}

function mcpUnavailable(sessionId: string, code: string): RequestError {
  return RequestError.internalError(
    { source: 'adapter', operation: 'mcp.prepare', sessionId, code },
    'Session MCP tools are unavailable',
  );
}
