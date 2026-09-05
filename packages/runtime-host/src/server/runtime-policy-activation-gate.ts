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
