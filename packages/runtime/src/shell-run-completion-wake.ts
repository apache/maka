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
  #closed = false;

  constructor(input: ShellRunCompletionWakeInput) {
    this.#input = input;
    this.#maxDeliveryAttempts = input.maxDeliveryAttempts ?? DEFAULT_MAX_DELIVERY_ATTEMPTS;
    if (!Number.isSafeInteger(this.#maxDeliveryAttempts) || this.#maxDeliveryAttempts < 1) {
      throw new Error('ShellRun completion wake attempts must be a positive safe integer');
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
    const task = this.#deliver(sessionId, shellRunId)
      .catch((error) => {
        if (!this.#closed && !isAbortError(error)) {
          return this.#input.onError?.(sessionId, error);
        }
      })
      .finally(() => this.#pending.delete(key));
    this.#tasks.add(task);
    void task.finally(() => this.#tasks.delete(task));
  }

  async #deliver(sessionId: string, shellRunId: string): Promise<void> {
    let lastFailure = 'unknown failure';
    for (let attempt = 0; attempt < this.#maxDeliveryAttempts; attempt += 1) {
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
          if (previous === 'active') return;
        }

        const turnId = this.#input.newId();
        record = await this.#input.store.updateShellRun(sessionId, shellRunId, {
          completionWake: { attemptTurnId: turnId },
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
            },
            activity,
            this.#abortController.signal,
          );
        } catch (error) {
          lastFailure = errorMessage(error);
          continue;
        }
        if (outcome.kind === 'completed' || outcome.kind === 'suspended') {
          await this.#markDelivered(record, turnId);
          return;
        }
        lastFailure = outcome.kind === 'errored' ? outcome.reason : outcome.kind;
      } finally {
        activity.release();
      }
      if (this.#closed) return;
    }
    throw new Error(
      `ShellRun completion wake ${shellRunId} was not delivered after ${this.#maxDeliveryAttempts} attempts: ${lastFailure}`,
    );
  }

  async #markDelivered(record: ShellRunRecord, attemptTurnId: string): Promise<void> {
    const deliveredAt = this.#input.now();
    await this.#input.store.updateShellRun(record.sessionId, record.shellRunId, {
      completionWake: { attemptTurnId, deliveredAt },
      observedAt: deliveredAt,
      updatedAt: deliveredAt,
    });
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
    record.completionWake?.deliveredAt === undefined
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
