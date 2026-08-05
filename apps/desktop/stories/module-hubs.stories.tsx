import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent } from 'storybook/test';
import type { DailyReviewArchive, DailyReviewSummary, PlanReminder } from '@maka/core';
import type { McpConfigFile, McpServerStatus } from '@maka/core/mcp';
import {
  AutomationsPage,
  DailyReviewPage,
  formatDailyReviewArchiveTitle,
  getDailyReviewCopy,
  getSharedUiCopy,
  ModuleHubSelector,
  SkillsPage,
  type ManagedSkillUpdatePreview,
  type SkillEntry,
  ToastProvider,
  useUiLocale,
} from '@maka/ui';
import { type ComponentProps, type ReactNode, useState } from 'react';
import { AppShellWorkspaceTopActions } from '../src/renderer/app-shell-chrome-actions';
import { AppShellDetailPanel } from '../src/renderer/app-shell-detail-panel';
import { McpPage } from '../src/renderer/mcp-page';
import { withScopedMakaBridge } from './maka-bridge';

// Fidelity convention (#1433): every story below names the real app path
// that reaches it. See apps/desktop/stories/FIDELITY.md.

const meta = {
  title: 'Product/Module Hubs',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const NOW = Date.UTC(2026, 6, 1, 9, 30);
const PLAN_NOW = Date.now();
const noop = () => {};
const CONFIGURED_CRON_LAST_RUN = {
  id: 'run-1',
  at: PLAN_NOW - 86_400_000,
  status: 'triggered',
  message: '已生成进度摘要。',
} as const;
const CONFIGURED_COMPLETED_LAST_RUN = {
  id: 'run-done',
  at: PLAN_NOW - 2 * 86_400_000,
  status: 'triggered',
  message: '已发送。',
} as const;

const INSTALLED_SKILLS: SkillEntry[] = [
  {
    ref: 'workspace:maka:skill-git-flow',
    id: 'skill-git-flow',
    name: 'git-flow',
    description: '封装分支创建、合并与发布打 tag 的常用 git 操作。',
    path: '~/.maka/skills/git-flow',
    declaredTools: ['Bash', 'Write'],
    sourceType: 'workspace',
    scope: 'workspace',
    contextStatus: 'advertised',
    manageable: true,
    enabled: true,
    runtimeStatus: 'enabled',
  },
  {
    ref: 'user:agents:skill-docs-screenshot',
    id: 'skill-docs-screenshot',
    name: 'docs-screenshot',
    description: '把组件截图同步进设计文档，按 token 分类命名。',
    path: '~/.maka/skills/docs-screenshot',
    declaredTools: ['Bash', 'Read'],
    sourceType: 'workspace',
    scope: 'user',
    contextStatus: 'disabled',
    manageable: true,
    enabled: false,
    runtimeStatus: 'disabled',
  },
  {
    ref: 'project:maka:skill-release-notes',
    id: 'skill-release-notes',
    name: 'release-notes',
    description: '从最近的 commit 历史生成发布说明草稿。',
    path: '~/.maka/skills/release-notes',
    declaredTools: ['Bash'],
    sourceType: 'bundled',
    scope: 'project',
    contextStatus: 'advertised',
    manageable: false,
    enabled: true,
    runtimeStatus: 'enabled',
  },
];

const UPDATE_AVAILABLE_SKILLS: SkillEntry[] = [
  {
    ref: 'workspace:maka:release-checklist',
    id: 'release-checklist',
    name: 'release-checklist',
    description: '发布前检查版本、测试证据和变更说明。',
    path: '~/.maka/skills/release-checklist',
    declaredTools: ['Bash', 'Read'],
    sourceType: 'managed',
    managedUpdateStatus: 'update_available',
    scope: 'workspace',
    contextStatus: 'advertised',
    manageable: true,
    enabled: true,
    runtimeStatus: 'enabled',
  },
];

const UPDATE_AVAILABLE_PREVIEW: ManagedSkillUpdatePreview = {
  skill: {
    id: 'release-checklist',
    name: 'release-checklist',
    description: '发布前检查版本、测试证据和变更说明。',
    path: '~/.maka/skills/release-checklist/SKILL.md',
    declaredTools: ['Bash', 'Read'],
    sourceType: 'managed',
    userModified: false,
    validationStatus: 'ok',
    enabled: true,
    runtimeStatus: 'enabled',
    validationCodes: [],
    validationMessages: [],
    managedSourceId: 'release-checklist-source',
    managedUpdateStatus: 'update_available',
    hasManagedBaseline: true,
  },
  currentContent: '# Release checklist\n\nRun the release tests.',
  sourceContent: '# Release checklist\n\nRun tests and attach the release evidence.',
  baselineContent: '# Release checklist\n\nRun the release tests.',
  expectedCurrentSha256: 'current-story-sha256',
  expectedSourceSha256: 'source-story-sha256',
  summary: {
    currentLineCount: 3,
    sourceLineCount: 3,
    changedLineCount: 1,
  },
};

const DISABLED_SKILLS: SkillEntry[] = [
  {
    ref: 'workspace:maka:spreadsheet-audit',
    id: 'spreadsheet-audit',
    name: 'spreadsheet-audit',
    description: '检查工作簿中的公式、格式和异常值。',
    path: '~/.maka/skills/spreadsheet-audit',
    declaredTools: ['Read'],
    sourceType: 'bundled',
    scope: 'workspace',
    contextStatus: 'disabled',
    manageable: true,
    enabled: false,
    runtimeStatus: 'disabled',
  },
];

// Enough installed Skills that the list genuinely scrolls at the story's
// viewport — the #2236 regression surface (the view switch scrolling away
// with the list) only exists when the list is taller than its container.
const LONG_LIST_SKILLS: SkillEntry[] = Array.from({ length: 40 }, (_, index) => ({
  ref: `workspace:maka:skill-long-${index}`,
  id: `skill-long-${index}`,
  name: `long-list-skill-${index}`,
  description: '长列表占位技能，用于滚动契约。',
  path: `~/.maka/skills/skill-long-${index}`,
  declaredTools: ['Bash'],
  sourceType: 'workspace',
  scope: 'workspace',
  contextStatus: 'advertised',
  manageable: true,
  enabled: true,
  runtimeStatus: 'enabled',
}));

const BUNDLED_SKILLS: NonNullable<ComponentProps<typeof SkillsPage>['bundledSkillCatalog']> = [
  {
    id: 'document-review',
    name: 'Document review',
    description: 'Review and refine documents before sharing.',
    category: '文档与写作',
    declaredTools: ['Read', 'Write'],
    installed: false,
  },
  {
    id: 'image-workbench',
    name: 'Image workbench',
    description: 'Generate and edit visual assets.',
    category: '设计与UI',
    declaredTools: ['Read', 'Write'],
    installed: true,
  },
];

const CONFIGURED_REMINDERS: PlanReminder[] = [
  {
    id: 'plan-weekly',
    title: '每周发布风险复盘',
    note: '聚合本周未解决的发布风险项。',
    schedule: { kind: 'recurring', startAt: PLAN_NOW - 7 * 86_400_000, recurrence: 'weekly' },
    delivery: { channel: 'local' },
    status: 'scheduled',
    enabled: true,
    createdAt: PLAN_NOW - 14 * 86_400_000,
    updatedAt: PLAN_NOW - 2 * 86_400_000,
    nextRunAt: PLAN_NOW + 2 * 86_400_000,
    runs: [],
    runCount: 0,
  },
  {
    id: 'plan-cron',
    title: '工作日早 9 点同步进度',
    note: '',
    schedule: { kind: 'cron', startAt: PLAN_NOW - 30 * 86_400_000, expression: '0 9 * * 1-5' },
    delivery: { channel: 'local' },
    status: 'scheduled',
    enabled: true,
    createdAt: PLAN_NOW - 30 * 86_400_000,
    updatedAt: PLAN_NOW - 30 * 86_400_000,
    nextRunAt: PLAN_NOW + 18 * 3_600_000,
    lastRun: CONFIGURED_CRON_LAST_RUN,
    runs: [CONFIGURED_CRON_LAST_RUN],
    runCount: 1,
  },
  {
    id: 'plan-paused',
    title: '一次性补一次截图基线',
    note: '发布前再补一轮稳定基线。',
    schedule: { kind: 'once', runAt: PLAN_NOW + 3 * 86_400_000 },
    delivery: { channel: 'local' },
    status: 'paused',
    enabled: false,
    createdAt: PLAN_NOW - 5 * 86_400_000,
    updatedAt: PLAN_NOW - 86_400_000,
    runs: [],
    runCount: 0,
  },
  {
    id: 'plan-completed',
    title: '发布日提醒',
    note: '',
    schedule: { kind: 'once', runAt: PLAN_NOW - 2 * 86_400_000 },
    delivery: { channel: 'local' },
    status: 'completed',
    enabled: false,
    createdAt: PLAN_NOW - 10 * 86_400_000,
    updatedAt: PLAN_NOW - 2 * 86_400_000,
    lastRun: CONFIGURED_COMPLETED_LAST_RUN,
    runs: [CONFIGURED_COMPLETED_LAST_RUN],
    runCount: 1,
  },
  // The blocked row rides along with the healthy ones rather than in a story of
  // its own: a page whose whole job is scanning a list is only honest about the
  // attention state when that state has neighbours to stand out from. Same
  // reason ExtensionsMcpConfigured shows one healthy and one failed server.
  {
    id: 'plan-delivery-blocked',
    title: '发送每日客户反馈摘要',
    note: '汇总过去 24 小时的反馈并投递到项目群。',
    schedule: { kind: 'cron', startAt: PLAN_NOW - 30 * 86_400_000, expression: '0 18 * * 1-5' },
    delivery: { channel: 'bot', platform: 'telegram', chatId: 'project-room' },
    status: 'scheduled',
    enabled: true,
    createdAt: PLAN_NOW - 30 * 86_400_000,
    updatedAt: PLAN_NOW - 60 * 60_000,
    nextRunAt: PLAN_NOW + 8 * 60 * 60_000,
    lastRun: {
      id: 'run-blocked',
      at: PLAN_NOW - 60 * 60_000,
      status: 'blocked',
      message: 'Telegram 投递不可用：机器人已被移出目标群聊。',
      blockReason: 'bot_delivery_unavailable',
    },
    runs: [
      {
        id: 'run-blocked',
        at: PLAN_NOW - 60 * 60_000,
        status: 'blocked',
        message: 'Telegram 投递不可用：机器人已被移出目标群聊。',
        blockReason: 'bot_delivery_unavailable',
      },
    ],
    runCount: 12,
  },
  // Eighth reminder: the list's own control bar (search / sort / filter) only
  // appears at eight, so without this row the story could never show it — and
  // the controls are the widest thing the page's header carries.
  {
    id: 'plan-monthly-audit',
    title: '每月依赖许可证审计',
    note: '核对新引入依赖的许可证与来源。',
    schedule: { kind: 'recurring', startAt: PLAN_NOW - 40 * 86_400_000, recurrence: 'monthly' },
    delivery: { channel: 'local' },
    status: 'scheduled',
    enabled: true,
    createdAt: PLAN_NOW - 40 * 86_400_000,
    updatedAt: PLAN_NOW - 9 * 86_400_000,
    nextRunAt: PLAN_NOW + 6 * 86_400_000,
    runs: [],
    runCount: 0,
  },
  {
    id: 'plan-standup',
    title: '每日站会前汇总阻塞项',
    note: '',
    schedule: { kind: 'cron', startAt: PLAN_NOW - 20 * 86_400_000, expression: '30 9 * * 1-5' },
    delivery: { channel: 'local' },
    status: 'scheduled',
    enabled: true,
    createdAt: PLAN_NOW - 20 * 86_400_000,
    updatedAt: PLAN_NOW - 3 * 86_400_000,
    nextRunAt: PLAN_NOW + 20 * 3_600_000,
    runs: [],
    runCount: 0,
  },
  {
    id: 'plan-quarter-close',
    title: '季度收尾清点未归档会话',
    note: '把仍未归档的会话列成一张清单。',
    schedule: { kind: 'once', runAt: PLAN_NOW + 21 * 86_400_000 },
    delivery: { channel: 'local' },
    status: 'paused',
    enabled: false,
    createdAt: PLAN_NOW - 11 * 86_400_000,
    updatedAt: PLAN_NOW - 4 * 86_400_000,
    runs: [],
    runCount: 0,
  },
];

const LONG_CONTENT_REMINDERS: PlanReminder[] = [
  {
    id: 'plan-hostile-content',
    title: '每周一早上汇总所有仍未关闭、缺少明确负责人或预计完成日期、并且已经连续两个工作日没有更新的跨团队发布阻塞项',
    note: '从工程、设计、法务与运营项目中读取发布风险，保留原始链接、负责人、最后更新时间和下一步；如果投递目标不可用，必须在本地提醒中完整说明失败原因，而不是静默跳过。',
    schedule: {
      kind: 'cron',
      startAt: PLAN_NOW - 90 * 86_400_000,
      expression: '15 8 * * 1',
    },
    delivery: {
      channel: 'bot',
      platform: 'telegram',
      chatId: 'release-coordination-room-with-an-intentionally-hostile-identifier',
    },
    status: 'scheduled',
    enabled: true,
    createdAt: PLAN_NOW - 90 * 86_400_000,
    updatedAt: PLAN_NOW - 2 * 60 * 60_000,
    nextRunAt: PLAN_NOW + 5 * 86_400_000,
    lastRun: {
      id: 'run-long',
      at: PLAN_NOW - 2 * 86_400_000,
      status: 'blocked',
      message: '隐私浏览正在进行，因此本轮任务没有读取工作区或向外部群聊投递。',
      blockReason: 'incognito_active',
    },
    runs: [
      {
        id: 'run-long',
        at: PLAN_NOW - 2 * 86_400_000,
        status: 'blocked',
        message: '隐私浏览正在进行，因此本轮任务没有读取工作区或向外部群聊投递。',
        blockReason: 'incognito_active',
      },
    ],
    runCount: 37,
  },
];

const DAILY_REVIEW_SUMMARY: DailyReviewSummary = {
  day: { fromMs: Date.UTC(2026, 6, 1), toMs: Date.UTC(2026, 6, 2) },
  totals: {
    sessionCount: 6,
    requestCount: 42,
    totalTokens: 18_320,
    costUsd: 0.21,
    errorCount: 1,
  },
  sessions: [
    {
      id: 's-1',
      name: '整理 Storybook 表面覆盖',
      lastMessageAt: NOW - 12 * 60_000,
      lastMessagePreview: '先把高频页面补齐。',
    },
    {
      id: 's-2',
      name: 'PR #435 发布风险清单',
      lastMessageAt: NOW - 2 * 60 * 60_000,
      lastMessagePreview: '权限弹窗的状态要全。',
    },
  ],
  topTools: [
    { key: 'Bash', label: 'Bash', requests: 18, totalTokens: 4_200, costUsd: 0.05 },
    { key: 'Read', label: 'Read', requests: 12, totalTokens: 2_100, costUsd: 0.02 },
  ],
  topModels: [
    {
      key: 'claude-sonnet-4-5',
      label: 'Claude Sonnet 4.5',
      requests: 28,
      totalTokens: 12_400,
      costUsd: 0.16,
    },
  ],
};

const DAILY_REVIEW_ARCHIVE: DailyReviewArchive = {
  id: '2026-07-01-1d',
  day: DAILY_REVIEW_SUMMARY.day,
  range: 1,
  status: 'ok',
  generatedAt: NOW - 5 * 60_000,
  trigger: 'manual',
  modelKey: 'openai::gpt-5',
  totals: DAILY_REVIEW_SUMMARY.totals,
  sections: {
    summary: '今天聚焦 Daily Review 的信息架构和页面重构，完成了时间范围、活动概览与报告详情的职责拆分。',
    gaps: '报告导出仍需在真实桌面环境验证文件保存路径。',
    usage: '共完成 42 次模型请求，主要活动集中在六个对话中。',
    code: '继续让设置页只承载持久配置，把即时动作留在功能主页面。',
  },
};

type DailyReviewBridge = NonNullable<ComponentProps<typeof DailyReviewPage>['bridge']>;

const configuredMcpConfig: McpConfigFile = {
  version: 1,
  mcpServers: {
    filesystem: {
      enabled: true,
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/Users/yuhan/workspace'],
    },
    'linear-remote': {
      enabled: false,
      url: 'https://mcp.linear.app/sse',
      transport: 'sse',
    },
  },
};

const editorMcpConfig: McpConfigFile = {
  version: 1,
  mcpServers: {
    slack: {
      enabled: false,
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-slack@2025.4.25'],
      env: { SLACK_BOT_TOKEN: '', SLACK_TEAM_ID: '', SLACK_CHANNEL_IDS: '' },
    },
  },
};

const editorMcpStatus: McpServerStatus = {
  serverId: 'slack',
  state: 'disabled',
  transport: 'stdio',
  toolCount: 0,
  tools: [],
  updatedAt: NOW,
};

const configuredMcpStatuses: McpServerStatus[] = [
  {
    serverId: 'filesystem',
    state: 'connected',
    transport: 'stdio',
    toolCount: 2,
    tools: [
      { serverId: 'filesystem', name: 'read_file', inputSchema: {} },
      { serverId: 'filesystem', name: 'list_directory', inputSchema: {} },
    ],
    updatedAt: NOW,
  },
  {
    serverId: 'linear-remote',
    state: 'disabled',
    transport: 'sse',
    toolCount: 0,
    tools: [],
    updatedAt: NOW,
  },
];

const failedMcpConfig: McpConfigFile = {
  version: 1,
  mcpServers: {
    'team-tools': {
      enabled: true,
      url: 'https://mcp.example.com/team/tools',
      transport: 'streamable-http',
    },
  },
};

const failedMcpStatuses: McpServerStatus[] = [
  {
    serverId: 'team-tools',
    state: 'error',
    transport: 'streamable-http',
    toolCount: 0,
    tools: [],
    error: '连接超时，请检查服务器地址或网络代理。',
    stderrTail: ['request timed out after 30s'],
    updatedAt: NOW,
  },
];

const withConfiguredMcpBridge = withScopedMakaBridge({
  mcp: {
    getConfig: async () => configuredMcpConfig,
    listStatuses: async () => configuredMcpStatuses,
    setConfig: async () => configuredMcpConfig,
    upsert: async () => configuredMcpConfig,
    install: async () => configuredMcpConfig,
    remove: async () => configuredMcpConfig,
    cancelInstall: async () => configuredMcpConfig,
    test: async () => ({ ok: true, status: configuredMcpStatuses[0], latencyMs: 42 }),
    reconnect: async () => configuredMcpStatuses[0],
    subscribeChanges: () => () => {},
  },
});

const withEditorMcpBridge = withScopedMakaBridge({
  mcp: {
    getConfig: async () => editorMcpConfig,
    listStatuses: async () => [editorMcpStatus],
    setConfig: async () => editorMcpConfig,
    upsert: async () => editorMcpConfig,
    install: async () => editorMcpConfig,
    remove: async () => editorMcpConfig,
    cancelInstall: async () => editorMcpConfig,
    test: async () => ({ ok: false, status: editorMcpStatus, latencyMs: 0 }),
    reconnect: async () => editorMcpStatus,
    subscribeChanges: () => () => {},
  },
});

const withEmptyMcpBridge = withScopedMakaBridge({
  mcp: {
    getConfig: async () => ({ version: 1, mcpServers: {} }),
    listStatuses: async () => [],
    setConfig: async () => ({ version: 1, mcpServers: {} }),
    upsert: async () => ({ version: 1, mcpServers: {} }),
    install: async () => ({ version: 1, mcpServers: {} }),
    remove: async () => ({ version: 1, mcpServers: {} }),
    cancelInstall: async () => ({ version: 1, mcpServers: {} }),
    test: async () => ({ ok: true, status: configuredMcpStatuses[0], latencyMs: 42 }),
    reconnect: async () => configuredMcpStatuses[0],
    subscribeChanges: () => () => {},
  },
});

const withFailedMcpBridge = withScopedMakaBridge({
  mcp: {
    getConfig: async () => failedMcpConfig,
    listStatuses: async () => failedMcpStatuses,
    setConfig: async () => failedMcpConfig,
    upsert: async () => failedMcpConfig,
    install: async () => failedMcpConfig,
    remove: async () => failedMcpConfig,
    cancelInstall: async () => failedMcpConfig,
    test: async () => ({ ok: false, status: failedMcpStatuses[0], latencyMs: 30_000 }),
    reconnect: async () => failedMcpStatuses[0],
    subscribeChanges: () => () => {},
  },
});

function ModuleSurface(props: {
  children: ReactNode;
  agentsView: 'skills' | 'mcp' | 'cron' | 'daily-review';
}) {
  return (
    <div
      data-maka-e2e-fixture="true"
      // The detail panel's height contract hangs off `.maka-shell-astryx`
      // (shell-layout.css); without the shell class the panel grows with
      // content and nothing inside the page ever scrolls on its own.
      className="app maka-shell-astryx"
      style={{
        background: 'var(--surface-canvas)',
        display: 'flex',
        height: '100vh',
        minHeight: 0,
        minWidth: 0,
      }}
    >
      <AppShellDetailPanel agentsView={props.agentsView}>
        <AppShellWorkspaceTopActions
          workbarAvailable={false}
          workbarCollapsed
          onToggleWorkbar={noop}
        />
        <ToastProvider>{props.children}</ToastProvider>
      </AppShellDetailPanel>
    </div>
  );
}

function ExtensionsSkillsSurface(props: {
  skills?: SkillEntry[];
  bundledSkillCatalog?: NonNullable<ComponentProps<typeof SkillsPage>['bundledSkillCatalog']>;
  onSetSkillEnabled?: ComponentProps<typeof SkillsPage>['onSetSkillEnabled'];
  onUpdateManagedSkill?: ComponentProps<typeof SkillsPage>['onUpdateManagedSkill'];
}) {
  const copy = getSharedUiCopy(useUiLocale()).moduleHubs.extensions;
  return (
    <ModuleSurface agentsView="skills">
      <SkillsPage
        hubHeader={{
          title: copy.title,
          subtitle: copy.description,
          badge: <ModuleHubSelector hub="extensions" value="skills" onChange={() => {}} />,
        }}
        skills={props.skills ?? []}
        managedSkillSources={[]}
        bundledSkillCatalog={props.bundledSkillCatalog ?? []}
        onRefreshSkills={noop}
        onRefreshManagedSkillSources={noop}
        onRefreshBundledSkillCatalog={noop}
        onOpenSkill={noop}
        onUseSkill={noop}
        onOpenSkillsFolder={noop}
        onInstallBundledSkill={noop}
        onPreviewManagedSkillUpdate={async (skillId) => (
          skillId === UPDATE_AVAILABLE_PREVIEW.skill.id ? UPDATE_AVAILABLE_PREVIEW : null
        )}
        onUpdateManagedSkill={props.onUpdateManagedSkill ?? (async () => true)}
        onSetSkillEnabled={props.onSetSkillEnabled ?? noop}
        onSetSkillPinned={noop}
        onDeleteSkill={noop}
      />
    </ModuleSurface>
  );
}

function ExtensionsMcpSurface() {
  const copy = getSharedUiCopy(useUiLocale()).moduleHubs.extensions;
  return (
    <ModuleSurface agentsView="mcp">
      <McpPage
        hubHeader={{
          title: copy.title,
          subtitle: copy.description,
          badge: <ModuleHubSelector hub="extensions" value="mcp" onChange={() => {}} />,
        }}
      />
    </ModuleSurface>
  );
}

function ScheduledPlanRemindersSurface(props: { reminders?: PlanReminder[] }) {
  const copy = getSharedUiCopy(useUiLocale()).moduleHubs.automations;
  return (
    <ModuleSurface agentsView="cron">
      <AutomationsPage
        hubHeader={{
          title: copy.title,
          subtitle: copy.description,
          badge: <ModuleHubSelector hub="automations" value="plan-reminders" onChange={() => {}} />,
        }}
        reminders={props.reminders ?? []}
        keepSystemAwake={false}
        onKeepSystemAwakeChange={async () => {}}
        onRefresh={noop}
        onCreate={noop}
        onUpdate={noop}
        onToggle={noop}
        onTriggerNow={noop}
        onSnooze={noop}
        onClearRunHistory={noop}
        onDelete={noop}
      />
    </ModuleSurface>
  );
}

function ScheduledDailyReviewSurface(
  props: { bridge: DailyReviewBridge } & Pick<
    ComponentProps<typeof DailyReviewPage>,
    'onCopyMarkdown' | 'onAppendMarkdown' | 'onSaveMarkdown'
  >,
) {
  const copy = getSharedUiCopy(useUiLocale()).moduleHubs.automations;
  return (
    <ModuleSurface agentsView="daily-review">
      <DailyReviewPage
        hubHeader={{
          title: copy.title,
          subtitle: copy.description,
          badge: <ModuleHubSelector hub="automations" value="daily-review" onChange={() => {}} />,
        }}
        bridge={props.bridge}
        onCopyMarkdown={props.onCopyMarkdown}
        onAppendMarkdown={props.onAppendMarkdown}
        onSaveMarkdown={props.onSaveMarkdown}
      />
    </ModuleSurface>
  );
}

async function waitForStoryButton(
  canvasElement: HTMLElement,
  predicate: (button: HTMLButtonElement) => boolean,
): Promise<HTMLButtonElement> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const button = Array.from(canvasElement.querySelectorAll<HTMLButtonElement>('button')).find(predicate);
    if (button) return button;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 20));
  }
  throw new Error('Story action button did not render');
}

async function waitForStorySelector<T extends Element>(
  canvasElement: HTMLElement,
  selector: string,
): Promise<T> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const element = canvasElement.querySelector<T>(selector);
    if (element) return element;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 20));
  }
  throw new Error(`Story selector did not render: ${selector}`);
}

async function waitForStoryText(canvasElement: HTMLElement, text: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (canvasElement.textContent?.includes(text)) return;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 20));
  }
  throw new Error(`Story text did not render: ${text}`);
}

// Real path: sidebar → 扩展 → 技能, before any Skill or bundled catalog entry exists.
export const ExtensionsSkillsEmpty: Story = {
  render: () => <ExtensionsSkillsSurface />,
};

// Real path: sidebar → 扩展 → 技能, with several installed Skills. The play
// also locks the search contract: filtering, the match-count summary and the
// clear affordance.
export const ExtensionsSkillsInstalled: Story = {
  render: () => <ExtensionsSkillsSurface skills={INSTALLED_SKILLS} />,
  play: async ({ canvasElement }) => {
    const search = await waitForStorySelector<HTMLInputElement>(
      canvasElement,
      'input[placeholder="搜索技能"]',
    );
    await userEvent.type(search, 'git');
    await waitForStoryText(canvasElement, '1 个匹配');
    await waitForStoryText(canvasElement, 'git-flow');
    await expect(canvasElement.textContent).not.toContain('docs-screenshot');

    const clear = await waitForStoryButton(
      canvasElement,
      (candidate) => candidate.textContent?.trim() === '清空搜索',
    );
    clear.click();
    await waitForStoryText(canvasElement, 'docs-screenshot');
    await expect(canvasElement.textContent).toContain('release-notes');
  },
};

// Real path: sidebar → 扩展 → 技能, with bundled Skills available to install.
export const ExtensionsSkillsBundled: Story = {
  render: () => <ExtensionsSkillsSurface bundledSkillCatalog={BUNDLED_SKILLS} />,
};

// Real path: sidebar → 扩展 → 技能, after a managed source reports an update.
// The review flow lives in the inspector now: select the row, then 查看更新.
export const ExtensionsSkillsUpdateAvailable: Story = {
  render: function Render() {
    const [updateInput, setUpdateInput] = useState<unknown>(null);
    return (
      <>
        <ExtensionsSkillsSurface
          skills={UPDATE_AVAILABLE_SKILLS}
          onUpdateManagedSkill={async (skillId, options) => {
            setUpdateInput({ skillId, options });
            return true;
          }}
        />
        <output data-testid="skills-update-input" hidden>
          {updateInput ? JSON.stringify(updateInput) : ''}
        </output>
      </>
    );
  },
  play: async ({ canvasElement }) => {
    const row = await waitForStoryButton(
      canvasElement,
      (candidate) => candidate.textContent?.includes('release-checklist') === true,
    );
    row.click();

    const viewUpdate = await waitForStoryButton(
      canvasElement,
      (candidate) => candidate.textContent?.trim() === '查看更新',
    );
    viewUpdate.click();

    const review = await waitForStorySelector<HTMLElement>(
      canvasElement,
      '[aria-label="Skill 更新审查"]',
    );
    await expect(review.textContent).toContain(UPDATE_AVAILABLE_PREVIEW.currentContent);
    await expect(review.textContent).toContain(UPDATE_AVAILABLE_PREVIEW.sourceContent);

    const applyUpdate = await waitForStoryButton(
      review,
      (candidate) => candidate.textContent?.trim() === '更新到来源版本',
    );
    applyUpdate.click();

    const output = await waitForStorySelector<HTMLOutputElement>(
      canvasElement,
      '[data-testid="skills-update-input"]',
    );
    await waitForStoryText(output, UPDATE_AVAILABLE_PREVIEW.expectedSourceSha256);
    const input = JSON.parse(output.textContent ?? '') as Record<string, unknown>;
    await expect(input).toEqual({
      skillId: UPDATE_AVAILABLE_PREVIEW.skill.id,
      options: {
        expectedCurrentSha256: UPDATE_AVAILABLE_PREVIEW.expectedCurrentSha256,
        expectedSourceSha256: UPDATE_AVAILABLE_PREVIEW.expectedSourceSha256,
      },
    });
  },
};

// Real path: sidebar → 扩展 → 技能 → click an installed row, which opens the
// inspector where every per-skill control now lives. Wide only: below 1024px
// the page trades the panel for a dialog.
export const ExtensionsSkillsInspector: Story = {
  render: function Render() {
    const [enabledInput, setEnabledInput] = useState<unknown>(null);
    return (
      <>
        <ExtensionsSkillsSurface
          skills={INSTALLED_SKILLS}
          onSetSkillEnabled={(skillId, enabled) => setEnabledInput({ skillId, enabled })}
        />
        <output data-testid="skills-enabled-input" hidden>
          {enabledInput ? JSON.stringify(enabledInput) : ''}
        </output>
      </>
    );
  },
  play: async ({ canvasElement }) => {
    const row = await waitForStoryButton(
      canvasElement,
      (candidate) => candidate.textContent?.includes('git-flow') === true,
    );
    row.click();
    await waitForStoryText(canvasElement, '固定到技能上下文');
    await waitForStoryText(canvasElement, '声明工具');

    // The enable toggle must address the skill by its scope-qualified ref —
    // the same addressing pin/open/delete use — because an id can name more
    // than one skill across user/project/workspace scopes.
    const enableSwitch = await waitForStorySelector<HTMLElement>(
      canvasElement,
      '[role="switch"]',
    );
    enableSwitch.click();
    const enabledOutput = await waitForStorySelector<HTMLOutputElement>(
      canvasElement,
      '[data-testid="skills-enabled-input"]',
    );
    await waitForStoryText(enabledOutput, 'workspace:maka:skill-git-flow');
    await expect(JSON.parse(enabledOutput.textContent ?? '')).toEqual({
      skillId: 'workspace:maka:skill-git-flow',
      enabled: false,
    });

    // The inspector's resize handle carries an absolutely positioned hit
    // strip; a vendor translate bug once shifted it half its height upward,
    // over the toolbar, swallowing the view switch's clicks. The strip must
    // stay inside the content row — below the toolbar. Same selector as the
    // CSS fix: the strip is the handle child that is not the pill, regardless
    // of the order the vendor renders its children in.
    const hitStrip = await waitForStorySelector<HTMLElement>(
      canvasElement,
      '.maka-module-page .astryx-resize-handle > :not(.astryx-resize-handle-pill)',
    );
    const toolbar = await waitForStorySelector<HTMLElement>(
      canvasElement,
      '.maka-module-page-bar',
    );
    await expect(hitStrip.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      toolbar.getBoundingClientRect().bottom - 1,
    );
  },
};

// Real path: sidebar → 扩展 → 技能, scrolling a long installed list.
// Regression contract for #2236: the view switch rides the fixed header, so
// scrolling the list must not move it. Rows scroll; the switch stays put.
export const ExtensionsSkillsScrollContainment: Story = {
  render: () => <ExtensionsSkillsSurface skills={LONG_LIST_SKILLS} />,
  play: async ({ canvasElement }) => {
    const viewSwitch = await waitForStorySelector<HTMLElement>(
      canvasElement,
      '[aria-label="技能视图"]',
    );
    const rows = await waitForStorySelector<HTMLElement>(
      canvasElement,
      '[aria-label="技能列表"]',
    );
    // The scroller is whichever ancestor of the rows actually overflows —
    // asserting through the DOM, not through a class name the layout could
    // rename.
    let scroller: HTMLElement | null = rows;
    while (scroller && scroller.scrollHeight <= scroller.clientHeight) {
      scroller = scroller.parentElement;
    }
    if (!scroller) throw new Error('Skills list never overflows any ancestor');
    const before = viewSwitch.getBoundingClientRect().top;
    scroller.scrollTop = 600;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 50));
    await expect(scroller.scrollTop).toBeGreaterThan(0);
    await expect(viewSwitch.getBoundingClientRect().top).toBe(before);
  },
};

// Real path: sidebar → 扩展 → 技能, with an installed Skill disabled.
export const ExtensionsSkillsDisabled: Story = {
  render: () => <ExtensionsSkillsSurface skills={DISABLED_SKILLS} />,
};

// Real path: sidebar → 扩展 → 技能, at a narrow desktop window.
export const ExtensionsSkillsNarrow: Story = {
  render: () => <ExtensionsSkillsSurface skills={INSTALLED_SKILLS} />,
  parameters: { viewport: { defaultViewport: 'mobile2' } },
};

// Real path: sidebar → 扩展 → MCP, before any server has been configured.
export const ExtensionsMcpSetupRequired: Story = {
  decorators: [withEmptyMcpBridge],
  render: () => <ExtensionsMcpSurface />,
  play: async ({ canvasElement }) => {
    const installed = await waitForStoryButton(
      canvasElement,
      (candidate) => candidate.textContent?.trim() === '已安装',
    );
    installed.click();
    await waitForStoryText(canvasElement, '还没有安装 MCP');
  },
};

// Real path: sidebar → 扩展 → MCP, browsing catalog entries with existing configuration.
export const ExtensionsMcpMarketplace: Story = {
  decorators: [withConfiguredMcpBridge],
  render: () => <ExtensionsMcpSurface />,
  play: async ({ canvasElement }) => {
    const market = await waitForStoryButton(
      canvasElement,
      (candidate) => candidate.textContent?.trim() === '市场',
    );
    market.click();
    await waitForStoryText(canvasElement, 'Slack');
  },
};

// Real path: sidebar → 扩展 → MCP, with connected and disabled servers. The
// play also locks the search contract: a discovered tool name keeps the
// server that offers it, and the clear affordance restores the list.
export const ExtensionsMcpConfigured: Story = {
  decorators: [withConfiguredMcpBridge],
  render: () => <ExtensionsMcpSurface />,
  play: async ({ canvasElement }) => {
    const installed = await waitForStoryButton(
      canvasElement,
      (candidate) => candidate.textContent?.trim() === '已安装',
    );
    installed.click();
    await waitForStoryText(canvasElement, 'filesystem');

    const search = await waitForStorySelector<HTMLInputElement>(
      canvasElement,
      'input[placeholder="搜索 MCP…"]',
    );
    await userEvent.type(search, 'read_file');
    await waitForStoryText(canvasElement, '1 个匹配');
    await expect(canvasElement.textContent).toContain('filesystem');
    await expect(canvasElement.textContent).not.toContain('linear-remote');

    const clear = await waitForStoryButton(
      canvasElement,
      (candidate) => candidate.textContent?.trim() === '清空搜索',
    );
    clear.click();
    await waitForStoryText(canvasElement, 'linear-remote');
  },
};

// Real path: sidebar → 扩展 → MCP → click a server row, which opens the
// inspector where the enable switch, 测试, 编辑 and 删除 now live.
export const ExtensionsMcpInspector: Story = {
  decorators: [withConfiguredMcpBridge],
  render: () => <ExtensionsMcpSurface />,
  play: async ({ canvasElement }) => {
    const installed = await waitForStoryButton(
      canvasElement,
      (candidate) => candidate.textContent?.trim() === '已安装',
    );
    installed.click();
    await waitForStoryText(canvasElement, 'filesystem');
    const row = await waitForStoryButton(
      canvasElement,
      (candidate) => candidate.textContent?.includes('filesystem') === true,
    );
    row.click();
    await waitForStoryText(canvasElement, '测试');
    await waitForStoryText(canvasElement, 'read_file');
  },
};

// Real path: sidebar → 扩展 → MCP → Slack 管理, with credential fields visible.
export const ExtensionsMcpEditor: Story = {
  decorators: [withEditorMcpBridge],
  render: () => <ExtensionsMcpSurface />,
  play: async ({ canvasElement }) => {
    const manage = await waitForStoryButton(
      canvasElement,
      (button) => button.textContent?.trim() === '管理',
    );
    manage.click();
    await waitForStoryText(canvasElement.ownerDocument.body, '编辑 slack');
  },
};

// Real path: sidebar → 扩展 → MCP, after an enabled remote server fails to
// connect: the failure leads the row, the detail lives in the inspector.
export const ExtensionsMcpConnectionFailed: Story = {
  decorators: [withFailedMcpBridge],
  render: () => <ExtensionsMcpSurface />,
  play: async ({ canvasElement }) => {
    const installed = await waitForStoryButton(
      canvasElement,
      (candidate) => candidate.textContent?.trim() === '已安装',
    );
    installed.click();
    await waitForStoryText(canvasElement, '连接失败');
    const row = await waitForStoryButton(
      canvasElement,
      (candidate) => candidate.textContent?.includes('team-tools') === true,
    );
    row.click();
    await waitForStoryText(canvasElement, '连接超时，请检查服务器地址或网络代理。');
  },
};

// Real path: sidebar → 扩展 → MCP at the narrow desktop viewport floor.
export const ExtensionsMcpNarrow: Story = {
  ...ExtensionsMcpConfigured,
  parameters: { viewport: { defaultViewport: 'mobile2' } },
};

// Real path: sidebar → 定时任务 → 计划提醒, before any reminder exists.
export const ScheduledPlanReminders: Story = {
  render: () => <ScheduledPlanRemindersSurface />,
};

// Real path: sidebar → 定时任务 → 计划提醒, with recurring, paused, completed and
// delivery-blocked reminders in one list.
//
// 保持系统唤醒 has no story: it is persisted page state the page itself never
// renders, so a story for it would smoke pixels identical to this one at every
// viewport. The state lives on the settings menu item, and
// plan-reminder-panel.test.tsx asserts its aria-checked in both directions.
export const ScheduledPlanRemindersConfigured: Story = {
  render: () => <ScheduledPlanRemindersSurface reminders={CONFIGURED_REMINDERS} />,
};

// Real path: sidebar → 定时任务 → 计划提醒 → click a task row, which opens the
// inspector where every per-task control now lives. Wide only: below 1024px the
// page drops the inspector rather than squeeze two columns into one.
export const ScheduledPlanRemindersInspector: Story = {
  render: () => <ScheduledPlanRemindersSurface reminders={CONFIGURED_REMINDERS} />,
  play: async ({ canvasElement }) => {
    const row = await waitForStoryButton(
      canvasElement,
      (candidate) => candidate.textContent?.includes('每周发布风险复盘') === true,
    );
    row.click();
    await waitForStoryText(canvasElement, '立即触发');
  },
};

// Real path: sidebar → 定时任务 → 计划提醒, with user-authored content at storage limits.
export const ScheduledPlanRemindersLongContent: Story = {
  render: () => <ScheduledPlanRemindersSurface reminders={LONG_CONTENT_REMINDERS} />,
};

// Real path: sidebar → 定时任务 → 每日回顾, with reviews already generated.
export const ScheduledDailyReview: Story = {
  render: () => (
    <ScheduledDailyReviewSurface
      bridge={{
        fetchDay: async () => DAILY_REVIEW_SUMMARY,
        listArchives: async () => [],
        runOnce: async () => ({ archiveId: DAILY_REVIEW_ARCHIVE.id }),
        getArchive: async () => DAILY_REVIEW_ARCHIVE,
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const overview = await waitForStorySelector<HTMLElement>(
      canvasElement,
      '[aria-label="今天概览"]',
    );
    await expect(overview.textContent).not.toContain('错误');

    const week = await waitForStoryButton(
      canvasElement,
      (candidate) => candidate.textContent?.includes('最近 7 天') === true,
    );
    week.click();
    const earlier = await waitForStoryButton(
      canvasElement,
      (candidate) => candidate.getAttribute('aria-label') === '查看更早一天',
    );
    earlier.click();
    await waitForStoryText(canvasElement, '最近 7 天（往前 1 天）');
  },
};

// Real path: sidebar → scheduled tasks → Daily Review after the initial activity request fails.
export const ScheduledDailyReviewInitialLoadFailed: Story = {
  render: () => (
    <ScheduledDailyReviewSurface
      bridge={{
        fetchDay: async () => {
          throw new Error('activity fixture unavailable');
        },
        listArchives: async () => [],
        runOnce: async () => ({ archiveId: DAILY_REVIEW_ARCHIVE.id }),
        getArchive: async () => DAILY_REVIEW_ARCHIVE,
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    await waitForStoryText(canvasElement, '每日回顾刷新失败');
    await expect(canvasElement.querySelector('[aria-busy="true"]')).toBeNull();
    await expect(canvasElement.querySelector('.astryx-skeleton')).toBeNull();
  },
};

// Real path: sidebar → scheduled tasks → Daily Review while a new range loads.
export const ScheduledDailyReviewRefreshing: Story = {
  render: () => (
    <ScheduledDailyReviewSurface
      bridge={{
        fetchDay: async (_offsetDays, range) => {
          if (range === 1) return DAILY_REVIEW_SUMMARY;
          return new Promise<DailyReviewSummary>(() => undefined);
        },
        listArchives: async () => [],
        runOnce: async () => ({ archiveId: DAILY_REVIEW_ARCHIVE.id }),
        getArchive: async () => DAILY_REVIEW_ARCHIVE,
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const button = await waitForStoryButton(
      canvasElement,
      (candidate) => candidate.textContent?.includes('最近 7 天') === true,
    );
    button.click();
    const content = await waitForStorySelector<HTMLElement>(
      canvasElement,
      '.maka-daily-review-content',
    );
    await expect(button.getAttribute('aria-checked')).toBe('true');
    await expect(content.getAttribute('aria-busy')).toBe('true');
    await expect(canvasElement.querySelector('.astryx-skeleton')).toBeNull();
  },
};

// Real path after an analysis exists and the user opens its dedicated detail route.
// Real path: sidebar → scheduled tasks → Daily Review → view analysis.
export const ScheduledDailyReviewReport: Story = {
  render: function Render() {
    const [savedInput, setSavedInput] = useState<unknown>(null);
    const staleSummary = {
      ...DAILY_REVIEW_SUMMARY,
      day: {
        fromMs: DAILY_REVIEW_SUMMARY.day.fromMs - 86_400_000,
        toMs: DAILY_REVIEW_SUMMARY.day.toMs - 86_400_000,
      },
      totals: { ...DAILY_REVIEW_SUMMARY.totals, requestCount: 999 },
    };
    return (
      <>
        <ScheduledDailyReviewSurface
          bridge={{
            fetchDay: async (_offsetDays, range) => range === 1 ? DAILY_REVIEW_SUMMARY : staleSummary,
            listArchives: async () => [{
              id: DAILY_REVIEW_ARCHIVE.id,
              day: DAILY_REVIEW_ARCHIVE.day,
              range: DAILY_REVIEW_ARCHIVE.range,
              status: DAILY_REVIEW_ARCHIVE.status,
              generatedAt: DAILY_REVIEW_ARCHIVE.generatedAt,
              trigger: DAILY_REVIEW_ARCHIVE.trigger,
              modelKey: DAILY_REVIEW_ARCHIVE.modelKey,
              totals: DAILY_REVIEW_ARCHIVE.totals,
            }],
            getArchive: async () => {
              await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
              return DAILY_REVIEW_ARCHIVE;
            },
          }}
          onSaveMarkdown={(input) => setSavedInput(input)}
        />
        <output data-testid="daily-review-saved-input" hidden>
          {savedInput ? JSON.stringify(savedInput) : ''}
        </output>
      </>
    );
  },
  play: async ({ canvasElement }) => {
    const view = await waitForStoryButton(
      canvasElement,
      (candidate) => candidate.textContent?.includes('查看分析') === true,
    );
    view.click();
    const recent7Days = await waitForStoryButton(
      canvasElement,
      (candidate) => candidate.textContent?.includes('最近 7 天') === true,
    );
    recent7Days.click();
    await waitForStoryText(canvasElement, '返回活动');
    const save = await waitForStoryButton(
      canvasElement,
      (candidate) => candidate.textContent?.trim() === '保存',
    );
    save.click();
    const output = await waitForStorySelector<HTMLOutputElement>(
      canvasElement,
      '[data-testid="daily-review-saved-input"]',
    );
    await waitForStoryText(output, 'markdown');
    const input = JSON.parse(output.textContent ?? '') as Record<string, unknown>;
    await expect(input.day).toEqual(DAILY_REVIEW_ARCHIVE.day);
    await expect(input.range).toBe(DAILY_REVIEW_ARCHIVE.range);
    await expect(input.totals).toEqual(DAILY_REVIEW_ARCHIVE.totals);
    const archiveCopy = getDailyReviewCopy('zh');
    const expectedMarkdown = [
      `# ${formatDailyReviewArchiveTitle(DAILY_REVIEW_ARCHIVE, 'zh')}`,
      ...(['summary', 'gaps', 'usage', 'code'] as const).flatMap((key) => [
        '',
        `## ${archiveCopy.archive.section[key]}`,
        DAILY_REVIEW_ARCHIVE.sections[key],
      ]),
    ].join('\n');
    await expect(input.markdown).toBe(expectedMarkdown);
  },
};
