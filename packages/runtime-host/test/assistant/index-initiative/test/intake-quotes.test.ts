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
import { intakeFixture } from './intake-fixture.js';
import { decodeMessageAdmissionContent } from '../../../../src/protocol/turn.js';

test('Maka intake screens quote comments and can wake without a body or activity-token fallback', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  const comment = '交付已取消，需要确认备用安排';
  const messages: any[] = [];
  let revision = 0;
  f.ctx.sessionQuery.historyList = async () => [{ id: 'project', historyRevision: revision }];
  f.ctx.sessionQuery.historyRead = async () => ({ messages });
  await f.q.intake.collect();
  const tokens = (await f.q.activity(f.q.state())).tokens;
  f.q.store.update((s: any) => {
    s.checkedTokens = tokens;
    s.lastPeriodicFinishedAt = f.q.now();
  });
  messages.push({
    id: 'reply',
    type: 'user',
    ...decodeMessageAdmissionContent({ text: '', quotes: [{ text: '原定周五交付', comment }] }),
  });
  revision++;
  await f.q.intake.collect();
  f.advance();
  f.ctx.llm.generate = async (input: any) => {
    const records = JSON.parse(input.prompt).events.flatMap((g: any) => g.records);
    assert.equal(records.length, 1);
    assert.equal(records[0].content, comment);
    return { text: JSON.stringify('交付取消，可能需要协助') };
  };
  await f.q.intake.judge();
  assert.ok(await f.q.intake.next());
  await f.q.dispatch();
  await f.q.running;
  assert.equal(f.counts().workerCalls, 1);
  await f.q.intake.collect();
  assert.equal(f.q.store.db.prepare('SELECT COUNT(*) n FROM intake_events').get()?.n, 1);
});

test('Maka intake keeps display text and every quote comment without replaying baselined history', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  const messages: any[] = [
    { id: 'old', text: '', quotes: [{ text: 'old excerpt', comment: 'old comment' }] },
  ];
  let revision = 0;
  f.ctx.sessionQuery.historyList = async () => [{ id: 'project', historyRevision: revision }];
  f.ctx.sessionQuery.historyRead = async () => ({ messages });
  await f.q.intake.collect();
  messages.push({
    id: 'new',
    text: 'internal body',
    displayText: 'visible body',
    quotes: [
      { text: 'quoted context', comment: 'first comment' },
      { text: 'another excerpt', comment: 'second comment' },
      { text: 'context only' },
    ],
  });
  revision++;
  await f.q.intake.collect();
  const rows = f.q.store.db.prepare('SELECT payload FROM intake_events').all();
  assert.equal(rows.length, 1);
  assert.equal(
    JSON.parse(String(rows[0].payload)).content,
    'visible body\n\nfirst comment\n\nsecond comment',
  );
});

test('an empty frame advances the receipt and is reconsidered when its comment changes', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  f.say('chat', { id: 'earlier', type: 'user', text: 'Earlier message' });
  await f.q.intake.collect();
  const message = {
    id: 'quote-1',
    type: 'user',
    text: '',
    quotes: [{ text: 'Context only', comment: '' }],
  };
  f.say('chat', message);
  const read = f.ctx.sessionQuery.historyRead;
  let reads = 0;
  f.ctx.sessionQuery.historyRead = async (...args: any[]) => {
    reads++;
    return read(...args);
  };
  await f.q.intake.collect();
  await f.q.intake.collect();
  assert.equal(reads, 1, 'an unchanged empty frame must not repeatedly reread the whole history');
  assert.equal(
    f.q.store.db.prepare("SELECT COUNT(*) n FROM intake_events WHERE source='maka'").get()?.n,
    0,
  );
  message.quotes[0].comment = 'New feedback';
  await f.q.intake.collect();
  assert.equal(reads, 2, 'a revised message is read again');
  const rows = f.q.store.db.prepare("SELECT payload FROM intake_events WHERE source='maka'").all();
  assert.equal(rows.length, 1);
  assert.equal(JSON.parse(String(rows[0].payload)).content, 'New feedback');
});
