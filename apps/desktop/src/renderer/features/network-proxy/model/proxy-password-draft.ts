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

export interface ProxyPasswordDraft {
  readonly value: string;
  readonly pending: boolean;
  edit(value: string): void;
  commit(): Promise<void>;
  cancel(): void;
  subscribe(listener: () => void): () => void;
}

export async function runAfterProxyPasswordCommit<T>(
  draft: Pick<ProxyPasswordDraft, "commit">,
  operation: () => Promise<T>,
): Promise<T> {
  await draft.commit();
  return operation();
}

interface ActiveSave {
  readonly secret: string;
  readonly promise: Promise<void>;
}

/** Owns the write-only password draft and hides save de-duplication from UI callers. */
export function createProxyPasswordDraft(
  save: (secret: string) => Promise<void>,
): ProxyPasswordDraft {
  let value = "";
  let active: ActiveSave | undefined;
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const listener of listeners) listener();
  }

  function commit(): Promise<void> {
    if (active) {
      if (!value || value === active.secret) return active.promise;
      return active.promise.then(() => commit());
    }
    if (!value) return Promise.resolve();

    const secret = value;
    let write: Promise<void>;
    try {
      write = save(secret);
    } catch (error) {
      write = Promise.reject(error);
    }
    const promise = write
      .then(() => {
        if (value === secret) value = "";
      })
      .finally(() => {
        if (active?.promise === promise) active = undefined;
        notify();
      });
    active = { secret, promise };
    notify();
    return promise;
  }

  return {
    get value() {
      return value;
    },
    get pending() {
      return active !== undefined;
    },
    edit(next) {
      if (next === value) return;
      value = next;
      notify();
    },
    commit,
    cancel() {
      const next = active?.secret ?? "";
      if (next === value) return;
      value = next;
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
