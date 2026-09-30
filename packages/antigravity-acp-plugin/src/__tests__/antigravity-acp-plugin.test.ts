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
import acpPackage from '@maka/acp-executor-plugin';
import { MakaCompositionLoader } from '@maka/runtime/plugin-composition-loader';
import { PluginExecutorService } from '@maka/runtime/plugin-executor-service';
import { PluginStorageService } from '@maka/runtime/plugin-data-services';
import { Context } from '@maka/runtime/plugin-kernel';
import pluginPackage, {
  ANTIGRAVITY_ACP_EXECUTOR_ID,
  antigravityAcpAdapter,
  antigravityEnvironment,
  validateConfig,
} from '../index.js';

test('adapter registers through a parent ACP Runtime Entry', async () => {
  const root = new Context();
  const executors = new PluginExecutorService(root);
  new PluginStorageService(root);
  const loader = new MakaCompositionLoader({ root });
  await loader.install(acpPackage);
  await loader.install(pluginPackage);
  await loader.create('profile', {
    id: 'acp-runtime-entry',
    packageId: 'acp-executor',
    isolate: { acp: true },
    children: [
      {
        id: 'antigravity-entry',
        packageId: 'antigravity-acp',
        config: { executable: '/opt/antigravity/agy_acp_server.par' },
      },
    ],
  });

  assert.deepEqual(
    executors.list('session-a').map(({ id, displayName }) => ({ id, displayName })),
    [{ id: ANTIGRAVITY_ACP_EXECUTOR_ID, displayName: 'Antigravity' }],
  );
  assert.deepEqual(pluginPackage.contributions, [
    { id: ANTIGRAVITY_ACP_EXECUTOR_ID, kind: 'executor' },
  ]);
  await loader.close();
});

test('adapter owns Antigravity launch policy only', () => {
  const configured = antigravityAcpAdapter.configure({
    executable: '/opt/antigravity/agy_acp_server.par',
    helper: '/opt/antigravity/localharness_external',
    model: 'gemini-high',
  });
  assert.equal(configured.launch.executable, '/opt/antigravity/agy_acp_server.par');
  assert.equal(configured.launch.cwd, '/opt/antigravity');
  assert.deepEqual(configured.launch.requiredExecutables, [
    '/opt/antigravity/localharness_external',
  ]);
  assert.equal(
    configured.launch.env?.ANTIGRAVITY_HARNESS_PATH,
    '/opt/antigravity/localharness_external',
  );
  assert.deepEqual(configured.launch.initialConfig, { model: 'gemini-high' });
});

test('adapter validates configuration and preserves proxy bypass', () => {
  assert.throws(() => validateConfig({ executable: 'relative' }), /absolute path/u);
  const env = antigravityEnvironment({ NO_PROXY: 'example.test,localhost' }, '/helper');
  assert.equal(env.BROWSER, '/usr/bin/true');
  assert.equal(env.ANTIGRAVITY_HARNESS_PATH, '/helper');
  assert.equal(env.NO_PROXY, 'example.test,localhost,127.0.0.1,::1');
  assert.equal(env.no_proxy, env.NO_PROXY);
});

test('official interaction requests are questions; ordinary tool permissions stay permissions', () => {
  const classify = antigravityAcpAdapter.permissionKind!;
  const request = {
    sessionId: 'test',
    toolCall: {
      toolCallId: 'interaction_fixture',
      title: 'Alpha or beta?',
      status: 'pending' as const,
    },
    options: [
      { optionId: '1', name: 'Alpha', kind: 'allow_once' as const },
      { optionId: '2', name: 'Beta', kind: 'allow_once' as const },
    ],
  };
  assert.equal(classify(request), 'question');
  assert.equal(
    classify({
      ...request,
      toolCall: { ...request.toolCall, toolCallId: 'tool-edit', kind: 'edit' },
    }),
    'permission',
  );
});

// Labels are the verified adapter contract; IDs must never be synthesized.
test('official variants group complete and partial families while preserving opaque IDs', () => {
  const result = antigravityAcpAdapter.describeModels!([
    { id: 'flash-high', name: 'Gemini 3.8 Flash (High)' },
    { id: 'flash-mid', name: 'Gemini 3.8 Flash (Medium)' },
    { id: 'flash-low', name: 'Gemini 3.8 Flash (Low)' },
    { id: 'gemini-pro-agent', name: 'Gemini 3.1 Pro (High)' },
    { id: 'pro-low', name: 'Gemini 3.1 Pro (Low)' },
    { id: 'other', name: 'Unknown (High)' },
  ]);
  assert.deepEqual(result.modelGroups, [
    {
      id: 'Gemini 3.8 Flash',
      name: 'Gemini 3.8 Flash',
      variants: [
        { modelId: 'flash-low', level: 'low' },
        { modelId: 'flash-mid', level: 'medium' },
        { modelId: 'flash-high', level: 'high' },
      ],
    },
    {
      id: 'Gemini 3.1 Pro',
      name: 'Gemini 3.1 Pro',
      variants: [
        { modelId: 'pro-low', level: 'low' },
        { modelId: 'gemini-pro-agent', level: 'high' },
      ],
    },
  ]);
  assert.equal(result.models[0]?.providerType, 'google');
  assert.deepEqual(result.models.at(-1), { id: 'other', name: 'Unknown (High)' });
});

for (const names of [
  ['Gemini 3.8 Flash (High)'],
  ['Gemini 3.8 Flash (High)', 'Gemini 3.8 Flash (High)', 'Gemini 3.8 Flash (Low)'],
  ['Gemini 3.8 Flash (High)', 'Gemini 3.8 Flash (Low)', 'Gemini 3.8 Flash (Auto)'],
  ['Unrecognized (High)', 'Unrecognized (Low)'],
])
  test(`ambiguous or non-switchable families keep their original rows: ${names.join(', ')}`, () => {
    const models = names.map((name, index) => ({ id: `opaque-${index}`, name }));
    const result = antigravityAcpAdapter.describeModels!(models);
    assert.deepEqual(result.modelGroups, []);
    assert.deepEqual(
      result.models.map(({ id, name }) => ({ id, name })),
      models,
    );
  });
