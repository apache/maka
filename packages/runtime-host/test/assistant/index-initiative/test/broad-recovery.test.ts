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

import test from 'node:test';
import { legacyState } from './runner-fixture.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InitiativeController } from '../../../../src/assistant/index-initiative/controller.js';
import { InitiativeStore } from '../../../../src/assistant/index-initiative/store.js';
import { output, note } from './notebook-output.js';

// A restart must not turn a saved request body into a second investigation. Which of the
// two things happens is the Host's answer to give: a wake it still holds is reattached,
// and only a wake it proves absent is submitted again -- under its original identity.
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'initiative-broad-recovery-'));
  const submissions: { prompt: string; messageId?: string }[] = [];
  const prompts: string[] = [];
  // 'pending' is the window that used to be misread: accepted and queued in the Host, not
  // started yet, so the agent snapshot is not 'running'.
  const queue = new Map<string, 'pending' | 'owned' | 'not_admitted'>();
  const started = new Set<string>();
  let owner = 'first';
  let window = 0;
  const agent = (sessionId: string) => ({
    sessionId,
    followup: async (prompt: string, options?: { messageId?: string }) => {
      submissions.push({ prompt, messageId: options?.messageId });
      prompts.push(prompt);
      const messageId = String(options?.messageId);
      queue.set(messageId, 'pending');
      if (owner === 'first' && window === 1) {
        // The first window dies mid-cycle: its lease expires, so no later write from it can
        // be accepted and the activation stays unconfirmed for the next owner.
        store!.db.exec('UPDATE lease SET until_at=0');
      }
      return { disposition: 'turn_started' };
    },
    messageExecution: async (messageId: string) => {
      const state = queue.get(messageId) ?? 'not_admitted';
      // The Host's own turn runs the queued message in a later window and writes its result.
      if (state === 'pending' && window > 1) {
        queue.set(messageId, 'owned');
        if (!started.has(messageId)) {
          started.add(messageId);
          await output(prompts.at(-1)!, { notes: [note] });
        }
        return { messageId, state: 'owned' };
      }
      return { messageId, state };
    },
    transcript: async () => prompts.map((text) => ({ type: 'user', text })),
    snapshot: async () => ({ agent: { status: 'idle' }, pendingInteractions: 0 }),
    whenIdle: async () => {},
    cancel: async () => {},
  });
  const sessions = [
    { id: 'discovery-worker', cwd: directory, labels: ['assistant-discovery:owner'] },
    { id: 'judgement-worker', cwd: directory, labels: ['assistant-judgement:owner'] },
  ];
  const ctx: any = {
    agents: {
      withInvocation: (_invocation: any, fn: any) => fn(),
      resume: async ({ sessionId }: any) => agent(sessionId),
      create: async () => ({ sessionId: 'discovery-worker' }),
    },
    sessionQuery: { list: async () => sessions },
    bot: { post: () => true, discoveryContext: () => ({ deliveries: [], feedback: [] }) },
  };
  let store: InitiativeStore | undefined;
  let controller: InitiativeController | undefined;
  const open = (name: string) => {
    owner = name;
    window++;
    store?.release(); // the previous window is gone, not still holding its lease
    store = new InitiativeStore(directory, name);
    assert.equal(store.lease(), true);
    // Host startup keeps the durable cycle until its admission is reconciled.
    store.recover(true);
    controller = new InitiativeController(ctx, store, {});
    controller.runner.migrate();
    return controller;
  };
  return {
    directory,
    submissions,
    prompts,
    queue,
    get store() {
      return store!;
    },
    open,
    close() {
      store?.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('a restart during a queued wake reattaches it, and a proved-absent wake keeps its cycle', async () => {
  const f = fixture();
  const first = f.open('first');
  try {
    f.store.configure({ sessionId: 'owner', cwd: f.directory }, 60_000);
    f.store.control('check');
    // A lost lease is a crash, not a completed cycle: no later write from this window is
    // accepted, so the activation survives exactly as a real crash would leave it.
    f.store.update((s) => {
      s.nextAt = 0;
    });
    await first.dispatch();
    await first.running;
    const interrupted = f.store.get().active;
    assert.ok(interrupted, 'the interrupted cycle must survive its own window');
    assert.equal(f.submissions.length, 1, 'the interrupted wake was submitted once');
    assert.equal(f.queue.get(String(f.submissions[0].messageId)), 'pending');

    const second = f.open('second');
    assert.ok(f.store.get().active, 'a restart keeps the unconfirmed activation');
    assert.equal(f.store.get().active.id, interrupted.id, 'a restart mints no second claim');
    await second.dispatch();
    await second.running;
    const firstId = String(f.submissions[0].messageId);
    assert.equal(
      f.submissions.filter((entry) => entry.messageId === firstId).length,
      1,
      'an admitted wake is never submitted a second time',
    );
    assert.equal(f.store.get().lastRun.id, interrupted.id, 'the retry stays one cycle');
    assert.equal(second.notebook.events('note')[0].payload.topicId, note.topicId);

    const completedSubmissions = f.submissions.length;
    // Positive absence is the only answer that permits another submission. It must still be
    // the same cycle, not a second investigation of the same conversation.
    legacyState(f.store, (s) => {
      s.pendingDraft = {
        id: 'cycle-3',
        phase: 'discovery',
        submission: { messageId: 'proven-absent', sessionId: 'discovery-worker' },
      };
      s.active = { id: 'cycle-3', startedAt: Date.now(), phase: 'discovery' };
      s.nextAt = 0;
    });
    f.queue.set('proven-absent', 'not_admitted');
    const third = f.open('third');
    await third.dispatch();
    await third.running;
    assert.equal(f.store.get().active, null, 'the absent wake is retired, not reattached');
    // The next scheduled window retries it under the same identity.
    f.store.update((s) => {
      s.nextAt = 0;
      s.checkRequested = true;
    });
    await third.dispatch();
    await third.running;
    const retried = f.store.get().active ?? f.store.get().lastRun;
    assert.ok(retried, 'a proved-absent wake is retried');
    assert.equal(retried.id, 'cycle-3', 'the retry reuses the interrupted activation id');
    assert.equal(
      f.submissions.length - completedSubmissions,
      2,
      'the absent cycle submits exploration and judgement once each',
    );
    assert.equal(new Set(f.submissions.map((entry) => entry.messageId)).size, f.submissions.length);
    assert.equal(f.store.get().lastError, null);
    third.notebook.close();
    second.notebook.close();
  } finally {
    f.close();
  }
});
