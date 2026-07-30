import { AsyncLocalStorage } from 'node:async_hooks';

const sessionAdmissionLeaseBrand: unique symbol = Symbol('SessionAdmissionLease');

export interface SessionAdmissionLease {
  readonly [sessionAdmissionLeaseBrand]: true;
}

interface SessionAdmissionContext {
  readonly sessionId: string;
  active: boolean;
}

interface SessionAdmissionLeaseState {
  readonly sessionId: string;
  readonly context: SessionAdmissionContext;
  readonly tasks: Promise<SessionAdmissionTaskResult>[];
  accepting: boolean;
}

type SessionAdmissionTaskResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: unknown };

export class SessionAdmissionGate {
  readonly #tails = new Map<string, Promise<void>>();
  readonly #context = new AsyncLocalStorage<SessionAdmissionContext>();
  readonly #leases = new WeakMap<SessionAdmissionLease, SessionAdmissionLeaseState>();

  run<T>(
    sessionId: string,
    operation: (lease: SessionAdmissionLease) => Promise<T> | T,
  ): Promise<T> {
    if (this.#context.getStore()?.active) {
      return Promise.reject(
        new Error(
          'Cannot enter Session admission from an active admission; reuse its lease instead',
        ),
      );
    }
    return this.#runQueued(sessionId, operation);
  }

  enqueueDetached(
    sessionId: string,
    operation: (lease: SessionAdmissionLease) => Promise<void> | void,
  ): Promise<void> {
    return this.#runQueued(sessionId, operation);
  }

  runAdmitted<T>(
    sessionId: string,
    lease: SessionAdmissionLease,
    operation: () => Promise<T> | T,
  ): Promise<T> {
    const state = this.#requireLease(sessionId, lease);
    if (!state.accepting) {
      return Promise.reject(new Error('Session admission lease no longer accepts tasks'));
    }
    const inherited = this.#context.getStore();
    if (inherited?.active && inherited.sessionId !== sessionId) {
      return Promise.reject(new Error('Cannot nest Session admission across Sessions'));
    }

    let task: Promise<T>;
    try {
      task = Promise.resolve(this.#context.run(state.context, operation));
    } catch (error) {
      task = Promise.reject(error);
    }
    state.tasks.push(
      task.then(
        (): SessionAdmissionTaskResult => ({ ok: true }),
        (error): SessionAdmissionTaskResult => ({ ok: false, error }),
      ),
    );
    return task;
  }

  async #runQueued<T>(
    sessionId: string,
    operation: (lease: SessionAdmissionLease) => Promise<T> | T,
  ): Promise<T> {
    const previous = this.#tails.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.#tails.set(sessionId, tail);
    await previous;

    const context: SessionAdmissionContext = { sessionId, active: true };
    const lease: SessionAdmissionLease = Object.freeze({
      [sessionAdmissionLeaseBrand]: true as const,
    });
    const state: SessionAdmissionLeaseState = {
      sessionId,
      context,
      tasks: [],
      accepting: true,
    };
    this.#leases.set(lease, state);
    try {
      let result!: T;
      let operationError: unknown;
      let operationFailed = false;
      try {
        result = await this.#context.run(context, () => operation(lease));
      } catch (error) {
        operationFailed = true;
        operationError = error;
      } finally {
        state.accepting = false;
      }

      const taskResults = await Promise.all(state.tasks);
      const errors: unknown[] = [];
      const collect = (error: unknown) => {
        if (!errors.some((existing) => Object.is(existing, error))) errors.push(error);
      };
      if (operationFailed) collect(operationError);
      for (const taskResult of taskResults) {
        if (!taskResult.ok) collect(taskResult.error);
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, 'Session admission operation failed');
      }
      return result;
    } finally {
      context.active = false;
      this.#leases.delete(lease);
      release();
      if (this.#tails.get(sessionId) === tail) this.#tails.delete(sessionId);
    }
  }

  #requireLease(sessionId: string, lease: SessionAdmissionLease): SessionAdmissionLeaseState {
    const state = this.#leases.get(lease);
    if (!state) throw new Error('Session admission lease was not issued by this gate');
    if (state.sessionId !== sessionId) {
      throw new Error('Session admission lease does not match the Session');
    }
    return state;
  }
}
