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
import type { SessionHeader } from '@maka/core/session';
import { HostWorkHubTargetExecutionAuthority } from '../server/workhub-target-execution-authority.js';
import type { WorkHubTargetExecutionAuthorityOptions } from '../server/workhub-target-execution-authority.js';
import { WorkHubActionEffectFailure } from '../server/workhub-coordination-action-gate.js';

function fixture(model: string, enabled: readonly string[]) {
  const header = {
    id: 'target',
    name: 'Target task',
    backend: 'ai-sdk',
    llmConnectionId: 'connection',
    llmConnectionSlug: 'test',
    model,
  } as SessionHeader;
  const connection = configuredConnection('connection', 'test', 'Test', enabled);
  const options: WorkHubTargetExecutionAuthorityOptions = {
    readSession: async () => ({ header, revision: 1, committedAt: 1 }),
    runtimePolicy: {
      resolveExecutionConnection: async () => ({
        kind: 'ready',
        connection,
        secretMaterial: {},
        networkProxy: { enabled: false },
      }),
      connectionCatalog: {
        getSnapshot: async () => {
          throw new Error('Must not search for replacement models');
        },
      },
    } as unknown as WorkHubTargetExecutionAuthorityOptions['runtimePolicy'],
  };
  return { header, connection, authority: new HostWorkHubTargetExecutionAuthority(options) };
}

test('an available target model remains unchanged', async () => {
  const f = fixture('current', ['current']);
  await f.authority.assertReady('target');
  assert.equal(f.header.model, 'current');
});

test('an unavailable target model returns actionable failure without a repair workflow', async () => {
  const f = fixture('removed', ['replacement']);
  await assert.rejects(
    f.authority.assertReady('target'),
    (error) =>
      error instanceof WorkHubActionEffectFailure &&
      error.code === 'operation_unavailable' &&
      /Update its model in the task settings/.test(error.message),
  );
  assert.equal(f.header.model, 'removed');
});

test('final admission rechecks model availability', async () => {
  const f = fixture('current', ['current']);
  await f.authority.assertReady('target');
  f.connection.enabledModelIds = [];
  await assert.rejects(f.authority.assertReady('target'), WorkHubActionEffectFailure);
});
function configuredConnection(
  connectionId: string,
  slug: string,
  name: string,
  enabledModelIds: readonly string[],
) {
  return {
    connectionId,
    revision: 1,
    slug,
    name,
    providerType: 'openai' as const,
    enabled: true,
    enabledModelIds,
    models: enabledModelIds.map((id) => ({ id, capabilities: { chat: true } })),
    modelSource: 'fetched' as const,
    catalogEntries: enabledModelIds.map((id) => ({
      id,
      displayName: id,
      canUseAsChatDefault: true,
      isDefault: false,
      thinkingLevels: [],
      supportsVision: false,
    })),
  };
}
