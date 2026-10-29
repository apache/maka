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
  readFileSync,
  readdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  statSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('publishing plugin packages preserves unchanged files and removes obsolete bytes', async () => {
  const { bundle } = await import('../../../../scripts/plugins/build.mjs');
  const output = mkdtempSync(resolve(tmpdir(), 'maka-product-publication-'));
  try {
    const receipts = 'plugins/application/receipts';
    await bundle({ packages: { receipts, logs: 'plugins/application/host-logs' }, output });
    const manifest = resolve(output, 'packages/receipts/maka.extension.json');
    const bytes = readFileSync(manifest);
    utimesSync(manifest, 0, 0);
    const stale = resolve(output, 'packages/receipts/removed.js');
    writeFileSync(stale, 'obsolete source');
    await bundle({ packages: { receipts }, output });
    assert.deepEqual(readFileSync(manifest), bytes);
    assert.equal(statSync(manifest, { bigint: true }).mtimeNs, 0n);
    assert.deepEqual(readdirSync(resolve(output, 'packages')), ['receipts']);
    assert.deepEqual(readdirSync(resolve(output, 'packages/receipts')), ['maka.extension.json']);
    const inputs = JSON.parse(readFileSync(resolve(output, 'bundle-inputs.json'), 'utf8'));
    assert.ok(inputs.includes(resolve(root, '../../../plugins/application/receipts/package.ts')));
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test('native Web tools freeze their display contract while retaining explicit custom presentations', async () => {
  const { composition, instanceNames, packageNames } = await import(
    '../dist/authoring/composition.mjs'
  );
  const { host } = composition({
    locale: 'en',
    hostDeployment: 'host',
    keys: Object.fromEntries(instanceNames.map((name, index) => [name, `key-${index}`])),
    packages: Object.fromEntries(
      packageNames.map((name) => [name, { id: name, revision: 'a'.repeat(64) }]),
    ),
    web: { network: 'denied' },
    agent: {
      workspaceRoots: [],
      tools: [
        {
          name: 'WorkspacePage',
          description: 'Fetch a page',
          import: 'web',
          method: 'fetch',
          result: 'json',
          confirmation: 'preapproved',
        },
        {
          name: 'WorkspaceQuery',
          description: 'Search the web',
          import: 'web',
          method: 'search',
          result: 'json',
          confirmation: 'preapproved',
        },
        {
          name: 'CustomPage',
          description: 'Use a custom card',
          import: 'web',
          method: 'fetch',
          result: 'json',
          confirmation: 'preapproved',
          presentation: 'product.customPage@2',
        },
      ],
    },
  });
  const tools = host.instances.agent.configuration.values.tools;
  assert.deepEqual(
    tools.map(({ name, input, presentation }) => ({ name, input, presentation })),
    [
      { name: 'WorkspacePage', input: 'web', presentation: 'maka.workspace.Web@1/fetch' },
      { name: 'WorkspaceQuery', input: 'web', presentation: 'maka.workspace.Web@1/search' },
      { name: 'CustomPage', input: 'web', presentation: 'product.customPage@2' },
    ],
  );
  assert.deepEqual(host.instances.agent.bindings.web, [
    { kind: 'instance', path: ['workspace-web'], export: 'web' },
  ]);
});
