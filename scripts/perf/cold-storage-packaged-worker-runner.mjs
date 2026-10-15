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
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { seedInvocation } from '@maka/runtime/test-only/invocation-fixture';
import { removeControlDirectory } from '../../packages/storage/dist/__tests__/fixtures/control-directory-hygiene.js';

const [archive, root] = process.argv.slice(2);
const fromArchive = (name, file) =>
  import(pathToFileURL(join(archive, 'node_modules', '@maka', name, 'dist', file)).href);
const { resolveStorageRoot, tryAcquireInteractiveRootOwner } = await fromArchive(
  'storage',
  'root-authority.js',
);
const { acquireOperationalStateDatabase } = await fromArchive(
  'storage',
  'operational-state-store.js',
);
const { createSqliteRuntimeStore } = await fromArchive('storage', 'sqlite-runtime-store.js');
const { upgradeRuntimeStorageAtStartup } = await fromArchive(
  'storage',
  'runtime-storage-upgrade.js',
);
const { ColdRuntimeStorage, COLD_STORAGE_AGE_MS, reclaimColdRuntimeStorageSpace } =
  await fromArchive('storage', 'cold-runtime-storage.js');
const { TranscriptStorageWorker } = await fromArchive(
  'runtime-host',
  'server/transcript-storage-worker-client.js',
);
const { createSessionTranscriptReader } = await fromArchive(
  'runtime-host',
  'server/session-transcript-reader.js',
);
const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
const owner = await tryAcquireInteractiveRootOwner(capability);
assert.ok(owner);
const legacy = new DatabaseSync(join(root, 'runtime.sqlite'));
legacy.exec('PRAGMA auto_vacuum = NONE');
legacy.close();
const startup = await upgradeRuntimeStorageAtStartup(owner.lease);
assert.equal(startup.kind, 'converted');
const database = acquireOperationalStateDatabase(root);
const runtime = createSqliteRuntimeStore(join(root, 'runtime.sqlite'), { databaseLease: database });
const readerWorker = new TranscriptStorageWorker({
  databasePath: join(root, 'runtime.sqlite'),
  permissions: async () => new Map(),
});
const codecWorker = new TranscriptStorageWorker({
  databasePath: join(root, 'runtime.sqlite'),
  permissions: async () => new Map(),
});
let cold;
try {
  const sessionId = 'packaged-session';
  await seedInvocation(runtime, { sessionId, runId: 'run', turnId: 'turn', openedAt: 1 });
  await runtime.appendRuntimeEvent(sessionId, 'run', {
    id: 'prompt',
    sessionId,
    invocationId: 'run',
    runId: 'run',
    turnId: 'turn',
    ts: 2,
    partial: false,
    role: 'user',
    author: 'user',
    content: { kind: 'text', text: 'ASAR 无损正文 '.repeat(2000) },
  });
  const reader = createSessionTranscriptReader({
    stores: {
      runtimeEventStore: runtime,
      agentRunStore: { readRootTurnAdmission: async () => undefined },
    },
    storageWorker: readerWorker,
    canonicalPermissionOutcomes: { readPermissionOutcome: async () => undefined },
  });
  const request = { direction: 'older', maxMessages: 64, maxBytes: 1024 * 1024 };
  const before = await reader.readDurablePage(sessionId, request);
  assert.ok(before.fragments.length > 0);
  const landmarks = await reader.readDurableTurnLandmarks(sessionId, {
    maxLandmarks: 3,
    turnId: null,
  });
  cold = await ColdRuntimeStorage.open({
    lease: owner.lease,
    codec: codecWorker.codec,
    canRun: () => !readerWorker.reading,
    isProtected: (id) => readerWorker.isProtected(id),
  });
  database.database
    .prepare('UPDATE session_content_activity SET last_content_write_at = ?')
    .run(Date.now() - COLD_STORAGE_AGE_MS - 1);
  await cold.setEnabled(true);
  const compressed = await cold.compressBatch();
  assert.equal(compressed.changed, 1);
  assert.deepEqual(await readerWorker.readRecallCandidates([sessionId], ['无损正文']), [sessionId]);
  assert.deepEqual(await readerWorker.readRecallCandidates([sessionId], ['no-match']), []);
  assert.deepEqual(await reader.readDurablePage(sessionId, request), before);
  assert.deepEqual(
    await reader.readDurableTurnLandmarks(sessionId, { maxLandmarks: 3, turnId: null }),
    landmarks,
  );
  const restored = await cold.restoreBatch();
  assert.equal(restored.changed, 1);
  await Promise.all([readerWorker.close(), codecWorker.close()]);
  runtime.close();
  cold.close();
  database.close();
  const reclaimed = await reclaimColdRuntimeStorageSpace(owner.lease);
  assert.equal(reclaimed.busy, false);
  console.log(
    JSON.stringify({
      electron: process.versions.electron,
      node: process.versions.node,
      asarReadWorker: true,
      asarCodecWorker: true,
      asarVacuumWorker: true,
      asarStartupUpgrade: true,
      recallParity: true,
      pageParity: true,
      landmarkParity: true,
      restored: restored.changed,
    }),
  );
} finally {
  await Promise.all([readerWorker.close(), codecWorker.close()]);
  runtime.close();
  cold?.close();
  database.close();
  await owner.close();
  await removeControlDirectory(capability.rootId);
}
