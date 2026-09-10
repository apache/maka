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
import { applyAssistantDelta } from '../assistant-stream.js';
import { applyThinkingDelta } from '../thinking-stream.js';

test('ordinary deltas do not copy display or redaction state strings', () => {
  const original = globalThis.structuredClone;
  let copies = 0;
  globalThis.structuredClone = ((...args: Parameters<typeof structuredClone>) => {
    copies++;
    return original(...args);
  }) as typeof structuredClone;
  try {
    for (const apply of [applyAssistantDelta, applyThinkingDelta]) {
      let result: ReturnType<typeof apply> = { text: '', redacted: false, truncated: false };
      for (let i = 0; i < 1000; i++) {
        result = apply(result.text, 'ordinary streamed words!\n', { locale: 'en', redactionState: result.redactionState });
      }
      assert.equal(result.text, 'ordinary streamed words!\n'.repeat(1000));
    }
    assert.equal(copies, 0);
  } finally {
    globalThis.structuredClone = original;
  }
});

test('oversized live deltas retain bounded display and recovery strings, not whole seeds', () => {
  const child = spawnSync(process.execPath, [
    '--expose-gc', '--input-type=module', '-e', String.raw`
    import assert from 'node:assert/strict';
    import { getHeapSnapshot } from 'node:v8';
    const { applyLiveTurnEvent } = await import(process.argv[1]);
    let projection, control;
    function raw(i, mode) {
      return mode === 'token' ? 'ghp_DELTABACKING' + i + 'A'.repeat(1024 * 1024)
        : 'delta-backing-' + i + '\n' + (i % 2 ? ' ordinary 汉 words\n' : ' ordinary words\n').repeat(131072);
    }
    function seedControl() {
      const values = [raw(0, 'plain'), raw(1, 'plain'), raw(0, 'token')];
      for (const value of values) assert.ok(value.charCodeAt(value.length - 1) >= 0);
      return values;
    }
    function event(text, kind, i) {
      return { type: kind + '_delta', id: 'event-' + i, turnId: 'turn',
        messageId: 'step-' + i, ts: 1, startOffset: 0, text };
    }
    async function count() {
      // A real unrelated small event replaces V8's single last-RegExp input.
      // The eight live projections remain owned; only their backing is tested.
      applyLiveTurnEvent(undefined, event('api_key=x', 'thinking', 'unrelated'), 'en');
      for (let i = 0; i < 8; i++) { await new Promise(setImmediate); global.gc(); }
      const chunks = []; for await (const chunk of getHeapSnapshot()) chunks.push(chunk);
      const heap = JSON.parse(Buffer.concat(chunks).toString());
      const fields = heap.snapshot.meta.node_fields, width = fields.length;
      const type = fields.indexOf('type'), name = fields.indexOf('name'), size = fields.indexOf('self_size');
      const types = heap.snapshot.meta.node_types[type]; let found = 0;
      for (let i = 0; i < heap.nodes.length; i += width) {
        const label = heap.strings[heap.nodes[i + name]];
        if (types[heap.nodes[i + type]] === 'string' && heap.nodes[i + size] > 500000 &&
          (label.startsWith('delta-backing-') || label.startsWith('ghp_DELTABACKING'))) found++;
      }
      return found;
    }
    function add(i, kind, mode) {
      projection = applyLiveTurnEvent(projection, event(raw(i, mode), kind, i), 'en');
    }
    control = seedControl(); assert.equal(await count(), 3, 'ASCII/wide/token detector controls');
    control = undefined; assert.equal(await count(), 0, 'released controls');
    for (const kind of ['thinking', 'text']) {
      for (const mode of ['plain', 'token']) {
        for (let i = 0; i < 8; i++) add(i, kind, mode);
        assert.equal(projection.steps.length, 8);
        for (const step of projection.steps) {
          const item = step[kind], cap = kind === 'thinking' ? 32768 : 262144;
          assert.ok(item.text.length <= cap && !item.complete);
          assert.ok(item.redactionState.pendingChars <= 2 * (cap + 1) + 256);
          if (mode === 'plain') assert.ok(item.truncated);
          else assert.equal(item.text, '<redacted>');
        }
        assert.equal(await count(), 0, kind + '/' + mode + ' has no oversized backing');
        projection = undefined; assert.equal(await count(), 0, 'released projection');
      }
    }
  `, new URL('../live-turn-projection.js', import.meta.url).href], {
    encoding: 'utf8', timeout: 60_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr || child.stdout);
});
