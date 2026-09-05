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

import { createHash, randomUUID } from 'node:crypto';
import {
  MCP_CONFIG_VERSION,
  mcpConfigChangeRetiresCredentials,
  resolveMcpProtocolPreference,
  type McpConfigFile,
  type McpConfigSourceFailureReason,
  type McpProtocolPreference,
  type McpServerConfig,
  type McpServerStatus,
  type McpTestResult,
} from '@maka/core/mcp';
import { createCredentialMcpOAuthStorage, McpClientManager } from '@maka/mcp';
import { createFileCredentialStore } from '@maka/storage/credential-store';
import {
  createMcpConfigStore,
  assertMcpEndpointPolicyOnChanges,
  McpConfigSourceError,
  normalizeMcpConfig,
  normalizeMcpImport,
  type McpConfigStore,
} from '@maka/storage/mcp-config-store';
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
  | 'credential_required'
  | 'credential_rejected'
  | 'provider_conflict'
  | 'target_mismatch'
  | 'publishing'
  | 'published'
  | 'not_published'
  | 'error';

export interface TuiMcpServerSnapshot {
  readonly serverId: string;
  readonly configured: boolean;
  readonly synchronized: boolean;
  readonly enabled?: boolean;
  readonly configuredTransport?: 'stdio' | 'remote';
  readonly configuredProtocol?: McpProtocolPreference;
  readonly state?: McpServerStatus['state'];
  readonly transport?: McpServerStatus['transport'];
  readonly negotiatedProtocol?: McpServerStatus['negotiatedProtocol'];
  readonly toolCount: number;
  readonly error?: string;
}

export interface TuiMcpSnapshot {
  readonly initialization: 'loading' | 'ready' | 'error';
  readonly configuration: 'ready' | 'synchronizing' | 'out_of_sync';
  readonly publication: TuiMcpPublicationState;
  readonly canManagePublicationCredential?: boolean;
  readonly toolCount: number;
  readonly servers: readonly TuiMcpServerSnapshot[];
}

export interface TuiMcpSurface {
  snapshot(): TuiMcpSnapshot;
  subscribe(listener: () => void): () => void;
}

export interface TuiMcpEditConfig {
  readonly config: McpServerConfig;
  readonly revision: string;
}

export interface TuiMcpImportEntry {
  readonly serverId: string;
  readonly change: 'add' | 'replace';
  readonly transport: 'stdio' | 'remote';
  readonly protocol: McpProtocolPreference;
}

export interface TuiMcpImportPreview {
  readonly previewId: string;
  readonly entries: readonly TuiMcpImportEntry[];
}

export type TuiMcpImportPreviewResult =
  | { readonly status: 'ready'; readonly preview: TuiMcpImportPreview }
  | {
      readonly status: 'invalid';
      readonly reason: McpConfigSourceFailureReason | 'invalid-config' | 'not-ready';
    };

export type TuiMcpAction =
  | { readonly kind: 'add'; readonly serverId: string; readonly config: McpServerConfig }
  | {
      readonly kind: 'edit';
      readonly serverId: string;
      readonly config: McpServerConfig;
      readonly expectedRevision: string;
    }
  | { readonly kind: 'commit_import'; readonly previewId: string }
  | { readonly kind: 'set_enabled'; readonly serverId: string; readonly enabled: boolean }
  | { readonly kind: 'remove'; readonly serverId: string }
  | { readonly kind: 'test'; readonly serverId: string }
  | { readonly kind: 'reconnect'; readonly serverId: string }
  | { readonly kind: 'set_publication_credential'; readonly credential: string }
  | { readonly kind: 'remove_publication_credential' };

export type TuiMcpActionEffect =
  | 'published'
  | 'pending_host'
  | 'sync_failed'
  | 'publication_failed';

export type TuiMcpActionResult =
  | { readonly status: 'applied'; readonly effect: TuiMcpActionEffect }
  | { readonly status: 'tested'; readonly test: McpTestResult; readonly effect: TuiMcpActionEffect }
  | {
      readonly status: 'conflict';
      readonly reason: 'exists' | 'stale_config' | 'stale_edit' | 'stale_import' | 'missing';
    }
  | {
      readonly status: 'failed';
      readonly reason:
        | 'closed'
        | 'invalid-config'
        | 'credential-cleanup-failed'
        | 'publication-credential-failed'
        | 'persist-failed'
        | 'manager-failed';
    };

export interface TuiMcpManagement extends TuiMcpSurface {
  configForEdit(serverId: string): TuiMcpEditConfig | undefined;
  previewImport(source: string): TuiMcpImportPreviewResult;
  discardImportPreview(previewId: string): void;
  execute(action: TuiMcpAction): Promise<TuiMcpActionResult>;
}

export interface TuiMcpController extends TuiMcpManagement {
  close(): Promise<void>;
}

type TuiMcpManager = Pick<
  McpClientManager,
  | 'sync'
  | 'statuses'
  | 'toolSnapshot'
  | 'callTool'
  | 'onChange'
  | 'test'
  | 'reconnect'
  | 'forgetServerCredentials'
  | 'close'
>;

export type TuiMcpPublicationUnavailableReason =
  | 'host_unavailable'
  | 'credential_required'
  | 'credential_rejected'
  | 'provider_conflict'
  | 'target_mismatch';

export type TuiMcpPublicationAvailability =
  | {
      readonly kind: 'unavailable';
      readonly reason?: TuiMcpPublicationUnavailableReason;
    }
  | Extract<RuntimeHostConnectionAvailability, { kind: 'connected' }>;

export interface TuiMcpPublicationTarget
  extends Pick<
    RuntimeHostReconnectingConnection,
    'replaceClientCapabilities' | 'unregisterClientCapabilities'
  > {
  subscribeConnectionAvailability(
    listener: (availability: TuiMcpPublicationAvailability) => void,
  ): () => void;
  setCredential?(credential: string): Promise<void>;
  removeCredential?(): Promise<void>;
  closePublication?(): Promise<void>;
}

interface TuiMcpControllerDeps {
  readonly configStore: Pick<McpConfigStore, 'get' | 'transform'>;
  readonly manager: TuiMcpManager;
  readonly createProvider: (manager: TuiMcpManager) => ClientCapabilityProvider | undefined;
}

export function createTuiMcpController(
  input: {
    readonly workspaceRoot: string;
    readonly connection: TuiMcpPublicationTarget;
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
  readonly #connection: TuiMcpPublicationTarget;
  readonly #deps: TuiMcpControllerDeps;
  readonly #listeners = new Set<() => void>();
  readonly #disposeManagerChange: () => void;
  readonly #disposeConnectionAvailability: () => void;
  readonly #initialization: Promise<void>;
  #availability: TuiMcpPublicationAvailability = { kind: 'unavailable' };
  #closed = false;
  #config: McpConfigFile | undefined;
  #preparedImport:
    | {
        readonly previewId: string;
        readonly imported: McpConfigFile;
        readonly basis: ReadonlyMap<string, string>;
      }
    | undefined;
  #actionLane: Promise<void> = Promise.resolve();
  #publicationSuppressed = false;
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
    configuration: 'synchronizing',
    publication: 'waiting',
    canManagePublicationCredential: false,
    toolCount: 0,
    servers: [],
  });

  constructor(connection: TuiMcpPublicationTarget, deps: TuiMcpControllerDeps) {
    this.#connection = connection;
    this.#deps = deps;
    this.#snapshot = freezeSnapshot({
      ...this.#snapshot,
      canManagePublicationCredential: Boolean(
        connection.setCredential && connection.removeCredential,
      ),
    });
    this.#disposeManagerChange = deps.manager.onChange(() => {
      try {
        this.#refreshManagerSnapshot();
        if (this.#snapshot.initialization === 'ready' && !this.#publicationSuppressed) {
          this.#requestPublication();
        }
      } catch {
        // An observation must never break the MCP manager's state transition.
      }
    });
    this.#disposeConnectionAvailability = connection.subscribeConnectionAvailability(
      (availability) => {
        this.#availability = availability;
        if (availability.kind === 'unavailable') {
          this.#published = undefined;
          this.#updateSnapshot({
            publication: availability.reason ?? 'host_unavailable',
            ...(availability.reason === 'provider_conflict'
              ? { canManagePublicationCredential: false }
              : {}),
          });
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

  configForEdit(serverId: string): TuiMcpEditConfig | undefined {
    const config = this.#config?.mcpServers[serverId];
    if (!config) return undefined;
    return { config: structuredClone(config), revision: configRevision(config) };
  }

  previewImport(source: string): TuiMcpImportPreviewResult {
    const current = this.#config;
    if (this.#closed || !current || this.#snapshot.initialization !== 'ready') {
      return { status: 'invalid', reason: 'not-ready' };
    }
    let imported: McpConfigFile;
    try {
      imported = normalizeMcpImport(source);
    } catch (error) {
      this.#preparedImport = undefined;
      return {
        status: 'invalid',
        reason: error instanceof McpConfigSourceError ? error.reason : 'invalid-config',
      };
    }
    const previewId = randomUUID();
    const basis = new Map<string, string>();
    const entries = Object.entries(imported.mcpServers).map(([serverId, config]) => {
      const previous = current.mcpServers[serverId];
      basis.set(serverId, configRevision(previous));
      return Object.freeze({
        serverId,
        change: previous ? ('replace' as const) : ('add' as const),
        transport: 'command' in config ? ('stdio' as const) : ('remote' as const),
        protocol: resolveMcpProtocolPreference(config),
      });
    });
    this.#preparedImport = { previewId, imported, basis };
    return {
      status: 'ready',
      preview: Object.freeze({ previewId, entries: Object.freeze(entries) }),
    };
  }

  discardImportPreview(previewId: string): void {
    if (this.#preparedImport?.previewId === previewId) this.#preparedImport = undefined;
  }

  execute(action: TuiMcpAction): Promise<TuiMcpActionResult> {
    if (this.#closed) return Promise.resolve({ status: 'failed', reason: 'closed' });
    return this.#serializeAction(() => this.#executeAction(action));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#disposeManagerChange();
    this.#disposeConnectionAvailability();
    this.#listeners.clear();
    this.#preparedImport = undefined;
    this.#publicationRequested = false;
    const managerClosing = this.#deps.manager.close();
    await this.#actionLane.catch(() => undefined);
    this.#config = undefined;
    await this.#publicationTask?.catch(() => undefined);
    if (this.#availability.kind === 'connected') {
      await this.#connection.unregisterClientCapabilities().catch(() => undefined);
    }
    this.#published = undefined;
    await this.#connection.closePublication?.().catch(() => undefined);
    await managerClosing;
    await this.#initialization.catch(() => undefined);
  }

  async #initialize(): Promise<void> {
    try {
      const config = await this.#deps.configStore.get();
      if (this.#closed) return;
      await this.#deps.manager.sync(config);
      if (this.#closed) return;
      this.#config = cloneConfig(config);
      this.#refreshManagerSnapshot('ready', 'ready');
      this.#requestPublication();
    } catch {
      if (this.#closed) return;
      this.#updateSnapshot({ initialization: 'error', publication: 'not_published' });
    }
  }

  #serializeAction(work: () => Promise<TuiMcpActionResult>): Promise<TuiMcpActionResult> {
    const run = this.#actionLane.then(work, work);
    this.#actionLane = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #executeAction(action: TuiMcpAction): Promise<TuiMcpActionResult> {
    if (this.#closed) return { status: 'failed', reason: 'closed' };
    if (action.kind === 'set_publication_credential') {
      if (!this.#connection.setCredential) {
        return { status: 'failed', reason: 'publication-credential-failed' };
      }
      try {
        await this.#connection.setCredential(action.credential);
        return { status: 'applied', effect: await this.#settlePublication() };
      } catch {
        return { status: 'failed', reason: 'publication-credential-failed' };
      }
    }
    if (action.kind === 'remove_publication_credential') {
      if (!this.#connection.removeCredential) {
        return { status: 'failed', reason: 'publication-credential-failed' };
      }
      try {
        await this.#connection.removeCredential();
        return { status: 'applied', effect: 'pending_host' };
      } catch {
        return { status: 'failed', reason: 'publication-credential-failed' };
      }
    }
    if (action.kind === 'test') {
      try {
        const test = await this.#deps.manager.test(action.serverId);
        return { status: 'tested', test, effect: await this.#settlePublication() };
      } catch {
        return { status: 'failed', reason: 'manager-failed' };
      }
    }
    if (action.kind === 'reconnect') {
      try {
        await this.#deps.manager.reconnect(action.serverId);
        return { status: 'applied', effect: await this.#settlePublication() };
      } catch {
        this.#refreshManagerSnapshot();
        return { status: 'failed', reason: 'manager-failed' };
      }
    }
    const result = await this.#commitMutation(action);
    if (action.kind === 'commit_import') this.discardImportPreview(action.previewId);
    return result;
  }

  async #commitMutation(
    action: Exclude<
      TuiMcpAction,
      | { kind: 'test' | 'reconnect' }
      | { kind: 'set_publication_credential' | 'remove_publication_credential' }
    >,
  ): Promise<TuiMcpActionResult> {
    let committed: McpConfigFile;
    try {
      committed = await this.#deps.configStore.transform(async (current) => {
        if (this.#closed) {
          throw new TuiMcpMutationError({ status: 'failed', reason: 'closed' });
        }
        const prepared = this.#prepareMutation(current, action);
        if ('status' in prepared) throw new TuiMcpMutationError(prepared);
        const { next } = prepared;
        try {
          assertMcpEndpointPolicyOnChanges(current, next);
        } catch {
          throw new TuiMcpMutationError({ status: 'failed', reason: 'invalid-config' });
        }
        try {
          for (const [serverId, previous] of Object.entries(current.mcpServers)) {
            if (!mcpConfigChangeRetiresCredentials(previous, next.mcpServers[serverId])) continue;
            await this.#deps.manager.forgetServerCredentials(serverId, previous);
            if (this.#closed) {
              throw new TuiMcpMutationError({ status: 'failed', reason: 'closed' });
            }
          }
        } catch (error) {
          if (error instanceof TuiMcpMutationError) throw error;
          throw new TuiMcpMutationError({
            status: 'failed',
            reason: 'credential-cleanup-failed',
          });
        }
        return next;
      });
    } catch (error) {
      if (error instanceof TuiMcpMutationError) return error.result;
      return { status: 'failed', reason: 'persist-failed' };
    }
    if (this.#closed) return { status: 'failed', reason: 'closed' };
    this.#preparedImport = undefined;
    this.#config = cloneConfig(committed);
    this.#updateSnapshot({ configuration: 'synchronizing' });
    this.#refreshManagerSnapshot();
    this.#publicationSuppressed = true;
    try {
      await this.#deps.manager.sync(committed);
    } catch {
      this.#publicationSuppressed = false;
      this.#updateSnapshot({ configuration: 'out_of_sync' });
      this.#refreshManagerSnapshot();
      await this.#settlePublication();
      return { status: 'applied', effect: 'sync_failed' };
    }
    this.#publicationSuppressed = false;
    if (this.#closed) return { status: 'failed', reason: 'closed' };
    this.#updateSnapshot({ configuration: 'ready' });
    this.#refreshManagerSnapshot();
    return { status: 'applied', effect: await this.#settlePublication() };
  }

  #prepareMutation(
    current: McpConfigFile,
    action: Exclude<
      TuiMcpAction,
      | { kind: 'test' | 'reconnect' }
      | { kind: 'set_publication_credential' | 'remove_publication_credential' }
    >,
  ):
    | { readonly next: McpConfigFile }
    | Extract<TuiMcpActionResult, { status: 'conflict' | 'failed' }> {
    const servers = { ...current.mcpServers };
    if (action.kind === 'add') {
      if (Object.hasOwn(servers, action.serverId)) return { status: 'conflict', reason: 'exists' };
      servers[action.serverId] = action.config;
    } else if (action.kind === 'edit') {
      const previous = servers[action.serverId];
      if (!previous) return { status: 'conflict', reason: 'missing' };
      if (configRevision(previous) !== action.expectedRevision) {
        return { status: 'conflict', reason: 'stale_edit' };
      }
      servers[action.serverId] = action.config;
    } else if (action.kind === 'set_enabled') {
      const previous = servers[action.serverId];
      if (!previous) return { status: 'conflict', reason: 'missing' };
      servers[action.serverId] = { ...previous, enabled: action.enabled };
    } else if (action.kind === 'remove') {
      if (!Object.hasOwn(servers, action.serverId)) {
        return { status: 'conflict', reason: 'missing' };
      }
      delete servers[action.serverId];
    } else {
      const prepared = this.#preparedImport;
      if (!prepared || prepared.previewId !== action.previewId) {
        return { status: 'conflict', reason: 'stale_import' };
      }
      for (const [serverId, revision] of prepared.basis) {
        if (configRevision(servers[serverId]) !== revision) {
          return { status: 'conflict', reason: 'stale_import' };
        }
      }
      Object.assign(servers, prepared.imported.mcpServers);
    }
    try {
      return {
        next: normalizeMcpConfig({ version: MCP_CONFIG_VERSION, mcpServers: servers }),
      };
    } catch {
      return { status: 'failed', reason: 'invalid-config' };
    }
  }

  async #settlePublication(): Promise<TuiMcpActionEffect> {
    this.#requestPublication();
    while (!this.#closed && (this.#publicationTask || this.#publicationRequested)) {
      await this.#publicationTask?.catch(() => undefined);
    }
    if (
      this.#snapshot.publication === 'error' ||
      this.#snapshot.publication === 'credential_rejected' ||
      this.#snapshot.publication === 'provider_conflict' ||
      this.#snapshot.publication === 'target_mismatch'
    ) {
      return 'publication_failed';
    }
    if (
      this.#snapshot.publication === 'host_unavailable' ||
      this.#snapshot.publication === 'credential_required'
    ) {
      return 'pending_host';
    }
    return 'published';
  }

  #refreshManagerSnapshot(
    initialization = this.#snapshot.initialization,
    configuration = this.#snapshot.configuration,
  ): void {
    const statuses = this.#deps.manager.statuses();
    const statusById = new Map(statuses.map((status) => [status.serverId, status]));
    const serverIds = new Set([
      ...Object.keys(this.#config?.mcpServers ?? {}),
      ...statuses.map((status) => status.serverId),
    ]);
    this.#snapshot = freezeSnapshot({
      initialization,
      configuration,
      publication: this.#snapshot.publication,
      canManagePublicationCredential: this.#snapshot.canManagePublicationCredential,
      toolCount: this.#deps.manager.toolSnapshot().tools.length,
      servers: [...serverIds]
        .sort((left, right) => left.localeCompare(right))
        .map((serverId) =>
          projectServerStatus(
            serverId,
            this.#config?.mcpServers[serverId],
            statusById.get(serverId),
            configuration === 'ready',
          ),
        ),
    });
    this.#notify();
  }

  #requestPublication(): void {
    if (this.#closed) {
      this.#publicationRequested = false;
      return;
    }
    if (this.#snapshot.initialization !== 'ready' || this.#publicationSuppressed) return;
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
      this.#updateSnapshot({ publication: availability.reason ?? 'host_unavailable' });
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

  #updateSnapshot(
    update: Partial<Pick<TuiMcpSnapshot, 'initialization' | 'configuration' | 'publication'>>,
  ): void {
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

function projectServerStatus(
  serverId: string,
  config: McpServerConfig | undefined,
  status: McpServerStatus | undefined,
  configurationSynchronized: boolean,
): TuiMcpServerSnapshot {
  return {
    serverId,
    configured: config !== undefined,
    synchronized: configurationSynchronized && config !== undefined && status !== undefined,
    ...(config
      ? {
          enabled: config.enabled !== false,
          configuredTransport: 'command' in config ? ('stdio' as const) : ('remote' as const),
          configuredProtocol: resolveMcpProtocolPreference(config),
        }
      : {}),
    ...(status ? { state: status.state } : {}),
    ...(status?.transport ? { transport: status.transport } : {}),
    ...(status?.negotiatedProtocol ? { negotiatedProtocol: status.negotiatedProtocol } : {}),
    toolCount: status?.toolCount ?? 0,
    ...(status?.error ? { error: status.error } : {}),
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

function cloneConfig(config: McpConfigFile): McpConfigFile {
  return structuredClone(config);
}

function configRevision(config: McpConfigFile | McpServerConfig | undefined): string {
  if (!config) return 'missing';
  return createHash('sha256').update(JSON.stringify(config)).digest('hex');
}

class TuiMcpMutationError extends Error {
  constructor(readonly result: Extract<TuiMcpActionResult, { status: 'conflict' | 'failed' }>) {
    super(result.reason);
  }
}
