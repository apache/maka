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

// packages/runtime/src/preparation/target-identity.ts
// The `(dev, ino)` snapshot contract shared between the filesystem Authority's
// `prepare` (capture at T0) and `PreparedOperation.execute` (re-check at run
// time). This is the coarse pre-guard against "the target was replaced while the
// call waited for the lock". It is NOT a replacement for the fd-pinned
// read-modify-write in file-stable-write.ts, which catches in-place content
// changes that leave the inode unchanged.

export type TargetIdentity =
  | { readonly kind: 'file'; readonly dev: string; readonly ino: string }
  | { readonly kind: 'entry'; readonly dev: string; readonly ino: string }
  | { readonly kind: 'missing' };

export interface ResolvedTarget {
  /** Backend-executable canonical path. */
  readonly canonicalPath: string;
  /** Platform-normalized Scheduler/coordinator key. Never send to a backend. */
  readonly leaseKey: string;
  readonly identity: TargetIdentity;
}

export interface ResolveIdentity {
  (input: { cwd: string; path: string; semantics: 'target' | 'entry' }): Promise<ResolvedTarget>;
}

/**
 * True when the identity captured at prepare-time no longer matches the state
 * observed at execute-time. `missing` is only stable when both sides are
 * `missing` (a create target that is still absent).
 */
export function identityChanged(a: TargetIdentity, b: TargetIdentity): boolean {
  if (a.kind === 'missing' || b.kind === 'missing') return a.kind !== b.kind;
  return a.dev !== b.dev || a.ino !== b.ino;
}
