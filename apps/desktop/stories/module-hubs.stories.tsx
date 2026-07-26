import type { Meta, StoryObj } from '@storybook/react-vite';
import type { DailyReviewSummary, PlanReminder } from '@maka/core';
import {
  AutomationsPage,
  DailyReviewPage,
  getSharedUiCopy,
  ModuleHubSelector,
  SkillsPage,
  type SkillEntry,
  ToastProvider,
  useUiLocale,
} from '@maka/ui';
import type { ComponentProps, ReactNode } from 'react';
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
    id: 'skill-git-flow',
    name: 'git-flow',
    description: '封装分支创建、合并与发布打 tag 的常用 git 操作。',
    path: '~/.maka/skills/git-flow',
    declaredTools: ['Bash', 'Write'],
    enabled: true,
    runtimeStatus: 'enabled',
  },
  {
    id: 'skill-docs-screenshot',
    name: 'docs-screenshot',
    description: '把组件截图同步进设计文档，按 token 分类命名。',
    path: '~/.maka/skills/docs-screenshot',
    declaredTools: ['Bash', 'Read'],
    enabled: false,
    runtimeStatus: 'disabled',
  },
  {
    id: 'skill-release-notes',
    name: 'release-notes',
    description: '从最近的 commit 历史生成发布说明草稿。',
    path: '~/.maka/skills/release-notes',
    declaredTools: ['Bash'],
    enabled: true,
    runtimeStatus: 'enabled',
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
];

const ATTENTION_REMINDERS: PlanReminder[] = [
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

type DailyReviewBridge = NonNullable<ComponentProps<typeof DailyReviewPage>['bridge']>;

const withMcpBridge = withScopedMakaBridge({
  mcp: {
    getConfig: async () => ({ version: 1, mcpServers: {} }),
    listStatuses: async () => [],
    setConfig: async (config: unknown) => config,
    upsert: async () => ({ version: 1, mcpServers: {} }),
    install: async () => ({ version: 1, mcpServers: {} }),
    remove: async () => ({ version: 1, mcpServers: {} }),
    cancelInstall: async () => ({ version: 1, mcpServers: {} }),
    test: async () => {
      throw new Error('The empty MCP baseline does not test a server');
    },
    reconnect: async () => {
      throw new Error('The empty MCP baseline does not reconnect a server');
    },
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
          onOpenFeedback={noop}
          onOpenPalette={noop}
          onOpenHelp={noop}
          onOpenHealth={noop}
        />
        <ToastProvider>{props.children}</ToastProvider>
      </AppShellDetailPanel>
    </div>
  );
}

function ExtensionsSkillsSurface(props: { skills?: SkillEntry[] }) {
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
        bundledSkillCatalog={[]}
        onRefreshSkills={noop}
        onCreateSkillTemplate={noop}
        onOpenSkill={noop}
        onOpenSkillsFolder={noop}
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

function ScheduledPlanRemindersSurface(props: {
  reminders?: PlanReminder[];
  keepSystemAwake?: boolean;
}) {
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
        keepSystemAwake={props.keepSystemAwake ?? false}
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

function ScheduledDailyReviewSurface(props: { bridge: DailyReviewBridge }) {
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
      />
    </ModuleSurface>
  );
}

async function assertKeepAwakeStoryState(canvasElement: HTMLElement) {
  const document = canvasElement.ownerDocument;
  const deadline = Date.now() + 2_000;
  let trigger: HTMLButtonElement | undefined;
  while (!trigger && Date.now() < deadline) {
    trigger = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((button) => {
      const label = button.getAttribute('aria-label');
      return label === '定时任务页面设置' || label === 'Scheduled task page settings';
    });
    if (!trigger) await new Promise((resolve) => setTimeout(resolve, 16));
  }
  if (!trigger) throw new Error('Keep-awake story did not render the page-settings trigger');
  trigger.click();

  while (Date.now() < deadline) {
    const item = Array.from(
      document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]'),
    ).find((candidate) => /保持系统唤醒|Keep system awake/.test(candidate.textContent ?? ''));
    if (item?.getAttribute('aria-checked') === 'true') return;
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
  throw new Error('Keep-awake story did not expose a checked contextual control');
}

// Real path: sidebar → 扩展 → 技能, on a fresh install.
export const ExtensionsSkills: Story = { render: () => <ExtensionsSkillsSurface /> };

// Real path: sidebar → 扩展 → 技能, with several installed skills.
export const ExtensionsSkillsInstalled: Story = {
  render: () => <ExtensionsSkillsSurface skills={INSTALLED_SKILLS} />,
};

// Real path: sidebar → 扩展 → MCP, before any server is installed.
export const ExtensionsMcp: Story = {
  decorators: [withMcpBridge],
  render: () => <ExtensionsMcpSurface />,
};

// Real path: sidebar → 定时任务 → 计划提醒, before any reminder exists.
export const ScheduledPlanReminders: Story = {
  render: () => <ScheduledPlanRemindersSurface />,
};

// Real path: sidebar → 定时任务 → 计划提醒, with recurring and completed reminders.
export const ScheduledPlanRemindersConfigured: Story = {
  render: () => <ScheduledPlanRemindersSurface reminders={CONFIGURED_REMINDERS} />,
};

// Real path: sidebar → 定时任务 → 计划提醒, after the latest delivery needs attention.
export const ScheduledPlanRemindersAttention: Story = {
  render: () => <ScheduledPlanRemindersSurface reminders={ATTENTION_REMINDERS} />,
};

// Real path: sidebar → 定时任务 → 计划提醒, after Keep system awake is enabled in page settings.
export const ScheduledPlanRemindersKeepAwake: Story = {
  render: () => (
    <ScheduledPlanRemindersSurface
      reminders={CONFIGURED_REMINDERS}
      keepSystemAwake
    />
  ),
  play: async ({ canvasElement }) => {
    await assertKeepAwakeStoryState(canvasElement);
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
      bridge={{ fetchDay: async () => DAILY_REVIEW_SUMMARY }}
    />
  ),
};

// Real path: same page while the review is still being generated or fetched.
export const ScheduledDailyReviewLoading: Story = {
  render: () => (
    <ScheduledDailyReviewSurface
      bridge={{ fetchDay: async () => new Promise<DailyReviewSummary>(() => {}) }}
    />
  ),
};

// Real path: same page when the main-process bridge fails to return the review.
export const ScheduledDailyReviewLoadError: Story = {
  render: () => (
    <ScheduledDailyReviewSurface
      bridge={{
        fetchDay: async () => {
          throw new Error('每日回顾暂时不可用，请稍后重试。');
        },
      }}
    />
  ),
};
