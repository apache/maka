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

import { Notification, systemPreferences } from 'electron';
import { BOT_PROVIDERS, type BotProvider } from '@maka/core/bot-chat-settings';
import {
  deriveCapabilityReadiness,
  runtimeProbeFromBotReadiness,
  type CapabilityActionApprovalSignal,
  type CapabilityConfigurationSignal,
  type CapabilityFeatureSignal,
  type CapabilityMemoryAcceptanceSignal,
  type CapabilityPermissionRequirement,
  type CapabilityReasonCode,
  type CapabilityRuntimeProbeSignal,
  type CapabilitySnapshot,
  type CapabilitySnapshotCollection,
  type OsPermissionId,
  type OsPermissionSnapshot,
  type PermissionSnapshot,
} from '@maka/core/capabilities';
import { type AppSettings } from '@maka/core/settings';
import type { CuBackendId } from '@maka/computer-use';
import type { BotStatus } from '@maka/runtime/bots';
import type { computerUseServiceHealth } from './computer-use-host.js';
import {
  mapMediaAccessStatus,
  mediaPermissionActions,
  supportsMediaPermissionProbe,
} from './os-permission-policy.js';

const MAC_TCC_PERMISSIONS: OsPermissionId[] = ['accessibility', 'screen_recording', 'automation'];

export function buildPermissionSnapshot(now = Date.now(), platform: NodeJS.Platform = process.platform): PermissionSnapshot {
  return {
    checkedAt: now,
    platform,
    permissions: {
      accessibility: accessibilitySnapshot(now, platform),
      screen_recording: mediaPermissionSnapshot('screen_recording', 'screen', now, platform),
      notifications: notificationSnapshot(now, platform),
      automation: automationSnapshot(now, platform),
    },
  };
}

export function buildCapabilitySnapshotCollection(input: {
  settings: AppSettings;
  permissions: PermissionSnapshot;
  botStatuses: Record<BotProvider, BotStatus>;
  computerUse?: {
    backendId: CuBackendId | 'none';
    health: ReturnType<typeof computerUseServiceHealth>;
  };
  now?: number;
}): CapabilitySnapshotCollection {
  const now = input.now ?? Date.now();
  const permissions = input.permissions.permissions;
  const capabilities: CapabilitySnapshot[] = [
    computerUseCapability(input.computerUse, permissions, now),
    staticCapability({
      id: 'activity_recorder',
      label: 'Activity Recorder',
      now,
      feature: {
        state: 'partial',
        source: 'runtime',
        reason: 'activity_recorder_partial',
      },
      requiredPermissions: [
        { id: 'screen_recording', required: false, status: permissions.screen_recording.status },
      ],
      actionApproval: { state: 'not_required', source: 'not_applicable' },
      memoryAcceptance: { state: 'disabled', source: 'memory_contract' },
      runtimeProbe: {
        state: 'not_run',
        source: 'runtime_probe',
        reason: 'activity_recorder_probe_hint',
      },
    }),
    staticCapability({
      id: 'memory_write',
      label: 'Memory',
      now,
      feature: {
        state: 'partial',
        source: 'runtime',
        reason: 'memory_partial',
      },
      requiredPermissions: [],
      actionApproval: { state: 'not_required', source: 'not_applicable' },
      memoryAcceptance: { state: 'draft_required', source: 'memory_contract' },
      runtimeProbe: {
        state: 'not_run',
        source: 'runtime_probe',
        reason: 'memory_no_probe',
      },
    }),
    ...BOT_PROVIDERS.map((provider) =>
      botCapability(provider, input.settings, input.botStatuses[provider], now),
    ),
  ];

  return { checkedAt: now, capabilities };
}

function computerUseCapability(
  input: {
    backendId: CuBackendId | 'none';
    health: ReturnType<typeof computerUseServiceHealth>;
  } | undefined,
  permissions: PermissionSnapshot['permissions'],
  now: number,
): CapabilitySnapshot {
  // Any selected executor is an executor. Naming one here made the capability
  // read `not_available` for a machine that had a working backend, merely a
  // different one.
  const artifactAvailable = input !== undefined && input.backendId !== 'none';
  return staticCapability({
    id: 'computer_use',
    label: 'Computer Use',
    now,
    feature: {
      state: artifactAvailable ? 'enabled' : 'not_available',
      source: 'runtime',
      reason: input === undefined || input.backendId === 'none' ? 'cu_artifact_missing' : 'cu_backend_status',
    },
    requiredPermissions: [
      { id: 'accessibility', required: true, status: permissions.accessibility.status },
      { id: 'screen_recording', required: true, status: permissions.screen_recording.status },
    ],
    actionApproval: {
      state: 'required_scoped_lease',
      source: 'capability_policy',
    },
    memoryAcceptance: { state: 'not_applicable', source: 'not_applicable' },
    runtimeProbe: {
      state: input?.health.state ?? 'not_available',
      source: 'runtime_probe',
      lastCheckedAt: now,
      reason: input?.health.reason ?? 'cu_backend_unavailable',
    },
  });
}

function staticCapability(input: {
  id: CapabilitySnapshot['id'];
  label: string;
  now: number;
  feature: CapabilityFeatureSignal;
  requiredPermissions: CapabilityPermissionRequirement[];
  actionApproval: CapabilityActionApprovalSignal;
  memoryAcceptance: CapabilityMemoryAcceptanceSignal;
  runtimeProbe: CapabilityRuntimeProbeSignal;
  guidance?: string[];
}): CapabilitySnapshot {
  const configuration: CapabilityConfigurationSignal = { state: 'not_required', source: 'not_applicable' };
  return {
    id: input.id,
    label: input.label,
    readiness: deriveCapabilityReadiness({
      feature: input.feature,
      configuration,
      osPermissions: input.requiredPermissions,
      runtimeProbe: input.runtimeProbe,
    }),
    feature: input.feature,
    configuration,
    osPermissions: input.requiredPermissions,
    actionApproval: input.actionApproval,
    memoryAcceptance: input.memoryAcceptance,
    runtimeProbe: input.runtimeProbe,
    canRevoke: false,
    canPause: input.feature.state === 'enabled',
    guidance: input.guidance ?? [],
    auditEvents: [],
    updatedAt: input.now,
  };
}

function botCapability(
  provider: BotProvider,
  settings: AppSettings,
  status: BotStatus,
  now: number,
): CapabilitySnapshot {
  const channel = settings.botChat.channels[provider];
  const hasConfig = Boolean(channel.token.trim() || channel.appId || channel.appSecret);
  const feature: CapabilityFeatureSignal = {
    state: channel.enabled ? 'enabled' : 'disabled',
    source: 'settings',
  };
  const configuration: CapabilityConfigurationSignal = hasConfig
    ? { state: 'present', source: 'settings' }
    : { state: 'missing', source: 'settings', reason: 'missing platform credentials' };
  const runtimeProbe = runtimeProbeFromBotReadiness(
    status.readiness,
    channel.readinessUpdatedAt,
    status.reason ?? channel.readinessReason,
  );

  return {
    id: `bot:${provider}`,
    label: `${provider} Bot`,
    readiness: deriveCapabilityReadiness({
      feature,
      configuration,
      osPermissions: [],
      runtimeProbe,
    }),
    feature,
    configuration,
    osPermissions: [],
    actionApproval: { state: 'not_required', source: 'not_applicable' },
    memoryAcceptance: { state: 'disabled', source: 'memory_contract' },
    runtimeProbe,
    canRevoke: channel.enabled || hasConfig,
    canPause: channel.enabled,
    guidance: [],
    auditEvents: [],
    updatedAt: now,
  };
}

function accessibilitySnapshot(now: number, platform: NodeJS.Platform): OsPermissionSnapshot {
  if (platform !== 'darwin') return unsupportedPermission('accessibility', now, 'macOS TCC only');
  try {
    const granted = systemPreferences.isTrustedAccessibilityClient(false);
    return {
      id: 'accessibility',
      status: granted ? 'granted' : 'not_determined',
      source: 'electron',
      checkedAt: now,
      reason: granted ? undefined : 'accessibility_status_ambiguous',
      canOpenSettings: true,
      canRequest: false,
    };
  } catch {
    return unknownPermission('accessibility', now, true);
  }
}

function mediaPermissionSnapshot(
  id: 'screen_recording',
  mediaType: 'screen',
  now: number,
  platform: NodeJS.Platform,
): OsPermissionSnapshot {
  if (!supportsMediaPermissionProbe(id, platform)) {
    return unsupportedPermission(id, now, 'screen_recording_status_mac_only');
  }
  try {
    const status = mapMediaAccessStatus(systemPreferences.getMediaAccessStatus(mediaType));
    const actions = mediaPermissionActions({ id, platform, status });
    return {
      id,
      status,
      source: 'electron',
      checkedAt: now,
      ...actions,
    };
  } catch {
    return unknownPermission(id, now, platform === 'darwin');
  }
}

function notificationSnapshot(now: number, platform: NodeJS.Platform): OsPermissionSnapshot {
  const supported = Notification.isSupported();
  return {
    id: 'notifications',
    status: supported ? 'unknown' : 'unsupported',
    source: 'electron',
    checkedAt: now,
    reason: supported
      ? platform === 'darwin'
        ? 'notifications_status_unreadable_macos'
        : 'notifications_status_unreadable'
      : 'notifications_unsupported',
    canOpenSettings: platform === 'darwin',
    // Showing a Notification is not an authorization API and does not report
    // whether macOS delivered or suppressed it. Never present that probe as a
    // successful permission request.
    canRequest: false,
  };
}

function automationSnapshot(now: number, platform: NodeJS.Platform): OsPermissionSnapshot {
  if (platform !== 'darwin') return unsupportedPermission('automation', now, 'macOS TCC only');
  return {
    id: 'automation',
    status: 'unknown',
    source: 'static',
    checkedAt: now,
    reason: 'no Electron API for per-target Apple Events TCC status',
    canOpenSettings: true,
    canRequest: false,
  };
}

function unsupportedPermission(
  id: OsPermissionId,
  now: number,
  reason: CapabilityReasonCode,
): OsPermissionSnapshot {
  return {
    id,
    status: 'unsupported',
    source: MAC_TCC_PERMISSIONS.includes(id) ? 'platform' : 'static',
    checkedAt: now,
    reason,
    canOpenSettings: false,
    canRequest: false,
  };
}

function unknownPermission(
  id: OsPermissionId,
  now: number,
  canOpenSettings: boolean,
): OsPermissionSnapshot {
  return {
    id,
    status: 'unknown',
    source: 'electron',
    checkedAt: now,
    reason: 'permission_probe_failed',
    canOpenSettings,
    canRequest: false,
  };
}
