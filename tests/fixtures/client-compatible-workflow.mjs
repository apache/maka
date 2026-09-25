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
import { decodeStoredMessage } from '../../packages/core/src/session.ts';
import { watchSession } from './client-subscription.mjs';
import { compatibleFixture } from './client-compatible-fixture.mjs';

async function rows(connection, sessionId) {
  const observer = await watchSession(connection, sessionId, { kind: 'tail', maxBytes: 2 });
  try {
    return await observer.subscription.loadTranscript(decodeStoredMessage);
  } finally {
    await observer.close();
  }
}

export async function verifyCompatibleChat(connection, workspace, reopened) {
  const request = (operation, input) => connection.request(operation, input, 3000);
  const path = join(workspace, 'compatible.json');
  if (reopened) {
    const saved = JSON.parse(await readFile(path, 'utf8'));
    for (const item of saved.sessions) {
      assert.deepEqual(await rows(connection, item.sessionId), item.rows);
      for (const turn of item.turns)
        assert.deepEqual((await request('turn.start', turn.input)).turn, turn.terminal);
    }
    const model = await compatibleFixture(Number(new URL(saved.baseUrl).port), true);
    try {
      for (const field of ['reasoning', 'reasoning_content']) {
        const sessionId = 'compatible-' + field;
        const live = await watchSession(connection, sessionId);
        try {
          await request('turn.start', {
            sessionId,
            turnId: 'reopened',
            content: { text: field + ':max' },
            maxSteps: 3,
          });
          await live.waitFor(
            (frame) =>
              frame.kind === 'subscription.session_projection' &&
              frame.snapshot.rootTurn?.turnId === 'reopened' &&
              ['completed', 'failed', 'cancelled'].includes(frame.snapshot.rootTurn.status),
          );
          model.check();
          assert.equal(
            (await request('turn.query', { sessionId, turnId: 'reopened' })).status,
            'completed',
          );
        } finally {
          await live.close();
        }
      }
      model.verify();
    } finally {
      await model.close();
    }
    return;
  }
  const model = await compatibleFixture();
  try {
    await writeFile(join(workspace, 'evidence.txt'), 'compatible tool evidence\n');
    const created = await createModelConnection(request, {
      providerName: 'openai-compatible',
      slug: 'custom-chat-relay',
      name: 'Custom chat relay',
      baseUrl: model.baseUrl,
      apiKey: 'compatible-fixture',
      enabledModelIds: ['fixture-model'],
      modelOverrides: {
        'fixture-model': { contextWindow: 200000, thinkingLevels: ['high', 'max'] },
      },
    });
    const basis = created.connection;
    const saved = [];
    for (const field of ['reasoning', 'reasoning_content']) {
      const sessionId = 'compatible-' + field;
      await request('session.create', {
        sessionId,
        workspace: { kind: 'host_path', path: workspace },
        mode: 'bot',
        sandboxMode: 'read-only',
        modelTarget: {
          kind: 'explicit',
          connectionId: basis.connectionId,
          connectionSlug: 'custom-chat-relay',
          model: 'fixture-model',
        },
      });
      const live = await watchSession(connection, sessionId);
      const turns = [];
      try {
        for (const thinkingLevel of ['high', 'max']) {
          const session = (await request('session.catalog.query', { kind: 'get', sessionId }))
            .session;
          assert.equal(
            (
              await request('session.configuration.update', {
                sessionId,
                expectedRevision: session.revision,
                patch: { thinkingLevel },
              })
            ).kind,
            'committed',
          );
          const input = {
            sessionId,
            turnId: thinkingLevel,
            content: { text: field + ':' + thinkingLevel },
            maxSteps: 3,
          };
          await request('turn.start', input);
          await live.waitFor(
            (frame) =>
              frame.kind === 'subscription.session_projection' &&
              frame.snapshot.rootTurn?.turnId === thinkingLevel &&
              ['completed', 'failed', 'cancelled'].includes(frame.snapshot.rootTurn.status),
          );
          model.check();
          const terminal = await request('turn.query', { sessionId, turnId: thinkingLevel });
          assert.equal(terminal.status, 'completed');
          turns.push({ input, terminal });
        }
        const stored = await rows(connection, sessionId);
        const reasoning = stored.filter((row) => row.type === 'assistant' && row.thinking);
        for (const turnId of ['high', 'max']) {
          const parts = reasoning
            .filter((row) => row.turnId === turnId)
            .flatMap((row) => row.thinking.parts ?? [row.thinking]);
          assert.deepEqual(
            parts.map((part) => [part.text, part.providerOptions?.maka?.openAiChatReasoningField]),
            field === 'reasoning'
              ? [
                  ['first ', field],
                  ['second', field],
                ]
              : [['', field]],
          );
        }
        const calls = stored.filter((row) => row.type === 'tool_call');
        const results = stored.filter((row) => row.type === 'tool_result');
        assert.equal(calls.length, 2);
        assert.equal(results.length, 2);
        assert.notEqual(calls[0].id, calls[1].id);
        for (let i = 0; i < calls.length; i++) {
          assert.equal(results[i].toolUseId, calls[i].id);
          assert.equal(results[i].isError, false);
          assert.deepEqual(results[i].content, {
            kind: 'json',
            value: readPage('compatible tool evidence\n', { path: 'evidence.txt' }),
          });
        }
        saved.push({ sessionId, turns, rows: stored });
      } finally {
        await live.close();
      }
    }
    model.verify();
    await writeFile(path, JSON.stringify({ baseUrl: model.baseUrl, sessions: saved }));
  } finally {
    await model.close();
  }
}
