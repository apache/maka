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

import { randomUUID } from 'node:crypto';
import {
  decodeEventWaitRecord,
  EVENT_WAIT_LIMITS,
  type EventWaitRecord,
  type EventWaitObservation,
} from '@maka/core/event-wait';
import {
  authenticateInteractiveEventWaitAuthorityWriter,
  EVENT_WAIT_OBSERVATION_HINT_LIMIT,
  EVENT_WAIT_PAGE_LIMIT,
  eventWaitSourceKey,
  type ExtendEventWaitSourceCooldownInput,
  type InteractiveEventWaitAuthorityWriter,
  type EventWaitSnapshot,
  type ReadEventWaitInput,
} from '@maka/storage/event-wait-authority';
import { StorageRootAuthorityError } from '@maka/storage/root-authority';
import {
  EventWaitAdapterRegistry,
  type EventWaitObservationAccess,
  type EventWaitObservationResult,
  type EventWaitSourceAdapter,
  type EventWaitSubscription,
} from './event-wait-adapter.js';

export interface EventWaitClock {
  now(): number;
  schedule(callback: () => void, delayMs: number): () => void;
}
const systemClock: EventWaitClock = {
  now: Date.now,
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, Math.min(delayMs, 2_147_483_647));
    timer.unref();
    return () => clearTimeout(timer);
  },
};

export interface EventWaitObservationPolicy {
  readonly scanIntervalMs: number;
  readonly pageSize: number;
  readonly minIntervalMs: number;
  readonly pollIntervalMs: number;
  /** Caps local error backoff before jitter, not a source's Retry-After. */
  readonly maxBackoffMs: number;
  readonly readTimeoutMs: number;
  readonly closeTimeoutMs: number;
  /** Total observation budget, including healthy pending reads; exhaustion ends the wait. */
  readonly maxAttempts: number;
  /** Independent lifetime ceiling, not a guarantee that the attempt budget lasts this long. */
  readonly maxLifetimeMs: number;
  readonly maxConcurrent: number;
  readonly maxPerSource: number;
  readonly maxSubscriptions: number;
  /** Bounds the cache; unpersisted source facts reaching this threshold pause new observations. */
  readonly maxSourceCooldowns: number;
  readonly jitterRatio: number;
}
/**
 * For a promptly responding source that stays pending, ordinary 15–18 second polling
 * (including jitter) exhausts 10,000 attempts in roughly 42–50 hours. Exhaustion resolves
 * the wait as source_unavailable with reason observation_budget_exhausted.
 * This estimate excludes scheduling/I/O delays and shared-source contention or throttling;
 * notification-triggered reads can exhaust the budget sooner. The seven-day lifetime is
 * an independent ceiling, not a guarantee of seven days of observation.
 */
export const DEFAULT_EVENT_WAIT_OBSERVATION_POLICY: EventWaitObservationPolicy = Object.freeze({
  scanIntervalMs: 1_000,
  pageSize: 64,
  minIntervalMs: 1_000,
  pollIntervalMs: 15_000,
  maxBackoffMs: 300_000,
  readTimeoutMs: 30_000,
  closeTimeoutMs: 5_000,
  maxAttempts: 10_000,
  maxLifetimeMs: 7 * 24 * 60 * 60_000,
  maxConcurrent: 8,
  maxPerSource: 1,
  maxSubscriptions: 128,
  maxSourceCooldowns: 1024,
  jitterRatio: 0.2,
});
export interface HostEventWaitManagerOptions {
  readonly store: InteractiveEventWaitAuthorityWriter;
  readonly adapters: EventWaitAdapterRegistry;
  /** Trusted composition must check current Session/Goal identity and source access. */
  readonly authorize: (
    wait: EventWaitRecord,
    signal: AbortSignal,
  ) => Promise<EventWaitObservationAccess>;
  readonly clock?: EventWaitClock;
  readonly random?: () => number;
  readonly policy?: Partial<EventWaitObservationPolicy>;
  /** Diagnostics only. No result-delivery or execution-admission callback exists here. */
  readonly onError: (error: unknown) => void;
}
type Flight = {
  readonly controller: AbortController;
  readonly source: string;
  readonly sessionId: string;
  readonly waitId: string;
  claimed: boolean;
  cooldownUntil: number;
  /** Source Retry-After also gates authorization; read spacing and reservations do not. */
  retryAfterUntil: number;
  task: Promise<void>;
};
type Subscription = {
  readonly identity: ReadEventWaitInput;
  readonly controller: AbortController;
  handle?: EventWaitSubscription;
  dirty: boolean;
  isPending?: () => boolean;
};
type DispatchPreparation = {
  readonly waiters: Set<() => void>;
};
class ObservationTimeout extends Error {
  constructor(
    message: string,
    readonly isPending: () => boolean = () => false,
  ) {
    super(message);
  }
}
class SourceCooldownWriteError extends Error {
  constructor(cause: unknown) {
    super('Unable to persist event wait source cooldown', { cause });
  }
}
const identity = (r: EventWaitRecord): ReadEventWaitInput => ({
  sessionId: r.sessionId,
  waitId: r.waitId,
});
const sourceKey = (r: EventWaitRecord): string =>
  JSON.stringify([r.resource.providerId, r.resource.connectionId]);
const addTime = (now: number, delay: number): number =>
  Math.min(Number.MAX_SAFE_INTEGER, now + delay);

/**
 * Internal, explicitly composed observation service. PR2 has no production adapters or tool
 * registration. Durable records are the only authority; timers and subscriptions are hints.
 * Ready candidates normally use durable observation age. Failed preparations get a bounded
 * traversal by immutable ID, so neither failed writes nor cache capacity can pin selection.
 */
export class HostEventWaitManager {
  readonly #store: InteractiveEventWaitAuthorityWriter;
  readonly #options: HostEventWaitManagerOptions;
  readonly #clock: EventWaitClock;
  readonly #policy: EventWaitObservationPolicy;
  readonly #flights = new Map<string, Flight>();
  /** Registration/delivery authorization shares observation capacity and source facts. */
  readonly #accessFlights = new Set<Flight>();
  readonly #subscriptions = new Map<string, Subscription>();
  readonly #cooldowns = new Map<string, number>();
  /** Dispatch preparation is serialized per source, independently of in-flight reads. */
  readonly #dispatching = new Map<string, DispatchPreparation>();
  /** Failed source writes retain their absolute deadline independently of wait cleanup. */
  readonly #pendingCooldowns = new Map<string, ExtendEventWaitSourceCooldownInput>();
  /** Interrupted calls retain their owning flight's capacity through late-fact processing. */
  readonly #lingering = new Map<Promise<unknown>, Flight>();
  /** Source facts returned after interruption may still be writing their shared cooldown. */
  readonly #lateResults = new Set<Promise<void>>();
  #expiryCursor: string | undefined;
  /** A failed write cannot advance durable observation age. Recover with an O(1) ID cursor. */
  #observationScan: { readonly afterWaitId?: string } | undefined;
  #timer: (() => void) | undefined;
  #scan: Promise<void> | undefined;
  #start: Promise<void> | undefined;
  #close: Promise<void> | undefined;
  #closed = false;
  #ready = false;

  constructor(options: HostEventWaitManagerOptions) {
    this.#store = authenticateInteractiveEventWaitAuthorityWriter(options.store);
    this.#options = options;
    this.#clock = options.clock ?? systemClock;
    this.#policy = { ...DEFAULT_EVENT_WAIT_OBSERVATION_POLICY, ...options.policy };
    for (const [name, value] of Object.entries(this.#policy)) {
      if (name === 'jitterRatio') {
        if (!Number.isFinite(value) || value < 0 || value > 1)
          throw new TypeError('Invalid wait jitter');
      } else if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647)
        throw new TypeError(`Invalid wait policy: ${name}`);
    }
    if (
      this.#policy.pageSize > EVENT_WAIT_PAGE_LIMIT ||
      this.#policy.maxAttempts > EVENT_WAIT_LIMITS.observationAttempts ||
      this.#policy.minIntervalMs > this.#policy.pollIntervalMs ||
      this.#policy.pollIntervalMs > this.#policy.maxBackoffMs ||
      this.#policy.maxPerSource > this.#policy.maxConcurrent ||
      2 * (this.#policy.maxConcurrent + this.#policy.maxSourceCooldowns) +
        this.#policy.maxSubscriptions +
        this.#policy.pageSize >
        EVENT_WAIT_OBSERVATION_HINT_LIMIT
    )
      throw new TypeError('Inconsistent event wait policy');
  }

  /** Validates the supported template only; PR3 owns registration authorization and yield. */
  validate(wait: EventWaitRecord): void {
    const record = decodeEventWaitRecord(wait);
    if (record.deadlineAt - record.createdAt > this.#policy.maxLifetimeMs)
      throw new TypeError('Event wait exceeds maximum lifetime');
    this.#options.adapters.validate(record);
  }

  /** Bounded source access outside observation; no wait attempt or work Turn is charged. */
  async checkSourceAccess(
    wait: EventWaitRecord,
    parent: AbortSignal,
    authorize: HostEventWaitManagerOptions['authorize'],
  ): Promise<EventWaitObservationAccess> {
    const unknown = { kind: 'unknown' as const, reason: 'authorization_unavailable' };
    const source = sourceKey(wait);
    const occupied = this.#occupiedFlights();
    if (
      this.#closed ||
      parent.aborted ||
      this.#pendingCooldowns.size >= this.#policy.maxSourceCooldowns ||
      this.#sourceCooldown(source) > this.#clock.now() ||
      occupied.size >= this.#policy.maxConcurrent ||
      [...occupied].filter((f) => f.source === source).length >= this.#policy.maxPerSource
    )
      return unknown;
    const flight: Flight = {
      controller: new AbortController(),
      source,
      sessionId: wait.sessionId,
      waitId: wait.waitId,
      claimed: false,
      cooldownUntil: 0,
      retryAfterUntil: 0,
      task: Promise.resolve(),
    };
    this.#accessFlights.add(flight);
    const abort = () => flight.controller.abort();
    parent.addEventListener('abort', abort, { once: true });
    const task = (async () => {
      const cooldown = await this.#store.readSourceCooldown({
        providerId: wait.resource.providerId,
        connectionId: wait.resource.connectionId,
      });
      if (
        this.#closed ||
        flight.controller.signal.aborted ||
        Math.max(cooldown ?? 0, this.#sourceCooldown(source)) > this.#clock.now()
      )
        return unknown;
      try {
        // Expired waits still need delivery authorization, so the source deadline
        // does not bound this separate request. #call retains the request timeout.
        return (
          (await this.#tryAuthorize(wait, flight, Number.MAX_SAFE_INTEGER, authorize))?.access ??
          unknown
        );
      } catch (error) {
        if (error instanceof SourceCooldownWriteError || error instanceof StorageRootAuthorityError)
          throw error;
        return unknown;
      }
    })();
    flight.task = task.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await task;
    } finally {
      parent.removeEventListener('abort', abort);
      this.#accessFlights.delete(flight);
      // #call retains interrupted requests in #lingering until late facts settle.
    }
  }

  start(): Promise<void> {
    if (this.#closed) return Promise.reject(new Error('Event wait manager is closed'));
    return (this.#start ??= this.#recover());
  }

  async #recover(): Promise<void> {
    // Every source read has a durable source reservation before dispatch. Recover it
    // on demand while scanning bounded pages; per-wait checkpoints retain their own backoff.
    if (this.#closed) return;
    this.#ready = true;
    await this.reconcile();
  }

  /** Also used by the future registration/control bridge; notifications never bypass limits. */
  reconcile(): Promise<void> {
    if (this.#closed || !this.#ready) return Promise.resolve();
    if (this.#scan) return this.#scan;
    this.#timer?.();
    this.#timer = undefined;
    const task = this.#scanPage();
    this.#scan = task;
    void task
      .finally(() => {
        this.#scan = undefined;
        this.#schedule();
      })
      .catch(() => undefined);
    return task;
  }

  #schedule(): void {
    if (this.#closed || this.#timer) return;
    this.#timer = this.#clock.schedule(() => {
      this.#timer = undefined;
      return this.reconcile().catch((e: unknown) => this.#report(e));
    }, this.#policy.scanIntervalMs);
  }

  #occupiedFlights(): Set<Flight> {
    // One observation owns one slot even while its interrupted request and checkpoint
    // persistence overlap. Keep that slot until both the flight and its late work retire.
    return new Set([
      ...this.#flights.values(),
      ...this.#accessFlights,
      ...this.#lingering.values(),
    ]);
  }

  async #scanPage(): Promise<void> {
    // Session cleanup can remove waits without calling cancel(). Include polling-only
    // flights and release invalid work before scheduling peers into bounded capacity.
    const active = new Map<string, ReadEventWaitInput>();
    const seenWaitIds = new Set<string>();
    for (const [waitId, subscription] of this.#subscriptions)
      active.set(waitId, subscription.identity);
    for (const [waitId, flight] of this.#flights)
      active.set(waitId, { waitId, sessionId: flight.sessionId });
    for (const input of active.values()) {
      if (this.#closed) return;
      try {
        const current = await this.#store.read(input);
        if (!current || current.record.status !== 'waiting') this.#stopObservation(input);
      } catch (error) {
        // An unreadable record does not authorize continued use of its cached state.
        // Stop only its work; a later authoritative selection can retry it normally.
        this.#stopObservation(input);
        seenWaitIds.add(input.waitId);
        this.#report(error);
      }
    }
    // Retry a bounded, rotating batch without reinterpreting source facts as read errors.
    for (const [key, input] of [...this.#pendingCooldowns].slice(0, this.#policy.pageSize)) {
      if (this.#closed) return;
      if (this.#pendingCooldowns.get(key) !== input) continue;
      this.#pendingCooldowns.delete(key);
      if (input.until <= this.#clock.now()) continue;
      this.#pendingCooldowns.set(key, input);
      try {
        await this.#writeSourceCooldown(input);
      } catch (error) {
        this.#report(error);
      }
    }
    if (this.#closed) return;
    // Expiry has its own monotonic scan; unavailable sources cannot hide deadlines.
    const page = await this.#store.listByStatus({
      status: 'waiting',
      limit: this.#policy.pageSize,
      ...(this.#expiryCursor ? { afterWaitId: this.#expiryCursor } : {}),
    });
    for (const snapshot of page.items) {
      if (this.#closed) return;
      if (this.#clock.now() >= snapshot.record.deadlineAt) {
        try {
          await this.#expire(snapshot);
        } catch (error) {
          // A record-local failure must not pin the cursor or hide other deadlines.
          // Keep the durable record for a later pass; never manufacture an expiry.
          this.#report(error);
        }
      }
    }
    this.#expiryCursor = page.nextCursor ?? undefined;
    // Pending cooldown saturation pauses new observations globally until a write
    // succeeds or its absolute cooldown expires. Expiry and persistence retries above
    // continue, preserving source limits without admitting unbounded pending facts.
    // Fill source lanes separately: one source with many old waits must not occupy
    // the candidate page while another source could use a free global slot.
    for (
      let selected = 0;
      selected < Math.min(this.#policy.pageSize, this.#policy.maxConcurrent);
      selected++
    ) {
      const occupiedFlights = this.#occupiedFlights();
      if (
        this.#closed ||
        this.#pendingCooldowns.size >= this.#policy.maxSourceCooldowns ||
        occupiedFlights.size >= this.#policy.maxConcurrent
      )
        return;

      const now = this.#clock.now();
      const excludedWaitIds = new Set(seenWaitIds);
      const occupied = new Map<string, number>();
      for (const flight of occupiedFlights) {
        excludedWaitIds.add(flight.waitId);
        occupied.set(flight.source, (occupied.get(flight.source) ?? 0) + 1);
      }
      const dirtyWaitIds: string[] = [];
      for (const [waitId, subscription] of this.#subscriptions) {
        if (subscription.isPending?.()) excludedWaitIds.add(waitId);
        else if (subscription.dirty) dirtyWaitIds.push(waitId);
      }
      const excludedSources = new Set<string>();
      for (const [source, count] of occupied)
        if (count >= this.#policy.maxPerSource) excludedSources.add(source);
      for (const [source, until] of this.#cooldowns) if (until > now) excludedSources.add(source);
      for (const [source, input] of this.#pendingCooldowns)
        if (input.until > now) excludedSources.add(source);

      // Normally a durable claim moves the oldest winner behind its peers. After a
      // failed claim, traverse immutable IDs instead so progress does not depend on
      // that write succeeding or on a bounded cache retaining every failed wait.
      // Eligibility and occupied lanes are still filtered before LIMIT in both modes.
      const observationScan = this.#observationScan;
      const candidates = await this.#store.listForObservation({
        limit: 1,
        now,
        ...(observationScan ? { scan: observationScan } : {}),
        dirtyWaitIds,
        excludedWaitIds: [...excludedWaitIds],
        excludedSources: [...excludedSources].map((key) => {
          const [providerId, connectionId] = JSON.parse(key) as [string, string | null];
          return { providerId, connectionId };
        }),
      });
      const snapshot = candidates[0];
      if (this.#closed) return;
      if (!snapshot) {
        if (observationScan && this.#observationScan === observationScan)
          this.#observationScan = undefined;
        return;
      }
      if (observationScan && this.#observationScan === observationScan)
        this.#observationScan = { afterWaitId: snapshot.record.waitId };
      seenWaitIds.add(snapshot.record.waitId);
      const r = snapshot.record;
      const dispatchAt = this.#clock.now();
      if (dispatchAt >= r.deadlineAt) {
        try {
          await this.#expire(snapshot);
        } catch (error) {
          this.#report(error);
        }
        continue;
      }
      const currentFlights = this.#occupiedFlights();
      if ([...currentFlights].some((flight) => flight.waitId === r.waitId)) continue;
      const subscription = this.#subscriptions.get(r.waitId);
      if (subscription?.isPending?.()) continue;
      const o = r.observation;
      const due = o ? (subscription?.dirty ? o.nextObserveAt : o.nextPollAt) : r.createdAt;
      if (dispatchAt < due) continue;
      const source = sourceKey(r);
      if (
        dispatchAt < this.#sourceCooldown(source) ||
        this.#pendingCooldowns.size >= this.#policy.maxSourceCooldowns ||
        currentFlights.size >= this.#policy.maxConcurrent ||
        [...currentFlights].filter((v) => v.source === source).length >= this.#policy.maxPerSource
      )
        continue;
      // Reserve capacity before asynchronous setup; rate limits apply at read dispatch.
      const flight: Flight = {
        controller: new AbortController(),
        source,
        sessionId: r.sessionId,
        waitId: r.waitId,
        claimed: false,
        cooldownUntil: 0,
        retryAfterUntil: 0,
        task: Promise.resolve(),
      };
      this.#flights.set(r.waitId, flight);
      flight.task = this.#observe(snapshot, flight)
        .catch((error: unknown) => {
          this.#report(error);
          if (!this.#closed && !flight.claimed) this.#observationScan ??= {};
        })
        .finally(() => {
          if (this.#flights.get(r.waitId) === flight) this.#flights.delete(r.waitId);
        });
    }
  }

  async #observe(snapshot: EventWaitSnapshot, flight: Flight): Promise<void> {
    let r = snapshot.record;
    if (r.status !== 'waiting' || this.#closed) return;
    const cooldown = await this.#store.readSourceCooldown({
      providerId: r.resource.providerId,
      connectionId: r.resource.connectionId,
    });
    if (this.#closed || flight.controller.signal.aborted) return;
    if (cooldown !== null && cooldown > this.#clock.now()) {
      return;
    }
    const previous = r.observation;
    if ((previous?.attempts ?? 0) >= this.#policy.maxAttempts) {
      const finished = await this.#finish(
        snapshot,
        { kind: 'source_unavailable', receiptKey: `${r.deliveryKey}/budget`, evidenceRefs: [] },
        { reason: 'observation_budget_exhausted' },
      );
      if (!finished && !this.#closed && !flight.controller.signal.aborted)
        this.#observationScan ??= {};
      return;
    }
    let adapter: EventWaitSourceAdapter;
    try {
      this.validate(r);
      adapter = this.#options.adapters.get(r)!;
    } catch {
      const finished = await this.#finish(snapshot, {
        kind: 'source_unavailable',
        receiptKey: `${r.deliveryKey}/unsupported`,
        evidenceRefs: [],
      });
      if (!finished && !this.#closed && !flight.controller.signal.aborted)
        this.#observationScan ??= {};
      return;
    }
    const now = Math.max(r.updatedAt, this.#clock.now());
    if (now >= r.deadlineAt) {
      await this.#expire(snapshot);
      return;
    }
    const reserved: EventWaitObservation = {
      schemaVersion: 1,
      attempts: (previous?.attempts ?? 0) + 1,
      lastAttemptAt: now,
      lastObservedAt: previous?.lastObservedAt ?? null,
      nextObserveAt: Math.min(
        r.deadlineAt,
        addTime(now, Math.max(this.#policy.readTimeoutMs, this.#policy.minIntervalMs)),
      ),
      nextPollAt: Math.min(
        r.deadlineAt,
        addTime(now, Math.max(this.#policy.readTimeoutMs, this.#policy.minIntervalMs)),
      ),
      consecutiveErrors: previous?.consecutiveErrors ?? 0,
      outcome: 'checking',
      cursor: previous?.cursor ?? null,
      eventKey: previous?.eventKey ?? null,
      reason: null,
    };
    const claim = await this.#commit(snapshot, { ...r, updatedAt: now, observation: reserved });
    if (this.#closed || flight.controller.signal.aborted) return;
    if (!claim) {
      // Conflict responses also need progress if a backend keeps returning the same
      // ready row. Reselect from authority during the next bounded recovery pass.
      this.#observationScan ??= {};
      return;
    }
    flight.claimed = true;
    snapshot = claim;
    r = claim.record;
    let result: EventWaitObservationResult;
    let subscriptionPending = false;
    try {
      for (;;) {
        const access = await this.#authorize(r, flight);
        if (access.kind === 'revoked') {
          await this.cancel(identity(r), access.reason);
          return;
        }
        if (access.kind === 'unknown') {
          result = access;
          break;
        }
        const readiness = await this.#subscribe(adapter, r, access.context, flight);
        // A peer can throttle the source while authorization is in flight. Wait
        // outside the request timeout, then obtain fresh access before subscribing.
        if (readiness === 'deferred') continue;
        subscriptionPending = readiness === 'pending';
        if (subscriptionPending) {
          result = { kind: 'unknown', reason: 'observation_timeout' };
        } else {
          const read = await this.#read(adapter, r, flight);
          if ('access' in read) {
            if (read.access.kind === 'revoked') {
              await this.cancel(identity(r), read.access.reason);
              return;
            }
            // No source result needs revalidation; unknown access must back off immediately.
            result = read.access;
          } else {
            result = read.result;
            // A rate-limited read has no condition facts to accept. Preserve its backoff
            // without issuing another potentially remote authorization request.
            if (result.kind !== 'unknown' || (result.retryAfterMs ?? 0) === 0) {
              const latestAccess = await this.#authorize(r, flight);
              if (latestAccess.kind === 'revoked') {
                await this.cancel(identity(r), latestAccess.reason);
                return;
              }
              if (latestAccess.kind === 'unknown') {
                result = latestAccess;
              }
            }
          }
        }
        break;
      }
    } catch (error) {
      // A source fact must not become a weaker observation_failed checkpoint just
      // because its persistence failed. Leave the reservation intact and report it.
      if (error instanceof SourceCooldownWriteError || error instanceof StorageRootAuthorityError)
        throw error;
      if (this.#closed || flight.controller.signal.aborted) return;
      result = {
        kind: 'unknown',
        reason: error instanceof ObservationTimeout ? 'observation_timeout' : 'observation_failed',
      };
    }
    if (this.#closed || flight.controller.signal.aborted) return;
    try {
      this.#validateResult(result, r);
    } catch {
      result = { kind: 'unknown', reason: 'invalid_observation_result' };
    }
    // Release live notification intake when observation or access is uncertain, but
    // keep a failed subscription's polling-only marker across transient read errors.
    if (
      result.kind === 'unknown' &&
      !subscriptionPending &&
      !this.#subscriptions.get(r.waitId)?.controller.signal.aborted
    )
      this.#detach(r.waitId);
    await this.#finish(snapshot, result, { retryAfterUntil: flight.retryAfterUntil });
  }

  #validateAccess(access: EventWaitObservationAccess): void {
    if (!access || !['allowed', 'revoked', 'unknown'].includes(access.kind))
      throw new TypeError('Invalid observation access');
  }

  async #authorize(r: EventWaitRecord, flight: Flight): Promise<EventWaitObservationAccess> {
    for (;;) {
      // Every authorization boundary may issue a remote request. A peer can establish
      // or extend Retry-After during any earlier await, including the source read.
      // Intentional throttling stays outside the request timeout and attempt budget.
      if (flight.retryAfterUntil > this.#clock.now())
        await this.#waitForCooldown(flight, Math.min(flight.retryAfterUntil, r.deadlineAt));
      const checked = await this.#tryAuthorize(r, flight);
      if (checked) return checked.access;
    }
  }

  /** Null defers dispatch to the caller without starting an authorization request. */
  async #tryAuthorize(
    r: EventWaitRecord,
    flight: Flight,
    deadline = r.deadlineAt,
    authorize = this.#options.authorize,
  ): Promise<{ access: EventWaitObservationAccess } | null> {
    const recordCooldown = async (checked: { access: EventWaitObservationAccess } | null) => {
      if (!checked || this.#closed) return;
      this.#validateAccess(checked.access);
      if (checked.access.kind === 'unknown') {
        this.#validateResult(checked.access, r);
        await this.#recordSourceCooldown(r, checked.access);
      }
    };
    const checked = await this.#call<{ access: EventWaitObservationAccess } | null>(
      flight,
      deadline,
      (signal) => {
        // Recheck at actual dispatch; cooldown can change after the timer wakes or
        // before #call invokes this callback. Active flights retain it across cache eviction.
        if (flight.retryAfterUntil > this.#clock.now()) return Promise.resolve(null);
        return authorize(structuredClone(r), signal).then((access) => ({ access }));
      },
      recordCooldown,
    );
    // Shared facts outlive a cancelled wait, including cancellation during the
    // handoff from #call. Normal and late results use the same validation/persistence
    // path, outside the request timeout and before releasing their request capacity.
    await recordCooldown(checked);
    return checked;
  }

  async #read(
    adapter: EventWaitSourceAdapter,
    r: EventWaitRecord,
    flight: Flight,
  ): Promise<
    | { result: EventWaitObservationResult }
    | { access: Exclude<EventWaitObservationAccess, { kind: 'allowed' }> }
  > {
    for (;;) {
      if (this.#closed || flight.controller.signal.aborted)
        throw new Error('Observation cancelled');
      if (this.#clock.now() >= r.deadlineAt)
        throw new ObservationTimeout('Observation deadline reached');
      const preparing = this.#dispatching.get(flight.source);
      if (preparing) {
        await this.#waitForPreparation(flight, r.deadlineAt, preparing);
        continue;
      }
      const preparation: DispatchPreparation = { waiters: new Set() };
      this.#dispatching.set(flight.source, preparation);
      const unlock = () => {
        if (this.#dispatching.get(flight.source) === preparation)
          this.#dispatching.delete(flight.source);
        for (const resume of preparation.waiters) resume();
        preparation.waiters.clear();
      };
      const token = randomUUID();
      let reserved = false;
      let completion: Promise<{ error: unknown } | null> | undefined;
      const complete = (at: number, until: number) => {
        const writing = this.#completeDispatch(r, token, at, until).then(
          () => null,
          (error: unknown) => ({ error }),
        );
        // Only dispatch preparation is serialized; the source read may continue.
        void writing.then(unlock);
        return writing;
      };
      try {
        // The cache contains actual source facts only. A durable dispatch reservation
        // is checked here, but never cached as though it were a source Retry-After.
        const persisted = await this.#store.readSourceCooldown({
          providerId: r.resource.providerId,
          connectionId: r.resource.connectionId,
        });
        if (this.#closed || flight.controller.signal.aborted)
          throw new Error('Observation cancelled');
        if (this.#clock.now() >= r.deadlineAt)
          throw new ObservationTimeout('Observation deadline reached');
        const until = Math.max(
          persisted ?? 0,
          this.#sourceCooldown(flight.source),
          flight.cooldownUntil,
        );
        if (until > this.#clock.now()) {
          unlock();
          await this.#waitForCooldown(flight, Math.min(until, r.deadlineAt));
          continue;
        }
        const now = this.#clock.now();
        // Persist a bounded preparation window before any source request. It survives
        // a crash before actual dispatch timing is committed, without permanently
        // extending the ordinary minimum interval after a successful dispatch.
        const dispatchBy = addTime(now, this.#policy.readTimeoutMs);
        reserved = await this.#reserveDispatch(
          r,
          token,
          now,
          addTime(dispatchBy, this.#policy.minIntervalMs),
        );
        if (!reserved) continue;
        // Never wait out Retry-After while holding a bounded dispatch reservation.
        // Release it in finally, then wait and reserve afresh within this observation.
        const checked = await this.#tryAuthorize(r, flight);
        if (!checked) continue;
        const { access } = checked;
        if (access.kind !== 'allowed') return { access };
        const read = await this.#call(
          flight,
          r.deadlineAt,
          (signal) => {
            const at = this.#clock.now();
            if (at > dispatchBy || at >= r.deadlineAt)
              throw new ObservationTimeout('Dispatch reservation elapsed');
            if (at < flight.cooldownUntil || at < this.#sourceCooldown(flight.source))
              return Promise.resolve(null);
            const subscription = this.#subscriptions.get(r.waitId);
            if (subscription) subscription.dirty = false;
            this.#cool(flight.source, addTime(at, this.#policy.minIntervalMs), flight);
            // The reservation already protects restart. Persist actual timing beside
            // the source request; a synchronous source throw also consumes an interval.
            try {
              return adapter
                .read({
                  wait: structuredClone(r),
                  access: access.context,
                  cursor: r.observation?.cursor ?? null,
                  signal,
                })
                .then((result) => ({ result }));
            } finally {
              completion = complete(at, addTime(at, this.#policy.minIntervalMs));
            }
          },
          async (lateRead) => {
            if (!lateRead) return;
            this.#validateResult(lateRead.result, r);
            await this.#recordSourceCooldown(r, lateRead.result);
          },
        );
        if (read) {
          this.#validateResult(read.result, r);
          await this.#recordSourceCooldown(r, read.result);
          return read;
        }
      } finally {
        try {
          // An aborted preparation has no source request to account for. Release only
          // our own token; newer Retry-After facts and later reservations remain intact.
          if (reserved && !completion && !this.#closed) {
            const at = this.#clock.now();
            completion = complete(at, at);
          }
          const failed = await completion;
          if (failed) throw failed.error;
        } finally {
          unlock();
        }
      }
    }
  }

  async #reserveDispatch(
    r: EventWaitRecord,
    token: string,
    observedAt: number,
    until: number,
  ): Promise<boolean> {
    for (let attempt = 0; ; attempt++) {
      if (this.#closed) throw new Error('Observation cancelled');
      try {
        return await this.#store.reserveSourceDispatch({
          providerId: r.resource.providerId,
          connectionId: r.resource.connectionId,
          token,
          observedAt,
          until,
        });
      } catch (error) {
        if (error instanceof StorageRootAuthorityError) throw error;
        if (attempt === 1) throw new SourceCooldownWriteError(error);
      }
    }
  }

  async #completeDispatch(
    r: EventWaitRecord,
    token: string,
    observedAt: number,
    until: number,
  ): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.#closed) return;
      try {
        await this.#store.completeSourceDispatch({
          providerId: r.resource.providerId,
          connectionId: r.resource.connectionId,
          token,
          observedAt,
          until,
        });
        return;
      } catch (error) {
        if (error instanceof StorageRootAuthorityError) throw error;
        if (attempt === 1) throw new SourceCooldownWriteError(error);
      }
    }
  }

  async #waitForPreparation(
    flight: Flight,
    deadline: number,
    preparation: DispatchPreparation,
  ): Promise<void> {
    if (this.#closed || flight.controller.signal.aborted) throw new Error('Observation cancelled');
    if (this.#clock.now() >= deadline) throw new ObservationTimeout('Observation deadline reached');
    if (this.#dispatching.get(flight.source) !== preparation) return;
    // This wait owns no source request or dispatch reservation. Detach on interruption
    // rather than retaining a Promise reaction or counting it as a lingering request.
    let resume!: () => void;
    let abort!: () => void;
    let cancelTimer: (() => void) | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        resume = resolve;
        abort = () => reject(new Error('Observation cancelled'));
        preparation.waiters.add(resume);
        flight.controller.signal.addEventListener('abort', abort, { once: true });
        cancelTimer = this.#clock.schedule(
          () => reject(new ObservationTimeout('Observation deadline reached')),
          Math.max(0, deadline - this.#clock.now()),
        );
      });
    } finally {
      preparation.waiters.delete(resume);
      flight.controller.signal.removeEventListener('abort', abort);
      cancelTimer?.();
    }
  }

  async #waitForCooldown(flight: Flight, until: number): Promise<void> {
    if (this.#closed || flight.controller.signal.aborted) throw new Error('Observation cancelled');
    if (this.#clock.now() >= until) return;
    // Intentional throttling does not consume read timeouts or additional attempts.
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        cancelTimer();
        flight.controller.signal.removeEventListener('abort', abort);
        reject(new Error('Observation cancelled'));
      };
      const cancelTimer = this.#clock.schedule(() => {
        flight.controller.signal.removeEventListener('abort', abort);
        resolve();
      }, until - this.#clock.now());
      flight.controller.signal.addEventListener('abort', abort, { once: true });
    });
  }

  #validateResult(result: EventWaitObservationResult, r: EventWaitRecord): void {
    if (
      !result ||
      !['pending', 'unknown', 'satisfied', 'invalidated', 'source_unavailable'].includes(
        result.kind,
      )
    )
      throw new TypeError('Invalid observation result');
    if (
      result.kind === 'unknown' &&
      result.retryAfterMs !== undefined &&
      (!Number.isSafeInteger(result.retryAfterMs) || result.retryAfterMs < 0)
    )
      throw new TypeError('Invalid retry delay');
    const now = Math.max(r.updatedAt, this.#clock.now());
    // Registration and delivery authorization may have no observation checkpoint.
    // Validate the prospective fields without writing an attempt or changing the wait.
    const observation = r.observation ?? {
      schemaVersion: 1,
      attempts: 1,
      lastAttemptAt: now,
      lastObservedAt: now,
      nextObserveAt: now,
      nextPollAt: now,
      consecutiveErrors: 0,
      outcome: 'checking',
      cursor: null,
      eventKey: null,
      reason: null,
    };
    decodeEventWaitRecord({
      ...r,
      updatedAt: now,
      observation: {
        ...observation,
        outcome: result.kind,
        lastObservedAt: now,
        cursor: result.cursor ?? observation.cursor,
        eventKey: result.eventKey ?? observation.eventKey,
        reason: result.kind === 'unknown' ? result.reason : null,
      },
      ...(result.kind === 'pending' || result.kind === 'unknown'
        ? {}
        : {
            status: 'resolved',
            resolvedAt: now,
            resolution: {
              outcome: result.kind,
              receiptKey: result.receiptKey,
              observedAt: now,
              evidenceRefs: result.evidenceRefs,
            },
          }),
    });
  }

  async #recordSourceCooldown(
    r: EventWaitRecord,
    result: EventWaitObservationResult,
  ): Promise<void> {
    if (this.#closed) return;
    const now = Math.max(r.updatedAt, this.#clock.now());
    const retry = result.kind === 'unknown' ? (result.retryAfterMs ?? 0) : 0;
    if (retry > 0) {
      // Persist the source fact before changing the wait, including a late expiry
      // or a losing cancellation CAS. Another wait still owes the full Retry-After.
      const until = addTime(now, retry);
      this.#cool(sourceKey(r), until);
      await this.#persistSourceCooldown(r, now, until);
    }
  }

  async #persistSourceCooldown(
    r: EventWaitRecord,
    observedAt: number,
    until: number,
  ): Promise<void> {
    await this.#writeSourceCooldown({
      providerId: r.resource.providerId,
      connectionId: r.resource.connectionId,
      observedAt,
      until,
    });
  }

  async #writeSourceCooldown(input: ExtendEventWaitSourceCooldownInput): Promise<void> {
    const key = eventWaitSourceKey(input);
    // Keep unacknowledged facts outside the evictable cache. A peer may finish setup
    // while this write is pending, and wait cleanup must not erase the source limit.
    if ((this.#pendingCooldowns.get(key)?.until ?? 0) < input.until)
      this.#pendingCooldowns.set(key, input);
    // Retry a transient write once using the same absolute deadline. A lost
    // acknowledgement is safe because the store only extends the existing limit.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.#closed) return;
      try {
        const persisted = await this.#store.extendSourceCooldown(input);
        if (!this.#closed) {
          this.#cacheCooldown(key, persisted);
          if ((this.#pendingCooldowns.get(key)?.until ?? 0) <= persisted)
            this.#pendingCooldowns.delete(key);
        }
        return;
      } catch (error) {
        if (error instanceof StorageRootAuthorityError) throw error;
        // The fact was registered before the first await. If it has since been
        // removed, a successful dominating write or expiry already retired it.
        if (attempt === 1) throw new SourceCooldownWriteError(error);
      }
    }
  }

  async #finish(
    snapshot: EventWaitSnapshot,
    result: EventWaitObservationResult,
    options: { reason?: string; retryAfterUntil?: number } = {},
  ): Promise<EventWaitSnapshot | null> {
    const r = snapshot.record;
    if (this.#closed || r.status !== 'waiting') return null;
    // Source reads and authorization already recorded their shared facts. Finishing
    // this wait must neither discard those facts nor restart their absolute cooldown.
    const now = Math.max(r.updatedAt, this.#clock.now());
    if (now >= r.deadlineAt) {
      await this.#expire(snapshot);
      return null;
    }
    const previous = r.observation;
    let observation = previous;
    if (previous) {
      const errors = result.kind === 'unknown' ? previous.consecutiveErrors + 1 : 0;
      const backoff =
        result.kind === 'unknown'
          ? Math.min(
              this.#policy.maxBackoffMs,
              this.#policy.pollIntervalMs * 2 ** Math.min(errors - 1, 20),
            )
          : this.#policy.pollIntervalMs;
      const random = this.#options.random?.() ?? Math.random();
      if (!Number.isFinite(random) || random < 0 || random > 1)
        throw new TypeError('Invalid wait randomness');
      const delay = Math.ceil(backoff * (1 + this.#policy.jitterRatio * random));
      const nextObserveAt = Math.min(
        r.deadlineAt,
        Math.max(
          options.retryAfterUntil ?? 0,
          addTime(
            now,
            result.kind === 'unknown'
              ? Math.max(delay, this.#policy.minIntervalMs)
              : this.#policy.minIntervalMs,
          ),
        ),
      );
      observation = {
        ...previous,
        lastObservedAt: now,
        nextObserveAt,
        nextPollAt: Math.min(r.deadlineAt, Math.max(nextObserveAt, addTime(now, delay))),
        consecutiveErrors: errors,
        outcome: result.kind,
        // Failed reads never advance a replay checkpoint.
        cursor: result.kind === 'unknown' ? previous.cursor : (result.cursor ?? previous.cursor),
        eventKey:
          result.kind === 'unknown' ? previous.eventKey : (result.eventKey ?? previous.eventKey),
        reason: result.kind === 'unknown' ? result.reason : (options.reason ?? null),
      };
    }
    let record: EventWaitRecord = { ...r, updatedAt: now, ...(observation ? { observation } : {}) };
    if (result.kind !== 'pending' && result.kind !== 'unknown') {
      record = {
        ...record,
        status: 'resolved',
        resolvedAt: now,
        resolution: {
          outcome: result.kind,
          receiptKey: result.receiptKey,
          observedAt: now,
          evidenceRefs: result.evidenceRefs,
        },
      };
    }
    const committed = await this.#commit(snapshot, record);
    if (!committed || committed.record.status !== 'waiting') this.#detach(r.waitId);
    return committed;
  }

  async #subscribe(
    adapter: EventWaitSourceAdapter,
    r: EventWaitRecord,
    access: unknown,
    flight: Flight,
  ): Promise<'ready' | 'pending' | 'deferred'> {
    if (
      !adapter.subscribe ||
      this.#subscriptions.has(r.waitId) ||
      this.#subscriptions.size >= this.#policy.maxSubscriptions
    )
      return 'ready';
    if (flight.retryAfterUntil > this.#clock.now()) return 'deferred';
    const subscription: Subscription = {
      identity: identity(r),
      controller: new AbortController(),
      dirty: false,
    };
    this.#subscriptions.set(r.waitId, subscription);
    try {
      const subscribed = await this.#call(flight, r.deadlineAt, async (signal) => {
        // Check at the side-effect boundary too: #call dispatches in a microtask.
        if (flight.retryAfterUntil > this.#clock.now()) return false;
        const abort = () => subscription.controller.abort();
        signal.addEventListener('abort', abort, { once: true });
        try {
          const handle = await adapter.subscribe!(
            {
              wait: structuredClone(r),
              access,
              cursor: r.observation?.cursor ?? null,
              signal: subscription.controller.signal,
            },
            () => {
              if (
                !this.#closed &&
                this.#subscriptions.get(r.waitId) === subscription &&
                !subscription.controller.signal.aborted
              )
                subscription.dirty = true;
            },
          );
          if (
            this.#closed ||
            subscription.controller.signal.aborted ||
            this.#subscriptions.get(r.waitId) !== subscription
          )
            handle.close();
          else subscription.handle = handle;
          return true;
        } finally {
          signal.removeEventListener('abort', abort);
        }
      });
      if (!subscribed) {
        this.#detach(r.waitId);
        return 'deferred';
      }
    } catch (error) {
      subscription.controller.abort();
      if (this.#closed || flight.controller.signal.aborted) throw error;
      // Retain the bounded, aborted entry as a polling-only fallback. Retrying a
      // broken optional subscription before every read can consume the entire TTL.
      // A timed-out setup still running must first release its source capacity.
      if (error instanceof ObservationTimeout) subscription.isPending = error.isPending;
      return subscription.isPending?.() ? 'pending' : 'ready';
    }
    return 'ready';
  }

  async #call<T>(
    flight: Flight,
    deadline: number,
    operation: (signal: AbortSignal) => Promise<T>,
    onLateResult?: (result: T) => Promise<void>,
  ): Promise<T> {
    if (this.#closed || flight.controller.signal.aborted) throw new Error('Observation cancelled');
    if (this.#clock.now() >= deadline) throw new ObservationTimeout('Observation deadline reached');
    const controller = new AbortController();
    let settled = false;
    let delivered = false;
    let finishHandoff!: () => void;
    const handoff = new Promise<void>((resolve) => {
      finishHandoff = resolve;
    });
    let rejectWait!: (reason: unknown) => void;
    const interrupted = new Promise<never>((_, reject) => {
      rejectWait = reject;
    });
    const task = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new Error('Observation cancelled');
      return operation(controller.signal);
    });
    const interrupt = (error: Error) => {
      controller.abort();
      if (!settled) this.#lingering.set(task, flight);
      rejectWait(error);
    };
    const abort = () => interrupt(new Error('Observation cancelled'));
    flight.controller.signal.addEventListener('abort', abort, { once: true });
    const cancelTimer = this.#clock.schedule(
      () => interrupt(new ObservationTimeout('Observation timed out', () => !settled)),
      Math.max(0, Math.min(this.#policy.readTimeoutMs, deadline - this.#clock.now())),
    );
    void task
      .then(
        async (result) => {
          // Abort can fire after task settlement while its result still wins the
          // race. Only the actual handoff outcome decides who processes the fact.
          await handoff;
          if (delivered || this.#closed || !onLateResult) return;
          // Keep source capacity until its late facts are processed. This persistence
          // is outside the source timeout and participates in bounded Host shutdown.
          const processing = Promise.resolve().then(() => {
            if (!this.#closed) return onLateResult(result);
          });
          this.#lateResults.add(processing);
          try {
            await processing;
          } catch (error) {
            this.#report(error);
          } finally {
            this.#lateResults.delete(processing);
          }
        },
        () => undefined,
      )
      .finally(() => {
        settled = true;
        this.#lingering.delete(task);
      })
      .catch(() => undefined);
    try {
      const result = await Promise.race([task, interrupted]);
      delivered = true;
      return result;
    } finally {
      cancelTimer();
      flight.controller.signal.removeEventListener('abort', abort);
      finishHandoff();
    }
  }

  async #commit(
    snapshot: EventWaitSnapshot,
    record: EventWaitRecord,
  ): Promise<EventWaitSnapshot | null> {
    if (this.#closed) return null;
    const result = await this.#store.commit({
      ...identity(record),
      expectedAuthorityRevision: snapshot.authorityRevision,
      record,
    });
    return result.kind === 'committed' ? result.snapshot : null;
  }

  async #expire(snapshot: EventWaitSnapshot): Promise<void> {
    if (this.#closed || snapshot.record.status !== 'waiting') return;
    const r = snapshot.record;
    const now = Math.max(r.updatedAt, this.#clock.now());
    if (now < r.deadlineAt) return;
    // The immutable deadline already forbids more observation, even if recording
    // expiry fails or its acknowledgement is lost. The store still owns the status.
    this.#stopObservation(identity(r));
    await this.#commit(snapshot, {
      ...r,
      status: 'expired',
      updatedAt: now,
      expiredAt: now,
    });
  }

  /** Trusted internal control entry point; PR3 is responsible for authenticating the caller. */
  async cancel(input: ReadEventWaitInput, reason: string): Promise<void> {
    if (this.#closed) throw new Error('Event wait manager is closed');
    for (let attempt = 0; attempt < 4 && !this.#closed; attempt++) {
      const snapshot = await this.#store.read(input);
      if (!snapshot || ['cancelled', 'expired'].includes(snapshot.record.status)) {
        this.#stopObservation(input);
        return;
      }
      const r = snapshot.record;
      const now = Math.max(r.updatedAt, this.#clock.now());
      const base = {
        ...r,
        status: 'cancelled' as const,
        updatedAt: now,
        cancelledAt: now,
        reason,
        ...(r.status === 'resolved'
          ? { priorResolution: { resolvedAt: r.resolvedAt, resolution: r.resolution } }
          : {}),
      };
      // Construct from the base contract; terminal-only keys must not leak across variants.
      const {
        resolvedAt: _resolvedAt,
        resolution: _resolution,
        ...record
      } = base as typeof base & {
        resolvedAt?: number;
        resolution?: unknown;
      };
      try {
        if (await this.#commit(snapshot, record)) {
          this.#stopObservation(input);
          return;
        }
      } catch (error) {
        // A lost acknowledgement may still have durably cancelled the wait.
        // Release resources once that fact is confirmed; preserve the original error.
        try {
          const current = await this.#store.read(input);
          if (!current || current.record.status !== 'waiting') this.#stopObservation(input);
        } catch {
          /* Failed storage remains authoritative; the caller receives the failure. */
        }
        throw error;
      }
    }
    // Only an authoritative outcome above acknowledges cancellation. Shutdown
    // may stop observation without durably cancelling the wait.
    throw new Error(
      this.#closed ? 'Event wait manager is closed' : 'Event wait cancellation conflicted',
    );
  }

  #stopObservation(input: ReadEventWaitInput): void {
    const flight = this.#flights.get(input.waitId);
    if (flight?.sessionId === input.sessionId) flight.controller.abort();
    if (this.#subscriptions.get(input.waitId)?.identity.sessionId === input.sessionId)
      this.#detach(input.waitId);
  }

  #sourceCooldown(source: string): number {
    return Math.max(
      this.#cooldowns.get(source) ?? 0,
      this.#pendingCooldowns.get(source)?.until ?? 0,
    );
  }

  #cool(source: string, until: number, owner?: Flight): void {
    // Prepared reads retain new source facts even if their cache entry is evicted.
    for (const flight of this.#occupiedFlights()) {
      if (flight.source === source && flight !== owner) {
        flight.cooldownUntil = Math.max(flight.cooldownUntil, until);
        // An owner marks ordinary read spacing. Source-reported Retry-After has no
        // owner and must also defer authorization in every already-admitted flight.
        if (!owner) flight.retryAfterUntil = Math.max(flight.retryAfterUntil, until);
      }
    }
    this.#cacheCooldown(source, until);
  }

  #cacheCooldown(source: string, until: number): void {
    const now = this.#clock.now();
    for (const [key, time] of this.#cooldowns) if (time <= now) this.#cooldowns.delete(key);
    if (until <= now) return;
    const latest = Math.max(this.#cooldowns.get(source) ?? 0, until);
    this.#cooldowns.delete(source);
    if (this.#cooldowns.size >= this.#policy.maxSourceCooldowns)
      this.#cooldowns.delete(this.#cooldowns.keys().next().value!);
    this.#cooldowns.set(source, latest);
  }
  #detach(waitId: string): void {
    const subscription = this.#subscriptions.get(waitId);
    if (!subscription) return;
    this.#subscriptions.delete(waitId);
    subscription.controller.abort();
    try {
      subscription.handle?.close();
    } catch (error) {
      this.#report(error);
    }
  }
  #report(error: unknown): void {
    if (error instanceof StorageRootAuthorityError && error.code === 'invalid_lease')
      void this.close();
    try {
      this.#options.onError(error);
    } catch {
      /* Diagnostic consumers cannot stop cleanup. */
    }
  }

  close(): Promise<void> {
    if (this.#close) return this.#close;
    this.#closed = true;
    this.#timer?.();
    this.#timer = undefined;
    for (const flight of this.#flights.values()) flight.controller.abort();
    for (const flight of this.#accessFlights) flight.controller.abort();
    for (const waitId of this.#subscriptions.keys()) this.#detach(waitId);
    this.#close = (async () => {
      let cancelTimer: (() => void) | undefined;
      try {
        await Promise.race([
          Promise.allSettled([
            this.#start,
            this.#scan,
            ...[...this.#flights.values()].map((v) => v.task),
            ...[...this.#accessFlights].map((v) => v.task),
            ...this.#lateResults,
          ]),
          new Promise<void>((resolve) => {
            cancelTimer = this.#clock.schedule(resolve, this.#policy.closeTimeoutMs);
          }),
        ]);
      } finally {
        cancelTimer?.();
      }
    })();
    return this.#close;
  }
}
