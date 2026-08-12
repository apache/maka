import { randomUUID } from 'node:crypto';
import type { SessionHeader } from '@maka/core/session';
import { RuntimeContextCompactError } from '@maka/runtime/runtime-kernel';
import {
  RuntimeHostedRootConflictError,
  RuntimeHostedRootUnavailableError,
} from '@maka/runtime/message-authority';
import { type SessionManager } from '@maka/runtime/session-manager';
import { isSessionNotFoundError } from '@maka/storage/execution-stores';
import type {
  ContextCompactInput,
  ContextDiagnosticsQueryInput,
  OperationOutcome,
} from '../protocol/index.js';
import type { ContextOperationHandlerMap } from './operation-dispatcher.js';
import { runtimeHostExternalTurnUnavailableReason } from './host-session-availability.js';
import type {
  HostedExecutionAdmission,
  HostedExecutionAuthority,
  HostedExecutionIdentity,
} from './hosted-execution-authority.js';
import { isHostedExecutionTerminal } from './hosted-execution-authority.js';

type ContextRuntime = Pick<
  SessionManager,
  'compactSession' | 'getContextDiagnostics' | 'listTurns' | 'preflightContextCompaction'
>;
type ContextExecutionAuthority = Pick<
  HostedExecutionAuthority,
  'admit' | 'lookup' | 'prepare' | 'reconcile'
>;

export interface HostContextCoordinatorOptions {
  readonly runtime: ContextRuntime;
  readonly executions: ContextExecutionAuthority;
  readonly sessions: {
    readHeaderSnapshot(sessionId: string): Promise<SessionHeader>;
  };
  readonly requestDrain: () => void;
  readonly newId?: () => string;
}

/** Owns Interactive context inspection and explicit compaction policy. */
export class HostContextCoordinator {
  readonly handlers: ContextOperationHandlerMap = {
    'context.diagnostics.query': (input) => this.#queryDiagnostics(input),
    'context.compact': (input) => this.#compact(input),
  };

  readonly #runtime: ContextRuntime;
  readonly #executions: ContextExecutionAuthority;
  readonly #sessions: HostContextCoordinatorOptions['sessions'];
  readonly #requestDrain: () => void;
  readonly #newId: () => string;

  constructor(options: HostContextCoordinatorOptions) {
    this.#runtime = options.runtime;
    this.#executions = options.executions;
    this.#sessions = options.sessions;
    this.#requestDrain = options.requestDrain;
    this.#newId = options.newId ?? randomUUID;
  }

  async #queryDiagnostics(
    input: ContextDiagnosticsQueryInput,
  ): Promise<OperationOutcome<'context.diagnostics.query'>> {
    try {
      await this.#sessions.readHeaderSnapshot(input.sessionId);
      return {
        ok: true,
        result: await this.#runtime.getContextDiagnostics(input.sessionId),
      };
    } catch (error) {
      if (isSessionNotFoundError(error)) return notFound('Session does not exist');
      throw error;
    }
  }

  async #compact(input: ContextCompactInput): Promise<OperationOutcome<'context.compact'>> {
    let prepared:
      | Extract<ReturnType<ContextExecutionAuthority['prepare']>, { kind: 'prepared' }>['admission']
      | undefined;
    try {
      const existing = await this.#executions.lookup(input.sessionId, input.turnId);
      if (existing && existing.descriptor.kind !== 'context_compact') {
        return operationConflict('Turn identity belongs to a different execution kind');
      }
      if (existing) {
        const admitted = await this.#executions.admit(this.#admission(input, existing));
        return {
          ok: true,
          result: admitted.snapshot,
        };
      }

      let preparation = this.#executions.prepare(input.sessionId);
      if (preparation.kind === 'busy' && preparation.execution) {
        const active = await this.#executions.reconcile(preparation.execution);
        if (isHostedExecutionTerminal(active)) {
          await preparation.whenIdle;
          preparation = this.#executions.prepare(input.sessionId);
        }
      }
      if (preparation.kind === 'busy') {
        return sessionBusy('Session already has an active or pending root Turn');
      }
      if (preparation.kind === 'unavailable') {
        return operationUnavailable(preparation.reason);
      }
      prepared = preparation.admission;

      const rejected = await this.#preflight(input);
      if (rejected) return rejected;

      const identity: HostedExecutionIdentity = {
        sessionId: input.sessionId,
        turnId: input.turnId,
        runId: this.#newId(),
        userMessageId: null,
        descriptor: { kind: 'context_compact' },
      };
      const admitted = await prepared.admit(this.#admission(input, identity));
      return {
        ok: true,
        result: admitted.snapshot,
      };
    } catch (error) {
      if (error instanceof RuntimeHostedRootConflictError) {
        return sessionBusy(error.message);
      }
      if (error instanceof RuntimeHostedRootUnavailableError) {
        return operationUnavailable(error.message);
      }
      this.#requestDrain();
      throw error;
    } finally {
      prepared?.release();
    }
  }

  async #preflight(
    input: ContextCompactInput,
  ): Promise<OperationOutcome<'context.compact'> | undefined> {
    let header: SessionHeader;
    try {
      header = await this.#sessions.readHeaderSnapshot(input.sessionId);
    } catch (error) {
      if (isSessionNotFoundError(error)) return notFound('Session does not exist');
      throw error;
    }
    if (header.status === 'archived' || header.isArchived) {
      return sessionArchived('Cannot compact an archived Session');
    }
    const unavailableReason = runtimeHostExternalTurnUnavailableReason(header);
    if (unavailableReason) return operationUnavailable(unavailableReason);
    if (
      (await this.#runtime.listTurns(input.sessionId)).some((turn) => turn.turnId === input.turnId)
    ) {
      return operationConflict('Turn identity already exists');
    }
    try {
      await this.#runtime.preflightContextCompaction(input.sessionId);
    } catch (error) {
      if (error instanceof RuntimeContextCompactError) {
        return error.code === 'session_busy'
          ? sessionBusy(error.message)
          : operationUnavailable(error.message);
      }
      throw error;
    }
    return undefined;
  }

  #admission(
    input: ContextCompactInput,
    identity: HostedExecutionIdentity,
  ): HostedExecutionAdmission {
    return {
      sessionId: identity.sessionId,
      turnId: identity.turnId,
      runId: identity.runId,
      userMessageId: identity.userMessageId,
      execution: identity.descriptor,
      content: null,
      start: ({ runId, userMessageId, onRunStarted }) => {
        if (runId !== identity.runId || userMessageId !== null) {
          throw new Error('Hosted Execution changed the context compact identity');
        }
        return this.#runtime.compactSession(input.sessionId, {
          turnId: input.turnId,
          hostedRoot: { runId, onRunStarted },
        });
      },
    };
  }
}

function notFound(message: string) {
  return { ok: false, error: { code: 'not_found', message } } as const;
}

function sessionBusy(message: string) {
  return { ok: false, error: { code: 'session_busy', message } } as const;
}

function sessionArchived(message: string) {
  return { ok: false, error: { code: 'session_archived', message } } as const;
}

function operationUnavailable(message: string) {
  return {
    ok: false,
    error: { code: 'operation_unavailable', message },
  } as const;
}

function operationConflict(message: string) {
  return { ok: false, error: { code: 'operation_conflict', message } } as const;
}
