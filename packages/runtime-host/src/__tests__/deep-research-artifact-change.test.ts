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
import { DEEP_RESEARCH_SAVE_ARTIFACT_TOOL_NAME } from '@maka/runtime/deep-research-tools';
import { openInteractiveArtifactStoreForWrite } from '@maka/storage/artifact-stores';
import { openInteractiveDeepResearchStoreForWrite } from '@maka/storage/deep-research-authority';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { HostDeepResearchCoordinator } from '../server/deep-research-coordinator.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';

test('Deep Research rollback publishes invalidation after deleting its owned Artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-deep-research-artifact-change-'));
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  const artifacts = await openInteractiveArtifactStoreForWrite(owner.lease);
  const deepResearch = await openInteractiveDeepResearchStoreForWrite(owner.lease);
  const sessionId = 'session-1';
  const turnId = 'turn-1';
  const toolCallId = 'save-invalid-evidence';
  const deletedArtifacts: Array<{ sessionId: string; artifactId: string }> = [];
  const coordinator = new HostDeepResearchCoordinator({
    store: deepResearch,
    artifacts,
    sessions: {
      readHeaderSnapshot: async () => {
        throw new Error('Session projection is not used by Deep Research tools');
      },
    },
    sessionAdmission: new SessionAdmissionGate(),
    onProjectionChanged: () => {},
    onArtifactDeleted: (deletedSessionId, artifactId) =>
      deletedArtifacts.push({ sessionId: deletedSessionId, artifactId }),
  });
  try {
    await deepResearch.start(sessionId, 'Research an invalid evidence reference', 'standard', {
      turnId,
      toolCallId: 'start-research',
    });
    const save = coordinator
      .toolsForSession(sessionId)
      .find((tool) => tool.name === DEEP_RESEARCH_SAVE_ARTIFACT_TOOL_NAME);
    assert.ok(save);

    await assert.rejects(
      async () =>
        await save.impl(
          {
            role: 'evidence_note',
            name: 'Evidence note',
            content: 'Evidence without a durable source.',
            summary: 'Invalid evidence reference',
            source_artifact_ids: ['missing-source'],
          },
          {
            sessionId,
            turnId,
            toolCallId,
            cwd: root,
            abortSignal: new AbortController().signal,
            emitOutput: () => {},
          },
        ),
      /references non-source artifact/u,
    );

    assert.equal(deletedArtifacts.length, 1);
    assert.equal(deletedArtifacts[0]?.sessionId, sessionId);
    const artifactId = deletedArtifacts[0]?.artifactId;
    assert.ok(artifactId);
    assert.equal((await artifacts.getInSession(sessionId, artifactId)).record, null);
  } finally {
    coordinator.close();
    artifacts.close();
    deepResearch.close();
    await owner.close();
    await rm(root, { recursive: true, force: true });
  }
});
