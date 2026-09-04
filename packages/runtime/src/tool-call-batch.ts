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

import type { PreparedOperation } from './preparation/types.js';
import { ToolScheduler } from './tool-scheduler.js';

export interface ToolCallBatchEntry<Result> {
  readonly id: string;
  readonly signal?: AbortSignal;
  /**
   * The synthesis root's single entry point. It validates, canonicalises and
   * dispatches to the authority, returning a one-shot PreparedOperation. A
   * reject here is treated as an unclassified real effect and scheduled with
   * all claims. The caller still owns the fallback effect and settlement.
   */
  readonly prepare: () => Promise<PreparedOperation<unknown>>;
  /**
   * Execute the prepared operation. Receives `undefined` when preparation
   * failed, in which case the caller runs its normal effect under all claims.
   */
  readonly run: (operation: PreparedOperation<unknown> | undefined) => Promise<Result> | Result;
}

/**
 * Prepare every call behind one barrier, submit by original array index, and
 * return settled outcomes in that same order regardless of completion order.
 * Claims are produced by `prepare`. If preparation rejects but the caller will
 * still run a real effect, the fallback is all() so it cannot fail open.
 */
export async function settleToolCallBatch<Result>(
  entries: readonly ToolCallBatchEntry<Result>[],
): Promise<PromiseSettledResult<Result>[]> {
  const scheduler = new ToolScheduler();
  const slots = entries.map((entry, index) => ({ entry, sequence: index }));
  const prepared = await Promise.all(
    slots.map(async (slot) => {
      try {
        return { slot, operation: await slot.entry.prepare() };
      } catch {
        // A preparation failure does not prove the fallback effect is harmless.
        // Synthetic/no-effect calls return noneOperation() before reaching here.
        return { slot, operation: undefined };
      }
    }),
  );

  const resultSlots = prepared.map(({ slot, operation }) => {
    const runnable: PreparedOperation<unknown> = operation ?? {
      claims: [{ kind: 'all' }],
      execute: () => slot.entry.run(undefined) as Promise<Result>,
    };
    return scheduler.add({
      id: slot.entry.id,
      sequence: slot.sequence,
      operation: runnable,
      ...(slot.entry.signal ? { signal: slot.entry.signal } : {}),
      run: (candidate) => slot.entry.run(candidate === runnable ? operation : undefined),
    });
  });
  return await Promise.allSettled(resultSlots);
}
