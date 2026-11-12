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
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createSessionStore } from '@maka/storage/session-store';
import { createSqliteAgentRunStore } from '@maka/storage/agent-run-store';
import { createWorkspaceRuntimeStore } from '@maka/storage/runtime-event-persistence';
import { PluginExecutorBackend } from '../plugin-executor-backend.js';
import { PluginExecutorService } from '../plugin-executor-service.js';
import { Context } from '../plugin-kernel.js';
import { BackendRegistry, SessionManager } from '../session-manager.js';
import { projectRuntimeEventsToStoredMessages } from '../runtime-event-read-model.js';

for (const outcome of [
  'cancelled',
  'cancelled-oversized',
  'abort-error',
  'failed',
  'transport-error',
] as const) {
  test(`interrupted executor output survives SQLite reopen: ${outcome}`, {
    timeout: 10_000,
  }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'maka-executor-history-'));
    const sessions = createSessionStore(directory);
    const runs = createSqliteAgentRunStore(directory);
    const events = createWorkspaceRuntimeStore(directory);
    const root = new Context();
    const service = new PluginExecutorService(root);
    const cancelling =
      outcome === 'cancelled' || outcome === 'cancelled-oversized' || outcome === 'abort-error';
    root
      .extend({
        maka: { rootId: 'profile', packageId: 'fixture', entryId: 'provider', generation: 1 },
      })
      .executors.register({
        id: 'remote',
        execute: async (_request, context) => {
          context.emit({ type: 'output_delta', text: '保留 before stop' });
          if (cancelling) {
            await new Promise<void>((resolve) =>
              context.signal.addEventListener('abort', () => resolve(), { once: true }),
            );
          }
          // Cancellation still drains updates until the provider settles.
          if (outcome === 'cancelled-oversized') {
            for (let index = 0; index < 17; index++)
              context.emit({ type: 'output_delta', text: 'x'.repeat(16 * 1024) });
          }
          context.emit({ type: 'output_delta', text: ' and final update.' });
          if (outcome === 'abort-error' || outcome === 'transport-error')
            throw new Error('transport ended');
          return cancelling
            ? { status: 'cancelled', providerStopReason: 'cancelled' }
            : { status: 'failed', message: 'provider failed' };
        },
      });
    const backends = new BackendRegistry();
    backends.register(
      'plugin-executor',
      (context) =>
        new PluginExecutorBackend({
          sessionId: context.sessionId,
          cwd: directory,
          binding: service.bind(context.sessionId, 'remote'),
        }),
    );
    const manager = new SessionManager({
      store: sessions,
      runStore: runs,
      runtimeEventStore: events,
      backends,
      newId: randomUUID,
      now: Date.now,
    });
    try {
      const session = await manager.createSession({
        cwd: directory,
        executorId: 'remote',
        llmConnectionSlug: 'executor:remote',
        permissionMode: 'bypass',
      });
      let stopping: Promise<void> | undefined;
      for await (const event of manager.sendMessage(session.id, {
        turnId: 'turn-a',
        text: 'write a long answer',
      })) {
        if (event.type === 'text_delta' && cancelling && !stopping)
          stopping = manager.stopSession(session.id);
      }
      await stopping;
      events.close();
      const reopened = createWorkspaceRuntimeStore(directory);
      try {
        const ledger = await reopened.readSessionRuntimeEvents(session.id);
        const invocations = await reopened.listSessionInvocations(session.id);
        const answers = projectRuntimeEventsToStoredMessages(ledger, {
          invocations,
        }).messages.filter((message) => message.type === 'assistant');
        assert.equal(answers.length, 1, 'the visible partial answer survives exactly once');
        const marker = '\n[Response truncated]';
        const expected =
          outcome === 'cancelled-oversized'
            ? '保留 before stop' +
              'x'.repeat(256 * 1024 - Buffer.byteLength('保留 before stop' + marker)) +
              marker
            : '保留 before stop and final update.';
        assert.equal(answers[0]?.text, expected);
        assert.ok(Buffer.byteLength(answers[0]!.text) <= 256 * 1024);
        const saved = ledger.filter(
          (event) => event.role === 'model' && event.content?.kind === 'text',
        );
        assert.equal(saved.length, 1);
        assert.equal(saved[0]?.partial, false);
        assert.equal(
          saved[0]?.modelVisibility,
          'hidden',
          'interrupted output is display history, not completed model context',
        );
        assert.equal(saved[0]?.content?.kind === 'text' && saved[0].content.interrupted, true);
        assert.equal(invocations[0]?.terminalEvent?.status, cancelling ? 'aborted' : 'failed');
      } finally {
        reopened.close();
      }
    } finally {
      await root.fiber.dispose();
      events.close();
      runs.close?.();
      await sessions.close?.();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
