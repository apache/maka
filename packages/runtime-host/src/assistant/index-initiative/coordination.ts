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
import type { InitiativeStore } from './store.js';

type Lane = 'broad' | 'quick';
type Outcome = 'completed' | 'interrupted';

/** One non-preemptive investigation slot. Event receipt/screening never holds it. */
export class DiscoveryCoordinator {
  private readonly pendingReleases = new Map<string, Outcome | undefined>();
  /** Reattach an admitted investigation before accepting new FIFO work. */
  recoveryLane?: () => Lane | undefined;
  constructor(
    private readonly store: InitiativeStore,
    private readonly sequence: () => number,
  ) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS discovery_waiters(
        seq INTEGER PRIMARY KEY AUTOINCREMENT, lane TEXT NOT NULL UNIQUE, queued_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS discovery_running(
        id INTEGER PRIMARY KEY CHECK(id=1), token TEXT NOT NULL, owner TEXT NOT NULL,
        lane TEXT NOT NULL, started_at INTEGER NOT NULL, memory_after INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS discovery_previous(id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);
    `);
  }
  private remember(active: any, outcome: Outcome) {
    const throughSequence = this.sequence();
    const previous = {
      lane: active.lane,
      outcome,
      startedAt: Number(active.started_at),
      finishedAt: Date.now(),
      memory: {
        view: 'history',
        afterSequence: Number(active.memory_after),
        throughSequence,
      },
    };
    this.store.db
      .prepare(
        'INSERT INTO discovery_previous VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',
      )
      .run(JSON.stringify(previous));
  }
  recover() {
    this.store.transaction(() => {
      this.store.fence();
      const active = this.store.db.prepare('SELECT * FROM discovery_running WHERE id=1').get();
      if (active && active.owner !== this.store.owner) {
        this.remember(active, 'interrupted');
        this.store.db.exec('DELETE FROM discovery_running');
      }
    });
    for (const [token, outcome] of this.pendingReleases) this.release(token, outcome);
  }
  acquire(lane: Lane): string | undefined {
    return this.store.transaction(() => {
      this.store.fence();
      this.store.db
        .prepare('INSERT OR IGNORE INTO discovery_waiters(lane,queued_at) VALUES(?,?)')
        .run(lane, Date.now());
      const recovering = this.recoveryLane?.();
      if (recovering && recovering !== lane) return;
      if (this.store.db.prepare('SELECT 1 FROM discovery_running').get()) return;
      const next = this.store.db
        .prepare('SELECT lane FROM discovery_waiters ORDER BY seq LIMIT 1')
        .get();
      if (next?.lane !== lane && recovering !== lane) return;
      const token = randomUUID();
      this.store.db.prepare('DELETE FROM discovery_waiters WHERE lane=?').run(lane);
      this.store.db
        .prepare('INSERT INTO discovery_running VALUES(1,?,?,?,?,?)')
        .run(token, this.store.owner, lane, Date.now(), this.sequence());
      return token;
    });
  }
  withdraw(lane: Lane) {
    this.store.transaction(() => {
      this.store.fence();
      this.store.db.prepare('DELETE FROM discovery_waiters WHERE lane=?').run(lane);
    });
  }
  waiting(lane: Lane) {
    return !!this.store.db.prepare('SELECT 1 FROM discovery_waiters WHERE lane=?').get(lane);
  }
  assertActive(token: string) {
    this.store.fence();
    if (
      !this.store.db
        .prepare('SELECT 1 FROM discovery_running WHERE token=? AND owner=?')
        .get(token, this.store.owner)
    )
      throw Error('Discovery coordination ownership changed');
  }
  release(token: string, outcome?: Outcome) {
    const settled = this.store.transaction(() => {
      // A retiring Host cannot release its successor's reservation.
      const lease = this.store.db.prepare('SELECT * FROM lease WHERE id=1').get();
      if (lease?.owner !== this.store.owner) return true;
      if (Number(lease.until_at) <= Date.now()) return false;
      const active = this.store.db
        .prepare('SELECT * FROM discovery_running WHERE token=? AND owner=?')
        .get(token, this.store.owner);
      if (!active) return true;
      if (outcome) this.remember(active, outcome);
      this.store.db.prepare('DELETE FROM discovery_running WHERE token=?').run(token);
      return true;
    });
    if (settled) this.pendingReleases.delete(token);
    else this.pendingReleases.set(token, outcome);
  }
  previous(): any {
    const row = this.store.db.prepare('SELECT payload FROM discovery_previous WHERE id=1').get();
    return row ? JSON.parse(String(row.payload)) : null;
  }
  status() {
    const active = this.store.db.prepare('SELECT lane,started_at FROM discovery_running').get();
    return {
      running: active ? { lane: active.lane, startedAt: active.started_at } : null,
      waiting: this.store.db
        .prepare('SELECT lane,queued_at AS queuedAt FROM discovery_waiters ORDER BY seq')
        .all(),
      previous: this.previous(),
    };
  }
}
