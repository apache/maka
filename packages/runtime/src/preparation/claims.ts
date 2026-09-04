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

// packages/runtime/src/preparation/claims.ts
// Domain-agnostic conflict predicate over `ResourceClaim`. This is the ONLY
// comparison the Scheduler performs — it compares canonical keys, never
// resolves an identity. Two operations conflict iff they would touch the same
// canonical resource in a way that requires ordering.

import type { KeyedResourceClaim, ResourceClaim } from './types.js';

/**
 * True when any claim on the left conflicts with any claim on the right. This
 * is the pure function the Scheduler uses to derive the partial order.
 */
export function claimsConflict(
  left: readonly ResourceClaim[],
  right: readonly ResourceClaim[],
): boolean {
  return left.some((a) => right.some((b) => resourceClaimsConflict(a, b)));
}

export function resourceClaimsConflict(a: ResourceClaim, b: ResourceClaim): boolean {
  // Batch-local description only: the corresponding PreparedOperation acquires
  // the real process-wide exclusive barrier against participating authorities.
  if (a.kind === 'all' || b.kind === 'all') return true;

  // Coarse claims only interact with another coarse claim on the same key.
  // (Cross-coarse↔keyed interaction is intentionally left as a future
  // extension point: no tool in this batch emits `coarse`.)
  if (a.kind === 'coarse' || b.kind === 'coarse') {
    return a.kind === 'coarse' && b.kind === 'coarse' && a.key === b.key;
  }

  if (a.kind !== b.kind) return false;

  if (a.kind === 'keyed' && b.kind === 'keyed') return keyedClaimsConflict(a, b);

  // Capacity is a permit pool, not a mutex. Per Option B §7.1 it must NOT be
  // folded into the conflict graph — that would turn backpressure into
  // serialization. Shared pools are enforced by an independent semaphore.
  if (a.kind === 'capacity' && b.kind === 'capacity') return false;

  return false;
}

function keyedClaimsConflict(a: KeyedResourceClaim, b: KeyedResourceClaim): boolean {
  if (a.authority !== b.authority) return false;
  // Two reads never conflict, whether they are exact or tree-scoped.
  const aWrites = a.mode === 'write' || a.mode === 'exclusive';
  const bWrites = b.mode === 'write' || b.mode === 'exclusive';
  if (!aWrites && !bWrites) return false;
  return keyedKeysOverlap(a, b);
}

function keyedKeysOverlap(a: KeyedResourceClaim, b: KeyedResourceClaim): boolean {
  return scopedKeysOverlap(a.key, a.scope ?? 'exact', b.key, b.scope ?? 'exact');
}

export function scopedKeysOverlap(
  aKey: string,
  aScope: 'exact' | 'tree',
  bKey: string,
  bScope: 'exact' | 'tree',
): boolean {
  if (aKey === bKey) return true;
  if (aScope === 'tree' && containsPath(aKey, bKey)) return true;
  if (bScope === 'tree' && containsPath(bKey, aKey)) return true;
  return false;
}

export function containsPath(parent: string, candidate: string): boolean {
  if (parent === candidate) return true;
  if (parent.length === 0 || !candidate.startsWith(parent)) return false;
  // Claim keys are canonical strings produced by their authority. Filesystem
  // authorities retain the host separator, so a domain-agnostic Scheduler must
  // recognise both POSIX and Windows boundaries without rewriting the lock key.
  if (parent.endsWith('/') || parent.endsWith('\\')) return true;
  const boundary = candidate[parent.length];
  return boundary === '/' || boundary === '\\';
}
