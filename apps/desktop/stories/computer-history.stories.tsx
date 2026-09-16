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
import { DEFAULT_DAILY_REVIEW_CONFIG, type DailyReviewConfig } from '@maka/core/daily-review';
import type { ProjectedLlmConnection } from '@maka/core/llm-connections';
import type { DesktopRuntimeHostProfileSnapshot } from '../src/preload/bridge-contract';
import type {
  ComputerHistoryApplication,
  ComputerHistoryDetail,
  ComputerHistoryEventEvidence,
  ComputerHistoryStatus,
  ComputerHistorySettings,
  ComputerHistoryTimelineEntry,
} from '@maka/core/computer-history';
import { computerHistorySearchExcerpt } from '@maka/core/computer-history';
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
import { createDesktopModuleHubServices, type DesktopModuleHubBridge } from '../src/renderer/platform/desktop/create-module-hub-services';
import { createUiLocaleUpdateGate } from '../src/renderer/settings/ui-locale-update-gate';
import { withScopedMakaBridge } from './maka-bridge';
import {
  OverlaysRoot,
  OverlaysServicesProvider,
  type OverlaysShellProjection,
} from '../src/renderer/features/overlays';
import { createFakeOverlaysServices } from '../src/renderer/features/overlays/testing';
import { safeLocalStorageSet } from '../src/renderer/browser-storage';
import { OS_PERMISSION_IDS, type PermissionSnapshot } from '@maka/core/capabilities';

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
const analysisConnection: ProjectedLlmConnection = {
  connectionId: 'synthetic-analysis', name: 'Fixture provider', slug: 'fixture',
  providerType: 'openai', enabled: true, createdAt: 0, updatedAt: 0,
  defaultModel: 'analysis-model', enabledModelIds: ['analysis-model', 'alternate-analysis'],
  catalogEntries: [
    { id: 'analysis-model', displayName: 'Analysis model', canUseAsChatDefault: true, isDefault: true, supportsVision: false, thinkingLevels: [] },
    { id: 'alternate-analysis', displayName: 'Alternate analysis', canUseAsChatDefault: true, isDefault: false, supportsVision: false, thinkingLevels: [] },
  ],
};
let analysisConfig: DailyReviewConfig = { ...DEFAULT_DAILY_REVIEW_CONFIG };
let analysisConnections: ProjectedLlmConnection[] = [analysisConnection];
let historyPermissionsGranted = true;
let onPermissionAction: () => void = noop;
const permissionAction = async () => {
  onPermissionAction();
  return { ok: true as const };
};
const readAnalysisConfig = fn(async (_host: { profileId: string; hostId: string }) => structuredClone(analysisConfig));
const writeAnalysisConfig = fn(async (patch: Partial<DailyReviewConfig>, _host: { profileId: string; hostId: string }) => {
  analysisConfig = { ...analysisConfig, ...patch };
  return structuredClone(analysisConfig);
});
const settingsBridge = {
  settings: {
    getClient: async () => settingsSnapshot,
    get: async () => ({ ...settingsSnapshot, network: { proxy: { ...settingsSnapshot.network.proxy, passwordConfigured: false } } }),
    subscribeClientChanged: subscription,
    subscribeExternalChanged: subscription,
    usageStats: async () => null,
  },
  runtimeHostProfiles: { getSnapshot: async () => settingsHosts, subscribeChanges: subscription },
  connections: {
    getSnapshot: async () => ({ connections: structuredClone(analysisConnections), defaultConnection: analysisConnections[0]?.slug ?? null }),
    subscribeEvents: subscription, hasSecret: async () => true, getRequestHeaders: async () => [],
  },
  dailyReview: { getConfig: readAnalysisConfig, setConfig: writeAnalysisConfig },
  permissions: {
    getSnapshot: async (): Promise<PermissionSnapshot> => ({
      checkedAt: Date.now(), platform: 'darwin',
      permissions: Object.fromEntries(OS_PERMISSION_IDS.map((id) => {
        const historyRequired = id === 'accessibility' || id === 'input_monitoring';
        const status = historyRequired && !historyPermissionsGranted ? 'not_determined' : 'granted';
        return [id, {
          id, status, source: 'platform', checkedAt: Date.now(), canOpenSettings: true, canRequest: true,
          ...(historyRequired ? { consumers: { activity_recorder: { status } } } : {}),
        }];
      })) as PermissionSnapshot['permissions'],
    }),
    requestAccess: permissionAction, openSystemSettings: permissionAction, startDragOnboarding: permissionAction,
  },
  capabilities: { getSnapshot: async () => ({ checkedAt: Date.now(), capabilities: [] }) },
};

const meta = {
  title: 'Product/Computer History',
  component: HistorySurface,
  decorators: [withScopedMakaBridge(settingsBridge)],
  beforeEach: ({ args }) => {
    localStorage.removeItem('maka-computer-history-granularity-v1');
    analysisConfig = { ...DEFAULT_DAILY_REVIEW_CONFIG };
    analysisConnections = args.scenario === 'missing-model' ? [] : [analysisConnection];
    historyPermissionsGranted = args.scenario !== 'missing-model';
    onPermissionAction = args.onPermissionRequest;
    readAnalysisConfig.mockClear();
    writeAnalysisConfig.mockClear();
  },
  parameters: { layout: 'fullscreen' },
  args: {
    scenario: 'populated', withSidebar: false, onCreateDraft: fn(),
    onSettingsWrite: fn(), onPermissionRequest: fn(), onDetailRead: fn(), onTimelineRead: fn(),
    onSummaryRetry: fn(),
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
    keywords: ['Computer History', '可访问性', '界面回归'],
    documentName: '2026-09-14_12-20__10min__界面布局-synthetic.md',
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

const GRANULARITY_ACTIVITIES = [
  { day: -1, time: '23:40', title: '核对午夜前的摘要来源', description: '阅读摘要索引，检查保存的来源与时间边界。', body: '索引记录了三个来源片段；第二个片段包含切换窗口的时间，仍需与采集记录逐项核对。' },
  { day: -1, time: '23:50', title: '整理午夜前的验证记录', description: '整理截至午夜的检查记录和待办。', body: '记录恰好结束于 00:00。尚未运行完整回归，待办中保留了日期筛选和滚动位置两项检查。' },
  { day: 0, time: '00:10', title: '复查午夜后的阅读位置', description: '回到浏览器检查切换视图后的阅读位置。', body: '浏览器停留在文档的观察依据段落。切换粒度后应保留这段正文与当前阅读位置。' },
  { day: 0, time: '01:10', title: '整理跨日筛选的复查结论', description: '对照两天的记录，整理跨午夜筛选的复查项。', body: '01:10 的文档属于午夜之后的本地日期，同时保留在昨晚 20:00 开始的六小时总览中。' },
  { day: 0, time: '08:10', title: '检查早间构建日志', description: '打开早间构建日志，尚未保存六小时总览。', body: '日志中看到资源复制和类型检查阶段；没有找到最终退出码，不能判断整个构建已经成功。' },
  { day: 0, time: '08:20', title: '记录早间回归待办', description: '补充早间回归待办，等待后续总览。', body: '待办包含浅色页面、侧边栏和全天文档的检查。尚未观察到执行或完成通知。' },
] as const;
const GRANULARITY_OVERVIEW = '复查电脑历史的跨日阅读与来源';
const GRANULARITY_OVERVIEW_BODY = '本总览引用午夜前后四份已保存的十分钟摘要。早间的两份文档尚未纳入总览；这里没有推断回归已通过。';
const GRANULARITY_RAW_TITLE = 'Chrome · 早间未整理的窗口片段';

function granularityEntries(): ComputerHistoryTimelineEntry[] {
  // Shanghai midnight falls inside the UTC-aligned 12:00-18:00 window (20:00-02:00).
  const shanghaiTime = (dayOffset: number, time: string) => {
    const date = new Date();
    date.setDate(date.getDate() + dayOffset);
    const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    return new Date(`${day}T${time}:00+08:00`).toISOString();
  };
  const leaves: ComputerHistoryTimelineEntry[] = GRANULARITY_ACTIVITIES.map((activity, index) => {
    const start = shanghaiTime(activity.day, activity.time);
    return {
      id: `10min-${Date.parse(start)}`, start,
      end: new Date(Date.parse(start) + 600_000).toISOString(),
      title: activity.title, description: activity.description,
      applications: index < 2 ? ['com.microsoft.VSCode'] : ['com.google.Chrome', 'com.apple.Terminal'],
      eventCount: 6, suppressedEventCount: 0, summaryLevel: '10min',
      contextMarkdown: `<computer-history-context trust="untrusted-observed-ui">\n${activity.title}\n${activity.description}\n</computer-history-context>`,
    };
  });
  const start = shanghaiTime(-1, '20:00');
  const parent: ComputerHistoryTimelineEntry = {
    id: `6h-${Date.parse(start)}`, start, end: shanghaiTime(0, '02:00'),
    title: GRANULARITY_OVERVIEW,
    description: '汇集午夜前后的来源核对、阅读位置与日期筛选检查，保留各段记录中的未决项。',
    summaryLevel: '6h', summaryChildren: leaves.slice(0, 4).map((entry) => entry.id),
    applications: ['com.microsoft.VSCode', 'com.google.Chrome', 'com.apple.Terminal'],
    eventCount: 24, suppressedEventCount: 0,
    contextMarkdown: `<computer-history-context trust="untrusted-observed-ui">\n${GRANULARITY_OVERVIEW}\n${GRANULARITY_OVERVIEW_BODY}\n</computer-history-context>`,
  };
  const raw: ComputerHistoryTimelineEntry = {
    id: 'granularity-raw', start: shanghaiTime(0, '08:31'), end: shanghaiTime(0, '08:32'),
    title: GRANULARITY_RAW_TITLE, description: '尚未生成摘要的窗口切换记录。',
    applications: ['com.google.Chrome'], eventCount: 2, suppressedEventCount: 0,
    contextMarkdown: '<computer-history-context trust="untrusted-observed-ui">尚未生成摘要的窗口切换记录。</computer-history-context>',
  };
  return [raw, ...leaves.toReversed(), parent];
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
    summaryTextEnabled: false,
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
  const granularityActivity = GRANULARITY_ACTIVITIES.find((activity) => activity.title === entry.title);
  const granularityBody = entry.title === GRANULARITY_OVERVIEW ? GRANULARITY_OVERVIEW_BODY : granularityActivity?.body;
  const body = granularityBody ? [
    '## 观察依据', '', granularityBody, '', '### 待核对', '',
    '- 保留原始时间与应用来源。',
    '- 未记录到完成通知的事项仍需人工确认。',
  ].join('\n') : entry.id === 'layout' ? [
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
    ...(entry.documentName ? { filename: entry.documentName } : {}),
    start: entry.start, end: entry.end, applications: entry.applications,
    eventCount: entry.eventCount, sourceIds: entry.summaryChildren ?? [`synthetic-${entry.id}-segment`],
    content: { title: entry.title, description: entry.description, ...(entry.keywords ? { keywords: entry.keywords } : {}), ...(entry.suggestion ? { suggestion: entry.suggestion } : {}) },
  };
  return { name: entry.documentName ?? `${entry.summaryLevel}-${Date.parse(entry.start)}.md`, markdown: `---\n${JSON.stringify(header)}\n---\n${body}\n`, body };
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

type Scenario = 'populated' | 'empty' | 'expired' | 'corrupt' | 'detail-error' | 'cached-detail-error' | 'unsupported' | 'missing-model' | 'settings-error' | 'multi-day' | 'granularity' | 'delete-error' | 'mixed-pending' | 'pending-summaries' | 'pending-summaries-idle' | 'summaries-disabled' | 'summary-failed';

type HistoryProbes = {
  onSettingsWrite(patch: Partial<ComputerHistorySettings>): void;
  onPermissionRequest(): void;
  onDetailRead(id: string): void;
  onTimelineRead(): void;
  onSummaryRetry(): void;
};

function fixtureService(scenario: Scenario, probes: HistoryProbes, applications?: readonly ComputerHistoryApplication[]): ModuleHubComputerHistoryService {
  const analysis = createDesktopModuleHubServices(settingsBridge as unknown as DesktopModuleHubBridge).computerHistory;
  let entries = scenario === 'empty' || scenario === 'unsupported' ? [] : [...fixtureEntries()];
  if (scenario === 'granularity') entries = granularityEntries();
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
    getViewGranularity: analysis.getViewGranularity,
    setViewGranularity: analysis.setViewGranularity,
    status: async () => structuredClone(status),
    applications: async (bundleIds) => bundleIds.map((bundleIdentifier) =>
      applications?.find((application) => application.bundleIdentifier === bundleIdentifier)
      ?? { bundleIdentifier, name: APP_NAMES[bundleIdentifier] ?? bundleIdentifier, iconDataUrl: null }),
    timeline: async (_days, query) => {
      probes.onTimelineRead();
      if (corrupt) throw new Error('Synthetic summary archive could not be read.');
      return { status: structuredClone(status), entries: entries.map((entry) => query
        ? { ...entry, searchText: computerHistorySearchExcerpt(fixtureDocument(entry)?.body ?? '', query) } : entry) };
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
      probes.onSummaryRetry();
      detailError = false;
      if (scenario === 'summary-failed') status = { ...status, summaryState: 'idle', summaryError: undefined };
      return structuredClone(status);
    },
    getAnalysisModel: analysis.getAnalysisModel,
    setAnalysisModel: analysis.setAnalysisModel,
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

type HistorySurfaceProps = {
  scenario: Scenario;
  onCreateDraft(text: string): void;
  withSidebar?: boolean;
  applications?: readonly ComputerHistoryApplication[];
} & HistoryProbes;

function HistorySurface(props: HistorySurfaceProps) {
  const [services] = useState(() => createFakeOverlaysServices({
    settingsSection: { persist: (section) => safeLocalStorageSet('maka-settings-section-v1', section) },
    focus: { blurActiveElement: () => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    } },
  }));
  return <OverlaysServicesProvider services={services}><OverlaysRoot>
    {(overlays) => <HistorySurfaceContent {...props} overlays={overlays} />}
  </OverlaysRoot></OverlaysServicesProvider>;
}

function HistorySurfaceContent({ scenario, onCreateDraft, withSidebar = false, applications, overlays, ...probes }: HistorySurfaceProps & {
  overlays: OverlaysShellProjection;
}) {
  const { onSettingsWrite, onPermissionRequest, onDetailRead, onTimelineRead, onSummaryRetry } = probes;
  const services = useMemo(() => createFakeModuleHubServices({ computerHistory: fixtureService(scenario, {
    onSettingsWrite, onPermissionRequest, onDetailRead, onTimelineRead, onSummaryRetry,
  }, applications) }), [scenario, applications, onSettingsWrite, onPermissionRequest, onDetailRead, onTimelineRead, onSummaryRetry]);
  const [collapsed, setCollapsed] = useState(false);
  const { open: settingsOpen, request: settingsRequest } = overlays.selectors.settings;
  const openComputerHistorySettings = () => overlays.commands.openSettingsSection('computer-history');
  const closeSettingsModal = overlays.commands.closeSettings;
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
  await waitFor(() => expect(within(settings).getByRole('button', { name: '刷新历史记录' })).toBeEnabled());
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
    await userEvent.click(await canvas.findByRole('radio', { name: '10 分钟' }));
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
    const search = canvas.getByRole('textbox', { name: /搜索历史|搜尋歷史|Search history/ });
    await userEvent.type(search, 'nothing-matches-this-fixture');
    await waitFor(() => expect(canvasElement.querySelector('.computer-history-master')).toHaveAttribute('aria-busy', 'false'));
    expect(canvasElement.querySelectorAll('.computer-history-row')).toHaveLength(0);
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
    const keyword = canvas.getByRole('button', { name: /^(搜索关键词|搜尋關鍵字|Search keyword): 可访问性$/ });
    keyword.focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(search).toHaveFocus());
    expect(search).toHaveValue('可访问性');
    expect(canvasElement.querySelector('.computer-history-detail')).toBeNull();
    await waitFor(() => expect(canvasElement.querySelectorAll('.computer-history-row')).toHaveLength(1));
    expect(canvasElement.querySelector('.computer-history-search-hint')).toHaveTextContent('可访问性');
    await userEvent.clear(search);
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
    await waitFor(() => expect(document.querySelector('pre code')).toHaveTextContent('"version":1'));
    expect(document.querySelector('pre code')).toHaveTextContent('```ts');
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

// Real path: saved UTC-aligned overviews -> original documents -> local calendar-day reading.
export const Granularity: Story = {
  args: { scenario: 'granularity', withSidebar: true },
  play: async ({ canvasElement, args, step }) => {
    const canvas = within(canvasElement);
    const body = within(canvasElement.ownerDocument.body);
    const list = within(await canvas.findByRole('complementary', { name: '活动列表' }));
    const modes = within(canvas.getByRole('radiogroup', { name: '查看粒度' }));
    const entries = granularityEntries();
    const parent = entries.find((entry) => entry.summaryLevel === '6h')!;
    const leaf = entries.find((entry) => entry.title === GRANULARITY_ACTIVITIES[3].title)!;
    const today = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }).format(new Date(at('12:00')));
    const yesterday = new Date(at('12:00'));
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayLabel = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }).format(yesterday);

    await step('Default six-hour overview and pending interval', async () => {
      await list.findByRole('button', { name: new RegExp(GRANULARITY_OVERVIEW) });
      expect(modes.getByRole('radio', { name: '6 小时' })).toBeChecked();
      expect(list.getByRole('button', { name: /今天 · 08:00–14:00.*总览待生成/ })).toHaveTextContent('2 段活动');
      expect(list.getAllByRole('listitem')).toHaveLength(2);
      expect(list.getByRole('button', { name: new RegExp(GRANULARITY_ACTIVITIES[4].title) })).toBeVisible();
      expect(list.queryByRole('button', { name: new RegExp(leaf.title) })).toBeNull();
      expect(canvas.queryByText(GRANULARITY_RAW_TITLE)).toBeNull();
      expect(args.onDetailRead).not.toHaveBeenCalled();

      const expand = list.getByRole('button', { name: '展开明细 · 昨天 20:00–今天 02:00' });
      expect(expand).toHaveAttribute('aria-expanded', 'false');
      await userEvent.click(expand);
      expect(list.getByRole('button', { name: '收起明细 · 昨天 20:00–今天 02:00' })).toHaveAttribute('aria-expanded', 'true');
      expect(list.getAllByRole('listitem')).toHaveLength(6);
      expect(list.getByRole('button', { name: new RegExp(leaf.title) })).toHaveTextContent('今天');
      expect(list.getByRole('button', { name: new RegExp(GRANULARITY_ACTIVITIES[0].title) })).toHaveTextContent('昨天');
      await userEvent.click(list.getByRole('button', { name: new RegExp(GRANULARITY_OVERVIEW) }));
      const reader = await canvas.findByRole('region', { name: GRANULARITY_OVERVIEW });
      const document = await within(reader).findByRole('region', { name: '摘要文档' });
      await waitFor(() => expect(document).toHaveTextContent(GRANULARITY_OVERVIEW_BODY));
      expect(reader).toHaveTextContent('昨天 20:00–今天 02:00');
      expect(args.onDetailRead).toHaveBeenLastCalledWith(parent.id);
    });

    await step('Changing granularity preserves the open document and its source mode', async () => {
      const reader = canvas.getByRole('region', { name: GRANULARITY_OVERVIEW });
      const document = within(reader).getByRole('region', { name: '摘要文档' });
      await userEvent.click(within(document).getByRole('radio', { name: '源码' }));
      const reads = args.onDetailRead.mock.calls.length;
      for (const [label, value] of [['10 分钟', '10min'], ['1 天', 'day'], ['6 小时', '6h']]) {
        await userEvent.click(modes.getByRole('radio', { name: label }));
        expect(modes.getByRole('radio', { name: label })).toBeChecked();
        expect(localStorage.getItem('maka-computer-history-granularity-v1')).toBe(value);
        expect(canvas.getByRole('region', { name: GRANULARITY_OVERVIEW })).toBe(reader);
        expect(within(reader).getByRole('region', { name: '摘要文档' })).toBe(document);
        expect(within(document).getByRole('radio', { name: '源码' })).toBeChecked();
        expect(args.onDetailRead).toHaveBeenCalledTimes(reads);
        expect(canvas.queryByText(GRANULARITY_RAW_TITLE)).toBeNull();
      }
      await userEvent.click(list.getByRole('button', { name: new RegExp(leaf.title) }));
      const leafReader = await canvas.findByRole('region', { name: leaf.title });
      await waitFor(() => expect(within(leafReader).getByRole('region', { name: '摘要文档' })).toHaveTextContent(GRANULARITY_ACTIVITIES[3].body));
      expect(args.onDetailRead).toHaveBeenLastCalledWith(leaf.id);
      await userEvent.click(modes.getByRole('radio', { name: '10 分钟' }));
      expect(canvas.getByRole('region', { name: leaf.title })).toBe(leafReader);
      expect(list.getByRole('button', { name: '今天 4 段活动' })).toHaveAttribute('aria-expanded', 'true');
      expect(list.getByRole('button', { name: '昨天 2 段活动' })).toHaveAttribute('aria-expanded', 'true');
      expect(list.queryByRole('button', { name: new RegExp(GRANULARITY_OVERVIEW) })).toBeNull();
    });

    await step('Local days show complete saved documents and open the original leaf', async () => {
      await userEvent.click(modes.getByRole('radio', { name: '1 天' }));
      await userEvent.click(list.getByRole('button', { name: new RegExp(`${today} · 全天活动`) }));
      const reader = await canvas.findByRole('region', { name: `${today} · 全天活动` });
      await waitFor(() => expect(within(reader).getAllByRole('region', { name: '摘要文档' })).toHaveLength(4));
      for (const activity of GRANULARITY_ACTIVITIES.slice(2)) {
        const section = within(reader).getByRole('region', { name: activity.title });
        await waitFor(() => expect(within(section).getByRole('region', { name: '摘要文档' })).toHaveTextContent(activity.body));
      }
      expect(within(reader).queryByRole('region', { name: GRANULARITY_ACTIVITIES[1].title })).toBeNull();
      expect(reader).not.toHaveTextContent(GRANULARITY_OVERVIEW_BODY);
      expect(reader).not.toHaveTextContent(GRANULARITY_RAW_TITLE);
      const documents = within(reader).getAllByRole('region', { name: '摘要文档' });
      const reads = args.onDetailRead.mock.calls.length;
      await userEvent.click(modes.getByRole('radio', { name: '6 小时' }));
      expect(canvas.getByRole('region', { name: `${today} · 全天活动` })).toBe(reader);
      expect(within(reader).getAllByRole('region', { name: '摘要文档' })).toEqual(documents);
      expect(args.onDetailRead).toHaveBeenCalledTimes(reads);
      await userEvent.click(within(reader).getByRole('button', { name: leaf.title }));
      await waitFor(() => expect(within(canvas.getByRole('region', { name: leaf.title })).getByRole('region', { name: '摘要文档' })).toHaveTextContent(GRANULARITY_ACTIVITIES[3].body));
      expect(args.onDetailRead).toHaveBeenLastCalledWith(leaf.id);
      await userEvent.click(modes.getByRole('radio', { name: '1 天' }));
      await userEvent.click(list.getByRole('button', { name: new RegExp(`${yesterdayLabel} · 全天活动`) }));
      const previousReader = await canvas.findByRole('region', { name: `${yesterdayLabel} · 全天活动` });
      await waitFor(() => expect(within(previousReader).getAllByRole('region', { name: '摘要文档' })).toHaveLength(2));
      for (const activity of GRANULARITY_ACTIVITIES.slice(0, 2)) {
        await waitFor(() => expect(within(previousReader).getByRole('region', { name: activity.title })).toHaveTextContent(activity.body));
      }
      expect(within(previousReader).queryByRole('region', { name: leaf.title })).toBeNull();
    });

    await step('Filtering the new date retains the cross-midnight overview', async () => {
      await userEvent.click(modes.getByRole('radio', { name: '6 小时' }));
      await userEvent.click(canvas.getByRole('button', { name: '关闭活动详情' }));
      await userEvent.click(canvas.getByRole('combobox', { name: '活动日期' }));
      await userEvent.click(await body.findByRole('option', { name: today }));
      const overview = list.getByRole('button', { name: new RegExp(GRANULARITY_OVERVIEW) });
      expect(overview).toHaveTextContent('昨天 20:00–今天 02:00');
      expect(overview).toHaveTextContent('2 段活动');
      expect(list.getByRole('button', { name: new RegExp(leaf.title) })).toBeVisible();
      expect(list.queryByRole('button', { name: new RegExp(GRANULARITY_ACTIVITIES[1].title) })).toBeNull();
      await userEvent.click(overview);
      await waitFor(() => expect(within(canvas.getByRole('region', { name: GRANULARITY_OVERVIEW })).getByRole('region', { name: '摘要文档' })).toHaveTextContent(GRANULARITY_OVERVIEW_BODY));
      expect(args.onSummaryRetry).not.toHaveBeenCalled();
      expect(args.onSettingsWrite).not.toHaveBeenCalled();
      expect(args.onPermissionRequest).not.toHaveBeenCalled();
      expect(args.onCreateDraft).not.toHaveBeenCalled();
      expect(writeAnalysisConfig).not.toHaveBeenCalled();
    });
  },
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
    const search = canvas.getByRole('textbox', { name: /搜索历史|搜尋歷史|Search history/ });
    await userEvent.type(search, '窗口切换、快捷键与鼠标点击');
    await waitFor(() => expect(canvasElement.querySelector('.computer-history-master')).toHaveAttribute('aria-busy', 'false'));
    expect(canvasElement.querySelectorAll('.computer-history-row')).toHaveLength(0);
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
    const pane = canvasElement.querySelector<HTMLElement>('.settingsMainPane')!;
    pane.scrollTop = 40;
    const position = pane.scrollTop;
    await userEvent.click(content.getByRole('button', { name: '前往授权' }));
    await waitFor(() => expect(canvasElement.querySelector('[data-maka-assistant-target="settings.permissions"]')).toHaveAttribute('aria-current', 'page'));
    await waitFor(() => expect(canvas.getByRole('tab', { name: '电脑历史' })).toHaveAttribute('aria-selected', 'true'));
    await userEvent.click(canvas.getByRole('button', { name: '返回电脑历史设置' }));
    const returned = within(await canvas.findByRole('region', { name: '电脑历史' }));
    await waitFor(() => {
      expect(returned.getByRole('button', { name: '前往授权' })).toHaveFocus();
      expect(pane.scrollTop).toBe(position);
    });
    await userEvent.click(returned.getByRole('button', { name: '刷新历史记录' }));
    await userEvent.click(returned.getByRole('button', { name: '打开历史' }));
    await canvas.findByRole('button', { name: /检查电脑历史的独立页面布局/ });
    const reopened = await openHistorySettings(canvasElement);
    for (const control of reopened.getAllByRole('switch')) expect(control).not.toBeChecked();
    expect(args.onPermissionRequest).not.toHaveBeenCalled();
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
    await userEvent.click(await settings.findByRole('button', { name: '选择摘要模型' }));
    await userEvent.click(await within(canvasElement.ownerDocument.body).findByRole('option', { name: /Alternate analysis/ }));
    await waitFor(() => expect(writeAnalysisConfig).toHaveBeenCalledWith(
      { modelKey: 'fixture::alternate-analysis' },
      { profileId: 'local', hostId: 'synthetic-local-host' },
    ));
    await waitFor(() => expect(settings.getByRole('button', { name: '选择摘要模型' })).toBeEnabled());
    const pane = canvasElement.querySelector<HTMLElement>('.settingsMainPane')!;
    pane.scrollTop = 80;
    const settingsPosition = pane.scrollTop;
    await userEvent.click(settings.getByRole('button', { name: '管理权限' }));
    await waitFor(() => expect(canvas.getByRole('tab', { name: '电脑历史' })).toHaveAttribute('aria-selected', 'true'));
    await userEvent.click(canvas.getByRole('button', { name: '返回电脑历史设置' }));
    settings = within(await canvas.findByRole('region', { name: '电脑历史' }));
    await waitFor(() => {
      expect(settings.getByRole('button', { name: '管理权限' })).toHaveFocus();
      expect(pane.scrollTop).toBe(settingsPosition);
    });
    expect(args.onPermissionRequest).not.toHaveBeenCalled();
    await userEvent.click(settings.getByRole('button', { name: '管理连接' }));
    await waitFor(() => expect(canvasElement.querySelector('[data-maka-assistant-target="settings.models"]')).toHaveAttribute('aria-current', 'page'));
    await waitFor(() => expect(readAnalysisConfig).toHaveBeenCalledWith({ profileId: 'local', hostId: 'synthetic-local-host' }));
    expect(readAnalysisConfig.mock.calls.every(([host]) => host.profileId === 'local')).toBe(true);
    await userEvent.click(canvas.getByRole('button', { name: '返回电脑历史设置' }));
    settings = within(await canvas.findByRole('region', { name: '电脑历史' }));
    await waitFor(() => {
      expect(settings.getByRole('button', { name: '选择摘要模型' })).toHaveFocus();
      expect(settings.getByRole('button', { name: '选择摘要模型' })).toHaveTextContent('Alternate analysis');
      expect(pane.scrollTop).toBe(settingsPosition);
    });
    expect(writeAnalysisConfig).toHaveBeenCalledTimes(1);
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
    await userEvent.click(await canvas.findByRole('radio', { name: '10 分钟' }));
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
