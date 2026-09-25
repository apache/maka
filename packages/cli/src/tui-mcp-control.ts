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
  AtomicFileWriteCommitUnknownError,
  McpConfigRevisionConflictError,
  createMcpConfigStore,
  updateMcpConfiguration,
  McpConfigurationValidationError,
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

import { McpCapabilityPublication } from './mcp-capability-publication.js';

const RUNTIME_HOST_CREDENTIAL_ENV = 'MAKA_RUNTIME_HOST_ACCESS_CREDENTIAL';
const MCP_ACTION_TIMEOUT_MS = 90_000;
const MCP_ACTION_CLEANUP_RESERVE_MS = 5_000;

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
  readonly configuration: 'ready' | 'synchronizing' | 'committing' | 'out_of_sync';
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
  | {
      readonly kind: 'add';
      readonly serverId: string;
      readonly config: McpServerConfig;
    }
  | {
      readonly kind: 'edit';
      readonly serverId: string;
      readonly config: McpServerConfig;
      readonly expectedRevision: string;
    }
  | { readonly kind: 'commit_import'; readonly previewId: string }
  | {
      readonly kind: 'set_enabled';
      readonly serverId: string;
      readonly enabled: boolean;
    }
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
  | {
      readonly status: 'pending';
      readonly reason: 'commit-pending';
      readonly completion: Promise<TuiMcpActionResult>;
    }
  | {
      readonly status: 'tested';
      readonly test: McpTestResult;
      readonly effect: TuiMcpActionEffect;
    }
  | {
      readonly status: 'failed';
      readonly reason: 'commit-unknown';
      readonly cause: AtomicFileWriteCommitUnknownError;
      readonly reconciliationError?: unknown;
    }
  | {
      readonly status: 'conflict';
      readonly reason: 'exists' | 'stale_config' | 'stale_edit' | 'stale_import' | 'missing';
    }
  | {
      readonly status: 'failed';
      readonly reason:
        | 'closed'
        | 'cancelled'
        | 'invalid-config'
        | 'credential-cleanup-failed'
        | 'publication-credential-failed'
        | 'commit-in-progress'
        | 'persist-failed'
        | 'rollback-failed'
        | 'manager-failed';
    };

export interface TuiMcpManagement extends TuiMcpSurface {
  configForEdit(serverId: string): TuiMcpEditConfig | undefined;
  previewImport(source: string): TuiMcpImportPreviewResult;
  discardImportPreview(previewId: string): void;
  execute(
    action: TuiMcpAction,
    options?: { readonly signal?: AbortSignal },
  ): Promise<TuiMcpActionResult>;
}

export interface TuiMcpController extends TuiMcpManagement {
  close(): Promise<void>;
}

type TuiMcpManager = Pick<
  McpClientManager,
  'sync' | 'statuses' | 'toolSnapshot' | 'callTool' | 'onChange' | 'test' | 'reconnect' | 'close'
> &
  Pick<McpClientManager, 'forgetServerCredentials'> & {
    disconnect?(
      serverId: string,
      remove?: boolean,
      options?: { signal?: AbortSignal },
    ): Promise<void>;
  };

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
  setCredential?(credential: string, options?: { readonly signal?: AbortSignal }): Promise<void>;
  removeCredential?(options?: { readonly signal?: AbortSignal }): Promise<void>;
  closePublication?(): Promise<void>;
}

interface TuiMcpControllerDeps {
  readonly configStore: Pick<McpConfigStore, 'get' | 'transform' | 'subscribeChanges'>;
  readonly manager: TuiMcpManager;
  readonly createProvider: (manager: TuiMcpManager) => ClientCapabilityProvider | undefined;
  readonly actionTimeoutMs: number;
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
    actionTimeoutMs: overrides.actionTimeoutMs ?? MCP_ACTION_TIMEOUT_MS,
  });
}

class TuiMcpControllerImpl implements TuiMcpController {
  readonly #connection: TuiMcpPublicationTarget;
  readonly #deps: TuiMcpControllerDeps;
  readonly #listeners = new Set<() => void>();
  readonly #disposeManagerChange: () => void;
  readonly #disposeConnectionAvailability: () => void;
  readonly #disposeConfigChanges: () => void;
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
  #pendingCommit: Promise<TuiMcpActionResult> | undefined;
  readonly #mutationVersions = new Map<string, symbol>();
  readonly #lifetimeAbort = new AbortController();
  #publicationSuppressed = false;
  readonly #publication: McpCapabilityPublication;
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
    this.#publication = new McpCapabilityPublication({
      connectionIdentity: () =>
        this.#availability.kind === 'connected'
          ? connectionIdentity(this.#availability)
          : undefined,
      revision: () => this.#deps.manager.toolSnapshot().revision,
      createProvider: () => this.#deps.createProvider(this.#deps.manager),
      replace: (provider) => this.#connection.replaceClientCapabilities(provider),
      unregister: () => this.#connection.unregisterClientCapabilities(),
      onState: (state) => {
        this.#updateSnapshot({
          publication:
            state === 'unavailable'
              ? this.#availability.kind === 'unavailable'
                ? (this.#availability.reason ?? 'host_unavailable')
                : 'waiting'
              : state,
        });
      },
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
          this.#publication.invalidate();
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
    // Desktop edits the same file. A change during startup waits for it
    // rather than being dropped, since startup may have read the file first.
    // Failing to follow leaves the TUI's own edits working, so it stays quiet
    // rather than print over the screen.
    this.#disposeConfigChanges = deps.configStore.subscribeChanges((error) => {
      if (error) return;
      void this.#initialization
        .then(() => this.#serializeAction(() => this.#followConfigChange()))
        .catch(() => undefined);
    });
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
    return {
      config: structuredClone(config),
      revision: configRevision(config),
    };
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

  execute(
    action: TuiMcpAction,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<TuiMcpActionResult> {
    if (this.#closed) return Promise.resolve({ status: 'failed', reason: 'closed' });
    if (this.#pendingCommit)
      return Promise.resolve({
        status: 'failed',
        reason: 'commit-in-progress',
      });
    return this.#serializeAction(async () => {
      if (this.#pendingCommit)
        return {
          status: 'failed',
          reason: 'commit-in-progress',
        };
      const cleanupReserveMs = Math.min(
        MCP_ACTION_CLEANUP_RESERVE_MS,
        Math.max(1, Math.floor(this.#deps.actionTimeoutMs / 10)),
      );
      const operationDeadline = AbortSignal.timeout(
        Math.max(1, this.#deps.actionTimeoutMs - cleanupReserveMs),
      );
      const signals = [this.#lifetimeAbort.signal, operationDeadline];
      if (options.signal) signals.push(options.signal);
      const signal = AbortSignal.any(signals);
      return this.#executeAction(action, signal, cleanupReserveMs);
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#lifetimeAbort.abort(new Error('MCP controller closed'));
    this.#disposeManagerChange();
    this.#disposeConnectionAvailability();
    this.#disposeConfigChanges();
    this.#listeners.clear();
    this.#preparedImport = undefined;
    const publicationClosing = this.#publication.close().catch(() => undefined);
    const managerClosing = this.#deps.manager.close();
    await this.#actionLane.catch(() => undefined);
    await this.#pendingCommit;
    this.#config = undefined;
    await publicationClosing;
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
      this.#updateSnapshot({
        initialization: 'error',
        publication: 'not_published',
      });
    }
  }

  #serializeAction<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#actionLane.then(work, work);
    this.#actionLane = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #executeAction(
    action: TuiMcpAction,
    signal?: AbortSignal,
    cleanupTimeoutMs?: number,
  ): Promise<TuiMcpActionResult> {
    if (this.#closed) return { status: 'failed', reason: 'closed' };
    if (signal?.aborted) return { status: 'failed', reason: 'cancelled' };
    if (action.kind === 'set_publication_credential') {
      if (!this.#connection.setCredential) {
        return { status: 'failed', reason: 'publication-credential-failed' };
      }
      const operation = this.#connection.setCredential(action.credential, {
        signal,
      });
      try {
        await waitForAbort(operation, signal);
        throwIfAborted(signal);
        const effect = await this.#settlePublication(signal);
        throwIfAborted(signal);
        return { status: 'applied', effect };
      } catch (error) {
        if (signal?.aborted) {
          return this.#settleCancelledCredentialOperation(
            operation,
            signal,
            true,
            cleanupTimeoutMs,
          );
        }
        if (error === signal?.reason) return { status: 'failed', reason: 'cancelled' };
        return { status: 'failed', reason: 'publication-credential-failed' };
      }
    }
    if (action.kind === 'remove_publication_credential') {
      if (!this.#connection.removeCredential) {
        return { status: 'failed', reason: 'publication-credential-failed' };
      }
      const operation = this.#connection.removeCredential({ signal });
      try {
        await waitForAbort(operation, signal);
        throwIfAborted(signal);
        return { status: 'applied', effect: 'pending_host' };
      } catch (error) {
        if (signal?.aborted) {
          return this.#settleCancelledCredentialOperation(
            operation,
            signal,
            false,
            cleanupTimeoutMs,
          );
        }
        if (error === signal?.reason) return { status: 'failed', reason: 'cancelled' };
        return { status: 'failed', reason: 'publication-credential-failed' };
      }
    }
    if (action.kind === 'test') {
      try {
        const test = await waitForAbort(
          this.#deps.manager.test(action.serverId, { signal }),
          signal,
        );
        throwIfAborted(signal);
        const effect = await this.#settlePublication(signal);
        throwIfAborted(signal);
        return { status: 'tested', test, effect };
      } catch (error) {
        if (signal?.aborted) {
          const cleaned = await this.#settleCancelledConnection(
            action.serverId,
            cleanupSignal(cleanupTimeoutMs),
          );
          this.#refreshManagerSnapshot();
          const publicationCleaned = cleaned
            ? await this.#settleCancelledPublication(cleanupSignal(cleanupTimeoutMs))
            : false;
          return {
            status: 'failed',
            reason: cleaned && publicationCleaned ? 'cancelled' : 'manager-failed',
          };
        }
        return { status: 'failed', reason: 'manager-failed' };
      }
    }
    if (action.kind === 'reconnect') {
      try {
        await waitForAbort(this.#deps.manager.reconnect(action.serverId, { signal }), signal);
        throwIfAborted(signal);
        const effect = await this.#settlePublication(signal);
        throwIfAborted(signal);
        return { status: 'applied', effect };
      } catch (error) {
        if (signal?.aborted) {
          const cleaned = await this.#settleCancelledConnection(
            action.serverId,
            cleanupSignal(cleanupTimeoutMs),
          );
          this.#refreshManagerSnapshot();
          const publicationCleaned = cleaned
            ? await this.#settleCancelledPublication(cleanupSignal(cleanupTimeoutMs))
            : false;
          return {
            status: 'failed',
            reason: cleaned && publicationCleaned ? 'cancelled' : 'manager-failed',
          };
        }
        this.#refreshManagerSnapshot();
        return { status: 'failed', reason: 'manager-failed' };
      }
    }
    const result = await this.#commitMutation(action, signal, cleanupTimeoutMs);
    if (action.kind === 'commit_import') this.discardImportPreview(action.previewId);
    return result;
  }

  async #commitMutation(
    action: Exclude<
      TuiMcpAction,
      | { kind: 'test' | 'reconnect' }
      | { kind: 'set_publication_credential' | 'remove_publication_credential' }
    >,
    signal?: AbortSignal,
    cleanupTimeoutMs?: number,
  ): Promise<TuiMcpActionResult> {
    let previous: McpConfigFile | undefined;
    let changedIds: string[] = [];
    let committed: McpConfigFile;
    let credentialRetirementStarted = false;
    const mutationVersion = Symbol('MCP mutation');
    let touchedIds: string[] = [];
    let lateSettlement: Promise<unknown> | undefined;
    const releaseOwnership = () => {
      for (const serverId of touchedIds) {
        if (this.#mutationVersions.get(serverId) === mutationVersion) {
          this.#mutationVersions.delete(serverId);
        }
      }
    };
    const commitReceipt: { revision?: string } = {};
    let credentialRetirementFailed = false;
    const transaction = updateMcpConfiguration(
      this.#deps.configStore,
      (current, transaction) => {
        commitReceipt.revision = transaction?.writeRevision;
        if (this.#closed) {
          throw new TuiMcpMutationError({ status: 'failed', reason: 'closed' });
        }
        if (signal?.aborted) {
          throw new TuiMcpMutationError({ status: 'failed', reason: 'cancelled' });
        }
        const prepared = this.#prepareMutation(current, action);
        if ('status' in prepared) throw new TuiMcpMutationError(prepared);
        const { next } = prepared;
        previous = cloneConfig(current);
        changedIds = changedServerIds(current, next);
        // Same-value retries still own their target. A content hash alone
        // cannot distinguish them from the write an older action compensates.
        touchedIds =
          action.kind === 'commit_import'
            ? Object.keys(this.#preparedImport!.imported.mcpServers)
            : [action.serverId];
        for (const serverId of touchedIds) this.#mutationVersions.set(serverId, mutationVersion);
        return next;
      },
      async (serverId, previous) => {
        if (credentialRetirementFailed) return;
        try {
          // The manager owns the erase fence. Once credential storage has
          // entered its write phase, let that operation settle before this
          // transaction reports cancellation; an outer abort race here could
          // otherwise leave a tombstone landing after rollback has begun.
          await this.#deps.manager.forgetServerCredentials(serverId, previous, {
            signal: credentialRetirementStarted ? undefined : signal,
            onCommitStarted: () => {
              credentialRetirementStarted = true;
            },
          });
        } catch (error) {
          if (error instanceof TuiMcpMutationError) throw error;
          if (credentialRetirementStarted) {
            // The erase may already be durable even when its promise rejects.
            // Commit the new config and let manager.sync retry retirement
            // before it adopts or connects the new endpoint.
            credentialRetirementFailed = true;
            return;
          }
          throw new TuiMcpMutationError({
            status: 'failed',
            reason: signal?.aborted ? 'cancelled' : 'credential-cleanup-failed',
          });
        }
      },
    );
    try {
      try {
        committed = await waitForAbort(transaction, signal);
      } catch (error) {
        if (error instanceof TuiMcpMutationError) return error.result;
        if (error instanceof McpConfigurationValidationError)
          return { status: 'failed', reason: 'invalid-config' };
        if (error instanceof AtomicFileWriteCommitUnknownError) {
          return this.#reconcilePublishedMutation(error, signal, cleanupTimeoutMs);
        }
        if (this.#closed || signal?.aborted) {
          const cleanup = cleanupSignal(cleanupTimeoutMs);
          try {
            committed = await waitForAbort(transaction, cleanup);
          } catch (settlementError) {
            if (settlementError instanceof TuiMcpMutationError) return settlementError.result;
            if (settlementError instanceof McpConfigurationValidationError)
              return { status: 'failed', reason: 'invalid-config' };
            if (settlementError instanceof AtomicFileWriteCommitUnknownError) {
              return this.#reconcilePublishedMutation(settlementError, signal, cleanupTimeoutMs);
            }
            if (credentialRetirementStarted) {
              if (settlementError !== cleanup?.reason) {
                this.#publicationSuppressed = false;
                this.#updateSnapshot({ configuration: 'out_of_sync' });
                this.#refreshManagerSnapshot();
                return { status: 'failed', reason: 'persist-failed' };
              }
              // Keep ownership of the irreversible write, but release the
              // foreground wait with an honest pending result. New actions are
              // refused until settlement and bounded reconciliation complete.
              const completion = this.#settlePendingCommit(
                transaction,
                () => changedIds,
                cleanupTimeoutMs,
              );
              lateSettlement = completion;
              return { status: 'pending', reason: 'commit-pending', completion };
            } else {
              lateSettlement = this.#scheduleLateMutationRollback(
                transaction,
                () => previous,
                () => changedIds,
                mutationVersion,
                commitReceipt,
                signal,
                cleanupTimeoutMs,
              );
              this.#publicationSuppressed = false;
              this.#updateSnapshot({ configuration: 'out_of_sync' });
              return { status: 'failed', reason: 'rollback-failed' };
            }
          }
          if (!credentialRetirementStarted) {
            const rolledBack = await this.#rollbackCancelledMutation(
              previous,
              committed,
              changedIds,
              cleanup,
              mutationVersion,
              commitReceipt.revision,
            );
            if (!rolledBack) return { status: 'failed', reason: 'rollback-failed' };
            return {
              status: 'failed',
              reason: this.#closed ? 'closed' : 'cancelled',
            };
          }
        } else {
          if (credentialRetirementStarted) {
            this.#publicationSuppressed = false;
            this.#updateSnapshot({ configuration: 'out_of_sync' });
            this.#refreshManagerSnapshot();
          }
          return { status: 'failed', reason: 'persist-failed' };
        }
      }
      this.#preparedImport = undefined;
      return (
        await this.#synchronizeCommittedConfig(committed, {
          previous,
          changedIds,
          rollbackOnCancel: !credentialRetirementStarted,
          signal,
          cleanupTimeoutMs,
          mutationVersion,
          committedRevision: commitReceipt.revision,
        })
      ).result;
    } finally {
      // Absence never grants ownership to an older compensation. Retain only
      // the current owner's marker while its late settlement still needs it.
      if (lateSettlement) void lateSettlement.finally(releaseOwnership).catch(() => undefined);
      else releaseOwnership();
    }
  }

  #settlePendingCommit(
    transaction: Promise<McpConfigFile>,
    changedIds: () => readonly string[],
    cleanupTimeoutMs?: number,
  ): Promise<TuiMcpActionResult> {
    this.#preparedImport = undefined;
    this.#publicationSuppressed = true;
    this.#updateSnapshot({ configuration: 'committing' });
    this.#refreshManagerSnapshot();
    const reconcile = (error?: unknown) =>
      this.#serializeAction(async (): Promise<TuiMcpActionResult> => {
        if (this.#closed) {
          return error instanceof AtomicFileWriteCommitUnknownError
            ? this.#reconcilePublishedMutation(error)
            : { status: 'failed', reason: 'closed' };
        }
        const signal = AbortSignal.any([
          this.#lifetimeAbort.signal,
          AbortSignal.timeout(this.#deps.actionTimeoutMs),
        ]);
        if (error instanceof AtomicFileWriteCommitUnknownError) {
          return this.#reconcilePublishedMutation(error, signal, cleanupTimeoutMs);
        }
        try {
          if (error !== undefined) throw error;
          // Another controller may have committed after our write. Reload the
          // current authority instead of publishing this transaction's snapshot.
          const current = await waitForAbort(this.#deps.configStore.get(), signal);
          return (
            await this.#synchronizeCommittedConfig(current, {
              changedIds: changedIds(),
              rollbackOnCancel: false,
              signal,
              cleanupTimeoutMs,
            })
          ).result;
        } catch {
          this.#publicationSuppressed = false;
          this.#updateSnapshot({ configuration: 'out_of_sync' });
          this.#refreshManagerSnapshot();
          return { status: 'failed', reason: 'persist-failed' };
        }
      });
    const pending = transaction
      .then(() => reconcile(), reconcile)
      .finally(() => {
        if (this.#pendingCommit === pending) this.#pendingCommit = undefined;
      });
    this.#pendingCommit = pending;
    return pending;
  }

  async #reconcilePublishedMutation(
    error: AtomicFileWriteCommitUnknownError,
    signal?: AbortSignal,
    cleanupTimeoutMs?: number,
  ): Promise<TuiMcpActionResult> {
    // The transform has already published, including any credential
    // retirement. Reload its authority; never replay or roll back those effects.
    this.#preparedImport = undefined;
    let reconciliationError: unknown;
    if (!this.#closed) {
      try {
        const committed = await waitForAbort(
          this.#deps.configStore.get(),
          signal?.aborted ? cleanupSignal(cleanupTimeoutMs) : signal,
        );
        if (!this.#closed) {
          ({ reconciliationError } = await this.#synchronizeCommittedConfig(committed, {
            changedIds: changedServerIds(this.#config ?? committed, committed),
            rollbackOnCancel: false,
            signal,
            cleanupTimeoutMs,
          }));
        }
      } catch (failure) {
        if (!this.#closed) {
          reconciliationError = failure;
          this.#publicationSuppressed = false;
          this.#snapshot = freezeSnapshot({
            ...this.#snapshot,
            configuration: 'out_of_sync',
            servers: this.#snapshot.servers.map((server) => ({
              ...server,
              synchronized: false,
            })),
          });
          this.#notify();
        }
      }
    }
    // Reconciliation does not establish the missing durability fence,
    // and its own failure must not replace the original write error.
    return {
      status: 'failed',
      reason: 'commit-unknown',
      cause: error,
      ...(reconciliationError === undefined ? {} : { reconciliationError }),
    };
  }

  async #followConfigChange(): Promise<void> {
    if (this.#closed || this.#pendingCommit) return;
    if (this.#snapshot.initialization === 'error') return this.#initialize();
    const signal = AbortSignal.any([
      this.#lifetimeAbort.signal,
      AbortSignal.timeout(this.#deps.actionTimeoutMs),
    ]);
    const latest = await waitForAbort(this.#deps.configStore.get(), signal);
    // An import preview survives: its commit re-checks each server it replaces.
    if (
      this.#snapshot.configuration !== 'ready' ||
      JSON.stringify(latest) !== JSON.stringify(this.#config)
    ) {
      await this.#synchronizeCommittedConfig(latest, {
        changedIds: changedServerIds(this.#config ?? latest, latest),
        rollbackOnCancel: false,
        signal,
        cleanupTimeoutMs: Math.min(MCP_ACTION_CLEANUP_RESERVE_MS, this.#deps.actionTimeoutMs),
      });
    }
  }

  async #synchronizeCommittedConfig(
    committed: McpConfigFile,
    {
      previous,
      changedIds,
      rollbackOnCancel,
      signal,
      cleanupTimeoutMs,
      mutationVersion,
      committedRevision,
    }: {
      readonly previous?: McpConfigFile;
      readonly changedIds: readonly string[];
      readonly rollbackOnCancel: boolean;
      readonly signal?: AbortSignal;
      readonly cleanupTimeoutMs?: number;
      readonly mutationVersion?: symbol;
      readonly committedRevision?: string;
    },
  ): Promise<{
    readonly result: TuiMcpActionResult;
    readonly reconciliationError?: unknown;
  }> {
    if (this.#closed) return { result: { status: 'failed', reason: 'closed' } };
    this.#config = cloneConfig(committed);
    this.#updateSnapshot({ configuration: 'synchronizing' });
    this.#refreshManagerSnapshot();
    this.#publicationSuppressed = true;
    let synchronizationError: unknown;
    try {
      throwIfAborted(signal);
      try {
        await waitForAbort(this.#deps.manager.sync(committed, { signal }), signal);
      } catch (error) {
        synchronizationError = error;
      }
      throwIfAborted(signal);
      this.#publicationSuppressed = false;
      if (this.#closed) throw new Error('MCP controller closed');
      this.#updateSnapshot({
        configuration: synchronizationError === undefined ? 'ready' : 'out_of_sync',
      });
      this.#refreshManagerSnapshot();
      const effect = await this.#settlePublication(signal);
      throwIfAborted(signal);
      return synchronizationError === undefined
        ? { result: { status: 'applied', effect } }
        : {
            result: { status: 'applied', effect: 'sync_failed' },
            reconciliationError: synchronizationError,
          };
    } catch (error) {
      if (rollbackOnCancel && (this.#closed || signal?.aborted)) {
        const rolledBack = await this.#rollbackCancelledMutation(
          previous,
          committed,
          changedIds,
          cleanupSignal(cleanupTimeoutMs),
          mutationVersion,
          committedRevision,
        );
        if (!rolledBack) return { result: { status: 'failed', reason: 'rollback-failed' } };
        return {
          result: {
            status: 'failed',
            reason: this.#closed ? 'closed' : 'cancelled',
          },
        };
      }
      this.#publicationSuppressed = false;
      this.#updateSnapshot({ configuration: 'out_of_sync' });
      this.#refreshManagerSnapshot();
      const cleanup = cleanupSignal(cleanupTimeoutMs);
      if (this.#closed || signal?.aborted) {
        await this.#settleCancelledConnections(changedIds, cleanup);
        this.#refreshManagerSnapshot();
      }
      await this.#settleCancelledPublication(cleanup);
      return {
        result: { status: 'applied', effect: 'sync_failed' },
        reconciliationError: synchronizationError ?? error,
      };
    }
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
        next: normalizeMcpConfig({
          version: MCP_CONFIG_VERSION,
          mcpServers: servers,
        }),
      };
    } catch {
      return { status: 'failed', reason: 'invalid-config' };
    }
  }

  async #settlePublication(signal?: AbortSignal): Promise<TuiMcpActionEffect> {
    throwIfAborted(signal);
    if (
      !this.#closed &&
      this.#snapshot.initialization === 'ready' &&
      !this.#publicationSuppressed
    ) {
      await waitForAbort(this.#publication.settle(), signal);
      throwIfAborted(signal);
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

  async #rollbackCancelledMutation(
    previous: McpConfigFile | undefined,
    committed: McpConfigFile,
    serverIds: readonly string[],
    signal?: AbortSignal,
    mutationVersion?: symbol,
    committedRevision?: string,
  ): Promise<boolean> {
    const ownedIds = serverIds.filter(
      (serverId) =>
        mutationVersion === undefined || this.#mutationVersions.get(serverId) === mutationVersion,
    );
    if (serverIds.length > 0 && ownedIds.length === 0) return true;
    if (!previous) {
      this.#publicationSuppressed = false;
      this.#updateSnapshot({ configuration: 'out_of_sync' });
      return false;
    }
    try {
      let superseded = false;
      const restored = await waitForAbort(
        this.#deps.configStore
          .transform(async (current, transaction) => {
            throwIfAborted(signal);
            if (committedRevision !== undefined) {
              if (!transaction)
                throw new Error('MCP config store lost transaction revision support');
              transaction.assertRevision(committedRevision);
            }
            const servers = { ...current.mcpServers };
            for (const serverId of ownedIds) {
              if (
                configRevision(servers[serverId]) !== configRevision(committed.mcpServers[serverId])
              ) {
                continue;
              }
              const currentEntry = servers[serverId];
              const previousEntry = previous.mcpServers[serverId];
              if (currentEntry && mcpConfigChangeRetiresCredentials(currentEntry, previousEntry)) {
                await this.#deps.manager.forgetServerCredentials(serverId, currentEntry, {
                  signal,
                });
                throwIfAborted(signal);
              }
              if (previousEntry) servers[serverId] = previousEntry;
              else delete servers[serverId];
            }
            throwIfAborted(signal);
            return normalizeMcpConfig({
              version: MCP_CONFIG_VERSION,
              mcpServers: servers,
            });
          })
          .catch((error: unknown) => {
            // A newer writer owns the config, even if it wrote identical values.
            // Reconcile that authority without executing compensation effects.
            if (error instanceof McpConfigRevisionConflictError) {
              superseded = true;
              return error.current;
            }
            throw error;
          }),
        signal,
      );
      this.#config = cloneConfig(restored);
      if (this.#closed) return !superseded;
      for (const serverId of ownedIds) {
        if (!this.#deps.manager.disconnect) continue;
        await waitForAbort(this.#deps.manager.disconnect(serverId, false, { signal }), signal);
      }
      await waitForAbort(this.#deps.manager.sync(restored, { signal }), signal);
      this.#publicationSuppressed = false;
      this.#updateSnapshot({ configuration: 'ready' });
      this.#refreshManagerSnapshot();
      await this.#settlePublication(signal);
      // The manager can be synchronized even when compensation was refused.
      // Do not claim cancellation rolled back a superseded transaction.
      return !superseded;
    } catch {
      this.#publicationSuppressed = false;
      this.#updateSnapshot({ configuration: 'out_of_sync' });
      this.#refreshManagerSnapshot();
      return false;
    }
  }

  #scheduleLateMutationRollback(
    transaction: Promise<McpConfigFile>,
    previous: () => McpConfigFile | undefined,
    serverIds: () => readonly string[],
    mutationVersion: symbol,
    commitReceipt: { readonly revision?: string },
    signal?: AbortSignal,
    cleanupTimeoutMs?: number,
  ): Promise<void> {
    return transaction
      .then(
        (committed) =>
          this.#serializeAction(() =>
            this.#rollbackCancelledMutation(
              previous(),
              committed,
              serverIds(),
              cleanupSignal(cleanupTimeoutMs),
              mutationVersion,
              commitReceipt.revision,
            ),
          ),
        (error) => {
          if (error instanceof AtomicFileWriteCommitUnknownError) {
            return this.#serializeAction(async () => {
              if (
                serverIds().some(
                  (serverId) => this.#mutationVersions.get(serverId) === mutationVersion,
                )
              ) {
                await this.#reconcilePublishedMutation(error, signal, cleanupTimeoutMs);
              }
            });
          }
        },
      )
      .then(
        () => undefined,
        () => undefined,
      );
  }

  async #settleCancelledConnection(serverId: string, signal?: AbortSignal): Promise<boolean> {
    if (!this.#deps.manager.disconnect) return true;
    try {
      await waitForAbort(this.#deps.manager.disconnect(serverId, false, { signal }), signal);
      return true;
    } catch {
      return false;
    }
  }

  async #settleCancelledConnections(
    serverIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<boolean> {
    const disconnect = this.#deps.manager.disconnect;
    if (!disconnect) return true;
    try {
      await Promise.all(
        serverIds.map((serverId) =>
          waitForAbort(disconnect.call(this.#deps.manager, serverId, false, { signal }), signal),
        ),
      );
      return true;
    } catch {
      return false;
    }
  }

  async #settleCancelledPublication(signal?: AbortSignal): Promise<boolean> {
    try {
      await this.#settlePublication(signal);
      return true;
    } catch {
      return false;
    }
  }

  async #settleCancelledCredentialOperation(
    operation: Promise<void>,
    signal: AbortSignal,
    publish: boolean,
    cleanupTimeoutMs?: number,
  ): Promise<TuiMcpActionResult> {
    const cleanup = cleanupSignal(cleanupTimeoutMs);
    try {
      await waitForAbort(operation, cleanup);
    } catch (error) {
      return {
        status: 'failed',
        reason: error === signal.reason ? 'cancelled' : 'rollback-failed',
      };
    }
    // Resolving means the target committed. A cancellation racing the
    // acknowledgement cannot retroactively turn that into a failed rollback.
    const effect = publish
      ? await this.#settlePublication(cleanup).catch(() => 'publication_failed' as const)
      : 'pending_host';
    return { status: 'applied', effect };
  }

  #requestPublication(): void {
    if (this.#closed || this.#snapshot.initialization !== 'ready' || this.#publicationSuppressed)
      return;
    this.#publication.request();
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

function cloneConfig(config: McpConfigFile): McpConfigFile {
  return structuredClone(config);
}

function changedServerIds(before: McpConfigFile, after: McpConfigFile): string[] {
  return [...new Set([...Object.keys(before.mcpServers), ...Object.keys(after.mcpServers)])].filter(
    (serverId) =>
      configRevision(before.mcpServers[serverId]) !== configRevision(after.mcpServers[serverId]),
  );
}

function cleanupSignal(timeoutMs?: number): AbortSignal | undefined {
  return timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error(String(signal.reason ?? 'MCP action cancelled'));
}

function waitForAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  try {
    throwIfAborted(signal);
  } catch (error) {
    return Promise.reject(error);
  }
  let rejectAbort!: (reason: Error) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => {
    try {
      throwIfAborted(signal);
    } catch (error) {
      rejectAbort(error instanceof Error ? error : new Error(String(error)));
    }
  };
  signal.addEventListener('abort', onAbort, { once: true });
  return Promise.race([promise, aborted]).finally(() => {
    signal.removeEventListener('abort', onAbort);
  });
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
