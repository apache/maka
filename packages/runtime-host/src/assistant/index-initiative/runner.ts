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
import { setTimeout as delay } from 'node:timers/promises';
import { awaitingUser } from '../execution-outcome.js';
import type { InitiativeStore } from './store.js';
import type {
  TurnMessageExecutionResolution,
  TurnMessageSubmitResult,
} from '../../protocol/message.js';
import type { DiscoveryLane, DiscoveryWorkByLane } from './work-types.js';
export type { DiscoveryLane } from './work-types.js';

/** Only the Host fields used by discovery; message ownership is not an execution outcome. */
export interface DiscoveryAgent {
  readonly sessionId: string;
  messageExecution(
    messageId: string,
  ): Promise<Pick<TurnMessageExecutionResolution, 'state'> | undefined>;
  followup(
    input: string,
    options: { messageId: string },
  ): Promise<Pick<TurnMessageSubmitResult, 'disposition'>>;
  whenIdle(signal: AbortSignal): Promise<void>;
  snapshot(): Promise<{
    agent?: { status?: string };
    root?: { kind?: string };
    pendingInteractions?: number;
  }>;
  cancel(): Promise<unknown>;
}
type State = 'preparing' | 'running' | 'settling' | 'recovering' | 'retry_wait' | 'done';
export interface DiscoveryJob<L extends DiscoveryLane = DiscoveryLane> {
  id: string;
  lane: L;
  state: State;
  startedAt: number;
  work: DiscoveryWorkByLane[L];
}
export interface DiscoveryAdapter {
  store: InitiativeStore;
  signal: AbortSignal;
  ready(): void;
  request(): Promise<boolean>;
  prepare(job: DiscoveryJob): Promise<DiscoveryAgent | undefined>;
  recovery(job: DiscoveryJob): Promise<{ agent: DiscoveryAgent; messageId: string } | undefined>;
  reattach(): void;
  defer(cancelled: boolean): void;
  /** Retire local outputs synchronously; return a best-effort stop for the old worker. */
  abandon(job: DiscoveryJob): () => Promise<unknown>;
  unfinished(): boolean;
  run(agent: DiscoveryAgent): Promise<void | 'deferred'>;
  error(error: unknown): void;
}

const fields = {
  broad: ['active', 'pendingDraft', 'pendingJudgement', 'candidateReport', 'retry', 'contextWake'],
  quick: ['active', 'pending', 'contextWake'],
} as const satisfies { [L in DiscoveryLane]: readonly (keyof DiscoveryWorkByLane[L])[] };
const occupied = "state IN ('preparing','running','settling','recovering')";
const recoveryTimeoutMs = 5 * 60_000;

/** Cross-version continuation is deliberately unsupported; never silently discard work. */
export function requireIdleDiscovery(state: any) {
  if (
    Object.values(fields)
      .flat()
      .some((key) => state?.[key])
  )
    throw Error(
      'Finish pending discovery work in the previous version, or use a fresh profile; legacy executions are not resumed by this Runner',
    );
}

/** The execution ended, as opposed to an observer or a request becoming unavailable. */
export class DiscoveryExecutionEnded extends Error {}

/** One durable owner of discovery admission. Lane state is a projection of its job. */
export class DiscoveryRunner {
  private adapters = new Map<DiscoveryLane, DiscoveryAdapter>();
  private tasks = new Map<DiscoveryLane, Promise<void>>();
  private ticking?: Promise<void>;
  private initializationError?: string;
  constructor(
    private readonly store: InitiativeStore,
    private readonly sequence: () => number,
    private readonly now: () => number = Date.now,
  ) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS discovery_requests(
        seq INTEGER PRIMARY KEY AUTOINCREMENT,lane TEXT NOT NULL UNIQUE,queued_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS discovery_jobs(
        id TEXT PRIMARY KEY,lane TEXT NOT NULL,state TEXT NOT NULL,owner TEXT NOT NULL,
        started_at INTEGER NOT NULL,work TEXT NOT NULL,memory_after INTEGER NOT NULL,
        memory_through INTEGER,finished_at INTEGER,outcome TEXT,error TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS discovery_job_lane ON discovery_jobs(lane) WHERE state!='done';
      CREATE UNIQUE INDEX IF NOT EXISTS discovery_job_slot ON discovery_jobs((1)) WHERE ${occupied};
    `);
    store.transaction(() => {
      if (
        !store.db
          .prepare('PRAGMA table_info(discovery_jobs)')
          .all()
          .some((c) => c.name === 'recovery_since')
      )
        store.db.exec('ALTER TABLE discovery_jobs ADD COLUMN recovery_since INTEGER');
    });
  }
  register(lane: DiscoveryLane, adapter: DiscoveryAdapter) {
    if (this.adapters.has(lane)) throw Error('Discovery lane already registered');
    this.adapters.set(lane, adapter);
    adapter.store.project({
      read: (configuration) => {
        if (!configuration?.runnerSchema) return configuration;
        const clean = { ...configuration };
        for (const key of fields[lane]) delete clean[key];
        return {
          ...clean,
          active: null,
          ...(lane === 'quick' ? { pending: null } : {}),
          ...this.job(lane)?.work,
        };
      },
      write: (state) => {
        if (!state?.runnerSchema) return state;
        this.store.fence();
        const configuration = { ...state };
        const work = Object.fromEntries(
          fields[lane].filter((key) => state[key] !== undefined).map((key) => [key, state[key]]),
        ) as DiscoveryWorkByLane[typeof lane];
        for (const key of fields[lane]) delete configuration[key];
        const job = this.job(lane);
        if (job) {
          if (work.active && work.active.id !== job.id)
            throw Error('Discovery job identity changed');
          this.store.db
            .prepare('UPDATE discovery_jobs SET work=? WHERE id=?')
            .run(JSON.stringify(work), job.id);
        } else if (Object.values(work).some((value) => value != null && value !== false)) {
          throw Error('No discovery job owns this working state');
        }
        return configuration;
      },
    });
  }
  job<L extends DiscoveryLane>(lane: L): DiscoveryJob<L> | undefined {
    const row = this.store.db
      .prepare("SELECT * FROM discovery_jobs WHERE lane=? AND state!='done'")
      .get(lane);
    return (
      row && {
        id: String(row.id),
        lane,
        state: row.state as State,
        startedAt: Number(row.started_at),
        work: JSON.parse(String(row.work)) as DiscoveryWorkByLane[L],
      }
    );
  }
  get dispatching() {
    return this.ticking;
  }
  running(lane: DiscoveryLane) {
    return this.tasks.get(lane);
  }
  unregister(lane: DiscoveryLane) {
    if (this.tasks.has(lane)) throw Error('Discovery lane still has a live observer');
    this.adapters.delete(lane);
  }
  private set(job: DiscoveryJob, state: State, error?: unknown) {
    this.store.fence();
    const current = this.job(job.lane);
    if (current?.id !== job.id) throw Error('Discovery job ownership changed');
    this.store.db
      .prepare(`UPDATE discovery_jobs SET state=?,owner=?,error=?,
        recovery_since=CASE WHEN ?='recovering' THEN COALESCE(recovery_since,?) ELSE NULL END
        WHERE id=?`)
      .run(
        state,
        this.store.owner,
        error === undefined ? null : String(error),
        state,
        this.now(),
        job.id,
      );
  }
  abandoned(id: string) {
    return !!this.store.db
      .prepare("SELECT 1 FROM discovery_jobs WHERE id=? AND outcome='abandoned'")
      .get(id);
  }
  private recoverySince(job: DiscoveryJob) {
    return Number(
      this.store.db.prepare('SELECT recovery_since FROM discovery_jobs WHERE id=?').get(job.id)!
        .recovery_since,
    );
  }
  private abandon(job: DiscoveryJob, adapter: DiscoveryAdapter) {
    const stop = this.store.transaction(() => {
      this.store.fence();
      const cancel = adapter.abandon(job);
      this.finish(job, 'abandoned');
      this.store.db.prepare('DELETE FROM discovery_requests WHERE lane=?').run(job.lane);
      return cancel;
    });
    // Stopping can fail or never answer. Old outputs are already discarded and the
    // next ordinary cycle will use a fresh worker, so cancellation cannot hold the slot.
    void Promise.resolve()
      .then(stop)
      .catch(() => {});
  }
  private async recover(job: DiscoveryJob, adapter: DiscoveryAdapter) {
    const timeout = new AbortController();
    try {
      return await Promise.race([
        (async () => {
          const recovered = await adapter.recovery(job);
          adapter.ready();
          if (!recovered) return;
          const admission = await this.readExecution(recovered.agent, recovered.messageId);
          if (!admission) throw Error('Host has not resolved this discovery submission');
          if (admission.state === 'owned') {
            const snapshot = await recovered.agent.snapshot();
            if (snapshot.root?.kind === 'reserved')
              throw Error('Discovery Host is still recovering');
          }
          return { ...recovered, admission };
        })(),
        delay(Math.max(0, recoveryTimeoutMs - (this.now() - this.recoverySince(job))), undefined, {
          signal: AbortSignal.any([timeout.signal, adapter.signal]),
        }).then(() => {
          throw Error('Discovery recovery timed out');
        }),
      ]);
    } finally {
      timeout.abort();
    }
  }
  request(lane: DiscoveryLane) {
    this.store.transaction(() => {
      this.store.fence();
      this.store.db
        .prepare('INSERT OR IGNORE INTO discovery_requests(lane,queued_at) VALUES(?,?)')
        .run(lane, Date.now());
    });
  }
  withdraw(lane: DiscoveryLane) {
    this.store.transaction(() => {
      this.store.fence();
      this.store.db.prepare('DELETE FROM discovery_requests WHERE lane=?').run(lane);
    });
  }
  waiting(lane: DiscoveryLane) {
    return !!this.store.db.prepare('SELECT 1 FROM discovery_requests WHERE lane=?').get(lane);
  }
  /** Start from an idle configuration; old execution formats are not converted. */
  initialize() {
    this.store.transaction(() => {
      this.store.fence();
      for (const [lane, adapter] of this.adapters) {
        const configuration = adapter.store.configuration();
        if (!configuration || configuration.runnerSchema) continue;
        requireIdleDiscovery(configuration);
        for (const key of fields[lane]) delete configuration[key];
        delete configuration.recovery;
        configuration.runnerSchema = 1;
        adapter.store.saveConfiguration(configuration);
      }
    });
  }
  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = this.dispatch().finally(() => {
      this.ticking = undefined;
    });
    return this.ticking;
  }
  private async dispatch() {
    for (const adapter of this.adapters.values()) adapter.ready();
    try {
      this.initialize();
      this.initializationError = undefined;
    } catch (error) {
      this.initializationError = String(error);
      throw error;
    }
    // An interrupted admission is reconciled before a new investigation can start.
    for (const [lane, adapter] of this.adapters) {
      const job = this.job(lane);
      if (!job || job.state === 'retry_wait' || this.tasks.has(lane)) continue;
      try {
        // The business commit may succeed just before this owner's lease expires.
        // Reconcile that settlement before considering another attempt.
        if (job.state === 'settling' && !adapter.unfinished()) {
          this.finish(job, 'completed');
          continue;
        }
        this.set(job, 'recovering');
        const recovered = await this.recover(job, adapter);
        adapter.ready();
        if (!recovered) {
          adapter.defer(false);
          this.set(job, 'retry_wait');
          continue;
        }
        const { admission } = recovered;
        if (admission.state === 'not_admitted' || admission.state === 'cancelled') {
          adapter.defer(admission.state === 'cancelled');
          this.set(job, 'retry_wait');
          continue;
        }
        adapter.reattach();
        this.set(job, 'running');
        this.launch(job, adapter, recovered.agent);
      } catch (error) {
        adapter.ready();
        this.set(job, 'recovering', error);
        if (this.now() - this.recoverySince(job) >= recoveryTimeoutMs) this.abandon(job, adapter);
      }
    }
    for (const [lane, adapter] of this.adapters) {
      if (this.tasks.has(lane)) continue;
      try {
        if (await adapter.request()) this.request(lane);
        else this.withdraw(lane);
      } catch (error) {
        adapter.error(error);
        this.withdraw(lane);
      }
    }
    if (this.store.db.prepare(`SELECT 1 FROM discovery_jobs WHERE ${occupied}`).get()) return;
    const request = this.store.db
      .prepare('SELECT * FROM discovery_requests ORDER BY seq LIMIT 1')
      .get();
    if (!request) return;
    const lane = request.lane as DiscoveryLane;
    const adapter = this.adapters.get(lane);
    if (!adapter) return;
    const job = this.store.transaction(() => {
      this.store.fence();
      let current = this.job(lane);
      if (!current) {
        const id = randomUUID();
        this.store.db
          .prepare(
            'INSERT INTO discovery_jobs(id,lane,state,owner,started_at,work,memory_after) VALUES(?,?,?,?,?,?,?)',
          )
          .run(id, lane, 'preparing', this.store.owner, Date.now(), '{}', this.sequence());
        current = this.job(lane)!;
      } else this.set(current, 'preparing');
      this.store.db.prepare('DELETE FROM discovery_requests WHERE lane=?').run(lane);
      return current;
    });
    try {
      const agent = await adapter.prepare(job);
      adapter.ready();
      if (!agent) {
        this.set(job, 'retry_wait');
        return;
      }
      this.launch(job, adapter, agent);
    } catch (error) {
      adapter.error(error);
      this.set(job, 'retry_wait', error);
    }
  }
  private launch(job: DiscoveryJob, adapter: DiscoveryAdapter, agent: DiscoveryAgent) {
    let outcome: void | 'deferred';
    const task = adapter
      .run(agent)
      .then((value) => {
        outcome = value;
      })
      .finally(() => {
        this.tasks.delete(job.lane);
        adapter.ready();
        const current = this.job(job.lane);
        if (current?.id !== job.id) throw Error('Discovery job changed during execution');
        if (!adapter.unfinished()) {
          this.finish(job, outcome === 'deferred' ? 'interrupted' : 'completed');
        } else {
          this.set(job, current.state === 'settling' ? 'retry_wait' : 'recovering');
          if (current.state === 'settling')
            this.store.db
              .prepare(
                'UPDATE discovery_jobs SET finished_at=?,memory_through=?,outcome=? WHERE id=?',
              )
              .run(Date.now(), this.sequence(), 'interrupted', job.id);
        }
      });
    // Closing a retiring Host can fence the observer's final callback.
    const observed = task.catch(() => {});
    this.tasks.set(job.lane, observed);
  }
  private finish(job: DiscoveryJob, outcome: 'completed' | 'interrupted' | 'abandoned') {
    this.store.fence();
    this.store.db
      .prepare(
        "UPDATE discovery_jobs SET state='done',finished_at=?,memory_through=?,outcome=? WHERE id=?",
      )
      .run(Date.now(), this.sequence(), outcome, job.id);
  }
  /** Validate plugin adapters against the Host query contract, including older inbox replies. */
  async readExecution(agent: Pick<DiscoveryAgent, 'messageExecution'>, messageId: string) {
    const execution = await agent.messageExecution(messageId);
    switch (execution?.state) {
      case undefined:
        return undefined;
      case 'pending':
      case 'inbox':
      case 'cancelled':
      case 'not_admitted':
      case 'owned':
        return execution;
      default:
        throw Error('Unexpected Host message execution state');
    }
  }
  /** Shared exact-message observer. It never equates physical Host detach with completion. */
  async execute(
    lane: DiscoveryLane,
    agent: DiscoveryAgent,
    submission: { messageId: string; input?: string },
    signal: AbortSignal,
  ) {
    const adapter = this.adapters.get(lane)!;
    const job = this.job(lane);
    if (!job) throw Error('No discovery execution');
    adapter.ready();
    const admission = await this.readExecution(agent, submission.messageId);
    if (!admission) throw Error('Discovery admission is not yet known');
    if (admission.state === 'not_admitted') {
      if (!submission.input) throw Error('An unadmitted discovery has no saved input');
      this.set(job, 'preparing');
      const result = await agent.followup(submission.input, { messageId: submission.messageId });
      if (!['turn_started', 'followup'].includes(result?.disposition))
        throw Error('Host rejected discovery wake');
    }
    for (;;) {
      signal.throwIfAborted();
      adapter.ready();
      const execution = await this.readExecution(agent, submission.messageId);
      if (!execution) throw Error('Discovery admission is not yet known');
      if (execution?.state === 'owned') break;
      if (execution?.state === 'cancelled') {
        this.set(job, 'settling');
        throw new DiscoveryExecutionEnded('Discovery wake was cancelled');
      }
      await delay(50, undefined, { signal });
    }
    this.set(job, 'running');
    for (;;) {
      // A handoff may keep whenIdle unresolved. Inspect the Host while waiting,
      // without treating a healthy long run or user interaction as recovery failure.
      const waiting = new AbortController();
      let idle: { failure?: unknown } | undefined;
      const observed = agent.whenIdle(AbortSignal.any([signal, waiting.signal])).then(
        () => (idle = {}),
        (failure: unknown) => (idle = { failure }),
      );
      let snapshot;
      try {
        do {
          await Promise.race([observed, delay(1000, undefined, { signal: waiting.signal })]);
          signal.throwIfAborted();
          adapter.ready();
          snapshot = await agent.snapshot();
          if (snapshot.root?.kind === 'reserved') throw Error('Discovery Host is still recovering');
        } while (!idle);
      } finally {
        waiting.abort();
      }
      const failure = idle?.failure;
      signal.throwIfAborted();
      adapter.ready();
      if (awaitingUser(snapshot)) {
        if (failure) throw failure;
        await delay(1000, undefined, { signal });
        continue;
      }
      const status = snapshot.agent?.status;
      if (status && ['failed', 'aborted', 'blocked'].includes(status)) {
        this.set(job, 'settling');
        throw new DiscoveryExecutionEnded(
          failure ? String(failure) : `Discovery ended with ${status}`,
        );
      }
      if (failure) throw failure;
      if (snapshot?.agent?.status === 'running' || snapshot.root?.kind === 'active') {
        await delay(50, undefined, { signal });
        continue;
      }
      this.set(job, 'settling');
      return;
    }
  }
  previous() {
    const row = this.store.db
      .prepare(
        'SELECT * FROM discovery_jobs WHERE finished_at IS NOT NULL ORDER BY finished_at DESC,rowid DESC LIMIT 1',
      )
      .get();
    return row
      ? {
          lane: row.lane,
          outcome: row.outcome,
          startedAt: row.started_at,
          finishedAt: row.finished_at,
          memory: {
            view: 'history',
            afterSequence: row.memory_after,
            throughSequence: row.memory_through,
          },
        }
      : null;
  }
  status() {
    const active = this.store.db
      .prepare(`SELECT lane,started_at FROM discovery_jobs WHERE ${occupied}`)
      .get();
    const recovering = Object.fromEntries(
      this.store.db
        .prepare("SELECT lane,recovery_since,error FROM discovery_jobs WHERE state='recovering'")
        .all()
        .map((row) => [row.lane, { since: row.recovery_since, reason: row.error }]),
    );
    return {
      running: active ? { lane: active.lane, startedAt: active.started_at } : null,
      recovering,
      waiting: this.store.db
        .prepare('SELECT lane,queued_at AS queuedAt FROM discovery_requests ORDER BY seq')
        .all(),
      previous: this.previous(),
      ...(this.initializationError ? { initializationError: this.initializationError } : {}),
    };
  }
}
