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
    assert.strictEqual(
      deriveCapabilityReadiness({
        feature: { state: 'disabled', source: 'settings' },
        configuration: presentConfig,
        osPermissions: [requiredPermission('accessibility', 'granted')],
        runtimeProbe: noRuntime,
      }),
      'paused',
    );
  });

  test('missing configuration is not_configured before runtime health', () => {
    assert.strictEqual(
      deriveCapabilityReadiness({
        feature: enabledFeature,
        configuration: { state: 'missing', source: 'settings', reason: 'missing token' },
        osPermissions: [],
        runtimeProbe: { state: 'healthy', source: 'runtime_probe' },
      }),
      'not_configured',
    );
  });

  test('required denied or unsupported OS permission blocks capability', () => {
    assert.strictEqual(
      deriveCapabilityReadiness({
        feature: enabledFeature,
        configuration: presentConfig,
        osPermissions: [requiredPermission('accessibility', 'denied')],
        runtimeProbe: noRuntime,
      }),
      'denied',
    );

    assert.strictEqual(
      deriveCapabilityReadiness({
        feature: enabledFeature,
        configuration: presentConfig,
        osPermissions: [requiredPermission('screen_recording', 'unsupported')],
        runtimeProbe: noRuntime,
      }),
      'denied',
    );
  });

  test('optional denied OS permission does not block a partial shipped capability', () => {
    assert.strictEqual(
      deriveCapabilityReadiness({
        feature: { state: 'partial', source: 'runtime', reason: 'local activity aggregation only' },
        configuration: presentConfig,
        osPermissions: [{ id: 'screen_recording', required: false, status: 'denied' }],
        runtimeProbe: noRuntime,
      }),
      'not_configured',
    );
  });

  test('required not_determined or unknown OS permission is not configured yet', () => {
    assert.strictEqual(
      deriveCapabilityReadiness({
        feature: enabledFeature,
        configuration: presentConfig,
        osPermissions: [requiredPermission('screen_recording', 'not_determined')],
        runtimeProbe: noRuntime,
      }),
      'not_configured',
    );

    assert.strictEqual(
      deriveCapabilityReadiness({
        feature: enabledFeature,
        configuration: presentConfig,
        osPermissions: [requiredPermission('automation', 'unknown')],
        runtimeProbe: noRuntime,
      }),
      'not_configured',
    );
  });

  test('degraded runtime probe is surfaced after feature and permission gates pass', () => {
    assert.strictEqual(
      deriveCapabilityReadiness({
        feature: enabledFeature,
        configuration: presentConfig,
        osPermissions: [requiredPermission('accessibility', 'granted')],
        runtimeProbe: { state: 'degraded', source: 'runtime_probe', reason: 'probe failed' },
      }),
      'degraded',
    );
  });

  test('bot credentials_valid is runtime not_run, not operational', () => {
    const probe = runtimeProbeFromBotReadiness('credentials_valid', 123, 'getMe ok');

    assert.strictEqual(probe.state, 'not_run');
    assert.strictEqual(probe.source, 'bot_registry');
    assert.strictEqual(probe.lastCheckedAt, 123);
  });
});

function requiredPermission(
  id: CapabilityPermissionRequirement['id'],
  status: CapabilityPermissionRequirement['status'],
): CapabilityPermissionRequirement {
  return { id, required: true, status };
}
