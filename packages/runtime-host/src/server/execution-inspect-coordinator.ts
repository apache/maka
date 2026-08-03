import {
  inspectAgentRunDocument,
  inspectSessionDocument,
  type AgentRunInspectDocument,
  type SessionInspectDocument,
} from '@maka/runtime';
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
    'readRun' | 'findRunsById' | 'listSessionRunsBounded' | 'readEventsBounded'
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
          : await this.#inspectSession(input.sessionId);
      if (result === undefined) {
        return failure('execution.inspect.query', 'not_found', 'Execution evidence was not found');
      }
      if (encodedBytes(result) > EXECUTION_INSPECT_RESULT_MAX_BYTES) {
        return failure(
          'execution.inspect.query',
          'invalid_request',
          input.kind === 'session'
            ? 'Session inspection exceeds the live Host result limit; inspect one AgentRun instead'
            : 'AgentRun inspection exceeds the live Host result limit',
        );
      }
      return { ok: true, result };
    } catch (error) {
      if (error instanceof InspectQueryTooLargeError) {
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

class InspectEvidenceBudget {
  #remainingRecords = EXECUTION_INSPECT_EVIDENCE_MAX_RECORDS;
  #remainingBytes = EXECUTION_INSPECT_EVIDENCE_MAX_BYTES;

  constructor(private readonly label: 'AgentRun' | 'Session') {}

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
