import { describe, test } from 'node:test';
import { expect } from '../test-helpers.js';
import {
  deriveCapabilityReadiness,
  runtimeProbeFromBotReadiness,
  type CapabilityFeatureSignal,
  type CapabilityRuntimeProbeSignal,
  type CapabilityPermissionRequirement,
} from '../capabilities.js';

const enabledFeature: CapabilityFeatureSignal = { state: 'enabled', source: 'settings' };
const presentConfig = { state: 'present', source: 'settings' } as const;
const noRuntime: CapabilityRuntimeProbeSignal = { state: 'not_run', source: 'runtime_probe' };

describe('permission and capability snapshot contracts', () => {
  test('disabled feature is paused, not permission denied', () => {
    expect(
      deriveCapabilityReadiness({
        feature: { state: 'disabled', source: 'settings' },
        configuration: presentConfig,
        osPermissions: [requiredPermission('accessibility', 'granted')],
        runtimeProbe: noRuntime,
      }),
    ).toBe('paused');
  });

  test('missing configuration is not_configured before runtime health', () => {
    expect(
      deriveCapabilityReadiness({
        feature: enabledFeature,
        configuration: { state: 'missing', source: 'settings', reason: 'missing token' },
        osPermissions: [],
        runtimeProbe: { state: 'healthy', source: 'runtime_probe' },
      }),
    ).toBe('not_configured');
  });

  test('required denied or unsupported OS permission blocks capability', () => {
    expect(
      deriveCapabilityReadiness({
        feature: enabledFeature,
        configuration: presentConfig,
        osPermissions: [requiredPermission('accessibility', 'denied')],
        runtimeProbe: noRuntime,
      }),
    ).toBe('denied');

    expect(
      deriveCapabilityReadiness({
        feature: enabledFeature,
        configuration: presentConfig,
        osPermissions: [requiredPermission('screen_recording', 'unsupported')],
        runtimeProbe: noRuntime,
      }),
    ).toBe('denied');
  });

  test('optional denied OS permission does not block a partial shipped capability', () => {
    expect(
      deriveCapabilityReadiness({
        feature: { state: 'partial', source: 'runtime', reason: 'local activity aggregation only' },
        configuration: presentConfig,
        osPermissions: [{ id: 'screen_recording', required: false, status: 'denied' }],
        runtimeProbe: noRuntime,
      }),
    ).toBe('not_configured');
  });

  test('required not_determined or unknown OS permission is not configured yet', () => {
    expect(
      deriveCapabilityReadiness({
        feature: enabledFeature,
        configuration: presentConfig,
        osPermissions: [requiredPermission('screen_recording', 'not_determined')],
        runtimeProbe: noRuntime,
      }),
    ).toBe('not_configured');

    expect(
      deriveCapabilityReadiness({
        feature: enabledFeature,
        configuration: presentConfig,
        osPermissions: [requiredPermission('automation', 'unknown')],
        runtimeProbe: noRuntime,
      }),
    ).toBe('not_configured');
  });

  test('degraded runtime probe is surfaced after feature and permission gates pass', () => {
    expect(
      deriveCapabilityReadiness({
        feature: enabledFeature,
        configuration: presentConfig,
        osPermissions: [requiredPermission('accessibility', 'granted')],
        runtimeProbe: { state: 'degraded', source: 'runtime_probe', reason: 'probe failed' },
      }),
    ).toBe('degraded');
  });

  test('bot credentials_valid is runtime not_run, not operational', () => {
    const probe = runtimeProbeFromBotReadiness('credentials_valid', 123, 'getMe ok');

    expect(probe.state).toBe('not_run');
    expect(probe.source).toBe('bot_registry');
    expect(probe.lastCheckedAt).toBe(123);
  });
});

function requiredPermission(
  id: CapabilityPermissionRequirement['id'],
  status: CapabilityPermissionRequirement['status'],
): CapabilityPermissionRequirement {
  return { id, required: true, status };
}
