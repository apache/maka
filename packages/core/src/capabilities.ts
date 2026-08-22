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

import type { BotProvider, BotReadinessState } from './bot-chat-settings.js';

export const OS_PERMISSION_IDS = [
  'accessibility',
  'screen_recording',
  'notifications',
  'automation',
] as const;
export type OsPermissionId = (typeof OS_PERMISSION_IDS)[number];

/**
 * The macOS permissions granted by dragging the app bundle onto the
 * Privacy list, rather than through a consent dialog.
 *
 * These two are the ones whose normal setup requires adding the app to a
 * System Settings list, so the stock path is: open System Settings, press `+`,
 * navigate a file picker to /Applications, pick the app, tick the box.
 * Dropping the bundle satisfies the same explicit-consent intent in one
 * gesture, which is what the drag-to-grant onboarding automates.
 *
 * Lives in core because both the main-process flow and the Permission
 * Center row need the same list; two copies would drift.
 */
export const DRAG_GRANT_PERMISSION_IDS = ['accessibility', 'screen_recording'] as const;
export type DragGrantPermissionId = (typeof DRAG_GRANT_PERMISSION_IDS)[number];

export function isDragGrantPermissionId(value: unknown): value is DragGrantPermissionId {
  return (DRAG_GRANT_PERMISSION_IDS as readonly unknown[]).includes(value);
}

export const OS_PERMISSION_STATES = [
  'unsupported',
  'unknown',
  'not_determined',
  'denied',
  'granted',
] as const;
export type OsPermissionState = (typeof OS_PERMISSION_STATES)[number];

export const FEATURE_ENABLEMENT_STATES = [
  'not_available',
  'partial',
  'disabled',
  'enabled',
] as const;
export type FeatureEnablementState = (typeof FEATURE_ENABLEMENT_STATES)[number];

export const ACTION_APPROVAL_STATES = [
  'not_required',
  'required_per_action',
  'required_scoped_lease',
  'pending',
  'approved',
  'denied',
] as const;
export type ActionApprovalState = (typeof ACTION_APPROVAL_STATES)[number];

export const CAPABILITY_CONFIGURATION_STATES = ['not_required', 'missing', 'present'] as const;
export type CapabilityConfigurationState = (typeof CAPABILITY_CONFIGURATION_STATES)[number];

export const MEMORY_ACCEPTANCE_STATES = [
  'not_applicable',
  'disabled',
  'draft_required',
  'accepted',
] as const;
export type MemoryAcceptanceState = (typeof MEMORY_ACCEPTANCE_STATES)[number];

export const RUNTIME_PROBE_STATES = ['not_available', 'not_run', 'healthy', 'degraded'] as const;
export type RuntimeProbeState = (typeof RUNTIME_PROBE_STATES)[number];

export const CAPABILITY_READINESS_STATES = [
  'not_configured',
  'denied',
  'enabled',
  'degraded',
  'paused',
] as const;
export type CapabilityReadinessState = (typeof CAPABILITY_READINESS_STATES)[number];

export type CapabilityId =
  | 'computer_use'
  | 'activity_recorder'
  | 'memory_write'
  | `bot:${BotProvider}`;

export interface OsPermissionSnapshot {
  id: OsPermissionId;
  status: OsPermissionState;
  source: 'electron' | 'platform' | 'static';
  checkedAt: number;
  reason?: string;
  canOpenSettings: boolean;
  canRequest: boolean;
}

export interface PermissionSnapshot {
  checkedAt: number;
  platform: NodeJS.Platform;
  permissions: Record<OsPermissionId, OsPermissionSnapshot>;
}

export interface CapabilityPermissionRequirement {
  id: OsPermissionId;
  required: boolean;
  status: OsPermissionState;
}

export interface CapabilityFeatureSignal {
  state: FeatureEnablementState;
  source: 'settings' | 'scaffold' | 'runtime';
  reason?: string;
}

export interface CapabilityConfigurationSignal {
  state: CapabilityConfigurationState;
  source: 'settings' | 'runtime' | 'not_applicable';
  reason?: string;
}

export interface CapabilityActionApprovalSignal {
  state: ActionApprovalState;
  source: 'permission_engine' | 'capability_policy' | 'not_applicable';
}

export interface CapabilityMemoryAcceptanceSignal {
  state: MemoryAcceptanceState;
  source: 'memory_contract' | 'not_applicable';
}

export interface CapabilityRuntimeProbeSignal {
  state: RuntimeProbeState;
  source: 'runtime_probe' | 'bot_registry' | 'not_applicable';
  lastCheckedAt?: number;
  reason?: string;
}

export interface CapabilitySnapshot {
  id: CapabilityId;
  label: string;
  readiness: CapabilityReadinessState;
  feature: CapabilityFeatureSignal;
  configuration: CapabilityConfigurationSignal;
  osPermissions: CapabilityPermissionRequirement[];
  actionApproval: CapabilityActionApprovalSignal;
  memoryAcceptance: CapabilityMemoryAcceptanceSignal;
  runtimeProbe: CapabilityRuntimeProbeSignal;
  canRevoke: boolean;
  canPause: boolean;
  guidance: string[];
  auditEvents: string[];
  updatedAt: number;
}

export interface CapabilitySnapshotCollection {
  checkedAt: number;
  capabilities: CapabilitySnapshot[];
}

export interface DeriveCapabilityReadinessInput {
  feature: CapabilityFeatureSignal;
  configuration: CapabilityConfigurationSignal;
  osPermissions: CapabilityPermissionRequirement[];
  runtimeProbe: CapabilityRuntimeProbeSignal;
}

export function isOsPermissionState(value: unknown): value is OsPermissionState {
  return typeof value === 'string' && (OS_PERMISSION_STATES as readonly string[]).includes(value);
}

export function isCapabilityReadinessState(value: unknown): value is CapabilityReadinessState {
  return (
    typeof value === 'string' && (CAPABILITY_READINESS_STATES as readonly string[]).includes(value)
  );
}

export function deriveCapabilityReadiness(
  input: DeriveCapabilityReadinessInput,
): CapabilityReadinessState {
  if (input.feature.state === 'disabled') return 'paused';
  if (input.feature.state === 'not_available') return 'not_configured';
  if (input.configuration.state === 'missing') return 'not_configured';

  const required = input.osPermissions.filter((permission) => permission.required);
  if (
    required.some(
      (permission) => permission.status === 'denied' || permission.status === 'unsupported',
    )
  ) {
    return 'denied';
  }
  if (
    required.some(
      (permission) => permission.status === 'not_determined' || permission.status === 'unknown',
    )
  ) {
    return 'not_configured';
  }

  if (input.runtimeProbe.state === 'degraded' || input.runtimeProbe.state === 'not_available')
    return 'degraded';
  if (input.feature.state === 'partial') return 'not_configured';
  return 'enabled';
}

export function runtimeProbeFromBotReadiness(
  readiness: BotReadinessState,
  lastCheckedAt?: number,
  reason?: string,
): CapabilityRuntimeProbeSignal {
  if (readiness === 'operational') {
    return { state: 'healthy', source: 'bot_registry', lastCheckedAt, reason };
  }
  if (readiness === 'degraded') {
    return { state: 'degraded', source: 'bot_registry', lastCheckedAt, reason };
  }
  return { state: 'not_run', source: 'bot_registry', lastCheckedAt, reason };
}
