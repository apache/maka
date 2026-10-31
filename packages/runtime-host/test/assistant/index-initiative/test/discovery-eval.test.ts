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
import { evaluate } from './discovery-eval.js';
import { exhibitionAndVisa } from './discovery-eval-scenarios.js';

// Scripted runners stand in for discovery. Each one is a known behaviour, so the
// four numbers can be checked against what they should say about it.
const tell = (text: string, ...topicIds: string[]) => ({ text, topicIds });

// Tells every known topic every round, ignoring that nothing changed or that the
// user said stop.
const repeater = ({ round }: { round: number }) => ({
  draft: {
    messages: [tell('摄影展', 'exhibition'), ...(round >= 1 ? [tell('签证材料', 'visa')] : [])],
  },
});

// Never tells anything: no repeats, and that is exactly the failure to catch.
const silent = () => ({ draft: {} });

// Tells each useful finding once, respects the user's stop, and comes back to a
// closed topic only after reopening it for a real change (the `reopened` draft
// field from #6359).
const sensible = ({ round }: { round: number }) => {
  if (round === 0) return { draft: { messages: [tell('周末摄影展开幕', 'exhibition')] } };
  if (round === 1) return { draft: { messages: [tell('签证材料下周五截止', 'visa')] } };
  if (round === 3)
    return {
      draft: {
        reopened: [{ topicId: 'exhibition', reason: '展览延期，原来的开幕信息已失效' }],
        messages: [tell('摄影展延期到下月', 'exhibition')],
      },
    };
  return { draft: {} };
};

test('a silent runner has no repeats and loses both findings', async () => {
  const report = await evaluate(exhibitionAndVisa, silent);
  assert.deepEqual(report.repeats, []);
  assert.deepEqual(report.misses, ['exhibition-opening', 'visa-deadline']);
  assert.deepEqual(report.told, []);
});

test('a repeating runner finds everything and is charged for every needless repeat', async () => {
  const report = await evaluate(exhibitionAndVisa, repeater);
  assert.deepEqual(report.misses, []);
  assert.deepEqual(
    report.repeats.map((r) => `${r.round}:${r.topicId}:${r.reason}`),
    [
      '1:exhibition:unchanged',
      '2:exhibition:closed_by_user',
      '2:visa:unchanged',
      // The note about the extension is a change, but the user closed the topic
      // and nobody reopened it.
      '3:exhibition:closed_by_user',
      '3:visa:unchanged',
    ],
  );
});

test('a sensible runner tells each finding once and reopens only for a real change', async () => {
  const report = await evaluate(exhibitionAndVisa, sensible);
  assert.deepEqual(report.misses, []);
  assert.deepEqual(report.repeats, []);
  assert.deepEqual(report.told, [
    { round: 0, topicId: 'exhibition' },
    { round: 1, topicId: 'visa' },
    { round: 3, topicId: 'exhibition' },
  ]);
});

test('reading the numbers together separates the three behaviours', async () => {
  const [a, b, c] = await Promise.all(
    [silent, repeater, sensible].map((runner) => evaluate(exhibitionAndVisa, runner)),
  );
  const score = (r: typeof a) => ({ misses: r.misses.length, repeats: r.repeats.length });
  assert.deepEqual(score(a), { misses: 2, repeats: 0 });
  assert.deepEqual(score(b), { misses: 0, repeats: 5 });
  assert.deepEqual(score(c), { misses: 0, repeats: 0 });
});

test('latency and cost are summed from what the runner reports', async () => {
  let clock = 0;
  const report = await evaluate(
    exhibitionAndVisa,
    () => {
      clock += 40;
      return {
        draft: {},
        usage: { calls: 2, inputTokens: 1000, outputTokens: 100 },
      };
    },
    // Each round reads the clock twice, so every round is 40 ms apart.
    { now: () => (clock += 10) },
  );
  assert.equal(report.latencyMs.perRound.length, 4);
  assert.ok(report.latencyMs.perRound.every((ms) => ms === 50));
  assert.equal(report.latencyMs.total, 200);
  assert.deepEqual(report.cost, { calls: 8, inputTokens: 4000, outputTokens: 400 });
});

test('a user reply needs something told to reply to', async () => {
  const silentReport = await evaluate(exhibitionAndVisa, silent);
  assert.equal(silentReport.userReplies, 0);
  const sensibleReport = await evaluate(exhibitionAndVisa, sensible);
  assert.equal(sensibleReport.userReplies, 1);
});
