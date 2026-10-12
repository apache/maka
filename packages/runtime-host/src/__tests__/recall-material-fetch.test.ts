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
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { ArtifactKind, ArtifactSource } from '@maka/core/artifacts';
import {
  createArtifactAttachmentResourceReader,
  openInteractiveArtifactStoreForWrite,
} from '@maka/storage/artifact-stores';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { createRecallMaterialFetch } from '../server/recall-material-fetch.js';

const SOURCE = 'source-session-0000-0000-0000-000000000001';
const TARGET = 'target-session-0000-0000-0000-000000000002';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

interface Harness {
  readonly root: string;
  readonly fetchMaterial: ReturnType<typeof createRecallMaterialFetch>;
  create(input: {
    sessionId?: string;
    name: string;
    kind: ArtifactKind;
    source: ArtifactSource;
    mimeType?: string;
    content?: Buffer | string;
  }): Promise<string>;
}

/** The composed gate over a real Artifact store, exactly as the Host wires it. */
async function withGate(body: (harness: Harness) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-recall-material-gate-'));
  const owner = await tryAcquireInteractiveRootOwner(
    await resolveStorageRoot({ path: root, kind: 'interactive' }),
  );
  assert.ok(owner, 'the test needs the storage root');
  const store = await openInteractiveArtifactStoreForWrite(owner.lease);
  try {
    const fetchMaterial = createRecallMaterialFetch({
      artifacts: store,
      attachments: createArtifactAttachmentResourceReader({ artifactStore: store }),
    });
    await body({
      root,
      fetchMaterial,
      create: async (input) =>
        (
          await store.create({
            sessionId: input.sessionId ?? SOURCE,
            turnId: 'upload',
            name: input.name,
            kind: input.kind,
            source: input.source,
            content: input.content ?? PNG,
            ...(input.mimeType ? { mimeType: input.mimeType } : {}),
          })
        ).id,
    });
  } finally {
    await owner.close();
    await rm(root, { recursive: true, force: true });
  }
}

const IMAGE = { name: 'screenshot.png', kind: 'image', mimeType: 'image/png' } as const;

describe('the material fetch gate', () => {
  test('a file a person attached is brought into the asking Session', async () => {
    await withGate(async ({ root, fetchMaterial, create }) => {
      const materialId = await create({ ...IMAGE, source: 'user_upload' });
      const result = await fetchMaterial({
        sourceSessionId: SOURCE,
        materialId,
        targetSessionId: TARGET,
      });
      assert.ok(result.ok, 'an eligible material must be fetched');
      assert.equal((result.content as { kind: string }).kind, 'image');
      const copied = (result.content as { ref: { sessionId: string } }).ref;
      assert.equal(copied.sessionId, TARGET, 'the answer must belong to the asking Session');
      assert.deepEqual((await readdir(join(root, 'artifacts', TARGET))).length, 1);
    });
  });

  /**
   * `material_id` is model-influenced input, so this is the boundary that keeps
   * a recalled name from becoming a way to read any artifact in the workspace.
   * Anything a person did not attach reads as absent, not as refused: the
   * caller learns nothing about what is there.
   */
  test('only a file a person attached is retrievable', async () => {
    await withGate(async ({ root, fetchMaterial, create }) => {
      for (const source of [
        'tool_result',
        'tool_result_projection',
        'tool_result_archive',
        'session_effect',
      ] as const) {
        const materialId = await create({ name: `${source}.png`, kind: 'image', source });
        const result = await fetchMaterial({
          sourceSessionId: SOURCE,
          materialId,
          targetSessionId: TARGET,
        });
        assert.ok(!result.ok && result.reason === 'not_found', source);
        assert.match(result.message, /not found/u, source);
      }
      await assert.rejects(() => readdir(join(root, 'artifacts', TARGET)), /ENOENT/u);
    });
  });

  test('an id from a Session that does not hold it reads as absent', async () => {
    await withGate(async ({ fetchMaterial, create }) => {
      const materialId = await create({ ...IMAGE, source: 'user_upload' });
      const result = await fetchMaterial({
        sourceSessionId: TARGET,
        materialId,
        targetSessionId: TARGET,
      });
      assert.ok(!result.ok && result.reason === 'not_found');
    });
  });

  test('a material Read cannot decode is refused rather than copied', async () => {
    await withGate(async ({ root, fetchMaterial, create }) => {
      const materialId = await create({
        name: 'contract.pdf',
        kind: 'pdf',
        mimeType: 'application/pdf',
        source: 'user_upload',
        content: Buffer.from('%PDF-1.4'),
      });
      const result = await fetchMaterial({
        sourceSessionId: SOURCE,
        materialId,
        targetSessionId: TARGET,
      });
      assert.ok(!result.ok && result.reason === 'unsupported');
      await assert.rejects(
        () => readdir(join(root, 'artifacts', TARGET)),
        /ENOENT/u,
        'a refused material must not be copied first',
      );
    });
  });

  test('a material already in the asking Session is answered without a copy', async () => {
    await withGate(async ({ root, fetchMaterial, create }) => {
      const materialId = await create({ ...IMAGE, sessionId: TARGET, source: 'user_upload' });
      const result = await fetchMaterial({
        sourceSessionId: TARGET,
        materialId,
        targetSessionId: TARGET,
      });
      assert.ok(result.ok);
      assert.equal(
        (result.content as { ref: { relativePath: string } }).ref.relativePath,
        materialId,
        'the original must be answered, not a copy of itself',
      );
      assert.equal((await readdir(join(root, 'artifacts', TARGET))).length, 1);
    });
  });

  test('opening the same material again reuses the copy', async () => {
    await withGate(async ({ root, fetchMaterial, create }) => {
      const materialId = await create({ ...IMAGE, source: 'user_upload' });
      const request = {
        sourceSessionId: SOURCE,
        materialId,
        targetSessionId: TARGET,
      } as const;
      const first = await fetchMaterial(request);
      const second = await fetchMaterial(request);
      assert.ok(first.ok && second.ok);
      assert.deepEqual(second.content, first.content);
      assert.equal((await readdir(join(root, 'artifacts', TARGET))).length, 1);
    });
  });

  test('a text material is copied and read back as text', async () => {
    await withGate(async ({ fetchMaterial, create }) => {
      const materialId = await create({
        name: 'notes.md',
        kind: 'file',
        mimeType: 'text/markdown',
        source: 'user_upload',
        content: 'pipeline notes',
      });
      const result = await fetchMaterial({
        sourceSessionId: SOURCE,
        materialId,
        targetSessionId: TARGET,
      });
      assert.ok(result.ok);
      assert.deepEqual(result.content, { kind: 'text', text: 'pipeline notes' });
    });
  });

  /**
   * State can change between the check and the copy — the source purged, a
   * payload deleted after ingest. The caller is a tool, so that has to arrive
   * as a refusal it can report rather than as an unhandled error.
   */
  test('a store failure mid-flight is a refusal, not a thrown error', async () => {
    await withGate(async ({ fetchMaterial, create }) => {
      const materialId = await create({ ...IMAGE, source: 'user_upload' });
      assert.ok(
        (
          await fetchMaterial({
            sourceSessionId: SOURCE,
            materialId,
            targetSessionId: TARGET,
          })
        ).ok,
      );

      const torn = createRecallMaterialFetch({
        artifacts: {
          getInSession: async () => ({
            record: {
              id: materialId,
              sessionId: SOURCE,
              turnId: 'upload',
              createdAt: 0,
              name: 'screenshot.png',
              kind: 'image',
              sizeBytes: PNG.byteLength,
              mimeType: 'image/png',
              source: 'user_upload',
              relativePath: `${SOURCE}/${materialId}`,
            },
          }),
          copyConversationArtifacts: async () => {
            throw new Error('source vanished mid-flight');
          },
        },
        attachments: {
          readAttachmentResource: async () => {
            throw new Error('unreachable');
          },
        },
      });
      const result = await torn({
        sourceSessionId: SOURCE,
        materialId,
        targetSessionId: TARGET,
      });
      assert.ok(!result.ok && result.reason === 'not_found');
    });
  });

  test('an aborted request never reaches the store', async () => {
    await withGate(async ({ fetchMaterial, create }) => {
      const materialId = await create({ ...IMAGE, source: 'user_upload' });
      const controller = new AbortController();
      controller.abort();
      const result = await fetchMaterial({
        sourceSessionId: SOURCE,
        materialId,
        targetSessionId: TARGET,
        abortSignal: controller.signal,
      });
      assert.ok(!result.ok && result.reason === 'not_found');
    });
  });
});
