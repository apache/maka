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
import type { DailyReviewArchive, DailyReviewSummary } from '@maka/core/daily-review';
import type { ScheduledTask, ScheduledTaskRun } from '@maka/core/scheduled-task';
import type { McpConfigFile, McpServerStatus } from '@maka/core/mcp';
import { MCP_CONFIG_VERSION } from '@maka/core/mcp';
import {
  ScheduledTasksPage,
  DailyReviewPage,
  getSharedUiCopy,
  ModuleHubSelector,
  SkillsPage,
  type ManagedSkillUpdatePreview,
  type SkillEntry,
  ToastProvider,
  useUiLocale,
} from '@maka/ui';
import { type ComponentProps, type ReactNode, useState } from 'react';
import { WorkbarTitlebarActions } from '../src/renderer/features/workbar';
import {
  createModuleHubCommandPort,
  ModuleHubHost,
  ModuleHubHostView,
  ModuleHubProvider,
  ModuleHubServicesProvider,
} from '../src/renderer/features/module-hub';
import {
  createFakeModuleHubHostModel,
  createFakeModuleHubServices,
} from '../src/renderer/features/module-hub/testing';
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
const TASK_NOW = Date.now();
const noop = () => {};
const CONFIGURED_CRON_LAST_RUN = {
  id: 'run-1',
  at: TASK_NOW - 86_400_000,
  outcome: 'ok',
  message: '已生成进度摘要。',
} satisfies ScheduledTaskRun;
const CONFIGURED_COMPLETED_LAST_RUN = {
  id: 'run-done',
  at: TASK_NOW - 2 * 86_400_000,
  outcome: 'ok',
  message: '已发送。',
} satisfies ScheduledTaskRun;

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

type StoryScheduledTask = Omit<
  ScheduledTask,
  'lastFireAt' | 'maxFires' | 'expiresAt' | 'createdBy' | 'lastError'
>;

function storyScheduledTask(task: StoryScheduledTask): ScheduledTask {
  return {
    ...task,
    lastFireAt: task.runs[0]?.at ?? null,
    maxFires: null,
    expiresAt: null,
    createdBy: { kind: 'user' },
    lastError: task.runs[0]?.outcome === 'failed' ? task.runs[0].message : null,
  };
}

const CONFIGURED_TASKS: ScheduledTask[] = ([
  {
    id: 'task-weekly',
    title: '每周发布风险复盘',
    intent: { kind: 'text', body: '聚合本周未解决的发布风险项。' },
    schedule: { kind: 'calendar', anchorAt: TASK_NOW - 7 * 86_400_000, recurrence: 'weekly' },
    effect: { kind: 'notify', channel: 'local' },
    status: 'active',
    createdAt: TASK_NOW - 14 * 86_400_000,
    updatedAt: TASK_NOW - 2 * 86_400_000,
    nextFireAt: TASK_NOW + 2 * 86_400_000,
    runs: [],
    fireCount: 0,
  },
  {
    id: 'task-cron',
    title: '工作日早 9 点同步进度',
    intent: { kind: 'text', body: '' },
    schedule: { kind: 'cron', startAt: TASK_NOW - 30 * 86_400_000, expression: '0 9 * * 1-5' },
    effect: { kind: 'notify', channel: 'local' },
    status: 'active',
    createdAt: TASK_NOW - 30 * 86_400_000,
    updatedAt: TASK_NOW - 30 * 86_400_000,
    nextFireAt: TASK_NOW + 18 * 3_600_000,
    runs: [CONFIGURED_CRON_LAST_RUN],
    fireCount: 1,
  },
  {
    id: 'task-paused',
    title: '一次性补一次截图基线',
    intent: { kind: 'text', body: '发布前再补一轮稳定基线。' },
    schedule: { kind: 'once', runAt: TASK_NOW + 3 * 86_400_000 },
    effect: { kind: 'notify', channel: 'local' },
    status: 'paused',
    createdAt: TASK_NOW - 5 * 86_400_000,
    updatedAt: TASK_NOW - 86_400_000,
    nextFireAt: null,
    runs: [],
    fireCount: 0,
  },
  {
    id: 'task-completed',
    title: '发布日提醒',
    intent: { kind: 'text', body: '' },
    schedule: { kind: 'once', runAt: TASK_NOW - 2 * 86_400_000 },
    effect: { kind: 'notify', channel: 'local' },
    status: 'completed',
    createdAt: TASK_NOW - 10 * 86_400_000,
    updatedAt: TASK_NOW - 2 * 86_400_000,
    nextFireAt: null,
    runs: [CONFIGURED_COMPLETED_LAST_RUN],
    fireCount: 1,
  },
  // The blocked row rides along with the healthy ones rather than in a story of
  // its own: a page whose whole job is scanning a list is only honest about the
  // attention state when that state has neighbours to stand out from. Same
  // reason ExtensionsMcpConfigured shows one healthy and one failed server.
  {
    id: 'task-delivery-blocked',
    title: '发送每日客户反馈摘要',
    intent: { kind: 'text', body: '汇总过去 24 小时的反馈并投递到项目群。' },
    schedule: { kind: 'cron', startAt: TASK_NOW - 30 * 86_400_000, expression: '0 18 * * 1-5' },
    effect: { kind: 'notify', channel: 'bot', platform: 'telegram', chatId: 'project-room' },
    status: 'active',
    createdAt: TASK_NOW - 30 * 86_400_000,
    updatedAt: TASK_NOW - 60 * 60_000,
    nextFireAt: TASK_NOW + 8 * 60 * 60_000,
    runs: [
      {
        id: 'run-blocked',
        at: TASK_NOW - 60 * 60_000,
        outcome: 'blocked',
        message: 'Telegram 投递不可用：机器人已被移出目标群聊。',
      },
    ],
    fireCount: 12,
  },
  // Eighth task: the list's own control bar (search / sort / filter) only
  // appears at eight, so without this row the story could never show it — and
  // the controls are the widest thing the page's header carries.
  {
    id: 'task-monthly-audit',
    title: '每月依赖许可证审计',
    intent: { kind: 'text', body: '核对新引入依赖的许可证与来源。' },
    schedule: { kind: 'calendar', anchorAt: TASK_NOW - 40 * 86_400_000, recurrence: 'monthly' },
    effect: { kind: 'notify', channel: 'local' },
    status: 'active',
    createdAt: TASK_NOW - 40 * 86_400_000,
    updatedAt: TASK_NOW - 9 * 86_400_000,
    nextFireAt: TASK_NOW + 6 * 86_400_000,
    runs: [],
    fireCount: 0,
  },
  {
    id: 'task-standup',
    title: '每日站会前汇总阻塞项',
    intent: { kind: 'text', body: '' },
    schedule: { kind: 'cron', startAt: TASK_NOW - 20 * 86_400_000, expression: '30 9 * * 1-5' },
    effect: { kind: 'notify', channel: 'local' },
    status: 'active',
    createdAt: TASK_NOW - 20 * 86_400_000,
    updatedAt: TASK_NOW - 3 * 86_400_000,
    nextFireAt: TASK_NOW + 20 * 3_600_000,
    runs: [],
    fireCount: 0,
  },
  {
    id: 'task-quarter-close',
    title: '季度收尾清点未归档会话',
    intent: { kind: 'text', body: '把仍未归档的会话列成一张清单。' },
    schedule: { kind: 'once', runAt: TASK_NOW + 21 * 86_400_000 },
    effect: { kind: 'notify', channel: 'local' },
    status: 'paused',
    createdAt: TASK_NOW - 11 * 86_400_000,
    updatedAt: TASK_NOW - 4 * 86_400_000,
    nextFireAt: null,
    runs: [],
    fireCount: 0,
  },
] satisfies StoryScheduledTask[]).map(storyScheduledTask);

const LONG_CONTENT_TASKS: ScheduledTask[] = ([
  {
    id: 'task-hostile-content',
    title: '每周一早上汇总所有仍未关闭、缺少明确负责人或预计完成日期、并且已经连续两个工作日没有更新的跨团队发布阻塞项',
    intent: { kind: 'text', body: '从工程、设计、法务与运营项目中读取发布风险，保留原始链接、负责人、最后更新时间和下一步；如果投递目标不可用，必须在本地提醒中完整说明失败原因，而不是静默跳过。' },
    schedule: {
      kind: 'cron',
      startAt: TASK_NOW - 90 * 86_400_000,
      expression: '15 8 * * 1',
    },
    effect: {
      kind: 'notify',
      channel: 'bot',
      platform: 'telegram',
      chatId: 'release-coordination-room-with-an-intentionally-hostile-identifier',
    },
    status: 'active',
    createdAt: TASK_NOW - 90 * 86_400_000,
    updatedAt: TASK_NOW - 2 * 60 * 60_000,
    nextFireAt: TASK_NOW + 5 * 86_400_000,
    runs: [
      {
        id: 'run-long',
        at: TASK_NOW - 2 * 86_400_000,
        outcome: 'blocked',
        message: '隐私浏览正在进行，因此本轮任务没有读取工作区或向外部群聊投递。',
      },
    ],
    fireCount: 37,
  },
] satisfies StoryScheduledTask[]).map(storyScheduledTask);

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

// A day with no recorded activity — the panel's own empty state.
const EMPTY_DAILY_REVIEW_SUMMARY: DailyReviewSummary = {
  ...DAILY_REVIEW_SUMMARY,
  totals: { sessionCount: 0, requestCount: 0, totalTokens: 0, costUsd: 0, errorCount: 0 },
  sessions: [],
  topTools: [],
  topModels: [],
};

// A busy day whose session list runs past its display limit (8).
// A busy day whose true session count exceeds the list cap. Production caps the
// list at DAILY_REVIEW_LIST_LIMIT (8) — the coordinator picks 8 and the
// protocol decoder rejects more — so the fixture lists 8 rows while the higher
// total lives in totals.sessionCount.
const MANY_SESSION_SUMMARY: DailyReviewSummary = {
  ...DAILY_REVIEW_SUMMARY,
  totals: { ...DAILY_REVIEW_SUMMARY.totals, sessionCount: 12, requestCount: 96 },
  sessions: Array.from({ length: 8 }, (_, index) => ({
    id: `s-many-${index + 1}`,
    name: `第 ${index + 1} 个会话：回归与修复`,
    lastMessageAt: NOW - (index + 1) * 15 * 60_000,
    lastMessagePreview: `第 ${index + 1} 条会话的最后一条消息预览。`,
  })),
};

// A generation that failed — the host returns a `failed` archive on a model
// timeout/error. Reached by triggering generate/retry (runOnce → getArchive →
// report route), where DailyReviewReport shows the error Banner + errorMessage.
const FAILED_DAILY_REVIEW_ARCHIVE: DailyReviewArchive = {
  ...DAILY_REVIEW_ARCHIVE,
  id: '2026-07-01-1d-failed',
  status: 'failed',
  errorMessage: '模型在生成分析时超时，未能产出报告，请稍后重试。',
  sections: {},
};

// A generated report whose sections run long, to check the report body stays
// readable instead of clipping.
const LONG_REVIEW_SECTION = Array.from(
  { length: 6 },
  (_, index) =>
    `## 第 ${index + 1} 节\n\n这一节刻意写得很长，用来检验报告正文在多段落、多标题下仍然可读，` +
    '不会把布局撑破或截断关键结论：它覆盖了当天的活动重点、发现的问题，以及后续要跟进的改进项，逐条展开说明。',
).join('\n\n');
const LONG_DAILY_REVIEW_ARCHIVE: DailyReviewArchive = {
  ...DAILY_REVIEW_ARCHIVE,
  sections: {
    summary: LONG_REVIEW_SECTION,
    gaps: LONG_REVIEW_SECTION,
    usage: LONG_REVIEW_SECTION,
    code: LONG_REVIEW_SECTION,
  },
};

const configuredMcpConfig: McpConfigFile = {
  version: MCP_CONFIG_VERSION,
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
  version: MCP_CONFIG_VERSION,
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
  version: MCP_CONFIG_VERSION,
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

const storyRuntimeHostProfilesBridge = {
  getDefaultHost: async () => ({ profileId: 'local', hostId: 'storybook-local-host' }),
};

const withConfiguredMcpBridge = withScopedMakaBridge({
  runtimeHostProfiles: storyRuntimeHostProfilesBridge,
  mcp: {
    getConfig: async () => configuredMcpConfig,
    listStatuses: async () => configuredMcpStatuses,
    setConfig: async () => configuredMcpConfig,
    upsert: async () => configuredMcpConfig,
    install: async () => configuredMcpConfig,
    remove: async () => configuredMcpConfig,
    cancelInstall: async () => configuredMcpConfig,
    test: async () => ({ ok: true, status: configuredMcpStatuses[0], latencyMs: 42 }),
    subscribeChanges: () => () => {},
  },
});

const withEditorMcpBridge = withScopedMakaBridge({
  runtimeHostProfiles: storyRuntimeHostProfilesBridge,
  mcp: {
    getConfig: async () => editorMcpConfig,
    listStatuses: async () => [editorMcpStatus],
    setConfig: async () => editorMcpConfig,
    upsert: async () => editorMcpConfig,
    install: async () => editorMcpConfig,
    remove: async () => editorMcpConfig,
    cancelInstall: async () => editorMcpConfig,
    test: async () => ({ ok: false, status: editorMcpStatus, latencyMs: 0 }),
    subscribeChanges: () => () => {},
  },
});

const withEmptyMcpBridge = withScopedMakaBridge({
  runtimeHostProfiles: storyRuntimeHostProfilesBridge,
  mcp: {
    getConfig: async () => ({ version: MCP_CONFIG_VERSION, mcpServers: {} }),
    listStatuses: async () => [],
    setConfig: async () => ({ version: MCP_CONFIG_VERSION, mcpServers: {} }),
    upsert: async () => ({ version: MCP_CONFIG_VERSION, mcpServers: {} }),
    install: async () => ({ version: MCP_CONFIG_VERSION, mcpServers: {} }),
    remove: async () => ({ version: MCP_CONFIG_VERSION, mcpServers: {} }),
    cancelInstall: async () => ({ version: MCP_CONFIG_VERSION, mcpServers: {} }),
    test: async () => ({ ok: true, status: configuredMcpStatuses[0], latencyMs: 42 }),
    subscribeChanges: () => () => {},
  },
});

const withFailedMcpBridge = withScopedMakaBridge({
  runtimeHostProfiles: storyRuntimeHostProfilesBridge,
  mcp: {
    getConfig: async () => failedMcpConfig,
    listStatuses: async () => failedMcpStatuses,
    setConfig: async () => failedMcpConfig,
    upsert: async () => failedMcpConfig,
    install: async () => failedMcpConfig,
    remove: async () => failedMcpConfig,
    cancelInstall: async () => failedMcpConfig,
    test: async () => ({ ok: false, status: failedMcpStatuses[0], latencyMs: 30_000 }),
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
        <WorkbarTitlebarActions
          available={false}
          collapsed
          onToggle={noop}
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

function ScheduledTasksSurface(props: {
  tasks?: ScheduledTask[];
  keepSystemAwake?: boolean;
  onKeepSystemAwakeChange?: (next: boolean) => Promise<void>;
}) {
  const copy = getSharedUiCopy(useUiLocale()).moduleHubs.automations;
  return (
    <ModuleSurface agentsView="cron">
      <ScheduledTasksPage
        hubHeader={{
          title: copy.title,
          subtitle: copy.description,
          badge: <ModuleHubSelector hub="automations" value="scheduled-tasks" onChange={() => {}} />,
        }}
        tasks={props.tasks ?? []}
        keepSystemAwake={props.keepSystemAwake ?? false}
        onKeepSystemAwakeChange={
          props.onKeepSystemAwakeChange ?? (async () => {})
        }
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

function ModuleHubHostSurface(props: {
  selection:
    | { section: 'extensions'; module: 'skills' | 'mcp' }
    | { section: 'automations'; module: 'scheduled-tasks' | 'daily-review' };
}) {
  const base = createFakeModuleHubHostModel(props.selection);
  const model = {
    ...base,
    skills: {
      ...base.skills,
      skills: INSTALLED_SKILLS,
      bundledSkillCatalog: BUNDLED_SKILLS,
    },
    scheduledTasks: {
      ...base.scheduledTasks,
      scheduledTasks: CONFIGURED_TASKS,
    },
    dailyReview: {
      ...base.dailyReview,
      bridge: {
        fetchDay: async () => DAILY_REVIEW_SUMMARY,
      },
    },
  };
  const agentsView = props.selection.section === 'extensions'
    ? props.selection.module
    : props.selection.module === 'daily-review'
      ? 'daily-review'
      : 'cron';
  return (
    <ModuleSurface agentsView={agentsView}>
      <ModuleHubHostView model={model} />
    </ModuleSurface>
  );
}

function ProductionModuleHubHostSurface() {
  const [commandPort] = useState(createModuleHubCommandPort);
  const [services] = useState(() => {
    const defaults = createFakeModuleHubServices();
    return createFakeModuleHubServices({
      skills: {
        ...defaults.skills,
        list: async () => INSTALLED_SKILLS,
        listBundledCatalog: async () => BUNDLED_SKILLS,
      },
    });
  });
  return (
    <ModuleSurface agentsView="skills">
      <ModuleHubServicesProvider services={services}>
        <ModuleHubProvider
          selection={{ section: 'extensions', module: 'skills' }}
          selectModule={noop}
          useSkillInChat={noop}
          openSession={noop}
          appendComposerText={noop}
          captureActiveComposerClaim={() => undefined}
          commandPort={commandPort}
        >
          <ModuleHubHost />
        </ModuleHubProvider>
      </ModuleHubServicesProvider>
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

// Full production composition: public Provider → Context → public Host.
export const HostExtensionsSkills: Story = {
  render: () => <ProductionModuleHubHostSurface />,
};

// Focused view seams keep the other route variants deterministic.
export const HostExtensionsMcp: Story = {
  decorators: [withEmptyMcpBridge],
  render: () => (
    <ModuleHubHostSurface
      selection={{ section: 'extensions', module: 'mcp' }}
    />
  ),
};

export const HostAutomationsScheduledTasks: Story = {
  render: () => (
    <ModuleHubHostSurface
      selection={{ section: 'automations', module: 'scheduled-tasks' }}
    />
  ),
};

export const HostAutomationsDailyReview: Story = {
  render: () => (
    <ModuleHubHostSurface
      selection={{ section: 'automations', module: 'daily-review' }}
    />
  ),
};

// Real path: sidebar → 扩展 → 技能, with several installed Skills.
export const ExtensionsSkillsInstalled: Story = {
  render: () => <ExtensionsSkillsSurface skills={INSTALLED_SKILLS} />,
};

// Real path: sidebar → 扩展 → 技能, with bundled Skills available to install.
export const ExtensionsSkillsBundled: Story = {
  render: () => <ExtensionsSkillsSurface bundledSkillCatalog={BUNDLED_SKILLS} />,
};

// Real path: sidebar → 扩展 → 技能, after a managed source reports an update.
// The review flow lives in the inspector now: select the row, then 查看更新.
export const ExtensionsSkillsUpdateAvailable: Story = {
  render: () => (
    <ExtensionsSkillsSurface
      skills={UPDATE_AVAILABLE_SKILLS}
      onUpdateManagedSkill={async () => true}
    />
  ),
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

    await waitForStorySelector<HTMLElement>(canvasElement, '[aria-label="Skill 更新审查"]');
  },
};

// Real path: sidebar → 扩展 → 技能 → click an installed row, which opens the
// inspector where every per-skill control now lives. Wide only: below 1024px
// the page trades the panel for a dialog.
export const ExtensionsSkillsInspector: Story = {
  render: () => <ExtensionsSkillsSurface skills={INSTALLED_SKILLS} />,
  play: async ({ canvasElement }) => {
    const row = await waitForStoryButton(
      canvasElement,
      (candidate) => candidate.textContent?.includes('git-flow') === true,
    );
    row.click();
    await waitForStoryText(canvasElement, '固定到技能上下文');
  },
};

// Real path: sidebar → 扩展 → 技能, long installed list (visual catalog only).
// Do not pin scroll geometry / Astryx List a11y in play — those are vendor DOM
// contracts, not product journeys.
export const ExtensionsSkillsScrollContainment: Story = {
  render: () => <ExtensionsSkillsSurface skills={LONG_LIST_SKILLS} />,
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

// Real path: sidebar → 扩展 → MCP, with connected and disabled servers.
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

// Real path: sidebar → 定时任务 → 定时任务, before any task exists.
export const ScheduledTasks: Story = {
  render: () => <ScheduledTasksSurface />,
};

// Real path: sidebar → 定时任务 → 定时任务, with recurring, paused, completed and
// delivery-blocked tasks in one list.
//
// 保持系统唤醒 has no story: it is persisted page state the page itself never
// renders, so a story for it would show pixels identical to this one. The state
// lives on the settings menu item rather than this page.
export const ScheduledTasksConfigured: Story = {
  render: () => <ScheduledTasksSurface tasks={CONFIGURED_TASKS} />,
};

// A newer external settings read wins over a slow local write in the Module
// Hub controller. The checkbox must return to the persisted prop when that
// pending write settles, even when the Boolean prop itself never changed.
export const ScheduledTasksKeepAwakeExternalWins: Story = {
  render: () => (
    <ScheduledTasksSurface
      keepSystemAwake
      onKeepSystemAwakeChange={async () => {
        await new Promise((resolve) => globalThis.setTimeout(resolve, 80));
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const settings = await waitForStoryButton(
      canvasElement,
      (candidate) => candidate.getAttribute('aria-label') === '定时任务页面设置',
    );
    settings.click();
    const body = canvasElement.ownerDocument.body;
    const checkbox = await waitForStorySelector<HTMLElement>(
      body,
      '[role="menuitemcheckbox"]',
    );
    if (checkbox.getAttribute('aria-checked') !== 'true') {
      throw new Error('Keep-awake story did not start from persisted true');
    }
    checkbox.click();
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const current = body.querySelector<HTMLElement>('[role="menuitemcheckbox"]');
      if (current?.getAttribute('aria-checked') === 'false') break;
      await new Promise((resolve) => globalThis.setTimeout(resolve, 10));
      if (attempt === 49) throw new Error('Keep-awake optimistic value did not render');
    }
    // The write resolves asynchronously and Astryx may close the menu while
    // the panel re-syncs its optimistic value from the persisted prop. Poll
    // for the confirmed value instead of assuming a fixed 100ms settle time;
    // the latter is fast locally but flakes under Storybook CI load.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      let persisted = body.querySelector<HTMLElement>('[role="menuitemcheckbox"]');
      if (!persisted) {
        settings.click();
        persisted = await waitForStorySelector<HTMLElement>(
          body,
          '[role="menuitemcheckbox"]',
        );
      }
      if (persisted.getAttribute('aria-checked') === 'true') return;
      await new Promise((resolve) => globalThis.setTimeout(resolve, 10));
    }
    throw new Error('Keep-awake checkbox diverged from the persisted setting');
  },
};

// Real path: sidebar → 定时任务 → 定时任务 → click a task row, which opens the
// inspector where every per-task control now lives. Wide only: below 1024px the
// page drops the inspector rather than squeeze two columns into one.
export const ScheduledTasksInspector: Story = {
  render: () => <ScheduledTasksSurface tasks={CONFIGURED_TASKS} />,
  play: async ({ canvasElement }) => {
    const row = await waitForStoryButton(
      canvasElement,
      (candidate) => candidate.textContent?.includes('每周发布风险复盘') === true,
    );
    row.click();
    await waitForStoryText(canvasElement, '立即触发');
  },
};

// Real path: narrow desktop → sidebar → 定时任务.
// The inspector is intentionally hidden below the two-column breakpoint.
export const ScheduledTasksNarrow: Story = {
  render: () => <ScheduledTasksSurface tasks={CONFIGURED_TASKS} />,
  parameters: { viewport: { defaultViewport: 'mobile2' } },
};

// Real path: sidebar → 定时任务 → 定时任务, with user-authored content at storage limits.
export const ScheduledTasksLongContent: Story = {
  render: () => <ScheduledTasksSurface tasks={LONG_CONTENT_TASKS} />,
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
    await waitForStorySelector<HTMLElement>(canvasElement, '.maka-daily-review-content');
  },
};

// Real path after an analysis exists and the user opens its dedicated detail route.
// Real path: sidebar → scheduled tasks → Daily Review → view analysis.
export const ScheduledDailyReviewReport: Story = {
  render: function Render() {
    const staleSummary = {
      ...DAILY_REVIEW_SUMMARY,
      day: {
        fromMs: DAILY_REVIEW_SUMMARY.day.fromMs - 86_400_000,
        toMs: DAILY_REVIEW_SUMMARY.day.toMs - 86_400_000,
      },
      totals: { ...DAILY_REVIEW_SUMMARY.totals, requestCount: 999 },
    };
    return (
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
      />
    );
  },
  play: async ({ canvasElement }) => {
    const view = await waitForStoryButton(
      canvasElement,
      (candidate) => candidate.textContent?.includes('查看分析') === true,
    );
    view.click();
    await waitForStoryText(canvasElement, '返回活动');
  },
};

// Real path: sidebar → scheduled tasks → 每日回顾 on a day with no recorded
// activity — the panel's own empty state, not a spinner and not an error.
export const ScheduledDailyReviewEmpty: Story = {
  render: () => (
    <ScheduledDailyReviewSurface
      bridge={{
        fetchDay: async () => EMPTY_DAILY_REVIEW_SUMMARY,
        listArchives: async () => [],
        runOnce: async () => ({ archiveId: DAILY_REVIEW_ARCHIVE.id }),
        getArchive: async () => DAILY_REVIEW_ARCHIVE,
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    await waitForStoryText(canvasElement, '等待记录今天活动');
  },
};

// Real path: sidebar → scheduled tasks → 每日回顾 on a busy day. The list caps
// at DAILY_REVIEW_LIST_LIMIT (8), so a higher total (12) surfaces as 8 rows —
// the production-reachable "many sessions" shape the seeded two-session fixture
// never reaches.
export const ScheduledDailyReviewManySessions: Story = {
  render: () => (
    <ScheduledDailyReviewSurface
      bridge={{
        fetchDay: async () => MANY_SESSION_SUMMARY,
        listArchives: async () => [],
        runOnce: async () => ({ archiveId: DAILY_REVIEW_ARCHIVE.id }),
        getArchive: async () => DAILY_REVIEW_ARCHIVE,
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    await waitForStorySelector<HTMLElement>(canvasElement, '.maka-daily-review-content');
    await waitForStoryText(canvasElement, '第 1 个会话：回归与修复');
  },
};

// Real path: sidebar → scheduled tasks → 每日回顾 → view analysis on a long
// report — the report body must stay readable across many long sections.
export const ScheduledDailyReviewLongReport: Story = {
  render: () => (
    <ScheduledDailyReviewSurface
      bridge={{
        fetchDay: async () => DAILY_REVIEW_SUMMARY,
        listArchives: async () => [
          {
            id: LONG_DAILY_REVIEW_ARCHIVE.id,
            day: LONG_DAILY_REVIEW_ARCHIVE.day,
            range: LONG_DAILY_REVIEW_ARCHIVE.range,
            status: LONG_DAILY_REVIEW_ARCHIVE.status,
            generatedAt: LONG_DAILY_REVIEW_ARCHIVE.generatedAt,
            trigger: LONG_DAILY_REVIEW_ARCHIVE.trigger,
            modelKey: LONG_DAILY_REVIEW_ARCHIVE.modelKey,
            totals: LONG_DAILY_REVIEW_ARCHIVE.totals,
          },
        ],
        getArchive: async () => LONG_DAILY_REVIEW_ARCHIVE,
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const view = await waitForStoryButton(
      canvasElement,
      (candidate) => candidate.textContent?.includes('查看分析') === true,
    );
    view.click();
    await waitForStoryText(canvasElement, '返回活动');
    await waitForStoryText(canvasElement, '第 1 节');
  },
};

// Real path: sidebar → scheduled tasks → 每日回顾 → generate, when generation
// fails (model timeout/error). runOnce → getArchive returns a `failed` archive,
// so the report route shows the error Banner and failure message. This is the
// only path to a failed archive — it has no "view analysis" affordance, so
// generate/retry is how it is reached.
export const ScheduledDailyReviewGenerationFailed: Story = {
  render: () => (
    <ScheduledDailyReviewSurface
      bridge={{
        fetchDay: async () => DAILY_REVIEW_SUMMARY,
        listArchives: async () => [],
        runOnce: async () => ({ archiveId: FAILED_DAILY_REVIEW_ARCHIVE.id }),
        getArchive: async () => FAILED_DAILY_REVIEW_ARCHIVE,
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const generate = await waitForStoryButton(
      canvasElement,
      (candidate) => candidate.textContent?.includes('生成分析') === true,
    );
    generate.click();
    await waitForStoryText(canvasElement, '生成失败');
  },
};
