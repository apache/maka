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

// packages/runtime/src/preparation/types.ts
// The PreparedOperation vocabulary shared by the process-level synthesis root,
// the per-batch Scheduler, and each domain ResourceAuthority.
//
// A `ResourceClaim` is a *description* used only for ordering and tracing. It is
// never a lease, never an execution permission, and never a lock. The resource
// correctness (mutual exclusion, CAS, atomicity, legal state transitions) lives
// inside each domain Authority's `PreparedOperation.execute`.

import type { ExecutionBoundary } from '@maka/core/sandbox-boundary';
import type { PermissionMode } from '@maka/core/permission';

export type KeyedClaimMode = 'read' | 'write' | 'exclusive';

/**
 * How a keyed claim is scoped. `exact` addresses one canonical key; `tree`
 * addresses every key under the canonical root (a recursive read or a big-
 * grained exclusive), which is how `Grep(src)` conflicts with `Write(src/a.ts)`
 * without the Scheduler needing to know it is a tree scan.
 */
export type KeyedClaimScope = 'exact' | 'tree';

/**
 * A claim on one canonical coordination key (platform-normalized filesystem
 * lease key, session id, ...). `key` is exactly the string the authority's
 * `PreparedOperation.execute` uses for admission.
 */
export interface KeyedResourceClaim {
  readonly kind: 'keyed';
  /** Domain namespace, e.g. 'filesystem:workspace-1' | 'session-todo'. */
  readonly authority: string;
  /** Canonical coordination identity. It need not be a backend-executable path. */
  readonly key: string;
  readonly mode: KeyedClaimMode;
  readonly scope?: KeyedClaimScope;
}

/**
 * A capacity (permit-pool) claim. Per the Option B plan these are advisory:
 * they signal backpressure, not mutual exclusion, and must NOT be folded into
 * the Scheduler's conflict graph (which would turn "bounded concurrency" into
 * "serialize every subagent spawn").
 */
export interface CapacityResourceClaim {
  readonly kind: 'capacity';
  readonly authority: string;
  readonly key: string;
  readonly permits: number;
}

/**
 * A coarse-grained claim scoped to a workspace/provider. Used to avoid
 * head-of-line blocking when a coarse tool (e.g. a shell command) must not
 * freeze unrelated domains.
 */
export interface CoarseResourceClaim {
  readonly kind: 'coarse';
  readonly authority: string;
  readonly key: string;
}

/** Placeholder `all()`: conflicts with everything. Fail-closed fallback only. */
export interface AllResourceClaim {
  readonly kind: 'all';
}

export type ResourceClaim =
  | KeyedResourceClaim
  | CapacityResourceClaim
  | CoarseResourceClaim
  | AllResourceClaim;

/** Live ToolRuntime identity that only exists after the durable T1 cut. */
export interface PreparedOperationExecutionContext {
  readonly operationId?: string;
}

/**
 * A one-shot executable unit produced by a domain Authority. `claims` feed the
 * Scheduler and tracing; `execute` is the single physical entry point that
 * acquires the correctness primitives, re-validates state, runs the effect, and
 * releases in `finally`. Repeated calls must be rejected.
 */
export interface PreparedOperation<Result> {
  readonly claims: readonly ResourceClaim[];
  /**
   * `fallbackEffect` is supplied at the ToolRuntime execute boundary. Domain
   * authorities that own their effect ignore it; placeholder authorities use
   * it to invoke the original tool implementation with the complete live
   * ToolRuntime context.
   */
  execute(
    signal?: AbortSignal,
    fallbackEffect?: () => Promise<Result>,
    executionContext?: PreparedOperationExecutionContext,
  ): Promise<Result>;
}

/**
 * Context handed to a domain Authority's `prepare`. It carries the canonical
 * call context plus an optional `effect` for placeholder authorities that do
 * not own an effect of their own (they invoke `context.effect` — the tool's
 * real `impl`).
 */
export interface AuthorityContext {
  readonly sessionId: string;
  readonly runId?: string;
  readonly turnId: string;
  readonly cwd: string;
  readonly executionBoundary?: ExecutionBoundary;
  readonly permissionMode?: PermissionMode;
  readonly toolCallId: string;
  readonly abortSignal?: AbortSignal;
  readonly effect?: (signal?: AbortSignal) => Promise<unknown>;
}

/**
 * A domain Authority owns the correctness of one class of real resource. It
 * receives a validated, deep-frozen, canonicalised input snapshot and computes
 * the canonical identity, produces claims, and returns a `PreparedOperation`.
 */
export interface ResourceAuthority<Input, Result> {
  prepare(input: Readonly<Input>, context: AuthorityContext): Promise<PreparedOperation<Result>>;
}
