import { randomUUID } from 'node:crypto';
import { arch as osArch, release as osRelease } from 'node:os';
import {
  assertStateRootOwner,
  authenticateStateRootOwner,
  type StateRootOwner,
  type StorageRootKind,
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
  revokeAccessCredential,
  type RuntimeHostAccessAuthority,
} from './access-authority.js';
import type { RuntimeHostConnectionAuthority } from './connection-authority.js';
import type { SessionContinuityService } from './session-continuity-service.js';
import type { ClientCapabilityService } from './client-capability-service.js';
import type { HostConfigurationChangeService } from './configuration-change-service.js';
import type { HostProjectCatalogChangeService } from './project-catalog-change-service.js';
import { runtimeHostLogBuffer } from '../process-diagnostics.js';
import type { HostSessionCatalogChangeService } from './session-catalog-change-service.js';
import type { HostScheduledTaskChangeService } from './scheduled-task-change-service.js';
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

const DEFAULT_IDLE_GRACE_MS = 30_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 10_000;
const SHUTDOWN_HANDSHAKE_GRACE_MS = 1_000;
const SHUTDOWN_OPERATION_GRACE_MS = 1_000;
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

export interface RuntimeHostCompositionContext<K extends StorageRootKind = 'interactive'> {
  owner: StateRootOwner<K>;
  hostEpoch: string;
  acquireResidency(label: string): RuntimeHostResidency;
  /** Irreversible fail-stop latch; normal residency still uses acquireResidency(). */
  retainUntilProcessExit(): void;
  requestDrain(): void;
  waitForResidencies?(): Promise<void>;
  waitForResidenciesExcept?(excludedLabel: string): Promise<void>;
}

export interface RuntimeHostComposition {
  readonly handlers: DomainOperationHandlerMap;
  readonly moduleIds?: readonly string[];
  readonly continuity?: SessionContinuityService;
  readonly clientCapabilities?: ClientCapabilityService;
  readonly configurationChanges?: HostConfigurationChangeService;
  readonly projectCatalogChanges?: HostProjectCatalogChangeService;
  readonly sessionCatalogChanges?: HostSessionCatalogChangeService;
  readonly scheduledTaskChanges?: HostScheduledTaskChangeService;
  releaseConnection?(connectionId: string): void;
  beginDrain(): void;
  recover(): Promise<void>;
  close(): Promise<void>;
}

export type RuntimeHostCompositionFactory<K extends StorageRootKind = 'interactive'> = (
  context: RuntimeHostCompositionContext<K>,
) => Promise<RuntimeHostComposition>;

interface RuntimeHostKernelCommonOptions<K extends StorageRootKind> {
  owner: StateRootOwner<K>;
  handshakeTimeoutMs?: number;
  shutdownGraceMs?: number;
  composition: RuntimeHostCompositionSource<K>;
  listenerSetFactory?: RuntimeHostListenerSetFactory;
  accessAuthority?: RuntimeHostAccessAuthority;
}

export type RuntimeHostLifecycleMode = 'ephemeral' | 'service';

export type RuntimeHostKernelOptions<K extends StorageRootKind = 'interactive'> =
  RuntimeHostKernelCommonOptions<K> &
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

type RuntimeHostKernelInternalOptions = RuntimeHostKernelOptions<StorageRootKind>;

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
  readonly #options: RuntimeHostKernelInternalOptions;
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
  #shutdownRequested = false;
  #shutdownTask: Promise<void> | undefined;
  #shutdownDeadlineTimer: NodeJS.Timeout | undefined;
  #terminationRequired: RuntimeHostProcessTerminationRequiredError | undefined;
  #resolveClosed!: () => void;
  #rejectClosed!: (error: unknown) => void;
  readonly #unsubscribeAccessRevocations: (() => void) | undefined;

  private constructor(options: RuntimeHostKernelInternalOptions) {
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
    this.#operationHandlers = this.#createOperationHandlers(
      createUnavailableDomainOperationHandlers(),
    );
    this.closed = new Promise((resolve, reject) => {
      this.#resolveClosed = resolve;
      this.#rejectClosed = reject;
    });
  }

  static async start<K extends StorageRootKind>(
    options: RuntimeHostKernelOptions<K>,
  ): Promise<RuntimeHostKernel> {
    const owner = authenticateStateRootOwner(options.owner, options.owner.capability.kind);
    let host: RuntimeHostKernel | undefined;
    try {
      host = new RuntimeHostKernel(eraseRootKind(options, owner));
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
        await owner.close();
      }
      throw error;
    }
  }

  get state(): HostLifecycleState {
    return this.#state;
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
      this.#armShutdownDeadline();
      this.#beginCompositionDrain();
    }
    this.#commitRequestedShutdownIfQuiescent();
  }

  async #start(): Promise<void> {
    await assertStateRootOwner(this.#options.owner, this.#options.owner.capability.kind);
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
    const compositionStartup = (async () => {
      try {
        this.#composition = await this.#options.composition.create({
          owner: this.#options.owner,
          hostEpoch: this.hostEpoch,
          acquireResidency: (label) => this.#acquireResidency(label),
          retainUntilProcessExit: () => this.#retainUntilProcessExit(),
          requestDrain: () => this.#requestDrain(),
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
          surface: frame.surface,
          authority,
        },
        resolveHandlers: () => this.#operationHandlers,
        resolveContinuity: () => this.#composition?.continuity,
        resolveClientCapabilities: () => this.#composition?.clientCapabilities,
        resolveConfigurationChanges: () => this.#composition?.configurationChanges,
        resolveProjectCatalogChanges: () => this.#composition?.projectCatalogChanges,
        resolveSessionCatalogChanges: () => this.#composition?.sessionCatalogChanges,
        resolveScheduledTaskChanges: () => this.#composition?.scheduledTaskChanges,
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
    const selectedProtocol = negotiateProtocol(
      { min: hello.protocolMin, max: hello.protocolMax },
      HOST_PROTOCOL,
    );
    const generationMismatch =
      this.#lifecycle.kind === 'ephemeral' &&
      hello.generation !== undefined &&
      hello.generation !== this.#options.generation;
    if (generationMismatch && hello.takeover?.expectedHostEpoch === this.hostEpoch) {
      if (authority.principalKind === 'local_owner' && this.#acceptedTransports.size === 0) {
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
          this.#lifecycle.kind === 'ephemeral' && this.#isTrueIdle()
            ? 'wait_for_idle_exit'
            : 'blocked_by_residency',
        ...(generationMismatch && authority.principalKind === 'local_owner'
          ? { activity: this.#activitySnapshot() }
          : {}),
      };
    }
    this.#hasAcceptedConnection = true;
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
      await assertStateRootOwner(this.#options.owner, this.#options.owner.capability.kind);
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
    this.#residencies.acquire('process-retention');
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
            logs: runtimeHostLogBuffer.snapshot(),
          },
        }),
        'host.upgrade.prepare': async (input) => {
          if (this.#lifecycle.kind !== 'ephemeral') {
            return {
              ok: false,
              error: {
                code: 'operation_unavailable',
                message: 'Runtime Host service lifecycle cannot be replaced by a Client',
              },
            };
          }
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
          this.#requestDrain();
          return { ok: true, result: { kind: 'prepared', pid: process.pid } };
        },
        'access.credential.issue': async (input) =>
          issueAccessCredential(this.#options.accessAuthority, input),
        'access.credential.revoke': async (input) =>
          revokeAccessCredential(this.#options.accessAuthority, input),
      },
      domainHandlers,
    );
  }

  #statusSnapshot(): HostStatusResult {
    return {
      hostEpoch: this.hostEpoch,
      compositionId: this.compositionDescriptor.id,
      compositionRevision: this.compositionDescriptor.revision,
      state: this.#state,
      connections: this.#acceptedTransports.size,
      activeOperations: this.#activeOperations,
      activeResidencies: this.#residencies.activeCount,
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
    if (this.#activeCommandOperations > 1) return true;
    return this.#residencies.snapshot().some(({ label }) => label !== 'process-retention');
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
    if (!this.#isTrueIdle() || this.#idleTimer) return;
    const timeoutMs = this.#hasAcceptedConnection
      ? this.#lifecycle.idleGraceMs
      : this.#lifecycle.initialConnectionTimeoutMs;
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = undefined;
      if (!this.#isTrueIdle()) return;
      void this.#commitShutdown().catch(() => undefined);
    }, timeoutMs);
  }

  #isTrueIdle(): boolean {
    return (
      this.#state === 'ready' &&
      this.#acceptedTransports.size === 0 &&
      this.#activeOperations === 0 &&
      this.#residencies.activeCount === 0
    );
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
    for (const transport of this.#handshakingTransports) transport.abort();
    for (const transport of this.#acceptedTransports) transport.abort();
    await this.#listeners?.closeAdmission().catch(() => undefined);
    await this.#listeners?.cleanup().catch(() => undefined);
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

function normalizeLifecycle<K extends StorageRootKind>(
  options: RuntimeHostKernelOptions<K>,
): RuntimeHostLifecycle {
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

function eraseRootKind<K extends StorageRootKind>(
  options: RuntimeHostKernelOptions<K>,
  owner: StateRootOwner<K>,
): RuntimeHostKernelInternalOptions {
  return {
    ...options,
    owner,
    composition: {
      descriptor: options.composition.descriptor,
      create: (context: RuntimeHostCompositionContext<StorageRootKind>) =>
        options.composition.create({ ...context, owner }),
    },
  };
}
