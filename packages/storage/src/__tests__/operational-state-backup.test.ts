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
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { eventWaitDeliveryKey, type EventWaitRecord } from '@maka/core/event-wait';
import { createSqliteArtifactStoreWriteAuthority } from '../artifact-store.js';
import type { EventWaitSnapshot } from '../event-wait-authority.js';
import { createSqliteEventWaitAuthority } from '../sqlite-event-wait-authority.js';
import { createProjectCatalog } from '../project-catalog.js';
import { createSessionStore } from '../session-store.js';
import {
  createOperationalStateBackup,
  OperationalBackupError,
  restoreOperationalStateBackup,
  validateOperationalStateBackup,
} from '../operational-state-backup.js';

test('backs up and restores runtime.sqlite plus artifact bytes', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-operational-backup-'));
  const stateRoot = join(base, 'state');
  const backupRoot = join(base, 'backup');
  const restoreRoot = join(base, 'restore');
  const projectPath = join(base, 'project');
  await mkdir(projectPath);
  const sessions = createSessionStore(stateRoot);
  try {
    // The project catalog decides how every session is grouped, and its name,
    // relink aliases and archive state exist nowhere else. Restoring sessions
    // without it would silently reorganize the user's whole sidebar.
    const catalog = createProjectCatalog(stateRoot, { now: () => 5 });
    const project = await catalog.register(projectPath);
    await catalog.rename(project.id, 'Renamed Project');
    await catalog.archive(project.id);
    catalog.close();

    const session = await sessions.create({
      projectId: project.id,
      cwd: '/tmp/cwd',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
      name: 'Backup',
      labels: [],
    });
    const message = {
      type: 'user',
      id: 'message-1',
      turnId: 'turn-1',
      ts: 1,
      text: 'durable'.repeat(12_000),
    } as const;
    await sessions.appendMessage(session.id, message);
    await sessions.close?.();
    const artifactAuthority = createSqliteArtifactStoreWriteAuthority(stateRoot);
    const artifacts = artifactAuthority.store;
    const artifact = await artifacts.create({
      id: 'artifact-1',
      sessionId: session.id,
      turnId: 'turn-1',
      name: 'note.txt',
      kind: 'file',
      content: 'artifact',
      source: 'tool_result',
      now: 2,
    });
    artifactAuthority.close();

    await createOperationalStateBackup({ stateRoot, destinationRoot: backupRoot, now: () => 10 });
    assert.equal((await validateOperationalStateBackup(backupRoot)).createdAt, 10);
    await restoreOperationalStateBackup({ backupRoot, destinationRoot: restoreRoot });

    const restored = createSessionStore(restoreRoot);
    const restoredCatalog = createProjectCatalog(restoreRoot);
    try {
      assert.deepEqual(await restored.readMessages(session.id), [message]);
      assert.equal(
        await readFile(join(restoreRoot, 'artifacts', artifact.relativePath), 'utf8'),
        'artifact',
      );
      assert.equal(
        (await restored.readHeaderSnapshot(session.id)).projectId,
        project.id,
        'a restored session still belongs to the project it was grouped under',
      );
      assert.deepEqual(await restoredCatalog.list(), [
        {
          id: project.id,
          name: 'Renamed Project',
          locations: [{ path: await realpath(projectPath), isWorktree: false }],
          archivedAt: 5,
          available: true,
          preferredPath: await realpath(projectPath),
        },
      ]);
    } finally {
      await restored.close?.();
      restoredCatalog.close();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('backup restores every wait lifecycle, revisions and the resolved active slot', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-operational-backup-waits-'));
  const stateRoot = join(base, 'state');
  const backupRoot = join(base, 'backup');
  const restoreRoot = join(base, 'restore');
  const sessions = createSessionStore(stateRoot);
  const waits = createSqliteEventWaitAuthority(stateRoot);
  const expected: EventWaitSnapshot[] = [];
  try {
    for (const status of ['waiting', 'resolved', 'cancelled', 'expired'] as const) {
      const session = await sessions.create({
        cwd: base,
        llmConnectionSlug: 'fake',
        model: 'fake-model',
        permissionMode: 'ask',
        name: `Backup ${status}`,
      });
      const record: EventWaitRecord = {
        schemaVersion: 1,
        waitId: `wait-${status}`,
        sessionId: session.id,
        goalControlLease: { goalId: 'goal-1', generation: 3 },
        sourceTurnId: 'turn-1',
        sourceToolCallId: 'call-1',
        resource: {
          providerId: 'test',
          connectionId: 'connection-1',
          resourceType: 'task',
          resourceId: 'opaque/任务',
        },
        condition: { typeId: 'terminal', version: 1, parameters: { nested: [null, true, 3] } },
        deliveryKey: eventWaitDeliveryKey(`wait-${status}`),
        createdAt: 10,
        updatedAt: 10,
        deadlineAt: 100,
        status: 'waiting',
      };
      const commit = (next: EventWaitRecord, revision: number | null) =>
        waits.commit({
          sessionId: session.id,
          waitId: record.waitId,
          record: next,
          expectedAuthorityRevision: revision,
        });
      let result = await commit(record, null);
      if (status === 'resolved' || status === 'cancelled') {
        const resolved: EventWaitRecord = {
          ...record,
          status: 'resolved',
          updatedAt: 30,
          resolvedAt: 30,
          resolution: {
            outcome: 'invalidated',
            receiptKey: 'receipt-1',
            observedAt: 25,
            evidenceRefs: ['artifact:external-evidence'],
          },
        };
        result = await commit(resolved, 0);
        if (status === 'cancelled') {
          result = await commit(
            {
              ...record,
              status: 'cancelled',
              updatedAt: 40,
              cancelledAt: 40,
              reason: 'Revoked before delivery',
              priorResolution: { resolvedAt: resolved.resolvedAt, resolution: resolved.resolution },
            },
            1,
          );
        }
      } else if (status === 'expired') {
        result = await commit({ ...record, status: 'expired', expiredAt: 100, updatedAt: 100 }, 0);
      }
      assert.equal(result.kind, 'committed');
      if (result.kind !== 'committed') throw new Error('Expected stored wait');
      expected.push(result.snapshot);
    }
  } finally {
    await waits.close();
    await sessions.close?.();
  }
  try {
    await createOperationalStateBackup({ stateRoot, destinationRoot: backupRoot, now: () => 200 });
    await restoreOperationalStateBackup({ backupRoot, destinationRoot: restoreRoot });
    const restored = createSqliteEventWaitAuthority(restoreRoot);
    try {
      for (const snapshot of expected) {
        const { record } = snapshot;
        assert.deepEqual(
          await restored.read({ sessionId: record.sessionId, waitId: record.waitId }),
          snapshot,
        );
        assert.deepEqual(await restored.listSession({ sessionId: record.sessionId, limit: 200 }), {
          items: [snapshot],
          nextCursor: null,
        });
        const nextWaitId = `${record.waitId}-next`;
        // Use the original waiting shape, omitting terminal fields from the
        // restored record, when checking whether its active slot survived.
        const waiting = {
          schemaVersion: record.schemaVersion,
          waitId: nextWaitId,
          sessionId: record.sessionId,
          goalControlLease: record.goalControlLease,
          sourceTurnId: record.sourceTurnId,
          sourceToolCallId: record.sourceToolCallId,
          resource: record.resource,
          condition: record.condition,
          deliveryKey: eventWaitDeliveryKey(nextWaitId),
          createdAt: record.createdAt,
          updatedAt: record.createdAt,
          deadlineAt: record.deadlineAt,
          status: 'waiting',
        } as const;
        assert.deepEqual(
          await restored.commit({
            sessionId: record.sessionId,
            waitId: nextWaitId,
            expectedAuthorityRevision: null,
            record: waiting,
          }),
          record.status === 'waiting' || record.status === 'resolved'
            ? { kind: 'active_wait_conflict', waitId: record.waitId }
            : { kind: 'committed', snapshot: { authorityRevision: 0, record: waiting } },
        );
      }
    } finally {
      await restored.close();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('rejects a backup whose SQLite Artifact metadata has no matching payload', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-operational-backup-artifact-'));
  const stateRoot = join(base, 'state');
  try {
    const artifactAuthority = createSqliteArtifactStoreWriteAuthority(stateRoot);
    const artifacts = artifactAuthority.store;
    const artifact = await artifacts.create({
      id: 'artifact-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      name: 'note.txt',
      kind: 'file',
      content: 'artifact',
      source: 'tool_result',
      now: 2,
    });
    artifactAuthority.close();
    await rm(join(stateRoot, 'artifacts', artifact.relativePath));

    await assert.rejects(
      createOperationalStateBackup({
        stateRoot,
        destinationRoot: join(base, 'backup'),
        now: () => 10,
      }),
      (error: unknown) =>
        error instanceof OperationalBackupError &&
        error.code === 'corrupt_backup' &&
        /artifact payload/i.test(error.message),
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('rejects a backup whose native Runtime version contradicts its registry', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-operational-backup-version-'));
  const stateRoot = join(base, 'state');
  const backupRoot = join(base, 'backup');
  try {
    const sessions = createSessionStore(stateRoot);
    await sessions.close?.();
    await createOperationalStateBackup({ stateRoot, destinationRoot: backupRoot, now: () => 10 });

    const databasePath = join(backupRoot, 'runtime.sqlite');
    const database = new DatabaseSync(databasePath);
    database.exec('PRAGMA user_version = 999');
    database.close();
    const bytes = await readFile(databasePath);
    const manifestPath = join(backupRoot, 'operational-backup.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      files: Array<{ path: string; size: number; sha256: string }>;
    };
    const entry = manifest.files.find((file) => file.path === 'runtime.sqlite');
    assert.ok(entry);
    entry.size = bytes.byteLength;
    entry.sha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);

    await assert.rejects(validateOperationalStateBackup(backupRoot), /newer than supported/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('continues to validate and restore version 3 backups without context refs', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-backup-v3-'));
  try {
    const stateRoot = join(base, 'state');
    const sessions = createSessionStore(stateRoot);
    await sessions.close?.();
    const backupRoot = join(base, 'backup');
    await createOperationalStateBackup({ stateRoot, destinationRoot: backupRoot });
    const path = join(backupRoot, 'operational-backup.json');
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    manifest.schemaVersion = 3;
    await writeFile(path, JSON.stringify(manifest));
    assert.equal((await validateOperationalStateBackup(backupRoot)).schemaVersion, 3);
    assert.equal(
      (await restoreOperationalStateBackup({ backupRoot, destinationRoot: join(base, 'restored') }))
        .schemaVersion,
      3,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
