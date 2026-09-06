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

import {
  decodeModelCallAttempt,
  MODEL_CALL_ATTEMPT_EVENT_TYPE,
  type ModelCallAttempt,
} from '@maka/core/model-call-attempt';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { readRunInvocation } from '@maka/core/runtime-event-store';
import type {
  RuntimeInvocationPageCursor,
  RuntimeInvocationRecord,
} from '@maka/core/runtime-invocation';
import { inspectAgentRunDocument, inspectSessionDocument } from '@maka/runtime/execution-inspect';
import { projectSessionTrace } from '@maka/runtime/session-trace-projection';
import {
  type AgentRunInspectDocument,
  type SessionInspectDocument,
} from '@maka/core/execution-inspect';
import {
  isSessionNotFoundError,
  type BoundedEvidenceReadResult,
  type EvidenceReadBudget,
  type ExecutionAgentRunReader,
  type ExecutionRuntimeEventReader,
  type ExecutionSessionWriter,
} from '@maka/storage/execution-stores';
import {
  EXECUTION_INSPECT_EVIDENCE_MAX_BYTES,
  EXECUTION_INSPECT_EVIDENCE_MAX_RECORDS,
  EXECUTION_INSPECT_RESULT_MAX_BYTES,
  EXECUTION_INSPECT_SESSION_MAX_RUNS,
  EXECUTION_INSPECT_TRACE_PAGE_MAX_TURNS,
  type ExecutionInspectQueryInput,
  type ExecutionInspectQueryResult,
  type OperationOutcome,
} from '../protocol/index.js';
import type { ExecutionInspectOperationHandlerMap } from './operation-dispatcher.js';

interface InspectStores {
  readonly sessionStore: Pick<ExecutionSessionWriter, 'readHeaderSnapshot'>;
  readonly agentRunStore: Pick<
    ExecutionAgentRunReader,
    'readEventsBounded' | 'readEventsByTypeBounded' | 'readRootTurnAdmission'
  >;
  readonly runtimeEventStore: Pick<
    ExecutionRuntimeEventReader,
    | 'readRuntimeEventsBounded'
    | 'listSessionInvocations'
    | 'listSessionInvocationsBounded'
    | 'listSessionInvocationsPage'
    | 'readInvocation'
  >;
}

/** Host-owned, payload-safe read model for live Interactive execution evidence. */
export class HostExecutionInspectCoordinator {
  readonly handlers: ExecutionInspectOperationHandlerMap = {
    'execution.inspect.query': (input) => this.#query(input),
  };

  readonly #stores: InspectStores;

  constructor(stores: InspectStores) {
    this.#stores = stores;
  }

  async #query(
    input: ExecutionInspectQueryInput,
  ): Promise<OperationOutcome<'execution.inspect.query'>> {
    try {
      const result =
        input.kind === 'agent_run'
          ? await this.#inspectAgentRun(input.sessionId, input.agentRunId)
          : input.kind === 'session'
            ? await this.#inspectSession(input.sessionId)
            : input.kind === 'turn_trace'
              ? await this.#inspectTurnTrace(input.sessionId, input.turnId)
              : await this.#inspectSessionTracePage(input);
      if (result === undefined) {
        return failure('not_found', 'Execution evidence was not found');
      }
      if (encodedBytes(result) > EXECUTION_INSPECT_RESULT_MAX_BYTES) {
        return failure(
          'invalid_request',
          input.kind === 'session'
            ? 'Session inspection exceeds the live Host result limit; inspect one AgentRun instead'
            : input.kind === 'turn_trace'
              ? 'Turn trace exceeds the live Host result limit'
              : input.kind === 'session_trace_start' || input.kind === 'session_trace_continue'
                ? 'One Session trace page exceeds the live Host result limit'
                : 'AgentRun inspection exceeds the live Host result limit',
        );
      }
      return { ok: true, result };
    } catch (error) {
      if (error instanceof InspectQueryTooLargeError) {
        return failure('invalid_request', error.message);
      }
      if (error instanceof InspectQueryInvalidError) {
        return failure('invalid_request', error.message);
      }
      return failure('persistence_failed', 'Execution evidence is unavailable');
    }
  }

  async #inspectAgentRun(
    sessionId: string,
    agentRunId: string,
  ): Promise<ExecutionInspectQueryResult | undefined> {
    let invocation;
    try {
      invocation = await readRunInvocation(this.#stores.runtimeEventStore, sessionId, agentRunId);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    if (!invocation) return undefined;
    const document: AgentRunInspectDocument = await inspectAgentRunDocument(
      ...this.#budgetedReaders('AgentRun'),
      {
        sessionId,
        agentRunId,
        invocation,
        isFatalReadError: isInspectQueryTooLargeError,
      },
    );
    return { kind: 'agent_run', document };
  }

  async #inspectSession(sessionId: string): Promise<ExecutionInspectQueryResult | undefined> {
    let header;
    try {
      header = await this.#stores.sessionStore.readHeaderSnapshot(sessionId);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    const runPage = await this.#stores.runtimeEventStore.listSessionInvocationsBounded(
      sessionId,
      EXECUTION_INSPECT_SESSION_MAX_RUNS,
    );
    if (runPage.truncated) {
      throw new InspectQueryTooLargeError(
        'Session inspection exceeds the live Host run limit; inspect one AgentRun instead',
      );
    }
    const readers = this.#budgetedReaders('Session');
    const document: SessionInspectDocument = await inspectSessionDocument(
      { readHeader: (id) => this.#stores.sessionStore.readHeaderSnapshot(id) },
      readers[0],
      readers[1],
      sessionId,
      {
        header,
        invocations: runPage.invocations,
        isFatalReadError: isInspectQueryTooLargeError,
      },
    );
    return { kind: 'session', document };
  }

  async #inspectSessionTracePage(
    input: Extract<
      ExecutionInspectQueryInput,
      { kind: 'session_trace_start' | 'session_trace_continue' }
    >,
  ): Promise<ExecutionInspectQueryResult | undefined> {
    try {
      await this.#stores.sessionStore.readHeaderSnapshot(input.sessionId);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    const before =
      input.kind === 'session_trace_continue' ? decodeTraceCursor(input.cursor) : undefined;
    const runPage = await this.#stores.runtimeEventStore.listSessionInvocationsPage(
      input.sessionId,
      {
        ...(before ? { before } : {}),
        limit: EXECUTION_INSPECT_TRACE_PAGE_MAX_TURNS,
      },
    );
    const budget = new InspectEvidenceBudget('Session');
    const runtimeEvents: RuntimeEvent[] = [];
    const modelCallAttempts: ModelCallAttempt[] = [];
    let unreadableRecords = 0;
    let includedRuns = 0;
    let acceptedPage: ExecutionInspectQueryResult | undefined;
    for (const run of runPage.invocations) {
      let evidence: {
        readonly runtimeEvents: RuntimeEvent[];
        readonly modelCallAttempts: ModelCallAttempt[];
        readonly unreadableRecords: number;
      };
      try {
        evidence = await this.#readRunTraceEvidence(input.sessionId, run.runId, budget);
      } catch (error) {
        if (!isInspectQueryTooLargeError(error)) throw error;
        if (includedRuns > 0) break;
        return oversizedTracePage(
          input.sessionId,
          tracePageCursorAfter(runPage.invocations, 1, runPage.nextCursor),
        );
      }
      const candidateRuntimeEvents = [...runtimeEvents, ...evidence.runtimeEvents];
      const candidateModelCallAttempts = [...modelCallAttempts, ...evidence.modelCallAttempts];
      const candidateUnreadableRecords = unreadableRecords + evidence.unreadableRecords;
      const candidateTrace = projectSessionTrace({
        sessionId: input.sessionId,
        runtimeEvents: candidateRuntimeEvents,
        modelCallAttempts: candidateModelCallAttempts,
        ...(candidateUnreadableRecords > 0
          ? { unreadableRecords: candidateUnreadableRecords }
          : {}),
      });
      const candidateRunCount = includedRuns + 1;
      const candidatePage: ExecutionInspectQueryResult = {
        kind: 'session_trace_page',
        ...candidateTrace,
        nextCursor: tracePageCursorAfter(
          runPage.invocations,
          candidateRunCount,
          runPage.nextCursor,
        ),
      };
      if (
        candidateTrace.turns.length > EXECUTION_INSPECT_TRACE_PAGE_MAX_TURNS ||
        encodedBytes(candidatePage) > EXECUTION_INSPECT_RESULT_MAX_BYTES
      ) {
        if (includedRuns === 0) {
          return oversizedTracePage(
            input.sessionId,
            tracePageCursorAfter(runPage.invocations, 1, runPage.nextCursor),
          );
        }
        break;
      }
      runtimeEvents.push(...evidence.runtimeEvents);
      modelCallAttempts.push(...evidence.modelCallAttempts);
      unreadableRecords = candidateUnreadableRecords;
      includedRuns = candidateRunCount;
      acceptedPage = candidatePage;
    }
    return (
      acceptedPage ?? {
        kind: 'session_trace_page',
        ...projectSessionTrace({
          sessionId: input.sessionId,
          runtimeEvents: [],
          modelCallAttempts: [],
        }),
        nextCursor: tracePageCursorAfter(runPage.invocations, 0, runPage.nextCursor),
      }
    );
  }

  async #inspectTurnTrace(
    sessionId: string,
    turnId: string,
  ): Promise<ExecutionInspectQueryResult | undefined> {
    try {
      await this.#stores.sessionStore.readHeaderSnapshot(sessionId);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    const admission = await this.#stores.agentRunStore.readRootTurnAdmission(sessionId, turnId);
    if (!admission) return undefined;
    let run;
    try {
      run = await readRunInvocation(this.#stores.runtimeEventStore, sessionId, admission.runId);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    if (!run) return undefined;
    if (run.turnId !== turnId) {
      throw new InspectQueryInvalidError('Turn trace admission does not match its AgentRun');
    }
    const evidence = await this.#readRunTraceEvidence(
      sessionId,
      admission.runId,
      new InspectEvidenceBudget('Turn'),
    );
    const turn = projectSessionTrace({
      sessionId,
      runtimeEvents: evidence.runtimeEvents,
      modelCallAttempts: evidence.modelCallAttempts,
      ...(evidence.unreadableRecords > 0 ? { unreadableRecords: evidence.unreadableRecords } : {}),
    }).turns.find(
      (candidate) => candidate.turnId === turnId && candidate.runId === admission.runId,
    );
    return turn ? { kind: 'turn_trace', sessionId, turn } : undefined;
  }

  async #readRunTraceEvidence(
    sessionId: string,
    runId: string,
    budget: InspectEvidenceBudget,
  ): Promise<{
    readonly runtimeEvents: RuntimeEvent[];
    readonly modelCallAttempts: ModelCallAttempt[];
    readonly unreadableRecords: number;
  }> {
    let unreadableRecords = 0;
    const runEvents = await budget
      .read((remaining) =>
        this.#stores.agentRunStore.readEventsByTypeBounded(
          sessionId,
          runId,
          MODEL_CALL_ATTEMPT_EVENT_TYPE,
          remaining,
        ),
      )
      .catch((error) => {
        if (isInspectQueryTooLargeError(error)) throw error;
        unreadableRecords += 1;
        return [];
      });
    const modelCallAttempts: ModelCallAttempt[] = [];
    for (const event of runEvents) {
      if (event.type === 'event_corrupt') {
        unreadableRecords += 1;
        continue;
      }
      if (event.type !== MODEL_CALL_ATTEMPT_EVENT_TYPE) continue;
      try {
        modelCallAttempts.push(decodeModelCallAttempt(event.data));
      } catch {
        unreadableRecords += 1;
      }
    }
    const runtimeEvents = await budget.read((remaining) =>
      this.#stores.runtimeEventStore.readRuntimeEventsBounded(sessionId, runId, remaining),
    );
    return { runtimeEvents, modelCallAttempts, unreadableRecords };
  }

  #budgetedReaders(label: 'AgentRun' | 'Session') {
    const budget = new InspectEvidenceBudget(label);
    return [
      {
        readEvents: (sessionId: string, runId: string) =>
          budget.read((remaining) =>
            this.#stores.agentRunStore.readEventsBounded(sessionId, runId, remaining),
          ),
      },
      {
        readRuntimeEvents: (sessionId: string, runId: string) =>
          budget.read((remaining) =>
            this.#stores.runtimeEventStore.readRuntimeEventsBounded(sessionId, runId, remaining),
          ),
        listSessionInvocations: (sessionId: string) =>
          this.#stores.runtimeEventStore.listSessionInvocations(sessionId),
        readInvocation: (sessionId: string, invocationId: string) =>
          this.#stores.runtimeEventStore.readInvocation(sessionId, invocationId),
      },
    ] as const;
  }
}

class InspectQueryTooLargeError extends Error {
  readonly name = 'InspectQueryTooLargeError';
}

class InspectQueryInvalidError extends Error {
  readonly name = 'InspectQueryInvalidError';
}

class InspectEvidenceBudget {
  #remainingRecords = EXECUTION_INSPECT_EVIDENCE_MAX_RECORDS;
  #remainingBytes = EXECUTION_INSPECT_EVIDENCE_MAX_BYTES;

  constructor(private readonly label: 'AgentRun' | 'Session' | 'Turn') {}

  async read<T>(
    operation: (budget: EvidenceReadBudget) => Promise<BoundedEvidenceReadResult<T>>,
  ): Promise<T[]> {
    const result = await operation({
      maxRecords: this.#remainingRecords,
      maxBytes: this.#remainingBytes,
    });
    if (result.status === 'limit_exceeded') this.#throwExceeded();
    this.#remainingRecords -= result.sourceRecordCount;
    this.#remainingBytes -= result.storedBytes;
    return [...result.records];
  }

  #throwExceeded(): never {
    throw new InspectQueryTooLargeError(
      `${this.label} inspection exceeds the live Host evidence limit; stop the Host to inspect it offline`,
    );
  }
}

function encodedBytes(result: ExecutionInspectQueryResult): number {
  return Buffer.byteLength(JSON.stringify(result), 'utf8');
}

function oversizedTracePage(
  sessionId: string,
  nextCursor: string | null,
): ExecutionInspectQueryResult {
  return {
    kind: 'session_trace_page',
    ...projectSessionTrace({
      sessionId,
      runtimeEvents: [],
      modelCallAttempts: [],
      oversizedRuns: 1,
    }),
    nextCursor,
  };
}

function tracePageCursorAfter(
  invocations: readonly RuntimeInvocationRecord[],
  includedRuns: number,
  sourceNextCursor: RuntimeInvocationPageCursor | null,
): string | null {
  const last = invocations[includedRuns - 1];
  if (!last) return null;
  const hasMore = includedRuns < invocations.length || sourceNextCursor !== null;
  return hasMore
    ? encodeTraceCursor({ openedAt: last.openedAt, invocationId: last.invocationId })
    : null;
}

function encodeTraceCursor(cursor: RuntimeInvocationPageCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, ...cursor }), 'utf8').toString('base64url');
}

function decodeTraceCursor(cursor: string): RuntimeInvocationPageCursor {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    if (
      value.v !== 1 ||
      typeof value.openedAt !== 'number' ||
      !Number.isFinite(value.openedAt) ||
      typeof value.invocationId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(value.invocationId) ||
      Object.keys(value).length !== 3
    ) {
      throw new Error('invalid cursor');
    }
    return { openedAt: value.openedAt, invocationId: value.invocationId };
  } catch {
    throw new InspectQueryInvalidError('Session trace continuation cursor is invalid');
  }
}

function isMissing(error: unknown): boolean {
  return isSessionNotFoundError(error) || (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function isInspectQueryTooLargeError(error: unknown): boolean {
  return error instanceof InspectQueryTooLargeError;
}

function failure(
  code: Extract<OperationOutcome<'execution.inspect.query'>, { ok: false }>['error']['code'],
  message: string,
): OperationOutcome<'execution.inspect.query'> {
  return { ok: false, error: { code, message } };
}
