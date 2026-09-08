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
import { test } from 'node:test';
import { openInteractiveArtifactStoreForWrite } from '@maka/storage/artifact-stores';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { WORKHUB_COORDINATION_SESSION_ID } from '@maka/core/session';
import type { AttachmentRef } from '@maka/core/events';
import { HostArtifactCoordinator } from '../server/artifact-coordinator.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';
import { copyWorkHubAttachmentsToTarget } from '../server/workhub-message-attachments.js';

test('delegation copies only selected canonical attachments into the target Work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workhub-attachments-'));
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  try {
    const store = await openInteractiveArtifactStoreForWrite(owner.lease);
    try {
      const selected = await store.create({
        sessionId: WORKHUB_COORDINATION_SESSION_ID,
        turnId: 'upload-1',
        name: 'requirements.txt',
        kind: 'file',
        source: 'user_upload',
        mimeType: 'text/plain',
        content: 'requirements',
      });
      await store.create({
        sessionId: WORKHUB_COORDINATION_SESSION_ID,
        turnId: 'upload-2',
        name: 'unrelated.txt',
        kind: 'file',
        source: 'user_upload',
        mimeType: 'text/plain',
        content: 'private draft',
      });
      const artifacts = new HostArtifactCoordinator(store, () => {}, new SessionAdmissionGate(), {
        probeSessionRemoval: async () => ({ kind: 'present' }),
      });
      const source: AttachmentRef = {
        name: selected.name,
        kind: 'other',
        mimeType: 'text/plain',
        bytes: selected.sizeBytes,
        ref: {
          kind: 'session_file',
          sessionId: WORKHUB_COORDINATION_SESSION_ID,
          relativePath: selected.id,
        },
      };
      const copied = await copyWorkHubAttachmentsToTarget(store, artifacts, 'target-work', [
        source,
      ]);
      assert.equal(await artifacts.validateTurnAttachments('target-work', copied), undefined);
      assert.equal(copied[0]!.ref.kind, 'session_file');
      if (copied[0]!.ref.kind !== 'session_file') throw new Error('Expected canonical ref');
      const binary = await store.readTextInSession('target-work', copied[0]!.ref.relativePath);
      assert.deepEqual(binary, { ok: true, text: 'requirements' });
      assert.notEqual(copied[0]!.ref.relativePath, selected.id);
      await assert.rejects(
        copyWorkHubAttachmentsToTarget(store, artifacts, 'target-work', [
          { ...source, bytes: 999 },
        ]),
        /metadata/,
      );
      await assert.rejects(
        copyWorkHubAttachmentsToTarget(store, artifacts, 'target-work', [
          { ...source, ref: { ...source.ref, sessionId: 'foreign-work' } } as AttachmentRef,
        ]),
        /different Session/,
      );
    } finally {
      store.close();
    }
  } finally {
    await owner.close();
    await rm(root, { recursive: true, force: true });
  }
});
