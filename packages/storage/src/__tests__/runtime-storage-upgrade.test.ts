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
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test, type TestContext } from 'node:test';
import { acquireOperationalStateDatabase } from '../operational-state-store.js';
import { upgradeRuntimeStorageAtStartup } from '../runtime-storage-upgrade.js';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '../root-authority.js';
import {
  trackControlDirectory,
  removeTrackedControlDirectories,
} from './fixtures/control-directory-hygiene.js';

after(removeTrackedControlDirectories);

async function fixture(t: TestContext, mode: 0 | 1 | 2, rows = 1) {
  const root = await mkdtemp(join(tmpdir(), 'maka-startup-storage-'));
  const capability = trackControlDirectory(
    await resolveStorageRoot({ path: root, kind: 'interactive' }),
  );
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  const path = join(root, 'runtime.sqlite');
  const original = new DatabaseSync(path);
  original.exec(`PRAGMA auto_vacuum = ${mode}; VACUUM`);
  original.close();
  const lease = acquireOperationalStateDatabase(root);
  lease.transaction('write', () => {
    const insert = lease.database.prepare(`INSERT INTO runtime_events
      (event_id, session_id, invocation_id, run_id, turn_id, event_seq, event_kind, payload_json, committed_at)
      VALUES (?, 'session', 'invocation', 'run', 'turn', ?, 'text', ?, 1)`);
    for (let index = 0; index < rows; index++) {
      const id = `event-${index}`;
      insert.run(
        id,
        index + 1,
        JSON.stringify({
          id,
          sessionId: 'session',
          invocationId: 'invocation',
          runId: 'run',
          turnId: 'turn',
          ts: 1,
          partial: false,
          author: 'agent',
          role: 'model',
          content: { kind: 'text', text: 'unchanged history '.repeat(rows > 1 ? 4096 : 128) },
        }),
      );
    }
  });
  const activity = lease.database.prepare('SELECT * FROM session_content_activity').all();
  lease.close();
  t.after(async () => {
    if (!owner.closed) await owner.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, path, capability, owner, activity };
}

function digest(path: string) {
  const db = new DatabaseSync(path);
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
    const hash = createHash('sha256');
    for (const row of db
      .prepare('SELECT event_id, payload_json, event_seq FROM runtime_events ORDER BY event_id')
      .iterate())
      hash.update(JSON.stringify(row));
    return {
      hash: hash.digest('hex'),
      activity: db.prepare('SELECT * FROM session_content_activity').all(),
      mode: db.prepare('PRAGMA auto_vacuum').get()?.auto_vacuum,
    };
  } finally {
    db.close();
  }
}

test('startup converts NONE once without changing history or its seven-day clock', async (t) => {
  const f = await fixture(t, 0);
  const before = digest(f.path);
  const phases: Array<string | undefined> = [];
  assert.deepEqual(
    await upgradeRuntimeStorageAtStartup(f.owner.lease, { onPhase: (phase) => phases.push(phase) }),
    { kind: 'converted', mode: 2 },
  );
  assert.deepEqual(digest(f.path), { ...before, mode: 2 });
  assert.ok(phases.includes('rebuilding'));
  assert.ok(phases.includes('verifying'));
  assert.equal(phases.at(-1), undefined);
  assert.deepEqual(await upgradeRuntimeStorageAtStartup(f.owner.lease), {
    kind: 'current',
    mode: 2,
  });
});

test('FULL switches without rebuilding and an incremental database skips the upgrade', async (t) => {
  const f = await fixture(t, 1);
  const phases: Array<string | undefined> = [];
  assert.equal(
    (
      await upgradeRuntimeStorageAtStartup(f.owner.lease, {
        onPhase: (phase) => phases.push(phase),
      })
    ).kind,
    'converted',
  );
  assert.ok(!phases.includes('rebuilding'));
  assert.deepEqual(await upgradeRuntimeStorageAtStartup(f.owner.lease), {
    kind: 'current',
    mode: 2,
  });
});

test('low space leaves the old database usable and failed attempts back off', async (t) => {
  const f = await fixture(t, 0);
  const before = digest(f.path);
  assert.deepEqual(
    await upgradeRuntimeStorageAtStartup(f.owner.lease, {
      minimumFreeBytes: Number.MAX_SAFE_INTEGER,
    }),
    { kind: 'deferred', mode: 0, reason: 'low_space' },
  );
  assert.deepEqual(digest(f.path), before);
  assert.deepEqual(await upgradeRuntimeStorageAtStartup(f.owner.lease), {
    kind: 'deferred',
    mode: 0,
    reason: 'recent_attempt',
  });
  assert.equal(
    (await upgradeRuntimeStorageAtStartup(f.owner.lease, { now: () => Date.now() + 3600_001 }))
      .kind,
    'converted',
  );
});

test('a committed conversion with an unfinished marker validates without rebuilding', async (t) => {
  const f = await fixture(t, 2);
  await writeFile(
    join(f.root, '.runtime-storage-upgrade.json'),
    JSON.stringify({ rootId: f.owner.lease.rootId, startedAt: Date.now(), status: 'running' }),
  );
  const phases: Array<string | undefined> = [];
  assert.equal(
    (
      await upgradeRuntimeStorageAtStartup(f.owner.lease, {
        onPhase: (phase) => phases.push(phase),
      })
    ).kind,
    'converted',
  );
  assert.ok(phases.includes('verifying'));
  assert.ok(!phases.includes('rebuilding'));
});

test('a malformed retry hint cannot permanently prevent conversion', async (t) => {
  const f = await fixture(t, 0);
  await writeFile(join(f.root, '.runtime-storage-upgrade.json'), '{interrupted');
  assert.equal((await upgradeRuntimeStorageAtStartup(f.owner.lease)).kind, 'converted');
});

test('process death during conversion preserves complete history and permits retry', {
  timeout: 60_000,
}, async (t) => {
  const f = await fixture(t, 0, 512);
  const before = digest(f.path);
  await f.owner.close();
  const child = fork(
    new URL('./fixtures/runtime-storage-upgrade-child.js', import.meta.url),
    [f.root],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
  );
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  const exited = once(child, 'exit');
  await new Promise<void>((resolve, reject) => {
    child.on('message', (message) => {
      if ((message as { phase?: string }).phase === 'rebuilding') resolve();
    });
    child.once('error', reject);
    child.once('exit', () => reject(new Error('Upgrade child exited before rebuilding')));
  });
  child.kill('SIGKILL');
  await exited;
  const recovered = digest(f.path);
  assert.equal(recovered.hash, before.hash);
  assert.deepEqual(recovered.activity, before.activity);
  assert.ok(recovered.mode === 0 || recovered.mode === 2);
  const owner = await tryAcquireInteractiveRootOwner(f.capability);
  assert.ok(owner);
  try {
    const result = await upgradeRuntimeStorageAtStartup(owner.lease);
    assert.notEqual(result.kind, 'deferred');
    assert.deepEqual(digest(f.path), { ...before, mode: 2 });
  } finally {
    await owner.close();
  }
});
