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

import { useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { ToastProvider, useToast } from '@maka/ui';
import type {
  AppSettings,
  SettingsSection,
  ThemePalette,
  ThemePreference,
  UpdateAppSettingsResult,
  UsageRange,
  UsageStats,
} from '@maka/core/settings';
import { EMPTY_USAGE_PROVENANCE } from '@maka/core/usage-ledger-merge';
import type {
  CapabilitySnapshot,
  CapabilitySnapshotCollection,
  OsPermissionSnapshot,
  OsPermissionState,
  PermissionSnapshot,
} from '@maka/core/capabilities';
import type { HealthSignal, HealthSnapshot } from '@maka/core/health';
import type { DesktopExternalSessionCatalogItem } from '../../src/preload/external-session-catalog';
import type { SessionSummary } from '@maka/core/session';
import { revisionFamilySessionIds } from '@maka/core/session-revisions';
import type { IdentifiedLlmConnection, LlmConnection, ProviderType } from '@maka/core/llm-connections';
import { buildChatModelChoices } from '@maka/core/chat-model-choice';
import type { LocalMemoryBackupInfo, LocalMemoryEntryPreview, LocalMemoryState } from '@maka/core/local-memory';
import { buildHealthSnapshot } from '@maka/core/health';
import { createDefaultSettings, mergeSettings } from '@maka/core/settings';
import { DEFAULT_DAILY_REVIEW_CONFIG } from '@maka/core/daily-review';
import { SettingsSurface } from '../../src/renderer/settings/settings-surface';
import { createUiLocaleUpdateGate } from '../../src/renderer/settings/ui-locale-update-gate';
import {
  createSettingsSnapshotCache,
  type SettingsSnapshotCache,
} from '../../src/renderer/settings/settings-snapshot-cache';
import type { ConnectionsBridge } from '../../src/renderer/settings/providers-panel';
import type { ProjectRecord } from '@maka/core/project';
import type { ArchivedTasksBridge } from '../../src/renderer/settings/tasks-settings-page';
import type {
  DesktopRuntimeHostProfileChangedEvent,
  DesktopRuntimeHostProfileSnapshot,
  DesktopSessionSummary,
} from '../../src/preload/bridge-contract.js';
import { withScopedMakaBridge } from '../maka-bridge';
import { getDailyReviewSettingsCopy } from '../../src/renderer/locales/settings-daily-review-copy';
import { getUsageSettingsCopy } from '../../src/renderer/locales/settings-usage-copy';

/**
 * Read from the copy table, not typed out again. This selector matched a
 * literal '跟随对话默认' that the 任务 rename retired, so it silently found
 * nothing — and `scripts/storybook-visual-smoke.mjs` disables every `play`
 * function, so CI could not tell us. A story that drives the UI by its visible
 * text has to source that text where the UI does.
 */
const DAILY_REVIEW_DEFAULT_MODEL_LABEL = getDailyReviewSettingsCopy('zh').defaultModel;
/** A 1×1 transparent PNG: the picker needs a valid data URL, not real art. */
const STORY_ICON_PREVIEW =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const STORY_PLATFORM = 'darwin' as const;

// Fidelity convention (#1433): every story below names the real app path
// that reaches it. See apps/desktop/stories/FIDELITY.md.

const meta = {
  title: 'Product/Settings/Pages',
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

const NOW = Date.now();
const noop = () => undefined;

function makeConnection(input: {
  slug: string;
  name: string;
  providerType: ProviderType;
  enabled?: boolean;
}): IdentifiedLlmConnection {
  return {
    connectionId: `connection-${input.slug}`,
    slug: input.slug,
    name: input.name,
    providerType: input.providerType,
    defaultModel: 'glm-4.7',
    enabled: input.enabled ?? true,
    modelsFetchedAt: NOW - 18 * 60_000,
    lastTestStatus: 'verified',
    lastTestAt: new Date(NOW - 12 * 60_000).toISOString(),
    createdAt: NOW - 6 * 24 * 60 * 60 * 1000,
    updatedAt: NOW - 12 * 60_000,
  };
}

const connections: IdentifiedLlmConnection[] = [
  makeConnection({ slug: 'zai-live', name: 'Z.AI Live', providerType: 'zai-coding-plan' }),
  makeConnection({ slug: 'openai-review', name: 'OpenAI Review', providerType: 'openai' }),
  makeConnection({ slug: 'ollama-local', name: 'Ollama Local', providerType: 'ollama' }),
];

const generationStoryCopilotConnection = makeConnection({
  slug: 'github-copilot-generation',
  name: 'GitHub Copilot',
  providerType: 'github-copilot',
});
const generationStoryConnections = [
  ...connections,
  generationStoryCopilotConnection,
];

const connectionsBridge: ConnectionsBridge = {
  async getSnapshot() {
    return {
      connections,
      defaultConnection: 'zai-live',
      chatModelChoices: buildChatModelChoices(connections),
    };
  },
  async setDefault() {
    /* noop */
  },
  async create(next) {
    return makeConnection({ slug: next.slug, name: next.name, providerType: next.providerType });
  },
  async update(slug, patch) {
    const current = connections.find((c) => c.slug === slug)!;
    return {
      ...current,
      ...patch,
      // Tri-state relayModelProfiles (null clears) never stores null on a
      // connection — clear maps to absent.
      relayModelProfiles:
        patch.relayModelProfiles === undefined
          ? current.relayModelProfiles
          : (patch.relayModelProfiles ?? undefined),
      requestBodyOverlay:
        patch.requestBodyOverlay === undefined
          ? current.requestBodyOverlay
          : (patch.requestBodyOverlay ?? undefined),
      updatedAt: NOW,
    };
  },
  async delete() {
    /* noop */
  },
  async test() {
    return { ok: true, latencyMs: 210, modelTested: 'glm-4.7' };
  },
  async fetchModels(slug) {
    return {
      models: slug.includes('openai') ? [{ id: 'gpt-5' }] : [{ id: 'glm-4.7' }],
      source: 'fetched',
      fetchedAt: NOW,
    };
  },
  async hasSecret() {
    return true;
  },
  async getRequestHeaders() {
    return { names: [] };
  },
  async setRequestHeaders(_slug, headers) {
    return { names: headers.map(({ name }) => name) };
  },
  subscribeEvents() {
    return () => undefined;
  },
};

/**
 * #1364: request logs with deliberately hostile content — a dated preview
 * model id, a namespaced MCP tool name, and full-length UUIDs — so the
 * requests Astryx Table (8 explicitly sized columns) is exercised at its real
 * intrinsic width. `logs` used to be `[]`, which meant no story ever rendered
 * a table at all.
 */
function makeUsageLog(input: {
  id: string;
  kind: 'model' | 'tool';
  model: string;
  toolName?: string;
  status?: 'success' | 'error' | 'aborted';
  minutesAgo: number;
  sessionName?: string;
}): UsageStats['logs'][number] {
  return {
    id: input.id,
    ts: NOW - input.minutesAgo * 60_000,
    kind: input.kind,
    sessionId: `b0efaaf9-9e58-46c1-bfea-${input.id.padStart(12, '0')}`,
    sessionName: input.sessionName ?? '',
    turnId: `turn-${input.id}`,
    provider: 'zai-coding-plan',
    model: input.model,
    toolName: input.toolName,
    inputTokens: 12_400,
    outputTokens: 3_800,
    costUsd: input.kind === 'model' ? 0.0412 : undefined,
    latencyMs: input.kind === 'model' ? 2840 : 640,
    status: input.status ?? 'success',
  };
}

const usageLogs: UsageStats['logs'] = [
  makeUsageLog({
    id: '1',
    kind: 'model',
    model: 'anthropic/claude-sonnet-4-5-20250929-preview-extended-thinking',
    // A long session name exercises the 任务 column's truncate-plus-tooltip path.
    sessionName: '重构使用统计页请求日志的任务列，改为显示会话名称并处理超长标题的截断',
    minutesAgo: 4,
  }),
  makeUsageLog({
    id: '2',
    kind: 'tool',
    model: 'glm-4.7',
    toolName: 'mcp__cloud_workspace__list_repository_branch_protection_rules',
    sessionName: '排查 MCP 分支保护规则拉取失败',
    minutesAgo: 9,
  }),
  // No sessionName → renders the "未命名会话 · <short id>" fallback.
  makeUsageLog({ id: '3', kind: 'model', model: 'glm-4.7', status: 'error', minutesAgo: 16 }),
  makeUsageLog({ id: '4', kind: 'tool', model: 'glm-4.7', toolName: 'Bash', sessionName: 'Bash 环境探查', minutesAgo: 25 }),
  {
    ...makeUsageLog({ id: '5', kind: 'model', model: 'gpt-5', status: 'aborted', minutesAgo: 31 }),
    sessionId: undefined,
    turnId: undefined,
    costUsd: undefined,
  },
];

// Priced provenance so the fixtures' costs read as authoritative
// (pricedAttempts > 0); the empty fixture keeps the all-zero provenance.
const STORY_USAGE_PROVENANCE = {
  ...EMPTY_USAGE_PROVENANCE,
  coverage: {
    ...EMPTY_USAGE_PROVENANCE.coverage,
    attempts: 1,
    pricedAttempts: 1,
    usageReportedAttempts: 1,
  },
};

const usageStats: UsageStats = {
  summary: {
    totalRequests: 420,
    totalCostUsd: 2.34,
    totalTokens: 186_000,
    inputTokens: 100_000,
    outputTokens: 86_000,
    cacheTokens: 0,
    cacheMiss: 0,
    cacheRead: 0,
    cacheCreation: 0,
    reasoning: 0,
  },
  logs: usageLogs,
  byProvider: [{ provider: 'zai-coding-plan', requests: 280, tokens: 124_000, costUsd: 1.5 }],
  byModel: [
    {
      model: 'anthropic/claude-sonnet-4-5-20250929-preview-extended-thinking',
      requests: 140,
      tokens: 62_000,
      costUsd: 0.84,
    },
    { model: 'glm-4.7', requests: 280, tokens: 124_000, costUsd: 1.5 },
  ],
  byTool: [
    {
      tool: 'mcp__cloud_workspace__list_repository_branch_protection_rules',
      calls: 12,
      success: 11,
      errors: 1,
      avgDurationMs: 1240,
    },
    { tool: 'Bash', calls: 120, success: 118, errors: 2, avgDurationMs: 840 },
  ],
  pricing: [{ provider: 'zai-coding-plan', model: 'glm-4.7', inputPerMTokUsd: 0, outputPerMTokUsd: 0 }],
  provenance: STORY_USAGE_PROVENANCE,
};

const emptyUsageStats: UsageStats = {
  summary: {
    totalRequests: 0,
    totalCostUsd: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheTokens: 0,
    cacheMiss: 0,
    cacheRead: 0,
    cacheCreation: 0,
    reasoning: 0,
  },
  logs: [],
  byProvider: [],
  byModel: [],
  byTool: [],
  pricing: [],
  provenance: EMPTY_USAGE_PROVENANCE,
};

const singleProviderUsageStats: UsageStats = {
  ...emptyUsageStats,
  summary: {
    ...emptyUsageStats.summary,
    totalRequests: 37,
    totalCostUsd: 0.18,
    totalTokens: 24_800,
    inputTokens: 19_600,
    outputTokens: 5_200,
  },
  byProvider: [{ provider: 'zai-coding-plan', requests: 37, tokens: 24_800, costUsd: 0.18 }],
  provenance: STORY_USAGE_PROVENANCE,
};

const multiModelUsageStats: UsageStats = {
  ...emptyUsageStats,
  summary: {
    ...emptyUsageStats.summary,
    totalRequests: 592,
    totalCostUsd: 8.42,
    totalTokens: 1_284_000,
    inputTokens: 914_000,
    outputTokens: 370_000,
    cacheTokens: 436_000,
    cacheRead: 436_000,
  },
  byModel: [
    { model: 'glm-4.7', requests: 280, tokens: 624_000, costUsd: 1.5 },
    { model: 'gpt-5', requests: 148, tokens: 318_000, costUsd: 3.74 },
    { model: 'claude-sonnet-4-5-20250929', requests: 96, tokens: 214_000, costUsd: 2.56 },
    { model: 'gemini-2.5-pro', requests: 48, tokens: 96_000, costUsd: 0.52 },
    { model: 'qwen3-coder-480b-a35b-instruct', requests: 20, tokens: 32_000, costUsd: 0.1 },
  ],
  provenance: STORY_USAGE_PROVENANCE,
};

function makeMemoryEntry(input: {
  id: string;
  title: string;
  content: string;
  status: LocalMemoryEntryPreview['status'];
  tags?: readonly string[];
  minutesAgo?: number;
}): LocalMemoryEntryPreview {
  const ts = NOW - (input.minutesAgo ?? 60) * 60_000;
  return {
    id: input.id,
    origin: 'manual',
    source: 'user_authored',
    status: input.status,
    title: input.title,
    content: input.content,
    createdAt: ts,
    updatedAt: ts,
    tags: input.tags ?? [],
  };
}

const memoryEntries: LocalMemoryEntryPreview[] = [
  makeMemoryEntry({
    id: 'mem-1',
    title: '部署流程要走灰度队列，先发 1% 再看 30 分钟错误率，确认无回归后才放全量',
    content:
      '生产部署必须先进灰度队列（deploy-canary），观察 30 分钟内 5xx 率与 p99 延迟，都稳定后再放全量。历史上有两次全量直发导致回滚，耗时超过一小时。相关看板：grafana.internal/d/deploy-canary-overview。',
    status: 'active',
    tags: ['deploy', 'canary', 'sre', 'incident-review', 'grafana'],
    minutesAgo: 42,
  }),
  makeMemoryEntry({
    id: 'mem-2',
    title: '用户偏好中文回复',
    content: '交流一律使用中文，代码注释保持英文。',
    status: 'active',
    minutesAgo: 180,
  }),
  makeMemoryEntry({
    id: 'mem-3',
    title: '旧的 API 网关地址已废弃',
    content: '内部网关已从 gateway-legacy.internal:8443 迁移到 mesh.internal，旧地址 2026-06 起停止解析。',
    status: 'archived',
    tags: ['infra'],
    minutesAgo: 4320,
  }),
];

function makeMemoryBackup(kind: LocalMemoryBackupInfo['kind'], minutesAgo: number): LocalMemoryBackupInfo {
  return {
    path: `/Users/storybook/Library/Application Support/Maka/workspaces/default/memory/MEMORY.md.${kind}.bak`,
    kind,
    updatedAt: NOW - minutesAgo * 60_000,
    sizeBytes: 4_812,
    entryCount: 3,
    activeEntryCount: 2,
    archivedEntryCount: 1,
    safeMode: false,
  };
}

function makeMemoryState(input: {
  entries: LocalMemoryEntryPreview[];
  backups?: LocalMemoryBackupInfo[];
}): LocalMemoryState {
  const activeEntries = input.entries.filter((entry) => entry.status === 'active');
  const archivedEntries = input.entries.filter((entry) => entry.status === 'archived');
  const content = input.entries
    .map((entry) => `## ${entry.title}\n\n${entry.content}\n`)
    .join('\n');
  return {
    path: '/Users/storybook/Library/Application Support/Maka/workspaces/default/memory/MEMORY.md',
    enabled: true,
    agentReadEnabled: true,
    status: 'ok',
    content,
    entryCount: input.entries.length,
    activeEntryCount: activeEntries.length,
    archivedEntryCount: archivedEntries.length,
    entries: input.entries,
    activeEntries,
    archivedEntries,
    latestEntry: input.entries[0],
    latestBackup: input.backups?.[0],
    backups: input.backups,
  };
}

const emptyMemoryState = makeMemoryState({ entries: [] });
const populatedMemoryState = makeMemoryState({
  entries: memoryEntries,
  backups: [makeMemoryBackup('save', 42), makeMemoryBackup('restore', 300)],
});

function makeMemoryBridgeChannels(state: LocalMemoryState) {
  return {
    memory: {
      getState: async () => state,
      setEnabled: async () => state,
      setAgentReadEnabled: async () => state,
      save: async () => state,
      reset: async () => state,
      restoreLatestBackup: async () => ({ ok: true as const, state }),
      restoreBackup: async () => ({ ok: true as const, state }),
      openFile: async () => ({ ok: true as const }),
      openLatestBackup: async () => ({ ok: true as const }),
      openBackup: async () => ({ ok: true as const }),
    },
  };
}

/**
 * Permission Center / Health Center fixtures.
 *
 * These three bridge channels used to answer with empty payloads, which left
 * both pages unusable as the visual baseline #1303 asks for: `permissions: {}`
 * crashed the Permission Center outright (the page maps `OS_PERMISSION_IDS`
 * and main's `buildPermissionSnapshot` always ships a complete record), and an
 * all-zero health summary rendered five dimmed tiles with nothing under them.
 *
 * The fixtures mirror the shape main actually builds, with a deliberately
 * mixed set of states so tone, wrapping, and the summary grids are all
 * exercised at once.
 */
function makeOsPermission(input: {
  id: keyof PermissionSnapshot['permissions'];
  status: OsPermissionState;
  reason?: string;
  canRequest?: boolean;
  canOpenSettings?: boolean;
}): OsPermissionSnapshot {
  return {
    id: input.id,
    status: input.status,
    source: 'electron',
    checkedAt: NOW - 30_000,
    reason: input.reason,
    canOpenSettings: input.canOpenSettings ?? input.status !== 'unsupported',
    canRequest: input.canRequest ?? false,
  };
}

const permissionSnapshot: PermissionSnapshot = {
  checkedAt: NOW - 30_000,
  platform: STORY_PLATFORM,
  permissions: {
    accessibility: makeOsPermission({ id: 'accessibility', status: 'granted' }),
    screen_recording: makeOsPermission({
      id: 'screen_recording',
      status: 'not_determined',
      canRequest: true,
    }),
    notifications: makeOsPermission({
      id: 'notifications',
      status: 'granted',
      canRequest: true,
    }),
    automation: makeOsPermission({
      id: 'automation',
      status: 'unsupported',
      reason: '当前系统版本不暴露自动化授权状态。',
      canOpenSettings: false,
    }),
  },
};

function makeCapability(input: Partial<CapabilitySnapshot> & Pick<CapabilitySnapshot, 'id' | 'label' | 'readiness'>): CapabilitySnapshot {
  return {
    feature: { state: 'enabled', source: 'settings' },
    configuration: { state: 'present', source: 'settings' },
    osPermissions: [],
    actionApproval: { state: 'not_required', source: 'not_applicable' },
    memoryAcceptance: { state: 'not_applicable', source: 'not_applicable' },
    runtimeProbe: { state: 'healthy', source: 'runtime_probe', lastCheckedAt: NOW - 60_000 },
    canRevoke: false,
    canPause: false,
    guidance: [],
    auditEvents: [],
    updatedAt: NOW - 60_000,
    ...input,
  };
}

const capabilitySnapshot: CapabilitySnapshotCollection = {
  checkedAt: NOW - 30_000,
  capabilities: [
    makeCapability({
      id: 'computer_use',
      label: '计算机操作（辅助功能 + 屏幕录制）',
      readiness: 'degraded',
      runtimeProbe: {
        state: 'degraded',
        source: 'runtime_probe',
        lastCheckedAt: NOW - 5 * 60_000,
        reason: 'maka-cu 未响应握手，已回落到只读观察模式。',
      },
      osPermissions: [
        { id: 'accessibility', required: true, status: 'granted' },
        { id: 'screen_recording', required: true, status: 'not_determined' },
      ],
      actionApproval: { state: 'required_per_action', source: 'capability_policy' },
      guidance: ['前往系统设置授予屏幕录制权限后重新探测。'],
    }),
    makeCapability({
      id: 'memory_write',
      label: '记忆写入',
      readiness: 'enabled',
      memoryAcceptance: { state: 'accepted', source: 'memory_contract' },
      auditEvents: ['2026-07-24 10:12 接受了 3 条记忆草稿'],
    }),
  ],
};

const healthSignals: HealthSignal[] = [
  {
    id: 'app:config',
    label: '应用配置',
    scope: 'app',
    layer: 'configuration',
    status: 'ok',
    source: 'settings',
    checkedAt: NOW - 60_000,
    message: '配置文件可读写，schema 版本为最新。',
  },
  {
    id: 'conn:zai-live',
    label: 'Z.AI Live',
    scope: 'llm_connection',
    layer: 'validation',
    status: 'ok',
    source: 'connection_test',
    checkedAt: NOW - 12 * 60_000,
    message: '连接测试通过，延迟 210ms。',
    detail: '验证通过只代表凭据可用，实际可用性仍需运行态探测确认。',
  },
  {
    id: 'conn:openai-review',
    label: 'OpenAI Review',
    scope: 'llm_connection',
    layer: 'validation',
    status: 'error',
    source: 'connection_test',
    checkedAt: NOW - 3 * 60_000,
    message: '连接测试失败：HTTP 401 invalid_api_key。',
    detail: '凭据已失效或被吊销，请在「模型」页重新填写 API Key 后再次测试。',
    blocksSend: true,
  },
  {
    id: 'feature:computer-use',
    label: '计算机操作',
    scope: 'capability',
    layer: 'feature',
    status: 'info',
    source: 'capability_snapshot',
    checkedAt: NOW - 60_000,
    message: '功能已开启，但仍以逐次审批模式运行。',
    relatedCapabilityId: 'computer_use',
  },
  {
    id: 'probe:maka-cu',
    label: 'maka-cu 运行态探测',
    scope: 'capability',
    layer: 'runtime_probe',
    status: 'warning',
    source: 'runtime_probe',
    checkedAt: NOW - 5 * 60_000,
    message: '探测超时，已回落到只读观察模式。',
    detail: 'maka-cu 未在 3000ms 内完成握手；下一次探测会在功能被调用时自动触发。',
    relatedCapabilityId: 'computer_use',
    blocksCapability: true,
  },
  {
    id: 'storage:sessions',
    label: '会话存储',
    scope: 'storage',
    layer: 'storage',
    status: 'ok',
    source: 'storage',
    checkedAt: NOW - 60_000,
    message: 'SQLite 库可写，WAL 检查点正常。',
  },
];

const healthSnapshot: HealthSnapshot = buildHealthSnapshot(NOW - 45_000, healthSignals);

const runtimeHostProfiles: DesktopRuntimeHostProfileSnapshot = {
  defaultProfileId: 'local',
  entries: [
    {
      profile: { id: 'local', name: 'Local', kind: 'local' },
      enabled: true,
      isDefault: true,
      readiness: 'ready',
      hostId: 'storybook-local-host',
    },
  ],
};

const runtimeHostProfilesWithRemote: DesktopRuntimeHostProfileSnapshot = {
  defaultProfileId: 'local',
  entries: [
    ...runtimeHostProfiles.entries,
    {
      profile: {
        id: 'remote',
        name: 'Remote',
        kind: 'remote',
        rootId: 'storybook-remote-root',
        transport: {
          kind: 'ssh',
          destination: 'storybook.example.test',
          remotePort: 43123,
          websocketPath: '/runtime-host',
        },
      },
      enabled: true,
      isDefault: false,
      readiness: 'ready',
      hostId: 'storybook-remote-host',
    },
  ],
};

const unavailableRuntimeHostProfiles: DesktopRuntimeHostProfileSnapshot = {
  defaultProfileId: 'local',
  entries: [
    {
      profile: { id: 'local', name: 'Local', kind: 'local' },
      enabled: true,
      isDefault: true,
      readiness: 'unavailable',
      message: 'Runtime Host is offline in this story.',
    },
  ],
};

const STORY_RUNTIME_HOST_KEY = 'local:storybook-local-host';

function seedGeneralSnapshotCache(cache: SettingsSnapshotCache): void {
  const settings = createDefaultSettings();
  cache.commitClientRead(settings);
  cache.commitRuntimeHostCatalogRead(runtimeHostProfiles);
  cache.commitRuntimeHostSettingsRead(STORY_RUNTIME_HOST_KEY, settings);
  cache.commitRuntimeHostConnectionsRead(STORY_RUNTIME_HOST_KEY, {
    connections,
    defaultSlug: 'zai-live',
  });
}

function seedCopilotGenerationSnapshotCache(cache: SettingsSnapshotCache): void {
  seedGeneralSnapshotCache(cache);
  cache.commitRuntimeHostConnectionsRead(STORY_RUNTIME_HOST_KEY, {
    connections: generationStoryConnections,
    defaultSlug: 'zai-live',
  });
}

function seedGeneralTwoHostSnapshotCache(cache: SettingsSnapshotCache): void {
  seedGeneralSnapshotCache(cache);
  cache.commitRuntimeHostCatalogRead(runtimeHostProfilesWithRemote);
}

let storyClientSettings = createDefaultSettings();
let storyRuntimeHostSettings = createDefaultSettings();

const makaBridge = {
  runtimeHostProfiles: {
    getDefaultHost: async () => ({ profileId: 'local', hostId: 'storybook-local-host' }),
    getSnapshot: async () => runtimeHostProfiles,
    addAndEnable: async () => ({ kind: 'connected' as const, snapshot: runtimeHostProfiles }),
    remove: async () => runtimeHostProfiles,
    setEnabled: async () => runtimeHostProfiles,
    setDefault: async () => runtimeHostProfiles,
    subscribeChanges: () => () => undefined,
  },
  // Projects always mounts the Runtime Host management dialog shell, even
  // before a remote profile is selected. Keep the shared Settings fixture in
  // sync with the full preload surface so mount-time subscriptions stay real.
  runtimeHostManagement: {
    run: async (
      _profileId: string,
      action: Parameters<typeof window.maka.runtimeHostManagement.run>[1],
    ) => ({
      schemaVersion: 1 as const,
      kind: 'error' as const,
      action,
      error: { code: 'storybook_unavailable', message: 'Not configured in this story.' },
    }),
    update: async () => ({
      schemaVersion: 1 as const,
      kind: 'error' as const,
      action: 'update' as const,
      error: { code: 'storybook_unavailable', message: 'Not configured in this story.' },
    }),
    subscribeProgress: () => () => undefined,
    listCredentials: async () => ({ canRotate: false, credentials: [] }),
    rotateCredential: async () => ({ canRotate: false, credentials: [] }),
    revokeCredential: async () => ({ canRotate: false, credentials: [] }),
  },
  settings: {
    getClient: async () => storyClientSettings,
    get: async () => storyRuntimeHostSettings,
    updateClient: async (
      patch: Parameters<typeof window.maka.settings.updateClient>[0],
    ): Promise<UpdateAppSettingsResult> => {
      storyClientSettings = mergeSettings(storyClientSettings, patch);
      return { settings: storyClientSettings };
    },
    update: async (patch: Parameters<typeof window.maka.settings.update>[0]): Promise<UpdateAppSettingsResult> => {
      storyRuntimeHostSettings = mergeSettings(storyRuntimeHostSettings, patch);
      return { settings: storyRuntimeHostSettings };
    },
    subscribeClientChanged: () => () => undefined,
    subscribeExternalChanged: () => () => undefined,
    usageStats: async (): Promise<UsageStats> => usageStats,
    bots: {
      listStatuses: async () => ({}),
      subscribeStatusChanges: () => () => undefined,
    },
  },
  connections: connectionsBridge,
  // The OAuth cards on 模型 read their live state off window.maka rather than
  // through the connections bridge, so the page needs these channels to render
  // the state a user actually sees: without them the gate call rejects on
  // mount, the Claude card never appears, and every other card stays at its
  // static 可用 label. Each card's login modal has its own fixture in
  // Product/Settings/Providers.
  openAiCodex: {
    getAccountState: async () => ({
      runtimeState: 'authenticated',
      email: 'codex@example.com',
      plan: 'Plus',
    }),
  },
  githubCopilotSubscription: {
    getAccountState: async () => ({ runtimeState: 'not_logged_in' }),
  },
  xaiOAuth: {
    getAccountState: async () => ({ runtimeState: 'not_logged_in' }),
  },
  app: {
    info: async () => ({
      platform: STORY_PLATFORM,
      osRelease: '23.4.0',
      arch: 'arm64',
      buildMode: 'dev',
      buildCommit: 'a63ae4d',
      appVersion: '0.9.0-dev',
      electronVersion: '33.2.0',
      nodeVersion: '20.18.0',
      chromeVersion: '130.0.6723.59',
      // #1363: was missing entirely — the About and Data pages' 工作区路径
      // rows rendered an EMPTY value in every story. Deliberately long and
      // deep so the mono value exercises its wrap contract.
      workspacePath:
        '/Users/storybook-fixture-user/Library/Application Support/Maka/workspaces/infra-observability-platform-desktop',
    }),
    openPath: async () => ({ ok: true as const, opened: '/Users/storybook' }),
    // The 外观 page mounts the app-icon picker as soon as it opens. Without
    // these the story throws on mount rather than degrading: calling a bridge
    // method the fixture does not define is a synchronous TypeError, which the
    // effect's own `.catch()` never sees.
    //
    // The set deliberately spans one shipped icon per group plus an imported
    // one, so the smoke covers the group headings and the remove affordance
    // rather than an empty picker.
    iconPreviews: async () => [
      { id: 'default' as const, dataUrl: STORY_ICON_PREVIEW },
      { id: 'mono' as const, dataUrl: STORY_ICON_PREVIEW },
      { id: 'sky' as const, dataUrl: STORY_ICON_PREVIEW },
      { id: 'ink' as const, dataUrl: STORY_ICON_PREVIEW },
      { id: 'pencil-kraft' as const, dataUrl: STORY_ICON_PREVIEW },
      { id: 'alpine' as const, dataUrl: STORY_ICON_PREVIEW },
      {
        id: `custom:${'a'.repeat(32)}` as const,
        dataUrl: STORY_ICON_PREVIEW,
        removable: true,
      },
    ],
    selectIcon: async (icon: Parameters<typeof window.maka.app.selectIcon>[0]) => ({
      ok: true as const,
      selection: icon,
    }),
    importIcon: async () => ({ ok: false as const, reason: 'cancelled' as const }),
    removeIcon: async () => ({ ok: true as const, selection: 'default' as const }),
    // About mounts update status + subscribe on open (Settings → 关于).
    updateStatus: async () => ({ state: 'idle' as const, currentVersion: '0.9.0-dev' }),
    subscribeUpdateStatus: () => () => undefined,
    checkForUpdates: async () => ({ state: 'not-available' as const, currentVersion: '0.9.0-dev' }),
  },
  ...makeMemoryBridgeChannels(emptyMemoryState),
  webSearch: {
    test: async () => ({ ok: true as const, results: [] }),
    query: async () => ({ ok: true as const, results: [] }),
  },
  health: {
    getSnapshot: async () => healthSnapshot,
  },
  permissions: {
    getSnapshot: async () => permissionSnapshot,
    openSystemSettings: async () => ({ ok: true }),
    requestAccess: async () => ({ ok: true }),
  },
  capabilities: {
    getSnapshot: async () => capabilitySnapshot,
  },
  dailyReview: {
    getConfig: async () => DEFAULT_DAILY_REVIEW_CONFIG,
    setConfig: async (patch: Record<string, unknown>) => ({
      ...DEFAULT_DAILY_REVIEW_CONFIG,
      ...patch,
    }),
    runOnce: async () => ({ ok: true }),
  },
  e2eFixture: {
    getState: async () => null,
  },
  // 导入任务 reads another agent's session directory through Desktop Main. The
  // fixture answers with one source and a short first page so the story shows
  // the source switch, the archived filter, and 加载更多 together. It honours
  // `includeArchived` and `cursor` rather than returning one fixed page:
  // otherwise the archived row shows while its filter is off and 加载更多 hands
  // back the first page forever, which is a control the story cannot be used to
  // judge.
  externalSessions: {
    listSources: async () => ({ adapterIds: ['codex'] }),
    list: async (input: { includeArchived?: boolean; cursor?: string; text?: string }) => {
      // The stub honours `text` because the real Host applies it before
      // paging. A stub that ignored it would render a search box that looks
      // wired and is not, and the story would certify that.
      const term = input.text?.trim().toLowerCase();
      const visible = externalConversations.filter(
        (conversation) =>
          (input.includeArchived || !conversation.archived) &&
          (!term ||
            conversation.name.toLowerCase().includes(term) ||
            conversation.cwd.toLowerCase().includes(term)),
      );
      const start = input.cursor === EXTERNAL_SECOND_PAGE ? EXTERNAL_PAGE_SIZE : 0;
      const end = start + EXTERNAL_PAGE_SIZE;
      return {
        sessions: visible.slice(start, end),
        nextCursor: end < visible.length ? EXTERNAL_SECOND_PAGE : null,
      };
    },
    import: async () => ({ ok: false as const, reason: 'commit_outcome_unknown' as const }),
  },
  // Appearance mounts CustomPetSettingsSection, which reads and subscribes on
  // window.maka.pets. Without this fixture the catalog story throws on mount
  // (subscribeChanges of undefined) and the render smoke fails the page.
  pets: {
    list: async () => [],
    getSelection: async () => null,
    select: async () => ({ ok: true as const, selectedPetId: null }),
    remove: async () => ({ ok: true as const, removed: false }),
    importLocalDirectory: async () => ({ ok: false as const, reason: 'cancelled' as const }),
    readSpriteSheet: async () => ({ ok: false as const, reason: 'not_found' as const }),
    subscribeChanges: () => () => undefined,
  },
} satisfies Record<string, unknown>;

const withSettingsBridge = withScopedMakaBridge(makaBridge);

function pendingForever<T>(): Promise<T> {
  return new Promise(() => undefined);
}

const withGeneralHostSettingsLoadingBridge = withScopedMakaBridge({
  ...makaBridge,
  settings: {
    ...makaBridge.settings,
    get: () => pendingForever(),
  },
} satisfies Record<string, unknown>);

const withGeneralConnectionsLoadingBridge = withScopedMakaBridge({
  ...makaBridge,
  connections: {
    ...connectionsBridge,
    getSnapshot: () => pendingForever(),
  },
} satisfies Record<string, unknown>);

const withGeneralCachedRevalidationBridge = withScopedMakaBridge({
  ...makaBridge,
  runtimeHostProfiles: {
    ...makaBridge.runtimeHostProfiles,
    getSnapshot: () => pendingForever(),
  },
  settings: {
    ...makaBridge.settings,
    get: () => pendingForever(),
  },
  connections: {
    ...connectionsBridge,
    getSnapshot: () => pendingForever(),
  },
} satisfies Record<string, unknown>);

let generationStoryCatalogPending = false;
let generationStoryRuntimeHostProfiles = runtimeHostProfiles;
let generationStoryConnectionsPending = false;
let generationStoryCodexEmail = 'old-generation@example.com';
let generationStoryCodexAccountReads = 0;
let generationStoryOpenedAuthIds: string[] = [];
let generationStoryCancelledAuthIds: string[] = [];
let generationStoryCopilotImportAttempts = 0;
let generationStoryCopilotSecretReads = 0;
let generationStoryCopilotImportResolve:
  | ((result: { ok: true }) => void)
  | undefined;
let generationStoryProfileListener:
  | ((event: DesktopRuntimeHostProfileChangedEvent) => void)
  | undefined;

function resetGenerationStoryBridge(
  snapshot: DesktopRuntimeHostProfileSnapshot = runtimeHostProfiles,
): void {
  generationStoryCatalogPending = false;
  generationStoryRuntimeHostProfiles = snapshot;
  generationStoryConnectionsPending = false;
  generationStoryCodexEmail = 'old-generation@example.com';
  generationStoryCodexAccountReads = 0;
  generationStoryOpenedAuthIds = [];
  generationStoryCancelledAuthIds = [];
  generationStoryCopilotImportAttempts = 0;
  generationStoryCopilotSecretReads = 0;
  generationStoryCopilotImportResolve = undefined;
  generationStoryProfileListener = undefined;
}

const generationStoryRuntimeHostProfilesBridge = {
  ...makaBridge.runtimeHostProfiles,
  getSnapshot: () => {
    return generationStoryCatalogPending
      ? pendingForever()
      : Promise.resolve({
          ...generationStoryRuntimeHostProfiles,
          // IPC returns a fresh structured clone. Reusing the cache's exact
          // object identity would suppress the selected-Host effect after
          // catalog hydration and make this fake less faithful than Desktop.
          entries: [...generationStoryRuntimeHostProfiles.entries],
        });
  },
  subscribeChanges: (handler: (event: DesktopRuntimeHostProfileChangedEvent) => void) => {
    generationStoryProfileListener = handler;
    return () => {
      if (generationStoryProfileListener === handler) {
        generationStoryProfileListener = undefined;
      }
    };
  },
};

const withGeneralHostGenerationRevalidationBridge = withScopedMakaBridge({
  ...makaBridge,
  runtimeHostProfiles: generationStoryRuntimeHostProfilesBridge,
} satisfies Record<string, unknown>);

const withModelsOAuthGenerationRevalidationBridge = withScopedMakaBridge({
  ...makaBridge,
  runtimeHostProfiles: generationStoryRuntimeHostProfilesBridge,
  openAiCodex: {
    ...makaBridge.openAiCodex,
    getAccountState: async () => {
      generationStoryCodexAccountReads += 1;
      return {
        runtimeState: 'authenticated' as const,
        email: generationStoryCodexEmail,
        plan: 'Plus',
      };
    },
  },
} satisfies Record<string, unknown>);

const withModelsConnectionsGenerationRevalidationBridge = withScopedMakaBridge({
  ...makaBridge,
  runtimeHostProfiles: generationStoryRuntimeHostProfilesBridge,
  connections: {
    ...connectionsBridge,
    getSnapshot: () => generationStoryConnectionsPending
      ? pendingForever()
      : connectionsBridge.getSnapshot(),
  },
} satisfies Record<string, unknown>);

const withModelsOAuthAuthorizationGenerationBridge = withScopedMakaBridge({
  ...makaBridge,
  runtimeHostProfiles: generationStoryRuntimeHostProfilesBridge,
  openAiCodex: {
    ...makaBridge.openAiCodex,
    getAccountState: async () => ({ runtimeState: 'not_logged_in' as const }),
    getAuthUrl: async () => ({
      authRequestId: 'authorization-from-generation-1',
      stateHint: 'GEN1-CODE',
    }),
    openAuthUrl: async (authRequestId: string) => {
      generationStoryOpenedAuthIds.push(authRequestId);
      return pendingForever<{ ok: true }>();
    },
    completeAuthorization: () => pendingForever<{ ok: true }>(),
    cancelAuthorization: async (authRequestId?: string) => {
      if (authRequestId) generationStoryCancelledAuthIds.push(authRequestId);
      return { ok: true as const };
    },
    logout: async () => ({ ok: true as const }),
  },
} satisfies Record<string, unknown>);

const withModelsCopilotReimportGenerationBridge = withScopedMakaBridge({
  ...makaBridge,
  runtimeHostProfiles: generationStoryRuntimeHostProfilesBridge,
  connections: {
    ...connectionsBridge,
    getSnapshot: async () => ({
      connections: generationStoryConnections,
      defaultConnection: 'zai-live',
      chatModelChoices: buildChatModelChoices(generationStoryConnections),
    }),
    hasSecret: async () => {
      generationStoryCopilotSecretReads += 1;
      return true;
    },
  },
  githubCopilotSubscription: {
    ...makaBridge.githubCopilotSubscription,
    connectExistingLogin: () => {
      generationStoryCopilotImportAttempts += 1;
      if (generationStoryCopilotImportAttempts > 1) {
        return Promise.resolve({ ok: true as const });
      }
      return new Promise<{ ok: true }>((resolve) => {
        generationStoryCopilotImportResolve = resolve;
      });
    },
  },
} satisfies Record<string, unknown>);

const withProviderCatalogIntentRevalidationBridge = withScopedMakaBridge({
  ...makaBridge,
  runtimeHostProfiles: {
    ...makaBridge.runtimeHostProfiles,
    getSnapshot: () => pendingForever(),
  },
  settings: {
    ...makaBridge.settings,
    get: () => pendingForever(),
  },
  connections: {
    ...connectionsBridge,
    getSnapshot: async () => {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
      return {
        connections,
        defaultConnection: 'zai-live',
        chatModelChoices: buildChatModelChoices(connections),
      };
    },
  },
} satisfies Record<string, unknown>);

const cachedProjectsSnapshotRead = fn(async () => ({
  projects: [],
  capabilities: {
    chooseClientDirectory: false,
    chooseHostDirectory: false,
    selectNoProject: false,
    setLocalDefault: false,
    viewClientPath: false,
  },
}));

const withProjectsCachedRevalidationBridge = withScopedMakaBridge({
  ...makaBridge,
  runtimeHostProfiles: {
    ...makaBridge.runtimeHostProfiles,
    getSnapshot: () => pendingForever(),
  },
  projects: {
    getSnapshot: cachedProjectsSnapshotRead,
    subscribeChanges: () => () => undefined,
  },
} satisfies Record<string, unknown>);

const withGeneralHostSettingsErrorBridge = withScopedMakaBridge({
  ...makaBridge,
  settings: {
    ...makaBridge.settings,
    get: async () => {
      throw new Error('Runtime Host settings read failed in this story.');
    },
  },
} satisfies Record<string, unknown>);

const withGeneralUnavailableBridge = withScopedMakaBridge({
  ...makaBridge,
  runtimeHostProfiles: {
    ...makaBridge.runtimeHostProfiles,
    getSnapshot: async () => unavailableRuntimeHostProfiles,
  },
} satisfies Record<string, unknown>);

// 已归档任务 renders the shell's catalog, so its fixture is sessions +
// projects rather than a settings patch. The set is chosen to exercise the
// projection itself: a revision family that must fold to one row, a linked
// subagent whose parent is present (hidden) and one whose parent is gone
// (listed), a task in no project, and an active task the page must drop.
function archivedTask(
  id: string,
  name: string,
  ageDays: number,
  overrides: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    id,
    name,
    isFlagged: false,
    isArchived: true,
    labels: [],
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionSlug: 'zai-live',
    connectionLocked: true,
    model: 'glm-4.7',
    permissionMode: 'ask',
    lastMessageAt: NOW - ageDays * 24 * 60 * 60 * 1000,
    ...overrides,
  };
}

function storyLinkedTo(parentSessionId: string): Partial<SessionSummary> {
  return {
    subagentParent: {
      kind: 'subagent',
      parentSessionId,
      spawnedBy: { parentRunId: 'run-1', parentTurnId: 'turn-1', toolCallId: 'call-1' },
      lifecycle: 'foreground',
    },
  };
}

const archivedTaskSessions: SessionSummary[] = [
  archivedTask('task-spawn', 'Single agent_spawn with local_read for runtime/src inspection', 6, {
    projectId: 'proj-maka',
  }),
  // Folds together with `task-spawn` into one row.
  archivedTask('task-spawn-v2', 'Single agent_spawn, second attempt', 5, {
    projectId: 'proj-maka',
    revisionRootSessionId: 'task-spawn',
    revisionParentSessionId: 'task-spawn',
  }),
  // Hidden: its parent is on the list, so it is part of that task.
  archivedTask('task-child', 'Inspect the runtime source directory', 6, {
    projectId: 'proj-maka',
    ...storyLinkedTo('task-spawn'),
  }),
  // Listed: its parent is gone, so nothing else can reach it.
  archivedTask('task-orphan', 'Leftover subagent run', 9, {
    projectId: 'proj-maka',
    ...storyLinkedTo('deleted-parent'),
  }),
  archivedTask('task-sort', '修复归档任务在导轨里的排序', 14, { projectId: 'proj-astryx' }),
  archivedTask('task-unfiled', 'Analyze entire project', 32),
  archivedTask('task-active', 'An active task the page must not list', 0, { isArchived: false }),
];

// 导入任务's rows come from another agent's directory, not from Maka's store:
// a source-native id, the cwd it ran in, and whether that agent archived it.
/**
 * Two rows a page, so the default view — three unarchived conversations — is
 * one short page plus 加载更多, and turning the archived filter on changes both
 * the first page and how many pages there are.
 */
const EXTERNAL_PAGE_SIZE = 2;
const EXTERNAL_SECOND_PAGE = 'page-2';

const externalConversations: DesktopExternalSessionCatalogItem[] = [
  {
    id: 'codex-01930f',
    name: 'Trace the flaky worktree teardown in CI',
    cwd: '/Users/storybook-fixture-user/workspace/maka-agent',
    updatedAt: Date.now() - 42 * 60 * 1000,
    importState: {
      importedCount: 2,
      importedSessionIds: ['imported-task-newest', 'imported-task-older'],
      isImporting: false,
    },
  },
  {
    id: 'codex-01930e',
    name: '把 provider catalog 的分页改成游标',
    cwd: '/Users/storybook-fixture-user/workspace/maka-agent',
    updatedAt: Date.now() - 3 * 60 * 60 * 1000,
    importState: { importedCount: 1, importedSessionIds: ['imported-task-1'], isImporting: true },
  },
  {
    id: 'codex-01930a',
    name: 'Reproduce the SQLite lock contention under parallel evals',
    cwd: '/Users/storybook-fixture-user/workspace/maka-agent',
    updatedAt: Date.now() - 2 * 24 * 60 * 60 * 1000,
    importState: { importedCount: 0, importedSessionIds: [], isImporting: false },
  },
  {
    id: 'codex-01929c',
    name: 'Draft the release notes for 0.9.0',
    cwd: '/Users/storybook-fixture-user/workspace/docs',
    updatedAt: Date.now() - 6 * 24 * 60 * 60 * 1000,
    archived: true,
    importState: { importedCount: 1, importedSessionIds: ['imported-archived'], isImporting: false },
  },
];

const archivedTaskProjects: ProjectRecord[] = [
  { id: 'proj-maka', name: 'maka-agent', locations: [], available: true },
  { id: 'proj-astryx', name: 'astryx-design', locations: [], available: true },
];

/**
 * Story-local stand-in for the shell's catalog. Restoring, deleting and
 * clearing really remove rows, because a story whose buttons resolve to
 * nothing shows a list that cannot answer the question it is there to answer.
 */
function useArchivedTasksStoryBridge(seed: readonly SessionSummary[]): ArchivedTasksBridge {
  const toast = useToast();
  const [sessions, setSessions] = useState<DesktopSessionSummary[]>(() =>
    seed.map((session) => ({
      ...session,
      runtimeHostId: 'storybook-local',
      profileId: 'local',
      profileName: 'Local',
      profileKind: 'local',
    })),
  );
  const confirmDelete = (sessionId: string) =>
    toast.confirm({
      title: `彻底删除「${sessions.find((session) => session.id === sessionId)?.name ?? ''}」？`,
      description: '任务及其全部消息会被永久删除，无法撤销。',
      confirmLabel: '永久删除',
      cancelLabel: '取消',
      destructive: true,
    });
  // Both writes go out with `revisionFamily: true`, so a row takes its whole
  // edit-and-resend family with it. Dropping only the id on screen would leave
  // an older revision behind and show a list the real app never produces.
  const drop = (ids: readonly string[]) => {
    setSessions((current) => {
      const doomed = new Set(ids.flatMap((id) => revisionFamilySessionIds(current, id)));
      return current.filter((session) => !doomed.has(session.id));
    });
  };
  return {
    sessions,
    projects: archivedTaskProjects,
    onRestore: (sessionId) =>
      setSessions((current) => {
        const family = new Set(revisionFamilySessionIds(current, sessionId));
        return current.map((session) =>
          family.has(session.id) ? { ...session, isArchived: false } : session,
        );
      }),
    // Mirrors the shell's own row action, which always confirms first — a
    // story where a row vanishes on one click would be showing an interaction
    // the app does not have.
    onDelete: (sessionId) => {
      void confirmDelete(sessionId).then((ok) => {
        if (ok) drop([sessionId]);
      });
    },
    onPurge: async (sessionIds) => {
      drop(sessionIds);
      return {
        removed: sessionIds.length,
        remaining: [],
        restored: [],
        verified: true,
        firstError: undefined,
      };
    },
  };
}
const gitBashSettings = mergeSettings(createDefaultSettings(), {
  shell: {
    preference: 'git_bash',
    executable: 'C:\\Program Files\\Git\\bin\\bash.exe',
  },
});
const withGitBashSettingsBridge = withScopedMakaBridge({
  ...makaBridge,
  settings: {
    ...makaBridge.settings,
    get: async () => gitBashSettings,
    update: async (
      patch: Parameters<typeof window.maka.settings.update>[0],
    ): Promise<UpdateAppSettingsResult> => ({
      settings: mergeSettings(gitBashSettings, patch),
    }),
  },
} satisfies Record<string, unknown>);

// #1364: list-page variants — empty vs populated vs long-content, per the
// tracking issue's expected deliverables.

const withMemoryPopulatedBridge = withScopedMakaBridge({
  ...makaBridge,
  ...makeMemoryBridgeChannels(populatedMemoryState),
} satisfies Record<string, unknown>);

function withUsageStoryBridge(
  stats: UsageStats,
  usage: Partial<AppSettings['usage']>,
) {
  const settings = mergeSettings(createDefaultSettings(), { usage });
  return withScopedMakaBridge({
    ...makaBridge,
    settings: {
      ...makaBridge.settings,
      get: async () => settings,
      update: async (
        patch: Parameters<typeof window.maka.settings.update>[0],
      ): Promise<UpdateAppSettingsResult> => ({
        settings: mergeSettings(settings, patch),
      }),
      usageStats: async (): Promise<UsageStats> => stats,
    },
  } satisfies Record<string, unknown>);
}

const withUsageEmptyBridge = withUsageStoryBridge(emptyUsageStats, {
  activeTab: 'providers',
});
const withUsageSingleProviderBridge = withUsageStoryBridge(singleProviderUsageStats, {
  activeTab: 'providers',
});
const withUsageMultiModelBridge = withUsageStoryBridge(multiModelUsageStats, {
  activeTab: 'models',
});
const withUsageLongTailBridge = withUsageStoryBridge(usageStats, {
  showDetails: true,
  activeTab: 'requests',
});

const subagentStorySettings = mergeSettings(createDefaultSettings(), {
  subagents: {
    presets: [
      {
        id: 'fast-reader',
        name: '快速代码阅读',
        description: '适合快速、低成本地搜索并理解大型仓库。',
        profile: 'local_read',
        connectionSlug: 'zai-live',
        model: 'glm-4.7',
        enabled: true,
      },
      {
        id: 'implementation-review',
        name: '实现与验证',
        description: '需要修改代码、运行测试并产出可合并补丁时使用。',
        profile: 'implementation',
        connectionSlug: 'openai-review',
        model: 'gpt-5',
        thinkingLevel: 'high',
        enabled: true,
      },
      {
        id: 'orphaned-route',
        name: '外部资料检索',
        description: '连接被删除后仍处于启用状态，用于展示失效路由。',
        profile: 'web_research',
        connectionSlug: 'removed-connection',
        model: 'legacy-search-model',
        enabled: true,
      },
      {
        id: 'retired-researcher',
        name: '旧研究配置',
        description: '保留用于展示已停用配置。',
        profile: 'web_research',
        connectionSlug: 'removed-connection',
        model: 'legacy-search-model',
        enabled: false,
      },
    ],
  },
});

const withSubagentSettingsBridge = withScopedMakaBridge({
  ...makaBridge,
  settings: {
    ...makaBridge.settings,
    get: async () => subagentStorySettings,
    update: async (
      patch: Parameters<typeof window.maka.settings.update>[0],
    ): Promise<UpdateAppSettingsResult> => ({
      settings: mergeSettings(subagentStorySettings, patch),
    }),
  },
} satisfies Record<string, unknown>);

type StoryBotStatuses = Awaited<ReturnType<typeof window.maka.settings.bots.listStatuses>>;

const botAttentionError =
  'Discord WebSocket 握手失败：系统级代理连接超时，请检查 TUN 模式与网络设置后重试。';

const botAttentionSettings = mergeSettings(createDefaultSettings(), {
  botChat: {
    channels: {
      telegram: {
        enabled: true,
        connected: true,
        readiness: 'operational',
        token: 'storybook-telegram-token',
        lastTestAt: NOW - 8 * 60_000,
      },
      discord: {
        enabled: true,
        connected: true,
        readiness: 'degraded',
        token: 'storybook-discord-token',
        lastTestAt: NOW - 25 * 60_000,
        lastError: botAttentionError,
      },
    },
  },
});

function createInactiveStoryBotStatus(
  platform: keyof StoryBotStatuses,
): StoryBotStatuses[keyof StoryBotStatuses] {
  return {
    platform,
    running: false,
    readiness: 'scaffolded',
    connection: 'none',
  };
}

const botAttentionStatuses: StoryBotStatuses = {
  telegram: {
    platform: 'telegram',
    running: true,
    readiness: 'operational',
    connection: 'polling',
    startedAt: NOW - 2 * 60 * 60_000,
    lastEventAt: NOW - 4 * 60_000,
    identity: { username: '@maka_review_bot' },
  },
  discord: {
    platform: 'discord',
    running: false,
    readiness: 'degraded',
    connection: 'none',
    reason: botAttentionError,
    lastEventAt: NOW - 35 * 60_000,
    identity: { username: 'maka-remote-review-bot-with-a-long-name' },
  },
  feishu: createInactiveStoryBotStatus('feishu'),
  wecom: createInactiveStoryBotStatus('wecom'),
  wechat: createInactiveStoryBotStatus('wechat'),
  dingtalk: createInactiveStoryBotStatus('dingtalk'),
  qq: createInactiveStoryBotStatus('qq'),
  slack: createInactiveStoryBotStatus('slack'),
};

function makeBotAttentionBridge(settings: AppSettings) {
  return {
    ...makaBridge,
    settings: {
      ...makaBridge.settings,
      get: async () => settings,
      update: async (
        patch: Parameters<typeof window.maka.settings.update>[0],
      ): Promise<UpdateAppSettingsResult> => ({
        settings: mergeSettings(settings, patch),
      }),
      bots: {
        ...makaBridge.settings.bots,
        listStatuses: async () => botAttentionStatuses as StoryBotStatuses,
      },
    },
  } satisfies Record<string, unknown>;
}

const withBotAttentionBridge = withScopedMakaBridge(makeBotAttentionBridge(botAttentionSettings));

type SettingsStoryProps = {
  section: SettingsSection;
  connections?: LlmConnection[];
  defaultSlug?: string | null;
  openProviderCatalog?: boolean;
  initialConnectionSlug?: string;
  /** Seeds 已归档任务. Empty for every story that is not about that page. */
  archivedTaskSessions?: readonly SessionSummary[];
  seedSnapshotCache?(cache: SettingsSnapshotCache): void;
};

/**
 * The provider has to sit above the body: 已归档任务's story bridge confirms
 * through the same toast surface the shell's row action uses, and a hook cannot
 * reach a provider its own component renders.
 */
function SettingsStory(props: SettingsStoryProps) {
  return (
    <ToastProvider>
      <SettingsStoryFrame {...props} />
    </ToastProvider>
  );
}

function SettingsStoryFrame(props: SettingsStoryProps) {
  const archivedTasks = useArchivedTasksStoryBridge(props.archivedTaskSessions ?? []);
  const initialFocusRef = useRef<HTMLButtonElement>(null);
  const [uiLocaleUpdateGate] = useState(createUiLocaleUpdateGate);
  const [snapshotCache] = useState(() => {
    const cache = createSettingsSnapshotCache();
    props.seedSnapshotCache?.(cache);
    return cache;
  });
  // Fidelity: the theme and palette pickers are the 外观 page's whole content,
  // and with static props + noop handlers the selection could never move — the
  // story showed a picker that looked interactive and wasn't. The real app
  // holds both in AppShell state and applies them optimistically on click.
  const [themePref, setThemePref] = useState<ThemePreference>('auto');
  const [themePalette, setThemePalette] = useState<ThemePalette>('default');

  return (
    <>
      {/* `100dvh`, not `100%`: `SettingsSurface` is a `Layout height="fill"`,
          which needs a bounded ancestor to hand its content pane a scroll
          box. Under Storybook's fullscreen body a percentage height resolves
          against an auto-height parent, so every page taller than the
          viewport stretched the whole surface instead of scrolling inside it
          — 权限与能力 reached 1942px in a 720px frame with no way down. */}
      <div
        data-maka-e2e-fixture="true"
        style={{
          background: 'var(--surface-canvas)',
          height: '100dvh',
          minHeight: 640,
        }}
      >
        <SettingsSurface
          onClose={noop}
          themePref={themePref}
          onThemeChange={setThemePref}
          themePalette={themePalette}
          onThemePaletteChange={setThemePalette}
          onUiLocalePreferenceChange={noop}
          uiLocaleUpdateGate={uiLocaleUpdateGate}
          onDefaultPermissionModeChange={noop}
          request={{ section: props.section }}
          openProviderCatalog={props.openProviderCatalog}
          initialConnectionSlug={props.initialConnectionSlug}
          initialFocusRef={initialFocusRef}
          onOpenDailyReview={noop}
          onOpenSession={noop}
          archivedTasks={archivedTasks}
          onTaskImported={noop}
          onRemoteHostAdded={noop}
          onSelectedRuntimeHostProfileIdChange={noop}
          snapshotCache={snapshotCache}
        />
      </div>
    </>
  );
}

async function waitForStoryButton(
  canvasElement: HTMLElement,
  predicate: (button: HTMLButtonElement) => boolean,
): Promise<HTMLButtonElement> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const button = Array.from(canvasElement.querySelectorAll<HTMLButtonElement>('button')).find(
      predicate,
    );
    if (button) return button;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 20));
  }
  throw new Error('Story action button did not render');
}

async function waitForStoryCondition(predicate: () => boolean, errorMessage: string): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 20));
  }
  throw new Error(errorMessage);
}

async function openDailyReviewModelSelector(canvasElement: HTMLElement): Promise<HTMLButtonElement> {
  const selector = await waitForStoryButton(
    canvasElement,
    (candidate) => candidate.textContent?.includes(DAILY_REVIEW_DEFAULT_MODEL_LABEL) === true,
  );
  await userEvent.click(selector);
  await waitForStoryCondition(
    () => selector.getAttribute('aria-expanded') === 'true',
    'Daily Review model selector did not open',
  );
  return selector;
}

// Real path: sidebar footer 设置 → 模型.
export const Models: Story = {
  decorators: [withSettingsBridge],
  render: () => <SettingsStory section="models" />,
};
// Real path: sidebar footer 设置 → 子 Agent, with multiple approved model routes.
export const Subagents: Story = {
  decorators: [withSubagentSettingsBridge],
  render: () => <SettingsStory section="subagents" />,
};

// Real path: 设置 → 子 Agent → 配置“实现与验证”. A second story because the
// editor is a route level, not a disclosure: it replaces the list, shares no
// content with it, and is where this page's pixel work happens. Landed on the
// implementation preset because it renders the most of the level at once — the
// settled read-only subagent_id, the capability warning, the degraded model
// option, and the delete section. It renders them; what they must be is pinned
// in the e2e journeys, not here.
export const SubagentEditor: Story = {
  decorators: [withSubagentSettingsBridge],
  render: () => <SettingsStory section="subagents" />,
  play: async ({ canvasElement }) => {
    const button = await waitForStoryButton(
      canvasElement,
      (candidate) => candidate.getAttribute('aria-label') === '配置“实现与验证”',
    );
    await userEvent.click(button);
  },
};

// Real path: 设置 → 通用.
export const General: Story = {
  decorators: [withSettingsBridge],
  render: () => <SettingsStory section="general" />,
};
// Cold path: Desktop-owned preferences are ready while the selected Runtime
// Host settings read is still pending. The complete page topology stays
// visible as neutral row placeholders, without treating hydration as a warning.
export const GeneralHostSettingsLoading: Story = {
  decorators: [withGeneralHostSettingsLoadingBridge],
  render: () => <SettingsStory section="general" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText('显示名称');
    await canvas.findByRole('switch', { name: '完成时发送系统通知' });
    await expect(
      await canvas.findByRole('button', { name: '默认模型' }),
    ).toBeEnabled();
    await expect(
      canvas.queryByRole('textbox', { name: '助手语气偏好' }),
    ).not.toBeInTheDocument();
    await expect(canvas.queryByRole('alert')).not.toBeInTheDocument();
  },
};
// Independent resource path: Host settings are usable, but the model
// connection catalog is still loading. Only 默认模型 remains a placeholder.
export const GeneralConnectionsLoading: Story = {
  decorators: [withGeneralConnectionsLoadingBridge],
  render: () => <SettingsStory section="general" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const tone = await canvas.findByRole('textbox', { name: '助手语气偏好' });
    await expect(tone).toBeEnabled();
    await canvas.findByText('默认模型');
    await expect(
      canvas.queryByRole('button', { name: '默认模型' }),
    ).not.toBeInTheDocument();
    await expect(canvas.queryByRole('alert')).not.toBeInTheDocument();
  },
};
// Warm path: renderer-memory snapshots render the complete General page on
// the first commit, but Host-owned mutations remain fenced until this modal
// verifies the catalog and both resource authorities.
export const GeneralCachedRevalidation: Story = {
  decorators: [withGeneralCachedRevalidationBridge],
  render: () => (
    <SettingsStory
      section="general"
      seedSnapshotCache={seedGeneralSnapshotCache}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const tone = await canvas.findByRole('textbox', { name: '助手语气偏好' });
    const defaultModel = await canvas.findByRole('button', { name: '默认模型' });
    await expect(tone).toBeDisabled();
    await expect(defaultModel).toBeDisabled();
    await expect(
      canvas.getByRole('switch', { name: '完成时发送系统通知' }),
    ).toBeEnabled();
    await expect(canvas.getByRole('radio', { name: '中文' })).toBeEnabled();
    const mixedBoundary = canvasElement.querySelector<HTMLElement>(
      '.settingsRuntimeHostInteractionBoundary',
    );
    if (!mixedBoundary) throw new Error('General mixed-ownership boundary did not render');
    await expect(mixedBoundary).not.toHaveAttribute('inert');
    await canvas.findByText('正在加载设置');
    await expect(canvas.queryByRole('alert')).not.toBeInTheDocument();
  },
};
// A Runtime Host can be replaced without changing its renderer-facing
// profileId:hostId key. The lifecycle epoch is the generation boundary: keep
// cached Host values visible, revoke their write authority immediately, and
// leave Desktop-owned controls usable while the new generation verifies.
export const GeneralHostGenerationRevalidation: Story = {
  decorators: [withGeneralHostGenerationRevalidationBridge],
  render: () => {
    resetGenerationStoryBridge();
    return (
      <SettingsStory
        section="general"
        seedSnapshotCache={seedGeneralSnapshotCache}
      />
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const tone = await canvas.findByRole('textbox', { name: '助手语气偏好' });
    const defaultModel = await canvas.findByRole('button', { name: '默认模型' });
    await waitForStoryCondition(
      () => !tone.matches(':disabled') && !defaultModel.matches(':disabled'),
      'Initial Runtime Host generation did not become interactive',
    );
    const listener = generationStoryProfileListener;
    if (!listener) throw new Error('Runtime Host generation listener did not subscribe');

    generationStoryCatalogPending = true;
    listener({
      epoch: 'storybook-generation-2',
      profileId: 'local',
      profileName: 'Local',
      profileKind: 'local',
      profileAccess: 'owner',
      readiness: 'ready',
      hostId: 'storybook-local-host',
      isDefault: true,
    });

    await waitForStoryCondition(
      () => tone.matches(':disabled') && defaultModel.matches(':disabled'),
      'Previous Runtime Host generation remained writable',
    );
    await expect(tone).toBeDisabled();
    await expect(defaultModel).toBeDisabled();
    await expect(
      canvas.getByRole('switch', { name: '完成时发送系统通知' }),
    ).toBeEnabled();
    await expect(canvas.getByRole('radio', { name: '中文' })).toBeEnabled();
    const mixedBoundary = canvasElement.querySelector<HTMLElement>(
      '.settingsRuntimeHostInteractionBoundary',
    );
    if (!mixedBoundary) throw new Error('General mixed-ownership boundary did not render');
    await expect(mixedBoundary).not.toHaveAttribute('inert');
  },
};
// A lifecycle event is newer than the cached catalog even when its profile is
// not selected yet. Switching to that profile must respect the event's
// reconnecting tombstone instead of reviving the catalog's last-ready Host.
export const GeneralBackgroundHostReconnectThenSelect: Story = {
  decorators: [withGeneralHostGenerationRevalidationBridge],
  render: () => {
    resetGenerationStoryBridge(runtimeHostProfilesWithRemote);
    return (
      <SettingsStory
        section="general"
        seedSnapshotCache={seedGeneralTwoHostSnapshotCache}
      />
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const tone = await canvas.findByRole('textbox', { name: '助手语气偏好' });
    await waitForStoryCondition(
      () => !tone.matches(':disabled'),
      'Initial Runtime Host did not become interactive',
    );
    const listener = generationStoryProfileListener;
    if (!listener) throw new Error('Runtime Host generation listener did not subscribe');

    generationStoryCatalogPending = true;
    listener({
      epoch: 'storybook-remote-generation-2',
      profileId: 'remote',
      profileName: 'Remote',
      profileKind: 'remote',
      profileAccess: 'owner',
      readiness: 'reconnecting',
      hostId: 'storybook-remote-host',
      isDefault: false,
    });

    await userEvent.click(canvas.getByRole('combobox', { name: 'Runtime Host' }));
    await userEvent.click(
      await within(document.body).findByRole('option', { name: 'Remote' }),
    );
    await waitForStoryCondition(
      () => {
        const currentTone = canvas.queryByRole('textbox', {
          name: '助手语气偏好',
        });
        return currentTone === null || currentTone.matches(':disabled');
      },
      'The reconnecting background Host was revived from the stale catalog',
    );
    await expect(canvas.getByRole('combobox', { name: 'Runtime Host' }))
      .toHaveTextContent('Remote');
    await canvas.findByText('助手语气偏好');
    const currentTone = canvas.queryByRole('textbox', { name: '助手语气偏好' });
    if (currentTone) await expect(currentTone).toBeDisabled();
    await expect(
      canvas.getByRole('switch', { name: '完成时发送系统通知' }),
    ).toBeEnabled();
    await expect(canvas.getByRole('radio', { name: '中文' })).toBeEnabled();
  },
};
// Error is a real signal rather than a loading state. Desktop-owned controls
// and independently loaded connections remain usable; unknown Host settings
// are not represented as a perpetual shimmer.
export const GeneralHostSettingsError: Story = {
  decorators: [withGeneralHostSettingsErrorBridge],
  render: () => <SettingsStory section="general" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const alert = await canvas.findByRole('alert');
    await expect(alert).toHaveTextContent('载入设置失败');
    await canvas.findByRole('button', { name: '重试' });
    await expect(
      canvas.getByRole('switch', { name: '完成时发送系统通知' }),
    ).toBeEnabled();
    await expect(canvas.getByRole('button', { name: '默认模型' })).toBeEnabled();
    await expect(canvas.queryByText('显示名称')).not.toBeInTheDocument();
    await expect(
      canvas.queryByRole('textbox', { name: '助手语气偏好' }),
    ).not.toBeInTheDocument();
  },
};
// An unavailable Host is not still loading: keep Client preferences usable,
// show one warning, and omit Host controls/placeholders until a target exists.
export const GeneralRuntimeHostUnavailable: Story = {
  decorators: [withGeneralUnavailableBridge],
  render: () => <SettingsStory section="general" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const alert = await canvas.findByRole('alert');
    await expect(alert).toHaveTextContent('Runtime Host');
    await expect(
      canvas.getByRole('switch', { name: '完成时发送系统通知' }),
    ).toBeEnabled();
    await expect(
      Array.from(canvasElement.querySelectorAll('[role="status"]')).some(
        (status) => status.textContent?.includes('正在加载设置') === true,
      ),
    ).toBe(false);
    await expect(canvas.queryByText('显示名称')).not.toBeInTheDocument();
    await expect(canvas.queryByText('默认模型')).not.toBeInTheDocument();
  },
};
// Mixed authority path: Runtime Host profile management remains available,
// while project-catalog reads and writes wait for this modal to confirm the
// cached selected Host.
export const ProjectsCachedHostRevalidation: Story = {
  decorators: [withProjectsCachedRevalidationBridge],
  render: () => (
    <SettingsStory
      section="projects"
      seedSnapshotCache={seedGeneralSnapshotCache}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('button', { name: '添加电脑' })).toBeEnabled();
    await waitForStoryCondition(
      () => canvasElement.querySelector(
        '.settingsRuntimeHostInteractionBoundary[inert][aria-busy="true"]',
      ) !== null,
      'Project Host interaction boundary did not remain inert',
    );
    const boundary = canvasElement.querySelector<HTMLElement>(
      '.settingsRuntimeHostInteractionBoundary[inert][aria-busy="true"]',
    );
    const mutedProjectContent = boundary?.firstElementChild;
    if (!(mutedProjectContent instanceof HTMLElement)) {
      throw new Error('Project Host interaction boundary did not contain visible content');
    }
    await expect(getComputedStyle(mutedProjectContent).opacity).toBe('0.5');
    await expect(cachedProjectsSnapshotRead).not.toHaveBeenCalled();
    await expect(canvas.queryByRole('alert')).not.toBeInTheDocument();
  },
};
// Real path: 设置 → 通用, after selecting Git Bash for the current Runtime Host.
export const GeneralGitBash: Story = {
  decorators: [withGitBashSettingsBridge],
  render: () => <SettingsStory section="general" />,
};
// Real path: 设置 → 外观.
export const Appearance: Story = {
  decorators: [withSettingsBridge],
  render: () => <SettingsStory section="appearance" />,
};
/** #1362: proxy + auth enabled so the full form-grid stack renders. */
// Real path: 设置 → 使用统计 → 供应商统计, before any usage has been recorded.
export const UsageEmpty: Story = {
  decorators: [withUsageEmptyBridge],
  render: () => <SettingsStory section="usage" />,
};
// Real path: 设置 → 使用统计 → 供应商统计, with traffic from one provider.
export const UsageSingleProvider: Story = {
  decorators: [withUsageSingleProviderBridge],
  render: () => <SettingsStory section="usage" />,
};
// Real path: 设置 → 使用统计 → 模型统计, with several model families to compare.
export const UsageMultiModel: Story = {
  decorators: [withUsageMultiModelBridge],
  render: () => <SettingsStory section="usage" />,
};
// Real path: 设置 → 使用统计 → 详情记录 on → 活动记录, with long model and tool names.
export const UsageLongTail: Story = {
  decorators: [withUsageLongTailBridge],
  render: () => <SettingsStory section="usage" />,
  play: async ({ canvasElement, globals }) => {
    const canvas = within(canvasElement);
    const usageCopy = getUsageSettingsCopy(globals.locale === 'en' ? 'en' : 'zh');
    expect(
      await canvas.findByText(usageCopy.totalRequests, {
        selector: '[data-slot="stat-tile-label"]',
      }),
    ).toBeInTheDocument();
    // Astryx `TabList` is a <nav> of <button> tabs — there is no ARIA `tab`
    // role, so query the tab by `button` (that is how @astryxdesign's own
    // TabList tests reach them). The tab also carries a count badge in its
    // `endContent`, which folds into the accessible name after the label
    // (e.g. '活动记录 5'), so match the label as a prefix rather than whole.
    expect(
      await canvas.findByRole('button', { name: new RegExp(`^${usageCopy.tabs[0]}`) }),
    ).toBeInTheDocument();
    await waitForStoryCondition(
      () => canvas.queryByRole('table', { name: usageCopy.tables.requestsAria }) !== null
        || canvas.queryByRole('button', { name: usageCopy.showDetails }) !== null,
      'Usage request details did not become available',
    );
    const showDetails = canvas.queryByRole('button', { name: usageCopy.showDetails });
    if (showDetails) await userEvent.click(showDetails);

    const table = await canvas.findByRole('table', { name: usageCopy.tables.requestsAria });
    const timeCell = table.querySelector<HTMLTableCellElement>('tbody tr td:first-child');
    expect(timeCell).not.toBeNull();
    const timeText = timeCell?.firstElementChild;
    expect(timeText).toBeInstanceOf(HTMLElement);
    const timeRange = document.createRange();
    timeRange.selectNodeContents(timeText!);
    const timeCellStyle = getComputedStyle(timeCell!);
    const requiredWidth = timeRange.getBoundingClientRect().width
      + Number.parseFloat(timeCellStyle.paddingLeft)
      + Number.parseFloat(timeCellStyle.paddingRight);
    expect(requiredWidth).toBeLessThanOrEqual(timeCell!.clientWidth);

    const longTarget = 'anthropic/claude-sonnet-4-5-20250929-preview-extended-thinking';
    const targetCellText = within(table).getByText(longTarget);
    await waitFor(() => expect(targetCellText).toHaveAttribute('title', longTarget));
    await userEvent.hover(targetCellText);
    await waitFor(() => {
      const tooltipId = targetCellText.getAttribute('aria-describedby');
      expect(tooltipId).toBeTruthy();
      const tooltip = document.getElementById(tooltipId!);
      expect(tooltip).toHaveAttribute('role', 'tooltip');
      expect(tooltip).toHaveTextContent(longTarget);
    });
    await userEvent.unhover(targetCellText);
  },
};
// Real path: the same long-content Usage page at the minimum supported window width.
export const UsageNarrow: Story = {
  ...UsageLongTail,
  parameters: { viewport: { defaultViewport: 'mobile2' } },
};

/** The persisted range lands with the async CLIENT settings load — usage
 * is client-owned (settings-ownership.ts), so getClient() is the channel
 * that carries it — after the section effect's first fetch already ran
 * with the '24h' default. A Settings window restored directly onto
 * 使用统计 must refetch when the persisted range arrives — without that,
 * the page shows the default range's (empty) numbers under the persisted
 * range's selected chip until a manual refresh. The bridge makes the race
 * explicit: stats exist only for the persisted 'all' range, and the
 * client settings resolve a beat late. */
const withUsagePersistedRangeBridge = (() => {
  const clientSettings = mergeSettings(createDefaultSettings(), { usage: { range: 'all' } });
  return withScopedMakaBridge({
    ...makaBridge,
    settings: {
      ...makaBridge.settings,
      getClient: async () => {
        await new Promise((resolve) => globalThis.setTimeout(resolve, 30));
        return clientSettings;
      },
      updateClient: async (
        patch: Parameters<typeof window.maka.settings.updateClient>[0],
      ): Promise<UpdateAppSettingsResult> => ({
        settings: mergeSettings(clientSettings, patch),
      }),
      usageStats: async (range?: UsageRange): Promise<UsageStats> =>
        range === 'all' ? usageStats : emptyUsageStats,
    },
  } satisfies Record<string, unknown>);
})();

// Real path: 设置 remembers 使用统计 as the last-open page and restores
// straight onto it, with 全部 as the persisted range.
export const UsagePersistedRangeRestore: Story = {
  decorators: [withUsagePersistedRangeBridge],
  render: () => <SettingsStory section="usage" />,
  play: async ({ canvasElement }) => {
    // The totals must come from the PERSISTED range's dataset, not the
    // '24h' default the section effect first fired with.
    await waitForStoryCondition(
      () => (canvasElement.textContent ?? '').includes('420'),
      'Usage totals for the persisted range did not render',
    );
  },
};
/**
 * #1364: entry list (long title / content / tag set), archived group, and
 * backup-candidate rows. The bridge used to lack the `memory` channel
 * entirely, so the page booted into error toasts instead of any state.
 */
// Real path: 设置 → 记忆, on a workspace with saved memories and backup candidates.
export const MemoryPopulated: Story = {
  decorators: [withMemoryPopulatedBridge],
  render: () => <SettingsStory section="memory" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const archiveButtons = await canvas.findAllByRole('button', { name: /^归档：/ });
    expect(archiveButtons).toHaveLength(2);
    for (const button of archiveButtons) {
      expect(button).toHaveTextContent(/^归档$/);
    }
    const restoreButton = await canvas.findByRole('button', { name: /^恢复：/ });
    expect(restoreButton).toHaveTextContent(/^恢复$/);
    expect(canvas.getByRole('group', {
      name: /^部署流程要走灰度队列.*手动记录.*记忆操作$/,
    })).toBeInTheDocument();

    const stableButton = archiveButtons.find((button) =>
      button.getAttribute('aria-label')?.includes('用户偏好中文回复'));
    const stableName = stableButton?.getAttribute('aria-label');
    expect(stableName).toBeTruthy();
    await userEvent.type(
      canvas.getByRole('textbox', { name: '筛选本地记忆' }),
      '用户偏好中文回复',
    );
    expect(await canvas.findByRole('button', { name: stableName! })).toHaveTextContent(/^归档$/);
  },
};
// Real path: 设置 → 联网搜索.
export const WebSearch: Story = {
  decorators: [withSettingsBridge],
  render: () => <SettingsStory section="search" />,
};
// Real path: same page when a bound channel needs attention — e.g. a WeChat session that
// has to be re-scanned.
export const BotChatNeedsAttention: Story = {
  decorators: [withBotAttentionBridge],
  render: () => <SettingsStory section="bot-chat" />,
};
// Real path: 设置 → 每日回顾.
export const DailyReview: Story = {
  decorators: [withSettingsBridge],
  render: () => <SettingsStory section="daily-review" />,
};

// Real path at a narrow desktop window.
// Real path: Settings → Daily Review at a narrow window.
export const DailyReviewNarrow: Story = {
  ...DailyReview,
  parameters: { viewport: { defaultViewport: 'mobile2' } },
};

// Real path with the Astryx model selector expanded.
// Real path: Settings → Daily Review → Analysis model.
export const DailyReviewModelSelectorOpen: Story = {
  decorators: [withSettingsBridge],
  render: () => <SettingsStory section="daily-review" />,
  play: async ({ canvasElement }) => {
    await openDailyReviewModelSelector(canvasElement);
  },
};

// Real path: 设置 → 数据.
export const Data: Story = {
  decorators: [withSettingsBridge],
  render: () => <SettingsStory section="data" />,
};
// Mixed authority path: local input-history and export-draft controls remain
// available, but operations that address the cached Host are disabled until
// the fresh catalog confirms that target.
export const DataCachedHostRevalidation: Story = {
  decorators: [withGeneralCachedRevalidationBridge],
  render: () => (
    <SettingsStory
      section="data"
      seedSnapshotCache={seedGeneralSnapshotCache}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('button', { name: '清空输入历史' })).toBeEnabled();
    await expect(canvas.getByRole('button', { name: '打开工作区文件夹' })).toBeDisabled();
    await expect(canvas.getByRole('button', { name: '复制路径' })).toBeDisabled();
    await expect(canvas.getByRole('button', { name: '导出配置…' })).toBeDisabled();
    await expect(canvas.getByRole('button', { name: '导入配置…' })).toBeDisabled();
    await expect(canvas.getByRole('switch', { name: '模型连接' })).toBeEnabled();
    await expect(
      canvas.getByRole('combobox', { name: '导入时同名连接的处理方式' }),
    ).toBeEnabled();
    await expect(canvas.queryByRole('alert')).not.toBeInTheDocument();
  },
};
// Runtime-Host-only pages share one mutation fence while a cached Host target
// is being confirmed. The wrapper is layout-transparent but interaction-inert.
export const ModelsCachedHostRevalidation: Story = {
  decorators: [withGeneralCachedRevalidationBridge],
  render: () => (
    <SettingsStory
      section="models"
      seedSnapshotCache={seedGeneralSnapshotCache}
    />
  ),
  play: async ({ canvasElement }) => {
    await waitForStoryCondition(
      () => canvasElement.querySelector('.settingsRuntimeHostInteractionBoundary') !== null,
      'Runtime Host interaction boundary did not render',
    );
    const boundary = canvasElement.querySelector<HTMLElement>(
      '.settingsRuntimeHostInteractionBoundary',
    );
    await expect(boundary).toHaveAttribute('inert');
    const mutedPage = boundary?.firstElementChild;
    if (!(mutedPage instanceof HTMLElement)) {
      throw new Error('Runtime Host interaction boundary did not contain a visible page');
    }
    await expect(Number.parseFloat(getComputedStyle(mutedPage).opacity)).toBeLessThan(1);
    await expect(within(canvasElement).queryByRole('alert')).not.toBeInTheDocument();
  },
};

// A same-key Host replacement can verify the profile catalog before its
// connection catalog has arrived. Keep the last-ready rows visible, but do not
// let Models make them writable until the new generation verifies connections.
export const ModelsConnectionsHostGenerationRevalidation: Story = {
  decorators: [withModelsConnectionsGenerationRevalidationBridge],
  render: () => {
    resetGenerationStoryBridge();
    return (
      <SettingsStory
        section="models"
        seedSnapshotCache={seedGeneralSnapshotCache}
      />
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const oldConnection = await canvas.findByText('Z.AI Live');
    const boundary = canvasElement.querySelector<HTMLElement>(
      '.settingsRuntimeHostInteractionBoundary',
    );
    if (!boundary) throw new Error('Runtime Host interaction boundary did not render');
    await waitForStoryCondition(
      () => !boundary.hasAttribute('inert'),
      'Initial Runtime Host generation did not become interactive',
    );

    generationStoryConnectionsPending = true;
    generationStoryRuntimeHostProfiles = runtimeHostProfilesWithRemote;
    const listener = generationStoryProfileListener;
    if (!listener) throw new Error('Runtime Host generation listener did not subscribe');
    listener({
      epoch: 'storybook-generation-2',
      profileId: 'local',
      profileName: 'Local',
      profileKind: 'local',
      profileAccess: 'owner',
      readiness: 'ready',
      hostId: 'storybook-local-host',
      isDefault: true,
    });

    await userEvent.click(await canvas.findByRole('combobox', { name: 'Runtime Host' }));
    await within(document.body).findByRole('option', { name: 'Remote' });
    await userEvent.keyboard('{Escape}');
    await expect(boundary).toHaveAttribute('inert');
    await expect(oldConnection).toBeInTheDocument();
    await expect(canvas.queryByRole('alert')).not.toBeInTheDocument();
  },
};

// A ready event can replace the Runtime Host without changing
// profileId:hostId. The catalog route stays mounted, but its OAuth account
// snapshot belongs to the Host generation and must be read again before the
// previous account can be presented as current.
export const ModelsOAuthHostGenerationRevalidation: Story = {
  decorators: [withModelsOAuthGenerationRevalidationBridge],
  render: () => {
    resetGenerationStoryBridge();
    return (
      <SettingsStory
        section="models"
        openProviderCatalog
        seedSnapshotCache={seedGeneralSnapshotCache}
      />
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText('old-generation@example.com');
    const readsBeforeReplacement = generationStoryCodexAccountReads;
    const listener = generationStoryProfileListener;
    if (!listener) throw new Error('Runtime Host generation listener did not subscribe');

    generationStoryCodexEmail = 'new-generation@example.com';
    listener({
      epoch: 'storybook-generation-2',
      profileId: 'local',
      profileName: 'Local',
      profileKind: 'local',
      profileAccess: 'owner',
      readiness: 'ready',
      hostId: 'storybook-local-host',
      isDefault: true,
    });

    await canvas.findByText('new-generation@example.com');
    await expect(canvas.queryByText('old-generation@example.com')).not.toBeInTheDocument();
    await expect(generationStoryCodexAccountReads).toBeGreaterThan(readsBeforeReplacement);
    await expect(
      canvasElement.querySelector('[data-maka-contract="provider-catalog"]'),
    ).toBeInTheDocument();
  },
};

// Browser authorization is an active Host-owned controller, not durable
// Settings route state. Replacing a same-key Host cancels the old generation's
// request while leaving the user on the same provider setup route.
export const ModelsOAuthAuthorizationHostGenerationRevalidation: Story = {
  decorators: [withModelsOAuthAuthorizationGenerationBridge],
  render: () => {
    resetGenerationStoryBridge();
    return (
      <SettingsStory
        section="models"
        openProviderCatalog
        seedSnapshotCache={seedGeneralSnapshotCache}
      />
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', {
      name: /打开 OAuth 登录：OpenAI Codex/,
    }));
    await userEvent.click(await canvas.findByRole('button', { name: '登录 Codex' }));
    await waitForStoryCondition(
      () => generationStoryOpenedAuthIds.includes('authorization-from-generation-1'),
      'OAuth authorization did not reach the browser handoff',
    );
    const listener = generationStoryProfileListener;
    if (!listener) throw new Error('Runtime Host generation listener did not subscribe');

    listener({
      epoch: 'storybook-generation-2',
      profileId: 'local',
      profileName: 'Local',
      profileKind: 'local',
      profileAccess: 'owner',
      readiness: 'ready',
      hostId: 'storybook-local-host',
      isDefault: true,
    });

    await waitForStoryCondition(
      () => generationStoryCancelledAuthIds.includes('authorization-from-generation-1'),
      'Previous Runtime Host generation authorization was not cancelled',
    );
    await expect(
      canvasElement.querySelector('[data-maka-contract="provider-setup"]'),
    ).toBeInTheDocument();
    await expect(await canvas.findByRole('button', { name: '登录 Codex' })).toBeEnabled();
    await expect(generationStoryCancelledAuthIds).toEqual([
      'authorization-from-generation-1',
    ]);
  },
};

// The connection-detail Copilot import owns an action guard and a late
// success callback independently of the catalog login panel. A same-key Host
// replacement retires that controller without throwing away the detail route
// or its surrounding Settings state.
export const ModelsCopilotReimportHostGenerationRevalidation: Story = {
  decorators: [withModelsCopilotReimportGenerationBridge],
  render: () => {
    resetGenerationStoryBridge();
    return (
      <SettingsStory
        section="models"
        initialConnectionSlug="github-copilot-generation"
        seedSnapshotCache={seedCopilotGenerationSnapshotCache}
      />
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const firstImport = await canvas.findByRole('button', { name: '重新导入' });
    await userEvent.click(firstImport);
    await waitForStoryCondition(
      () => generationStoryCopilotImportAttempts === 1,
      'GitHub Copilot reimport did not start',
    );

    const listener = generationStoryProfileListener;
    if (!listener) throw new Error('Runtime Host generation listener did not subscribe');
    listener({
      epoch: 'storybook-generation-2',
      profileId: 'local',
      profileName: 'Local',
      profileKind: 'local',
      profileAccess: 'owner',
      readiness: 'ready',
      hostId: 'storybook-local-host',
      isDefault: true,
    });

    await waitForStoryCondition(
      () => canvas.queryByRole('button', { name: '重新导入' })?.hasAttribute('disabled') === false,
      'Replacement Host kept the previous generation import guard',
    );
    const readsAfterReplacement = generationStoryCopilotSecretReads;
    generationStoryCopilotImportResolve?.({ ok: true });
    await new Promise((resolve) => globalThis.setTimeout(resolve, 50));
    await expect(generationStoryCopilotSecretReads).toBe(readsAfterReplacement);

    await userEvent.click(canvas.getByRole('button', { name: '重新导入' }));
    await waitForStoryCondition(
      () => generationStoryCopilotImportAttempts === 2,
      'Replacement Host could not start a fresh GitHub Copilot reimport',
    );
    await waitForStoryCondition(
      () => generationStoryCopilotSecretReads > readsAfterReplacement,
      'Replacement Host reimport did not refresh the current credential state',
    );
    await expect(
      canvasElement.querySelector('[data-maka-contract="connection-detail"]'),
    ).toBeInTheDocument();
  },
};

// Warm cache makes SettingsSurface ready before ProvidersPanel finishes its
// own connection read. The catalog landing intent belongs to the child and is
// retired only after that child has actually entered the catalog route.
export const ModelsCatalogIntentDuringWarmRevalidation: Story = {
  decorators: [withProviderCatalogIntentRevalidationBridge],
  render: () => (
    <SettingsStory
      section="models"
      openProviderCatalog
      seedSnapshotCache={seedGeneralSnapshotCache}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitForStoryCondition(
      () => canvasElement.querySelector('[data-maka-contract="provider-catalog"]') !== null,
      'Provider catalog intent was retired before ProvidersPanel consumed it',
    );

    await userEvent.click(canvas.getByRole('button', { name: /^外观$/ }));
    await userEvent.click(canvas.getByRole('button', { name: /^模型$/ }));
    await waitForStoryCondition(
      () => canvasElement.querySelector(
        '[data-maka-contract="providers-panel"]:not([aria-busy="true"])',
      ) !== null,
      'ProvidersPanel did not finish loading after remount',
    );
    await expect(
      canvasElement.querySelector('[data-maka-contract="provider-catalog"]'),
    ).not.toBeInTheDocument();
    await expect(
      canvasElement.querySelector('button[data-maka-contract="add-connection"]'),
    ).toBeInTheDocument();
  },
};
/**
 * The expanded state, not the collapsed one the page opens in: the capability layers grid
 * and the guidance block are hidden until diagnostics are expanded, so the collapsed story
 * gives those layouts no baseline at all — which is exactly where the remaining overflow
 * was hiding. Everything the collapsed story shows is still on screen here.
 *
 * The disclosure is per-row now (a CollapsibleGroup, one open at a time) rather than one
 * page-level 展开详情 button, so the story opens the first capability instead.
 */
// Real path: 设置 → 权限与能力 → 展开某个能力行.
export const PermissionCenterDiagnosticsExpanded: Story = {
  decorators: [withSettingsBridge],
  render: () => <SettingsStory section="permissions" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const grantedFilter = await canvas.findByRole('button', { name: /^仅显示已授权权限/ });
    expect(grantedFilter).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(grantedFilter);
    await waitFor(() => {
      expect(grantedFilter).toHaveAttribute('aria-pressed', 'true');
      expect(canvasElement.querySelectorAll('[data-permission-id]')).toHaveLength(2);
      expect(canvasElement.querySelector('[data-permission-id="screen_recording"]')).not.toBeInTheDocument();
    });
    await userEvent.click(grantedFilter);
    await waitFor(() => {
      expect(grantedFilter).toHaveAttribute('aria-pressed', 'false');
      expect(canvasElement.querySelectorAll('[data-permission-id]')).toHaveLength(4);
    });

    // Scoped through `data-readiness` — the capability rows' own attribute — so
    // the story cannot latch onto some other expandable button on the page.
    const trigger = await waitForStoryButton(
      canvasElement,
      (candidate) =>
        candidate.getAttribute('aria-expanded') === 'false' &&
        candidate.closest('[data-readiness]') !== null,
    );
    trigger.click();
    await waitForStoryCondition(
      () =>
        canvasElement.querySelector('[data-readiness] button[aria-expanded="true"]') !== null,
      'Permission Center story did not expand a capability row',
    );
  },
};
// Real path: 设置 → 健康 (also reachable from the topbar health action), with probes
// reporting.
export const HealthCenter: Story = {
  decorators: [withSettingsBridge],
  render: () => <SettingsStory section="health" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const errorFilter = await canvas.findByRole('button', { name: /^仅显示错误健康信号/ });
    expect(errorFilter).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(errorFilter);
    await waitFor(() => {
      expect(errorFilter).toHaveAttribute('aria-pressed', 'true');
      expect(canvas.getByText('OpenAI Review')).toBeInTheDocument();
      expect(canvas.queryByText('Z.AI Live')).not.toBeInTheDocument();
      expect(canvas.getByText('全部健康信号中，1/6 条会阻塞发送')).toBeInTheDocument();
      expect(canvas.getByText('全部健康信号中，1/6 条会阻塞能力')).toBeInTheDocument();
    });
    await userEvent.click(errorFilter);
    await waitFor(() => {
      expect(errorFilter).toHaveAttribute('aria-pressed', 'false');
      expect(canvas.getByText('Z.AI Live')).toBeInTheDocument();
    });
  },
};
// Real path: 设置 → 关于 (also reachable from 反馈 in the topbar).
export const About: Story = {
  decorators: [withSettingsBridge],
  render: () => <SettingsStory section="about" />,
};

// Real path: 设置 → 已归档任务, after archiving tasks from the rail's row menu.
export const ArchivedTasks: Story = {
  decorators: [withSettingsBridge],
  render: () => (
    <SettingsStory section="archived-tasks" archivedTaskSessions={archivedTaskSessions} />
  ),
};

// Real path: 设置 → 导入任务 on a machine that has Codex installed.
export const ImportTasks: Story = {
  decorators: [withSettingsBridge],
  render: () => <SettingsStory section="import-tasks" />,
};

// Real path: 设置 → 导入任务 → type into 搜索. The catalog pages 16 at a time
// over a source that can hold a thousand sessions, so the term is the only way
// to reach one by name. Typing here proves the box reaches the query rather
// than filtering the page already on screen.
export const ImportTasksSearch: Story = {
  decorators: [withSettingsBridge],
  render: () => <SettingsStory section="import-tasks" />,
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    const search = await body.findByRole('textbox', { name: '搜索' });
    // `worktree` appears in exactly one fixture title, so a working search
    // narrows three rows to one. Filtering the assembled page would too — the
    // difference is that this term reaches the query, which is what the
    // stub asserts by honouring it.
    await userEvent.type(search, 'worktree');
    // Debounced, so the list settles a moment after the last keystroke.
    await waitFor(async () => {
      const rows = body.queryAllByRole('listitem');
      await expect(rows).toHaveLength(1);
    });
    await expect(
      await body.findByText('Trace the flaky worktree teardown in CI'),
    ).toBeInTheDocument();
  },
};

function importOutcomeRecoveryBridge(): Record<string, unknown> {
  let importAttempted = false;
  const source = externalConversations[2];
  return {
    ...makaBridge,
    externalSessions: {
      ...makaBridge.externalSessions,
      list: async () => ({
        sessions: [
          importAttempted
            ? {
                ...source,
                importState: {
                  importedCount: 1,
                  importedSessionIds: ['outcome-recovered-task'],
                  isImporting: false,
                },
              }
            : source,
        ],
        nextCursor: null,
      }),
      import: async () => {
        importAttempted = true;
        return { ok: false as const, reason: 'commit_outcome_unknown' as const };
      },
    },
  };
}

// The import response is deliberately unknown; the next authoritative catalog
// read proves that the task landed and turns the banner into a usable entry.
// Real path: 设置 → 导入任务 → 导入, when Main reports an unknown commit outcome that catalog recovery confirms.
export const ImportTasksOutcomeUnknownRecovered: Story = {
  decorators: [withScopedMakaBridge(importOutcomeRecoveryBridge())],
  render: () => <SettingsStory section="import-tasks" />,
  play: async ({ canvasElement }) => {
    const importButton = await waitForStoryButton(canvasElement, (candidate) =>
      ['导入', 'Import'].includes(candidate.textContent?.trim() ?? ''),
    );
    await userEvent.click(importButton);
    await waitForStoryCondition(
      () =>
        canvasElement.textContent?.includes('已确认导入') === true ||
        canvasElement.textContent?.includes('Import confirmed') === true,
      'Unknown-outcome recovery did not expose the imported task',
    );
  },
};

// Real path: the same page on a machine with no supported agent — the common
// case, and the one where the source switch and the filter would be chrome
// around nothing.
export const ImportTasksNoSource: Story = {
  decorators: [withScopedMakaBridge({
    ...makaBridge,
    externalSessions: {
      ...makaBridge.externalSessions,
      listSources: async () => ({ adapterIds: [] }),
    },
  })],
  render: () => <SettingsStory section="import-tasks" />,
};
