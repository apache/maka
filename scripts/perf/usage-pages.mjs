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

// Build core/storage at both revisions, then pass the baseline checkout path.
// Both real readers run against the same fixture, alternating timed requests.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { acquireOperationalStateDatabase } from '../../packages/storage/dist/operational-state-store.js';
import {
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
  tryAcquireInteractiveRootReader,
} from '../../packages/storage/dist/root-authority.js';
import {
  openInteractiveUsageStoresForRead,
  openInteractiveUsageStoresForWrite,
} from '../../packages/storage/dist/usage-stores.js';
import { removeControlDirectory } from '../../packages/storage/dist/__tests__/fixtures/control-directory-hygiene.js';
import { report, summarize } from './report.mjs';

assert.ok(process.argv[2], 'Pass a built baseline checkout');
const baselinePath = resolve(process.argv[2]);
const baseline = await import(
  pathToFileURL(join(baselinePath, 'packages/storage/dist/usage-stores.js')).href
);
const baselineAuthority = await import(
  pathToFileURL(join(baselinePath, 'packages/storage/dist/root-authority.js')).href
);
const baselineDatabase = await import(
  pathToFileURL(join(baselinePath, 'packages/storage/dist/operational-state-store.js')).href
);
const rows = [];
const profiles = [];
let sqlite;

function seed(lease, count, mixed, tied) {
  const db = lease.database;
  const inserts = [
    db.prepare(`INSERT INTO usage_model_call_attempts
      (attempt_id, completed_at, session_id, logical_call_id, turn_id, call_kind,
       connection_slug, provider_id, model_id, latency_ms, status, usage_basis,
       input_tokens, output_tokens, cost_basis, cost_usd)
      VALUES (?, ?, 'session', 'logical', ?, 'main', 'provider', 'provider', ?, 1,
        ?, 'reported', 10, 2, 'priced', 0.001)`),
    db.prepare('INSERT INTO usage_llm_calls(storage_key, id, ts, record_json) VALUES (?, ?, ?, ?)'),
    db.prepare(
      'INSERT INTO usage_tool_invocations(storage_key, id, ts, record_json) VALUES (?, ?, ?, ?)',
    ),
  ];
  const records = [];
  lease.transaction('write', () => {
    for (let i = 1; i <= count; i++) {
      const source = mixed ? (i - 1) % 3 : 2;
      const identity = `key-${String(i).padStart(8, '0')}`;
      const ts = tied ? 100 : i;
      const turnId = `turn-${i}`;
      const model = i % 7 === 0 ? 'ÄModel%_İ' : 'model';
      const status = i % 13 === 0 ? 'error' : 'success';
      const toolName = i % 11 === 0 ? 'Grep' : 'Read';
      if (source === 0) {
        inserts[source].run(
          identity,
          ts,
          turnId,
          model,
          status === 'error' ? 'failed' : 'completed',
        );
      } else {
        inserts[source].run(
          identity,
          `display-${i % 5}`,
          ts,
          JSON.stringify({
            sessionId: 'session',
            turnId,
            providerId: 'provider',
            modelId: model,
            toolName,
            status,
            durationMs: 1,
            inputTokens: 10,
            outputTokens: 2,
            totalTokens: 12,
            costUsd: 0.001,
            latencyMs: 1,
          }),
        );
      }
      records.push({ ts, source, identity, turnId });
    }
  });
  return records.sort(
    (a, b) =>
      b.ts - a.ts ||
      b.source - a.source ||
      Buffer.compare(Buffer.from(b.identity), Buffer.from(a.identity)),
  );
}

function capture(db) {
  const prepare = db.prepare;
  const statements = [];
  let lowerCalls = 0;
  db.function('usage_screen_lower', { deterministic: true }, (value) => {
    lowerCalls++;
    return String(value ?? '').toLowerCase();
  });
  db.prepare = function (sql) {
    const statement = prepare.call(this, sql);
    for (const method of ['all', 'get']) {
      const run = statement[method].bind(statement);
      statement[method] = (...args) => {
        const before = lowerCalls;
        const value = run(...args);
        statements.push({ sql, args, lowerCalls: lowerCalls - before });
        return value;
      };
    }
    return statement;
  };
  return () => {
    db.prepare = prepare;
    db.function('usage_screen_lower', { deterministic: true }, (value) =>
      String(value ?? '').toLowerCase(),
    );
    return {
      lowerCalls,
      statements: statements.map((statement) => ({
        ...statement,
        plan: prepare.call(db, `EXPLAIN QUERY PLAN ${statement.sql}`).all(...statement.args),
      })),
    };
  };
}

for (const [count, mixed, tied] of [
  [1_000, false, false],
  [10_000, false, false],
  [50_000, false, false],
  [50_000, true, true],
]) {
  const base = await mkdtemp(join(tmpdir(), 'maka-perf-usage-'));
  const capability = await resolveStorageRoot({ path: join(base, 'root'), kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  const writer = await openInteractiveUsageStoresForWrite(owner.lease);
  const seedLease = acquireOperationalStateDatabase(capability.canonicalPath);
  let records;
  try {
    records = seed(seedLease, count, mixed, tied);
  } finally {
    seedLease.close();
    await writer.close();
    await owner.close();
  }
  const readerOwner = await tryAcquireInteractiveRootReader(capability);
  const oldCapability = await baselineAuthority.resolveStorageRoot({
    path: capability.canonicalPath,
    kind: 'interactive',
  });
  const oldOwner = await baselineAuthority.tryAcquireInteractiveRootReader(oldCapability);
  assert.ok(readerOwner && oldOwner);
  const stores = await openInteractiveUsageStoresForRead(readerOwner.lease);
  const oldStores = await baseline.openInteractiveUsageStoresForRead(oldOwner.lease);
  const lease = acquireOperationalStateDatabase(capability.canonicalPath);
  const oldLease = baselineDatabase.acquireOperationalStateDatabase(capability.canonicalPath);
  try {
    sqlite = lease.database.prepare('SELECT sqlite_version() AS version').get().version;
    const scenario = `${count}/${mixed ? 'mixed' : 'tools'}/${tied ? 'tied' : 'spread'}`;
    const versions = [
      { name: 'before', db: oldLease.database, read: (input) => oldStores.readUsageScreen(input) },
      { name: 'after', db: lease.database, read: (input) => stores.readUsageScreen(input) },
    ];
    const query = { range: { from: 0, to: count }, search: '', status: 'all' };
    const screens = [];
    for (const version of versions) {
      const start = performance.now();
      const result = await version.read({ kind: 'screen', query });
      rows.push({
        scenario,
        metric: `${version.name}/first-screen-ms`,
        ...summarize([performance.now() - start]),
      });
      assert.equal(result.kind, 'screen');
      screens.push(result.screen);
    }
    assert.deepEqual({ ...screens[0], revision: '' }, { ...screens[1], revision: '' });
    const inputs = [];
    for (const [name, offset] of [
      ['second-page', 50],
      ['middle-page', Math.floor(count / 2)],
      ['tail-page', count - 51],
    ]) {
      const at = records[offset - 1];
      const requests = screens.map((screen) => ({
        kind: 'activity',
        query,
        revision: screen.revision,
        queryIdentity: screen.queryIdentity,
        cursor:
          name === 'second-page'
            ? screen.nextCursor
            : Buffer.from(
                JSON.stringify([
                  screen.queryIdentity,
                  at.ts,
                  ['canonical', 'legacy', 'tool'][at.source],
                  at.identity,
                ]),
              ).toString('base64url'),
      }));
      inputs.push({ name, requests });
      for (let i = 0; i < versions.length; i++) {
        const result = await versions[i].read(requests[i]);
        assert.equal(result.kind, 'activity');
        assert.deepEqual(
          result.page.logs.map((log) => log.turnId),
          records.slice(offset, offset + 50).map((row) => row.turnId),
        );
      }
    }
    for (const [name, search] of [
      ['screen', ''],
      ['no-match-screen', 'absentword'],
      ['filtered-screen', 'model'],
    ]) {
      inputs.push({
        name,
        requests: versions.map(() => ({ kind: 'screen', query: { ...query, search } })),
      });
    }
    const matching = await Promise.all(
      versions.map((version) =>
        version.read({
          kind: 'screen',
          query: { ...query, search: 'model' },
        }),
      ),
    );
    inputs.push({
      name: 'matching-second-page',
      requests: matching.map(({ screen }) => ({
        kind: 'activity',
        query: screen.query,
        revision: screen.revision,
        queryIdentity: screen.queryIdentity,
        cursor: screen.nextCursor,
      })),
    });
    for (const { name, requests } of inputs) {
      const samples = [[], []];
      for (let repetition = -3; repetition < 15; repetition++) {
        for (const i of repetition % 2 === 0 ? [0, 1] : [1, 0]) {
          const start = performance.now();
          await versions[i].read(requests[i]);
          if (repetition >= 0) samples[i].push(performance.now() - start);
        }
      }
      for (let i = 0; i < versions.length; i++) {
        const version = versions[i];
        const timing = summarize(samples[i]);
        rows.push({ scenario, metric: `${version.name}/${name}-ms`, ...timing });
        const finish = capture(version.db);
        try {
          await version.read(requests[i]);
        } finally {
          profiles.push({ scenario, version: version.name, operation: name, ...finish() });
        }
        console.log(
          `${scenario} ${version.name}/${name}: ${timing.median.toFixed(3)} ms median, ${timing.p95.toFixed(3)} ms p95`,
        );
      }
    }
  } finally {
    oldLease.close();
    lease.close();
    await oldStores.close();
    await stores.close();
    await oldOwner.close();
    await readerOwner.close();
    await removeControlDirectory(capability.rootId);
    await rm(base, { recursive: true, force: true });
  }
}
await report(
  'usage-pages',
  {
    baselineCommit: execFileSync('git', ['-C', baselinePath, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim(),
    currentDiff: execFileSync('git', ['diff', '--stat'], { encoding: 'utf8' }).trim(),
    sqlite,
    electron: process.versions.electron ?? null,
    warmup: 3,
    repetitions: 15,
    conditions:
      'Same temporary SQLite data, alternating public readUsageScreen facades in one process. First-screen samples use newly opened reader connections, not a cold OS page cache. Warm measurements include lease validation, query preparation and result mapping.',
    limits:
      'Synthetic persisted rows, no Host repair, wire encoding/transport or rendering. Deep cursors are supplied from known fixture positions; this does not measure random-page navigation. Full statistics, exact filtered counts and sparse search remain range-sized work. Search callbacks and SQL plans are collected outside timed runs; they are not physical row-visit counters.',
    profiles,
  },
  rows,
);
