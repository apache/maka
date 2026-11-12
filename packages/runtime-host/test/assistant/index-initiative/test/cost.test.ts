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
import { fixture, until } from './fixture.js';
import { output, note } from './notebook-output.js';
import type { SessionUsageWindow } from '../../../../src/assistant/run-cost.js';

// Discovery cost and outcome (#6309), observed through the fixed `assistant.status`
// API with the real scheduler, controlled models and a controlled Usage ledger.
const window = (calls: number, input: number): SessionUsageWindow => ({
  calls,
  inputTokens: input,
  cacheReadTokens: Math.floor(input / 2),
  cacheWriteTokens: 10,
  outputTokens: calls * 100,
  modelDurationMs: calls * 1000,
  complete: true,
});

function usageProbe(options: { fail?: boolean } = {}) {
  const asked: { sessionId: string; from: number; to: number }[] = [];
  let labels: (sessionId: string) => string[] = () => [];
  return {
    asked,
    bind(read: (sessionId: string) => string[]) {
      labels = read;
    },
    read: async (sessionId: string, from: number, to: number) => {
      asked.push({ sessionId, from, to });
      if (options.fail) throw Error('usage ledger unavailable');
      return labels(sessionId).some((l) => l.startsWith('assistant-discovery:'))
        ? window(3, 1000)
        : window(2, 400);
    },
  };
}

async function completed(f: any, runs: number) {
  await until(async () => {
    const cost = (await f.remote('assistant.status', { includeMemory: false })).cost;
    return cost.recent.length >= runs && !(await f.invoke('InitiativeStatus')).active;
  });
  return (await f.remote('assistant.status', { includeMemory: false })).cost;
}

test('a run that reports is recorded with both workers cost, kept apart from the conversation', async () => {
  const probe = usageProbe();
  const f = await fixture({ readSessionUsage: probe.read });
  probe.bind((id) => f.workers.get(id)?.labels ?? []);
  try {
    await f.remote('assistant.bind', { sessionId: 'owner' });
    f.setRunner(async ({ prompt }: any) => {
      if (prompt.includes('Phase: discovery')) await output(prompt, { notes: [note] });
      else
        await output(prompt, {
          messages: [{ text: '报名窗口今天关闭，确认后及时报名。', topicIds: [note.topicId] }],
        });
    });
    await f.invoke('InitiativeControl', { action: 'check' });
    const cost = await completed(f, 1);
    const [run] = cost.recent;
    assert.equal(run.kind, 'discovery');
    assert.equal(run.outcome, 'reported');
    assert.equal(run.reported, true);
    assert.equal(run.calls, 5, 'discovery 3 + judgement 2');
    assert.equal(run.inputTokens, 1400);
    assert.equal(run.cacheReadTokens, 700);
    assert.equal(run.cacheWriteTokens, 20);
    assert.equal(run.outputTokens, 500);
    assert.equal(run.usageComplete, true);
    assert.equal(run.durationMs, run.endedAt - run.startedAt);
    assert.ok(run.durationMs >= 0);
    // One window per worker Session, never the user's conversation.
    assert.equal(probe.asked.length, 2);
    assert.ok(probe.asked.every((a) => a.sessionId !== 'owner'));
    assert.ok(probe.asked.every((a) => a.from <= a.to));
    const [today] = cost.daily;
    assert.equal(today.kind, 'discovery');
    assert.equal(today.runs, 1);
    assert.equal(today.reported, 1);
    assert.equal(today.noReport, 0);
    assert.equal(today.calls, 5);
  } finally {
    await f.close();
  }
});

test('a run that reports nothing is counted as no report, not as failed or as reported', async () => {
  const probe = usageProbe();
  const f = await fixture({ readSessionUsage: probe.read });
  probe.bind((id) => f.workers.get(id)?.labels ?? []);
  try {
    await f.remote('assistant.bind', { sessionId: 'owner' });
    // Both phases finish cleanly and the judgement hands nothing to the Bot.
    f.setRunner(async ({ prompt }: any) => {
      await output(prompt, { notes: prompt.includes('Phase: discovery') ? [note] : [] });
    });
    await f.invoke('InitiativeControl', { action: 'check' });
    const cost = await completed(f, 1);
    const [run] = cost.recent;
    assert.equal(run.outcome, 'no_report');
    assert.equal(run.reported, false);
    assert.equal(run.calls, 5, 'a quiet run still spent model calls');
    const [today] = cost.daily;
    assert.equal(today.runs, 1);
    assert.equal(today.noReport, 1);
    assert.equal(today.reported, 0);
    assert.equal(today.failed, 0);
    assert.equal((await f.invoke('InitiativeStatus')).lastRun.outcome, 'quiet');
  } finally {
    await f.close();
  }
});

test('a failed run keeps what it spent and a second run is a separate row', async () => {
  const probe = usageProbe();
  const f = await fixture({ readSessionUsage: probe.read });
  probe.bind((id) => f.workers.get(id)?.labels ?? []);
  try {
    await f.remote('assistant.bind', { sessionId: 'owner' });
    let judgements = 0;
    f.setRunner(async ({ prompt }: any) => {
      if (prompt.includes('Phase: discovery')) return output(prompt, { notes: [note] });
      judgements++;
      if (judgements === 1) throw Error('provider unavailable');
      return output(prompt);
    });
    await f.invoke('InitiativeControl', { action: 'check' });
    let cost = await completed(f, 1);
    assert.equal(cost.recent[0].outcome, 'failed');
    assert.equal(cost.recent[0].reported, false);
    assert.equal(cost.recent[0].calls, 5, 'the failed attempt still cost its calls');
    await f.invoke('InitiativeConfigure', { intervalMinutes: 90 });
    await f.invoke('InitiativeControl', { action: 'check' });
    cost = await completed(f, 2);
    assert.deepEqual(
      cost.recent.map((r: any) => r.outcome),
      ['no_report', 'failed'],
    );
    const [today] = cost.daily;
    assert.equal(today.runs, 2);
    assert.equal(today.failed, 1);
    assert.equal(today.noReport, 1);
  } finally {
    await f.close();
  }
});

test('an unreadable Usage ledger is recorded as unknown cost, never as zero cost or a stalled run', async () => {
  const probe = usageProbe({ fail: true });
  const f = await fixture({ readSessionUsage: probe.read });
  try {
    await f.remote('assistant.bind', { sessionId: 'owner' });
    f.setRunner(async ({ prompt }: any) => {
      await output(prompt, { notes: prompt.includes('Phase: discovery') ? [note] : [] });
    });
    await f.invoke('InitiativeControl', { action: 'check' });
    const cost = await completed(f, 1);
    assert.equal(cost.recent[0].outcome, 'no_report');
    assert.equal(cost.recent[0].usageComplete, false);
    assert.equal(cost.daily[0].incompleteUsageRuns, 1);
    assert.equal((await f.invoke('InitiativeStatus')).lastError, null);
  } finally {
    await f.close();
  }
});
