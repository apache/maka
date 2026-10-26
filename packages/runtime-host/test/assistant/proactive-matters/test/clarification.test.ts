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
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerClarification } from '../../../../src/assistant/proactive-matters/clarification.js';
import { createMatterStore } from '../../../../src/assistant/proactive-matters/store.js';

function setup(t: any) {
  const root = mkdtempSync(join(tmpdir(), 'bot-clarification-'));
  const store = createMatterStore(root);
  const m = store.create({
    cwd: root,
    title: 'K42',
    request: 'Warehouse verifies model and condition',
    sessionId: 'worker',
  });
  const activation = store.claim(m.id)!.matter.activation!;
  store.bindTurn(m.id, activation.id, 'turn');
  const db = new DatabaseSync(join(root, 'questions.sqlite'));
  db.exec(
    "CREATE TABLE delegations(session TEXT, owner TEXT); INSERT INTO delegations VALUES('worker','owner')",
  );
  const tools = new Map<string, any>(),
    posts = new Map<string, any>();
  let available = true;
  const ctx = {
    tools: { register: (tool: any) => tools.set(tool.name, tool) },
    bot: {
      post(owner: string, message: any) {
        assert.equal(owner, 'owner');
        if (!available) return false;
        posts.set(message.id, message);
        return true;
      },
    },
  };
  const install = () =>
    registerClarification(ctx as any, db, store, { assertReady() {}, async tick() {} } as any);
  install();
  const invoke = (name: string, input: any, sessionId = 'worker', turnId = 'turn') =>
    tools.get(name).impl(input, { sessionId, turnId });
  t.after(() => {
    db.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    store,
    m,
    posts,
    invoke,
    install,
    unavailable: () => {
      available = false;
    },
    available: () => {
      available = true;
    },
  };
}
const question = {
  requestKey: 'acceptance',
  question: 'Does the user require a separate Bot record?',
  evidence: 'User asked for warehouse verification; warehouse confirms model and condition.',
};
test('worker asks Bot once; reply reaches task inbox without amending user request', (t) => {
  const f = setup(t);
  const a = f.invoke('MatterAskBot', question);
  assert.equal(f.invoke('MatterAskBot', question).requestId, a.requestId);
  assert.equal(f.posts.size, 1);
  assert.equal([...f.posts.values()][0].content.kind, 'clarification_request');
  assert.throws(
    () => f.invoke('MatterReply', { requestId: a.requestId, answer: 'yes' }, 'stranger'),
    /outside/,
  );
  f.invoke(
    'MatterReply',
    {
      requestId: a.requestId,
      answer: 'No extra Bot record is required by the original user request.',
    },
    'owner',
  );
  f.invoke(
    'MatterReply',
    {
      requestId: a.requestId,
      answer: 'No extra Bot record is required by the original user request.',
    },
    'owner',
  );
  const snapshot = f.store.get(f.m.id);
  const replies = snapshot.events.filter((e) => e.source === 'bot_clarification');
  assert.equal(replies.length, 1);
  assert.match(replies[0].text, /not new user authorization/);
  assert.equal(snapshot.matter.request, f.m.request);
  assert.notEqual(snapshot.matter.status, 'completed');
  assert.equal(f.invoke('MatterAskBot', question).status, 'answered');
});
test('saved question survives unavailable Bot and registration restart; scope and retries enforced', (t) => {
  const f = setup(t);
  f.unavailable();
  assert.throws(() => f.invoke('MatterAskBot', question), /question saved/);
  f.install();
  f.available();
  const a = f.invoke('MatterAskBot', question);
  assert.equal(a.status, 'delivered_to_bot');
  assert.throws(
    () => f.invoke('MatterAskBot', { ...question, question: 'Different' }),
    /different question/,
  );
  assert.throws(
    () => f.invoke('MatterAskBot', question, 'worker', 'other-turn'),
    /active delegated/,
  );
  f.invoke(
    'MatterReply',
    { requestId: a.requestId, answer: 'Need the user to specify which warehouse; keep waiting.' },
    'owner',
  );
  assert.throws(
    () => f.invoke('MatterReply', { requestId: a.requestId, answer: 'changed' }, 'owner'),
    /different answer/,
  );
});
