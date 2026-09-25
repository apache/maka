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
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const sdk = await readFile(
  new URL('../../../crates/js-runtime/src/plugin/sdk.js', import.meta.url),
  'utf8',
);
export const size = (value) => Buffer.byteLength(JSON.stringify(value));
const plain = (value) => JSON.parse(JSON.stringify(value));
export const block = (message, text = message, revision = '1') => ({
  key: { turn: 'turn', message, part: 'text' },
  revision,
  kind: 'assistant',
  content: { text },
});
export async function fixture(initial = {}, activate) {
  let store;
  let tui;
  const operations = [];
  const runtime = vm.runInNewContext(sdk, {
    TextEncoder,
    TextDecoder,
    Deno: {
      core: {
        ops: {
          op_maka_plugin: async (_key, method, input) => {
            operations.push({ method, input });
            return { ok: true, value: null };
          },
        },
      },
    },
  })(
    {
      default: async (ctx) => {
        tui = ctx.tui;
        store = activate ? await activate(ctx) : await tui.transcriptResource('activity', initial);
      },
    },
    'plugin',
  );
  const registrations = await runtime.activate({}, {});
  const caller = (documentId) => ({ documentId, clientInstanceId: 'client', sessionId: null });
  const invoke = (name, input, document = 'doc') => {
    const definition = registrations.find((entry) => entry.name === name);
    assert.ok(definition, name);
    return runtime.invoke(definition.callback, input, caller(document));
  };
  const value = (reply) => {
    assert.equal(reply.kind, 'value', reply.message);
    return reply.value;
  };
  return {
    store,
    tui,
    registrations,
    operations,
    runtime,
    invoke,
    async open(document = 'doc') {
      return value(
        await invoke(
          'activity.stream',
          { resource: 'activity', route: null, locale: 'en' },
          document,
        ),
      );
    },
    async next(handle) {
      const reply = value(await runtime.streamNext(handle));
      return reply.kind === 'end' ? null : plain(reply.value);
    },
    async page(input, document = 'doc') {
      return plain(
        value(await invoke('activity.read', { resource: 'activity', ...input }, document)),
      );
    },
  };
}
export async function logicalPage(f, fence, direction = 'tail', cursor = null, document = 'doc') {
  let page = await f.page({ fence, direction, cursor }, document);
  const records = [];
  const timings = [];
  let assembly;
  for (;;) {
    assert.ok(size(page) < 64 * 1024);
    for (const record of page.records) {
      if (record.kind === 'block') {
        assert.equal(assembly, undefined);
        records.push(record.block);
        continue;
      }
      assert.ok(Buffer.byteLength(record.json) <= 8192);
      if (!assembly)
        assembly = { key: record.key, revision: record.revision, total: record.total, json: '' };
      assert.deepEqual(record.key, assembly.key);
      assert.equal(record.revision, assembly.revision);
      assert.equal(record.total, assembly.total);
      assert.equal(record.offset, Buffer.byteLength(assembly.json));
      assembly.json += record.json;
      if (Buffer.byteLength(assembly.json) === assembly.total) {
        const complete = JSON.parse(assembly.json);
        assert.deepEqual(complete.key, assembly.key);
        assert.equal(complete.revision, assembly.revision);
        records.push(complete);
        assembly = undefined;
      }
    }
    timings.push(...page.timings);
    if (!page.continuation) break;
    const input = { fence, direction: 'continue', cursor: page.continuation };
    page = await f.page(input, document);
    assert.deepEqual(await f.page(input, document), page, 'cursor replay is immutable');
  }
  assert.equal(assembly, undefined);
  return { records, timings, older: page.older, newer: page.newer };
}
