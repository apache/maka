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
import type { LlmConnection } from './llm-connections.js';
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

export type HealthSignalScope = 'app' | 'llm_connection' | 'bot' | 'capability' | 'storage';

export type HealthSignalSource =
  | 'connection_test'
  | 'capability_snapshot'
  | 'permission_snapshot'
  | 'runtime_probe'
  | 'settings'
  | 'storage';

export interface HealthSignal {
  id: string;
  label: string;
  scope: HealthSignalScope;
  layer: HealthSignalLayer;
  status: HealthSignalStatus;
  source: HealthSignalSource;
  checkedAt: number;
  message: string;
  detail?: string;
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

export function healthSignalFromConnection(
  connection: LlmConnection,
  checkedAt: number,
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
      message: '连接已关闭。',
      blocksSend: false,
    };
  }

  if (!configured) {
    return {
      id: `connection:${connection.slug}`,
      label: connection.name,
      scope: 'llm_connection',
      layer: 'configuration',
      status: 'warning',
      source: 'settings',
      checkedAt,
      message: '等待选择默认模型。',
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
      message: '凭据与端点验证已通过。',
      detail: '这是连接验证结果，不代表发送、流式输出或中断通路已经运行通过。',
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
      message: '连接需要重新修复认证。',
      detail: connection.lastTestMessage,
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
      message: '上次连接验证失败。',
      detail: connection.lastTestMessage,
      blocksSend: true,
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
    message: '等待验证连接。',
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
      label: `${connection.name} 运行态`,
      scope: 'llm_connection',
      layer: 'runtime_probe',
      status: 'unknown',
      source: 'runtime_probe',
      checkedAt,
      message: '等待完成发送运行态探测。',
      detail: '凭据验证与真实发送、流式输出、中断通路是两层健康信号。',
      blocksSend: false,
    };
  }

  const status = runtimeStatusToHealth(latestRuntimeProbe.status);
  return {
    id: `connection:${connection.slug}:runtime`,
    label: `${connection.name} 运行态`,
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

function capabilityMessage(readiness: CapabilityReadinessState): string {
  switch (readiness) {
    case 'enabled':
      return '能力门禁已满足。';
    case 'paused':
      return '能力已关闭或暂停。';
    case 'not_configured':
      return '等待补齐能力配置。';
    case 'denied':
      return '能力被必要系统权限阻塞。';
    case 'degraded':
      return '能力运行态探测处于降级状态。';
  }
}

function capabilityDetail(capability: CapabilitySnapshot): string | undefined {
  return userVisibleCapabilityReason(
    capability.runtimeProbe.reason ?? capability.feature.reason ?? capability.configuration.reason,
  );
}

function userVisibleCapabilityReason(reason: string | undefined): string | undefined {
  const raw = reason?.trim();
  if (!raw) return undefined;
  switch (raw) {
    case 'disabled':
      return '该能力当前已关闭。';
    case 'missing platform credentials':
      return '等待填写平台凭据。';
    case 'macOS TCC only':
      return '仅 macOS 系统权限可探测。';
    case 'no Electron API for per-target Apple Events TCC status':
      return '系统未提供可直接读取的授权状态。';
    default:
      return /[\u3400-\u9fff]/.test(raw) ? raw : '状态详情请见对应设置页。';
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

function runtimeProbeMessage(status: UsageLogRow['status']): string {
  switch (status) {
    case 'success':
      return '最近一次发送已完成。';
    case 'aborted':
      return '最近一次发送已由用户停止。';
    case 'error':
      return '最近一次发送失败。';
  }
}

function runtimeProbeDetail(row: UsageLogRow): string {
  const parts = [`模型=${row.modelId}`, `延迟=${row.latencyMs}ms`];
  if (row.errorClass) parts.push(`错误类型=${row.errorClass}`);
  return parts.join(' · ');
}
