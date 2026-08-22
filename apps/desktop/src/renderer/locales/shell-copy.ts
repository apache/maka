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

import { generalizedErrorMessage, generalizedErrorMessageChinese } from '@maka/core/redaction';

import { type UiCatalog, type UiLocale } from '@maka/core/ui-locale';

import { type PermissionMode } from '@maka/core/permission';

import { type ChatDefaultPermissionMode, type SettingsSection } from '@maka/core/settings';

import { type SlashCommandIdForSurface } from '@maka/core/slash-command-catalog';

import { type ThinkingLevel } from '@maka/core/model-thinking';

export const STATIC_COMMAND_IDS = [
  'action:new-chat',
  'action:side-chat',
  'action:new-deep-research',
  'action:new-scheduled-task',
  'action:open-settings',
  'action:keyboard-help',
  'theme:light',
  'theme:dark',
  'theme:auto',
  'nav:sessions',
  'nav:automations',
  'nav:skills',
  'nav:mcp',
  'nav:daily-review',
  'diag:open-workspace',
  'diag:open-project-folder',
  'diag:open-skills',
  'diag:export-conversation',
  'diag:save-conversation-file',
  'diag:copy-today-daily-review',
  'diag:paste-today-daily-review',
  'diag:save-today-daily-review',
  'diag:copy-diagnostics',
  'diag:test-network-proxy',
  'diag:open-local-memory',
] as const;

export type StaticCommandId = (typeof STATIC_COMMAND_IDS)[number];

type CommandCopy = {
  label: string;
  group: string;
  hint?: string;
};

const STATIC_COMMAND_KEYWORDS: Record<StaticCommandId, readonly string[]> = {
  'action:new-chat': ['new', 'chat', 'start', '新', '建', '任务'],
  'action:side-chat': [
    'side',
    'chat',
    'btw',
    'ask',
    'explore',
    '侧边',
    '侧聊',
    '任务',
    '追问',
  ],
  'action:new-deep-research': ['deep', 'research', 'explore', 'readonly', '研究', '深度', '探索', '只读'],
  'action:new-scheduled-task': ['plan', 'task', 'schedule', 'new', 'create', '计划', '提醒', '新建', '创建'],
  'action:open-settings': ['settings', 'preferences', '设置', 'options'],
  'action:keyboard-help': ['shortcuts', 'keyboard', 'help', '快捷键', '帮助'],
  'theme:light': ['light', 'theme', '浅色', '主题'],
  'theme:dark': ['dark', 'theme', '深色', 'night', '主题'],
  'theme:auto': ['auto', 'system', 'theme', '跟随', '系统', '主题'],
  'nav:sessions': ['sessions', 'chats', '任务', '会话', '对话', 'left'],
  'nav:automations': ['automations', 'plan', 'task', 'schedule', 'cron', '定时任务', '计划', '提醒'],
  'nav:skills': ['skills', '技能'],
  'nav:mcp': ['mcp', 'server', 'tools', '扩展', '工具'],
  'nav:daily-review': ['daily', 'review', 'today', '每日', '回顾', '今天'],
  'diag:open-workspace': ['workspace', 'folder', 'open', 'finder', '工作区', '文件夹', '目录'],
  'diag:open-project-folder': ['project', 'folder', 'open', 'finder', '项目', '目录', '文件夹'],
  'diag:open-skills': ['skills', 'folder', 'open', 'finder', '技能', '文件夹'],
  'diag:export-conversation': ['export', 'markdown', 'copy', 'conversation', '导出', '任务', '剪贴板', 'md'],
  'diag:save-conversation-file': [
    'save',
    'file',
    'markdown',
    'conversation',
    'export',
    '保存',
    '文件',
    '任务',
    '导出',
    'md',
  ],
  'diag:copy-today-daily-review': ['daily', 'review', 'today', 'copy', 'markdown', '今日', '回顾', '复制', '剪贴板'],
  'diag:paste-today-daily-review': ['daily', 'review', 'paste', 'composer', '今日', '回顾', '粘贴', '输入框'],
  'diag:save-today-daily-review': [
    'daily',
    'review',
    'save',
    'file',
    'export',
    'markdown',
    '今日',
    '回顾',
    '保存',
    '文件',
    '导出',
  ],
  'diag:copy-diagnostics': [
    'env',
    'environment',
    'version',
    'diagnostics',
    'logs',
    'about',
    'bug',
    'report',
    '环境',
    '版本',
    '日志',
    '关于',
    '诊断',
    '汇报',
  ],
  'diag:test-network-proxy': ['network', 'proxy', 'test', 'ping', '网络', '代理', '测试', '连接', '诊断'],
  'diag:open-local-memory': ['memory', 'md', 'open', '记忆', '本地', '编辑', 'edit'],
};

type ShellCopy = {
  navigation: {
    settings: string;
  };
  actions: {
    retry: string;
  };
  paths: Record<'workspace' | 'project' | 'skills', string>;
  errors: {
    messageRead: string;
    messageRefresh: string;
    openPath(path: string): string;
    workspaceUnavailableTitle: string;
    workspaceUnavailableDescription: string;
  };
  chatActions: {
    newConversation: string;
    sendFailedTitle: string;
    sendFailedFallback: string;
    skillInvocationBlockedTitle: string;
    skillInvocationBlockedDescription(items: readonly string[]): string;
    skillInvocationFailedTitle: string;
    skillInvocationFailedDescription(items: readonly string[]): string;
    skillInvocationFailureReason: Record<
      | 'invalid_name'
      | 'not_found'
      | 'disabled'
      | 'host_incompatible'
      | 'resolution_failed'
      | 'too_many_requests',
      string
    >;
    responseFailedTitle: string;
    responseFailedFallback: string;
    refreshFailedTitle: string;
    sessionStartFailedTitle: string;
    sessionStartFailedFallback: string;
  };
  projectActions: {
    currentProject: string;
    readPathFailedTitle: string;
    readPathFailedFallback: string;
    selectDirectoryFailedTitle: string;
    selectedPathUnreadable: string;
    directorySwitchedTitle: string;
    projectUpdateFailedTitle: string;
    projectUpdateFailedFallback: string;
    catalogUnavailable: string;
    retryCatalog: string;
    remoteDirectoryTitle(host: string): string;
    remoteDirectoryBreadcrumbs: string;
    remoteDirectoryHome: string;
    remoteDirectoryEmpty: string;
    remoteDirectorySelect: string;
    remoteDirectoryCancel: string;
    remoteDirectoryRetry: string;
    remoteDirectoryLoading: string;
    remoteDirectoryShowHidden: string;
    remoteDirectoryHideHidden: string;
    runtimeHostReadiness: Record<'connecting' | 'reconnecting' | 'unavailable', string>;
    openFailedTitle(path: string): string;
    openPathLabels: Record<'workspace' | 'skills' | 'memory' | 'project', string>;
    openPathFailures: Record<
      'unknown-key' | 'not-allowed' | 'missing' | 'not-a-directory' | 'open-failed' | 'unknown',
      string
    >;
  };
  commandActions: {
    connectionVerified(name: string): string;
    connectionLatency(latency: number | string, model?: string): string;
    connectionTestFailed(name: string): string;
    testErrorTitle: string;
    connectionUnavailable: string;
    connectionFailures: Record<'rateLimit' | 'timeout' | 'auth' | 'network' | 'provider' | 'unknown', string>;
    setDefaultSuccess(name: string): string;
    setDefaultFailedTitle: string;
    setDefaultFallback: string;
    newConversation: string;
    conversationCopiedTitle: string;
    lineCount(lines: number): string;
    copyFailedTitle: string;
    clipboardUnavailable: string;
    conversationSavedTitle: string;
    saveSummary(lines: number, fileName: string): string;
    saveFailedTitle: string;
    invalidExport: string;
    writeFailed: string;
    exportFallback: string;
    memoryOpenFailedTitle: string;
    openFailedTitle: string;
    memoryOpenFallback: string;
    today: string;
    reviewCopiedTitle: string;
    reviewSummary(sessions: number, requests: number): string;
    reviewCopyFallback: string;
    reviewPastedTitle: string;
    reviewCopied(label: string): string;
    reviewPasted(label: string): string;
    reviewSaved(label: string): string;
    reviewSaveFallback: string;
    pasteFailedTitle: string;
    reviewUnavailable: string;
    diagnosticsCopiedTitle: string;
    diagnosticsCopiedDescription: string;
    clipboardDenied: string;
    networkPassedTitle: string;
    networkFailedTitle: string;
    genericTestFailedTitle: string;
    networkTestFallback: string;
  };
  sessionRowActions: {
    actionFallback: string;
    flagFailedTitle: string;
    unflagFailedTitle: string;
    archiveFailedTitle: string;
    unarchiveFailedTitle: string;
    renameFailedTitle: string;
    deleteFailedTitle: string;
    currentConversation: string;
    deleteTitle(name: string): string;
    deleteDescription: string;
    deleteLabel: string;
    cancelLabel: string;
    deletedTitle(name: string): string;
    /** The task was restored elsewhere, so the delete was called off. */
    deleteRestoredTitle(name: string): string;
  };
  skillActions: {
    refreshSkillsFailedTitle: string;
    refreshSkillsFallback: string;
    refreshSourcesFailedTitle: string;
    refreshSourcesFallback: string;
    refreshBundledFailedTitle: string;
    refreshBundledFallback: string;
    installBundledFailedTitle: string;
    installBundledFallback: string;
    installedBundledTitle: string;
    installedDescription(id: string): string;
    importSourceFailedTitle: string;
    importSourceFallback: string;
    importedSourceTitle: string;
    installFailedTitle: string;
    installFallback: string;
    installedTitle: string;
    previewFailedTitle: string;
    previewFallback: string;
    updateFailedTitle: string;
    updateFallback: string;
    updatedTitle: string;
    forceUpdatedTitle: string;
    updatedDescription(id: string): string;
    toggleFailedTitle: string;
    toggleFallback: string;
    enabledTitle: string;
    disabledTitle: string;
    pinnedTitle: string;
    unpinnedTitle: string;
    runtimeDescription(name: string): string;
    deleteFailedTitle: string;
    deleteFallback: string;
    deletedTitle: string;
    deletedDescription(id: string): string;
    openFailedTitle: string;
    openFallback: string;
    openFailures: Record<
      'invalid_id' | 'missing' | 'blocked_path' | 'not_file' | 'not_directory' | 'open_failed',
      string
    >;
    sourceFailures: Record<'invalid_skill' | 'already_exists' | 'blocked_path' | 'write_failed' | 'cancelled', string>;
    installFailures: Record<'not_found' | 'already_exists' | 'blocked_path' | 'write_failed', string>;
    updateFailures: Record<
      'not_managed' | 'source_missing' | 'local_modified' | 'metadata_error' | 'blocked_path' | 'write_failed',
      string
    >;
    previewFailures: Record<
      'not_managed' | 'source_missing' | 'metadata_error' | 'blocked_path' | 'read_failed',
      string
    >;
    deleteFailures: Record<'not_found' | 'blocked_path' | 'blocked_scope' | 'delete_failed', string>;
    runtimeFailures: Record<'not_found' | 'blocked_path' | 'state_error' | 'write_failed', string>;
  };
  sessionSettingsActions: {
    permissionLabels: Record<ChatDefaultPermissionMode, string>;
    permissionDescriptions: Record<PermissionMode, string>;
    bypassConfirmTitle: string;
    bypassConfirmDescription: string;
    bypassConfirmLabel: string;
    bypassCancelLabel: string;
    permissionSwitched(label: string): string;
    permissionFailedTitle: string;
    permissionFallback: string;
    modelSwitchedTitle: string;
    modelSwitchedDescription(from: string, to: string): string;
    modelFailedTitle: string;
    modelFallback: string;
    thinkingUpdatedTitle: string;
    thinkingDefault: string;
    thinkingLabels: Record<ThinkingLevel, string>;
    thinkingFailedTitle: string;
    thinkingFallback: string;
  };
  /**
   * The Goal dialog. A Goal spends tokens without further prompting, so the
   * wording states what it does and names the two budgets that stop it —
   * silence here reads as "nothing happens until I press something else".
   */
  goalDialog: {
    title: string;
    description: string;
    conditionLabel: string;
    conditionDescription: string;
    conditionPlaceholder: string;
    maxIterationsLabel: string;
    maxIterationsDescription: string;
    maxIterationsInvalid(max: number): string;
    tokenBudgetLabel: string;
    tokenBudgetDescription: string;
    tokenBudgetInvalid(min: number): string;
    cancel: string;
    submit: string;
    failedFallback: string;
  };
  errorBoundary: {
    copyPending: string;
    copied: string;
    copyFailed: string;
    copyReport: string;
    title: string;
    descriptionBeforeRetry: string;
    retry: string;
    descriptionBeforeReload: string;
    reload: string;
    descriptionAfterReload: string;
    errorDetails: string;
    componentStack: string;
    clipboardFailure: string;
  };
  commandPalette: {
    label: string;
    searchLabel: string;
    placeholder: string;
    closeLabel: string;
    resultsLabel: string;
    emptyTitle: string;
    emptyDescription: string;
    selectHint: string;
    runHint: string;
    closeHint: string;
    current: string;
    groups: {
      settings: string;
      permissions: string;
      connections: string;
      conversations: string;
    };
    staticKeywords: Record<StaticCommandId, readonly string[]>;
    commands: Record<StaticCommandId, CommandCopy>;
    settingsSections: Record<SettingsSection, string>;
    permissionModes: Record<PermissionMode, { label: string; hint: string }>;
    settingsCommand(section: string): string;
    testDefaultConnection(name: string): string;
    setDefaultConnection(name: string): string;
    testConnection(name: string): string;
    settingsKeywords(section: SettingsSection, label: string): string[];
    permissionKeywords(mode: PermissionMode): string[];
    connectionKeywords(action: 'default' | 'test', name: string, providerType: string): string[];
  };
  keyboardHelp: {
    title: string;
    sections: Array<{
      heading: string;
      rows: Array<{ keys: string[]; description: string }>;
    }>;
  };
  chrome: {
    windowActions: string;
    searchConversations: string;
    expandSidebar: string;
    collapseSidebar: string;
    newTask: string;
    expandWorkbar: string;
    collapseWorkbar: string;
    workspaceActions: string;
  };
  app: {
    loadingWorkbarLabel: string;
    loadingWorkbar: string;
    useSkillPrompt(skillName: string): string;
    newConversation: string;
    compactErrorTitle: string;
    compactErrorFallback: string;
    slashCommands: Record<SlashCommandIdForSurface<'desktop'>, {
      name: string;
      description: string;
    }>;
    sideChatUnavailableTitle: string;
    sideChatUnavailableDescription: string;
    sideChatContextPendingTitle: string;
    sideChatContextPendingDescription: string;
    resumeStartedTitle: string;
    resumeStartedDescription: string;
    resumeFailedTitle: string;
    resumeFailedFallback: string;
    goalClearFailedTitle: string;
    goalClearFailedFallback: string;
    goalPauseFailedTitle: string;
    goalPauseFailedFallback: string;
    goalResumeFailedTitle: string;
    goalResumeFailedFallback: string;
    appearanceLoadErrorTitle: string;
    appearanceLoadErrorFallback: string;
    memoryRefreshErrorTitle: string;
    memoryLoadErrorTitle: string;
    memoryErrorFallback: string;
    openModelSettings: string;
    configureModelsOnHost(hostName: string): string;
    sidebarCollapsed: string;
    resizeConversationList: string;
    skipErrorTitle: string;
    tryAgainLater: string;
    updateInstallFailedTitle: string;
    updateInstallFailedFallback: string;
    updateInstallManualFallback: string;
    updateActiveTasksTitle: string;
    updateActiveTasksDescription: string;
    updateActiveTasksConfirm: string;
    updateActiveTasksCancel: string;
    updateRetryFailedTitle: string;
    updateRetryFailedFallback: string;
    loading: string;
    goToModels: string;
    boundaryUnreadableTitle: string;
    boundaryUnreadableDetail: string;
    boundaryUnreadableRetry: string;
    boundaryUnreadableRetrying: string;
    permissionModeChanging: string;
    permissionModeStreaming: string;
    permissionModeRunning: string;
    permissionModeWaiting: string;
    /** The one mode control locks for the same four reasons, worded once. */
    /** The Session summary has not arrived, so its mode is not known yet. */
    modeChangeLoading: string;
    modeChanging: string;
    modeChangeStreaming: string;
    modeChangeRunning: string;
    modeChangeWaiting: string;
    /**
     * Why the ＋ menu's Goal entry is unavailable right now. A Goal takes hold
     * on the next Turn, so arming one mid-Turn would look like it did nothing;
     * saying so is better than letting the user find that out afterwards.
     */
    goalTurnActive: string;
    planModeFailedTitle: string;
    planModeFallback: string;
    orchestrationModeFailedTitle: string;
    orchestrationModeFallback: string;
    planModeExitPendingTitle: string;
    planModeExitPendingDescription(title: string): string;
    planModeExitConfirm: string;
    planModeExitCancel: string;
    planModeExecutionActiveTitle: string;
    planModeExecutionActiveDescription: string;
    swarmModeEnabledTitle: string;
    swarmModeDisabledTitle: string;
    swarmModeStatusDescription: string;
    graphModeEnabledTitle: string;
    graphModeDisabledTitle: string;
    graphModeStatusDescription: string;
    graphHistoryTitle: string;
    graphHistoryDescription: string;
    resizeWorkbar: string;
  };
};

const ZH_STATIC_COMMANDS: Record<StaticCommandId, CommandCopy> = {
  'action:new-chat': { label: '新建任务', hint: '开始新的任务', group: '操作' },
  'action:side-chat': {
    label: '打开侧边对话',
    hint: '⌥⌘S',
    group: '操作',
  },
  'action:new-deep-research': {
    label: '新建深度研究',
    hint: '只读探索',
    group: '操作',
  },
  'action:new-scheduled-task': {
    label: '新建定时任务',
    hint: '打开定时任务表单',
    group: '操作',
  },
  'action:open-settings': { label: '打开设置', hint: '⌘,', group: '操作' },
  'action:keyboard-help': { label: '查看键盘快捷键', hint: '?', group: '操作' },
  'theme:light': { label: '主题 · 浅色', group: '主题' },
  'theme:dark': { label: '主题 · 深色', group: '主题' },
  'theme:auto': { label: '主题 · 跟随系统', group: '主题' },
  'nav:sessions': { label: '侧栏 · 任务', group: '导航' },
  'nav:automations': { label: '侧栏 · 定时任务', group: '导航' },
  'nav:skills': { label: '打开 · 技能', group: '导航' },
  'nav:mcp': { label: '打开 · MCP', group: '导航' },
  'nav:daily-review': { label: '打开 · 每日回顾', group: '导航' },
  'diag:open-workspace': {
    label: '打开工作区文件夹',
    hint: 'Finder',
    group: '诊断',
  },
  'diag:open-project-folder': {
    label: '打开项目目录',
    hint: 'Finder',
    group: '诊断',
  },
  'diag:open-skills': {
    label: '打开 Skills 文件夹',
    hint: 'Finder',
    group: '诊断',
  },
  'diag:export-conversation': {
    label: '导出当前任务为 Markdown',
    hint: '复制到剪贴板',
    group: '诊断',
  },
  'diag:save-conversation-file': {
    label: '保存当前任务为 .md 文件',
    hint: '用系统保存对话框',
    group: '诊断',
  },
  'diag:copy-today-daily-review': {
    label: '复制今日回顾为 Markdown',
    hint: '复制到剪贴板',
    group: '诊断',
  },
  'diag:paste-today-daily-review': {
    label: '把今日回顾粘到 composer',
    hint: '不进剪贴板',
    group: '诊断',
  },
  'diag:save-today-daily-review': {
    label: '保存今日回顾为 .md 文件',
    hint: '用系统保存对话框',
    group: '诊断',
  },
  'diag:copy-diagnostics': {
    label: '复制诊断信息',
    hint: '⇧⌘D · 脱敏日志 · 仅写入剪贴板',
    group: '诊断',
  },
  'diag:test-network-proxy': {
    label: '测试当前网络代理',
    hint: '诊断 · 不打开设置',
    group: '诊断',
  },
  'diag:open-local-memory': {
    label: '打开本地 MEMORY.md',
    hint: '系统编辑器',
    group: '诊断',
  },
};

const EN_STATIC_COMMANDS: Record<StaticCommandId, CommandCopy> = {
  'action:new-chat': {
    label: 'New task',
    hint: 'Start a new task',
    group: 'Actions',
  },
  'action:side-chat': {
    label: 'Open side chat',
    hint: '⌥⌘S',
    group: 'Actions',
  },
  'action:new-deep-research': {
    label: 'New deep research',
    hint: 'Read-only exploration',
    group: 'Actions',
  },
  'action:new-scheduled-task': {
    label: 'New scheduled task',
    hint: 'Open the task form',
    group: 'Actions',
  },
  'action:open-settings': {
    label: 'Open Settings',
    hint: '⌘,',
    group: 'Actions',
  },
  'action:keyboard-help': {
    label: 'View keyboard shortcuts',
    hint: '?',
    group: 'Actions',
  },
  'theme:light': { label: 'Theme · Light', group: 'Theme' },
  'theme:dark': { label: 'Theme · Dark', group: 'Theme' },
  'theme:auto': { label: 'Theme · Follow system', group: 'Theme' },
  'nav:sessions': { label: 'Sidebar · Tasks', group: 'Navigation' },
  'nav:automations': { label: 'Sidebar · Automations', group: 'Navigation' },
  'nav:skills': { label: 'Open · Skills', group: 'Navigation' },
  'nav:mcp': { label: 'Open · MCP', group: 'Navigation' },
  'nav:daily-review': { label: 'Open · Daily Review', group: 'Navigation' },
  'diag:open-workspace': {
    label: 'Open workspace folder',
    hint: 'Finder',
    group: 'Diagnostics',
  },
  'diag:open-project-folder': {
    label: 'Open project folder',
    hint: 'Finder',
    group: 'Diagnostics',
  },
  'diag:open-skills': {
    label: 'Open Skills folder',
    hint: 'Finder',
    group: 'Diagnostics',
  },
  'diag:export-conversation': {
    label: 'Copy task as Markdown',
    hint: 'Copy to clipboard',
    group: 'Diagnostics',
  },
  'diag:save-conversation-file': {
    label: 'Save task as an .md file',
    hint: 'Use the system save dialog',
    group: 'Diagnostics',
  },
  'diag:copy-today-daily-review': {
    label: "Copy today's review as Markdown",
    hint: 'Copy to clipboard',
    group: 'Diagnostics',
  },
  'diag:paste-today-daily-review': {
    label: "Paste today's review into the composer",
    hint: 'Skip the clipboard',
    group: 'Diagnostics',
  },
  'diag:save-today-daily-review': {
    label: "Save today's review as an .md file",
    hint: 'Use the system save dialog',
    group: 'Diagnostics',
  },
  'diag:copy-diagnostics': {
    label: 'Copy diagnostics',
    hint: '⇧⌘D · Redacted logs · clipboard only',
    group: 'Diagnostics',
  },
  'diag:test-network-proxy': {
    label: 'Test the current network proxy',
    hint: 'Diagnose without opening Settings',
    group: 'Diagnostics',
  },
  'diag:open-local-memory': {
    label: 'Open local MEMORY.md',
    hint: 'System editor',
    group: 'Diagnostics',
  },
};

const ZH_SETTINGS_SECTIONS: Record<SettingsSection, string> = {
  general: '通用',
  appearance: '外观',
  projects: '工作区',
  models: '模型',
  subagents: '子 Agent',
  usage: '使用统计',
  'archived-tasks': '已归档任务',
  'import-tasks': '导入任务',
  memory: '记忆',
  'daily-review': '每日回顾',
  'bot-chat': '远程接入',
  search: '联网搜索',
  data: '数据',
  permissions: '权限与能力',
  health: '健康',
  about: '关于',
};

const EN_SETTINGS_SECTIONS: Record<SettingsSection, string> = {
  general: 'General',
  appearance: 'Appearance',
  projects: 'Workspace',
  models: 'Models',
  subagents: 'Subagents',
  usage: 'Usage',
  'archived-tasks': 'Archived tasks',
  'import-tasks': 'Import tasks',
  memory: 'Memory',
  'daily-review': 'Daily Review',
  'bot-chat': 'Remote Access',
  search: 'Web Search',
  data: 'Data',
  permissions: 'Permissions & Capabilities',
  health: 'Health',
  about: 'About',
};

const SHELL_COPY_BY_LOCALE = {
  zh: {
    navigation: { settings: '设置' },
    actions: { retry: '重试' },
    paths: {
      workspace: '工作区文件夹',
      project: '项目目录',
      skills: 'Skills 文件夹',
    },
    errors: {
      messageRead: '任务内容暂时无法读取，请稍后重试。',
      messageRefresh: '任务内容暂时无法刷新，请稍后重试。',
      openPath: (path: string) => `无法打开${path}，请稍后重试。`,
      workspaceUnavailableTitle: '工作目录不可用',
      workspaceUnavailableDescription: '工作目录不存在或无法访问。请选择有效目录创建新任务。',
    },
    chatActions: {
      newConversation: '新建任务',
      sendFailedTitle: '发送失败',
      sendFailedFallback: '消息暂时无法发送，请稍后重试。',
      skillInvocationBlockedTitle: 'Skill 调用失败，消息未发送',
      skillInvocationBlockedDescription: (items) => `${items.join('、')}。请调整选择后重试。`,
      skillInvocationFailedTitle: '部分 Skill 未能调用',
      skillInvocationFailedDescription: (items) => `${items.join('、')}。其余 Skill 已正常调用。`,
      skillInvocationFailureReason: {
        invalid_name: '名称无效',
        not_found: '未找到',
        disabled: '已停用',
        host_incompatible: '当前环境缺少依赖',
        resolution_failed: '解析失败',
        too_many_requests: 'Skill 调用请求超过 50 个上限',
      },
      responseFailedTitle: '响应失败',
      responseFailedFallback: '任务操作失败，请稍后重试。',
      refreshFailedTitle: '刷新任务失败',
      sessionStartFailedTitle: '开始任务失败',
      sessionStartFailedFallback: '任务暂时无法开始，请稍后重试。',
    },
    projectActions: {
      currentProject: '当前项目',
      readPathFailedTitle: '读取项目路径失败',
      readPathFailedFallback: '项目路径暂时无法读取，请稍后重试。',
      selectDirectoryFailedTitle: '选择工作目录失败',
      selectedPathUnreadable: '所选路径不存在或不可读。',
      directorySwitchedTitle: '已切换工作目录',
      projectUpdateFailedTitle: '项目操作失败',
      projectUpdateFailedFallback: '暂时无法更新项目，请稍后重试。',
      catalogUnavailable: 'Runtime Host 暂时不可用',
      retryCatalog: '重试加载',
      remoteDirectoryTitle: (host: string) => `在 ${host} 上添加项目`,
      remoteDirectoryBreadcrumbs: '当前文件夹',
      remoteDirectoryHome: '主目录',
      remoteDirectoryEmpty: '此文件夹中没有子文件夹',
      remoteDirectorySelect: '添加此文件夹',
      remoteDirectoryCancel: '取消',
      remoteDirectoryRetry: '重试',
      remoteDirectoryLoading: '正在读取文件夹…',
      remoteDirectoryShowHidden: '显示隐藏目录',
      remoteDirectoryHideHidden: '不显示隐藏目录',
      runtimeHostReadiness: {
        connecting: '连接中',
        reconnecting: '正在重连',
        unavailable: '不可用',
      },
      openFailedTitle: (path: string) => `无法打开${path}`,
      openPathLabels: {
        workspace: '工作区目录',
        skills: 'Skills 目录',
        memory: '记忆目录',
        project: '项目目录',
      },
      openPathFailures: {
        'unknown-key': '未知的工作区目录。',
        'not-allowed': '路径不在允许打开的工作区范围内。',
        missing: '目录不存在。',
        'not-a-directory': '目标不是目录。',
        'open-failed': '系统没有打开该目录。',
        unknown: '无法打开目录。',
      },
    },
    commandActions: {
      connectionVerified: (name: string) => `连接已验证 · ${name}`,
      connectionLatency: (latency: number | string, model?: string) =>
        `延迟 ${latency} ms${model ? ` · ${model}` : ''}`,
      connectionTestFailed: (name: string) => `连接测试失败 · ${name}`,
      testErrorTitle: '测试出错',
      connectionUnavailable: '连接测试暂时不可用，请稍后重试。',
      connectionFailures: {
        rateLimit: '当前账号或模型服务触发速率限制，请稍后重试。',
        timeout: '请求超时，请检查网络或代理后重试。',
        auth: '鉴权失败，请检查模型密钥、订阅账号登录或凭据配置后重试。',
        network: '网络错误，请检查网络或代理后重试。',
        provider: '模型服务返回错误，请稍后重试。',
        unknown: '连接测试失败，请稍后重试。',
      },
      setDefaultSuccess: (name: string) => `已设为默认 · ${name}`,
      setDefaultFailedTitle: '切换默认失败',
      setDefaultFallback: '默认模型暂时无法切换，请稍后重试。',
      newConversation: '新建任务',
      conversationCopiedTitle: '已复制任务为 Markdown',
      lineCount: (lines: number) => `${lines} 行 · 可粘贴到 Notion / Obsidian / GitHub`,
      copyFailedTitle: '复制失败',
      clipboardUnavailable: '剪贴板不可用',
      conversationSavedTitle: '已保存当前任务',
      saveSummary: (lines: number, fileName: string) => `${lines} 行 · 保存为 ${fileName}`,
      saveFailedTitle: '保存失败',
      invalidExport: '导出内容无效',
      writeFailed: '无法写入选择的位置',
      exportFallback: '导出当前任务失败，请稍后重试。',
      memoryOpenFailedTitle: '无法打开 MEMORY.md',
      openFailedTitle: '打开失败',
      memoryOpenFallback: '无法打开 MEMORY.md，请稍后重试。',
      today: '今天',
      reviewCopiedTitle: '已复制今日回顾为 Markdown',
      reviewSummary: (sessions: number, requests: number) => `${sessions} 个任务 · ${requests} 个请求`,
      reviewCopyFallback: '今日回顾暂时不可用，或剪贴板被系统拒绝。',
      reviewPastedTitle: '已追加今日回顾到输入框',
      reviewCopied: (label: string) => `已复制${label}回顾`,
      reviewPasted: (label: string) => `已追加${label}回顾到输入框`,
      reviewSaved: (label: string) => `已保存${label}回顾`,
      reviewSaveFallback: '保存每日回顾失败，请稍后重试。',
      pasteFailedTitle: '粘贴失败',
      reviewUnavailable: '今日回顾暂时不可用，请稍后重试。',
      diagnosticsCopiedTitle: '已复制诊断信息',
      diagnosticsCopiedDescription: '检查内容后，可直接粘贴到问题报告',
      clipboardDenied: '剪贴板不可用或被系统拒绝',
      networkPassedTitle: '网络代理测试通过',
      networkFailedTitle: '网络代理测试失败',
      genericTestFailedTitle: '测试失败',
      networkTestFallback: '网络代理测试暂时不可用，请稍后重试。',
    },
    sessionRowActions: {
      actionFallback: '任务操作失败，请稍后重试。',
      flagFailedTitle: '标记任务失败',
      unflagFailedTitle: '取消标记失败',
      archiveFailedTitle: '归档任务失败',
      unarchiveFailedTitle: '恢复任务失败',
      renameFailedTitle: '重命名任务失败',
      deleteFailedTitle: '删除任务失败',
      currentConversation: '当前任务',
      deleteTitle: (name: string) => `删除 "${name}"`,
      deleteDescription: '任务和全部消息会从磁盘上永久移除。该操作不可撤销。',
      deleteLabel: '删除',
      cancelLabel: '取消',
      deletedTitle: (name: string) => `已删除 ${name}`,
      deleteRestoredTitle: (name: string) => `${name} 已被恢复，未删除`,
    },
    skillActions: {
      refreshSkillsFailedTitle: '刷新技能失败',
      refreshSkillsFallback: '刷新技能失败，请稍后重试。',
      refreshSourcesFailedTitle: '刷新来源库失败',
      refreshSourcesFallback: '刷新来源库失败，请稍后重试。',
      refreshBundledFailedTitle: '刷新内置技能失败',
      refreshBundledFallback: '刷新内置技能失败，请稍后重试。',
      installBundledFailedTitle: '无法安装内置 Skill',
      installBundledFallback: '无法安装内置 Skill，请稍后重试。',
      installedBundledTitle: '已安装内置 Skill',
      installedDescription: (id: string) => `${id}/SKILL.md 已放到当前工作区。`,
      importSourceFailedTitle: '无法导入 Skill 来源',
      importSourceFallback: '无法导入 Skill 来源，请稍后重试。',
      importedSourceTitle: '已导入 Skill 来源',
      installFailedTitle: '无法安装 Skill',
      installFallback: '无法安装 Skill，请稍后重试。',
      installedTitle: '已安装 Skill',
      previewFailedTitle: '无法预览 Skill 更新',
      previewFallback: '无法预览 Skill 更新，请稍后重试。',
      updateFailedTitle: '无法更新 Skill',
      updateFallback: '无法更新 Skill，请稍后重试。',
      updatedTitle: '已更新 Skill',
      forceUpdatedTitle: '已覆盖更新 Skill',
      updatedDescription: (id: string) => `${id}/SKILL.md 已更新到来源库版本。`,
      toggleFailedTitle: '无法切换 Skill',
      toggleFallback: '无法切换 Skill，请稍后重试。',
      enabledTitle: '已启用 Skill',
      disabledTitle: '已停用 Skill',
      pinnedTitle: '已固定到技能上下文',
      unpinnedTitle: '已取消固定',
      runtimeDescription: (name: string) => `${name} 已更新当前项目的运行状态。`,
      deleteFailedTitle: '无法删除 Skill',
      deleteFallback: '无法删除 Skill，请稍后重试。',
      deletedTitle: '已删除 Skill',
      deletedDescription: (id: string) => `${id} 已移除。`,
      openFailedTitle: '无法打开 Skill',
      openFallback: '无法打开 Skill，请稍后重试。',
      openFailures: {
        invalid_id: 'Skill 名称不在允许范围内。',
        missing: '没有找到对应的 SKILL.md。',
        blocked_path: 'Skill 路径不在工作区 skills 目录内，已阻止打开。',
        not_file: '目标不是一个可打开的 SKILL.md 文件。',
        not_directory: '目标不是一个可打开的目录。',
        open_failed: '系统打开文件失败。',
      },
      sourceFailures: {
        invalid_skill: '请选择有效的 SKILL.md 文件。',
        already_exists: '来源库里已经有同名 Skill。',
        blocked_path: '该文件路径不允许导入。',
        write_failed: '写入来源库失败，请检查文件权限。',
        cancelled: '已取消。',
      },
      installFailures: {
        not_found: '没有找到这个 Skill 来源。',
        already_exists: '当前工作区已经有同名 Skill。',
        blocked_path: '目标路径不允许写入。',
        write_failed: '写入工作区失败，请检查文件权限。',
      },
      updateFailures: {
        not_managed: '这个 Skill 不是受管理来源。',
        source_missing: '来源库中找不到对应来源。',
        local_modified: '工作区副本已经被修改。请打开本地文件和来源文件手动比较后再更新。',
        metadata_error: 'Skill 元数据异常，不能安全更新。',
        blocked_path: '目标路径不允许写入。',
        write_failed: '写入工作区失败，请检查文件权限。',
      },
      previewFailures: {
        not_managed: '这个 Skill 不是受管理来源。',
        source_missing: '来源库中找不到对应来源。',
        metadata_error: 'Skill 元数据异常，不能安全预览。',
        blocked_path: '目标路径不允许读取。',
        read_failed: '读取 Skill 内容失败，请检查文件权限。',
      },
      deleteFailures: {
        not_found: '当前工作区找不到这个 Skill。',
        blocked_path: 'Skill 路径不允许删除。',
        blocked_scope: '项目内的 Skill 由仓库管理，请直接在项目里删除。',
        delete_failed: '删除 Skill 失败，请检查文件权限。',
      },
      runtimeFailures: {
        not_found: '当前工作区找不到这个 Skill。',
        blocked_path: 'Skill 状态路径不允许写入。',
        state_error: '当前工作区的 Skill 状态文件异常，需要先修复。',
        write_failed: '写入当前项目的 Skill 状态失败，请检查文件权限。',
      },
    },
    sessionSettingsActions: {
      permissionLabels: {
        ask: '自动',
        bypass: '完全权限',
      },
      permissionDescriptions: {
        explore: '只读：只读取和搜索，写入文件和访问网络会先来问你。',
        ask: '自动：在 Maka 的保护层内执行；需要超出当前权限范围时会先来问你。',
        execute: '兼容模式：等同于自动。',
        bypass: '本地工具直接访问你的文件和网络，不经 Maka 的保护层。',
      },
      bypassConfirmTitle: '切换到完全权限？',
      bypassConfirmDescription:
        '本地工具将直接读写你的文件并访问网络，不经 Maka 的保护层。仅用于你完全信任、或已在外部隔离环境中运行的任务。',
      bypassConfirmLabel: '开启完全权限',
      bypassCancelLabel: '保持自动',
      permissionSwitched: (label: string) => `已切到 ${label}`,
      permissionFailedTitle: '切换权限模式失败',
      permissionFallback: '权限模式暂时无法切换，请稍后重试。',
      modelSwitchedTitle: '已切换当前任务模型',
      modelSwitchedDescription: (from, to) => `${from} → ${to}`,
      modelFailedTitle: '切换模型失败',
      modelFallback: '模型暂时无法切换，请稍后重试。',
      thinkingUpdatedTitle: '已更新思考级别',
      thinkingDefault: '默认',
      thinkingLabels: {
        off: '关',
        minimal: '最少',
        low: '低',
        medium: '中',
        high: '高',
        xhigh: '超高',
        max: '最高',
      },
      thinkingFailedTitle: '切换思考级别失败',
      thinkingFallback: '思考级别暂时无法切换，请稍后重试。',
    },
    goalDialog: {
      title: '设定 Goal',
      description: 'Goal 会在每轮结束后自动续行，直到达成、判定不可行，或触及下面的预算。随时可在输入框上方停止。',
      conditionLabel: '达成条件',
      conditionDescription: '用一句话说明什么算做完；Maka 每轮都据此判断。',
      conditionPlaceholder: '例如：所有测试通过，且 lint 无告警',
      maxIterationsLabel: '最多轮数',
      maxIterationsDescription: '留空使用默认值。',
      maxIterationsInvalid: (max) => `请填 1 到 ${max} 之间的整数，或留空。`,
      tokenBudgetLabel: 'Token 预算',
      tokenBudgetDescription: '留空表示不设 token 上限。',
      tokenBudgetInvalid: (min) => `请填不小于 ${min} 的整数，或留空。`,
      cancel: '取消',
      submit: '开始',
      failedFallback: '无法设定 Goal，请稍后重试。',
    },
    errorBoundary: {
      copyPending: '复制中…',
      copied: '已复制',
      copyFailed: '复制失败',
      copyReport: '复制诊断信息',
      title: 'Maka 渲染层崩溃了',
      descriptionBeforeRetry: '已捕获一次未处理的 React 异常。下面是错误摘要；点',
      retry: '重试',
      descriptionBeforeReload: '清掉这次崩溃，',
      reload: '重新加载',
      descriptionAfterReload: '会刷新整个窗口。需要交接时先复制诊断信息。',
      errorDetails: '错误详情',
      componentStack: '组件栈',
      clipboardFailure: '剪贴板不可用或被系统拒绝；可以手动选择上面的错误摘要。',
    },
    commandPalette: {
      label: '命令面板',
      searchLabel: '命令面板搜索',
      placeholder: '搜索命令、设置项或任务…',
      closeLabel: '关闭命令面板',
      resultsLabel: '命令面板结果',
      emptyTitle: '没有匹配的命令',
      emptyDescription: '换个关键词，或按 Esc 关闭。',
      selectHint: '选择',
      runHint: '执行',
      closeHint: '关闭',
      current: '当前',
      groups: {
        settings: '设置',
        permissions: '权限',
        connections: '连接',
        conversations: '任务',
      },
      staticKeywords: STATIC_COMMAND_KEYWORDS,
      commands: ZH_STATIC_COMMANDS,
      settingsSections: ZH_SETTINGS_SECTIONS,
      permissionModes: {
        explore: { label: '权限 · 只读', hint: '读取和搜索直通，写入和网络仍需确认' },
        ask: { label: '权限 · 自动', hint: '在 Maka 的保护层内运行；需要超出当前权限范围时再询问' },
        execute: {
          label: '权限 · 自动执行',
          hint: '常见工具直通，破坏性操作仍确认',
        },
        bypass: {
          label: '权限 · 完全权限',
          hint: '不经 Maka 的保护层，直接访问你的文件和网络',
        },
      },
      settingsCommand: (section: string) => `设置 · ${section}`,
      testDefaultConnection: (name: string) => `测试默认连接 · ${name}`,
      setDefaultConnection: (name: string) => `设为默认 · ${name}`,
      testConnection: (name: string) => `测试连接 · ${name}`,
      settingsKeywords: (section: SettingsSection, label: string) => [section, label, 'settings', '设置'],
      permissionKeywords: (mode: PermissionMode) => [mode, 'permission', 'mode', '权限', '模式'],
      connectionKeywords: (action: 'default' | 'test', name: string, providerType: string) => [
        action,
        'connection',
        '连接',
        '默认',
        '测试',
        name,
        providerType,
      ],
    },
    keyboardHelp: {
      title: '键盘快捷键',
      sections: [
        {
          heading: '通用',
          rows: [
            {
              keys: ['⌘', 'K'],
              description: '打开命令面板（跳任务 / 设置 / 主题等）',
            },
            { keys: ['?'], description: '打开 / 关闭此快捷键面板' },
            { keys: ['⌘', 'N'], description: '新建任务' },
            { keys: ['⌘', ','], description: '打开设置' },
            {
              keys: ['⌘', 'Shift', 'D'],
              description: '复制当前上下文的诊断信息',
            },
            { keys: ['Esc'], description: '关闭当前模态框' },
          ],
        },
        {
          heading: 'Composer 输入',
          rows: [
            { keys: ['Enter'], description: '发送消息' },
            { keys: ['Shift', 'Enter'], description: '插入换行' },
            { keys: ['Alt', 'Enter'], description: '插入换行（备用）' },
          ],
        },
        {
          heading: '任务列表',
          rows: [
            { keys: ['Tab'], description: '在任务与导航之间移动焦点' },
            { keys: ['↑', '↓'], description: '上下移动聚焦的任务' },
            { keys: ['Home', 'End'], description: '跳到列表顶部 / 底部' },
            { keys: ['Enter'], description: '打开聚焦的任务' },
            { keys: ['Delete'], description: '弹出删除确认（永远不静默删除）' },
            { keys: ['F'], description: '聚焦任务列表搜索框（按 Esc 清空）' },
          ],
        },
        {
          heading: '聊天区',
          rows: [
            { keys: ['Tab'], description: '聚焦工具活动 / 复制按钮' },
            { keys: ['Space', 'Enter'], description: '展开 / 折叠工具调用' },
          ],
        },
        {
          heading: '面板调整',
          rows: [
            { keys: ['Tab'], description: '聚焦左右分割条' },
            { keys: ['←', '→'], description: '微调任务列表宽度（±10 px）' },
            { keys: ['Shift', '←', '→'], description: '快速调整（±50 px）' },
            { keys: ['Home', 'End'], description: '直接拉到最小 / 最大宽度' },
          ],
        },
      ],
    },
    chrome: {
      windowActions: '窗口快捷操作',
      searchConversations: '搜索任务',
      expandSidebar: '展开侧边栏',
      collapseSidebar: '收起侧边栏',
      newTask: '新任务',
      expandWorkbar: '展开任务工作栏',
      collapseWorkbar: '收起任务工作栏',
      workspaceActions: '工作区辅助操作',
    },
    app: {
      loadingWorkbarLabel: '正在加载任务工作栏',
      loadingWorkbar: '正在加载任务工作栏…',
      useSkillPrompt: (skillName: string) => `使用 ${skillName} 技能：`,
      newConversation: '新建任务',
      compactErrorTitle: '压缩失败',
      compactErrorFallback: '任务暂时无法压缩，请稍后重试。',
      slashCommands: {
        compact: { name: '压缩上下文', description: '压缩旧历史并保留当前任务' },
        graph: { name: '使用 Graph', description: '查看、切换或单次运行 Graph' },
        side: { name: '打开侧聊', description: '在右侧开始一个具体话题' },
        swarm: { name: '使用 Swarm', description: '查看、切换或单次运行 Swarm' },
      },
      sideChatUnavailableTitle: '暂时无法打开侧边对话',
      sideChatUnavailableDescription: '请先在主任务中发送一条消息，再使用 /side。',
      sideChatContextPendingTitle: '先处理待发送的上下文',
      sideChatContextPendingDescription:
        '当前 Composer 还有附件、引用或文件 mention。请先发送或移除它们，再使用 /side。',
      resumeStartedTitle: '已开始安全恢复',
      resumeStartedDescription: '正在从最后一个完整执行边界继续',
      resumeFailedTitle: '恢复失败',
      resumeFailedFallback: '无法启动安全恢复，请检查任务状态后重试。',
      goalClearFailedTitle: '停止目标失败',
      goalClearFailedFallback: '目标仍可能继续运行，请立即重试。',
      goalPauseFailedTitle: '暂停目标失败',
      goalPauseFailedFallback: '目标可能仍在自动续行，请立即重试。',
      goalResumeFailedTitle: '恢复目标失败',
      goalResumeFailedFallback: '目标仍处于暂停状态，请重试。',
      appearanceLoadErrorTitle: '载入外观设置失败',
      appearanceLoadErrorFallback: '外观设置暂时无法载入，请稍后重试。',
      memoryRefreshErrorTitle: '刷新本地记忆状态失败',
      memoryLoadErrorTitle: '载入本地记忆状态失败',
      memoryErrorFallback: '本地记忆状态暂时无法刷新，请稍后重试。',
      openModelSettings: '打开设置 · 模型',
      configureModelsOnHost: (hostName: string) =>
        `请先在 ${hostName} 上配置模型连接。`,
      sidebarCollapsed: '侧边栏已收起',
      resizeConversationList: '调整任务列表宽度',
      skipErrorTitle: '跳过失败',
      tryAgainLater: '请稍后重试。',
      updateInstallFailedTitle: '无法安装更新',
      updateInstallFailedFallback: '请稍后重试。',
      updateInstallManualFallback: '请稍后重试，或手动下载最新版本。',
      updateActiveTasksTitle: '仍有任务正在运行',
      updateActiveTasksDescription: '仍有任务正在运行。更新会中断这些任务，是否继续？',
      updateActiveTasksConfirm: '仍然更新',
      updateActiveTasksCancel: '取消',
      updateRetryFailedTitle: '无法重新下载更新',
      updateRetryFailedFallback: '请稍后重试，或手动下载最新版本。',
      loading: '加载中',
      goToModels: '去模型',
      boundaryUnreadableTitle: '暂时读不到这个任务的权限',
      boundaryUnreadableDetail: '在读到之前，这里暂时不能输入。可以重试，或先切换到别的任务。',
      boundaryUnreadableRetry: '重试',
      boundaryUnreadableRetrying: '重试中…',
      permissionModeChanging: '权限模式正在切换，完成后再继续操作。',
      permissionModeStreaming: '当前任务正在流式输出，等结束后再切换权限模式。',
      permissionModeRunning: '当前任务正在运行，等结束后再切换权限模式。',
      permissionModeWaiting: '当前有工具调用正在等待确认，处理后再切换权限模式。',
      modeChangeLoading: '会话还在载入，稍候即可切换模式。',
      modeChanging: '模式正在切换，完成后再继续操作。',
      modeChangeStreaming: '当前任务正在流式输出，等结束后再切换模式。',
      modeChangeRunning: '当前任务正在运行，等结束后再切换模式。',
      modeChangeWaiting: '当前有工具调用正在等待确认，处理后再切换模式。',
      goalTurnActive: 'Goal 从下一轮开始生效。等当前这一轮结束后再设定。',
      planModeFailedTitle: '切换 Plan 模式失败',
      planModeFallback: 'Plan 模式暂时无法切换，请稍后重试。',
      orchestrationModeFailedTitle: '切换编排模式失败',
      orchestrationModeFallback: '编排模式暂时无法切换，请稍后重试。',
      planModeExitPendingTitle: '放弃当前方案？',
      planModeExitPendingDescription: (title: string) =>
        `「${title}」尚未审批。退出 Plan Mode 后，该方案会标记为已放弃，但历史记录仍会保留。`,
      planModeExitConfirm: '放弃并退出',
      planModeExitCancel: '继续规划',
      planModeExecutionActiveTitle: '计划仍在执行',
      planModeExecutionActiveDescription: '请先中断当前执行，再进入 Plan Mode 调整方案。',
      swarmModeEnabledTitle: 'Swarm Mode 已开启',
      swarmModeDisabledTitle: 'Swarm Mode 未开启',
      swarmModeStatusDescription: '使用 /swarm on、/swarm off，或 /swarm <任务> 单次运行。',
      graphModeEnabledTitle: 'Graph Mode 已开启',
      graphModeDisabledTitle: 'Graph Mode 未开启',
      graphModeStatusDescription: '使用 /graph on、/graph off，或 /graph <任务> 单次运行。',
      graphHistoryTitle: 'Graph 历史',
      graphHistoryDescription: '请在 Agent Graph 面板的运行轮次菜单中查看历史记录。',
      resizeWorkbar: '调整任务工作栏宽度',
    },
  },
  en: {
    navigation: { settings: 'Settings' },
    actions: { retry: 'Retry' },
    paths: {
      workspace: 'workspace',
      project: 'project folder',
      skills: 'Skills folder',
    },
    errors: {
      messageRead: 'Task content is temporarily unavailable. Try again later.',
      messageRefresh: 'Task content could not be refreshed. Try again later.',
      openPath: (path: string) => `Could not open the ${path}. Try again later.`,
      workspaceUnavailableTitle: 'Working directory unavailable',
      workspaceUnavailableDescription:
        'The working directory does not exist or cannot be accessed. Select a valid folder for a new task.',
    },
    chatActions: {
      newConversation: 'New task',
      sendFailedTitle: 'Message not sent',
      sendFailedFallback: 'The message could not be sent. Try again later.',
      skillInvocationBlockedTitle: 'Skill invocation failed; message not sent',
      skillInvocationBlockedDescription: (items) => `${items.join(', ')}. Adjust the selection and try again.`,
      skillInvocationFailedTitle: 'Some Skills were not invoked',
      skillInvocationFailedDescription: (items) =>
        `${items.join(', ')}. The remaining Skills were invoked.`,
      skillInvocationFailureReason: {
        invalid_name: 'invalid name',
        not_found: 'not found',
        disabled: 'disabled',
        host_incompatible: 'required tools unavailable',
        resolution_failed: 'resolution failed',
        too_many_requests: 'more than 50 distinct Skill invocation requests',
      },
      responseFailedTitle: 'Response failed',
      responseFailedFallback: 'The task action failed. Try again later.',
      refreshFailedTitle: 'Could not refresh task',
      sessionStartFailedTitle: 'Could not start task',
      sessionStartFailedFallback: 'The task could not be started. Try again later.',
    },
    projectActions: {
      currentProject: 'Current project',
      readPathFailedTitle: 'Could not read project path',
      readPathFailedFallback: 'The project path is temporarily unavailable. Try again later.',
      selectDirectoryFailedTitle: 'Could not select working directory',
      selectedPathUnreadable: 'The selected path does not exist or cannot be read.',
      directorySwitchedTitle: 'Working directory changed',
      projectUpdateFailedTitle: 'Could not update project',
      projectUpdateFailedFallback: 'The project could not be updated. Try again later.',
      catalogUnavailable: 'Runtime Hosts unavailable',
      retryCatalog: 'Retry loading',
      remoteDirectoryTitle: (host: string) => `Add a project on ${host}`,
      remoteDirectoryBreadcrumbs: 'Current folder',
      remoteDirectoryHome: 'Home',
      remoteDirectoryEmpty: 'No folders here',
      remoteDirectorySelect: 'Add this folder',
      remoteDirectoryCancel: 'Cancel',
      remoteDirectoryRetry: 'Retry',
      remoteDirectoryLoading: 'Loading folders…',
      remoteDirectoryShowHidden: 'Show hidden folders',
      remoteDirectoryHideHidden: 'Hide hidden folders',
      runtimeHostReadiness: {
        connecting: 'Connecting',
        reconnecting: 'Reconnecting',
        unavailable: 'Unavailable',
      },
      openFailedTitle: (path: string) => `Could not open ${path}`,
      openPathLabels: {
        workspace: 'workspace folder',
        skills: 'Skills folder',
        memory: 'memory folder',
        project: 'project folder',
      },
      openPathFailures: {
        'unknown-key': 'Unknown workspace folder.',
        'not-allowed': 'The path is outside the folders that Maka can open.',
        missing: 'The folder does not exist.',
        'not-a-directory': 'The target is not a folder.',
        'open-failed': 'The system could not open the folder.',
        unknown: 'The folder could not be opened.',
      },
    },
    commandActions: {
      connectionVerified: (name: string) => `Connection verified · ${name}`,
      connectionLatency: (latency: number | string, model?: string) =>
        `Latency ${latency} ms${model ? ` · ${model}` : ''}`,
      connectionTestFailed: (name: string) => `Connection test failed · ${name}`,
      testErrorTitle: 'Test error',
      connectionUnavailable: 'Connection testing is temporarily unavailable. Try again later.',
      connectionFailures: {
        rateLimit: 'The account or model service is rate limited. Try again later.',
        timeout: 'The request timed out. Check the network or proxy and try again.',
        auth: 'Authentication failed. Check the model key, subscription login, or credentials and try again.',
        network: 'Network error. Check the network or proxy and try again.',
        provider: 'The model service returned an error. Try again later.',
        unknown: 'The connection test failed. Try again later.',
      },
      setDefaultSuccess: (name: string) => `Set as default · ${name}`,
      setDefaultFailedTitle: 'Could not change default',
      setDefaultFallback: 'The default model could not be changed. Try again later.',
      newConversation: 'New task',
      conversationCopiedTitle: 'Task copied as Markdown',
      lineCount: (lines: number) => `${lines} lines · Ready for Notion / Obsidian / GitHub`,
      copyFailedTitle: 'Copy failed',
      clipboardUnavailable: 'Clipboard unavailable',
      conversationSavedTitle: 'Task saved',
      saveSummary: (lines: number, fileName: string) => `${lines} lines · Saved as ${fileName}`,
      saveFailedTitle: 'Save failed',
      invalidExport: 'The export content is invalid',
      writeFailed: 'The selected location could not be written',
      exportFallback: 'The task could not be exported. Try again later.',
      memoryOpenFailedTitle: 'Could not open MEMORY.md',
      openFailedTitle: 'Open failed',
      memoryOpenFallback: 'MEMORY.md could not be opened. Try again later.',
      today: 'Today',
      reviewCopiedTitle: "Today's review copied as Markdown",
      reviewSummary: (sessions: number, requests: number) => `${sessions} tasks · ${requests} requests`,
      reviewCopyFallback: "Today's review is unavailable, or the clipboard was denied.",
      reviewPastedTitle: "Today's review added to the composer",
      reviewCopied: (label: string) => `${label} review copied`,
      reviewPasted: (label: string) => `${label} review added to the composer`,
      reviewSaved: (label: string) => `${label} review saved`,
      reviewSaveFallback: 'The Daily Review could not be saved. Try again later.',
      pasteFailedTitle: 'Paste failed',
      reviewUnavailable: "Today's review is temporarily unavailable. Try again later.",
      diagnosticsCopiedTitle: 'Diagnostics copied',
      diagnosticsCopiedDescription: 'Review the contents, then paste them into the issue report',
      clipboardDenied: 'The clipboard is unavailable or was denied',
      networkPassedTitle: 'Network proxy test passed',
      networkFailedTitle: 'Network proxy test failed',
      genericTestFailedTitle: 'Test failed',
      networkTestFallback: 'Network proxy testing is temporarily unavailable. Try again later.',
    },
    sessionRowActions: {
      actionFallback: 'The task action failed. Try again later.',
      flagFailedTitle: 'Could not flag task',
      unflagFailedTitle: 'Could not remove flag',
      archiveFailedTitle: 'Could not archive task',
      unarchiveFailedTitle: 'Could not restore task',
      renameFailedTitle: 'Could not rename task',
      deleteFailedTitle: 'Could not delete task',
      currentConversation: 'Current task',
      deleteTitle: (name: string) => `Delete "${name}"`,
      deleteDescription:
        'The task and all of its messages will be permanently removed from disk. This cannot be undone.',
      deleteLabel: 'Delete',
      cancelLabel: 'Cancel',
      deletedTitle: (name: string) => `Deleted ${name}`,
      deleteRestoredTitle: (name: string) => `${name} was restored, so it was kept`,
    },
    skillActions: {
      refreshSkillsFailedTitle: 'Could not refresh Skills',
      refreshSkillsFallback: 'Skills could not be refreshed. Try again later.',
      refreshSourcesFailedTitle: 'Could not refresh Skill sources',
      refreshSourcesFallback: 'Skill sources could not be refreshed. Try again later.',
      refreshBundledFailedTitle: 'Could not refresh built-in Skills',
      refreshBundledFallback: 'Built-in Skills could not be refreshed. Try again later.',
      installBundledFailedTitle: 'Could not install built-in Skill',
      installBundledFallback: 'The built-in Skill could not be installed. Try again later.',
      installedBundledTitle: 'Built-in Skill installed',
      installedDescription: (id: string) => `${id}/SKILL.md was added to the current workspace.`,
      importSourceFailedTitle: 'Could not import Skill source',
      importSourceFallback: 'The Skill source could not be imported. Try again later.',
      importedSourceTitle: 'Skill source imported',
      installFailedTitle: 'Could not install Skill',
      installFallback: 'The Skill could not be installed. Try again later.',
      installedTitle: 'Skill installed',
      previewFailedTitle: 'Could not preview Skill update',
      previewFallback: 'The Skill update could not be previewed. Try again later.',
      updateFailedTitle: 'Could not update Skill',
      updateFallback: 'The Skill could not be updated. Try again later.',
      updatedTitle: 'Skill updated',
      forceUpdatedTitle: 'Skill update overwritten',
      updatedDescription: (id: string) => `${id}/SKILL.md was updated to the source-library version.`,
      toggleFailedTitle: 'Could not change Skill status',
      toggleFallback: 'The Skill status could not be changed. Try again later.',
      enabledTitle: 'Skill enabled',
      disabledTitle: 'Skill disabled',
      pinnedTitle: 'Skill pinned to context',
      unpinnedTitle: 'Skill unpinned',
      runtimeDescription: (name: string) => `${name} runtime status was updated for the current project.`,
      deleteFailedTitle: 'Could not delete Skill',
      deleteFallback: 'The Skill could not be deleted. Try again later.',
      deletedTitle: 'Skill deleted',
      deletedDescription: (id: string) => `${id} was removed.`,
      openFailedTitle: 'Could not open Skill',
      openFallback: 'The Skill could not be opened. Try again later.',
      openFailures: {
        invalid_id: 'The Skill name is not allowed.',
        missing: 'The matching SKILL.md was not found.',
        blocked_path: 'The Skill path is outside the workspace skills folder, so opening was blocked.',
        not_file: 'The target is not an openable SKILL.md file.',
        not_directory: 'The target is not an openable folder.',
        open_failed: 'The system could not open the file.',
      },
      sourceFailures: {
        invalid_skill: 'Select a valid SKILL.md file.',
        already_exists: 'A Skill with the same name already exists in the source library.',
        blocked_path: 'This file path cannot be imported.',
        write_failed: 'The source library could not be written. Check file permissions.',
        cancelled: 'Cancelled.',
      },
      installFailures: {
        not_found: 'This Skill source was not found.',
        already_exists: 'A Skill with the same name already exists in this workspace.',
        blocked_path: 'The target path cannot be written.',
        write_failed: 'The workspace could not be written. Check file permissions.',
      },
      updateFailures: {
        not_managed: 'This Skill is not from a managed source.',
        source_missing: 'The matching source was not found in the source library.',
        local_modified:
          'The workspace copy was modified. Open the local and source files to compare them before updating.',
        metadata_error: 'The Skill metadata is invalid, so it cannot be updated safely.',
        blocked_path: 'The target path cannot be written.',
        write_failed: 'The workspace could not be written. Check file permissions.',
      },
      previewFailures: {
        not_managed: 'This Skill is not from a managed source.',
        source_missing: 'The matching source was not found in the source library.',
        metadata_error: 'The Skill metadata is invalid, so it cannot be previewed safely.',
        blocked_path: 'The target path cannot be read.',
        read_failed: 'The Skill content could not be read. Check file permissions.',
      },
      deleteFailures: {
        not_found: 'This Skill was not found in the current workspace.',
        blocked_path: 'The Skill path cannot be deleted.',
        blocked_scope: 'Project Skills are managed by the repository. Delete it from the project instead.',
        delete_failed: 'The Skill could not be deleted. Check file permissions.',
      },
      runtimeFailures: {
        not_found: 'This Skill was not found in the current workspace.',
        blocked_path: 'The Skill status path cannot be written.',
        state_error: 'The Skill status file in this workspace is invalid and must be fixed first.',
        write_failed: 'The Skill status for the current project could not be written. Check file permissions.',
      },
    },
    sessionSettingsActions: {
      permissionLabels: {
        ask: 'Auto',
        bypass: 'Full access',
      },
      permissionDescriptions: {
        explore: 'Read only: reads and searches only; writing files and network access ask you first.',
        ask: "Auto: runs inside Maka's protection layer and asks before anything goes beyond the current permissions.",
        execute: 'Compatibility mode: same as Auto.',
        bypass: "Local tools reach your files and your network directly, outside Maka's protection layer.",
      },
      bypassConfirmTitle: 'Switch to full access?',
      bypassConfirmDescription:
        "Local tools will read and write your files and reach the network directly, outside Maka's protection layer. Use only for tasks you fully trust, or ones already isolated by their environment.",
      bypassConfirmLabel: 'Turn on full access',
      bypassCancelLabel: 'Keep Auto',
      permissionSwitched: (label: string) => `Switched to ${label}`,
      permissionFailedTitle: 'Could not change permission mode',
      permissionFallback: 'The permission mode could not be changed. Try again later.',
      modelSwitchedTitle: 'Task model changed',
      modelSwitchedDescription: (from, to) => `${from} → ${to}`,
      modelFailedTitle: 'Could not change model',
      modelFallback: 'The model could not be changed. Try again later.',
      thinkingUpdatedTitle: 'Thinking level updated',
      thinkingDefault: 'Default',
      thinkingLabels: {
        off: 'Off',
        minimal: 'Minimal',
        low: 'Low',
        medium: 'Medium',
        high: 'High',
        xhigh: 'Extra high',
        max: 'Maximum',
      },
      thinkingFailedTitle: 'Could not change thinking level',
      thinkingFallback: 'The thinking level could not be changed. Try again later.',
    },
    goalDialog: {
      title: 'Set a goal',
      description: 'Maka continues on its own after each turn until the goal is met, judged impossible, or a budget below is reached. You can stop it any time from above the composer.',
      conditionLabel: 'Completion condition',
      conditionDescription: 'One sentence for what counts as done; Maka checks it after every turn.',
      conditionPlaceholder: 'e.g. all tests pass and lint reports no warnings',
      maxIterationsLabel: 'Maximum turns',
      maxIterationsDescription: 'Leave empty to use the default.',
      maxIterationsInvalid: (max) => `Enter a whole number from 1 to ${max}, or leave it empty.`,
      tokenBudgetLabel: 'Token budget',
      tokenBudgetDescription: 'Leave empty for no token ceiling.',
      tokenBudgetInvalid: (min) => `Enter a whole number of at least ${min}, or leave it empty.`,
      cancel: 'Cancel',
      submit: 'Start',
      failedFallback: 'The goal could not be set. Try again.',
    },
    errorBoundary: {
      copyPending: 'Copying…',
      copied: 'Copied',
      copyFailed: 'Copy failed',
      copyReport: 'Copy diagnostics',
      title: 'The Maka renderer crashed',
      descriptionBeforeRetry: 'An unhandled React error was caught. The summary is below. Choose',
      retry: 'Try again',
      descriptionBeforeReload: 'to clear this crash, or',
      reload: 'Reload',
      descriptionAfterReload: 'to refresh the entire window. Copy the diagnostics before handing off the issue.',
      errorDetails: 'Error details',
      componentStack: 'Component stack',
      clipboardFailure: 'The clipboard is unavailable or was denied. You can select the error summary above manually.',
    },
    commandPalette: {
      label: 'Command palette',
      searchLabel: 'Search the command palette',
      placeholder: 'Search commands, settings, or tasks…',
      closeLabel: 'Close command palette',
      resultsLabel: 'Command palette results',
      emptyTitle: 'No matching commands',
      emptyDescription: 'Try another search, or press Esc to close.',
      selectHint: 'Select',
      runHint: 'Run',
      closeHint: 'Close',
      current: 'Current',
      groups: {
        settings: 'Settings',
        permissions: 'Permissions',
        connections: 'Connections',
        conversations: 'Tasks',
      },
      staticKeywords: STATIC_COMMAND_KEYWORDS,
      commands: EN_STATIC_COMMANDS,
      settingsSections: EN_SETTINGS_SECTIONS,
      permissionModes: {
        explore: {
          label: 'Permissions · Read only',
          hint: 'Read and search directly; confirm writes and network access',
        },
        ask: {
          label: 'Permissions · Auto',
          hint: "Run inside Maka's protection layer; ask before going beyond the current permissions",
        },
        execute: {
          label: 'Permissions · Auto execute',
          hint: 'Run common tools; confirm destructive actions',
        },
        bypass: {
          label: 'Permissions · Full access',
          hint: "Reach your files and your network directly, outside Maka's protection layer",
        },
      },
      settingsCommand: (section: string) => `Settings · ${section}`,
      testDefaultConnection: (name: string) => `Test default connection · ${name}`,
      setDefaultConnection: (name: string) => `Set as default · ${name}`,
      testConnection: (name: string) => `Test connection · ${name}`,
      settingsKeywords: (section: SettingsSection, label: string) => [section, label, 'settings', '设置'],
      permissionKeywords: (mode: PermissionMode) => [mode, 'permission', 'mode', '权限', '模式'],
      connectionKeywords: (action: 'default' | 'test', name: string, providerType: string) => [
        action,
        'connection',
        '连接',
        '默认',
        '测试',
        name,
        providerType,
      ],
    },
    keyboardHelp: {
      title: 'Keyboard shortcuts',
      sections: [
        {
          heading: 'General',
          rows: [
            {
              keys: ['⌘', 'K'],
              description: 'Open the command palette (tasks, Settings, themes, and more)',
            },
            { keys: ['?'], description: 'Open or close this shortcuts panel' },
            { keys: ['⌘', 'N'], description: 'Create a new task' },
            { keys: ['⌘', ','], description: 'Open Settings' },
            {
              keys: ['⌘', 'Shift', 'D'],
              description: 'Copy diagnostics for the current context',
            },
            { keys: ['Esc'], description: 'Close the current dialog' },
          ],
        },
        {
          heading: 'Composer',
          rows: [
            { keys: ['Enter'], description: 'Send the message' },
            { keys: ['Shift', 'Enter'], description: 'Insert a line break' },
            {
              keys: ['Alt', 'Enter'],
              description: 'Insert a line break (alternative)',
            },
          ],
        },
        {
          heading: 'Task list',
          rows: [
            {
              keys: ['Tab'],
              description: 'Move focus between tasks and navigation',
            },
            {
              keys: ['↑', '↓'],
              description: 'Move through focused tasks',
            },
            {
              keys: ['Home', 'End'],
              description: 'Jump to the top or bottom of the list',
            },
            { keys: ['Enter'], description: 'Open the focused task' },
            {
              keys: ['Delete'],
              description: 'Open the delete confirmation (never delete silently)',
            },
            {
              keys: ['F'],
              description: 'Focus task search (press Esc to clear)',
            },
          ],
        },
        {
          heading: 'Chat',
          rows: [
            {
              keys: ['Tab'],
              description: 'Focus tool activity and Copy buttons',
            },
            {
              keys: ['Space', 'Enter'],
              description: 'Expand or collapse a tool call',
            },
          ],
        },
        {
          heading: 'Panel sizing',
          rows: [
            { keys: ['Tab'], description: 'Focus the left or right splitter' },
            {
              keys: ['←', '→'],
              description: 'Adjust task-list width (±10 px)',
            },
            {
              keys: ['Shift', '←', '→'],
              description: 'Adjust quickly (±50 px)',
            },
            {
              keys: ['Home', 'End'],
              description: 'Jump directly to minimum or maximum width',
            },
          ],
        },
      ],
    },
    chrome: {
      windowActions: 'Window shortcuts',
      searchConversations: 'Search tasks',
      expandSidebar: 'Expand sidebar',
      collapseSidebar: 'Collapse sidebar',
      newTask: 'New task',
      expandWorkbar: 'Expand task workbar',
      collapseWorkbar: 'Collapse task workbar',
      workspaceActions: 'Workspace actions',
    },
    app: {
      loadingWorkbarLabel: 'Loading task workbar',
      loadingWorkbar: 'Loading task workbar…',
      useSkillPrompt: (skillName: string) => `Use the ${skillName} skill: `,
      newConversation: 'New task',
      compactErrorTitle: 'Compaction failed',
      compactErrorFallback: 'The task could not be compacted. Try again later.',
      slashCommands: {
        compact: { name: 'Compact context', description: 'Compact older history while preserving the current task' },
        graph: { name: 'Use Graph', description: 'Inspect, switch, or run Graph once' },
        side: { name: 'Open side chat', description: 'Start a specific topic in the side panel' },
        swarm: { name: 'Use Swarm', description: 'Inspect, switch, or run Swarm once' },
      },
      sideChatUnavailableTitle: 'Side chat is not available yet',
      sideChatUnavailableDescription:
        'Send a message in the main task before using /side.',
      sideChatContextPendingTitle: 'Resolve pending context first',
      sideChatContextPendingDescription:
        'The Composer still has attachments, quotes, or file mentions. Send or remove them before using /side.',
      resumeStartedTitle: 'Safe recovery started',
      resumeStartedDescription: 'Continuing from the last complete execution boundary',
      resumeFailedTitle: 'Recovery failed',
      resumeFailedFallback: 'Safe recovery could not start. Check the task state and try again.',
      goalClearFailedTitle: 'Could not stop the goal',
      goalClearFailedFallback: 'The goal may still be running. Try again now.',
      goalPauseFailedTitle: 'Could not pause the goal',
      goalPauseFailedFallback: 'The goal may still be continuing. Try again now.',
      goalResumeFailedTitle: 'Could not resume the goal',
      goalResumeFailedFallback: 'The goal is still paused. Try again.',
      appearanceLoadErrorTitle: 'Could not load appearance settings',
      appearanceLoadErrorFallback: 'Appearance settings are temporarily unavailable. Try again later.',
      memoryRefreshErrorTitle: 'Could not refresh local memory status',
      memoryLoadErrorTitle: 'Could not load local memory status',
      memoryErrorFallback: 'Local memory status could not be refreshed. Try again later.',
      openModelSettings: 'Open Settings · Models',
      configureModelsOnHost: (hostName: string) =>
        `Configure a model connection on ${hostName} before starting a task.`,
      sidebarCollapsed: 'Sidebar is collapsed',
      resizeConversationList: 'Resize task list',
      skipErrorTitle: 'Could not skip onboarding',
      tryAgainLater: 'Try again later.',
      updateInstallFailedTitle: 'Could not install update',
      updateInstallFailedFallback: 'Try again later.',
      updateInstallManualFallback: 'Try again later, or download the latest version manually.',
      updateActiveTasksTitle: 'Tasks are still running',
      updateActiveTasksDescription: 'Tasks are still running. Updating will interrupt them. Continue?',
      updateActiveTasksConfirm: 'Update anyway',
      updateActiveTasksCancel: 'Cancel',
      updateRetryFailedTitle: 'Could not retry update download',
      updateRetryFailedFallback: 'Try again later, or download the latest version manually.',
      loading: 'Loading',
      goToModels: 'Go to Models',
      boundaryUnreadableTitle: 'Could not read this task’s permissions',
      boundaryUnreadableDetail:
        'Until they can be read, you cannot type here. Try again, or switch to another task.',
      boundaryUnreadableRetry: 'Try again',
      boundaryUnreadableRetrying: 'Trying again…',
      permissionModeChanging: 'The permission mode is changing. Wait for it to finish before continuing.',
      permissionModeStreaming:
        'This task is streaming. Wait for it to finish before changing the permission mode.',
      permissionModeRunning: 'This task is running. Wait for it to finish before changing the permission mode.',
      permissionModeWaiting: 'A tool call is waiting for confirmation. Respond before changing the permission mode.',
      modeChangeLoading: 'This session is still loading. Its mode can be changed in a moment.',
      modeChanging: 'The mode is changing. Wait for it to finish before continuing.',
      modeChangeStreaming: 'This task is streaming. Wait for it to finish before changing the mode.',
      modeChangeRunning: 'This task is running. Wait for it to finish before changing the mode.',
      modeChangeWaiting: 'A tool call is waiting for confirmation. Respond before changing the mode.',
      goalTurnActive:
        'A goal takes hold on the next turn. Wait for this one to finish before setting one.',
      planModeFailedTitle: 'Could not change Plan mode',
      planModeFallback: 'Plan mode could not be changed. Try again later.',
      orchestrationModeFailedTitle: 'Could not change the orchestration mode',
      orchestrationModeFallback: 'The orchestration mode could not be changed. Try again later.',
      planModeExitPendingTitle: 'Abandon the current plan?',
      planModeExitPendingDescription: (title: string) =>
        `“${title}” has not been approved. Leaving Plan Mode will mark it as abandoned while preserving its history.`,
      planModeExitConfirm: 'Abandon and leave',
      planModeExitCancel: 'Keep planning',
      planModeExecutionActiveTitle: 'The plan is still running',
      planModeExecutionActiveDescription: 'Interrupt the active execution before entering Plan Mode to revise it.',
      swarmModeEnabledTitle: 'Swarm Mode is on',
      swarmModeDisabledTitle: 'Swarm Mode is off',
      swarmModeStatusDescription: 'Use /swarm on, /swarm off, or /swarm <task> for one turn.',
      graphModeEnabledTitle: 'Graph Mode is on',
      graphModeDisabledTitle: 'Graph Mode is off',
      graphModeStatusDescription: 'Use /graph on, /graph off, or /graph <task> for one turn.',
      graphHistoryTitle: 'Graph history',
      graphHistoryDescription: 'Use the run menu in the Agent Graph panel to inspect history.',
      resizeWorkbar: 'Resize task workbar',
    },
  },
} satisfies UiCatalog<ShellCopy>;

export function getShellCopy(locale: UiLocale): ShellCopy {
  return SHELL_COPY_BY_LOCALE[locale];
}

export function localizedShellErrorMessage(error: unknown, fallback: string, locale: UiLocale): string {
  return locale === 'zh' ? generalizedErrorMessageChinese(error, fallback) : generalizedErrorMessage(error, fallback);
}
