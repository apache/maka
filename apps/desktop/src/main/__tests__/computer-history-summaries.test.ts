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
    window: { title: 'Implementation', urlDomain: 'private-secret.example' },
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
    'end',
    'eventCount',
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
  assert.ok(raw.evidence.length > 0 && raw.evidence.length <= 96);
  assert.ok(Buffer.byteLength(JSON.stringify(raw)) < 60_000);
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
  const summaries = new ComputerHistorySummaries({
    home,
    now: () => BASE + 2 * SIX_HOURS,
    generate: async () => CONTENT,
  });
  await summaries.run([
    event(BASE + MINUTE),
    event(BASE + SIX_HOURS + MINUTE),
    event(BASE + SIX_HOURS + 11 * MINUTE),
  ]);
  assert.equal((await summaries.list()).length, 5);
  await summaries.clear(BASE + SIX_HOURS + TEN_MINUTES);
  const remaining = await summaries.list();
  assert.equal(remaining.length, 3);
  assert.ok(remaining.every(({ end }) => Date.parse(end) <= BASE + SIX_HOURS + TEN_MINUTES));
  assert.equal(remaining.filter(({ level }) => level === '6h').length, 1);
  await summaries.clear(-Infinity);
  assert.deepEqual(await summaries.list(), []);
});

test('interval clear preserves adjacent leaves and removes an overlapping rollup', async (t) => {
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
    new Date(BASE).toISOString(), new Date(BASE + 2 * TEN_MINUTES).toISOString(),
  ]);
  await summaries.clearInterval(BASE + 2 * TEN_MINUTES, BASE + 2 * TEN_MINUTES);
  assert.deepEqual((await summaries.list()).map(({ start }) => start), [new Date(BASE).toISOString()]);
  await assert.rejects(summaries.clearInterval(BASE + 1, BASE), /Invalid history clear interval/);
  await assert.rejects(summaries.clearInterval(-Infinity, BASE), /Invalid history clear interval/);
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
    { ...CONTENT, body: 'x'.repeat(8_193) },
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
    body: '\u4e2d'.repeat(2_730),
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
  assert.ok(Buffer.byteLength(JSON.stringify(rollup)) < 64 * 1024);
  assert.ok(rollup.evidence.every(({ text }) => text.endsWith('[truncated]')));
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
  assert.deepEqual(shown, [join(directory, `${leaf}.md`)]);
  for (const id of [
    '../notes', `${leaf}.md`, '0000000000000000', '10min-00', '10min-1',
    `10min-${'1'.repeat(1_000)}`, `10min-${BASE + TEN_MINUTES}`, `10min-${BASE + 2 * TEN_MINUTES}`,
  ]) {
    await assert.rejects(reopened.reveal(id, showItemInFolder));
  }
  await rm(join(directory, `${leaf}.md`));
  await assert.rejects(reopened.reveal(leaf, showItemInFolder));
  await mkdir(join(directory, `${leaf}.md`));
  await assert.rejects(reopened.reveal(leaf, showItemInFolder));
  await rm(join(directory, `${leaf}.md`), { recursive: true });
  await writeFile(join(directory, `${leaf}.md`), Buffer.from([0xff, 0xfe]));
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
