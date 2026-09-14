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
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { ComputerHistorySummaryContent } from '@maka/core/computer-history';
import {
  ComputerHistorySummaries,
  serializeComputerHistorySummary,
  type ComputerHistorySummaryEvent,
} from '../computer-history-summaries.js';

const BASE = Date.parse('2025-11-02T05:00:00.000Z');
const MINUTE = 60_000;
const TEN_MINUTES = 10 * MINUTE;
const HOUR = 60 * MINUTE;
const CONTENT: ComputerHistorySummaryContent = {
  title: 'Review work',
  description: 'Reviewed the permission flow in the editor.',
  body: '## Permission review\n\nChecked the settings flow and its focused tests.',
  keywords: ['permission flow', 'regression tests'],
};

async function fixture(t: TestContext): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'maka-history-filenames-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

function event(time: number): ComputerHistorySummaryEvent {
  return {
    timestamp: new Date(time).toISOString(),
    kind: 'window.changed',
    app: { name: 'Editor', bundleIdentifier: 'com.example.editor' },
    window: { title: 'Permission flow review' },
  };
}

test('mixed-case titles at the same local clock preserve both summary identities on the current volume', async (t) => {
  const home = await fixture(t);
  const previousTimezone = process.env.TZ;
  process.env.TZ = 'America/New_York';
  t.after(() => {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  });
  const localClock = (time: number) => {
    const date = new Date(time);
    return [date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes()];
  };
  assert.deepEqual(localClock(BASE), localClock(BASE + HOUR));
  assert.notEqual(new Date(BASE).getTimezoneOffset(), new Date(BASE + HOUR).getTimezoneOffset());

  let now = BASE + TEN_MINUTES;
  const summaries = new ComputerHistorySummaries({
    home,
    now: () => now,
    generate: async (input) => ({
      ...CONTENT,
      title: Date.parse(input.start) === BASE + HOUR ? 'review work' : CONTENT.title,
    }),
  });
  const events = [event(BASE + MINUTE)];
  await summaries.run(events);
  const first = await summaries.get(`10min-${BASE}`);
  assert.ok(first?.filename);
  const directory = join(home, 'summaries');
  const firstPath = join(directory, first.filename);
  const saved = await readFile(firstPath, 'utf8');
  const firstInfo = await lstat(firstPath);
  let caseInsensitive = false;
  try {
    const alias = await lstat(join(directory, first.filename.toLowerCase()));
    caseInsensitive = alias.dev === firstInfo.dev && alias.ino === firstInfo.ino;
  } catch (error) {
    assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT');
  }
  t.diagnostic(`Current fixture volume is ${caseInsensitive ? 'case-insensitive' : 'case-sensitive'}`);

  now = BASE + HOUR + TEN_MINUTES;
  events.push(event(BASE + HOUR + MINUTE));
  await summaries.run(events);
  const leaves = (await summaries.list()).filter(({ level }) => level === '10min');
  assert.deepEqual(leaves.map(({ id }) => id), [`10min-${BASE}`, `10min-${BASE + HOUR}`]);
  const second = await summaries.get(`10min-${BASE + HOUR}`);
  assert.ok(second?.filename);
  assert.equal(second.content.title, 'review work');
  assert.notEqual(second.filename, first.filename);
  if (caseInsensitive) assert.notEqual(second.filename.toLowerCase(), first.filename.toLowerCase());
  const secondPath = join(directory, second.filename);
  const secondInfo = await lstat(secondPath);
  assert.notDeepEqual([secondInfo.dev, secondInfo.ino], [firstInfo.dev, firstInfo.ino]);
  assert.equal(await readFile(firstPath, 'utf8'), saved, 'the first summary must not be overwritten or regenerated');
  assert.equal(JSON.parse((await readFile(secondPath, 'utf8')).split('\n')[1]!).id, second.id);

  const reopened = new ComputerHistorySummaries({
    home,
    generate: async () => assert.fail('cold lookup and reveal must not invoke the model'),
  });
  const shown: string[] = [];
  for (const leaf of [first, second]) {
    assert.equal((await reopened.get(leaf.id))?.filename, leaf.filename);
    await reopened.reveal(leaf.id, (path) => { shown.push(path); });
  }
  assert.deepEqual(shown, [firstPath, secondPath]);
});

test('duplicate IDs remain rejected across repeated cold get, reveal and list cycles', async (t) => {
  const home = await fixture(t);
  const seed = new ComputerHistorySummaries({
    home,
    now: () => BASE + TEN_MINUTES,
    generate: async () => CONTENT,
  });
  await seed.run([event(BASE + MINUTE)]);
  const id = `10min-${BASE}`;
  const original = await seed.get(id);
  assert.ok(original?.filename);
  const duplicate = {
    ...original,
    filename: original.filename.replace(/\.md$/u, '-duplicate.md'),
    content: { ...CONTENT, body: '## Conflicting copy\n\nA different synthetic document claims the same interval.' },
  };
  const directory = join(home, 'summaries');
  const originalPath = join(directory, original.filename);
  const duplicatePath = join(directory, duplicate.filename);
  const originalBytes = await readFile(originalPath, 'utf8');
  const duplicateBytes = serializeComputerHistorySummary(duplicate);
  await writeFile(duplicatePath, duplicateBytes, { flag: 'wx' });

  for (const first of ['get', 'reveal', 'list'] as const) {
    const reopened = new ComputerHistorySummaries({
      home,
      generate: async () => assert.fail('ambiguous archive reads must not invoke the model'),
    });
    const shown: string[] = [];
    const operations = {
      get: () => reopened.get(id),
      reveal: () => reopened.reveal(id, (path) => { shown.push(path); }),
      list: () => reopened.list(),
    };
    for (const operation of [first, 'get', 'reveal', 'list', 'get', 'reveal', 'list'] as const) {
      await assert.rejects(operations[operation], /Invalid computer history summary/u,
        `${first}-first cycle: ${operation} must not accept a cached conflicting identity`);
      assert.deepEqual(shown, [], 'an ambiguous ID must never dispatch a reveal');
    }
  }
  assert.equal(await readFile(originalPath, 'utf8'), originalBytes);
  assert.equal(await readFile(duplicatePath, 'utf8'), duplicateBytes);
});
