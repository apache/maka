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
import { setTimeout as delay } from 'node:timers/promises';

export async function createMessageSession(
  connection,
  workspace,
  sessionId,
  baseUrl,
  sandboxMode = 'workspace-write',
) {
  const request = (op, input) => connection.request(op, input, 3000);
  const created = await createModelConnection(request, {
    providerName: 'openai-compatible',
    slug: 'submit-fixture',
    name: 'Submit fixture',
    baseUrl: baseUrl,
    apiKey: 'dummy-local-fixture',
    enabledModelIds: ['fixture-model'],
    modelOverrides: { 'fixture-model': { contextWindow: 200000 } },
  });
  const basis = created.connection;
  await request('connection.catalog.set-default-target', {
    expectedCatalogRevision: created.catalogRevision,
    target: { connectionId: basis.connectionId, modelId: 'fixture-model' },
  });
  await request('session.create', {
    sessionId,
    sandboxMode,
    workspace: { kind: 'host_path', path: workspace },
    modelTarget: { kind: 'default' },
  });
  return basis;
}

export async function waitMessageTerminal(request, sessionId, turnId) {
  for (let index = 0; index < 300; index++) {
    const turn = await request('turn.query', { sessionId, turnId });
    if (['completed', 'cancelled', 'failed'].includes(turn.status)) return turn;
    await delay(10);
  }
  throw new Error('Message Turn did not reach terminal');
}
