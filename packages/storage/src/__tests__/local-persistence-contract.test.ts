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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  messageContentDigest,
  normalizeMessageContent,
  type AttachmentRef,
} from '@maka/core/events';
import { WORKHUB_COORDINATION_SESSION_ID } from '@maka/core/session';
import {
  SessionMetadataConflictError,
  SessionMetadataVersionConflictError,
  type WorkHubMessageAssignmentRequest,
} from '../session-store-contract.js';
import {
  SessionMetadataConflictError as SqliteConflict,
  SessionMetadataVersionConflictError as SqliteVersionConflict,
} from '../sqlite-session-metadata-store.js';
import { SessionMetadataConflictError as ExecutionConflict } from '../execution-stores.js';
import { acquireOperationalStateDatabase } from '../operational-state-store.js';
import {
  openStorageWriterComposition,
  type StorageWriterComposition,
} from '../storage-writer-composition.js';
import {
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
  runWithStorageRootLease,
  StorageRootAuthorityError,
  type InteractiveRootOwner,
} from '../root-authority.js';
import {
  trackControlDirectory,
  removeTrackedControlDirectories,
} from './fixtures/control-directory-hygiene.js';
import { assignmentRequest, createCoordinationSession } from './fixtures/workhub-assignment.js';

after(removeTrackedControlDirectories);

test('contract errors retain instanceof identity through existing package seams', () => {
  assert.equal(SqliteConflict, SessionMetadataConflictError);
  assert.equal(ExecutionConflict, SessionMetadataConflictError);
  assert.equal(SqliteVersionConflict, SessionMetadataVersionConflictError);
  assert.ok(new SessionMetadataVersionConflictError('target', 1, 2) instanceof SqliteConflict);
});

test('leased WorkHub contract persists copied attachments and rejects inconsistent content or replay', async () => {
  await withComposition(async (storage, root) => {
    const store = storage.execution.sessionStore;
    await createCoordinationSession(store, root);
    const target = await store.create({
      cwd: root,
      name: 'Payments',
      llmConnectionSlug: 'test',
      model: 'test',
      permissionMode: 'ask',
    });
    const source: AttachmentRef = {
      kind: 'other',
      name: 'requirements.txt',
      mimeType: 'text/plain',
      bytes: 12,
      ref: {
        kind: 'session_file',
        sessionId: WORKHUB_COORDINATION_SESSION_ID,
        relativePath: 'source.txt',
      },
    };
    const copied: AttachmentRef = {
      ...source,
      ref: { kind: 'session_file', sessionId: target.id, relativePath: 'copied.txt' },
    };
    const base = assignmentRequest('attachments', target.id, 'Payments', 'target-turn');
    const content = normalizeMessageContent({
      text: base.assignment.userText,
      attachments: [copied],
    });
    const request: WorkHubMessageAssignmentRequest = {
      assignment: { ...base.assignment, attachments: [source], targetAttachments: [copied] },
      admission: {
        ...base.admission,
        content,
        submittedContentDigest: messageContentDigest(content),
      },
    };
    for (const attachments of [
      [],
      [source],
      [{ ...copied, bytes: 13 }],
      [copied, copied],
      [{ ...copied, name: 'different.txt' }],
    ]) {
      const invalid = normalizeMessageContent({ text: base.assignment.userText, attachments });
      await assert.rejects(
        store.assignWorkHubMessage({
          ...request,
          admission: {
            ...request.admission,
            content: invalid,
            submittedContentDigest: messageContentDigest(invalid),
          },
        }),
        SessionMetadataConflictError,
      );
      assert.equal(await store.readWorkHubAssignment(base.assignment.actionId), undefined);
      assert.deepEqual(await store.listMessageAdmissions(target.id), []);
    }
    await assert.rejects(
      store.assignWorkHubMessage({
        ...request,
        assignment: { ...request.assignment, attachments: [copied] },
      }),
      SessionMetadataConflictError,
    );
    assert.equal((await store.assignWorkHubMessage(request)).kind, 'assigned');
    assert.equal((await store.assignWorkHubMessage(request)).kind, 'existing');
    assert.deepEqual(
      await store.readMessageAdmission(target.id, base.admission.messageId),
      request.admission,
    );
    // Same caller-supplied fingerprint cannot authorize replacing source content.
    const replacement = { ...source, ref: { ...source.ref, relativePath: 'different-source.txt' } };
    await assert.rejects(
      store.assignWorkHubMessage({
        ...request,
        assignment: { ...request.assignment, attachments: [replacement] },
      }),
      SessionMetadataConflictError,
    );
    assert.deepEqual(
      await store.readWorkHubAssignment(base.assignment.actionId),
      request.assignment,
    );
  });
});

test('leased WorkHub transaction rolls back target, create claim, admission and linkage together', async () => {
  await withComposition(async (storage, root, owner) => {
    const store = storage.execution.sessionStore;
    await createCoordinationSession(store, root);
    const base = assignmentRequest('rollback', 'new-target', 'Payments', 'target-turn');
    const request: WorkHubMessageAssignmentRequest = {
      ...base,
      assignment: {
        ...base.assignment,
        disposition: 'create_new',
        create: { title: 'Payments', workspace: { kind: 'host_path', path: root } },
      },
      create: {
        sessionId: 'new-target',
        requestFingerprint: `sha256:${'b'.repeat(64)}`,
        input: {
          cwd: root,
          name: 'Payments',
          llmConnectionSlug: 'test',
          model: 'test',
          permissionMode: 'ask',
        },
      },
    };
    // The adapter owns one shared connection. A test-only trigger aborts AFTER
    // target creation and admission insert, during the coordination insert.
    // The Host-facing contract exposes neither this connection nor SQL callbacks.
    const database = await runWithStorageRootLease(
      owner.lease,
      'interactive',
      'write',
      async (path) => acquireOperationalStateDatabase(path),
    );
    try {
      database.database.exec(`
        CREATE TEMP TRIGGER workhub_assignment_rollback BEFORE INSERT ON session_messages
        WHEN NEW.session_id = 'maka_workhub_coordination'
          AND json_extract(NEW.record_json, '$.kind') = 'delegation_assigned'
        BEGIN SELECT RAISE(ABORT, 'workhub_assignment_rollback'); END;
      `);
      await assert.rejects(store.assignWorkHubMessage(request), /workhub_assignment_rollback/);
      assert.equal(await store.readWorkHubAssignment(base.assignment.actionId), undefined);
      assert.equal(
        (await store.probeStableSessionCreate('new-target', request.create!.requestFingerprint))
          .kind,
        'absent',
      );
      assert.deepEqual(await store.listMessageAdmissions('new-target'), []);
      assert.deepEqual(
        (await store.listHeaders()).map((header) => header.id),
        [WORKHUB_COORDINATION_SESSION_ID],
      );
      database.database.exec('DROP TRIGGER workhub_assignment_rollback');
      assert.equal((await store.assignWorkHubMessage(request)).kind, 'assigned');
      assert.equal((await store.assignWorkHubMessage(request)).kind, 'existing');
      assert.deepEqual(
        await store.readWorkHubAssignment(base.assignment.actionId),
        request.assignment,
      );
      assert.deepEqual(await store.listMessageAdmissions('new-target'), [request.admission]);
    } finally {
      database.database.exec('DROP TRIGGER IF EXISTS workhub_assignment_rollback');
      database.close();
    }
  });
});

test('retained execution contract cannot read or assign after its root lease is closed', async () => {
  await withComposition(async (storage, root, owner) => {
    const store = storage.execution.sessionStore;
    await createCoordinationSession(store, root);
    await storage.close();
    await owner.close();
    const invalidLease = (error: unknown) =>
      error instanceof StorageRootAuthorityError && error.code === 'invalid_lease';
    await assert.rejects(store.listHeaders(), invalidLease);
    await assert.rejects(
      store.assignWorkHubMessage(assignmentRequest('closed', 'target', 'Payments', 'turn')),
      invalidLease,
    );
  });
});

async function withComposition(
  run: (
    storage: StorageWriterComposition,
    root: string,
    owner: InteractiveRootOwner,
  ) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-local-persistence-contract-'));
  const capability = trackControlDirectory(
    await resolveStorageRoot({ path: root, kind: 'interactive' }),
  );
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  let storage: StorageWriterComposition | undefined;
  try {
    storage = await openStorageWriterComposition(owner.lease);
    await run(storage, root, owner);
  } finally {
    await storage?.close();
    await owner.close();
    await rm(root, { recursive: true, force: true });
  }
}
