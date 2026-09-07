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
// The `(dev, ino)` execution contract captured after filesystem lease admission.
// Prepared operations retain only their canonical claim; the mutable identity is
// sampled after preceding conflicting owners have completed, immediately before
// the backend pins the object with a handle/CAS primitive.

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

/** The target a backend is authorised to use for one admitted effect. */
export interface AdmittedTargetContract {
  /** Backend-executable canonical path. Never reconstruct this from provider input. */
  readonly canonicalPath: string;
  readonly semantics: 'target' | 'entry';
  /** Identity sampled while the operation owns the matching filesystem lease. */
  readonly identity: TargetIdentity;
}

export interface ResolveIdentity {
  (input: { cwd: string; path: string; semantics: 'target' | 'entry' }): Promise<ResolvedTarget>;
}

/**
 * True when two execution-time observations name different objects. Backends
 * and tests use this for CAS/revalidation; prepare never stores an identity.
 */
export function identityChanged(a: TargetIdentity, b: TargetIdentity): boolean {
  if (a.kind === 'missing' || b.kind === 'missing') return a.kind !== b.kind;
  return a.dev !== b.dev || a.ino !== b.ino;
}
