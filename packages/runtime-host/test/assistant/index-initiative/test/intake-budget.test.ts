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
import { estimatePluginLlmInputTokens } from '@maka/runtime/plugin-llm-service';
import { intakeFixture } from './intake-fixture.js';

const pending = (f: any) =>
  Number(
    f.q.store.db.prepare("SELECT COUNT(*) n FROM intake_events WHERE status='pending'").get().n,
  );

test('selected model budget packs full serialized input and reacts to a smaller model', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  let capacity = 8000;
  const counts: number[] = [];
  f.ctx.llm.budget = async () => ({
    modelId: 'configured',
    maxInputTokens: capacity,
    maxOutputTokens: 2048,
  });
  f.ctx.llm.generate = async (input: any) => {
    assert.equal(input.boundedInput, true);
    assert.ok(estimatePluginLlmInputTokens(input.system, input.prompt) <= capacity);
    const groups = JSON.parse(input.prompt).events;
    counts.push(groups.flatMap((g: any) => g.records).length);
    return { text: '""' };
  };
  await f.q.intake.collect();
  for (let i = 0; i < 40; i++) f.add(String(i), '中文😀\"\n'.repeat(30));
  await f.q.intake.collect();
  f.advance();
  await f.q.intake.judge();
  assert.ok(pending(f) > 0);
  capacity = 3000;
  await f.q.intake.judge();
  assert.ok(counts[1] < counts[0]);
  for (let i = 0; i < 50 && pending(f); i++) await f.q.intake.judge();
  assert.equal(pending(f), 0);
  assert.equal(
    counts.reduce((a, b) => a + b, 0),
    40,
  );
});

test('oversized original is preserved and all Unicode fragments survive restart without loss', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  const text = '用户😀\n"重要变化"'.repeat(1500);
  const seen: any[] = [];
  f.ctx.llm.budget = async () => ({
    modelId: 'small',
    maxInputTokens: 4000,
    maxOutputTokens: 2048,
  });
  f.ctx.llm.generate = async (input: any) => {
    assert.ok(estimatePluginLlmInputTokens(input.system, input.prompt) <= 4000);
    seen.push(...JSON.parse(input.prompt).events.flatMap((g: any) => g.records));
    return { text: '""' };
  };
  await f.q.intake.collect();
  f.add('huge', text);
  await f.q.intake.collect();
  f.advance();
  await f.q.intake.judge();
  assert.equal(seen.length, 0);
  const original = f.q.store.db
    .prepare("SELECT payload FROM intake_events WHERE status='split'")
    .get();
  assert.equal(JSON.parse(String(original?.payload)).content, text);
  await f.restart();
  for (let i = 0; i < 100 && pending(f); i++) await f.q.intake.judge();
  assert.equal(pending(f), 0);
  assert.equal(
    seen
      .sort((a, b) => a.part - b.part)
      .map((r) => r.content)
      .join(''),
    text,
  );
  assert.ok(seen.every((r) => r.content.isWellFormed()));
  await f.q.intake.collect();
  assert.equal(pending(f), 0);
});

test('unknown capacity fails before model call and leaves original pending', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  await f.q.intake.collect();
  f.add('new');
  await f.q.intake.collect();
  f.advance();
  f.ctx.llm.budget = async () => {
    throw Error('Context capacity is unknown');
  };
  await assert.rejects(f.q.intake.judge(), /capacity is unknown/);
  assert.equal(f.counts().modelCalls, 0);
  assert.equal(pending(f), 1);
});
