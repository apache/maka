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

import { randomBytes } from 'node:crypto';
import {
  auth,
  Client,
  extractWWWAuthenticateParams,
  LATEST_PROTOCOL_VERSION,
  SdkErrorCode,
  SdkHttpError,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type FetchLike,
  type McpSubscription,
  type Tool,
  type Transport,
  type VersionNegotiationOptions,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { redactSecrets } from '@maka/core/redaction';
import {
  deepScrubMcpSecrets,
  EMPTY_MCP_SECRET_INVENTORY,
  MCP_SECRET_MIN_SUBSTITUTION_LENGTH,
  mcpSecretInventory,
  scrubKnownMcpSecrets,
  type McpSecretInventory,
} from '@maka/core/mcp-secrets';
import {
  isMcpStdioConfig,
  isNonLoopbackCleartextHttp,
  resolveMcpRemoteProtocolPreference,
  type McpBoundTool,
  type McpCallResult,
  type McpConfigFile,
  type McpContentBlock,
  type McpNegotiatedProtocol,
  type McpProtocolPreference,
  type McpRemoteServerConfig,
  type McpServerConfig,
  type McpServerStatus,
  type McpTestResult,
  type McpToolBinding,
  type McpToolDescriptor,
  type McpToolSnapshot,
} from '@maka/core/mcp';
import {
  formatMcpDiagnosticText,
  MCP_DIAGNOSTIC_INPUT_CODE_UNITS,
  MCP_ERROR_DIAGNOSTIC_CODE_POINTS,
} from './diagnostic-text.js';
import {
  formatMcpHeaderExclusionWarning,
  partitionMcpHeaderToolDefinitions,
  validateMcpHeaderArguments,
  type McpHeaderDeclaration,
} from './sep-2243.js';
import { createMcpToolBinding, parseMcpToolBinding } from './tool-binding.js';
import { McpToolCallError, normalizeToolCallError } from './tool-call-error.js';
import { discoverMcpTools, type McpDiscoveredTool } from './tool-discovery.js';
import { McpToolCallPreparer, type McpToolCallPreparationState } from './tool-output-validation.js';
import { McpCredentialCoordinator } from './credential-coordinator.js';
import {
  assertTransportSecurity,
  urlProvenance,
  type UrlProvenance,
} from './transport-security.js';
import {
  McpAuthRequiredError,
  McpOAuthProvider,
  type McpOAuthRecord,
  type McpOAuthStorage,
} from './oauth.js';

export { McpToolCallError } from './tool-call-error.js';
export {
  createCredentialMcpOAuthStorage,
  type McpCredentialSecretStore,
} from './credential-oauth-storage.js';
export {
  createMemoryMcpOAuthStorage,
  McpAuthRequiredError,
  McpOAuthProvider,
  type McpOAuthRecord,
  type McpOAuthStorage,
} from './oauth.js';

export type McpAuthorizationStart =
  | { status: 'authorized' }
  | {
      status: 'redirect';
      authorizationUrl: string;
      /** The round's state parameter — minted here when the caller did not
       * supply one. finishAuthorization verifies the callback against it. */
      state: string;
      /** The authorization server this round resolved — the origin the user
       * is about to grant. Chosen by the (untrusted) MCP server's metadata,
       * which is exactly why the consumer must show it. */
      issuer: string;
      /** The scope this round will request, from the server's challenge or
       * the configured list. */
      scopes: string[];
    };

const DEFAULT_TIMEOUTS = {
  remoteConnectMs: 30_000,
  stdioConnectMs: 60_000,
  listToolsMs: 15_000,
  callToolMs: 600_000,
} as const;
const STDERR_LINES = 10;
const STDERR_LINE_CHARS = 2_000;
const STDERR_OVERSIZED_LINE = '[stderr line omitted: exceeds diagnostic limit]';
const STDERR_CONTINUATION = '[stderr continuation omitted]';
const MAX_SUMMARIZED_ERROR_BLOCKS = 100;
const OVERSIZED_TOOL_ERROR_CONTENT = 'server returned oversized error content';
const MAX_TOOL_REFRESH_PASSES = 3;
const TOOL_REFRESH_BURST_IDLE_MS = 1_000;
// Recency-bounded per-server scrub material: enough to cover every value a
// server could still realistically reflect (current + a few rotations of
// access/refresh/id token, client secret, verifier), small enough that
// deepScrub stays O(bound) per payload for the life of the process.
const MAX_HARVESTED_SECRETS_PER_SERVER = 40;

export interface McpClientManagerOptions {
  clientName?: string;
  clientVersion?: string;
  timeouts?: Partial<McpTimeouts>;
  now?: () => number;
  excludedStdioEnvironmentKeys?: readonly string[];
  /**
   * Enables OAuth for remote servers. Background connects use stored tokens
   * (refreshing silently when possible) and report `needs-auth` instead of
   * `error` when the server demands an interactive round; the interactive
   * flow itself runs through startAuthorization/finishAuthorization.
   */
  oauthStorage?: McpOAuthStorage;
}

export type McpManagerChangeListener = (status: McpServerStatus) => void;

type McpTimeouts = { [K in keyof typeof DEFAULT_TIMEOUTS]: number };

interface ToolSnapshotEntry {
  definition: Tool;
  definitionFingerprint: string;
  descriptor: McpToolDescriptor;
  binding: McpToolBinding;
  connectionGeneration: number;
  headerDeclarations: readonly McpHeaderDeclaration[];
  callPreparation?: McpToolCallPreparationState;
}

interface ToolRefreshState {
  readonly client: Client;
  readonly connectionGeneration: number;
  // Initial discovery runs before the status transitions to 'connected'; it
  // still owns the same single-flight gate so a list-changed notification
  // received while the first tools/list is in flight joins this pass instead
  // of racing or being dropped.
  readonly initial: boolean;
  // Connect-scoped abort for the initial pass: cancelling an installation
  // must interrupt the in-flight first tools/list instead of waiting out the
  // server. Post-connect refreshes are torn down via the connection identity
  // guard and transport close instead.
  readonly signal?: AbortSignal;
  pending: boolean;
  pendingNotification: boolean;
  promise: Promise<ToolRefreshResult>;
}

interface ToolRefreshResult {
  readonly descriptors: McpToolDescriptor[];
  readonly initialSnapshot?: Map<string, ToolSnapshotEntry>;
  readonly suppressed: boolean;
}

interface ToolRefreshOptions {
  readonly notification?: boolean;
  readonly initial?: boolean;
  readonly signal?: AbortSignal;
}

interface ToolRefreshNotificationState {
  readonly client: Client;
  readonly connectionGeneration: number;
  // This state intentionally outlives one refresh promise. A notification
  // sent just after every response must consume the same bounded pass budget,
  // while an idle interval starts a later independent burst with a new one.
  refreshPasses: number;
  suppressed: boolean;
  lastPassCompletedAt?: number;
}

interface Connection {
  config: McpServerConfig;
  fingerprint: string;
  /** Set when stored credentials for this entry's (old) config could not be
   * erased. The entry is blocked — connect() refuses it — until a later
   * sync retires the credentials; only then may a new config take over. */
  credentialCleanupOwed?: McpServerConfig;
  client?: Client;
  transport?: Transport;
  stdioTransport?: StdioClientTransport;
  connectPromise?: Promise<McpServerStatus>;
  connectController?: AbortController;
  status: McpServerStatus;
  toolSnapshot: Map<string, ToolSnapshotEntry>;
  connectionGeneration?: number;
  refreshState?: ToolRefreshState;
  refreshNotificationState?: ToolRefreshNotificationState;
  enforceMcpHeaders: boolean;
  refreshDiagnostic?: string;
  subscription?: McpSubscription;
  subscriptionDiagnostic?: string;
  closing: boolean;
}

interface ToolBindingTarget {
  readonly connection: Connection;
  readonly snapshot: ToolSnapshotEntry;
}

interface OpenedMcpClient {
  client: Client;
  events: McpClientEventBridge;
  transport: Transport;
  stdioTransport?: StdioClientTransport;
  kind: 'stdio' | 'streamable-http' | 'sse';
  isClosed(): boolean;
}

interface McpClientEventBridge {
  activate(handlers: { onToolsChanged(error: Error | null): void }): {
    clientErrors: Error[];
    pendingToolsChanged?: { error: Error | null };
  };
}

export class McpClientManager {
  private readonly connections = new Map<string, Connection>();
  /** Servers with an interactive OAuth round in flight (startAuthorization
   * → finish/abandon). A background connect is a WRITER against the same
   * credential record — the SDK persists discovery state on every auth
   * pass — and racing one against the round trips the round's version
   * fence, failing the user's login over nothing they did. */
  private readonly interactiveRounds = new Set<string>();
  private bindingIndex = new Map<McpToolBinding, ToolBindingTarget>();
  private readonly listeners = new Set<McpManagerChangeListener>();
  private syncQueue: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly timeouts: McpTimeouts;
  private readonly now: () => number;
  private readonly clientName: string;
  private readonly clientVersion: string;
  private readonly excludedStdioEnvironmentKeys: readonly string[];
  private readonly oauthStorage?: McpOAuthStorage;
  private readonly toolCallPreparer = new McpToolCallPreparer();
  private readonly bindingManagerId = randomBytes(16).toString('base64url');
  private lastConnectionGeneration = 0;
  private callableSnapshot: McpToolSnapshot = Object.freeze({
    revision: 0,
    tools: Object.freeze([]),
  });

  /** Secret values seen flowing through OAuth storage, per server. Config
   * secrets are knowable synchronously; stored tokens are not — so every
   * storage read/write harvests them for the outbound-message scrubber.
   * Values survive record deletion on purpose: a late error can still
   * reflect a token that was just dropped. */
  private readonly storedSecrets = new Map<string, Set<string>>();

  /** Owns every credential state transition: per-server lanes, epochs and
   * versioned CAS writes live in one place (credential-coordinator.ts). */
  private coordinator?: McpCredentialCoordinator;

  constructor(options: McpClientManagerOptions = {}) {
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
    this.now = options.now ?? Date.now;
    this.clientName = options.clientName ?? 'maka';
    this.clientVersion = options.clientVersion ?? '0.1.0';
    this.excludedStdioEnvironmentKeys = [...(options.excludedStdioEnvironmentKeys ?? [])];
    this.oauthStorage = options.oauthStorage
      ? this.harvestingStorage(options.oauthStorage)
      : undefined;
    this.coordinator = this.oauthStorage
      ? new McpCredentialCoordinator(this.oauthStorage)
      : undefined;
  }

  private harvestingStorage(storage: McpOAuthStorage): McpOAuthStorage {
    const harvest = (
      serverId: string,
      record: { tokens?: unknown; clientInformation?: unknown; codeVerifier?: unknown } | undefined,
    ) => {
      if (!record) return;
      const tokens = record.tokens as
        | { access_token?: unknown; refresh_token?: unknown; id_token?: unknown }
        | undefined;
      const client = record.clientInformation as { client_secret?: unknown } | undefined;
      const verifier = record.codeVerifier;
      const values = [
        tokens?.access_token,
        tokens?.refresh_token,
        tokens?.id_token,
        client?.client_secret,
        // The PKCE verifier is a secret too: a hostile token endpoint can
        // echo the code_verifier parameter it was sent back into an error.
        verifier,
      ];
      const secrets = this.storedSecrets.get(serverId) ?? new Set<string>();
      for (const value of values) {
        if (typeof value !== 'string' || value.length === 0) continue;
        // Re-insertion moves the value to the tail: the set stays ordered
        // by recency, so the eviction below drops the OLDEST harvested
        // material once a long-lived process has rotated tokens enough
        // times that scrubbing every historical value would grow without
        // bound. Recently seen values are the ones a server can still
        // reflect.
        secrets.delete(value);
        secrets.add(value);
      }
      while (secrets.size > MAX_HARVESTED_SECRETS_PER_SERVER) {
        const oldest: string = secrets.values().next().value as string;
        secrets.delete(oldest);
      }
      if (secrets.size > 0) this.storedSecrets.set(serverId, secrets);
    };
    const underlyingCompareAndSet = storage.compareAndSet?.bind(storage);
    return {
      get: async (serverId) => {
        const record = await storage.get(serverId);
        harvest(serverId, record);
        return record;
      },
      set: async (serverId, record) => {
        harvest(serverId, record);
        await storage.set(serverId, record);
      },
      delete: (serverId) => storage.delete(serverId),
      // The coordinator downgrades to unconditional writes when the backend
      // hides its CAS — forward it, or external-writer conflicts are never
      // detected.
      ...(underlyingCompareAndSet
        ? {
            compareAndSet: async (
              serverId: string,
              expectedVersion: number | null,
              record: McpOAuthRecord,
            ) => {
              harvest(serverId, record);
              return underlyingCompareAndSet(serverId, expectedVersion, record);
            },
          }
        : {}),
    };
  }

  /** Everything the scrubber must never let out for this server: the
   * config's secret values plus any token material seen in storage. */
  private secretsFor(serverId: string, config: McpServerConfig): SecretInventory {
    const inventory = collectConfigSecrets(config);
    for (const value of this.storedSecrets.get(serverId) ?? []) {
      (value.length >= MIN_SUBSTITUTION_LENGTH ? inventory.substitute : inventory.withhold).push(
        value,
      );
    }
    return inventory;
  }

  onChange(listener: McpManagerChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  sync(config: McpConfigFile): Promise<void> {
    if (this.closed) return Promise.reject(new Error('MCP client manager is closed'));
    const snapshot = structuredClone(config);
    const operation = this.syncQueue.catch(() => {}).then(() => this.syncNow(snapshot));
    this.syncQueue = operation;
    return operation;
  }

  private async syncNow(config: McpConfigFile): Promise<void> {
    const desired = new Set(Object.keys(config.mcpServers));
    // A failed erase must not abandon the rest of the reconciliation: the
    // config file is already written, so stopping here would leave every
    // OTHER added/changed server diverged until the next sync. The blocked
    // server stays blocked; the failures reject the sync at the end.
    const removalFailures: unknown[] = [];
    await Promise.all(
      [...this.connections.keys()]
        .filter((serverId) => !desired.has(serverId))
        .map(async (serverId) => {
          const entry = this.connections.get(serverId);
          // Credentials first, connection second: a removed server's stored
          // OAuth tokens are a hazard — a same-id server added back later
          // must not inherit them. Erasing is the authoritative transition;
          // only after it succeeds may connection ownership be released. On
          // failure the entry stays, blocked — the next sync retries.
          try {
            await this.forgetAuthorization(serverId, entry?.credentialCleanupOwed ?? entry?.config);
          } catch (error) {
            if (entry) {
              await this.blockForCredentialCleanup(
                serverId,
                entry,
                entry.credentialCleanupOwed ?? entry.config,
                error,
              );
            }
            removalFailures.push(error);
            return;
          }
          await this.disconnect(serverId, true);
        }),
    );
    const connectIds: string[] = [];
    for (const [serverId, serverConfig] of Object.entries(config.mcpServers)) {
      const fingerprint = stableConfigFingerprint(serverConfig);
      const current = this.connections.get(serverId);
      if (current && current.fingerprint !== fingerprint) {
        // A changed endpoint URL invalidates the credentials: replaying the
        // old server's bearer token against a new URL is exactly the leak to
        // avoid. A headers-only edit keeps them. Credential retirement is a
        // prerequisite: endpoint ownership changes ONLY after the erase
        // succeeds — on failure the old entry stays, blocked and never
        // connectable, and the new config is not adopted. The next sync
        // retries the erase against the still-owed old config.
        const owed = current.credentialCleanupOwed
          ? current.credentialCleanupOwed
          : remoteUrlChanged(current.config, serverConfig)
            ? current.config
            : undefined;
        if (owed) {
          try {
            await this.forgetAuthorization(serverId, owed);
          } catch (error) {
            await this.blockForCredentialCleanup(serverId, current, owed, error);
            // Same contract as the removal loop: the config is already
            // written to the NEW endpoint while the old one stays blocked —
            // the caller that wrote it needs the failure, not a clean
            // resolve that hides the divergence.
            removalFailures.push(error);
            continue;
          }
          current.credentialCleanupOwed = undefined;
        }
        await this.disconnect(serverId, true);
      } else if (current?.credentialCleanupOwed) {
        // Same fingerprint again: the config reverted to (or never left)
        // the endpoint the credentials belong to — nothing is owed.
        current.credentialCleanupOwed = undefined;
      }
      if (!this.connections.has(serverId)) {
        this.connections.set(serverId, {
          config: serverConfig,
          fingerprint,
          closing: false,
          toolSnapshot: new Map(),
          enforceMcpHeaders: false,
          status: this.makeStatus(
            serverId,
            serverConfig.enabled === false ? 'disabled' : 'disconnected',
          ),
        });
      }
      if (serverConfig.enabled !== false) connectIds.push(serverId);
    }
    await Promise.all(connectIds.map((serverId) => this.connect(serverId).catch(() => {})));
    if (removalFailures.length > 0) throw removalFailures[0];
  }

  /** Fail-closed holding state for a server whose stored credentials could
   * not be erased: the transport is torn down, the entry is kept under its
   * OLD config (the one the credentials belong to), and connect() refuses
   * it until a later sync retires the credentials. */
  private async blockForCredentialCleanup(
    serverId: string,
    entry: Connection,
    owed: McpServerConfig,
    error: unknown,
  ): Promise<void> {
    entry.credentialCleanupOwed = owed;
    await this.disconnect(serverId, false).catch(() => {});
    this.update(entry, {
      ...entry.status,
      state: 'error',
      toolCount: 0,
      tools: [],
      // The inventory matters here too: a credential-store failure can echo
      // record contents into its message.
      error: `stored credentials for the previous endpoint could not be removed: ${errorMessage(
        error,
        this.secretsFor(serverId, owed),
      )}`,
      updatedAt: this.now(),
    });
  }

  statuses(): McpServerStatus[] {
    return [...this.connections.values()].map((entry) => cloneStatus(entry.status));
  }

  status(serverId: string): McpServerStatus | undefined {
    const value = this.connections.get(serverId)?.status;
    return value ? cloneStatus(value) : undefined;
  }

  toolSnapshot(): McpToolSnapshot {
    return this.callableSnapshot;
  }

  async connect(serverId: string): Promise<McpServerStatus> {
    if (this.closed) throw new Error('MCP client manager is closed');
    const entry = this.requireConnection(serverId);
    if (entry.closing) throw new Error(`MCP server "${serverId}" is closing`);
    if (entry.credentialCleanupOwed) {
      // Fail closed: the previous endpoint's credentials still exist, so no
      // connection may proceed until a sync retires them.
      throw new Error(
        `MCP server "${serverId}" is blocked: stored credentials for the previous endpoint could not be removed`,
      );
    }
    if (entry.config.enabled === false) return cloneStatus(entry.status);
    if (entry.status.state === 'connected') return cloneStatus(entry.status);
    if (this.interactiveRounds.has(serverId)) {
      // Deferred, not failed: the round's finish (or the next sync after an
      // abandon) reconnects. Starting a connect here would persist discovery
      // state mid-round and rotate the record under the round's fence.
      return cloneStatus(entry.status);
    }
    if (entry.connectPromise) return entry.connectPromise;
    const controller = new AbortController();
    entry.connectController = controller;
    const promise = this.connectEntry(serverId, entry, controller.signal).finally(() => {
      if (entry.connectPromise === promise) entry.connectPromise = undefined;
      if (entry.connectController === controller) entry.connectController = undefined;
    });
    entry.connectPromise = promise;
    return promise;
  }

  cancelConnect(serverId: string): boolean {
    const entry = this.connections.get(serverId);
    if (entry?.status.state !== 'connecting') return false;
    const controller = entry.connectController;
    if (!controller || controller.signal.aborted) return false;
    controller.abort(new Error(`MCP installation cancelled: ${serverId}`));
    return true;
  }

  async reconnect(serverId: string): Promise<McpServerStatus> {
    await this.disconnect(serverId, false);
    return this.connect(serverId);
  }

  async disconnect(serverId: string, remove = false): Promise<void> {
    const entry = this.connections.get(serverId);
    if (!entry) return;
    entry.closing = true;
    entry.connectController?.abort(new Error(`MCP connection closed: ${serverId}`));
    const connectPromise = entry.connectPromise;
    const client = entry.client;
    const transport = entry.transport;
    const subscription = entry.subscription;
    entry.client = undefined;
    entry.transport = undefined;
    entry.stdioTransport = undefined;
    entry.subscription = undefined;
    this.replaceToolSnapshot(entry, new Map());
    entry.connectionGeneration = undefined;
    entry.refreshState = undefined;
    entry.refreshNotificationState = undefined;
    entry.enforceMcpHeaders = false;
    entry.refreshDiagnostic = undefined;
    entry.subscriptionDiagnostic = undefined;
    await safeClose(client, transport, subscription);
    await connectPromise?.catch(() => {});
    if (remove) {
      this.connections.delete(serverId);
      return;
    }
    entry.closing = false;
    this.update(entry, {
      ...this.makeStatus(serverId, entry.config.enabled === false ? 'disabled' : 'disconnected'),
      stderrTail: entry.status.stderrTail,
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    const closing = [...this.connections.values()].map((entry) => {
      entry.closing = true;
      entry.connectController?.abort(
        new Error(`MCP client manager closed: ${entry.status.serverId}`),
      );
      this.replaceToolSnapshot(entry, new Map());
      entry.connectionGeneration = undefined;
      entry.refreshState = undefined;
      entry.refreshNotificationState = undefined;
      entry.enforceMcpHeaders = false;
      const subscription = entry.subscription;
      entry.subscription = undefined;
      entry.refreshDiagnostic = undefined;
      entry.subscriptionDiagnostic = undefined;
      return safeClose(entry.client, entry.transport, subscription);
    });
    await Promise.all(closing);
    await this.syncQueue.catch(() => {});
    await Promise.all(
      [...this.connections.keys()].map((serverId) => this.disconnect(serverId, true)),
    );
  }

  async refreshTools(serverId: string): Promise<McpToolDescriptor[]> {
    if (this.closed) throw new Error('MCP client manager is closed');
    const entry = this.requireConnection(serverId);
    const connectingRefresh = entry.refreshState;
    // Initial discovery already defines the first callable snapshot. An
    // explicit refresh during that connect joins it without requesting the
    // notification-style follow-up pass used after publication.
    if (
      entry.status.state === 'connecting' &&
      entry.client &&
      connectingRefresh?.client === entry.client &&
      connectingRefresh.connectionGeneration === entry.connectionGeneration
    ) {
      return (await connectingRefresh.promise).descriptors;
    }
    if (!entry.client || entry.status.state !== 'connected') await this.connect(serverId);
    const client = entry.client;
    if (!client) throw new Error(`MCP server "${serverId}" is not connected`);
    const connectionGeneration = this.requireConnectionGeneration(serverId, entry);
    const activeRefresh = entry.refreshState;
    const refreshIsActive =
      activeRefresh?.client === client &&
      activeRefresh.connectionGeneration === connectionGeneration;
    if (!refreshIsActive) {
      entry.refreshNotificationState = {
        client,
        connectionGeneration,
        refreshPasses: 0,
        suppressed: false,
      };
    }
    const result = await this.startToolRefresh(serverId, entry, client, connectionGeneration);
    return result.descriptors;
  }

  private startToolRefresh(
    serverId: string,
    entry: Connection,
    client: Client,
    connectionGeneration: number,
    options: ToolRefreshOptions = {},
  ): Promise<ToolRefreshResult> {
    const notification = options.notification ?? false;
    if (
      entry.refreshState?.client === client &&
      entry.refreshState.connectionGeneration === connectionGeneration
    ) {
      entry.refreshState.pending = true;
      entry.refreshState.pendingNotification ||= notification;
      return entry.refreshState.promise;
    }

    const state: ToolRefreshState = {
      client,
      connectionGeneration,
      initial: options.initial ?? false,
      signal: options.signal,
      pending: false,
      pendingNotification: notification,
      promise: Promise.resolve({ descriptors: [], suppressed: false }),
    };
    entry.refreshState = state;
    // Start on the next microtask so the generation-owned gate is installed
    // before even a synchronous no-capability refresh can settle and release it.
    state.promise = Promise.resolve().then(() => this.refreshToolLoop(serverId, entry, state));
    return state.promise;
  }

  private async refreshToolsAfterNotification(
    serverId: string,
    entry: Connection,
    client: Client,
    connectionGeneration: number,
  ): Promise<McpToolDescriptor[]> {
    let notificationState = entry.refreshNotificationState;
    if (
      notificationState?.client !== client ||
      notificationState.connectionGeneration !== connectionGeneration
    ) {
      notificationState = {
        client,
        connectionGeneration,
        refreshPasses: 0,
        suppressed: false,
      };
      entry.refreshNotificationState = notificationState;
    }
    const activeRefresh = entry.refreshState;
    if (
      activeRefresh?.client === client &&
      activeRefresh.connectionGeneration === connectionGeneration
    ) {
      activeRefresh.pending = true;
      activeRefresh.pendingNotification = true;
      return (await activeRefresh.promise).descriptors;
    }
    if (
      notificationState.lastPassCompletedAt !== undefined &&
      this.now() - notificationState.lastPassCompletedAt >= TOOL_REFRESH_BURST_IDLE_MS
    ) {
      notificationState.refreshPasses = 0;
      notificationState.suppressed = false;
    }
    if (notificationState.suppressed) {
      return Promise.reject(this.toolRefreshFrequencyError(serverId));
    }
    if (notificationState.refreshPasses >= MAX_TOOL_REFRESH_PASSES) {
      notificationState.suppressed = true;
      return Promise.reject(this.toolRefreshFrequencyError(serverId));
    }
    const result = await this.startToolRefresh(serverId, entry, client, connectionGeneration, {
      notification: true,
    });
    return result.descriptors;
  }

  async callTool(
    binding: McpToolBinding,
    args: Record<string, unknown>,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<McpCallResult> {
    const identity = parseMcpToolBinding(binding);
    if (!identity) {
      throw new McpToolCallError('unknown', 'unknown', 'tool binding is invalid');
    }
    if (this.closed) {
      throw new McpToolCallError('unknown', 'unknown', 'client manager is closed');
    }
    const target = this.bindingIndex.get(binding);
    const entry = target?.connection;
    const snapshot = target?.snapshot;
    const serverId = snapshot?.descriptor.serverId ?? 'unknown';
    const toolName = snapshot?.descriptor.name ?? 'unknown';
    if (
      identity.managerId !== this.bindingManagerId ||
      !entry ||
      !snapshot ||
      this.connections.get(serverId) !== entry ||
      entry.closing ||
      entry.status.state !== 'connected' ||
      !entry.client ||
      snapshot.binding !== binding ||
      snapshot.connectionGeneration !== identity.connectionGeneration ||
      entry.connectionGeneration !== identity.connectionGeneration ||
      entry.toolSnapshot.get(toolName) !== snapshot
    ) {
      throw new McpToolCallError(serverId, toolName, 'tool binding is stale');
    }
    const client = entry.client;
    const headerArguments = validateMcpHeaderArguments(snapshot.headerDeclarations, args);
    if (!headerArguments.valid) {
      throw new McpToolCallError(
        serverId,
        toolName,
        `unsafe integer argument at ${formatMcpDiagnosticText(headerArguments.path.join('.'))}`,
      );
    }
    const inventory = this.secretsFor(serverId, entry.config);
    const preparation =
      snapshot.callPreparation ??
      (snapshot.callPreparation = this.toolCallPreparer.prepare(snapshot.definition));
    if (!preparation.ok) {
      throw new McpToolCallError(serverId, toolName, 'server advertised an invalid output schema', {
        cause: preparation.cause,
      });
    }
    let result;
    try {
      result = await client.callTool(
        { name: toolName, arguments: args },
        {
          signal: options.signal,
          timeout: options.timeoutMs ?? this.timeouts.callToolMs,
          toolDefinition: structuredClone(preparation.value.definitionForSdk),
        },
      );
    } catch (error) {
      // A 401 after connect means the server revoked the session, not that
      // one call hiccuped: leave `connected` and the UI never offers the
      // login it now needs.
      if (
        isAuthRequiredError(error) &&
        this.connections.get(serverId) === entry &&
        entry.client === client
      ) {
        this.markError(entry, error);
      }
      // The transport error can carry reflected request material (the body
      // of a failed POST); scrub it like every other outbound message. The
      // cause chain still holds the RAW transport error — the rejection
      // leaves the manager (IPC, logs, telemetry), and any cause-aware
      // serializer downstream would expose it — so the retained cause is an
      // allowlisted copy: typed identity (name, code, status, SDK brands)
      // with a scrubbed message and no deeper chain or payload fields.
      const normalized = normalizeToolCallError(serverId, toolName, error, options.signal);
      normalized.message = scrubKnownSecrets(normalized.message, inventory);
      normalized.cause = sanitizedCause(normalized.cause, inventory);
      throw normalized;
    }
    // The SDK's legacy compatibility schema defaults a missing content array
    // before returning, but retains deferred-result compatibility fields.
    // Reject every decoded marker and any future content-less result.
    if (
      !Object.hasOwn(result, 'content') ||
      Object.hasOwn(result, 'toolResult') ||
      Object.hasOwn(result, 'task') ||
      Object.hasOwn(result, 'inputRequests') ||
      Object.hasOwn(result, 'requestState')
    ) {
      throw new McpToolCallError(
        serverId,
        toolName,
        'server returned an unsupported deferred tool result',
      );
    }
    if (!Array.isArray(result.content)) {
      throw new McpToolCallError(serverId, toolName, 'server returned invalid content');
    }
    if (result.isError) {
      // The server writes this text; it can echo a secret it was sent.
      throw new McpToolCallError(
        serverId,
        toolName,
        scrubKnownSecrets(redactSecrets(summarizeErrorContent(result.content)), inventory),
      );
    }
    const validateOutput = preparation.value.validateOutput;
    if (validateOutput) {
      if (result.structuredContent === undefined) {
        throw new McpToolCallError(serverId, toolName, 'server returned an invalid tool result');
      }
      let validation;
      try {
        validation = validateOutput(result.structuredContent);
      } catch (cause) {
        throw new McpToolCallError(serverId, toolName, 'server returned an invalid tool result', {
          cause,
        });
      }
      if (!validation.valid) {
        throw new McpToolCallError(serverId, toolName, 'server returned an invalid tool result', {
          cause: new Error(validation.errorMessage),
        });
      }
    }
    // Success payloads cross toward the renderer and the transcript too; a
    // server can embed the credential it was just sent into a result.
    return {
      content: deepScrub(result.content.map(normalizeContent), inventory),
      structuredContent: deepScrub(result.structuredContent, inventory),
    };
  }

  async test(serverId: string): Promise<McpTestResult> {
    const started = this.now();
    const current = this.requireConnection(serverId);
    if (current.config.enabled === false) {
      return {
        ok: false,
        status: { ...cloneStatus(current.status), error: 'MCP server is disabled' },
        latencyMs: this.now() - started,
      };
    }
    try {
      const status = await this.reconnect(serverId);
      return { ok: true, status, latencyMs: this.now() - started };
    } catch {
      return {
        ok: false,
        status: this.status(serverId) ?? this.makeStatus(serverId, 'error'),
        latencyMs: this.now() - started,
      };
    }
  }

  private async connectEntry(
    serverId: string,
    entry: Connection,
    signal: AbortSignal,
  ): Promise<McpServerStatus> {
    let connected: OpenedMcpClient | undefined;
    entry.closing = false;
    entry.refreshDiagnostic = undefined;
    entry.subscription = undefined;
    entry.subscriptionDiagnostic = undefined;
    this.update(entry, {
      ...this.makeStatus(serverId, 'connecting'),
      stderrTail: entry.status.stderrTail,
    });
    try {
      connected = await this.openClient(serverId, entry, signal);
      if (signal.aborted || entry.closing || connected.isClosed()) {
        throw new Error(`MCP server "${serverId}" connection closed during setup`);
      }
      const connectedClient = connected.client;
      const negotiatedProtocol = readNegotiatedProtocol(connectedClient);
      const serverCapabilities = connectedClient.getServerCapabilities();
      const expectsToolListSubscription =
        negotiatedProtocol.era === 'modern' && serverCapabilities?.tools?.listChanged === true;
      let subscription = expectsToolListSubscription
        ? connectedClient.autoOpenedSubscription
        : undefined;
      let subscriptionFailure:
        | { reason: 'missing'; cause?: Error }
        | { reason: 'unhonored' }
        | undefined;
      if (subscription && subscription.honoredFilter.toolsListChanged !== true) {
        // close() settles the handle locally before sending its cancellation
        // notification. Do not let an uncooperative server hold setup open by
        // never answering that best-effort notification.
        void subscription.close().catch(() => {});
        subscription = undefined;
        subscriptionFailure = { reason: 'unhonored' };
      }
      entry.client = connectedClient;
      entry.transport = connected.transport;
      entry.stdioTransport = connected.stdioTransport;
      entry.subscription = subscription;
      const connectionGeneration = this.allocateConnectionGeneration();
      entry.connectionGeneration = connectionGeneration;
      entry.enforceMcpHeaders =
        connected.kind === 'streamable-http' && negotiatedProtocol.era === 'modern';

      if (negotiatedProtocol.era === 'legacy') {
        // Legacy servers commonly emit this notification without advertising
        // the optional listChanged flag. Keep that compatibility at the
        // manager boundary; modern connections use the SDK subscription path.
        connectedClient.setNotificationHandler('notifications/tools/list_changed', async () => {
          this.handleToolsChanged(serverId, entry, connectedClient, connectionGeneration, null);
        });
      }

      const bufferedEvents = connected.events.activate({
        onToolsChanged: (error) => {
          this.handleToolsChanged(serverId, entry, connectedClient, connectionGeneration, error);
        },
      });
      if (expectsToolListSubscription && !subscription && !subscriptionFailure) {
        subscriptionFailure = {
          reason: 'missing',
          cause: bufferedEvents.clientErrors.at(-1),
        };
      }
      entry.subscriptionDiagnostic = subscriptionFailure
        ? subscriptionFailure.reason === 'unhonored'
          ? formatSubscriptionDiagnostic(serverId, 'did not honor tool-list changes')
          : scrubKnownSecrets(
              formatSubscriptionDiagnostic(serverId, 'is unavailable', subscriptionFailure.cause),
              this.secretsFor(serverId, entry.config),
            )
        : undefined;
      // Initial discovery shares the generation-fenced, single-flight refresh
      // owner with explicit refreshes and live change signals. A notification
      // arriving while the first tools/list is in flight therefore joins that
      // pass instead of publishing a snapshot the server already marked stale.
      const initialRefreshPromise = this.startToolRefresh(
        serverId,
        entry,
        connectedClient,
        connectionGeneration,
        { initial: true, signal },
      );
      if (bufferedEvents.pendingToolsChanged) {
        this.handleToolsChanged(
          serverId,
          entry,
          connectedClient,
          connectionGeneration,
          bufferedEvents.pendingToolsChanged.error,
        );
      }
      const initialRefresh = await initialRefreshPromise;
      if (
        signal.aborted ||
        entry.closing ||
        connected.isClosed() ||
        entry.client !== connectedClient ||
        entry.connectionGeneration !== connectionGeneration
      ) {
        throw new Error(`MCP server "${serverId}" connection changed during tool discovery`);
      }
      const initialSnapshot = initialRefresh.initialSnapshot;
      if (!initialSnapshot) {
        throw new Error(`MCP server "${serverId}" returned no initial tool snapshot`);
      }
      // Initial discovery prepares snapshots while the connection is still
      // connecting, but publication and the connected status transition stay
      // in one synchronous commit. Observers can therefore never advertise a
      // binding that callTool still rejects as not connected.
      this.replaceToolSnapshot(entry, initialSnapshot);
      if (initialRefresh.suppressed) {
        entry.refreshDiagnostic = errorMessage(this.toolRefreshFrequencyError(serverId));
      }
      const authenticated =
        !isMcpStdioConfig(entry.config) && this.oauthStorage
          ? Boolean((await this.oauthStorage.get(serverId))?.tokens)
          : undefined;
      this.update(entry, {
        serverId,
        state: 'connected',
        transport: connected.kind,
        negotiatedProtocol,
        toolCount: initialRefresh.descriptors.length,
        tools: initialRefresh.descriptors,
        error: projectConnectionDiagnostics(entry),
        stderrTail: entry.status.stderrTail,
        ...(authenticated !== undefined ? { authenticated } : {}),
        updatedAt: this.now(),
      });
      if (
        signal.aborted ||
        entry.closing ||
        connected.isClosed() ||
        entry.client !== connectedClient ||
        entry.connectionGeneration !== connectionGeneration
      ) {
        throw safeMcpOperationError(
          serverId,
          'connection changed during tool discovery',
          undefined,
        );
      }
      if (subscription) {
        this.observeSubscriptionClose(
          serverId,
          entry,
          connectedClient,
          connectionGeneration,
          subscription,
        );
      }
      return cloneStatus(entry.status);
    } catch (error) {
      const exposedError = safeMcpOperationError(
        serverId,
        signal.aborted ? 'connection aborted' : 'connection failed',
        error,
        !signal.aborted,
      );
      await safeClose(
        connected?.client ?? entry.client,
        connected?.transport ?? entry.transport,
        connected?.client.autoOpenedSubscription ?? entry.subscription,
      );
      if (!connected || !entry.client || entry.client === connected.client) {
        entry.client = undefined;
        entry.transport = undefined;
        entry.stdioTransport = undefined;
        entry.subscription = undefined;
        this.replaceToolSnapshot(entry, new Map());
        entry.connectionGeneration = undefined;
        entry.refreshState = undefined;
        entry.refreshNotificationState = undefined;
        entry.enforceMcpHeaders = false;
        entry.refreshDiagnostic = undefined;
        entry.subscriptionDiagnostic = undefined;
      }
      if (signal.aborted) {
        if (!entry.closing && this.connections.get(serverId) === entry) {
          this.update(entry, {
            ...this.makeStatus(serverId, 'disconnected'),
            stderrTail: entry.status.stderrTail,
          });
        }
      } else {
        this.markError(entry, exposedError);
      }
      // The status above is scrubbed; the rejection leaves the manager too
      // (reconnect → IPC → renderer) and must not carry the raw message or
      // cause chain. Like the tool-call path, the cause survives as an
      // allowlisted sanitized copy — a plain DNS/TLS/refused failure keeps
      // its underlying explanation (including the per-transport aggregate).
      const inventory = this.secretsFor(serverId, entry.config);
      const rejection = scrubbedError(exposedError, inventory);
      rejection.cause = sanitizedCause(exposedError.cause, inventory);
      throw rejection;
    }
  }

  private async openClient(
    serverId: string,
    entry: Connection,
    signal: AbortSignal,
  ): Promise<OpenedMcpClient> {
    if (isMcpStdioConfig(entry.config)) {
      const transport = new StdioClientTransport({
        command: entry.config.command,
        args: entry.config.args,
        cwd: entry.config.cwd,
        env: buildStdioEnvironment(
          entry.config.env,
          process.env,
          this.excludedStdioEnvironmentKeys,
        ),
        stderr: 'pipe',
      });
      attachStderrTail(transport, entry, collectConfigSecrets(entry.config), () => {
        if (this.connections.get(serverId) === entry) this.emit(entry.status);
      });
      const { client, events } = this.createClient('legacy');
      const isClosed = this.watchClientClose(serverId, entry, client);
      try {
        await client.connect(transport, { timeout: this.timeouts.stdioConnectMs, signal });
        return {
          client,
          events,
          transport,
          stdioTransport: transport,
          kind: 'stdio',
          isClosed,
        };
      } catch (error) {
        await safeClose(client, transport);
        throw enrichStdioError(error, entry.status.stderrTail, collectConfigSecrets(entry.config));
      }
    }
    const remoteConfig: McpRemoteServerConfig = entry.config;
    const requested = remoteConfig.transport ?? 'auto';
    const preference = resolveMcpRemoteProtocolPreference(remoteConfig);
    if (requested === 'sse' && preference !== 'legacy') {
      throw new Error(`MCP legacy SSE transport does not support protocol ${preference}`);
    }
    const authProvider = await this.backgroundAuthProvider(serverId, remoteConfig, signal);
    const serverUrl = new URL(remoteConfig.url);
    // One authority per header: when OAuth is in play for this server —
    // a static client is configured, or a stored record exists — the OAuth
    // bearer owns Authorization, and a configured Authorization header is
    // excluded rather than left to fight (and win over) the fresh token.
    // A plain static-bearer config with no OAuth involvement keeps its
    // header untouched. The config store rejects the explicit conflict
    // (oauth block + Authorization header) outright.
    const record = this.coordinator ? await this.coordinator.read(serverId) : undefined;
    // The raw record only counts when it is BOUND to this endpoint: after an
    // offline mcp.json repoint the stale record's tokens will be dropped by
    // the provider, so they must not strip a configured header either.
    const boundRecord = record?.serverUrl === remoteConfig.url ? record : undefined;
    const oauthOwnsAuthorization =
      authProvider !== undefined &&
      (Boolean(remoteConfig.oauth) ||
        Boolean(boundRecord?.tokens || boundRecord?.clientInformation));
    const requestHeaders = oauthOwnsAuthorization
      ? withoutAuthorizationHeader(remoteConfig.headers)
      : remoteConfig.headers;
    // The SDK reuses request headers for OAuth discovery, registration and
    // token requests too, which would leak a configured resource secret (an
    // Authorization or X-API-Key header) to a cross-origin authorization
    // server. The scoped fetch confines them to the endpoint's own origin,
    // hop by hop across redirects, and blocks cleartext downgrades.
    const fetchImpl = scopedFetch(serverUrl, requestHeaders);
    let streamableFailure: unknown;
    if (requested !== 'sse') {
      const evidence = createStreamableHandshakeEvidence(fetchImpl);
      const { client, events } = this.createClient(preference);
      const transport = new StreamableHTTPClientTransport(serverUrl, {
        requestInit: { headers: requestHeaders },
        ...(authProvider ? { authProvider } : {}),
        fetch: evidence.fetch,
      });
      const isClosed = this.watchClientClose(serverId, entry, client);
      try {
        await connectRemoteCandidate(client, transport, this.timeouts.remoteConnectMs, signal);
        return { client, events, transport, kind: 'streamable-http', isClosed };
      } catch (error) {
        const producedProtocolEvidence =
          evidence.hasAcceptedInitialize() ||
          client.getProtocolEra() !== undefined ||
          client.getNegotiatedProtocolVersion() !== undefined;
        await safeClose(client, transport);
        if (
          !shouldFallbackToLegacySse({
            remoteConfig,
            error,
            signal,
            producedProtocolEvidence,
          })
        ) {
          throw error;
        }
        streamableFailure = error;
      }
    }
    const { client, events } = this.createClient('legacy');
    const transport = new SSEClientTransport(serverUrl, {
      requestInit: { headers: requestHeaders },
      ...(authProvider ? { authProvider } : {}),
      fetch: fetchImpl,
    });
    const isClosed = this.watchClientClose(serverId, entry, client);
    try {
      await connectRemoteCandidate(client, transport, this.timeouts.remoteConnectMs, signal);
      return { client, events, transport, kind: 'sse', isClosed };
    } catch (error) {
      await safeClose(client, transport);
      if (streamableFailure !== undefined) {
        throw new AggregateError(
          [streamableFailure, error],
          'Streamable HTTP and legacy SSE connection attempts failed',
        );
      }
      throw error;
    }
  }

  /** Provider for non-interactive connects: uses and refreshes stored
   * tokens, but refuses to start a browser round. */
  private async backgroundAuthProvider(
    serverId: string,
    config: McpRemoteServerConfig,
    signal?: AbortSignal,
  ): Promise<McpOAuthProvider | undefined> {
    if (!this.oauthStorage) return undefined;
    return new McpOAuthProvider({
      serverId,
      serverUrl: config.url,
      // The abort signal fences writes only while the CONNECT is in flight
      // — connect() clears its controller in `finally`, so nothing aborts
      // this flow once the connection is up. What fences a live
      // connection's late writes is the epoch bump (logout/erase) and the
      // generation/version beginFlow pins before the first network await:
      // a cross-process logout during the handshake trips those, not the
      // signal.
      storage: await this.beginFlow(serverId, signal),
      config: config.oauth,
      clientName: this.clientName,
      clientVersion: this.clientVersion,
    });
  }

  private flowStorage(serverId: string, signal?: AbortSignal): McpOAuthStorage {
    return this.requireCoordinator().flowStorage(serverId, signal ? { signal } : {});
  }

  /** Flow view with generation/version pinned before any remote await. */
  private beginFlow(serverId: string, signal?: AbortSignal): Promise<McpOAuthStorage> {
    return this.requireCoordinator().beginFlow(serverId, signal ? { signal } : {});
  }

  private requireCoordinator(): McpCredentialCoordinator {
    if (!this.coordinator) throw new Error('MCP OAuth storage is not configured');
    return this.coordinator;
  }

  private requireRemoteEntry(serverId: string): {
    entry: Connection;
    config: McpRemoteServerConfig;
  } {
    const entry = this.requireConnection(serverId);
    if (isMcpStdioConfig(entry.config)) {
      throw new Error(
        `MCP server "${serverId}" is a stdio server; OAuth applies to remote servers`,
      );
    }
    if (entry.credentialCleanupOwed) {
      // The same fail-closed gate connect() applies: no OAuth path — start,
      // finish, or clear — may write fresh credential state while the
      // previous endpoint's credentials are still owed retirement. The next
      // sync retries the erase and unblocks the entry.
      throw new Error(
        `MCP server "${serverId}" is blocked: stored credentials for the previous endpoint could not be removed`,
      );
    }
    return { entry, config: entry.config };
  }

  private requireOAuthStorage(): McpOAuthStorage {
    if (!this.oauthStorage) throw new Error('MCP OAuth storage is not configured');
    return this.oauthStorage;
  }

  /**
   * Begins an interactive authorization round. Runs discovery (and, when
   * stored or configured credentials already satisfy the server, the silent
   * token path); returns either `authorized` — nothing to open — or the
   * authorization URL to open in the user's browser. The PKCE verifier and
   * redirect URL are persisted, so the matching finishAuthorization call is
   * process-restart-safe.
   */
  async startAuthorization(
    serverId: string,
    redirectUrl: string,
    options: { state?: string; signal?: AbortSignal } = {},
  ): Promise<McpAuthorizationStart> {
    const { config } = this.requireRemoteEntry(serverId);
    // The round is bound to a verifiable state from the first byte: minted
    // here when the caller supplies none, so the pending record ALWAYS
    // carries one and finishAuthorization always has something to verify.
    const state = options.state ?? randomBytes(16).toString('hex');
    // Claim the round BEFORE any await, and retire any in-flight background
    // connect: it writes discovery state through the same record and would
    // trip this round's version fence (see interactiveRounds).
    this.interactiveRounds.add(serverId);
    try {
      this.cancelConnect(serverId);
      await this.connections.get(serverId)?.connectPromise?.catch(() => {});
    } catch (error) {
      this.interactiveRounds.delete(serverId);
      throw error;
    }
    return this.startAuthorizationRound(serverId, config, redirectUrl, state, options).catch(
      (error) => {
        this.interactiveRounds.delete(serverId);
        throw error;
      },
    );
  }

  private async startAuthorizationRound(
    serverId: string,
    config: McpRemoteServerConfig,
    redirectUrl: string,
    state: string,
    options: { state?: string; signal?: AbortSignal },
  ): Promise<McpAuthorizationStart> {
    // The caller's round deadline fences this flow's storage writes: a
    // round abandoned by its owner must not land verifier/state/tokens
    // over a newer round's record. beginFlow pins the persisted
    // generation/version BEFORE the remote probe below — a logout in
    // another process during that await must fence this flow, not hand it
    // the tombstone as a fresh starting point.
    const storage = await this.beginFlow(serverId, options.signal);
    let authorizationUrl: URL | undefined;
    const provider = new McpOAuthProvider({
      serverId,
      serverUrl: config.url,
      storage,
      config: config.oauth,
      clientName: this.clientName,
      clientVersion: this.clientVersion,
      interactive: {
        redirectUrl,
        state,
        onAuthorizationUrl: (url) => {
          authorizationUrl = url;
        },
      },
    });
    // The interactive flow IS OAuth: it owns Authorization for every request
    // it makes (discovery, registration, the probe, token exchange) — the
    // same ownership rule openClient applies, unconditional here. A
    // configured static header must not ride along and shadow the round's
    // own bearer.
    const fetchFn = scopedFetch(
      new URL(config.url),
      withoutAuthorizationHeader(config.headers),
      options.signal,
    );
    // A fresh 401 challenge may carry a scope (and resource_metadata URL)
    // the authorization request must echo; the persisted discovery state
    // covers the metadata but not the scope, so ask the endpoint directly.
    const challenge = await probeAuthChallenge(config.url, fetchFn);
    let result: Awaited<ReturnType<typeof auth>>;
    try {
      result = await auth(provider, {
        serverUrl: config.url,
        scope: challenge?.scope || config.oauth?.scopes?.join(' ') || undefined,
        ...(challenge?.resourceMetadataUrl
          ? { resourceMetadataUrl: challenge.resourceMetadataUrl }
          : {}),
        fetchFn,
      });
    } catch (error) {
      throw scrubbedError(error, this.secretsFor(serverId, config));
    }
    if (result === 'AUTHORIZED') {
      this.interactiveRounds.delete(serverId);
      await this.reconnect(serverId).catch(() => {});
      return { status: 'authorized' };
    }
    if (!authorizationUrl) {
      throw new Error(`MCP server "${serverId}" did not produce an authorization URL`);
    }
    // The authorization URL comes from remote metadata: the same provenance
    // rule as every other remotely supplied destination applies before it
    // is handed to a browser. (https, or loopback-http only when the user
    // configured the server itself on loopback.)
    try {
      assertTransportSecurity(authorizationUrl, urlProvenance(new URL(config.url)));
    } catch (error) {
      // auth() already persisted this round's verifier and pending fields;
      // a refused URL means the round can never complete. Clear them so
      // pendingAuthorization stops advertising a dead round for the desktop
      // resume path to rebind a listener to.
      await provider.invalidateCredentials('verifier').catch(() => {});
      throw error;
    }
    // Both values are the SERVER'S claims — the issuer from the discovery
    // this round performed, the scope from its challenge — surfaced so a
    // consumer can show the user what they are consenting to BEFORE a
    // browser opens, instead of burying the issuer inside the URL.
    const discovery = await provider.discoveryState().catch(() => undefined);
    const resolvedScope = challenge?.scope || config.oauth?.scopes?.join(' ') || undefined;
    return {
      status: 'redirect',
      authorizationUrl: authorizationUrl.toString(),
      state,
      issuer: discovery?.authorizationServerUrl
        ? `${discovery.authorizationServerUrl}`
        : new URL(config.url).origin,
      scopes: resolvedScope ? resolvedScope.split(' ').filter(Boolean) : [],
    };
  }

  /** Exchanges the callback's authorization code, then reconnects. The
   * callback payload is passed whole — including the RFC 9207 `iss`
   * parameter, which the SDK validates against the discovered issuer to
   * defeat authorization-server mix-ups; truncating it here would disable
   * that check. */
  async finishAuthorization(
    serverId: string,
    callback: { code: string; iss?: string; state?: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<McpServerStatus> {
    try {
      return await this.finishAuthorizationRound(serverId, callback, options);
    } finally {
      // Success released it before its reconnect; every failure path
      // releases here so an aborted exchange cannot park the connect gate.
      this.interactiveRounds.delete(serverId);
    }
  }

  private async finishAuthorizationRound(
    serverId: string,
    callback: { code: string; iss?: string; state?: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<McpServerStatus> {
    const authorizationCode = callback.code;
    const { config } = this.requireRemoteEntry(serverId);
    // The immediate read doubles as the flow's generation/version pin.
    const storage = this.flowStorage(serverId, options.signal);
    const record = await storage.get(serverId);
    const pendingRedirectUrl = record?.pendingRedirectUrl;
    if (!pendingRedirectUrl) {
      throw new Error(`No pending authorization for MCP server "${serverId}"`);
    }
    // Two interactive rounds share one server's pending slot: the newer
    // round's verifier overwrote the older one's. A caller that presents
    // its round state must match the PERSISTED round, or its code would be
    // exchanged against the wrong PKCE verifier.
    // The binding fires whenever the PERSISTED round has a state — which
    // startAuthorization now guarantees. Keying off the caller-supplied
    // value instead would let a callback that simply omits `state` skip the
    // check and redeem a foreign code against the pending verifier.
    if (record?.pendingState !== undefined && record.pendingState !== callback.state) {
      throw new Error(
        `Authorization round for MCP server "${serverId}" was superseded by a newer login`,
      );
    }
    // The pending round is bound to the URL it was started against — the
    // binding is REQUIRED, not merely checked when present: a pending
    // record that cannot prove its endpoint must not mint tokens for one.
    if (record?.pendingServerUrl !== config.url) {
      throw new Error(`MCP server "${serverId}" changed its URL during authorization`);
    }
    const provider = new McpOAuthProvider({
      serverId,
      serverUrl: config.url,
      storage,
      config: config.oauth,
      clientName: this.clientName,
      clientVersion: this.clientVersion,
      interactive: {
        redirectUrl: pendingRedirectUrl,
        onAuthorizationUrl: () => {
          throw new Error(`MCP server "${serverId}" restarted authorization during token exchange`);
        },
      },
    });
    // Same ownership rule as startAuthorization: the round owns
    // Authorization; the configured static header stays out of the exchange.
    const fetchFn = scopedFetch(
      new URL(config.url),
      withoutAuthorizationHeader(config.headers),
      options.signal,
    );
    let result: Awaited<ReturnType<typeof auth>>;
    try {
      result = await auth(provider, {
        serverUrl: config.url,
        authorizationCode,
        ...(callback.iss !== undefined ? { iss: callback.iss } : {}),
        fetchFn,
      });
    } catch (error) {
      // A token endpoint can reflect what it was sent (a static clientSecret,
      // a header value, a token — or this round's authorization code) into
      // error_description; none of it may reach the renderer through the
      // flattened IPC error.
      const inventory = this.secretsFor(serverId, config);
      (authorizationCode.length >= MIN_SUBSTITUTION_LENGTH
        ? inventory.substitute
        : inventory.withhold
      ).push(authorizationCode);
      throw scrubbedError(error, inventory);
    }
    if (result !== 'AUTHORIZED') {
      throw new Error(`Authorization for MCP server "${serverId}" did not complete`);
    }
    // Round over: release before reconnect, which the round gate would
    // otherwise defer.
    this.interactiveRounds.delete(serverId);
    return this.reconnect(serverId);
  }

  /** The persisted-but-unfinished interactive round, if any — enough for
   * the desktop to rebind its loopback callback listener after a restart. */
  async pendingAuthorization(
    serverId: string,
  ): Promise<{ redirectUrl: string; state?: string } | undefined> {
    if (!this.oauthStorage) return undefined;
    const record = await this.oauthStorage.get(serverId);
    if (!record?.codeVerifier || !record.pendingRedirectUrl) return undefined;
    // Callable before the first sync populates connections — the boot-time
    // listener rebind must not wait for slow connects. When the entry is
    // known, its URL still gates the pending round; either way
    // finishAuthorization re-checks pendingServerUrl before the exchange.
    const entry = this.connections.get(serverId);
    if (entry && isMcpStdioConfig(entry.config)) return undefined;
    if (
      entry &&
      !isMcpStdioConfig(entry.config) &&
      record.pendingServerUrl &&
      record.pendingServerUrl !== entry.config.url
    ) {
      return undefined;
    }
    return { redirectUrl: record.pendingRedirectUrl, state: record.pendingState };
  }

  /** Abandons a persisted-but-dead interactive round: clears the verifier
   * and pending fields, keeping tokens, client registration and discovery
   * intact. The desktop controller calls this on TERMINAL login failures
   * (denial, timeout, browser-launch failure) — otherwise the boot resume
   * would rebind a listener for a round that can never complete and hold
   * the per-server login guard on every restart. */
  async abandonAuthorization(serverId: string): Promise<void> {
    this.interactiveRounds.delete(serverId);
    if (!this.coordinator) return;
    const record = await this.coordinator.read(serverId);
    if (!record?.codeVerifier && !record?.pendingRedirectUrl && !record?.pendingState) return;
    const observedVersion = record.version ?? 0;
    const storage = this.flowStorage(serverId);
    // The coordinator's flow view always supplies update(); a silent no-op
    // else-branch on a security-relevant clear must not exist.
    if (!storage.update) throw new Error('MCP credential coordinator view lost update()');
    {
      try {
        await storage.update(serverId, (basis) => {
          // Pinned to the round we DECIDED to abandon: a fresh flow view
          // captures whatever version it reads at write time, so without
          // this check an abandon racing a NEWER login round would happily
          // CAS away that round's verifier and state.
          if ((basis.version ?? 0) !== observedVersion) throw new McpAbandonSupersededError();
          const next = { ...basis };
          delete next.codeVerifier;
          delete next.pendingRedirectUrl;
          delete next.pendingServerUrl;
          delete next.pendingState;
          return next;
        });
      } catch (error) {
        // A superseded abandon is a no-op, not a failure: the round we
        // wanted dead no longer exists.
        if (!(error instanceof McpAbandonSupersededError)) throw error;
      }
    }
  }

  /** Public variant for the IPC layer: drop a server's credentials BEFORE
   * its config is removed, so a delete failure aborts the removal while
   * everything is still recoverable — instead of leaving an orphaned token
   * a same-id re-add would inherit. */
  async forgetServerCredentials(serverId: string): Promise<void> {
    await this.forgetAuthorization(serverId, this.connections.get(serverId)?.config);
  }

  /** Drops any stored OAuth record for a server that is being removed or
   * whose endpoint changed. A failure propagates — the callers must not
   * proceed as if the credentials were gone. Deliberately NOT gated on the
   * server's current kind: an offline edit can convert a credentialed
   * remote server to stdio, and skipping the erase for stdio would let the
   * stale record survive the id being freed for reuse. A stdio server with
   * NO stored record skips the erase entirely: writing a tombstone there
   * would grow the credential file by one junk record per removed stdio
   * server, guarding a resurrection no flow can attempt (flows only exist
   * for remote configs, and the remote-conversion case reads a record). */
  private async forgetAuthorization(
    serverId: string,
    config?: McpServerConfig,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    if (!this.coordinator) return;
    if (config && isMcpStdioConfig(config) && !(await this.coordinator.read(serverId))) return;
    await this.coordinator.erase(serverId, options);
  }

  /** Drops stored tokens and registration, returning the server to needs-auth. */
  async clearAuthorization(
    serverId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<McpServerStatus> {
    const { config } = this.requireRemoteEntry(serverId);
    this.interactiveRounds.delete(serverId);
    await this.forgetAuthorization(serverId, config, options);
    await this.reconnect(serverId).catch(() => {});
    const status = this.status(serverId);
    if (!status) throw new Error(`Unknown MCP server: ${serverId}`);
    return status;
  }

  private createClient(preference: McpProtocolPreference): {
    client: Client;
    events: McpClientEventBridge;
  } {
    let bufferedClientError: Error | undefined;
    let pendingToolsChanged: { error: Error | null } | undefined;
    let liveHandlers:
      | {
          onToolsChanged(error: Error | null): void;
        }
      | undefined;
    const client = new Client(
      { name: this.clientName, version: this.clientVersion },
      {
        capabilities: {},
        versionNegotiation: versionNegotiationFor(preference),
        inputRequired: { autoFulfill: false },
        enforceStrictCapabilities: false,
        listChanged: {
          tools: {
            autoRefresh: false,
            debounceMs: 0,
            onChanged: (error) => {
              if (liveHandlers) {
                liveHandlers.onToolsChanged(error);
              } else {
                pendingToolsChanged = { error };
              }
            },
          },
        },
      },
    );
    client.onerror = (error) => {
      // client.onerror is a client-wide transport channel. It can explain why
      // the SDK failed to auto-open a subscription during connect, but after
      // activation it cannot safely be attributed to that subscription.
      if (!liveHandlers) bufferedClientError = error;
    };
    return {
      client,
      events: {
        activate: (handlers) => {
          if (liveHandlers) throw new Error('MCP client event bridge is already active');
          liveHandlers = handlers;
          const result = {
            clientErrors: bufferedClientError ? [bufferedClientError] : [],
            ...(pendingToolsChanged ? { pendingToolsChanged } : {}),
          };
          bufferedClientError = undefined;
          pendingToolsChanged = undefined;
          return result;
        },
      },
    };
  }

  private handleToolsChanged(
    serverId: string,
    entry: Connection,
    client: Client,
    connectionGeneration: number,
    error: Error | null,
  ): void {
    if (!this.isCurrentClient(serverId, entry, client, connectionGeneration)) return;
    if (error) {
      const exposed = safeMcpOperationError(serverId, 'tool-list change signal failed', error);
      entry.refreshDiagnostic = errorMessage(exposed, this.secretsFor(serverId, entry.config));
      this.publishConnectionDiagnostics(entry);
      return;
    }
    void this.refreshToolsAfterNotification(serverId, entry, client, connectionGeneration).catch(
      (failure) => {
        if (!this.isCurrentClient(serverId, entry, client, connectionGeneration)) return;
        const diagnostic = errorMessage(failure, this.secretsFor(serverId, entry.config));
        if (entry.refreshDiagnostic === diagnostic) return;
        entry.refreshDiagnostic = diagnostic;
        this.publishConnectionDiagnostics(entry);
      },
    );
  }

  private observeSubscriptionClose(
    serverId: string,
    entry: Connection,
    client: Client,
    connectionGeneration: number,
    subscription: McpSubscription,
  ): void {
    void subscription.closed.then((reason) => {
      if (reason === 'local' || entry.subscription !== subscription) return;
      this.recordSubscriptionDiagnostic(
        serverId,
        entry,
        client,
        connectionGeneration,
        formatSubscriptionDiagnostic(serverId, `closed ${reason}`),
      );
    });
  }

  private recordSubscriptionDiagnostic(
    serverId: string,
    entry: Connection,
    client: Client,
    connectionGeneration: number,
    diagnostic: string,
  ): void {
    if (!this.isCurrentClient(serverId, entry, client, connectionGeneration)) return;
    entry.subscriptionDiagnostic = diagnostic;
    if (entry.status.state === 'connected') this.publishConnectionDiagnostics(entry);
  }

  private publishConnectionDiagnostics(entry: Connection): void {
    if (entry.status.state !== 'connected') return;
    this.update(entry, {
      ...entry.status,
      error: projectConnectionDiagnostics(entry),
      updatedAt: this.now(),
    });
  }

  private isCurrentClient(
    serverId: string,
    entry: Connection,
    client: Client,
    connectionGeneration: number,
  ): boolean {
    return (
      this.connections.get(serverId) === entry &&
      entry.client === client &&
      entry.connectionGeneration === connectionGeneration &&
      !entry.closing
    );
  }

  private async refreshToolLoop(
    serverId: string,
    entry: Connection,
    state: ToolRefreshState,
  ): Promise<ToolRefreshResult> {
    let latestSnapshot:
      | { entries: Map<string, ToolSnapshotEntry>; descriptors: McpToolDescriptor[] }
      | undefined;
    const finish = (
      snapshot: NonNullable<typeof latestSnapshot>,
      suppressed: boolean,
    ): ToolRefreshResult => ({
      descriptors: snapshot.descriptors.map(cloneTool),
      ...(state.initial ? { initialSnapshot: snapshot.entries } : {}),
      suppressed,
    });
    try {
      while (true) {
        const notificationPass = state.pendingNotification;
        state.pending = false;
        state.pendingNotification = false;
        if (notificationPass) {
          const notificationState = entry.refreshNotificationState;
          if (
            notificationState?.client !== state.client ||
            notificationState.connectionGeneration !== state.connectionGeneration
          ) {
            throw safeMcpOperationError(
              serverId,
              'connection changed during tool refresh',
              undefined,
            );
          }
          if (notificationState.suppressed) {
            if (state.initial && latestSnapshot) return finish(latestSnapshot, true);
            throw this.toolRefreshFrequencyError(serverId);
          }
          if (notificationState.refreshPasses >= MAX_TOOL_REFRESH_PASSES) {
            notificationState.suppressed = true;
            if (state.initial && latestSnapshot) return finish(latestSnapshot, true);
            throw this.toolRefreshFrequencyError(serverId);
          }
          notificationState.refreshPasses += 1;
        }
        let definitions: McpDiscoveredTool[] | undefined;
        let failure: unknown;
        try {
          definitions = shouldDiscoverTools(state.client)
            ? await listAllTools(state.client, serverId, this.timeouts.listToolsMs, state.signal)
            : [];
        } catch (error) {
          failure = error;
        }
        if (!this.ownsToolRefresh(serverId, entry, state)) {
          throw scrubbedError(
            safeMcpOperationError(serverId, 'connection changed during tool refresh', failure),
            this.secretsFor(serverId, entry.config),
          );
        }
        const notificationState = entry.refreshNotificationState;
        const notificationStateMatches =
          notificationState?.client === state.client &&
          notificationState.connectionGeneration === state.connectionGeneration;
        const refreshSuppressed = notificationStateMatches && notificationState.suppressed;
        if (failure !== undefined) {
          if (refreshSuppressed) throw this.toolRefreshFrequencyError(serverId);
          const exposed = safeMcpOperationError(serverId, 'tool refresh failed', failure);
          entry.refreshDiagnostic = errorMessage(exposed, this.secretsFor(serverId, entry.config));
          this.publishConnectionDiagnostics(entry);
          if (!this.ownsToolRefresh(serverId, entry, state)) {
            // The raw failure text (and its cause chain) can reflect request
            // material; this rejection leaves the manager like every other.
            throw scrubbedError(
              safeMcpOperationError(serverId, 'connection changed during tool refresh', failure),
              this.secretsFor(serverId, entry.config),
            );
          }
          if (state.pending) continue;
          // A 401 through the PUBLIC refresh path is the same authorization
          // loss as one through the notification path: the server must
          // leave `connected` and its snapshot must stop being callable
          // before the caller sees the error.
          if (!state.initial && isAuthRequiredError(failure)) this.markError(entry, failure);
          throw scrubbedError(exposed, this.secretsFor(serverId, entry.config));
        }
        if (!definitions) {
          if (refreshSuppressed) throw this.toolRefreshFrequencyError(serverId);
          if (state.pending) continue;
          throw new Error(`MCP server "${serverId}" returned no tool definitions`);
        }

        // Descriptions and schemas are server-authored and persist into the
        // status/capability surfaces — scrub them like any outbound text.
        const inventory = this.secretsFor(serverId, entry.config);
        const snapshot = createToolSnapshot(
          serverId,
          definitions,
          entry.enforceMcpHeaders,
          this.bindingManagerId,
          state.connectionGeneration,
          entry.toolSnapshot,
          (descriptor) => deepScrub(descriptor, inventory),
        );
        latestSnapshot = snapshot;
        if (notificationStateMatches) notificationState.lastPassCompletedAt = this.now();
        if (refreshSuppressed) {
          if (state.initial) return finish(snapshot, true);
          throw this.toolRefreshFrequencyError(serverId);
        }
        if (state.pending) continue;
        publishMcpHeaderExclusionWarning(snapshot.warning);
        entry.refreshDiagnostic = undefined;
        if (!state.initial) {
          this.replaceToolSnapshot(entry, snapshot.entries);
          this.update(entry, {
            ...entry.status,
            tools: snapshot.descriptors,
            toolCount: snapshot.descriptors.length,
            error: projectConnectionDiagnostics(entry),
            updatedAt: this.now(),
          });
          // A synchronous status listener can retire this generation during
          // publication. Never hand descriptors for that retired snapshot
          // back to the caller.
          if (!this.ownsToolRefresh(serverId, entry, state)) {
            throw safeMcpOperationError(
              serverId,
              'connection changed during tool refresh',
              undefined,
            );
          }
          if (state.pending) continue;
        }
        return finish(snapshot, false);
      }
    } finally {
      // Release the gate synchronously on every exit. A promise `.finally`
      // runs one microtask after settlement, so a refresh requested in that
      // window would join a settled promise and receive descriptors from a
      // list that started before it asked.
      if (entry.refreshState === state) entry.refreshState = undefined;
    }
  }

  private ownsToolRefresh(serverId: string, entry: Connection, state: ToolRefreshState): boolean {
    return (
      this.connections.get(serverId) === entry &&
      !entry.closing &&
      entry.client === state.client &&
      entry.connectionGeneration === state.connectionGeneration &&
      (entry.status.state === 'connected' || (state.initial && entry.status.state === 'connecting'))
    );
  }

  private toolRefreshFrequencyError(serverId: string): Error {
    return safeMcpOperationError(
      serverId,
      'tool refresh failed',
      new Error('tool list changed too frequently during discovery'),
    );
  }

  private watchClientClose(serverId: string, entry: Connection, client: Client): () => boolean {
    let closed = false;
    client.onclose = () => {
      closed = true;
      this.handleTransportClose(serverId, entry, client);
    };
    return () => closed;
  }

  private handleTransportClose(serverId: string, entry: Connection, client: Client): void {
    if (entry.closing || this.connections.get(serverId) !== entry || entry.client !== client) {
      return;
    }
    const subscription = entry.subscription;
    entry.client = undefined;
    entry.transport = undefined;
    entry.stdioTransport = undefined;
    entry.subscription = undefined;
    this.replaceToolSnapshot(entry, new Map());
    entry.connectionGeneration = undefined;
    entry.refreshState = undefined;
    entry.refreshNotificationState = undefined;
    entry.enforceMcpHeaders = false;
    entry.refreshDiagnostic = undefined;
    entry.subscriptionDiagnostic = undefined;
    void subscription?.close().catch(() => {});
    this.update(entry, {
      ...this.makeStatus(serverId, 'disconnected'),
      stderrTail: entry.status.stderrTail,
    });
  }

  private markError(entry: Connection, error: unknown): void {
    // Leaving `connected` invalidates the published tool bindings; dropping
    // the snapshot revises the callable set so stale capabilities cannot
    // survive in the Runtime Host.
    if (entry.status.state === 'connected' && entry.toolSnapshot.size > 0) {
      this.replaceToolSnapshot(entry, new Map());
    }
    // One lifecycle owner per connection generation: the failed generation
    // retires HERE. Keeping the old client on the entry would let a later
    // connect() overwrite these fields on success without closing it,
    // leaking its transport and its server-side session.
    const retiredClient = entry.client;
    const retiredTransport = entry.transport;
    entry.client = undefined;
    entry.transport = undefined;
    entry.stdioTransport = undefined;
    entry.connectionGeneration = undefined;
    entry.refreshState = undefined;
    entry.refreshNotificationState = undefined;
    if (retiredClient) void safeClose(retiredClient, retiredTransport).catch(() => {});
    if (isAuthRequiredError(error)) {
      this.update(entry, {
        ...entry.status,
        state: 'needs-auth',
        toolCount: 0,
        tools: [],
        error: undefined,
        updatedAt: this.now(),
      });
      return;
    }
    this.update(entry, {
      ...this.makeStatus(entry.status.serverId, 'error'),
      error: errorMessage(error, this.secretsFor(entry.status.serverId, entry.config)),
      stderrTail: entry.status.stderrTail,
    });
  }

  private update(entry: Connection, status: McpServerStatus): void {
    entry.status = status;
    this.emit(status);
  }

  private emit(status: McpServerStatus): void {
    for (const listener of this.listeners) listener(cloneStatus(status));
  }

  private requireConnection(serverId: string): Connection {
    const entry = this.connections.get(serverId);
    if (!entry) throw new Error(`Unknown MCP server: ${serverId}`);
    return entry;
  }

  private requireConnectionGeneration(serverId: string, entry: Connection): number {
    if (!entry.connectionGeneration) {
      throw new Error(`MCP server "${serverId}" has no active connection generation`);
    }
    return entry.connectionGeneration;
  }

  private replaceToolSnapshot(entry: Connection, snapshot: Map<string, ToolSnapshotEntry>): void {
    const nextIndex = new Map(this.bindingIndex);
    for (const previous of entry.toolSnapshot.values()) {
      const target = nextIndex.get(previous.binding);
      if (target?.connection === entry && target.snapshot === previous) {
        nextIndex.delete(previous.binding);
      }
    }
    for (const current of snapshot.values()) {
      if (nextIndex.has(current.binding)) {
        throw new Error('MCP tool binding collision');
      }
      nextIndex.set(current.binding, { connection: entry, snapshot: current });
    }
    const nextCallableSnapshot = this.buildCallableSnapshot(entry, snapshot);
    entry.toolSnapshot = snapshot;
    this.bindingIndex = nextIndex;
    this.callableSnapshot = nextCallableSnapshot;
  }

  private buildCallableSnapshot(
    replacedEntry: Connection,
    replacement: ReadonlyMap<string, ToolSnapshotEntry>,
  ): McpToolSnapshot {
    const entries = this.closed
      ? []
      : [...this.connections.values()]
          .filter((entry) => !entry.closing && entry.client && entry.connectionGeneration)
          .flatMap((entry) => [
            ...(entry === replacedEntry ? replacement : entry.toolSnapshot).values(),
          ]);
    const nextBindings = entries.map(({ binding }) => binding).sort(compareText);
    const previousBindings = this.callableSnapshot.tools
      .map(({ binding }) => binding)
      .sort(compareText);
    if (
      nextBindings.length === previousBindings.length &&
      nextBindings.every((binding, index) => binding === previousBindings[index])
    ) {
      return this.callableSnapshot;
    }
    if (this.callableSnapshot.revision >= Number.MAX_SAFE_INTEGER) {
      throw new Error('MCP tool snapshot revision exhausted');
    }
    const tools = entries.map(
      ({ descriptor, binding }) =>
        deepFreeze({ descriptor: cloneTool(descriptor), binding }) as McpBoundTool,
    );
    return Object.freeze({
      revision: this.callableSnapshot.revision + 1,
      tools: Object.freeze(tools),
    });
  }

  private allocateConnectionGeneration(): number {
    if (this.lastConnectionGeneration >= Number.MAX_SAFE_INTEGER) {
      throw new Error('MCP connection generation exhausted');
    }
    this.lastConnectionGeneration += 1;
    return this.lastConnectionGeneration;
  }

  private makeStatus(serverId: string, state: McpServerStatus['state']): McpServerStatus {
    return { serverId, state, toolCount: 0, tools: [], updatedAt: this.now() };
  }
}

async function listAllTools(
  client: Client,
  serverId: string,
  timeout: number,
  signal?: AbortSignal,
): Promise<McpDiscoveredTool[]> {
  return discoverMcpTools(
    {
      requestToolsPage: (cursor, timeoutMs) =>
        client.request(
          {
            method: 'tools/list',
            ...(cursor !== undefined ? { params: { cursor } } : {}),
          },
          { timeout: timeoutMs, signal },
        ),
    },
    serverId,
    timeout,
  );
}

function versionNegotiationFor(preference: McpProtocolPreference): VersionNegotiationOptions {
  switch (preference) {
    case 'legacy':
      return { mode: 'legacy' };
    case 'auto':
      return { mode: 'auto' };
    case '2026-07-28':
      return { mode: { pin: '2026-07-28' } };
  }
}

function readNegotiatedProtocol(client: Client): McpNegotiatedProtocol {
  const era = client.getProtocolEra();
  const revision = client.getNegotiatedProtocolVersion();
  if (!era || !revision) {
    throw new Error('MCP SDK connected without a negotiated protocol');
  }
  return { era, revision };
}

function shouldDiscoverTools(client: Client): boolean {
  return !(
    client.getProtocolEra() === 'modern' && client.getServerCapabilities()?.tools === undefined
  );
}

function shouldFallbackToLegacySse(options: {
  remoteConfig: McpRemoteServerConfig;
  error: unknown;
  signal: AbortSignal;
  producedProtocolEvidence: boolean;
}): boolean {
  const { remoteConfig, error, signal, producedProtocolEvidence } = options;
  return (
    (remoteConfig.transport ?? 'auto') === 'auto' &&
    resolveMcpRemoteProtocolPreference(remoteConfig) !== '2026-07-28' &&
    !producedProtocolEvidence &&
    !signal.aborted &&
    SdkHttpError.isInstance(error) &&
    error.code === SdkErrorCode.ClientHttpNotImplemented &&
    (error.status === 404 || error.status === 405)
  );
}

function createStreamableHandshakeEvidence(base: FetchLike = globalThis.fetch): {
  fetch: FetchLike;
  hasAcceptedInitialize(): boolean;
} {
  let acceptedInitialize = false;
  return {
    fetch: async (url, init) => {
      // SDK v2 emits notifications/initialized only after the initialize result
      // has passed wire validation and its server identity/capabilities have
      // been accepted. The SDK clears those getters when this notification's
      // HTTP request fails, so retain this one bit outside the Client lifecycle.
      if (readJsonRpcMethods(init?.body).includes('notifications/initialized')) {
        acceptedInitialize = true;
      }
      return base(url, init);
    },
    hasAcceptedInitialize: () => acceptedInitialize,
  };
}

function readJsonRpcMethods(body: BodyInit | null | undefined): string[] {
  if (typeof body !== 'string') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  return (Array.isArray(parsed) ? parsed : [parsed]).flatMap((message) =>
    isRecord(message) && typeof message.method === 'string' ? [message.method] : [],
  );
}

function formatSubscriptionDiagnostic(serverId: string, detail: string, cause?: unknown): string {
  return errorMessage(
    safeMcpOperationError(serverId, `tool-list subscription ${detail}`, cause, cause !== undefined),
  );
}

function projectConnectionDiagnostics(entry: Connection): string | undefined {
  const diagnostics = [entry.subscriptionDiagnostic, entry.refreshDiagnostic].filter(
    (value): value is string => Boolean(value),
  );
  if (diagnostics.length === 0) return undefined;
  return formatMcpDiagnosticText(diagnostics.join('\n'), MCP_ERROR_DIAGNOSTIC_CODE_POINTS);
}

function publishMcpHeaderExclusionWarning(warning: string | undefined): void {
  if (!warning) return;
  try {
    console.warn(warning);
  } catch {
    // A diagnostic sink cannot roll back an already-published Tool snapshot.
  }
}

function createToolSnapshot(
  serverId: string,
  definitions: readonly McpDiscoveredTool[],
  enforceMcpHeaders: boolean,
  managerId: string,
  connectionGeneration: number,
  previousEntries?: ReadonlyMap<string, ToolSnapshotEntry>,
  scrubDescriptor: (descriptor: McpToolDescriptor) => McpToolDescriptor = (descriptor) =>
    descriptor,
): {
  entries: Map<string, ToolSnapshotEntry>;
  descriptors: McpToolDescriptor[];
  warning?: string;
} {
  const tools = definitions.map(({ definition }) => definition);
  const partition = enforceMcpHeaders
    ? partitionMcpHeaderToolDefinitions(tools)
    : {
        valid: tools.map((tool) => ({ tool, declarations: [] })),
        rejected: [],
      };
  const warning = formatMcpHeaderExclusionWarning(partition.rejected);

  const entries = new Map<string, ToolSnapshotEntry>();
  const descriptors: McpToolDescriptor[] = [];
  const discoveredByName = new Map(
    definitions.map((definition) => [definition.definition.name, definition]),
  );
  for (const { tool, declarations } of partition.valid) {
    const discovered = discoveredByName.get(tool.name);
    if (!discovered) {
      throw new Error(`MCP server "${serverId}" lost Tool "${tool.name}" during validation`);
    }
    const definition = discovered.definition;
    const descriptor = scrubDescriptor(descriptorFromTool(serverId, definition));
    const definitionFingerprint = discovered.definitionFingerprint;
    const previous = previousEntries?.get(definition.name);
    const binding =
      previous?.connectionGeneration === connectionGeneration &&
      previous.definitionFingerprint === definitionFingerprint
        ? previous.binding
        : createMcpToolBinding({
            managerId,
            connectionGeneration,
            serverId,
            toolName: definition.name,
            definitionFingerprint,
          });
    entries.set(definition.name, {
      definition,
      definitionFingerprint,
      descriptor,
      binding,
      connectionGeneration,
      headerDeclarations: declarations.map((declaration) => ({
        ...declaration,
        path: [...declaration.path],
      })),
      ...(previous?.connectionGeneration === connectionGeneration &&
      previous.definitionFingerprint === definitionFingerprint &&
      previous.callPreparation
        ? { callPreparation: previous.callPreparation }
        : {}),
    });
    descriptors.push(descriptor);
  }
  return { entries, descriptors, ...(warning ? { warning } : {}) };
}

function descriptorFromTool(serverId: string, tool: Tool): McpToolDescriptor {
  return {
    serverId,
    name: tool.name,
    description: tool.description,
    inputSchema: structuredClone(tool.inputSchema),
    annotations: tool.annotations ? { ...tool.annotations } : undefined,
  };
}

function normalizeContent(value: unknown): McpContentBlock {
  if (!isRecord(value) || typeof value.type !== 'string') return { type: 'unknown', value };
  if (value.type === 'text' && typeof value.text === 'string')
    return { type: 'text', text: value.text };
  if (
    value.type === 'image' &&
    typeof value.data === 'string' &&
    typeof value.mimeType === 'string'
  ) {
    return { type: 'image', data: value.data, mimeType: value.mimeType };
  }
  if (
    value.type === 'audio' &&
    typeof value.data === 'string' &&
    typeof value.mimeType === 'string'
  ) {
    return { type: 'audio', data: value.data, mimeType: value.mimeType };
  }
  if (
    value.type === 'resource' &&
    isRecord(value.resource) &&
    typeof value.resource.uri === 'string'
  ) {
    return {
      type: 'resource',
      uri: value.resource.uri,
      mimeType: stringValue(value.resource.mimeType),
      text: stringValue(value.resource.text),
      blob: stringValue(value.resource.blob),
    };
  }
  if (value.type === 'resource_link' && typeof value.uri === 'string') {
    return {
      type: 'resource_link',
      uri: value.uri,
      name: stringValue(value.name),
      description: stringValue(value.description),
      mimeType: stringValue(value.mimeType),
    };
  }
  return { type: 'unknown', value };
}

function summarizeErrorContent(content: unknown[]): string {
  if (content.length > MAX_SUMMARIZED_ERROR_BLOCKS) return OVERSIZED_TOOL_ERROR_CONTENT;
  const fragments: string[] = [];
  let rawChars = 0;
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') continue;
    rawChars += block.text.length + (fragments.length > 0 ? 1 : 0);
    if (rawChars > MCP_DIAGNOSTIC_INPUT_CODE_UNITS) {
      return OVERSIZED_TOOL_ERROR_CONTENT;
    }
    fragments.push(block.text);
  }
  const text = fragments.join('\n').trim();
  return text || 'server reported an error';
}

export function buildStdioEnvironment(
  explicit: Record<string, string> = {},
  source = process.env,
  excludedKeys: readonly string[] = [],
): Record<string, string> {
  const result: Record<string, string> = {};
  const exact = new Set([
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'LANG',
    'TMPDIR',
    'SystemRoot',
    'COMSPEC',
    'PATHEXT',
    'WINDIR',
    'LOCALAPPDATA',
    'APPDATA',
    'TEMP',
    'TMP',
  ]);
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && (exact.has(key) || key.startsWith('LC_') || key.startsWith('XDG_')))
      result[key] = value;
  }
  const environment = { ...result, ...explicit };
  const excluded = new Set(excludedKeys.map((key) => key.toLowerCase()));
  for (const key of Object.keys(environment)) {
    if (excluded.has(key.toLowerCase())) delete environment[key];
  }
  return environment;
}

function attachStderrTail(
  transport: StdioClientTransport,
  entry: Connection,
  secrets: SecretInventory,
  onUpdate: () => void,
): void {
  let pending = '';
  let oversized = false;
  let discardingContinuation = false;
  let physicalSuffix = '';
  const append = (lines: string[]) => {
    const rendered = lines
      .map((line) => formatMcpDiagnosticText(scrubKnownSecrets(line, secrets), STDERR_LINE_CHARS))
      .filter(Boolean);
    if (rendered.length === 0) return;
    const next = [...(entry.status.stderrTail ?? []), ...rendered]
      .filter(Boolean)
      .slice(-STDERR_LINES);
    entry.status = { ...entry.status, stderrTail: next, updatedAt: Date.now() };
    onUpdate();
  };
  const retain = (batch: string[], value: string) => {
    if (!value) return;
    batch.push(value);
    if (batch.length > STDERR_LINES) batch.splice(0, batch.length - STDERR_LINES);
  };
  const consume = (value: string, endOfLine: boolean, batch: string[]) => {
    physicalSuffix = value.length >= 2 ? value.slice(-2) : `${physicalSuffix}${value}`.slice(-2);
    if (!oversized && !discardingContinuation) {
      const remaining = MCP_DIAGNOSTIC_INPUT_CODE_UNITS - pending.length;
      if (value.length > remaining) {
        pending = '';
        oversized = true;
      } else {
        pending += value;
      }
    }
    if (!endOfLine) return;
    const continued = physicalSuffix.endsWith('\\') || physicalSuffix.endsWith('\\\r');
    if (discardingContinuation) {
      if (!continued) {
        retain(batch, STDERR_CONTINUATION);
        discardingContinuation = false;
      }
    } else if (continued) {
      pending = '';
      oversized = false;
      discardingContinuation = true;
    } else if (oversized) {
      retain(batch, STDERR_OVERSIZED_LINE);
    } else {
      retain(batch, pending.endsWith('\r') ? pending.slice(0, -1) : pending);
    }
    pending = '';
    if (!discardingContinuation) oversized = false;
    physicalSuffix = '';
  };
  const stream = transport.stderr;
  stream?.on('data', (chunk) => {
    const batch: string[] = [];
    const value = String(chunk);
    let offset = 0;
    for (let newline = value.indexOf('\n', offset); newline >= 0; ) {
      consume(value.slice(offset, newline), true, batch);
      offset = newline + 1;
      newline = value.indexOf('\n', offset);
    }
    consume(value.slice(offset), false, batch);
    append(batch);
  });
  const flush = () => {
    if (!pending && !oversized && !discardingContinuation) return;
    const batch: string[] = [];
    retain(
      batch,
      discardingContinuation ? STDERR_CONTINUATION : oversized ? STDERR_OVERSIZED_LINE : pending,
    );
    append(batch);
    pending = '';
    oversized = false;
    discardingContinuation = false;
    physicalSuffix = '';
  };
  stream?.once('end', flush);
  stream?.once('close', flush);
}

function enrichStdioError(
  error: unknown,
  stderrTail: string[] | undefined,
  secrets: SecretInventory = EMPTY_INVENTORY,
): Error {
  const suffix = stderrTail?.length ? `\nstderr:\n${stderrTail.join('\n')}` : '';
  return new Error(`${errorMessage(error, secrets)}${suffix}`, { cause: error });
}

async function safeClose(
  client?: Client,
  transport?: Transport,
  subscription?: McpSubscription,
): Promise<void> {
  const subscriptionClose = subscription?.close().catch(() => {});
  await Promise.all([
    subscriptionClose,
    client?.close().catch(() => {}),
    transport?.close().catch(() => {}),
  ]);
}

async function connectRemoteCandidate(
  client: Client,
  transport: Transport,
  timeout: number,
  signal: AbortSignal,
): Promise<void> {
  const closeOnAbort = () => {
    // SDK v2's server/discover probe currently uses its timeout but not the
    // Client.connect signal. Closing the candidate transport aborts that probe
    // instead of leaving a late handshake running after manager cancellation.
    void transport.close().catch(() => {});
  };
  if (signal.aborted) {
    await transport.close().catch(() => {});
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error(String(signal.reason ?? 'MCP connection aborted'));
  }
  signal.addEventListener('abort', closeOnAbort, { once: true });
  try {
    await client.connect(transport, { timeout, signal });
  } finally {
    signal.removeEventListener('abort', closeOnAbort);
  }
}

/** True when a reconfigured server no longer talks to the endpoint its
 * stored credentials were issued for: the URL changed, or the entry
 * switched between stdio and remote. A headers-only edit returns false. */
function remoteUrlChanged(previous: McpServerConfig, next: McpServerConfig): boolean {
  const previousStdio = isMcpStdioConfig(previous);
  const nextStdio = isMcpStdioConfig(next);
  if (previousStdio || nextStdio) return previousStdio !== nextStdio;
  return previous.url !== next.url;
}

function stableConfigFingerprint(config: McpServerConfig): string {
  return JSON.stringify(sortValue(config));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortValue(value[key])]),
  );
}

function cloneStatus(status: McpServerStatus): McpServerStatus {
  return {
    ...status,
    negotiatedProtocol: status.negotiatedProtocol ? { ...status.negotiatedProtocol } : undefined,
    tools: status.tools.map(cloneTool),
    stderrTail: status.stderrTail?.slice(),
  };
}

function cloneTool(tool: McpToolDescriptor): McpToolDescriptor {
  return {
    ...tool,
    inputSchema: structuredClone(tool.inputSchema),
    annotations: tool.annotations ? { ...tool.annotations } : undefined,
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

type SecretInventory = McpSecretInventory;

const EMPTY_INVENTORY = EMPTY_MCP_SECRET_INVENTORY;
const MIN_SUBSTITUTION_LENGTH = MCP_SECRET_MIN_SUBSTITUTION_LENGTH;

function errorMessage(error: unknown, secrets: SecretInventory = EMPTY_INVENTORY): string {
  // Scrub before the diagnostic formatter truncates: a secret straddling
  // the truncation boundary would otherwise leave a matching prefix behind.
  const raw = error instanceof Error ? error.message : String(error);
  return formatMcpDiagnosticText(scrubKnownSecrets(raw, secrets), MCP_ERROR_DIAGNOSTIC_CODE_POINTS);
}

/** The shared secret-location plan (@maka/core/mcp-secrets) is the single
 * authority for which config positions carry credentials; this derives the
 * scrub inventory from it. */
function collectConfigSecrets(config: McpServerConfig): SecretInventory {
  return mcpSecretInventory(config);
}

function scrubKnownSecrets(message: string, secrets: SecretInventory): string {
  return scrubKnownMcpSecrets(message, secrets);
}

/** Rebuilds an outbound error with its message scrubbed of the given secret
 * values. The cause chain is dropped deliberately: causes carry the raw
 * upstream messages this exists to contain. */
function scrubbedError(error: unknown, secrets: SecretInventory): Error {
  const scrubbed = new Error(errorMessage(error, secrets));
  if (error instanceof Error) {
    scrubbed.name = error.name;
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'number') (scrubbed as { code?: number }).code = code;
  }
  // The cause chain is dropped, but the auth signal it carried must survive
  // the scrub — the notification handler and every caller key off it to
  // turn a 401 into needs-auth instead of a dead-end error.
  if (isAuthRequiredError(error) && !isAuthRequiredError(scrubbed)) {
    scrubbed.name = 'UnauthorizedError';
  }
  return scrubbed;
}

function deepScrub<T>(value: T, secrets: SecretInventory): T {
  return deepScrubMcpSecrets(value, secrets);
}

/** Asks the endpoint for its current WWW-Authenticate challenge with an
 * unauthenticated request. GET first (the SSE stream), then — because a
 * Streamable HTTP server may answer GET with 405 and only challenge the
 * initialize POST — an initialize POST. Best-effort: a server that answers
 * 401 to neither simply yields no challenge context. */
async function probeAuthChallenge(
  serverUrl: string,
  fetchImpl: typeof fetch,
): Promise<{ scope?: string; resourceMetadataUrl?: URL } | undefined> {
  const attempts: RequestInit[] = [
    { method: 'GET', headers: { accept: 'text/event-stream, application/json' } },
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          // The SDK's current version, not a pinned literal: a server that
          // only accepts the current protocol would 400 an outdated probe
          // and the challenge (with its scope) would never be seen.
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'maka-challenge-probe', version: '0' },
        },
      }),
    },
  ];
  for (const init of attempts) {
    const challenge = await probeOnce(serverUrl, fetchImpl, init);
    // A 401 whose WWW-Authenticate carried no usable parameters is not an
    // answer — the POST attempt may still surface scope/metadata.
    if (challenge && (challenge.scope || challenge.resourceMetadataUrl)) return challenge;
  }
  return undefined;
}

async function probeOnce(
  serverUrl: string,
  fetchImpl: typeof fetch,
  init: RequestInit,
): Promise<{ scope?: string; resourceMetadataUrl?: URL } | undefined> {
  try {
    const response = await fetchImpl(serverUrl, init);
    await response.body?.cancel().catch(() => {});
    if (response.status !== 401) {
      // If the unauthenticated initialize actually succeeded, the server
      // may have opened a session for the probe; close it politely.
      const sessionId = response.headers.get('mcp-session-id');
      if (sessionId) {
        await fetchImpl(serverUrl, {
          method: 'DELETE',
          headers: { 'mcp-session-id': sessionId },
        })
          .then((cleanup) => cleanup.body?.cancel())
          .catch(() => {});
      }
      return undefined;
    }
    return extractWWWAuthenticateParams(response);
  } catch {
    return undefined;
  }
}

const MAX_FETCH_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** Credential-bearing headers a cross-origin redirect must shed — the rule
 * undici applies to Authorization on its own, re-created here because the
 * manual redirect loop takes over hop handling (and the SDK's authProvider
 * injects Authorization after config headers are scoped). */
// The MCP session identifier is a credential too: an established Streamable
// HTTP transport sends it on every request, and a 307/308 to another origin
// would hand the live session to that origin. `last-event-id` rides along —
// it exposes resumable stream position for that session.
const CREDENTIAL_HEADERS = [
  'authorization',
  'cookie',
  'proxy-authorization',
  'mcp-session-id',
  'last-event-id',
];

/** Every URL this client will actually talk to — the endpoint, its
 * redirects, and the OAuth discovery/registration/token endpoints the SDK
 * routes through the same fetch — must not carry credentials over
 * cleartext off the machine. Mirrors the config store's rule for the
 * endpoint URL itself. */

/** Wraps fetch so credentials stay scoped hop by hop: configured resource
 * headers ride only requests to the MCP endpoint's own origin, any redirect
 * that leaves an origin sheds Authorization/Cookie for the rest of the
 * chain, and no hop may downgrade to non-loopback cleartext http. Redirects
 * are followed manually because undici forwards custom headers (an
 * X-API-Key) across a cross-origin 307, and the SDK routes OAuth discovery /
 * registration / token calls through this same fetch. */
function scopedFetch(
  serverUrl: URL,
  headers: Record<string, string> | undefined,
  signal?: AbortSignal,
): typeof fetch {
  const configured = headers ?? {};
  const guardedKeys = Object.keys(configured).map((key) => key.toLowerCase());
  const provenance: UrlProvenance = urlProvenance(serverUrl);
  const initFor = (
    target: URL,
    init: RequestInit | undefined,
    credentialsShed: boolean,
  ): RequestInit => {
    const merged = new Headers(init?.headers);
    if (target.origin === serverUrl.origin) {
      for (const [key, value] of Object.entries(configured)) {
        if (!merged.has(key)) merged.set(key, value);
      }
    } else {
      for (const key of guardedKeys) merged.delete(key);
    }
    if (credentialsShed) {
      for (const key of CREDENTIAL_HEADERS) merged.delete(key);
    }
    return {
      ...init,
      headers: merged,
      redirect: 'manual',
      // The round's deadline aborts in-flight requests too, not only the
      // caller's await: a hung endpoint must not keep the flow alive.
      ...(signal ? { signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal } : {}),
    };
  };
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    // The SDK's transports and auth flows always call (url, init); a
    // preassembled Request would hide its headers and body from the
    // per-hop policy, so refuse rather than guess.
    if (typeof input !== 'string' && !(input instanceof URL)) {
      throw new Error('MCP scoped fetch requires a URL input');
    }
    let target = new URL(input);
    let request = init;
    // Once any hop crosses an origin, credential headers stay off for the
    // remainder of the chain — even if it bounces back.
    let credentialsShed = false;
    for (let hop = 0; hop <= MAX_FETCH_REDIRECTS; hop += 1) {
      assertTransportSecurity(target, provenance);
      const response = await fetch(target, initFor(target, request, credentialsShed));
      if (!REDIRECT_STATUSES.has(response.status)) return response;
      const location = response.headers.get('location');
      if (!location) return response;
      await response.body?.cancel().catch(() => {});
      const method = (request?.method ?? 'GET').toUpperCase();
      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) && method === 'POST')
      ) {
        request = { ...request, method: 'GET', body: undefined };
      } else if (
        request?.body !== undefined &&
        request.body !== null &&
        typeof request.body !== 'string'
      ) {
        // A stream body cannot be replayed for the next hop.
        throw new Error(`MCP request to ${target.origin} was redirected and cannot be resent`);
      }
      const next = new URL(location, target);
      if (next.origin !== target.origin) credentialsShed = true;
      target = next;
    }
    throw new Error(`MCP request exceeded ${MAX_FETCH_REDIRECTS} redirects`);
  }) as typeof fetch;
}

/** True when the failure means "the server wants the user to log in":
 * our own refusal to open a browser mid-connect, the SDK's
 * UnauthorizedError, or a raw 401 from either remote transport (matched by
 * name — the error may cross package boundaries where instanceof breaks).
 * Walks the cause chain. */
function isAuthRequiredError(error: unknown): boolean {
  for (let current = error; current instanceof Error; current = current.cause as Error) {
    if (current instanceof McpAuthRequiredError) return true;
    if (current.name === 'UnauthorizedError' || current.name === 'McpAuthRequiredError')
      return true;
    const code = (current as { code?: unknown }).code;
    const status = (current as { status?: unknown }).status;
    if (
      (code === 401 || status === 401) &&
      (current.name === 'StreamableHTTPError' ||
        current.name === 'SseError' ||
        current.name === 'SdkHttpError')
    ) {
      return true;
    }
  }
  return false;
}

function safeMcpOperationError(
  serverId: string,
  operation: string,
  cause: unknown,
  includeCause = cause !== undefined,
): Error {
  const prefix = `MCP server ${JSON.stringify(formatMcpDiagnosticText(serverId))} ${operation}`;
  const message = includeCause ? `${prefix}: ${errorMessage(cause)}` : prefix;
  return new Error(formatMcpDiagnosticText(message, MCP_ERROR_DIAGNOSTIC_CODE_POINTS), { cause });
}

function withoutAuthorizationHeader(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const filtered = Object.fromEntries(
    Object.entries(headers).filter(([key]) => key.toLowerCase() !== 'authorization'),
  );
  return filtered;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Rebuilds an outbound error cause with only its typed identity: name,
 * numeric/string code, HTTP status, and the SDK's brand symbols (what
 * `SdkError.isInstance` keys on) survive; the message is scrubbed and the
 * deeper cause chain and any payload fields (response bodies, request data)
 * are dropped — those are where an endpoint's reflection of credential
 * material hides. */
function sanitizedCause(error: unknown, secrets: SecretInventory): Error | undefined {
  if (!(error instanceof Error)) return undefined;
  if (error instanceof AggregateError) {
    // A connect failure aggregates one error per attempted transport;
    // keeping the shape (with each member sanitized) preserves the
    // diagnosability the aggregate exists for.
    const clean = new AggregateError(
      error.errors.map((item) => sanitizedCause(item, secrets)).filter(Boolean) as Error[],
      scrubKnownSecrets(error.message, secrets),
    );
    clean.name = error.name;
    return clean;
  }
  const clean = new Error(scrubKnownSecrets(error.message, secrets));
  clean.name = error.name;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'number' || typeof code === 'string') {
    (clean as { code?: unknown }).code = code;
  }
  const status = (error as { status?: unknown }).status;
  if (typeof status === 'number') (clean as { status?: unknown }).status = status;
  for (const symbol of Object.getOwnPropertySymbols(error)) {
    const descriptor = Object.getOwnPropertyDescriptor(error, symbol);
    if (descriptor) Object.defineProperty(clean, symbol, descriptor);
  }
  return clean;
}

/** Internal sentinel: the pending round this abandon targeted was replaced
 * by a newer one before the clearing write landed. */
class McpAbandonSupersededError extends Error {
  constructor() {
    super('MCP authorization round was superseded before it could be abandoned');
    this.name = 'McpAbandonSupersededError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
