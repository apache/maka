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
 * The outcome a mutation can report. Distinct from "did the tool call succeed"
 * — a tool that fails to apply is `rejected`; a tool that may have applied
 * before losing the ability to confirm is `unknown`. Only `applied` leaves the
 * file in a known state.
 */
export type FilesystemMutationOutcome = 'applied' | 'rejected' | 'unknown';
