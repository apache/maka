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

// packages/runtime/src/filesystem-authority.ts
// The shared contract for who a filesystem mutation may touch and how its
// outcome is reported. Issue #2600 asks for this to live in one place, kept
// separate from the individual editing tools: the executor, the worker, and
// the workspace executor all import from here rather than each restating what
// "the target I approved" and "the outcome on disk" mean.
//
// This module is types and pure classification only — no I/O. The fd-pinned
// read-modify-write that enforces these contracts lives in file-stable-write.ts
// and is consumed by both the worker and the local workspace executor; the
// contract itself is what every backend agrees on.

import { FilesystemWorkerClientError } from './filesystem-worker/client.js';

/**
 * A stable identity for a filesystem target, captured the moment a mutation is
 * authorised. `dev` and `ino` are carried as opaque decimal strings rather
 * than bigint: bigint cannot cross the worker's JSON protocol boundary
 * (`JSON.stringify` throws on a BigInt), and identity is only ever compared
 * for equality, never used to build a path. Stringifying `stats.dev` /
 * `stats.ino` on the capturing side and comparing the strings on the checking
 * side is the whole round-trip.
 */
export interface FilesystemTargetIdentity {
  readonly dev: string;
  readonly ino: string;
}

/**
 * The full target descriptor captured at lock acquisition (the earliest point a
 * mutation commits to a path). Modelled as a discriminated union so that
 * "the target had no identity to compare" is an explicit `missing` case,
 * never an accidentally-absent optional field. A later "skip the identity
 * check" change cannot compile without handling the `missing` arm, which is
 * what closes the "no identity → CAS passes" regression class.
 *
 * - `missing`: the path did not exist at capture (a create, or a write to a
 *   brand-new file). There is no inode to pin; the missing→existing transition
 *   is detected by `O_EXCL` / `wx` instead.
 * - the other variants carry the captured inode, which the worker compares
 *   against the on-disk inode immediately before mutating.
 */
export type FilesystemTargetDescriptor =
  | { readonly enforcementPath: string; readonly targetType: 'missing' }
  | {
      readonly enforcementPath: string;
      readonly targetType: 'file' | 'directory' | 'symlink' | 'other';
      readonly identity: FilesystemTargetIdentity;
    };

/**
 * The outcome a mutation can report. Distinct from "did the tool call succeed"
 * — a tool that fails to apply is `rejected`; a tool that may have applied
 * before losing the ability to confirm is `unknown`. Only `applied` leaves the
 * file in a known state.
 */
export type FilesystemMutationOutcome = 'applied' | 'rejected' | 'unknown';

/**
 * Reasons that, when a *mutating* operation fails with them, mean the file's
 * state on disk is genuinely unknown. Each is semantically dispatched: the
 * launch-stage reasons are produced only after the child ran (timeout /
 * worker_crashed / response_overflow observe a real exit; worker_io_incomplete
 * is defined as "ran but the result was lost"), and the protocol-stage reasons
 * are produced while parsing the child's own response. So membership here is a
 * sufficient signal — `dispatched` is not re-checked for them. Only `aborted`
 * straddles the pre-flight and post-dispatch worlds, so it alone is gated on
 * the worker error's `dispatched` flag.
 *
 * Pre-flight failures (validation, transform, the bundle being unavailable, a
 * never-started spawn) are deliberately absent: nothing could have been
 * written there.
 */
export const UNKNOWN_OUTCOME_REASONS: ReadonlySet<FilesystemWorkerClientError['reason']> = new Set<
  FilesystemWorkerClientError['reason']
>([
  'timeout',
  'worker_io_incomplete',
  'response_overflow',
  'worker_crashed',
  'invalid_response',
  'response_id_mismatch',
  'response_kind_mismatch',
  'outcome_unknown',
]);

/**
 * Classify the outcome of a failed mutation. Returns `undefined` for errors
 * that are not a worker client failure (the caller lets those propagate) and
 * for worker failures that cannot have touched the disk (reads, pre-flight
 * validation, a never-dispatched spawn, a pre-dispatch abort). Returns
 * `'unknown'` when the worker had the request and may have applied it, so the
 * caller surfaces a ToolOutcomeUnknownError and the model re-reads instead of
 * assuming the call did nothing.
 */
export function classifyFailedMutationOutcome(
  error: unknown,
): FilesystemMutationOutcome | undefined {
  if (!(error instanceof FilesystemWorkerClientError)) return undefined;
  if (error.reason === 'aborted') return error.dispatched === true ? 'unknown' : undefined;
  return UNKNOWN_OUTCOME_REASONS.has(error.reason) ? 'unknown' : undefined;
}
