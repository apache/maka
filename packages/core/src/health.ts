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

import type { CapabilityId, CapabilityReadinessState, CapabilitySnapshot } from './capabilities.js';
import {
  connectionEnabledModelIds,
  type ConnectionTestErrorClass,
  type LlmConnection,
} from './llm-connections.js';
import type { UsageLogRow } from './usage-stats/types.js';

export const HEALTH_SIGNAL_STATUSES = ['ok', 'info', 'warning', 'error', 'unknown'] as const;
export type HealthSignalStatus = (typeof HEALTH_SIGNAL_STATUSES)[number];

export const HEALTH_SIGNAL_LAYERS = [
  'configuration',
  'validation',
  'permission',
  'feature',
  'action_approval',
  'memory_acceptance',
  'runtime_probe',
  'storage',
] as const;
export type HealthSignalLayer = (typeof HEALTH_SIGNAL_LAYERS)[number];

export type HealthSignalScope = 'llm_connection' | 'bot' | 'capability';

export type HealthSignalSource =
  | 'connection_test'
  | 'capability_snapshot'
  | 'permission_snapshot'
  | 'runtime_probe'
  | 'settings';

export type HealthSignalMessageCode =
  | 'connection_disabled'
  | 'awaiting_default_model'
  | 'validation_passed'
  | 'needs_reauth'
  | 'validation_failed'
  | 'no_models_enabled'
  | 'not_default_source'
  | 'awaiting_validation'
  | 'runtime_probe_pending'
  | 'send_completed'
  | 'send_aborted'
  | 'send_failed'
  | 'capability_ok'
  | 'capability_paused'
  | 'capability_not_configured'
  | 'capability_denied'
  | 'capability_degraded';

export type HealthConnectionTestErrorClass = ConnectionTestErrorClass;

export type HealthSignalDetail =
  | { kind: 'validation_scope_note' }
  | { kind: 'no_models_enabled_hint' }
  | { kind: 'not_default_source_hint' }
  | { kind: 'runtime_probe_layers_note' }
  | { kind: 'runtime_probe_result'; modelId: string; latencyMs: number; errorClass?: string }
  | { kind: 'capability_reason'; reason: string }
  | { kind: 'last_test_error_class'; errorClass: HealthConnectionTestErrorClass }
  | { kind: 'last_test_message' };

export interface HealthSignal {
  id: string;
  label: string;
  scope: HealthSignalScope;
  layer: HealthSignalLayer;
  status: HealthSignalStatus;
  source: HealthSignalSource;
  checkedAt: number;
  message: HealthSignalMessageCode;
  detail?: HealthSignalDetail;
  relatedCapabilityId?: CapabilityId;
  blocksSend?: boolean;
  blocksCapability?: boolean;
}

export interface HealthSnapshotSummary {
  ok: number;
  info: number;
  warning: number;
  error: number;
  unknown: number;
}

export interface HealthSnapshot {
  checkedAt: number;
  signals: HealthSignal[];
  summary: HealthSnapshotSummary;
}

export function isHealthSignalStatus(value: unknown): value is HealthSignalStatus {
  return typeof value === 'string' && (HEALTH_SIGNAL_STATUSES as readonly string[]).includes(value);
}

export function buildHealthSnapshot(checkedAt: number, signals: HealthSignal[]): HealthSnapshot {
  const summary: HealthSnapshotSummary = {
    ok: 0,
    info: 0,
    warning: 0,
    error: 0,
    unknown: 0,
  };
  for (const signal of signals) {
    summary[signal.status] += 1;
  }
  return { checkedAt, signals, summary };
}

export function healthSignalFromCapability(capability: CapabilitySnapshot): HealthSignal {
  const status = healthStatusFromCapabilityReadiness(capability.readiness);
  const layer = healthLayerFromCapability(capability);
  return {
    id: `capability:${capability.id}`,
    label: capability.label,
    scope: capability.id.startsWith('bot:') ? 'bot' : 'capability',
    layer,
    status,
    source: 'capability_snapshot',
    checkedAt: capability.updatedAt,
    message: capabilityMessage(capability.readiness),
    detail: capabilityDetail(capability),
    relatedCapabilityId: capability.id,
    blocksCapability: capability.readiness === 'denied' || capability.readiness === 'degraded',
  };
}

/** Whether some ENABLED connection holds the workspace's default model
 * target. The catalog projects `defaultModel` purely from the default
 * target's connection id — a DISABLED holder keeps its projected value,
 * but cannot serve a new chat: counting it would show an all-clear health
 * page in exactly the state where sends fail with connection_disabled.
 * The one derivation, exported so the caller and the tests cannot drift. */
export function workspaceHasDefaultModelTarget(
  connections: readonly Pick<LlmConnection, 'defaultModel' | 'enabled'>[],
): boolean {
  return connections.some((connection) => Boolean(connection.defaultModel) && connection.enabled);
}

export function healthSignalFromConnection(
  connection: LlmConnection,
  checkedAt: number,
  options: {
    /** Whether SOME connection in the workspace carries the default model
     * target. The catalog projects `defaultModel` onto exactly one
     * connection — the default target — so with a default configured,
     * every OTHER enabled connection has an empty `defaultModel` BY
     * CONSTRUCTION. That is the connection model's documented normal state
     * (设置 · 通用 is the one control for which model a new chat starts
     * on; see reconcileConnectionAfterEnabledModelsChange), not a
     * configuration gap — warning on it sent users hunting for a
     * per-connection setting that deliberately does not exist. Only when
     * NO default exists anywhere is a missing model an actionable,
     * send-blocking problem. */
    workspaceHasDefaultTarget?: boolean;
  } = {},
): HealthSignal {
  const configured = Boolean(connection.defaultModel);
  if (!connection.enabled) {
    return {
      id: `connection:${connection.slug}`,
      label: connection.name,
      scope: 'llm_connection',
      layer: 'configuration',
      status: 'info',
      source: 'settings',
      checkedAt,
      message: 'connection_disabled',
      blocksSend: false,
    };
  }

  if (!configured && !options.workspaceHasDefaultTarget) {
    return {
      id: `connection:${connection.slug}`,
      label: connection.name,
      scope: 'llm_connection',
      layer: 'configuration',
      status: 'warning',
      source: 'settings',
      checkedAt,
      message: 'awaiting_default_model',
      blocksSend: true,
    };
  }

  if (connection.lastTestStatus === 'verified') {
    return {
      id: `connection:${connection.slug}`,
      label: connection.name,
      scope: 'llm_connection',
      layer: 'validation',
      status: 'ok',
      source: 'connection_test',
      checkedAt: timeFromIso(connection.lastTestAt) ?? checkedAt,
      message: 'validation_passed',
      detail: { kind: 'validation_scope_note' },
      blocksSend: false,
    };
  }

  if (connection.lastTestStatus === 'needs_reauth') {
    return {
      id: `connection:${connection.slug}`,
      label: connection.name,
      scope: 'llm_connection',
      layer: 'validation',
      status: 'error',
      source: 'connection_test',
      checkedAt: timeFromIso(connection.lastTestAt) ?? checkedAt,
      message: 'needs_reauth',
      ...(connection.lastTestMessage
        ? { detail: connectionLastTestDetail(connection.lastTestMessage) }
        : {}),
      blocksSend: true,
    };
  }

  if (connection.lastTestStatus === 'error') {
    return {
      id: `connection:${connection.slug}`,
      label: connection.name,
      scope: 'llm_connection',
      layer: 'validation',
      status: 'warning',
      source: 'connection_test',
      checkedAt: timeFromIso(connection.lastTestAt) ?? checkedAt,
      message: 'validation_failed',
      ...(connection.lastTestMessage
        ? { detail: connectionLastTestDetail(connection.lastTestMessage) }
        : {}),
      blocksSend: true,
    };
  }

  if (!configured) {
    // A non-default connection reaches here only with nothing above firing:
    // enabled, workspace default lives elsewhere, no failing validation.
    // Ordered AFTER the validation branches on purpose — a needs_reauth or
    // failed test on a non-default connection is a real blocker and must
    // not be papered over by the "not the default source" note.
    if (connectionEnabledModelIds(connection).length === 0) {
      return {
        id: `connection:${connection.slug}`,
        label: connection.name,
        scope: 'llm_connection',
        layer: 'configuration',
        status: 'warning',
        source: 'settings',
        checkedAt,
        message: 'no_models_enabled',
        detail: { kind: 'no_models_enabled_hint' },
        blocksSend: false,
      };
    }
    return {
      id: `connection:${connection.slug}`,
      label: connection.name,
      scope: 'llm_connection',
      layer: 'configuration',
      status: 'info',
      source: 'settings',
      checkedAt,
      message: 'not_default_source',
      detail: { kind: 'not_default_source_hint' },
      blocksSend: false,
    };
  }

  return {
    id: `connection:${connection.slug}`,
    label: connection.name,
    scope: 'llm_connection',
    layer: 'validation',
    status: 'unknown',
    source: 'connection_test',
    checkedAt,
    message: 'awaiting_validation',
    blocksSend: false,
  };
}

export function healthSignalFromConnectionRuntime(
  connection: LlmConnection,
  latestRuntimeProbe: UsageLogRow | undefined,
  checkedAt: number,
): HealthSignal | undefined {
  if (!connection.enabled || !connection.defaultModel) return undefined;

  if (!latestRuntimeProbe) {
    return {
      id: `connection:${connection.slug}:runtime`,
      label: connection.name,
      scope: 'llm_connection',
      layer: 'runtime_probe',
      status: 'unknown',
      source: 'runtime_probe',
      checkedAt,
      message: 'runtime_probe_pending',
      detail: { kind: 'runtime_probe_layers_note' },
      blocksSend: false,
    };
  }

  const status = runtimeStatusToHealth(latestRuntimeProbe.status);
  return {
    id: `connection:${connection.slug}:runtime`,
    label: connection.name,
    scope: 'llm_connection',
    layer: 'runtime_probe',
    status,
    source: 'runtime_probe',
    checkedAt: latestRuntimeProbe.ts,
    message: runtimeProbeMessage(latestRuntimeProbe.status),
    detail: runtimeProbeDetail(latestRuntimeProbe),
    // Historical probe failures inform health UI but never gate the next send.
    blocksSend: false,
  };
}

function healthStatusFromCapabilityReadiness(
  readiness: CapabilityReadinessState,
): HealthSignalStatus {
  switch (readiness) {
    case 'enabled':
      return 'ok';
    case 'paused':
      return 'info';
    case 'not_configured':
      return 'warning';
    case 'degraded':
    case 'denied':
      return 'error';
  }
}

function healthLayerFromCapability(capability: CapabilitySnapshot): HealthSignalLayer {
  if (capability.readiness === 'paused') return 'feature';
  if (capability.readiness === 'degraded') return 'runtime_probe';

  const requiredPermissions = capability.osPermissions.filter((permission) => permission.required);
  if (
    requiredPermissions.some(
      (permission) => permission.status === 'denied' || permission.status === 'unsupported',
    )
  ) {
    return 'permission';
  }
  if (
    requiredPermissions.some(
      (permission) => permission.status === 'not_determined' || permission.status === 'unknown',
    )
  ) {
    return 'permission';
  }
  if (capability.configuration.state === 'missing') return 'configuration';
  if (capability.feature.state === 'not_available') return 'feature';
  if (capability.feature.state === 'partial') return 'feature';
  if (capability.runtimeProbe.state === 'healthy') return 'runtime_probe';
  return 'feature';
}

function capabilityMessage(readiness: CapabilityReadinessState): HealthSignalMessageCode {
  switch (readiness) {
    case 'enabled':
      return 'capability_ok';
    case 'paused':
      return 'capability_paused';
    case 'not_configured':
      return 'capability_not_configured';
    case 'denied':
      return 'capability_denied';
    case 'degraded':
      return 'capability_degraded';
  }
}

function capabilityDetail(capability: CapabilitySnapshot): HealthSignalDetail | undefined {
  const reason = (
    capability.runtimeProbe.reason ??
    capability.feature.reason ??
    capability.configuration.reason
  )?.trim();
  return reason ? { kind: 'capability_reason', reason } : undefined;
}

function connectionLastTestDetail(message: string): HealthSignalDetail {
  const normalized = message.trim().toLowerCase();
  switch (normalized) {
    case 'auth':
    case 'timeout':
    case 'provider_unavailable':
    case 'network':
    case 'unknown':
      return { kind: 'last_test_error_class', errorClass: normalized };
    default:
      return { kind: 'last_test_message' };
  }
}

function timeFromIso(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function runtimeStatusToHealth(status: UsageLogRow['status']): HealthSignalStatus {
  switch (status) {
    case 'success':
      return 'ok';
    case 'aborted':
      return 'info';
    case 'error':
      return 'warning';
  }
}

function runtimeProbeMessage(status: UsageLogRow['status']): HealthSignalMessageCode {
  switch (status) {
    case 'success':
      return 'send_completed';
    case 'aborted':
      return 'send_aborted';
    case 'error':
      return 'send_failed';
  }
}

function runtimeProbeDetail(row: UsageLogRow): HealthSignalDetail {
  return {
    kind: 'runtime_probe_result',
    modelId: row.modelId,
    latencyMs: row.latencyMs,
    ...(row.errorClass ? { errorClass: row.errorClass } : {}),
  };
}
