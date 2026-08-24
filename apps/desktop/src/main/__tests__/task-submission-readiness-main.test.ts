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
import test from 'node:test';
import type { LlmConnection } from '@maka/core/llm-connections';
import {
  createDesktopTaskSubmissionReadinessService,
  resolveStoredModelTarget,
} from '../task-submission-readiness-main.js';

test('keeps credential lookup failure unknown instead of inventing a repair failure', async () => {
  const service = createDesktopTaskSubmissionReadinessService({
    workspaceRoot: '/workspace',
    runtimeState: () => ({ state: 'ready', checkedAt: 90 }),
    resolveModelTarget: async () => ({
      kind: 'resolved',
      connection: connection(),
      hasSecret: undefined,
    }),
    inspectWorkspace: async () => 'ready',
    now: () => 100,
  });

  const snapshot = await service.getSnapshot({ model: 'model-a' });
  assert.equal(snapshot.state, 'unknown');
  assert.equal(snapshot.blockers[0]?.blockerCode, 'model_credentials_unknown');
});

test('reports a closed runtime when model catalog resolution is unavailable', async () => {
  const service = createDesktopTaskSubmissionReadinessService({
    workspaceRoot: '/workspace',
    runtimeState: () => ({ state: 'unavailable', checkedAt: 90 }),
    resolveModelTarget: async () => ({ kind: 'unknown' }),
    inspectWorkspace: async (cwd) => cwd === '/missing' ? 'unavailable' : 'ready',
    now: () => 100,
  });

  const snapshot = await service.getSnapshot({ cwd: '/missing' });
  assert.equal(snapshot.state, 'unavailable');
  assert.deepEqual(snapshot.blockers.map(({ blockerCode }) => blockerCode), [
    'runtime_unavailable',
    'model_target_unknown',
    'workspace_unavailable',
  ]);
});

test('passes an explicit slug to one model-target resolution without requiring a default read', async () => {
  const requestedSlugs: Array<string | undefined> = [];
  const service = createDesktopTaskSubmissionReadinessService({
    workspaceRoot: '/workspace',
    runtimeState: () => ({ state: 'ready', checkedAt: 90 }),
    resolveModelTarget: async (requestedSlug) => {
      requestedSlugs.push(requestedSlug);
      return { kind: 'connection_missing', connectionSlug: requestedSlug ?? 'unexpected' };
    },
    inspectWorkspace: async () => 'ready',
    now: () => 100,
  });

  const snapshot = await service.getSnapshot({ connectionSlug: 'deleted' });
  assert.deepEqual(requestedSlugs, ['deleted']);
  assert.equal(snapshot.blockers[0]?.blockerCode, 'model_connection_missing');
});

test('resolves connection and default from one immutable catalog snapshot', async () => {
  let reads = 0;
  const resolution = await resolveStoredModelTarget(undefined, {
    getSnapshot: async () => {
      reads += 1;
      return { defaultSlug: 'provider', connections: [connection()] };
    },
    hasCredential: async (candidate) => candidate.slug === 'provider',
  });

  assert.equal(reads, 1);
  assert.equal(resolution.kind, 'resolved');
  if (resolution.kind === 'resolved') {
    assert.equal(resolution.connection.slug, 'provider');
    assert.equal(resolution.hasSecret, true);
  }
});

test('rejects malformed renderer input before reading stores', async () => {
  let reads = 0;
  const service = createDesktopTaskSubmissionReadinessService({
    workspaceRoot: '/workspace',
    runtimeState: () => ({ state: 'ready', checkedAt: 90 }),
    resolveModelTarget: async () => { reads += 1; return { kind: 'missing_default' }; },
  });

  await assert.rejects(service.getSnapshot({ cwd: '', extra: true }), /INVALID_TASK_READINESS_REQUEST/);
  assert.equal(reads, 0);
});


test('maps a missing cwd to repairable workspace_missing', async () => {
  const service = createDesktopTaskSubmissionReadinessService({
    workspaceRoot: '/workspace',
    runtimeState: () => ({ state: 'ready', checkedAt: 90 }),
    resolveModelTarget: async () => ({ kind: 'resolved', connection: connection(), hasSecret: true }),
    inspectWorkspace: async () => 'missing',
    now: () => 100,
  });

  const snapshot = await service.getSnapshot({ cwd: '/gone' });
  assert.equal(snapshot.state, 'repair_required');
  assert.equal(snapshot.blockers[0]?.blockerCode, 'workspace_missing');
  assert.deepEqual(snapshot.blockers[0]?.repairTarget, { kind: 'workspace_picker' });
});

function connection(): LlmConnection {
  return {
    slug: 'provider',
    name: 'Provider',
    providerType: 'openai-compatible',
    enabled: true,
    defaultModel: 'model-a',
    enabledModelIds: ['model-a'],
    models: [{ id: 'model-a' }],
    createdAt: 1,
    updatedAt: 1,
  };
}
