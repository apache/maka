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
  EXECUTION_INSPECT_CANDIDATE_MAX_ITEMS,
  EXECUTION_INSPECT_EVIDENCE_MAX_BYTES,
  EXECUTION_INSPECT_EVIDENCE_MAX_RECORDS,
  EXECUTION_INSPECT_RESULT_MAX_BYTES,
  EXECUTION_INSPECT_SESSION_MAX_RUNS,
  EXECUTION_INSPECT_TRACE_PAGE_MAX_TURNS,
  type ExecutionInspectCandidate,
  type ExecutionInspectQueryInput,
  type ExecutionInspectQueryResult,
  type ExecutionInspectResolveInput,
  type OperationOutcome,
} from '../protocol/index.js';
import type { ExecutionInspectOperationHandlerMap } from './operation-dispatcher.js';

interface InspectStores {
  readonly sessionStore: Pick<ExecutionSessionWriter, 'readHeaderSnapshot'>;
  readonly agentRunStore: Pick<
    ExecutionAgentRunReader,
    | 'readRun'
    | 'findRunsById'
    | 'listSessionRunsBounded'
    | 'listSessionRunsPage'
    | 'readEventsBounded'
    | 'readEventsByTypeBounded'
    | 'readRootTurnAdmission'
  >;
  readonly runtimeEventStore: Pick<ExecutionRuntimeEventReader, 'readRuntimeEventsBounded'>;
}

/** Host-owned, payload-safe read model for live Interactive execution evidence. */
export class HostExecutionInspectCoordinator {
  readonly handlers: ExecutionInspectOperationHandlerMap = {
    'execution.inspect.resolve': (input) => this.#resolve(input),
    'execution.inspect.query': (input) => this.#query(input),
  };

  readonly #stores: InspectStores;

  constructor(stores: InspectStores) {
    this.#stores = stores;
  }

  async #resolve(
    input: ExecutionInspectResolveInput,
  ): Promise<OperationOutcome<'execution.inspect.resolve'>> {
    try {
      const [sessionCandidates, runSearch] = await Promise.all([
        input.requestedKind === 'agent_run' ? [] : this.#findSession(input.id),
        input.requestedKind === 'session'
          ? { runs: [], truncated: false }
          : input.sessionId
            ? this.#findRunInSession(input.sessionId, input.id)
            : this.#stores.agentRunStore.findRunsById(
                input.id,
                input.requestedKind === undefined
                  ? EXECUTION_INSPECT_CANDIDATE_MAX_ITEMS - 1
                  : EXECUTION_INSPECT_CANDIDATE_MAX_ITEMS,
              ),
      ]);
      const candidates = [
        ...runSearch.runs.map(
          (run): ExecutionInspectCandidate => ({
            kind: 'agent_run',
            id: run.runId,
            sessionId: run.sessionId,
          }),
        ),
        ...sessionCandidates,
      ].sort(compareCandidates);
      const truncated = runSearch.truncated;
      const status =
        candidates.length === 0 && !truncated
          ? 'not_found'
          : candidates.length === 1 && !truncated
            ? 'resolved'
            : 'ambiguous';
      return { ok: true, result: { status, candidates, truncated } };
    } catch {
      return failure(
        'execution.inspect.resolve',
        'persistence_failed',
        'Execution evidence is unavailable',
      );
    }
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
        return failure('execution.inspect.query', 'not_found', 'Execution evidence was not found');
      }
      if (encodedBytes(result) > EXECUTION_INSPECT_RESULT_MAX_BYTES) {
        return failure(
          'execution.inspect.query',
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
        return failure('execution.inspect.query', 'invalid_request', error.message);
      }
      if (error instanceof InspectQueryInvalidError) {
        return failure('execution.inspect.query', 'invalid_request', error.message);
      }
      return failure(
        'execution.inspect.query',
        'persistence_failed',
        'Execution evidence is unavailable',
      );
    }
  }

  async #findSession(id: string): Promise<ExecutionInspectCandidate[]> {
    try {
      const header = await this.#stores.sessionStore.readHeaderSnapshot(id);
      return [{ kind: 'session', id: header.id }];
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }

  async #findRunInSession(sessionId: string, runId: string) {
    try {
      const run = await this.#stores.agentRunStore.readRun(sessionId, runId);
      return { runs: [run], truncated: false };
    } catch (error) {
      if (isMissing(error)) return { runs: [], truncated: false };
      throw error;
    }
  }

  async #inspectAgentRun(
    sessionId: string,
    agentRunId: string,
  ): Promise<ExecutionInspectQueryResult | undefined> {
    let header;
    try {
      header = await this.#stores.agentRunStore.readRun(sessionId, agentRunId);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    const document: AgentRunInspectDocument = await inspectAgentRunDocument(
      ...this.#budgetedReaders('AgentRun'),
      {
        sessionId,
        agentRunId,
        header,
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
    const runPage = await this.#stores.agentRunStore.listSessionRunsBounded(
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
      {
        ...readers[0],
        listSessionRuns: async () => [...runPage.runs],
      },
      readers[1],
      sessionId,
      {
        header,
        runHeaders: runPage.runs,
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
    const runPage = await this.#stores.agentRunStore.listSessionRunsPage(input.sessionId, {
      ...(before ? { before } : {}),
      limit: EXECUTION_INSPECT_TRACE_PAGE_MAX_TURNS,
    });
    const budget = new InspectEvidenceBudget('Session');
    const runtimeEvents: RuntimeEvent[] = [];
    const modelCallAttempts: ModelCallAttempt[] = [];
    let unreadableRecords = 0;
    let includedRuns = 0;
    let acceptedPage: ExecutionInspectQueryResult | undefined;
    for (const run of runPage.runs) {
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
          tracePageCursorAfter(runPage.runs, 1, runPage.nextCursor),
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
        nextCursor: tracePageCursorAfter(runPage.runs, candidateRunCount, runPage.nextCursor),
      };
      if (
        candidateTrace.turns.length > EXECUTION_INSPECT_TRACE_PAGE_MAX_TURNS ||
        encodedBytes(candidatePage) > EXECUTION_INSPECT_RESULT_MAX_BYTES
      ) {
        if (includedRuns === 0) {
          return oversizedTracePage(
            input.sessionId,
            tracePageCursorAfter(runPage.runs, 1, runPage.nextCursor),
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
        nextCursor: tracePageCursorAfter(runPage.runs, 0, runPage.nextCursor),
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
    try {
      const run = await this.#stores.agentRunStore.readRun(sessionId, admission.runId);
      if (run.turnId !== turnId) {
        throw new InspectQueryInvalidError('Turn trace admission does not match its AgentRun');
      }
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
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
        readRun: (sessionId: string, runId: string) =>
          this.#stores.agentRunStore.readRun(sessionId, runId),
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
  runs: readonly { readonly runId: string; readonly createdAt: number }[],
  includedRuns: number,
  sourceNextCursor: { readonly createdAt: number; readonly runId: string } | null,
): string | null {
  const last = runs[includedRuns - 1];
  if (!last) return null;
  const hasMore = includedRuns < runs.length || sourceNextCursor !== null;
  return hasMore ? encodeTraceCursor({ createdAt: last.createdAt, runId: last.runId }) : null;
}

function encodeTraceCursor(cursor: { readonly createdAt: number; readonly runId: string }): string {
  return Buffer.from(JSON.stringify({ v: 1, ...cursor }), 'utf8').toString('base64url');
}

function decodeTraceCursor(cursor: string): { readonly createdAt: number; readonly runId: string } {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    if (
      value.v !== 1 ||
      typeof value.createdAt !== 'number' ||
      !Number.isFinite(value.createdAt) ||
      typeof value.runId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(value.runId) ||
      Object.keys(value).length !== 3
    ) {
      throw new Error('invalid cursor');
    }
    return { createdAt: value.createdAt, runId: value.runId };
  } catch {
    throw new InspectQueryInvalidError('Session trace continuation cursor is invalid');
  }
}

function compareCandidates(
  left: ExecutionInspectCandidate,
  right: ExecutionInspectCandidate,
): number {
  return (
    left.kind.localeCompare(right.kind) ||
    (left.kind === 'agent_run' ? left.sessionId : '').localeCompare(
      right.kind === 'agent_run' ? right.sessionId : '',
    )
  );
}

function isMissing(error: unknown): boolean {
  return isSessionNotFoundError(error) || (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function isInspectQueryTooLargeError(error: unknown): boolean {
  return error instanceof InspectQueryTooLargeError;
}

function failure<K extends 'execution.inspect.resolve' | 'execution.inspect.query'>(
  _operation: K,
  code: Extract<OperationOutcome<K>, { ok: false }>['error']['code'],
  message: string,
): OperationOutcome<K> {
  return { ok: false, error: { code, message } } as OperationOutcome<K>;
}
