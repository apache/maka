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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  rmSync,
  symlinkSync,
  statSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexFileSource } from '../src/file-source.js';
const caller = {};
function fixture(t: any, mode: 'memories' | 'computer-history' = 'memories') {
  const dir = mkdtempSync(join(tmpdir(), 'codex-files-中文-')),
    root = join(dir, 'source'),
    cache = join(dir, 'cache');
  mkdirSync(root);
  let a = new CodexFileSource(root, mode, 1, cache, 'key');
  t.after(() => {
    a.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const put = (name: string, body: string) => {
    const file = join(root, name);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, body);
    return file;
  };
  return {
    a,
    root,
    dir,
    cache,
    put,
    restart: () => {
      a.close();
      a = new CodexFileSource(root, mode, 1, cache, 'key');
      return a;
    },
  };
}
test('memory distinguishes generated summaries; excludes instructions, hidden files and symlink escapes', async (t) => {
  const f = fixture(t);
  f.put('MEMORY.md', 'User likes tea');
  f.put('extensions/skysight/resources/day-10min-reading.md', 'User read an article');
  f.put('extensions/skysight/instructions.md', 'DO NOT import');
  f.put('.hidden.md', 'hidden');
  writeFileSync(join(f.dir, 'outside.md'), 'secret');
  symlinkSync(join(f.dir, 'outside.md'), join(f.root, 'link.md'));
  symlinkSync(f.dir, join(f.root, 'escape'));
  const p = await f.a.query({}, caller);
  assert.deepEqual(
    new Set(p.items.map((o) => o.kind)),
    new Set(['codex_memory', 'computer_history_summary']),
  );
  assert.equal(p.items.length, 2);
  const q = await f.a.query({ text: 'tea', types: ['codex_memory'] }, caller);
  assert.equal(q.items.length, 1);
  assert.equal((await f.a.read(q.items[0], caller)).content, 'User likes tea');
  for (const path of [
    '../outside.md',
    'link.md',
    'escape/outside.md',
    'extensions/skysight/instructions.md',
  ]) {
    const o = { id: Buffer.from(path).toString('base64url') };
    assert.deepEqual(await f.a.authorize([o], caller), []);
    assert.equal((await f.a.read(o, caller)).status, 'unavailable');
  }
});
test('activity publishes complete lines; append changes revision with stable IDs', async (t) => {
  const f = fixture(t, 'computer-history'),
    line = JSON.stringify({ id: 'one', timestamp: '2026-10-23T15:00:00Z' }) + '\n';
  const file = f.put('segments/2026-10-23T15-00-00Z/events.jsonl', line + '{"id":');
  f.put('segments/2026-10-23T15-00-00Z/metadata.json', '{}');
  const first = (await f.a.enumerate(undefined, caller)).items[0];
  assert.equal((await f.a.read(first, caller)).content, line);
  appendFileSync(file, '"two"}\n');
  assert.equal((await f.a.read(first, caller)).status, 'version_unavailable');
  const next = (await f.a.query({}, caller)).items[0];
  assert.equal(first.id, next.id);
  assert.notEqual(first.revision, next.revision);
  assert.match((await f.a.read(next, caller)).content!, /two/);
  assert.equal(statSync(file).size, Buffer.byteLength(line + '{"id":"two"}\n'));
});
test('pages survive restart, freeze listings and reject tampering or changed scope/query', async (t) => {
  const f = fixture(t);
  f.put('a.md', 'a');
  f.put('b.md', 'b');
  const first = await f.a.query({ limit: 1 }, caller);
  assert.ok(first.next);
  f.put('c.md', 'c');
  const a = f.restart(),
    next = await a.query({ limit: 1, cursor: first.next }, caller);
  assert.equal(next.items.length, 1);
  assert.equal(next.next, undefined);
  assert.equal((await a.query({}, caller)).items.length, 3);
  await assert.rejects(a.query({ limit: 2, cursor: first.next }, caller), /scope or query/);
  await assert.rejects(
    a.query({ limit: 1, cursor: first.next + 'x' }, caller),
    /Invalid source cursor/,
  );
  const changed = new CodexFileSource(f.root, 'memories', 2, f.cache, 'key');
  try {
    await assert.rejects(changed.query({ limit: 1, cursor: first.next }, caller), /scope or query/);
  } finally {
    changed.close();
  }
  assert.equal(statSync(join(f.cache, 'pages.sqlite')).mode & 0o777, 0o600);
});
test('deletion revokes references; missing root errors instead of publishing empty snapshot', async (t) => {
  const f = fixture(t),
    file = f.put('a.md', 'original');
  const o = (await f.a.query({}, caller)).items[0];
  rmSync(file);
  assert.deepEqual(await f.a.authorize([o], caller), []);
  assert.equal((await f.a.read(o, caller)).status, 'unavailable');
  assert.equal((await f.a.query({}, caller)).items.length, 0);
  rmSync(f.root, { recursive: true });
  await assert.rejects(f.a.query({}, caller), /ENOENT/);
});
test('empty enabled store is valid; malformed activity and cancellation fail visibly', async (t) => {
  const f = fixture(t, 'computer-history');
  assert.equal((await f.a.query({}, caller)).items.length, 0);
  f.put('segments/day/events.jsonl', '{broken}\n');
  await assert.rejects(f.a.query({}, caller), SyntaxError);
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(f.a.query({}, { invocation: { abortSignal: ac.signal } }));
});
test('time bounds filter updated files', async (t) => {
  const f = fixture(t),
    file = f.put('old.md', 'old context updated later');
  utimesSync(file, 100, 100);
  assert.equal((await f.a.query({ startTime: 100000, endTime: 100001 }, caller)).items.length, 1);
  assert.equal((await f.a.query({ startTime: 100001 }, caller)).items.length, 0);
  utimesSync(file, 200, 200);
  assert.equal((await f.a.query({ startTime: 100001 }, caller)).items.length, 1);
});

test('activity feed tails complete lines across restart, rotation and rewrite', async (t) => {
  const f = fixture(t, 'computer-history');
  const file = f.put(
    'segments/a/events.jsonl',
    '{"timestamp":"2026-10-30T01:00:00Z","ax":{"text":"old"}}\n',
  );
  const base = await f.a.changes(undefined, 50, caller);
  assert.equal(base.items.length, 0);
  appendFileSync(file, '{"timestamp":"2026-10-30T01:01:00Z","ax":{"text":"new"}}\n{"ax":');
  const p = await f.a.changes(base.cursor, 50, caller);
  assert.equal(p.items.length, 1);
  assert.match(p.items[0].content, /new/);
  const a = f.restart();
  appendFileSync(file, '{"text":"partial completed"}}\n');
  f.put('segments/b/events.jsonl', '{"ax":{"text":"rotated"}}\n');
  const next = await a.changes(p.cursor, 1, caller);
  assert.equal(next.items.length, 1);
  assert.equal(next.more, true);
  const rest = await a.changes(next.cursor, 50, caller);
  assert.equal(rest.items.length, 1);
  writeFileSync(file, '{"ax":{"text":"rewritten"}}\n');
  assert.equal((await a.changes(rest.cursor, 50, caller)).items.length, 1);
});

test('repeated screen text across timestamps and restarts does not repeatedly wake intake', async (t) => {
  const f = fixture(t, 'computer-history');
  const file = f.put('segments/a/events.jsonl', '{"ax":{"text":"old"}}\n');
  const base = await f.a.changes(undefined, 50, caller);
  for (let n = 0; n < 30; n++)
    appendFileSync(
      file,
      JSON.stringify({
        timestamp: '2026-10-31T00:00:' + String(n).padStart(2, '0') + 'Z',
        app: 'Calendar',
        ax: { text: 'unchanged screen' },
      }) + '\n',
    );
  const p = await f.a.changes(base.cursor, 50, caller);
  assert.equal(p.items.length, 1);
  const a = f.restart();
  appendFileSync(
    file,
    '{"timestamp":"2026-10-31T00:01:00Z","app":"Calendar","ax":{"text":"unchanged screen"}}\n',
  );
  assert.equal((await a.changes(p.cursor, 50, caller)).items.length, 0);
  appendFileSync(file, '{"app":"Calendar","ax":{"text":"new meeting"}}\n');
  assert.equal((await a.changes(p.cursor, 50, caller)).items.length, 1);
});
