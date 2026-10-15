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
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, after, type TestContext } from 'node:test';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import {
  ColdRuntimeStorage,
  COLD_STORAGE_AGE_MS,
  reclaimColdRuntimeStorageSpace,
  type RuntimeStorageCodec,
} from '../cold-runtime-storage.js';
import {
  encodeRuntimePayloadJson,
  decodeRuntimePayloadJson,
  RUNTIME_PAYLOAD_MAX_BYTES,
  runtimePayloadBytesSql,
  parseRuntimePayloadJson,
} from '../runtime-payload-codec.js';
import { migrateColdStorageDatabase } from '../cold-storage-schema.js';
import { acquireOperationalStateDatabase } from '../operational-state-store.js';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '../root-authority.js';
import { createSqliteRuntimeStore } from '../sqlite-runtime-store.js';
import { openToolResultArchiveEvidenceReader } from '../tool-result-archive-evidence.js';
import { createSessionStore } from '../session-store.js';
import { importSessionBundleState } from '../session-bundle-policy.js';
import {
  createOperationalStateBackup,
  restoreOperationalStateBackup,
} from '../operational-state-backup.js';
import {
  trackControlDirectory,
  removeTrackedControlDirectories,
} from './fixtures/control-directory-hygiene.js';

after(removeTrackedControlDirectories);
const codec: RuntimeStorageCodec = async (mode, values) =>
  values.map((value) => {
    if (mode === 'encode') return encodeRuntimePayloadJson(value);
    const json = decodeRuntimePayloadJson(value);
    return { json };
  });

function event(
  id: string,
  content: RuntimeEvent['content'] = { kind: 'text', text: '正文 repeated '.repeat(1000) },
): RuntimeEvent {
  return {
    id,
    sessionId: 'session',
    runId: 'run',
    invocationId: 'invocation',
    turnId: 'turn',
    ts: 1,
    partial: false,
    author: content?.kind === 'function_response' ? 'tool' : 'agent',
    role: content?.kind === 'function_response' ? 'tool' : 'model',
    content,
  };
}

async function fixture(
  t: TestContext,
  customCodec = codec,
  options: {
    minimumFreeBytes?: number;
    maximumWalBytes?: number;
    autoVacuumMode?: 0 | 1 | 2;
  } = {},
) {
  const base = await mkdtemp(join(tmpdir(), 'maka-cold-storage-'));
  const root = join(base, 'root');
  const capability = trackControlDirectory(
    await resolveStorageRoot({ path: root, kind: 'interactive' }),
  );
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  const { autoVacuumMode, ...resourceLimits } = options;
  if (autoVacuumMode !== undefined) {
    await mkdir(root, { recursive: true });
    const existing = new DatabaseSync(join(root, 'runtime.sqlite'));
    existing.exec(`PRAGMA auto_vacuum = ${autoVacuumMode}; VACUUM`);
    existing.close();
  }
  let now = Date.now();
  let protectedSession = false;
  let allowed = true;
  const cold = await ColdRuntimeStorage.open({
    lease: owner.lease,
    codec: customCodec,
    now: () => now,
    canRun: () => allowed,
    isProtected: () => protectedSession,
    ...resourceLimits,
  });
  const database = acquireOperationalStateDatabase(root);
  const db = database.database;
  let sequence = 0;
  const insert = (value: RuntimeEvent) => {
    db.prepare(`INSERT INTO runtime_events(event_id, session_id, invocation_id, run_id, turn_id,
      event_seq, event_kind, payload_json, committed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      value.id,
      value.sessionId,
      value.invocationId,
      value.runId,
      value.turnId,
      ++sequence,
      value.content?.kind ?? 'completed',
      JSON.stringify(value),
      1,
    );
  };
  const raw = (id: string) =>
    (
      db.prepare('SELECT payload_json FROM runtime_events WHERE event_id = ?').get(id) as {
        payload_json: string;
      }
    ).payload_json;
  const activity = () =>
    db.prepare('SELECT * FROM session_content_activity WHERE session_id = ?').get('session');
  const cool = () =>
    db
      .prepare('UPDATE session_content_activity SET last_content_write_at = ?')
      .run(now - COLD_STORAGE_AGE_MS);
  t.after(async () => {
    cold.close();
    database.close();
    await owner.close();
    await rm(base, { recursive: true, force: true });
  });
  return {
    base,
    root,
    owner,
    cold,
    db,
    insert,
    raw,
    activity,
    cool,
    closeDatabase: () => database.close(),
    advance: (ms: number) => {
      now += ms;
    },
    protect: (value: boolean) => {
      protectedSession = value;
    },
    allow: (value: boolean) => {
      allowed = value;
    },
    now: () => now,
  };
}

test('all four body types round-trip exact JSON bytes, including signed/provider metadata and large tool results', () => {
  for (const content of [
    { kind: 'text', text: '问题😀'.repeat(3000), providerOptions: { citation: 'source' } },
    {
      kind: 'thinking',
      text: 'reason'.repeat(3000),
      signature: 'signed',
      providerOptions: { opaque: [1, 2] },
    },
    { kind: 'function_call', id: 'call', name: 'Read', args: { text: 'argument'.repeat(3000) } },
    {
      kind: 'function_response',
      id: 'call',
      name: 'Read',
      result: 'raw'.repeat(1024 * 1024),
      providerOutput: { opaque: 'native' },
      modelProjection: { version: 1, kind: 'text', text: 'model'.repeat(3000) },
    },
  ] as RuntimeEvent['content'][]) {
    const raw = JSON.stringify(event('event', content), null, 1);
    const encoded = encodeRuntimePayloadJson(raw);
    assert.ok(encoded.json, String(content?.kind));
    assert.equal(decodeRuntimePayloadJson(encoded.json), raw);
    assert.ok(Buffer.byteLength(encoded.json) < Buffer.byteLength(raw) / 2);
    assert.equal(JSON.parse(encoded.json).role, event('event', content).role);
    const db = new DatabaseSync(':memory:');
    try {
      assert.equal(
        db
          .prepare(
            `SELECT ${runtimePayloadBytesSql('payload_json')} AS bytes FROM (SELECT ? AS payload_json)`,
          )
          .get(encoded.json)?.bytes,
        Buffer.byteLength(raw),
        'SQL quotas must preserve the exact original UTF-8 size',
      );
    } finally {
      db.close();
    }
  }
});

test('invalid version, codec, length, hash and SQL projection fail closed; incompressible/partial bodies stay raw', () => {
  const raw = JSON.stringify(event('event'));
  const encoded = JSON.parse(encodeRuntimePayloadJson(raw).json!);
  for (const [key, value] of [
    ['version', 2],
    ['codec', 'unknown'],
    ['rawBytes', RUNTIME_PAYLOAD_MAX_BYTES + 1],
    ['sha256', '0'.repeat(64)],
    ['storedBytes', 0],
    ['data', '!!!'],
  ] as const) {
    const corrupt = structuredClone(encoded);
    corrupt.__maka_storage[key] = value;
    assert.throws(() => decodeRuntimePayloadJson(JSON.stringify(corrupt)));
  }
  const forged = structuredClone(encoded);
  forged.sessionId = 'foreign';
  assert.throws(() => decodeRuntimePayloadJson(JSON.stringify(forged)), /projection mismatch/);
  assert.equal(
    encodeRuntimePayloadJson(JSON.stringify({ ...event('partial'), partial: true })).json,
    null,
  );
  assert.equal(
    encodeRuntimePayloadJson(
      JSON.stringify(event('random', { kind: 'text', text: randomBytes(8192).toString('base64') })),
    ).json,
    null,
  );
});

test('repeated decoding never shares mutable events and still rejects altered stored bytes', () => {
  const original = event('cached');
  const raw = JSON.stringify(original);
  const encoded = encodeRuntimePayloadJson(raw).json!;
  const first = parseRuntimePayloadJson(encoded) as RuntimeEvent;
  first.sessionId = 'mutated';
  assert.ok(first.content?.kind === 'text');
  first.content.text = 'mutated';
  assert.deepEqual(parseRuntimePayloadJson(encoded), original);
  assert.equal(decodeRuntimePayloadJson(encoded), raw);
  const forged = JSON.parse(encoded);
  forged.sessionId = 'mutated';
  assert.throws(() => parseRuntimePayloadJson(JSON.stringify(forged)), /projection mismatch/);
});

test('forged logical length cannot fetch a larger physical frame through a smaller SQL read budget', () => {
  const encoded = JSON.parse(encodeRuntimePayloadJson(JSON.stringify(event('event'))).json!);
  encoded.__maka_storage.rawBytes = 1;
  encoded.__maka_storage.data = 'X'.repeat(8192);
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE test(payload_json TEXT)');
    db.prepare('INSERT INTO test VALUES (?)').run(JSON.stringify(encoded));
    assert.equal(
      db
        .prepare(
          `SELECT CASE WHEN ${runtimePayloadBytesSql('payload_json')} <= 512 THEN payload_json END AS body FROM test`,
        )
        .get()?.body,
      null,
    );
  } finally {
    db.close();
  }
});

test('alternate numeric header syntax cannot bypass the logical read quota', () => {
  const encoded = encodeRuntimePayloadJson(JSON.stringify(event('event'))).json!;
  const rawBytes = JSON.parse(encoded).__maka_storage.rawBytes;
  const alternate = encoded.replace(`"rawBytes":${rawBytes},`, `"rawBytes":${rawBytes / 10}e1,`);
  assert.equal(JSON.parse(alternate).__maka_storage.rawBytes, rawBytes);
  assert.throws(() => parseRuntimePayloadJson(alternate), /length header/);
});

test('enabled by default, exact 7-day boundary and real local write clock; read is not a write and append keeps old frames', async (t) => {
  const f = await fixture(t);
  f.insert(event('first'));
  assert.ok(Number(f.activity()?.last_content_write_at) > 1);
  assert.equal((await f.cold.compressBatch()).changed, 0);
  f.cool();
  f.db
    .prepare(
      'UPDATE session_content_activity SET last_content_write_at = last_content_write_at + 1',
    )
    .run();
  assert.equal((await f.cold.compressBatch()).changed, 0);
  f.advance(1);
  assert.equal((await f.cold.compressBatch()).changed, 1);
  const encoded = f.raw('first');
  const clock = f.activity();
  const reader = createSqliteRuntimeStore(join(f.root, 'runtime.sqlite'));
  try {
    assert.deepEqual(await reader.readRuntimeEvents('session', 'run'), [event('first')]);
    assert.deepEqual(f.activity(), clock);
    assert.equal(f.raw('first'), encoded);
    await reader.appendRuntimeEvent('session', 'run', event('first'));
    assert.equal(f.raw('first'), encoded, 'immutable retry compares restored original bytes');
    assert.deepEqual(f.activity(), clock, 'retry is not a new content write');
    f.insert(event('new'));
    assert.equal(f.raw('first'), encoded);
    assert.equal(decodeRuntimePayloadJson(f.raw('new')), f.raw('new'));
    assert.equal((await f.cold.compressBatch()).changed, 0);
  } finally {
    reader.close();
  }
});

test('protected/active Sessions are skipped; publication rechecks content activity and writer epoch', async (t) => {
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture(t, async (mode, values) => {
    started();
    await wait;
    return codec(mode, values);
  });
  f.insert(event('first'));
  f.cool();
  await f.cold.setEnabled(true);
  f.allow(false);
  assert.equal((await f.cold.compressBatch()).changed, 0);
  f.allow(true);
  f.protect(true);
  assert.equal((await f.cold.compressBatch()).changed, 0);
  f.protect(false);
  await f.cold.compressBatch(); // reset the cursor after the protected sweep
  const work = f.cold.compressBatch();
  await entered;
  f.insert(event('arrived'));
  await f.cold.setEnabled(false);
  release();
  assert.equal((await work).changed, 0);
  assert.equal(decodeRuntimePayloadJson(f.raw('first')), f.raw('first'));
});

test('recall candidates retain compressed matches, reject misses and preserve searchable-message counts', async (t) => {
  const f = await fixture(t);
  f.insert(event('searchable', { kind: 'text', text: 'needle '.repeat(2000) }));
  const reader = createSqliteRuntimeStore(join(f.root, 'runtime.sqlite'));
  try {
    const before = await reader.listSessionsWithRuntimeEventText(['session', 'absent'], ['needle']);
    const misses = await reader.listSessionsWithRuntimeEventText(['session'], ['unrelated']);
    const count = await reader.countRuntimeEventMessages(['session']);
    f.cool();
    await f.cold.setEnabled(true);
    assert.equal((await f.cold.compressBatch()).changed, 1);
    assert.deepEqual(
      await reader.listSessionsWithRuntimeEventText(['session', 'absent'], ['needle']),
      before,
    );
    assert.deepEqual(
      await reader.listSessionsWithRuntimeEventText(['session'], ['unrelated']),
      misses,
    );
    assert.equal(await reader.countRuntimeEventMessages(['session']), count);
    assert.deepEqual(await reader.readRuntimeEvents('session', 'run'), [
      event('searchable', { kind: 'text', text: 'needle '.repeat(2000) }),
    ]);
  } finally {
    reader.close();
  }
});

test('compressed recovery evidence preserves steering identity, prompt selection and logical byte budgets', async (t) => {
  const f = await fixture(t);
  const store = createSqliteRuntimeStore(join(f.root, 'runtime.sqlite'), { readOnly: true });
  t.after(() => store.close());
  const prompt: RuntimeEvent = {
    ...event('prompt'),
    role: 'user',
    author: 'user',
    content: { kind: 'text', text: 'prompt evidence '.repeat(5000) },
  };
  const steering: RuntimeEvent = {
    ...prompt,
    id: 'steering',
    content: { kind: 'text', text: 'steering evidence '.repeat(5000), steering: true },
    refs: { providerEventId: 'steering-message' },
  };
  f.insert(prompt);
  f.insert(steering);
  const query = {
    sessionId: 'session',
    turnIds: ['turn'],
    eventIds: [],
    budget: { maxRecords: 4, maxBytes: 256 * 1024 },
  };
  const before = await store.readRecoveryMessageEvents(query);
  assert.equal(before.status, 'complete');
  if (before.status !== 'complete') throw new Error('Expected recovery evidence');
  assert.deepEqual(before.records, [prompt]);
  f.cool();
  await f.cold.setEnabled(true);
  assert.equal((await f.cold.compressBatch()).changed, 2);
  assert.deepEqual(await store.readRecoveryMessageEvents(query), before);
  assert.deepEqual(await store.readImmutableSteeringMessageProof('session', 'steering-message'), {
    event: steering,
  });
  assert.deepEqual(
    await store.readRecoveryMessageEvents({ ...query, budget: { maxRecords: 4, maxBytes: 1024 } }),
    { status: 'limit_exceeded' },
  );
  assert.deepEqual(
    await store.readRecoveryMessageEvents({
      ...query,
      turnIds: [],
      eventIds: ['steering'],
      budget: { maxRecords: 4, maxBytes: 1024 },
    }),
    { status: 'limit_exceeded' },
  );
  store.close();
  const writer = createSqliteRuntimeStore(join(f.root, 'runtime.sqlite'), {
    databaseLease: acquireOperationalStateDatabase(f.root),
  });
  try {
    await writer.appendRuntimeEvent('session', 'run', steering, { durable: true });
    await assert.rejects(
      writer.appendRuntimeEvent('session', 'another-run', {
        ...steering,
        id: 'conflicting-steering',
        invocationId: 'another-invocation',
        runId: 'another-run',
        turnId: 'another-turn',
        content: { kind: 'text', text: 'different', steering: true },
      }),
      /Immutable steering message identity conflict/,
    );
  } finally {
    writer.close();
  }
});

test('large records are supported with a small batch budget, and explicit restore leaves writer off without reheating', async (t) => {
  const f = await fixture(t);
  f.insert(event('large', { kind: 'text', text: 'x'.repeat(2 * 1024 * 1024) }));
  f.cool();
  const clock = f.activity();
  await f.cold.setEnabled(true);
  const compressed = await f.cold.compressBatch({ maxBytes: 1024 });
  assert.equal(compressed.changed, 1);
  assert.ok(compressed.inputBytes > 1024 * 1024);
  assert.deepEqual(f.activity(), clock);
  const restored = await f.cold.restoreBatch({ maxBytes: 1024 });
  assert.equal(restored.changed, 1);
  assert.equal(
    f.raw('large'),
    JSON.stringify(event('large', { kind: 'text', text: 'x'.repeat(2 * 1024 * 1024) })),
  );
  assert.deepEqual(f.activity(), clock);
  assert.equal((await f.cold.inspect()).writerEnabled, false);
});

test('cross-connection writer contention returns immediately and preserves the owner busy timeout', async (t) => {
  const f = await fixture(t);
  f.insert(event('first'));
  f.cool();
  await f.cold.setEnabled(true);
  const blocker = new DatabaseSync(join(f.root, 'runtime.sqlite'));
  blocker.exec('BEGIN IMMEDIATE');
  const before = f.db.prepare('PRAGMA busy_timeout').get();
  try {
    const start = performance.now();
    const result = await f.cold.compressBatch();
    assert.equal(result.busy, true);
    assert.equal(result.changed, 0);
    assert.ok(
      performance.now() - start < 1000,
      'must not wait for the normal 5-second busy timeout',
    );
    assert.deepEqual(f.db.prepare('PRAGMA busy_timeout').get(), before);
  } finally {
    blocker.exec('ROLLBACK');
    blocker.close();
  }
});

test('low free space and WAL pressure defer maintenance without changing source bytes', async (t) => {
  for (const [limits, reason] of [
    [{ minimumFreeBytes: Number.MAX_SAFE_INTEGER }, 'low_space'],
    [{ maximumWalBytes: 0 }, 'wal_limit'],
  ] as const) {
    let calls = 0;
    const f = await fixture(
      t,
      async (mode, values) => {
        calls++;
        return codec(mode, values);
      },
      limits,
    );
    f.insert(event('first'));
    f.cool();
    await f.cold.setEnabled(true);
    const result = await f.cold.compressBatch();
    assert.equal(result.pauseReason, reason);
    assert.equal(calls, 0);
    assert.equal(f.raw('first'), JSON.stringify(event('first')));
    f.insert(event('removed', { kind: 'text', text: 'free pages '.repeat(20000) }));
    f.db.prepare('DELETE FROM runtime_events WHERE event_id = ?').run('removed');
    const free = f.db.prepare('PRAGMA freelist_count').get()?.freelist_count;
    assert.ok(Number(free) > 0);
    assert.equal((await f.cold.reclaimFreePages({ maxPages: 64 })).pauseReason, reason);
    assert.equal(f.db.prepare('PRAGMA freelist_count').get()?.freelist_count, free);
  }
});

test('one failed codec record retains its original bytes without starving valid records in the batch', async (t) => {
  const f = await fixture(t, async (mode, values) =>
    (await codec(mode, values)).map((value, index) =>
      index === 0 ? { json: null, error: 'invalid record' } : value,
    ),
  );
  f.insert(event('a'));
  f.insert(event('b'));
  f.cool();
  await f.cold.setEnabled(true);
  const result = await f.cold.compressBatch();
  assert.equal(result.failures, 1);
  assert.equal(result.changed, 1);
  assert.equal(f.raw('a'), JSON.stringify(event('a')));
  assert.notEqual(f.raw('b'), JSON.stringify(event('b')));
});

test('compressed tool evidence returns the same bounded projection without materializing raw result', async (t) => {
  const f = await fixture(t);
  f.insert(
    event('tool', {
      kind: 'function_response',
      id: 'call',
      name: 'Read',
      result: 'raw'.repeat(1024 * 1024),
      modelProjection: { version: 1, kind: 'text', text: 'model'.repeat(1000) },
    }),
  );
  const reader = await openToolResultArchiveEvidenceReader(f.owner.lease);
  t.after(() => reader.close());
  const before = await reader.read({ sessionId: 'session', runtimeEventId: 'tool' });
  assert.ok(before.ok);
  f.cool();
  await f.cold.setEnabled(true);
  assert.equal((await f.cold.compressBatch()).changed, 1);
  let rawResultFetched = false;
  const prepare = DatabaseSync.prototype.prepare;
  t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
    if (/SELECT\s+payload_json\b/.test(sql)) rawResultFetched = true;
    return prepare.call(this, sql);
  });
  const after = await reader.read({ sessionId: 'session', runtimeEventId: 'tool' });
  assert.deepEqual(after, before);
  assert.equal(rawResultFetched, false);
  const encoded = f.raw('tool');
  const withoutEvidence = JSON.parse(encoded);
  delete withoutEvidence.__maka_storage.evidence;
  f.db
    .prepare('UPDATE runtime_events SET payload_json = ? WHERE event_id = ?')
    .run(JSON.stringify(withoutEvidence), 'tool');
  assert.deepEqual(await reader.read({ sessionId: 'session', runtimeEventId: 'tool' }), {
    ok: false,
    reason: 'corrupt',
  });
  f.db
    .prepare('UPDATE runtime_events SET payload_json = ? WHERE event_id = ?')
    .run(encoded, 'tool');
  assert.deepEqual(await reader.read({ sessionId: 'session', runtimeEventId: 'tool' }), before);
});

test('legacy unknown activity starts now, and backup restore resets cooling and uses the local writer default', async (t) => {
  const f = await fixture(t);
  f.insert(event('first'));
  f.db.exec('DELETE FROM session_content_activity');
  migrateColdStorageDatabase(f.db, f.now());
  assert.equal(f.activity()?.last_content_write_at, f.now());
  f.cool();
  await f.cold.setEnabled(true);
  await f.cold.compressBatch();
  await f.cold.setEnabled(false);
  const backupRoot = join(f.base, 'backup');
  const destinationRoot = join(f.base, 'restored');
  await createOperationalStateBackup({ stateRoot: f.root, destinationRoot: backupRoot });
  const now = f.now() + 10000;
  await restoreOperationalStateBackup({ backupRoot, destinationRoot, now: () => now });
  const db = new DatabaseSync(join(destinationRoot, 'runtime.sqlite'), { readOnly: true });
  try {
    assert.equal(
      db.prepare('SELECT last_content_write_at FROM session_content_activity').get()
        ?.last_content_write_at,
      now,
    );
    assert.equal(
      db.prepare('SELECT writer_enabled FROM runtime_storage_policy').get()?.writer_enabled,
      1,
    );
    assert.equal(
      decodeRuntimePayloadJson(
        String(db.prepare('SELECT payload_json FROM runtime_events').get()?.payload_json),
      ),
      JSON.stringify(event('first')),
    );
  } finally {
    db.close();
  }
});

test('offline reclaim rejects open repositories, releases real file space and preserves original bodies', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 32; i++)
    f.insert(event('record-' + i, { kind: 'text', text: 'large'.repeat(16000) }));
  f.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  f.cool();
  await f.cold.setEnabled(true);
  while ((await f.cold.compressBatch()).hasMore) {
    /* bounded batches */
  }
  await assert.rejects(reclaimColdRuntimeStorageSpace(f.owner.lease), /Close all operational/);
  // This fixture owns two references. Releasing the explicit one and the cold lane
  // permits the offline rewrite; their close operations are idempotent.
  f.cold.close();
  // The fixture's inspection handle is also an operational repository.
  f.closeDatabase();
  const reclaimed = await reclaimColdRuntimeStorageSpace(f.owner.lease);
  assert.equal(reclaimed.busy, false);
  assert.ok(reclaimed.databaseBytesAfter < reclaimed.databaseBytesBefore / 2);
  const db = new DatabaseSync(join(f.root, 'runtime.sqlite'), { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
    const rows = db.prepare('SELECT payload_json FROM runtime_events').all();
    assert.equal(rows.length, 32);
    for (const row of rows)
      assert.equal(
        JSON.parse(decodeRuntimePayloadJson(String(row.payload_json))).content.text,
        'large'.repeat(16000),
      );
  } finally {
    db.close();
  }
});

test('incremental reclamation is bounded, leaves content and cooling unchanged, and respects foreground activity', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 32; i++)
    f.insert(event('incremental-' + i, { kind: 'text', text: 'large'.repeat(16000) }));
  f.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const before = await f.cold.inspect();
  assert.equal(before.autoVacuumMode, 2);
  f.cool();
  await f.cold.setEnabled(true);
  while ((await f.cold.compressBatch()).hasMore) {
    /* bounded batches */
  }
  await f.cold.setEnabled(false);
  const activity = f.activity();
  const compressed = f.raw('incremental-0');
  const free = Number(f.db.prepare('PRAGMA freelist_count').get()?.freelist_count);
  assert.ok(free > 64);
  f.allow(false);
  assert.equal((await f.cold.reclaimFreePages({ maxPages: 64 })).pauseReason, 'inactive');
  assert.equal(f.db.prepare('PRAGMA freelist_count').get()?.freelist_count, free);
  f.allow(true);
  await assert.rejects(f.cold.reclaimFreePages({ maxPages: 0 }), /Invalid runtime page/);
  const first = await f.cold.reclaimFreePages({ maxPages: 1 });
  assert.equal(first.reclaimedPages, 1);
  assert.equal(first.hasMore, true);
  let batches = 0;
  for (;;) {
    // Even a larger requested budget is capped at 64 pages by the authority.
    const result = await f.cold.reclaimFreePages({ maxPages: 10000 });
    assert.equal(result.busy, false);
    assert.ok(result.reclaimedPages <= 64);
    assert.ok(++batches < 100);
    if (!result.hasMore) break;
  }
  assert.deepEqual(await f.cold.reclaimFreePages({ maxPages: 64 }), {
    reclaimedPages: 0,
    hasMore: false,
    busy: false,
    autoVacuumMode: 2,
  });
  const after = await f.cold.inspect();
  assert.ok(after.databaseBytes < before.databaseBytes / 2);
  assert.equal(after.writerEnabled, false);
  assert.deepEqual(f.activity(), activity);
  assert.equal(f.raw('incremental-0'), compressed);
  assert.equal(f.db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
});

test('runtime reclamation immediately yields to a competing writer and restores the normal lock timeout', async (t) => {
  const f = await fixture(t);
  f.insert(event('retained'));
  f.insert(event('removed', { kind: 'text', text: 'free'.repeat(50000) }));
  f.db.prepare('DELETE FROM runtime_events WHERE event_id = ?').run('removed');
  const other = new DatabaseSync(join(f.root, 'runtime.sqlite'));
  const timeout = f.db.prepare('PRAGMA busy_timeout').get()?.timeout;
  other.exec('BEGIN IMMEDIATE');
  try {
    const start = performance.now();
    assert.equal((await f.cold.reclaimFreePages({ maxPages: 64 })).busy, true);
    assert.ok(performance.now() - start < 500);
    assert.equal(f.db.prepare('PRAGMA busy_timeout').get()?.timeout, timeout);
    assert.equal(f.raw('retained'), JSON.stringify(event('retained')));
  } finally {
    other.exec('ROLLBACK');
    other.close();
  }
});

test('an existing NONE database is only converted explicitly offline, preserves evidence, and stays converted on restart', async (t) => {
  const f = await fixture(t, codec, { autoVacuumMode: 0 });
  for (let i = 0; i < 16; i++)
    f.insert(event('legacy-' + i, { kind: 'text', text: 'legacy history '.repeat(10000) }));
  f.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  f.cool();
  await f.cold.setEnabled(true);
  while ((await f.cold.compressBatch()).hasMore) {
    /* bounded batches */
  }
  await f.cold.setEnabled(false);
  const activity = f.activity();
  const encoded = f.raw('legacy-0');
  assert.equal(
    (await f.cold.reclaimFreePages({ maxPages: 64 })).pauseReason,
    'conversion_required',
  );
  assert.equal((await f.cold.inspect()).autoVacuumMode, 0);
  await assert.rejects(
    reclaimColdRuntimeStorageSpace(f.owner.lease, { enableIncrementalVacuum: true }),
    /Close all operational/,
  );
  // A pinned WAL snapshot defers conversion, leaving the existing mode intact.
  const pinned = new DatabaseSync(join(f.root, 'runtime.sqlite'), { readOnly: true });
  pinned.exec('BEGIN');
  pinned.prepare('SELECT payload_json FROM runtime_events LIMIT 1').get();
  f.cold.close();
  f.closeDatabase();
  try {
    const deferred = await reclaimColdRuntimeStorageSpace(f.owner.lease, {
      enableIncrementalVacuum: true,
    });
    assert.equal(deferred.busy, true);
    assert.equal(deferred.autoVacuumModeAfter, 0);
    assert.equal(deferred.convertedToIncremental, false);
  } finally {
    pinned.exec('ROLLBACK');
    pinned.close();
  }
  const converted = await reclaimColdRuntimeStorageSpace(f.owner.lease, {
    enableIncrementalVacuum: true,
  });
  assert.equal(converted.busy, false);
  assert.equal(converted.autoVacuumModeBefore, 0);
  assert.equal(converted.autoVacuumModeAfter, 2);
  assert.equal(converted.convertedToIncremental, true);
  assert.ok(converted.databaseBytesAfter < converted.databaseBytesBefore / 2);
  const again = await reclaimColdRuntimeStorageSpace(f.owner.lease, {
    enableIncrementalVacuum: true,
  });
  assert.equal(again.convertedToIncremental, false);
  assert.equal(again.databaseBytesBefore, again.databaseBytesAfter);
  const restarted = acquireOperationalStateDatabase(f.root, { schemaMigration: 'require_current' });
  try {
    assert.equal(restarted.database.prepare('PRAGMA auto_vacuum').get()?.auto_vacuum, 2);
    assert.equal(
      restarted.database
        .prepare('SELECT payload_json FROM runtime_events WHERE event_id = ?')
        .get('legacy-0')?.payload_json,
      encoded,
    );
    assert.deepEqual(
      restarted.database
        .prepare('SELECT * FROM session_content_activity WHERE session_id = ?')
        .get('session'),
      activity,
    );
    assert.equal(
      restarted.database.prepare('SELECT writer_enabled FROM runtime_storage_policy').get()
        ?.writer_enabled,
      0,
    );
    assert.equal(restarted.database.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
  } finally {
    restarted.close();
  }
});

test('an existing FULL database keeps automatic reclamation and can switch explicitly without a full rewrite', async (t) => {
  const f = await fixture(t, codec, { autoVacuumMode: 1 });
  f.insert(event('full-mode'));
  const before = await f.cold.inspect();
  assert.deepEqual(await f.cold.reclaimFreePages({ maxPages: 64 }), {
    reclaimedPages: 0,
    hasMore: false,
    busy: false,
    autoVacuumMode: 1,
  });
  f.cold.close();
  f.closeDatabase();
  const result = await reclaimColdRuntimeStorageSpace(f.owner.lease, {
    enableIncrementalVacuum: true,
  });
  assert.equal(result.busy, false);
  assert.equal(result.autoVacuumModeBefore, 1);
  assert.equal(result.autoVacuumModeAfter, 2);
  assert.equal(result.databaseBytesBefore, result.databaseBytesAfter);
  const db = new DatabaseSync(join(f.root, 'runtime.sqlite'), { readOnly: true });
  try {
    assert.equal(
      Number(db.prepare('PRAGMA page_count').get()?.page_count) *
        Number(db.prepare('PRAGMA page_size').get()?.page_size),
      before.pageBytes,
    );
    assert.equal(
      db.prepare('SELECT payload_json FROM runtime_events').get()?.payload_json,
      JSON.stringify(event('full-mode')),
    );
  } finally {
    db.close();
  }
});

test('Session import preserves encoded bytes, starts local cooling and does not import the source writer switch', async (t) => {
  const f = await fixture(t);
  const sessions = createSessionStore(f.root);
  const session = await sessions.create({
    cwd: f.root,
    llmConnectionSlug: 'fake',
    model: 'fake',
    permissionMode: 'ask',
  });
  await sessions.close?.();
  const value = { ...event('portable'), sessionId: session.id };
  f.insert(value);
  f.cool();
  await f.cold.setEnabled(true);
  assert.equal((await f.cold.compressBatch()).changed, 1);
  const encoded = f.raw('portable');
  await f.cold.setEnabled(false);
  const bundleStateRoot = join(f.base, 'bundle');
  await mkdir(bundleStateRoot);
  const snapshot = acquireOperationalStateDatabase(f.root);
  try {
    await snapshot.backup(join(bundleStateRoot, 'runtime.sqlite'));
  } finally {
    snapshot.close();
  }
  const target = join(f.base, 'imported');
  const capability = trackControlDirectory(
    await resolveStorageRoot({ path: target, kind: 'interactive' }),
  );
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  try {
    const began = Date.now();
    const result = await importSessionBundleState({
      stateRoot: target,
      bundleStateRoot,
      lease: owner.lease,
    });
    assert.ok(result.sessionIds.includes(session.id));
    const db = new DatabaseSync(join(target, 'runtime.sqlite'), { readOnly: true });
    try {
      assert.equal(
        db.prepare('SELECT payload_json FROM runtime_events').get()?.payload_json,
        encoded,
      );
      assert.ok(
        Number(
          db
            .prepare(
              'SELECT last_content_write_at FROM session_content_activity WHERE session_id = ?',
            )
            .get(session.id)?.last_content_write_at,
        ) >= began,
      );
      assert.equal(
        db.prepare('SELECT writer_enabled FROM runtime_storage_policy').get()?.writer_enabled,
        1,
      );
    } finally {
      db.close();
    }
  } finally {
    await owner.close();
  }
});
