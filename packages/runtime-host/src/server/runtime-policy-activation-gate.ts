const POISONED_MESSAGE = 'Runtime policy activation is poisoned';

/**
 * Coordinates runtime-policy mutation/invalidation with policy-dependent reads
 * and the short backend activation window that selects a backend and starts a run.
 */
export class RuntimePolicyActivationGate {
  readonly #readActivations = new Set<Promise<void>>();
  #mutationTail = Promise.resolve();
  #poisoned = false;

  runBackendActivation<T>(operation: () => Promise<T> | T): Promise<T> {
    return this.runReadActivation(operation);
  }

  runReadActivation<T>(operation: () => Promise<T> | T): Promise<T> {
    if (this.#poisoned) return Promise.reject(poisonedError());

    const precedingMutations = this.#mutationTail;
    const completion = deferred();
    this.#readActivations.add(completion.promise);

    return this.#executeReadActivation(precedingMutations, completion, operation);
  }

  runMutation<T>(operation: () => Promise<T> | T): Promise<T> {
    if (this.#poisoned) return Promise.reject(poisonedError());

    const precedingMutation = this.#mutationTail;
    const precedingReadActivations = [...this.#readActivations];
    const completion = deferred();

    // This tail never rejects, so later registrations cannot create an
    // unhandled rejection from an operation failure.
    this.#mutationTail = precedingMutation.then(() => completion.promise);

    return this.#executeMutation(
      precedingMutation,
      precedingReadActivations,
      completion,
      operation,
    );
  }

  poison(): void {
    this.#poisoned = true;
  }

  async #executeReadActivation<T>(
    precedingMutations: Promise<void>,
    completion: Deferred,
    operation: () => Promise<T> | T,
  ): Promise<T> {
    try {
      await precedingMutations;
      this.#assertOpen();
      return await operation();
    } finally {
      completion.resolve();
      this.#readActivations.delete(completion.promise);
    }
  }

  async #executeMutation<T>(
    precedingMutation: Promise<void>,
    precedingReadActivations: readonly Promise<void>[],
    completion: Deferred,
    operation: () => Promise<T> | T,
  ): Promise<T> {
    try {
      await Promise.all([precedingMutation, ...precedingReadActivations]);
      this.#assertOpen();
      return await operation();
    } finally {
      completion.resolve();
    }
  }

  #assertOpen(): void {
    if (this.#poisoned) throw poisonedError();
  }
}

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function poisonedError(): Error {
  return new Error(POISONED_MESSAGE);
}
