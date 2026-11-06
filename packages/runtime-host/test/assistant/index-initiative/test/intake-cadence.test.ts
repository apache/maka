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
import { until } from './fixture.js';

const minute = 60000;

test('continuous edits merge with their resolution; an empty decision also cools down that thread', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  await f.q.intake.collect();
  const requests: any[] = [];
  f.ctx.llm.generate = async (input: any) => {
    requests.push(input);
    return { text: JSON.stringify('') };
  };
  for (let i = 0; i < 20; i++) {
    f.add(
      'edit-' + i,
      i === 0 ? 'Export failed; fixing it now.' : 'Editing and exporting.',
      'video',
    );
    await f.q.intake.collect();
    f.advance(30000);
    await f.q.intake.judge();
  }
  assert.equal(requests.length, 0);
  f.add('resolved', 'Export succeeded; the original problem is resolved.', 'video');
  await f.q.intake.collect();
  f.advance(3 * minute);
  await f.q.intake.judge();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].reasoning, 'least');
  assert.match(requests[0].prompt, /Export failed/);
  assert.match(requests[0].prompt, /problem is resolved/);
  assert.equal(await f.q.intake.next(), undefined);

  f.add('later', 'Another normal edit.', 'video');
  await f.q.intake.collect();
  f.advance(3 * minute);
  await f.q.intake.judge();
  assert.equal(requests.length, 1);
  await f.restart();
  await f.q.intake.judge();
  assert.equal(requests.length, 1, 'restart preserves the last successful empty screening');
  f.add('other', 'An independent conversation.', 'other');
  await f.q.intake.collect();
  f.advance(3 * minute);
  await f.q.intake.judge();
  assert.equal(requests.length, 2);
  assert.deepEqual(
    JSON.parse(requests[1].prompt).events.map((e: any) => e.group),
    ['other'],
  );
  f.advance(9 * minute);
  await f.q.intake.judge();
  const input = JSON.parse(requests[2].prompt);
  assert.equal(input.events[0].lastScreening.decision, 'quiet');
  assert.equal(input.events[0].records.length, 1, 'old raw messages are not copied again');
});

test('a continuously active thread becomes eligible after the maximum merge wait', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  await f.q.intake.collect();
  for (let i = 0; i < 60; i++) {
    f.add('progress-' + i);
    await f.q.intake.collect();
    await f.q.intake.judge();
    assert.equal(f.counts().modelCalls, 0);
    f.advance(30000);
  }
  await f.q.intake.judge();
  assert.equal(f.counts().modelCalls, 1);
  assert.equal(f.q.intake.status().counts.find((row) => row.status === 'screened')?.count, 60);
});

test('an in-flight screening cannot bypass a completed quick investigation cooldown, including restart', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  await f.q.intake.collect();
  f.add('new');
  await f.q.intake.collect();
  f.advance();
  let resolve!: (value: any) => void;
  f.ctx.llm.generate = () =>
    new Promise((r) => {
      resolve = r;
    });
  const screening = f.q.intake.judge();
  await until(() => !!resolve);
  await f.q.control({ action: 'check' });
  await f.q.tick();
  await f.q.running;
  assert.equal(f.counts().workerCalls, 1);
  resolve({ text: JSON.stringify('A pending hint arrived after the manual investigation.') });
  await screening;
  assert.ok(await f.q.intake.next());
  await f.q.tick();
  await f.q.running;
  assert.equal(f.counts().workerCalls, 1);
  await f.restart();
  f.advance(15 * minute - 1);
  await f.q.tick();
  await f.q.running;
  assert.equal(f.counts().workerCalls, 1);
  f.advance(1);
  await f.q.tick();
  await f.q.running;
  assert.equal(f.counts().workerCalls, 2);
  assert.equal(await f.q.intake.next(), undefined);
  assert.match(f.prompts.at(-1)!, /不扩展为无关方向的全局探索/);
  f.add('follow-up');
  await f.q.intake.collect();
  f.advance(3 * minute);
  assert.equal(f.q.intake.status().scheduling.state, 'cooldown');
  await f.q.intake.judge();
  await f.q.control({ action: 'check' });
  await f.q.tick();
  await f.q.running;
  assert.equal(f.counts().workerCalls, 3, 'explicit checks can bypass timing');
  let input: any;
  f.ctx.llm.generate = async (request: any) => {
    input = JSON.parse(request.prompt);
    return { text: JSON.stringify('') };
  };
  f.advance(15 * minute);
  await f.q.intake.judge();
  assert.equal(input.events[0].lastInvestigation.outcome, 'no_report');
  assert.ok(input.events[0].lastInvestigation.id);
});

test('collection continues during investigation but screening waits for completion and cooldown', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  await f.q.intake.collect();
  let release!: () => void;
  f.agent.whenIdle = () =>
    new Promise<void>((r) => {
      release = r;
    });
  await f.q.control({ action: 'check' });
  await f.q.tick();
  await until(() => !!release);
  f.add('during', 'new work');
  await f.q.intake.collect();
  f.advance(31 * minute);
  await f.q.intake.judge();
  assert.equal(f.counts().modelCalls, 0);
  assert.equal(f.q.intake.status().counts.find((row) => row.status === 'pending')?.count, 1);
  release();
  await f.q.running;
  await f.q.intake.judge();
  assert.equal(f.counts().modelCalls, 0);
  f.advance(15 * minute);
  f.allow(false);
  await f.q.intake.judge();
  assert.equal(f.counts().modelCalls, 0, 'authorization is checked after the wait');
  assert.equal(await f.q.intake.next(), undefined);
});
