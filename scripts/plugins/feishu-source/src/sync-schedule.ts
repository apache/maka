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
import { hash } from './message-cache.js';
import type { MessageSync } from './message-sync.js';

/** Source I/O only. No model, index checkpoint or automatic history import. */
export class SyncSchedule {
  private owner = randomUUID();
  private abort = new AbortController();
  private running?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private scope: string;
  constructor(
    readonly sync: MessageSync,
    readonly defaults: any = {},
  ) {
    this.scope = hash(sync.cache.scope);
    sync.cache.db.exec(`CREATE TABLE IF NOT EXISTS sync_schedule (
      id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sync_schedule_lease (
      id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, until_at INTEGER NOT NULL);`);
  }
  get() {
    const row = this.sync.cache.db.prepare('SELECT payload FROM sync_schedule WHERE id=1').get();
    const s = row ? JSON.parse(String(row.payload)) : { enabled: false };
    return {
      ...s,
      ...(s.scope && s.scope !== this.scope
        ? {
            enabled: false,
            error: '来源范围已改变，请重新开启同步；已发布原文保留。',
            scopeChanged: true,
          }
        : {}),
      running: !!this.running,
      notice:
        '同步只检查所示时间和聊天范围；不保证更早消息的修改或删除已被发现。索引整理独立进行。',
    };
  }
  private save(s: any) {
    this.sync.cache.db
      .prepare(
        'INSERT INTO sync_schedule VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',
      )
      .run(JSON.stringify(s));
  }
  async control(input: any, call: any) {
    let old = this.get();
    if (input.action === 'pause') {
      this.save({ ...old, enabled: false, checkRequested: false });
      return this.get();
    }
    await this.sync.verify({ invocation: call });
    old = this.get();
    const intervalMinutes =
      input.intervalMinutes ?? old.intervalMinutes ?? this.defaults.syncIntervalMinutes ?? 30;
    const overlapHours =
      input.overlapHours ?? old.overlapHours ?? this.defaults.syncOverlapHours ?? 24;
    if (
      !Number.isInteger(intervalMinutes) ||
      intervalMinutes < 5 ||
      intervalMinutes > 1440 ||
      !Number.isInteger(overlapHours) ||
      overlapHours < 1 ||
      overlapHours > 168
    )
      throw Error('Invalid sync cadence or overlap');
    if (this.running) throw Error('同步正在进行，请稍后修改设置。');
    const s = old.scopeChanged ? {} : old;
    this.save({
      ...s,
      scope: this.scope,
      intervalMinutes,
      overlapHours,
      enabled: input.action === 'enable' ? true : !!s.enabled,
      checkRequested: true,
      invocation: { sessionId: call.sessionId, cwd: call.cwd },
      nextAt: Date.now(),
      error: null,
    });
    void this.tick();
    return this.get();
  }
  start() {
    this.timer = setInterval(() => void this.tick(), 10000);
    this.timer.unref?.();
    void this.tick();
  }
  tick(): Promise<void> {
    if (this.running || this.abort.signal.aborted) return this.running ?? Promise.resolve();
    const s = this.get();
    if (s.scopeChanged || (!s.enabled && !s.checkRequested) || s.nextAt > Date.now())
      return Promise.resolve();
    const db = this.sync.cache.db;
    const claimed = db
      .prepare(`INSERT INTO sync_schedule_lease VALUES(1,?,?)
      ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,until_at=excluded.until_at
      WHERE sync_schedule_lease.until_at<=? OR sync_schedule_lease.owner=?`)
      .run(this.owner, Date.now() + 30000, Date.now(), this.owner);
    if (!claimed.changes) return Promise.resolve();
    this.running = this.run(s).finally(() => {
      db.prepare('DELETE FROM sync_schedule_lease WHERE owner=?').run(this.owner);
      this.running = undefined;
    });
    return this.running;
  }
  private async run(s: any) {
    const lease = setInterval(
      () =>
        this.sync.cache.db
          .prepare('UPDATE sync_schedule_lease SET until_at=? WHERE owner=?')
          .run(Date.now() + 30000, this.owner),
      10000,
    );
    lease.unref?.();
    const assertActive = () => {
      this.abort.signal.throwIfAborted();
      const row = this.sync.cache.db
        .prepare('SELECT owner,until_at FROM sync_schedule_lease WHERE id=1')
        .get();
      if (!row || row.owner !== this.owner) throw Error('Source sync ownership changed');
    };
    try {
      assertActive();
      const scope = this.sync.cache.scope;
      const endTime = Math.min(Math.floor(Date.now() / 1000), scope.endTime ?? Infinity);
      // A persisted partial request wins. After downtime include the gap plus the overlap.
      const range = s.pendingRange ?? {
        startTime: Math.max(
          scope.startTime ?? 0,
          Math.min(s.lastSuccessfulEnd ?? endTime, endTime) - s.overlapHours * 3600,
        ),
        endTime,
      };
      if (range.startTime >= range.endTime) throw Error('配置的消息时间范围内暂时没有可同步区间。');
      this.save({ ...s, pendingRange: range, lastAttemptAt: Date.now() });
      const result = await this.sync.sync(
        { ...range, refresh: true },
        {
          assertActive,
          invocation: {
            ...s.invocation,
            turnId: 'feishu-source-sync',
            toolCallId: randomUUID(),
            abortSignal: this.abort.signal,
          },
        },
      );
      if (result.status !== 'complete')
        throw Error(result.error ?? '同步未完成，将从已保存页面继续。');
      assertActive();
      this.save({
        ...this.get(),
        pendingRange: null,
        checkRequested: false,
        lastSuccessfulEnd: range.endTime,
        lastSuccessfulRange: range,
        lastSuccessAt: Date.now(),
        jobId: result.jobId,
        failures: 0,
        error: null,
        nextAt: Date.now() + s.intervalMinutes * 60000,
      });
    } catch (error) {
      // A newer owner alone may publish progress; shutdown keeps the last committed range.
      const owner = this.sync.cache.db
        .prepare('SELECT owner FROM sync_schedule_lease WHERE id=1')
        .get();
      if (owner?.owner !== this.owner) return;
      const current = this.get(),
        failures = (current.failures ?? 0) + 1;
      this.save({
        ...current,
        failures,
        error: String(error),
        nextAt: Date.now() + Math.min(3600000, 30000 * 2 ** Math.min(failures - 1, 7)),
      });
    } finally {
      clearInterval(lease);
    }
  }
  async close() {
    clearInterval(this.timer);
    this.abort.abort(Error('同步暂停，进度已保存'));
    await this.running;
  }
}
