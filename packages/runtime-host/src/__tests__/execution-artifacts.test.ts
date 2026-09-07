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
import { DatabaseSync } from 'node:sqlite';
import { openToolResultArchiveEvidenceReader } from '@maka/storage/tool-result-archive-evidence';
import {
  buildModelProjectionTransition,
  durableToolResultProjectionDigest,
} from '@maka/core/model-projection-transition';
import { buildLedgerArchivedToolResultPlaceholder } from '@maka/runtime/tool-result-archive';
import { parseToolResultArchiveResourceRef } from '@maka/runtime/tool-result-archive-resource';
import { mkdir, mkdtemp, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MAX_ATTACHMENT_BYTES } from '@maka/core/attachments';
import {
  openInteractiveArtifactStoreForWrite,
  createReadImageSnapshotPlanner,
} from '@maka/storage/artifact-stores';
import { encodeDurableToolResultOutputWithArtifacts } from '@maka/runtime/durable-tool-result-projection';
import { deferred } from '@maka/core/test-only/async-primitives';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { createHostExecutionArtifactServices } from '../server/execution-artifacts.js';
import { restoreArtifactV1Shape } from './fixtures/artifact-v1.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';

test('production archive services prepare ledger writes, keep legacy reads, and replay after reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-ledger-archive-host-'));
  const owner = await tryAcquireInteractiveRootOwner(
    await resolveStorageRoot({ path: root, kind: 'interactive' }),
  );
  assert.ok(owner);
  const artifacts = await openInteractiveArtifactStoreForWrite(owner.lease);
  let evidence = await openToolResultArchiveEvidenceReader(owner.lease);
  const db = new DatabaseSync(join(root, 'runtime.sqlite'));
  try {
    const projection = { version: 1 as const, kind: 'text' as const, text: 'durable ledger body' };
    const serializedResult = JSON.stringify(projection.text);
    const bodySha256 = createHash('sha256').update(serializedResult).digest('hex');
    const event = {
      id: 'response',
      sessionId: 'session',
      runId: 'run',
      invocationId: 'invocation',
      turnId: 'turn',
      ts: 1,
      partial: false,
      author: 'tool',
      role: 'tool',
      content: {
        kind: 'function_response',
        id: 'call',
        name: 'Read',
        result: 'raw execution body',
        modelProjection: projection,
      },
    };
    db.prepare(
      'INSERT INTO runtime_events(event_id, session_id, invocation_id, run_id, turn_id, event_seq, event_kind, payload_json, committed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'response',
      'session',
      'invocation',
      'run',
      'turn',
      1,
      'function_response',
      JSON.stringify(event),
      1,
    );
    const old = await artifacts.create({
      id: 'legacy-archive',
      sessionId: 'session',
      turnId: 'turn',
      name: 'legacy.json',
      kind: 'file',
      content: serializedResult,
      source: 'tool_result_archive',
    });
    const input = {
      sessionId: 'session',
      runtimeEventId: 'response',
      turnId: 'turn',
      toolCallId: 'call',
      toolName: 'Read',
      serializedResult,
      bodySha256,
      originalBytes: Buffer.byteLength(serializedResult),
      originalEstimatedTokens: 10,
      rewriteVersion: 1,
      sourceProjectionDigest: durableToolResultProjectionDigest(projection),
      reason: 'stale_tool_result_pruned_before_compact' as const,
    };
    const make = () =>
      createHostExecutionArtifactServices({
        artifacts,
        archiveEvidence: evidence,
        sessionAdmission: new SessionAdmissionGate(),
        sessions: { probeSessionRemoval: async () => ({ kind: 'present' }) },
        requestDrain: () => assert.fail('archive failure must not drain'),
      });
    let services = make();
    const prepared = await services.toolResultArchive.services.archiveToolResult(input);
    assert.ok(prepared?.ledger);
    assert.equal(typeof prepared.commitTransition, 'function');
    assert.equal((await artifacts.listPage('session', { offset: 0, limit: 10 })).total, 1);
    const placeholder = buildLedgerArchivedToolResultPlaceholder({ ...input, storage: 'ledger' });
    const transition = buildModelProjectionTransition({
      sessionId: 'session',
      target: {
        runtimeEventId: 'response',
        part: 'tool_result',
        toolCallId: 'call',
        toolName: 'Read',
      },
      sourceProjection: projection,
      replacement: { version: 1, kind: 'json', value: placeholder as never },
      now: 2,
    });
    db.prepare('INSERT INTO core_agent_runs(session_id, run_id, created_at) VALUES (?, ?, ?)').run(
      'session',
      'run',
      1,
    );
    const persist = async () => {
      db.prepare('INSERT INTO core_agent_run_events VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        'session',
        'run',
        1,
        transition.transitionId,
        'model_projection_transition_recorded',
        2,
        JSON.stringify({
          id: transition.transitionId,
          type: 'model_projection_transition_recorded',
          sessionId: 'session',
          runId: 'run',
          turnId: 'turn',
          ts: 2,
          data: { runtimeEventId: 'response', part: 'tool_result', transition },
        }),
      );
    };
    assert.equal(await prepared.commitTransition!(transition, persist), true);
    assert.equal(
      await prepared.commitTransition!(transition, async () =>
        assert.fail('stale preparation must not append'),
      ),
      false,
    );
    evidence.close();
    evidence = await openToolResultArchiveEvidenceReader(owner.lease);
    services = make();
    assert.deepEqual(
      await services.toolResultArchive.services.readToolResultArchive({
        ...placeholder,
        sessionId: 'session',
      }),
      { ok: true, serializedResult },
    );
    assert.equal(
      (
        await services.toolResultArchive.services.readToolResultArchive({
          ...placeholder,
          sessionId: 'other',
        })
      ).ok,
      false,
    );
    const identity = parseToolResultArchiveResourceRef(placeholder.resourceRef!);
    assert.ok(identity);
    assert.deepEqual(
      await services.toolResultArchive.services.readArchivedToolResultResource({
        ...identity,
        sessionId: 'session',
        maxBytes: input.originalBytes,
      }),
      { ok: true, serializedResult },
    );
    assert.deepEqual(
      await services.toolResultArchive.services.readArchivedToolResultResource({
        artifactId: old.id,
        bodySha256,
        originalBytes: input.originalBytes,
        sessionId: 'session',
        maxBytes: input.originalBytes,
      }),
      { ok: true, serializedResult },
    );
  } finally {
    db.close();
    evidence.close();
    artifacts.close();
    await owner.close();
    await rm(root, { recursive: true, force: true });
    await rm(owner.controlDirectory, { recursive: true, force: true });
  }
});

test('a refused projection preserves a shared image until Session cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-shared-projection-'));
  const owner = await tryAcquireInteractiveRootOwner(
    await resolveStorageRoot({ path: root, kind: 'interactive' }),
  );
  assert.ok(owner);
  const store = await openInteractiveArtifactStoreForWrite(owner.lease);
  const entered = deferred();
  const fail = deferred();
  let rejected: PromiseLike<unknown> | undefined;
  try {
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=',
      'base64',
    );
    const image = {
      type: 'file' as const,
      mediaType: 'image/png',
      data: { type: 'data' as const, data: bytes.toString('base64') },
    };
    const plan = createReadImageSnapshotPlanner(store);
    const shared = () =>
      plan({
        sessionId: 'session-1',
        turnId: 'turn-1',
        name: 'Tool Result image',
        bytes,
        mimeType: 'image/png',
      });
    let ordinal = 0;
    rejected = Promise.resolve(
      encodeDurableToolResultOutputWithArtifacts(
        {
          type: 'content',
          value: [
            image,
            {
              ...image,
              data: {
                type: 'data',
                data: Buffer.concat([bytes, Buffer.from([0])]).toString('base64'),
              },
            },
          ],
        },
        'session-1',
        () => {
          if (++ordinal === 1) return shared();
          return {
            ref: {
              kind: 'session_file' as const,
              sessionId: 'session-1',
              relativePath: 'failed-image',
            },
            persist: async () => {
              entered.resolve();
              await fail.promise;
              throw new Error('injected publication failure');
            },
          };
        },
      ),
    );
    await entered.promise;
    const accepted = await encodeDurableToolResultOutputWithArtifacts(
      { type: 'content', value: [image] },
      'session-1',
      shared,
    );
    assert.equal(accepted.kind, 'content');
    fail.resolve();
    assert.equal(((await rejected) as { kind: string }).kind, 'failure');
    const ref = shared().ref;
    assert.deepEqual(
      await store.readDurableAttachmentBinary({
        sessionId: ref.sessionId,
        artifactId: ref.relativePath,
      }),
      {
        ok: true,
        base64: bytes.toString('base64'),
        mimeType: 'image/png',
      },
    );
    const record = (await store.getInSession(ref.sessionId, ref.relativePath)).record;
    assert.ok(record);
    await store.purgeSessionArtifacts('session-1');
    await assert.rejects(stat(join(root, 'artifacts', record.relativePath)), { code: 'ENOENT' });
    assert.equal((await store.listPage('session-1', { offset: 0, limit: 10 })).total, 0);
    assert.deepEqual(
      await store.readDurableAttachmentBinary({
        sessionId: ref.sessionId,
        artifactId: ref.relativePath,
      }),
      {
        ok: false,
        reason: 'not_found',
      },
    );
  } finally {
    fail.resolve();
    await rejected;
    store.close();
    await owner.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Hosted execution publishes contained Tool Artifacts and durable result archives', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-host-execution-artifacts-'));
  const workspace = join(base, 'workspace');
  const outside = join(base, 'outside.txt');
  await mkdir(workspace);
  await writeFile(join(workspace, 'inside.txt'), 'inside artifact');
  await writeFile(join(workspace, 'oversized.bin'), '');
  await truncate(join(workspace, 'oversized.bin'), MAX_ATTACHMENT_BYTES + 1);
  await writeFile(outside, 'outside artifact');
  const capability = await resolveStorageRoot({ path: join(base, 'root'), kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  try {
    const store = await openInteractiveArtifactStoreForWrite(owner.lease);
    const services = createHostExecutionArtifactServices({
      artifacts: store,
      sessionAdmission: new SessionAdmissionGate(),
      sessions: { probeSessionRemoval: async () => ({ kind: 'present' }) },
      requestDrain: () => assert.fail('successful Artifact writes must not request Host drain'),
    });
    await services.recordToolArtifacts({
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolUseId: 'tool-use-1',
      toolName: 'Write',
      args: {},
      result: {},
      cwd: workspace,
      candidates: [
        { kind: 'file', name: 'inside.txt', sourcePath: 'inside.txt' },
        { kind: 'file', name: 'oversized.bin', sourcePath: 'oversized.bin' },
        { kind: 'file', name: 'outside.txt', sourcePath: outside },
      ],
    });
    const published = await store.listPage('session-1', { offset: 0, limit: 10 });
    assert.deepEqual(
      published.records.map((record) => record.name),
      ['inside.txt'],
    );

    const serializedResult = JSON.stringify({ output: 'x'.repeat(2_048) });
    const bodySha256 = createHash('sha256').update(serializedResult).digest('hex');
    const archiveInput = {
      sessionId: 'session-1',
      turnId: 'turn-1',
      runtimeEventId: 'runtime-event-1',
      toolCallId: 'tool-call-1',
      toolName: 'Bash',
      result: { output: 'x'.repeat(2_048) },
      serializedResult,
      originalEstimatedTokens: 512,
      originalBytes: Buffer.byteLength(serializedResult),
      rewriteVersion: 1 as const,
      reason: 'stale_tool_result_pruned_before_compact' as const,
      bodySha256,
    };
    assert.equal(
      await services.toolResultArchive.services.archiveToolResult(archiveInput),
      undefined,
      'without ledger evidence the Host must not fall back to publishing an Artifact',
    );
    const legacy = await store.create({
      sessionId: archiveInput.sessionId,
      turnId: archiveInput.turnId,
      name: 'legacy.json',
      kind: 'file',
      content: serializedResult,
      source: 'tool_result_archive',
    });
    const archived = { artifactId: legacy.id };
    assert.deepEqual(
      await services.toolResultArchive.services.readToolResultArchive({
        ...archiveInput,
        kind: 'maka.archived_tool_result',
        artifactId: archived.artifactId,
      }),
      { ok: true, serializedResult },
    );
    await store.close();
    restoreArtifactV1Shape(join(base, 'root'));
    const upgraded = await openInteractiveArtifactStoreForWrite(owner.lease);
    try {
      const successor = createHostExecutionArtifactServices({
        artifacts: upgraded,
        sessionAdmission: new SessionAdmissionGate(),
        sessions: { probeSessionRemoval: async () => ({ kind: 'present' }) },
        requestDrain: () => assert.fail('reading an upgraded archive must not drain'),
      });
      assert.deepEqual(
        await successor.toolResultArchive.services.readToolResultArchive({
          ...archiveInput,
          kind: 'maka.archived_tool_result',
          artifactId: archived.artifactId,
        }),
        { ok: true, serializedResult },
      );
    } finally {
      upgraded.close();
    }
  } finally {
    await owner.close();
    await rm(base, { recursive: true, force: true });
  }
});
