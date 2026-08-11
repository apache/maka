import {
  HOST_OPERATION_SPECS,
  type ClientCapabilityReplaceResult,
  type ClientCapabilityUnregisterResult,
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
  type HostStatusResult,
  type OperationInput,
  type OperationKey,
  type OperationOutput,
  type PlanControlInput,
  type PlanControlResult,
  type PlanQueryInput,
  type PlanQueryResult,
  type PlanTurnStartInput,
  type PlanTurnStartResult,
  type SessionCatalogChangedFrame,
  type ScheduledTaskChangedFrame,
  type SessionWorkspaceRelocateInput,
  type SessionRecapGenerateInput,
  type SessionRecapGenerateResult,
  type SessionUpdateResult,
  type SubscriptionOpenInput,
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
} from '../protocol/index.js';
import type { ClientCapabilityProvider } from './client-capability.js';
import {
  RuntimeHostOperationError,
  RuntimeHostRequestInterruptedError,
  type DirectRequestOperationKey,
  type RuntimeHostConnection,
} from './connection.js';
import {
  RuntimeHostPermanentReconnectError,
  startRuntimeHostReconnectLifecycle,
  type RuntimeHostReconnectBackoff,
  type RuntimeHostReconnectLifecycle,
} from './reconnect-lifecycle.js';
import type { RuntimeHostSessionSubscription } from './session-subscription.js';

export interface RuntimeHostReconnectingConnection extends RuntimeHostConnection {
  readonly reconnecting: true;
}

export async function createRuntimeHostReconnectingConnection(input: {
  readonly initialConnection: RuntimeHostConnection;
  readonly connect: (signal: AbortSignal) => Promise<RuntimeHostConnection>;
  readonly backoff?: RuntimeHostReconnectBackoff;
  readonly onReconnectError?: (error: Error) => void;
  readonly onFatalError?: (error: Error) => void;
}): Promise<RuntimeHostReconnectingConnection> {
  const expectedRootId = input.initialConnection.rootId;
  const expectedProtocol = input.initialConnection.selectedProtocol;
  const expectedCompositionId = input.initialConnection.compositionId;
  const expectedCompositionRevision = input.initialConnection.compositionRevision;
  const connect = async (signal: AbortSignal): Promise<RuntimeHostConnection> => {
    const connection = await input.connect(signal);
    if (connection.rootId !== expectedRootId) {
      await connection.close().catch(() => undefined);
      throw new RuntimeHostPermanentReconnectError(
        `Runtime Host root changed from ${expectedRootId} to ${connection.rootId}`,
      );
    }
    if (connection.selectedProtocol !== expectedProtocol) {
      await connection.close().catch(() => undefined);
      throw new RuntimeHostPermanentReconnectError(
        `Runtime Host protocol changed from ${expectedProtocol} to ${connection.selectedProtocol}`,
      );
    }
    if (
      connection.compositionId !== expectedCompositionId ||
      connection.compositionRevision !== expectedCompositionRevision
    ) {
      await connection.close().catch(() => undefined);
      throw new RuntimeHostPermanentReconnectError(
        `Runtime Host composition changed from ${expectedCompositionId}@${expectedCompositionRevision} to ${connection.compositionId}@${connection.compositionRevision}`,
      );
    }
    return connection;
  };
  const lifecycle = await startRuntimeHostReconnectLifecycle({
    initial: input.initialConnection,
    connect,
    ...(input.backoff ? { backoff: input.backoff } : {}),
    ...(input.onReconnectError ? { onReconnectError: input.onReconnectError } : {}),
    ...(input.onFatalError ? { onFatalError: input.onFatalError } : {}),
  });
  return new RuntimeHostReconnectingConnectionImpl(lifecycle);
}

export function isRuntimeHostReconnectingConnection(
  connection: unknown,
): connection is RuntimeHostReconnectingConnection {
  return (connection as Partial<RuntimeHostReconnectingConnection>).reconnecting === true;
}

class RuntimeHostReconnectingConnectionImpl implements RuntimeHostReconnectingConnection {
  readonly reconnecting = true as const;
  readonly closed: Promise<void>;
  readonly #configurationListeners = new Set<(revision: number) => void>();
  readonly #projectListeners = new Set<(revision: number) => void>();
  readonly #sessionListeners = new Set<(frame: SessionCatalogChangedFrame) => void>();
  readonly #scheduledTaskListeners = new Set<(frame: ScheduledTaskChangedFrame) => void>();
  readonly #lifecycle: RuntimeHostReconnectLifecycle<RuntimeHostConnection>;
  #lastConnection: RuntimeHostConnection;
  #listenerDisposers: (() => void)[] = [];

  constructor(lifecycle: RuntimeHostReconnectLifecycle<RuntimeHostConnection>) {
    const initial = lifecycle.current;
    if (!initial) throw new Error('Runtime Host reconnect lifecycle has no initial connection');
    this.#lifecycle = lifecycle;
    this.#lastConnection = initial;
    this.closed = lifecycle.closed;
    this.#bindListeners(initial);
    lifecycle.subscribe((connection) => {
      this.#unbindListeners();
      if (!connection) return;
      this.#lastConnection = connection;
      this.#bindListeners(connection);
    });
  }

  get rootId(): string {
    return this.#lastConnection.rootId;
  }

  get hostEpoch(): string {
    return this.#lastConnection.hostEpoch;
  }

  get connectionId(): string {
    return this.#lastConnection.connectionId;
  }

  get selectedProtocol(): number {
    return this.#lastConnection.selectedProtocol;
  }

  get compositionId(): string {
    return this.#lastConnection.compositionId;
  }

  get compositionRevision(): string {
    return this.#lastConnection.compositionRevision;
  }

  request<K extends DirectRequestOperationKey>(
    operation: K,
    input: OperationInput<K>,
    timeoutMs?: number,
  ): Promise<OperationOutput<K>> {
    return this.#request(operation, input, timeoutMs);
  }

  status(timeoutMs?: number): Promise<HostStatusResult> {
    return this.#request('host.status', {}, timeoutMs);
  }

  queryHostDiagnostics(timeoutMs?: number): Promise<HostDiagnosticsResult> {
    return this.#request('host.diagnostics.query', {}, timeoutMs);
  }

  startTurn(input: TurnStartInput, timeoutMs?: number): Promise<TurnStartResult> {
    return this.#request('turn.start', input, timeoutMs);
  }

  queryTurn(input: TurnQueryInput, timeoutMs?: number): Promise<TurnSnapshot> {
    return this.#request('turn.query', input, timeoutMs);
  }

  stopTurn(input: TurnStopInput, timeoutMs?: number): Promise<TurnSnapshot> {
    return this.#request('turn.stop', input, timeoutMs);
  }

  regenerateTurn(input: TurnRegenerateInput, timeoutMs?: number): Promise<TurnSnapshot> {
    return this.#request('turn.regenerate', input, timeoutMs);
  }

  queryContextDiagnostics(
    input: ContextDiagnosticsQueryInput,
    timeoutMs?: number,
  ): Promise<ContextDiagnosticsResult> {
    return this.#request('context.diagnostics.query', input, timeoutMs);
  }

  compactContext(input: ContextCompactInput, timeoutMs?: number): Promise<ContextCompactResult> {
    return this.#request('context.compact', input, timeoutMs);
  }

  relocateSessionWorkspace(
    input: SessionWorkspaceRelocateInput,
    timeoutMs?: number,
  ): Promise<SessionUpdateResult> {
    return this.#request('session.workspace.relocate', input, timeoutMs);
  }

  generateSessionRecap(
    input: SessionRecapGenerateInput,
    timeoutMs?: number,
  ): Promise<SessionRecapGenerateResult> {
    return this.#request('session.recap.generate', input, timeoutMs);
  }

  queryPlan(input: PlanQueryInput, timeoutMs?: number): Promise<PlanQueryResult> {
    return this.#request('plan.query', input, timeoutMs);
  }

  controlPlan(input: PlanControlInput, timeoutMs?: number): Promise<PlanControlResult> {
    return this.#request('plan.control', input, timeoutMs);
  }

  startPlanTurn(input: PlanTurnStartInput, timeoutMs?: number): Promise<PlanTurnStartResult> {
    return this.#request('plan.turn.start', input, timeoutMs);
  }

  queryDeepResearch(
    input: DeepResearchQueryInput,
    timeoutMs?: number,
  ): Promise<DeepResearchQueryResult> {
    return this.#request('deep-research.query', input, timeoutMs);
  }

  queryDailyReview(
    input: DailyReviewQueryInput,
    timeoutMs?: number,
  ): Promise<DailyReviewQueryResult> {
    return this.#request('daily-review.query', input, timeoutMs);
  }

  mutateDailyReview(
    input: DailyReviewMutateInput,
    timeoutMs?: number,
  ): Promise<DailyReviewMutateResult> {
    return this.#request('daily-review.mutate', input, timeoutMs);
  }

  queryTurnResume(input: TurnResumeQueryInput, timeoutMs?: number): Promise<TurnResumePlan> {
    return this.#request('turn.resume.query', input, timeoutMs);
  }

  startTurnResume(input: TurnResumeStartInput, timeoutMs?: number): Promise<TurnResumeStartResult> {
    return this.#request('turn.resume.start', input, timeoutMs);
  }

  async openSessionSubscription(
    input: SubscriptionOpenInput,
    timeoutMs?: number,
  ): Promise<RuntimeHostSessionSubscription> {
    const deadline = requestDeadline(timeoutMs);
    let previous: RuntimeHostConnection | undefined;
    while (true) {
      const connection = await this.#waitForConnection('subscription.open', previous, deadline);
      const remaining = deadline === undefined ? undefined : Math.max(1, deadline - Date.now());
      try {
        return await connection.openSessionSubscription(input, remaining);
      } catch (error) {
        if (!isRetryableSubscriptionInterruption(error)) throw error;
        previous = connection;
      }
    }
  }

  async replaceClientCapabilities(
    provider: ClientCapabilityProvider,
    timeoutMs?: number,
  ): Promise<ClientCapabilityReplaceResult> {
    const connection = this.#requireCurrent('client.capability.replace');
    return connection.replaceClientCapabilities(provider, timeoutMs);
  }

  async unregisterClientCapabilities(
    timeoutMs?: number,
  ): Promise<ClientCapabilityUnregisterResult> {
    const connection = this.#requireCurrent('client.capability.unregister');
    return connection.unregisterClientCapabilities(timeoutMs);
  }

  subscribeConfigurationChanges(listener: (revision: number) => void): () => void {
    this.#configurationListeners.add(listener);
    return () => this.#configurationListeners.delete(listener);
  }

  subscribeProjectCatalogChanges(listener: (revision: number) => void): () => void {
    this.#projectListeners.add(listener);
    return () => this.#projectListeners.delete(listener);
  }

  subscribeSessionCatalogChanges(
    listener: (frame: SessionCatalogChangedFrame) => void,
  ): () => void {
    this.#sessionListeners.add(listener);
    return () => this.#sessionListeners.delete(listener);
  }

  subscribeScheduledTaskChanges(listener: (frame: ScheduledTaskChangedFrame) => void): () => void {
    this.#scheduledTaskListeners.add(listener);
    return () => this.#scheduledTaskListeners.delete(listener);
  }

  close(): Promise<void> {
    this.#unbindListeners();
    return this.#lifecycle.close();
  }

  async #request<K extends OperationKey>(
    operation: K,
    input: OperationInput<K>,
    timeoutMs?: number,
  ): Promise<OperationOutput<K>> {
    const spec = HOST_OPERATION_SPECS[operation];
    const canonicalInput = spec.decodeInput(input) as OperationInput<K>;
    const mode = spec.mode;
    if (mode !== 'query') {
      return this.#requireCurrent(operation).request(
        operation as DirectRequestOperationKey,
        canonicalInput as OperationInput<DirectRequestOperationKey>,
        timeoutMs,
      ) as Promise<OperationOutput<K>>;
    }
    const deadline = requestDeadline(timeoutMs);
    let previous: RuntimeHostConnection | undefined;
    while (true) {
      const connection = await this.#waitForConnection(operation, previous, deadline);
      const remaining = deadline === undefined ? undefined : Math.max(1, deadline - Date.now());
      try {
        return (await connection.request(
          operation as DirectRequestOperationKey,
          canonicalInput as OperationInput<DirectRequestOperationKey>,
          remaining,
        )) as OperationOutput<K>;
      } catch (error) {
        if (!isRetryableQueryInterruption(error)) throw error;
        previous = connection;
      }
    }
  }

  async #waitForConnection(
    operation: OperationKey,
    previous: RuntimeHostConnection | undefined,
    deadline: number | undefined,
  ): Promise<RuntimeHostConnection> {
    if (deadline === undefined) return this.#lifecycle.waitForCurrent(previous);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw timeoutBeforeDispatch(operation);
    const abort = new AbortController();
    const timer = setTimeout(
      () => abort.abort(new Error('Runtime Host request timed out')),
      remaining,
    );
    try {
      return await this.#lifecycle.waitForCurrent(previous, abort.signal);
    } catch (error) {
      if (abort.signal.aborted) throw timeoutBeforeDispatch(operation, asError(error));
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  #requireCurrent(operation: OperationKey): RuntimeHostConnection {
    const connection = this.#lifecycle.current;
    if (connection) return connection;
    throw new RuntimeHostRequestInterruptedError(
      operation,
      HOST_OPERATION_SPECS[operation].mode,
      'not_dispatched',
      'connection_lost',
      { cause: new Error('Runtime Host is reconnecting') },
    );
  }

  #bindListeners(connection: RuntimeHostConnection): void {
    this.#listenerDisposers = [
      connection.subscribeConfigurationChanges((revision: number) => {
        notify(this.#configurationListeners, revision);
      }),
      connection.subscribeProjectCatalogChanges((revision: number) => {
        notify(this.#projectListeners, revision);
      }),
      connection.subscribeSessionCatalogChanges((frame: SessionCatalogChangedFrame) => {
        notify(this.#sessionListeners, frame);
      }),
      connection.subscribeScheduledTaskChanges((frame: ScheduledTaskChangedFrame) => {
        notify(this.#scheduledTaskListeners, frame);
      }),
    ];
  }

  #unbindListeners(): void {
    for (const dispose of this.#listenerDisposers.splice(0)) dispose();
  }
}

function isConnectionLossInterruption(error: unknown): error is RuntimeHostRequestInterruptedError {
  return error instanceof RuntimeHostRequestInterruptedError && error.reason === 'connection_lost';
}

function isHostDrainingOperation(error: unknown): error is RuntimeHostOperationError {
  return error instanceof RuntimeHostOperationError && error.code === 'host_draining';
}

function isRetryableSubscriptionInterruption(error: unknown): boolean {
  return isConnectionLossInterruption(error) || isHostDrainingOperation(error);
}

function isRetryableQueryInterruption(error: unknown): boolean {
  return (isConnectionLossInterruption(error) && error.retryable) || isHostDrainingOperation(error);
}

function timeoutBeforeDispatch(
  operation: OperationKey,
  cause: Error = new Error('Runtime Host request timed out'),
): RuntimeHostRequestInterruptedError {
  return new RuntimeHostRequestInterruptedError(
    operation,
    HOST_OPERATION_SPECS[operation].mode,
    'not_dispatched',
    'timeout',
    { cause },
  );
}

function requestDeadline(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined) return undefined;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new RangeError('timeoutMs must be an integer between 1 and 120000');
  }
  return Date.now() + timeoutMs;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function notify<T>(listeners: ReadonlySet<(value: T) => void>, value: T): void {
  for (const listener of listeners) {
    try {
      listener(value);
    } catch {
      // A presentation listener cannot invalidate the Host connection.
    }
  }
}
