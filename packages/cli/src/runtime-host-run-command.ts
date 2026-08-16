import { type SessionEvent } from '@maka/core/events';
import { findProjectByIdentity } from '@maka/core/project';
import { type StoredMessage } from '@maka/core/session';
import type { CreateSessionInput, UserMessageInput } from '@maka/core/runtime-inputs';
import type { ExecutionBoundaryReadModel } from '@maka/core/sandbox-boundary';
import type { SessionSummary } from '@maka/core/session';
import {
  readRuntimeHostSessions,
  readRuntimeHostProjects,
  RuntimeHostOperationError,
  type RuntimeHostConnection,
  type RuntimeHostProfile,
} from '@maka/runtime-host/client';
import type { InteractionPendingSnapshot, SessionCatalogItem } from '@maka/runtime-host/protocol';
import {
  runMakaTextCliCore,
  type MakaRunContext,
  type MakaRunContextInput,
  type MakaRunDeps,
  type MakaRunEnvironmentDeps,
  type MakaRunOutcome,
  type MakaRunRuntime,
} from './run-command-core.js';
import {
  connectRuntimeHostCli,
  resolveRuntimeHostCliTarget,
  type RuntimeHostCliConnectionContext,
} from './runtime-host-cli-context.js';
import {
  createRuntimeHostMakaSessionDriver,
  runtimeHostSessionSummary,
  type RuntimeHostMakaSessionDriver,
} from './runtime-host-session-driver.js';
import type { MakaPreparedSessionTurn } from './session-driver.js';
import {
  formatRuntimeHostCliTaskBlockers,
  isRuntimeHostCliTaskBlocked,
  readRuntimeHostCliTaskReadiness,
} from './runtime-host-task-readiness.js';
import { resolveMakaClientDataRoot } from './workspace-root.js';

const GRAPH_POLL_INTERVAL_MS = 25;

export interface RuntimeHostRunCommandDeps {
  connect(
    rootPath: string,
    hostProfileId: string | undefined,
    clientDataRoot: string,
  ): Promise<RuntimeHostCliConnectionContext>;
  createContext(
    connection: RuntimeHostConnection,
    catalog: RuntimeHostCliConnectionContext['catalog'],
    input: Parameters<MakaRunDeps['createContext']>[0],
    profile: RuntimeHostProfile,
  ): MakaRunContext | Promise<MakaRunContext>;
  run: typeof runMakaTextCliCore;
}

export interface RuntimeHostTextCliOptions {
  readonly cliCommand: string;
  readonly clientDataRoot: string;
}

export interface RuntimeHostRunContextDeps {
  createDriver(
    input: Parameters<typeof createRuntimeHostMakaSessionDriver>[0],
  ): RuntimeHostMakaSessionDriver;
}

export async function runRuntimeHostTextCli(
  argv: readonly string[],
  overrides: Partial<MakaRunEnvironmentDeps> = {},
  commandOverrides: Partial<RuntimeHostRunCommandDeps> = {},
  options: RuntimeHostTextCliOptions = {
    cliCommand: 'maka',
    clientDataRoot: resolveMakaClientDataRoot(),
  },
): Promise<number> {
  const commandDeps = { ...defaultRuntimeHostRunCommandDeps(), ...commandOverrides };
  let connected: RuntimeHostCliConnectionContext | undefined;
  const connect = async (
    rootPath: string,
    hostProfileId?: string,
  ): Promise<RuntimeHostCliConnectionContext> => {
    connected ??= await commandDeps.connect(rootPath, hostProfileId, options.clientDataRoot);
    return connected;
  };
  try {
    return await commandDeps.run(
      argv,
      {
        listSessions: async (rootPath, hostProfileId) =>
          runtimeHostSessionSummaries(
            await readRuntimeHostSessions((await connect(rootPath, hostProfileId)).connection),
          ),
        createContext: async (input) => {
          const context = await connect(input.workspaceRoot, input.hostProfileId);
          const preparedInput = await prepareRuntimeHostRunInput(
            context.connection,
            context.catalog,
            context.profile,
            input,
            options.cliCommand,
          );
          return commandDeps.createContext(
            context.connection,
            context.catalog,
            preparedInput,
            context.profile,
          );
        },
      },
      { ...overrides, cliCommand: () => options.cliCommand },
    );
  } finally {
    await connected?.close().catch(() => undefined);
  }
}

function defaultRuntimeHostRunCommandDeps(): RuntimeHostRunCommandDeps {
  return {
    connect: (rootPath, hostProfileId, clientDataRoot) =>
      connectRuntimeHostCli({
        rootPath,
        surface: 'run',
        ...(hostProfileId ? { profileId: hostProfileId } : {}),
        clientDataRoot,
      }),
    createContext: (connection, catalog, input) =>
      createRuntimeHostRunContext(connection, catalog, input),
    run: runMakaTextCliCore,
  };
}

export function createRuntimeHostRunContext(
  connection: RuntimeHostConnection,
  catalog: RuntimeHostCliConnectionContext['catalog'],
  input: Parameters<MakaRunDeps['createContext']>[0],
  overrides: Partial<RuntimeHostRunContextDeps> = {},
): MakaRunContext {
  const target = resolveRuntimeHostCliTarget(catalog, {
    ...(input.requestedConnectionSlug ? { connectionSlug: input.requestedConnectionSlug } : {}),
    ...(input.requestedModel ? { model: input.requestedModel } : {}),
  });
  const contextDeps = {
    createDriver: createRuntimeHostMakaSessionDriver,
    ...overrides,
  };
  const driver = contextDeps.createDriver({
    connection,
    cwd: input.cwd,
    llmConnectionSlug: target.connection.slug,
    model: target.model,
    permissionMode: 'ask',
    executionLocation:
      !input.hostProfileId || input.hostProfileId === 'local'
        ? { kind: 'client_path' }
        : { kind: 'host' },
    ...(input.projectId ? { workspace: { kind: 'project', projectId: input.projectId } } : {}),
  });
  const runtime = new RuntimeHostRunRuntime(
    connection,
    driver,
    input.runOutcomeObserver,
    input.enableAgentGraph === true,
    input.sessionCwdOverride,
    input.maxSteps,
  );
  return {
    runtime,
    target: { connection: { slug: target.connection.slug }, model: target.model },
    ...(input.enableAgentGraph
      ? {
          agentGraph: {
            reserveActivity: () => ({ release: () => {} }),
            waitForCompletion: (sessionId: string) => runtime.waitForGraphCompletion(sessionId),
          },
        }
      : {}),
    close: async () => runtime.close(),
  };
}

async function prepareRuntimeHostRunInput(
  connection: RuntimeHostConnection,
  catalog: RuntimeHostCliConnectionContext['catalog'],
  profile: RuntimeHostProfile,
  input: Parameters<MakaRunDeps['createContext']>[0],
  cliCommand: string,
): Promise<Parameters<MakaRunDeps['createContext']>[0]> {
  let projectId = input.projectId;
  if (profile.kind === 'remote' && !input.resumeSessionId) {
    if (!projectId) {
      throw new Error(`Runtime Host profile ${profile.id} requires --project for a new Session`);
    }
    const project = findProjectByIdentity(await readRuntimeHostProjects(connection), projectId);
    if (!project || project.archivedAt !== null || !project.available) {
      throw new Error(`Runtime Host Project is unavailable: ${projectId}`);
    }
    projectId = project.id;
  }
  const preparedInput = projectId === input.projectId ? input : { ...input, projectId };
  const snapshot = await readRuntimeHostCliTaskReadiness({
    connection,
    catalog,
    cwd: preparedInput.cwd,
    ...(profile.kind === 'remote' ? { workspaceState: 'ready' as const } : {}),
    ...(preparedInput.requestedConnectionSlug
      ? { connectionSlug: preparedInput.requestedConnectionSlug }
      : {}),
    ...(preparedInput.requestedModel ? { model: preparedInput.requestedModel } : {}),
  });
  if (isRuntimeHostCliTaskBlocked(snapshot)) {
    throw new Error(
      `Task is not ready:\n${formatRuntimeHostCliTaskBlockers(snapshot, cliCommand)}`,
    );
  }
  return preparedInput;
}

class RuntimeHostRunRuntime implements MakaRunRuntime {
  readonly #connection: RuntimeHostConnection;
  readonly #driver: RuntimeHostMakaSessionDriver;
  readonly #observer: ((outcome: MakaRunOutcome) => void | Promise<void>) | undefined;
  readonly #graphEnabled: boolean;
  readonly #sessionCwdOverride: MakaRunContextInput['sessionCwdOverride'];
  readonly #maxSteps: number | undefined;
  readonly #unsubscribeTranscriptReplacements: () => void;
  #sessionId: string | undefined;
  #activeTurn: { sessionId: string; turnId: string; runId: string } | undefined;
  #stopRequested = false;
  #closed = false;
  readonly #interactions: NonInteractiveInteractionController;
  #graphAdmissionTurnIds = new Set<string>();
  #latestTranscriptReplacement: StoredMessage[] | undefined;
  readonly #graphTerminalWaiters = new Map<
    string,
    Set<{
      resolve(messages: StoredMessage[]): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }>
  >();

  constructor(
    connection: RuntimeHostConnection,
    driver: RuntimeHostMakaSessionDriver,
    observer: ((outcome: MakaRunOutcome) => void | Promise<void>) | undefined,
    graphEnabled: boolean,
    sessionCwdOverride: MakaRunContextInput['sessionCwdOverride'],
    maxSteps: number | undefined,
  ) {
    this.#connection = connection;
    this.#driver = driver;
    this.#observer = observer;
    this.#graphEnabled = graphEnabled;
    this.#sessionCwdOverride = sessionCwdOverride;
    this.#maxSteps = maxSteps;
    this.#interactions = new NonInteractiveInteractionController(driver, (pending) =>
      this.#stopForInteraction(pending),
    );
    this.#unsubscribeTranscriptReplacements = driver.subscribeTranscriptReplacements(
      (_sessionId, _turnId, messages) => this.#acceptGraphTranscript(messages),
    );
  }

  async createSession(input: CreateSessionInput): Promise<SessionSummary> {
    const created = await this.#driver.createSession(input);
    this.#sessionId = created.id;
    return created;
  }

  async readExecutionBoundary(sessionId: string): Promise<ExecutionBoundaryReadModel> {
    await this.#attach(sessionId);
    return this.#connection.request('session.execution_boundary.query', { sessionId });
  }

  async *sendMessage(sessionId: string, input: UserMessageInput): AsyncIterable<SessionEvent> {
    await this.#attach(sessionId);
    if (this.#stopRequested) throw new Error('Turn was cancelled before start');
    if (input.turnOrchestration?.mode === 'graph') {
      this.#graphAdmissionTurnIds = graphSupervisorTurnIds(await this.#driver.readMessages());
    }
    const maxSteps = input.maxSteps ?? this.#maxSteps;
    const turn = await this.#driver.preparePrompt(input.text, {
      turnId: input.turnId,
      ...(input.turnOrchestration ? { turnOrchestration: input.turnOrchestration } : {}),
      ...(maxSteps !== undefined ? { maxSteps } : {}),
    });
    if (!turn.runId) throw new Error('Runtime Host did not return a Run identity');
    const activeTurn = { sessionId: turn.sessionId, turnId: turn.turnId, runId: turn.runId };
    this.#activeTurn = activeTurn;
    if (this.#stopRequested) {
      await this.#stopTurn(activeTurn);
      if (input.turnOrchestration?.mode === 'graph') await this.#stopGraph(sessionId);
    }
    try {
      yield* this.#observeTurn(turn);
    } finally {
      if (this.#activeTurn === activeTurn) this.#activeTurn = undefined;
    }
  }

  async respondToSandboxBoundary(
    sessionId: string,
    response: { requestId: string; decision: 'deny' },
  ): Promise<void> {
    await this.#attach(sessionId);
    await this.#driver.respondToSandboxBoundary(response);
  }

  async resumeLatest(sessionId: string): Promise<AsyncIterable<SessionEvent> | null> {
    await this.#attach(sessionId);
    const plan = await this.#connection.request('turn.resume.query', { sessionId });
    return plan.disposition === 'ready' ? this.#driver.resumeLatest() : null;
  }

  async stopSession(sessionId: string): Promise<void> {
    this.#stopRequested = true;
    await this.#attach(sessionId);
    const stops: Promise<unknown>[] = [
      this.#activeTurn ? this.#stopTurn(this.#activeTurn) : this.#driver.stop(),
    ];
    if (this.#graphEnabled) {
      stops.push(this.#stopGraph(sessionId));
    }
    const settled = await Promise.allSettled(stops);
    const failure = settled.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    this.#cancelGraphTerminalWaiters(new Error('Agent Graph wait was cancelled'));
    if (failure) throw failure.reason;
  }

  async setExecutionBoundaryKind(sessionId: string, kind: 'managed' | 'bypass'): Promise<void> {
    await this.#attach(sessionId);
    await this.#driver.setPermissionMode(kind === 'bypass' ? 'bypass' : 'ask');
  }

  async waitForGraphCompletion(sessionId: string): Promise<void> {
    let terminalStatus: 'completed' | 'failed' | 'stopped' | undefined;
    for (;;) {
      await this.#interactions.settle();
      if (this.#stopRequested) throw new Error('Agent Graph wait was cancelled');
      try {
        const graph = await this.#connection.request('agent.graph.query', {
          rootSessionId: sessionId,
        });
        await this.#interactions.settle();
        if (this.#stopRequested) throw new Error('Agent Graph wait was cancelled');
        if (graph.status === 'empty' || graph.status === 'completed') {
          terminalStatus = 'completed';
          break;
        }
        if (graph.status === 'failed' || graph.status === 'stopped') {
          terminalStatus = graph.status;
          break;
        }
      } catch (error) {
        if (error instanceof RuntimeHostOperationError && error.code === 'not_found') return;
        throw error;
      }
      await this.#interactions.race(delay(GRAPH_POLL_INTERVAL_MS));
    }
    if (terminalStatus !== 'completed') {
      throw new Error(`Agent Graph ${terminalStatus}`);
    }
    await this.#interactions.settle();
    let messages = await this.#driver.readMessages();
    let graphTurnId = lastNewGraphSupervisorTurnId(messages, this.#graphAdmissionTurnIds);
    let outcome = graphTurnId ? outcomeFromStoredTurn(messages, graphTurnId) : undefined;
    if (graphTurnId && !outcome) {
      messages = await this.#waitForGraphTurnTerminal(graphTurnId);
      graphTurnId = lastNewGraphSupervisorTurnId(messages, this.#graphAdmissionTurnIds);
      outcome = graphTurnId ? outcomeFromStoredTurn(messages, graphTurnId) : undefined;
      if (!outcome)
        throw new Error('Agent Graph final Turn did not reach a durable terminal boundary');
    }
    if (outcome) await this.#observer?.(outcome);
  }

  close(): Promise<void> {
    this.#closed = true;
    this.#interactions.close();
    this.#unsubscribeTranscriptReplacements();
    this.#cancelGraphTerminalWaiters(new Error('Runtime Host run context closed'));
    return Promise.resolve();
  }

  async #attach(sessionId: string): Promise<void> {
    if (this.#sessionId === sessionId) return;
    const switched = await this.#driver.switchSession(sessionId);
    if (
      this.#sessionCwdOverride?.sessionId === sessionId &&
      switched.summary.cwd !== this.#sessionCwdOverride.cwd
    ) {
      const moveSession = this.#driver.moveSession;
      if (!moveSession) {
        throw new Error('The selected Runtime Host does not allow Client path relocation');
      }
      const moved = await moveSession(this.#sessionCwdOverride.cwd);
      if (moved.cwd !== this.#sessionCwdOverride.cwd) {
        throw new Error(
          `Runtime Host cannot resume Session ${sessionId}: its working directory could not be canonicalized`,
        );
      }
    }
    this.#sessionId = sessionId;
  }

  async *#observeTurn(turn: MakaPreparedSessionTurn): AsyncIterable<SessionEvent> {
    const accumulator = new TurnOutcomeAccumulator(turn.runId ?? turn.turnId);
    const events = turn.events[Symbol.asyncIterator]();
    for (;;) {
      const next = await this.#interactions.race(events.next());
      if (next.done) break;
      const event = next.value;
      if (event.type === 'user_question_request' || event.type === 'sandbox_boundary_request') {
        continue;
      }
      accumulator.accept(event);
      yield event;
    }
    await this.#interactions.settle();
    await this.#observer?.(accumulator.finish());
  }

  async #stopTurn(turn: { sessionId: string; turnId: string; runId: string }): Promise<void> {
    await this.#connection.request('turn.stop', turn);
  }

  async #stopGraph(sessionId: string): Promise<void> {
    try {
      await this.#connection.request('agent.graph.stop', { rootSessionId: sessionId });
    } catch (error) {
      if (!(error instanceof RuntimeHostOperationError) || error.code !== 'not_found') throw error;
    }
  }

  #acceptGraphTranscript(messages: StoredMessage[]): void {
    const replacement = messages.map((message) => structuredClone(message));
    this.#latestTranscriptReplacement = replacement;
    for (const [turnId, waiters] of this.#graphTerminalWaiters) {
      if (!outcomeFromStoredTurn(replacement, turnId)) continue;
      this.#graphTerminalWaiters.delete(turnId);
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(replacement);
      }
    }
  }

  #waitForGraphTurnTerminal(turnId: string): Promise<StoredMessage[]> {
    if (this.#closed) return Promise.reject(new Error('Runtime Host run context closed'));
    if (this.#stopRequested) return Promise.reject(new Error('Agent Graph wait was cancelled'));
    const latest = this.#latestTranscriptReplacement;
    if (latest && outcomeFromStoredTurn(latest, turnId)) return Promise.resolve(latest);
    return new Promise<StoredMessage[]>((resolve, reject) => {
      let waiters = this.#graphTerminalWaiters.get(turnId);
      if (!waiters) {
        waiters = new Set();
        this.#graphTerminalWaiters.set(turnId, waiters);
      }
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          waiters?.delete(waiter);
          if (waiters?.size === 0) this.#graphTerminalWaiters.delete(turnId);
          reject(new Error('Agent Graph final Turn did not reach a durable terminal boundary'));
        }, 45_000),
      };
      waiters.add(waiter);
    });
  }

  async #stopForInteraction(pending: InteractionPendingSnapshot): Promise<void> {
    this.#stopRequested = true;
    const stops: Promise<unknown>[] = [
      this.#stopTurn({
        sessionId: pending.sessionId,
        turnId: pending.turnId,
        runId: pending.runId,
      }),
    ];
    if (this.#graphEnabled) stops.push(this.#stopGraph(pending.sessionId));
    const settled = await Promise.allSettled(stops);
    const failure = settled.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failure) throw failure.reason;
  }

  #cancelGraphTerminalWaiters(error: Error): void {
    for (const waiters of this.#graphTerminalWaiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    }
    this.#graphTerminalWaiters.clear();
  }
}

function runtimeHostSessionSummaries(items: readonly SessionCatalogItem[]): SessionSummary[] {
  return items.flatMap((item) => ('kind' in item ? [] : [runtimeHostSessionSummary(item)]));
}

class TurnOutcomeAccumulator {
  readonly #outcomeId: string;
  #finalOutput: string | undefined;
  #failure: { class: string; message: string } | undefined;
  #completed = false;
  #unresolvedBoundary = false;
  #recoveredBoundary = false;

  constructor(outcomeId: string) {
    this.#outcomeId = outcomeId;
  }

  accept(event: SessionEvent): void {
    if (event.type === 'text_complete' && event.text.trim().length > 0) {
      this.#finalOutput = event.text;
    } else if (event.type === 'error') {
      this.#failure = { class: event.reason ?? 'runtime_error', message: event.message };
    } else if (event.type === 'abort') {
      this.#failure = { class: 'aborted', message: 'Turn was cancelled' };
    } else if (event.type === 'complete') {
      this.#completed = true;
    }
    if (event.type !== 'tool_result') return;
    if (event.isError && event.content.kind === 'text' && event.content.sandboxFailure) {
      this.#unresolvedBoundary = true;
      return;
    }
    if (!event.isError && this.#unresolvedBoundary) {
      this.#unresolvedBoundary = false;
      this.#recoveredBoundary = true;
    }
  }

  finish(): MakaRunOutcome {
    const completed = this.#completed && !this.#failure;
    return {
      outcomeId: this.#outcomeId,
      status: completed ? 'completed' : 'failed',
      ...(completed && this.#finalOutput !== undefined ? { finalOutput: this.#finalOutput } : {}),
      ...(!completed
        ? {
            failure: this.#failure ?? {
              class: 'missing_terminal_event',
              message: 'Turn ended unexpectedly',
            },
          }
        : {}),
      sandboxBoundary: this.#unresolvedBoundary
        ? 'unresolved'
        : this.#recoveredBoundary
          ? 'recovered'
          : 'none',
    };
  }
}

function graphSupervisorTurnIds(messages: readonly StoredMessage[]): Set<string> {
  return new Set(
    messages.flatMap((message) =>
      message.type === 'user' && message.origin?.kind === 'agent_graph' ? [message.turnId] : [],
    ),
  );
}

function lastNewGraphSupervisorTurnId(
  messages: readonly StoredMessage[],
  admissionTurnIds: ReadonlySet<string>,
): string | undefined {
  return [...messages]
    .reverse()
    .find(
      (message) =>
        message.type === 'user' &&
        message.origin?.kind === 'agent_graph' &&
        !admissionTurnIds.has(message.turnId),
    )?.turnId;
}

function outcomeFromStoredTurn(
  messages: readonly StoredMessage[],
  turnId: string,
): MakaRunOutcome | undefined {
  const turnMessages = messages.filter((message) => message.turnId === turnId);
  const finalOutput = [...turnMessages]
    .reverse()
    .find(
      (message): message is Extract<StoredMessage, { type: 'assistant' }> =>
        message.type === 'assistant' && message.text.trim().length > 0,
    )?.text;
  const storedTerminal = [...turnMessages]
    .reverse()
    .find(
      (message): message is Extract<StoredMessage, { type: 'turn_state' }> =>
        message.type === 'turn_state' && message.status !== 'running',
    );
  const status = storedTerminal?.status;
  if (!status) return undefined;
  const completed = status === 'completed';
  return {
    outcomeId: turnId,
    status: completed ? 'completed' : 'failed',
    ...(completed && finalOutput !== undefined ? { finalOutput } : {}),
    ...(!completed
      ? {
          failure: {
            class: storedTerminal?.errorClass ?? storedTerminal?.abortSource ?? status,
            message: status === 'aborted' ? 'Turn was cancelled' : 'Agent Graph final Turn failed',
          },
        }
      : {}),
    sandboxBoundary: storedSandboxBoundaryOutcome(turnMessages),
  };
}

class NonInteractiveInteractionController {
  readonly #driver: RuntimeHostMakaSessionDriver;
  readonly #stop: (pending: InteractionPendingSnapshot) => Promise<void>;
  readonly #handled = new Set<string>();
  readonly #tasks = new Set<Promise<void>>();
  readonly #unsubscribe: () => void;
  #failure: Error | undefined;
  readonly #failureSignal: Promise<Error>;
  #publishFailure!: (error: Error) => void;

  constructor(
    driver: RuntimeHostMakaSessionDriver,
    stop: (pending: InteractionPendingSnapshot) => Promise<void>,
  ) {
    this.#driver = driver;
    this.#stop = stop;
    this.#failureSignal = new Promise((resolve) => {
      this.#publishFailure = resolve;
    });
    this.#unsubscribe = driver.subscribePendingInteractions((pending) => this.#accept(pending));
  }

  race<T>(operation: Promise<T>): Promise<T> {
    this.throwIfFailed();
    return Promise.race([operation, this.#failureSignal.then((error) => Promise.reject(error))]);
  }

  async settle(): Promise<void> {
    await Promise.all([...this.#tasks]);
    this.throwIfFailed();
  }

  throwIfFailed(): void {
    if (this.#failure) throw this.#failure;
  }

  close(): void {
    this.#unsubscribe();
  }

  #accept(pending: InteractionPendingSnapshot): void {
    if (this.#handled.has(pending.interactionId)) return;
    this.#handled.add(pending.interactionId);
    const task = this.#handle(pending).catch((error) => {
      this.#fail(error instanceof Error ? error : new Error(String(error)));
    });
    this.#tasks.add(task);
    void task.finally(() => this.#tasks.delete(task));
  }

  async #handle(pending: InteractionPendingSnapshot): Promise<void> {
    if (pending.request.kind === 'sandbox_boundary') {
      await this.#driver.respondToSandboxBoundary({
        requestId: pending.interactionId,
        decision: 'deny',
      });
      return;
    }
    await this.#stop(pending);
    throw new Error(
      pending.request.kind === 'question'
        ? 'interactive user questions are unavailable in non-interactive mode'
        : 'interactive permission requests are unavailable in non-interactive mode',
    );
  }

  #fail(error: Error): void {
    if (this.#failure) return;
    this.#failure = error;
    this.#publishFailure(error);
  }
}

function storedSandboxBoundaryOutcome(
  messages: readonly StoredMessage[],
): MakaRunOutcome['sandboxBoundary'] {
  let unresolved = false;
  let recovered = false;
  for (const message of messages) {
    if (
      message.type === 'tool_result' &&
      message.isError &&
      message.content.kind === 'text' &&
      message.content.sandboxFailure
    ) {
      unresolved = true;
    } else if (message.type === 'tool_result' && !message.isError && unresolved) {
      unresolved = false;
      recovered = true;
    }
  }
  return unresolved ? 'unresolved' : recovered ? 'recovered' : 'none';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
