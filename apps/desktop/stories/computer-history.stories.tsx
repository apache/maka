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

import type { Meta, StoryObj } from '@storybook/react-vite';
import { type CSSProperties, useMemo, useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { AppShell as AstryxAppShell } from '@astryxdesign/core/AppShell';
import type { SessionSummary } from '@maka/core/session';
import { createDefaultSettings } from '@maka/core/settings';
import { DEFAULT_DAILY_REVIEW_CONFIG } from '@maka/core/daily-review';
import type { DesktopRuntimeHostProfileSnapshot } from '../src/preload/bridge-contract';
import type {
  ComputerHistoryApplication,
  ComputerHistoryDetail,
  ComputerHistoryEventEvidence,
  ComputerHistoryStatus,
  ComputerHistorySettings,
  ComputerHistoryTimelineEntry,
} from '@maka/core/computer-history';
import { ToastProvider } from '@maka/ui';
import { AppShellDetailPanel } from '../src/renderer/app-shell-detail-panel';
import {
  ComputerHistoryPage,
  ModuleHubServicesProvider,
  createFakeModuleHubServices,
} from '../src/renderer/features/module-hub/testing';
import type { ModuleHubComputerHistoryService } from '../src/renderer/features/module-hub';
import { WorkbarTitlebarActions } from '../src/renderer/features/workbar';
import { SessionRail } from '../../../packages/ui/stories/session-rail-harness';
import { AppShellTopbarActions } from '../src/renderer/app-shell-chrome-actions';
import SettingsModal from '../src/renderer/settings/settings-modal';
import { ConnectionSettingsServicesProvider } from '../src/renderer/features/connection-settings';
import { createDesktopConnectionSettingsServices } from '../src/renderer/platform/desktop/create-connection-settings-services';
import { createUiLocaleUpdateGate } from '../src/renderer/settings/ui-locale-update-gate';
import { withScopedMakaBridge } from './maka-bridge';
import { useSettingsModal } from '../src/renderer/use-settings-modal';

const noop = () => undefined;
const subscription = () => noop;
const settingsSnapshot = createDefaultSettings();
const settingsHosts: DesktopRuntimeHostProfileSnapshot = {
  defaultProfileId: 'synthetic-remote',
  entries: [
    { profile: { id: 'local', name: 'Local', kind: 'local' }, enabled: true, isDefault: false, readiness: 'ready', hostId: 'synthetic-local-host' },
    { profile: { id: 'synthetic-remote', name: 'QA Remote', kind: 'remote', rootId: 'synthetic-root', transport: { kind: 'ssh', destination: 'synthetic.example.test', remotePort: 43123, websocketPath: '/runtime-host' } }, enabled: true, isDefault: true, readiness: 'ready', hostId: 'synthetic-remote-host' },
  ],
};
const readAnalysisConfig = fn(async (_host: { profileId: string; hostId: string }) => DEFAULT_DAILY_REVIEW_CONFIG);
const settingsBridge = {
  settings: {
    getClient: async () => settingsSnapshot,
    get: async () => ({ ...settingsSnapshot, network: { proxy: { ...settingsSnapshot.network.proxy, passwordConfigured: false } } }),
    subscribeClientChanged: subscription,
    subscribeExternalChanged: subscription,
    usageStats: async () => null,
  },
  runtimeHostProfiles: { getSnapshot: async () => settingsHosts, subscribeChanges: subscription },
  connections: { getSnapshot: async () => ({ connections: [], defaultConnection: null }), subscribeEvents: subscription },
  dailyReview: { getConfig: readAnalysisConfig, setConfig: fn() },
};

const meta = {
  title: 'Product/Computer History',
  component: HistorySurface,
  decorators: [withScopedMakaBridge(settingsBridge)],
  parameters: { layout: 'fullscreen' },
  args: {
    scenario: 'populated', withSidebar: false, onCreateDraft: fn(),
    onSettingsWrite: fn(), onPermissionRequest: fn(), onDetailRead: fn(), onTimelineRead: fn(),
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

function at(time: string): string {
  const now = new Date();
  const [hour, minute, second = 0] = time.split(':').map(Number);
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, second).toISOString();
}
const ACTIVITIES = [
  {
    id: 'layout',
    start: '12:20',
    title: '检查电脑历史的独立页面布局',
    description: '对照桌面与 390px 预览检查摘要换行和操作区，并阅读左侧导航实现。尚未记录到完整测试结果。',
    applications: ['com.microsoft.VSCode', 'com.google.Chrome'],
    eventCount: 18,
  },
  {
    id: 'privacy',
    start: '11:40',
    title: '核对采集与模型摘要的授权边界',
    description: '阅读权限处理和保留策略，区分原始记录的 48 小时期限与摘要的手动删除规则。未观察到实际开启采集。',
    applications: ['com.microsoft.VSCode', 'com.apple.Terminal'],
    eventCount: 12,
  },
  {
    id: 'review',
    start: '11:10',
    title: '复查界面调整的验证步骤',
    description: '查看上一次窄屏检查的截图与记录，整理需要重复检查的文字、筛选栏和滚动边界。',
    applications: ['com.google.Chrome', 'com.microsoft.VSCode'],
    eventCount: 16,
  },
  {
    id: 'paper',
    start: '10:20',
    title: '整理交互式 Agent 的评测条件',
    description: '对照论文与阅读笔记，区分可见操作、模型推断和任务完成证据。笔记中的结论仍待回到原文核对。',
    applications: ['com.google.Chrome', 'com.microsoft.VSCode'],
    eventCount: 21,
  },
  {
    id: 'meeting',
    start: '09:40',
    title: '整理活动摘要的团队讨论',
    description: '查看团队关于模型授权的讨论，整理默认关闭、发送内容说明和删除范围三个待确认点。',
    applications: ['com.bytedance.Lark', 'com.microsoft.VSCode'],
    eventCount: 9,
  },
  {
    id: 'workflow',
    start: '09:10',
    title: '检查上次页面回归的结果',
    description: '打开本地预览与验证记录，对照桌面、窄屏布局和截图范围。这是当天第一个相似的界面检查片段。',
    applications: ['com.google.Chrome', 'com.apple.Terminal'],
    eventCount: 14,
  },
];

function fixtureEntries(): readonly ComputerHistoryTimelineEntry[] {
  return ACTIVITIES.map((activity) => ({
  ...activity,
  start: at(activity.start),
  end: new Date(Date.parse(at(activity.start)) + 600_000).toISOString(),
  summaryText: activity.id === 'layout'
    ? '观察到两次编辑器窗口切换和一次浏览器预览。记录中没有构建退出码或测试报告，无法确认验证已通过。'
    : undefined,
  suppressedEventCount: 0,
  summaryLevel: '10min',
  contextMarkdown: `<computer-history-context trust="untrusted-observed-ui">\n${activity.title}\n${activity.description}\n</computer-history-context>`,
  ...(activity.id === 'layout' ? {
    suggestion: {
      type: 'skill' as const,
      name: '界面回归检查',
      description: '整理桌面与窄屏的检查步骤。创建前需要核对测试范围和完成证据。',
    },
  } : {}),
  }));
}

function fixturePendingEntries(): ComputerHistoryTimelineEntry[] {
  return [
    {
      id: 'pending-editor', start: '12:32:10', end: '12:32:42',
      title: 'VS Code · computer-history-page.tsx',
      description: '窗口切换、快捷键与鼠标点击，尚未生成活动摘要。',
      applications: ['com.microsoft.VSCode'], eventCount: 4,
    },
    {
      id: 'pending-preview', start: '12:31:05', end: '12:31:24',
      title: 'Chrome · Computer History · 390px',
      description: '打开本地页面预览并切换窗口，尚未生成活动摘要。',
      applications: ['com.google.Chrome'], eventCount: 3,
    },
  ].map((entry) => ({
    ...entry, start: at(entry.start), end: at(entry.end), suppressedEventCount: 0,
    contextMarkdown: `<computer-history-context trust="untrusted-observed-ui">\n${entry.title}\n${entry.description}\n</computer-history-context>`,
  }));
}

const STATUS: ComputerHistoryStatus = {
  platformSupported: true,
  helperAvailable: true,
  state: 'paused',
  accessibilityGranted: true,
  inputMonitoringGranted: true,
  eventCount: ACTIVITIES.reduce((sum, entry) => sum + entry.eventCount, 0),
  suppressedEventCount: 0,
  segmentCount: 1,
  settings: {
    enabled: true,
    captureText: false,
    summariesEnabled: false,
    blockedApplications: [],
    blockedDomains: [],
  },
  summaryState: 'disabled',
};

const APP_NAMES: Record<string, string> = {
  'com.microsoft.VSCode': 'VS Code',
  'com.google.Chrome': 'Chrome',
  'com.apple.Terminal': '终端',
  'com.bytedance.Lark': '飞书',
};

const WINDOWS: Record<string, string[]> = {
  layout: ['Computer History · 390px', 'session-sidebar-nav.tsx', 'computer-history.css'],
  privacy: ['computer-history-main.ts', 'maka-agent-computer-history'],
  review: ['Computer History · desktop', 'verification.json'],
  paper: ['Agent evaluation · 阅读材料', 'evaluation-notes.md'],
  meeting: ['Maka 产品讨论', 'history-discussion.md'],
  workflow: ['Computer History · desktop', 'ui-validation'],
};

function fixtureDocument(entry: ComputerHistoryTimelineEntry): ComputerHistoryDetail['document'] {
  if (!entry.summaryLevel) return undefined;
  const body = entry.id === 'layout' ? [
    '## 活动概览',
    '',
    '在 **VS Code** 与 **Chrome** 之间切换，围绕电脑历史独立页面检查导航、摘要排版和窄屏操作区。',
    '当前可见记录只支持“进行了检查”，不能确认构建或回归测试已经通过。',
    '',
    '### 已观察到的操作',
    '',
    '- 阅读 `session-sidebar-nav.tsx`，核对电脑历史在全局左侧导航的位置。',
    '- 打开 390px 浏览器预览，检查摘要换行与加入草稿入口。',
    '- 回到编辑器查看样式，随后再次切换至预览窗口。',
    '',
    '| 时间 | 应用 | 窗口或材料 | 可确认的内容 |',
    '| --- | --- | --- | --- |',
    '| 12:20 | VS Code | `apps/desktop/src/renderer/features/module-hub/ui/computer-history-page.tsx` | 打开页面实现 |',
    '| 12:24 | Chrome | Computer History · 390px | 查看窄屏预览 |',
    '| 12:28 | VS Code | `computer-history.css` | 阅读布局规则 |',
    '',
    '> 记录中没有构建退出码、测试报告或保存成功通知。页面显示正常不等于完整验证已完成。',
    '',
    '### 后续核对',
    '',
    '- [ ] 检查浅色与深色下的摘要阅读体验。',
    '- [ ] 确认长表格和代码块只在文档内部横向滚动。',
    '- [ ] 将选中的内容加入草稿后核对，保持手动发送。',
    '',
    '以下代码是待核对步骤的示意，不是已执行的操作：',
    '',
    '```ts',
    'type ReviewTarget = { viewport: number; theme: "light" | "dark" };',
    'const target: ReviewTarget = { viewport: 390, theme: "light" };',
    'const documentPath = "apps/desktop/src/renderer/features/module-hub/ui/computer-history-summary-document-rendered-and-source-view.tsx";',
    'const draft = { context: "请核对观察依据", sendAutomatically: false };',
    '```',
    '',
    '### 工作流建议',
    '',
    '可整理一份“界面回归检查”草稿，覆盖侧边栏、文档阅读和窄屏返回。创建前先补齐验证证据。',
  ].join('\n') : [
    `## ${entry.title}`,
    '',
    entry.description,
    '',
    '### 观察依据',
    '',
    ...((WINDOWS[entry.id] ?? []).map((window) => `- 打开窗口：\`${window}\``)),
    '',
    '> 未观察到明确完成通知；此摘要应与原始记录共同核对。',
  ].join('\n');
  const header = {
    version: 1, id: entry.id, level: entry.summaryLevel,
    start: entry.start, end: entry.end, applications: entry.applications,
    eventCount: entry.eventCount, sourceIds: [`synthetic-${entry.id}-segment`],
    content: { title: entry.title, description: entry.description, ...(entry.suggestion ? { suggestion: entry.suggestion } : {}) },
  };
  return { name: `${entry.summaryLevel}-${Date.parse(entry.start)}.md`, markdown: `---\n${JSON.stringify(header)}\n---\n${body}\n`, body };
}

function fixtureDetail(entry: ComputerHistoryTimelineEntry): ComputerHistoryDetail {
  const events: ComputerHistoryEventEvidence[] = Array.from({ length: entry.eventCount }, (_, index) => {
    const titles = WINDOWS[entry.id] ?? ['Synthetic activity window'];
    const windowTitle = titles[index % titles.length];
    const application = entry.id === 'layout'
      ? windowTitle.includes('390px') ? 'com.google.Chrome' : 'com.microsoft.VSCode'
      : entry.applications[index % entry.applications.length];
    return {
      id: `${entry.id}-event-${index}`,
      timestamp: new Date(Date.parse(entry.end) - (index + 1) * 20_000).toISOString(),
      application,
      applicationName: APP_NAMES[application] ?? application,
      windowTitle,
      kind: ['window.changed', 'keyboard.shortcut', 'mouse.click'][index % 3],
    };
  });
  return { entry, document: fixtureDocument(entry), events, eventTotal: events.length, rawAvailable: true, truncated: false };
}

type Scenario = 'populated' | 'empty' | 'expired' | 'corrupt' | 'detail-error' | 'cached-detail-error' | 'unsupported' | 'missing-model' | 'settings-error' | 'multi-day' | 'delete-error' | 'mixed-pending' | 'pending-summaries' | 'pending-summaries-idle' | 'summaries-disabled' | 'summary-failed';

type HistoryProbes = {
  onSettingsWrite(patch: Partial<ComputerHistorySettings>): void;
  onPermissionRequest(): void;
  onDetailRead(id: string): void;
  onTimelineRead(): void;
};

function fixtureService(scenario: Scenario, probes: HistoryProbes, applications?: readonly ComputerHistoryApplication[]): ModuleHubComputerHistoryService {
  let entries = scenario === 'empty' || scenario === 'unsupported' ? [] : [...fixtureEntries()];
  if (scenario === 'multi-day') entries.push(...entries.slice(-2).map((entry) => ({
    ...entry, id: `${entry.id}-yesterday`,
    start: new Date(Date.parse(entry.start) - 86_400_000).toISOString(),
    end: new Date(Date.parse(entry.end) - 86_400_000).toISOString(),
  })));
  if (scenario === 'mixed-pending') entries = [...fixturePendingEntries(), ...entries];
  const pendingOnly = ['pending-summaries', 'pending-summaries-idle', 'summaries-disabled', 'summary-failed'].includes(scenario);
  if (pendingOnly) entries = fixturePendingEntries();
  let status = structuredClone(STATUS);
  if (scenario === 'mixed-pending' || pendingOnly) {
    status = {
      ...status,
      state: scenario === 'pending-summaries' || scenario === 'pending-summaries-idle' ? 'running' : status.state,
      summaryState: scenario === 'summaries-disabled' ? 'disabled'
        : scenario === 'summary-failed' ? 'error'
          : scenario === 'pending-summaries-idle' ? 'idle' : 'running',
      ...(scenario === 'summary-failed' ? { summaryError: 'Synthetic analysis provider is temporarily unavailable.' } : {}),
      eventCount: entries.reduce((sum, entry) => sum + entry.eventCount, 0),
      settings: { ...status.settings, summariesEnabled: scenario !== 'summaries-disabled' },
    };
  }
  let corrupt = scenario === 'corrupt';
  let detailError = scenario === 'detail-error';
  let detailReads = 0;
  if (scenario === 'empty') {
    status = { ...status, state: 'stopped', eventCount: 0, settings: { ...status.settings, enabled: false } };
  } else if (scenario === 'missing-model') {
    status = { ...status, state: 'stopped', accessibilityGranted: false, inputMonitoringGranted: false, settings: { ...status.settings, enabled: false } };
  } else if (scenario === 'unsupported') {
    status = { ...status, state: 'unsupported', eventCount: 0, platformSupported: false, helperAvailable: false, settings: { ...status.settings, enabled: false } };
  }
  return {
    status: async () => structuredClone(status),
    applications: async (bundleIds) => bundleIds.map((bundleIdentifier) =>
      applications?.find((application) => application.bundleIdentifier === bundleIdentifier)
      ?? { bundleIdentifier, name: APP_NAMES[bundleIdentifier] ?? bundleIdentifier, iconDataUrl: null }),
    timeline: async () => {
      probes.onTimelineRead();
      if (corrupt) throw new Error('Synthetic summary archive could not be read.');
      return { status: structuredClone(status), entries: [...entries] };
    },
    detail: async (id) => {
      probes.onDetailRead(id);
      detailReads += 1;
      if (detailError || (scenario === 'cached-detail-error' && detailReads === 2)) throw new Error('Synthetic event segment could not be read.');
      const entry = entries.find((candidate) => candidate.id === id);
      if (!entry) return null;
      return scenario === 'expired'
        ? { entry, document: fixtureDocument(entry), events: [], eventTotal: 0, rawAvailable: false, truncated: false }
        : fixtureDetail(entry);
    },
    revealSummary: async () => { throw new Error('Synthetic summaries have no saved file to reveal in Finder.'); },
    updateSettings: async (patch) => {
      probes.onSettingsWrite(patch);
      if (scenario === 'settings-error') throw new Error('Synthetic settings write failed.');
      status = { ...status, settings: { ...status.settings, ...patch } };
      if (patch.enabled !== undefined) status = { ...status, state: patch.enabled ? 'running' : 'stopped' };
      return structuredClone(status.settings);
    },
    requestPermissions: async () => {
      probes.onPermissionRequest();
      return structuredClone(status);
    },
    pause: async () => {
      status = { ...status, state: 'paused' };
      return structuredClone(status);
    },
    resume: async () => {
      status = { ...status, state: 'running' };
      return structuredClone(status);
    },
    clear: async (scope) => {
      if (scenario === 'settings-error') throw new Error('Synthetic deletion failed.');
      const now = new Date();
      const threshold = scope === 'last_10_minutes' ? Date.now() - 600_000
        : scope === 'last_hour' ? Date.now() - 3_600_000
          : scope === 'today' ? new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
            : -Infinity;
      entries = entries.filter((entry) => Date.parse(entry.end) <= threshold);
      status = { ...status, eventCount: entries.reduce((sum, entry) => sum + entry.eventCount, 0) };
      if (scope === 'all') corrupt = false;
      return structuredClone(status);
    },
    deleteEntry: async (id) => {
      if (scenario === 'delete-error') throw new Error('Synthetic activity deletion failed.');
      entries = entries.filter((entry) => entry.id !== id);
      return structuredClone(status);
    },
    retrySummary: async () => {
      detailError = false;
      if (scenario === 'summary-failed') status = { ...status, summaryState: 'idle', summaryError: undefined };
      return structuredClone(status);
    },
    getAnalysisModel: async () => scenario === 'missing-model' ? null : 'Fixture provider / analysis-model',
  };
}

const SIDEBAR_SESSIONS: SessionSummary[] = [
  ['history-design', '电脑历史页面打磨'],
  ['release-check', '发布前回归检查'],
  ['evaluation-notes', '评测条件阅读笔记'],
].map(([id, name], index) => ({
  id, name, isFlagged: false, isArchived: false, labels: [], hasUnread: false,
  status: 'active', lastMessageAt: Date.parse(at('12:30')) - index * 3_600_000,
  backend: 'ai-sdk', llmConnectionSlug: 'fixture', connectionLocked: false,
  model: 'analysis-model', permissionMode: 'ask',
}));

function HistorySurface({ scenario, onCreateDraft, withSidebar = false, applications, ...probes }: {
  scenario: Scenario;
  onCreateDraft(text: string): void;
  withSidebar?: boolean;
  applications?: readonly ComputerHistoryApplication[];
} & HistoryProbes) {
  const { onSettingsWrite, onPermissionRequest, onDetailRead, onTimelineRead } = probes;
  const services = useMemo(() => createFakeModuleHubServices({ computerHistory: fixtureService(scenario, {
    onSettingsWrite, onPermissionRequest, onDetailRead, onTimelineRead,
  }, applications) }), [scenario, applications, onSettingsWrite, onPermissionRequest, onDetailRead, onTimelineRead]);
  const [collapsed, setCollapsed] = useState(false);
  const { settingsOpen, settingsRequest, openComputerHistorySettings, closeSettingsModal } = useSettingsModal();
  const [localeGate] = useState(createUiLocaleUpdateGate);
  const [connections] = useState(createDesktopConnectionSettingsServices);
  const content = (
    <AppShellDetailPanel agentsView="computer-history">
      <WorkbarTitlebarActions available={false} collapsed onToggle={() => {}} />
      <ComputerHistoryPage onCreateDraft={onCreateDraft} onOpenSettings={openComputerHistorySettings} isObscured={settingsOpen} />
    </AppShellDetailPanel>
  );
  // AppShell's unexported frame owns these classes, variables and mounted-hidden
  // navigation. The actual history, rail, detail wrapper and settings are imported.
  return <ToastProvider><ModuleHubServicesProvider services={services}>
    <div hidden={settingsOpen} inert={settingsOpen || undefined} aria-hidden={settingsOpen || undefined} style={{ display: settingsOpen ? 'none' : 'contents' }}>
    {withSidebar ? (
      <div className="appFrame agents-layout-root" data-maka-e2e-fixture="true" data-sidebar-state={collapsed ? 'collapsed' : 'expanded'} style={{ height: '100vh', minHeight: 640, '--maka-sidenav-width': '260px' } as CSSProperties}>
        <header className="maka-window-titlebar">
          <AppShellTopbarActions sidebarCollapsed={collapsed} onToggleSidebar={() => setCollapsed((value) => !value)} onOpenSearchModal={() => {}} />
        </header>
        <AstryxAppShell className="app maka-shell-astryx agents-layout-body" variant="elevated" height="fill" contentPadding={0} mobileNav={{ breakpoint: 'none', hasToggle: false }} sideNav={
          <SessionRail sessions={SIDEBAR_SESSIONS} selection={{ section: 'computer-history' }} collapsed={collapsed} onCollapsedChange={setCollapsed} width={260} onWidthChange={() => {}} minWidth={180} maxWidth={480} />
        }>
          {content}
        </AstryxAppShell>
      </div>
    ) : (
    <div className="app maka-shell-astryx" style={{ display: 'flex', height: '100vh', minHeight: 0, minWidth: 0 }}>
      {content}
    </div>
    )}
    </div>
    {settingsOpen ? <ConnectionSettingsServicesProvider services={connections}>
      <SettingsModal
        onClose={closeSettingsModal}
        onOpenComputerHistory={closeSettingsModal}
        request={settingsRequest}
        themePref="auto" onThemeChange={noop} themePalette="default" onThemePaletteChange={noop}
        onUiLocalePreferenceChange={noop} uiLocaleUpdateGate={localeGate}
        onDefaultPermissionModeChange={noop}
        archivedTasks={{ sessions: [], projects: [], onRestore: noop, onDelete: noop, onPurge: async () => { throw new Error('Archive mutation is outside this fixture'); } }}
        onTaskImported={noop} onRemoteHostAdded={noop} onSelectedRuntimeHostProfileIdChange={noop}
      />
    </ConnectionSettingsServicesProvider> : null}
  </ModuleHubServicesProvider></ToastProvider>;
}

async function openFirstActivity(canvasElement: HTMLElement, evidence = false) {
  const canvas = within(canvasElement);
  const row = await canvas.findByRole('button', { name: /检查电脑历史的独立页面布局/ });
  await userEvent.click(row);
  if (evidence) {
    await userEvent.click(canvas.getByRole('button', { name: /查看记录依据|查看記錄依據|View recorded evidence/ }));
    await waitFor(() => expect(canvas.getByRole('tabpanel')).toHaveAttribute('aria-busy', 'false'));
  }
  return canvas;
}

async function openHistorySettings(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole('button', { name: /电脑历史设置|電腦歷史設定|Computer history settings/ }));
  const settings = await canvas.findByRole('region', { name: '电脑历史' });
  await waitFor(() => expect(within(settings).getByRole('button', { name: '刷新状态' })).toBeEnabled());
  await waitFor(() => expect(settings).not.toHaveTextContent('正在读取状态'));
  return within(settings);
}

async function closeReader(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: /关闭活动详情|關閉活動詳情|Close activity/ }));
  await waitFor(() => {
    expect(canvasElement.querySelector('.computer-history-detail')).toBeNull();
    expect(canvasElement.querySelector('.computer-history-row[aria-current="true"] button')).toHaveFocus();
  });
}

async function expectSummaryEmpty(canvasElement: HTMLElement, args: HistoryProbes, heading: RegExp) {
  const canvas = within(canvasElement);
  await canvas.findByRole('heading', { level: 2, name: heading });
  expect(canvasElement.querySelectorAll('.computer-history-empty')).toHaveLength(1);
  expect(canvasElement.querySelectorAll('.computer-history-row')).toHaveLength(0);
  expect(canvasElement.querySelector('.computer-history-detail')).toBeNull();
  expect(canvasElement.querySelector('.computer-history-filters')).toBeNull();
  expect(args.onDetailRead).not.toHaveBeenCalled();
  expect(args.onSettingsWrite).not.toHaveBeenCalled();
  expect(args.onPermissionRequest).not.toHaveBeenCalled();
  return canvas;
}

function syntaxTokens(root: Element): string[] {
  const spans = [...root.querySelectorAll('[class*="astryx-token-"]')].map((token) => token.textContent ?? '');
  const highlights = (CSS as typeof CSS & { highlights?: Map<string, Iterable<Range>> }).highlights;
  const ranges = [...(highlights?.values() ?? [])].flatMap((highlight) => [...highlight])
    .filter((range) => root.contains(range.startContainer)).map((range) => range.toString());
  return [...spans, ...ranges];
}

// Real path: sidebar -> Computer History, with six saved summaries and recording paused.
export const Populated: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('button', { name: /检查电脑历史的独立页面布局/ });
    expect(canvasElement.querySelectorAll('.computer-history-row')).toHaveLength(6);
    expect(canvasElement.querySelector('.computer-history-detail')).toBeNull();
    expect(args.onDetailRead).not.toHaveBeenCalled();
    const group = canvas.getByRole('button', { name: /今天 6 段活动/ });
    await userEvent.click(group);
    expect(group).toHaveAttribute('aria-expanded', 'false');
    expect(canvasElement.querySelectorAll('.computer-history-row')).toHaveLength(0);
    expect(canvasElement.querySelector('.computer-history-empty')).toBeNull();
    await userEvent.click(group);
    // Expanding mounts new ListItems, so use the current buttons for roving focus.
    const currentRows = Array.from(canvasElement.querySelectorAll<HTMLElement>('.computer-history-row'));
    const currentControls = currentRows.map((row) => row.querySelector<HTMLButtonElement>('button')!);
    currentControls[0].focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(currentControls[1]).toHaveFocus();
    expect(canvasElement.querySelector('.computer-history-detail')).toBeNull();
    await userEvent.keyboard('{End}');
    expect(currentControls.at(-1)).toHaveFocus();
    await userEvent.keyboard('{Home}{ArrowDown}{Enter}');
    await waitFor(() => expect(canvasElement.querySelector('.computer-history-detail')).toHaveAccessibleName('核对采集与模型摘要的授权边界'));
    await closeReader(canvasElement);
    expect(currentControls[1]).toHaveFocus();
    await userEvent.click(currentControls[0]);
    await waitFor(() => expect(canvas.getByRole('region', { name: /摘要文档|摘要文件|Summary document/ }).querySelector('table')).not.toBeNull());
    const detail = canvasElement.querySelector<HTMLElement>('.computer-history-detail')!;
    detail.scrollTop = detail.scrollHeight;
    expect(detail.scrollTop).toBeGreaterThan(0);
    await closeReader(canvasElement);
    await userEvent.click(currentControls[1]);
    await waitFor(() => {
      const next = canvasElement.querySelector<HTMLElement>('.computer-history-detail')!;
      expect(next).toHaveAccessibleName('核对采集与模型摘要的授权边界');
      expect(next.scrollTop).toBe(0);
    });
    await closeReader(canvasElement);
    const search = canvas.getByRole('textbox', { name: /搜索摘要或应用|搜尋摘要或應用程式|Search summaries or apps/ });
    await userEvent.type(search, 'nothing-matches-this-fixture');
    await waitFor(() => expect(canvasElement.querySelectorAll('.computer-history-row')).toHaveLength(0));
    await userEvent.click(canvas.getByRole('button', { name: /清除筛选|清除篩選|Clear filters/ }));
    expect(search).toHaveValue('');
    await waitFor(() => expect(canvasElement.querySelectorAll('.computer-history-row')).toHaveLength(6));
    expect(canvasElement.querySelector('.computer-history-detail')).toBeNull();
    await openFirstActivity(canvasElement);
    expect(canvas.getByRole('button', { name: /查看记录依据|查看記錄依據|View recorded evidence/ })).toHaveAttribute('aria-expanded', 'false');
    const document = await canvas.findByRole('region', { name: /摘要文档|摘要文件|Summary document/ });
    await waitFor(() => expect(within(document).getByRole('table')).toBeVisible());
    expect(document.querySelector('blockquote')).not.toBeNull();
    expect(document.querySelectorAll('li').length).toBeGreaterThanOrEqual(6);
    await waitFor(() => expect(syntaxTokens(document)).toContain('const'));
    const page = canvasElement.querySelector('.computer-history-page')!;
    expect(page.scrollWidth).toBeLessThanOrEqual(page.clientWidth + 1);
    await closeReader(canvasElement);
    expect(args.onSettingsWrite).not.toHaveBeenCalled();
    expect(args.onCreateDraft).not.toHaveBeenCalled();
  },
};

// Real path: sidebar -> Computer History -> select model summary -> Source.
export const DocumentSource: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await openFirstActivity(canvasElement);
    const document = await canvas.findByRole('region', { name: /摘要文档|摘要文件|Summary document/ });
    const source = within(document).getByRole('radio', { name: /源码|原始碼|Source/ });
    await userEvent.click(source);
    expect(source).toBeChecked();
    await waitFor(() => expect(document.querySelector('code')).toHaveTextContent('"version":1'));
    expect(document.querySelector('code')).toHaveTextContent('```ts');
    await waitFor(() => expect(syntaxTokens(document).length).toBeGreaterThan(5));
  },
};

// Real path: sidebar -> Computer History -> select activity -> expand recorded evidence.
export const RecordedEvents: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await openFirstActivity(canvasElement, true);
    expect(canvasElement.querySelectorAll('.computer-history-events li')).toHaveLength(5);
    await userEvent.click(canvas.getByRole('button', { name: /展开更多事件|展開更多事件|Show more events/ }));
    expect(canvasElement.querySelectorAll('.computer-history-events li')).toHaveLength(18);
    await userEvent.click(canvas.getByRole('button', { name: /收起事件|Show fewer events/ }));
    expect(canvasElement.querySelectorAll('.computer-history-events li')).toHaveLength(5);
  },
};

// Real path: global sidebar -> Computer History, keeping task history visible in the rail.
export const GlobalSidebar: Story = {
  args: { withSidebar: true },
};

// Real path: sidebar -> Computer History with saved summaries and two newer unsummarized fragments.
export const MixedPending: Story = {
  args: { scenario: 'mixed-pending', withSidebar: true },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('button', { name: /检查电脑历史的独立页面布局/ });
    expect(canvasElement.querySelectorAll('.computer-history-row')).toHaveLength(6);
    expect(canvas.queryByRole('button', { name: /VS Code · computer-history-page\.tsx|Chrome · Computer History · 390px/ })).toBeNull();
    expect(canvas.getByRole('button', { name: /恢复记录|恢復記錄|Resume recording/ })).toBeVisible();
    const search = canvas.getByRole('textbox', { name: /搜索摘要或应用|搜尋摘要或應用程式|Search summaries or apps/ });
    await userEvent.type(search, 'computer-history-page.tsx');
    await waitFor(() => expect(canvasElement.querySelectorAll('.computer-history-row')).toHaveLength(0));
    await userEvent.click(canvas.getByRole('button', { name: /清除筛选|清除篩選|Clear filters/ }));
    await waitFor(() => expect(canvasElement.querySelectorAll('.computer-history-row')).toHaveLength(6));
    expect(search).toHaveValue('');
    expect(canvasElement.querySelector('.computer-history-detail')).toBeNull();
    expect(args.onDetailRead).not.toHaveBeenCalled();
    expect(args.onSettingsWrite).not.toHaveBeenCalled();
    expect(args.onPermissionRequest).not.toHaveBeenCalled();
  },
};

// Real path: sidebar -> Computer History -> select activity -> Applications & windows.
export const ApplicationsAndWindows: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await openFirstActivity(canvasElement, true);
    const tabs = canvas.getAllByRole('tab');
    tabs[0].focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(tabs[1]).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(tabs[1]).toHaveAttribute('aria-selected', 'true'));
    expect(tabs[1]).toHaveFocus();
    expect(canvas.getByRole('tabpanel')).toHaveTextContent('com.microsoft.VSCode');
    expect(canvas.getByRole('tabpanel')).toHaveTextContent('Computer History · 390px');
  },
};

// Real path: sidebar -> Computer History -> select activity -> Add to chat draft.
export const EditableDraft: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = await openFirstActivity(canvasElement);
    const body = within(canvasElement.ownerDocument.body);
    const opener = canvas.getByRole('button', { name: /加入对话草稿|加入對話草稿|Add to chat draft/ });
    await userEvent.click(opener);
    let dialog = await body.findByRole('dialog');
    let input = within(dialog).getByRole('textbox');
    await userEvent.type(input, '\n请先核对证据，不要自动执行。');
    expect((input as HTMLTextAreaElement).value).toContain('<computer-history-context trust="untrusted-observed-ui">');
    expect(args.onCreateDraft).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: /取消|Cancel/ }));
    expect(args.onCreateDraft).not.toHaveBeenCalled();
    await waitFor(() => expect(opener).toHaveFocus());
    await userEvent.click(opener);
    dialog = await body.findByRole('dialog');
    input = within(dialog).getByRole('textbox');
    await userEvent.type(input, '\n只创建草稿，不发送。');
    const edited = (input as HTMLTextAreaElement).value;
    await userEvent.click(within(dialog).getByRole('button', { name: /加入草稿|Add draft/ }));
    expect(args.onCreateDraft).toHaveBeenCalledTimes(1);
    expect(args.onCreateDraft).toHaveBeenCalledWith(edited);
    await userEvent.click(opener);
    dialog = await body.findByRole('dialog');
    input = within(dialog).getByRole('textbox');
    await userEvent.type(input, '\n请先核对证据，不要自动执行。');
    expect(args.onCreateDraft).toHaveBeenCalledTimes(1);
  },
};

// Real path: sidebar -> Computer History -> settings, no model or recording consent.
export const PermissionsWithoutModel: Story = {
  args: { scenario: 'missing-model' },
  play: async ({ canvasElement, args }) => {
    const content = await openHistorySettings(canvasElement);
    const canvas = within(canvasElement);
    const summaries = content.getByRole('switch', { name: /允许模型生成摘要|允許模型產生摘要|Allow model summaries/ });
    expect(summaries).toHaveAttribute('aria-disabled', 'true');
    for (const control of content.getAllByRole('switch')) expect(control).not.toBeChecked();
    await userEvent.click(content.getByRole('button', { name: '申请 macOS 权限' }));
    await content.findByText(/已完成权限申请/);
    await userEvent.click(content.getByRole('button', { name: '刷新状态' }));
    await userEvent.click(content.getByRole('button', { name: '打开历史' }));
    await canvas.findByRole('button', { name: /检查电脑历史的独立页面布局/ });
    const reopened = await openHistorySettings(canvasElement);
    for (const control of reopened.getAllByRole('switch')) expect(control).not.toBeChecked();
    expect(args.onPermissionRequest).toHaveBeenCalledTimes(1);
    expect(args.onSettingsWrite).not.toHaveBeenCalled();
  },
};

// Real path: history reader -> settings -> return, retaining the mounted reader.
export const Settings: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = await openFirstActivity(canvasElement);
    const document = await canvas.findByRole('region', { name: '摘要文档' });
    await waitFor(() => expect(syntaxTokens(document)).toContain('const'));
    const detail = canvasElement.querySelector<HTMLElement>('.computer-history-detail')!;
    const master = canvasElement.querySelector<HTMLElement>('.computer-history-master')!;
    detail.scrollTop = 240;
    master.scrollTop = 80;
    const readingPosition = detail.scrollTop;
    const listPosition = master.scrollTop;
    expect(readingPosition).toBeGreaterThan(0);
    const readsBeforeSettings = args.onTimelineRead.mock.calls.length;
    let settings = await openHistorySettings(canvasElement);
    await userEvent.click(settings.getByRole('button', { name: '打开历史' }));
    await waitFor(() => {
      expect(canvasElement.querySelector('.computer-history-detail')).toBe(detail);
      expect(detail.scrollTop).toBe(readingPosition);
      expect(master.scrollTop).toBe(listPosition);
      expect(args.onTimelineRead.mock.calls.length).toBeGreaterThan(readsBeforeSettings);
      expect(canvas.getByRole('button', { name: '电脑历史设置' })).toHaveFocus();
    });
    settings = await openHistorySettings(canvasElement);
    await userEvent.click(settings.getByRole('button', { name: '配置' }));
    await waitFor(() => expect(readAnalysisConfig).toHaveBeenCalledWith({ profileId: 'local', hostId: 'synthetic-local-host' }));
    expect(readAnalysisConfig.mock.calls.every(([host]) => host.profileId === 'local')).toBe(true);
    await userEvent.click(canvasElement.querySelector<HTMLElement>('[data-maka-assistant-target="settings.computer-history"]')!);
    settings = within(await canvas.findByRole('region', { name: '电脑历史' }));
    expect(settings.getByRole('switch', { name: '包含文本内容' })).not.toBeChecked();
    expect(settings.getByRole('switch', { name: '允许模型生成摘要' })).not.toBeChecked();
    expect(args.onSettingsWrite).not.toHaveBeenCalled();
    await userEvent.click(await settings.findByRole('button', { name: '最近使用的应用' }));
    await userEvent.click(await within(canvasElement.ownerDocument.body).findByRole('option', { name: /VS Code/ }));
    await settings.findByRole('button', { name: '移除 com.microsoft.VSCode' });
    expect(args.onSettingsWrite).toHaveBeenCalledTimes(1);
    expect(args.onSettingsWrite).toHaveBeenCalledWith({ blockedApplications: ['com.microsoft.VSCode'] });
    expect(settings.getByRole('switch', { name: '包含文本内容' })).not.toBeChecked();
    expect(settings.getByRole('switch', { name: '允许模型生成摘要' })).not.toBeChecked();
  },
};

// Real path: history with retained summaries spanning multiple calendar days.
export const MultipleDays: Story = {
  args: { scenario: 'multi-day' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const yesterday = await canvas.findByRole('button', { name: /昨天 2 段活动/ });
    expect(canvasElement.querySelectorAll('.computer-history-day')).toHaveLength(2);
    expect(canvasElement.querySelectorAll('.computer-history-row')).toHaveLength(8);
    await userEvent.click(yesterday);
    expect(canvasElement.querySelectorAll('.computer-history-row')).toHaveLength(6);
    expect(canvasElement.querySelector('.computer-history-empty')).toBeNull();
    await userEvent.click(yesterday);
    expect(canvasElement.querySelectorAll('.computer-history-row')).toHaveLength(8);
  },
};

// Real path: settings -> excluded source fails to save -> delete fails to confirm.
export const SettingsWriteError: Story = {
  args: { scenario: 'settings-error' },
  play: async ({ canvasElement }) => {
    const settings = await openHistorySettings(canvasElement);
    await userEvent.click(settings.getByRole('tab', { name: '网站' }));
    const input = settings.getByRole('textbox', { name: '网站域名' });
    await userEvent.type(input, 'private.example.test');
    await userEvent.click(settings.getByRole('button', { name: '添加' }));
    await waitFor(() => expect(settings.getByRole('alert')).toHaveTextContent('Synthetic settings write failed.'));
    expect(input).toHaveValue('private.example.test');
    await userEvent.click(settings.getByRole('button', { name: '删除历史' }));
    const confirmation = await within(canvasElement.ownerDocument.body).findByRole('alertdialog');
    await userEvent.click(within(confirmation).getByRole('button', { name: '删除' }));
    await waitFor(() => expect(confirmation).toHaveTextContent('Synthetic deletion failed.'));
    expect(confirmation).toBeVisible();
    await waitFor(() => expect(confirmation.contains(document.activeElement)).toBe(true));
  },
};

// Real path: history -> select activity -> deletion rejected by local storage.
export const ActivityDeleteError: Story = {
  args: { scenario: 'delete-error' },
  play: async ({ canvasElement }) => {
    const canvas = await openFirstActivity(canvasElement);
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole('button', { name: '删除此活动' }));
    let confirmation = await body.findByRole('alertdialog');
    await userEvent.click(within(confirmation).getByRole('button', { name: '永久删除' }));
    await waitFor(() => {
      expect(confirmation).toHaveTextContent('Synthetic activity deletion failed.');
      expect(confirmation.contains(document.activeElement)).toBe(true);
    });
    await userEvent.click(within(confirmation).getByRole('button', { name: '取消' }));
    expect(canvasElement.querySelectorAll('.computer-history-row')).toHaveLength(6);
    await userEvent.click(canvas.getByRole('button', { name: '删除此活动' }));
    confirmation = await body.findByRole('alertdialog');
    await userEvent.click(within(confirmation).getByRole('button', { name: '永久删除' }));
    await waitFor(() => {
      expect(confirmation).toHaveTextContent('Synthetic activity deletion failed.');
      expect(confirmation.contains(document.activeElement)).toBe(true);
    });
  },
};

// Real path: sidebar -> Computer History, after retained raw events expire but summaries remain.
export const ExpiredEvidence: Story = {
  args: { scenario: 'expired' },
  play: async ({ canvasElement }) => {
    const canvas = await openFirstActivity(canvasElement, true);
    expect(canvas.getByRole('tabpanel')).toHaveTextContent(/原始证据已不可用|原始證據已無法取得|Raw evidence is no longer available/);
  },
};

// Real path: sidebar -> Computer History while the first recorded fragments are being summarized.
export const PendingSummaries: Story = {
  args: { scenario: 'pending-summaries' },
  play: async ({ canvasElement, args }) => {
    await expectSummaryEmpty(canvasElement, args, /正在生成摘要|正在產生摘要|Generating summary/);
  },
};

// Real path: sidebar -> Computer History after recording, before the summary worker starts.
export const PendingSummariesIdle: Story = {
  args: { scenario: 'pending-summaries-idle' },
  play: async ({ canvasElement, args }) => {
    await expectSummaryEmpty(canvasElement, args, /等待活动摘要|等待活動摘要|Waiting for activity summaries/);
  },
};

// Real path: sidebar -> Computer History with raw records retained and model-summary consent off.
export const SummariesDisabled: Story = {
  args: { scenario: 'summaries-disabled' },
  play: async ({ canvasElement, args }) => {
    await expectSummaryEmpty(canvasElement, args, /模型摘要已关闭|模型摘要已關閉|Model summaries off/);
  },
};

// Real path: sidebar -> Computer History after the first summary attempt fails at the analysis provider.
export const SummaryFailed: Story = {
  args: { scenario: 'summary-failed' },
  play: async ({ canvasElement, args }) => {
    const canvas = await expectSummaryEmpty(canvasElement, args, /摘要生成失败|摘要產生失敗|Summary failed/);
    expect(canvas.getByRole('alert')).toHaveTextContent('Synthetic analysis provider is temporarily unavailable.');
    expect(canvas.getByRole('button', { name: /重试摘要|重試摘要|Retry summary/ })).toBeEnabled();
  },
};

// Real path: sidebar -> Computer History, when summary storage cannot be read.
export const CorruptArchive: Story = {
  args: { scenario: 'corrupt' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText('Synthetic summary archive could not be read.');
    const settings = await openHistorySettings(canvasElement);
    expect(settings.getByRole('button', { name: '删除历史' })).toBeEnabled();
  },
};

// Real path: sidebar -> Computer History -> select activity whose event file cannot be read.
export const EvidenceReadError: Story = {
  args: { scenario: 'detail-error' },
  play: async ({ canvasElement }) => {
    const canvas = await openFirstActivity(canvasElement, true);
    expect(canvas.getByRole('tabpanel')).toHaveTextContent('Synthetic event segment could not be read.');
  },
};

// Real path: sidebar -> Computer History -> Source -> refresh fails after a successful read.
export const CachedDocumentReadError: Story = {
  args: { scenario: 'cached-detail-error' },
  play: async ({ canvasElement, args }) => {
    const canvas = await openFirstActivity(canvasElement);
    const summary = await canvas.findByRole('region', { name: '摘要文档' });
    const source = within(summary).getByRole('radio', { name: '源码' });
    await userEvent.click(source);
    await waitFor(() => expect(syntaxTokens(summary).length).toBeGreaterThan(5));
    const reader = canvasElement.querySelector<HTMLElement>('.computer-history-detail')!;
    reader.scrollTop = 260;
    expect(reader.scrollTop).toBe(260);
    // Keyboard activation does not scroll the reader to bring the toolbar into view.
    canvas.getByRole('button', { name: /^刷新历史$/ }).focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(canvas.getByRole('alert')).toHaveTextContent('Synthetic event segment could not be read.'));
    expect(canvas.getByRole('region', { name: '摘要文档' })).toBe(summary);
    expect(source).toBeChecked();
    expect(reader.scrollTop).toBe(260);
    expect(args.onDetailRead).toHaveBeenCalledTimes(2);
    expect(args.onSettingsWrite).not.toHaveBeenCalled();
  },
};

// Real path: sidebar -> Computer History before first opt-in, with no recorded activity.
export const FirstUse: Story = {
  args: { scenario: 'empty' },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('button', { name: /设置记录|設定記錄|Set up recording/ });
    expect(canvasElement.querySelectorAll('.computer-history-empty')).toHaveLength(1);
    expect(canvasElement.querySelector('.computer-history-detail')).toBeNull();
    expect(args.onDetailRead).not.toHaveBeenCalled();
    expect(args.onSettingsWrite).not.toHaveBeenCalled();
  },
};

// Real path: sidebar -> Computer History on a platform without native recording support.
export const UnsupportedPlatform: Story = {
  args: { scenario: 'unsupported' },
};
