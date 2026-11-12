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
import { test, type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMatterStore } from '../assistant/proactive-matters/store.js';
import { buildMatterTools } from '../assistant/proactive-matters/tools.js';
import {
  deliveredMatterInput,
  workerTools,
  matterInput,
} from '../assistant/proactive-matters/settlement-context.js';

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'matter-submit-'));
  let store = createMatterStore(dir);
  const created = store.create({
    cwd: dir,
    title: 'Check delivery',
    request: 'Receive and inspect the package',
    sessionId: 'worker',
  });
  const claimed = store.claim(created.id)!.matter;
  store.bindTurn(created.id, claimed.activation!.id, 'turn');
  const call: any = {
    sessionId: 'worker',
    turnId: 'turn',
    toolCallId: 'submit1',
    abortSignal: new AbortController().signal,
    cwd: dir,
  };
  const events: any[] = [];
  let reviews = 0;
  let review: () => any = () => ({ approved: true, feedback: 'done' });
  const tools = () =>
    buildMatterTools({
      store,
      changed() {},
      deliveredInput: async (c) => deliveredMatterInput(events, c),
      review: async () => {
        reviews++;
        return await review();
      },
    });
  const deliver = () => {
    const snapshot = store.get(created.id);
    const m = snapshot.matter;
    const value = matterInput(snapshot);
    events.push({
      sessionId: 'worker',
      turnId: 'turn',
      role: 'system',
      author: 'host',
      content: {
        kind: 'text',
        runtimeContextName: 'proactive-matters.inbox',
        text: 'Runtime context (host metadata)\nTask inputs\n' + JSON.stringify(value),
      },
    });
  };
  const submit = (args: any, fresh = true) => {
    if (fresh) deliver();
    events.push({
      sessionId: 'worker',
      turnId: 'turn',
      content: { kind: 'function_call', id: call.toolCallId },
    });
    const tool = tools().find((t) => t.name === 'MatterSettle')!;
    return tool.impl(
      (tool.parameters as any).parse({ progressSummary: '检查包裹签收与验收进展', ...args }),
      call,
    ) as Promise<any>;
  };
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    get store() {
      return store;
    },
    id: created.id,
    activation: claimed.activation!.id,
    dir,
    call,
    tools,
    events,
    deliver,
    submit,
    get reviews() {
      return reviews;
    },
    review(fn: () => any) {
      review = fn;
    },
    reopen() {
      store.close();
      store = createMatterStore(dir);
    },
  };
}
const complete = {
  disposition: 'complete',
  summary: 'Received and inspected; the objective is met.',
  update: 'Delivered and inspected.',
};

test('direct settlement needs no revision/path/draft and preserves optional notes', async (t) => {
  const f = fixture(t);
  const tool = f.tools().find((t) => t.name === 'MatterSettle')!;
  assert.equal(tool.discovery, 'direct');
  const result = await f.submit({ ...complete, note: 'Serial verified.' });
  assert.equal(result.status, 'completed');
  assert.equal(f.reviews, 1);
  assert.equal(f.store.get(f.id).matter.stateText, 'Serial verified.');
  assert.equal(f.store.updates(f.id).length, 1);
  // Exact operation replay survives reopen, without a second review or notification.
  f.reopen();
  await f.submit({ ...complete, note: 'Serial verified.' }, false);
  assert.equal(f.reviews, 1);
  assert.equal(f.store.updates(f.id).length, 1);
  await assert.rejects(f.submit({ ...complete, note: 'changed' }, false), /identity reused/);
});
test('wait saves a tested boundary and deadline; missing concrete wait is rejected', async (t) => {
  const f = fixture(t);
  await assert.rejects(
    f.submit({
      disposition: 'wait',
      summary: 'Awaiting delivery',
      wakes: [{ kind: 'at', at: Date.now() + 60000 }],
    }),
    /waiting condition/,
  );
  f.call.toolCallId = 'submit2';
  const result = await f.submit({
    disposition: 'wait',
    summary: 'Not received; no useful immediate action remains',
    waitingFor: 'Actual receipt',
    wakes: [{ kind: 'at', at: Date.now() + 60000 }],
  });
  assert.equal(result.status, 'waiting');
  assert.equal(f.store.get(f.id).matter.wakes.length, 1);
});
test('continue remains review-free, with optional note retained when omitted later', async (t) => {
  const f = fixture(t);
  f.store.checkpoint(
    f.id,
    f.activation,
    f.store.get(f.id).matter.revision,
    'Keep the serial number',
    'prior-note',
  );
  const result = await f.submit({ disposition: 'continue', summary: 'More work remains' });
  assert.equal(f.store.get(f.id).matter.stateText, 'Keep the serial number');
  assert.equal(result.status, 'active');
  assert.equal(f.reviews, 0);
  await f.submit({ disposition: 'continue', summary: 'More work remains' }, false);
  assert.equal(f.reviews, 0);
});
test('new user input after model dispatch invalidates even before review', async (t) => {
  const f = fixture(t);
  f.deliver();
  f.store.ingest(f.id, { key: 'amend', source: 'user', text: 'Also inspect packaging' });
  const result = await f.submit(complete, false);
  assert.equal(result.code, 'MATTER_REVIEW_INVALIDATED');
  assert.equal(f.reviews, 0);
  assert.equal(f.store.get(f.id).matter.status, 'active');
  f.call.toolCallId = 'submit2';
  assert.equal((await f.submit(complete)).status, 'completed');
});
test('input during review invalidates approval and does not commit note or notify', async (t) => {
  const f = fixture(t);
  f.review(() => {
    f.store.ingest(f.id, { key: 'amend', source: 'user', text: 'Do not finish yet' });
    return { approved: true, feedback: 'old approval' };
  });
  const result = await f.submit({ ...complete, note: 'stale' });
  assert.equal(result.code, 'MATTER_REVIEW_INVALIDATED');
  assert.equal(f.store.get(f.id).matter.status, 'active');
  assert.equal(f.store.updates(f.id).length, 0);
  assert.notEqual(f.store.get(f.id).matter.stateText, 'stale');
});
test('rejections and review failures leave execution active without rejection limit', async (t) => {
  const f = fixture(t);
  f.review(() => ({ approved: false, feedback: 'Packaging still unverified' }));
  for (let i = 0; i < 5; i++) {
    f.call.toolCallId = 'reject' + i;
    assert.equal((await f.submit(complete)).accepted, false);
  }
  f.review(() => {
    throw Error('transport failed');
  });
  f.call.toolCallId = 'transport';
  await assert.rejects(f.submit(complete), /transport failed/);
  assert.equal(f.store.get(f.id).matter.status, 'active');
  assert.equal(f.store.updates(f.id).length, 0);
  f.review(() => ({ approved: true, feedback: 'verified' }));
  f.call.toolCallId = 'final';
  assert.equal((await f.submit(complete)).status, 'completed');
});
test('missing delivered context fails closed rather than adopting latest state', async (t) => {
  const f = fixture(t);
  assert.equal((await f.submit(complete, false)).code, 'MATTER_REVIEW_INVALIDATED');
  assert.equal(f.reviews, 0);
});
test('only host context before this call and in this turn is eligible', async (t) => {
  const f = fixture(t);
  f.deliver();
  const original = structuredClone(f.events[0]);
  f.events[0].role = 'user';
  f.events.push({
    sessionId: 'worker',
    turnId: 'turn',
    content: { kind: 'function_call', id: 'submit1' },
  });
  f.events.push(original);
  assert.equal(deliveredMatterInput(f.events, f.call), undefined);
  f.events[0] = original;
  assert.ok(deliveredMatterInput(f.events, f.call));
  f.events[0].turnId = 'other';
  assert.equal(deliveredMatterInput(f.events, f.call), undefined);
});
test('worker surface exposes lifecycle directly and excludes coordinator tools without removing ordinary tools', async (t) => {
  const f = fixture(t);
  for (const name of ['MatterRead', 'MatterSettle', 'MatterConditionTest'])
    assert.equal(f.tools().find((t) => t.name === name)!.discovery, 'direct');
  const all = [
    'Bash',
    'MemoryOriginal',
    'MatterDelegate',
    'MatterTaskMessage',
    'MatterReply',
    'MatterSettle',
    'MatterAskBot',
  ].map((name) => ({ name }));
  assert.deepEqual(
    workerTools(all).map((t) => t.name),
    ['Bash', 'MemoryOriginal', 'MatterSettle', 'MatterAskBot'],
  );
});

test('observation-only revision changes do not invalidate unchanged delivered task inputs', async (t) => {
  const f = fixture(t);
  f.store.ingest(f.id, { key: 'amend', source: 'user', text: 'Inspect packaging too' });
  f.deliver();
  const prior = f.store.get(f.id).matter.revision;
  f.store.observe(f.id, f.activation);
  assert.ok(f.store.get(f.id).matter.revision > prior);
  assert.equal((await f.submit(complete, false)).status, 'completed');
});

test('inherited tool IDs cannot substitute for the current physical run call', (t) => {
  const f = fixture(t);
  f.call.runId = 'successor';
  f.deliver();
  const inheritedCall = {
    sessionId: f.call.sessionId,
    turnId: f.call.turnId,
    runId: 'predecessor',
    content: { kind: 'function_call', id: f.call.toolCallId },
  };
  f.events.push(inheritedCall);
  assert.equal(deliveredMatterInput(f.events, f.call), undefined);
  f.events.push({ ...inheritedCall, runId: 'successor' });
  assert.equal(deliveredMatterInput(f.events, f.call)?.activationId, f.activation);
});
