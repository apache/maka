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
    expect(result.message).toBe('凭据与端点验证已通过。');
    expect(result.detail).toContain('不代表发送、流式输出或中断通路已经运行通过');
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
    expect(unknown?.message).toBe('等待完成发送运行态探测。');
    expect(/还没有记录到发送运行态探测/.test(unknown?.message ?? '')).toBe(false);

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
    expect(ok?.detail).toContain('模型=glm-4.7');

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
    // PR-HEALTH-1 (xuan msg `e4887ffd` + kenji msg `bd8ee4c1`, I2 — demote):
    // historical runtime_probe error is surfaced as a warning, NOT a send
    // gate. The previous behavior (`blocksSend === true`) impersonated a
    // current send block from a historical observation. `requireReadyConnection`
    // remains the authoritative send gate.
    expect(failed?.blocksSend).toBe(false);
    expect(failed?.detail).toContain('错误类型=auth');
  });

  test('disabled or unconfigured connections do not emit runtime probe health', () => {
    expect(healthSignalFromConnectionRuntime(connection({ enabled: false }), undefined, 30)).toBe(
      undefined,
    );
    expect(healthSignalFromConnectionRuntime(connection({ defaultModel: '' }), undefined, 30)).toBe(
      undefined,
    );
  });

  test('unconfigured connection health copy is an actionable waiting state', () => {
    const result = healthSignalFromConnection(connection({ defaultModel: '' }), 20);

    expect(result.message).toBe('等待选择默认模型。');
    expect(/缺少默认模型/.test(result.message)).toBe(false);
    expect(result.blocksSend).toBe(true);
  });

  /*
   * PR-HEALTH-1 — E1 lock (three-layer separation):
   * Connection auth state and bot capability readiness must derive
   * independently. The Health snapshot must surface BOTH as separate
   * signals — neither layer should impersonate the other.
   */
  test('E1: bot capability operational + connection unverified → two independent signals', () => {
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

    // Connection layer reports its own status (unknown because no test yet),
    // independent of the bot layer.
    expect(connectionUnverified.scope).toBe('llm_connection');
    expect(connectionUnverified.status).toBe('unknown');
    expect(connectionUnverified.message).toBe('等待验证连接。');

    // Bot capability layer reports its own status from runtime probe,
    // independent of the connection's lastTestStatus.
    expect(botOperational.scope).toBe('bot');
    expect(botOperational.status).toBe('ok');

    // Combined snapshot keeps both layers distinct — neither one is
    // derived from the other; the user sees per-layer truth.
    const snapshot = buildHealthSnapshot(30, [connectionUnverified, botOperational]);
    expect(snapshot.signals.length).toBe(2);
    expect(snapshot.signals.some((s) => s.scope === 'llm_connection')).toBe(true);
    expect(snapshot.signals.some((s) => s.scope === 'bot')).toBe(true);
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
    expect(denied.message).toBe('能力被必要系统权限阻塞。');
    expect(degraded.status).toBe('error');
    expect(degraded.layer).toBe('runtime_probe');
    expect(degraded.message).toBe('能力运行态探测处于降级状态。');
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
