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
import type { DurableToolResultProjection } from '@maka/core/durable-tool-result-projection';
import {
  parseToolResultArchiveResourceRef,
  readToolResultArchiveResource,
} from '@maka/runtime/tool-result-archive-resource';
import { shapeTerminalResult } from '@maka/runtime/shell-tools';
import { readPageSchema, READ_PAGE_MAX_CHARS } from '@maka/runtime/read-page';
import { TOOL_RESULT_ARCHIVE_EVIDENCE_MAX_BYTES } from '@maka/core/tool-result-archive-evidence';
import { mkdir, mkdtemp, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MAX_ATTACHMENT_BYTES } from '@maka/core/attachments';
import {
  openInteractiveArtifactStoreForWrite,
  createReadImageSnapshotPlanner,
} from '@maka/storage/artifact-stores';
import {
  encodeDurableToolResultOutput,
  encodeDurableToolResultOutputWithArtifacts,
} from '@maka/runtime/durable-tool-result-projection';
import { durableProjectionToToolResultOutput } from '@maka/runtime/durable-tool-result-projection';
import { deferred } from '@maka/core/test-only/async-primitives';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { createHostExecutionArtifactServices } from '../server/execution-artifacts.js';
import { restoreArtifactV1Shape } from './fixtures/artifact-v1.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';

for (const scenario of ['text', 'large raw MCP image', 'executor-sized Bash'] as const) {
  test(`production archives survive reopen (${scenario})`, async () => {
    const largeImage = scenario === 'large raw MCP image';
    const largeBash = scenario === 'executor-sized Bash';
    const root = await mkdtemp(join(tmpdir(), 'maka-ledger-archive-host-'));
    const owner = await tryAcquireInteractiveRootOwner(
      await resolveStorageRoot({ path: root, kind: 'interactive' }),
    );
    assert.ok(owner);
    const artifacts = await openInteractiveArtifactStoreForWrite(owner.lease);
    let evidence = await openToolResultArchiveEvidenceReader(owner.lease);
    const db = new DatabaseSync(join(root, 'runtime.sqlite'));
    try {
      // Control characters exercise JSON's worst-case six-byte escaping.
      const stream = `${'\u0001'.repeat(127)}\n`.repeat(8191);
      const bash = largeBash
        ? shapeTerminalResult({
            cwd: root,
            command: 'synthetic bounded output',
            result: {
              stdout: `FRONT\n${stream}TAIL`,
              stderr: `ERROR_FRONT\n${stream}ERROR_TAIL`,
              exitCode: 7,
              stdoutTruncated: true,
            },
          })
        : undefined;
      const projection: DurableToolResultProjection = bash
        ? encodeDurableToolResultOutput({ type: 'json', value: bash as never }, 'session')
        : largeImage
          ? {
              version: 1,
              kind: 'content',
              parts: [
                {
                  kind: 'artifact',
                  mediaType: 'image/png',
                  ref: { kind: 'session_file', sessionId: 'session', relativePath: 'mcp-image' },
                },
              ],
            }
          : { version: 1, kind: 'text', text: 'durable ledger body' };
      const output = durableProjectionToToolResultOutput(projection);
      assert.ok('value' in output);
      const serializedResult = JSON.stringify(output.value);
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
          name: bash ? 'Bash' : 'Read',
          result:
            bash ??
            (largeImage
              ? {
                  content: [
                    {
                      type: 'image',
                      mimeType: 'image/png',
                      data: Buffer.alloc(2 * 1024 * 1024).toString('base64'),
                    },
                  ],
                }
              : 'raw execution body'),
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
      const projectedEvidence = await evidence.read({
        sessionId: 'session',
        runtimeEventId: 'response',
      });
      assert.ok(projectedEvidence.ok);
      assert.ok(projectedEvidence.storedBytes! < TOOL_RESULT_ARCHIVE_EVIDENCE_MAX_BYTES);
      if (bash) assert.ok(projectedEvidence.storedBytes! > 12_000_000);
      else assert.ok(projectedEvidence.storedBytes! < 4096);
      assert.equal(
        projectedEvidence.event.content?.kind === 'function_response'
          ? projectedEvidence.event.content.result
          : undefined,
        null,
      );
      const old = bash
        ? undefined
        : await artifacts.create({
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
        toolName: bash ? 'Bash' : 'Read',
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
      assert.equal(
        (await artifacts.listPage('session', { offset: 0, limit: 10 })).total,
        bash ? 0 : 1,
      );
      const placeholder = buildLedgerArchivedToolResultPlaceholder({ ...input, storage: 'ledger' });
      const transition = buildModelProjectionTransition({
        sessionId: 'session',
        target: {
          runtimeEventId: 'response',
          part: 'tool_result',
          toolCallId: 'call',
          toolName: bash ? 'Bash' : 'Read',
        },
        sourceProjection: projection,
        replacement: { version: 1, kind: 'json', value: placeholder as never },
        now: 2,
      });
      db.prepare(
        'INSERT INTO core_agent_runs(session_id, run_id, created_at) VALUES (?, ?, ?)',
      ).run('session', 'run', 1);
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
        await services.toolResultArchive.services.readArchivedToolResultResource({
          storage: 'event',
          runtimeEventId: placeholder.runtimeEventId,
          maxBytes: input.originalBytes,
          sessionId: 'session',
        }),
        { ok: true, serializedResult },
      );
      assert.equal(
        (
          await services.toolResultArchive.services.readArchivedToolResultResource({
            storage: 'event',
            runtimeEventId: placeholder.runtimeEventId,
            maxBytes: input.originalBytes,
            sessionId: 'other',
          })
        ).ok,
        false,
      );
      const identity = { storage: 'event' as const, runtimeEventId: placeholder.runtimeEventId };
      assert.ok(identity);
      assert.deepEqual(
        await services.toolResultArchive.services.readArchivedToolResultResource({
          ...identity,
          sessionId: 'session',
          maxBytes: input.originalBytes,
        }),
        { ok: true, serializedResult },
      );
      if (bash) {
        const read = async (offset: number) => {
          const page = readPageSchema.parse(
            await readToolResultArchiveResource(services.toolResultArchive.services, 'session', {
              path: 'maka://runtime/tool-results/response',
              offset,
              limit: 1,
            }),
          );
          assert.ok(JSON.stringify(page).length <= READ_PAGE_MAX_CHARS);
          assert.equal(page.metadata?.exitCode, 7);
          assert.equal(page.metadata?.status, 'failed');
          assert.equal(page.metadata?.stdoutTruncated, true);
          return page.content;
        };
        assert.equal(await read(0), 'FRONT');
        assert.equal(await read(8192), 'TAIL');
        assert.equal(await read(8193), 'ERROR_FRONT');
        assert.equal(await read(16385), 'ERROR_TAIL');
      }
      if (old)
        assert.deepEqual(
          await services.toolResultArchive.services.readArchivedToolResultResource({
            artifactId: old.id,
            bodySha256,
            originalBytes: input.originalBytes,
            sessionId: 'session',
            maxBytes: input.originalBytes,
          }),
          { ok: false, reason: 'read_failed' },
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
}

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
      await services.toolResultArchive.services.readArchivedToolResultResource({
        ...archiveInput,
        maxBytes: archiveInput.originalBytes,
        artifactId: archived.artifactId,
      }),
      { ok: false, reason: 'read_failed' },
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
        await successor.toolResultArchive.services.readArchivedToolResultResource({
          ...archiveInput,
          maxBytes: archiveInput.originalBytes,
          artifactId: archived.artifactId,
        }),
        { ok: false, reason: 'read_failed' },
      );
    } finally {
      upgraded.close();
    }
  } finally {
    await owner.close();
    await rm(base, { recursive: true, force: true });
  }
});
