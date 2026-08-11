import { describe, test } from 'node:test';
import { expect } from '../test-helpers.js';
import {
  buildHealthSnapshot,
  healthSignalFromCapability,
  healthSignalFromConnection,
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

    expect(result.status).toBe('ok');
    expect(result.layer).toBe('validation');
    expect(result.source).toBe('connection_test');
  });

  test('LLM runtime probe is separate from credential validation', () => {
    const unknown = healthSignalFromConnectionRuntime(
      connection({ lastTestStatus: 'verified' }),
      undefined,
      30,
    );
    expect(unknown?.status).toBe('unknown');
    expect(unknown?.layer).toBe('runtime_probe');
    expect(unknown?.source).toBe('runtime_probe');

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
    expect(ok?.status).toBe('ok');
    expect(ok?.checkedAt).toBe(40);

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
    expect(failed?.status).toBe('warning');
    expect(failed?.blocksSend).toBe(false);
  });

  test('disabled or unconfigured connections do not emit runtime probe health', () => {
    expect(healthSignalFromConnectionRuntime(connection({ enabled: false }), undefined, 30)).toBe(
      undefined,
    );
    expect(healthSignalFromConnectionRuntime(connection({ defaultModel: '' }), undefined, 30)).toBe(
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
    expect(snapshot.signals.map((signal) => signal.scope)).toEqual(['llm_connection', 'bot']);
    expect(snapshot.summary).toEqual({ ok: 1, info: 0, warning: 0, error: 0, unknown: 1 });
  });

  test('capability denied and degraded remain distinct health states', () => {
    const denied = healthSignalFromCapability(
      capability('computer_use', 'denied', {
        osPermissions: [{ id: 'accessibility', required: true, status: 'denied' }],
      }),
    );
    const degraded = healthSignalFromCapability(capability('bot:telegram', 'degraded'));

    expect(denied.status).toBe('error');
    expect(denied.layer).toBe('permission');
    expect(degraded.status).toBe('error');
    expect(degraded.layer).toBe('runtime_probe');
    expect(degraded.scope).toBe('bot');
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

    expect(partial.status).toBe('warning');
    expect(partial.layer).toBe('feature');
    expect(partial.blocksCapability).toBe(false);
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
