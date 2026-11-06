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

export type DiscoveryLane = 'broad' | 'quick';
type State = 'preparing' | 'running' | 'settling' | 'recovering' | 'retry_wait' | 'done';
export interface DiscoveryJob {
  id: string;
  lane: DiscoveryLane;
  state: State;
  startedAt: number;
  work: any;
}
export interface DiscoveryAdapter {
  store: InitiativeStore;
  ready(): void;
  request(): Promise<boolean>;
  prepare(job: DiscoveryJob): Promise<any | undefined>;
  recovery(): Promise<{ agent: any; messageId: string } | undefined>;
  reattach(): void;
  defer(cancelled: boolean): void;
  unfinished(): boolean;
  run(agent: any): Promise<void | 'deferred'>;
  error(error: unknown): void;
}

const fields: Record<DiscoveryLane, readonly string[]> = {
  broad: ['active', 'pendingDraft', 'pendingJudgement', 'candidateReport', 'retry', 'contextWake'],
  quick: ['active', 'pending', 'contextWake'],
};
const occupied = "state IN ('preparing','running','settling','recovering')";

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
        const work: any = {};
        for (const key of fields[lane]) {
          if (state[key] !== undefined) work[key] = state[key];
          delete configuration[key];
        }
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
  job(lane: DiscoveryLane): DiscoveryJob | undefined {
    const row = this.store.db
      .prepare("SELECT * FROM discovery_jobs WHERE lane=? AND state!='done'")
      .get(lane);
    return (
      row && {
        id: String(row.id),
        lane,
        state: row.state as State,
        startedAt: Number(row.started_at),
        work: JSON.parse(String(row.work)),
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
      .prepare('UPDATE discovery_jobs SET state=?,owner=?,error=? WHERE id=?')
      .run(state, this.store.owner, error === undefined ? null : String(error), job.id);
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
        const recovered = await adapter.recovery();
        adapter.ready();
        if (!recovered) {
          adapter.defer(false);
          this.set(job, 'retry_wait');
          continue;
        }
        const admission = await recovered.agent.messageExecution(recovered.messageId);
        adapter.ready();
        if (
          !admission ||
          !['owned', 'pending', 'inbox', 'completed', 'not_admitted', 'cancelled'].includes(
            admission.state,
          )
        ) {
          this.set(job, 'recovering', 'Host has not resolved this discovery submission');
          continue;
        }
        if (admission.state === 'not_admitted' || admission.state === 'cancelled') {
          adapter.defer(admission.state === 'cancelled');
          this.set(job, 'retry_wait');
          continue;
        }
        adapter.reattach();
        this.set(job, 'running');
        this.launch(job, adapter, recovered.agent);
      } catch (error) {
        this.set(job, 'recovering', error);
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
  private launch(job: DiscoveryJob, adapter: DiscoveryAdapter, agent: any) {
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
  private finish(job: DiscoveryJob, outcome: 'completed' | 'interrupted') {
    this.store.fence();
    this.store.db
      .prepare(
        "UPDATE discovery_jobs SET state='done',finished_at=?,memory_through=?,outcome=? WHERE id=?",
      )
      .run(Date.now(), this.sequence(), outcome, job.id);
  }
  /** Shared exact-message observer. It never equates physical Host detach with completion. */
  async execute(
    lane: DiscoveryLane,
    agent: any,
    submission: { messageId: string; input?: string },
    signal: AbortSignal,
  ) {
    const adapter = this.adapters.get(lane)!;
    const job = this.job(lane);
    if (!job) throw Error('No discovery execution');
    adapter.ready();
    const admission = await agent.messageExecution(submission.messageId);
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
      const execution = await agent.messageExecution(submission.messageId);
      if (['owned', 'completed'].includes(execution?.state)) break;
      if (execution?.state === 'cancelled') {
        this.set(job, 'settling');
        throw new DiscoveryExecutionEnded('Discovery wake was cancelled');
      }
      await delay(50, undefined, { signal });
    }
    this.set(job, 'running');
    for (;;) {
      let failure: unknown;
      try {
        await agent.whenIdle(signal);
      } catch (error) {
        failure = error;
      }
      signal.throwIfAborted();
      adapter.ready();
      const snapshot = await agent.snapshot();
      if (awaitingUser(snapshot) || snapshot.root?.kind === 'reserved') {
        if (failure) throw failure;
        await delay(1000, undefined, { signal });
        continue;
      }
      if (['failed', 'aborted', 'blocked'].includes(snapshot?.agent?.status)) {
        this.set(job, 'settling');
        throw new DiscoveryExecutionEnded(
          failure ? String(failure) : `Discovery ended with ${snapshot.agent.status}`,
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
        .prepare("SELECT lane,started_at,error FROM discovery_jobs WHERE state='recovering'")
        .all()
        .map((row) => [row.lane, { since: row.started_at, reason: row.error }]),
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
