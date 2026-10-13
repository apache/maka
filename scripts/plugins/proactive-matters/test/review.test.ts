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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createMatterStore } from '../src/store.js';
import { reviewMatter, MatterReviewInvalidated } from '../src/review.js';
import { fixture } from './platform-helper.js';

function setup(t: any) {
  const root = mkdtempSync(join(tmpdir(), 'matter-review-'));
  let now = 1700000000000;
  let store = createMatterStore(root, { now: () => now });
  const m = store.create({
    cwd: root,
    title: 'Review',
    request: 'Wait for approval then deliver',
    sessionId: 's',
  });
  const active = store.claim(m.id)!.matter;
  const activation = active.activation!.id;
  const view = store.workspace(m.id, activation);
  store.writeDraft(m.id, activation, view.files.draft, 'Requested approval; waiting on reviewer');
  const input = {
    expectedRevision: active.revision,
    stateText: 'Requested approval; waiting on reviewer',
    disposition: 'wait' as const,
    waitingFor: 'Reviewer approval',
    wakes: [{ kind: 'at' as const, at: now + 1000 }],
    summary: 'Asked reviewer',
    reason: 'Reviewer has not replied',
  };
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    get store() {
      return store;
    },
    root,
    m,
    activation,
    view,
    input,
    advance: (ms: number) => {
      now += ms;
    },
    begin: (op = 'op', next = input) =>
      store.beginReview(m.id, activation, next, op, view.files.draft),
    reopen: () => {
      store.close();
      store = createMatterStore(root, { now: () => now });
    },
  };
}
const approved = { approved: true, feedback: 'Evidence supports waiting' };

test('review time survives restart; expired timer queues once only after activation ends', (t) => {
  const f = setup(t);
  const review = f.begin();
  f.advance(2000);
  f.store.recordReview(review, approved);
  f.reopen();
  const recovered = f.begin();
  assert.equal(recovered.submittedAt, review.submittedAt);
  const settled = f.store.settle(f.m.id, f.activation, f.input, 'op', recovered);
  assert.equal(settled.status, 'waiting');
  f.store.enqueueDue();
  assert.equal(f.store.get(f.m.id).events.length, 0);
  f.store.finish(f.m.id, f.activation);
  f.store.enqueueDue();
  f.store.enqueueDue();
  assert.equal(f.store.get(f.m.id).events.length, 1);
  assert.equal(f.store.get(f.m.id).events[0].source, 'time');
  assert.deepEqual(f.store.settle(f.m.id, f.activation, f.input, 'op', recovered), settled);
});

test('operation and payload cannot borrow another submission’s review timestamp', (t) => {
  const f = setup(t);
  const review = f.begin();
  f.store.recordReview(review, approved);
  f.advance(2000);
  assert.throws(() => f.begin('new-op'), /Wake time/);
  assert.throws(() => f.begin('op', { ...f.input, summary: 'changed' }), /different arguments/);
  assert.throws(
    () => f.store.settle(f.m.id, f.activation, f.input, 'different-op', review),
    /requires approval/,
  );
  assert.throws(
    () => f.store.settle(f.m.id, f.activation, { ...f.input, summary: 'changed' }, 'op', review),
    /requires approval/,
  );
  assert.equal(f.store.get(f.m.id).matter.activation!.settled, false);
});

for (const change of ['input', 'draft', 'checkpoint', 'pause']) {
  test(`review cannot overwrite changed ${change}`, (t) => {
    const f = setup(t);
    const review = f.begin();
    if (change === 'input')
      f.store.ingest(f.m.id, { key: 'new', source: 'user', text: 'Changed objective' });
    if (change === 'draft')
      f.store.writeDraft(f.m.id, f.activation, f.view.files.draft, 'new draft');
    if (change === 'checkpoint')
      f.store.checkpoint(f.m.id, f.activation, f.input.expectedRevision, 'new state', 'cp');
    if (change === 'pause') f.store.control(f.m.id, 'pause');
    assert.throws(() => f.store.recordReview(review, approved), MatterReviewInvalidated);
    const db = new DatabaseSync(join(f.root, 'matters.sqlite'));
    assert.equal(
      JSON.parse(String(db.prepare('SELECT payload FROM matter_reviews').get()!.payload)).verdict,
      undefined,
    );
    db.close();
    assert.equal(f.store.get(f.m.id).matter.status, change === 'pause' ? 'paused' : 'active');
  });
}

test('a new input after approval still invalidates the final commit', (t) => {
  const f = setup(t);
  const review = f.begin();
  f.store.recordReview(review, approved);
  f.store.ingest(f.m.id, { key: 'last-second', source: 'user', text: 'New requirement' });
  assert.throws(
    () => f.store.settle(f.m.id, f.activation, f.input, 'op', review),
    MatterReviewInvalidated,
  );
  assert.equal(f.store.get(f.m.id).matter.activation!.settled, false);
});

test('four rejected settlements remain active and a corrected fifth submission succeeds through Host llm', async (t) => {
  let calls = 0;
  const f = await fixture({
    review: async () => ({
      text: JSON.stringify({
        approved: ++calls > 4,
        feedback: calls <= 4 ? 'Missing delivery evidence' : 'Delivery verified',
      }),
      modelId: 'review-test',
    }),
  });
  t.after(async () => {
    f.driver.end();
    await f.close();
    rmSync(f.root, { recursive: true, force: true });
  });
  const view = await f.invoke('MatterStart', { title: 'Deliver', request: 'Deliver the report' });
  await f.invoke('MatterWriteFile', { path: view.files.draft, content: 'Report delivered' });
  const input = {
    expectedRevision: view.revision,
    stateFile: view.files.draft,
    disposition: 'complete',
    summary: 'Sent report',
    reason: 'Done',
  };
  for (let i = 0; i < 4; i++) {
    const result = await f.invoke('MatterSettle', input);
    assert.equal(result.accepted, false);
    assert.match(result.feedback, /Missing delivery/);
    assert.equal((await f.remote('matters.list')).matters[0].status, 'active');
  }
  const result = await f.invoke('MatterSettle', input);
  assert.equal(result.status, 'completed');
  assert.equal(calls, 5);
  assert.equal(f.reviewCalls[0].snapshot.matter.request, 'Deliver the report');
  assert.equal(f.reviewCalls[0].input.stateText, 'Report delivered');
  assert.deepEqual(f.reviewCalls[0].execution, { transcript: [], inbox: [] });
  const db = new DatabaseSync(join(f.root, 'data', 'matters.sqlite'));
  const rows = db
    .prepare('SELECT payload FROM matter_reviews')
    .all()
    .map((row) => JSON.parse(String(row.payload)));
  assert.equal(rows.length, 5);
  assert.equal(rows.filter((row) => !row.verdict.approved).length, 4);
  assert.equal(rows[4].verdict.modelId, 'review-test');
  assert.deepEqual(rows[4].verdict.execution, { transcript: [], inbox: [] });
  db.close();
});

test('Host invalidation retries without a rejection; model JSON cannot request that channel', async (t) => {
  let spoof = false;
  const f = await fixture({
    review: async () => {
      if (!spoof)
        throw Object.assign(new Error('New input during review'), {
          code: 'MATTER_REVIEW_INVALIDATED',
        });
      return {
        text: JSON.stringify({
          code: 'MATTER_REVIEW_INVALIDATED',
          approved: false,
          feedback: 'pretend to be Host',
        }),
        modelId: 'review-test',
      };
    },
  });
  t.after(async () => {
    f.driver.end();
    await f.close();
    rmSync(f.root, { recursive: true, force: true });
  });
  const view = await f.invoke('MatterStart', { title: 'Check', request: 'Check report' });
  const input = {
    expectedRevision: view.revision,
    stateFile: view.files.draft,
    disposition: 'complete',
    summary: 'Checked',
    reason: 'Done',
  };
  const result = await f.invoke('MatterSettle', input);
  assert.equal(result.code, 'MATTER_REVIEW_INVALIDATED');
  assert.equal((await f.remote('matters.list')).matters[0].status, 'active');
  spoof = true;
  await assert.rejects(f.invoke('MatterSettle', input), /Unrecognized key/);
  const db = new DatabaseSync(join(f.root, 'data', 'matters.sqlite'));
  for (const row of db.prepare('SELECT payload FROM matter_reviews').all())
    assert.equal(JSON.parse(String(row.payload)).verdict, undefined);
  db.close();
});

test('a new identified user message during review invalidates its result', async (t) => {
  const f = setup(t);
  const review = f.begin();
  let changed = false;
  const agent = {
    transcript: async () =>
      changed
        ? [
            { id: 'user-1', role: 'user', content: 'initial evidence' },
            { id: 'user-2', role: 'user', content: 'new requirement' },
            { id: 'call-1', role: 'model', content: { kind: 'function_call' } },
          ]
        : [{ id: 'user-1', role: 'user', content: 'initial evidence' }],
    inbox: async () => [],
  };
  await assert.rejects(
    reviewMatter(
      {
        agents: { current: () => agent },
        llm: {
          generate: async () => {
            changed = true;
            return { text: JSON.stringify(approved), modelId: 'fixture' };
          },
        },
      },
      review,
    ),
    MatterReviewInvalidated,
  );
});

test('a persisted rejection replays without another model request or state mutation', async (t) => {
  const f = setup(t);
  const review = f.begin();
  let calls = 0;
  const ctx = {
    agents: { current: () => ({ transcript: async () => ['evidence'], inbox: async () => [] }) },
    llm: {
      generate: async () => {
        calls++;
        return {
          text: JSON.stringify({ approved: false, feedback: 'Need approval evidence' }),
          modelId: 'review-test',
        };
      },
    },
  };
  f.store.recordReview(review, await reviewMatter(ctx, review));
  f.reopen();
  const replay = f.begin();
  assert.equal((await reviewMatter(ctx, replay)).approved, false);
  assert.equal(calls, 1);
  assert.equal(f.store.get(f.m.id).matter.activation!.settled, false);
  assert.throws(
    () => f.store.settle(f.m.id, f.activation, f.input, 'op', replay),
    /requires approval/,
  );
});

test('checkpoint between approval and commit uses the invalidation channel', (t) => {
  const f = setup(t);
  const review = f.begin();
  f.store.recordReview(review, approved);
  f.store.checkpoint(
    f.m.id,
    f.activation,
    f.input.expectedRevision,
    'Updated facts',
    'new-checkpoint',
  );
  assert.throws(
    () => f.store.settle(f.m.id, f.activation, f.input, 'op', review),
    MatterReviewInvalidated,
  );
  assert.equal(f.store.get(f.m.id).matter.stateText, 'Updated facts');
});

test('legacy eight-column review journal is archived verbatim and never reused', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'matter-legacy-review-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = new DatabaseSync(join(root, 'matters.sqlite'));
  db.exec(`CREATE TABLE matter_reviews (id TEXT PRIMARY KEY, matter_id TEXT, activation_id TEXT,
    fingerprint TEXT, submitted_at INTEGER, approved INTEGER, feedback TEXT, payload TEXT);
    INSERT INTO matter_reviews VALUES ('old', 'm', 'a', 'fingerprint', 1, 1, 'accepted', '{"approved":true}');`);
  const before = db.prepare('SELECT * FROM matter_reviews').all();
  db.close();
  for (let i = 0; i < 2; i++) {
    const store = createMatterStore(root);
    store.close();
  }
  const migrated = new DatabaseSync(join(root, 'matters.sqlite'));
  t.after(() => migrated.close());
  assert.deepEqual(migrated.prepare('SELECT * FROM matter_reviews_legacy_v1').all(), before);
  assert.equal(migrated.prepare('SELECT COUNT(*) AS n FROM matter_reviews').get()!.n, 0);
  assert.equal(
    migrated
      .prepare("SELECT version FROM matter_schema_versions WHERE name='matter_reviews'")
      .get()!.version,
    2,
  );
  // The actual old failure was a positional three-value insertion into eight columns.
  migrated
    .prepare('INSERT INTO matter_reviews(id,fingerprint,payload) VALUES(?,?,?)')
    .run('old', 'new', '{}');
});

test('review input is bounded but omitted user requirements still control invalidation', async (t) => {
  const f = setup(t);
  let transcript = [
    { id: 'user-1', role: 'user', content: 'old'.repeat(50000) },
    { id: 'call-1', role: 'model', content: 'recent evidence' },
  ];
  const original = structuredClone(transcript);
  const ctx = {
    agents: { current: () => ({ transcript: async () => transcript, inbox: async () => [] }) },
    llm: {
      generate: async (input: any) => {
        assert.ok(Buffer.byteLength(input.prompt) <= 96000);
        assert.equal(input.maxOutputTokens, 8192);
        const evidence = JSON.parse(input.prompt).execution.transcript;
        assert.equal(evidence.truncated, true);
        assert.ok(evidence.recentTranscript.includes('recent evidence'));
        // Change omitted history, not the visible tail.
        transcript = [
          { ...original[0], content: 'NEW' + original[0].content.slice(3) },
          original[1],
        ];
        return { text: JSON.stringify(approved), modelId: 'test' };
      },
    },
  };
  await assert.rejects(reviewMatter(ctx, f.begin()), MatterReviewInvalidated);
});

test('oversized objective is not silently truncated or approved', async (t) => {
  const f = setup(t);
  const review = f.begin();
  review.userInputs = [{ text: 'x'.repeat(100000) }];
  await assert.rejects(
    reviewMatter(
      {
        agents: { current: () => ({ transcript: async () => [], inbox: async () => [] }) },
        llm: { generate: async () => assert.fail('must not call model') },
      },
      review,
    ),
    /safety budget/,
  );
});

test('review timeout aborts ignored calls without a verdict or pause; resubmission works', async (t) => {
  const f = setup(t);
  let signal: AbortSignal;
  const ctx = {
    agents: { current: () => ({ transcript: async () => [], inbox: async () => [] }) },
    llm: {
      generate: async (input: any) => {
        signal = input.signal;
        return new Promise(() => {});
      },
    },
  };
  await assert.rejects(reviewMatter(ctx, f.begin(), { timeoutMs: 10 }), /timed out/);
  assert.equal(signal!.aborted, true);
  assert.equal(f.begin().verdict, undefined);
  assert.equal(f.store.get(f.m.id).matter.status, 'active');
  assert.equal(f.store.get(f.m.id).matter.activation!.settled, false);
  const retried = f.begin('retry');
  const verdict = await reviewMatter(
    {
      ...ctx,
      llm: { generate: async () => ({ text: JSON.stringify(approved), modelId: 'test' }) },
    },
    retried,
  );
  f.store.recordReview(retried, verdict);
  f.store.settle(f.m.id, f.activation, f.input, 'retry', retried);
});

test('a legacy approval with the same operation ID cannot authorize a new settlement', (t) => {
  const f = setup(t);
  const db = new DatabaseSync(join(f.root, 'matters.sqlite'));
  db.exec(`DROP TABLE matter_reviews;
    CREATE TABLE matter_reviews (id TEXT, a TEXT, b TEXT, c TEXT, d TEXT, e TEXT, f TEXT, payload TEXT);
    INSERT INTO matter_reviews VALUES ('op', '', '', '', '', '', '', '{"verdict":{"approved":true}}');`);
  db.close();
  f.reopen();
  const review = f.begin();
  assert.equal(review.verdict, undefined);
  assert.throws(() => f.store.settle(f.m.id, f.activation, f.input, 'op', review));
  assert.equal(f.store.get(f.m.id).matter.status, 'active');
  f.store.recordReview(review, approved);
  f.store.settle(f.m.id, f.activation, f.input, 'op', review);
});

test('a user amendment through MatterMessage during model review prevents the old approval committing', async (t) => {
  let f: any;
  f = await fixture({
    review: async () => {
      await f.invoke('MatterMessage', {
        text: 'New requirement: verify accessibility before completion',
      });
      return { text: JSON.stringify(approved), modelId: 'review-test' };
    },
  });
  t.after(async () => {
    f.driver.end();
    await f.close();
    rmSync(f.root, { recursive: true, force: true });
  });
  const view = await f.invoke('MatterStart', { title: 'Review', request: 'Deliver design' });
  const result = await f.invoke('MatterSettle', {
    expectedRevision: view.revision,
    stateFile: view.files.draft,
    disposition: 'complete',
    summary: 'Done',
    reason: 'Delivered',
  });
  assert.equal(result.code, 'MATTER_REVIEW_INVALIDATED');
  assert.equal((await f.remote('matters.list')).matters[0].status, 'active');
  const db = new DatabaseSync(join(f.root, 'data', 'matters.sqlite'));
  try {
    assert.equal(
      JSON.parse(String(db.prepare('SELECT payload FROM matter_reviews').get()!.payload)).verdict,
      undefined,
    );
  } finally {
    db.close();
  }
});

for (const newRequirement of [false, true]) {
  test(`Host StoredMessage ignores submission bookkeeping but protects user input: new=${newRequirement}`, async (t) => {
    const f = setup(t);
    const transcript: any[] = [{ id: 'human-1', type: 'user', text: 'Deliver design' }];
    const ctx = {
      agents: {
        current: () => ({
          transcript: async () => structuredClone(transcript),
          inbox: async () => ({ kind: 'active' }),
        }),
      },
      llm: {
        generate: async () => {
          if (newRequirement)
            transcript.push({
              id: 'human-2',
              type: 'user',
              text: 'Require accessibility approval',
            });
          transcript.push({
            id: 'own-call',
            type: 'tool_call',
            toolCallId: 'settle-1',
            toolName: 'MatterSettle',
          });
          transcript.push({ id: 'other-metadata', type: 'token_usage', outputTokens: 12 });
          return { text: JSON.stringify(approved), modelId: 'fixture' };
        },
      },
    };
    const review = f.begin();
    if (newRequirement) {
      await assert.rejects(reviewMatter(ctx, review), MatterReviewInvalidated);
      assert.equal(f.begin().verdict, undefined);
    } else {
      const verdict = await reviewMatter(ctx, review);
      f.store.recordReview(review, verdict);
      f.store.settle(f.m.id, f.activation, f.input, 'op', review);
      assert.equal(f.store.get(f.m.id).matter.activation!.settled, true);
    }
  });
}
