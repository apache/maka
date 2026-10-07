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
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { fixture } from './host-fixture.js';

async function setup(t: any) {
  const f = await fixture();
  t.after(() => f.close());
  const state = {
    revision: 'v1',
    text: '采购将在周五交付',
    allowed: true,
    reads: 0,
    enumerations: 0,
    present: true,
  };
  const object = () => ({
    id: 'message-1',
    locator: { chatId: 'chat-1', messageId: 'message-1' },
    revision: state.revision,
    kind: 'text',
    title: '交付进展',
  });
  f.sources.register({
    id: 'feishu.test',
    description: 'Feishu controlled adapter',
    queryHelp: 'query',
    scope: { chatId: 'chat-1' },
    enumerate: async () => {
      state.enumerations++;
      return { items: state.present ? [object()] : [] };
    },
    query: async () => ({ items: [object()] }),
    authorize: async (objects) => (state.allowed ? objects.map((o) => o.id) : []),
    read: async () => {
      state.reads++;
      return { status: 'ok', object: object(), content: { text: state.text } };
    },
  });
  const db = new DatabaseSync(join(f.root, 'data/network.sqlite'));
  t.after(() => db.close());
  return { f, state, db };
}
test('external refs are metadata-only; mixed-source indexes and object backlinks share one edge table', async (t) => {
  const { f, state, db } = await setup(t);
  const range = await f.invoke('MemoryRange', { sources: ['maka', 'feishu.test'] });
  assert.equal(state.reads, 0);
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM documents WHERE session LIKE '%feishu%'").get()!.n,
    0,
  );
  const found = await f.invoke('MemorySourceQuery', { source: 'feishu.test', query: {} });
  const ref = found.items[0].ref;
  const again = await f.invoke('MemorySourceQuery', { source: 'feishu.test', query: {} });
  assert.equal(again.items[0].ref, ref);
  const original = await f.invoke('MemoryOriginal', { ref });
  assert.equal(original.content.text, state.text);
  assert.equal(state.reads, 1);
  f.setWorkerRunner(async (worker, prompt) => {
    const indexId = /Organize index ([^. ]+)/.exec(prompt)![1];
    const summary = await f.invokeAs(worker, 'MemoryIndexRead', { indexId });
    const result = await f.invokeAs(worker, 'MemoryIndexWrite', {
      indexId,
      key: 'delivery',
      expectedRevision: 0,
      text: `供应商交付进展 ${found.items[0].citation}`,
    });
    await f.invokeAs(worker, 'MemoryIndexCheckpoint', {
      indexId,
      rangeId: summary.range.rangeId,
      expectedRevision: result.revision,
      notes: '整理完成',
      complete: true,
    });
  });
  for (const name of ['事件', '未完成事项'])
    await f.invoke('MemoryIndexCreate', { name, instructions: '按实际信息整理', cursor: range.to });
  const read = await f.invoke('MemoryOriginal', { ref });
  assert.equal(read.backlinks.length, 2);
  assert.equal(state.reads, 1, 'exact evidence is cached after first read');
  state.revision = 'v2';
  state.text = '已经完成交付';
  const latest = await f.invoke('MemoryOriginal', { ref, latest: true });
  assert.equal(latest.content.text, state.text);
  assert.notEqual(latest.ref, ref);
  assert.equal(latest.backlinks.length, 2, 'same object across revisions links to old index leads');
  assert.equal((await f.invoke('MemoryOriginal', { ref })).content.text, '采购将在周五交付');
  state.allowed = false;
  await assert.rejects(f.invoke('MemoryOriginal', { ref }), /visibility|permission/);
  const fk = db.prepare('PRAGMA foreign_key_list(links)').all();
  assert.ok(fk.some((x) => x.table === 'memory_references'));
});
test('changed uncached evidence is never substituted; on-demand history and extraction use source reads', async (t) => {
  const { f, state, db } = await setup(t);
  const range = await f.invoke('MemoryRange', { sources: ['feishu.test'] });
  const before = (await f.invoke('MemorySourceQuery', { source: 'feishu.test', query: {} }))
    .items[0];
  state.revision = 'v2';
  state.text = '新的要求';
  const result = await f.invoke('MemoryOriginal', { ref: before.ref });
  assert.equal(result.status, 'version_unavailable');
  assert.equal(result.content, undefined);
  assert.ok(result.latestRef);
  const next = await f.invoke('MemoryRange', { sources: ['feishu.test'] });
  const messages = await f.invoke('MemoryHistory', {
    to: next.to,
    mode: 'messages',
    source: 'feishu.test',
    types: ['text'],
  });
  assert.equal(messages.items.length, 1);
  assert.match(JSON.stringify(messages.items[0].message), /新的要求/);
  const extraction = await f.invoke('MemoryExtract', {
    to: next.to,
    source: 'feishu.test',
    types: ['text'],
    requirements: '提取进展',
  });
  assert.equal(extraction.modelCalled, true);
  assert.match(f.llmCalls.at(-1).prompt, /新的要求/);
  assert.equal(
    db.prepare('SELECT count(*) AS n FROM documents').get()!.n,
    0,
    'no remote original is copied into the Session corpus',
  );
  f.setIncognito(true);
  await assert.rejects(
    f.invoke('MemorySourceQuery', { source: 'feishu.test', query: {} }),
    /Incognito/,
  );
});
test('enumeration removals and revisions become deltas without deleting historical evidence', async (t) => {
  const { f, state, db } = await setup(t);
  const first = await f.invoke('MemoryRange', { sources: ['feishu.test'] });
  state.revision = 'v2';
  const second = await f.invoke('MemoryRange', { sources: ['feishu.test'] });
  const changed = await f.invoke('MemoryHistory', {
    from: first.to,
    to: second.to,
    mode: 'records',
  });
  assert.equal(changed.items.length, 1);
  state.present = false;
  const removed = await f.invoke('MemoryRange', { sources: ['feishu.test'] });
  const old = JSON.parse(
    String(db.prepare('SELECT payload FROM memory_cursors WHERE id=?').get(removed.to)!.payload),
  );
  assert.equal(old.records.length, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM memory_references').get()!.n, 2);
});

test('packaged Feishu provider uses the real plugin service and complete memory tool chain', async (t) => {
  const { mkdtemp, copyFile, mkdir, writeFile } = await import('node:fs/promises');
  const { readFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const f = await fixture();
  t.after(() => f.close());
  const tokenPath = join(f.root, 'access-token');
  await writeFile(tokenPath, 'controlled-token', { mode: 0o600 });
  const packageRoot = join(f.root, 'feishu-plugin');
  await mkdir(join(packageRoot, 'dist'), { recursive: true });
  const sourceRoot = resolve('../feishu-source');
  await copyFile(join(sourceRoot, 'maka.extension.json'), join(packageRoot, 'maka.extension.json'));
  const { build } = await import('esbuild');
  await build({
    entryPoints: [join(sourceRoot, 'src/host.ts')],
    outfile: join(packageRoot, 'dist/host.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
  });
  const patch = JSON.parse(readFileSync(join(sourceRoot, 'maka.composition.json'), 'utf8'));
  patch[0].entry.config = {
    instanceId: 'packaged-test',
    containers: JSON.stringify([{ type: 'chat', id: 'oc_test' }]),
    startTime: 1,
    endTime: 20,
    tokenFile: tokenPath,
  };
  await writeFile(join(packageRoot, 'maka.composition.json'), JSON.stringify(patch));
  const { exportExtensionBundle } = await import('../.artifacts/main-api.mjs');
  const bundlePath = join(f.root, 'feishu-source.maka-extension');
  await exportExtensionBundle(packageRoot, bundlePath);
  const realFetch = globalThis.fetch,
    requests: string[] = [];
  const original = {
    message_id: 'om_original',
    chat_id: 'oc_test',
    create_time: '2000',
    msg_type: 'text',
    body: { content: '{"text":"请本周确认设备到货时间"}' },
  };
  globalThis.fetch = async (url, options) => {
    requests.push(`${options?.method} ${new URL(String(url)).pathname}`);
    return new Response(JSON.stringify({ code: 0, data: { has_more: false, items: [original] } }));
  };
  try {
    const result = await f.platform.installPackage(bundlePath);
    assert.deepEqual(result.failures, []);
  } finally {
    globalThis.fetch = realFetch;
  }
  const sources = await f.invoke('MemorySources', {});
  assert.ok(sources.some((s) => s.id === 'feishu.packaged-test'));
  const range = await f.invoke('MemoryRange', { sources: ['maka', 'feishu.packaged-test'] });
  const found = await f.invoke('MemorySourceQuery', {
    source: 'feishu.packaged-test',
    query: { text: '到货' },
  });
  const ref = found.items[0].ref;
  f.setWorkerRunner(async (worker, prompt) => {
    const indexId = /Organize index ([^. ]+)/.exec(prompt)![1];
    const state = await f.invokeAs(worker, 'MemoryIndexRead', { indexId });
    const evidence = await f.invokeAs(worker, 'MemoryOriginal', { ref });
    assert.deepEqual(evidence.content, original);
    const result = await f.invokeAs(worker, 'MemoryIndexWrite', {
      indexId,
      key: 'delivery',
      text: `设备到货需要确认 ${found.items[0].citation}`,
      expectedRevision: 0,
    });
    await f.invokeAs(worker, 'MemoryIndexCheckpoint', {
      indexId,
      rangeId: state.range.rangeId,
      expectedRevision: result.revision,
      notes: 'Scoped provider test',
      complete: true,
    });
  });
  const index = await f.invoke('MemoryIndexCreate', {
    name: '飞书事件',
    instructions: '整理事件和来龙去脉',
    cursor: range.to,
  });
  assert.equal(index.range.completed, true);
  const originalRead = await f.invoke('MemoryOriginal', { ref, latest: true });
  assert.equal(originalRead.status, 'ok');
  assert.equal(originalRead.backlinks.length, 1);
  const content = await f.invoke('MemoryIndexContent', {
    indexId: index.index.id,
    key: originalRead.backlinks[0].key,
  });
  assert.match(content.text, /设备到货/);
  assert.ok(requests.length > 0 && requests.every((x) => x.startsWith('GET ')));
});

test('native type filters skip remote body reads and account namespaces never share refs', async (t) => {
  const { f, state } = await setup(t);
  const range = await f.invoke('MemoryRange', { sources: ['feishu.test'] });
  const filtered = await f.invoke('MemoryHistory', {
    to: range.to,
    mode: 'messages',
    types: ['calendar'],
  });
  assert.equal(filtered.items.length, 0);
  assert.equal(state.reads, 0);
  const first = (await f.invoke('MemorySourceQuery', { source: 'feishu.test', query: {} }))
    .items[0];
  f.sources.register({
    id: 'another.account',
    description: 'different account',
    queryHelp: '{}',
    scope: {},
    enumerate: async () => ({ items: [first] }),
    query: async () => ({ items: [first] }),
    authorize: async (objects) => objects.map((o) => o.id),
    read: async () => ({ status: 'ok', object: first, content: 'other account' }),
  });
  const second = (await f.invoke('MemorySourceQuery', { source: 'another.account', query: {} }))
    .items[0];
  assert.notEqual(first.ref, second.ref);
  assert.equal(second.citation, `[source](memory-original:${second.ref})`);
});
