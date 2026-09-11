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
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { createSessionStore } from '../session-store.js';
import { createSqliteRuntimeStore } from '../sqlite-runtime-store.js';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '../root-authority.js';
import { openInteractiveContextOffloadStoreForWrite } from '../context-offload-store.js';
import { createReadImageSnapshotStore } from '../read-image-snapshot-store.js';
import { SqliteContextOffloadStore } from '../sqlite-context-offload-store.js';
import {
  createOperationalStateBackup,
  restoreOperationalStateBackup,
  validateOperationalStateBackup,
} from '../operational-state-backup.js';
import { exportSessionBundleState } from '../session-bundle-policy.js';
import { withOfflineContextSnapshot } from '../context-offload-snapshot.js';
import {
  trackControlDirectory,
  removeTrackedControlDirectories,
} from './fixtures/control-directory-hygiene.js';
import { after } from 'node:test';

after(removeTrackedControlDirectories);
const limits = {
  ownerMaxBytes: { read_image_snapshot: 5 * 1024 * 1024, tool_result_archive: 4 * 1024 * 1024 },
  sessionLogicalBytes: 1024 * 1024 * 1024,
  workspacePhysicalBytes: 20 * 1024 * 1024 * 1024,
};

async function fixture(t: TestContext) {
  const base = await mkdtemp(join(tmpdir(), 'maka-context-snapshot-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'source');
  const capability = trackControlDirectory(
    await resolveStorageRoot({ path: root, kind: 'interactive' }),
  );
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  t.after(() => owner.close());
  const sessions = createSessionStore(root);
  const selected = await sessions.create({
    cwd: base,
    llmConnectionSlug: 'fake',
    model: 'fake',
    permissionMode: 'ask',
  });
  const other = await sessions.create({
    cwd: base,
    llmConnectionSlug: 'fake',
    model: 'fake',
    permissionMode: 'ask',
  });
  const writer = await openInteractiveContextOffloadStoreForWrite(owner.lease, { limits });
  const bytes = Buffer.from('snapshot bytes that cannot be recovered from the changed workspace');
  const ref = await createReadImageSnapshotStore(writer, selected.id).snapshot({
    ownerId: 'image-1',
    bytes,
    mimeType: 'image/png',
  });
  await createReadImageSnapshotStore(writer, other.id).snapshot({
    ownerId: 'shared',
    bytes,
    mimeType: 'image/png',
  });
  const privateBytes = Buffer.from('OTHER-SESSION-PRIVATE-CONTEXT');
  const inlinePrivate = Buffer.from('OTHER-SESSION-PRIVATE-INLINE');
  assert.equal(
    (
      await writer.put({
        sessionId: other.id,
        owner: { kind: 'tool_result_archive', ownerId: 'inline' },
        bytes: inlinePrivate,
        mediaType: 'application/json',
      })
    ).ok,
    true,
  );
  const otherRef = await createReadImageSnapshotStore(writer, other.id).snapshot({
    ownerId: 'private',
    bytes: privateBytes,
    mimeType: 'image/png',
  });
  const orphan = await createReadImageSnapshotStore(writer, selected.id).snapshot({
    ownerId: 'orphan',
    bytes: Buffer.from('orphan bytes'),
    mimeType: 'image/png',
  });
  await writer.releaseReference({ sessionId: selected.id, refId: orphan.refId });
  await sessions.appendMessage(selected.id, {
    type: 'tool_result',
    id: 'image-result',
    turnId: 'turn',
    ts: 1,
    toolUseId: 'read',
    isError: false,
    content: { kind: 'image', mimeType: 'image/png', ref },
  });
  await sessions.close?.();
  const runtime = createSqliteRuntimeStore(join(root, 'runtime.sqlite'));
  try {
    await runtime.appendRuntimeEvent(selected.id, 'run-image', {
      id: 'call-event-image',
      invocationId: 'invocation-image',
      runId: 'run-image',
      sessionId: selected.id,
      turnId: 'turn-image',
      ts: 1,
      partial: false,
      role: 'model',
      author: 'agent',
      content: {
        kind: 'function_call',
        id: 'call-image',
        name: 'Read',
        args: { path: 'image.png' },
      },
    });
    await runtime.appendRuntimeEvent(selected.id, 'run-image', {
      id: 'event-image',
      invocationId: 'invocation-image',
      runId: 'run-image',
      sessionId: selected.id,
      turnId: 'turn-image',
      ts: 2,
      partial: false,
      role: 'tool',
      author: 'tool',
      content: {
        kind: 'function_response',
        id: 'call-image',
        name: 'Read',
        result: { kind: 'image', mimeType: 'image/png', ref },
        modelProjection: {
          version: 1,
          kind: 'content',
          parts: [{ kind: 'artifact', mediaType: 'image/png', ref }],
        },
      },
    });
  } finally {
    runtime.close();
  }
  const close = async () => {
    await writer.close();
    await owner.close();
  };
  t.after(close);
  const imagePath = (data: Buffer) => {
    const hash = createHash('sha256').update(data).digest('hex');
    return join('context-offload-values', 'sha256', hash.slice(0, 2), hash);
  };
  return {
    base,
    root,
    owner,
    capability,
    close,
    bytes,
    privateBytes,
    inlinePrivate,
    ref,
    otherRef,
    imagePath,
    selected,
    other,
  };
}

test('offline backup restores context refs and verified managed bytes into an empty root', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    createOperationalStateBackup({ stateRoot: f.root, destinationRoot: join(f.base, 'busy') }),
    /offline Storage Root/,
  );
  await f.close();
  const backupRoot = join(f.base, 'backup');
  const manifest = await createOperationalStateBackup({
    stateRoot: f.root,
    destinationRoot: backupRoot,
  });
  assert.equal(manifest.schemaVersion, 4);
  assert.ok(manifest.files.some((file) => file.path === 'context-offload.sqlite'));
  const restored = join(f.base, 'restored');
  await restoreOperationalStateBackup({ backupRoot, destinationRoot: restored });
  const store = new SqliteContextOffloadStore(join(restored, 'context-offload.sqlite'), { limits });
  try {
    const read = await store.read({ sessionId: f.selected.id, refId: f.ref.refId, maxBytes: 1024 });
    assert.equal(read.ok, true);
    if (read.ok) assert.deepEqual(Buffer.from(read.bytes), f.bytes);
    assert.equal((await store.usage()).references, 4);
    assert.equal(
      (await store.usage()).physicalBytes,
      f.bytes.length + f.privateBytes.length + f.inlinePrivate.length,
    );
  } finally {
    store.close();
  }
});

test('single-Session export contains only its refs and shared payload once, with no private free-page bytes', async (t) => {
  const f = await fixture(t);
  const input = {
    stateRoot: f.root,
    configRoot: join(f.base, 'config'),
    destinationRoot: join(f.base, 'bundle'),
    sessionId: f.selected.id,
  };
  await assert.rejects(exportSessionBundleState(input), /offline Storage Root/);
  await f.close();
  const plan = await exportSessionBundleState(input);
  assert.ok(plan.includedEntries.includes('context-offload.sqlite'));
  const store = new SqliteContextOffloadStore(
    join(input.destinationRoot, 'context-offload.sqlite'),
    { limits },
  );
  try {
    const read = await store.read({ sessionId: f.selected.id, refId: f.ref.refId, maxBytes: 1024 });
    assert.equal(read.ok, true);
    if (read.ok) assert.deepEqual(Buffer.from(read.bytes), f.bytes);
    assert.equal((await store.usage()).references, 1);
    assert.equal((await store.usage()).physicalBytes, f.bytes.length);
    assert.equal(
      (await store.read({ sessionId: f.other.id, refId: f.otherRef.refId, maxBytes: 1024 })).ok,
      false,
    );
  } finally {
    store.close();
  }
  const database = await readFile(join(input.destinationRoot, 'context-offload.sqlite'));
  assert.equal(database.includes(Buffer.from(f.other.id)), false);
  assert.equal(database.includes(f.privateBytes), false);
  assert.equal(database.includes(f.inlinePrivate), false);
  await assert.rejects(readFile(join(input.destinationRoot, f.imagePath(f.privateBytes))), {
    code: 'ENOENT',
  });
});

test('missing or corrupt context bytes never publish a successful backup', async (t) => {
  const f = await fixture(t);
  await f.close();
  const path = join(f.root, f.imagePath(f.bytes));
  await writeFile(path, Buffer.alloc(f.bytes.length));
  await assert.rejects(
    createOperationalStateBackup({ stateRoot: f.root, destinationRoot: join(f.base, 'corrupt') }),
    /size\/hash mismatch/,
  );
  await rm(path);
  await assert.rejects(
    createOperationalStateBackup({ stateRoot: f.root, destinationRoot: join(f.base, 'missing') }),
  );
  assert.deepEqual((await readdir(f.base)).sort(), ['source']);
});

test('restore rejects tampering even if the manifest is recomputed', async (t) => {
  const f = await fixture(t);
  await f.close();
  const backupRoot = join(f.base, 'backup');
  await createOperationalStateBackup({ stateRoot: f.root, destinationRoot: backupRoot });
  const path = f.imagePath(f.bytes).split('\\').join('/');
  const changed = Buffer.alloc(f.bytes.length);
  await writeFile(join(backupRoot, path), changed);
  const manifestPath = join(backupRoot, 'operational-backup.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const file = manifest.files.find((entry: { path: string }) => entry.path === path);
  file.sha256 = 'sha256:' + createHash('sha256').update(changed).digest('hex');
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(
    restoreOperationalStateBackup({ backupRoot, destinationRoot: join(f.base, 'restore') }),
    /size\/hash mismatch/,
  );
});

test('a missing context database with a durable image reference fails closed', async (t) => {
  const f = await fixture(t);
  await f.close();
  await rm(join(f.root, 'context-offload.sqlite'));
  await assert.rejects(
    createOperationalStateBackup({ stateRoot: f.root, destinationRoot: join(f.base, 'backup') }),
    /missing or cross-Session/,
  );
  await assert.rejects(
    exportSessionBundleState({
      stateRoot: f.root,
      configRoot: join(f.base, 'config'),
      destinationRoot: join(f.base, 'bundle'),
      sessionId: f.selected.id,
    }),
    /missing or cross-Session/,
  );
});

test('validates typed projection refs without interpreting opaque JSON as storage refs', async (t) => {
  const f = await fixture(t);
  await f.close();
  const database = new DatabaseSync(join(f.root, 'runtime.sqlite'));
  try {
    const row = database
      .prepare("SELECT payload_json FROM runtime_events WHERE event_id = 'event-image'")
      .get()!;
    const event = JSON.parse(String(row.payload_json));
    event.content.result = {
      kind: 'json',
      value: {
        attachments: [{ ref: { kind: 'session_context', sessionId: 'fake', refId: 'opaque' } }],
      },
    };
    database
      .prepare("UPDATE runtime_events SET payload_json = ? WHERE event_id = 'event-image'")
      .run(JSON.stringify(event));
    await createOperationalStateBackup({
      stateRoot: f.root,
      destinationRoot: join(f.base, 'opaque'),
    });
    event.content.modelProjection.parts[0].ref = f.otherRef;
    database
      .prepare("UPDATE runtime_events SET payload_json = ? WHERE event_id = 'event-image'")
      .run(JSON.stringify(event));
    await assert.rejects(
      createOperationalStateBackup({ stateRoot: f.root, destinationRoot: join(f.base, 'foreign') }),
      /cross-Session/,
    );
  } finally {
    database.close();
  }
});

test('offline snapshot authority blocks a new Host owner and releases after failure', async (t) => {
  const f = await fixture(t);
  await f.close();
  await assert.rejects(
    withOfflineContextSnapshot(f.root, async (locked) => {
      assert.equal(locked, true);
      assert.equal(await tryAcquireInteractiveRootOwner(f.capability), undefined);
      throw new Error('injected snapshot failure');
    }),
    /injected snapshot failure/,
  );
  const owner = await tryAcquireInteractiveRootOwner(f.capability);
  assert.ok(owner);
  await owner.close();
});

test('context snapshot refuses a symlinked managed-value ancestor', async (t) => {
  const f = await fixture(t);
  await f.close();
  const values = join(f.root, 'context-offload-values');
  const outside = join(f.base, 'outside');
  const { rename } = await import('node:fs/promises');
  await rename(values, outside);
  await symlink(outside, values, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(
    createOperationalStateBackup({ stateRoot: f.root, destinationRoot: join(f.base, 'backup') }),
    /symlinks/,
  );
});
