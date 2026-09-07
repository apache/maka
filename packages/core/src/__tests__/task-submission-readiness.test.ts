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
import { describe, test } from 'node:test';
import type { LlmConnection } from '../llm-connections.js';
import {
  deriveTaskSubmissionReadiness,
  type DeriveTaskSubmissionReadinessInput,
} from '../task-submission-readiness.js';

describe('task submission readiness', () => {
  test('reuses connection readiness and routes an invalid model to its connection', () => {
    const input = readyInput();
    if (input.modelTarget.kind !== 'resolved') throw new Error('expected resolved model target');
    input.modelTarget.requestedModel = 'removed-model';
    const snapshot = deriveTaskSubmissionReadiness(input);

    assert.strictEqual(snapshot.state, 'repair_required');
    assert.deepStrictEqual(snapshot.blockers[0], {
      id: 'model_target',
      state: 'repair_required',
      authority: 'connection_readiness',
      checkedAt: 90,
      blockerCode: 'model_model_not_enabled',
      repairTarget: { kind: 'connection', connectionSlug: 'provider' },
    });
  });

  test('does not turn unresolved credentials into a confirmed repair failure', () => {
    const input = readyInput();
    if (input.modelTarget.kind !== 'resolved') throw new Error('expected resolved model target');
    input.modelTarget.hasSecret = undefined;
    const snapshot = deriveTaskSubmissionReadiness(input);

    assert.strictEqual(snapshot.state, 'unknown');
    assert.strictEqual(snapshot.blockers[0]?.blockerCode, 'model_credentials_unknown');
    assert.strictEqual(snapshot.blockers[0]?.repairTarget, undefined);
  });

  test('distinguishes unavailable runtime and workspace from repairable setup', () => {
    const runtimeInput = readyInput();
    runtimeInput.runtime.state = 'unavailable';
    assert.strictEqual(deriveTaskSubmissionReadiness(runtimeInput).state, 'unavailable');

    const workspaceInput = readyInput();
    workspaceInput.workspace.state = 'missing';
    const workspace = deriveTaskSubmissionReadiness(workspaceInput);
    assert.strictEqual(workspace.state, 'repair_required');
    assert.deepStrictEqual(workspace.blockers[0]?.repairTarget, { kind: 'workspace_picker' });
  });

  test('only requested capabilities participate in submission readiness', () => {
    const input = readyInput();
    input.capabilities = [
      { id: 'computer_use', state: 'unavailable', checkedAt: 80 },
      { id: 'git', state: 'ready', checkedAt: 81 },
    ];

    const ordinaryTask = deriveTaskSubmissionReadiness(input);
    assert.strictEqual(ordinaryTask.state, 'ready');
    assert.strictEqual(ordinaryTask.dimensions.length, 3);

    input.requestedCapabilityIds = ['computer_use'];
    const computerUseTask = deriveTaskSubmissionReadiness(input);
    assert.strictEqual(computerUseTask.state, 'unavailable');
    assert.strictEqual(computerUseTask.blockers[0]?.id, 'capability:computer_use');
  });

  test('treats a missing requested capability observation as unknown', () => {
    const input = readyInput();
    input.requestedCapabilityIds = ['git'];
    const snapshot = deriveTaskSubmissionReadiness(input);

    assert.strictEqual(snapshot.state, 'unknown');
    assert.strictEqual(snapshot.blockers[0]?.blockerCode, 'capability_unknown');
    assert.strictEqual(snapshot.blockers[0]?.repairTarget, undefined);
  });
});

function readyInput(): DeriveTaskSubmissionReadinessInput {
  return {
    checkedAt: 100,
    runtime: { state: 'ready', checkedAt: 95 },
    modelTarget: {
      kind: 'resolved',
      connection: connection(),
      hasSecret: true,
      requestedModel: 'model-a',
      checkedAt: 90,
    },
    workspace: { state: 'ready', checkedAt: 85 },
  };
}

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
