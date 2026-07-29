import { randomUUID } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import {
  assertInteractiveRootOwner,
  authenticateInteractiveRootOwner,
  type InteractiveRootOwner,
} from '@maka/storage/root-authority';
import { prepareRuntimeHostEndpoint, type RuntimeHostEndpoint } from '../control/endpoint.js';
import { removeHostRegistration, writeHostRegistration } from '../control/registration.js';
import {
  decodeClientFrame,
  HOST_OPERATION_SPECS,
  negotiateProtocol,
  RUNTIME_HOST_PROTOCOL_VERSION,
  RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION,
  type ClientHello,
  type HostOperationErrorCode,
  type HostHandshakeResult,
  type HostLifecycleState,
  type HostRegistration,
  type RequestFrame,
} from '../protocol/index.js';
import { FramedTransport } from '../transport/framed-transport.js';
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
import type { SessionContinuityService } from './session-continuity-service.js';

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

export interface RuntimeHostCompositionContext {
  owner: InteractiveRootOwner;
  hostEpoch: string;
  acquireResidency(): RuntimeHostResidency;
  /** Irreversible fail-stop latch; normal residency still uses acquireResidency(). */
  retainUntilProcessExit(): void;
  requestDrain(): void;
}

export interface RuntimeHostComposition {
  readonly handlers: DomainOperationHandlerMap;
  readonly continuity?: SessionContinuityService;
  releaseConnection?(connectionId: string): void;
  beginDrain(): void;
  recover(): Promise<void>;
  close(): Promise<void>;
}

export type RuntimeHostCompositionFactory = (
  context: RuntimeHostCompositionContext,
) => Promise<RuntimeHostComposition>;

export interface RuntimeHostKernelOptions {
  owner: InteractiveRootOwner;
  idleGraceMs?: number;
  handshakeTimeoutMs?: number;
  shutdownGraceMs?: number;
  compositionFactory?: RuntimeHostCompositionFactory;
}

export class RuntimeHostKernel {
  readonly hostEpoch = randomUUID();
  readonly closed: Promise<void>;
  readonly #options: RuntimeHostKernelOptions;
  readonly #createdAt = new Date().toISOString();
  readonly #server: Server;
  readonly #handshakingTransports = new Set<FramedTransport>();
  readonly #acceptedTransports = new Set<FramedTransport>();
  readonly #operationDrainWaiters = new Set<() => void>();
  readonly #residencyDrainWaiters = new Set<() => void>();
  readonly #idleGraceMs: number;
  readonly #handshakeTimeoutMs: number;
  readonly #shutdownGraceMs: number;
  #endpoint: RuntimeHostEndpoint | undefined;
  #state: HostLifecycleState = 'starting';
  #activeOperations = 0;
  #activeCommandOperations = 0;
  #activeResidencies = 0;
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

  private constructor(options: RuntimeHostKernelOptions) {
    assertDuration(options.idleGraceMs ?? DEFAULT_IDLE_GRACE_MS, 'idleGraceMs', 0);
    assertDuration(
      options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
      'handshakeTimeoutMs',
      1,
    );
    assertDuration(options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS, 'shutdownGraceMs', 1);
    this.#idleGraceMs = options.idleGraceMs ?? DEFAULT_IDLE_GRACE_MS;
    this.#handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.#shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
    this.#options = options;
    this.#operationHandlers = this.#createOperationHandlers(
      createUnavailableDomainOperationHandlers(),
    );
    this.closed = new Promise((resolve, reject) => {
      this.#resolveClosed = resolve;
      this.#rejectClosed = reject;
    });
    this.#server = createServer({ allowHalfOpen: true }, (socket) => this.#accept(socket));
  }

  static async start(options: RuntimeHostKernelOptions): Promise<RuntimeHostKernel> {
    const owner = authenticateInteractiveRootOwner(options.owner);
    let host: RuntimeHostKernel | undefined;
    try {
      host = new RuntimeHostKernel({
        owner,
        idleGraceMs: options.idleGraceMs,
        handshakeTimeoutMs: options.handshakeTimeoutMs,
        shutdownGraceMs: options.shutdownGraceMs,
        compositionFactory: options.compositionFactory,
      });
      await host.#start();
      return host;
    } catch (error) {
      if (host) {
        if (host.#endpoint) {
          host.#requestDrain();
          try {
            await host.closed;
          } catch (shutdownError) {
            throw shutdownError;
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
    if (!this.#endpoint) throw new Error('Runtime Host has not started listening');
    return this.#endpoint.path;
  }

  get connectionCount(): number {
    return this.#acceptedTransports.size;
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
    await assertInteractiveRootOwner(this.#options.owner);
    this.#endpoint = await prepareRuntimeHostEndpoint({
      rootId: this.#options.owner.capability.rootId,
      hostEpoch: this.hostEpoch,
    });
    await listen(this.#server, this.#endpoint.path);
    await this.#endpoint.prepareAfterListen();
    await this.#publishRegistration();
    const compositionFactory = this.#options.compositionFactory;
    if (compositionFactory) {
      this.#state = 'recovering';
      await this.#publishRegistration();
      let settleCompositionStartup!: () => void;
      this.#compositionStartup = new Promise((resolve) => {
        settleCompositionStartup = resolve;
      });
      const compositionStartup = (async () => {
        try {
          this.#composition = await compositionFactory({
            owner: this.#options.owner,
            hostEpoch: this.hostEpoch,
            acquireResidency: () => this.#acquireResidency(),
            retainUntilProcessExit: () => this.#retainUntilProcessExit(),
            requestDrain: () => this.#requestDrain(),
          });
          if (this.#shutdownRequested) this.#beginCompositionDrain();
          this.#operationHandlers = this.#createOperationHandlers(this.#composition.handlers);
          await this.#composition.recover();
        } finally {
          settleCompositionStartup();
        }
      })();
      await Promise.race([compositionStartup, this.closed]);
    }
    if (this.#shutdownRequested) {
      this.#commitRequestedShutdownIfQuiescent();
      return;
    }
    this.#state = 'ready';
    await this.#publishRegistration();
    this.#scheduleIdleIfNeeded();
  }

  #accept(socket: Socket): void {
    const transport = new FramedTransport(socket);
    this.#handshakingTransports.add(transport);
    void this.#serveConnection(transport).finally(() => {
      this.#handshakingTransports.delete(transport);
    });
  }

  async #serveConnection(transport: FramedTransport): Promise<void> {
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
      const result = await this.#admitHandshake(frame, transport);
      connectionId = result.kind === 'accepted' ? result.connectionId : undefined;
      await transport.write(result);
      if (result.kind !== 'accepted') {
        transport.destroyAfterFlush();
        return;
      }
      const session = new RuntimeHostConnectionSession({
        transport,
        connection: {
          hostEpoch: this.hostEpoch,
          connectionId: result.connectionId,
          surface: frame.surface,
          principal: 'local_os_user',
        },
        resolveHandlers: () => this.#operationHandlers,
        resolveContinuity: () => this.#composition?.continuity,
        beginOperation: (request) => this.#beginOperation(request),
        onTeardown: releaseTransport,
      });
      await session.run();
    } catch {
      transport.destroy();
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
    transport: FramedTransport,
  ): Promise<HostHandshakeResult> {
    const admittedState = await this.#readAdmissionState();
    if (!admittedState) {
      return { kind: 'draining', hostEpoch: this.hostEpoch };
    }
    const selectedProtocol = negotiateProtocol(
      { min: hello.protocolMin, max: hello.protocolMax },
      HOST_PROTOCOL,
    );
    if (selectedProtocol === undefined) {
      return {
        kind: 'incompatible',
        hostEpoch: this.hostEpoch,
        protocolMin: HOST_PROTOCOL.min,
        protocolMax: HOST_PROTOCOL.max,
        state: admittedState,
        replacement: this.#isTrueIdle() ? 'wait_for_idle_exit' : 'blocked_by_residency',
      };
    }
    this.#acceptedTransports.add(transport);
    this.#handshakingTransports.delete(transport);
    this.#cancelIdle();
    return {
      kind: 'accepted',
      hostEpoch: this.hostEpoch,
      connectionId: randomUUID(),
      selectedProtocol,
      state: admittedState,
    };
  }

  #releaseConnection(transport: FramedTransport): void {
    if (!this.#acceptedTransports.delete(transport)) {
      throw new Error('Runtime Host connection residency underflow');
    }
    this.#settleLifecycleAfterWork();
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
        return this.#acquireResidency();
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

  #acquireResidency(): RuntimeHostResidency {
    this.#activeResidencies += 1;
    this.#cancelIdle();
    let active = true;
    return {
      release: () => {
        if (!active) return;
        active = false;
        if (this.#activeResidencies === 0) throw new Error('Runtime Host residency underflow');
        this.#activeResidencies -= 1;
        if (this.#activeResidencies === 0) {
          for (const resolve of this.#residencyDrainWaiters) resolve();
          this.#residencyDrainWaiters.clear();
        }
        this.#settleLifecycleAfterWork();
      },
    };
  }

  #retainUntilProcessExit(): void {
    if (this.#retainedUntilProcessExit) return;
    this.#retainedUntilProcessExit = true;
    this.#activeResidencies += 1;
    this.#cancelIdle();
  }

  #createOperationHandlers(domainHandlers: DomainOperationHandlerMap): OperationHandlerMap {
    return composeOperationHandlers(
      {
        'host.status': async () => ({
          ok: true,
          result: {
            hostEpoch: this.hostEpoch,
            state: this.#state,
            connections: this.#acceptedTransports.size,
            activeOperations: this.#activeOperations,
            activeResidencies: this.#activeResidencies,
          },
        }),
      },
      domainHandlers,
    );
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
    if (this.#activeResidencies === 0) return Promise.resolve();
    return new Promise((resolve) => this.#residencyDrainWaiters.add(resolve));
  }

  #scheduleIdleIfNeeded(): void {
    if (this.#shutdownRequested) return;
    if (!this.#isTrueIdle() || this.#idleTimer) return;
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = undefined;
      if (!this.#isTrueIdle()) return;
      void this.#commitShutdown().catch(() => undefined);
    }, this.#idleGraceMs);
  }

  #isTrueIdle(): boolean {
    return (
      this.#state === 'ready' &&
      this.#acceptedTransports.size === 0 &&
      this.#activeOperations === 0 &&
      this.#activeResidencies === 0
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
    await this.#publishRegistration().catch((error: unknown) => errors.push(error));
    this.#assertShutdownCanContinue();
    const serverClosed = closeServer(this.#server).catch((error: unknown) => errors.push(error));
    const accepted = [...this.#acceptedTransports];
    const handshaking = [...this.#handshakingTransports];
    const operationDrain = this.#waitForOperations();
    const [operationsDrained] = await Promise.all([
      waitForBoundedCompletion(operationDrain, SHUTDOWN_OPERATION_GRACE_MS),
      waitForTransportClose(handshaking, SHUTDOWN_HANDSHAKE_GRACE_MS),
    ]);
    this.#assertShutdownCanContinue();
    if (!operationsDrained) {
      for (const transport of accepted) transport.destroy();
    }
    for (const transport of handshaking) transport.destroy();
    await operationDrain;
    this.#assertShutdownCanContinue();
    await this.#compositionStartup;
    this.#assertShutdownCanContinue();
    await this.#composition?.close().catch((error: unknown) => errors.push(error));
    this.#assertShutdownCanContinue();
    await this.#waitForResidencies();
    this.#assertShutdownCanContinue();
    for (const transport of accepted) transport.destroy();
    await serverClosed;
    this.#assertShutdownCanContinue();
    await this.#endpoint?.cleanup().catch((error: unknown) => errors.push(error));
    this.#assertShutdownCanContinue();
    await removeHostRegistration(this.#options.owner.controlDirectory, this.hostEpoch).catch(
      (error: unknown) => errors.push(error),
    );
    this.#assertShutdownCanContinue();
    await this.#options.owner.close().catch((error: unknown) => errors.push(error));
    this.#assertShutdownCanContinue();
    if (errors.length > 0)
      throw new AggregateError(
        errors,
        'Runtime Host shutdown did not cleanly close every resource',
      );
  }

  async #abortStartup(): Promise<void> {
    this.#state = 'draining';
    for (const transport of this.#handshakingTransports) transport.destroy();
    for (const transport of this.#acceptedTransports) transport.destroy();
    await closeServer(this.#server).catch(() => undefined);
    await this.#endpoint?.cleanup().catch(() => undefined);
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
      state: this.#state,
      pid: process.pid,
      createdAt: this.#createdAt,
    };
    return writeHostRegistration(this.#options.owner.controlDirectory, registration);
  }
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(path);
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function waitForTransportClose(
  transports: readonly FramedTransport[],
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
