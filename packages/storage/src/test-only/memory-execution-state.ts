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

import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export type MemoryState = Map<string, Map<string, unknown>>;
export const copy = <T>(value: T): T => structuredClone(value);
export const key = (...parts: unknown[]): string => JSON.stringify(parts);
export const digest = (value: unknown): `sha256:${string}` =>
  `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
export const equal = isDeepStrictEqual;

/** Internal representation, never exposed as a Runtime persistence API. */
export function rows<T>(state: MemoryState, name: string): Map<string, T> {
  let table = state.get(name);
  if (!table) {
    table = new Map();
    state.set(name, table);
  }
  return table as Map<string, T>;
}

export interface MemoryExecutionFaults {
  /** Test diagnostics only; never changes the result or authorizes a fallback. */
  onFailure?(operation: string, error: unknown): void;
  /** Synchronous test-only hooks. Readers still see the old committed state here. */
  beforeCommit?(operation: string): void;
  /** Throwing here simulates a lost acknowledgement, not a rolled-back commit. */
  afterCommit?(operation: string): void;
}

/**
 * Deliberately independent, process-lifetime reference model. Copy-on-write and
 * one synchronous state replacement provide atomic visibility across domains.
 * This is not a production durable backend or a claim about process-loss safety.
 */
export class MemoryExecutionAuthority {
  state: MemoryState = new Map();
  readonly listeners = new Set<(sessionId: string) => void>();
  constructor(readonly faults: MemoryExecutionFaults = {}) {}
  read<T>(operation: (state: MemoryState) => T): T {
    try {
      return copy(operation(this.state));
    } catch (error) {
      this.faults.onFailure?.('read', error);
      throw error;
    }
  }
  write<T>(name: string, operation: (draft: MemoryState) => T): T {
    try {
      const draft = copy(this.state);
      const result = operation(draft);
      if (result instanceof Promise)
        throw new TypeError('Memory reference transactions must be synchronous');
      this.faults.beforeCommit?.(name);
      this.state = draft;
      this.faults.afterCommit?.(name);
      return copy(result);
    } catch (error) {
      this.faults.onFailure?.(name, error);
      throw error;
    }
  }
  notify(sessionId: string): void {
    for (const listener of this.listeners) listener(sessionId);
  }
}
