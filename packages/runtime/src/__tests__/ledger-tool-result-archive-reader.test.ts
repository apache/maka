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
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { openToolResultArchiveEvidenceReader } from '@maka/storage/tool-result-archive-evidence';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { AgentRunEvent } from '@maka/core/agent-run';
import type { DurableToolResultProjection } from '@maka/core/durable-tool-result-projection';
import { buildModelProjectionTransition } from '@maka/core/model-projection-transition';
import { createLedgerToolResultArchiveReader } from '../ledger-tool-result-archive-reader.js';
import { serializedToolResultProjection } from '../tool-result-archive-transition.js';
import { serializeToolResultProjectionV1 } from '../tool-result-archive-encoding.js';
import {
  buildArchivedToolResultPlaceholder,
  type ToolResultArchiveReaderInput,
} from '../tool-result-archive.js';

function fixture(
  source: DurableToolResultProjection = { version: 1, kind: 'text', text: 'bounded model output' },
) {
  const event: RuntimeEvent = {
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
      result: 'RAW SECRET MUST NOT BE READ',
      modelProjection: source,
    },
  };
  const body = serializeToolResultProjectionV1(source);
  const placeholder = buildArchivedToolResultPlaceholder({
    artifactId: 'archive',
    runtimeEventId: event.id,
    toolCallId: 'call',
    toolName: 'Read',
    bodySha256: createHash('sha256').update(body).digest('hex'),
    originalBytes: Buffer.byteLength(body),
    originalEstimatedTokens: 100,
    reason: 'stale_tool_result_pruned_before_compact',
  });
  const transition = buildModelProjectionTransition({
    sessionId: 'session',
    target: {
      runtimeEventId: 'response',
      part: 'tool_result',
      toolCallId: 'call',
      toolName: 'Read',
    },
    sourceProjection: source,
    replacement: { version: 1, kind: 'json', value: placeholder as never },
    now: 2,
  });
  const records = [envelope(transition)];
  const reader = createLedgerToolResultArchiveReader({
    read: async () => ({ ok: true, event, transitions: records }),
  });
  return { event, placeholder, transition, records, reader, body, source };
}
function envelope(transition: ReturnType<typeof buildModelProjectionTransition>): AgentRunEvent {
  return {
    id: transition.transitionId,
    type: 'model_projection_transition_recorded',
    sessionId: 'session',
    runId: 'run',
    turnId: 'turn',
    ts: 2,
    data: { runtimeEventId: 'response', part: 'tool_result', transition },
  };
}

test('reads committed SQLite evidence after reopen without any Artifact payload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-ledger-archive-'));
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  try {
    const initial = await openToolResultArchiveEvidenceReader(owner.lease);
    initial.close();
    const f = fixture();
    const db = new DatabaseSync(join(root, 'runtime.sqlite'));
    try {
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
        JSON.stringify(f.event),
        1,
      );
      db.prepare(
        'INSERT INTO core_agent_runs(session_id, run_id, created_at) VALUES (?, ?, ?)',
      ).run('session', 'run', 1);
      db.prepare('INSERT INTO core_agent_run_events VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        'session',
        'run',
        1,
        f.transition.transitionId,
        'model_projection_transition_recorded',
        2,
        JSON.stringify(f.records[0]),
      );
    } finally {
      db.close();
    }
    const evidence = await openToolResultArchiveEvidenceReader(owner.lease);
    try {
      const reader = createLedgerToolResultArchiveReader(evidence);
      assert.deepEqual(await reader({ ...f.placeholder, sessionId: 'session' }), {
        ok: true,
        serializedResult: f.body,
      });
      assert.equal((await reader({ ...f.placeholder, sessionId: 'foreign' })).ok, false);
    } finally {
      evidence.close();
    }
  } finally {
    await owner.close();
    await rm(root, { recursive: true, force: true });
    await rm(owner.controlDirectory, { recursive: true, force: true });
  }
});

test('v1 archive encoding is byte-identical for text, JSON, denial and media', () => {
  const sources: DurableToolResultProjection[] = [
    { version: 1, kind: 'text', text: '中文\n"quoted"\\' },
    { version: 1, kind: 'json', value: { z: ['中文', 1, null], a: 'line\nend' } },
    { version: 1, kind: 'execution_denied', reason: 'no' },
    {
      version: 1,
      kind: 'content',
      parts: [
        { kind: 'text', text: 'caption' },
        {
          kind: 'artifact',
          mediaType: 'image/png',
          ref: { kind: 'session_context', sessionId: 'session', refId: 'image' },
        },
      ],
    },
  ];
  for (const source of sources)
    assert.equal(serializeToolResultProjectionV1(source), serializedToolResultProjection(source));
});

test('reads the source of an applied archive transition, never the raw result', async () => {
  const f = fixture();
  assert.deepEqual(await f.reader({ ...f.placeholder, sessionId: 'session' }), {
    ok: true,
    serializedResult: f.body,
  });
});

test('refuses missing projections instead of applying the legacy tool projector', async () => {
  const f = fixture();
  if (f.event.content?.kind === 'function_response') delete f.event.content.modelProjection;
  assert.deepEqual(await f.reader({ ...f.placeholder, sessionId: 'session' }), {
    ok: false,
    reason: 'source_mismatch',
  });
});

test('fails closed on Session, identity, encoding, size and hash mismatch', async () => {
  const f = fixture();
  for (const override of [
    { sessionId: 'foreign' },
    { toolCallId: 'foreign' },
    { rewriteVersion: 2 },
    { originalBytes: 999 },
    { bodySha256: 'f'.repeat(64) },
    { maxBytes: 1 },
  ]) {
    assert.equal(
      (
        await f.reader({
          ...f.placeholder,
          sessionId: 'session',
          ...override,
        } as ToolResultArchiveReaderInput)
      ).ok,
      false,
    );
  }
});

test('cannot read an archive without a committed, applicable transition', async () => {
  const f = fixture();
  f.records.length = 0;
  assert.equal((await f.reader({ ...f.placeholder, sessionId: 'session' })).ok, false);
  f.records.push(envelope({ ...f.transition, sourceProjectionDigest: `sha256:${'a'.repeat(64)}` }));
  assert.equal((await f.reader({ ...f.placeholder, sessionId: 'session' })).ok, false);
});

test('rejects losing siblings using the existing reducer and accepts duplicate appends', async () => {
  const f = fixture();
  const sibling = buildModelProjectionTransition({
    sessionId: 'session',
    target: f.transition.target,
    sourceProjection: f.source,
    replacement: { version: 1, kind: 'text', text: 'sibling' },
    now: 3,
  });
  // IDs are the reducer's tie break; do not invent a different winner here.
  const archiveWins = f.transition.transitionId < sibling.transitionId;
  f.records.push(envelope(sibling), envelope(f.transition));
  assert.equal((await f.reader({ ...f.placeholder, sessionId: 'session' })).ok, archiveWins);
  f.records.reverse();
  assert.equal((await f.reader({ ...f.placeholder, sessionId: 'session' })).ok, archiveWins);
});

test('reconstructs a predecessor replacement rather than the original or final projection', async () => {
  const f = fixture();
  const before = buildModelProjectionTransition({
    sessionId: 'session',
    target: f.transition.target,
    sourceProjection: { version: 1, kind: 'text', text: 'earlier' },
    replacement: f.source,
    now: 1,
  });
  if (f.event.content?.kind === 'function_response')
    f.event.content.modelProjection = { version: 1, kind: 'text', text: 'earlier' };
  const archive = buildModelProjectionTransition({
    sessionId: 'session',
    target: f.transition.target,
    sourceProjection: f.source,
    replacement: f.transition.replacement,
    previousTransitionId: before.transitionId,
    now: 2,
  });
  const final = buildModelProjectionTransition({
    sessionId: 'session',
    target: f.transition.target,
    sourceProjection: archive.replacement,
    replacement: { version: 1, kind: 'text', text: 'final' },
    previousTransitionId: archive.transitionId,
    now: 3,
  });
  f.records.splice(0, f.records.length, envelope(final), envelope(archive), envelope(before));
  assert.deepEqual(await f.reader({ ...f.placeholder, sessionId: 'session' }), {
    ok: true,
    serializedResult: f.body,
  });
});

test('unknown transition versions and incomplete evidence do not expose a source', async () => {
  const f = fixture();
  f.records[0]!.data = {
    runtimeEventId: 'response',
    transition: { ...f.transition, version: 999 },
  };
  assert.equal((await f.reader({ ...f.placeholder, sessionId: 'session' })).ok, false);
  const reader = createLedgerToolResultArchiveReader({
    read: async () => ({ ok: false, reason: 'too_large' }),
  });
  assert.deepEqual(await reader({ ...f.placeholder, sessionId: 'session' }), {
    ok: false,
    reason: 'too_large',
  });
});
