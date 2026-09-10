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
import { redactSecrets } from '../redact.js';
import { applyStreamComplete } from '../stream-delta.js';

test('completed stream copies preserve redaction, cap markers and UTF-16 boundaries', () => {
  let units = '';
  for (let start = 0; start < 65536; start += 8192) {
    units += String.fromCharCode(...Array.from({ length: 8192 }, (_, i) => start + i));
  }
  for (const raw of [
    '', 'short text', ' x \n\t', units.repeat(3),
    'prefix\ud800\udc00' + ' end'.repeat(100),
    '\ufeffstart\0' + ' words'.repeat(100) + '\ud800',
    'Authorization: Bearer fixture-secret-value\n' + 'safe words\n'.repeat(100),
  ]) {
    for (const recovery of ['head', 'tail'] as const) {
      for (const cap of [0, 1, 5, 32, 32768, 262144]) {
        const marker = '[cut]';
        const safe = redactSecrets(raw), truncated = safe.length > cap, keep = cap - marker.length;
        const expected = !truncated ? safe : recovery === 'head'
          ? safe.slice(0, keep) + marker
          : marker + safe.slice(safe.length - keep);
        assert.deepEqual(applyStreamComplete(raw, { maxTotalChars: cap, recovery, totalMarker: marker }), {
          text: expected, redacted: safe !== raw, truncated,
        });
      }
    }
  }
});

test('completed live display projections do not retain full oversized text', () => {
  const child = spawnSync(process.execPath, [
    '--expose-gc', '--input-type=module', '-e', String.raw`
    import assert from 'node:assert/strict';
    import { getHeapSnapshot } from 'node:v8';
    const { applyLiveTurnEvent } = await import(process.argv[1]);
    let projection, control;
    function raw(i) {
      return 'stream-complete-backing-' + i + '\n' + (i % 2 ? ' ordinary 汉 words\n' : ' ordinary words\n').repeat(131072);
    }
    async function count() {
      for (let i = 0; i < 8; i++) { await new Promise(setImmediate); global.gc(); }
      const chunks = []; for await (const chunk of getHeapSnapshot()) chunks.push(chunk);
      const heap = JSON.parse(Buffer.concat(chunks).toString());
      const fields = heap.snapshot.meta.node_fields, width = fields.length;
      const type = fields.indexOf('type'), name = fields.indexOf('name'), size = fields.indexOf('self_size');
      const types = heap.snapshot.meta.node_types[type]; let found = 0;
      for (let i = 0; i < heap.nodes.length; i += width) {
        if (types[heap.nodes[i + type]] === 'string' && heap.nodes[i + size] > 1024 * 1024 &&
          heap.strings[heap.nodes[i + name]].startsWith('stream-complete-backing-')) found++;
      }
      return found;
    }
    function add(i, kind) {
      projection = applyLiveTurnEvent(projection, { type: kind + '_complete', turnId: 'turn',
        id: 'event-' + i, messageId: 'step-' + i, ts: 1, text: raw(i) }, 'en');
    }
    function seedControl() {
      const values = [raw(0), raw(1)];
      for (const value of values) assert.ok(value.charCodeAt(value.length - 1) >= 0);
      return values;
    }
    control = seedControl();
    assert.equal(await count(), 2, 'live ASCII and wide detector controls');
    control = undefined; assert.equal(await count(), 0, 'released control strings');
    for (const kind of ['thinking', 'text']) {
      for (let i = 0; i < 8; i++) add(i, kind);
      const cap = kind === 'thinking' ? 32768 : 262144;
      assert.equal(projection.steps.length, 8);
      assert.ok(projection.steps.every(step => step[kind].text.length === cap &&
        step[kind].truncated && step[kind].complete));
      assert.equal(await count(), 0, 'live ' + kind + ' display has no oversized parents');
      projection = undefined; assert.equal(await count(), 0);
    }
  `, new URL('../live-turn-projection.js', import.meta.url).href], {
    encoding: 'utf8', timeout: 60_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr || child.stdout);
});
