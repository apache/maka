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
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type {
  ComputerHistorySummaryContent,
  ComputerHistorySummaryInput,
} from '@maka/core/computer-history';
import {
  ComputerHistorySummaries,
  serializeComputerHistorySummary,
  summaryEventId,
  type ComputerHistorySummaryEvent,
} from '../computer-history-summaries.js';

const BASE = Date.parse('2026-09-12T00:00:00.000Z');
const MINUTE = 60_000;
const TEN_MINUTES = 10 * MINUTE;
const SIX_HOURS = 6 * 60 * MINUTE;
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
    'generation',
    'id',
    'level',
    'sourceIds',
    'start',
  ]);
  const markdown = await readFile(join(home, 'summaries', `${stored[0]!.id}.md`), 'utf8');
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
      await readFile(join(home, 'summaries', `${summary.id}.md`), 'utf8'),
    );
  }
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
  const bytes = await readFile(join(home, 'summaries', `10min-${BASE}.md`));
  now = BASE + SIX_HOURS;
  await summaries.run([rich, event(BASE + 11 * MINUTE)]);
  assert.equal(inputs.length, 3);
  assert.equal(inputs[2]!.priorContext, undefined);
  assert.doesNotMatch(JSON.stringify(inputs[2]), /RICH_SECRET/);
  assert.equal((await summaries.list()).length, 2);
  assert.deepEqual(await summaries.get(`10min-${BASE}`), original);
  assert.deepEqual(await readFile(join(home, 'summaries', `10min-${BASE}.md`)), bytes);
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
  const path = join(home, 'summaries', `${rollupId}.md`);
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
  const path = join(home, 'summaries', `${parentId}.md`);
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
  assert.deepEqual(descendant.generation!.priorContextIds, [parentId]);
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
  const path = join(home, 'summaries', `${leaf.id}.md`);
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
  const paths = original.map(({ id }) => join(home, 'summaries', `${id}.md`));
  const bytes = await Promise.all(paths.map((path) => readFile(path)));
  events.push(event(BASE + 2 * MINUTE));
  for (const failure of ['failure', 'invalid'] as const) {
    mode = failure;
    await assert.rejects(summaries.run(events));
    assert.deepEqual(await Promise.all(paths.map((path) => readFile(path))), bytes);
  }
  mode = 'held';
  const running = summaries.run(events);
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
  assert.equal(calls, 6);
  // Publishing the first rollup refreshes later prior context within the same run cap.
  await summaries.run(events);
  assert.equal(calls, 7);
  assert.equal((await summaries.list()).length, 5);
  await summaries.run(events);
  assert.equal(calls, 7);
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
  const independentPath = join(home, 'summaries', `${independent.id}.md`);
  const bytes = await readFile(independentPath);
  if (missingSource) await rm(join(home, 'summaries', `10min-${BASE}.md`));
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
  const bytes = await Promise.all(richIds.map((id) => readFile(join(home, 'summaries', `${id}.md`))));
  assert.deepEqual((await summaries.get(richIds[0]!))!.generation!.rawEvidenceRanges, [[BASE, BASE + 4 * TEN_MINUTES]]);
  const beforeRewrite = inputs.length;
  const replacements = events.slice(1, 3);
  await summaries.run(replacements, { scopeKey: 'b' });
  now += 2 * TEN_MINUTES;
  const independentEvent = event(BASE + SIX_HOURS + 21 * MINUTE);
  await summaries.run([independentEvent], { scopeKey: 'b' });
  const independent = (await summaries.get(`10min-${BASE + SIX_HOURS + 2 * TEN_MINUTES}`))!;
  const independentBytes = await readFile(join(home, 'summaries', `${independent.id}.md`));
  assert.deepEqual(
    await Promise.all(richIds.map((id) => readFile(join(home, 'summaries', `${id}.md`)))),
    bytes,
  );
  assert.doesNotMatch(JSON.stringify(inputs.slice(beforeRewrite)), /ANCESTOR_CANARY|rawEvidenceRanges/);
  const calls = inputs.length;
  await create().run([independentEvent, ...replacements].reverse(), { scopeKey: 'b' });
  assert.equal(inputs.length, calls, 'rewrites converge while incompatible rich consumers remain archived');
  const replacementIds = [1, 2].map((index) => `10min-${BASE + index * TEN_MINUTES}`);
  if (missingIntermediates) {
    for (const id of [`10min-${BASE}`, ...replacementIds, `6h-${BASE}`]) {
      await rm(join(home, 'summaries', `${id}.md`));
    }
  }
  now = BASE + 72 * 60 * MINUTE;
  const reopened = create();
  await reopened.clearInterval(BASE + MINUTE, BASE + MINUTE);
  assert.deepEqual((await reopened.list()).map(({ id }) => id),
    [...(missingIntermediates ? [] : replacementIds), independent.id]);
  assert.deepEqual(await readFile(join(home, 'summaries', `${independent.id}.md`)), independentBytes);
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
  const bytes = await readFile(join(home, 'summaries', `${descendantId}.md`));
  now = BASE + 72 * 60 * MINUTE;
  await summaries.clearInterval(BASE + TEN_MINUTES, BASE + 2 * TEN_MINUTES);
  assert.equal(await summaries.get(`6h-${BASE}`), null, 'the selected interval still removes its enclosing document');
  assert.deepEqual(await readFile(join(home, 'summaries', `${descendantId}.md`)), bytes);
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
  await writeFile(join(home, 'summaries', `${original.id}.md`), serializeComputerHistorySummary({
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
  assert.ok((await readFile(join(home, 'summaries', `${descendantId}.md`))).length < 128 * 1024);
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
  const { priorContextIds: _prior, rawEvidenceRanges: _ranges, ...generation } = original.generation!;
  const legacy = (start: number) => ({
    ...original,
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
  await writeFile(join(home, 'summaries', `${legacy.id}.md`), serializeComputerHistorySummary(legacy));
  const savedLegacy = (await summaries.get(legacy.id))!;
  assert.notEqual(savedLegacy.documentRevision, original.documentRevision);
  assert.deepEqual(savedLegacy, { ...legacy, documentRevision: savedLegacy.documentRevision });
  now = BASE + 72 * 60 * MINUTE;
  await summaries.run([]);
  const rollup = (await summaries.get(`6h-${BASE}`))!;
  assert.deepEqual(rollup.generation!.rawEvidenceRanges, [[BASE, BASE + TEN_MINUTES]]);
  await summaries.clearInterval(BASE - MINUTE, BASE - MINUTE);
  assert.deepEqual(await summaries.list(), [savedLegacy, rollup]);
  await rm(join(home, 'summaries', `${legacy.id}.md`));
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

test('maximal accepted multilingual content stays within the 6h input budget', async (t) => {
  const home = await fixture(t);
  const inputs: ComputerHistorySummaryInput[] = [];
  const content: ComputerHistorySummaryContent = {
    title: '\u4e2d'.repeat(170),
    description: '\u4e2d'.repeat(682),
    body: `BODY_START\n${'\u4e2d'.repeat(16_000)}`,
    suggestion: {
      type: 'automation',
      name: '\u4e2d'.repeat(85),
      description: '\u4e2d'.repeat(682),
    },
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
  assert.equal(rollup.evidence.length, 36);
  assert.ok(Buffer.byteLength(JSON.stringify(rollup)) < 256 * 1024);
  assert.ok(rollup.evidence.every(({ text }) => text.endsWith('[truncated]')));
  assert.ok(rollup.evidence.every(({ text }) => text.includes('BODY_START')));
  assert.ok(rollup.evidence.every(({ text }) => Buffer.byteLength(text) <= 32 * 1024));
  assert.equal((await summaries.list()).length, 37);
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
      ...[undefined, null, 'false', 0].map((includesText) => ({
        ...metadata, generation: { ...metadata.generation, includesText },
      })),
      { ...metadata, generation: { ...metadata.generation, version: 2, includesText: undefined, priorContextIds: undefined } },
      ...[
        undefined, null, ['../private'], [`10min-${BASE}`], [`6h-${BASE}`],
        [`10min-${BASE - TEN_MINUTES}`, `10min-${BASE - TEN_MINUTES}`],
        [`10min-${BASE - SIX_HOURS - TEN_MINUTES}`],
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
  assert.equal((await summaries.list()).length, 2);
  const reopened = new ComputerHistorySummaries({
    home, now: () => BASE + 90 * 86_400_000,
    generate: async () => assert.fail('reveal must not generate'),
  });
  // An unrelated damaged file must not turn exact-ID lookup into a directory scan.
  await writeFile(join(directory, `10min-${BASE + TEN_MINUTES}.md`), 'unrelated corrupt summary');
  const shown: string[] = [];
  const showItemInFolder = (path: string) => { shown.push(path); };
  assert.equal(await reopened.reveal(leaf, showItemInFolder), undefined);
  assert.equal((await reopened.get(leaf))!.content.body, CONTENT.body);
  assert.equal(await reopened.get(`10min-${BASE + 2 * TEN_MINUTES}`), null);
  await assert.rejects(reopened.get(`10min-${BASE + TEN_MINUTES}`));
  await assert.rejects(reopened.get('../notes'));
  assert.deepEqual(shown, [join(directory, `${leaf}.md`)]);
  for (const id of [
    '../notes', `${leaf}.md`, '0000000000000000', '10min-00', '10min-1',
    `10min-${'1'.repeat(1_000)}`, `10min-${BASE + TEN_MINUTES}`, `10min-${BASE + 2 * TEN_MINUTES}`,
  ]) {
    await assert.rejects(reopened.reveal(id, showItemInFolder));
  }
  await rm(join(directory, `${leaf}.md`));
  assert.equal(await reopened.get(leaf), null);
  await assert.rejects(reopened.reveal(leaf, showItemInFolder));
  await mkdir(join(directory, `${leaf}.md`));
  await assert.rejects(reopened.get(leaf));
  await assert.rejects(reopened.reveal(leaf, showItemInFolder));
  await rm(join(directory, `${leaf}.md`), { recursive: true });
  await writeFile(join(directory, `${leaf}.md`), Buffer.from([0xff, 0xfe]));
  await assert.rejects(reopened.get(leaf));
  await assert.rejects(reopened.reveal(leaf, showItemInFolder));
  assert.deepEqual(shown, [join(directory, `${leaf}.md`)]);
  assert.equal(generate.mock.callCount(), 2);
});

test('all-clear removes only canonical owned summary filenames', async (t) => {
  const home = await fixture(t);
  const directory = join(home, 'summaries');
  await mkdir(directory);
  const owned = [`10min-${BASE}.md`, `6h-${BASE}.md`, '10min-0.md', '10min--600000.md'];
  const unrelated = [
    'notes.md',
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
