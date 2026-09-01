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
import {
  buildHealthSnapshot,
  healthSignalFromCapability,
  healthSignalFromConnection,
  workspaceHasDefaultModelTarget,
  healthSignalFromConnectionRuntime,
} from '../health.js';
import type { CapabilitySnapshot } from '../capabilities.js';
import type { LlmConnection } from '../llm-connections.js';

describe('HealthSignal contract', () => {
  test('verified LLM connection is validation health, not runtime operational', () => {
    const result = healthSignalFromConnection(
      connection({
        lastTestStatus: 'verified',
        lastTestAt: '2026-05-22T07:30:00.000Z',
      }),
      20,
    );

    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.layer, 'validation');
    assert.strictEqual(result.source, 'connection_test');
  });

  test('a missing default model warns only when the workspace has no default target', () => {
    // The catalog projects `defaultModel` onto exactly one connection (the
    // default target). With a default configured elsewhere, an enabled
    // connection with an empty `defaultModel` is the documented normal
    // state — informational, never send-blocking, and never a prompt to
    // find a per-connection setting that deliberately does not exist.
    const nonDefault = healthSignalFromConnection(
      connection({ defaultModel: '', enabledModelIds: ['glm-4.7'] }),
      20,
      { workspaceHasDefaultTarget: true },
    );
    assert.strictEqual(nonDefault.status, 'info');
    assert.strictEqual(nonDefault.blocksSend, false);

    // With NO default anywhere, a new chat cannot start: that is the
    // actionable, send-blocking configuration gap.
    const noDefaultAnywhere = healthSignalFromConnection(connection({ defaultModel: '' }), 20, {
      workspaceHasDefaultTarget: false,
    });
    assert.strictEqual(noDefaultAnywhere.status, 'warning');
    assert.strictEqual(noDefaultAnywhere.blocksSend, true);

    // The informational note must not paper over real per-connection
    // blockers: failing validation still wins on a non-default connection…
    const reauth = healthSignalFromConnection(
      connection({
        defaultModel: '',
        enabledModelIds: ['glm-4.7'],
        lastTestStatus: 'needs_reauth',
      }),
      20,
      { workspaceHasDefaultTarget: true },
    );
    assert.strictEqual(reauth.status, 'error');
    assert.strictEqual(reauth.blocksSend, true);

    // …and a connection with no enabled models cannot claim that explicit
    // selection works — there is nothing to select.
    const emptyInventory = healthSignalFromConnection(
      connection({ defaultModel: '', enabledModelIds: [] }),
      20,
      { workspaceHasDefaultTarget: true },
    );
    assert.strictEqual(emptyInventory.status, 'warning');
    assert.strictEqual(emptyInventory.blocksSend, false);

    // The default target itself keeps its validation-layer signals.
    const configured = healthSignalFromConnection(
      connection({ lastTestStatus: 'verified', lastTestAt: '2026-05-22T07:30:00.000Z' }),
      20,
      { workspaceHasDefaultTarget: true },
    );
    assert.strictEqual(configured.status, 'ok');
  });

  test('a disabled default holder does not count as a workspace default', () => {
    // Disabling the connection that holds the default target (ordinary UI,
    // nothing clears defaultTarget) leaves its projected defaultModel in
    // place. Counting it would show an all-clear health page in exactly
    // the state where sends fail with connection_disabled.
    const disabledHolder = connection({ enabled: false }); // defaultModel: 'glm-4.7'
    const other = connection({ slug: 'other', defaultModel: '', enabledModelIds: ['m'] });
    assert.strictEqual(workspaceHasDefaultModelTarget([disabledHolder, other]), false);
    assert.strictEqual(workspaceHasDefaultModelTarget([connection({}), other]), true);

    // With the holder disabled, the OTHER enabled connections escalate back
    // to the send-blocking warning — the workspace genuinely has no default.
    const signal = healthSignalFromConnection(other, 20, {
      workspaceHasDefaultTarget: workspaceHasDefaultModelTarget([disabledHolder, other]),
    });
    assert.strictEqual(signal.status, 'warning');
    assert.strictEqual(signal.blocksSend, true);
  });

  test('LLM runtime probe is separate from credential validation', () => {
    const unknown = healthSignalFromConnectionRuntime(
      connection({ lastTestStatus: 'verified' }),
      undefined,
      30,
    );
    assert.strictEqual(unknown?.status, 'unknown');
    assert.strictEqual(unknown?.layer, 'runtime_probe');
    assert.strictEqual(unknown?.source, 'runtime_probe');

    const ok = healthSignalFromConnectionRuntime(
      connection({ lastTestStatus: 'verified' }),
      {
        id: 'usage_turn_1',
        ts: 40,
        connectionSlug: 'zai',
        providerId: 'zai-coding-plan',
        modelId: 'glm-4.7',
        inputTokens: 1,
        outputTokens: 2,
        cacheMissTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: 3,
        costUsd: 0,
        latencyMs: 250,
        status: 'success',
      },
      30,
    );
    assert.strictEqual(ok?.status, 'ok');
    assert.strictEqual(ok?.checkedAt, 40);

    const failed = healthSignalFromConnectionRuntime(
      connection({ lastTestStatus: 'verified' }),
      {
        id: 'usage_turn_2',
        ts: 50,
        connectionSlug: 'zai',
        providerId: 'zai-coding-plan',
        modelId: 'glm-4.7',
        inputTokens: 1,
        outputTokens: 0,
        cacheMissTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: 1,
        costUsd: 0,
        latencyMs: 90,
        status: 'error',
        errorClass: 'auth',
      },
      30,
    );
    assert.strictEqual(failed?.status, 'warning');
    assert.strictEqual(failed?.blocksSend, false);
  });

  test('disabled or unconfigured connections do not emit runtime probe health', () => {
    assert.strictEqual(
      healthSignalFromConnectionRuntime(connection({ enabled: false }), undefined, 30),
      undefined,
    );
    assert.strictEqual(
      healthSignalFromConnectionRuntime(connection({ defaultModel: '' }), undefined, 30),
      undefined,
    );
  });

  test('summarizes independent connection and capability signals', () => {
    const connectionUnverified = healthSignalFromConnection(
      connection({
        lastTestStatus: undefined,
      }),
      20,
    );
    const botOperational = healthSignalFromCapability(
      capability('bot:telegram', 'enabled', {
        runtimeProbe: { state: 'healthy', source: 'bot_registry', lastCheckedAt: 15 },
      }),
    );

    const snapshot = buildHealthSnapshot(30, [connectionUnverified, botOperational]);
    assert.deepStrictEqual(
      snapshot.signals.map((signal) => signal.scope),
      ['llm_connection', 'bot'],
    );
    assert.deepStrictEqual(snapshot.summary, { ok: 1, info: 0, warning: 0, error: 0, unknown: 1 });
  });

  test('capability denied and degraded remain distinct health states', () => {
    const denied = healthSignalFromCapability(
      capability('computer_use', 'denied', {
        osPermissions: [{ id: 'accessibility', required: true, status: 'denied' }],
      }),
    );
    const degraded = healthSignalFromCapability(capability('bot:telegram', 'degraded'));

    assert.strictEqual(denied.status, 'error');
    assert.strictEqual(denied.layer, 'permission');
    assert.strictEqual(degraded.status, 'error');
    assert.strictEqual(degraded.layer, 'runtime_probe');
    assert.strictEqual(degraded.scope, 'bot');
  });

  test('partial-only capabilities are warnings, not app-wide error states', () => {
    const partial = healthSignalFromCapability(
      capability('activity_recorder', 'not_configured', {
        feature: {
          state: 'partial',
          source: 'runtime',
          reason: 'Daily Review 已聚合本地会话 / 工具 / 模型活动；当前不包含屏幕与应用级录制',
        },
        runtimeProbe: {
          state: 'not_run',
          source: 'runtime_probe',
          reason: '打开 Daily Review 可查看本地活动聚合结果',
        },
      }),
    );

    assert.strictEqual(partial.status, 'warning');
    assert.strictEqual(partial.layer, 'feature');
    assert.strictEqual(partial.blocksCapability, false);
  });
});

function connection(patch: Partial<LlmConnection>): LlmConnection {
  return {
    slug: 'zai',
    name: 'Z.ai',
    providerType: 'zai-coding-plan',
    defaultModel: 'glm-4.7',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

function capability(
  id: CapabilitySnapshot['id'],
  readiness: CapabilitySnapshot['readiness'],
  patch: Partial<CapabilitySnapshot> = {},
): CapabilitySnapshot {
  return {
    id,
    label: id,
    readiness,
    feature: { state: 'enabled', source: 'settings' },
    configuration: { state: 'present', source: 'settings' },
    osPermissions: [],
    actionApproval: { state: 'required_per_action', source: 'capability_policy' },
    memoryAcceptance: { state: 'not_applicable', source: 'not_applicable' },
    runtimeProbe: {
      state: readiness === 'degraded' ? 'degraded' : 'not_run',
      source: 'runtime_probe',
    },
    canRevoke: false,
    canPause: false,
    guidance: [],
    auditEvents: [],
    updatedAt: 1,
    ...patch,
  };
}
