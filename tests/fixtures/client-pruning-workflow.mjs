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
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { decodeStoredMessage } from '../../packages/core/src/session.ts';
import { watchSession } from './client-subscription.mjs';
import { createModelConnection } from './client-model-connection.mjs';
import { pruningFixture, text } from './client-pruning-fixture.mjs';

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
function rawSource(stored) {
  const calls = stored.filter((row) => row.type === 'tool_call' && row.toolName === 'Shell');
  assert.equal(calls.length, 1, 'Resource reads must not rerun the source command');
  const raw = stored.find((row) => row.type === 'tool_result' && row.toolUseId === calls[0].id);
  assert.equal(raw.isError, false);
  assert.equal(raw.content.kind, 'json');
  assert.equal(raw.content.value.kind, 'terminal');
  assert.equal(raw.content.value.exitCode, 0);
  assert.equal(raw.content.value.output.stdout, text);
  assert.equal(raw.content.value.output.stdoutTruncated, false);
  assert(
    !JSON.stringify(stored).includes('maka.archived_tool_result'),
    'pruning does not replace UI raw or add placeholder messages',
  );
  assert(!JSON.stringify(stored).includes('PRUNING_PRIVATE_SUMMARY'));
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
async function mainTurn(request, sessionId, turnId, prompt, model) {
  const input = { sessionId, turnId, content: { text: prompt }, maxSteps: 4 };
  await request('turn.start', input);
  return { input, terminal: await terminal(request, sessionId, turnId, model) };
}

export async function verifyPruning(connection, workspace, reopened) {
  const request = (operation, input) => connection.request(operation, input, 5000);
  const path = join(workspace, 'pruning.json'),
    source = join(workspace, 'evidence.txt');
  const saved = reopened
    ? JSON.parse(await readFile(path, 'utf8'))
    : {
        sessionId: 'pruning',
        otherSessionId: 'pruning-other',
      };
  const model = await pruningFixture(reopened ? Number(new URL(saved.baseUrl).port) : 0, reopened);
  let live;
  try {
    if (reopened) {
      model.state.ref = saved.ref;
      assert.deepEqual(await rows(connection, saved.sessionId), saved.rows);
      for (const turn of [...saved.turns, saved.otherTurn])
        assert.deepEqual((await request('turn.start', turn.input)).turn, turn.terminal);
      assert.deepEqual(
        await request('context.compact', saved.compact.input),
        saved.compact.finished,
      );
      await assert.rejects(readFile(source), (error) => error.code === 'ENOENT');
      await mainTurn(
        request,
        saved.sessionId,
        'reopened',
        'Read the retained archive reference after restart',
        model,
      );
      rawSource(await rows(connection, saved.sessionId));
    } else {
      await writeFile(source, text);
      const created = await createModelConnection(request, {
        slug: 'pruning',
        name: 'Pruning fixture',
        providerName: 'openai',
        apiKey: 'pruning-fixture',
        baseUrl: model.baseUrl,
        enabledModelIds: ['fixture-model'],
        modelOverrides: { 'fixture-model': { contextWindow: 200000, vision: false } },
      });
      assert.equal(created.kind, 'committed');
      const basis = created.connection;
      for (const sessionId of [saved.sessionId, saved.otherSessionId])
        await request('session.create', {
          sessionId,
          workspace: { kind: 'host_path', path: workspace },
          sandboxMode: 'danger-full-access',
          modelTarget: {
            kind: 'explicit',
            connectionId: basis.connectionId,
            connectionSlug: 'pruning',
            model: 'fixture-model',
          },
        });
      live = await watchSession(connection, saved.sessionId);
      saved.turns = [
        await mainTurn(
          request,
          saved.sessionId,
          'read-and-archive',
          'Capture evidence.txt using Shell, then Read its archived output',
          model,
        ),
      ];
      saved.ref = model.state.ref;
      assert.match(saved.ref, /^archive:[0-9a-f-]{36}$/);
      const before = await rows(connection, saved.sessionId);
      rawSource(before);
      await unlink(source);
      const compactInput = { sessionId: saved.sessionId, turnId: 'compact' };
      assert.equal((await request('context.compact', compactInput)).kind, 'started');
      await model.waitForSummary();
      rawSource(await rows(connection, saved.sessionId));
      model.release();
      const compactTurn = await terminal(request, saved.sessionId, compactInput.turnId, model);
      await live.terminal(compactTurn);
      const finished = await request('context.compact', compactInput);
      assert.equal(finished.kind, 'finished');
      assert.equal(finished.outcome.kind, 'compacted');
      saved.compact = { input: compactInput, finished };
      assert(
        !live.frames.some(
          (frame) =>
            frame.kind === 'subscription.session_delta' &&
            frame.delta.turnId === compactInput.turnId,
        ),
      );
      saved.turns.push(
        await mainTurn(
          request,
          saved.sessionId,
          'retained',
          'Read the retained archive and reject a forged reference',
          model,
        ),
      );
      saved.otherTurn = await mainTurn(
        request,
        saved.otherSessionId,
        'foreign',
        'Try the archive reference from another Session',
        model,
      );
      saved.rows = await rows(connection, saved.sessionId);
      rawSource(saved.rows);
      for (const row of before)
        assert.deepEqual(
          saved.rows.find((current) => current.id === row.id),
          row,
        );
      saved.baseUrl = model.baseUrl;
      saved.requestCount = 8;
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
