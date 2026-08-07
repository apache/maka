import { describe, test } from 'node:test';
import { expect } from '../test-helpers.js';
import {
  CAPABILITY_READINESS_STATES,
  FEATURE_ENABLEMENT_STATES,
  OS_PERMISSION_STATES,
  deriveCapabilityReadiness,
  isCapabilityReadinessState,
  isOsPermissionState,
  runtimeProbeFromBotReadiness,
  type CapabilityFeatureSignal,
  type CapabilityRuntimeProbeSignal,
  type CapabilityPermissionRequirement,
} from '../capabilities.js';

const enabledFeature: CapabilityFeatureSignal = { state: 'enabled', source: 'settings' };
const presentConfig = { state: 'present', source: 'settings' } as const;
const noRuntime: CapabilityRuntimeProbeSignal = { state: 'not_run', source: 'runtime_probe' };

describe('permission and capability snapshot contracts', () => {
  test('locks permission and capability readiness enums', () => {
    expect(OS_PERMISSION_STATES).toEqual([
      'unsupported',
      'unknown',
      'not_determined',
      'denied',
      'granted',
    ]);
    expect(FEATURE_ENABLEMENT_STATES).toEqual(['not_available', 'partial', 'disabled', 'enabled']);
    expect(CAPABILITY_READINESS_STATES).toEqual([
      'not_configured',
      'denied',
      'enabled',
      'degraded',
      'paused',
    ]);
    expect(isOsPermissionState('granted')).toBe(true);
    expect(isOsPermissionState('authorized')).toBe(false);
    expect(isCapabilityReadinessState('enabled')).toBe(true);
    expect(isCapabilityReadinessState('operational')).toBe(false);
  });

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

  test('unavailable feature is not_configured even when OS permission is granted', () => {
    expect(
      deriveCapabilityReadiness({
        feature: { state: 'not_available', source: 'scaffold' },
        configuration: presentConfig,
        osPermissions: [requiredPermission('accessibility', 'granted')],
        runtimeProbe: { state: 'healthy', source: 'runtime_probe' },
      }),
    ).toBe('not_configured');
  });

  test('partial feature stays not_configured until runtime probe reports degradation', () => {
    expect(
      deriveCapabilityReadiness({
        feature: { state: 'partial', source: 'runtime', reason: 'local smoke only' },
        configuration: presentConfig,
        osPermissions: [requiredPermission('accessibility', 'granted')],
        runtimeProbe: { state: 'not_run', source: 'runtime_probe' },
      }),
    ).toBe('not_configured');
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

  test('unavailable runtime probe degrades an otherwise enabled capability', () => {
    expect(
      deriveCapabilityReadiness({
        feature: enabledFeature,
        configuration: presentConfig,
        osPermissions: [requiredPermission('accessibility', 'granted')],
        runtimeProbe: {
          state: 'not_available',
          source: 'runtime_probe',
          reason: 'service exited',
        },
      }),
    ).toBe('degraded');
  });

  test('degraded runtime probe still wins over partial feature copy', () => {
    expect(
      deriveCapabilityReadiness({
        feature: { state: 'partial', source: 'runtime', reason: 'local smoke only' },
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
