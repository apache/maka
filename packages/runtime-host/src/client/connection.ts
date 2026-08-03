import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { performance } from 'node:perf_hooks';
import {
  discoverMarkedStorageRoot,
  prepareStorageRootControlDirectory,
  resolveExistingStorageRootControlDirectory,
  resolveStorageRoot,
  type StorageRootCapability,
} from '@maka/storage/root-authority';
import { readHostRegistration, RuntimeHostRegistrationError } from '../control/registration.js';
import {
  decodeHostFrame,
  isClientCapabilityHostFrameKind,
  type ClientCapabilityHostFrame,
  type ClientCapabilityReplaceResult,
  type ClientCapabilityUnregisterResult,
  type ClientSurface,
  type ContextCompactInput,
  type ContextCompactResult,
  type ContextDiagnosticsQueryInput,
  type ContextDiagnosticsResult,
  type HostOperationErrorCode,
  type HostIncompatible,
  type HostRegistration,
  type HostStatusResult,
  HOST_OPERATION_SPECS,
  type OperationInput,
  type OperationKey,
  type OperationOutput,
  type ProtocolRange,
  type RequestFrame,
  type ResponseFrame,
  type SubscriptionFrame,
  type SubscriptionOpenInput,
  type SessionCwdRelocateInput,
  type SessionUpdateResult,
  type TurnQueryInput,
  type TurnRegenerateInput,
  type TurnResumePlan,
  type TurnResumeQueryInput,
  type TurnResumeStartInput,
  type TurnResumeStartResult,
  type TurnSnapshot,
  type TurnStartInput,
  type TurnStopInput,
  requireClientInstanceId,
  validateProtocolRange,
} from '../protocol/index.js';
import { FramedTransport, RuntimeHostTransportError } from '../transport/framed-transport.js';
import type { OperationSpec } from '../protocol/operation-spec.js';
import {
  ClientSessionSubscription,
  RuntimeHostSubscriptionError,
  type RuntimeHostSessionSubscription,
} from './session-subscription.js';
import { ClientCapabilityChannel } from './client-capability-channel.js';
import type { ClientCapabilityProvider } from './client-capability.js';

const DEFAULT_CONNECT_TIMEOUT_MS = 500;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 2_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 2_000;

export interface ConnectRuntimeHostInput {
  rootPath: string;
  surface: ClientSurface;
  protocol: ProtocolRange;
  clientInstanceId?: string;
  connectTimeoutMs?: number;
  handshakeTimeoutMs?: number;
}

export type RuntimeHostUnavailableReason =
  | 'not_registered'
  | 'invalid_registration'
  | 'root_mismatch'
  | 'connect_failed'
  | 'handshake_failed'
  | 'epoch_mismatch';

export type ConnectRuntimeHostResult =
  | {
      kind: 'connected';
      connection: RuntimeHostConnection;
      registration: HostRegistration;
    }
  | {
      kind: 'incompatible';
      handshake: HostIncompatible;
      registration: HostRegistration;
    }
  | { kind: 'draining'; registration: HostRegistration }
  | {
      kind: 'unavailable';
      reason: RuntimeHostUnavailableReason;
      registration?: HostRegistration;
    };

type ConnectResolvedRuntimeHostResult =
  | ConnectRuntimeHostResult
  | {
      kind: 'election_deadline_elapsed';
      endpointConnected: boolean;
    };

class ElectionDeadlineElapsedError extends Error {
  constructor() {
    super('Runtime Host election deadline elapsed');
    this.name = 'ElectionDeadlineElapsedError';
  }
}

interface ConnectResolvedRuntimeHostInput
  extends Omit<ConnectRuntimeHostInput, 'rootPath' | 'clientInstanceId'> {
  capability: StorageRootCapability<'interactive'>;
  clientInstanceId: string;
  controlDirectory: string;
  electionDeadline?: number;
}

export interface RuntimeHostConnection {
  readonly hostEpoch: string;
  readonly connectionId: string;
  readonly selectedProtocol: number;
  readonly closed: Promise<void>;
  request<K extends DirectRequestOperationKey>(
    operation: K,
    input: OperationInput<K>,
    timeoutMs?: number,
  ): Promise<OperationOutput<K>>;
  status(timeoutMs?: number): Promise<HostStatusResult>;
  startTurn(input: TurnStartInput, timeoutMs?: number): Promise<TurnSnapshot>;
  queryTurn(input: TurnQueryInput, timeoutMs?: number): Promise<TurnSnapshot>;
  stopTurn(input: TurnStopInput, timeoutMs?: number): Promise<TurnSnapshot>;
  regenerateTurn(input: TurnRegenerateInput, timeoutMs?: number): Promise<TurnSnapshot>;
  queryContextDiagnostics(
    input: ContextDiagnosticsQueryInput,
    timeoutMs?: number,
  ): Promise<ContextDiagnosticsResult>;
  compactContext(input: ContextCompactInput, timeoutMs?: number): Promise<ContextCompactResult>;
  relocateSessionCwd(
    input: SessionCwdRelocateInput,
    timeoutMs?: number,
  ): Promise<SessionUpdateResult>;
  queryTurnResume(input: TurnResumeQueryInput, timeoutMs?: number): Promise<TurnResumePlan>;
  startTurnResume(input: TurnResumeStartInput, timeoutMs?: number): Promise<TurnResumeStartResult>;
  openSessionSubscription(
    input: SubscriptionOpenInput,
    timeoutMs?: number,
  ): Promise<RuntimeHostSessionSubscription>;
  close(): Promise<void>;
  replaceClientCapabilities(
    provider: ClientCapabilityProvider,
    timeoutMs?: number,
  ): Promise<ClientCapabilityReplaceResult>;
  unregisterClientCapabilities(timeoutMs?: number): Promise<ClientCapabilityUnregisterResult>;
}

export type DirectRequestOperationKey = Exclude<
  OperationKey,
  | 'subscription.open'
  | 'subscription.close'
  | 'client.capability.replace'
  | 'client.capability.unregister'
>;

export class RuntimeHostOperationError extends Error {
  constructor(
    readonly operation: OperationKey,
    readonly code: HostOperationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RuntimeHostOperationError';
  }
}

interface PendingRequest {
  operation: OperationKey;
  accept(value: unknown): unknown;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer?: NodeJS.Timeout;
}

class RuntimeHostConnectionImpl implements RuntimeHostConnection {
  readonly hostEpoch: string;
  readonly connectionId: string;
  readonly selectedProtocol: number;
  readonly closed: Promise<void>;
  readonly #transport: FramedTransport;
  readonly #pendingRequests = new Map<string, PendingRequest>();
  readonly #subscriptions = new Map<string, ClientSessionSubscription>();
  readonly #retiredSubscriptionIds = new Set<string>();
  readonly #clientCapabilities: ClientCapabilityChannel;
  #terminalError: Error | undefined;

  constructor(
    transport: FramedTransport,
    accepted: {
      hostEpoch: string;
      connectionId: string;
      selectedProtocol: number;
    },
  ) {
    this.#transport = transport;
    this.hostEpoch = accepted.hostEpoch;
    this.connectionId = accepted.connectionId;
    this.selectedProtocol = accepted.selectedProtocol;
    this.closed = this.#transport.closed;
    this.#clientCapabilities = new ClientCapabilityChannel({
      write: (frame) => this.#transport.write(frame),
      replace: (input, timeoutMs) =>
        this.#requestOperation('client.capability.replace', input, timeoutMs, (result) => result),
      unregister: (input, timeoutMs) =>
        this.#requestOperation(
          'client.capability.unregister',
          input,
          timeoutMs,
          (result) => result,
        ),
      onFailure: (error) => this.#fail(error),
    });
    void this.#readResponses();
  }

  request<K extends DirectRequestOperationKey>(
    operation: K,
    input: OperationInput<K>,
    timeoutMs?: number,
  ): Promise<OperationOutput<K>> {
    if (isClientCapabilityMutation(operation)) {
      return Promise.reject(
        new Error('Client Capability mutations require the dedicated capability channel'),
      );
    }
    return this.#requestOperation(
      operation,
      input,
      timeoutMs ?? defaultRequestTimeoutMs(operation),
      (result) => result,
    );
  }

  #requestOperation<K extends OperationKey, Result>(
    operation: K,
    input: OperationInput<K>,
    timeoutMs: number | undefined,
    accept: (result: OperationOutput<K>) => Result,
  ): Promise<Result> {
    const boundedTimeoutMs =
      timeoutMs === undefined ? undefined : requireTimeout(timeoutMs, 'timeoutMs');
    if (this.#terminalError) return Promise.reject(this.#terminalError);
    const spec = HOST_OPERATION_SPECS[operation] as OperationSpec<
      OperationInput<K>,
      OperationOutput<K>,
      HostOperationErrorCode
    >;
    let canonicalInput: OperationInput<K>;
    try {
      canonicalInput = spec.decodeInput(input);
    } catch (error) {
      return Promise.reject(asError(error));
    }
    const requestId = randomUUID();
    const result = new Promise<Result>((resolve, reject) => {
      const timer =
        boundedTimeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              const error = new RuntimeHostTransportError(
                'read_timeout',
                `Timed out waiting for Runtime Host ${operation} response`,
              );
              this.#fail(error);
            }, boundedTimeoutMs);
      this.#pendingRequests.set(requestId, {
        operation,
        accept: (value) => {
          const output = value as OperationOutput<K>;
          spec.assertOutputForInput?.(canonicalInput, output);
          return accept(output);
        },
        resolve: (value) => resolve(value as Result),
        reject,
        timer,
      });
    });
    const frame = {
      requestId,
      operation,
      input: canonicalInput,
    } as RequestFrame;
    void this.#transport.write(frame).catch((error: unknown) => this.#fail(asError(error)));
    return result;
  }

  async status(timeoutMs?: number): Promise<HostStatusResult> {
    const status = await this.request('host.status', {}, timeoutMs);
    if (status.hostEpoch !== this.hostEpoch) {
      const error = new Error('Runtime Host returned status for a different Host Epoch');
      this.#fail(error);
      throw error;
    }
    return status;
  }

  startTurn(input: TurnStartInput, timeoutMs?: number): Promise<TurnSnapshot> {
    return this.request('turn.start', input, timeoutMs);
  }

  queryTurn(input: TurnQueryInput, timeoutMs?: number): Promise<TurnSnapshot> {
    return this.request('turn.query', input, timeoutMs);
  }

  stopTurn(input: TurnStopInput, timeoutMs?: number): Promise<TurnSnapshot> {
    return this.request('turn.stop', input, timeoutMs);
  }

  regenerateTurn(input: TurnRegenerateInput, timeoutMs?: number): Promise<TurnSnapshot> {
    return this.request('turn.regenerate', input, timeoutMs);
  }

  queryContextDiagnostics(
    input: ContextDiagnosticsQueryInput,
    timeoutMs?: number,
  ): Promise<ContextDiagnosticsResult> {
    return this.request('context.diagnostics.query', input, timeoutMs);
  }

  compactContext(input: ContextCompactInput, timeoutMs?: number): Promise<ContextCompactResult> {
    return this.request('context.compact', input, timeoutMs);
  }

  relocateSessionCwd(
    input: SessionCwdRelocateInput,
    timeoutMs?: number,
  ): Promise<SessionUpdateResult> {
    return this.request('session.cwd.relocate', input, timeoutMs);
  }

  queryTurnResume(input: TurnResumeQueryInput, timeoutMs?: number): Promise<TurnResumePlan> {
    return this.request('turn.resume.query', input, timeoutMs);
  }

  startTurnResume(input: TurnResumeStartInput, timeoutMs?: number): Promise<TurnResumeStartResult> {
    return this.request('turn.resume.start', input, timeoutMs);
  }

  openSessionSubscription(
    input: SubscriptionOpenInput,
    timeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS,
  ): Promise<RuntimeHostSessionSubscription> {
    const expectedSessionId = input.sessionId;
    return this.#requestOperation('subscription.open', input, timeoutMs, (result) => {
      if (result.hostEpoch !== this.hostEpoch) {
        throw new RuntimeHostSubscriptionError(
          'host_epoch_changed',
          'Session subscription opened for a different Host Epoch',
        );
      }
      if (result.snapshot.session.sessionId !== expectedSessionId) {
        throw new RuntimeHostSubscriptionError(
          'correlation_changed',
          'Runtime Host opened a subscription for a different Session',
        );
      }
      if (this.#subscriptions.has(result.subscriptionId)) {
        throw new RuntimeHostSubscriptionError(
          'correlation_changed',
          'Runtime Host returned a duplicate subscription identity',
        );
      }
      const subscription = new ClientSessionSubscription(result, () =>
        this.#closeSessionSubscription(result.subscriptionId),
      );
      this.#subscriptions.set(result.subscriptionId, subscription);
      return subscription;
    });
  }

  async close(): Promise<void> {
    this.#clientCapabilities.close(new Error('Runtime Host connection closed by Client'));
    this.#transport.destroy();
    await this.#transport.closed;
  }

  async replaceClientCapabilities(
    provider: ClientCapabilityProvider,
    timeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS,
  ): Promise<ClientCapabilityReplaceResult> {
    return this.#clientCapabilities.replace(provider, timeoutMs);
  }

  async unregisterClientCapabilities(
    timeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS,
  ): Promise<ClientCapabilityUnregisterResult> {
    return this.#clientCapabilities.unregister(timeoutMs);
  }

  async #readResponses(): Promise<void> {
    try {
      while (true) {
        const frame = decodeHostFrame(await this.#transport.read(0));
        if ('kind' in frame) {
          if (isClientCapabilityHostFrameKind(frame.kind)) {
            this.#clientCapabilities.accept(frame as ClientCapabilityHostFrame);
            continue;
          }
          switch (frame.kind) {
            case 'subscription.session_projection':
            case 'subscription.session_delta':
            case 'subscription.session_event':
            case 'subscription.agent_graph_changed':
            case 'subscription.closed':
              this.#acceptSubscriptionFrame(frame);
              continue;
            default:
              throw new Error('Runtime Host returned a handshake frame after acceptance');
          }
        }
        this.#acceptResponse(frame);
      }
    } catch (error) {
      this.#fail(asError(error));
    }
  }

  #acceptResponse(frame: ResponseFrame): void {
    const pending = this.#pendingRequests.get(frame.requestId);
    if (!pending || pending.operation !== frame.operation) {
      this.#fail(new Error('Runtime Host returned an unmatched operation response'));
      return;
    }
    this.#pendingRequests.delete(frame.requestId);
    if (pending.timer) clearTimeout(pending.timer);
    if (frame.ok) {
      try {
        pending.resolve(pending.accept(frame.result));
      } catch (error) {
        const failure = asError(error);
        pending.reject(failure);
        this.#fail(failure);
      }
      return;
    }
    pending.reject(
      new RuntimeHostOperationError(frame.operation, frame.error.code, frame.error.message),
    );
  }

  #acceptSubscriptionFrame(frame: SubscriptionFrame): void {
    const subscription = this.#subscriptions.get(frame.subscriptionId);
    if (!subscription) {
      if (this.#retiredSubscriptionIds.has(frame.subscriptionId)) return;
      this.#fail(new Error('Runtime Host returned an unmatched subscription frame'));
      return;
    }
    try {
      subscription.accept(frame);
      if (frame.kind === 'subscription.closed') {
        this.#subscriptions.delete(frame.subscriptionId);
      }
    } catch (error) {
      const failure = asError(error);
      if (failure instanceof RuntimeHostSubscriptionError) {
        this.#invalidateSubscription(subscription, failure);
        return;
      }
      this.#fail(failure);
    }
  }

  async #closeSessionSubscription(subscriptionId: string): Promise<void> {
    const subscription = this.#subscriptions.get(subscriptionId);
    if (!subscription) return;
    await this.#requestOperation(
      'subscription.close',
      { subscriptionId },
      DEFAULT_HANDSHAKE_TIMEOUT_MS,
      (result) => {
        if (result.subscriptionId !== subscriptionId) {
          throw new Error('Runtime Host closed a different subscription');
        }
      },
    );
    this.#subscriptions.delete(subscriptionId);
    subscription.finish();
  }

  #invalidateSubscription(
    subscription: ClientSessionSubscription,
    error: RuntimeHostSubscriptionError,
  ): void {
    const { subscriptionId } = subscription;
    if (this.#subscriptions.get(subscriptionId) !== subscription) return;
    this.#subscriptions.delete(subscriptionId);
    this.#retiredSubscriptionIds.add(subscriptionId);
    subscription.fail(error);
    if (this.#terminalError) return;
    void this.#requestOperation(
      'subscription.close',
      { subscriptionId },
      DEFAULT_HANDSHAKE_TIMEOUT_MS,
      () => this.#retiredSubscriptionIds.delete(subscriptionId),
    ).catch((failure: unknown) => this.#fail(asError(failure)));
  }

  #fail(error: Error): void {
    if (this.#terminalError) return;
    this.#terminalError = error;
    for (const pending of this.#pendingRequests.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pendingRequests.clear();
    const subscriptionError = new RuntimeHostSubscriptionError(
      'connection_closed',
      `Runtime Host connection closed: ${error.message}`,
    );
    for (const subscription of this.#subscriptions.values()) {
      subscription.fail(subscriptionError);
    }
    this.#subscriptions.clear();
    this.#retiredSubscriptionIds.clear();
    this.#clientCapabilities.close(error);
    this.#transport.destroy();
  }
}

function isClientCapabilityMutation(operation: unknown): boolean {
  return operation === 'client.capability.replace' || operation === 'client.capability.unregister';
}

export async function connectRuntimeHost(
  input: ConnectRuntimeHostInput,
): Promise<ConnectRuntimeHostResult> {
  const normalized = normalizeConnectRuntimeHostInput(input);
  const capability = await resolveStorageRoot({
    path: input.rootPath,
    kind: 'interactive',
  });
  const { controlDirectory } = await prepareStorageRootControlDirectory(capability);
  return finalizeConnectRuntimeHostResult(
    await connectResolvedRuntimeHost({
      ...input,
      ...normalized,
      capability,
      controlDirectory,
    }),
  );
}

/** Connects only through an already published Host control plane and performs no filesystem writes. */
export async function connectExistingRuntimeHost(
  input: ConnectRuntimeHostInput,
): Promise<ConnectRuntimeHostResult> {
  const normalized = normalizeConnectRuntimeHostInput(input);
  const discovered = await discoverMarkedStorageRoot({ path: input.rootPath });
  if (discovered.kind !== 'interactive') {
    return { kind: 'unavailable', reason: 'root_mismatch' };
  }
  const capability = discovered;
  const { controlDirectory } = await resolveExistingStorageRootControlDirectory(capability);
  return finalizeConnectRuntimeHostResult(
    await connectResolvedRuntimeHost({
      ...input,
      ...normalized,
      capability,
      controlDirectory,
    }),
  );
}

function normalizeConnectRuntimeHostInput(input: ConnectRuntimeHostInput): {
  clientInstanceId: string;
  connectTimeoutMs: number;
  handshakeTimeoutMs: number;
} {
  validateProtocolRange(input.protocol);
  return {
    clientInstanceId: requireClientInstanceId(input.clientInstanceId ?? randomUUID()),
    connectTimeoutMs: requireTimeout(
      input.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      'connectTimeoutMs',
    ),
    handshakeTimeoutMs: requireTimeout(
      input.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
      'handshakeTimeoutMs',
    ),
  };
}

function finalizeConnectRuntimeHostResult(
  result: ConnectResolvedRuntimeHostResult,
): ConnectRuntimeHostResult {
  if (result.kind === 'election_deadline_elapsed') {
    return {
      kind: 'unavailable',
      reason: result.endpointConnected ? 'handshake_failed' : 'connect_failed',
    };
  }
  return result;
}

export async function connectResolvedRuntimeHost(
  input: ConnectResolvedRuntimeHostInput,
): Promise<ConnectResolvedRuntimeHostResult> {
  validateProtocolRange(input.protocol);
  requireClientInstanceId(input.clientInstanceId);
  const connectTimeoutMs = requireTimeout(
    input.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    'connectTimeoutMs',
  );
  const handshakeTimeoutMs = requireTimeout(
    input.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
    'handshakeTimeoutMs',
  );
  let registration: HostRegistration | undefined;
  try {
    registration = await readRegistrationBeforeDeadline(
      input.controlDirectory,
      input.electionDeadline,
    );
  } catch (error) {
    if (error instanceof ElectionDeadlineElapsedError) {
      return { kind: 'election_deadline_elapsed', endpointConnected: false };
    }
    if (error instanceof RuntimeHostRegistrationError && error.code === 'invalid_registration') {
      return { kind: 'unavailable', reason: 'invalid_registration' };
    }
    return { kind: 'unavailable', reason: 'connect_failed' };
  }
  if (!registration) return { kind: 'unavailable', reason: 'not_registered' };
  if (registration.rootId !== input.capability.rootId) {
    return { kind: 'unavailable', reason: 'root_mismatch', registration };
  }

  const connectDeadline = phaseDeadline(connectTimeoutMs, input.electionDeadline);
  const connectBudget = remainingTimeout(connectDeadline.at);
  if (connectBudget === undefined) {
    if (connectDeadline.exhaustsElection) {
      return { kind: 'election_deadline_elapsed', endpointConnected: false };
    }
    return { kind: 'unavailable', reason: 'connect_failed', registration };
  }
  let transport: FramedTransport;
  try {
    transport = await openTransport(
      registration.endpoint,
      connectBudget,
      connectDeadline.exhaustsElection,
    );
  } catch (error) {
    if (error instanceof ElectionDeadlineElapsedError) {
      return { kind: 'election_deadline_elapsed', endpointConnected: false };
    }
    return { kind: 'unavailable', reason: 'connect_failed', registration };
  }
  const handshakeDeadline = phaseDeadline(handshakeTimeoutMs, input.electionDeadline);
  const handshakeBudget = remainingTimeout(handshakeDeadline.at);
  if (handshakeBudget === undefined) {
    transport.destroy();
    if (handshakeDeadline.exhaustsElection) {
      return { kind: 'election_deadline_elapsed', endpointConnected: true };
    }
    return { kind: 'unavailable', reason: 'handshake_failed', registration };
  }
  let handshakeTimeoutError: Error | undefined;
  const handshakeTimer = setTimeout(() => {
    handshakeTimeoutError = handshakeDeadline.exhaustsElection
      ? new ElectionDeadlineElapsedError()
      : new Error('Timed out handshaking with Runtime Host');
    transport.destroy(handshakeTimeoutError);
  }, handshakeBudget);
  try {
    await transport.write({
      kind: 'hello',
      clientInstanceId: input.clientInstanceId,
      surface: input.surface,
      protocolMin: input.protocol.min,
      protocolMax: input.protocol.max,
    });
    if (remainingTimeout(handshakeDeadline.at) === undefined) {
      throw handshakeDeadline.exhaustsElection
        ? new ElectionDeadlineElapsedError()
        : new Error('Runtime Host handshake deadline elapsed');
    }
    // The phase timer owns the full hello write/read deadline and its timeout classification.
    const handshake = decodeHostFrame(await transport.read(0));
    if (!('kind' in handshake))
      throw new Error('Runtime Host returned an operation response before handshake');
    if (
      handshake.kind !== 'accepted' &&
      handshake.kind !== 'incompatible' &&
      handshake.kind !== 'draining'
    ) {
      throw new Error('Runtime Host returned a non-handshake frame before acceptance');
    }
    if (handshake.hostEpoch !== registration.hostEpoch) {
      transport.destroy();
      return { kind: 'unavailable', reason: 'epoch_mismatch', registration };
    }
    if (handshake.kind === 'accepted') {
      if (
        handshake.selectedProtocol < input.protocol.min ||
        handshake.selectedProtocol > input.protocol.max ||
        handshake.selectedProtocol < registration.protocolMin ||
        handshake.selectedProtocol > registration.protocolMax
      ) {
        throw new Error('Runtime Host selected a protocol outside the negotiated range');
      }
      return {
        kind: 'connected',
        registration,
        connection: new RuntimeHostConnectionImpl(transport, handshake),
      };
    }
    transport.destroy();
    if (handshake.kind === 'incompatible') return { kind: 'incompatible', handshake, registration };
    return { kind: 'draining', registration };
  } catch (error) {
    transport.destroy();
    const failure = handshakeTimeoutError ?? error;
    if (failure instanceof ElectionDeadlineElapsedError) {
      return { kind: 'election_deadline_elapsed', endpointConnected: true };
    }
    return { kind: 'unavailable', reason: 'handshake_failed', registration };
  } finally {
    clearTimeout(handshakeTimer);
  }
}

function openTransport(
  path: string,
  timeoutMs: number,
  exhaustsElection: boolean,
): Promise<FramedTransport> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(
        exhaustsElection
          ? new ElectionDeadlineElapsedError()
          : new Error('Timed out connecting to Runtime Host'),
      );
    }, timeoutMs);
    const onConnect = () => {
      const transport = new FramedTransport(socket);
      cleanup();
      resolve(transport);
    };
    const onError = (error: Error) => {
      cleanup();
      socket.destroy();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('connect', onConnect);
      socket.off('error', onError);
    };
    socket.once('connect', onConnect);
    socket.once('error', onError);
  });
}

function requireTimeout(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 120_000) {
    throw new RangeError(`${label} must be an integer between 1 and 120000`);
  }
  return value;
}

function defaultRequestTimeoutMs(operation: DirectRequestOperationKey): number | undefined {
  switch (operation) {
    case 'agent.graph.stop':
    case 'connection.models.fetch':
    case 'connection.test.run':
      // Completion effects own their deadlines and may wait for admitted work to settle.
      return undefined;
    default:
      return DEFAULT_REQUEST_TIMEOUT_MS;
  }
}

interface PhaseDeadline {
  at: number;
  exhaustsElection: boolean;
}

function phaseDeadline(timeoutMs: number, outerDeadline: number | undefined): PhaseDeadline {
  const phaseTimeout = performance.now() + timeoutMs;
  if (outerDeadline !== undefined && outerDeadline <= phaseTimeout) {
    return { at: outerDeadline, exhaustsElection: true };
  }
  return { at: phaseTimeout, exhaustsElection: false };
}

function remainingTimeout(deadline: number): number | undefined {
  const remaining = deadline - performance.now();
  return remaining <= 0 ? undefined : Math.max(1, Math.ceil(remaining));
}

function readRegistrationBeforeDeadline(
  controlDirectory: string,
  deadline: number | undefined,
): Promise<HostRegistration | undefined> {
  if (deadline === undefined) return readHostRegistration(controlDirectory);
  const remaining = remainingTimeout(deadline);
  if (remaining === undefined) {
    return Promise.reject(new ElectionDeadlineElapsedError());
  }
  const operation = readHostRegistration(controlDirectory);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new ElectionDeadlineElapsedError()), remaining);
    operation.then(
      (registration) => {
        clearTimeout(timer);
        resolve(registration);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
