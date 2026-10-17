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

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, rm, statfs, writeFile } from 'node:fs/promises';
import { setImmediate as yieldEventLoop } from 'node:timers/promises';
import { cpus, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { decodeRuntimeEvent } from '../../packages/core/dist/runtime-event.js';
import { acquireOperationalStateDatabase } from '../../packages/storage/dist/operational-state-store.js';
import {
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
} from '../../packages/storage/dist/root-authority.js';
import { createSqliteRuntimeStore } from '../../packages/storage/dist/sqlite-runtime-store.js';
import { rebuildTranscriptTurnExtents } from '../../packages/storage/dist/runtime-transcript-query.js';
import {
  ColdRuntimeStorage,
  COLD_STORAGE_AGE_MS,
  decodeRuntimePayloadJson,
} from '../../packages/storage/dist/cold-runtime-storage.js';
import { upgradeRuntimeStorageAtStartup } from '../../packages/storage/dist/runtime-storage-upgrade.js';
import { TranscriptStorageWorker } from '../../packages/runtime-host/dist/server/transcript-storage-worker-client.js';
import { createSessionTranscriptReader } from '../../packages/runtime-host/dist/server/session-transcript-reader.js';

const { values } = parseArgs({
  options: {
    source: { type: 'string' },
    output: { type: 'string' },
    samples: { type: 'string', default: '1001' },
    'auto-vacuum': { type: 'string', default: 'incremental' },
    'copy-source': { type: 'boolean', default: false },
  },
});
if (!values.source || !values.output)
  throw new Error(
    'Required: --source SQLITE --output NEW_DIRECTORY [--samples 1001] [--auto-vacuum none|incremental] [--copy-source]',
  );
const samples = Number(values.samples);
assert.ok(Number.isSafeInteger(samples) && samples >= 10);
assert.ok(['none', 'incremental'].includes(values['auto-vacuum']));
const sourcePath = resolve(values.source);
const output = resolve(values.output);
await mkdir(output); // Refuse reuse: source and prior evidence are never overwritten.
const repo = fileURLToPath(new URL('../..', import.meta.url));
const files = execFileSync(
  'git',
  [
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
    '--',
    'packages/storage/src',
    'packages/storage/package.json',
    'packages/runtime-host/src/server',
    'scripts/cold-runtime-storage.mjs',
    'scripts/perf/cold-runtime-storage.mjs',
    'package-lock.json',
  ],
  { cwd: repo, encoding: 'utf8' },
)
  .trim()
  .split('\n')
  .sort();
const sourceFiles = {};
for (const file of files)
  sourceFiles[file] = createHash('sha256')
    .update(await readFile(join(repo, file)))
    .digest('hex');
const buildIdentity = {
  head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  files: sourceFiles,
  sha256: createHash('sha256').update(JSON.stringify(sourceFiles)).digest('hex'),
};
await writeFile(join(output, 'build-identity.json'), JSON.stringify(buildIdentity, null, 2) + '\n');
const root = join(output, 'root');
const sourceHash = await fileHash(sourcePath);
const source = new DatabaseSync(sourcePath, { readOnly: true });
const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
const owner = await tryAcquireInteractiveRootOwner(capability);
assert.ok(owner);
let database, runtime, worker, compressionWorker, cold;
const report = {
  source: {
    path: sourcePath,
    sha256: sourceHash,
    provenance: values['copy-source']
      ? 'Complete SQLite file copied into an isolated root and upgraded through the production owner; all source tables retained. Original source remains read-only.'
      : 'Caller-supplied RuntimeEvent corpus. Replayed exact event JSON into a fresh current-schema fixture; source remains read-only. This is not a full source-schema migration.',
  },
  environment: {
    node: process.version,
    cpu: cpus()[0]?.model,
    memory: totalmem(),
    platform: process.platform,
    head: buildIdentity.head,
    sourceSha256: buildIdentity.sha256,
    initialAutoVacuum: values['auto-vacuum'],
    workers:
      'One lazy foreground read worker, one lazy compression worker; maintenance concurrency remains one.',
  },
  samples,
};
try {
  const copyStart = performance.now();
  if (values['copy-source']) {
    await copyFile(sourcePath, join(root, 'runtime.sqlite'), constants.COPYFILE_FICLONE);
    assert.equal(
      source.prepare('PRAGMA auto_vacuum').get().auto_vacuum,
      values['auto-vacuum'] === 'none' ? 0 : 2,
    );
  } else if (values['auto-vacuum'] === 'none') {
    await mkdir(root, { recursive: true });
    const existing = new DatabaseSync(join(root, 'runtime.sqlite'));
    existing.exec('PRAGMA auto_vacuum = NONE; VACUUM');
    existing.close();
  }
  database = acquireOperationalStateDatabase(root);
  let db = database.database;
  if (!values['copy-source']) {
    const insert =
      db.prepare(`INSERT INTO runtime_events(event_id, session_id, invocation_id, run_id, turn_id,
    event_seq, event_kind, payload_json, committed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    let imported = 0;
    const rows = source.prepare('SELECT * FROM runtime_events ORDER BY rowid').iterate();
    const start = performance.now();
    let batch = [];
    const flush = () => {
      database.transaction('write', () => {
        for (const row of batch) {
          // Validate the corpus against today's domain decoder without changing its source bytes.
          decodeRuntimeEvent(JSON.parse(row.payload_json));
          insert.run(
            row.event_id,
            row.session_id,
            row.invocation_id,
            row.run_id,
            row.turn_id,
            row.event_seq,
            row.event_kind,
            row.payload_json,
            row.committed_at,
          );
        }
      });
      imported += batch.length;
      batch = [];
    };
    for (const row of rows) {
      batch.push(row);
      if (batch.length === 1024) flush();
    }
    if (batch.length) flush();
    // Ordinals are durable ordering facts, not an INSERT trigger. Preserve them,
    // then rebuild today's derived Turn index through its production mapping.
    const ordinal = db.prepare(
      'INSERT INTO runtime_session_event_ordinals(session_id, ordinal, event_id) VALUES (?, ?, ?)',
    );
    database.transaction('write', () => {
      for (const row of source
        .prepare(
          'SELECT session_id, ordinal, event_id FROM runtime_session_event_ordinals ORDER BY session_id, ordinal',
        )
        .iterate())
        ordinal.run(row.session_id, row.ordinal, row.event_id);
      rebuildTranscriptTurnExtents(db);
    });
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    report.import = { records: imported, ms: performance.now() - start };
  } else {
    report.import = {
      records: Number(db.prepare('SELECT count(*) AS count FROM runtime_events').get().count),
      ms: performance.now() - copyStart,
      mode: 'whole_file_copy_and_schema_upgrade',
    };
  }
  console.log(JSON.stringify({ phase: 'import', ...report.import }));
  const beforeStartupDigest = corpusDigest(db);
  assert.deepEqual(beforeStartupDigest, corpusDigest(source));
  database.close();
  database = undefined;
  const upgradeStart = performance.now();
  const upgradeHeartbeat = monitor();
  report.startupUpgrade = {
    ...(await upgradeRuntimeStorageAtStartup(owner.lease, {
      onPhase: (phase) => {
        if (phase) console.log(JSON.stringify({ phase: 'startup-upgrade', step: phase }));
      },
    })),
    ms: performance.now() - upgradeStart,
    heartbeat: upgradeHeartbeat.stop(),
  };
  assert.notEqual(report.startupUpgrade.kind, 'deferred');
  assert.equal(report.startupUpgrade.mode, 2);
  database = acquireOperationalStateDatabase(root, { schemaMigration: 'require_current' });
  db = database.database;
  assert.deepEqual(corpusDigest(db), beforeStartupDigest);
  console.log(JSON.stringify({ phase: 'startup-upgrade-complete', ...report.startupUpgrade }));
  report.distribution = db
    .prepare(`SELECT event_kind, count(*) AS records,
    sum(length(CAST(payload_json AS BLOB))) AS bytes FROM runtime_events GROUP BY event_kind ORDER BY bytes DESC`)
    .all();
  report.rawDigest = corpusDigest(db);
  const busiest = db
    .prepare(
      'SELECT session_id, count(*) AS records FROM runtime_events GROUP BY session_id ORDER BY records DESC LIMIT 1',
    )
    .get();
  const sessionId = String(busiest.session_id);
  runtime = createSqliteRuntimeStore(join(root, 'runtime.sqlite'), { readOnly: true });
  const createReaderWorker = () =>
    new TranscriptStorageWorker({
      databasePath: join(root, 'runtime.sqlite'),
      permissions: async () => new Map(),
    });
  worker = createReaderWorker();
  compressionWorker = new TranscriptStorageWorker({
    databasePath: join(root, 'runtime.sqlite'),
    permissions: async () => new Map(),
  });
  cold = await ColdRuntimeStorage.open({
    lease: owner.lease,
    codec: compressionWorker.codec,
    canRun: () => !worker.reading,
    isProtected: (id) => worker.isProtected(id),
  });
  const createReader = () =>
    createSessionTranscriptReader({
      stores: {
        runtimeEventStore: runtime,
        agentRunStore: { readRootTurnAdmission: async () => undefined },
      },
      storageWorker: worker,
      canonicalPermissionOutcomes: { readPermissionOutcome: async () => undefined },
    });
  let reader = createReader();
  const throughSequence = await reader.readDurableHighWater(sessionId);
  assert.notEqual(throughSequence, null, 'fixture must contain the durable ordinal index');
  report.readScenario = {
    sessionId,
    records: busiest.records,
    throughSequence,
    cache:
      'OS cache is not purged. Each transcript phase starts a fresh lazy reader worker; subsequent samples are warm repeated reads. Scope is storage+decode+projection/page DTO, excludes transport and UI.',
  };
  const requests = [
    { direction: 'older', throughSequence, maxBytes: 256 * 1024, maxMessages: 128 },
    {
      direction: 'older',
      throughSequence,
      position: Math.floor(throughSequence / 2),
      maxBytes: 256 * 1024,
      maxMessages: 128,
    },
    { direction: 'newer', throughSequence, position: 0, maxBytes: 256 * 1024, maxMessages: 128 },
  ];
  const read = async (index) => {
    const page = await reader.readDurablePage(sessionId, requests[index % requests.length]);
    assert.ok(page.fragments.length > 0, 'latency must measure a populated transcript page');
    return pageDigest(page);
  };
  report.raw = await measure(read, samples);
  const recallSessions = db
    .prepare('SELECT DISTINCT session_id FROM runtime_events')
    .all()
    .map((row) => String(row.session_id));
  const measureRecall = async () => {
    const heartbeat = monitor();
    const cases = [];
    for (const term of ['storage', '上下文', 'maka-cold-probe-never-matches-20261015']) {
      const timings = [];
      let candidates;
      for (let trial = 0; trial < 3; trial++) {
        const start = performance.now();
        const current = (await worker.readRecallCandidates(recallSessions, [term])).sort();
        timings.push(performance.now() - start);
        if (candidates) assert.deepEqual(current, candidates);
        candidates = current;
      }
      cases.push({ term, timings, candidates });
    }
    return { cases, heartbeat: heartbeat.stop() };
  };
  report.recallRaw = await measureRecall();
  const runs = [1, Math.floor(throughSequence / 16), Math.floor(throughSequence / 8)].map(
    (position) =>
      String(
        db
          .prepare(`SELECT e.run_id FROM runtime_session_event_ordinals o JOIN runtime_events e ON e.event_id = o.event_id
      WHERE o.session_id = ? AND o.ordinal >= ? ORDER BY o.ordinal LIMIT 1`)
          .get(sessionId, position).run_id,
      ),
  );
  const replay = async (index) => {
    const events = await runtime.readRuntimeEvents(sessionId, runs[index % runs.length]);
    assert.ok(events.length > 0);
    return createHash('sha256').update(JSON.stringify(events)).digest('hex');
  };
  report.replayRaw = await measure(replay, samples);
  console.log(
    JSON.stringify({
      phase: 'raw-reads',
      transcript: report.raw.latency,
      replay: report.replayRaw.latency,
    }),
  );
  // A constructed pre-feature baseline isolates the one-time upgrade cost. It
  // is NOT the historical schema-20 fixture with its version number changed.
  const migrationRoot = join(output, 'migration-experiment');
  await mkdir(migrationRoot);
  const migrationPath = join(migrationRoot, 'runtime.sqlite');
  await database.backup(migrationPath);
  const baseline = new DatabaseSync(migrationPath);
  try {
    for (const row of baseline
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'cold_activity_%'",
      )
      .all())
      baseline.exec(`DROP TRIGGER "${row.name}"`);
    baseline.exec(`DROP INDEX runtime_cold_candidates; DROP INDEX runtime_encoded_candidates;
      DROP TABLE runtime_compression_checks; DROP TABLE runtime_storage_policy; DROP TABLE session_content_activity;
      PRAGMA user_version = 20; UPDATE operational_schema_migrations SET version = 2 WHERE scope = 'operational';`);
  } finally {
    baseline.close();
  }
  const migrationStart = performance.now();
  const upgraded = acquireOperationalStateDatabase(migrationRoot);
  report.migration = {
    ms: performance.now() - migrationStart,
    provenance:
      'Current native fixture with exactly this unreleased feature removed: runtime 20, operational 2; then upgraded by the production owner migrator.',
  };
  assert.deepEqual(corpusDigest(upgraded.database), report.rawDigest);
  upgraded.close();
  await rm(migrationRoot, { recursive: true, force: true });
  report.before = await cold.inspect();
  // Test-only aging after import; production never infers coldness from historical event timestamps.
  db.prepare('UPDATE session_content_activity SET last_content_write_at = ?').run(
    Date.now() - COLD_STORAGE_AGE_MS - 1,
  );
  await cold.setEnabled(true);
  const compression = {
    batches: 0,
    changed: 0,
    inputBytes: 0,
    rawBytes: 0,
    storedBytes: 0,
    maximumBatchMs: 0,
  };
  const compressionStart = performance.now();
  const heartbeat = monitor();
  for (;;) {
    const began = performance.now();
    const result = await cold.compressBatch();
    assert.equal(result.busy, false);
    assert.equal(result.failures, 0);
    compression.batches++;
    compression.changed += result.changed;
    compression.inputBytes += result.inputBytes;
    compression.rawBytes += result.rawBytes;
    compression.storedBytes += result.storedBytes;
    compression.maximumBatchMs = Math.max(compression.maximumBatchMs, performance.now() - began);
    if (compression.batches % 200 === 0)
      console.log(JSON.stringify({ phase: 'compress', ...compression }));
    if (!result.hasMore) break;
    assert.ok(compression.batches < 100000, 'maintenance must make bounded forward progress');
  }
  report.compression = {
    ...compression,
    ms: performance.now() - compressionStart,
    heartbeat: heartbeat.stop(),
    scheduling:
      'Offline back-to-back batches to measure total work; production charges input bytes at >=1 second per MiB and yields to execution/reads.',
  };
  report.compressedDigest = corpusDigest(db);
  assert.deepEqual(report.compressedDigest, report.rawDigest);
  await worker.close();
  worker = createReaderWorker();
  reader = createReader();
  report.compressed = await measure(read, samples);
  assert.deepEqual(report.compressed.digests, report.raw.digests);
  report.recallCompressed = await measureRecall();
  assert.deepEqual(
    report.recallCompressed.cases.map((value) => value.candidates),
    report.recallRaw.cases.map((value) => value.candidates),
  );
  report.replayCompressed = await measure(replay, samples);
  assert.deepEqual(report.replayCompressed.digests, report.replayRaw.digests);
  report.afterCompression = await cold.inspect();
  report.integrity = db.prepare('PRAGMA integrity_check').get();
  const spaceBefore = await statfs(root);
  {
    const heartbeat = monitor();
    const start = performance.now();
    const reclaim = { batches: 0, reclaimedPages: 0, maximumBatchMs: 0 };
    for (;;) {
      const start = performance.now();
      const result = await cold.reclaimFreePages({ maxPages: 64 });
      assert.equal(result.busy, false);
      assert.equal(result.pauseReason, undefined);
      assert.ok(result.reclaimedPages <= 64);
      reclaim.batches++;
      reclaim.reclaimedPages += result.reclaimedPages;
      reclaim.maximumBatchMs = Math.max(reclaim.maximumBatchMs, performance.now() - start);
      assert.ok(reclaim.batches < 100000);
      if (reclaim.batches % 500 === 0)
        console.log(JSON.stringify({ phase: 'incremental-reclaim', ...reclaim }));
      if (!result.hasMore) break;
    }
    report.incrementalReclamation = {
      ...reclaim,
      ms: performance.now() - start,
      heartbeat: heartbeat.stop(),
    };
    report.afterPageReclamation = await cold.inspect();
    assert.deepEqual(corpusDigest(db), report.rawDigest);
  }
  await cold.setEnabled(false);
  runtime.close();
  runtime = undefined;
  await worker.close();
  worker = undefined;
  await compressionWorker.close();
  compressionWorker = undefined;
  cold.close();
  cold = undefined;
  database.close();
  database = undefined;
  database = acquireOperationalStateDatabase(root, { schemaMigration: 'require_current' });
  assert.deepEqual(corpusDigest(database.database), report.rawDigest);
  cold = await ColdRuntimeStorage.open({
    lease: owner.lease,
    codec: async () => {
      throw new Error('No encoding during final reads');
    },
    canRun: () => false,
    isProtected: () => false,
  });
  report.finalStorage = await cold.inspect();
  assert.equal(report.finalStorage.autoVacuumMode, 2);
  assert.equal(report.finalStorage.writerEnabled, false);
  runtime = createSqliteRuntimeStore(join(root, 'runtime.sqlite'), { readOnly: true });
  worker = createReaderWorker();
  reader = createReader();
  report.reclaimedReads = await measure(read, samples);
  assert.deepEqual(report.reclaimedReads.digests, report.raw.digests);
  const spaceAfter = await statfs(root);
  report.reclaim = {
    kind: 'bounded_incremental',
    legacyStartupConverted: report.startupUpgrade.kind === 'converted',
    databaseBytesBefore: report.afterCompression.databaseBytes,
    databaseBytesAfter: report.finalStorage.databaseBytes,
    allocatedBytesBefore: report.afterCompression.allocatedDatabaseBytes,
    allocatedBytesAfter: report.finalStorage.allocatedDatabaseBytes,
    filesystemAvailableBytesBefore: spaceBefore.bavail * spaceBefore.bsize,
    filesystemAvailableBytesAfter: spaceAfter.bavail * spaceAfter.bsize,
  };
  runtime.close();
  runtime = undefined;
  await worker.close();
  worker = undefined;
  cold.close();
  cold = undefined;
  database.close();
  database = undefined;
  report.sourceUnchanged = (await fileHash(sourcePath)) === sourceHash;
  assert.equal(report.sourceUnchanged, true);
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify({
      report: join(output, 'report.json'),
      compression: report.compression,
      raw: report.raw.latency,
      compressed: report.compressed.latency,
      reclaimedReads: report.reclaimedReads.latency,
      reclaim: report.reclaim,
    }),
  );
} finally {
  runtime?.close();
  await Promise.all([worker?.close(), compressionWorker?.close()]);
  cold?.close();
  database?.close();
  source.close();
  await owner.close();
}

async function fileHash(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function corpusDigest(db) {
  const hash = createHash('sha256');
  let records = 0,
    bytes = 0;
  for (const row of db
    .prepare('SELECT event_id, payload_json FROM runtime_events ORDER BY event_id')
    .iterate()) {
    const json = decodeRuntimePayloadJson(row.payload_json);
    hash.update(row.event_id).update('\0').update(json).update('\0');
    records++;
    bytes += Buffer.byteLength(json);
  }
  return { records, bytes, sha256: hash.digest('hex') };
}

function pageDigest(page) {
  const hash = createHash('sha256');
  const { fragments, ...metadata } = page;
  hash.update(JSON.stringify(metadata));
  for (const { data, ...fragment } of fragments) hash.update(JSON.stringify(fragment)).update(data);
  return hash.digest('hex');
}

function monitor() {
  let previous = performance.now(),
    gap = 0,
    rss = process.memoryUsage().rss;
  const gaps = [];
  const timer = setInterval(() => {
    const now = performance.now();
    gap = Math.max(gap, now - previous);
    gaps.push(now - previous);
    previous = now;
    rss = Math.max(rss, process.memoryUsage().rss);
  }, 5);
  return {
    stop() {
      clearInterval(timer);
      const tail = performance.now() - previous;
      gap = Math.max(gap, tail);
      gaps.push(tail);
      gaps.sort((a, b) => a - b);
      return {
        maximumHeartbeatGapMs: gap,
        p99HeartbeatGapMs: gaps[Math.max(0, Math.ceil(gaps.length * 0.99) - 1)] ?? 0,
        heartbeatSamples: gaps.length,
        sampledPeakRss: rss,
      };
    },
  };
}

async function measure(read, count) {
  const values = [],
    digests = [],
    cases = [[], [], []];
  const heartbeat = monitor();
  const cpu = process.cpuUsage();
  for (let i = 0; i < count * cases.length; i++) {
    const start = performance.now();
    digests.push(await read(i));
    const elapsed = performance.now() - start;
    values.push(elapsed);
    cases[i % cases.length].push(elapsed);
    await yieldEventLoop();
  }
  const firstMs = values[0];
  const stats = (all) => {
    const sorted = all.slice(1).sort((a, b) => a - b);
    const quantile = (p) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
    return {
      firstMs: all[0],
      repeatedSamples: sorted.length,
      p50: quantile(0.5),
      p95: quantile(0.95),
      p99: quantile(0.99),
      max: sorted.at(-1),
    };
  };
  const repeated = cases.flatMap((values) => values.slice(1)).sort((a, b) => a - b);
  const quantile = (p) => repeated[Math.max(0, Math.ceil(p * repeated.length) - 1)];
  return {
    latency: {
      firstMs,
      repeatedSamples: repeated.length,
      p50: quantile(0.5),
      p95: quantile(0.95),
      p99: quantile(0.99),
      max: repeated.at(-1),
    },
    cases: cases.map((values, index) => ({
      name: ['latest', 'middle', 'oldest'][index],
      ...stats(values),
    })),
    heartbeat: heartbeat.stop(),
    cpu: process.cpuUsage(cpu),
    digests,
  };
}
