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

import type { StatusSemantic } from '@maka/ui';
import type { HealthSignal, HealthSignalLayer, HealthSignalSource, HealthSignalStatus } from '@maka/core/health';

import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';

/**
 * Health signals carry their own severity ladder — error > warning > info > ok
 * — and the colours have to stay monotonic with it. That is why `info` maps to
 * neutral rather than to attention: amber would collide with `warning` and
 * collapse five rungs into four, leaving 提示 and 警告 visually identical. Grey
 * keeps the ladder ordered (red > amber > grey > green); 提示 and 未知 share
 * grey and are told apart by their labels, which is fine because neither asks
 * for action.
 */
type HealthTone = StatusSemantic;

export type HealthCenterCopy = {
  loading: string;
  readFailed: string;
  noData: string;
  readAgain: string;
  title: string;
  subtitle: string;
  badge: string;
  lastRead: string;
  refresh: string;
  summaryAria: string;
  blockers: { send(count: number): string; capability(count: number): string };
  layerAria(label: string): string;
  layerListAria(label: string): string;
  footnote: string;
  layers: Record<HealthSignalLayer, { label: string; description: string }>;
  statuses: Record<HealthSignalStatus, { label: string; tone: HealthTone }>;
  scopes: Record<HealthSignal['scope'], string>;
  sources: Record<HealthSignalSource, string>;
  source: string;
  blocksSend: string;
  blocksCapability: string;
  signalLabel(signal: HealthSignal): string;
  signalMessage(signal: HealthSignal): string;
  signalDetail(signal: HealthSignal): string | undefined;
};

const layersZh: HealthCenterCopy['layers'] = {
  configuration: { label: '配置', description: '是否填齐了设置页里的必填项。' },
  validation: { label: '验证', description: '凭据 / 端点的连通性测试结果，仅代表验证通过，不等于发送通路可用。' },
  permission: { label: '系统权限', description: '所需 OS / TCC 权限是否已授权。' },
  feature: { label: '功能开关', description: '功能是否被显式启用、当前是否可使用。' },
  action_approval: { label: '操作审批', description: '每次工具调用 / 高危操作的审批策略状态。' },
  memory_acceptance: { label: '记忆写入', description: '是否接受了记忆写入约定、是否启用了记忆写入。' },
  runtime_probe: { label: '运行态探测', description: '最近一次真实运行（发送 / 流式 / 接收事件）的探测结果。' },
  storage: { label: '存储', description: '工作区文件、JSONL、SQLite 等本地存储健康度。' },
};

const layersEn: HealthCenterCopy['layers'] = {
  configuration: { label: 'Configuration', description: 'Whether required settings are complete.' },
  validation: { label: 'Validation', description: 'Credential and endpoint connectivity results. A passing validation does not prove the send path works.' },
  permission: { label: 'System permissions', description: 'Whether required OS and TCC permissions are granted.' },
  feature: { label: 'Feature state', description: 'Whether the feature is explicitly enabled and currently available.' },
  action_approval: { label: 'Action approval', description: 'Approval policy for tool calls and high-risk actions.' },
  memory_acceptance: { label: 'Memory writes', description: 'Whether the memory-write agreement was accepted and writes are enabled.' },
  runtime_probe: { label: 'Runtime probe', description: 'The latest real send, stream, or event-receipt observation.' },
  storage: { label: 'Storage', description: 'Health of workspace files, JSONL, SQLite, and other local storage.' },
};

const SETTINGS_HEALTH_COPY = {
  zh: {
    loading: '正在加载健康快照', readFailed: '无法读取健康快照', noData: '健康服务未返回数据。', readAgain: '重新读取',
    title: '健康中心', subtitle: '各项能力当前的运行状况检查。',
    badge: '只读快照', lastRead: '最近一次读取：', refresh: '刷新', summaryAria: '健康摘要',
    blockers: { send: (count) => `${count} 条健康信号会阻塞发送`, capability: (count) => `${count} 条健康信号会阻塞能力` },
    layerAria: (label) => `${label}健康信号`, layerListAria: (label) => `${label}健康信号列表`,
    footnote: '本页不直接执行测试、修复或权限变更；它只汇总当前已记录的健康信号。需要处理问题时，请进入对应设置页或重新触发相关功能。',
    layers: layersZh,
    statuses: { ok: { label: '正常', tone: 'neutral' }, info: { label: '提示', tone: 'neutral' }, warning: { label: '警告', tone: 'attention' }, error: { label: '错误', tone: 'error' }, unknown: { label: '未知', tone: 'neutral' } },
    scopes: { app: '应用', llm_connection: 'LLM 连接', bot: '机器人', capability: '能力', storage: '存储' },
    sources: { connection_test: '连接测试', capability_snapshot: '能力快照', permission_snapshot: '权限快照', runtime_probe: '运行态探测', settings: '设置', storage: '本地存储' },
    source: '来源：', blocksSend: '阻塞发送', blocksCapability: '阻塞能力',
    signalLabel: (signal) => signal.label,
    signalMessage: (signal) => signal.message,
    signalDetail: (signal) => signal.detail,
  },
  en: {
    loading: 'Loading health snapshot', readFailed: 'Could not read health snapshot', noData: 'The health service returned no data.', readAgain: 'Read again',
    title: 'Health center', subtitle: 'How each capability is currently doing.',
    badge: 'Read-only snapshot', lastRead: 'Last read: ', refresh: 'Refresh', summaryAria: 'Health summary',
    blockers: { send: (count) => `${count} health ${count === 1 ? 'signal blocks' : 'signals block'} sending`, capability: (count) => `${count} health ${count === 1 ? 'signal blocks' : 'signals block'} capabilities` },
    layerAria: (label) => `${label} health signals`, layerListAria: (label) => `${label} health signal list`,
    footnote: 'This page does not run tests, repairs, or permission changes. It only summarizes recorded health signals. Open the relevant settings page or retry the related feature to address an issue.',
    layers: layersEn,
    statuses: { ok: { label: 'Healthy', tone: 'neutral' }, info: { label: 'Info', tone: 'neutral' }, warning: { label: 'Warning', tone: 'attention' }, error: { label: 'Error', tone: 'error' }, unknown: { label: 'Unknown', tone: 'neutral' } },
    scopes: { app: 'App', llm_connection: 'LLM connection', bot: 'Bot', capability: 'Capability', storage: 'Storage' },
    sources: { connection_test: 'Connection test', capability_snapshot: 'Capability snapshot', permission_snapshot: 'Permission snapshot', runtime_probe: 'Runtime probe', settings: 'Settings', storage: 'Local storage' },
    source: 'Source: ', blocksSend: 'Blocks sending', blocksCapability: 'Blocks capability',
    signalLabel: englishSignalLabel,
    signalMessage: englishSignalMessage,
    signalDetail: englishSignalDetail,
  },
} satisfies UiCatalog<HealthCenterCopy>;

export function getHealthCenterCopy(locale: UiLocale): HealthCenterCopy {
  return SETTINGS_HEALTH_COPY[locale];
}

function englishSignalLabel(signal: HealthSignal): string {
  if (signal.id.endsWith(':runtime')) return `${signal.label.replace(/\s*运行态$/, '')} runtime`;
  return signal.label;
}

function englishSignalMessage(signal: HealthSignal): string {
  if (signal.scope === 'llm_connection') {
    if (signal.layer === 'configuration') return signal.status === 'info' ? 'Connection is disabled.' : 'Select a default model.';
    if (signal.layer === 'runtime_probe') {
      return { ok: 'The latest send completed.', info: 'The latest send was stopped by the user.', warning: 'The latest send failed.', error: 'The latest send failed.', unknown: 'Waiting for a send-path runtime probe.' }[signal.status];
    }
    return { ok: 'Credentials and endpoint validation passed.', info: 'Connection validation needs attention.', warning: 'The latest connection validation failed.', error: 'The connection needs authentication repair.', unknown: 'Waiting to validate the connection.' }[signal.status];
  }
  if (signal.scope === 'capability' || signal.scope === 'bot') {
    return { ok: 'Capability requirements are satisfied.', info: 'The capability is disabled or paused.', warning: 'Capability configuration is incomplete.', error: 'The capability is blocked or degraded.', unknown: 'Capability state is unknown.' }[signal.status];
  }
  return { ok: 'The health check passed.', info: 'Review this health signal.', warning: 'This health signal needs attention.', error: 'This health signal reports an error.', unknown: 'Health state is unknown.' }[signal.status];
}

function englishSignalDetail(signal: HealthSignal): string | undefined {
  if (!signal.detail) return undefined;
  if (signal.scope === 'llm_connection' && signal.layer === 'validation' && signal.status === 'ok') {
    return 'This validates the connection only; it does not prove send, streaming, or interruption paths have run successfully.';
  }
  if (signal.scope === 'llm_connection' && signal.layer === 'runtime_probe') {
    const model = signal.detail.match(/模型=([^·]+)/)?.[1]?.trim();
    const latency = signal.detail.match(/延迟=([^·]+)/)?.[1]?.trim();
    const errorClass = signal.detail.match(/错误类型=([^·]+)/)?.[1]?.trim();
    const parts = [model && `Model=${model}`, latency && `Latency=${latency}`, errorClass && `Error type=${errorClass}`].filter(Boolean);
    return parts.length > 0 ? parts.join(' · ') : 'Runtime details are available in Usage settings.';
  }
  return 'See the corresponding settings page for details.';
}
