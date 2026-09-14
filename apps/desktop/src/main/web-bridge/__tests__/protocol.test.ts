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
import { test } from 'node:test';
import {
  assertJsonSafe,
  decodeFrame,
  encodeFrame,
  encodeOutboundFrame,
  errorMessage,
  reviveFrame,
  unwrapBytes,
  wrapBytes,
} from '../protocol.js';

test('accepts JSON-safe payloads', () => {
  assert.doesNotThrow(() => assertJsonSafe({ a: [1, 'x', null, true, { b: 2 }] }, 't'));
});

test('encodeFrame matches JSON.stringify on Electron optional fields (undefined)', () => {
  // Real IPC results (settings:get, connections:getSnapshot, sessions:observe)
  // carry TypeScript optional properties as `undefined`. Electron structured
  // clone preserves them; JSON omits object keys and nulls array holes.
  // Dropping the frame used to hang the web client on Loading… forever.
  const withOptionals = encodeFrame({
    t: 'result',
    id: 1,
    ok: true,
    value: { a: 1, b: undefined, nested: { c: undefined }, catalogEntries: undefined },
  });
  assert.equal(
    withOptionals,
    JSON.stringify({ t: 'result', id: 1, ok: true, value: { a: 1, nested: {} } }),
  );

  const voidHandler = encodeFrame({ t: 'result', id: 2, ok: true, value: undefined });
  assert.equal(voidHandler, JSON.stringify({ t: 'result', id: 2, ok: true }));

  const observeReady = encodeFrame({
    t: 'result',
    id: 3,
    ok: true,
    value: { kind: 'ready', value: undefined },
  });
  assert.equal(
    observeReady,
    JSON.stringify({ t: 'result', id: 3, ok: true, value: { kind: 'ready' } }),
  );

  const sparseArray = encodeFrame({ t: 'result', id: 4, ok: true, value: [1, undefined, 2] });
  assert.equal(
    sparseArray,
    JSON.stringify({ t: 'result', id: 4, ok: true, value: [1, null, 2] }),
  );
});

test('encodeFrame serializes shared object references (not true cycles)', () => {
  // Memory state aliases latestEntry === entries[0]; chatModelChoices reuse
  // one thinkingLevels array. JSON.stringify handles that; a global `seen`
  // set used to call it circular and drop the frame.
  const shared = { x: 1 };
  const levels = ['low', 'high'];
  const encoded = encodeFrame({
    t: 'result',
    id: 1,
    ok: true,
    value: {
      entries: [shared],
      latestEntry: shared,
      chatModelChoices: [{ thinkingLevels: levels }, { thinkingLevels: levels }],
    },
  });
  const parsed = JSON.parse(encoded) as {
    value: { latestEntry: { x: number }; chatModelChoices: { thinkingLevels: string[] }[] };
  };
  assert.equal(parsed.value.latestEntry.x, 1);
  assert.deepEqual(parsed.value.chatModelChoices[1].thinkingLevels, ['low', 'high']);
});

test('rejects anything JSON would silently mangle', () => {
  assert.throws(() => assertJsonSafe({ f: () => {} }, 't'), /function/);
  assert.throws(() => assertJsonSafe({ s: Symbol('x') }, 't'), /symbol/);
  assert.throws(() => assertJsonSafe({ b: 1n }, 't'), /bigint/);
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.throws(() => assertJsonSafe(circular, 't'), /circular/);
});

test('bytes envelope round-trips through frames', () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 255]);
  const frame = encodeFrame({ t: 'invoke', id: 1, channel: 'c', args: [wrapBytes(bytes)] });
  const decoded = decodeFrame(frame);
  assert.equal(decoded.t, 'invoke');
  if (decoded.t !== 'invoke') return;
  assert.deepEqual(decoded.args[0], bytes);
});

test('encodeFrame auto-wraps Uint8Array transcript fragments', () => {
  const bytes = new Uint8Array([7, 8, 9]);
  const encoded = encodeFrame({
    t: 'result',
    id: 1,
    ok: true,
    value: { batches: [{ fragments: [{ data: bytes }] }] },
  });
  const parsed = JSON.parse(encoded) as {
    value: { batches: { fragments: { data: unknown }[] }[] };
  };
  const revived = reviveFrame(parsed.value);
  assert.deepEqual(revived.batches[0]?.fragments[0]?.data, bytes);
});

test('decodeFrame rejects malformed input', () => {
  assert.throws(() => decodeFrame('not json'), /not JSON/);
  assert.throws(() => decodeFrame('42'), /not an object/);
  assert.throws(() => decodeFrame('{"t":"nope","channel":"c","args":[]}'), /unknown type/);
  assert.throws(() => decodeFrame('{"t":"invoke","id":1,"args":[]}'), /missing channel/);
  assert.throws(() => decodeFrame('{"t":"invoke","id":1,"channel":"c"}'), /args must be an array/);
  assert.throws(() => decodeFrame('{"t":"invoke","channel":"c","args":[]}'), /missing id/);
  // Notify needs no id.
  assert.equal(decodeFrame('{"t":"notify","channel":"c","args":[]}').t, 'notify');
});

test('reviveFrame copies nested envelopes', () => {
  const bytes = new Uint8Array([9, 9]);
  const revived = reviveFrame({ deep: { list: [wrapBytes(bytes)] } });
  assert.deepEqual(revived, { deep: { list: [bytes] } });
  assert.equal(unwrapBytes({ nope: 1 }), undefined);
});

test('errorMessage never throws', () => {
  assert.equal(errorMessage(new Error('boom')), 'boom');
  assert.equal(errorMessage('plain'), 'plain');
  assert.match(errorMessage({ code: 7 }), /7/);
  assert.equal(typeof errorMessage(undefined), 'string');
});

test('encodeOutboundFrame turns an unencodable result into an error result', () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const encoded = encodeOutboundFrame({ t: 'result', id: 9, ok: true, value: circular });
  const parsed = JSON.parse(encoded) as { t: string; id: number; ok: boolean; error?: string };
  assert.equal(parsed.t, 'result');
  assert.equal(parsed.id, 9);
  assert.equal(parsed.ok, false);
  assert.match(String(parsed.error), /circular/);
});
