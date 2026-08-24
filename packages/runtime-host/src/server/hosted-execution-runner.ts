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

import type {
  HostedExecutionProjection,
  HostedExecutionStartInput,
  OperationKey,
  OperationOutcome,
  OperationOutput,
  TurnSnapshot,
  UsageQueryResult,
} from '../protocol/index.js';
import type { ConnectionContext, OperationHandlerMap } from './operation-dispatcher.js';

export interface HostHostedExecutionRunnerInput {
  readonly handlers: Pick<
    OperationHandlerMap,
    'session.create' | 'turn.start' | 'turn.query' | 'turn.stop' | 'usage.query'
  >;
  readonly context: ConnectionContext;
  readonly requestDrain: () => void;
  readonly waitForExecutionResidencies: () => Promise<void>;
  readonly waitForAllResidencies: () => Promise<void>;
  readonly now?: () => number;
}

export class HostHostedExecutionRunner {
  constructor(private readonly input: HostHostedExecutionRunnerInput) {}

  async run(
    input: HostedExecutionStartInput,
    signal: AbortSignal,
  ): Promise<HostedExecutionProjection> {
    const startedAt = (this.input.now ?? Date.now)();
    let drainRequested = false;
    const requestDrain = () => {
      if (drainRequested) return;
      drainRequested = true;
      this.input.requestDrain();
    };
    const requestCancellation = () => requestDrain();
    signal.addEventListener('abort', requestCancellation, { once: true });
    if (signal.aborted) requestCancellation();
    try {
      signal.throwIfAborted();
      await requireSuccess(
        this.input.handlers['session.create'](
          { sessionId: input.executionId, ...input.session },
          this.input.context,
        ),
      );
      signal.throwIfAborted();
      const started = await requireSuccess(
        this.input.handlers['turn.start'](
          {
            sessionId: input.executionId,
            turnId: input.executionId,
            content: input.content,
            ...(input.maxSteps === undefined ? {} : { maxSteps: input.maxSteps }),
          },
          this.input.context,
        ),
      );
      if (started.kind !== 'started') throw new Error('Hosted root Turn was not started');
      const terminal = await this.#waitForTerminal(started.turn, signal);
      await (signal.aborted
        ? this.input.waitForAllResidencies()
        : this.input.waitForExecutionResidencies());
      const usage = await this.#readUsage(startedAt, (this.input.now ?? Date.now)());
      const incompleteUsage = incompleteUsageReason(usage);
      if (incompleteUsage) {
        return indeterminate(
          input.executionId,
          `Runtime Host usage did not settle: ${incompleteUsage}`,
        );
      }
      return {
        executionId: input.executionId,
        kind: 'settled',
        status: terminalStatus(terminal),
        ...(terminal.status === 'failed' ? { failureReason: terminal.failureClass } : {}),
        usage: {
          inputTokens: usage.summary.totalTokens.input,
          outputTokens: usage.summary.totalTokens.output,
          cacheReadTokens: usage.summary.totalTokens.cacheRead,
          cacheWriteTokens: usage.summary.totalTokens.cacheWrite,
          reasoningTokens: usage.summary.totalTokens.reasoning,
          totalTokens: usage.summary.totalTokens.total,
        },
        costUsd:
          usage.provenance.coverage.unpricedAttempts === 0 && usage.provenance.legacyRecords === 0
            ? usage.summary.totalCostUsd
            : null,
      };
    } catch {
      requestDrain();
      await this.input.waitForAllResidencies().catch(() => undefined);
      return indeterminate(input.executionId, 'Runtime Host could not settle execution');
    } finally {
      signal.removeEventListener('abort', requestCancellation);
    }
  }

  async #waitForTerminal(started: TurnSnapshot, signal: AbortSignal): Promise<TurnSnapshot> {
    let stop: Promise<TurnSnapshot> | undefined;
    const requestStop = () => {
      stop ??= requireSuccess(
        this.input.handlers['turn.stop'](
          { sessionId: started.sessionId, turnId: started.turnId, runId: started.runId },
          this.input.context,
        ),
      );
    };
    signal.addEventListener('abort', requestStop, { once: true });
    if (signal.aborted) requestStop();
    try {
      for (;;) {
        if (stop) return await stop;
        const snapshot = await requireSuccess(
          this.input.handlers['turn.query'](
            { sessionId: started.sessionId, turnId: started.turnId },
            this.input.context,
          ),
        );
        if (isTerminal(snapshot)) return snapshot;
        await delay();
      }
    } finally {
      signal.removeEventListener('abort', requestStop);
    }
  }

  async #readUsage(from: number, to: number) {
    const result = await requireSuccess(
      this.input.handlers['usage.query'](
        { kind: 'summary', query: { range: { from, to } } },
        this.input.context,
      ),
    );
    if (result.kind !== 'summary') throw new Error('Runtime Host returned non-summary usage');
    return result;
  }
}

function incompleteUsageReason(
  result: Extract<UsageQueryResult, { kind: 'summary' }>,
): string | undefined {
  const { coverage, unreadableRecords, pendingRepairs } = result.provenance;
  if (unreadableRecords > 0) return 'unreadable_usage_record';
  if (pendingRepairs > 0) return 'pending_usage_repair';
  if (coverage.usagePartialAttempts > 0) return 'partial_attempt_usage';
  if (coverage.usageMissingAttempts > 0) return 'missing_attempt_usage';
  return undefined;
}

function isTerminal(
  snapshot: TurnSnapshot,
): snapshot is TurnSnapshot & { status: 'completed' | 'failed' | 'cancelled' } {
  return (
    snapshot.status === 'completed' ||
    snapshot.status === 'failed' ||
    snapshot.status === 'cancelled'
  );
}

function terminalStatus(snapshot: TurnSnapshot): 'completed' | 'failed' | 'cancelled' {
  if (!isTerminal(snapshot)) throw new Error('Hosted root Turn is not terminal');
  return snapshot.status;
}

async function requireSuccess<K extends OperationKey>(
  outcome: Promise<OperationOutcome<K>>,
): Promise<OperationOutput<K>> {
  const result = await outcome;
  if (!result.ok) throw new Error(result.error.message);
  return result.result;
}

function delay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 25));
}

function indeterminate(executionId: string, failureReason: string): HostedExecutionProjection {
  return { executionId, kind: 'indeterminate', failureReason };
}
