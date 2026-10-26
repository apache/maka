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
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BotStore } from '../assistant/bot/store.js';

const card = {
  type: 'offer' as const,
  title: '选一个',
  items: [
    { title: 'A', actions: [{ kind: 'reply' as const, label: 'A', value: '选择 A' }] },
    { title: 'B', actions: [{ kind: 'reply' as const, label: 'B', value: '选择 B' }] },
  ],
};
function seed(store: BotStore) {
  store.queueVisible({
    type: 'assistant',
    id: 'card',
    turnId: 'turn',
    text: '选一个',
    modelId: 'bot',
    ts: 1,
    card,
  });
  store.delivered('card');
}
test('whole-card selection survives restart and competing clients cannot enqueue a second option', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maka-card-choice-'));
  let a = new BotStore(dir);
  let b = new BotStore(dir);
  try {
    seed(a);
    assert.equal(a.chooseCard('card', '0:0'), '0:0');
    assert.equal(b.chooseCard('card', '1:0'), '0:0');
    assert.equal(b.chooseCard('card', '0:0'), '0:0');
    assert.equal(a.head(), 1);
    assert.deepEqual(
      a.pendingVisible().map((x) => 'text' in x && x.text),
      ['选择 A'],
    );
    a.close();
    a = new BotStore(dir);
    assert.equal(a.cardSelection('card'), '0:0');
    assert.equal(a.chooseCard('card', '1:0'), '0:0');
    assert.equal(a.head(), 1);
  } finally {
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test('invalid selection and failed transaction do not consume the card or create Inbox entries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maka-card-choice-'));
  const store = new BotStore(dir);
  try {
    seed(store);
    assert.throws(() => store.chooseCard('missing', '0:0'), /Unknown/);
    assert.throws(() => store.chooseCard('card', '2:0'), /Invalid/);
    store.db.exec(
      "CREATE TRIGGER fail_choice BEFORE INSERT ON card_replies BEGIN SELECT RAISE(ABORT, 'disk failure'); END",
    );
    assert.throws(() => store.chooseCard('card', '0:0'), /disk failure/);
    assert.equal(store.cardSelection('card'), null);
    assert.equal(store.head(), 0);
    assert.equal(store.pendingVisible().length, 0);
    store.db.exec('DROP TRIGGER fail_choice');
    assert.equal(store.chooseCard('card', '1:0'), '1:0');
    assert.equal(store.head(), 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});


test('card choices coexist with durable notification decisions across store instances and restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maka-card-decisions-'));
  let a = new BotStore(dir);
  const b = new BotStore(dir);
  try {
    seed(a);
    a.post({ id: 'discovery', type: 'discovery', source: 'test', content: 'fixture only' });
    const decisions = [{ inboxId: 'discovery', reason: 'test omission' }];
    a.recordNotNotified('operation-a', decisions);
    const saved = a.read('discovery').notNotified;
    assert.equal(b.chooseCard('card', '1:0'), '1:0');
    b.recordNotNotified('operation-a', decisions);
    assert.deepEqual(a.read('discovery').notNotified, saved);
    assert.throws(() => b.recordNotNotified('operation-a', [{ ...decisions[0]!, reason: 'changed' }]), /different reason/);
    a.close();
    a = new BotStore(dir);
    assert.equal(a.cardSelection('card'), '1:0');
    assert.equal(a.chooseCard('card', '0:0'), '1:0');
    assert.deepEqual(a.read('discovery').notNotified, saved);
    assert.equal(a.pendingVisible().filter(m => m.type === 'user').length, 1);
    b.recordNotNotified('operation-b', decisions);
    assert.equal(a.read('discovery').notNotified.length, 2);
  } finally {
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
