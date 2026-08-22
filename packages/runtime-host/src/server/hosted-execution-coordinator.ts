import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { preservesHostedExecutionEnvironment } from '../protocol/index.js';
import type {
  HostedExecutionProjection,
  HostedExecutionReferenceInput,
  HostedExecutionStartInput,
  OperationOutcome,
} from '../protocol/index.js';
import type { HostedExecutionOperationHandlerMap } from './operation-dispatcher.js';

type EnsuredHostedExecution =
  | {
      readonly ok: true;
      readonly admissionToken: string;
      readonly task: Promise<HostedExecutionProjection>;
    }
  | { readonly ok: false; readonly outcome: OperationOutcome<'hosted.execution.start'> };

export class HostHostedExecutionCoordinator {
  readonly handlers: HostedExecutionOperationHandlerMap = {
    'hosted.execution.admit': (input) => this.#admit(input),
    'hosted.execution.start': (input) => this.#start(input),
    'hosted.execution.cancel': (input) => this.#cancel(input),
  };

  readonly #executions = new Map<
    string,
    {
      readonly input: HostedExecutionStartInput;
      readonly abort: AbortController;
      readonly admissionToken: string;
      readonly task: Promise<HostedExecutionProjection>;
    }
  >();
  readonly #cancelled = new Set<string>();
  #accepting = true;

  constructor(
    private readonly run: (
      input: HostedExecutionStartInput,
      signal: AbortSignal,
    ) => Promise<HostedExecutionProjection>,
    private readonly requestDrain: () => void,
  ) {}

  beginDrain(): void {
    this.#accepting = false;
    for (const execution of this.#executions.values()) execution.abort.abort();
  }

  async close(): Promise<void> {
    this.beginDrain();
    await Promise.all([...this.#executions.values()].map(({ task }) => task));
  }

  async #admit(
    input: HostedExecutionStartInput,
  ): Promise<OperationOutcome<'hosted.execution.admit'>> {
    const ensured = this.#ensureExecution(input);
    if (!ensured.ok) {
      return ensured.outcome.ok
        ? {
            ok: false,
            error: {
              code: 'invalid_request',
              message: 'Hosted execution was cancelled before admission',
            },
          }
        : ensured.outcome;
    }
    return {
      ok: true,
      result: { executionId: input.executionId, admissionToken: ensured.admissionToken },
    };
  }

  async #start(
    input: HostedExecutionStartInput,
  ): Promise<OperationOutcome<'hosted.execution.start'>> {
    const ensured = this.#ensureExecution(input);
    if (!ensured.ok) return ensured.outcome;
    return { ok: true, result: structuredClone(await ensured.task) };
  }

  #ensureExecution(input: HostedExecutionStartInput): EnsuredHostedExecution {
    if (this.#cancelled.has(input.executionId)) {
      this.requestDrain();
      return {
        ok: false,
        outcome: {
          ok: true,
          result: indeterminate(
            input.executionId,
            'Hosted execution was cancelled before admission',
          ),
        },
      };
    }
    const existing = this.#executions.get(input.executionId);
    if (existing) {
      if (!isDeepStrictEqual(existing.input, input)) return { ok: false, outcome: conflict() };
      return { ok: true, admissionToken: existing.admissionToken, task: existing.task };
    }
    if (!this.#accepting) {
      return {
        ok: false,
        outcome: {
          ok: false,
          error: { code: 'host_draining', message: 'Runtime Host is draining' },
        },
      };
    }
    const abort = new AbortController();
    const admissionToken = randomUUID();
    const task = this.run(input, abort.signal)
      .catch(() => indeterminate(input.executionId, 'Runtime Host could not settle execution'))
      .then((result) => {
        if (!preservesHostedExecutionEnvironment(result)) this.requestDrain();
        return result;
      })
      .finally(() => {
        this.#executions.delete(input.executionId);
      });
    this.#executions.set(input.executionId, {
      input: structuredClone(input),
      abort,
      admissionToken,
      task,
    });
    return { ok: true, admissionToken, task };
  }

  async #cancel(
    input: HostedExecutionReferenceInput,
  ): Promise<OperationOutcome<'hosted.execution.cancel'>> {
    this.#cancelled.add(input.executionId);
    const execution = this.#executions.get(input.executionId);
    if (!execution) {
      this.requestDrain();
      return {
        ok: true,
        result: indeterminate(input.executionId, 'Hosted execution is not active'),
      };
    }
    execution.abort.abort();
    return { ok: true, result: structuredClone(await execution.task) };
  }
}

function conflict(): OperationOutcome<'hosted.execution.start'> {
  return {
    ok: false,
    error: { code: 'operation_conflict', message: 'Hosted execution identity is already in use' },
  };
}

function indeterminate(executionId: string, failureReason: string): HostedExecutionProjection {
  return { executionId, kind: 'indeterminate', failureReason };
}
