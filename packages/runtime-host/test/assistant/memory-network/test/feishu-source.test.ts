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
import { join } from 'node:path';
import { fixture } from './host-fixture.js';

test('packaged Feishu provider uses the real plugin service and complete memory tool chain', async (t) => {
  const { copyFile, mkdir, writeFile } = await import('node:fs/promises');
  const { readFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const f = await fixture();
  t.after(() => f.close());
  const tokenPath = join(f.root, 'access-token');
  await writeFile(tokenPath, 'controlled-token', { mode: 0o600 });
  const packageRoot = join(f.root, 'feishu-plugin');
  await mkdir(join(packageRoot, 'dist'), { recursive: true });
  const sourceRoot = resolve('../../../../../scripts/plugins/feishu-source');
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
    accountId: 'user',
    appId: 'app',
    dataDirectory: join(f.root, 'feishu-data'),
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
    return new Response(
      JSON.stringify({
        code: 0,
        data: new URL(String(url)).pathname.endsWith('user_info')
          ? { open_id: 'user' }
          : { has_more: false, items: [original] },
      }),
    );
  };
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const installed = await f.platform.installPackage(bundlePath);
  assert.deepEqual(installed.failures, []);
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
  assert.ok(requests.includes('GET /open-apis/im/v1/messages'));
  assert.ok(!requests.some((x) => x.startsWith('POST')));
});
