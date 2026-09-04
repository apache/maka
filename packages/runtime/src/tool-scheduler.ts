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

import { claimsConflict } from './preparation/claims.js';
import type { PreparedOperation } from './preparation/types.js';

export interface ToolSchedulerTask<Result> {
  readonly id: string;
  readonly sequence: number;
  /** The prepared operation whose claims drive ordering and whose run is executed. */
  readonly operation: PreparedOperation<unknown>;
  readonly signal?: AbortSignal;
  /**
   * Execute the prepared operation. Kept on the task (rather than scheduler
   * calling `operation.execute` directly) so the caller can wrap the one-shot
   * effect inside `settleToolCall` and keep admission / durable / projection
   * ownership outside the pure sequencer.
   */
  readonly run: (
    operation: PreparedOperation<unknown>,
    signal?: AbortSignal,
  ) => Promise<Result> | Result;
}

type ScheduledTaskState = 'queued' | 'active' | 'finished';

interface ScheduledTask<Result> extends ToolSchedulerTask<Result> {
  state: ScheduledTaskState;
  readonly result: Promise<Result>;
  readonly resolve: (value: Result | PromiseLike<Result>) => void;
  readonly reject: (reason?: unknown) => void;
  abortListener?: () => void;
}

/**
 * Batch-local, conflict-aware Scheduler. A later task may bypass queued work
 * only when it conflicts with neither active work nor an earlier queued task.
 * The Scheduler is a pure deterministic sequencer: it reads `claims` to decide
 * ordering and never resolves an identity or touches a resource. The resource
 * correctness lives in each `PreparedOperation.execute`.
 */
export class ToolScheduler {
  private readonly activeTasks: ScheduledTask<unknown>[] = [];
  private queuedTasks: ScheduledTask<unknown>[] = [];
  private lastSequence = -1;
  /** Fail-stop latch: a rejected task freezes further dispatch. */
  private frozen = false;

  add<Result>(task: ToolSchedulerTask<Result>): Promise<Result> {
    if (!Number.isSafeInteger(task.sequence) || task.sequence <= this.lastSequence) {
      throw new Error(
        `Tool Scheduler tasks must be submitted once in strictly increasing sequence order (received ${task.sequence} after ${this.lastSequence})`,
      );
    }
    this.lastSequence = task.sequence;

    let resolve!: (value: Result | PromiseLike<Result>) => void;
    let reject!: (reason?: unknown) => void;
    const result = new Promise<Result>((resolveResult, rejectResult) => {
      resolve = resolveResult;
      reject = rejectResult;
    });
    const scheduled: ScheduledTask<Result> = {
      ...task,
      state: 'queued',
      result,
      resolve,
      reject,
    };

    if (this.frozen) {
      scheduled.state = 'finished';
      scheduled.reject(
        new Error(
          `Tool Scheduler is frozen after a prior rejection; task ${task.id} was never started`,
        ),
      );
      return result;
    }

    if (task.signal?.aborted) {
      scheduled.state = 'finished';
      scheduled.reject(abortReason(task.signal, task.id));
      return result;
    }

    if (this.isBlocked(scheduled as ScheduledTask<unknown>, this.queuedTasks)) {
      this.queuedTasks.push(scheduled as ScheduledTask<unknown>);
      this.listenForQueuedAbort(scheduled);
    } else {
      this.startTask(scheduled);
    }
    return result;
  }

  get activeCount(): number {
    return this.activeTasks.length;
  }

  get queuedCount(): number {
    return this.queuedTasks.length;
  }

  private isBlocked(
    task: ScheduledTask<unknown>,
    queuedBefore: readonly ScheduledTask<unknown>[],
  ): boolean {
    return (
      this.conflictsWithAny(task, this.activeTasks) || this.conflictsWithAny(task, queuedBefore)
    );
  }

  private conflictsWithAny(
    task: ScheduledTask<unknown>,
    candidates: readonly ScheduledTask<unknown>[],
  ): boolean {
    return candidates.some((candidate) =>
      claimsConflict(task.operation.claims, candidate.operation.claims),
    );
  }

  private startTask<Result>(task: ScheduledTask<Result>): void {
    if (this.frozen) {
      task.state = 'finished';
      task.reject(new Error(`Tool Scheduler is frozen; task ${task.id} was never started`));
      return;
    }
    if (task.state !== 'queued') {
      task.reject(
        new Error(`Tool Scheduler invariant violated: task ${task.id} started from ${task.state}`),
      );
      return;
    }
    this.removeQueuedAbortListener(task);
    task.state = 'active';
    this.activeTasks.push(task as ScheduledTask<unknown>);

    let execution: Promise<Result>;
    try {
      execution = Promise.resolve(task.run(task.operation, task.signal));
    } catch (error) {
      execution = Promise.reject(error);
    }
    void execution.then(
      (value) => this.finishTask(task, { status: 'fulfilled', value }),
      (reason: unknown) => this.finishTask(task, { status: 'rejected', reason }),
    );
  }

  private finishTask<Result>(
    task: ScheduledTask<Result>,
    outcome: PromiseSettledResult<Result>,
  ): void {
    if (task.state !== 'active') {
      task.reject(
        new Error(`Tool Scheduler invariant violated: task ${task.id} finished from ${task.state}`),
      );
      return;
    }
    const index = this.activeTasks.indexOf(task as ScheduledTask<unknown>);
    if (index < 0) {
      task.state = 'finished';
      task.reject(
        new Error(`Tool Scheduler invariant violated: active task ${task.id} was missing`),
      );
      return;
    }
    this.activeTasks.splice(index, 1);
    task.state = 'finished';
    if (outcome.status === 'fulfilled') {
      task.resolve(outcome.value);
    } else {
      // §6.2 fail-stop: settleToolCall has already normalised business failures
      // into fulfilled error results, so a rejection is infrastructure/turn-fatal.
      this.frozen = true;
      task.reject(outcome.reason);
    }
    this.drainQueue();
  }

  private drainQueue(): void {
    if (this.frozen) {
      const toCancel = this.queuedTasks.filter((task) => task.state === 'queued');
      this.queuedTasks = [];
      for (const task of toCancel) {
        this.removeQueuedAbortListener(task);
        task.state = 'finished';
        task.reject(new Error(`Tool Scheduler is frozen; queued task ${task.id} was cancelled`));
      }
      return;
    }
    const waiting: ScheduledTask<unknown>[] = [];
    for (const task of this.queuedTasks) {
      if (task.state !== 'queued') continue;
      if (this.isBlocked(task, waiting)) waiting.push(task);
      else this.startTask(task);
    }
    this.queuedTasks = waiting;
  }

  private listenForQueuedAbort<Result>(task: ScheduledTask<Result>): void {
    if (!task.signal) return;
    const listener = () => this.cancelQueuedTask(task);
    task.abortListener = listener;
    task.signal.addEventListener('abort', listener, { once: true });
    // Abort can race the listener registration between add()'s first check and
    // this call. Recheck so a queued task can never become permanently stuck.
    if (task.signal.aborted) this.cancelQueuedTask(task);
  }

  private cancelQueuedTask<Result>(task: ScheduledTask<Result>): void {
    if (task.state !== 'queued') return;
    const index = this.queuedTasks.indexOf(task as ScheduledTask<unknown>);
    if (index < 0) return;
    this.queuedTasks.splice(index, 1);
    this.removeQueuedAbortListener(task);
    task.state = 'finished';
    task.reject(abortReason(task.signal, task.id));
    this.drainQueue();
  }

  private removeQueuedAbortListener<Result>(task: ScheduledTask<Result>): void {
    if (!task.signal || !task.abortListener) return;
    task.signal.removeEventListener('abort', task.abortListener);
    task.abortListener = undefined;
  }
}

function abortReason(signal: AbortSignal | undefined, taskId: string): unknown {
  if (signal?.reason !== undefined) return signal.reason;
  return Object.assign(new Error(`Tool task ${taskId} was cancelled before it started`), {
    name: 'AbortError',
  });
}
