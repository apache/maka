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

// A quote-only frame is a real protocol shape: the owner replies to an excerpt, so the
// message body is empty and the owner's words live in quotes[].comment. Event intake is
// allowed to be late, but it may not silently drop such a frame.
const quoted = {
  id: 'quote-1',
  type: 'user',
  text: '',
  quotes: [{ text: '合同第三条：验收后 30 日内付款', comment: '这条要改，改成预付三成' }],
};

const receipt = (f: any, key = 'maka') => {
  const row = f.q.store.db.prepare('SELECT value FROM intake_meta WHERE key=?').get(key);
  return row ? JSON.parse(String(row.value)) : undefined;
};

test('screening reads the quoted comment of a frame whose body is empty', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  f.say('chat', { id: 'earlier', type: 'user', text: '开场白' });
  await f.q.intake.collect();
  f.say('chat', quoted);
  await f.q.intake.collect();
  const prompts: string[] = [];
  f.ctx.llm.generate = async (input: any) => {
    prompts.push(String(input.prompt));
    return { modelId: 'fixture', text: JSON.stringify('合同付款条件可能要改') };
  };
  f.advance();
  await f.q.intake.judge();
  assert.equal(prompts.length, 1, 'the frame still reaches screening');
  assert.match(prompts[0], /改成预付三成/, 'screening must read the owner quote comment');
});

test('a frame that projects to nothing does not advance the receipt position', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  f.say('chat', { id: 'earlier', type: 'user', text: '开场白' });
  await f.q.intake.collect();
  const before = receipt(f);
  assert.ok(before?.chat, 'baseline receipt is recorded');
  f.say('chat', { id: 'empty-1', type: 'user', text: '', quotes: [] });
  await f.q.intake.collect();
  assert.deepEqual(receipt(f), before, 'an unprojectable frame keeps the receipt position');
  assert.equal(
    f.q.store.db.prepare("SELECT COUNT(*) n FROM intake_events WHERE source='maka'").get()?.n,
    0,
    'an empty projection is not queued as a screened event',
  );
});
