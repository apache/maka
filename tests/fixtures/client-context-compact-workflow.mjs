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
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { decodeStoredMessage } from '../../packages/core/src/session.ts';
import { watchSession } from './client-subscription.mjs';
import { createModelConnection } from './client-model-connection.mjs';
import {
  contextCompactFixture,
  original,
  summary,
  malformed,
} from './client-context-compact-fixture.mjs';

async function rows(connection, sessionId) {
  const observer = await watchSession(connection, sessionId, { kind: 'tail', maxBytes: 2 });
  try {
    const subscription = observer.subscription;
    let page = subscription.transcriptBootstrap.durable;
    const entries = [];
    for (;;) {
      const decoded = await subscription.decodeTranscriptPage(
        page,
        decodeStoredMessage,
        16 * 1024 * 1024,
      );
      entries.push(...decoded.messages);
      if (decoded.nextCursor === null) break;
      page = await subscription.loadTranscriptPage({
        direction: 'older',
        throughSequence: page.throughSequence,
        cursor: decoded.nextCursor,
        anchorSequence: null,
        maxBytes: 48 * 1024,
      });
    }
    return entries.sort((a, b) => a.identity - b.identity).map((entry) => entry.message);
  } finally {
    await observer.close();
  }
}

async function terminal(request, input, model) {
  const deadline = Date.now() + 10000;
  let turn;
  do {
    model.check();
    turn = await request('turn.query', input);
    if (['completed', 'failed', 'cancelled'].includes(turn.status)) break;
    await delay(10);
  } while (Date.now() < deadline);
  model.check();
  assert.equal(turn.status, 'completed');
  return turn;
}

async function mainTurn(request, sessionId, turnId, text, model) {
  const input = { sessionId, turnId, content: { text }, maxSteps: 3 };
  await request('turn.start', input);
  return { input, terminal: await terminal(request, { sessionId, turnId }, model) };
}

function hidden(rows, frames, compactId) {
  const content = JSON.stringify(rows);
  assert(
    !content.includes(JSON.stringify(summary).slice(1, -1)) &&
      !content.includes('COMPACT_BASELINE_PERSISTED') &&
      !content.includes(malformed),
    'summary text is not transcript content',
  );
  assert(
    !frames.some(
      (frame) => frame.kind === 'subscription.session_delta' && frame.delta.turnId === compactId,
    ),
    'summary output does not create visible assistant deltas',
  );
}

async function compact(
  request,
  connection,
  sessionId,
  turnId,
  expected,
  live,
  model,
  gated = false,
) {
  const input = { sessionId, turnId };
  const before = (await request('session.catalog.query', { kind: 'get', sessionId })).session;
  const beforeRows = await rows(connection, sessionId);
  const started = await request('context.compact', input);
  assert.equal(started.kind, 'started');
  assert.equal(started.turn.rootExecutionKind, 'context_compact');
  if (gated) {
    await model.summaryRequested;
    await live.waitFor(
      (frame) =>
        frame.kind === 'subscription.session_projection' &&
        frame.snapshot.rootTurn?.turnId === turnId &&
        frame.snapshot.rootTurn.rootExecutionKind === 'context_compact' &&
        frame.snapshot.rootTurn.status === 'running',
    );
    assert.equal((await request('context.compact', input)).kind, 'started');
    await assert.rejects(
      request('context.compact', { sessionId, turnId: 'busy-compact' }),
      (error) => error.code === 'session_busy',
    );
    await assert.rejects(
      request('turn.start', {
        sessionId,
        turnId,
        content: { text: 'wrong execution kind' },
      }),
      (error) => error.code === 'operation_conflict',
    );
    model.release();
  }
  const finishedTurn = await terminal(request, input, model);
  await live.terminal(finishedTurn);
  const finished = await request('context.compact', input);
  assert.equal(finished.kind, 'finished');
  assert.deepEqual(finished.turn, finishedTurn);
  assert.equal(finished.outcome.kind, expected);
  assert.deepEqual(finishedTurn.contextCompactionOutcome, finished.outcome);
  if (expected === 'compacted') assert.equal(typeof finished.outcome.checkpointId, 'string');
  else assert.equal(typeof finished.outcome.reason, 'string');
  assert.deepEqual(await request('context.compact', input), finished);
  const afterRows = await rows(connection, sessionId);
  for (const row of beforeRows)
    assert.deepEqual(
      afterRows.find((after) => after.id === row.id),
      row,
    );
  hidden(afterRows, live.frames, turnId);
  const after = (await request('session.catalog.query', { kind: 'get', sessionId })).session;
  for (const field of ['lastMessageAt', 'lastMessagePreview', 'lastReadMessageId', 'hasUnread'])
    assert.deepEqual(after[field], before[field], 'compaction cannot change visible ' + field);
  return { input, finished };
}

export async function verifyContextCompact(connection, workspace, reopened) {
  const request = (operation, input) => connection.request(operation, input, 5000);
  const path = join(workspace, 'context-compact.json');
  const saved = reopened
    ? JSON.parse(await readFile(path, 'utf8'))
    : { sessionId: 'context-compact' };
  const model = await contextCompactFixture(
    reopened ? Number(new URL(saved.baseUrl).port) : 0,
    reopened,
  );
  let live;
  try {
    if (reopened) {
      assert.deepEqual(await rows(connection, saved.sessionId), saved.rows);
      for (const item of saved.compactions)
        assert.deepEqual(await request('context.compact', item.input), item.finished);
      for (const turn of saved.turns)
        assert.deepEqual((await request('turn.start', turn.input)).turn, turn.terminal);
      await mainTurn(request, saved.sessionId, 'after-reopen', 'Continue after reopen', model);
      hidden(await rows(connection, saved.sessionId), [], '');
    } else {
      await writeFile(join(workspace, 'evidence.txt'), 'compact evidence read successfully\n');
      const created = await createModelConnection(request, {
        slug: 'context-compact',
        name: 'Context compact fixture',
        providerName: 'openai',
        apiKey: 'context-compact-fixture',
        baseUrl: model.baseUrl,
        enabledModelIds: ['fixture-model'],
        modelOverrides: { 'fixture-model': { contextWindow: 200000, vision: false } },
      });
      assert.equal(created.kind, 'committed');
      const basis = created.connection;
      await request('session.create', {
        sessionId: saved.sessionId,
        workspace: { kind: 'host_path', path: workspace },
        mode: 'bot',
        sandboxMode: 'read-only',
        modelTarget: {
          kind: 'explicit',
          connectionId: basis.connectionId,
          connectionSlug: 'context-compact',
          model: 'fixture-model',
        },
      });
      saved.baseUrl = model.baseUrl;
      live = await watchSession(connection, saved.sessionId);
      saved.turns = [await mainTurn(request, saved.sessionId, 'seed', original, model)];
      const seedRows = await rows(connection, saved.sessionId);
      await request('session.read_marker.set', {
        sessionId: saved.sessionId,
        readThroughMessageId: seedRows.findLast((row) => row.type === 'assistant').id,
      });
      saved.compactions = [
        await compact(
          request,
          connection,
          saved.sessionId,
          'compact-good',
          'compacted',
          live,
          model,
          true,
        ),
      ];
      saved.turns.push(
        await mainTurn(request, saved.sessionId, 'tail', 'tail after good compact', model),
      );
      saved.compactions.push(
        await compact(request, connection, saved.sessionId, 'compact-bad', 'failed', live, model),
      );
      saved.turns.push(
        await mainTurn(
          request,
          saved.sessionId,
          'after-bad',
          'Continue after rejected summary',
          model,
        ),
      );
      saved.rows = await rows(connection, saved.sessionId);
      hidden(saved.rows, live.frames, 'compact-good');
      hidden(saved.rows, live.frames, 'compact-bad');
      assert(saved.rows.some((row) => row.type === 'user' && row.text === original));
      await writeFile(path, JSON.stringify(saved));
    }
    model.verify();
    assert.equal((await connection.status(3000)).state, 'ready');
  } finally {
    model.release();
    try {
      await live?.close();
    } finally {
      await model.close();
    }
  }
}
