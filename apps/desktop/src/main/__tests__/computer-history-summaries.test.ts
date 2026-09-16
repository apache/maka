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

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs, { chmod, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type {
  ComputerHistorySummaryContent,
  ComputerHistorySummaryInput,
} from '@maka/core/computer-history';
import { decodeComputerHistorySummaryInput } from '@maka/runtime-host/protocol';
import {
  ComputerHistorySummaries,
  ComputerHistorySummaryProviderError,
  ComputerHistorySummaryRunError,
  ComputerHistorySummarySnapshotError,
  serializeComputerHistorySummary,
  summaryEventId,
  type ComputerHistorySummaryEvent,
  type StoredComputerHistorySummary,
} from '../computer-history-summaries.js';

const BASE = Date.parse('2026-09-12T00:00:00.000Z');
const MINUTE = 60_000;
const TEN_MINUTES = 10 * MINUTE;
const SIX_HOURS = 6 * 60 * MINUTE;
const DAY = 24 * 60 * MINUTE;
const CONTENT: ComputerHistorySummaryContent = {
  title: 'Review work',
  description: 'Reviewed the implementation in the editor.',
  body: '## Review\n\nChecked the implementation and focused tests.',
  suggestion: { type: 'skill', name: 'Review checklist', description: 'Reuse the review checklist.' },
};

async function fixture(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'maka-history-summaries-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

function event(time: number, title = 'Implementation'): ComputerHistorySummaryEvent {
  return {
    timestamp: new Date(time).toISOString(),
    kind: 'window.changed',
    app: { name: 'Editor', bundleIdentifier: 'com.example.editor' },
    window: { title },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function seedContextSummary(
  home: string,
  start: number,
  level: '10min' | '6h',
  content: ComputerHistorySummaryContent,
  scopeKey = 'allowed',
): Promise<StoredComputerHistorySummary> {
  const duration = level === '6h' ? SIX_HOURS : TEN_MINUTES;
  const summary: StoredComputerHistorySummary = {
    id: `${level}-${start}`, level, start: new Date(start).toISOString(),
    end: new Date(start + duration).toISOString(), content, applications: ['com.example.editor'],
    eventCount: 1,
    sourceIds: level === '6h' ? [`10min-${start}`] : [summaryEventId(event(start + MINUTE))!],
    generation: {
      version: 5, sourceRevision: '0'.repeat(64), includesText: true, scopeKey,
      priorContextIds: [], rawEvidenceRanges: [[start, start + TEN_MINUTES]],
    },
  };
  await mkdir(join(home, 'summaries'), { recursive: true });
  await writeFile(join(home, 'summaries', `${summary.id}.md`), serializeComputerHistorySummary(summary));
  return summary;
}

for (const scenario of [
  'next-day', 'body-tail', 'different-task', 'generic-single', 'app-keyword',
  'nested-keywords', 'proposal-only', 'prior-only', 'tied', 'overlapping',
  'different-scope', 'text-off', 'day-31', 'expired', 'chinese', 'body-prior-only',
  'body-proposal-only', 'metadata-only', 'source-id-only', 'two-generic', 'body-one-anchor',
] as const) test(`older context relevance: ${scenario}`, async (t) => {
  const home = await fixture(t);
  const start = BASE + DAY + 3 * 60 * MINUTE;
  const { suggestion: _suggestion, ...plain } = CONTENT;
  const query = 'ProjectQuartz E_CONNRESET';
  const oldBody = scenario === 'body-tail'
    ? `${'Unrelated earlier details.\n'.repeat(1500)}ProjectQuartz E_CONNRESET: RETRY_DECISION use a smaller batch.`
    : `${query}: RETRY_DECISION use a smaller batch.`;
  const oldContent = {
    ...plain, keywords: ['ProjectQuartz', 'E_CONNRESET'], body: oldBody,
  };
  if (scenario === 'generic-single') oldContent.keywords = ['review'];
  if (scenario === 'two-generic') {
    oldContent.keywords = ['review', 'tests'];
    oldContent.body = 'Review the tests for an unrelated task.';
  }
  if (scenario === 'app-keyword') oldContent.keywords = ['Editor', 'E_CONNRESET'];
  if (scenario === 'nested-keywords') oldContent.keywords = ['ProjectQuartz', 'ProjectQuartz API'];
  if (scenario === 'proposal-only') oldContent.body = 'An unrelated task was observed.';
  if (scenario === 'body-one-anchor') oldContent.body = 'ProjectQuartz: a review with no observed connection error.';
  if (scenario === 'body-prior-only') oldContent.body = `## Prior Context\n${query}\n## Current Work\nA different task.`;
  if (scenario === 'body-proposal-only') oldContent.body = `## Suggestion\n${query}\n## Current Work\nA different task.`;
  if (scenario === 'chinese') {
    oldContent.keywords = ['星河项目', '连接重置'];
    oldContent.body = '昨天排查星河项目遇到的连接重置故障，决定减小批次再试。';
  }
  let oldStart = BASE;
  if (scenario === 'day-31' || scenario === 'expired') oldStart = BASE - 30 * DAY - SIX_HOURS;
  const old = await seedContextSummary(home, oldStart, '6h', {
    ...oldContent,
    ...(scenario === 'proposal-only' ? { suggestion: { type: 'skill', name: query, description: query } } : {}),
  }, scenario === 'different-scope' ? 'excluded' : 'allowed');
  const recent = [];
  for (const minutes of [20, 10]) {
    recent.push(await seedContextSummary(home, start - minutes * MINUTE, '10min', {
      ...plain, body: scenario === 'prior-only' ? query : 'Different recent task.',
    }));
  }
  const tied = scenario === 'tied'
    ? await seedContextSummary(home, BASE - SIX_HOURS, '6h', oldContent) : undefined;
  if (scenario === 'overlapping') await seedContextSummary(home, BASE + TEN_MINUTES, '10min', oldContent);
  const currentStart = scenario === 'day-31' ? Date.parse(old.end) + 31 * DAY :
    scenario === 'expired' ? Date.parse(old.end) + 31 * DAY + TEN_MINUTES : start;
  const inputs: ComputerHistorySummaryInput[] = [];
  const summaries = new ComputerHistorySummaries({
    home, now: () => currentStart + TEN_MINUTES,
    generate: async (input) => { inputs.push(input); return plain; },
  });
  t.after(() => summaries.close());
  const content = ['different-task', 'prior-only', 'metadata-only', 'source-id-only'].includes(scenario) ? 'ProjectHelios E_TIMEOUT' :
    scenario === 'generic-single' ? 'Review the next item.' :
      scenario === 'app-keyword' ? 'Editor E_CONNRESET' :
        scenario === 'nested-keywords' ? 'ProjectQuartz API' :
          scenario === 'chinese' ? '今天继续排查星河项目的连接重置问题。' :
            scenario === 'two-generic' ? 'Review the tests for current work.' : query;
  await summaries.run([{
    ...event(currentStart + MINUTE, scenario === 'metadata-only' ? query : undefined), content,
    ...(scenario === 'source-id-only' ? { sourceKey: query } : {}),
  }], {
    includeText: scenario !== 'text-off', scopeKey: 'allowed',
  });
  const input = inputs.find((input) => input.start === new Date(currentStart).toISOString() && input.level === '10min')!;
  assert.ok(input);
  const expected = ['next-day', 'body-tail', 'day-31', 'chinese', 'tied'].includes(scenario);
  assert.equal(input.priorContext?.some(({ id }) => id === old.id) ?? false, expected);
  assert.ok((input.priorContext?.length ?? 0) <= (tied ? 3 : 2));
  assert.ok(Buffer.byteLength(JSON.stringify(input.priorContext ?? [])) <= 8 * 1024);
  assert.deepEqual(decodeComputerHistorySummaryInput(input), input);
  if (expected) {
    const text = input.priorContext!.find(({ id }) => id === old.id)!.text;
    assert.match(text, scenario === 'chinese' ? /星河项目遇到的连接重置故障，决定减小批次/ :
      /ProjectQuartz E_CONNRESET: RETRY_DECISION use a smaller batch/);
    if (scenario !== 'day-31') assert.deepEqual(input.priorContext!.map(({ id }) => id),
      [...(tied ? [tied.id] : []), old.id, recent[1]!.id]);
  } else if (!['text-off', 'expired'].includes(scenario)) {
    assert.deepEqual(input.priorContext!.map(({ id }) => id), recent.map(({ id }) => id));
  }
});

test('two tied older tasks and the latest recent context reach one request with useful tail excerpts', async (t) => {
  const home = await fixture(t);
  const start = BASE + DAY + 3 * 60 * MINUTE;
  const { suggestion: _suggestion, ...plain } = CONTENT;
  const old = [];
  for (const [index, decision] of [
    'ProjectQuartz E_CONNRESET: upload retry uses SMALLER_BATCH; the upload remains blocked.',
    'ProjectQuartz E_CONNRESET: live stream uses RECONNECT_SOCKET; no upload was attempted.',
  ].entries()) {
    old.push(await seedContextSummary(home, BASE + index * SIX_HOURS, '6h', {
      ...plain, keywords: ['ProjectQuartz', 'E_CONNRESET'],
      body: `${'Unrelated earlier detail.\n'.repeat(1500)}${decision}`,
    }));
  }
  const recent = await seedContextSummary(home, start - TEN_MINUTES, '10min', {
    ...plain, body: 'The upload was selected again. LATEST_UPLOAD_STATE is awaiting retry.',
  });
  const inputs: ComputerHistorySummaryInput[] = [];
  const summaries = new ComputerHistorySummaries({
    home, now: () => start + TEN_MINUTES,
    generate: async (input) => { inputs.push(input); return plain; },
  });
  t.after(() => summaries.close());
  await summaries.run([{
    ...event(start + MINUTE), content: 'ProjectQuartz E_CONNRESET: retrying the upload, not the live stream.',
  }], { includeText: true, scopeKey: 'allowed' });
  assert.equal(inputs.length, 1, 'the shortlist uses the existing single generation call');
  const input = inputs[0]!;
  assert.deepEqual(input.priorContext?.map(({ id }) => id), [...old.map(({ id }) => id), recent.id]);
  assert.match(input.priorContext![0]!.text, /SMALLER_BATCH; the upload remains blocked/);
  assert.match(input.priorContext![1]!.text, /RECONNECT_SOCKET; no upload was attempted/);
  assert.match(input.priorContext![2]!.text, /LATEST_UPLOAD_STATE is awaiting retry/);
  assert.ok(Buffer.byteLength(JSON.stringify(input.priorContext)) <= 8 * 1024);
  assert.deepEqual(decodeComputerHistorySummaryInput(input), input);
  const saved = (await summaries.get(`10min-${start}`))!;
  assert.deepEqual(saved.generation!.priorContextIds, input.priorContext!.map(({ id }) => id));
  for (const source of [...old, recent]) {
    assert.ok(saved.generation!.rawEvidenceRanges!.some(([from, to]) =>
      from <= Date.parse(source.start) && to >= Date.parse(source.start) + TEN_MINUTES));
  }
});

for (const scenario of [
  'three-ties', 'overlap', 'scope', 'text-off', 'escaped-fit', 'near-budget', 'escaped-overflow', 'no-recent',
] as const) test(`older shortlist admission: ${scenario}`, async (t) => {
  const home = await fixture(t);
  const start = BASE + DAY + 3 * 60 * MINUTE;
  const { suggestion: _suggestion, ...plain } = CONTENT;
  const old: StoredComputerHistorySummary[] = [];
  const padding = scenario === 'escaped-fit' ? '"\\\t'.repeat(20) :
    scenario === 'escaped-overflow' ? '"\\\t'.repeat(170) : '';
  for (let index = 0; index < (scenario === 'three-ties' ? 3 : 2); index++) {
    const body = `${'Earlier background.\n'.repeat(1000)}${padding}ProjectQuartz E_CONNRESET: TASK_${index}_TAIL keeps its distinct decision.`;
    const suggestion = scenario === 'near-budget'
      ? { type: 'skill' as const, name: 'Proposed review', description: '"'.repeat(750) }
      : scenario === 'escaped-overflow'
        ? { type: 'skill' as const, name: 'Unapproved proposal', description: '"\\'.repeat(950) }
        : undefined;
    old.push(await seedContextSummary(home,
      scenario === 'overlap' ? BASE + index * TEN_MINUTES : BASE + index * SIX_HOURS,
      scenario === 'overlap' && index === 1 ? '10min' : '6h', {
        ...plain, keywords: ['ProjectQuartz', 'E_CONNRESET'],
        body, ...(suggestion ? { suggestion } : {}),
      }, scenario === 'scope' && index === 1 ? 'excluded' : 'allowed'));
  }
  const recent: StoredComputerHistorySummary[] = [];
  if (scenario !== 'no-recent') {
    for (const minutes of [20, 10]) recent.push(await seedContextSummary(home, start - minutes * MINUTE, '10min', {
      ...plain, body: `Recent task ${minutes}: RECENT_${minutes}_STATE is still pending.`,
    }));
  }
  const inputs: ComputerHistorySummaryInput[] = [];
  const summaries = new ComputerHistorySummaries({
    home, now: () => start + TEN_MINUTES,
    generate: async (input) => { inputs.push(input); return plain; },
  });
  t.after(() => summaries.close());
  await summaries.run([{ ...event(start + MINUTE), content: 'ProjectQuartz E_CONNRESET: resume TASK_0.' }],
    { includeText: scenario !== 'text-off', scopeKey: 'allowed' });
  assert.equal(inputs.length, 1);
  const input = inputs[0]!;
  const expected = scenario === 'text-off' ? [] :
    scenario === 'scope' ? [old[0]!.id, recent[1]!.id] :
      ['escaped-fit', 'near-budget'].includes(scenario) ? [...old.map(({ id }) => id), recent[1]!.id] :
        scenario === 'no-recent' ? old.map(({ id }) => id) : recent.map(({ id }) => id);
  assert.deepEqual(input.priorContext?.map(({ id }) => id) ?? [], expected);
  assert.ok(Buffer.byteLength(JSON.stringify(input.priorContext ?? [])) <= 8 * 1024);
  assert.deepEqual(decodeComputerHistorySummaryInput(input), input);
  for (const [index, source] of old.entries()) {
    const item = input.priorContext?.find(({ id }) => id === source.id);
    if (item) assert.ok(item.text.includes(`TASK_${index}_TAIL keeps its distinct decision.`));
  }
  if (recent.length && scenario !== 'text-off') {
    assert.match(input.priorContext!.at(-1)!.text, /RECENT_10_STATE is still pending/);
  }
  const saved = (await summaries.get(`10min-${start}`))!;
  assert.deepEqual(saved.generation!.priorContextIds, expected);
  if (scenario === 'near-budget') {
    const bytes = Buffer.byteLength(JSON.stringify(input.priorContext));
    assert.ok(bytes >= 7800, `exercise three-source provenance near 8 KiB, received ${bytes} bytes`);
    assert.deepEqual(saved.generation!.rawEvidenceRanges, [
      [BASE, BASE + TEN_MINUTES],
      [BASE + SIX_HOURS, BASE + SIX_HOURS + TEN_MINUTES],
      [start - TEN_MINUTES, start + TEN_MINUTES],
    ]);
    await summaries.close();
    const reopened = new ComputerHistorySummaries({
      home, now: () => start + TEN_MINUTES,
      generate: async () => assert.fail('near-budget pinned context must not regenerate on restart'),
    });
    t.after(() => reopened.close());
    await reopened.run([{ ...event(start + MINUTE), content: 'ProjectQuartz E_CONNRESET: resume TASK_0.' }],
      { includeText: true, scopeKey: 'allowed' });
    assert.deepEqual(await reopened.get(saved.id), saved);
  }
  if (['three-ties', 'overlap', 'escaped-overflow', 'text-off'].includes(scenario)) {
    assert.ok(saved.generation!.rawEvidenceRanges!.every(([from]) => from > BASE + SIX_HOURS * 3),
      'unexposed alternatives must not become phantom dependencies');
  }
});

for (const removed of [0, 1, 2]) test(`shortlist pins every exposure through restart and deletion: source ${removed}`, async (t) => {
  const home = await fixture(t);
  const start = BASE + DAY + 3 * 60 * MINUTE;
  let now = start + TEN_MINUTES;
  const { suggestion: _suggestion, ...plain } = CONTENT;
  const old = [];
  for (let index = 0; index < 2; index++) old.push(await seedContextSummary(home, BASE + index * SIX_HOURS, '6h', {
    ...plain, keywords: ['ProjectQuartz', 'E_CONNRESET'],
    body: `ProjectQuartz E_CONNRESET: ${index === 0 ? 'SMALLER_BATCH upload' : 'RECONNECT_SOCKET stream'}.`,
  }));
  const recent = await seedContextSummary(home, start - TEN_MINUTES, '10min', plain);
  const unusedRecent = await seedContextSummary(home, start - 2 * TEN_MINUTES, '10min', plain);
  const exposed = [...old, recent];
  const inputs: ComputerHistorySummaryInput[] = [];
  const create = () => new ComputerHistorySummaries({
    home, now: () => now, generate: async (input) => {
      inputs.push(input);
      // The deterministic consumer uses only the upload alternative. This does
      // not make the other offered task cease to be a deletion dependency.
      return { ...plain, body: 'The upload still needs SMALLER_BATCH.' };
    },
  });
  const events = [{ ...event(start + MINUTE), content: 'ProjectQuartz E_CONNRESET: upload retry.' }];
  const summaries = create();
  await summaries.run(events, { includeText: true, scopeKey: 'allowed' });
  const saved = (await summaries.get(`10min-${start}`))!;
  assert.deepEqual(saved.generation!.priorContextIds, exposed.map(({ id }) => id));
  assert.doesNotMatch(saved.content.body, /RECONNECT_SOCKET/);
  await summaries.close();
  const reopened = create();
  t.after(() => reopened.close());
  await reopened.run(events, { includeText: true, scopeKey: 'allowed' });
  assert.equal(inputs.length, 1, 'all three stored IDs must resolve to the same generation after restart');
  assert.deepEqual(await reopened.get(saved.id), saved);
  await seedContextSummary(home, BASE - SIX_HOURS, '6h', old[0]!.content);
  await reopened.run(events, { includeText: true, scopeKey: 'allowed' });
  assert.equal(inputs.length, 1, 'archive arrival does not replace a pinned shortlist or make a new call');
  now += TEN_MINUTES;
  await reopened.run([{ ...event(start + TEN_MINUTES + MINUTE), content: 'Checking the upload outcome.' }],
    { includeText: true, scopeKey: 'allowed' });
  const descendant = (await reopened.get(`10min-${start + TEN_MINUTES}`))!;
  for (const source of exposed) assert.ok(descendant.generation!.rawEvidenceRanges!.some(([from, to]) =>
    from <= Date.parse(source.start) && to >= Date.parse(source.start) + TEN_MINUTES));
  const source = exposed[removed]!;
  await rm(join(home, 'summaries', `${source.id}.md`));
  now = start + 3 * DAY;
  await reopened.clearInterval(Date.parse(source.start) + MINUTE, Date.parse(source.start) + MINUTE);
  assert.equal(await reopened.get(saved.id), null);
  assert.equal(await reopened.get(descendant.id), null);
  assert.ok(await reopened.get(unusedRecent.id), 'unrelated recent context survives transitive deletion');
});

test('older context pins saved choices across archive arrivals and restart, then preserves immutable deletion coverage', async (t) => {
  const home = await fixture(t);
  const start = BASE + DAY + 3 * 60 * MINUTE;
  let now = start + TEN_MINUTES;
  const { suggestion: _suggestion, ...plain } = CONTENT;
  const query = 'ProjectQuartz E_CONNRESET';
  const recent = [];
  for (const minutes of [20, 10]) recent.push(await seedContextSummary(home, start - minutes * MINUTE, '10min', plain));
  const events = [{ ...event(start + MINUTE), content: query }];
  const inputs: ComputerHistorySummaryInput[] = [];
  const create = () => new ComputerHistorySummaries({
    home, now: () => now, generate: async (input) => { inputs.push(input); return plain; },
  });
  const summaries = create();
  await summaries.run(events, { includeText: true, scopeKey: 'allowed' });
  const original = (await summaries.get(`10min-${start}`))!;
  const old = await seedContextSummary(home, BASE, '6h', {
    ...plain, keywords: ['ProjectQuartz', 'E_CONNRESET'], body: `${query}: historic diagnosis.`,
  });
  await summaries.run(events, { includeText: true, scopeKey: 'allowed' });
  assert.equal(inputs.length, 1, 'archive arrival must not regenerate an unchanged saved leaf');
  assert.deepEqual(await summaries.get(original.id), original);
  await summaries.close();
  const reopened = create();
  t.after(() => reopened.close());
  await reopened.run(events, { includeText: true, scopeKey: 'allowed' });
  assert.equal(inputs.length, 1);
  events.push({ ...event(start + 2 * MINUTE), content: `${query}: another retry was observed.` });
  await reopened.run(events, { includeText: true, scopeKey: 'allowed' });
  assert.equal(inputs.length, 2, 'changed current evidence may select older relevant context');
  const updated = (await reopened.get(original.id))!;
  assert.deepEqual(updated.generation!.priorContextIds, [old.id, recent[1]!.id]);
  assert.equal(updated.generation!.version, original.generation!.version);
  const coverage = updated.generation!.rawEvidenceRanges!;
  assert.ok(coverage.some(([from, to]) => from <= BASE && to >= BASE + TEN_MINUTES));
  await seedContextSummary(home, BASE - SIX_HOURS, '6h', old.content);
  await reopened.run(events, { includeText: true, scopeKey: 'allowed' });
  assert.equal(inputs.length, 2, 'a later tied candidate must not displace pinned evidence');
  assert.deepEqual(await reopened.get(updated.id), updated);
  now += TEN_MINUTES;
  await reopened.run([{ ...event(start + TEN_MINUTES + MINUTE), content: query }], { includeText: true, scopeKey: 'allowed' });
  const descendant = (await reopened.get(`10min-${start + TEN_MINUTES}`))!;
  assert.ok(descendant.generation!.rawEvidenceRanges!.some(([from, to]) => from <= BASE && to >= BASE + TEN_MINUTES));
  await rm(join(home, 'summaries', `${old.id}.md`));
  now = start + 3 * DAY;
  await reopened.clearInterval(BASE + MINUTE, BASE + MINUTE);
  assert.equal(await reopened.get(updated.id), null);
  assert.equal(await reopened.get(descendant.id), null);
  for (const item of recent) assert.ok(await reopened.get(item.id), 'unrelated recent context must survive deletion');
});

test('older context indexes a 48-hour catch-up without rescanning archive bodies per window', async (t) => {
  const home = await fixture(t);
  const { suggestion: _suggestion, ...plain } = CONTENT;
  const query = 'ProjectQuartz E_CONNRESET';
  const events = Array.from({ length: 288 }, (_, index) => ({
    ...event(BASE + index * TEN_MINUTES + MINUTE), content: query,
  }));
  let calls = 0;
  let lastInput: ComputerHistorySummaryInput | undefined;
  const summaries = new ComputerHistorySummaries({
    home, now: () => BASE + 2 * DAY,
    generate: async (input) => { calls++; lastInput = input; return plain; },
  });
  t.after(() => summaries.close());
  for (let run = 0; run < 50; run++) await summaries.run(events, { includeText: true, scopeKey: 'allowed' });
  assert.equal((await summaries.list()).filter(({ level }) => level === '10min').length, 288);
  assert.equal(calls, 296, '288 leaves and eight rollups, without archive-driven regeneration');
  const bodies = new Set<string>();
  for (let index = 0; index < 64; index++) {
    const body = `${'Archived details.\n'.repeat(2700)}${index ? `UnrelatedProject${index} E_OTHER` : query}: TAIL_DECISION`;
    bodies.add(body);
    await seedContextSummary(home, BASE - (index + 2) * SIX_HOURS, '6h', {
      ...plain, keywords: index ? [`UnrelatedProject${index}`, 'E_OTHER'] : ['ProjectQuartz', 'E_CONNRESET'], body,
    });
  }
  const originalExec = RegExp.prototype.exec;
  const inspected: string[] = [];
  RegExp.prototype.exec = function (text: string) {
    if (bodies.has(text)) inspected.push(text);
    return originalExec.call(this, text);
  };
  t.after(() => { RegExp.prototype.exec = originalExec; });
  await summaries.run(events, { includeText: true, scopeKey: 'allowed' });
  assert.equal(calls, 296);
  assert.equal(inspected.length, 0, 'unchanged pinned generations do not inspect candidate bodies');
  const changed = [...events, ...Array.from({ length: 6 }, (_, index) => ({
    ...event(BASE + index * TEN_MINUTES + 2 * MINUTE), content: `${query}: another retry.`,
  }))];
  await summaries.run(changed, { includeText: true, scopeKey: 'allowed' });
  assert.equal(calls, 302);
  assert.equal(new Set(inspected).size, 1, 'unmatched archives are not inspected');
  assert.equal(inspected.length, 2, 'two anchors inspect the matched body once per run, not once per window');
  assert.match(lastInput!.priorContext!.find(({ id }) => id === `6h-${BASE - 2 * SIX_HOURS}`)!.text,
    /ProjectQuartz E_CONNRESET: TAIL_DECISION/);
});

test('closed UTC windows use allowlisted evidence and survive restart without regeneration', async (t) => {
  const home = await fixture(t);
  const inputs: ComputerHistorySummaryInput[] = [];
  const privateEvent = {
    ...event(BASE + MINUTE),
    keyboard: { text: 'keyboard-secret' },
    ax: { value: 'ax-secret' },
    path: '/private/raw-secret.jsonl',
    app: { ...event(BASE).app, executablePath: '/private/executable-secret' },
    window: { title: 'Implementation', privateExtra: 'private-secret.example' },
  };
  const summaries = new ComputerHistorySummaries({
    home,
    now: () => BASE + 21 * MINUTE,
    generate: async (input) => {
      inputs.push(input);
      return CONTENT;
    },
  });
  await summaries.run([
    event(BASE + 11 * MINUTE),
    privateEvent,
    event(BASE + 20 * MINUTE),
    event(BASE + 30 * MINUTE),
    event(BASE - 49 * 60 * MINUTE),
    { ...event(BASE), timestamp: 'invalid' },
  ]);
  assert.equal(inputs.length, 2);
  assert.equal(inputs[0]!.start, new Date(BASE).toISOString());
  assert.equal(inputs[0]!.end, new Date(BASE + TEN_MINUTES).toISOString());
  assert.deepEqual(JSON.parse(inputs[0]!.evidence[0]!.text), event(BASE + MINUTE));
  assert.doesNotMatch(JSON.stringify(inputs), /secret|keyboard|executablePath|urlDomain/);
  const stored = await summaries.list();
  assert.equal(stored.length, 2);
  assert.deepEqual(stored[0]!.sourceIds, inputs[0]!.evidence.map(({ id }) => id));
  assert.deepEqual(stored[0]!.applications, ['com.example.editor']);
  assert.equal(stored[0]!.eventCount, 1);
  assert.deepEqual(stored[0]!.content, CONTENT);
  assert.deepEqual(Object.keys(stored[0]!).sort(), [
    'applications',
    'content',
    'documentRevision',
    'end',
    'eventCount',
    'filename',
    'generation',
    'id',
    'level',
    'sourceIds',
    'start',
  ]);
  const markdown = await readFile(join(home, 'summaries', stored[0]!.filename!), 'utf8');
  assert.equal(serializeComputerHistorySummary(stored[0]!), markdown);
  assert.equal(JSON.parse(markdown.split('\n')[1]!).id, stored[0]!.id);
  assert.ok(markdown.endsWith(`${CONTENT.body}\n`));
  assert.doesNotMatch(markdown, /secret/);
  assert.doesNotMatch(markdown, /documentRevision/);
  assert.doesNotMatch(JSON.stringify(inputs), /documentRevision/);

  const restarted = new ComputerHistorySummaries({
    home,
    now: () => BASE + 21 * MINUTE,
    generate: async () => assert.fail('persisted windows must not regenerate'),
  });
  await restarted.run([privateEvent, event(BASE + 11 * MINUTE)]);
  assert.deepEqual(await restarted.list(), stored);
});

test('application provenance prefers native bundle IDs and preserves name-only fallbacks through rollup', async (t) => {
  const home = await fixture(t);
  const summaries = new ComputerHistorySummaries({
    home, now: () => BASE + SIX_HOURS, generate: async () => CONTENT,
  });
  await summaries.run([
    { ...event(BASE + MINUTE), app: { name: 'Google Chrome', bundleIdentifier: 'com.google.Chrome' } },
    { ...event(BASE + 2 * MINUTE), app: { name: 'Name-only application' } },
    { ...event(BASE + 3 * MINUTE), app: { bundleIdentifier: 'com.apple.Terminal' } },
  ]);
  const stored = await summaries.list();
  assert.deepEqual(stored.map(({ level }) => level).sort(), ['10min', '6h']);
  for (const summary of stored) {
    assert.deepEqual(summary.applications, [
      'Name-only application', 'com.apple.Terminal', 'com.google.Chrome',
    ]);
    assert.equal(
      serializeComputerHistorySummary(summary),
      await readFile(join(home, 'summaries', summary.filename!), 'utf8'),
    );
  }
});

test('long packaged application IDs remain exact through evidence, rollup and restart', async (t) => {
  const home = await fixture(t);
  const prefix = `winapp.${'A'.repeat(50)}_123456789abcd!${'B'.repeat(63)}`;
  const applications = [`${prefix}C`, `${prefix}D`];
  assert.equal(applications[0]!.length, 136);
  assert.equal(applications[0]!.slice(0, 128), applications[1]!.slice(0, 128));
  const events = applications.map((bundleIdentifier, index) => ({
    ...event(BASE + (index + 1) * MINUTE),
    app: { name: 'Shared packaged executable', bundleIdentifier },
  }));
  const inputs: ComputerHistorySummaryInput[] = [];
  const summaries = new ComputerHistorySummaries({
    home, now: () => BASE + SIX_HOURS,
    generate: async (input) => { inputs.push(input); return CONTENT; },
  });
  t.after(() => summaries.close());
  await summaries.run(events);
  const leaf = inputs.find((input) => input.level === '10min')!;
  assert.deepEqual(leaf.evidence.map((sample) => JSON.parse(sample.text).app.bundleIdentifier).sort(), applications);
  const stored = await summaries.list();
  assert.deepEqual(stored.map(({ level }) => level).sort(), ['10min', '6h']);
  for (const summary of stored) assert.deepEqual(summary.applications, applications);
  await summaries.close();
  const reopened = new ComputerHistorySummaries({
    home, now: () => BASE + SIX_HOURS,
    generate: async () => assert.fail('exact persisted application identities must not regenerate'),
  });
  t.after(() => reopened.close());
  await reopened.run(events);
  assert.deepEqual(await reopened.list(), stored);
});

test('readable filenames and keywords survive title changes, restart, reveal and interval deletion', async (t) => {
  const home = await fixture(t);
  let title = 'Maka / \u7535\u8111\u5386\u53f2: permission <review>';
  const keywords = ['Maka', 'Computer History', '\u6743\u9650\u7ba1\u7406'];
  const inputs: ComputerHistorySummaryInput[] = [];
  const create = () => new ComputerHistorySummaries({
    home, now: () => BASE + SIX_HOURS,
    generate: async (input) => {
      inputs.push(input);
      return { ...CONTENT, title, keywords };
    },
  });
  const summaries = create();
  const events = [event(BASE + MINUTE)];
  await summaries.run(events);
  const first = (await summaries.get(`10min-${BASE}`))!;
  assert.match(first.filename!, /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}__10min__Maka-\u7535\u8111\u5386\u53f2-permission-review\.md$/u);
  assert.deepEqual(first.content.keywords, keywords);
  assert.match(inputs.find(({ level }) => level === '6h')!.evidence[0]!.text, /Keywords: Maka, Computer History/);
  title = 'Changed task title';
  events.push(event(BASE + 2 * MINUTE));
  await summaries.run(events);
  const updated = (await create().get(first.id))!;
  assert.equal(updated.filename, first.filename);
  assert.equal(updated.content.title, title);
  assert.notEqual(updated.documentRevision, first.documentRevision);
  const shown: string[] = [];
  await create().reveal(first.id, (path) => { shown.push(path); });
  assert.deepEqual(shown, [join(home, 'summaries', first.filename!)]);
  const markdown = await readFile(shown[0]!, 'utf8');
  assert.deepEqual(JSON.parse(markdown.split('\n')[1]!).content.keywords, keywords);
  await create().clearInterval(BASE + MINUTE, BASE + MINUTE);
  assert.deepEqual(await readdir(join(home, 'summaries')), []);
});

test('legacy ID-named documents stay readable and keep their names on regeneration', async (t) => {
  const home = await fixture(t);
  const directory = join(home, 'summaries');
  await mkdir(directory);
  const id = `10min-${BASE}`;
  const source = event(BASE + MINUTE);
  await writeFile(join(directory, `${id}.md`), serializeComputerHistorySummary({
    id, level: '10min', start: new Date(BASE).toISOString(),
    end: new Date(BASE + TEN_MINUTES).toISOString(),
    applications: ['com.example.editor'], eventCount: 1,
    sourceIds: [summaryEventId(source)!], content: CONTENT,
  }));
  const summaries = new ComputerHistorySummaries({
    home, now: () => BASE + TEN_MINUTES,
    generate: async () => ({ ...CONTENT, keywords: ['Maka'] }),
  });
  assert.equal((await summaries.get(id))!.filename, undefined);
  assert.equal((await summaries.get(id))!.content.keywords, undefined);
  await summaries.run([source]);
  assert.equal((await summaries.get(id))!.filename, undefined);
  assert.deepEqual((await summaries.get(id))!.content.keywords, ['Maka']);
  assert.deepEqual(await readdir(directory), [`${id}.md`]);
  const shown: string[] = [];
  await summaries.reveal(id, (path) => { shown.push(path); });
  assert.deepEqual(shown, [join(directory, `${id}.md`)]);
});

test('local clock collisions cannot overwrite a different summary and filenames remain bounded', async (t) => {
  const home = await fixture(t);
  const before = process.env.TZ;
  process.env.TZ = 'America/New_York';
  t.after(() => {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  });
  const start = Date.parse('2025-11-02T05:00:00.000Z');
  const summaries = new ComputerHistorySummaries({
    home, now: () => start + 2 * 60 * MINUTE,
    generate: async () => ({ ...CONTENT, title: '\u5386\u53f2'.repeat(80) }),
  });
  await summaries.run([event(start + MINUTE), event(start + 61 * MINUTE)]);
  const leaves = (await summaries.list()).filter(({ level }) => level === '10min');
  assert.equal(leaves.length, 2);
  assert.ok(leaves.every(({ filename }) => filename!.startsWith('2025-11-02_01-00__10min__')));
  assert.notEqual(leaves[0]!.filename, leaves[1]!.filename);
  assert.ok(leaves.every(({ filename }) => Buffer.byteLength(filename!) <= 200));
  const names = leaves.map(({ filename }) => filename);
  process.env.TZ = 'Asia/Shanghai';
  const reopened = new ComputerHistorySummaries({
    home, now: () => start + 2 * 60 * MINUTE,
    generate: async () => assert.fail('a local timezone change must not regenerate documents'),
  });
  await reopened.run([event(start + MINUTE), event(start + 61 * MINUTE)]);
  assert.deepEqual((await reopened.list()).filter(({ level }) => level === '10min').map(({ filename }) => filename), names);
  for (const leaf of leaves) assert.equal((await reopened.get(leaf.id))!.filename, leaf.filename);
});

test('bounded catch-up is oldest first, creates full 6h rollups only after all known children', async (t) => {
  const home = await fixture(t);
  const inputs: ComputerHistorySummaryInput[] = [];
  const summaries = new ComputerHistorySummaries({
    home,
    now: () => BASE + SIX_HOURS,
    generate: async (input) => {
      inputs.push(input);
      return CONTENT;
    },
  });
  const events = Array.from({ length: 36 }, (_, i) => event(BASE + i * TEN_MINUTES + MINUTE));
  for (let run = 0; run < 6; run++) {
    await summaries.run([...events].reverse());
    assert.equal(inputs.length, (run + 1) * 6);
    assert.ok(inputs.every(({ level }) => level === '10min'));
  }
  assert.deepEqual(
    inputs.map(({ start }) => start),
    events.map((_, i) => new Date(BASE + i * TEN_MINUTES).toISOString()),
  );
  await summaries.run(events);
  const rollup = (await summaries.list()).find(({ level }) => level === '6h')!;
  assert.equal(rollup.start, new Date(BASE).toISOString());
  assert.equal(rollup.end, new Date(BASE + SIX_HOURS).toISOString());
  assert.equal(rollup.eventCount, 36);
  assert.equal(rollup.sourceIds.length, 36);
  assert.deepEqual(inputs.at(-1)!.evidence.map(({ id }) => id), rollup.sourceIds);
  assert.ok(inputs.at(-1)!.evidence.every(({ text }) => text.includes(CONTENT.title)));
  await summaries.run(events);
  assert.equal(inputs.length, 37);
});

test('partial closed 6h groups roll up existing children, including after the raw horizon', async (t) => {
  const home = await fixture(t);
  let now = BASE + 20 * MINUTE;
  const inputs: ComputerHistorySummaryInput[] = [];
  const summaries = new ComputerHistorySummaries({
    home,
    now: () => now,
    generate: async (input) => {
      inputs.push(input);
      return CONTENT;
    },
  });
  await summaries.run([event(BASE + MINUTE)]);
  assert.equal(inputs.length, 1);
  now = BASE + 72 * 60 * MINUTE;
  await summaries.run([]);
  assert.equal(inputs.length, 2);
  assert.equal(inputs[1]!.level, '6h');
  assert.equal(inputs[1]!.evidence.length, 1);
  await summaries.run([]);
  assert.equal(inputs.length, 2);
});

test('a late new child refreshes a partial rollup without duplicating its identity', async (t) => {
  const home = await fixture(t);
  const summaries = new ComputerHistorySummaries({
    home,
    now: () => BASE + SIX_HOURS,
    generate: async () => CONTENT,
  });
  await summaries.run([event(BASE + MINUTE)]);
  const original = (await summaries.list()).find(({ level }) => level === '6h')!;
  await summaries.run([event(BASE + MINUTE), event(BASE + 21 * MINUTE)]);
  const rollups = (await summaries.list()).filter(({ level }) => level === '6h');
  assert.equal(rollups.length, 1);
  assert.equal(rollups[0]!.id, original.id);
  assert.equal(rollups[0]!.sourceIds.length, 2);
  assert.equal(rollups[0]!.eventCount, 2);
});

test('late evidence refreshes the existing leaf and rollup without changing their identities', async (t) => {
  const home = await fixture(t);
  const inputs: ComputerHistorySummaryInput[] = [];
  const summaries = new ComputerHistorySummaries({
    home, now: () => BASE + SIX_HOURS,
    generate: async (input) => {
      inputs.push(input);
      return { ...CONTENT, body: input.evidence.map(({ text }) => text).join('\n') };
    },
  });
  const first = event(BASE + MINUTE);
  await summaries.run([first]);
  const original = await summaries.list();
  const appended = [first, event(BASE + 2 * MINUTE, 'Late evidence')];
  await summaries.run(appended);
  const updated = await summaries.list();
  assert.deepEqual(updated.map(({ id }) => id), original.map(({ id }) => id));
  assert.deepEqual(updated.map(({ eventCount }) => eventCount), [2, 2]);
  assert.ok(updated.every(({ content }) => content.body.includes('Late evidence')));

  const replaced = [first, event(BASE + 2 * MINUTE, 'Corrected evidence')];
  await summaries.run(replaced);
  const corrected = await summaries.list();
  assert.deepEqual(corrected.map(({ eventCount }) => eventCount), [2, 2]);
  assert.ok(corrected.every(({ content }) => content.body.includes('Corrected evidence')));
  assert.ok(corrected.every(({ content }) => !content.body.includes('Late evidence')));
  assert.deepEqual(inputs.map(({ level }) => level), ['10min', '6h', '10min', '6h', '10min', '6h']);
  const reopened = new ComputerHistorySummaries({
    home, now: () => BASE + SIX_HOURS,
    generate: async () => assert.fail('unchanged evidence must not regenerate after restart'),
  });
  await reopened.run([...replaced].reverse());
  assert.deepEqual(await reopened.list(), corrected);
});

test('duplicate metadata increments counts without dominating the sample', async (t) => {
  const home = await fixture(t);
  const inputs: ComputerHistorySummaryInput[] = [];
  const summaries = new ComputerHistorySummaries({
    home, now: () => BASE + SIX_HOURS,
    generate: async (input) => { inputs.push(input); return CONTENT; },
  });
  const events = Array.from({ length: 1_000 }, (_, index) => event(BASE + index));
  await summaries.run(events);
  const original = (await summaries.list()).find(({ level }) => level === '10min')!;
  await summaries.run([...events, events[500]!]);
  const updated = await summaries.list();
  assert.deepEqual(updated.find(({ level }) => level === '10min')!.sourceIds, original.sourceIds);
  assert.equal(original.sourceIds.length, 2);
  assert.deepEqual(updated.map(({ eventCount }) => eventCount), [1_001, 1_001]);
  assert.match(inputs[2]!.evidence.at(-1)!.text, /Evidence sample: 2 of 1001 events/);
  assert.equal(inputs.length, 4);
});

test('streamed evidence covers late sources, endpoints and gated self-contained text deterministically', async (t) => {
  const home = await fixture(t);
  const inputs: ComputerHistorySummaryInput[] = [];
  const events: ComputerHistorySummaryEvent[] = [
    ...Array.from({ length: 1_000 }, (_, index) => event(BASE + index)),
    { ...event(BASE + 5 * MINUTE, 'Research'), sourceKey: 'opaque-research', content: '完整页面\nSELF_CONTAINED_AX' },
    { ...event(BASE + 9 * MINUTE, 'Planning'), content: 'LATE_TASK', window: { title: 'Planning', urlDomain: 'example.test' } },
    event(BASE + TEN_MINUTES - 1, 'Finished observation'),
  ];
  const summaries = new ComputerHistorySummaries({
    home, now: () => BASE + TEN_MINUTES,
    generate: async (input) => { inputs.push(input); return CONTENT; },
  });
  async function* stream(reverse = false) {
    for (const item of reverse ? [...events].reverse() : events) yield item;
  }
  await summaries.run(stream(), { includeText: true, locale: 'zh-CN', scopeKey: 'scope-a' });
  const input = inputs[0]!;
  assert.equal(input.locale, 'zh-CN');
  assert.equal(input.evidence[0]!.id, summaryEventId(events[0]!));
  assert.equal(input.evidence.at(-1)!.id, summaryEventId(events.at(-1)!));
  assert.match(JSON.stringify(input), /SELF_CONTAINED_AX|LATE_TASK/);
  assert.ok(input.evidence.some(({ text }) => text.includes('SELF_CONTAINED_AX')));
  assert.ok(input.evidence.some(({ text }) => text.includes('LATE_TASK')));
  assert.match(JSON.stringify(input), /example.test/);
  assert.doesNotMatch(JSON.stringify(input), /opaque-research/);
  const saved = (await summaries.list())[0]!;
  assert.equal(saved.eventCount, events.length);
  assert.equal(saved.generation!.includesText, true);
  assert.deepEqual(saved.sourceIds, input.evidence.map(({ id }) => id));
  assert.equal(input.evidence.find(({ text }) => text.includes('SELF_CONTAINED_AX'))!.id,
    summaryEventId(events[1_000]!, { includeText: true }));
  await summaries.run(stream(true), { includeText: true, locale: 'zh-CN', scopeKey: 'scope-a' });
  assert.equal(inputs.length, 1);
  await summaries.clear(-Infinity);
  await summaries.run(stream(true), { includeText: true, locale: 'zh-CN', scopeKey: 'scope-a' });
  assert.deepEqual(inputs[1], input);
});

test('one opaque source retains intermediate title and domain transitions between repeated endpoints', async (t) => {
  const home = await fixture(t);
  const inputs: ComputerHistorySummaryInput[] = [];
  const summaries = new ComputerHistorySummaries({
    home, now: () => BASE + TEN_MINUTES,
    generate: async (input) => { inputs.push(input); return CONTENT; },
  });
  const events = [
    { ...event(BASE + MINUTE), sourceKey: 'same-window', window: { title: 'Review', urlDomain: 'editor.test' } },
    { ...event(BASE + 3 * MINUTE), sourceKey: 'same-window', window: { title: 'Research', urlDomain: 'editor.test' } },
    { ...event(BASE + 6 * MINUTE), sourceKey: 'same-window', window: { title: 'Research', urlDomain: 'docs.test' } },
    { ...event(BASE + 9 * MINUTE), sourceKey: 'same-window', window: { title: 'Review', urlDomain: 'editor.test' } },
  ];
  await summaries.run(events);
  assert.deepEqual(inputs[0]!.evidence.map(({ text }) => JSON.parse(text).window), events.map(({ window }) => window));
  assert.deepEqual(inputs[0]!.evidence.map(({ id }) => id), events.map((item) => summaryEventId(item)));
});

test('full permitted tails and short intermediate changes survive one shared evidence budget', async (t) => {
  const home = await fixture(t);
  const inputs: ComputerHistorySummaryInput[] = [];
  const summaries = new ComputerHistorySummaries({
    home, now: () => BASE + TEN_MINUTES,
    generate: async (input) => { inputs.push(input); return CONTENT; },
  });
  const document = 'Visible document.\n' + 'paragraph '.repeat(790) + 'FINAL_DECISION';
  const utf8 = '\u4e2d\u6587 \ud83d\ude80\n"\\'.repeat(650) + 'MULTILINGUAL_FINAL';
  const events = [
    { ...event(BASE + 1_000), content: document, sourceKey: 'reader' },
    { ...event(BASE + 2_000), content: 'BRIEF_INTERMEDIATE_DECISION', sourceKey: 'reader' },
    { ...event(BASE + 3_000), content: document, sourceKey: 'reader' },
    { ...event(BASE + 4_000, 'Multilingual source'), content: utf8 },
  ];
  await summaries.run(events, { includeText: true });
  const evidence = inputs[0]!.evidence;
  assert.ok(evidence.some(({ text }) => text.includes(document)));
  assert.ok(evidence.some(({ text }) => text.includes('BRIEF_INTERMEDIATE_DECISION')));
  assert.ok(evidence.some(({ text }) => text.includes(utf8)));
  assert.doesNotMatch(JSON.stringify(evidence), /\[truncated\]|\ufffd/);
  assert.ok(Buffer.byteLength(JSON.stringify(evidence)) <= 224 * 1024);
  await summaries.clear(-Infinity);
  await summaries.run([...events].reverse(), { includeText: true });
  assert.deepEqual(inputs[1], inputs[0]);
  await summaries.clear(-Infinity);
  await summaries.run(events);
  assert.doesNotMatch(JSON.stringify(inputs[2]), /FINAL_DECISION|MULTILINGUAL_FINAL|BRIEF_INTERMEDIATE_DECISION|Observed content/);
  assert.equal((await summaries.list())[0]!.generation!.includesText, false);
});

test('bounded content pool preserves endpoints and brief middle evidence under escaped UTF-8 pressure', async (t) => {
  const home = await fixture(t);
  const inputs: ComputerHistorySummaryInput[] = [];
  const summaries = new ComputerHistorySummaries({
    home, now: () => BASE + TEN_MINUTES,
    generate: async (input) => { inputs.push(input); return CONTENT; },
  });
  const events = Array.from({ length: 600 }, (_, index) => ({
    ...event(BASE + index * 1_000),
    sourceKey: 'same-source',
    content: index === 311 ? 'BRIEF_MIDDLE_OUTCOME' :
      `START_${index}\n${'\u4e2d\ud83d\ude80\n"\\'.repeat(2_000)}\nTAIL_${index}`,
  }));
  await summaries.run(events, { includeText: true });
  const evidence = inputs[0]!.evidence;
  assert.ok(evidence.length <= 256);
  assert.equal(evidence[0]!.id, summaryEventId(events[0]!, { includeText: true }));
  assert.equal(evidence.at(-1)!.id, summaryEventId(events.at(-1)!, { includeText: true }));
  assert.ok(evidence.some(({ text }) => text.includes('BRIEF_MIDDLE_OUTCOME')));
  assert.ok(Buffer.byteLength(JSON.stringify(evidence)) <= 224 * 1024);
  assert.ok(evidence.every(({ text }) => Buffer.byteLength(text) <= 32 * 1024));
  assert.doesNotMatch(JSON.stringify(evidence), /\ufffd/);
  assert.equal((await summaries.list())[0]!.eventCount, 600);
  await summaries.clear(-Infinity);
  await summaries.run([...events].reverse(), { includeText: true });
  assert.deepEqual(inputs[1]!.evidence, evidence);
});

test('48-hour streaming input keeps rich evidence bounded in every closed window', async (t) => {
  const home = await fixture(t);
  const inputs: ComputerHistorySummaryInput[] = [];
  const summaries = new ComputerHistorySummaries({
    home, now: () => BASE + 48 * 60 * MINUTE,
    generate: async (input) => { inputs.push(input); return CONTENT; },
  });
  async function* stream() {
    for (let window = -1; window <= 288; window++) {
      for (let index = 0; index < 40; index++) {
        yield {
          ...event(BASE + window * TEN_MINUTES + index * 1_000, `Window ${window}`),
          content: index === 20 ? `BRIEF_WINDOW_${window}` :
            `Window ${window} content ${index}\n${'rich content '.repeat(800)}\nWINDOW_TAIL_${window}`,
        };
      }
    }
  }
  await summaries.run(stream(), { includeText: true });
  assert.equal(inputs.length, 6);
  assert.deepEqual(inputs.map(({ start }) => start),
    Array.from({ length: 6 }, (_, index) => new Date(BASE + index * TEN_MINUTES).toISOString()));
  for (const [index, input] of inputs.entries()) {
    assert.ok(input.evidence.length <= 256);
    assert.ok(Buffer.byteLength(JSON.stringify(input.evidence)) <= 224 * 1024);
    assert.ok(input.evidence.every(({ text }) => Buffer.byteLength(text) <= 32 * 1024));
    assert.ok(input.evidence.some(({ text }) => text.includes(`BRIEF_WINDOW_${index}`)));
  }
  assert.deepEqual((await summaries.list()).map(({ eventCount }) => eventCount), Array(6).fill(40));
});

test('stream scanning is bounded for large text, accounts for unsampled revisions and closes on cancellation', async (t) => {
  const home = await fixture(t);
  const inputs: ComputerHistorySummaryInput[] = [];
  const summaries = new ComputerHistorySummaries({
    home, now: () => BASE + TEN_MINUTES,
    generate: async (input) => { inputs.push(input); return CONTENT; },
  });
  async function* large(changed = false) {
    for (let index = 0; index < 2_000; index++) {
      yield { ...event(BASE + index), content: '中\n"'.repeat(8_000) + (changed && index === 1 ? 'revision' : '') };
    }
  }
  await summaries.run(large(), { includeText: true });
  const saved = (await summaries.list())[0]!;
  assert.equal(saved.eventCount, 2_000);
  assert.ok(inputs[0]!.evidence.length <= 256);
  assert.ok(Buffer.byteLength(JSON.stringify(inputs[0])) < 256 * 1024);
  assert.ok(inputs[0]!.evidence.every(({ text }) => Buffer.byteLength(text) <= 32 * 1024));
  await summaries.run(large(true), { includeText: true });
  assert.equal(inputs.length, 2);
  assert.notEqual((await summaries.list())[0]!.generation!.sourceRevision, saved.generation!.sourceRevision);
  let closed = false;
  const entered = deferred<void>();
  const release = deferred<void>();
  async function* held() {
    try {
      entered.resolve();
      await release.promise;
      yield event(BASE + MINUTE);
      assert.fail('cancelled scan must close its iterator');
    } finally { closed = true; }
  }
  const run = summaries.run(held());
  await entered.promise;
  const cancel = summaries.cancel();
  release.resolve();
  await Promise.all([run, cancel]);
  assert.equal(closed, true);
  assert.equal(inputs.length, 2);
});

test('a failed streaming scan makes no provider calls or partial writes and remains retryable', async (t) => {
  const home = await fixture(t);
  const inputs: ComputerHistorySummaryInput[] = [];
  const summaries = new ComputerHistorySummaries({
    home, now: () => BASE + SIX_HOURS,
    generate: async (input) => { inputs.push(input); return CONTENT; },
  });
  const original = event(BASE + MINUTE);
  await summaries.run([original]);
  const names = await readdir(join(home, 'summaries'));
  const bytes = await Promise.all(names.map((name) => readFile(join(home, 'summaries', name))));
  const calls = inputs.length;
  const late = { ...event(BASE + 2 * MINUTE), content: 'new eligible observation' };
  const next = event(BASE + 11 * MINUTE);
  const failure = new Error('raw record scan failed');
  let closed = false;
  async function* failed() {
    try {
      yield original;
      yield late;
      yield next;
      throw failure;
    } finally { closed = true; }
  }
  await assert.rejects(summaries.run(failed(), { includeText: true }), (error) => error === failure);
  assert.equal(closed, true);
  assert.equal(inputs.length, calls);
  assert.deepEqual(await readdir(join(home, 'summaries')), names);
  assert.deepEqual(
    await Promise.all(names.map((name) => readFile(join(home, 'summaries', name)))),
    bytes,
  );
  await summaries.run([original, late, next], { includeText: true });
  assert.equal(inputs.length, calls + 3);
  assert.equal((await summaries.get(`10min-${BASE}`))!.eventCount, 2);
});

test('text consent defaults off, preserves rich documents and excludes rich prior and rollup inputs', async (t) => {
  const home = await fixture(t);
  let now = BASE + TEN_MINUTES;
  const inputs: ComputerHistorySummaryInput[] = [];
  const summaries = new ComputerHistorySummaries({
    home, now: () => now,
    generate: async (input) => {
      inputs.push(input);
      return { ...CONTENT, body: JSON.stringify(input).includes('RICH_SECRET') ? 'RICH_SECRET' : 'metadata-only' };
    },
  });
  const rich = { ...event(BASE + MINUTE), content: 'RICH_SECRET', sourceKey: 'source-1' };
  await summaries.run([rich]);
  assert.doesNotMatch(JSON.stringify(inputs[0]), /RICH_SECRET/);
  assert.equal((await summaries.list())[0]!.generation!.includesText, false);
  assert.equal(inputs[0]!.evidence[0]!.id, summaryEventId(rich));
  assert.notEqual(summaryEventId(rich), summaryEventId(rich, { includeText: true }));
  assert.equal(summaryEventId(rich), summaryEventId({ ...rich, content: 'changed text' }));
  await summaries.run([rich], { includeText: true });
  assert.equal(inputs[1]!.evidence[0]!.id, summaryEventId(rich, { includeText: true }));
  const original = await summaries.get(`10min-${BASE}`);
  const path = join(home, 'summaries', original!.filename!);
  const bytes = await readFile(path);
  now = BASE + SIX_HOURS;
  await summaries.run([rich, event(BASE + 11 * MINUTE)]);
  assert.equal(inputs.length, 3);
  assert.equal(inputs[2]!.priorContext, undefined);
  assert.doesNotMatch(JSON.stringify(inputs[2]), /RICH_SECRET/);
  assert.equal((await summaries.list()).length, 2);
  assert.deepEqual(await summaries.get(`10min-${BASE}`), original);
  assert.deepEqual(await readFile(path), bytes);
  await summaries.run([rich, event(BASE + 11 * MINUTE)], { includeText: true });
  const rollup = (await summaries.list()).find(({ level }) => level === '6h')!;
  assert.equal(rollup.generation!.includesText, true);
  assert.ok(inputs.some(({ level, evidence }) => level === '6h' && JSON.stringify(evidence).includes('RICH_SECRET')));
});

test('text revocation preserves a rich rollup across late children and restart without resending it', async (t) => {
  const home = await fixture(t);
  let now = BASE + SIX_HOURS;
  const inputs: ComputerHistorySummaryInput[] = [];
  const create = () => new ComputerHistorySummaries({
    home, now: () => now,
    generate: async (input) => {
      inputs.push(input);
      return { ...CONTENT, body: JSON.stringify(input).includes('RICH_ARCHIVE') ? 'RICH_ARCHIVE' : 'metadata-only' };
    },
  });
  const summaries = create();
  const rich = { ...event(BASE + MINUTE), content: 'RICH_ARCHIVE' };
  await summaries.run([rich], { includeText: true, scopeKey: 'a' });
  const rollupId = `6h-${BASE}`;
  const path = join(home, 'summaries', (await summaries.get(rollupId))!.filename!);
  const bytes = await readFile(path);
  assert.equal((await summaries.get(rollupId))!.generation!.includesText, true);
  const late = event(BASE + 11 * MINUTE);
  await summaries.run([rich, late], { scopeKey: 'a' });
  assert.equal(inputs.length, 3);
  assert.deepEqual(await readFile(path), bytes);
  assert.doesNotMatch(JSON.stringify(inputs[2]), /RICH_ARCHIVE/);
  now = BASE + SIX_HOURS + TEN_MINUTES;
  const next = event(BASE + SIX_HOURS + MINUTE);
  const reopened = create();
  await reopened.run([rich, late, next], { scopeKey: 'a' });
  assert.equal(inputs.length, 4);
  assert.doesNotMatch(JSON.stringify(inputs.slice(2)), /RICH_ARCHIVE/);
  assert.ok(inputs.slice(2).every((input) => !input.priorContext?.some(({ id }) => id === rollupId)));
  assert.deepEqual(await readFile(path), bytes);
  await reopened.run([rich, late, next], { scopeKey: 'a' });
  assert.equal(inputs.length, 4);
  await reopened.run([rich, late, next], { includeText: true, scopeKey: 'a' });
  assert.equal((await reopened.get(rollupId))!.eventCount, 2);
  const calls = inputs.length;
  await reopened.run([rich, late, next], { includeText: true, scopeKey: 'a' });
  assert.equal(inputs.length, calls, 're-enabling consent rebuilds the archived parent and converges');
});

for (const includeText of [false, true]) test(`scope changes preserve a rich parent with text consent ${includeText} until compatible regeneration`, async (t) => {
  const home = await fixture(t);
  let now = BASE + SIX_HOURS;
  const inputs: ComputerHistorySummaryInput[] = [];
  const create = () => new ComputerHistorySummaries({
    home, now: () => now,
    generate: async (input) => {
      inputs.push(input);
      return {
        ...CONTENT,
        body: `${JSON.stringify(input).includes('OLD_SCOPE_CANARY') ? 'OLD_SCOPE_CANARY' : 'Current scope'} revision ${inputs.length}`,
      };
    },
  });
  const summaries = create();
  const rich = { ...event(BASE + MINUTE), content: 'OLD_SCOPE_CANARY' };
  await summaries.run([rich], { includeText: true, scopeKey: 'a' });
  const parentId = `6h-${BASE}`;
  const path = join(home, 'summaries', (await summaries.get(parentId))!.filename!);
  const saved = await summaries.get(parentId);
  const bytes = await readFile(path);
  const late = event(BASE + 11 * MINUTE);
  await summaries.run([late], { includeText, scopeKey: 'b' });
  assert.deepEqual(await summaries.get(parentId), saved);
  assert.deepEqual(await readFile(path), bytes);

  now += 2 * TEN_MINUTES;
  const next = [1, 11].map((minute) => event(BASE + SIX_HOURS + minute * MINUTE));
  const reopened = create();
  await reopened.run([late, ...next], { includeText, scopeKey: 'b' });
  assert.doesNotMatch(JSON.stringify(inputs.slice(2)), /OLD_SCOPE_CANARY/);
  assert.ok(inputs.slice(2).every((input) => !input.priorContext?.some(({ id }) => id === parentId)));
  assert.deepEqual(await reopened.get(parentId), saved);
  assert.deepEqual(await readFile(path), bytes);
  const beforeRestore = inputs.length;
  await reopened.run([late, ...next], { includeText, scopeKey: 'b' });
  assert.equal(inputs.length, beforeRestore);

  const events = [rich, late, ...next];
  await reopened.run(events, { includeText: true, scopeKey: 'a' });
  const parent = (await reopened.get(parentId))!;
  assert.equal(parent.eventCount, 2);
  assert.deepEqual(parent.sourceIds, [`10min-${BASE}`, `10min-${BASE + TEN_MINUTES}`]);
  const descendant = (await reopened.get(`10min-${BASE + SIX_HOURS}`))!;
  assert.deepEqual(descendant.generation!.priorContextIds, parent.sourceIds,
    'rebuilding the parent does not replace already admitted leaf dependencies');
  assert.match(descendant.content.body, /OLD_SCOPE_CANARY/);
  const afterRestore = inputs.length;
  await create().run([...events].reverse(), { includeText: true, scopeKey: 'a' });
  assert.equal(inputs.length, afterRestore, 'compatible parent and descendant refreshes converge across restart');

  now = BASE + 72 * 60 * MINUTE;
  await reopened.clearInterval(BASE + MINUTE, BASE + MINUTE);
  assert.deepEqual(await reopened.list(), [], 'restored prior-context dependencies remain transitively deletable');
});

test('prior context is compact, preceding and nonoverlapping; exclusion scope fences archived children', async (t) => {
  const home = await fixture(t);
  const inputs: ComputerHistorySummaryInput[] = [];
  let now = BASE + SIX_HOURS;
  const summaries = new ComputerHistorySummaries({
    home, now: () => now,
    generate: async (input) => { inputs.push(input); return CONTENT; },
  });
  const events = [1, 11, 21].map((minute) => event(BASE + minute * MINUTE));
  await summaries.run(events, { scopeKey: 'a', locale: 'zh-TW' });
  assert.equal(inputs[2]!.priorContext!.length, 2);
  for (const input of inputs) {
    for (const prior of input.priorContext ?? []) {
      const end = prior.text.match(/to ([^;]+);/)![1]!;
      assert.ok(Date.parse(end) <= Date.parse(input.start));
      assert.match(prior.text, /^Summary interval:/);
    }
    assert.ok(Buffer.byteLength(JSON.stringify(input.priorContext ?? [])) < 9 * 1024);
  }
  assert.equal(inputs.at(-1)!.priorContext, undefined);
  await summaries.run([events[0]!], { scopeKey: 'b', locale: 'zh-TW' });
  assert.equal(inputs.at(-1)!.level, '10min');
  const afterScopeChange = inputs.length;
  await summaries.run([], { scopeKey: 'b', locale: 'zh-TW' });
  assert.equal(inputs.length, afterScopeChange);
  now = BASE + 72 * 60 * MINUTE;
  await summaries.run([], { scopeKey: 'b' });
  assert.equal(inputs.length, afterScopeChange);
});

test('refreshing an earlier summary refreshes dependent prior context and then converges', async (t) => {
  const home = await fixture(t);
  const inputs: ComputerHistorySummaryInput[] = [];
  const summaries = new ComputerHistorySummaries({
    home, now: () => BASE + 31 * MINUTE,
    generate: async (input) => {
      inputs.push(input);
      return { ...CONTENT, body: `Observed revision ${inputs.length}` };
    },
  });
  const events = [1, 11, 21].map((minute) => event(BASE + minute * MINUTE));
  await summaries.run(events);
  const original = await summaries.list();
  const changed = [...events, event(BASE + 2 * MINUTE, 'Late correction')];
  await summaries.run(changed);
  assert.equal(inputs.length, 6);
  const updated = await summaries.list();
  assert.deepEqual(updated.map(({ id }) => id), original.map(({ id }) => id));
  assert.ok(updated.every((summary, index) =>
    summary.generation!.sourceRevision !== original[index]!.generation!.sourceRevision));
  assert.deepEqual(updated[1]!.sourceIds, original[1]!.sourceIds);
  assert.match(inputs[4]!.priorContext![0]!.text, /Observed revision 4/);
  assert.match(inputs[5]!.priorContext![1]!.text, /Observed revision 5/);
  await summaries.run(changed);
  assert.equal(inputs.length, 6);
});

test('reasonable complete child bodies survive rollup and generation versions migrate retained leaves once', async (t) => {
  const home = await fixture(t);
  const inputs: ComputerHistorySummaryInput[] = [];
  const body = `${'正文 detail\n'.repeat(300)}FINAL_OBSERVED_RESULT`;
  let now = BASE + SIX_HOURS;
  const summaries = new ComputerHistorySummaries({
    home, now: () => now,
    generate: async (input) => { inputs.push(input); return { ...CONTENT, body }; },
  });
  const events = [event(BASE + MINUTE), event(BASE + 11 * MINUTE)];
  await summaries.run(events, { locale: 'zh-CN' });
  const rollupInput = inputs.find(({ level }) => level === '6h')!;
  assert.ok(rollupInput.evidence.every(({ text }) => text.includes(body)));
  const leaf = (await summaries.get(`10min-${BASE}`))!;
  const { generation: _generation, ...legacy } = leaf;
  const path = join(home, 'summaries', leaf.filename!);
  await writeFile(path, serializeComputerHistorySummary(legacy));
  assert.equal((await summaries.get(leaf.id))!.generation, undefined);
  await summaries.run(events, { locale: 'zh-CN' });
  assert.equal(inputs.length, 5);
  await summaries.run([...events].reverse(), { locale: 'zh-CN' });
  assert.equal(inputs.length, 5);
  await writeFile(path, serializeComputerHistorySummary(legacy));
  now = BASE + 48 * 60 * MINUTE + 5 * MINUTE;
  await summaries.run([event(BASE + 8 * MINUTE)], { locale: 'en' });
  assert.equal((await summaries.get(leaf.id))!.generation, undefined);
});

for (const lateMinute of [2, 21]) test(`a late event at minute ${lateMinute} invalidates its rollup across failed rebuild and restart`, async (t) => {
  const home = await fixture(t);
  let failRollup = false;
  const summaries = new ComputerHistorySummaries({
    home, now: () => BASE + SIX_HOURS,
    generate: async (input) => {
      if (failRollup && input.level === '6h') throw new Error('Synthetic rollup failure');
      return CONTENT;
    },
  });
  const events = [event(BASE + MINUTE)];
  await summaries.run(events);
  failRollup = true;
  events.push(event(BASE + lateMinute * MINUTE));
  await assert.rejects(summaries.run(events), /Synthetic rollup failure/);
  const leaves = await summaries.list();
  assert.ok(leaves.every(({ level }) => level === '10min'));
  assert.equal(leaves.reduce((total, { eventCount }) => total + eventCount, 0), 2);
  const rebuilt: ComputerHistorySummaryInput[] = [];
  const reopened = new ComputerHistorySummaries({
    home, now: () => BASE + SIX_HOURS,
    generate: async (input) => { rebuilt.push(input); return CONTENT; },
  });
  await reopened.run(events);
  assert.deepEqual(rebuilt.map(({ level }) => level), ['6h']);
  assert.equal((await reopened.list()).find(({ level }) => level === '6h')!.eventCount, 2);
  await reopened.run(events);
  assert.equal(rebuilt.length, 1);
});

for (const change of ['append', 'replace'] as const) test(`fresh ${change} evidence progresses while a saved prior rollup is missing`, async (t) => {
  const home = await fixture(t);
  const options = { includeText: true, scopeKey: 'allowed' };
  const parentId = `6h-${BASE}`;
  const start = BASE + SIX_HOURS;
  const leafId = `10min-${start}`;
  let now = start;
  let failParent = false;
  const inputs: ComputerHistorySummaryInput[] = [];
  const generate = async (input: ComputerHistorySummaryInput) => {
    inputs.push(input);
    if (failParent && input.level === '6h' && Date.parse(input.start) === BASE) {
      return { ...CONTENT, body: '' };
    }
    return { ...CONTENT, body: `Observed ${input.evidence.map(({ text }) => text).join('\n')}` };
  };
  const summaries = new ComputerHistorySummaries({ home, now: () => now, generate });
  t.after(() => summaries.close());
  const events = [{ ...event(BASE + MINUTE), content: 'EARLIER_FACT' }];
  await summaries.run(events, options);
  now = start + TEN_MINUTES;
  events.push({ ...event(start + MINUTE), content: 'CURRENT_INITIAL_FACT' });
  await summaries.run(events, options);
  const original = (await summaries.get(leafId))!;
  assert.deepEqual(original.generation!.priorContextIds, [parentId]);
  const path = join(home, 'summaries', original.filename!);
  const originalBytes = await readFile(path);

  failParent = true;
  events.push({ ...event(BASE + 2 * MINUTE), content: 'EARLIER_CORRECTION' });
  await assert.rejects(summaries.run(events, options), ComputerHistorySummaryRunError);
  assert.equal(await summaries.get(parentId), null);
  assert.deepEqual(await readFile(path), originalBytes, 'prior disappearance alone must preserve the saved leaf');
  await summaries.close();

  const reopened = new ComputerHistorySummaries({ home, now: () => now, generate });
  t.after(() => reopened.close());
  await assert.rejects(reopened.run(events, { ...options, retryFailed: true }), ComputerHistorySummaryRunError);
  assert.deepEqual(await readFile(path), originalBytes, 'unchanged raw evidence stays pinned after restart');
  const fresh = { ...event(start + (change === 'append' ? 2 : 1) * MINUTE), content: 'FRESH_CURRENT_FACT' };
  if (change === 'append') events.push(fresh);
  else events[1] = fresh;
  const before = inputs.length;
  await reopened.run(events, { ...options, includeText: false });
  assert.equal(inputs.length, before, 'text revocation must not use rich saved dependencies');
  assert.deepEqual(await readFile(path), originalBytes);
  await assert.rejects(reopened.run(events, { ...options, retryFailed: true }), ComputerHistorySummaryRunError);
  const updated = (await reopened.get(leafId))!;
  assert.match(updated.content.body, /FRESH_CURRENT_FACT/, 'missing prior must not starve admitted current evidence');
  assert.equal(updated.eventCount, change === 'append' ? 2 : 1);
  const freshInput = inputs.slice(before).find((input) => input.level === '10min' &&
    Date.parse(input.start) === start)!;
  assert.ok(freshInput);
  assert.ok(freshInput.evidence.some(({ id }) => id === summaryEventId(fresh, { includeText: true })));
  assert.ok(!freshInput.priorContext?.some(({ id }) => id === parentId), 'an absent parent cannot be reused');
  assert.ok(updated.generation!.rawEvidenceRanges!.some(([from, to]) =>
    from <= BASE && to >= BASE + TEN_MINUTES), 'newly exposed prior evidence keeps deletion coverage');
  assert.equal(await reopened.get(parentId), null);
  const updatedBytes = await readFile(path);
  const unchangedCalls = inputs.length;
  await assert.rejects(reopened.run(events, { ...options, retryFailed: true }), ComputerHistorySummaryRunError);
  assert.equal(inputs.slice(unchangedCalls).filter((input) => input.level === '10min').length, 0);
  assert.deepEqual(await readFile(path), updatedBytes, 'repeated parent failure must not spin leaf regeneration');
  failParent = false;
  await reopened.run(events, { ...options, retryFailed: true });
  assert.ok(await reopened.get(parentId));
  assert.deepEqual(await readFile(path), updatedBytes, 'parent recovery alone does not replace new pinned evidence');
  await reopened.close();

  const converged = new ComputerHistorySummaries({
    home, now: () => now, generate: async () => assert.fail('saved generations must converge after restart'),
  });
  t.after(() => converged.close());
  await converged.run(events, options);
  now = BASE + 72 * 60 * MINUTE;
  await converged.clearInterval(BASE + MINUTE, BASE + MINUTE);
  assert.equal(await converged.get(leafId), null, 'prior deletion still removes the consumer after raw expiry');
});

for (const legacy of [false, true]) for (const missingPrior of [false, true]) test(`unsampled raw replacement with ${legacy ? 'legacy' : 'durable'} identity after restart and prior ${missingPrior ? 'missing' : 'present'}`, async (t) => {
  const home = await fixture(t);
  const options = { includeText: true, scopeKey: 'allowed' };
  const start = BASE + SIX_HOURS;
  const leafId = `10min-${start}`;
  const parentId = `6h-${BASE}`;
  let now = start;
  let failParent = false;
  const inputs: ComputerHistorySummaryInput[] = [];
  const generate = async (input: ComputerHistorySummaryInput) => {
    inputs.push(input);
    return { ...CONTENT, body: failParent && input.level === '6h' &&
      Date.parse(input.start) === BASE ? '' : CONTENT.body };
  };
  const summaries = new ComputerHistorySummaries({ home, now: () => now, generate });
  t.after(() => summaries.close());
  const earlier = [{ ...event(BASE + MINUTE), content: 'EARLIER_FACT' }];
  await summaries.run(earlier, options);
  now = start + TEN_MINUTES;
  const dense = Array.from({ length: 1000 }, (_, index) => ({
    ...event(start + MINUTE + index), content: index % 2 ? 'FACT_B' : 'FACT_A',
  }));
  await summaries.run([...earlier, ...dense], options);
  if (legacy) {
    for (const saved of await summaries.list()) {
      const { rawSourceRevision: _raw, ...generation } = saved.generation!;
      await writeFile(join(home, 'summaries', saved.filename!),
        serializeComputerHistorySummary({ ...saved, generation }));
    }
  }
  const original = (await summaries.get(leafId))!;
  assert.deepEqual(original.generation!.priorContextIds, [parentId]);
  const path = join(home, 'summaries', original.filename!);
  const originalBytes = await readFile(path);
  const sampledIds = inputs.find((input) => input.level === '10min' &&
    Date.parse(input.start) === start)!.evidence.map(({ id }) => id);
  assert.equal(sampledIds.length, 3);
  const replacement = { ...dense[500]!, content: 'FACT_B' };
  const oldId = summaryEventId(dense[500]!, options);
  const newId = summaryEventId(replacement, options);
  assert.ok(oldId);
  assert.ok(newId);
  assert.notEqual(oldId, newId);
  assert.ok(!sampledIds.includes(oldId));
  assert.ok(!sampledIds.includes(newId));
  if (!legacy) assert.match(original.generation!.rawSourceRevision!, /^[a-f0-9]{64}$/u);
  const archivePaths = (await summaries.list()).map(({ filename }) => join(home, 'summaries', filename!));
  const archiveBytes = await Promise.all(archivePaths.map((file) => readFile(file)));
  const unchangedCalls = inputs.length;
  await summaries.run([...earlier, ...dense], options);
  assert.equal(inputs.length, unchangedCalls);
  assert.deepEqual(await Promise.all(archivePaths.map((file) => readFile(file))), archiveBytes,
    'new bookkeeping alone must not rewrite leaves, prior context or rollups');
  if (missingPrior) {
    failParent = true;
    earlier.push({ ...event(BASE + 2 * MINUTE), content: 'EARLIER_CORRECTION' });
    await assert.rejects(summaries.run([...earlier, ...dense], options), ComputerHistorySummaryRunError);
    assert.equal(await summaries.get(parentId), null);
  }
  await summaries.close();
  const reopened = new ComputerHistorySummaries({ home, now: () => now, generate });
  t.after(() => reopened.close());
  const run = async () => {
    const pending = reopened.run([...earlier, ...dense], { ...options, retryFailed: true });
    if (missingPrior) await assert.rejects(pending, ComputerHistorySummaryRunError);
    else await pending;
  };
  await run();
  assert.deepEqual(await readFile(path), originalBytes, 'unchanged raw preserves saved bytes after restart');
  const before = inputs.length;
  dense[500] = replacement;
  await run();
  const refreshed = inputs.slice(before).filter((input) => input.level === '10min' &&
    Date.parse(input.start) === start);
  if (legacy && missingPrior) {
    assert.equal(refreshed.length, 0, 'missing prior and identical samples leave legacy raw identity unknown');
    assert.deepEqual(await readFile(path), originalBytes, 'unknown legacy input must not be backfilled as equality');
    dense.push({ ...event(start + 2 * MINUTE), content: 'KNOWN_NEW_FACT' });
    await run();
    const updated = (await reopened.get(leafId))!;
    assert.equal(updated.eventCount, 1001, 'positive fresh evidence permits ordinary legacy regeneration');
    assert.match(updated.generation!.rawSourceRevision!, /^[a-f0-9]{64}$/u);
    assert.ok(!updated.generation!.priorContextIds!.includes(parentId));
  } else {
    assert.equal(refreshed.length, 1, 'all-event identity must detect an unsampled same-count replacement');
    assert.deepEqual(refreshed[0]!.evidence.map(({ id }) => id), sampledIds);
    const updated = (await reopened.get(leafId))!;
    assert.equal(updated.eventCount, 1000);
    assert.notEqual(updated.generation!.sourceRevision, original.generation!.sourceRevision);
    assert.notEqual(updated.generation!.rawSourceRevision, original.generation!.rawSourceRevision);
  }
  const updatedBytes = await readFile(path);
  const after = inputs.length;
  await run();
  assert.equal(inputs.slice(after).filter((input) => input.level === '10min').length, 0);
  assert.deepEqual(await readFile(path), updatedBytes);
});

test('raw revision is leaf-only metadata and legacy documents remain readable without it', async (t) => {
  const home = await fixture(t);
  const summaries = new ComputerHistorySummaries({
    home, now: () => BASE + SIX_HOURS, generate: async () => CONTENT,
  });
  t.after(() => summaries.close());
  await summaries.run([event(BASE + MINUTE)]);
  const leaf = (await summaries.get(`10min-${BASE}`))!;
  const parent = (await summaries.get(`6h-${BASE}`))!;
  assert.match(leaf.generation!.rawSourceRevision!, /^[a-f0-9]{64}$/u);
  assert.equal(parent.generation!.rawSourceRevision, undefined);
  const parentPath = join(home, 'summaries', parent.filename!);
  const parentBytes = await readFile(parentPath);
  await writeFile(parentPath, serializeComputerHistorySummary({
    ...parent, generation: { ...parent.generation!, rawSourceRevision: leaf.generation!.rawSourceRevision },
  }));
  await assert.rejects(summaries.get(parent.id), /Invalid computer history summary/);
  await writeFile(parentPath, parentBytes);
  const { rawSourceRevision: _raw, ...generation } = leaf.generation!;
  const leafPath = join(home, 'summaries', leaf.filename!);
  for (const version of [4, 5]) {
    await writeFile(leafPath, serializeComputerHistorySummary({ ...leaf, generation: { ...generation, version } }));
    assert.equal((await summaries.get(leaf.id))!.generation!.rawSourceRevision, undefined);
  }
});

test('failed, invalid and cancelled leaf refreshes preserve saved leaf and rollup bytes', async (t) => {
  const home = await fixture(t);
  let mode: 'success' | 'failure' | 'invalid' | 'held' = 'success';
  const started = deferred<AbortSignal>();
  const result = deferred<ComputerHistorySummaryContent>();
  const summaries = new ComputerHistorySummaries({
    home, now: () => BASE + SIX_HOURS,
    generate: async (_input, signal) => {
      if (mode === 'failure') throw new Error('Synthetic leaf failure');
      if (mode === 'invalid') return { ...CONTENT, body: '' };
      if (mode === 'held') { started.resolve(signal); return result.promise; }
      return CONTENT;
    },
  });
  const events = [event(BASE + MINUTE)];
  await summaries.run(events);
  const original = await summaries.list();
  const paths = original.map(({ filename }) => join(home, 'summaries', filename!));
  const bytes = await Promise.all(paths.map((path) => readFile(path)));
  events.push(event(BASE + 2 * MINUTE));
  for (const failure of ['failure', 'invalid'] as const) {
    mode = failure;
    await assert.rejects(summaries.run(events, { retryFailed: true }));
    assert.deepEqual(await Promise.all(paths.map((path) => readFile(path))), bytes);
  }
  mode = 'held';
  const running = summaries.run(events, { retryFailed: true });
  const signal = await started.promise;
  const cancelling = summaries.cancel();
  assert.equal(signal.aborted, true);
  result.resolve(CONTENT);
  await Promise.all([running, cancelling]);
  assert.deepEqual(await Promise.all(paths.map((path) => readFile(path))), bytes);
  mode = 'success';
  await summaries.run(events);
  assert.deepEqual((await summaries.list()).map(({ eventCount }) => eventCount), [2, 2]);
});

test('retention crossing a window never replaces its complete saved evidence with the retained tail', async (t) => {
  const home = await fixture(t);
  let now = BASE + SIX_HOURS;
  let calls = 0;
  const summaries = new ComputerHistorySummaries({
    home, now: () => now,
    generate: async () => { calls++; return CONTENT; },
  });
  const events = [event(BASE + MINUTE), event(BASE + 8 * MINUTE)];
  await summaries.run(events);
  const original = await summaries.list();
  now = BASE + 48 * 60 * MINUTE + 5 * MINUTE;
  await summaries.run([events[1]!]);
  assert.equal(calls, 2);
  assert.deepEqual(await summaries.list(), original);
});

test('repeated failures of an old rollup do not prevent newer closed leaves from being saved', async (t) => {
  const home = await fixture(t);
  let now = BASE + TEN_MINUTES;
  const inputs: ComputerHistorySummaryInput[] = [];
  const summaries = new ComputerHistorySummaries({
    home, now: () => now,
    generate: async (input) => {
      inputs.push(input);
      if (input.level === '6h') throw new Error('Synthetic rollup failure');
      return CONTENT;
    },
  });
  const events = [event(BASE + MINUTE)];
  await summaries.run(events);
  for (let window = 0; window < 2; window++) {
    const start = BASE + SIX_HOURS + window * TEN_MINUTES;
    now = start + TEN_MINUTES;
    events.push(event(start + MINUTE));
    await assert.rejects(summaries.run(events), /Synthetic rollup failure/);
    assert.ok((await summaries.list()).some((summary) =>
      summary.level === '10min' && summary.start === new Date(start).toISOString(),
    ));
  }
  assert.deepEqual(inputs.map(({ level }) => level), ['10min', '10min', '6h', '10min', '6h']);
  assert.equal((await summaries.list()).length, 3);
});

test('empty, future, open and expired windows never produce fake summaries', async (t) => {
  const home = await fixture(t);
  const summaries = new ComputerHistorySummaries({
    home,
    now: () => BASE + MINUTE,
    generate: async () => assert.fail('no closed evidence'),
  });
  await summaries.run([]);
  await summaries.run([
    event(BASE),
    event(BASE + 2 * MINUTE),
    event(BASE - 49 * 60 * MINUTE),
    { ...event(BASE - TEN_MINUTES), kind: '' },
  ]);
  assert.deepEqual(await summaries.list(), []);
});

test('raw horizon is inclusive and long evidence remains bounded with stable IDs', async (t) => {
  const home = await fixture(t);
  const inputs: ComputerHistorySummaryInput[] = [];
  const events = Array.from({ length: 2_000 }, (_, i) => ({
    ...event(BASE + i, `${'\u4e2d'.repeat(10_000)}${i}`),
    app: { name: '\u4e2d'.repeat(10_000), bundleIdentifier: 'b'.repeat(10_000) },
    kind: 'k'.repeat(10_000),
    keyboard: { text: 'NEVER INCLUDE' },
  }));
  const summaries = new ComputerHistorySummaries({
    home,
    now: () => BASE + 48 * 60 * MINUTE,
    generate: async (input) => {
      inputs.push(input);
      return CONTENT;
    },
  });
  await summaries.run(events);
  const raw = inputs[0]!;
  assert.ok(raw.evidence.length > 0 && raw.evidence.length <= 256);
  assert.ok(Buffer.byteLength(JSON.stringify(raw)) < 256 * 1024);
  assert.match(raw.evidence[0]!.text, /\[truncated\]/);
  assert.match(raw.evidence.at(-1)!.text, /Evidence sample: \d+ of 2000 events/);
  assert.doesNotMatch(JSON.stringify(raw), /NEVER INCLUDE/);
  assert.equal((await summaries.list()).find(({ level }) => level === '10min')!.eventCount, 2_000);
  await summaries.clear(-Infinity);
  await summaries.run([...events].reverse());
  assert.deepEqual(inputs[2]!.evidence, raw.evidence);
});

test('single-flight clear waits for ignored cancellation and fences a late result', async (t) => {
  const home = await fixture(t);
  const started = deferred<AbortSignal>();
  const result = deferred<ComputerHistorySummaryContent>();
  let calls = 0;
  const summaries = new ComputerHistorySummaries({
    home,
    now: () => BASE + 20 * MINUTE,
    generate: async (_input, signal) => {
      calls++;
      if (calls > 1) return CONTENT;
      started.resolve(signal);
      return result.promise;
    },
  });
  const running = summaries.run([event(BASE + MINUTE)]);
  assert.equal(summaries.run([event(BASE + 11 * MINUTE)]), running);
  const signal = await started.promise;
  let cleared = false;
  const clearing = summaries.clear(BASE).then(() => {
    cleared = true;
  });
  assert.equal(signal.aborted, true);
  await Promise.resolve();
  assert.equal(cleared, false);
  const duringClear = summaries.run([event(BASE + 11 * MINUTE)]);
  result.resolve(CONTENT);
  await Promise.all([running, clearing, duringClear]);
  assert.equal(calls, 1);
  assert.deepEqual(await summaries.list(), []);
  await summaries.run([event(BASE + 11 * MINUTE)]);
  assert.equal((await summaries.list()).length, 1);
});

test('cancel drains rejected generation, permits retry, and close prevents future runs', async (t) => {
  const home = await fixture(t);
  const started = deferred<AbortSignal>();
  const result = deferred<ComputerHistorySummaryContent>();
  let calls = 0;
  const summaries = new ComputerHistorySummaries({
    home,
    now: () => BASE + TEN_MINUTES,
    generate: async (_input, signal) => {
      calls++;
      if (calls > 1) return CONTENT;
      started.resolve(signal);
      return result.promise;
    },
  });
  const running = summaries.run([event(BASE + MINUTE)]);
  const signal = await started.promise;
  const cancelling = summaries.cancel();
  assert.equal(signal.aborted, true);
  result.reject(new Error('provider cancelled'));
  await Promise.all([running, cancelling]);
  assert.deepEqual(await summaries.list(), []);
  await summaries.run([event(BASE + MINUTE)]);
  assert.equal(calls, 2);
  await summaries.close();
  await summaries.clear(-Infinity);
  await summaries.run([event(BASE + MINUTE)]);
  assert.equal(calls, 2);
  assert.deepEqual(await summaries.list(), []);
});

test('close drains an ignored abort and never publishes the late result', async (t) => {
  const home = await fixture(t);
  const started = deferred<AbortSignal>();
  const result = deferred<ComputerHistorySummaryContent>();
  const summaries = new ComputerHistorySummaries({
    home,
    now: () => BASE + TEN_MINUTES,
    generate: async (_input, signal) => {
      started.resolve(signal);
      return result.promise;
    },
  });
  const running = summaries.run([event(BASE + MINUTE)]);
  const signal = await started.promise;
  const closing = summaries.close();
  assert.equal(signal.aborted, true);
  await summaries.run([event(BASE + MINUTE)]);
  result.resolve(CONTENT);
  await Promise.all([running, closing]);
  assert.deepEqual(await summaries.list(), []);
});

test('generator input mutation cannot forge persisted provenance', async (t) => {
  const home = await fixture(t);
  let sourceId = '';
  const summaries = new ComputerHistorySummaries({
    home,
    now: () => BASE + TEN_MINUTES,
    generate: async (input) => {
      sourceId = input.evidence[0]!.id;
      Object.assign(input, { start: 'forged', end: 'forged', level: '6h' });
      Object.assign(input.evidence[0]!, { id: '/private/forged.jsonl', text: 'forged' });
      return CONTENT;
    },
  });
  await summaries.run([event(BASE + MINUTE)]);
  const [summary] = await summaries.list();
  assert.equal(summary!.start, new Date(BASE).toISOString());
  assert.equal(summary!.end, new Date(BASE + TEN_MINUTES).toISOString());
  assert.equal(summary!.level, '10min');
  assert.deepEqual(summary!.sourceIds, [sourceId]);
});

test('clear removes overlapping windows and enclosing rollups while preserving the cutoff boundary', async (t) => {
  const home = await fixture(t);
  let calls = 0;
  const summaries = new ComputerHistorySummaries({
    home,
    now: () => BASE + 2 * SIX_HOURS,
    generate: async () => { calls++; return CONTENT; },
  });
  const events = [
    event(BASE + MINUTE),
    event(BASE + SIX_HOURS + MINUTE),
    event(BASE + SIX_HOURS + 11 * MINUTE),
  ];
  await summaries.run(events);
  assert.equal(calls, 5);
  // Publishing the earlier rollup does not replace pinned context in unchanged leaves.
  await summaries.run(events);
  assert.equal(calls, 5);
  assert.equal((await summaries.list()).length, 5);
  await summaries.run(events);
  assert.equal(calls, 5);
  await summaries.clear(BASE + SIX_HOURS + TEN_MINUTES);
  const remaining = await summaries.list();
  assert.equal(remaining.length, 3);
  assert.ok(remaining.every(({ end }) => Date.parse(end) <= BASE + SIX_HOURS + TEN_MINUTES));
  assert.equal(remaining.filter(({ level }) => level === '6h').length, 1);
  await summaries.clear(-Infinity);
  assert.deepEqual(await summaries.list(), []);
});

test('interval clear preserves earlier leaves and removes later prior-context dependants and the rollup', async (t) => {
  const home = await fixture(t);
  const summaries = new ComputerHistorySummaries({
    home, now: () => BASE + SIX_HOURS, generate: async () => CONTENT,
  });
  await summaries.run([
    event(BASE + MINUTE),
    event(BASE + 11 * MINUTE),
    event(BASE + 21 * MINUTE),
  ]);
  assert.equal((await summaries.list()).length, 4);

  await summaries.clearInterval(BASE + TEN_MINUTES, BASE + 2 * TEN_MINUTES);

  assert.deepEqual((await summaries.list()).map(({ start }) => start), [
    new Date(BASE).toISOString(),
  ]);
  await summaries.clearInterval(BASE + 2 * TEN_MINUTES, BASE + 2 * TEN_MINUTES);
  assert.deepEqual((await summaries.list()).map(({ start }) => start), [new Date(BASE).toISOString()]);
  await summaries.clearInterval(BASE, BASE);
  assert.deepEqual(await summaries.list(), []);
  await assert.rejects(summaries.clearInterval(BASE + 1, BASE), /Invalid history clear interval/);
  await assert.rejects(summaries.clearInterval(-Infinity, BASE), /Invalid history clear interval/);
});

for (const missingSource of [false, true]) test(`persisted prior dependencies delete transitively after expiry with missing source ${missingSource}`, async (t) => {
  const home = await fixture(t);
  let now = BASE + SIX_HOURS;
  const inputs: ComputerHistorySummaryInput[] = [];
  const summaries = new ComputerHistorySummaries({
    home, now: () => now,
    generate: async (input) => {
      inputs.push(structuredClone(input));
      // Provider mutation must not change main-owned dependency provenance.
      if (input.priorContext?.length) Object.assign(input.priorContext[0]!, { id: 'forged' });
      return { ...CONTENT, body: 'Derived context' };
    },
  });
  await summaries.run([1, 11, 21, 31].map((minute) => event(BASE + minute * MINUTE)), { scopeKey: 'a' });
  now += 2 * TEN_MINUTES;
  await summaries.run([1, 11].map((minute) => event(BASE + SIX_HOURS + minute * MINUTE)), { scopeKey: 'a' });
  const dependent = await summaries.list();
  for (const summary of dependent) {
    const input = [...inputs].reverse().find((input) => input.level === summary.level && input.start === summary.start)!;
    assert.deepEqual(summary.generation!.priorContextIds, input.priorContext?.map(({ id }) => id) ?? []);
  }
  assert.ok(!(await summaries.get(`10min-${BASE + 3 * TEN_MINUTES}`))!.generation!.priorContextIds!.includes(`10min-${BASE}`));
  assert.deepEqual((await summaries.get(`10min-${BASE + SIX_HOURS}`))!.generation!.priorContextIds, [`6h-${BASE}`]);
  now += TEN_MINUTES;
  await summaries.run([event(BASE + SIX_HOURS + 21 * MINUTE)], { scopeKey: 'independent' });
  const independent = (await summaries.get(`10min-${BASE + SIX_HOURS + 2 * TEN_MINUTES}`))!;
  assert.deepEqual(independent.generation!.priorContextIds, []);
  const independentPath = join(home, 'summaries', independent.filename!);
  const bytes = await readFile(independentPath);
  if (missingSource) await rm(join(home, 'summaries', (await summaries.get(`10min-${BASE}`))!.filename!));
  now = BASE + 72 * 60 * MINUTE;
  const reopened = new ComputerHistorySummaries({
    home, now: () => now, generate: async () => assert.fail('deleted dependencies must not be reused'),
  });
  await reopened.clearInterval(BASE + MINUTE, BASE + MINUTE);
  assert.deepEqual(await reopened.list(), [independent]);
  assert.deepEqual(await readFile(independentPath), bytes);
  await reopened.run([], { scopeKey: 'a' });
});

for (const missingIntermediates of [false, true]) test(`immutable ancestry deletes rich archives after scope rewrites with missing intermediates ${missingIntermediates}`, async (t) => {
  const home = await fixture(t);
  let now = BASE + SIX_HOURS;
  const inputs: ComputerHistorySummaryInput[] = [];
  const create = () => new ComputerHistorySummaries({
    home, now: () => now,
    generate: async (input) => {
      inputs.push(input);
      return { ...CONTENT, body: JSON.stringify(input).includes('ANCESTOR_CANARY') ? 'ANCESTOR_CANARY' : 'Current scope' };
    },
  });
  const summaries = create();
  const events = [
    event(BASE + MINUTE, 'ANCESTOR_CANARY'),
    event(BASE + 11 * MINUTE),
    event(BASE + 21 * MINUTE),
    { ...event(BASE + 31 * MINUTE), content: 'Rich observed text' },
  ];
  await summaries.run(events, { scopeKey: 'a', includeText: true });
  now += TEN_MINUTES;
  const next = event(BASE + SIX_HOURS + MINUTE);
  await summaries.run([next], { scopeKey: 'a', includeText: true });
  const richIds = [`10min-${BASE + 3 * TEN_MINUTES}`, `6h-${BASE}`, `10min-${BASE + SIX_HOURS}`];
  const richPaths = await Promise.all(richIds.map(async (id) => join(home, 'summaries', (await summaries.get(id))!.filename!)));
  const bytes = await Promise.all(richPaths.map((path) => readFile(path)));
  assert.deepEqual((await summaries.get(richIds[0]!))!.generation!.rawEvidenceRanges, [[BASE, BASE + 4 * TEN_MINUTES]]);
  const beforeRewrite = inputs.length;
  const replacements = events.slice(1, 3);
  await summaries.run(replacements, { scopeKey: 'b' });
  now += 2 * TEN_MINUTES;
  const independentEvent = event(BASE + SIX_HOURS + 21 * MINUTE);
  await summaries.run([independentEvent], { scopeKey: 'b' });
  const independent = (await summaries.get(`10min-${BASE + SIX_HOURS + 2 * TEN_MINUTES}`))!;
  const independentPath = join(home, 'summaries', independent.filename!);
  const independentBytes = await readFile(independentPath);
  assert.deepEqual(
    await Promise.all(richPaths.map((path) => readFile(path))),
    bytes,
  );
  assert.doesNotMatch(JSON.stringify(inputs.slice(beforeRewrite)), /ANCESTOR_CANARY|rawEvidenceRanges/);
  const calls = inputs.length;
  await create().run([independentEvent, ...replacements].reverse(), { scopeKey: 'b' });
  assert.equal(inputs.length, calls, 'rewrites converge while incompatible rich consumers remain archived');
  const replacementIds = [1, 2].map((index) => `10min-${BASE + index * TEN_MINUTES}`);
  if (missingIntermediates) {
    for (const id of [`10min-${BASE}`, ...replacementIds, `6h-${BASE}`]) {
      await rm(join(home, 'summaries', (await summaries.get(id))!.filename!));
    }
  }
  now = BASE + 72 * 60 * MINUTE;
  const reopened = create();
  await reopened.clearInterval(BASE + MINUTE, BASE + MINUTE);
  assert.deepEqual((await reopened.list()).map(({ id }) => id),
    [...(missingIntermediates ? [] : replacementIds), independent.id]);
  assert.deepEqual(await readFile(independentPath), independentBytes);
  assert.equal(inputs.length, calls, 'deletion uses the consumer snapshot without a provider call');
});

test('sparse raw ancestry preserves gaps even when deleting an overlapping parent after expiry', async (t) => {
  const home = await fixture(t);
  let now = BASE + SIX_HOURS;
  const summaries = new ComputerHistorySummaries({
    home, now: () => now, generate: async () => CONTENT,
  });
  await summaries.run([event(BASE + MINUTE), event(BASE + 21 * MINUTE)]);
  now += TEN_MINUTES;
  await summaries.run([event(BASE + SIX_HOURS + MINUTE)]);
  const descendantId = `10min-${BASE + SIX_HOURS}`;
  const descendant = (await summaries.get(descendantId))!;
  assert.deepEqual(descendant.generation!.rawEvidenceRanges, [
    [BASE, BASE + TEN_MINUTES],
    [BASE + 2 * TEN_MINUTES, BASE + 3 * TEN_MINUTES],
    [BASE + SIX_HOURS, BASE + SIX_HOURS + TEN_MINUTES],
  ]);
  const path = join(home, 'summaries', descendant.filename!);
  const bytes = await readFile(path);
  now = BASE + 72 * 60 * MINUTE;
  await summaries.clearInterval(BASE + TEN_MINUTES, BASE + 2 * TEN_MINUTES);
  assert.equal(await summaries.get(`6h-${BASE}`), null, 'the selected interval still removes its enclosing document');
  assert.deepEqual(await readFile(path), bytes);
  await summaries.clearInterval(BASE + TEN_MINUTES, BASE + TEN_MINUTES);
  assert.deepEqual(await summaries.get(descendantId), descendant, 'half-open ancestry excludes the gap boundary');
  await summaries.clearInterval(BASE + 2 * TEN_MINUTES, BASE + 2 * TEN_MINUTES);
  assert.deepEqual((await summaries.list()).map(({ id }) => id), [`10min-${BASE}`]);
});

test('ancestry overflow preserves all sources, coarsens only oldest gaps and converges within file and model budgets', async (t) => {
  const home = await fixture(t);
  let now = BASE + TEN_MINUTES;
  const inputs: ComputerHistorySummaryInput[] = [];
  const create = () => new ComputerHistorySummaries({
    home, now: () => now,
    generate: async (input) => { inputs.push(input); return { ...CONTENT, body: '\u4e2d'.repeat(16_000) }; },
  });
  const summaries = create();
  await summaries.run([event(BASE + MINUTE)]);
  const original = (await summaries.get(`10min-${BASE}`))!;
  const rawEvidenceRanges = Array.from({ length: 256 }, (_, index) => {
    const start = BASE - (255 - index) * 2 * TEN_MINUTES;
    return [start, start + TEN_MINUTES] as const;
  });
  await writeFile(join(home, 'summaries', original.filename!), serializeComputerHistorySummary({
    ...original, generation: { ...original.generation!, rawEvidenceRanges },
  }));
  now += 2 * TEN_MINUTES;
  const next = event(BASE + 21 * MINUTE);
  await summaries.run([next]);
  const descendantId = `10min-${BASE + 2 * TEN_MINUTES}`;
  const descendant = (await summaries.get(descendantId))!;
  const coverage = descendant.generation!.rawEvidenceRanges!;
  assert.equal(coverage.length, 256);
  assert.ok(rawEvidenceRanges.every(([from, to]) => coverage.some(([a, b]) => a <= from && b >= to)));
  assert.deepEqual(coverage[0], [rawEvidenceRanges[0]![0], rawEvidenceRanges[1]![1]]);
  assert.deepEqual(coverage.slice(1), [...rawEvidenceRanges.slice(2), [BASE + 2 * TEN_MINUTES, BASE + 3 * TEN_MINUTES]]);
  assert.ok((await readFile(join(home, 'summaries', descendant.filename!))).length < 128 * 1024);
  assert.ok(inputs.every((input) => Buffer.byteLength(JSON.stringify(input)) < 256 * 1024));
  assert.doesNotMatch(JSON.stringify(inputs), /rawEvidenceRanges/);
  await create().run([next]);
  assert.equal(inputs.length, 2);
  await summaries.clearInterval(BASE + TEN_MINUTES, BASE + 2 * TEN_MINUTES);
  assert.deepEqual(await summaries.get(descendantId), descendant, 'recent unobserved gaps stay precise');
  const oldestGap = rawEvidenceRanges[0]![1];
  await summaries.clearInterval(oldestGap, oldestGap);
  assert.equal(await summaries.get(descendantId), null, 'compacted old gaps delete conservatively');
  assert.ok(await summaries.get(original.id), 'the original precise input remains independent of that gap');
});

for (const version of [1, 2, 3]) test(`v${version} unknown ancestry propagates to modern consumers across scopes and missing inputs`, async (t) => {
  const home = await fixture(t);
  let now = BASE + TEN_MINUTES;
  const summaries = new ComputerHistorySummaries({
    home, now: () => now, generate: async () => CONTENT,
  });
  await summaries.run([event(BASE + MINUTE)], { scopeKey: 'a' });
  const original = (await summaries.list())[0]!;
  const { priorContextIds: _prior, rawEvidenceRanges: _ranges, rawSourceRevision: _raw, ...generation } = original.generation!;
  const legacy = (start: number) => ({
    ...original,
    filename: undefined,
    id: `10min-${start}`,
    start: new Date(start).toISOString(),
    end: new Date(start + TEN_MINUTES).toISOString(),
    generation: { ...generation, version, scopeKey: 'b', ...(version === 3 ? { priorContextIds: [] } : {}) },
  });
  const older = legacy(BASE - TEN_MINUTES);
  const later = legacy(BASE + 2 * SIX_HOURS);
  for (const summary of [older, later]) {
    await writeFile(join(home, 'summaries', `${summary.id}.md`), serializeComputerHistorySummary(summary));
  }
  now = BASE + 2 * SIX_HOURS + 2 * TEN_MINUTES;
  await summaries.run([event(BASE + 2 * SIX_HOURS + 11 * MINUTE)], { scopeKey: 'b' });
  const consumer = (await summaries.get(`10min-${BASE + 2 * SIX_HOURS + TEN_MINUTES}`))!;
  assert.deepEqual(consumer.generation!.priorContextIds, [later.id]);
  assert.deepEqual(consumer.generation!.rawEvidenceRanges, [[-8_640_000_000_000_000, Date.parse(consumer.end)]]);
  now += TEN_MINUTES;
  await summaries.run([event(BASE + 2 * SIX_HOURS + 21 * MINUTE)], { scopeKey: 'c' });
  const independent = (await summaries.get(`10min-${BASE + 2 * SIX_HOURS + 2 * TEN_MINUTES}`))!;
  const preceding = (await summaries.list()).filter((summary) => Date.parse(summary.end) <= BASE);
  assert.ok(preceding.some(({ id }) => id === older.id));
  await rm(join(home, 'summaries', `${later.id}.md`));
  now = BASE + 72 * 60 * MINUTE;
  const reopened = new ComputerHistorySummaries({
    home, now: () => now, generate: async () => assert.fail('deletion never calls the provider'),
  });
  await reopened.clearInterval(BASE, BASE + TEN_MINUTES);
  assert.deepEqual(await reopened.list(), [...preceding, independent]);
});

test('nongeneration legacy summaries remain usable with interval coverage after raw expiry', async (t) => {
  const home = await fixture(t);
  let now = BASE + TEN_MINUTES;
  const summaries = new ComputerHistorySummaries({
    home, now: () => now, generate: async () => CONTENT,
  });
  await summaries.run([event(BASE + MINUTE)]);
  const original = (await summaries.list())[0]!;
  const { generation: _generation, ...legacy } = original;
  await writeFile(join(home, 'summaries', legacy.filename!), serializeComputerHistorySummary(legacy));
  const savedLegacy = (await summaries.get(legacy.id))!;
  assert.notEqual(savedLegacy.documentRevision, original.documentRevision);
  assert.deepEqual(savedLegacy, { ...legacy, documentRevision: savedLegacy.documentRevision });
  now = BASE + 72 * 60 * MINUTE;
  await summaries.run([]);
  const rollup = (await summaries.get(`6h-${BASE}`))!;
  assert.deepEqual(rollup.generation!.rawEvidenceRanges, [[BASE, BASE + TEN_MINUTES]]);
  await summaries.clearInterval(BASE - MINUTE, BASE - MINUTE);
  assert.deepEqual(await summaries.list(), [savedLegacy, rollup]);
  await rm(join(home, 'summaries', legacy.filename!));
  await summaries.clearInterval(BASE + MINUTE, BASE + MINUTE);
  assert.deepEqual(await summaries.list(), []);
});

test('interval clear fences a late model result before deleting affected summaries', async (t) => {
  const home = await fixture(t);
  const entered = deferred<AbortSignal>();
  const result = deferred<ComputerHistorySummaryContent>();
  const summaries = new ComputerHistorySummaries({
    home, now: () => BASE + TEN_MINUTES,
    generate: async (_input, signal) => { entered.resolve(signal); return result.promise; },
  });
  const running = summaries.run([event(BASE + MINUTE)]);
  const signal = await entered.promise;
  const clearing = summaries.clearInterval(BASE, BASE + TEN_MINUTES);
  assert.equal(signal.aborted, true);
  result.resolve(CONTENT);
  await Promise.all([running, clearing]);
  assert.deepEqual(await summaries.list(), []);
});

test('rejects malicious model metadata, malformed suggestions and oversized content', async (t) => {
  const home = await fixture(t);
  for (const value of [
    { ...CONTENT, id: '../../owned' },
    { ...CONTENT, start: '2020-01-01', end: '2030-01-01' },
    { ...CONTENT, sourceIds: ['/private/raw.jsonl'] },
    { ...CONTENT, applications: ['Invented'] },
    { ...CONTENT, path: '/private/raw.jsonl' },
    { ...CONTENT, title: 'x'.repeat(513) },
    { ...CONTENT, description: 'x'.repeat(2_049) },
    { ...CONTENT, body: 'x'.repeat(48 * 1024 + 1) },
    { ...CONTENT, title: '\u4e2d'.repeat(171) },
    { ...CONTENT, suggestion: { type: 'command', name: 'Run', description: 'Run' } },
    { ...CONTENT, suggestion: { ...CONTENT.suggestion, command: 'rm -rf /' } },
    { ...CONTENT, suggestion: { ...CONTENT.suggestion, name: 'x'.repeat(257) } },
    { ...CONTENT, suggestion: { ...CONTENT.suggestion, description: 'x'.repeat(2_049) } },
    { ...CONTENT, suggestion: null },
    { title: 'Missing fields' },
  ]) {
    const summaries = new ComputerHistorySummaries({
      home,
      now: () => BASE + TEN_MINUTES,
      generate: async () => value as ComputerHistorySummaryContent,
    });
    await assert.rejects(summaries.run([event(BASE + MINUTE)]));
    assert.deepEqual(await summaries.list(), []);
  }
});

test('generation failure propagates and leaves the window available for retry', async (t) => {
  const home = await fixture(t);
  let fail = true;
  const summaries = new ComputerHistorySummaries({
    home,
    now: () => BASE + TEN_MINUTES,
    generate: async () => {
      if (fail) throw new Error('provider failed');
      return { ...CONTENT, suggestion: undefined };
    },
  });
  await assert.rejects(summaries.run([event(BASE + MINUTE)]), /provider failed/);
  assert.deepEqual(await summaries.list(), []);
  fail = false;
  await summaries.run([event(BASE + MINUTE)]);
  assert.equal((await summaries.list()).length, 1);
});

test('invalid old leaf isolates retries and recovery supplies new windows without changing pinned context', async (t) => {
  const home = await fixture(t);
  let now = BASE + 21 * MINUTE;
  let invalid = true;
  const inputs: ComputerHistorySummaryInput[] = [];
  const summaries = new ComputerHistorySummaries({
    home, now: () => now,
    generate: async (input) => {
      inputs.push(input);
      if (invalid && input.start === new Date(BASE).toISOString()) {
        throw Object.assign(new Error('invalid model response'), { code: 'invalid_summary' });
      }
      return { ...CONTENT, body: `Recovered summary ${input.start}` };
    },
  });
  const events = [event(BASE + MINUTE), event(BASE + 11 * MINUTE)];
  await assert.rejects(summaries.run(events), (error) => {
    assert.ok(error instanceof ComputerHistorySummaryRunError);
    assert.equal(error.attempted, 2);
    assert.equal(error.generated, 1);
    assert.equal(error.providerUnavailable, false);
    assert.deepEqual(error.failures, [{ id: `10min-${BASE}`, nextRetryAt: now + TEN_MINUTES }]);
    return true;
  });
  assert.deepEqual((await summaries.list()).map(({ id }) => id), [`10min-${BASE + TEN_MINUTES}`]);
  assert.equal(inputs[1]!.priorContext, undefined);
  await assert.rejects(summaries.run(events), (error) =>
    error instanceof ComputerHistorySummaryRunError && error.attempted === 0,
  );
  assert.equal(inputs.length, 2);
  now += TEN_MINUTES;
  events.push(event(BASE + 21 * MINUTE));
  await assert.rejects(summaries.run(events), (error) =>
    error instanceof ComputerHistorySummaryRunError && error.generated === 1 && error.attempted === 2 &&
    error.nextRetryAt === now + 2 * TEN_MINUTES,
  );
  invalid = false;
  now += 2 * TEN_MINUTES;
  await summaries.run(events);
  const leaves = await summaries.list();
  assert.equal(leaves.length, 3);
  assert.deepEqual(leaves[1]!.generation!.priorContextIds, []);
  assert.deepEqual(leaves[2]!.generation!.priorContextIds, [leaves[1]!.id]);
  const count = inputs.length;
  await summaries.run(events);
  assert.equal(inputs.length, count);
  events.push(event(BASE + 31 * MINUTE));
  await summaries.run(events);
  assert.match(JSON.stringify(inputs.at(-1)!.priorContext), /Recovered summary/);
  assert.ok(inputs.at(-1)!.priorContext!.some(({ id }) => id === leaves[2]!.id));
  now = BASE + SIX_HOURS;
  await summaries.run(events);
  assert.deepEqual((await summaries.get(`6h-${BASE}`))!.sourceIds, [...leaves.map(({ id }) => id), `10min-${BASE + 3 * TEN_MINUTES}`]);
});

test('evidence and privacy revisions reset only applicable retries, manual retry remains bounded', async (t) => {
  const home = await fixture(t);
  let invalid = true;
  const inputs: ComputerHistorySummaryInput[] = [];
  const summaries = new ComputerHistorySummaries({
    home, now: () => BASE + TEN_MINUTES,
    generate: async (input) => {
      inputs.push(input);
      return invalid ? { ...CONTENT, body: '' } : CONTENT;
    },
  });
  const events = [{ ...event(BASE + MINUTE), content: 'ONLY_WITH_CONSENT' }];
  await assert.rejects(summaries.run(events, { includeText: true, scopeKey: 'a' }));
  await assert.rejects(summaries.run(events, { includeText: true, scopeKey: 'a', retryFailed: true }));
  assert.equal(inputs.length, 2);
  await assert.rejects(summaries.run(events, { includeText: false, scopeKey: 'b' }));
  assert.equal(inputs.length, 3);
  assert.doesNotMatch(JSON.stringify(inputs[2]), /ONLY_WITH_CONSENT/);
  events.push({ ...event(BASE + 2 * MINUTE), content: 'LATE_UPDATE' });
  invalid = false;
  await summaries.run(events, { includeText: false, scopeKey: 'b' });
  assert.equal(inputs.length, 4);
  assert.equal((await summaries.list())[0]!.generation!.scopeKey, 'b');
});

test('automatic invalid-output retries back off up to six hours without permanently abandoning a window', async (t) => {
  const home = await fixture(t);
  let now = BASE + TEN_MINUTES;
  let invalid = true;
  const summaries = new ComputerHistorySummaries({
    home, now: () => now,
    generate: async () => invalid ? { ...CONTENT, body: '' } : CONTENT,
  });
  const events = [event(BASE + MINUTE)];
  for (const minutes of [10, 20, 40, 80, 160, 320, 360, 360]) {
    await assert.rejects(summaries.run(events), (error) => {
      assert.ok(error instanceof ComputerHistorySummaryRunError);
      assert.equal(error.attempted, 1);
      assert.equal(error.nextRetryAt, now + minutes * MINUTE);
      return true;
    });
    now += minutes * MINUTE;
  }
  invalid = false;
  await summaries.run(events);
  assert.ok(await summaries.get(`10min-${BASE}`));
});

test('poison leaves spend at most six calls per run and cannot starve untouched windows', async (t) => {
  const home = await fixture(t);
  let calls = 0;
  let invalid = true;
  const summaries = new ComputerHistorySummaries({
    home, now: () => BASE + 100 * MINUTE,
    generate: async () => {
      calls++;
      if (invalid) throw Object.assign(new SyntaxError('Synthetic invalid JSON'), { code: 'invalid_summary' });
      return CONTENT;
    },
  });
  const events = Array.from({ length: 10 }, (_, index) => event(BASE + index * TEN_MINUTES));
  await assert.rejects(summaries.run(events), (error) =>
    error instanceof ComputerHistorySummaryRunError && error.attempted === 6,
  );
  invalid = false;
  await assert.rejects(summaries.run(events), (error) =>
    error instanceof ComputerHistorySummaryRunError && error.attempted === 4 && error.generated === 4,
  );
  assert.equal(calls, 10);
  assert.equal((await summaries.list()).length, 4);
  await summaries.run(events, { retryFailed: true });
  assert.equal(calls, 16);
  assert.equal((await summaries.list()).length, 10);
  await summaries.run(events);
  const converged = calls;
  await summaries.run(events);
  assert.equal(calls, converged);
});

test('provider-wide failures stop immediately and share cooldown without poisoning individual windows', async (t) => {
  const home = await fixture(t);
  let calls = 0;
  let unavailable = true;
  const summaries = new ComputerHistorySummaries({
    home, now: () => BASE + 21 * MINUTE,
    generate: async () => {
      calls++;
      if (unavailable) throw new ComputerHistorySummaryProviderError('service unavailable');
      return CONTENT;
    },
  });
  const events = [event(BASE + MINUTE), event(BASE + 11 * MINUTE)];
  await assert.rejects(summaries.run(events), (error) =>
    error instanceof ComputerHistorySummaryRunError && error.providerUnavailable && error.attempted === 1,
  );
  await assert.rejects(summaries.run(events), (error) =>
    error instanceof ComputerHistorySummaryRunError && error.providerUnavailable && error.attempted === 0,
  );
  assert.equal(calls, 1);
  unavailable = false;
  await summaries.run(events, { retryFailed: true });
  assert.equal(calls, 3);
  assert.equal((await summaries.list()).length, 2);
});

test('provider cooldown is not shortened by an earlier window-local retry deadline', async (t) => {
  const home = await fixture(t);
  let now = BASE + 21 * MINUTE;
  let unavailable = false;
  const summaries = new ComputerHistorySummaries({
    home, now: () => now,
    generate: async (input) => {
      if (unavailable) throw new ComputerHistorySummaryProviderError('outage');
      return input.start === new Date(BASE).toISOString() ? { ...CONTENT, body: '' } : CONTENT;
    },
  });
  await assert.rejects(summaries.run([event(BASE + MINUTE)]));
  now += 5 * MINUTE;
  unavailable = true;
  await assert.rejects(summaries.run([event(BASE + MINUTE), event(BASE + 11 * MINUTE)]), (error) => {
    assert.ok(error instanceof ComputerHistorySummaryRunError);
    assert.equal(error.failures.length, 2);
    assert.equal(error.providerUnavailable, true);
    assert.equal(error.nextRetryAt, now + TEN_MINUTES);
    return true;
  });
});

test('unknown authorization failures and failed storage never become per-window retries', async (t) => {
  const home = await fixture(t);
  const denied = Object.assign(new Error('Summary consent revoked'), { code: 'permission_denied' });
  let mode: 'denied' | 'storage' | 'ok' = 'denied';
  let calls = 0;
  const summaries = new ComputerHistorySummaries({
    home, now: () => BASE + 21 * MINUTE,
    generate: async () => {
      calls++;
      if (mode === 'denied') throw denied;
      if (mode === 'storage') await writeFile(join(home, 'summaries'), 'not a directory');
      return CONTENT;
    },
  });
  const events = [event(BASE + MINUTE), event(BASE + 11 * MINUTE)];
  await assert.rejects(summaries.run(events), (error) => error === denied);
  assert.equal(calls, 1);
  mode = 'storage';
  await assert.rejects(summaries.run(events), (error) => {
    assert.ok(error instanceof Error);
    assert.ok(!(error instanceof ComputerHistorySummaryRunError));
    return true;
  });
  assert.equal(calls, 2);
  await rm(join(home, 'summaries'));
  mode = 'ok';
  await summaries.run(events);
  assert.equal(calls, 4);
  assert.equal((await summaries.list()).length, 2);
});

test('cancel after an isolated failure drains the current model and clears retry state', async (t) => {
  const home = await fixture(t);
  const started = deferred<void>();
  const released = deferred<ComputerHistorySummaryContent>();
  let calls = 0;
  const summaries = new ComputerHistorySummaries({
    home, now: () => BASE + 21 * MINUTE,
    generate: async () => {
      calls++;
      if (calls === 1) return { ...CONTENT, body: '' };
      if (calls === 2) { started.resolve(); return released.promise; }
      return CONTENT;
    },
  });
  const events = [event(BASE + MINUTE), event(BASE + 11 * MINUTE)];
  const running = summaries.run(events);
  await started.promise;
  const cancelling = summaries.cancel();
  released.resolve(CONTENT);
  await Promise.all([running, cancelling]);
  assert.deepEqual(await summaries.list(), []);
  await summaries.run(events);
  assert.equal(calls, 4);
  assert.equal((await summaries.list()).length, 2);
});

test('rollups preserve full accepted child bodies within Host limits without changing archive generations', async (t) => {
  const home = await fixture(t);
  const inputs: ComputerHistorySummaryInput[] = [];
  const options = { includeText: true, scopeKey: 'allowed' };
  let now = BASE + 3 * TEN_MINUTES;
  const bodies = ['Observed context. ', '\u4e2d\ud83d\ude80 "\\\n'].map((sample, index) => {
    const heading = `## Task ${index}\n`;
    const tail = `\nFINAL_DECISION_${index}: load testing remains required.`;
    const prefix = heading + sample.repeat(Math.floor(
      (48 * 1024 - Buffer.byteLength(heading + tail)) / Buffer.byteLength(sample),
    ));
    return prefix + 'x'.repeat(48 * 1024 - Buffer.byteLength(prefix + tail)) + tail;
  });
  const escapedSample = '"\\\n\t\u0001';
  const escapedTail = '\nFINAL_ESCAPED_DECISION: approval remains pending.';
  const available = 64 * 1024 - Buffer.byteLength(JSON.stringify({ ...CONTENT, body: escapedTail }));
  const escaped = escapedSample.repeat(Math.floor(available / (Buffer.byteLength(JSON.stringify(escapedSample)) - 2)));
  const padding = 64 * 1024 - Buffer.byteLength(JSON.stringify({ ...CONTENT, body: escaped + escapedTail }));
  bodies.push(escaped + 'x'.repeat(padding) + escapedTail);
  const summaries = new ComputerHistorySummaries({
    home, now: () => now,
    generate: async (input) => {
      inputs.push(input);
      return input.level === '10min'
        ? { ...CONTENT, body: bodies[(Date.parse(input.start) - BASE) / TEN_MINUTES]! }
        : CONTENT;
    },
  });
  const events = bodies.map((_, index) => ({
    ...event(BASE + index * TEN_MINUTES + MINUTE), content: `Observed task ${index}`,
  }));
  await summaries.run(events, options);
  const children = await summaries.list();
  assert.equal(children.length, 3);
  assert.ok(children.slice(0, 2).every((child) => Buffer.byteLength(child.content.body) === 48 * 1024));
  assert.equal(Buffer.byteLength(JSON.stringify(children[2]!.content)), 64 * 1024);
  now = BASE + SIX_HOURS;
  await summaries.run(events, { ...options, includeText: false });
  await summaries.run([], { ...options, scopeKey: 'excluded' });
  assert.equal(inputs.length, 3, 'text opt-out and a different scope must not admit rich children');
  await summaries.run(events, options);
  assert.equal(inputs.length, 4);
  const rollup = inputs[3]!;
  assert.equal(rollup.level, '6h');
  assert.deepEqual(decodeComputerHistorySummaryInput(rollup), rollup);
  for (const child of children) {
    const pieces = rollup.evidence.filter(({ id }) => id === child.id || id.startsWith(`${child.id}:part-`));
    const reconstructed = pieces.map(({ text }, index) => {
      if (index === 0) return text;
      const prefix = `Continuation of child summary ${child.id}:\n`;
      assert.ok(text.startsWith(prefix), 'continuations must identify their original child');
      return text.slice(prefix.length);
    }).join('');
    assert.ok(reconstructed.endsWith(`Body:\n${child.content.body}`), 'the complete child body must reach the rollup');
  }
  const reconstructed = rollup.evidence.map(({ text }) => text).join('');
  assert.doesNotMatch(reconstructed, /\[truncated\]|\ufffd/);
  assert.ok(rollup.evidence.every(({ text }) => Buffer.byteLength(text) <= 32 * 1024));
  assert.ok(rollup.evidence.every(({ text }) => Buffer.byteLength(JSON.stringify(text)) <= 32 * 1024));
  assert.ok(Buffer.byteLength(JSON.stringify(rollup.evidence)) <= 224 * 1024);
  const stored = await summaries.list();
  const parent = stored.find(({ level }) => level === '6h')!;
  assert.deepEqual(parent.sourceIds, children.map(({ id }) => id));
  for (const child of children) {
    assert.deepEqual(stored.find(({ id }) => id === child.id), child);
    assert.equal(parent.generation!.version, child.generation!.version);
  }
  await summaries.close();
  const restarted = new ComputerHistorySummaries({
    home, now: () => now,
    generate: async () => assert.fail('unchanged archived generations must not regenerate'),
  });
  t.after(() => restarted.close());
  await restarted.run(events, options);
  assert.deepEqual(await restarted.list(), stored);
});

test('saved workflow proposals reach bounded prior and rollup headers without losing consent or deletion provenance', async (t) => {
  const home = await fixture(t);
  const options = { includeText: true, scopeKey: 'allowed' };
  let now = BASE + 2 * TEN_MINUTES;
  const proposals = [
    { type: 'skill' as const, name: 'Regression comparison', description: 'Compare outputs "\\\n<untrusted> before approval.' },
    { type: 'automation' as const, name: 'Weekly review', description: 'Review the observed weekly report; timing needs confirmation.' },
  ];
  const inputs: ComputerHistorySummaryInput[] = [];
  const summaries = new ComputerHistorySummaries({
    home, now: () => now,
    generate: async (input) => {
      inputs.push(input);
      const { suggestion: _suggestion, ...content } = CONTENT;
      const proposal = input.level === '10min' ? proposals[(Date.parse(input.start) - BASE) / TEN_MINUTES] : proposals[0];
      return {
        ...content, description: 'Observed work. '.repeat(130), body: 'Recorded task details.\n'.repeat(1800),
        ...(proposal ? { suggestion: proposal } : {}),
      };
    },
  });
  const events = [1, 11, 21].map((minute) => ({ ...event(BASE + minute * MINUTE), content: 'Synthetic observed steps' }));
  await summaries.run(events, options);
  const children = await summaries.list();
  now = BASE + 3 * TEN_MINUTES;
  await summaries.run(events, options);
  const readProposal = (text: string) => {
    const header = text.split('\n').find((line) => line.startsWith('Previously proposed workflow'));
    assert.ok(header, 'proposal metadata must survive before the bounded body');
    assert.ok(text.indexOf(header) < text.indexOf('Body:\n'));
    assert.match(header, /untrusted proposal; installation and approval unknown/);
    return JSON.parse(header.slice(header.indexOf(': ') + 2));
  };
  const prior = inputs[2]!.priorContext!;
  assert.deepEqual(prior.map(({ text }) => readProposal(text)), proposals);
  assert.ok(prior.every(({ text }) => text.endsWith('[truncated]')));
  assert.ok(Buffer.byteLength(JSON.stringify(prior)) <= 8 * 1024);
  const calls = inputs.length;
  now = BASE + SIX_HOURS;
  await summaries.run([], { ...options, includeText: false });
  await summaries.run([], { ...options, scopeKey: 'excluded' });
  assert.equal(inputs.length, calls, 'proposals inherit the summary consent and scope restrictions');
  await summaries.run(events, options);
  const rollup = inputs.at(-1)!;
  assert.equal(rollup.level, '6h');
  assert.deepEqual(decodeComputerHistorySummaryInput(rollup), rollup);
  for (const [index, child] of children.entries()) {
    assert.deepEqual(readProposal(rollup.evidence.find(({ id }) => id === child.id)!.text), proposals[index]);
    assert.deepEqual(await summaries.get(child.id), child, 'header changes must not force a leaf regeneration');
  }
  const rolled = await summaries.list();
  const parent = rolled.find(({ level }) => level === '6h')!;
  assert.deepEqual(parent.sourceIds, rolled.filter(({ level }) => level === '10min').map(({ id }) => id));
  now = BASE + SIX_HOURS + TEN_MINUTES;
  events.push({ ...event(BASE + SIX_HOURS + MINUTE), content: 'Continued synthetic work' });
  await summaries.run(events, options);
  const next = inputs.at(-1)!;
  assert.equal(next.level, '10min');
  assert.deepEqual(next.priorContext!.map(({ id }) => id), [parent.id]);
  assert.deepEqual(readProposal(next.priorContext![0]!.text), proposals[0]);
  const stored = await summaries.list();
  await summaries.close();
  const reopened = new ComputerHistorySummaries({
    home, now: () => now, generate: async () => assert.fail('saved proposal inputs must converge'),
  });
  t.after(() => reopened.close());
  await reopened.run(events, options);
  assert.deepEqual(await reopened.list(), stored);
  now = BASE + 72 * 60 * MINUTE;
  await reopened.clearInterval(BASE + MINUTE, BASE + MINUTE);
  assert.deepEqual(await reopened.list(), [], 'proposal consumers keep transitive deletion coverage after expiry');
});

for (const changedInput of ['continuation', 'child-suggestion', 'prior-suggestion', 'unchanged'] as const) test(`saved rollup ${changedInput} inputs preserve archives and migrate only when needed`, async (t) => {
  const home = await fixture(t);
  const options = { includeText: true, scopeKey: 'allowed' };
  const tail = 'FINAL_DECISION: approval remains pending.';
  let now = BASE;
  const inputs: ComputerHistorySummaryInput[] = [];
  const { suggestion, ...withoutSuggestion } = CONTENT;
  const summaries = new ComputerHistorySummaries({
    home, now: () => now,
    generate: async (input) => {
      inputs.push(input);
      return {
        ...withoutSuggestion,
        ...((changedInput === 'child-suggestion' && input.level === '10min' &&
          Date.parse(input.start) >= BASE) || (changedInput === 'prior-suggestion' &&
          Date.parse(input.start) < BASE) ? { suggestion } : {}),
        body: changedInput === 'continuation' && input.level === '10min' &&
          input.start === new Date(BASE).toISOString()
          ? `${'Observed context. '.repeat(2700)}${tail}` : CONTENT.body,
      };
    },
  });
  const priorEvent = { ...event(BASE - MINUTE), content: 'Earlier work' };
  await summaries.run([priorEvent], options);
  const priorSummaries = await summaries.list();
  now = BASE + 2 * TEN_MINUTES;
  const events = [priorEvent, ...[1, 11].map((minute) => ({
    ...event(BASE + minute * MINUTE), content: 'Current work',
  }))];
  await summaries.run(events, options);
  const leaves = (await summaries.list()).filter((summary) => summary.level === '10min' &&
    Date.parse(summary.start) >= BASE);
  now = BASE + SIX_HOURS;
  await summaries.run(events, options);
  const parent = (await summaries.get(`6h-${BASE}`))!;
  const parentInput = inputs.find((input) => input.level === '6h' && input.start === parent.start)!;
  const previous = [...parentInput.priorContext!].reverse().map(({ id }) =>
    priorSummaries.find((summary) => summary.id === id)!);
  assert.ok(previous.length > 0 && previous.every(Boolean));
  const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const legacyGeneration = (summary: StoredComputerHistorySummary) => {
    const { rawSourceRevision: _raw, ...generation } = summary.generation!;
    return generation;
  };
  // Legacy identity included full saved content even when model inputs omitted
  // suggestion metadata or clipped a child to a single evidence item.
  const sourceRevision = digest([
    leaves.map((child) => [child.id, child.eventCount, child.applications, child.content, legacyGeneration(child)]),
    digest(previous.map((summary) => [summary.id, summary.eventCount, summary.content, legacyGeneration(summary)])),
  ]);
  const legacy = {
    ...parent,
    content: { ...CONTENT, body: 'Reviewed work; the final decision was absent from the supplied sample.' },
    generation: { ...parent.generation!, sourceRevision },
  };
  const parentPath = join(home, 'summaries', parent.filename!);
  const legacyBytes = serializeComputerHistorySummary(legacy);
  await writeFile(parentPath, legacyBytes);
  await summaries.close();
  const denied = new ComputerHistorySummaries({
    home, now: () => now,
    generate: async () => assert.fail('incomplete, expired or ineligible archives must not regenerate'),
  });
  const unchanged = async () => assert.equal(await readFile(parentPath, 'utf8'), legacyBytes);
  now = BASE + 72 * 60 * MINUTE;
  await denied.run([], options);
  await unchanged();
  now = BASE + SIX_HOURS;
  for (const missing of [[leaves[1]!], priorSummaries]) {
    const files = await Promise.all(missing.map(async (summary) => ({
      path: join(home, 'summaries', summary.filename!),
      bytes: await readFile(join(home, 'summaries', summary.filename!)),
    })));
    for (const file of files) await rm(file.path);
    await denied.run([], options);
    await unchanged();
    for (const file of files) await writeFile(file.path, file.bytes);
  }
  await denied.run([], { ...options, includeText: false });
  await denied.run([], { ...options, scopeKey: 'excluded' });
  await unchanged();
  if (changedInput === 'unchanged') {
    await denied.run(events, options);
    await unchanged();
    await denied.close();
    return;
  }
  await denied.close();

  let mode: 'failure' | 'held' | 'success' = 'failure';
  const started = deferred<void>();
  const released = deferred<ComputerHistorySummaryContent>();
  const repairedInputs: ComputerHistorySummaryInput[] = [];
  const repair = new ComputerHistorySummaries({
    home, now: () => now,
    generate: async (input) => {
      repairedInputs.push(input);
      assert.equal(input.level, '6h');
      assert.equal(input.start, parent.start);
      if (changedInput === 'continuation') {
        assert.ok(input.evidence.some(({ text }) => text.includes(tail)), 'repair must deliver the omitted decision');
      } else {
        const evidence = changedInput === 'child-suggestion' ? input.evidence : input.priorContext!;
        assert.ok(evidence.some(({ text }) => text.includes(JSON.stringify(suggestion))),
          'repair must deliver previously omitted workflow metadata');
      }
      if (mode === 'failure') throw new Error('Synthetic repair failure');
      if (mode === 'held') { started.resolve(); return released.promise; }
      return { ...CONTENT, body: tail };
    },
  });
  const unchangedSummaries = (await repair.list()).filter((summary) => summary.id !== parent.id);
  await assert.rejects(repair.run(events, options), /Synthetic repair failure/);
  await unchanged();
  mode = 'held';
  const pending = repair.run(events, options);
  await started.promise;
  const cancelling = repair.cancel();
  released.resolve(CONTENT);
  await Promise.all([pending, cancelling]);
  await unchanged();
  mode = 'success';
  await repair.run(events, options);
  assert.equal(repairedInputs.length, 3);
  const updated = (await repair.get(parent.id))!;
  assert.equal(updated.content.body, tail);
  assert.notEqual(updated.generation!.sourceRevision, sourceRevision);
  assert.equal(updated.generation!.version, parent.generation!.version);
  assert.deepEqual(updated.sourceIds, parent.sourceIds);
  for (const summary of unchangedSummaries) assert.deepEqual(await repair.get(summary.id), summary);
  await repair.close();
  const reopened = new ComputerHistorySummaries({
    home, now: () => now,
    generate: async () => assert.fail('repaired rollups must converge across restart'),
  });
  t.after(() => reopened.close());
  await reopened.run(events, options);
  assert.deepEqual(await reopened.get(parent.id), updated);
});

test('maximal escaped multilingual children stay within the 6h item and encoded input budgets', async (t) => {
  const home = await fixture(t);
  const inputs: ComputerHistorySummaryInput[] = [];
  const header = {
    title: '\u4e2d'.repeat(170),
    description: '\u4e2d'.repeat(682),
    body: 'BODY_START\n',
  };
  const sample = '\u4e2d\ud83d\ude80"\\\n\u0001';
  const available = 64 * 1024 - Buffer.byteLength(JSON.stringify(header));
  const body = header.body + sample.repeat(Math.floor(available / (Buffer.byteLength(JSON.stringify(sample)) - 2)));
  const content: ComputerHistorySummaryContent = {
    ...header,
    body: body + 'x'.repeat(64 * 1024 - Buffer.byteLength(JSON.stringify({ ...header, body }))),
  };
  const summaries = new ComputerHistorySummaries({
    home,
    now: () => BASE + SIX_HOURS,
    generate: async (input) => {
      inputs.push(input);
      return content;
    },
  });
  const events = Array.from({ length: 36 }, (_, i) => event(BASE + i * TEN_MINUTES));
  for (let i = 0; i < 7; i++) await summaries.run(events);
  const rollup = inputs.at(-1)!;
  assert.equal(rollup.level, '6h');
  assert.deepEqual(decodeComputerHistorySummaryInput(rollup), rollup);
  assert.ok(rollup.evidence.length <= 108);
  assert.ok(Buffer.byteLength(JSON.stringify(rollup.evidence)) <= 224 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(rollup)) < 256 * 1024);
  for (const index of events.keys()) {
    const child = rollup.evidence.find(({ id }) => id === `10min-${BASE + index * TEN_MINUTES}`);
    assert.ok(child, 'each canonical child remains represented');
    assert.ok(child.text.includes('BODY_START'), 'each canonical child retains its body introduction');
    assert.ok(child.text.endsWith('[truncated]'), 'over-budget child introductions must disclose omitted text');
  }
  assert.doesNotMatch(JSON.stringify(rollup.evidence), /\ufffd/);
  assert.ok(rollup.evidence.every(({ text }) => Buffer.byteLength(text) <= 32 * 1024));
  assert.equal((await summaries.list()).length, 37);
});

test('archive scan streams documents, supports early close and rejects duplicate identities and unsafe entries', async (t) => {
  const home = await fixture(t);
  const summaries = new ComputerHistorySummaries({
    home, now: () => BASE + 21 * MINUTE, generate: async () => CONTENT,
  });
  await summaries.run([event(BASE + MINUTE), event(BASE + 11 * MINUTE)]);
  const expected = await summaries.list();
  const collect = async () => {
    const result = [];
    for await (const summary of summaries.scan()) result.push(summary);
    return result.sort((a, b) => a.id.localeCompare(b.id));
  };
  assert.deepEqual(await collect(), expected);
  const scan = summaries.scan();
  assert.equal((await scan.next()).done, false);
  await scan.return(undefined);
  assert.deepEqual(await collect(), expected);

  const directory = join(home, 'summaries');
  const duplicate = join(directory, `${expected[0]!.id}.md`);
  await writeFile(duplicate, serializeComputerHistorySummary({ ...expected[0]!, filename: undefined }));
  for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(collect(), /Invalid/);
  await rm(duplicate);
  const unsafe = join(directory, 'unsafe.md');
  await symlink(join(directory, expected[0]!.filename!), unsafe);
  await assert.rejects(collect(), /Invalid/);
  await rm(unsafe);
  await mkdir(unsafe);
  await assert.rejects(collect(), /Invalid/);
  await rm(unsafe, { recursive: true });
  await writeFile(unsafe, 'corrupt document');
  await assert.rejects(collect(), /Invalid/);
  await rm(unsafe);
  assert.deepEqual(await collect(), expected);
});

test('archive scan cannot finish successfully across privacy deletion', async (t) => {
  const home = await fixture(t);
  const summaries = new ComputerHistorySummaries({
    home, now: () => BASE + 21 * MINUTE, generate: async () => CONTENT,
  });
  await summaries.run([event(BASE + MINUTE), event(BASE + 11 * MINUTE)]);
  const scan = summaries.scan();
  assert.equal((await scan.next()).done, false);
  await summaries.clear(-Infinity);
  await assert.rejects(scan.next(), /Invalid/);
  assert.deepEqual(await summaries.list(), []);
});

test('read snapshot rejects mixed rollup coverage across two scans and a fresh query converges', async (t) => {
  const home = await fixture(t);
  let changed = false;
  const summaries = new ComputerHistorySummaries({
    home, now: () => BASE + SIX_HOURS,
    generate: async (input) => {
      if (changed && input.level === '6h') {
        throw Object.assign(new Error('invalid rollup'), { code: 'invalid_summary' });
      }
      return { ...CONTENT, body: changed ? 'Revised evidence' : 'Original evidence' };
    },
  });
  const original = event(BASE + MINUTE);
  await summaries.run([original]);
  let passes = 0;
  const search = (between: () => Promise<void>) => summaries.withReadSnapshot(async () => {
    const covered = new Set<string>();
    const entries = [];
    passes++;
    for await (const summary of summaries.scan()) {
      if (summary.level !== '6h') continue;
      entries.push(summary);
      for (const id of summary.sourceIds) covered.add(id);
    }
    await between();
    for await (const summary of summaries.scan()) {
      if (summary.level === '10min' && !covered.has(summary.id)) entries.push(summary);
    }
    return entries;
  });
  await assert.rejects(search(async () => {
    changed = true;
    await assert.rejects(
      summaries.run([original, event(BASE + 2 * MINUTE), event(BASE + 11 * MINUTE)]),
      ComputerHistorySummaryRunError,
    );
  }), ComputerHistorySummarySnapshotError);
  assert.equal(passes, 1, 'a conflicted query must not retry silently');
  const recovered = await search(async () => {});
  assert.deepEqual(recovered.map(({ id }) => id).sort(), [
    `10min-${BASE}`, `10min-${BASE + TEN_MINUTES}`,
  ]);
  assert.ok(recovered.every(({ content }) => content.body === 'Revised evidence'));
});

for (const operation of ['unlink', 'rename'] as const) {
  for (const phase of ['before', 'after'] as const) {
    test(`read snapshot rejects pending publication ${phase} ${operation}`, async (t) => {
      const home = await fixture(t);
      const summaries = new ComputerHistorySummaries({
        home, now: () => BASE + SIX_HOURS, generate: async () => CONTENT,
      });
      const original = event(BASE + MINUTE);
      await summaries.run([original]);
      const stored = await summaries.list();
      const target = join(home, 'summaries', stored.find(({ level }) => level === (operation === 'unlink' ? '6h' : '10min'))!.filename!);
      const entered = deferred<void>();
      const release = deferred<void>();
      const readStarted = deferred<void>();
      const readRelease = deferred<void>();
      let held = false;
      const hold = async (path: unknown, perform: () => Promise<void>) => {
        if (path !== target || held) return perform();
        held = true;
        if (phase === 'after') await perform();
        entered.resolve();
        await release.promise;
        if (phase === 'before') await perform();
      };
      if (operation === 'unlink') {
        const unlink = fs.unlink;
        t.mock.method(fs, 'unlink', (...args: Parameters<typeof unlink>) =>
          hold(args[0], () => unlink(...args)));
      } else {
        const rename = fs.rename;
        t.mock.method(fs, 'rename', (...args: Parameters<typeof rename>) =>
          hold(args[1], () => rename(...args)));
      }
      syncBuiltinESMExports();
      const reading = summaries.withReadSnapshot(async () => {
        const result = await summaries.list();
        readStarted.resolve();
        await readRelease.promise;
        return result;
      });
      const rejected = assert.rejects(reading, ComputerHistorySummarySnapshotError);
      let run: Promise<void> | undefined;
      try {
        await readStarted.promise;
        run = summaries.run([original, event(BASE + 2 * MINUTE)]);
        await entered.promise;
        await assert.rejects(summaries.withReadSnapshot(async () =>
          assert.fail('a read must not start inside a pending filesystem mutation'),
        ), ComputerHistorySummarySnapshotError);
        readRelease.resolve();
        await rejected;
        release.resolve();
        await run;
        const recovered = await summaries.withReadSnapshot(() => summaries.list());
        assert.equal(recovered.length, 2);
        assert.ok(recovered.every(({ eventCount }) => eventCount === 2));
      } finally {
        release.resolve();
        readRelease.resolve();
        await Promise.allSettled([reading, run]);
        t.mock.restoreAll();
        syncBuiltinESMExports();
      }
    });
  }
}

test('read snapshot permits pending model work, rejects maintenance overlap and preserves read failures', async (t) => {
  const home = await fixture(t);
  const entered = deferred<void>();
  const release = deferred<ComputerHistorySummaryContent>();
  const summaries = new ComputerHistorySummaries({
    home, now: () => BASE + TEN_MINUTES,
    generate: async () => {
      entered.resolve();
      return release.promise;
    },
  });
  const run = summaries.run([event(BASE + MINUTE)]);
  await entered.promise;
  try {
    assert.deepEqual(await summaries.withReadSnapshot(() => summaries.list()), []);
    const cancelling = summaries.cancel();
    await assert.rejects(summaries.withReadSnapshot(async () => []), ComputerHistorySummarySnapshotError);
    release.resolve(CONTENT);
    await Promise.all([run, cancelling]);
    assert.deepEqual(await summaries.withReadSnapshot(() => summaries.list()), []);
    await assert.rejects(summaries.withReadSnapshot(async () => {
      await summaries.clear(-Infinity);
      return [];
    }), ComputerHistorySummarySnapshotError);
    const failure = new Error('read denied');
    await assert.rejects(summaries.withReadSnapshot(async () => {
      throw failure;
    }), (error) => error === failure);
  } finally {
    release.resolve(CONTENT);
    await run;
  }
});

test('failed publication invalidates a read snapshot and releases the publication fence', async (t) => {
  const home = await fixture(t);
  const summaries = new ComputerHistorySummaries({
    home, now: () => BASE + TEN_MINUTES, generate: async () => CONTENT,
  });
  const failure = new Error('publication failed');
  t.mock.method(fs, 'rename', async () => { throw failure; });
  syncBuiltinESMExports();
  try {
    await assert.rejects(summaries.withReadSnapshot(async () => {
      await assert.rejects(summaries.run([event(BASE + MINUTE)]), (error) => error === failure);
      return [];
    }), ComputerHistorySummarySnapshotError);
    assert.deepEqual(await summaries.withReadSnapshot(() => summaries.list()), []);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  await summaries.run([event(BASE + MINUTE)]);
  assert.equal((await summaries.withReadSnapshot(() => summaries.list())).length, 1);
});

test('interval clear rejects corrupt summaries but all-clear deletes them without decoding', async (t) => {
  const home = await fixture(t);
  const summaries = new ComputerHistorySummaries({
    home,
    now: () => BASE + TEN_MINUTES,
    generate: async () => CONTENT,
  });
  await summaries.run([event(BASE + MINUTE)]);
  const path = join(home, 'summaries', (await readdir(join(home, 'summaries')))[0]!);
  const original = await readFile(path, 'utf8');
  const metadata = JSON.parse(original.split('\n')[1]!);
  const showItemInFolder = t.mock.fn((_path: string) => {});
  for (const text of [
    'not frontmatter',
    '---\n{invalid}\n---\nbody\n',
    'x'.repeat(128 * 1024 + 1),
    ...[
      { ...metadata, id: '../../elsewhere' },
      { ...metadata, end: new Date(BASE + 2 * TEN_MINUTES).toISOString() },
      { ...metadata, start: new Date(BASE + MINUTE).toISOString() },
      { ...metadata, sourceIds: ['/raw.jsonl'] },
      { ...metadata, sourceIds: [] },
      { ...metadata, eventCount: 0 },
      { ...metadata, content: { ...metadata.content, path: '/raw.jsonl' } },
      ...[null, false, 0, '', 'a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64), `${'a'.repeat(64)}\n`].map((rawSourceRevision) => ({
        ...metadata, generation: { ...metadata.generation, rawSourceRevision },
      })),
      { ...metadata, generation: { ...metadata.generation, version: 4 } },
      ...[undefined, null, 'false', 0].map((includesText) => ({
        ...metadata, generation: { ...metadata.generation, includesText },
      })),
      { ...metadata, generation: { ...metadata.generation, version: 2, includesText: undefined, priorContextIds: undefined } },
      ...[
        undefined, null, ['../private'], [`10min-${BASE}`], [`6h-${BASE}`],
        [`10min-${BASE - TEN_MINUTES}`, `10min-${BASE - TEN_MINUTES}`],
        [`10min-${BASE - 31 * DAY - 2 * TEN_MINUTES}`],
      ].map((priorContextIds) => ({
        ...metadata, generation: { ...metadata.generation, priorContextIds },
      })),
      ...[
        undefined, null, [], [[BASE, BASE]], [[BASE, BASE + TEN_MINUTES + 1]],
        [[BASE - TEN_MINUTES, BASE]], [[BASE, BASE + 2 * TEN_MINUTES]],
        [[BASE + 1, BASE + TEN_MINUTES]], [['0', BASE + TEN_MINUTES]],
        [[-8_640_000_000_600_000, BASE + TEN_MINUTES]],
        [[BASE, BASE + TEN_MINUTES], [BASE - 2 * TEN_MINUTES, BASE - TEN_MINUTES]],
        [[BASE - TEN_MINUTES, BASE], [BASE, BASE + TEN_MINUTES]],
        Array.from({ length: 257 }, () => [BASE, BASE + TEN_MINUTES]),
      ].map((rawEvidenceRanges) => ({
        ...metadata, generation: { ...metadata.generation, rawEvidenceRanges },
      })),
      { ...metadata, generation: { ...metadata.generation, version: 3 } },
    ].map((value) => `---\n${JSON.stringify(value)}\n---\n${CONTENT.body}\n`),
  ]) {
    await writeFile(path, text);
    await assert.rejects(summaries.list());
    await assert.rejects(summaries.reveal(`10min-${BASE}`, showItemInFolder));
    assert.equal(showItemInFolder.mock.callCount(), 0);
    await assert.rejects(summaries.run([]));
    await assert.rejects(summaries.clear(BASE));
    assert.equal(await readFile(path, 'utf8'), text);
    await summaries.clear(Number.NEGATIVE_INFINITY);
    assert.deepEqual(await readdir(join(home, 'summaries')), []);
  }
});

test('reveal resolves only a canonical persisted document, including old or rollup-hidden leaves', async (t) => {
  const home = await fixture(t);
  const generate = t.mock.fn(async () => CONTENT);
  const summaries = new ComputerHistorySummaries({
    home, now: () => BASE + SIX_HOURS, generate,
  });
  await summaries.run([event(BASE + MINUTE)]);
  const directory = join(home, 'summaries');
  const leaf = `10min-${BASE}`;
  const leafPath = join(directory, (await summaries.get(leaf))!.filename!);
  assert.equal((await summaries.list()).length, 2);
  const reopened = new ComputerHistorySummaries({
    home, now: () => BASE + 90 * 86_400_000,
    generate: async () => assert.fail('reveal must not generate'),
  });
  // An unrelated damaged file must not prevent resolving the selected document.
  await writeFile(join(directory, `10min-${BASE + TEN_MINUTES}.md`), 'unrelated corrupt summary');
  const shown: string[] = [];
  const showItemInFolder = (path: string) => { shown.push(path); };
  assert.equal(await reopened.reveal(leaf, showItemInFolder), undefined);
  assert.equal((await reopened.get(leaf))!.content.body, CONTENT.body);
  assert.equal(await reopened.get(`10min-${BASE + 2 * TEN_MINUTES}`), null);
  await assert.rejects(reopened.get(`10min-${BASE + TEN_MINUTES}`));
  await assert.rejects(reopened.get('../notes'));
  assert.deepEqual(shown, [leafPath]);
  for (const id of [
    '../notes', `${leaf}.md`, '0000000000000000', '10min-00', '10min-1',
    `10min-${'1'.repeat(1_000)}`, `10min-${BASE + TEN_MINUTES}`, `10min-${BASE + 2 * TEN_MINUTES}`,
  ]) {
    await assert.rejects(reopened.reveal(id, showItemInFolder));
  }
  await rm(leafPath);
  assert.equal(await reopened.get(leaf), null);
  await assert.rejects(reopened.reveal(leaf, showItemInFolder));
  await mkdir(leafPath);
  await assert.rejects(reopened.get(leaf));
  await assert.rejects(reopened.reveal(leaf, showItemInFolder));
  await rm(leafPath, { recursive: true });
  await writeFile(leafPath, Buffer.from([0xff, 0xfe]));
  await assert.rejects(reopened.get(leaf));
  await assert.rejects(reopened.reveal(leaf, showItemInFolder));
  assert.deepEqual(shown, [leafPath]);
  assert.equal(generate.mock.callCount(), 2);
});

test('all-clear removes only canonical owned summary filenames', async (t) => {
  const home = await fixture(t);
  const directory = join(home, 'summaries');
  await mkdir(directory);
  const owned = [
    `10min-${BASE}.md`, `6h-${BASE}.md`, '10min-0.md', '10min--600000.md',
    '2026-09-14_11-00__10min__Maka-review.md',
    '2026-09-14_12-00__6h__Review.md',
  ];
  const unrelated = [
    'notes.md',
    '2026-09-99_11-00__10min__Invalid-date.md',
    '2026-09-14_11-00__10min__escape..md',
    `10min-${BASE + 1}.md`,
    `6h-${BASE + TEN_MINUTES}.md`,
    '10min-00.md',
    '10min-NaN.md',
    '10min-99999999999999999999.md',
    `10min-${BASE}.md.backup`,
    `.${owned[0]}.tmp`,
  ];
  for (const name of [...owned, ...unrelated]) {
    await writeFile(join(directory, name), 'corrupt');
  }
  const summaries = new ComputerHistorySummaries({
    home,
    generate: async () => assert.fail('clear never invokes the generator'),
  });
  await summaries.clear(Number.NEGATIVE_INFINITY);
  assert.deepEqual((await readdir(directory)).sort(), unrelated.sort());
  for (const name of unrelated) assert.equal(await readFile(join(directory, name), 'utf8'), 'corrupt');
});

test('rejects symlinked homes, summary directories and files without touching their targets', async (t) => {
  const root = await fixture(t);
  const target = join(root, 'target');
  await mkdir(target);
  const linkHome = join(root, 'linked-home');
  await symlink(target, linkHome);
  const showItemInFolder = t.mock.fn((_path: string) => {});
  const create = (home: string) =>
    new ComputerHistorySummaries({
      home,
      now: () => BASE + TEN_MINUTES,
      generate: async () => CONTENT,
    });
  await assert.rejects(create(linkHome).list(), /Invalid/);
  await assert.rejects(create(linkHome).reveal(`10min-${BASE}`, showItemInFolder));
  await assert.rejects(create(linkHome).clear(Number.NEGATIVE_INFINITY), /Invalid/);
  const directoryHome = join(root, 'directory-home');
  await mkdir(directoryHome);
  await symlink(target, join(directoryHome, 'summaries'));
  await assert.rejects(create(directoryHome).run([event(BASE + MINUTE)]), /Invalid/);
  await assert.rejects(create(directoryHome).clear(Number.NEGATIVE_INFINITY), /Invalid/);
  await assert.rejects(create(directoryHome).reveal(`10min-${BASE}`, showItemInFolder));

  const fileHome = join(root, 'file-home');
  const directory = join(fileHome, 'summaries');
  await mkdir(directory, { recursive: true });
  const secret = join(target, 'secret.md');
  await writeFile(secret, 'private');
  await symlink(secret, join(directory, `10min-${BASE}.md`));
  await symlink(target, join(directory, `6h-${BASE}.md`));
  await assert.rejects(create(fileHome).list(), /Invalid/);
  await assert.rejects(create(fileHome).reveal(`10min-${BASE}`, showItemInFolder));
  await assert.rejects(create(fileHome).reveal(`6h-${BASE}`, showItemInFolder));
  assert.equal(showItemInFolder.mock.callCount(), 0);
  await assert.rejects(create(fileHome).clear(BASE), /Invalid/);
  await create(fileHome).clear(Number.NEGATIVE_INFINITY);
  assert.deepEqual(await readdir(directory), []);
  assert.equal(await readFile(secret, 'utf8'), 'private');
});

test('does not swallow non-ENOENT storage failures', async (t) => {
  const home = await fixture(t);
  const directory = join(home, 'summaries');
  await mkdir(directory);
  const summaries = new ComputerHistorySummaries({
    home,
    now: () => BASE + TEN_MINUTES,
    generate: async () => CONTENT,
  });
  if (process.getuid?.() === 0) return t.skip('root bypasses directory permissions');
  try {
    await chmod(directory, 0o500);
    await assert.rejects(summaries.run([event(BASE + MINUTE)]), { code: 'EACCES' });
    await chmod(directory, 0);
    await assert.rejects(summaries.list(), { code: 'EACCES' });
  } finally {
    await chmod(directory, 0o700);
  }
});
