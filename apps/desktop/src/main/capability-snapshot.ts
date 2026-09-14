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
  COMPUTER_HISTORY_PERMISSION_IDS,
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
import type { ComputerHistoryStatus } from '@maka/core/computer-history';
import type { ComputerHistoryPermissionStatus } from './computer-history-main.js';
import type { BotStatus } from '@maka/runtime/bots';
import type { computerUseServiceHealth } from './computer-use-host.js';
import {
  mapMediaAccessStatus,
  mediaPermissionActions,
  supportsMediaPermissionProbe,
} from './os-permission-policy.js';

const MAC_TCC_PERMISSIONS: OsPermissionId[] = ['accessibility', 'input_monitoring', 'screen_recording', 'automation'];

export function buildPermissionSnapshot(
  now = Date.now(),
  platform: NodeJS.Platform = process.platform,
  collector?: ComputerHistoryPermissionStatus,
): PermissionSnapshot {
  const historyPermissions: ComputerHistoryPermissionStatus = collector ?? {
    accessibility: platform === 'darwin' ? 'unknown' : 'unsupported',
    inputMonitoring: platform === 'darwin' ? 'unknown' : 'unsupported',
    reason: platform === 'darwin' ? 'permission_probe_failed' : 'macos_tcc_only',
  };
  return {
    checkedAt: now,
    platform,
    permissions: {
      accessibility: {
        ...accessibilitySnapshot(now, platform),
        consumers: { activity_recorder: {
          status: historyPermissions.accessibility, reason: historyPermissions.reason,
        } },
      },
      input_monitoring: {
        id: 'input_monitoring',
        status: historyPermissions.inputMonitoring,
        source: 'platform',
        checkedAt: now,
        reason: historyPermissions.reason,
        canOpenSettings: platform === 'darwin',
        canRequest: false,
        consumers: { activity_recorder: {
          status: historyPermissions.inputMonitoring, reason: historyPermissions.reason,
        } },
      },
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
  computerHistory?: ComputerHistoryStatus;
  now?: number;
}): CapabilitySnapshotCollection {
  const now = input.now ?? Date.now();
  const permissions = input.permissions.permissions;
  const capabilities: CapabilitySnapshot[] = [
    computerUseCapability(input.computerUse, permissions, now),
    activityRecorderCapability(input.computerHistory, permissions, now),
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

function activityRecorderCapability(
  history: ComputerHistoryStatus | undefined,
  permissions: PermissionSnapshot['permissions'],
  now: number,
): CapabilitySnapshot {
  const supported = history?.platformSupported === true && history.helperAvailable;
  const enabled = history?.settings.enabled === true;
  return staticCapability({
    id: 'activity_recorder',
    label: 'Computer History',
    now,
    feature: {
      state: !supported ? 'not_available' : enabled ? 'enabled' : 'disabled',
      source: enabled ? 'settings' : 'runtime',
      reason: supported && !enabled ? 'disabled' : undefined,
    },
    requiredPermissions: COMPUTER_HISTORY_PERMISSION_IDS.map((id) => ({
      id,
      required: true,
      status: permissions[id].consumers?.activity_recorder?.status ?? 'unknown',
    })),
    actionApproval: { state: 'not_required', source: 'not_applicable' },
    memoryAcceptance: { state: 'disabled', source: 'memory_contract' },
    runtimeProbe: {
      state:
        history?.state === 'running'
          ? 'healthy'
          : history?.state === 'paused' || history?.state === 'needs_permission'
            ? 'degraded'
            : history?.state === 'error'
              ? 'not_available'
              : 'not_run',
      source: 'runtime_probe',
      lastCheckedAt: now,
    },
    canPause: enabled,
  });
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
  canPause?: boolean;
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
    canPause: input.canPause ?? input.feature.state === 'enabled',
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
    : { state: 'missing', source: 'settings', reason: 'platform_credentials_missing' };
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
    auditEvents: [],
    updatedAt: now,
  };
}

function accessibilitySnapshot(now: number, platform: NodeJS.Platform): OsPermissionSnapshot {
  if (platform !== 'darwin') return unsupportedPermission('accessibility', now, 'macos_tcc_only');
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
  } catch (error) {
    // `permission_probe_failed` stays a closed code for the page; the raw
    // cause is diagnostic-only, so the probe error is not silently swallowed.
    console.warn('[capability] accessibility probe failed:', error instanceof Error ? error.message : error);
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
  } catch (error) {
    console.warn('[capability] media probe failed:', error instanceof Error ? error.message : error);
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
  if (platform !== 'darwin') return unsupportedPermission('automation', now, 'macos_tcc_only');
  return {
    id: 'automation',
    status: 'unknown',
    source: 'static',
    checkedAt: now,
    reason: 'apple_events_tcc_status_unavailable',
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
