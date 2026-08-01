import { createHash } from 'node:crypto';
import type { AgentRunHeader } from '@maka/core/agent-run';
import type { AutomationDefinition, AutomationPendingFire } from '@maka/core/automation';
import type { MessageContent } from '@maka/core/events';
import type { SessionHeader } from '@maka/core/session';
import {
  DEFER_WINDOW_MS,
  evaluateAutomationCanFire,
  FIRE_CHECK_INTERVAL_MS,
  HEARTBEAT_IDLE_STATUSES,
  RuntimeHostedRootConflictError,
  RuntimeHostedRootUnavailableError,
  type RuntimeHostedRootAuthority,
  type SessionManager,
} from '@maka/runtime';
import {
  isSessionNotFoundError,
  type ExecutionAgentRunWriter,
  type ExecutionSessionWriter,
} from '@maka/storage/execution-stores';
import type { RuntimePolicyStoresWriter } from '@maka/storage/runtime-policy-stores';
import { AutomationAuthorityInvariantError } from './automation-errors.js';
import type { RuntimeHostResidency } from './host-kernel.js';
import { runtimeHostSessionUnavailableReason } from './host-session-availability.js';

type AutomationSessions = Pick<
  ExecutionSessionWriter,
  'createStableSession' | 'readHeaderSnapshot'
>;
type AutomationRuns = Pick<ExecutionAgentRunWriter, 'readRun'>;
type AutomationRuntime = Pick<SessionManager, 'sendMessage'>;
type AutomationRoot = Pick<RuntimeHostedRootAuthority, 'executeRoot'>;

export interface AutomationFireStateAuthority {
  listPendingFires(): Promise<readonly AutomationPendingFire[]>;
  listDueAutomations(now: number): Promise<readonly AutomationDefinition[]>;
  recordDeferredFire(
    automationId: string,
    expectedSchedule: number | null,
    skip: boolean,
  ): Promise<boolean>;
  admitFire(
    automationId: string,
    expectedSchedule: number | null,
  ): Promise<AutomationPendingFire | undefined>;
  assertPendingFire(fire: AutomationPendingFire): Promise<void>;
  markFireRunning(fire: AutomationPendingFire): Promise<void>;
  settleFire(fire: AutomationPendingFire, run: AgentRunHeader): Promise<void>;
  residencyState(): { readonly pending: boolean; readonly scheduled: boolean };
}

export interface HostAutomationFireCoordinatorInput {
  readonly state: AutomationFireStateAuthority;
  readonly sessions: AutomationSessions;
  readonly runs: AutomationRuns;
  readonly runtime: AutomationRuntime;
  readonly root: AutomationRoot;
  readonly runtimePolicy: RuntimePolicyStoresWriter;
  readonly isSessionActive: (sessionId: string) => boolean;
  readonly acquireResidency: () => RuntimeHostResidency;
  readonly requestDrain: () => void;
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout: (timer: unknown) => void;
}

interface DeferredFireState {
  readonly firstDeferredAt: number;
  count: number;
}

interface FireTask {
  readonly established: Promise<void>;
  readonly done: Promise<void>;
}

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}

class AutomationFireDeferredError extends Error {
  readonly name = 'AutomationFireDeferredError';
}

/** Owns timers and execution side effects; canonical state stays behind its narrow port. */
export class HostAutomationFireCoordinator {
  readonly #state: AutomationFireStateAuthority;
  readonly #sessions: AutomationSessions;
  readonly #runs: AutomationRuns;
  readonly #runtime: AutomationRuntime;
  readonly #root: AutomationRoot;
  readonly #runtimePolicy: RuntimePolicyStoresWriter;
  readonly #isSessionActive: (sessionId: string) => boolean;
  readonly #acquireResidency: () => RuntimeHostResidency;
  readonly #requestDrain: () => void;
  readonly #now: () => number;
  readonly #setTimeout: (callback: () => void, delayMs: number) => unknown;
  readonly #clearTimeout: (timer: unknown) => void;
  readonly #deferredFires = new Map<string, DeferredFireState>();
  readonly #fireTasks = new Map<string, FireTask>();

  #timer: unknown;
  #tickTask: Promise<void> | undefined;
  #residency: RuntimeHostResidency | undefined;
  #recovered = false;
  #started = false;
  #draining = false;
  #closed = false;

  constructor(input: HostAutomationFireCoordinatorInput) {
    this.#state = input.state;
    this.#sessions = input.sessions;
    this.#runs = input.runs;
    this.#runtime = input.runtime;
    this.#root = input.root;
    this.#runtimePolicy = input.runtimePolicy;
    this.#isSessionActive = input.isSessionActive;
    this.#acquireResidency = input.acquireResidency;
    this.#requestDrain = input.requestDrain;
    this.#now = input.now;
    this.#setTimeout = input.setTimeout;
    this.#clearTimeout = input.clearTimeout;
  }

  get isDraining(): boolean {
    return this.#draining || this.#closed;
  }

  async recover(): Promise<void> {
    if (this.#recovered) return;
    const fires = await this.#state.listPendingFires();
    if (this.isDraining) return;
    await Promise.all(fires.map((fire) => this.#launchFire(fire).established));
    this.#recovered = true;
  }

  start(): void {
    if (this.isDraining) return;
    if (!this.#recovered) throw new Error('Automation scheduler started before recovery');
    if (this.#started) return;
    this.#started = true;
    this.refreshResidency();
    this.#scheduleTick();
  }

  beginDrain(): void {
    if (this.#draining) return;
    this.#draining = true;
    this.#stopTimer();
    this.refreshResidency();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.beginDrain();
    while (this.#tickTask || this.#fireTasks.size > 0) {
      await Promise.allSettled([
        ...(this.#tickTask ? [this.#tickTask] : []),
        ...[...this.#fireTasks.values()].map((task) => task.done),
      ]);
    }
    this.#closed = true;
    this.#deferredFires.clear();
    this.#residency?.release();
    this.#residency = undefined;
  }

  refreshResidency(): void {
    const state = this.#state.residencyState();
    const shouldHold = state.pending || (!this.#draining && this.#started && state.scheduled);
    if (shouldHold && !this.#residency) this.#residency = this.#acquireResidency();
    if (!shouldHold && this.#residency) {
      this.#residency.release();
      this.#residency = undefined;
    }
  }

  #scheduleTick(): void {
    if (!this.#started || this.isDraining || this.#timer !== undefined) return;
    this.#timer = this.#setTimeout(() => {
      this.#timer = undefined;
      const task = this.#checkAndFire();
      this.#tickTask = task;
      void task
        .catch(() => this.#requestDrain())
        .finally(() => {
          if (this.#tickTask === task) this.#tickTask = undefined;
          this.#scheduleTick();
        });
    }, FIRE_CHECK_INTERVAL_MS);
  }

  #stopTimer(): void {
    if (this.#timer === undefined) return;
    this.#clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  async #checkAndFire(): Promise<void> {
    if (this.isDraining) return;
    for (const fire of await this.#state.listPendingFires()) {
      if (this.isDraining) return;
      this.#launchFire(fire);
    }
    for (const automation of await this.#state.listDueAutomations(this.#now())) {
      if (this.isDraining) return;
      let allowed: boolean;
      try {
        allowed = await this.#canFire(automation);
      } catch (error) {
        this.#requestDrain();
        throw error;
      }
      if (!allowed) {
        await this.#recordDeferred(automation);
        continue;
      }
      const fire = await this.#state.admitFire(automation.id, automation.nextFireAt);
      if (fire) {
        this.#deferredFires.delete(automation.id);
        this.#launchFire(fire);
      }
    }
  }

  async #canFire(automation: Pick<AutomationDefinition, 'kind' | 'sessionId'>): Promise<boolean> {
    if (this.isDraining) return false;
    if (automation.kind === 'heartbeat' && this.#isSessionActive(automation.sessionId))
      return false;
    return evaluateAutomationCanFire(automation, {
      isIncognitoActive: async () =>
        (await this.#runtimePolicy.runtimePolicy.getSnapshot()).policy.privacy.incognitoActive,
      readSessionHeader: async (sessionId) => {
        try {
          const header = await this.#sessions.readHeaderSnapshot(sessionId);
          return header.isArchived ||
            header.status === 'archived' ||
            runtimeHostSessionUnavailableReason(header)
            ? null
            : header;
        } catch (error) {
          if (isSessionNotFoundError(error) || isMissingRecord(error)) return null;
          throw error;
        }
      },
    });
  }

  async #recordDeferred(
    automation: Pick<AutomationDefinition, 'id' | 'nextFireAt'>,
  ): Promise<void> {
    const now = this.#now();
    const deferred = this.#deferredFires.get(automation.id);
    const skip = deferred !== undefined && now - deferred.firstDeferredAt >= DEFER_WINDOW_MS;
    const recorded = await this.#state.recordDeferredFire(
      automation.id,
      automation.nextFireAt,
      skip,
    );
    if (!recorded) return;
    if (skip) {
      this.#deferredFires.delete(automation.id);
    } else if (!deferred) {
      this.#deferredFires.set(automation.id, { firstDeferredAt: now, count: 1 });
    } else {
      deferred.count += 1;
    }
  }

  #launchFire(fire: AutomationPendingFire): FireTask {
    const current = this.#fireTasks.get(fire.id);
    if (current) return current;
    const established = deferred();
    let task: FireTask;
    const done = this.#runFire(fire, established)
      .catch((error) => {
        this.#requestDrain();
        throw error;
      })
      .finally(() => {
        if (this.#fireTasks.get(fire.id) === task) this.#fireTasks.delete(fire.id);
      });
    task = { established: established.promise, done };
    this.#fireTasks.set(fire.id, task);
    void done.catch(() => undefined);
    return task;
  }

  async #runFire(fire: AutomationPendingFire, established: Deferred): Promise<void> {
    try {
      await this.#ensureFireTarget(fire);
      const existingRun = await this.#readRun(fire);
      if (existingRun) {
        assertFireRunIdentity(fire, existingRun);
        if (isTerminalRun(existingRun)) {
          await this.#state.settleFire(fire, existingRun);
          established.resolve();
          return;
        }
        established.resolve();
      }
      await this.#root.executeRoot({
        sessionId: fire.targetSessionId,
        turnId: fire.turnId,
        runId: fire.runId,
        userMessageId: fire.userMessageId,
        execution: { kind: 'automation', automationId: fire.automationId },
        content: fireContent(fire),
        admitExecution: async () => {
          await this.#assertFireCanEnterRuntime(fire);
          return 'executing';
        },
        start: ({ runId, userMessageId, onRunStarted }) => {
          if (runId !== fire.runId || userMessageId !== fire.userMessageId) {
            throw new AutomationAuthorityInvariantError(
              'Runtime Host changed the pending Automation fire identity',
            );
          }
          return this.#runtime.sendMessage(
            fire.targetSessionId,
            {
              turnId: fire.turnId,
              ...fireContent(fire),
              origin: { kind: 'automation', automationId: fire.automationId },
            },
            {
              runId: fire.runId,
              userMessageId: fire.userMessageId,
              durability: 'required',
              onRunStarted: async (startedRunId) => {
                if (startedRunId !== fire.runId) {
                  throw new AutomationAuthorityInvariantError(
                    'Runtime started a different Automation Run identity',
                  );
                }
                await this.#state.markFireRunning(fire);
                await onRunStarted();
              },
            },
          );
        },
        onReady: () => established.resolve(),
      });
      established.resolve();
      const run = await this.#readRun(fire);
      if (!run || !isTerminalRun(run)) {
        throw new AutomationAuthorityInvariantError(
          `Automation fire ${fire.id} completed without a terminal Run`,
        );
      }
      assertFireRunIdentity(fire, run);
      await this.#state.settleFire(fire, run);
    } catch (error) {
      let run: AgentRunHeader | undefined;
      try {
        run = await this.#readRun(fire);
      } catch (readError) {
        established.reject(readError);
        throw readError;
      }
      if (run && isTerminalRun(run)) {
        assertFireRunIdentity(fire, run);
        try {
          await this.#state.settleFire(fire, run);
        } catch (settleError) {
          established.reject(settleError);
          throw settleError;
        }
        established.resolve();
        return;
      }
      if (
        error instanceof AutomationFireDeferredError ||
        error instanceof RuntimeHostedRootConflictError ||
        error instanceof RuntimeHostedRootUnavailableError
      ) {
        established.resolve();
        return;
      }
      established.reject(error);
      throw error;
    }
  }

  async #ensureFireTarget(fire: AutomationPendingFire): Promise<void> {
    if (fire.automationKind === 'heartbeat') return;
    if (!fire.execution) {
      throw new AutomationAuthorityInvariantError('Pending cron fire has no execution template');
    }
    const result = await this.#sessions.createStableSession({
      sessionId: fire.targetSessionId,
      requestFingerprint: automationSessionFingerprint(fire),
      input: {
        cwd: fire.execution.cwd,
        ...(fire.execution.projectId === undefined ? {} : { projectId: fire.execution.projectId }),
        name: fire.automationName,
        labels: ['automation', 'cron'],
        backend: fire.execution.backend,
        llmConnectionSlug: fire.execution.llmConnectionSlug,
        model: fire.execution.model,
        ...(fire.execution.thinkingLevel === undefined
          ? {}
          : { thinkingLevel: fire.execution.thinkingLevel }),
        permissionMode: 'explore',
        collaborationMode: fire.execution.collaborationMode,
        orchestrationMode: fire.execution.orchestrationMode,
      },
    });
    if (result.kind === 'conflict') {
      throw new AutomationAuthorityInvariantError(
        `Cron Session identity conflicts for fire ${fire.id}`,
      );
    }
  }

  async #assertFireCanEnterRuntime(fire: AutomationPendingFire): Promise<void> {
    if (this.isDraining) {
      throw new AutomationFireDeferredError('Automation authority is draining');
    }
    await this.#state.assertPendingFire(fire);
    if (this.#isSessionActive(fire.targetSessionId)) {
      throw new AutomationFireDeferredError('Automation target Session is busy');
    }
    const incognito = (await this.#runtimePolicy.runtimePolicy.getSnapshot()).policy.privacy
      .incognitoActive;
    if (incognito) throw new AutomationFireDeferredError('Incognito mode is active');
    let header: SessionHeader;
    try {
      header = await this.#sessions.readHeaderSnapshot(fire.targetSessionId);
    } catch (error) {
      if (isSessionNotFoundError(error) || isMissingRecord(error)) {
        throw new AutomationFireDeferredError('Automation target Session is unavailable');
      }
      throw error;
    }
    if (header.isArchived || header.status === 'archived') {
      throw new AutomationFireDeferredError('Automation target Session is archived');
    }
    if (runtimeHostSessionUnavailableReason(header)) {
      throw new AutomationFireDeferredError('Automation target Session is unavailable');
    }
    if (fire.automationKind === 'heartbeat' && !HEARTBEAT_IDLE_STATUSES.has(header.status)) {
      throw new AutomationFireDeferredError('Automation target Session is not idle');
    }
  }

  async #readRun(fire: AutomationPendingFire): Promise<AgentRunHeader | undefined> {
    try {
      return await this.#runs.readRun(fire.targetSessionId, fire.runId);
    } catch (error) {
      if (isMissingRecord(error)) return undefined;
      throw error;
    }
  }
}

export function fireContent(fire: AutomationPendingFire): MessageContent {
  return {
    text:
      fire.automationKind === 'heartbeat'
        ? `[Automation: ${fire.automationName}]\n\n${fire.prompt}`
        : fire.prompt,
  };
}

export function automationSessionId(fireId: string): string {
  const digest = createHash('sha256').update(`automation-session-v0\0${fireId}`).digest('hex');
  return `automation_session_${digest.slice(0, 48)}`;
}

function automationSessionFingerprint(fire: AutomationPendingFire): string {
  return `sha256:${createHash('sha256')
    .update(
      JSON.stringify({
        protocol: 'automation-session-v0',
        fireId: fire.id,
        automationId: fire.automationId,
        targetSessionId: fire.targetSessionId,
        execution: fire.execution,
      }),
    )
    .digest('hex')}`;
}

export function assertFireRunIdentity(fire: AutomationPendingFire, run: AgentRunHeader): void {
  if (
    run.sessionId !== fire.targetSessionId ||
    run.turnId !== fire.turnId ||
    run.runId !== fire.runId ||
    run.automationId !== fire.automationId ||
    run.parentRunId !== undefined ||
    run.resumedFromRunId !== undefined ||
    run.retriedFromRunId !== undefined ||
    run.parentSessionId !== undefined ||
    run.agentId !== undefined ||
    run.agentName !== undefined ||
    run.continuationSource !== undefined ||
    run.agentGraphWakeId !== undefined ||
    run.agentGraphWakeAttemptId !== undefined
  ) {
    throw new AutomationAuthorityInvariantError(
      `Run ${run.runId} does not match pending Automation fire ${fire.id}`,
    );
  }
}

export function isTerminalRun(run: AgentRunHeader): boolean {
  return run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled';
}

function isMissingRecord(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function deferred(): Deferred {
  let settled = false;
  let resolvePromise!: () => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: () => {
      if (settled) return;
      settled = true;
      resolvePromise();
    },
    reject: (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    },
  };
}
