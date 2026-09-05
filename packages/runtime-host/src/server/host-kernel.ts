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

import { randomUUID } from 'node:crypto';
import { arch as osArch, homedir, release as osRelease } from 'node:os';
import { collapseHomePath } from '@maka/core/diagnostic-log';
import {
  assertInteractiveRootOwner,
  authenticateInteractiveRootOwner,
  type InteractiveRootOwner,
} from '@maka/storage/root-authority';
import { bindStateRootComposition } from '@maka/storage/state-root-composition';
import { removeHostRegistration, writeHostRegistration } from '../control/registration.js';
import {
  decodeClientFrame,
  encodeProtocolMessage,
  HOST_OPERATION_SPECS,
  negotiateProtocol,
  RUNTIME_HOST_COMPATIBILITY_EPOCH,
  RUNTIME_HOST_PROTOCOL_VERSION,
  RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION,
  requireHostGeneration,
  type ClientHello,
  type HostOperationErrorCode,
  type HostHandshakeResult,
  type HostActivitySnapshot,
  type HostLifecycleState,
  type HostRegistration,
  type HostStatusResult,
  type RequestFrame,
} from '../protocol/index.js';
import type { RuntimeHostMessageTransport } from '../transport/message-transport.js';
import {
  RuntimeHostConnectionSession,
  type ConnectionOperationLease,
} from './connection-session.js';
import {
  composeOperationHandlers,
  createUnavailableDomainOperationHandlers,
  type DomainOperationHandlerMap,
  type OperationResidency,
  type OperationHandlerMap,
} from './operation-dispatcher.js';
import {
  issueAccessCredential,
  acknowledgeCollaborationTurnRequest,
  createCollaborationTurnRequest,
  decideCollaborationTurnRequest,
  withdrawCollaborationTurnRequest,
  finalizeAccessCredential,
  prepareCollaborationInvitation,
  queryCollaborationTurnRequests,
  prepareAccessCredential,
  prepareAccessCredentialRotation,
  replaceAccessCredential,
  revokeAccessCredential,
  revokeAccessPrincipal,
  revokeAccessCredentialRotation,
  revokeCollaborationGrant,
  revokeCollaborationPrincipal,
  type RuntimeHostAccessAuthority,
} from './access-authority.js';
import type { RuntimeHostConnectionAuthority } from './connection-authority.js';
import type { SessionContinuityService } from './session-continuity-service.js';
import type { ClientCapabilityService } from './client-capability-service.js';
import type { HostChangeFeed } from './host-change-feed.js';
import { runtimeHostLogBuffer } from '../process-diagnostics.js';
import {
  type HostCompositionDescriptor,
  type RuntimeHostCompositionSource,
} from './host-composition.js';
import {
  startLocalRuntimeHostListenerSet,
  type RuntimeHostListenerConnection,
  type RuntimeHostListenerSet,
  type RuntimeHostListenerSetFactory,
} from './listener-set.js';
import { HostResidencyRegistry } from './host-residency-registry.js';
import type { PeerMeshNode } from '../peer-mesh/node.js';
import { createPeerMeshOperationHandlers } from './peer-mesh-authority.js';
import { createHostResourceCollector } from './host-resource-collector.js';

const DEFAULT_IDLE_GRACE_MS = 30_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 10_000;
const SHUTDOWN_HANDSHAKE_GRACE_MS = 1_000;
const SHUTDOWN_OPERATION_GRACE_MS = 1_000;
const INITIAL_CONNECTION_DEADLINE_DEFERRAL_LIMIT = 3;
const HOST_PROTOCOL = {
  min: RUNTIME_HOST_PROTOCOL_VERSION,
  max: RUNTIME_HOST_PROTOCOL_VERSION,
} as const;

export type RuntimeHostResidency = OperationResidency;

export class RuntimeHostProcessTerminationRequiredError extends Error {
  readonly code = 'process_termination_required';

  constructor(readonly shutdownGraceMs: number) {
    super(`Runtime Host did not shut down within ${shutdownGraceMs} ms`);
    this.name = 'RuntimeHostProcessTerminationRequiredError';
  }
}

export interface RuntimeHostCompositionContext {
  owner: InteractiveRootOwner;
  hostEpoch: string;
  acquireResidency(label: string): RuntimeHostResidency;
  /** Irreversible fail-stop latch; normal residency still uses acquireResidency(). */
  retainUntilProcessExit(): void;
  requestDrain(): void;
  sessionAccessAuthority?: Pick<
    RuntimeHostAccessAuthority,
    | 'activeSessionGrant'
    | 'activeSessionGrantForPrincipal'
    | 'approvedTurnAccessRequests'
    | 'completeTurnAccessRequest'
    | 'subscribeGrantRevocations'
    | 'subscribeApprovedTurnAccessRequests'
  >;
  waitForResidencies?(): Promise<void>;
  waitForResidenciesExcept?(excludedLabel: string): Promise<void>;
}

export interface RuntimeHostComposition {
  readonly handlers: DomainOperationHandlerMap;
  readonly moduleIds?: readonly string[];
  readonly continuity?: SessionContinuityService;
  readonly clientCapabilities?: ClientCapabilityService;
  readonly hostChanges?: HostChangeFeed;
  releaseConnection?(connectionId: string): void;
  beginDrain(): void;
  recover(): Promise<void>;
  close(): Promise<void>;
}

export type RuntimeHostCompositionFactory = (
  context: RuntimeHostCompositionContext,
) => Promise<RuntimeHostComposition>;

interface RuntimeHostKernelCommonOptions {
  owner: InteractiveRootOwner;
  handshakeTimeoutMs?: number;
  shutdownGraceMs?: number;
  composition: RuntimeHostCompositionSource;
  listenerSetFactory?: RuntimeHostListenerSetFactory;
  accessAuthority?: RuntimeHostAccessAuthority;
  peerMesh?: PeerMeshNode;
  /** Ephemeral launch gate used until a supervised Candidate durably commits. */
  initialClientAdmission?: {
    isClientAdmitted(clientInstanceId: string): boolean;
  };
}

export type RuntimeHostLifecycleMode = 'ephemeral' | 'service';

export type RuntimeHostKernelOptions = RuntimeHostKernelCommonOptions &
  (
    | {
        lifecycleMode?: 'ephemeral';
        initialConnectionTimeoutMs?: number;
        idleGraceMs?: number;
        generation?: string;
      }
    | {
        lifecycleMode: 'service';
        initialConnectionTimeoutMs?: never;
        idleGraceMs?: never;
        generation?: never;
      }
  );

type RuntimeHostLifecycle =
  | {
      readonly kind: 'ephemeral';
      readonly initialConnectionTimeoutMs: number;
      readonly idleGraceMs: number;
    }
  | { readonly kind: 'service' };

export class RuntimeHostKernel {
  readonly hostEpoch = randomUUID();
  readonly closed: Promise<void>;
  readonly #options: RuntimeHostKernelOptions;
  readonly #createdAt = new Date().toISOString();
  readonly #handshakingTransports = new Set<RuntimeHostMessageTransport>();
  readonly #acceptedTransports = new Set<RuntimeHostMessageTransport>();
  readonly #connectionSessions = new Set<RuntimeHostConnectionSession>();
  readonly #transportAuthorities = new Map<
    RuntimeHostMessageTransport,
    RuntimeHostListenerConnection['authority']
  >();
  readonly #operationDrainWaiters = new Set<() => void>();
  readonly #residencies = new HostResidencyRegistry();
  readonly #resourceCollector = createHostResourceCollector();
  readonly #lifecycle: RuntimeHostLifecycle;
  readonly #handshakeTimeoutMs: number;
  readonly #shutdownGraceMs: number;
  #listeners: RuntimeHostListenerSet | undefined;
  #state: HostLifecycleState = 'starting';
  #hasAcceptedConnection = false;
  #activeOperations = 0;
  #activeCommandOperations = 0;
  #retainedUntilProcessExit = false;
  #composition: RuntimeHostComposition | undefined;
  #compositionDrainBegun = false;
  #compositionStartup: Promise<void> | undefined;
  #operationHandlers: OperationHandlerMap;
  #idleTimer: NodeJS.Timeout | undefined;
  #initialConnectionDeadline: NodeJS.Timeout | undefined;
  #initialConnectionDeadlineDeferrals = 0;
  #shutdownRequested = false;
  #shutdownReason: 'retirement' | undefined;
  #shutdownTask: Promise<void> | undefined;
  #shutdownDeadlineTimer: NodeJS.Timeout | undefined;
  #terminationRequired: RuntimeHostProcessTerminationRequiredError | undefined;
  #resolveClosed!: () => void;
  #rejectClosed!: (error: unknown) => void;
  readonly #unsubscribeAccessRevocations: (() => void) | undefined;
  readonly #unsubscribeSessionGrantRevocations: (() => void) | undefined;

  private constructor(options: RuntimeHostKernelOptions) {
    this.#lifecycle = normalizeLifecycle(options);
    if (options.generation !== undefined) requireHostGeneration(options.generation);
    assertDuration(
      options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
      'handshakeTimeoutMs',
      1,
    );
    assertDuration(options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS, 'shutdownGraceMs', 1);
    this.#handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.#shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
    this.#options = options;
    this.#unsubscribeAccessRevocations = options.accessAuthority?.subscribeRevocations(
      (credentialId) => this.#revokeCredentialConnections(credentialId),
    );
    this.#unsubscribeSessionGrantRevocations = options.accessAuthority?.subscribeGrantRevocations(
      (grant) => {
        if (grant.kind === 'session_observation') {
          this.#composition?.hostChanges?.publishSessionCatalogAndCloseScope(
            grant.sessionId,
            grant.principalId,
          );
        }
      },
    );
    this.#operationHandlers = this.#createOperationHandlers(
      createUnavailableDomainOperationHandlers(),
    );
    this.closed = new Promise((resolve, reject) => {
      this.#resolveClosed = resolve;
      this.#rejectClosed = reject;
    });
  }

  static async start(options: RuntimeHostKernelOptions): Promise<RuntimeHostKernel> {
    const owner = authenticateInteractiveRootOwner(options.owner);
    let host: RuntimeHostKernel | undefined;
    try {
      host = new RuntimeHostKernel(options);
      await host.#start();
      return host;
    } catch (error) {
      if (host) {
        if (host.#listeners) {
          host.#requestDrain();
          try {
            await host.closed;
          } catch (shutdownError) {
            throw new AggregateError(
              [error, shutdownError],
              'Runtime Host startup failed and shutdown did not complete cleanly',
              { cause: error },
            );
          }
        } else {
          await host.#abortStartup();
        }
      } else {
        await options.accessAuthority?.close().catch(() => undefined);
        await owner.close();
      }
      throw error;
    }
  }

  get state(): HostLifecycleState {
    return this.#state;
  }

  get shutdownReason(): 'retirement' | undefined {
    return this.#shutdownReason;
  }

  get endpoint(): string {
    if (!this.#listeners) throw new Error('Runtime Host has not started listening');
    return this.#listeners.localEndpoint;
  }

  get rootId(): string {
    return this.#options.owner.capability.rootId;
  }

  get connectionCount(): number {
    return this.#acceptedTransports.size;
  }

  get websocketEndpoints(): readonly string[] {
    return this.#listeners?.websocketEndpoints ?? [];
  }

  get peerListeners(): RuntimeHostListenerSet['peerListeners'] {
    return this.#listeners?.peerListeners ?? [];
  }

  get compositionDescriptor(): HostCompositionDescriptor {
    return this.#options.composition.descriptor;
  }

  close(): Promise<void> {
    this.#requestDrain();
    return this.closed;
  }

  #requestDrain(): void {
    if (!this.#shutdownRequested) {
      this.#shutdownRequested = true;
      this.#cancelIdle();
      this.#cancelInitialConnectionDeadline();
      this.#armShutdownDeadline();
      this.#beginCompositionDrain();
    }
    this.#commitRequestedShutdownIfQuiescent();
  }

  async #start(): Promise<void> {
    await assertInteractiveRootOwner(this.#options.owner);
    await bindStateRootComposition(this.#options.owner.lease, this.compositionDescriptor.id);
    this.#listeners = await (this.#options.listenerSetFactory ?? startLocalRuntimeHostListenerSet)({
      rootId: this.#options.owner.capability.rootId,
      hostEpoch: this.hostEpoch,
      accept: (connection) => this.#accept(connection),
      isReady: () => this.#state === 'ready' && !this.#shutdownRequested,
    });
    await this.#publishRegistration();
    this.#state = 'recovering';
    await this.#publishRegistration();
    let settleCompositionStartup!: () => void;
    this.#compositionStartup = new Promise((resolve) => {
      settleCompositionStartup = resolve;
    });
    // Armed only once #compositionStartup is assigned: a deadline that fired
    // earlier would drive #closeResources past an undefined startup await and
    // let shutdown complete without closing the composition created below.
    this.#armInitialConnectionDeadline();
    const compositionStartup = (async () => {
      try {
        this.#composition = await this.#options.composition.create({
          owner: this.#options.owner,
          hostEpoch: this.hostEpoch,
          acquireResidency: (label) => this.#acquireResidency(label),
          retainUntilProcessExit: () => this.#retainUntilProcessExit(),
          requestDrain: () => this.#requestDrain(),
          ...(this.#options.accessAuthority
            ? { sessionAccessAuthority: this.#options.accessAuthority }
            : {}),
          waitForResidencies: () => this.#waitForResidencies(),
          waitForResidenciesExcept: (excludedLabel) =>
            this.#waitForResidenciesExcept(excludedLabel),
        });
        for (const session of this.#connectionSessions) session.attachGlobalChanges();
        if (this.#shutdownRequested) this.#beginCompositionDrain();
        this.#operationHandlers = this.#createOperationHandlers(this.#composition.handlers);
        await this.#composition.recover();
      } finally {
        settleCompositionStartup();
      }
    })();
    await Promise.race([compositionStartup, this.closed]);
    if (this.#shutdownRequested) {
      this.#commitRequestedShutdownIfQuiescent();
      return;
    }
    this.#state = 'ready';
    await this.#publishRegistration();
    this.#scheduleIdleIfNeeded();
  }

  #accept(connection: RuntimeHostListenerConnection): void {
    const { transport } = connection;
    this.#transportAuthorities.set(transport, connection.authority);
    this.#handshakingTransports.add(transport);
    void this.#serveConnection(connection).finally(() => {
      this.#handshakingTransports.delete(transport);
      this.#transportAuthorities.delete(transport);
      // A handshake that never completes keeps the Host visible to the idle
      // timer while it is in flight; once it settles, idle must re-evaluate.
      this.#scheduleIdleIfNeeded();
    });
  }

  async #serveConnection(connection: RuntimeHostListenerConnection): Promise<void> {
    const { authority, transport } = connection;
    let transportReleased = false;
    let connectionId: string | undefined;
    const releaseTransport = () => {
      if (!connectionId || transportReleased) return;
      transportReleased = true;
      this.#releaseConnection(transport);
    };
    try {
      const frame = decodeClientFrame(await transport.read(this.#handshakeTimeoutMs));
      if (!('kind' in frame) || frame.kind !== 'hello') {
        throw new Error('First Runtime Host frame must be a hello');
      }
      const result = await this.#admitHandshake(frame, transport, authority);
      connectionId = result.kind === 'accepted' ? result.connectionId : undefined;
      await transport.write(encodeProtocolMessage(result));
      if (result.kind !== 'accepted') {
        transport.closeAfterFlush();
        return;
      }
      const session = new RuntimeHostConnectionSession({
        transport,
        connection: {
          hostEpoch: this.hostEpoch,
          connectionId: result.connectionId,
          clientInstanceId: frame.clientInstanceId,
          authority,
        },
        resolveHandlers: () => this.#operationHandlers,
        resolveContinuity: () => this.#composition?.continuity,
        resolveClientCapabilities: () => this.#composition?.clientCapabilities,
        resolveHostChanges: () => this.#composition?.hostChanges,
        resolveSharedSessionId: () =>
          this.#options.accessAuthority?.activeSessionGrantForPrincipal(
            authority.principalId,
            'session_observation',
          )?.sessionId,
        beginOperation: (request) => this.#beginOperation(request),
        onTeardown: releaseTransport,
      });
      this.#connectionSessions.add(session);
      try {
        await session.run();
      } finally {
        this.#connectionSessions.delete(session);
      }
    } catch {
      transport.abort();
    } finally {
      try {
        if (connectionId) this.#composition?.releaseConnection?.(connectionId);
      } finally {
        releaseTransport();
      }
    }
  }

  async #admitHandshake(
    hello: ClientHello,
    transport: RuntimeHostMessageTransport,
    authority: RuntimeHostConnectionAuthority,
  ): Promise<HostHandshakeResult> {
    const admittedState = await this.#readAdmissionState();
    if (!admittedState) {
      return {
        kind: 'draining',
        hostEpoch: this.hostEpoch,
        compositionId: this.compositionDescriptor.id,
        compositionRevision: this.compositionDescriptor.revision,
      };
    }
    const initialClientAdmission = this.#options.initialClientAdmission;
    if (
      initialClientAdmission &&
      !initialClientAdmission.isClientAdmitted(hello.clientInstanceId)
    ) {
      return {
        kind: 'draining',
        hostEpoch: this.hostEpoch,
        compositionId: this.compositionDescriptor.id,
        compositionRevision: this.compositionDescriptor.revision,
      };
    }
    if (authority.clientInstanceId && authority.clientInstanceId !== hello.clientInstanceId) {
      throw new Error('Runtime Host access credential belongs to another Client');
    }
    if (
      authority.principalKind === 'remote_owner' &&
      authority.clientInstanceId === undefined &&
      this.#options.accessAuthority?.hasActiveBoundClientIdentity(
        authority.principalId,
        hello.clientInstanceId,
      )
    ) {
      throw new Error('Runtime Host Client identity is bound to another access credential');
    }
    const selectedProtocol = negotiateProtocol(
      { min: hello.protocolMin, max: hello.protocolMax },
      HOST_PROTOCOL,
    );
    const generationMismatch =
      this.#lifecycle.kind === 'ephemeral' &&
      hello.generation !== undefined &&
      hello.generation !== this.#options.generation;
    if (generationMismatch && hello.takeover?.expectedHostEpoch === this.hostEpoch) {
      if (authority.principalKind === 'local_owner' && this.#isTrueIdle(transport)) {
        this.#requestDrain();
        return {
          kind: 'draining',
          hostEpoch: this.hostEpoch,
          compositionId: this.compositionDescriptor.id,
          compositionRevision: this.compositionDescriptor.revision,
        };
      }
    }
    if (
      selectedProtocol === undefined ||
      hello.compatibilityEpoch !== RUNTIME_HOST_COMPATIBILITY_EPOCH ||
      hello.compositionId !== this.compositionDescriptor.id ||
      generationMismatch
    ) {
      return {
        kind: 'incompatible',
        hostEpoch: this.hostEpoch,
        protocolMin: HOST_PROTOCOL.min,
        protocolMax: HOST_PROTOCOL.max,
        compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH,
        compositionId: this.compositionDescriptor.id,
        compositionRevision: this.compositionDescriptor.revision,
        ...(this.#options.generation === undefined ? {} : { generation: this.#options.generation }),
        state: admittedState,
        replacement:
          this.#lifecycle.kind === 'ephemeral' && this.#isSettledForReplacementAdvice()
            ? 'wait_for_idle_exit'
            : 'blocked_by_residency',
        ...(generationMismatch && authority.principalKind === 'local_owner'
          ? { activity: this.#activitySnapshot() }
          : {}),
      };
    }
    this.#hasAcceptedConnection = true;
    this.#cancelInitialConnectionDeadline();
    this.#acceptedTransports.add(transport);
    this.#handshakingTransports.delete(transport);
    this.#cancelIdle();
    return {
      kind: 'accepted',
      rootId: this.#options.owner.capability.rootId,
      hostEpoch: this.hostEpoch,
      connectionId: randomUUID(),
      selectedProtocol,
      compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH,
      compositionId: this.compositionDescriptor.id,
      compositionRevision: this.compositionDescriptor.revision,
      state: admittedState,
    };
  }

  #releaseConnection(transport: RuntimeHostMessageTransport): void {
    if (!this.#acceptedTransports.delete(transport)) {
      throw new Error('Runtime Host connection residency underflow');
    }
    this.#settleLifecycleAfterWork();
  }

  #revokeCredentialConnections(credentialId: string): void {
    for (const [transport, authority] of this.#transportAuthorities) {
      if (authority.credentialId === credentialId) transport.abort();
    }
  }

  async #beginOperation(
    frame: RequestFrame,
  ): Promise<ConnectionOperationLease | HostOperationErrorCode> {
    if (!(await this.#readAdmissionState())) return 'host_draining';
    if (
      HOST_OPERATION_SPECS[frame.operation].availability !== 'bootstrap' &&
      this.#state !== 'ready'
    ) {
      return 'host_not_ready';
    }
    this.#activeOperations += 1;
    const command = HOST_OPERATION_SPECS[frame.operation].mode === 'command';
    if (command) this.#activeCommandOperations += 1;
    this.#cancelIdle();
    let sealed = false;
    let finished = false;
    const seal = () => {
      if (sealed) return;
      sealed = true;
      if (command) {
        if (this.#activeCommandOperations === 0) {
          throw new Error('Runtime Host command operation residency underflow');
        }
        this.#activeCommandOperations -= 1;
        this.#settleLifecycleAfterWork();
      }
    };
    return {
      acquireResidency: () => {
        if (sealed || finished) throw new Error('Runtime Host operation lease has ended');
        return this.#acquireResidency(`operation.${frame.operation}`);
      },
      seal,
      finish: () => {
        if (finished) throw new Error('Runtime Host operation lease already ended');
        finished = true;
        seal();
        this.#finishOperation();
      },
    };
  }

  async #hasLiveOwnerOrDrain(): Promise<boolean> {
    if (this.#isDraining()) return false;
    try {
      await assertInteractiveRootOwner(this.#options.owner);
    } catch {
      void this.#commitShutdown().catch(() => undefined);
      return false;
    }
    return !this.#isDraining();
  }

  async #readAdmissionState(): Promise<Exclude<HostLifecycleState, 'draining'> | undefined> {
    if (this.#shutdownRequested || this.#isDraining()) return undefined;
    if (!(await this.#hasLiveOwnerOrDrain())) return undefined;
    const state = this.#state;
    return this.#shutdownRequested || state === 'draining' ? undefined : state;
  }

  #isDraining(): boolean {
    return this.#state === 'draining';
  }

  #finishOperation(): void {
    if (this.#activeOperations === 0) throw new Error('Runtime Host operation residency underflow');
    this.#activeOperations -= 1;
    if (this.#activeOperations === 0) {
      for (const resolve of this.#operationDrainWaiters) resolve();
      this.#operationDrainWaiters.clear();
    }
    this.#settleLifecycleAfterWork();
  }

  #acquireResidency(label: string): RuntimeHostResidency {
    const residency = this.#residencies.acquire(label);
    this.#cancelIdle();
    return {
      release: () => {
        residency.release();
        this.#settleLifecycleAfterWork();
      },
    };
  }

  #retainUntilProcessExit(): void {
    if (this.#retainedUntilProcessExit) return;
    this.#retainedUntilProcessExit = true;
    // Not work in flight: the marker only blocks idle exit, so it must not
    // stall the drain it accompanies.
    this.#residencies.acquire('process-retention', 'idle');
    this.#cancelIdle();
  }

  #createOperationHandlers(domainHandlers: DomainOperationHandlerMap): OperationHandlerMap {
    return composeOperationHandlers(
      {
        'host.status': async () => ({
          ok: true,
          result: this.#statusSnapshot(),
        }),
        'host.diagnostics.query': async () => ({
          ok: true,
          result: {
            ...this.#statusSnapshot(),
            compositionModules: this.#composition?.moduleIds ?? [],
            residencies: this.#residencies.snapshot(),
            protocolVersion: RUNTIME_HOST_PROTOCOL_VERSION,
            compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH,
            pid: process.pid,
            processUptimeSeconds: Math.max(0, Math.floor(process.uptime())),
            nodeVersion: process.versions.node,
            platform: process.platform,
            arch: osArch(),
            osRelease: osRelease(),
            logs: runtimeHostLogBuffer
              .snapshot()
              .map((entry) => collapseHomePath(entry, homedir(), process.platform)),
          },
        }),
        'host.resources.query': async () => ({
          ok: true,
          result: await this.#resourceCollector.snapshot(this.hostEpoch),
        }),
        'host.upgrade.prepare': async (input) => {
          if (input.expectedHostEpoch !== this.hostEpoch) {
            return {
              ok: false,
              error: {
                code: 'operation_conflict',
                message: 'Runtime Host identity changed before upgrade drain',
              },
            };
          }
          if (!input.allowInterruptActiveTasks && this.#hasUpgradeBlockingActivity()) {
            return { ok: true, result: { kind: 'active_tasks' } };
          }
          this.#shutdownReason = 'retirement';
          this.#requestDrain();
          return { ok: true, result: { kind: 'prepared', pid: process.pid } };
        },
        'access.credential.issue': async (input) =>
          this.#settleAccessCredentialMutation(
            issueAccessCredential(this.#options.accessAuthority, input),
          ),
        'access.credential.replace': async (input) =>
          this.#settleAccessCredentialMutation(
            replaceAccessCredential(this.#options.accessAuthority, input),
          ),
        'access.credential.prepare': async (input) =>
          this.#settleAccessCredentialMutation(
            prepareAccessCredential(this.#options.accessAuthority, input),
          ),
        'access.credential.revoke': async (input) =>
          this.#settleAccessCredentialMutation(
            revokeAccessCredential(this.#options.accessAuthority, input),
          ),
        'access.principal.revoke': async (input) =>
          this.#settleAccessCredentialMutation(
            revokeAccessPrincipal(this.#options.accessAuthority, input),
          ),
        'access.credential.rotation.prepare': async (input) =>
          this.#settleAccessCredentialMutation(
            prepareAccessCredentialRotation(this.#options.accessAuthority, input),
          ),
        'access.credential.rotation.revoke': async (input) =>
          this.#settleAccessCredentialMutation(
            revokeAccessCredentialRotation(this.#options.accessAuthority, input),
          ),
        'access.credential.finalize': async (_input, context) =>
          this.#settleAccessCredentialMutation(
            finalizeAccessCredential(
              this.#options.accessAuthority,
              context.credentialId,
              context.clientInstanceId,
              context.credentialClientInstanceId,
            ),
          ),
        'collaboration.invitation.prepare': async (input) =>
          this.#settleAccessCredentialMutation(
            prepareCollaborationInvitation(this.#options.accessAuthority, this.rootId, input),
          ),
        'collaboration.access.query': async (input) =>
          this.#options.accessAuthority
            ? {
                ok: true,
                result: this.#options.accessAuthority.queryCollaborationAccess(input),
              }
            : {
                ok: false,
                error: {
                  code: 'operation_unavailable',
                  message: 'Runtime Host collaboration authority is unavailable',
                },
              },
        'collaboration.grant.revoke': async (input) =>
          this.#settleAccessCredentialMutation(
            revokeCollaborationGrant(this.#options.accessAuthority, input),
          ),
        'collaboration.principal.revoke': async (input) =>
          this.#settleAccessCredentialMutation(
            revokeCollaborationPrincipal(this.#options.accessAuthority, input.principalId),
          ),
        'collaboration.turn-request.create': async (input, context) =>
          this.#settleAccessCredentialMutation(
            createCollaborationTurnRequest(this.#options.accessAuthority, context.principal, input),
          ),
        'collaboration.turn-request.query': async (input, context) =>
          queryCollaborationTurnRequests(
            this.#options.accessAuthority,
            {
              principalId: context.principal,
              principalKind: context.principalKind,
            },
            input,
          ),
        'collaboration.turn-request.acknowledge': async (input, context) =>
          this.#settleAccessCredentialMutation(
            acknowledgeCollaborationTurnRequest(
              this.#options.accessAuthority,
              context.principal,
              input,
            ),
          ),
        'collaboration.turn-request.withdraw': async (input, context) =>
          this.#settleAccessCredentialMutation(
            withdrawCollaborationTurnRequest(
              this.#options.accessAuthority,
              context.principal,
              input,
            ),
          ),
        'collaboration.turn-request.decide': async (input, context) =>
          this.#settleAccessCredentialMutation(
            decideCollaborationTurnRequest(this.#options.accessAuthority, context.principal, input),
          ),
      },
      createPeerMeshOperationHandlers(this.#options.peerMesh, {
        requestDrain: () => this.#requestDrain(),
      }),
      domainHandlers,
    );
  }

  async #settleAccessCredentialMutation<
    T extends {
      readonly ok: boolean;
      readonly error?: { readonly code: string };
    },
  >(operation: Promise<T>): Promise<T> {
    const outcome = await operation;
    if (!outcome.ok && outcome.error?.code === 'commit_outcome_unknown') {
      this.#requestDrain();
    }
    return outcome;
  }

  #statusSnapshot(): HostStatusResult {
    const peer = this.peerListeners[0];
    return {
      hostEpoch: this.hostEpoch,
      compositionId: this.compositionDescriptor.id,
      compositionRevision: this.compositionDescriptor.revision,
      state: this.#state,
      connections: this.#acceptedTransports.size,
      activeOperations: this.#activeOperations,
      activeResidencies: this.#residencies.activeCount,
      ...(peer
        ? {
            peerEndpoint: peer.reachability,
          }
        : {}),
    };
  }

  #activitySnapshot(): HostActivitySnapshot {
    return {
      connections: this.#acceptedTransports.size,
      activeOperations: this.#activeOperations,
      processUptimeSeconds: Math.max(0, Math.floor(process.uptime())),
      residencies: this.#residencies.snapshot(),
    };
  }

  #hasUpgradeBlockingActivity(): boolean {
    // The request's own accepted transport is expected. Any other live
    // connection arrived after discovery or remained attached and therefore
    // requires explicit interruption authority before retirement.
    if (this.#acceptedTransports.size > 1) return true;
    if (this.#activeCommandOperations > 1) return true;
    return this.#residencies.drainCount > 0;
  }

  #beginCompositionDrain(): void {
    if (!this.#composition || this.#compositionDrainBegun) return;
    this.#compositionDrainBegun = true;
    this.#composition.beginDrain();
  }

  #waitForOperations(): Promise<void> {
    if (this.#activeOperations === 0) return Promise.resolve();
    return new Promise((resolve) => this.#operationDrainWaiters.add(resolve));
  }

  #waitForResidencies(): Promise<void> {
    return this.#residencies.waitForEmpty();
  }

  #waitForResidenciesExcept(excludedLabel: string): Promise<void> {
    return this.#residencies.waitForEmptyExcept(excludedLabel);
  }

  #scheduleIdleIfNeeded(): void {
    if (this.#lifecycle.kind === 'service') return;
    if (this.#shutdownRequested) return;
    // One timer authority per lifecycle phase: until the first connection is
    // accepted, only #initialConnectionDeadline governs (it defers under an
    // in-flight handshake up to a bounded number of times); afterwards the
    // idle timer owns the idleGraceMs exit, with in-flight handshakes visible
    // to #isTrueIdle().
    if (!this.#hasAcceptedConnection) return;
    if (!this.#isTrueIdle() || this.#idleTimer) return;
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = undefined;
      if (!this.#isTrueIdle()) return;
      void this.#commitShutdown().catch(() => undefined);
    }, this.#lifecycle.idleGraceMs);
  }

  #isTrueIdle(exceptHandshaking?: RuntimeHostMessageTransport): boolean {
    // A transport mid-handshake keeps the Host busy, except the one whose
    // admission is being decided right now: counting it would make every
    // true-idle takeover observe itself as activity.
    const handshaking =
      exceptHandshaking !== undefined && this.#handshakingTransports.has(exceptHandshaking)
        ? this.#handshakingTransports.size - 1
        : this.#handshakingTransports.size;
    return (
      this.#state === 'ready' &&
      this.#acceptedTransports.size === 0 &&
      handshaking === 0 &&
      this.#activeOperations === 0 &&
      this.#residencies.activeCount === 0
    );
  }

  // The replacement advice in a rejection is what a stale Client acts on.
  // In-flight handshakes resolve within milliseconds and must not flip that
  // advice, so unlike the idle timer and the takeover decision it ignores
  // the handshaking set entirely.
  #isSettledForReplacementAdvice(): boolean {
    return (
      this.#state === 'ready' &&
      this.#acceptedTransports.size === 0 &&
      this.#activeOperations === 0 &&
      this.#residencies.activeCount === 0
    );
  }

  // The idle timer only arms once the kernel reaches true idle, so a
  // composition startup that never settles or a residency held from boot
  // would keep an ephemeral candidate that no Client ever reached alive
  // forever. This deadline bounds the wait for the first accepted connection
  // independently of composition progress. A handshake in flight defers it by
  // the handshake budget instead of draining under a connecting Client, but
  // only a bounded number of times: connections enter the handshaking set
  // before their first hello byte, so a reconnect loop that never completes a
  // handshake must not push the deadline out indefinitely.
  #armInitialConnectionDeadline(delayMs?: number): void {
    if (this.#lifecycle.kind !== 'ephemeral') return;
    if (this.#hasAcceptedConnection || this.#shutdownRequested) return;
    this.#initialConnectionDeadline = setTimeout(() => {
      this.#initialConnectionDeadline = undefined;
      if (this.#hasAcceptedConnection || this.#shutdownRequested) return;
      if (
        this.#handshakingTransports.size > 0 &&
        this.#initialConnectionDeadlineDeferrals < INITIAL_CONNECTION_DEADLINE_DEFERRAL_LIMIT
      ) {
        this.#initialConnectionDeadlineDeferrals += 1;
        this.#armInitialConnectionDeadline(this.#handshakeTimeoutMs);
        return;
      }
      this.#requestDrain();
    }, delayMs ?? this.#lifecycle.initialConnectionTimeoutMs);
  }

  #cancelInitialConnectionDeadline(): void {
    if (!this.#initialConnectionDeadline) return;
    clearTimeout(this.#initialConnectionDeadline);
    this.#initialConnectionDeadline = undefined;
  }

  #cancelIdle(): void {
    if (!this.#idleTimer) return;
    clearTimeout(this.#idleTimer);
    this.#idleTimer = undefined;
  }

  #settleLifecycleAfterWork(): void {
    if (this.#shutdownRequested) {
      this.#commitRequestedShutdownIfQuiescent();
      return;
    }
    this.#scheduleIdleIfNeeded();
  }

  #commitRequestedShutdownIfQuiescent(): void {
    if (this.#activeCommandOperations !== 0) return;
    void this.#commitShutdown().catch(() => undefined);
  }

  #commitShutdown(): Promise<void> {
    if (this.#terminationRequired) return this.closed;
    if (!this.#shutdownTask) {
      if (!this.#shutdownRequested) {
        this.#shutdownRequested = true;
        this.#armShutdownDeadline();
        this.#beginCompositionDrain();
      }
      this.#state = 'draining';
      this.#cancelIdle();
      this.#cancelInitialConnectionDeadline();
      this.#shutdownTask = this.#closeResources();
      void this.#shutdownTask.then(
        () => {
          this.#clearShutdownDeadline();
          if (!this.#terminationRequired) this.#resolveClosed();
        },
        (error: unknown) => {
          this.#clearShutdownDeadline();
          if (!this.#terminationRequired) this.#rejectClosed(error);
        },
      );
    }
    return this.closed;
  }

  #armShutdownDeadline(): void {
    if (this.#shutdownDeadlineTimer || this.#terminationRequired) return;
    this.#shutdownDeadlineTimer = setTimeout(() => {
      this.#shutdownDeadlineTimer = undefined;
      const error = new RuntimeHostProcessTerminationRequiredError(this.#shutdownGraceMs);
      this.#terminationRequired = error;
      this.#rejectClosed(error);
    }, this.#shutdownGraceMs);
  }

  #clearShutdownDeadline(): void {
    if (!this.#shutdownDeadlineTimer) return;
    clearTimeout(this.#shutdownDeadlineTimer);
    this.#shutdownDeadlineTimer = undefined;
  }

  #assertShutdownCanContinue(): void {
    if (this.#terminationRequired) throw this.#terminationRequired;
  }

  async #closeResources(): Promise<void> {
    const errors: unknown[] = [];
    this.#unsubscribeAccessRevocations?.();
    this.#unsubscribeSessionGrantRevocations?.();
    // Stop new admissions before any asynchronous shutdown bookkeeping. The
    // shutdown deadline may expire while publishing the draining registration;
    // leaving the listener open in that case strands an unreachable, ref'ed
    // server until the process is forcibly terminated.
    const listenerClosed = this.#listeners
      ?.closeAdmission()
      .catch((error: unknown) => errors.push(error));
    await this.#publishRegistration().catch((error: unknown) => errors.push(error));
    this.#assertShutdownCanContinue();
    const accepted = [...this.#acceptedTransports];
    const handshaking = [...this.#handshakingTransports];
    const operationDrain = this.#waitForOperations();
    const [operationsDrained] = await Promise.all([
      waitForBoundedCompletion(operationDrain, SHUTDOWN_OPERATION_GRACE_MS),
      waitForTransportClose(handshaking, SHUTDOWN_HANDSHAKE_GRACE_MS),
    ]);
    this.#assertShutdownCanContinue();
    if (!operationsDrained) {
      for (const transport of accepted) transport.abort();
    }
    for (const transport of handshaking) transport.abort();
    await operationDrain;
    this.#assertShutdownCanContinue();
    await this.#compositionStartup;
    this.#assertShutdownCanContinue();
    await this.#composition?.close().catch((error: unknown) => errors.push(error));
    this.#assertShutdownCanContinue();
    await this.#waitForResidencies();
    this.#assertShutdownCanContinue();
    for (const transport of accepted) transport.abort();
    await listenerClosed;
    this.#assertShutdownCanContinue();
    await this.#listeners?.cleanup().catch((error: unknown) => errors.push(error));
    this.#assertShutdownCanContinue();
    await this.#options.accessAuthority?.close().catch((error: unknown) => errors.push(error));
    this.#assertShutdownCanContinue();
    await removeHostRegistration(this.#options.owner.controlDirectory, this.hostEpoch).catch(
      (error: unknown) => errors.push(error),
    );
    this.#assertShutdownCanContinue();
    await this.#options.owner.close().catch((error: unknown) => errors.push(error));
    this.#assertShutdownCanContinue();
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        'Runtime Host shutdown did not cleanly close every resource',
      );
    }
  }

  async #abortStartup(): Promise<void> {
    this.#state = 'draining';
    this.#unsubscribeAccessRevocations?.();
    this.#unsubscribeSessionGrantRevocations?.();
    for (const transport of this.#handshakingTransports) transport.abort();
    for (const transport of this.#acceptedTransports) transport.abort();
    await this.#listeners?.closeAdmission().catch(() => undefined);
    await this.#listeners?.cleanup().catch(() => undefined);
    await this.#options.accessAuthority?.close().catch(() => undefined);
    await removeHostRegistration(this.#options.owner.controlDirectory, this.hostEpoch).catch(
      () => undefined,
    );
    await this.#options.owner.close();
    this.#resolveClosed();
  }

  #publishRegistration(): Promise<void> {
    const registration: HostRegistration = {
      kind: 'maka-runtime-host',
      schemaVersion: RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION,
      rootId: this.#options.owner.capability.rootId,
      hostEpoch: this.hostEpoch,
      endpoint: this.endpoint,
      ...(this.websocketEndpoints.length === 0
        ? {}
        : { websocketEndpoints: this.websocketEndpoints }),
      protocolMin: HOST_PROTOCOL.min,
      protocolMax: HOST_PROTOCOL.max,
      compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH,
      compositionId: this.compositionDescriptor.id,
      compositionRevision: this.compositionDescriptor.revision,
      lifecycleMode: this.#lifecycle.kind,
      ...(this.#options.generation === undefined ? {} : { generation: this.#options.generation }),
      state: this.#state,
      pid: process.pid,
      createdAt: this.#createdAt,
    };
    return writeHostRegistration(this.#options.owner.controlDirectory, registration);
  }
}

async function waitForTransportClose(
  transports: readonly RuntimeHostMessageTransport[],
  timeoutMs: number,
): Promise<void> {
  if (transports.length === 0) return;
  await waitForBoundedCompletion(
    Promise.all(transports.map((transport) => transport.closed)),
    timeoutMs,
  );
}

async function waitForBoundedCompletion(
  task: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      task.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function assertDuration(value: number, label: string, minimum: 0 | 1): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > 120_000) {
    throw new RangeError(`${label} must be an integer between ${minimum} and 120000`);
  }
}

function normalizeLifecycle(options: RuntimeHostKernelOptions): RuntimeHostLifecycle {
  const lifecycleMode: unknown = options.lifecycleMode;
  if (lifecycleMode === 'service') {
    if (
      Object.hasOwn(options, 'initialConnectionTimeoutMs') ||
      Object.hasOwn(options, 'idleGraceMs')
    ) {
      throw new TypeError('Runtime Host service lifecycle does not accept idle timeouts');
    }
    return { kind: 'service' };
  }
  if (lifecycleMode !== undefined && lifecycleMode !== 'ephemeral') {
    throw new TypeError('Runtime Host lifecycleMode must be ephemeral or service');
  }
  const idleGraceMs = options.idleGraceMs ?? DEFAULT_IDLE_GRACE_MS;
  const initialConnectionTimeoutMs = options.initialConnectionTimeoutMs ?? idleGraceMs;
  assertDuration(initialConnectionTimeoutMs, 'initialConnectionTimeoutMs', 0);
  assertDuration(idleGraceMs, 'idleGraceMs', 0);
  return { kind: 'ephemeral', initialConnectionTimeoutMs, idleGraceMs };
}
