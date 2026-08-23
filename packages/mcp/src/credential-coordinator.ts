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

// packages/mcp/src/credential-coordinator.ts
//
// The single owner of MCP OAuth credential state transitions. Every read,
// write and delete for a server's stored record flows through one
// per-server lane here, every record write carries a monotonically
// increasing version validated against the basis that was read, and every
// terminal erase advances a PERSISTED per-server generation — a tombstone
// that outlives the process. Together these make a complete OAuth state
// transition atomic — not merely each storage call — and make revocation
// terminal in every interleaving, including across processes:
//
// - a flow that began before a logout may finish its reads, but its writes
//   are refused: in-process by the epoch, cross-process by the generation
//   it captured on its first read no longer matching the tombstone's;
// - a write that began before the logout completes first — the queued
//   erase lands after it (lane order);
// - a stale flow cannot delete a record a newer flow just stored (epoch
//   check on delete);
// - an external writer (another process editing the backing store) trips
//   the version/CAS check instead of being silently overwritten, when the
//   storage backend exposes compare-and-set;
// - deletion never leaves "absent" behind: erase writes a tombstone record
//   carrying only the advanced generation, so a cross-process flow cannot
//   CAS against absence (`expectedVersion = null`) and resurrect
//   credentials the user revoked.

import type { McpOAuthRecord, McpOAuthStorage } from './oauth.js';

/** Guards one flow's writes: the epoch pins in-process revocation, the
 * captured generation pins cross-process revocation, and the optional
 * abort signal fences writes landing after the flow's round was abandoned
 * (a timed-out login must not overwrite a newer round's state). */
interface FlowGuard {
  epoch: number;
  generation?: number;
  /** The record version this flow last observed or produced. A write whose
   * basis carries a DIFFERENT version means another writer (a concurrent
   * refresh in this or another process) rotated the record mid-flow: the
   * stale flow must not overwrite — or delete — the fresh material. */
  version?: number;
  signal?: AbortSignal;
}

export class McpCredentialCoordinator {
  private readonly epochs = new Map<string, number>();
  private readonly lanes = new Map<string, Promise<unknown>>();

  constructor(private readonly storage: McpOAuthStorage) {}

  /** Serializes an operation into the server's credential lane. */
  run<T>(serverId: string, op: () => Promise<T>): Promise<T> {
    const previous = this.lanes.get(serverId) ?? Promise.resolve();
    const next = previous.then(op, op);
    this.lanes.set(
      serverId,
      next.then(
        () => {},
        () => {},
      ),
    );
    return next;
  }

  epoch(serverId: string): number {
    return this.epochs.get(serverId) ?? 0;
  }

  /** Terminal erase: bumps the in-process epoch first (in-flight flows in
   * this process become stale immediately), then — inside the lane, behind
   * any write already in progress — replaces the record with a tombstone
   * whose generation is advanced by one. The tombstone is what makes the
   * revocation terminal for OTHER processes: their flows captured the old
   * generation and every later write verifies it against the stored one.
   * A failure propagates — callers must not proceed as if the credentials
   * were gone.
   *
   * The optional signal fences an ABANDONED erase: a logout whose round
   * timed out must not resume later, adopt whatever record a newer login
   * just stored as its basis, and tombstone the fresh tokens. */
  async erase(serverId: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    this.epochs.set(serverId, this.epoch(serverId) + 1);
    await this.run(serverId, async () => {
      this.assertNotAbandoned(serverId, options.signal);
      const basis = await this.storage.get(serverId);
      // Re-check after the read: the abandonment may have landed while the
      // storage read was in flight — committing past it would erase a
      // record the caller no longer owns.
      this.assertNotAbandoned(serverId, options.signal);
      // Absence still gets a tombstone: a cross-process flow that captured
      // generation 0 on absence must not CAS its credentials back in after
      // this revocation.
      const tombstone: McpOAuthRecord = {
        generation: (basis?.generation ?? 0) + 1,
        version: (basis?.version ?? 0) + 1,
      };
      await this.commit(serverId, basis, tombstone);
    });
  }

  private assertNotAbandoned(serverId: string, signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new Error(`MCP credential erase for "${serverId}" was abandoned before it landed`);
    }
  }

  /** One atomic state transition pinned to the flow guard: read the
   * current record, verify the guard (epoch, captured generation, abort),
   * apply, stamp the next version, and write — all inside the lane, with
   * the version validated against the read basis (and, when the backend
   * supports compare-and-set, against the stored bytes). */
  transition(
    serverId: string,
    guard: FlowGuard,
    apply: (record: McpOAuthRecord) => McpOAuthRecord,
  ): Promise<McpOAuthRecord> {
    return this.run(serverId, async () => {
      this.assertGuard(serverId, guard);
      const basis = await this.storage.get(serverId);
      // Re-check after the read: the abort (or a logout) may have landed
      // while the storage read was in flight, and committing past it would
      // persist a verifier or token for an abandoned round.
      this.assertGuard(serverId, guard);
      const basisGeneration = basis?.generation ?? 0;
      if (guard.generation !== undefined && basisGeneration !== guard.generation) {
        throw new Error(`MCP credentials for "${serverId}" were revoked during the operation`);
      }
      if (guard.version !== undefined && (basis?.version ?? 0) !== guard.version) {
        throw new Error(
          `MCP credentials for "${serverId}" were rotated by another writer during the operation`,
        );
      }
      const record = apply(basis ? { ...basis } : {});
      // The generation is the coordinator's own bookkeeping: flows never
      // set it, and a write never advances it — only erase() does.
      record.generation = basisGeneration;
      record.version = (basis?.version ?? 0) + 1;
      await this.commit(serverId, basis, record);
      return record;
    });
  }

  /** A storage view for one auth flow, pinned to the epoch at flow start
   * and to the persisted generation observed on the flow's first access.
   * The SDK-facing provider talks to this; every operation lands in the
   * lane, and writes/deletes are refused once the epoch or generation
   * moved — or once the flow's round was aborted. */
  flowStorage(serverId: string, options: { signal?: AbortSignal } = {}): McpOAuthStorage {
    const guard: FlowGuard = { epoch: this.epoch(serverId), ...options };
    const capture = (record: McpOAuthRecord | undefined) => {
      guard.generation ??= record?.generation ?? 0;
      guard.version ??= record?.version ?? 0;
    };
    // The flow's own writes advance its version fence; anyone ELSE's write
    // in between leaves the fence behind the stored version and the next
    // transition refuses instead of overwriting the rotation.
    const advance = (record: McpOAuthRecord) => {
      guard.version = record.version ?? guard.version;
      return record;
    };
    return {
      get: (id) =>
        this.run(serverId, async () => {
          const record = await this.storage.get(id);
          capture(record);
          return record;
        }),
      set: (id, record) =>
        this.transition(id, guard, (basis) => {
          capture(basis);
          return { ...record };
        })
          .then(advance)
          .then(() => {}),
      update: (id, apply) =>
        this.transition(id, guard, (basis) => {
          capture(basis);
          return apply(basis);
        }).then(advance),
      // An in-flow invalidation clears credential material but is NOT a
      // logout: the generation is preserved, not advanced, so the flow can
      // continue (e.g. re-register a client) without tripping its own guard.
      delete: (id) =>
        this.transition(id, guard, (basis) => {
          capture(basis);
          return {};
        })
          .then(advance)
          .then(() => {}),
    };
  }

  /** A flow view whose persisted generation/version are pinned BEFORE the
   * caller performs any remote await. flowStorage alone captures them on
   * the first storage access, which may come after a remote probe — a
   * logout in another process during that window would let the flow adopt
   * the tombstone's generation as its own starting point and keep writing.
   * beginFlow closes the window with one lane-ordered read up front. */
  async beginFlow(
    serverId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<McpOAuthStorage> {
    const view = this.flowStorage(serverId, options);
    await view.get(serverId);
    return view;
  }

  /** Lane-ordered read outside any flow (status displays, pending lookups). */
  read(serverId: string): Promise<McpOAuthRecord | undefined> {
    return this.run(serverId, () => this.storage.get(serverId));
  }

  private assertGuard(serverId: string, guard: FlowGuard): void {
    if (guard.signal?.aborted) {
      throw new Error(`MCP authorization for "${serverId}" was abandoned before the write landed`);
    }
    if (this.epoch(serverId) !== guard.epoch) {
      throw new Error(`MCP credentials for "${serverId}" were cleared during the operation`);
    }
  }

  private async commit(
    serverId: string,
    basis: McpOAuthRecord | undefined,
    record: McpOAuthRecord,
  ): Promise<void> {
    if (this.storage.compareAndSet) {
      const result = await this.storage.compareAndSet(serverId, basis?.version ?? null, record);
      if (result !== 'committed') {
        // Someone outside this coordinator changed the backing store
        // between our read and write. Fail closed rather than clobber.
        throw new Error(
          `MCP credentials for "${serverId}" changed outside the coordinator (${result})`,
        );
      }
      return;
    }
    await this.storage.set(serverId, record);
  }
}
