import { randomUUID } from 'node:crypto';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { connect } from 'node:net';
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';
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
  encodeProtocolMessage,
  isClientCapabilityHostFrameKind,
  type ClientFrame,
  type ClientCapabilityHostFrame,
  type ClientCapabilityReplaceResult,
  type ClientCapabilityUnregisterResult,
  type ClientSurface,
  type ConfigurationChangedFrame,
  type ContextCompactInput,
  type ContextCompactResult,
  type ContextDiagnosticsQueryInput,
  type ContextDiagnosticsResult,
  type DeepResearchQueryInput,
  type DeepResearchQueryResult,
  type DailyReviewMutateInput,
  type DailyReviewMutateResult,
  type DailyReviewQueryInput,
  type DailyReviewQueryResult,
  type HostDiagnosticsResult,
  type HostOperationErrorCode,
  type HostIncompatible,
  type HostRegistration,
  type HostStatusResult,
  HOST_OPERATION_SPECS,
  INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
  RUNTIME_HOST_COMPATIBILITY_EPOCH,
  RUNTIME_HOST_MAX_IN_FLIGHT_DOMAIN_REQUESTS,
  RUNTIME_HOST_MAX_MESSAGE_BYTES,
  type OperationInput,
  type OperationKey,
  type OperationOutput,
  type PlanControlInput,
  type PlanControlResult,
  type PlanQueryInput,
  type PlanQueryResult,
  type PlanTurnStartInput,
  type PlanTurnStartResult,
  type ProjectCatalogChangedFrame,
  type ProtocolRange,
  type RequestFrame,
  type ResponseFrame,
  type SessionCatalogChangedFrame,
  type ScheduledTaskChangedFrame,
  type SubscriptionFrame,
  type SubscriptionOpenInput,
  type SessionWorkspaceRelocateInput,
  type SessionRecapGenerateInput,
  type SessionRecapGenerateResult,
  type SessionUpdateResult,
  type TurnQueryInput,
  type TurnRegenerateInput,
  type TurnResumePlan,
  type TurnResumeQueryInput,
  type TurnResumeStartInput,
  type TurnResumeStartResult,
  type TurnSnapshot,
  type TurnStartInput,
  type TurnStartResult,
  type TurnStopInput,
  requireClientInstanceId,
  requireHostCompositionId,
  requireHostGeneration,
  requireHostRootId,
  validateProtocolRange,
} from '../protocol/index.js';
import { FramedTransport, RuntimeHostTransportError } from '../transport/framed-transport.js';
import type { RuntimeHostMessageTransport } from '../transport/message-transport.js';
import { WebSocketTransport } from '../transport/websocket-transport.js';
import type { OperationMode, OperationSpec } from '../protocol/operation-spec.js';
import {
  ClientSessionSubscription,
  RuntimeHostSubscriptionError,
  type RuntimeHostSessionSubscription,
} from './session-subscription.js';
import { ClientCapabilityChannel } from './client-capability-channel.js';
import type { ClientCapabilityProvider } from './client-capability.js';

const DEFAULT_CONNECT_TIMEOUT_MS = 500;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 2_000;
const DEFAULT_LIVENESS_INTERVAL_MS = 2_000;
const DEFAULT_LIVENESS_TIMEOUT_MS = 2_000;
const MAX_WEBSOCKET_FRAGMENTS = 256;
const MAX_WEBSOCKET_BUFFERED_CHUNKS = 256;

export interface ConnectRuntimeHostInput {
  rootPath: string;
  surface: ClientSurface;
  protocol: ProtocolRange;
  compositionId?: string;
  generation?: string;
  takeoverHostEpoch?: string;
  clientInstanceId?: string;
  connectTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  /**
   * Interval between liveness probes while a domain request is outstanding.
   * Injectable so tests exercise requests that outlive a probe cycle without
   * waiting the real cadence; defaults to DEFAULT_LIVENESS_INTERVAL_MS (2s).
   */
  livenessIntervalMs?: number;
  /**
   * Invoked after each liveness probe round-trips and validates its Host
   * Epoch. Test observability: lets a probe-crossing test prove probes
   * actually fired inside its window instead of assuming the cadence took.
   * Diagnostics only — exceptions it throws are swallowed and never affect
   * connection health.
   */
  onLivenessProbe?: () => void;
}

export type RuntimeHostUnavailableReason =
  | 'not_registered'
  | 'invalid_registration'
  | 'root_mismatch'
  | 'composition_mismatch'
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
  | {
      kind: 'upgrade_required';
      registration: HostRegistration;
      restartable: true;
      handshake: HostIncompatible;
    }
  | {
      kind: 'upgrade_required';
      registration: HostRegistration;
      restartable: false;
      handshake?: HostIncompatible;
    }
  | { kind: 'draining'; registration: HostRegistration }
  | {
      kind: 'unavailable';
      reason: RuntimeHostUnavailableReason;
      registration?: HostRegistration;
    };

export interface ConnectRemoteRuntimeHostInput {
  readonly url: string;
  readonly allowInsecureRemote?: boolean;
  readonly credential: string;
  readonly expectedRootId: string;
  readonly compositionId: string;
  readonly surface: ClientSurface;
  readonly protocol: ProtocolRange;
  readonly clientInstanceId?: string;
  readonly connectTimeoutMs?: number;
  readonly handshakeTimeoutMs?: number;
  readonly livenessIntervalMs?: number;
  readonly onLivenessProbe?: () => void;
  readonly connectionResource?: RuntimeHostConnectionResource;
}

export interface RuntimeHostConnectionResource {
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

export type ConnectRemoteRuntimeHostResult =
  | { kind: 'connected'; connection: RuntimeHostConnection }
  | { kind: 'incompatible'; handshake: HostIncompatible }
  | { kind: 'draining' }
  | {
      kind: 'unavailable';
      reason:
        | 'authentication_failed'
        | 'tls_failed'
        | 'unreachable'
        | 'connect_failed'
        | 'handshake_failed'
        | 'root_mismatch'
        | 'composition_mismatch';
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
  readonly rootId: string;
  readonly hostEpoch: string;
  readonly connectionId: string;
  readonly selectedProtocol: number;
  readonly compositionId: string;
  readonly compositionRevision: string;
  readonly closed: Promise<void>;
  request<K extends DirectRequestOperationKey>(
    operation: K,
    input: OperationInput<K>,
    timeoutMs?: number,
  ): Promise<OperationOutput<K>>;
  status(timeoutMs?: number): Promise<HostStatusResult>;
  queryHostDiagnostics(timeoutMs?: number): Promise<HostDiagnosticsResult>;
  startTurn(input: TurnStartInput, timeoutMs?: number): Promise<TurnStartResult>;
  queryTurn(input: TurnQueryInput, timeoutMs?: number): Promise<TurnSnapshot>;
  stopTurn(input: TurnStopInput, timeoutMs?: number): Promise<TurnSnapshot>;
  regenerateTurn(input: TurnRegenerateInput, timeoutMs?: number): Promise<TurnSnapshot>;
  queryContextDiagnostics(
    input: ContextDiagnosticsQueryInput,
    timeoutMs?: number,
  ): Promise<ContextDiagnosticsResult>;
  compactContext(input: ContextCompactInput, timeoutMs?: number): Promise<ContextCompactResult>;
  relocateSessionWorkspace(
    input: SessionWorkspaceRelocateInput,
    timeoutMs?: number,
  ): Promise<SessionUpdateResult>;
  generateSessionRecap(
    input: SessionRecapGenerateInput,
    timeoutMs?: number,
  ): Promise<SessionRecapGenerateResult>;
  queryPlan(input: PlanQueryInput, timeoutMs?: number): Promise<PlanQueryResult>;
  controlPlan(input: PlanControlInput, timeoutMs?: number): Promise<PlanControlResult>;
  startPlanTurn(input: PlanTurnStartInput, timeoutMs?: number): Promise<PlanTurnStartResult>;
  queryDeepResearch(
    input: DeepResearchQueryInput,
    timeoutMs?: number,
  ): Promise<DeepResearchQueryResult>;
  queryDailyReview(
    input: DailyReviewQueryInput,
    timeoutMs?: number,
  ): Promise<DailyReviewQueryResult>;
  mutateDailyReview(
    input: DailyReviewMutateInput,
    timeoutMs?: number,
  ): Promise<DailyReviewMutateResult>;
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
  subscribeConfigurationChanges(listener: (revision: number) => void): () => void;
  subscribeProjectCatalogChanges(listener: (revision: number) => void): () => void;
  subscribeSessionCatalogChanges(listener: (frame: SessionCatalogChangedFrame) => void): () => void;
  subscribeScheduledTaskChanges(listener: (frame: ScheduledTaskChangedFrame) => void): () => void;
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

export type RuntimeHostRequestDispatch = 'not_dispatched' | 'dispatched';
export type RuntimeHostRequestInterruptionReason = 'connection_lost' | 'timeout';

export class RuntimeHostRequestInterruptedError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly operation: OperationKey,
    readonly mode: OperationMode,
    readonly dispatch: RuntimeHostRequestDispatch,
    readonly reason: RuntimeHostRequestInterruptionReason,
    options: ErrorOptions = {},
  ) {
    const outcome =
      mode === 'query'
        ? reason === 'connection_lost'
          ? 'the query may be retried on another connection'
          : 'the query timed out and may be retried'
        : dispatch === 'not_dispatched'
          ? 'the operation was not dispatched'
          : 'the operation outcome is unknown; do not retry it automatically';
    super(`Runtime Host ${operation} was interrupted: ${outcome}`, options);
    this.name = 'RuntimeHostRequestInterruptedError';
    this.retryable = mode === 'query';
  }
}

interface PendingRequest {
  operation: OperationKey;
  accept(value: unknown): unknown;
  resolve(value: unknown): void;
  reject(error: Error): void;
  domainState?: 'queued' | 'in_flight';
  timer?: NodeJS.Timeout;
}

interface RetiredRequest {
  operation: OperationKey;
  domainState?: 'in_flight';
}

interface QueuedDomainFrame {
  requestId: string;
  frame: RequestFrame;
}

type RequestTimeoutScope = 'request' | 'connection';

class RuntimeHostConnectionImpl implements RuntimeHostConnection {
  readonly rootId: string;
  readonly hostEpoch: string;
  readonly connectionId: string;
  readonly selectedProtocol: number;
  readonly compositionId: string;
  readonly compositionRevision: string;
  readonly closed: Promise<void>;
  readonly #transport: RuntimeHostMessageTransport;
  readonly #pendingRequests = new Map<string, PendingRequest>();
  readonly #retiredRequests = new Map<string, RetiredRequest>();
  readonly #queuedDomainFrames: QueuedDomainFrame[] = [];
  readonly #subscriptions = new Map<string, ClientSessionSubscription>();
  readonly #retiredSubscriptionIds = new Set<string>();
  readonly #clientCapabilities: ClientCapabilityChannel;
  readonly #configurationChangeListeners = new Set<(revision: number) => void>();
  readonly #projectCatalogChangeListeners = new Set<(revision: number) => void>();
  readonly #sessionCatalogChangeListeners = new Set<(frame: SessionCatalogChangedFrame) => void>();
  readonly #scheduledTaskChangeListeners = new Set<(frame: ScheduledTaskChangedFrame) => void>();
  #livenessTimer: NodeJS.Timeout | undefined;
  #livenessProbePending = false;
  #inFlightDomainRequests = 0;
  #terminalError: Error | undefined;
  readonly #livenessIntervalMs: number;
  readonly #onLivenessProbe: (() => void) | undefined;

  constructor(
    transport: RuntimeHostMessageTransport,
    accepted: {
      rootId: string;
      hostEpoch: string;
      connectionId: string;
      selectedProtocol: number;
      compositionId: string;
      compositionRevision: string;
    },
    // livenessIntervalMs is validated by connectResolvedRuntimeHost alongside
    // the other connect timeouts, before any transport work happens.
    options?: {
      livenessIntervalMs?: number;
      onLivenessProbe?: () => void;
      connectionResource?: RuntimeHostConnectionResource;
    },
  ) {
    this.#livenessIntervalMs = options?.livenessIntervalMs ?? DEFAULT_LIVENESS_INTERVAL_MS;
    this.#onLivenessProbe = options?.onLivenessProbe;
    this.#transport = transport;
    this.rootId = accepted.rootId;
    this.hostEpoch = accepted.hostEpoch;
    this.connectionId = accepted.connectionId;
    this.selectedProtocol = accepted.selectedProtocol;
    this.compositionId = accepted.compositionId;
    this.compositionRevision = accepted.compositionRevision;
    const connectionResource = options?.connectionResource;
    if (connectionResource) {
      const abortForResourceClosure = (cause: Error) =>
        this.#transport.abort(
          new RuntimeHostTransportError('closed', 'Runtime Host connection resource closed', {
            cause,
          }),
        );
      void connectionResource.closed.then(
        () => abortForResourceClosure(new Error('Runtime Host connection resource closed')),
        (error) => abortForResourceClosure(asError(error)),
      );
      this.closed = this.#transport.closed.finally(() => connectionResource.close());
    } else {
      this.closed = this.#transport.closed;
    }
    this.#clientCapabilities = new ClientCapabilityChannel({
      write: (frame) => writeClientFrame(this.#transport, frame),
      replace: (input, timeoutMs) =>
        this.#requestOperation(
          'client.capability.replace',
          input,
          timeoutMs,
          (result) => result,
          'connection',
        ),
      unregister: (input, timeoutMs) =>
        this.#requestOperation(
          'client.capability.unregister',
          input,
          timeoutMs,
          (result) => result,
          'connection',
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
      timeoutMs ?? (operation === 'host.status' ? DEFAULT_LIVENESS_TIMEOUT_MS : undefined),
      (result) => result,
      operation === 'host.status' ? 'connection' : 'request',
    );
  }

  #requestOperation<K extends OperationKey, Result>(
    operation: K,
    input: OperationInput<K>,
    timeoutMs: number | undefined,
    accept: (result: OperationOutput<K>) => Result,
    timeoutScope: RequestTimeoutScope,
  ): Promise<Result> {
    const boundedTimeoutMs =
      timeoutMs === undefined ? undefined : requireTimeout(timeoutMs, 'timeoutMs');
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
    if (this.#terminalError) {
      return Promise.reject(
        this.#terminalError instanceof RuntimeHostTransportError
          ? interruptedRequestError(
              operation,
              'not_dispatched',
              'connection_lost',
              this.#terminalError,
            )
          : this.#terminalError,
      );
    }
    const requestId = randomUUID();
    const isDomainRequest = operation !== 'host.status';
    const result = new Promise<Result>((resolve, reject) => {
      const timer =
        boundedTimeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              const error = requestTimeoutError(operation);
              if (timeoutScope === 'connection') this.#fail(error);
              else this.#retireRequest(requestId, error);
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
        ...(isDomainRequest ? { domainState: 'queued' as const } : {}),
        timer,
      });
      this.#scheduleLivenessCheck();
    });
    const frame = {
      requestId,
      operation,
      input: canonicalInput,
    } as RequestFrame;
    if (isDomainRequest) {
      this.#queuedDomainFrames.push({ requestId, frame });
      this.#drainDomainRequests();
    } else {
      void writeClientFrame(this.#transport, frame).catch((error: unknown) =>
        this.#fail(asError(error)),
      );
    }
    return result;
  }

  #drainDomainRequests(): void {
    while (
      !this.#terminalError &&
      this.#inFlightDomainRequests < RUNTIME_HOST_MAX_IN_FLIGHT_DOMAIN_REQUESTS
    ) {
      const queued = this.#queuedDomainFrames.shift();
      if (!queued) return;
      const pending = this.#pendingRequests.get(queued.requestId);
      if (!pending || pending.domainState !== 'queued') continue;
      pending.domainState = 'in_flight';
      this.#inFlightDomainRequests += 1;
      void writeClientFrame(this.#transport, queued.frame).catch((error: unknown) =>
        this.#fail(asError(error)),
      );
    }
  }

  async status(timeoutMs?: number): Promise<HostStatusResult> {
    const status = await this.request('host.status', {}, timeoutMs);
    if (
      status.hostEpoch !== this.hostEpoch ||
      status.compositionId !== this.compositionId ||
      status.compositionRevision !== this.compositionRevision
    ) {
      const error = new Error('Runtime Host returned status for a different Host identity');
      this.#fail(error);
      throw error;
    }
    return status;
  }

  queryHostDiagnostics(timeoutMs?: number): Promise<HostDiagnosticsResult> {
    return this.request('host.diagnostics.query', {}, timeoutMs);
  }

  startTurn(input: TurnStartInput, timeoutMs?: number): Promise<TurnStartResult> {
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

  relocateSessionWorkspace(
    input: SessionWorkspaceRelocateInput,
    timeoutMs?: number,
  ): Promise<SessionUpdateResult> {
    return this.request('session.workspace.relocate', input, timeoutMs);
  }

  generateSessionRecap(
    input: SessionRecapGenerateInput,
    timeoutMs?: number,
  ): Promise<SessionRecapGenerateResult> {
    return this.request('session.recap.generate', input, timeoutMs);
  }

  queryPlan(input: PlanQueryInput, timeoutMs?: number): Promise<PlanQueryResult> {
    return this.request('plan.query', input, timeoutMs);
  }

  controlPlan(input: PlanControlInput, timeoutMs?: number): Promise<PlanControlResult> {
    return this.request('plan.control', input, timeoutMs);
  }

  startPlanTurn(input: PlanTurnStartInput, timeoutMs?: number): Promise<PlanTurnStartResult> {
    return this.request('plan.turn.start', input, timeoutMs);
  }

  queryDeepResearch(
    input: DeepResearchQueryInput,
    timeoutMs?: number,
  ): Promise<DeepResearchQueryResult> {
    return this.request('deep-research.query', input, timeoutMs);
  }

  queryDailyReview(
    input: DailyReviewQueryInput,
    timeoutMs?: number,
  ): Promise<DailyReviewQueryResult> {
    return this.request('daily-review.query', input, timeoutMs);
  }

  mutateDailyReview(
    input: DailyReviewMutateInput,
    timeoutMs?: number,
  ): Promise<DailyReviewMutateResult> {
    return this.request('daily-review.mutate', input, timeoutMs);
  }

  queryTurnResume(input: TurnResumeQueryInput, timeoutMs?: number): Promise<TurnResumePlan> {
    return this.request('turn.resume.query', input, timeoutMs);
  }

  startTurnResume(input: TurnResumeStartInput, timeoutMs?: number): Promise<TurnResumeStartResult> {
    return this.request('turn.resume.start', input, timeoutMs);
  }

  openSessionSubscription(
    input: SubscriptionOpenInput,
    timeoutMs?: number,
  ): Promise<RuntimeHostSessionSubscription> {
    const expectedSessionId = input.sessionId;
    return this.#requestOperation(
      'subscription.open',
      input,
      timeoutMs,
      (result) => {
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
        const subscription = new ClientSessionSubscription(
          result,
          () => this.#closeSessionSubscription(result.subscriptionId),
          (query) => this.request('session.transcript.page', query, timeoutMs),
          async () => {
            try {
              await this.request(
                'session.transcript.overlay.release',
                { subscriptionId: result.subscriptionId },
                timeoutMs,
              );
            } catch (error) {
              this.#fail(asError(error));
              throw error;
            }
          },
        );
        this.#subscriptions.set(result.subscriptionId, subscription);
        return subscription;
      },
      'connection',
    );
  }

  async close(): Promise<void> {
    this.#clientCapabilities.close(new Error('Runtime Host connection closed by Client'));
    this.#transport.abort();
    await this.closed;
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

  subscribeConfigurationChanges(listener: (revision: number) => void): () => void {
    this.#configurationChangeListeners.add(listener);
    return () => this.#configurationChangeListeners.delete(listener);
  }

  subscribeProjectCatalogChanges(listener: (revision: number) => void): () => void {
    this.#projectCatalogChangeListeners.add(listener);
    return () => this.#projectCatalogChangeListeners.delete(listener);
  }

  subscribeSessionCatalogChanges(
    listener: (frame: SessionCatalogChangedFrame) => void,
  ): () => void {
    this.#sessionCatalogChangeListeners.add(listener);
    return () => this.#sessionCatalogChangeListeners.delete(listener);
  }

  subscribeScheduledTaskChanges(listener: (frame: ScheduledTaskChangedFrame) => void): () => void {
    this.#scheduledTaskChangeListeners.add(listener);
    return () => this.#scheduledTaskChangeListeners.delete(listener);
  }

  async #readResponses(): Promise<void> {
    try {
      while (true) {
        const frame = decodeHostFrame(await this.#transport.read(0));
        this.#resetLivenessCheck();
        if ('kind' in frame) {
          if (isClientCapabilityHostFrameKind(frame.kind)) {
            this.#clientCapabilities.accept(frame as ClientCapabilityHostFrame);
            continue;
          }
          switch (frame.kind) {
            case 'configuration.changed':
              this.#acceptConfigurationChanged(frame);
              continue;
            case 'project.catalog.changed':
              this.#acceptProjectCatalogChanged(frame);
              continue;
            case 'session.catalog.changed':
              this.#acceptSessionCatalogChanged(frame);
              continue;
            case 'scheduled-task.changed':
              this.#acceptScheduledTaskChanged(frame);
              continue;
            case 'subscription.session_projection':
            case 'subscription.session_delta':
            case 'subscription.session_event':
            case 'subscription.transcript_advanced':
            case 'subscription.session_domain_changed':
            case 'subscription.runtime_resource_pty_data':
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
    if (!pending) {
      const retired = this.#retiredRequests.get(frame.requestId);
      if (retired?.operation === frame.operation) {
        this.#retiredRequests.delete(frame.requestId);
        this.#releaseDomainSlot(retired);
        this.#scheduleLivenessCheck();
        return;
      }
      this.#fail(new Error('Runtime Host returned an unmatched operation response'));
      return;
    }
    if (pending.operation !== frame.operation) {
      this.#fail(new Error('Runtime Host returned an unmatched operation response'));
      return;
    }
    this.#pendingRequests.delete(frame.requestId);
    if (pending.timer) clearTimeout(pending.timer);
    this.#scheduleLivenessCheck();
    if (frame.ok) {
      try {
        const accepted = pending.accept(frame.result);
        this.#releaseDomainSlot(pending);
        pending.resolve(accepted);
      } catch (error) {
        const failure = asError(error);
        pending.reject(failure);
        this.#fail(failure);
      }
      return;
    }
    this.#releaseDomainSlot(pending);
    pending.reject(
      new RuntimeHostOperationError(frame.operation, frame.error.code, frame.error.message),
    );
  }

  #acceptConfigurationChanged(frame: ConfigurationChangedFrame): void {
    for (const listener of this.#configurationChangeListeners) {
      try {
        listener(frame.revision);
      } catch {
        // A presentation listener cannot invalidate the Host connection.
      }
    }
  }

  #acceptProjectCatalogChanged(frame: ProjectCatalogChangedFrame): void {
    for (const listener of this.#projectCatalogChangeListeners) {
      try {
        listener(frame.revision);
      } catch {
        // A presentation listener cannot invalidate the Host connection.
      }
    }
  }

  #acceptSessionCatalogChanged(frame: SessionCatalogChangedFrame): void {
    for (const listener of this.#sessionCatalogChangeListeners) {
      try {
        listener(frame);
      } catch {
        // A presentation listener cannot invalidate the Host connection.
      }
    }
  }

  #acceptScheduledTaskChanged(frame: ScheduledTaskChangedFrame): void {
    for (const listener of this.#scheduledTaskChangeListeners) {
      try {
        listener(frame);
      } catch {
        // A presentation listener cannot invalidate the Host connection.
      }
    }
  }

  #retireRequest(requestId: string, error: Error): void {
    const pending = this.#pendingRequests.get(requestId);
    if (!pending) return;
    this.#pendingRequests.delete(requestId);
    if (pending.domainState === 'queued') {
      const index = this.#queuedDomainFrames.findIndex((queued) => queued.requestId === requestId);
      if (index !== -1) this.#queuedDomainFrames.splice(index, 1);
      pending.reject(
        interruptedRequestError(pending.operation, 'not_dispatched', 'timeout', error),
      );
      this.#scheduleLivenessCheck();
      return;
    }
    this.#retiredRequests.set(requestId, {
      operation: pending.operation,
      ...(pending.domainState === 'in_flight' ? { domainState: pending.domainState } : {}),
    });
    pending.reject(interruptedRequestError(pending.operation, 'dispatched', 'timeout', error));
    this.#scheduleLivenessCheck();
  }

  #releaseDomainSlot(request: PendingRequest | RetiredRequest): void {
    if (request.domainState !== 'in_flight') return;
    request.domainState = undefined;
    this.#inFlightDomainRequests -= 1;
    this.#drainDomainRequests();
  }

  #resetLivenessCheck(): void {
    if (this.#livenessTimer) clearTimeout(this.#livenessTimer);
    this.#livenessTimer = undefined;
    this.#scheduleLivenessCheck();
  }

  #scheduleLivenessCheck(): void {
    if (
      this.#terminalError ||
      this.#livenessTimer ||
      this.#livenessProbePending ||
      !this.#hasOutstandingDomainRequest()
    ) {
      if (!this.#hasOutstandingDomainRequest() && this.#livenessTimer) {
        clearTimeout(this.#livenessTimer);
        this.#livenessTimer = undefined;
      }
      return;
    }
    this.#livenessTimer = setTimeout(() => {
      this.#livenessTimer = undefined;
      this.#startLivenessProbe();
    }, this.#livenessIntervalMs);
  }

  #hasOutstandingDomainRequest(): boolean {
    if (this.#retiredRequests.size > 0) return true;
    for (const pending of this.#pendingRequests.values()) {
      if (pending.operation !== 'host.status') return true;
    }
    return false;
  }

  #startLivenessProbe(): void {
    if (this.#terminalError || this.#livenessProbePending || !this.#hasOutstandingDomainRequest()) {
      return;
    }
    this.#livenessProbePending = true;
    void this.#requestOperation(
      'host.status',
      {},
      DEFAULT_LIVENESS_TIMEOUT_MS,
      (status) => {
        if (status.hostEpoch !== this.hostEpoch) {
          throw new Error('Runtime Host returned status for a different Host Epoch');
        }
        try {
          this.#onLivenessProbe?.();
        } catch {
          // Diagnostics hook: an observer exception must never fail the
          // connection it is watching.
        }
      },
      'connection',
    )
      .catch((error: unknown) => this.#fail(asError(error)))
      .finally(() => {
        this.#livenessProbePending = false;
        this.#scheduleLivenessCheck();
      });
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
      'connection',
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
      'connection',
    ).catch((failure: unknown) => this.#fail(asError(failure)));
  }

  #fail(error: Error): void {
    if (this.#terminalError) return;
    this.#terminalError = error;
    if (this.#livenessTimer) clearTimeout(this.#livenessTimer);
    this.#livenessTimer = undefined;
    this.#queuedDomainFrames.length = 0;
    this.#inFlightDomainRequests = 0;
    for (const pending of this.#pendingRequests.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(
        error instanceof RuntimeHostTransportError
          ? interruptedRequestError(
              pending.operation,
              pending.domainState === 'queued' ? 'not_dispatched' : 'dispatched',
              'connection_lost',
              error,
            )
          : error,
      );
    }
    this.#pendingRequests.clear();
    this.#retiredRequests.clear();
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
    this.#configurationChangeListeners.clear();
    this.#sessionCatalogChangeListeners.clear();
    this.#scheduledTaskChangeListeners.clear();
    this.#transport.abort();
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

export async function connectRemoteRuntimeHost(
  input: ConnectRemoteRuntimeHostInput,
): Promise<ConnectRemoteRuntimeHostResult> {
  const connectionResource = input.connectionResource;
  let resourceTransferred = false;
  try {
    const normalized = normalizeConnectRuntimeHostInput(input);
    const compositionId = requireHostCompositionId(input.compositionId);
    const expectedRootId = requireHostRootId(input.expectedRootId);
    const url = normalizeRemoteRuntimeHostUrl(input.url, {
      allowInsecureRemote: input.allowInsecureRemote === true,
    });
    let transport: WebSocketTransport;
    try {
      transport = await openWebSocketTransport(url, input.credential, normalized.connectTimeoutMs);
    } catch (error) {
      return { kind: 'unavailable', reason: classifyRemoteRuntimeHostConnectFailure(error) };
    }
    const timer = setTimeout(() => {
      transport.abort(new Error('Timed out handshaking with Runtime Host'));
    }, normalized.handshakeTimeoutMs);
    try {
      const result = await exchangeRuntimeHostHandshake({
        transport,
        surface: input.surface,
        protocol: input.protocol,
        clientInstanceId: normalized.clientInstanceId,
        compositionId,
        expectedRootId,
        livenessIntervalMs: normalized.livenessIntervalMs,
        onLivenessProbe: input.onLivenessProbe,
        connectionResource,
      });
      if (result.kind === 'connected') {
        resourceTransferred = true;
        return result;
      }
      transport.abort();
      return result.kind === 'incompatible' ? result : { kind: 'draining' };
    } catch (error) {
      transport.abort();
      if (error instanceof RuntimeHostRootMismatchError) {
        return { kind: 'unavailable', reason: 'root_mismatch' };
      }
      if (error instanceof RuntimeHostCompositionMismatchError) {
        return { kind: 'unavailable', reason: 'composition_mismatch' };
      }
      return { kind: 'unavailable', reason: 'handshake_failed' };
    } finally {
      clearTimeout(timer);
    }
  } finally {
    if (!resourceTransferred) await connectionResource?.close().catch(() => undefined);
  }
}

function normalizeConnectRuntimeHostInput(
  input: Pick<
    ConnectRuntimeHostInput,
    | 'protocol'
    | 'clientInstanceId'
    | 'connectTimeoutMs'
    | 'handshakeTimeoutMs'
    | 'livenessIntervalMs'
  >,
): {
  clientInstanceId: string;
  connectTimeoutMs: number;
  handshakeTimeoutMs: number;
  livenessIntervalMs: number;
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
    livenessIntervalMs: requireTimeout(
      input.livenessIntervalMs ?? DEFAULT_LIVENESS_INTERVAL_MS,
      'livenessIntervalMs',
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
  const generation =
    input.generation === undefined ? undefined : requireHostGeneration(input.generation);
  if (input.takeoverHostEpoch !== undefined) {
    requireHostGeneration(input.takeoverHostEpoch);
    if (generation === undefined) {
      throw new TypeError('takeoverHostEpoch requires a Runtime Host generation');
    }
  }
  const connectTimeoutMs = requireTimeout(
    input.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    'connectTimeoutMs',
  );
  const handshakeTimeoutMs = requireTimeout(
    input.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
    'handshakeTimeoutMs',
  );
  const livenessIntervalMs = requireTimeout(
    input.livenessIntervalMs ?? DEFAULT_LIVENESS_INTERVAL_MS,
    'livenessIntervalMs',
  );
  const compositionId = requireHostCompositionId(
    input.compositionId ?? INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
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
    transport.abort();
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
    transport.abort(handshakeTimeoutError);
  }, handshakeBudget);
  try {
    const staleCompatibility = registration.compatibilityEpoch !== RUNTIME_HOST_COMPATIBILITY_EPOCH;
    const helloProtocol = staleCompatibility
      ? {
          min: Math.min(Number.MAX_SAFE_INTEGER, registration.protocolMax + 1),
          max: Math.min(Number.MAX_SAFE_INTEGER, registration.protocolMax + 1),
        }
      : input.protocol;
    const result = await exchangeRuntimeHostHandshake({
      transport,
      surface: input.surface,
      protocol: input.protocol,
      helloProtocol,
      clientInstanceId: input.clientInstanceId,
      compositionId,
      ...(generation === undefined ? {} : { generation }),
      ...(input.takeoverHostEpoch === undefined
        ? {}
        : { takeoverHostEpoch: input.takeoverHostEpoch }),
      expectedHostEpoch: registration.hostEpoch,
      expectedRootId: registration.rootId,
      expectedCompositionRevision: staleCompatibility
        ? undefined
        : registration.compositionRevision,
      hostProtocol: { min: registration.protocolMin, max: registration.protocolMax },
      livenessIntervalMs,
      onLivenessProbe: input.onLivenessProbe,
    });
    if (result.kind === 'connected') {
      if (
        generation !== undefined &&
        registration.lifecycleMode !== 'service' &&
        registration.generation !== generation
      ) {
        await result.connection.close().catch(() => undefined);
        return { kind: 'upgrade_required', registration, restartable: false };
      }
      return { ...result, registration };
    }
    transport.abort();
    if (
      result.kind === 'incompatible' &&
      generation !== undefined &&
      result.handshake.compatibilityEpoch === RUNTIME_HOST_COMPATIBILITY_EPOCH &&
      result.handshake.compositionId === compositionId &&
      result.handshake.generation !== generation
    ) {
      return registration.lifecycleMode === 'ephemeral' &&
        result.handshake.activity !== undefined &&
        result.handshake.activity.connections === 0
        ? {
            kind: 'upgrade_required',
            registration,
            restartable: true,
            handshake: result.handshake,
          }
        : {
            kind: 'upgrade_required',
            registration,
            restartable: false,
            handshake: result.handshake,
          };
    }
    return result.kind === 'incompatible'
      ? { ...result, registration }
      : { kind: 'draining', registration };
  } catch (error) {
    transport.abort();
    const failure = handshakeTimeoutError ?? error;
    if (failure instanceof RuntimeHostEpochMismatchError) {
      return { kind: 'unavailable', reason: 'epoch_mismatch', registration };
    }
    if (failure instanceof RuntimeHostRootMismatchError) {
      return { kind: 'unavailable', reason: 'root_mismatch', registration };
    }
    if (failure instanceof RuntimeHostCompositionMismatchError) {
      return { kind: 'unavailable', reason: 'composition_mismatch', registration };
    }
    if (failure instanceof ElectionDeadlineElapsedError) {
      return { kind: 'election_deadline_elapsed', endpointConnected: true };
    }
    return { kind: 'unavailable', reason: 'handshake_failed', registration };
  } finally {
    clearTimeout(handshakeTimer);
  }
}

interface ExchangeRuntimeHostHandshakeInput {
  readonly transport: RuntimeHostMessageTransport;
  readonly surface: ClientSurface;
  readonly protocol: ProtocolRange;
  readonly helloProtocol?: ProtocolRange;
  readonly hostProtocol?: ProtocolRange;
  readonly clientInstanceId: string;
  readonly compositionId: string;
  readonly generation?: string;
  readonly takeoverHostEpoch?: string;
  readonly expectedHostEpoch?: string;
  readonly expectedRootId?: string;
  readonly expectedCompositionRevision?: string;
  readonly livenessIntervalMs?: number;
  readonly onLivenessProbe?: () => void;
  readonly connectionResource?: RuntimeHostConnectionResource;
}

async function exchangeRuntimeHostHandshake(
  input: ExchangeRuntimeHostHandshakeInput,
): Promise<
  | { kind: 'connected'; connection: RuntimeHostConnection }
  | { kind: 'incompatible'; handshake: HostIncompatible }
  | { kind: 'draining' }
> {
  const helloProtocol = input.helloProtocol ?? input.protocol;
  await writeClientFrame(input.transport, {
    kind: 'hello',
    clientInstanceId: input.clientInstanceId,
    surface: input.surface,
    protocolMin: helloProtocol.min,
    protocolMax: helloProtocol.max,
    compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH,
    compositionId: input.compositionId,
    ...(input.generation === undefined ? {} : { generation: input.generation }),
    ...(input.takeoverHostEpoch === undefined
      ? {}
      : { takeover: { expectedHostEpoch: input.takeoverHostEpoch } }),
  });
  const handshake = decodeHostFrame(await input.transport.read(0));
  if (!('kind' in handshake)) {
    throw new Error('Runtime Host returned an operation response before handshake');
  }
  if (
    handshake.kind !== 'accepted' &&
    handshake.kind !== 'incompatible' &&
    handshake.kind !== 'draining'
  ) {
    throw new Error('Runtime Host returned a non-handshake frame before acceptance');
  }
  if (input.expectedHostEpoch && handshake.hostEpoch !== input.expectedHostEpoch) {
    throw new RuntimeHostEpochMismatchError();
  }
  if (handshake.kind === 'incompatible') return { kind: 'incompatible', handshake };
  if (
    handshake.compositionId !== input.compositionId ||
    (input.expectedCompositionRevision !== undefined &&
      handshake.compositionRevision !== input.expectedCompositionRevision)
  ) {
    throw new RuntimeHostCompositionMismatchError();
  }
  if (handshake.kind === 'draining') return { kind: 'draining' };
  if (input.expectedRootId && handshake.rootId !== input.expectedRootId) {
    throw new RuntimeHostRootMismatchError();
  }
  if (handshake.compatibilityEpoch !== RUNTIME_HOST_COMPATIBILITY_EPOCH) {
    throw new Error('Runtime Host accepted an incompatible schema epoch');
  }
  if (
    handshake.selectedProtocol < input.protocol.min ||
    handshake.selectedProtocol > input.protocol.max ||
    (input.hostProtocol !== undefined &&
      (handshake.selectedProtocol < input.hostProtocol.min ||
        handshake.selectedProtocol > input.hostProtocol.max))
  ) {
    throw new Error('Runtime Host selected a protocol outside the negotiated range');
  }
  return {
    kind: 'connected',
    connection: new RuntimeHostConnectionImpl(input.transport, handshake, {
      livenessIntervalMs: input.livenessIntervalMs,
      onLivenessProbe: input.onLivenessProbe,
      connectionResource: input.connectionResource,
    }),
  };
}

class RuntimeHostEpochMismatchError extends Error {}
class RuntimeHostRootMismatchError extends Error {}
class RuntimeHostCompositionMismatchError extends Error {}

export function normalizeRemoteRuntimeHostUrl(
  value: string,
  options: { readonly allowInsecureRemote?: boolean } = {},
): URL {
  const url = new URL(value);
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error('Remote Runtime Host URL must use ws or wss');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Remote Runtime Host URL must not contain credentials, a query, or a fragment');
  }
  if (
    url.protocol === 'ws:' &&
    url.hostname !== '127.0.0.1' &&
    url.hostname !== '[::1]' &&
    url.hostname !== '::1' &&
    options.allowInsecureRemote !== true
  ) {
    throw new Error('Plain remote Runtime Host WebSocket URLs must use loopback');
  }
  return url;
}

function openWebSocketTransport(
  url: URL,
  credential: string,
  timeoutMs: number,
): Promise<WebSocketTransport> {
  if (!credential || /\s/u.test(credential)) {
    return Promise.reject(new RemoteRuntimeHostConnectError('authentication_failed'));
  }
  return new Promise((resolve, reject) => {
    const webSocketOptions = {
      headers: { authorization: `Bearer ${credential}` },
      handshakeTimeout: timeoutMs,
      maxPayload: RUNTIME_HOST_MAX_MESSAGE_BYTES,
      maxFragments: MAX_WEBSOCKET_FRAGMENTS,
      maxBufferedChunks: MAX_WEBSOCKET_BUFFERED_CHUNKS,
      perMessageDeflate: false,
    };
    const socket = new WebSocket(url, webSocketOptions);
    const onOpen = () => {
      cleanup();
      resolve(new WebSocketTransport(socket));
    };
    const onError = (error: Error) => {
      cleanup();
      socket.terminate();
      reject(error);
    };
    const onUnexpectedResponse = (_request: ClientRequest, response: IncomingMessage) => {
      cleanup();
      response.resume();
      socket.once('error', () => undefined);
      reject(
        new RemoteRuntimeHostConnectError(
          response.statusCode === 401 ? 'authentication_failed' : 'connect_failed',
        ),
      );
      socket.terminate();
    };
    const cleanup = () => {
      socket.off('open', onOpen);
      socket.off('error', onError);
      socket.off('unexpected-response', onUnexpectedResponse);
    };
    socket.once('open', onOpen);
    socket.once('error', onError);
    socket.once('unexpected-response', onUnexpectedResponse);
  });
}

type RemoteRuntimeHostConnectFailureReason = Extract<
  ConnectRemoteRuntimeHostResult,
  { kind: 'unavailable' }
>['reason'];

const REMOTE_NETWORK_ERROR_CODES = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
]);
const REMOTE_TLS_ERROR_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_REVOKED',
  'CERT_SIGNATURE_FAILURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

class RemoteRuntimeHostConnectError extends Error {
  constructor(readonly reason: RemoteRuntimeHostConnectFailureReason) {
    super(`Remote Runtime Host connection failed (${reason})`);
    this.name = 'RemoteRuntimeHostConnectError';
  }
}

export function classifyRemoteRuntimeHostConnectFailure(
  error: unknown,
): RemoteRuntimeHostConnectFailureReason {
  if (error instanceof RemoteRuntimeHostConnectError) return error.reason;
  const code =
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined;
  if (code && REMOTE_NETWORK_ERROR_CODES.has(code)) return 'unreachable';
  if (
    code &&
    (REMOTE_TLS_ERROR_CODES.has(code) || code.startsWith('ERR_TLS_') || code.startsWith('ERR_SSL_'))
  ) {
    return 'tls_failed';
  }
  return 'connect_failed';
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

function writeClientFrame(
  transport: RuntimeHostMessageTransport,
  frame: ClientFrame,
): Promise<void> {
  try {
    return transport.write(encodeProtocolMessage(frame));
  } catch (error) {
    return Promise.reject(error);
  }
}

function requestTimeoutError(operation: OperationKey): RuntimeHostTransportError {
  return new RuntimeHostTransportError(
    'read_timeout',
    `Timed out waiting for Runtime Host ${operation} response`,
  );
}

function interruptedRequestError(
  operation: OperationKey,
  dispatch: RuntimeHostRequestDispatch,
  reason: RuntimeHostRequestInterruptionReason,
  cause: Error,
): RuntimeHostRequestInterruptedError {
  return new RuntimeHostRequestInterruptedError(
    operation,
    HOST_OPERATION_SPECS[operation].mode,
    dispatch,
    reason,
    { cause },
  );
}
