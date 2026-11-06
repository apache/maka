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
import { mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InitiativeStore } from '../../../../src/assistant/index-initiative/store.js';
import { DiscoveryRunner } from '../../../../src/assistant/index-initiative/runner.js';
import { QuickDiscoveryController } from '../../../../src/assistant/index-initiative/quick.js';
import { laneFixture } from './runner-fixture.js';
import { Notebook } from '../../../../src/assistant/index-initiative/notebook.js';
import { fixture, until } from './fixture.js';
import { intakeFixture } from './intake-fixture.js';

function setup(t: any) {
  const root = mkdtempSync(join(tmpdir(), 'discovery-coordination-'));
  const store = new InitiativeStore(root, 'first');
  store.lease();
  store.bind({ sessionId: 'owner', cwd: root });
  const book = new Notebook(join(root, 'notebook.sqlite'));
  const runner = new DiscoveryRunner(store, () => book.sequence());
  t.after(() => {
    book.close();
    store.release();
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return { root, store, book, runner };
}
const note = {
  topicId: 'export',
  title: 'export',
  text: 'Version incompatibility remains unverified',
  sources: ['fixture'],
  tags: [],
};

test('idle quick cutover preserves a scoped worker identity before publishing its binding', async (t) => {
  const { root, store, runner } = setup(t);
  const legacy = new InitiativeStore(join(root, 'quick-discovery'), store.owner);
  legacy.lease();
  legacy.bind({ sessionId: 'owner', cwd: root });
  legacy.bindWorker('scoped-worker', 'quick', 'scoped', 'previous-cycle');
  legacy.update((s) => {
    s.workerSession = 'scoped-worker';
    s.enabled = true;
    s.intervalMs = 900_000;
  });
  legacy.release();
  legacy.close();
  const quick = new QuickDiscoveryController({}, { store, runner }, root);
  try {
    quick.start(3_600_000);
    assert.equal(quick.state().workerSession, 'scoped-worker');
    assert.equal(quick.state().enabled, true);
    assert.equal(quick.state().intervalMs, 900_000);
    assert.deepEqual(quick.workerIdentity('scoped-worker'), {
      role: 'quick',
      mode: 'scoped',
      contextKey: 'previous-cycle',
    });
    assert.throws(() => quick.execution('scoped-worker', true), /No active quick discovery/);
  } finally {
    await quick.close();
  }
});

async function output(prompt: string, draft: any = {}) {
  const path = /完成后把增量操作写入 ([^\n]+)，格式/.exec(prompt)?.[1];
  assert.ok(path);
  await writeFile(path, JSON.stringify(draft));
}

test('coalesced requests keep FIFO order and completed memory intervals', async (t) => {
  const { store, book, runner } = setup(t);
  const quickStore = store.scope('quick');
  quickStore.bind({ sessionId: 'owner', cwd: store.directory });
  const broad = laneFixture(runner, store, 'broad');
  const quick = laneFixture(runner, quickStore, 'quick');
  book.appendNote({ ...note, text: 'old' }, 'old');
  await broad.start();
  quick.request();
  for (let i = 0; i < 20; i++) await runner.tick();
  assert.equal(quick.calls(), 0);
  assert.equal(runner.status().waiting.length, 1);
  book.appendNote(note, 'broad-note');
  await broad.finish();
  broad.request();
  await runner.tick();
  assert.equal(runner.status().running?.lane, 'quick');
  assert.equal(broad.calls(), 1);
  book.appendNote(note, 'quick-note');
  await quick.finish();
  const previous = runner.previous()!;
  book.appendNote(note, 'later');
  assert.deepEqual(
    book.readMemory(previous.memory).items.map((x: any) => x.id),
    ['quick-note'],
  );
  assert.equal(previous.outcome, 'completed');
  await runner.tick();
  assert.equal(broad.calls(), 2);
  await broad.finish();
});

test('idle cutover keeps settings and memory without converting old coordination records', (t) => {
  const { root, store, book, runner } = setup(t);
  const quick = store.scope('quick');
  quick.bind({ sessionId: 'owner', cwd: root });
  store.update((s) => {
    s.intervalMs = 90000;
  });
  book.appendNote(note, 'retained-note');
  store.db.exec(
    "CREATE TABLE discovery_waiters(seq INTEGER PRIMARY KEY, lane TEXT, queued_at INTEGER); INSERT INTO discovery_waiters VALUES(1,'quick',10)",
  );
  laneFixture(runner, store, 'broad');
  laneFixture(runner, quick, 'quick');
  runner.initialize();
  runner.initialize();
  assert.equal(store.get().intervalMs, 90000);
  assert.equal(store.get().enabled, false);
  assert.equal(book.event('retained-note').payload.text, note.text);
  assert.equal(runner.job('broad'), undefined);
  assert.equal(runner.job('quick'), undefined);
  assert.deepEqual(runner.status().waiting, []);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM discovery_waiters').get()?.n, 1);
});

test('broad exploration and judgement finish before quick investigation; committed memory reaches its request', async () => {
  const f = await fixture();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const seen: string[] = [];
  try {
    await f.remote('assistant.bind', { sessionId: 'owner' });
    f.setRunner(async ({ prompt, invoke }: any) => {
      if (prompt.includes('Phase: discovery')) {
        seen.push('broad');
        await gate;
        await output(prompt, { notes: [note] });
      } else if (prompt.includes('Phase: judgement')) {
        seen.push('judgement');
        await output(prompt);
      } else {
        seen.push('quick');
        assert.match(prompt, /上一轮调查的记忆增量入口/);
        assert.match(prompt, /"lane":"broad"/);
        const page = await invoke('DiscoveryNotebook', { view: 'topic', topicId: 'export' });
        assert.equal(page.items[0].text, note.text);
      }
    });
    await f.invoke('InitiativeControl', { action: 'check' });
    await until(async () => seen.length === 1);
    await f.invoke('QuickDiscoveryControl', { action: 'check' });
    await until(
      async () => (await f.invoke('QuickDiscoveryStatus')).coordination.waiting.length === 1,
    );
    assert.deepEqual(seen, ['broad']);
    release();
    await until(async () => seen.length === 3 && !(await f.invoke('QuickDiscoveryStatus')).active);
    assert.deepEqual(seen, ['broad', 'judgement', 'quick']);
    assert.equal((await f.invoke('InitiativeStatus')).coordination.running, null);
  } finally {
    release?.();
    await f.close();
  }
});

test('screening continues while broad is running; queued hints coalesce and later arrivals wait fairly', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  const c = f.parent.runner;
  const broad = laneFixture(c, f.parent.store, 'broad');
  await broad.start();
  await f.q.intake.collect();
  for (const id of ['one', 'two']) {
    f.add(id);
    await f.q.intake.collect();
    f.advance();
    await f.q.intake.judge();
    await f.q.dispatch();
  }
  assert.equal(f.counts().workerCalls, 0);
  assert.equal(c.status().waiting.length, 1);
  assert.equal((await f.q.intake.next())?.ids.length, 2);
  await broad.finish();
  const idle = f.agent.whenIdle;
  f.agent.whenIdle = async () => {
    broad.request();
    assert.equal(c.status().running?.lane, 'quick');
    f.add('during');
    await f.q.intake.collect();
    f.advance();
    await f.q.intake.judge();
  };
  await f.q.dispatch();
  await f.q.running;
  assert.equal(f.counts().workerCalls, 1);
  assert.equal((await f.q.intake.next())?.ids.length, 1);
  await f.q.dispatch();
  assert.equal(f.counts().workerCalls, 1, 'queued broad is served before another quick wake');
  assert.equal(c.status().running?.lane, 'broad');
  await broad.finish();
  f.agent.whenIdle = idle;
  await f.q.dispatch();
  await f.q.running;
  assert.equal(f.counts().workerCalls, 2);
  assert.equal(await f.q.intake.next(), undefined);
});

test('pausing a waiting quick lane removes only its request and retains unread hints', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  const c = f.parent.runner;
  const broad = laneFixture(c, f.parent.store, 'broad');
  await broad.start();
  await f.q.intake.collect();
  f.add('pending');
  await f.q.intake.collect();
  f.advance();
  await f.q.intake.judge();
  await f.q.dispatch();
  assert.equal(c.waiting('quick'), true);
  await f.q.control({ action: 'pause' });
  assert.equal(c.waiting('quick'), false);
  assert.equal(c.status().running?.lane, 'broad');
  assert.equal(
    f.q.intakeStore.db
      .prepare("SELECT COUNT(*) AS n FROM intake_wakes WHERE status='pending'")
      .get()?.n,
    1,
  );
  await f.q.control({ action: 'enable' });
  assert.equal((await f.q.intake.next())?.ids.length, 1);
  await broad.finish();
});

test('a failed quick investigation releases capacity without consuming its pending event window', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  await f.q.intake.collect();
  f.add('one');
  await f.q.intake.collect();
  f.advance();
  await f.q.intake.judge();
  f.failIdle('fixture interruption');
  await f.q.dispatch();
  await f.q.running;
  assert.match(f.q.state().lastError, /fixture interruption/);
  assert.equal(f.parent.runner.status().running, null);
  assert.equal(f.parent.runner.previous().outcome, 'interrupted');
  assert.equal((await f.q.intake.next())?.ids.length, 1);
  const broad = laneFixture(f.parent.runner, f.parent.store, 'broad');
  await broad.start();
  assert.equal(broad.calls(), 1);
  await broad.finish();
});

test('unfinished legacy work blocks cutover without discarding either identity', async (t) => {
  const { store, runner } = setup(t);
  const quick = store.scope('quick');
  quick.bind({ sessionId: 'owner', cwd: store.directory });
  store.update((s) => {
    s.active = { id: 'broad-before-upgrade' };
  });
  quick.update((s) => {
    s.active = { id: 'quick-before-upgrade' };
  });
  laneFixture(runner, store, 'broad');
  laneFixture(runner, quick, 'quick');
  await assert.rejects(runner.tick(), /Finish pending discovery work/);
  assert.equal(store.get().active.id, 'broad-before-upgrade');
  assert.equal(quick.get().active.id, 'quick-before-upgrade');
  assert.equal(store.configuration().runnerSchema, undefined);
  assert.equal(runner.job('broad'), undefined, 'no replacement job is created');
  assert.match(runner.status().initializationError!, /legacy executions are not resumed/);
});
