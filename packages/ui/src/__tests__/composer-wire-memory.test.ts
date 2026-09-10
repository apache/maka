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
import { test } from 'node:test';
import { composerWireText } from '../chat-input-behavior.js';

test('wire normalization preserves UTF-16 and copies only trimmed text', () => {
  let inventory = '';
  for (let start = 0; start < 65536; start += 8192) {
    inventory += String.fromCharCode(...Array.from({ length: 8192 }, (_, i) => start + i));
  }
  const originalClone = globalThis.structuredClone;
  let clones = 0;
  globalThis.structuredClone = (value, options) => {
    clones++;
    return originalClone(value, options);
  };
  try {
    const values = ['ordinary text', 'a\u00a0b', '', inventory, ' \ufeffx\ud800\0\udfff\t', ' \t\n'];
    for (const value of values) {
      const expected = value.replace(/\u00a0/g, ' ').trim();
      const before = clones;
      assert.equal(composerWireText(value), expected);
      assert.equal(clones - before, Number(expected.length < value.length));
    }
  } finally {
    globalThis.structuredClone = originalClone;
  }
});

const CHILD_SOURCE = String.raw`
  import assert from 'node:assert/strict';
  import { mkdtemp, readFile, rm } from 'node:fs/promises';
  import { tmpdir } from 'node:os';
  import { join } from 'node:path';
  import { writeHeapSnapshot } from 'node:v8';
  import { setImmediate as tick } from 'node:timers/promises';
  import { createElement, act } from 'react';
  import { createRoot } from 'react-dom/client';
  import { parseHTML } from 'linkedom';
  const { composerWireText } = await import(process.argv[1]);
  const { useComposerHistory } = await import(process.argv[2]);
  const { clearGlobalInputHistory } = await import(process.argv[3]);
  const dir = await mkdtemp(join(tmpdir(), 'maka-wire-memory-'));
  const { window, document } = parseHTML('<body><div id="mount"></div></body>');
  let storage = null, unavailable = false, api, shown = '';
  Object.assign(globalThis, { window, document, IS_REACT_ACT_ENVIRONMENT: true, localStorage: {
    getItem() { if (unavailable) throw Error('unavailable'); return storage; },
    setItem(key, value) { if (unavailable) throw Error('unavailable'); storage = value; },
    removeItem() { storage = null; },
  } });
  function Fixture() {
    api = useComposerHistory({ text: { getValue: () => shown, setValue: value => { shown = value; } }, saveCurrentDraft() {} });
    return null;
  }
  const root = createRoot(document.getElementById('mount'));
  await act(() => root.render(createElement(Fixture)));
  const positive = [];
  function raw(index) {
    return (index % 2 ? '\u2000' : ' ').repeat(2 * 1024 * 1024 + index * 100)
      + 'entry-' + index + '-' + 'x'.repeat(1000) + '\n';
  }
  function seedControls() { positive.push(raw(0).trim(), raw(1).trim()); }
  function save(index) { api.rememberSentEntry(composerWireText(raw(index))); }
  async function parents() {
    for (let i = 0; i < 8; i++) { await tick(); global.gc(); }
    const path = writeHeapSnapshot(join(dir, 'wire.heapsnapshot'));
    const heap = JSON.parse(await readFile(path, 'utf8'));
    await rm(path);
    const fields = heap.snapshot.meta.node_fields, width = fields.length;
    const type = fields.indexOf('type'), name = fields.indexOf('name'), size = fields.indexOf('self_size');
    let count = 0;
    for (let i = 0; i < heap.nodes.length; i += width) {
      if (heap.snapshot.meta.node_types[type][heap.nodes[i + type]] === 'string'
        && heap.nodes[i + size] > 1024 * 1024 && /^[ \u2000]{50}/.test(heap.strings[heap.nodes[i + name]])) count++;
    }
    return count;
  }
  try {
    seedControls();
    assert.equal(await parents(), 2, 'positive control sees both ASCII and wide backing strings');
    positive.length = 0;
    assert.equal(await parents(), 0, 'released controls collect');
    for (const failed of [false, true]) {
      unavailable = failed;
      for (let i = 0; i < 8; i++) save(i);
      assert.equal(await parents(), 0, 'history retains raw whitespace with storage unavailable=' + failed);
      api.handleArrowKey({ key: 'ArrowUp', ctrlKey: true, preventDefault() {} });
      assert.equal(shown, 'entry-7-' + 'x'.repeat(1000));
      shown = '';
      unavailable = false;
      clearGlobalInputHistory();
    }
    await act(() => root.unmount());
    api = undefined;
    assert.equal(await parents(), 0);
  } finally {
    await act(() => root.unmount());
    await rm(dir, { recursive: true, force: true });
  }
`;

test('sent history releases trimmed backing with available or unavailable storage', () => {
  const result = spawnSync(process.execPath, [
    '--expose-gc', '--input-type=module', '--eval', CHILD_SOURCE,
    new URL('../chat-input-behavior.js', import.meta.url).href,
    new URL('../use-composer-history.js', import.meta.url).href,
    new URL('../input-history.js', import.meta.url).href,
  ], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr + result.stdout);
});
