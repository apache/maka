import { useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { ToastProvider } from '@maka/ui';
import type {
  AppSettings,
  CapabilitySnapshot,
  CapabilitySnapshotCollection,
  HealthSignal,
  HealthSnapshot,
  LlmConnection,
  LocalMemoryBackupInfo,
  LocalMemoryEntryPreview,
  LocalMemoryState,
  OsPermissionSnapshot,
  OsPermissionState,
  PermissionSnapshot,
  ProviderType,
  SettingsSection,
  ThemePalette,
  ThemePreference,
  UpdateAppSettingsResult,
  UsageStats,
} from '@maka/core';
import {
  buildHealthSnapshot,
  createDefaultSettings,
  DEFAULT_DAILY_REVIEW_CONFIG,
  mergeSettings,
} from '@maka/core';
import { SettingsSurface } from '../../src/renderer/settings/settings-surface';
import { createUiLocaleUpdateGate } from '../../src/renderer/settings/ui-locale-update-gate';
import type { ConnectionsBridge } from '../../src/renderer/settings/ProvidersPanel';
import { withScopedMakaBridge } from '../maka-bridge';
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
}): LlmConnection {
  return {
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

const connections: LlmConnection[] = [
  makeConnection({ slug: 'zai-live', name: 'Z.AI Live', providerType: 'zai-coding-plan' }),
  makeConnection({ slug: 'openai-review', name: 'OpenAI Review', providerType: 'openai' }),
  makeConnection({ slug: 'ollama-local', name: 'Ollama Local', providerType: 'ollama' }),
];

const connectionsBridge: ConnectionsBridge = {
  async list() {
    return connections;
  },
  async getDefault() {
    return 'zai-live';
  },
  async setDefault() {
    /* noop */
  },
  async create(next) {
    return makeConnection({ slug: next.slug, name: next.name, providerType: next.providerType });
  },
  async update(slug, patch) {
    const current = connections.find((c) => c.slug === slug)!;
    return { ...current, ...patch, updatedAt: NOW };
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
  status?: 'success' | 'error';
  minutesAgo: number;
}): UsageStats['logs'][number] {
  return {
    id: input.id,
    ts: NOW - input.minutesAgo * 60_000,
    kind: input.kind,
    sessionId: `b0efaaf9-9e58-46c1-bfea-${input.id.padStart(12, '0')}`,
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
    minutesAgo: 4,
  }),
  makeUsageLog({
    id: '2',
    kind: 'tool',
    model: 'glm-4.7',
    toolName: 'mcp__cloud_workspace__list_repository_branch_protection_rules',
    minutesAgo: 9,
  }),
  makeUsageLog({ id: '3', kind: 'model', model: 'glm-4.7', status: 'error', minutesAgo: 16 }),
  makeUsageLog({ id: '4', kind: 'tool', model: 'glm-4.7', toolName: 'Bash', minutesAgo: 25 }),
];

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
    workspaceInstructions: {
      getState: async () => ({
        files: [
          { file: 'AGENTS.md', status: 'available', chars: 1_820, truncated: false },
          { file: 'CLAUDE.md', status: 'missing', chars: 0, truncated: false },
        ],
        detectedCount: 1,
        fileCharLimit: 20_000,
        promptCharLimit: 8_000,
      }),
      openFile: async () => ({ ok: true as const }),
      createFile: async () => ({ ok: true as const }),
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
    microphone: makeOsPermission({
      id: 'microphone',
      status: 'denied',
      reason: '用户在系统设置里拒绝了麦克风访问，语音输入与录音自检都会直接失败。',
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
        reason: 'cua-driver 未响应握手，已回落到只读观察模式。',
      },
      osPermissions: [
        { id: 'accessibility', required: true, status: 'granted' },
        { id: 'screen_recording', required: true, status: 'not_determined' },
      ],
      actionApproval: { state: 'required_per_action', source: 'capability_policy' },
      guidance: ['前往系统设置授予屏幕录制权限后重新探测。'],
    }),
    makeCapability({
      id: 'voice',
      label: '语音输入',
      readiness: 'denied',
      feature: { state: 'enabled', source: 'settings' },
      osPermissions: [{ id: 'microphone', required: true, status: 'denied' }],
      runtimeProbe: { state: 'not_run', source: 'runtime_probe' },
      guidance: ['麦克风权限已被拒绝，需要在系统设置中重新开启。'],
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
    id: 'perm:microphone',
    label: '麦克风权限',
    scope: 'capability',
    layer: 'permission',
    status: 'warning',
    source: 'permission_snapshot',
    checkedAt: NOW - 30_000,
    message: '麦克风权限已被拒绝。',
    relatedCapabilityId: 'voice',
    blocksCapability: true,
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
    id: 'probe:cua-driver',
    label: 'cua-driver 运行态探测',
    scope: 'capability',
    layer: 'runtime_probe',
    status: 'warning',
    source: 'runtime_probe',
    checkedAt: NOW - 5 * 60_000,
    message: '探测超时，已回落到只读观察模式。',
    detail: 'cua-driver 未在 3000ms 内完成握手；下一次探测会在功能被调用时自动触发。',
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

const makaBridge = {
  settings: {
    get: async () => createDefaultSettings(),
    update: async (patch: Parameters<typeof window.maka.settings.update>[0]): Promise<UpdateAppSettingsResult> => {
      return { settings: mergeSettings(createDefaultSettings(), patch) };
    },
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
  claudeSubscription: {
    isExperimentalEnabled: async () => true,
    getAccountState: async () => ({
      runtimeState: 'authenticated',
      profile: { email: 'claude@example.com' },
    }),
  },
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
} satisfies Record<string, unknown>;

const withSettingsBridge = withScopedMakaBridge(makaBridge);

// #1364: list-page variants — empty vs populated vs long-content, per the
// tracking issue's expected deliverables.

const withMemoryPopulatedBridge = withScopedMakaBridge({
  ...makaBridge,
  ...makeMemoryBridgeChannels(populatedMemoryState),
} satisfies Record<string, unknown>);

/** Requests tab visible with the hostile-width logs (see `usageLogs`). */
const usagePopulatedSettings = mergeSettings(createDefaultSettings(), {
  usage: { showDetails: true, activeTab: 'requests' },
});

const withUsagePopulatedBridge = withScopedMakaBridge({
  ...makaBridge,
  settings: {
    ...makaBridge.settings,
    get: async () => usagePopulatedSettings,
    update: async (
      patch: Parameters<typeof window.maka.settings.update>[0],
    ): Promise<UpdateAppSettingsResult> => ({
      settings: mergeSettings(usagePopulatedSettings, patch),
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

function SettingsStory(props: {
  section: SettingsSection;
  connections?: LlmConnection[];
  defaultSlug?: string | null;
}) {
  const initialFocusRef = useRef<HTMLButtonElement>(null);
  const [uiLocaleUpdateGate] = useState(createUiLocaleUpdateGate);

  return (
    <ToastProvider>
      <div
        data-maka-e2e-fixture="true"
        style={{
          background: 'var(--surface-canvas)',
          height: '100%',
          minHeight: 640,
        }}
      >
        <SettingsSurface
          connections={props.connections ?? connections}
          defaultSlug={props.defaultSlug === undefined ? 'zai-live' : props.defaultSlug}
          onRefresh={async () => undefined}
          onClose={noop}
          themePref={'auto' as ThemePreference}
          onThemeChange={noop}
          themePalette={'default' as ThemePalette}
          onThemePaletteChange={noop}
          onUiLocalePreferenceChange={noop}
          uiLocaleUpdateGate={uiLocaleUpdateGate}
          requestedSection={props.section}
          initialFocusRef={initialFocusRef}
          onOpenDailyReview={noop}
          onOpenSession={noop}
        />
      </div>
    </ToastProvider>
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

// Real path: sidebar footer 设置 → 模型.
export const Models: Story = {
  decorators: [withSettingsBridge],
  render: () => <SettingsStory section="models" />,
};
// Real path: 设置 → 通用.
export const General: Story = {
  decorators: [withSettingsBridge],
  render: () => <SettingsStory section="general" />,
};
// Real path: 设置 → 外观.
export const Appearance: Story = {
  decorators: [withSettingsBridge],
  render: () => <SettingsStory section="appearance" />,
};
/** #1362: proxy + auth enabled so the full form-grid stack renders. */
/**
 * #1364: the requests Astryx Table with hostile-width content (dated preview
 * model ids, namespaced MCP tool names). No story rendered a table at
 * all before this — `logs` was `[]` and the requests tab defaulted to its
 * summary-only Banner.
 */
// Real path: 设置 → 使用统计 → 详情记录 on → 请求日志, with recorded traffic.
export const UsageRequestsPopulated: Story = {
  decorators: [withUsagePopulatedBridge],
  render: () => <SettingsStory section="usage" />,
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
};
// Real path: 设置 → 联网搜索.
export const WebSearch: Story = {
  decorators: [withSettingsBridge],
  render: () => <SettingsStory section="search" />,
};
// Real path: 设置 → 语音.
export const Voice: Story = {
  decorators: [withSettingsBridge],
  render: () => <SettingsStory section="voice" />,
};
/**
 * The idle story above cannot show the page's only error surface. `permissionSnapshot`
 * already reports microphone `denied` on darwin, and `runCaptureSmoke` returns on that
 * snapshot before it ever reaches `getUserMedia` — so the real path gets here with no
 * MediaRecorder mock at all, which is why the old decorator-driven story was both
 * heavier and wrong.
 */
// Real path: 设置 → 语音 → 运行录音自检, when macOS has denied microphone access.
export const VoicePermissionDenied: Story = {
  decorators: [withSettingsBridge],
  render: () => <SettingsStory section="voice" />,
  play: async ({ canvasElement }) => {
    const button = await waitForStoryButton(
      canvasElement,
      (candidate) => candidate.textContent?.includes('运行录音自检') === true,
    );
    button.click();
    // The page renders several `[role="status"]` regions and the capture result
    // is not the first one, so this must scan them all — taking `querySelector`
    // here is what left the previous voice stories asserting against an empty
    // node and passing on a state they never reached.
    await waitForStoryCondition(
      () =>
        Array.from(canvasElement.querySelectorAll<HTMLElement>('[role="status"]')).some(
          (region) => region.textContent?.includes('麦克风权限被拒绝') === true,
        ),
      'Voice story did not reach the denied state',
    );
  },
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
// Real path: 设置 → 数据.
export const Data: Story = {
  decorators: [withSettingsBridge],
  render: () => <SettingsStory section="data" />,
};
/**
 * The expanded state, not the collapsed one the page opens in: the capability layers grid
 * and the guidance block are hidden until diagnostics are expanded, so the collapsed story
 * gives those layouts no baseline at all — which is exactly where the remaining overflow
 * was hiding. Everything the collapsed story shows is still on screen here.
 */
// Real path: 设置 → 权限与能力 → 展开详情.
export const PermissionCenterDiagnosticsExpanded: Story = {
  decorators: [withSettingsBridge],
  render: () => <SettingsStory section="permissions" />,
  play: async ({ canvasElement }) => {
    const toggle = await waitForStoryButton(
      canvasElement,
      (candidate) => candidate.textContent?.includes('展开详情') === true,
    );
    toggle.click();
    await waitForStoryCondition(
      () =>
        canvasElement
          .querySelector('.settingsCapabilityList')
          ?.getAttribute('data-diagnostics-open') === 'true',
      'Permission Center story did not expand the capability diagnostics',
    );
  },
};
// Real path: 设置 → 健康 (also reachable from the topbar health action), with probes
// reporting.
export const HealthCenter: Story = {
  decorators: [withSettingsBridge],
  render: () => <SettingsStory section="health" />,
};
// Real path: 设置 → 关于 (also reachable from 反馈 in the topbar).
export const About: Story = {
  decorators: [withSettingsBridge],
  render: () => <SettingsStory section="about" />,
};
