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

/**
 * Multi-Host recall fan-out.
 *
 * Each Host recalls over its own corpus — its Session store, its fact store,
 * its privacy state — and this layer only merges the answers. That split is
 * why scoring stays inside the Host: BM25's idf is a property of one corpus,
 * so a score from Host A is not comparable to one from Host B and the merge
 * must not pretend otherwise.
 *
 * Merge rule: interleave. Taking each Host's best, then each Host's second,
 * and so on keeps a Host with a large corpus from filling the whole list, and
 * it is the one order that does not require comparing scores that are not
 * comparable. This is the same rule the thread-search fan-out used, kept
 * deliberately so the visible ordering does not shift for a single-Host user.
 *
 * A Host that fails or is unreachable contributes nothing rather than failing
 * the search: one machine being down must not hide the history on the others.
 */

// The envelope types live in the bridge contract, which the renderer already
// reaches: importing them from here would add this module to the preload
// closure the renderer architecture check prices, and that ledger only shrinks.
// Re-exported so callers and tests can keep importing them from one place.
import type {
  RecallSearchPassage,
  RecallSearchRequest,
  RecallSearchResult,
} from './bridge-contract.js';

export type { RecallSearchPassage, RecallSearchRequest, RecallSearchResult };

export interface RecallSearchError {
  readonly ok: false;
  readonly reason: string;
  readonly message: string;
}

interface RecallSearchHostResponse {
  readonly ok: true;
  readonly result: {
    readonly ok: true;
    readonly passages: readonly RecallSearchPassage[];
    readonly gaps: string;
    readonly searchedEverySession: boolean;
  };
}

export function createRecallSearchClient<Scope>(input: {
  scopes(): Promise<readonly Scope[]>;
  search(scope: Scope, request: RecallSearchRequest, requestId: string): Promise<unknown>;
  cancel(scope: Scope, requestId: string): Promise<unknown>;
}) {
  const pending = new Map<string, { cancel(): Promise<void> }>();
  return {
    async recall(
      request: RecallSearchRequest,
      requestId: string = crypto.randomUUID(),
    ): Promise<RecallSearchResult | RecallSearchError> {
      if (pending.has(requestId)) throw new Error('Search request is already active');
      let scopes: readonly Scope[] = [];
      let cancelled = false;
      let finishCancel!: (error: RecallSearchError) => void;
      const cancellation = new Promise<RecallSearchError>((resolve) => {
        finishCancel = resolve;
      });
      pending.set(requestId, {
        async cancel() {
          cancelled = true;
          finishCancel({ ok: false, reason: 'aborted', message: 'History search was aborted.' });
          await Promise.all(scopes.map((scope) => input.cancel(scope, requestId)));
        },
      });
      try {
        return await Promise.race([
          (async () => {
            scopes = await input.scopes();
            if (cancelled) return cancellation;
            return collectRecallResponses(
              await Promise.allSettled(
                scopes.map((scope) => input.search(scope, request, requestId)),
              ),
              request.limit ?? 10,
            );
          })(),
          cancellation,
        ]);
      } finally {
        pending.delete(requestId);
      }
    },
    async cancelRecall(requestId: string): Promise<void> {
      await pending.get(requestId)?.cancel();
    },
  };
}

/**
 * Interleave the Hosts' passages and stop at `limit`.
 *
 * The `gaps` string of the winning Host is reported only when there is one
 * Host; across several it would describe a corpus the user did not ask about
 * separately. `searchedEverySession` is false if any Host declined a full
 * scan, because the envelope as a whole then did not cover every Session.
 */
export function collectRecallResponses(
  settled: readonly PromiseSettledResult<unknown>[],
  limit: number,
): RecallSearchResult | RecallSearchError {
  const hosts: RecallSearchHostResponse['result'][] = [];
  const failures: RecallSearchError[] = [];
  for (const outcome of settled) {
    if (outcome.status !== 'fulfilled') continue;
    if (isSuccessfulHost(outcome.value)) {
      hosts.push(outcome.value.result);
      continue;
    }
    const failure = failureOf(outcome.value);
    if (failure) failures.push(failure);
  }
  if (hosts.length === 0) {
    return (
      failures[0] ?? {
        ok: false,
        reason: 'provider_error',
        message: 'No Runtime Host is available for search',
      }
    );
  }
  const passages: RecallSearchPassage[] = [];
  for (let index = 0; passages.length < limit; index += 1) {
    let appended = false;
    for (const host of hosts) {
      const passage = host.passages[index];
      if (!passage) continue;
      passages.push(passage);
      appended = true;
      if (passages.length === limit) break;
    }
    if (!appended) break;
  }
  const only = hosts.length === 1 ? hosts[0]! : undefined;
  return {
    passages,
    gaps: only?.gaps ?? '',
    searchedEverySession: only
      ? only.searchedEverySession
      : hosts.every((host) => host.searchedEverySession),
  };
}

function isSuccessfulHost(value: unknown): value is RecallSearchHostResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { ok?: unknown }).ok === true &&
    typeof (value as { result?: unknown }).result === 'object' &&
    (value as { result: { ok?: unknown } }).result !== null &&
    (value as { result: { ok?: unknown } }).result.ok === true &&
    Array.isArray((value as { result: { passages?: unknown } }).result.passages)
  );
}

function failureOf(value: unknown): RecallSearchError | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as { ok?: unknown; reason?: unknown; message?: unknown };
  if (record.ok !== false) return undefined;
  if (typeof record.reason !== 'string') return undefined;
  return {
    ok: false,
    reason: record.reason,
    message: typeof record.message === 'string' ? record.message : 'Search failed.',
  };
}
