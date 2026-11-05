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
import { DiscoveryCoordinator } from '../../../../src/assistant/index-initiative/coordination.js';
import { Notebook } from '../../../../src/assistant/index-initiative/notebook.js';
import { fixture, until } from './fixture.js';
import { intakeFixture } from './intake-fixture.js';

function setup(t: any) {
  const root = mkdtempSync(join(tmpdir(), 'discovery-coordination-'));
  const store = new InitiativeStore(root, 'first');
  store.lease();
  store.bind({ sessionId: 'owner', cwd: root });
  const book = new Notebook(join(root, 'notebook.sqlite'));
  const coordinator = new DiscoveryCoordinator(store, () => book.sequence());
  t.after(() => {
    book.close();
    store.release();
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return { root, store, book, coordinator };
}
const note = {
  topicId: 'export',
  title: 'export',
  text: 'Version incompatibility remains unverified',
  sources: ['fixture'],
  tags: [],
};

async function output(prompt: string, draft: any = {}) {
  const path = /完成后把增量操作写入 ([^\n]+)，格式/.exec(prompt)?.[1];
  assert.ok(path);
  await writeFile(path, JSON.stringify(draft));
}

test('queued lanes are durable and fair; repeated ticks cannot jump a waiting investigation', (t) => {
  const { coordinator } = setup(t);
  const broad = coordinator.acquire('broad')!;
  assert.ok(broad);
  for (let i = 0; i < 20; i++) assert.equal(coordinator.acquire('quick'), undefined);
  assert.equal(coordinator.status().waiting.length, 1);
  coordinator.release(broad, 'completed');
  assert.equal(coordinator.acquire('broad'), undefined);
  const quick = coordinator.acquire('quick')!;
  assert.ok(quick);
  coordinator.release(broad, 'completed'); // stale completion cannot release quick
  assert.equal(coordinator.status().running?.lane, 'quick');
  coordinator.release(quick, 'completed');
  const next = coordinator.acquire('broad');
  assert.ok(next);
  coordinator.release(next!);
});

test('restart preserves the waiting lane, fences the old owner and records partial memory', (t) => {
  const { root, store, book, coordinator } = setup(t);
  const old = coordinator.acquire('broad')!;
  book.appendNote(note, 'partial');
  coordinator.acquire('quick');
  store.release();
  const successor = new InitiativeStore(root, 'successor');
  try {
    assert.equal(successor.lease(), true);
    const next = new DiscoveryCoordinator(successor, () => book.sequence());
    next.recover();
    assert.equal(next.previous().outcome, 'interrupted');
    assert.equal(book.readMemory(next.previous().memory).items[0].id, 'partial');
    assert.equal(next.acquire('broad'), undefined);
    const permit = next.acquire('quick')!;
    assert.ok(permit);
    coordinator.release(old, 'completed');
    assert.throws(() => coordinator.assertActive(old), /ownership changed/);
    assert.equal(next.status().running?.lane, 'quick');
    next.release(permit, 'completed');
  } finally {
    successor.release();
    successor.close();
  }
});

test('a completion fenced by temporary lease expiry is released after the same owner renews', (t) => {
  const { store, coordinator } = setup(t);
  const broad = coordinator.acquire('broad')!;
  coordinator.acquire('quick');
  store.db.exec('UPDATE lease SET until_at=0');
  coordinator.release(broad, 'completed');
  assert.equal(coordinator.status().running?.lane, 'broad');
  assert.equal(coordinator.previous(), null, 'expired owners cannot write a completion');
  assert.throws(() => coordinator.acquire('quick'), /ownership changed/);
  assert.equal(store.lease(), true);
  coordinator.recover();
  assert.equal(coordinator.status().running, null);
  assert.equal(coordinator.previous().outcome, 'completed');
  const quick = coordinator.acquire('quick');
  assert.ok(quick);
  coordinator.release(quick!);
});

test('memory handoff reads only the completed interval and keeps live feedback revision', (t) => {
  const { book, coordinator } = setup(t);
  book.appendNote({ ...note, text: 'old' }, 'old');
  const permit = coordinator.acquire('quick')!;
  book.appendNote(note, 'new');
  coordinator.release(permit, 'completed');
  const previous = coordinator.previous();
  book.appendNote({ ...note, text: 'later' }, 'later');
  const page: any = book.readMemory(previous.memory);
  assert.deepEqual(
    page.items.map((x: any) => x.id),
    ['new'],
  );
  assert.equal(page.nextCursor, null);
  assert.throws(() => book.readMemory({ view: 'catalog', afterSequence: 0 }), /only for history/);
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
  const c = f.parent.coordinator;
  const broad = c.acquire('broad')!;
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
  c.release(broad, 'completed');
  const idle = f.agent.whenIdle;
  f.agent.whenIdle = async () => {
    assert.equal(c.acquire('broad'), undefined);
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
  const secondBroad = c.acquire('broad')!;
  assert.ok(secondBroad);
  c.release(secondBroad, 'completed');
  f.agent.whenIdle = idle;
  await f.q.dispatch();
  await f.q.running;
  assert.equal(f.counts().workerCalls, 2);
  assert.equal(await f.q.intake.next(), undefined);
});

test('pausing a waiting quick lane removes only its request and retains unread hints', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  const c = f.parent.coordinator;
  const broad = c.acquire('broad')!;
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
    f.q.store.db.prepare("SELECT COUNT(*) AS n FROM intake_wakes WHERE status='pending'").get()?.n,
    1,
  );
  await f.q.control({ action: 'enable' });
  assert.equal((await f.q.intake.next())?.ids.length, 1);
  c.release(broad);
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
  assert.equal(f.parent.coordinator.status().running, null);
  assert.equal(f.parent.coordinator.previous().outcome, 'interrupted');
  assert.equal((await f.q.intake.next())?.ids.length, 1);
  const permit = f.parent.coordinator.acquire('broad');
  assert.ok(permit);
  f.parent.coordinator.release(permit!);
});
