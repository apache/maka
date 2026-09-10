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
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { readComposerDraft, rememberComposerDraft } from '../composer-helpers.js';

test('draft truncation preserves UTF-16 code units, whitespace and entry ordering', () => {
  let inventory = '';
  for (let start = 0; start < 65536; start += 8192) {
    inventory += String.fromCharCode(...Array.from({ length: 8192 }, (_, index) => start + index));
  }
  const store = new Map<string, string>();
  const values = [
    inventory.repeat(3),
    'prefix\ud800\udc00' + 'z'.repeat(119999),
    'x'.repeat(120001) + '\ud800',
    'prefix' + ' '.repeat(120000),
    '\ufeffprefix\0' + inventory.repeat(2),
    '  x \t\n',
  ];
  for (const length of [119999, 120000, 120001, 128192, 128193]) {
    values.push(inventory.repeat(3).slice(0, length));
  }
  for (const value of values) {
    rememberComposerDraft(store, 'draft', value);
    assert.equal(readComposerDraft(store, 'draft'), value.slice(-120000));
  }
  rememberComposerDraft(store, undefined, 'ignored');
  assert.equal(store.size, 1);
  rememberComposerDraft(store, 'draft', ' \t\n');
  assert.equal(store.size, 0);
  for (let i = 0; i < 32; i++) rememberComposerDraft(store, String(i), 'draft-' + i);
  rememberComposerDraft(store, '0', 'updated');
  rememberComposerDraft(store, '32', 'new');
  assert.equal(store.size, 32);
  assert.equal(readComposerDraft(store, '1'), '');
  assert.equal(readComposerDraft(store, '0'), 'updated');
  assert.deepEqual([...store.keys()], [...Array.from({ length: 30 }, (_, i) => String(i + 2)), '0', '32']);
});

test('bounded drafts do not retain oversized input backing strings', () => {
  const result = spawnSync(process.execPath, [
    '--expose-gc', '--input-type=module', '-e', String.raw`
    import assert from 'node:assert/strict';
    import { mkdtemp, readFile, rm } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { writeHeapSnapshot } from 'node:v8';
    const { rememberComposerDraft } = await import(process.argv[1]);
    const root = await mkdtemp(join(tmpdir(), 'maka-draft-memory-'));
    const store = new Map();
    function save(key, wide, rawSlice = false) {
      const input = 'maka-draft-backing:' + key + (wide ? '汉' : 'a').repeat(2 * 1024 * 1024);
      if (rawSlice) store.set(key, input.slice(-120000));
      else rememberComposerDraft(store, key, input);
      assert.equal(store.get(key), input.slice(-120000));
    }
    async function retained() {
      for (let i = 0; i < 8; i++) { await new Promise(setImmediate); global.gc(); }
      const path = writeHeapSnapshot(join(root, 'draft.heapsnapshot'));
      const heap = JSON.parse(await readFile(path, 'utf8'));
      await rm(path);
      const fields = heap.snapshot.meta.node_fields, width = fields.length;
      const type = fields.indexOf('type'), name = fields.indexOf('name'), size = fields.indexOf('self_size');
      const types = heap.snapshot.meta.node_types[type];
      let count = 0;
      for (let i = 0; i < heap.nodes.length; i += width) {
        if (types[heap.nodes[i + type]] === 'string' && heap.nodes[i + size] > 1024 * 1024 &&
          heap.strings[heap.nodes[i + name]].startsWith('maka-draft-backing:')) count++;
      }
      return count;
    }
    try {
      save('control-ascii', false, true); save('control-wide', true, true);
      assert.equal(await retained(), 2, 'detector sees live sliced parents');
      store.clear(); assert.equal(await retained(), 0, 'control parents collect');
      for (let i = 0; i < 8; i++) save('draft-' + i, i % 2 === 1);
      assert.equal(store.size, 8);
      assert.ok([...store.values()].every(value => value.length === 120000));
      assert.equal(await retained(), 0, 'live bounded store has no oversized parents');
      for (const key of [...store.keys()]) rememberComposerDraft(store, key, 'small');
      assert.equal(await retained(), 0);
    } finally { await rm(root, { recursive: true, force: true }); }
  `, new URL('../composer-helpers.js', import.meta.url).href], {
    encoding: 'utf8', timeout: 60_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
