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
  normalizeToolAccesses,
  ToolAccesses,
  type NormalizeToolAccessOptions,
  type ToolAccesses as ToolAccessSet,
} from './tool-access.js';
import { ToolScheduler } from './tool-scheduler.js';

export interface ToolCallBatchEntry<Result> {
  readonly id: string;
  readonly signal?: AbortSignal;
  /** Omission is fail-closed and becomes ToolAccesses.all(). */
  readonly resolveAccesses?: () => Promise<ToolAccessSet | undefined> | ToolAccessSet | undefined;
  readonly run: () => Promise<Result> | Result;
}

/**
 * Prepare every call behind one barrier, submit by original array index, and
 * return settled outcomes in that same order regardless of completion order.
 */
export async function settleToolCallBatch<Result>(
  entries: readonly ToolCallBatchEntry<Result>[],
  normalizeOptions: NormalizeToolAccessOptions = {},
): Promise<PromiseSettledResult<Result>[]> {
  const slots = entries.map((entry, index) => ({ entry, index, sequence: index }));
  const prepared = await Promise.all(
    slots.map(async (slot) => ({
      ...slot,
      accesses: await resolveEntryAccesses(slot.entry, normalizeOptions),
    })),
  );

  const scheduler = new ToolScheduler();
  const resultSlots = prepared.map(({ entry, sequence, accesses }) =>
    scheduler.add({
      id: entry.id,
      sequence,
      accesses,
      ...(entry.signal ? { signal: entry.signal } : {}),
      run: entry.run,
    }),
  );
  return await Promise.allSettled(resultSlots);
}

async function resolveEntryAccesses<Result>(
  entry: ToolCallBatchEntry<Result>,
  options: NormalizeToolAccessOptions,
): Promise<ToolAccessSet> {
  if (!entry.resolveAccesses) return ToolAccesses.all();
  try {
    const declared = await resolveAccessesUntilAbort(entry);
    return normalizeToolAccesses(declared ?? ToolAccesses.all(), options);
  } catch {
    // Access planning is a concurrency optimization and must never widen the
    // set of operations allowed by ToolRuntime. A bad declaration therefore
    // fails closed to global serialization while Runtime still owns the actual
    // validation and model-visible error.
    return ToolAccesses.all();
  }
}

function resolveAccessesUntilAbort<Result>(
  entry: ToolCallBatchEntry<Result>,
): Promise<ToolAccessSet | undefined> {
  const planning = Promise.resolve().then(() => entry.resolveAccesses?.());
  if (!entry.signal) return planning;
  if (entry.signal.aborted) return Promise.reject(abortReason(entry.signal, entry.id));

  return new Promise<ToolAccessSet | undefined>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortReason(entry.signal!, entry.id));
    };
    const cleanup = () => entry.signal?.removeEventListener('abort', onAbort);
    entry.signal!.addEventListener('abort', onAbort, { once: true });
    planning.then(
      (accesses) => {
        cleanup();
        resolve(accesses);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
    if (entry.signal!.aborted) onAbort();
  });
}

function abortReason(signal: AbortSignal, entryId: string): unknown {
  if (signal.reason !== undefined) return signal.reason;
  return Object.assign(new Error(`Tool call ${entryId} was cancelled during access planning`), {
    name: 'AbortError',
  });
}
