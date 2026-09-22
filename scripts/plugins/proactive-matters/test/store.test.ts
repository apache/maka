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
import { mkdtempSync, rmSync, readFileSync, writeFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMatterStore } from '../src/store.js';
import { MATTER_STATE_MAX_BYTES, type MatterStore, type Matter } from '../src/matter.js';
import { DatabaseSync } from 'node:sqlite';

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'maka-matters-'));
  let now = 1700000000000;
  let store = createMatterStore(root, { now: () => now });
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const m = store.create({
    cwd: root,
    title: '找房',
    request: '预算 6000，可以养猫，找到且用户选定后完成',
    sessionId: 'session-1',
  });
  return {
    get store() {
      return store;
    },
    m,
    root,
    time: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    reopen: () => {
      store.close();
      store = createMatterStore(root, { now: () => now });
      return store;
    },
  };
}
function settle(
  store: MatterStore,
  m: Matter,
  disposition: 'wait' | 'complete' | 'continue' = 'wait',
) {
  return store.settle(
    m.id,
    m.activation!.id,
    {
      expectedRevision: m.revision,
      stateText: 'A 不允许养猫；已联系 B。',
      disposition,
      summary: 'Inspected current facts and recorded the outcome.',
      reason: '已根据当前情况判断',
      ...(disposition === 'wait'
        ? { wakes: [{ kind: 'at' as const, at: m.updatedAt + 60000 }] }
        : {}),
    },
    `${m.activation!.id}:settle`,
  );
}

test('events do not change state; duplicate delivery cannot produce duplicate work', (t) => {
  const f = fixture(t);
  const before = f.store.get(f.m.id).matter;
  const event = { key: 'mail:123', source: 'user', text: '房东回复了' };
  assert.equal(f.store.ingest(f.m.id, event), true);
  assert.equal(f.store.ingest(f.m.id, event), false);
  assert.deepEqual(f.store.get(f.m.id).matter, before);
  const claimed = f.store.claim(f.m.id)!;
  assert.equal(claimed.events.length, 2);
  assert.equal(f.store.claim(f.m.id), null);
});

test('checkpoint CAS and idempotent receipts preserve the objective', (t) => {
  const f = fixture(t);
  const m = f.store.claim(f.m.id)!.matter;
  const saved = f.store.checkpoint(m.id, m.activation!.id, m.revision, '观察结果', 'op-1');
  assert.equal(saved.request, f.m.request);
  assert.deepEqual(
    f.store.checkpoint(m.id, m.activation!.id, m.revision, '观察结果', 'op-1'),
    saved,
  );
  assert.throws(
    () => f.store.checkpoint(m.id, m.activation!.id, m.revision, '其他', 'op-1'),
    /identity/,
  );
  assert.throws(
    () => f.store.checkpoint(m.id, m.activation!.id, m.revision, '其他', 'op-2'),
    /revision/,
  );
  assert.equal(f.store.get(m.id).matter.stateText, '观察结果');
});

test('oversized state is rejected without truncation or partial writes', (t) => {
  const f = fixture(t);
  const m = f.store.claim(f.m.id)!.matter;
  assert.throws(
    () =>
      f.store.checkpoint(
        m.id,
        m.activation!.id,
        m.revision,
        '猫'.repeat(MATTER_STATE_MAX_BYTES),
        'large',
      ),
    /Condense/,
  );
  assert.equal(f.store.get(m.id).matter.revision, m.revision);
});

test('wait, outbox and event acknowledgement survive reopening together', (t) => {
  const f = fixture(t);
  const m = f.store.claim(f.m.id)!.matter;
  f.store.settle(
    m.id,
    m.activation!.id,
    {
      expectedRevision: m.revision,
      stateText: '已联系 B',
      disposition: 'wait',
      wakes: [{ kind: 'at', at: f.time() + 60000 }],
      summary: 'Inspected current facts and recorded the outcome.',
      reason: '等回复',
      update: '已联系 B，明天再查。',
    },
    'settle',
  );
  f.reopen().recover();
  assert.equal(f.store.get(m.id).matter.status, 'waiting');
  assert.equal(f.store.get(m.id).matter.activation, null);
  assert.equal(f.store.get(m.id).events.length, 0);
  assert.equal(f.store.updates().length, 1);
  f.advance(120000);
  f.store.enqueueDue();
  f.store.enqueueDue();
  assert.equal(f.store.get(m.id).events.length, 1);
  assert.ok(f.store.claim(m.id));
});

test('late events survive settling and trigger another run', (t) => {
  const f = fixture(t);
  const m = f.store.claim(f.m.id)!.matter;
  f.store.ingest(m.id, { key: 'late', source: 'user', text: '发生变化' });
  settle(f.store, m);
  f.store.finish(m.id, m.activation!.id);
  const next = f.store.claim(m.id)!;
  assert.equal(next.events.length, 1);
  assert.equal(next.events[0].text, '发生变化');
});

test('completion cannot discard unread changes; read refresh permits informed completion', (t) => {
  const f = fixture(t);
  const m = f.store.claim(f.m.id)!.matter;
  f.store.ingest(m.id, {
    key: 'changed',
    source: 'user',
    text: '预算变成 4000',
  });
  assert.throws(() => settle(f.store, m, 'complete'), /Unread events/);
  const current = f.store.observe(m.id, m.activation!.id);
  assert.match(current.events.at(-1)!.text, /4000/);
  settle(f.store, current.matter, 'complete');
  f.store.finish(m.id, m.activation!.id);
  assert.equal(f.store.get(m.id).matter.status, 'completed');
  assert.equal(f.store.claim(m.id), null);
});

test('pause invalidates old writers and resume does not restore an old lease', (t) => {
  const f = fixture(t);
  const m = f.store.claim(f.m.id)!.matter;
  f.store.control(m.id, 'pause');
  const paused = f.store.get(m.id).matter;
  f.store.edit(m.id, paused.revision, '用户更新预算 4000');
  f.store.control(m.id, 'resume');
  const next = f.store.claim(m.id)!.matter;
  assert.notEqual(next.activation!.id, m.activation!.id);
  assert.throws(
    () => f.store.checkpoint(m.id, m.activation!.id, m.revision, '旧预算', 'stale'),
    /no longer/,
  );
  f.store.finish(m.id, m.activation!.id);
  assert.equal(f.store.get(m.id).matter.activation!.id, next.activation!.id);
});

test('unknown interrupted work is parked instead of replayed', (t) => {
  const f = fixture(t);
  const m = f.store.claim(f.m.id)!.matter;
  f.store.checkpoint(
    m.id,
    m.activation!.id,
    m.revision,
    '已发送请求，尚未确认外部结果',
    'checkpoint',
  );
  f.reopen().recover();
  const current = f.store.get(m.id).matter;
  assert.equal(current.status, 'paused');
  assert.match(current.lastError!, /外部结果/);
  assert.equal(current.stateText, '已发送请求，尚未确认外部结果');
  assert.equal(f.store.claim(m.id), null);
});

test('invalid wait leaves state, inbox and outbox unchanged', (t) => {
  const f = fixture(t);
  const m = f.store.claim(f.m.id)!.matter;
  assert.throws(
    () =>
      f.store.settle(
        m.id,
        m.activation!.id,
        {
          expectedRevision: m.revision,
          stateText: 'invalid',
          disposition: 'wait',
          summary: 'Inspected current facts and recorded the outcome.',
          reason: 'waiting',
          update: 'bad',
        },
        'invalid',
      ),
    /requires/,
  );
  assert.equal(f.store.get(m.id).matter.stateText, '');
  assert.equal(f.store.get(m.id).events.length, 1);
  assert.equal(f.store.updates().length, 0);
});

test('missing settle pauses; immediate continuation has a hard cap', (t) => {
  const f = fixture(t);
  let m = f.store.claim(f.m.id)!.matter;
  f.store.finish(m.id, m.activation!.id);
  assert.equal(f.store.get(m.id).matter.status, 'paused');
  f.store.control(m.id, 'resume');
  for (let i = 0; i < 6; i++) {
    m = f.store.claim(m.id)!.matter;
    settle(f.store, m, 'continue');
    f.store.finish(m.id, m.activation!.id);
  }
  assert.equal(f.store.get(m.id).matter.status, 'paused');
  assert.equal(f.store.claim(m.id), null);
});

test('large event batches retain unread events and cannot falsely complete', (t) => {
  const f = fixture(t);
  for (let i = 0; i < 8; i++)
    f.store.ingest(f.m.id, {
      key: `large-${i}`,
      source: 'user',
      text: '猫'.repeat(7000),
    });
  const snapshot = f.store.claim(f.m.id)!;
  assert.equal(snapshot.pendingEventCount, 9);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot.events)) < 64 * 1024);
  assert.ok(snapshot.events.length < snapshot.pendingEventCount);
  assert.throws(() => settle(f.store, snapshot.matter, 'complete'), /Unread events/);
  settle(f.store, snapshot.matter, 'continue');
  f.store.finish(f.m.id, snapshot.matter.activation!.id);
  const next = f.store.claim(f.m.id)!;
  assert.ok(next.events[0].sequence > snapshot.events.at(-1)!.sequence);
  assert.equal(next.pendingEventCount, 9 - snapshot.events.length + 1);
});

test('settle receipts remain idempotent after their timer has elapsed', (t) => {
  const f = fixture(t);
  const m = f.store.claim(f.m.id)!.matter;
  const input = {
    expectedRevision: m.revision,
    stateText: 'Waiting',
    disposition: 'wait' as const,
    wakes: [{ kind: 'at' as const, at: f.time() + 1000 }],
    summary: 'Inspected current facts and recorded the outcome.',
    reason: 'Check later',
    update: 'Started',
  };
  const first = f.store.settle(m.id, m.activation!.id, input, 'same-settle');
  f.advance(2000);
  assert.deepEqual(f.store.settle(m.id, m.activation!.id, input, 'same-settle'), first);
  assert.equal(f.store.updates().length, 1);
});

test('run budget pauses with a durable notice and explicit resume grants another budget', (t) => {
  const f = fixture(t);
  const m = f.store.create({
    cwd: f.root,
    title: 'Bounded',
    request: 'Continue',
    sessionId: 'limited',
    maxRuns: 1,
  });
  const active = f.store.claim(m.id)!.matter;
  settle(f.store, active, 'continue');
  f.store.finish(m.id, active.activation!.id);
  assert.equal(f.store.claim(m.id), null);
  assert.equal(f.store.get(m.id).matter.status, 'paused');
  assert.equal(f.store.updates(m.id).length, 1);
  f.store.control(m.id, 'resume');
  assert.equal(f.store.claim(m.id)!.matter.runCount, 2);
});

test('files hold published bodies; drafts, version history and scheduling commit separately from editing', (t) => {
  const f = fixture(t);
  const active = f.store.claim(f.m.id)!.matter;
  const context = f.store.workspace(active.id, active.activation!.id);
  assert.match(readFileSync(context.files.request, 'utf8'), /预算 6000/);
  assert.equal(readFileSync(context.files.state, 'utf8'), '');
  f.store.writeDraft(
    active.id,
    active.activation!.id,
    context.files.draft,
    '房源 B 已确认；等待用户回复。',
  );
  assert.equal(f.store.get(active.id).matter.stateText, '', 'editing a draft must not publish it');
  const input = {
    expectedRevision: active.revision,
    stateText: f.store.readDraft(active.id, active.activation!.id, context.files.draft),
    disposition: 'wait' as const,
    summary: 'Inspected current facts and recorded the outcome.',
    reason: '稍后检查',
    wakes: [{ kind: 'at' as const, at: f.time() - 1 }],
  };
  assert.throws(
    () => f.store.settle(active.id, active.activation!.id, input, 'bad-time'),
    /Wake time/,
  );
  assert.equal(f.store.get(active.id).matter.revision, active.revision);
  assert.equal(f.store.get(active.id).matter.stateText, '');
  assert.equal(f.store.get(active.id).events.length, 1);
  input.wakes[0].at = f.time() + 60000;
  const saved = f.store.settle(active.id, active.activation!.id, input, 'good-time');
  const files = f.store.workspace(active.id, active.activation!.id).files;
  assert.equal(readFileSync(files.state, 'utf8'), input.stateText);
  const history = readFileSync(files.changes, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    history.map((entry) => entry.kind),
    ['create', 'claim', 'draft', 'settle'],
  );
  assert.equal(readFileSync(history.at(-1).stateFile, 'utf8'), saved.stateText);
  assert.equal(history.at(-1).at, f.time());
  const db = new DatabaseSync(join(f.root, 'matters.sqlite'));
  try {
    const raw = JSON.parse(
      String(db.prepare('SELECT payload FROM matters WHERE id=?').get(active.id)!.payload),
    );
    assert.ok(raw.documents.state);
    assert.equal(raw.request, undefined);
    assert.equal(raw.stateText, undefined);
    assert.equal(
      String(db.prepare('SELECT text FROM matter_events LIMIT 1').get()!.text).startsWith('@file:'),
      true,
    );
  } finally {
    db.close();
  }
  f.store.finish(active.id, active.activation!.id);
  f.reopen().recover();
  assert.equal(f.store.get(active.id).matter.stateText, saved.stateText);
  assert.deepEqual(f.store.get(active.id).matter.wakes, input.wakes);
  writeFileSync(files.draft, 'editing a file does not wake anything');
  f.store.enqueueDue();
  assert.equal(f.store.claim(active.id), null);
});

test('file access is scoped to its activation and latest user instructions remain in the next workspace', (t) => {
  const f = fixture(t);
  const active = f.store.claim(f.m.id)!.matter;
  const ctx = f.store.workspace(active.id, active.activation!.id);
  assert.throws(
    () =>
      f.store.writeDraft(active.id, active.activation!.id, ctx.files.request, 'rewrite request'),
    /Only/,
  );
  assert.throws(
    () => f.store.readFile(active.id, active.activation!.id, join(f.root, 'matters.sqlite')),
    /Read only/,
  );
  settle(f.store, active);
  f.store.finish(active.id, active.activation!.id);
  f.store.ingest(active.id, {
    key: 'new-budget',
    source: 'user',
    text: '预算改成 4000',
  });
  const next = f.store.claim(active.id)!.matter;
  const nextCtx = f.store.workspace(next.id, next.activation!.id);
  assert.notEqual(nextCtx.files.draft, ctx.files.draft);
  assert.match(
    f.store.readFile(next.id, next.activation!.id, nextCtx.files.request).content,
    /预算改成 4000/,
  );
  assert.throws(() => f.store.readFile(next.id, next.activation!.id, ctx.files.state), /Read only/);
  assert.throws(
    () => f.store.writeDraft(active.id, active.activation!.id, ctx.files.draft, 'stale'),
    /no longer/,
  );
});

test('only time wakes and direct user input are admitted', (t) => {
  const f = fixture(t);
  const m = f.store.claim(f.m.id)!.matter;
  for (const kind of ['user', 'event']) {
    assert.throws(
      () =>
        f.store.settle(
          m.id,
          m.activation!.id,
          {
            expectedRevision: m.revision,
            stateText: 'waiting',
            disposition: 'wait',
            summary: 'Inspected current facts and recorded the outcome.',
            reason: 'test',
            wakes: [{ kind, source: 'file', subject: 'state.md' }] as never,
          },
          kind,
        ),
      /Only time/,
    );
  }
  assert.throws(
    () => f.store.ingest(m.id, { key: 'file', source: 'file', text: 'changed' }),
    /not supported/,
  );
  assert.equal(f.store.get(m.id).matter.revision, m.revision);
});

test('legacy documents remain readable and unsupported subscriptions pause explicitly on recovery', (t) => {
  const f = fixture(t);
  const legacy = {
    ...f.m,
    stateText: '旧版保存的状态',
    status: 'waiting',
    wakes: [{ kind: 'user' }],
  };
  const db = new DatabaseSync(join(f.root, 'matters.sqlite'));
  try {
    db.prepare('UPDATE matters SET payload=? WHERE id=?').run(JSON.stringify(legacy), f.m.id);
  } finally {
    db.close();
  }
  f.reopen().recover();
  const recovered = f.store.get(f.m.id).matter;
  assert.equal(recovered.stateText, legacy.stateText);
  assert.equal(recovered.request, f.m.request);
  assert.equal(recovered.status, 'paused');
  assert.deepEqual(recovered.wakes, []);
  assert.match(f.store.updates(f.m.id)[0].text, /仅支持时间唤醒/);
});

test('a replaced draft cannot redirect a state read or write to another file', (t) => {
  const f = fixture(t);
  const m = f.store.claim(f.m.id)!.matter;
  const { files } = f.store.workspace(m.id, m.activation!.id);
  unlinkSync(files.draft);
  symlinkSync(files.request, files.draft);
  const original = readFileSync(files.request, 'utf8');
  assert.throws(() => f.store.readDraft(m.id, m.activation!.id, files.draft), /symbolic link/);
  assert.throws(
    () => f.store.writeDraft(m.id, m.activation!.id, files.draft, 'overwrite'),
    /symbolic link/,
  );
  assert.equal(readFileSync(files.request, 'utf8'), original);
  assert.equal(f.store.get(m.id).matter.stateText, '');
});

test('state operations and activation handoffs are append-only, timestamped and survive reopening', (t) => {
  const f = fixture(t);
  const m = f.store.claim(f.m.id)!.matter;
  const activationId = m.activation!.id;
  const workspace = () => f.store.workspace(m.id, activationId);
  const history = () =>
    readFileSync(workspace().files.changes, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  const initial = history();
  f.advance(1000);
  f.store.writeDraft(
    m.id,
    activationId,
    workspace().files.draft,
    'First attempt; outcome unknown.',
  );
  f.advance(1000);
  f.store.writeDraft(
    m.id,
    activationId,
    workspace().files.draft,
    'Confirmed order A; plan to check delivery later.',
  );
  const drafts = history().filter((entry) => entry.kind === 'draft');
  assert.equal(drafts.length, 2);
  assert.equal(drafts[0].published, false);
  assert.equal(
    f.store.readFile(m.id, activationId, drafts[0].draftFile).content,
    'First attempt; outcome unknown.',
  );
  assert.equal(f.store.get(m.id).matter.stateText, '');
  const saved = f.store.checkpoint(
    m.id,
    activationId,
    m.revision,
    'Confirmed order A.',
    'checkpoint',
  );
  const beforeFailure = history();
  const input = {
    expectedRevision: saved.revision,
    stateText: 'Confirmed order A. Next: reconsider delivery status after waking.',
    disposition: 'wait' as const,
    summary: 'Created order A and verified confirmation after a lost response.',
    reason: 'Delivery has not happened yet; no useful immediate action.',
    next: 'Recheck delivery; earlier expectations may have changed.',
    wakes: [{ kind: 'at' as const, at: f.time() + 60000 }],
  };
  assert.throws(
    () => f.store.settle(m.id, activationId, { ...input, summary: '' }, 'invalid-summary'),
    /summary/,
  );
  assert.deepEqual(history(), beforeFailure);
  f.advance(1000);
  const settled = f.store.settle(m.id, activationId, input, 'settle');
  const after = history();
  assert.deepEqual(after.slice(0, initial.length), initial);
  const handoff = after.at(-1);
  assert.equal(handoff.summary, input.summary);
  assert.equal(handoff.reason, input.reason);
  assert.equal(handoff.next, input.next);
  assert.equal(handoff.activationId, activationId);
  assert.equal(handoff.timestamp, new Date(f.time()).toISOString());
  assert.equal(readFileSync(handoff.stateFile, 'utf8'), input.stateText);
  assert.deepEqual(f.store.settle(m.id, activationId, input, 'settle'), settled);
  assert.deepEqual(history(), after, 'replayed receipts must not append a second summary');
  assert.throws(
    () => f.store.writeDraft(m.id, activationId, workspace().files.changes, 'erase history'),
    /no longer/,
  );
  f.advance(500);
  const endedAt = f.time();
  f.store.finish(m.id, activationId);
  f.reopen().recover();
  f.advance(60000);
  f.store.enqueueDue();
  const next = f.store.claim(m.id)!.matter;
  const nextContext = f.store.workspace(m.id, next.activation!.id);
  assert.deepEqual(nextContext.wake, {
    causes: ['time'],
    previousRunEndedAt: endedAt,
  });
  const nextHistory = JSON.parse(
    '[' + readFileSync(nextContext.files.changes, 'utf8').trim().split('\n').join(',') + ']',
  );
  assert.deepEqual(nextHistory.slice(0, after.length), after);
  assert.equal(nextHistory.filter((entry: { summary?: string }) => entry.summary).length, 1);
  assert.equal(nextHistory.at(-2).kind, 'finish');
});

test('legacy revision history migrates once without inventing activation summaries', (t) => {
  const f = fixture(t);
  const m = f.store.claim(f.m.id)!.matter;
  settle(f.store, m);
  f.store.finish(m.id, m.activation!.id);
  const db = new DatabaseSync(join(f.root, 'matters.sqlite'));
  db.exec('DROP TABLE matter_history');
  db.close();
  f.reopen();
  f.store.control(m.id, 'resume');
  const next = f.store.claim(m.id)!.matter;
  const view = f.store.workspace(m.id, next.activation!.id);
  const before = readFileSync(view.files.changes, 'utf8');
  const history = before
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.ok(history.some((entry) => entry.kind === 'legacy_revision'));
  assert.equal(history.filter((entry) => entry.summary).length, 0);
  assert.deepEqual(view.wake.causes, ['resume']);
  f.reopen();
  assert.equal(
    readFileSync(f.store.workspace(m.id, next.activation!.id).files.changes, 'utf8'),
    before,
  );
});
