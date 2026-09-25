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
import { createModelConnection } from './client-model-connection.mjs';
import { createDefaultRuntimePolicy } from '../../packages/core/src/runtime-policy.ts';

export const proxyLocator = { scope: 'network_proxy', kind: 'password' };
export const requestFor = (connection) => (operation, input) =>
  connection.request(operation, input, 5000);

export async function settingsSnapshot(request) {
  const [policy, proxy] = await Promise.all([
    request('runtime.policy.query', {}),
    request('credential.vault.query', { locator: proxyLocator }),
  ]);
  for (const [result, locator] of [[proxy, proxyLocator]]) {
    assert.equal(result.kind, 'status');
    assert.deepEqual(result.status.locator, locator);
    assert(!Object.hasOwn(result.status, 'secret'));
    if (!result.status.configured) {
      assert.equal(result.status.credentialId, null);
      assert.equal(result.status.revision, null);
      assert.equal(result.status.updatedAt, null);
    } else {
      assert.equal(typeof result.status.credentialId, 'string');
      assert(result.status.credentialId.length > 0);
      assert(result.status.revision > 0);
      assert(Number.isSafeInteger(result.status.updatedAt) && result.status.updatedAt >= 0);
    }
  }
  // request() has already run the unmodified source full-shape decoder.
  assert.deepEqual(policy.policy, {
    ...createDefaultRuntimePolicy(),
    chatDefaults: policy.policy.chatDefaults,
  });
  return { policy, proxy };
}

export async function configureModel(request, baseUrl = 'http://127.0.0.1:9/v1') {
  const initial = await request('connection.catalog.query', { kind: 'start' });
  assert.equal(initial.revision, 0);
  const created = await createModelConnection(request, {
    providerName: 'openai-compatible',
    slug: 'runtime-policy',
    name: 'Runtime policy fixture',
    baseUrl: baseUrl,
    apiKey: 'runtime-policy-test-model-key',
    enabledModelIds: ['fixture-model'],
    modelOverrides: { 'fixture-model': { contextWindow: 200000 } },
  });
  const selected = await request('connection.catalog.set-default-target', {
    expectedCatalogRevision: created.catalogRevision,
    target: { connectionId: created.connection.connectionId, modelId: 'fixture-model' },
  });
  assert.equal(selected.kind, 'committed');
  const proxy = await request('credential.vault.set', {
    locator: proxyLocator,
    expected: null,
    secret: 'runtime-policy-test-proxy-secret',
  });
  assert.equal(proxy.kind, 'committed');
  return { connection: created.connection, proxy: proxy.status };
}

export function createInput(workspace, sessionId, sandboxMode) {
  return {
    sessionId,
    name: sessionId,
    workspace: { kind: 'host_path', path: workspace },
    modelTarget: { kind: 'default' },
    ...(sandboxMode === undefined ? {} : { sandboxMode }),
  };
}

export function modelDefault(session, sandboxMode) {
  assert.equal(session.sandboxMode, sandboxMode);
  assert.equal(
    Object.hasOwn(session, 'thinkingLevel'),
    false,
    'omitted thinking preserves the composer choice of model default',
  );
}

export const querySession = async (request, id) =>
  (await request('session.catalog.query', { kind: 'get', sessionId: id })).session;
