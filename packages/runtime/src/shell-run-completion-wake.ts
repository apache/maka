import {
  isTerminalShellRunStatus,
  type ShellRunRecord,
  type ShellRunStore,
  type ShellRunUpdate,
  type UserMessageInput,
} from '@maka/core';

import {
  type GoalTurnOutcome,
  type SessionActivityLease,
  SessionActivityRegistry,
} from './goal-turn-lifecycle.js';
import { parseShellRunResourceRef } from './shell-run-contract.js';

const DEFAULT_MAX_DELIVERY_ATTEMPTS = 3;
const DEFAULT_ACTIVE_TURN_CHECK_INTERVAL_MS = 1_000;

export type ShellRunCompletionTurnStatus = 'active' | 'completed' | 'failed' | 'missing';

export interface ShellRunCompletionWakeInput {
  activityRegistry: SessionActivityRegistry;
  store: ShellRunStore;
  listSessionIds(): Promise<readonly string[]>;
  startTurn(
    sessionId: string,
    input: UserMessageInput,
    activity: SessionActivityLease,
    abortSignal: AbortSignal,
  ): Promise<GoalTurnOutcome>;
  inspectTurn(sessionId: string, turnId: string): Promise<ShellRunCompletionTurnStatus>;
  newId(): string;
  now(): number;
  maxDeliveryAttempts?: number;
  activeTurnCheckIntervalMs?: number;
  /** Keeps an on-demand host alive from notification scheduling through durable settlement. */
  acquireTaskLease?(): { release(): void };
  onError?(sessionId: string, error: unknown): void | Promise<void>;
}

/**
 * Event-driven bridge from a detached ShellRun terminal transition to one
 * continuation turn in its owning Agent session.
 *
 * The ShellRun record is the durable subscription and delivery authority.
 * Process notifications are only hints: every delivery re-reads the record,
 * waits for the session activity lane, and records its turn id before starting
 * the model. Recovery can therefore converge a terminal run without polling a
 * live process or spending model tokens before completion.
 */
export class ShellRunCompletionWakeCoordinator {
  readonly #input: ShellRunCompletionWakeInput;
  readonly #tasks = new Set<Promise<void>>();
  readonly #pending = new Set<string>();
  readonly #abortController = new AbortController();
  readonly #maxDeliveryAttempts: number;
  readonly #activeTurnCheckIntervalMs: number;
  #closed = false;

  constructor(input: ShellRunCompletionWakeInput) {
    this.#input = input;
    this.#maxDeliveryAttempts = input.maxDeliveryAttempts ?? DEFAULT_MAX_DELIVERY_ATTEMPTS;
    this.#activeTurnCheckIntervalMs =
      input.activeTurnCheckIntervalMs ?? DEFAULT_ACTIVE_TURN_CHECK_INTERVAL_MS;
    if (!Number.isSafeInteger(this.#maxDeliveryAttempts) || this.#maxDeliveryAttempts < 1) {
      throw new Error('ShellRun completion wake attempts must be a positive safe integer');
    }
    if (
      !Number.isSafeInteger(this.#activeTurnCheckIntervalMs) ||
      this.#activeTurnCheckIntervalMs < 1
    ) {
      throw new Error('ShellRun completion wake active-turn interval must be positive');
    }
  }

  notify(update: ShellRunUpdate): void {
    if (
      this.#closed ||
      update.result.notifyOnComplete !== true ||
      !isTerminalShellRunStatus(update.result.status)
    ) {
      return;
    }
    const target = parseShellRunResourceRef(update.result.ref);
    if (!target) return;
    this.#schedule(update.sessionId, target.shellRunId);
  }

  /** Replays terminal, subscribed runs whose completion result was not delivered. */
  async recover(): Promise<number> {
    if (this.#closed) return 0;
    let scheduled = 0;
    for (const sessionId of await this.#input.listSessionIds()) {
      if (this.#closed) break;
      for (const record of await this.#input.store.listSessionShellRuns(sessionId)) {
        if (!isWakeEligible(record)) continue;
        this.#schedule(sessionId, record.shellRunId);
        scheduled += 1;
      }
    }
    return scheduled;
  }

  async waitForIdle(): Promise<void> {
    while (this.#tasks.size > 0) await Promise.all([...this.#tasks]);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#abortController.abort();
    await this.waitForIdle();
  }

  #schedule(sessionId: string, shellRunId: string): void {
    const key = `${sessionId}\0${shellRunId}`;
    if (this.#closed || this.#pending.has(key)) return;
    this.#pending.add(key);
    const taskLease = this.#input.acquireTaskLease?.();
    const task = this.#deliver(sessionId, shellRunId)
      .catch((error) => {
        if (!this.#closed && !isAbortError(error)) {
          return this.#input.onError?.(sessionId, error);
        }
      })
      .finally(() => {
        this.#pending.delete(key);
        taskLease?.release();
      });
    this.#tasks.add(task);
    void task.finally(() => this.#tasks.delete(task));
  }

  async #deliver(sessionId: string, shellRunId: string): Promise<void> {
    for (;;) {
      const activity = await this.#input.activityRegistry.acquire(
        sessionId,
        this.#abortController.signal,
      );
      try {
        if (this.#closed) return;
        let record = await this.#input.store.readShellRun(sessionId, shellRunId);
        if (!isWakeEligible(record)) return;

        // A foreground read that already consumed the terminal result wins the
        // race; no additional model turn is useful.
        if (record.observedAt !== undefined) return;

        const previousTurnId = record.completionWake?.attemptTurnId;
        if (previousTurnId) {
          const previous = await this.#input.inspectTurn(sessionId, previousTurnId);
          if (previous === 'completed') {
            await this.#markDelivered(record, previousTurnId);
            return;
          }
          if (previous === 'active') {
            // A recovered attempt may still be owned by another live stream.
            // Release the session lane while watching its durable AgentRun so a
            // later failure cannot strand this subscription until another host
            // restart or recovery pass.
            activity.release();
            await this.#waitForActiveTurn(sessionId, previousTurnId);
            continue;
          }
        }

        const attemptCount = durableAttemptCount(record);
        if (attemptCount >= this.#maxDeliveryAttempts) {
          const failure = record.completionWake?.lastFailure ?? 'previous attempt did not complete';
          await this.#markExhausted(record, failure);
          throw deliveryExhaustedError(shellRunId, this.#maxDeliveryAttempts, failure);
        }
        const turnId = this.#input.newId();
        record = await this.#input.store.updateShellRun(sessionId, shellRunId, {
          completionWake: {
            ...record.completionWake,
            attemptCount: attemptCount + 1,
            attemptTurnId: turnId,
          },
          updatedAt: this.#input.now(),
        });
        let outcome: GoalTurnOutcome;
        try {
          outcome = await this.#input.startTurn(
            sessionId,
            {
              turnId,
              text: renderShellRunCompletionWakePrompt(record),
              displayText: 'A background command reached terminal completion.',
              origin: { kind: 'shell_run_completion', shellRunId: record.shellRunId },
            },
            activity,
            this.#abortController.signal,
          );
        } catch (error) {
          const failure = boundedFailure(errorMessage(error));
          record = await this.#markAttemptFailed(record, failure);
          if (durableAttemptCount(record) >= this.#maxDeliveryAttempts) {
            await this.#markExhausted(record, failure);
            throw deliveryExhaustedError(shellRunId, this.#maxDeliveryAttempts, failure);
          }
          continue;
        }
        if (outcome.kind === 'completed' || outcome.kind === 'suspended') {
          await this.#markDelivered(record, turnId);
          return;
        }
        const failure = boundedFailure(outcome.kind === 'errored' ? outcome.reason : outcome.kind);
        record = await this.#markAttemptFailed(record, failure);
        if (durableAttemptCount(record) >= this.#maxDeliveryAttempts) {
          await this.#markExhausted(record, failure);
          throw deliveryExhaustedError(shellRunId, this.#maxDeliveryAttempts, failure);
        }
      } finally {
        activity.release();
      }
      if (this.#closed) return;
    }
  }

  async #markDelivered(record: ShellRunRecord, attemptTurnId: string): Promise<void> {
    const deliveredAt = this.#input.now();
    await this.#input.store.updateShellRun(record.sessionId, record.shellRunId, {
      completionWake: {
        ...record.completionWake,
        attemptCount: durableAttemptCount(record),
        attemptTurnId,
        deliveredAt,
      },
      observedAt: deliveredAt,
      updatedAt: deliveredAt,
    });
  }

  async #markAttemptFailed(record: ShellRunRecord, lastFailure: string): Promise<ShellRunRecord> {
    return this.#input.store.updateShellRun(record.sessionId, record.shellRunId, {
      completionWake: {
        ...record.completionWake,
        attemptCount: durableAttemptCount(record),
        lastFailure,
      },
      updatedAt: this.#input.now(),
    });
  }

  async #markExhausted(record: ShellRunRecord, failure: string): Promise<void> {
    if (record.completionWake?.exhaustedAt !== undefined) return;
    const exhaustedAt = this.#input.now();
    await this.#input.store.updateShellRun(record.sessionId, record.shellRunId, {
      completionWake: {
        ...record.completionWake,
        attemptCount: durableAttemptCount(record),
        lastFailure: boundedFailure(failure),
        exhaustedAt,
      },
      updatedAt: exhaustedAt,
    });
  }

  async #waitForActiveTurn(sessionId: string, turnId: string): Promise<void> {
    for (;;) {
      await waitForAbortableDelay(this.#activeTurnCheckIntervalMs, this.#abortController.signal);
      if ((await this.#input.inspectTurn(sessionId, turnId)) !== 'active') return;
    }
  }
}

export function renderShellRunCompletionWakePrompt(record: ShellRunRecord): string {
  const result = {
    ref: `maka://runtime/background-tasks/${record.shellRunId}`,
    status: record.status,
    exitCode: record.exitCode,
    failureMessage: record.failureMessage,
    completedAt: record.completedAt,
    output: record.output,
  };
  return [
    '<system-reminder>',
    'A background Bash task that requested completion notification is now terminal.',
    'This is the event-driven completion wake. Do not sleep or poll this task ref.',
    `Result: ${JSON.stringify(result)}`,
    'Continue the work that depended on this result. If no work remains, report the final outcome.',
    '</system-reminder>',
  ].join('\n');
}

function isWakeEligible(record: ShellRunRecord): boolean {
  return (
    record.notifyOnComplete === true &&
    isTerminalShellRunStatus(record.status) &&
    record.observedAt === undefined &&
    record.completionWake?.deliveredAt === undefined &&
    record.completionWake?.exhaustedAt === undefined
  );
}

function durableAttemptCount(record: ShellRunRecord): number {
  return (
    record.completionWake?.attemptCount ??
    (record.completionWake?.attemptTurnId === undefined ? 0 : 1)
  );
}

function boundedFailure(failure: string): string {
  return failure.slice(0, 4_000) || 'unknown failure';
}

function deliveryExhaustedError(shellRunId: string, maxAttempts: number, failure: string): Error {
  return new Error(
    `ShellRun completion wake ${shellRunId} was not delivered after ${maxAttempts} attempts: ${failure}`,
  );
}

async function waitForAbortableDelay(delayMs: number, abortSignal: AbortSignal): Promise<void> {
  abortSignal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    const onAbort = () => {
      cleanup();
      reject(new DOMException('ShellRun completion wake was aborted', 'AbortError'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      abortSignal.removeEventListener('abort', onAbort);
    };
    abortSignal.addEventListener('abort', onAbort, { once: true });
    if (abortSignal.aborted) onAbort();
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
