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

// Build core/storage at both revisions and pass the baseline checkout. Timed
// requests use the public facade; query probes run outside the timing loop.
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

function seed(lease, count, mixed) {
  const db = lease.database;
  const canonical = db.prepare(`INSERT INTO usage_model_call_attempts
    (attempt_id, completed_at, session_id, logical_call_id, turn_id, call_kind,
     connection_slug, provider_id, model_id, latency_ms, status, usage_basis,
     input_tokens, output_tokens, cost_basis, cost_usd)
    VALUES (?, ?, 'session', 'logical', 'turn', 'main', ?, 'provider', ?, 1,
      'completed', 'reported', 10, 2, 'priced', 0.001)`);
  const legacy = db.prepare(
    'INSERT INTO usage_llm_calls(storage_key, id, ts, record_json) VALUES (?, ?, ?, ?)',
  );
  const tool = db.prepare(
    'INSERT INTO usage_tool_invocations(storage_key, id, ts, record_json) VALUES (?, ?, ?, ?)',
  );
  lease.transaction('write', () => {
    for (let i = 1; i <= count; i++) {
      const id = `row-${String(i).padStart(8, '0')}`;
      const model = `model-${i % 20}`;
      const connection = `connection-${i % 10}`;
      if (mixed && i % 3 === 0) {
        canonical.run(id, i, connection, model);
      } else {
        (mixed && i % 3 === 1 ? legacy : tool).run(
          id,
          id,
          i,
          JSON.stringify({
            providerId: 'provider',
            connectionSlug: connection,
            modelId: model,
            toolName: `tool-${i % 8}`,
            status: i % 7 === 0 ? 'error' : 'success',
            inputTokens: 10,
            outputTokens: 2,
            totalTokens: 12,
            costUsd: 0.001,
            latencyMs: 1,
            durationMs: 1,
          }),
        );
      }
    }
  });
}

function capture(db) {
  const prepare = db.prepare;
  const statements = [];
  db.prepare = function (sql) {
    const statement = prepare.call(this, sql);
    for (const method of ['all', 'get']) {
      const run = statement[method].bind(statement);
      statement[method] = (...args) => {
        statements.push({ sql, args });
        return run(...args);
      };
    }
    return statement;
  };
  return () => {
    db.prepare = prepare;
    return {
      aggregateQueries: statements.filter(({ sql }) => /\bGROUP\s+BY\b|\bSUM\s*\(/i.test(sql))
        .length,
      statements,
    };
  };
}

function comparable(result) {
  assert.equal(result.kind, 'screen');
  return { ...result.screen, revision: '' };
}

for (const [count, mixed] of [
  [1_000, false],
  [10_000, false],
  [50_000, false],
  [50_000, true],
]) {
  const directory = await mkdtemp(join(tmpdir(), 'maka-perf-statistics-'));
  const capability = await resolveStorageRoot({
    path: join(directory, 'root'),
    kind: 'interactive',
  });
  const cleanups = [];
  try {
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    cleanups.push(() => owner.close());
    const writer = await openInteractiveUsageStoresForWrite(owner.lease);
    cleanups.push(() => writer.close());
    const seedLease = acquireOperationalStateDatabase(capability.canonicalPath);
    try {
      seed(seedLease, count, mixed);
    } finally {
      seedLease.close();
    }
    await writer.close();
    await owner.close();

    const oldCapability = await baselineAuthority.resolveStorageRoot({
      path: capability.canonicalPath,
      kind: 'interactive',
    });
    const readerOwner = await tryAcquireInteractiveRootReader(capability);
    assert.ok(readerOwner);
    cleanups.push(() => readerOwner.close());
    const oldOwner = await baselineAuthority.tryAcquireInteractiveRootReader(oldCapability);
    assert.ok(oldOwner);
    cleanups.push(() => oldOwner.close());
    const stores = await openInteractiveUsageStoresForRead(readerOwner.lease);
    cleanups.push(() => stores.close());
    const oldStores = await baseline.openInteractiveUsageStoresForRead(oldOwner.lease);
    cleanups.push(() => oldStores.close());
    const lease = acquireOperationalStateDatabase(capability.canonicalPath);
    cleanups.push(() => lease.close());
    const oldLease = baselineDatabase.acquireOperationalStateDatabase(capability.canonicalPath);
    cleanups.push(() => oldLease.close());
    sqlite = lease.database.prepare('SELECT sqlite_version() AS version').get().version;

    const versions = [
      { name: 'before', read: (input) => oldStores.readUsageScreen(input), db: oldLease.database },
      { name: 'after', read: (input) => stores.readUsageScreen(input), db: lease.database },
    ];
    const scenario = `${count}/${mixed ? 'mixed' : 'tools'}`;
    const query = { range: { from: 0, to: count }, search: '', status: 'all' };
    const inputs = [
      { name: 'matching-search', query: { ...query, search: 'model' } },
      { name: 'no-match-search', query: { ...query, search: 'absentword' } },
      { name: 'status-change', query: { ...query, status: 'error' } },
      { name: 'range-change', query: { ...query, range: { from: 1, to: count } } },
      { name: 'revision-change', query, mutate: true },
    ];
    for (const input of inputs) {
      const samples = [[], []];
      for (let repetition = -3; repetition < 15; repetition++) {
        const results = [];
        const order = repetition % 2 === 0 ? [0, 1] : [1, 0];
        for (const i of order) {
          await versions[i].read({ kind: 'screen', query });
        }
        if (input.mutate) {
          // Trigger the existing invalidation authority with a real write,
          // outside timing, so both readers observe the same new snapshot.
          lease.transaction('write', () => {
            lease.database.exec(`UPDATE usage_tool_invocations
              SET record_json = json_set(record_json, '$.durationMs', ${repetition + 5})
              WHERE storage_key = 'row-00000002'`);
          });
        }
        for (const i of order) {
          const start = performance.now();
          results[i] = await versions[i].read({ kind: 'screen', query: input.query });
          if (repetition >= 0) samples[i].push(performance.now() - start);
        }
        assert.deepEqual(comparable(results[0]), comparable(results[1]));
      }
      for (let i = 0; i < versions.length; i++) {
        const timing = summarize(samples[i]);
        rows.push({ scenario, metric: `${versions[i].name}/${input.name}-ms`, ...timing });
        console.log(
          `${scenario} ${versions[i].name}/${input.name}: ${timing.median.toFixed(3)} ms median, ${timing.p95.toFixed(3)} ms p95`,
        );
      }
    }
    for (const version of versions) {
      for (const search of ['model', 'absentword']) {
        await version.read({ kind: 'screen', query });
        const finish = capture(version.db);
        try {
          await version.read({ kind: 'screen', query: { ...query, search } });
        } finally {
          profiles.push({ scenario, version: version.name, search, ...finish() });
        }
      }
    }
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup();
    await removeControlDirectory(capability.rootId);
    await rm(directory, { recursive: true, force: true });
  }
}
await report(
  'usage-statistics',
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
      'Same persisted SQLite fixture, alternating public readUsageScreen facades in one process. Untimed preparation loads the original range, then a timed search/status edit reuses that range; range-change and revision-change requests measure statistics cache misses. SQL probes and fixture writes are outside timing. No cold OS page-cache claim.',
    limits:
      'Synthetic local facade measurements exclude Host repair, wire/IPC and rendering. Exact activity count and page SQL are unchanged from main; first-range aggregation and sparse substring searches remain history-sized. A global revision means ongoing writes may prevent cache hits.',
    profiles,
  },
  rows,
);
