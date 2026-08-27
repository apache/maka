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

import type { McpServerStatus } from '@maka/core/mcp';
import { createCredentialMcpOAuthStorage, McpClientManager } from '@maka/mcp';
import { createFileCredentialStore } from '@maka/storage/credential-store';
import { createMcpConfigStore, type McpConfigStore } from '@maka/storage/mcp-config-store';
import type {
  ClientCapabilityProvider,
  RuntimeHostConnectionAvailability,
  RuntimeHostReconnectingConnection,
} from '@maka/runtime-host/client';
import { createMcpCapabilityProvider } from './mcp-capability-provider.js';

const RUNTIME_HOST_CREDENTIAL_ENV = 'MAKA_RUNTIME_HOST_ACCESS_CREDENTIAL';

export type TuiMcpPublicationState =
  | 'waiting'
  | 'host_unavailable'
  | 'publishing'
  | 'published'
  | 'not_published'
  | 'error';

export interface TuiMcpServerSnapshot {
  readonly serverId: string;
  readonly state: McpServerStatus['state'];
  readonly transport?: McpServerStatus['transport'];
  readonly negotiatedProtocol?: McpServerStatus['negotiatedProtocol'];
  readonly toolCount: number;
  readonly error?: string;
}

export interface TuiMcpSnapshot {
  readonly initialization: 'loading' | 'ready' | 'error';
  readonly publication: TuiMcpPublicationState;
  readonly toolCount: number;
  readonly servers: readonly TuiMcpServerSnapshot[];
}

export interface TuiMcpSurface {
  snapshot(): TuiMcpSnapshot;
  subscribe(listener: () => void): () => void;
}

export interface TuiMcpController extends TuiMcpSurface {
  close(): Promise<void>;
}

type TuiMcpManager = Pick<
  McpClientManager,
  'sync' | 'statuses' | 'toolSnapshot' | 'callTool' | 'onChange' | 'close'
>;

type TuiMcpConnection = Pick<
  RuntimeHostReconnectingConnection,
  'replaceClientCapabilities' | 'unregisterClientCapabilities' | 'subscribeConnectionAvailability'
>;

interface TuiMcpControllerDeps {
  readonly configStore: Pick<McpConfigStore, 'get'>;
  readonly manager: TuiMcpManager;
  readonly createProvider: (manager: TuiMcpManager) => ClientCapabilityProvider | undefined;
}

export function createTuiMcpController(
  input: {
    readonly workspaceRoot: string;
    readonly connection: TuiMcpConnection;
  },
  overrides: Partial<TuiMcpControllerDeps> = {},
): TuiMcpController {
  const manager =
    overrides.manager ??
    new McpClientManager({
      clientName: 'maka-tui',
      excludedStdioEnvironmentKeys: [RUNTIME_HOST_CREDENTIAL_ENV],
      oauthStorage: createCredentialMcpOAuthStorage(createFileCredentialStore(input.workspaceRoot)),
    });
  return new TuiMcpControllerImpl(input.connection, {
    configStore: overrides.configStore ?? createMcpConfigStore(input.workspaceRoot),
    manager,
    createProvider: overrides.createProvider ?? createMcpCapabilityProvider,
  });
}

class TuiMcpControllerImpl implements TuiMcpController {
  readonly #connection: TuiMcpConnection;
  readonly #deps: TuiMcpControllerDeps;
  readonly #listeners = new Set<() => void>();
  readonly #disposeManagerChange: () => void;
  readonly #disposeConnectionAvailability: () => void;
  readonly #initialization: Promise<void>;
  #availability: RuntimeHostConnectionAvailability = { kind: 'unavailable' };
  #closed = false;
  #publicationRequested = false;
  #publicationTask: Promise<void> | undefined;
  #published:
    | {
        readonly identity: string;
        readonly revision: number;
        readonly registered: boolean;
      }
    | undefined;
  #snapshot: TuiMcpSnapshot = freezeSnapshot({
    initialization: 'loading',
    publication: 'waiting',
    toolCount: 0,
    servers: [],
  });

  constructor(connection: TuiMcpConnection, deps: TuiMcpControllerDeps) {
    this.#connection = connection;
    this.#deps = deps;
    this.#disposeManagerChange = deps.manager.onChange(() => {
      try {
        this.#refreshManagerSnapshot();
        if (this.#snapshot.initialization === 'ready') this.#requestPublication();
      } catch {
        // An observation must never break the MCP manager's state transition.
      }
    });
    this.#disposeConnectionAvailability = connection.subscribeConnectionAvailability(
      (availability) => {
        this.#availability = availability;
        if (availability.kind === 'unavailable') {
          this.#published = undefined;
          this.#updateSnapshot({ publication: 'host_unavailable' });
        } else {
          this.#updateSnapshot({ publication: 'waiting' });
          if (this.#snapshot.initialization === 'ready') this.#requestPublication();
        }
      },
    );
    this.#initialization = this.#initialize();
  }

  snapshot(): TuiMcpSnapshot {
    return this.#snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#disposeManagerChange();
    this.#disposeConnectionAvailability();
    this.#listeners.clear();
    await this.#publicationTask?.catch(() => undefined);
    if (this.#availability.kind === 'connected') {
      await this.#connection.unregisterClientCapabilities().catch(() => undefined);
    }
    this.#published = undefined;
    await this.#deps.manager.close();
    await this.#initialization.catch(() => undefined);
  }

  async #initialize(): Promise<void> {
    try {
      const config = await this.#deps.configStore.get();
      if (this.#closed) return;
      await this.#deps.manager.sync(config);
      if (this.#closed) return;
      this.#refreshManagerSnapshot('ready');
      this.#requestPublication();
    } catch {
      if (this.#closed) return;
      this.#updateSnapshot({ initialization: 'error', publication: 'not_published' });
    }
  }

  #refreshManagerSnapshot(initialization = this.#snapshot.initialization): void {
    const statuses = this.#deps.manager.statuses();
    this.#snapshot = freezeSnapshot({
      initialization,
      publication: this.#snapshot.publication,
      toolCount: this.#deps.manager.toolSnapshot().tools.length,
      servers: statuses.map(projectServerStatus),
    });
    this.#notify();
  }

  #requestPublication(): void {
    if (this.#closed || this.#snapshot.initialization !== 'ready') return;
    this.#publicationRequested = true;
    if (this.#publicationTask) return;
    this.#publicationTask = this.#runPublicationQueue().finally(() => {
      this.#publicationTask = undefined;
      if (this.#publicationRequested) this.#requestPublication();
    });
  }

  async #runPublicationQueue(): Promise<void> {
    while (this.#publicationRequested && !this.#closed) {
      this.#publicationRequested = false;
      await this.#publishCurrentSnapshot();
    }
  }

  async #publishCurrentSnapshot(): Promise<void> {
    const availability = this.#availability;
    if (availability.kind !== 'connected') {
      this.#updateSnapshot({ publication: 'host_unavailable' });
      return;
    }
    const identity = connectionIdentity(availability);
    const revision = this.#deps.manager.toolSnapshot().revision;
    if (this.#published?.identity === identity && this.#published.revision === revision) {
      this.#updateSnapshot({
        publication: this.#snapshot.toolCount === 0 ? 'not_published' : 'published',
      });
      return;
    }
    let provider: ClientCapabilityProvider | undefined;
    this.#updateSnapshot({ publication: 'publishing' });
    try {
      provider = this.#deps.createProvider(this.#deps.manager);
      if (provider) {
        await this.#connection.replaceClientCapabilities(provider);
      } else if (this.#published?.identity === identity && this.#published.registered) {
        await this.#connection.unregisterClientCapabilities();
      }
    } catch {
      await closeProvider(provider);
      if (this.#isCurrent(identity, revision)) {
        this.#updateSnapshot({ publication: 'error' });
      } else {
        this.#requestPublication();
      }
      return;
    }
    if (!this.#isCurrent(identity, revision)) {
      this.#requestPublication();
      return;
    }
    this.#published = { identity, revision, registered: provider !== undefined };
    this.#updateSnapshot({ publication: provider ? 'published' : 'not_published' });
  }

  #isCurrent(identity: string, revision: number): boolean {
    return (
      !this.#closed &&
      this.#availability.kind === 'connected' &&
      connectionIdentity(this.#availability) === identity &&
      this.#deps.manager.toolSnapshot().revision === revision
    );
  }

  #updateSnapshot(update: Partial<Pick<TuiMcpSnapshot, 'initialization' | 'publication'>>): void {
    this.#snapshot = freezeSnapshot({ ...this.#snapshot, ...update });
    this.#notify();
  }

  #notify(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        // Presentation failures do not own MCP or Host lifecycle.
      }
    }
  }
}

function projectServerStatus(status: McpServerStatus): TuiMcpServerSnapshot {
  return {
    serverId: status.serverId,
    state: status.state,
    ...(status.transport ? { transport: status.transport } : {}),
    ...(status.negotiatedProtocol ? { negotiatedProtocol: status.negotiatedProtocol } : {}),
    toolCount: status.toolCount,
    ...(status.error ? { error: status.error } : {}),
  };
}

function freezeSnapshot(snapshot: TuiMcpSnapshot): TuiMcpSnapshot {
  return Object.freeze({
    ...snapshot,
    servers: Object.freeze(snapshot.servers.map((server) => Object.freeze({ ...server }))),
  });
}

function connectionIdentity(
  availability: Extract<RuntimeHostConnectionAvailability, { kind: 'connected' }>,
): string {
  return `${availability.hostEpoch}\0${availability.connectionId}`;
}

async function closeProvider(provider: ClientCapabilityProvider | undefined): Promise<void> {
  try {
    await provider?.close?.();
  } catch {
    // A rejected provider never crossed into Host ownership.
  }
}
