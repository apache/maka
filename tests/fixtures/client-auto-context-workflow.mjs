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
import { createModelConnection } from './client-model-connection.mjs';
import { readPage } from '../../packages/runtime/src/read-page.ts';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { decodeStoredMessage } from '../../packages/core/src/session.ts';
import { watchSession } from './client-subscription.mjs';
import { autoContextFixture, anchor, evidence, summary } from './client-auto-context-fixture.mjs';

function noSummary(value) {
  assert(
    !JSON.stringify(value).includes('AUTO_SUMMARY_PRIVATE'),
    'summary body must remain model-only',
  );
}
function ordinaryRoot(frames) {
  noSummary(frames);
  for (const frame of frames)
    if (frame.kind === 'subscription.session_projection')
      assert.equal(
        frame.snapshot.rootTurn?.rootExecutionKind,
        undefined,
        'auto compaction is the same Message turn',
      );
}
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
    const stored = entries.sort((a, b) => a.identity - b.identity).map((entry) => entry.message);
    noSummary(stored);
    return stored;
  } finally {
    await observer.close();
  }
}
async function terminal(request, sessionId, turnId, model) {
  const deadline = Date.now() + 10000;
  let result;
  do {
    model.check();
    result = await request('turn.query', { sessionId, turnId });
    if (['completed', 'failed', 'cancelled'].includes(result.status)) break;
    await delay(10);
  } while (Date.now() < deadline);
  model.check();
  assert.equal(result.status, 'completed');
  return result;
}
function diagnostics(value, inputTokens, cacheReadInputTokens, since) {
  assert.equal(typeof value.completedAt, 'number');
  assert(value.completedAt >= since && value.completedAt <= Date.now());
  const { current, ...completed } = value;
  if (current !== undefined) {
    assert.equal(typeof current.connectionId, 'string');
    assert(current.tokens >= inputTokens);
    assert.equal(current.approximate, true);
  }
  assert.deepEqual(completed, {
    status: 'available',
    providerId: 'openai',
    modelId: 'fixture-model',
    completedAt: value.completedAt,
    inputTokens,
    cacheReadInputTokens,
    contextWindow: 1000000,
  });
}
function readResult(stored) {
  const results = stored.filter((row) => row.type === 'tool_result');
  assert.equal(results.length, 1, 'the completed tool must never be replayed');
  assert.equal(results[0].isError, false);
  assert.deepEqual(results[0].content, {
    kind: 'json',
    value: readPage(evidence, { path: 'evidence.txt' }),
  });
}

export async function verifyAutoContext(connection, workspace, reopened) {
  const request = (operation, input) => connection.request(operation, input, 5000);
  const path = join(workspace, 'auto-context.json');
  const saved = reopened ? JSON.parse(await readFile(path, 'utf8')) : { sessionId: 'auto-context' };
  const model = await autoContextFixture(
    reopened ? Number(new URL(saved.baseUrl).port) : 0,
    reopened,
  );
  const query = () => request('context.diagnostics.query', { sessionId: saved.sessionId });
  let live, during;
  try {
    if (reopened) {
      assert.deepEqual(
        await query(),
        saved.diagnostics,
        'diagnostics keep the exact completed request across restart',
      );
      assert.deepEqual(await rows(connection, saved.sessionId), saved.rows);
      assert.deepEqual((await request('turn.start', saved.turn)).turn, saved.terminal);
      const since = Date.now();
      await request('turn.start', {
        sessionId: saved.sessionId,
        turnId: 'reopened',
        content: { text: 'Continue from the automatic checkpoint' },
        maxSteps: 2,
      });
      await terminal(request, saved.sessionId, 'reopened', model);
      diagnostics(await query(), 14, 4, since);
      readResult(await rows(connection, saved.sessionId));
    } else {
      await writeFile(join(workspace, 'evidence.txt'), evidence);
      const created = await createModelConnection(request, {
        providerName: 'openai',
        slug: 'auto-context',
        name: 'Automatic context fixture',
        baseUrl: model.baseUrl,
        apiKey: 'auto-context-fixture',
        enabledModelIds: ['fixture-model'],
        modelOverrides: {
          'fixture-model': { vision: false, contextWindow: 1000000, maxOutputTokens: 128000 },
        },
      });
      const basis = created.connection;
      await request('session.create', {
        sessionId: saved.sessionId,
        workspace: { kind: 'host_path', path: workspace },
        mode: 'bot',
        sandboxMode: 'read-only',
        modelTarget: {
          kind: 'explicit',
          connectionId: basis.connectionId,
          connectionSlug: 'auto-context',
          model: 'fixture-model',
        },
      });
      assert.deepEqual(await query(), { status: 'unavailable', reason: 'no_completed_request' });
      live = await watchSession(connection, saved.sessionId);
      saved.turn = {
        sessionId: saved.sessionId,
        turnId: 'automatic',
        content: { text: anchor },
        maxSteps: 3,
      };
      const since = Date.now();
      await request('turn.start', saved.turn);
      await model.waitFor('summary');
      await model.waitFor('overlap');
      const firstDiagnostics = await query();
      diagnostics(firstDiagnostics, 849990, 7, since);
      const settledRows = await rows(connection, saved.sessionId);
      readResult(settledRows);
      await request('session.read_marker.set', {
        sessionId: saved.sessionId,
        readThroughMessageId: settledRows.find((row) => row.type === 'user').id,
      });
      const catalog = (
        await request('session.catalog.query', { kind: 'get', sessionId: saved.sessionId })
      ).session;
      during = await watchSession(connection, saved.sessionId, { kind: 'tail', maxBytes: 2 });
      assert.equal(during.subscription.snapshot.rootTurn.status, 'running');
      assert.equal(during.subscription.snapshot.rootTurn.rootExecutionKind, undefined);
      assert.deepEqual(during.subscription.activeAssistantStreams, []);
      noSummary(await during.subscription.loadTranscript(decodeStoredMessage));
      ordinaryRoot(live.frames);
      model.releaseSummary();
      model.releaseOverlap();
      await model.waitFor('main');
      const afterCompaction = await query();
      const { current: _beforeCurrent, ...beforeMain } = firstDiagnostics;
      const { current: afterCurrent, ...afterMain } = afterCompaction;
      assert.equal(
        afterCurrent,
        undefined,
        'compaction invalidates old current usage until the next Main settles',
      );
      assert.deepEqual(
        afterMain,
        beforeMain,
        'completed summary cannot replace completed main diagnostics',
      );
      const afterSummary = (
        await request('session.catalog.query', { kind: 'get', sessionId: saved.sessionId })
      ).session;
      for (const field of ['lastMessageAt', 'lastMessagePreview', 'lastReadMessageId', 'hasUnread'])
        assert.deepEqual(afterSummary[field], catalog[field], 'summary cannot change ' + field);
      const checkpointRows = await rows(connection, saved.sessionId);
      for (const row of settledRows)
        assert.deepEqual(
          checkpointRows.find((next) => next.id === row.id),
          row,
        );
      ordinaryRoot(live.frames);
      ordinaryRoot(during.frames);
      model.releaseMain();
      saved.terminal = await terminal(request, saved.sessionId, saved.turn.turnId, model);
      await live.terminal(saved.terminal);
      saved.diagnostics = await query();
      diagnostics(saved.diagnostics, 12, 3, since);
      saved.rows = await rows(connection, saved.sessionId);
      readResult(saved.rows);
      ordinaryRoot(live.frames);
      ordinaryRoot(during.frames);
      assert.deepEqual((await request('turn.start', saved.turn)).turn, saved.terminal);
      saved.baseUrl = model.baseUrl;
      saved.summary = summary;
      saved.requestCount = 4;
      await writeFile(path, JSON.stringify(saved));
    }
    model.verify();
    assert.equal((await connection.status(3000)).state, 'ready');
  } finally {
    model.releaseSummary();
    model.releaseMain();
    try {
      await during?.close();
      await live?.close();
    } finally {
      await model.close();
    }
  }
}
