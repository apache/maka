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
import { stableJsonStringify } from '@maka/core/canonical-json';
import { createCredentialMcpOAuthStorage, McpClientManager } from '@maka/mcp';
import { createFileCredentialStore } from '@maka/storage/credential-store';
import { createMcpConfigStore } from '@maka/storage/mcp-config-store';
import {
  RuntimeHostOperationError,
  type RuntimeHostConnectionAvailability,
  type RuntimeHostReconnectingConnection,
} from '@maka/runtime-host/client';
import { createMcpCapabilityProvider } from './mcp-capability-provider.js';
import { McpCapabilityPublication } from './mcp-capability-publication.js';

/** One headless invocation owns one Session's MCP processes and publication. */
export class RuntimeHostRunMcp {
  readonly #connection: RuntimeHostReconnectingConnection;
  readonly #workspaceRoot: string;
  readonly #manager: McpClientManager;
  readonly #publication: McpCapabilityPublication;
  readonly #unsubscribeManager: () => void;
  readonly #unsubscribeConnection: () => void;
  #availability: RuntimeHostConnectionAvailability | undefined;
  #sessionId: string | undefined;
  #sessionConfigurationId: string | undefined;
  #enabledServerIds: readonly string[] = [];
  #prepareTask: Promise<void> | undefined;
  #closed = false;
  #closeTask: Promise<void> | undefined;

  constructor(workspaceRoot: string, connection: RuntimeHostReconnectingConnection) {
    this.#workspaceRoot = workspaceRoot;
    this.#connection = connection;
    this.#manager = new McpClientManager({
      clientName: 'maka-run',
      excludedStdioEnvironmentKeys: ['MAKA_RUNTIME_HOST_ACCESS_CREDENTIAL'],
      oauthStorage: createCredentialMcpOAuthStorage(createFileCredentialStore(workspaceRoot)),
    });
    this.#publication = new McpCapabilityPublication({
      connectionIdentity: () =>
        this.#availability?.kind === 'connected'
          ? `${this.#availability.hostEpoch}\0${this.#availability.connectionId}`
          : undefined,
      revision: () => this.#manager.toolSnapshot().revision,
      createProvider: () =>
        createMcpCapabilityProvider(this.#manager, {
          admission: 'mcp',
          onCurrentRegistrationRetired: () => this.#retire(),
        }) ?? {
          // Even an empty snapshot must replace a lost Session publication.
          offers: () => [],
          currentRegistrationRetired: () => this.#retire(),
        },
      replace: (provider) =>
        this.#connection.replaceClientCapabilities(provider, {
          sessionId: this.#sessionId!,
          sessionConfigurationId: this.#sessionConfigurationId!,
        }),
      unregister: () =>
        this.#connection.unregisterClientCapabilities({ sessionId: this.#sessionId! }),
      onState: () => undefined,
    });
    this.#unsubscribeManager = this.#manager.onChange(() => {
      if (this.#sessionId && !this.#closed) this.#publication.request();
    });
    this.#unsubscribeConnection = connection.subscribeConnectionAvailability((availability) => {
      this.#availability = availability;
      if (availability.kind !== 'connected') this.#publication.invalidate();
      if (this.#sessionId && !this.#closed) this.#publication.request();
    });
  }

  prepare(sessionId: string): Promise<void> {
    if (this.#sessionId && this.#sessionId !== sessionId) {
      return Promise.reject(new Error('MCP is already bound to another Session'));
    }
    this.#prepareTask ??= this.#prepare(sessionId);
    return this.#prepareTask;
  }

  async #prepare(sessionId: string): Promise<void> {
    if (this.#closed) throw new Error('MCP publication is closed');
    try {
      const config = await createMcpConfigStore(this.#workspaceRoot).get();
      this.#enabledServerIds = Object.entries(config.mcpServers)
        .filter(([, server]) => server.enabled !== false)
        .map(([serverId]) => serverId);
      try {
        await this.#manager.sync(config);
      } catch (error) {
        throw new Error('Session MCP preparation failed; check the workspace MCP configuration', {
          cause: error,
        });
      }
      this.#assertServersConnected();
      if (this.#closed) throw new Error('MCP publication is closed');
      this.#sessionConfigurationId = `sha256:${createHash('sha256').update(stableJsonStringify(config)).digest('hex')}`;
      this.#sessionId = sessionId;
      await this.ready();
    } catch (error) {
      await this.close().catch(() => undefined);
      throw error;
    }
  }

  async ready(): Promise<void> {
    if (this.#closed || !this.#sessionId) throw new Error('MCP publication is not prepared');
    this.#assertServersConnected();
    const state = await this.#publication.settle();
    if (state !== 'published') {
      if (
        this.#publication.lastError instanceof RuntimeHostOperationError &&
        this.#publication.lastError.code === 'session_binding_conflict'
      ) {
        throw new Error(
          'Session MCP configuration conflicts with its frozen tools; restore the same configuration before resuming',
          { cause: this.#publication.lastError },
        );
      }
      throw new Error('Session MCP capability publication is unavailable', {
        cause: this.#publication.lastError,
      });
    }
    this.#assertServersConnected();
  }

  #assertServersConnected(): void {
    const unavailable = this.#enabledServerIds.flatMap((serverId) => {
      const state = this.#manager.status(serverId)?.state ?? 'missing';
      return state === 'connected' ? [] : [`${serverId} (${state})`];
    });
    if (unavailable.length > 0) {
      throw new Error(`Session MCP server(s) unavailable: ${unavailable.join(', ')}`);
    }
  }

  close(): Promise<void> {
    this.#closeTask ??= this.#close(true);
    return this.#closeTask;
  }

  #retire(): Promise<void> {
    this.#closeTask ??= this.#close(false);
    return this.#closeTask;
  }

  async #close(unregister: boolean): Promise<void> {
    this.#closed = true;
    this.#unsubscribeManager();
    this.#unsubscribeConnection();
    try {
      await (unregister ? this.#publication.close() : this.#publication.retire());
    } finally {
      await this.#manager.close();
    }
  }
}
