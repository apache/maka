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

import type { ProviderRetryReason } from '@maka/core/events';
import type { PermissionMode } from '@maka/core/permission';
import type { SessionBlockedReason, SessionStatus } from '@maka/core/session';
import type { ThinkingLevel } from '@maka/core/model-thinking';
import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';

export type DayPeriod = 'morning' | 'noon' | 'afternoon' | 'evening';

/** Compact token count: 999 → "999", 45,200 → "45.2k", 128,000 → "128k", 1,048,576 → "1M". */
function formatCompactTokenCount(count: number): string {
  if (count < 1_000) return `${count}`;
  if (count >= 1_000_000) {
    const millions = count / 1_000_000;
    return `${millions >= 100 ? Math.round(millions) : Math.round(millions * 10) / 10}M`;
  }
  const thousands = count / 1_000;
  return `${thousands >= 100 ? Math.round(thousands) : Math.round(thousands * 10) / 10}k`;
}

/** Wall-clock units per locale (zh uses words, en letters); each copy entry supplies its own. */
interface DurationUnits {
  second: string;
  minute: string;
  hour: string;
  day: string;
}

/** Humanize a retry delay (seconds) — 1s granularity. zh: `4小时 28分 3秒`, en: `4h 28m 3s`. */
export function formatRetryDelay(seconds: number, units: DurationUnits): string {
  const s = Math.max(1, Math.ceil(seconds));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  const sec = s % 60;
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}${units.day}`);
  if (h > 0) parts.push(`${h}${units.hour}`);
  if (m > 0) parts.push(`${m}${units.minute}`);
  if (sec > 0 || parts.length === 0) parts.push(`${sec}${units.second}`);
  return parts.join(' ');
}

/** One shared elapsed ladder so the zh/en goalElapsed entries cannot drift. */
function formatGoalElapsedUnits(elapsedMs: number, units: DurationUnits): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (seconds < 60) return `${seconds}${units.second}`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}${units.minute}`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) {
    return restMinutes === 0
      ? `${hours}${units.hour}`
      : `${hours}${units.hour} ${restMinutes}${units.minute}`;
  }
  return `${Math.floor(hours / 24)}${units.day} ${hours % 24}${units.hour}`;
}

export interface ConversationCopy {
  empty: {
    ariaLabel: string;
    surfaceAriaLabel: string;
    greeting: Record<DayPeriod, string>;
    greetingTail: Record<DayPeriod, string>;
    headlineWithLabel: (greeting: string, label: string) => string;
    headlineFallback: (greeting: string, tail: string) => string;
  };
  composer: {
    placeholder: string;
    textareaAriaLabel: string;
    pastedQuoteLabel: string;
    selectedSkillsAriaLabel: string;
    removeSkillAriaLabel(name: string): string;
    awaitingPermission: string;
    sending: string;
    importing: string;
    sendLabel: string;
    queuedMessagesAriaLabel(count: number): string;
    steeringPending: string;
    followupPending: string;
    queueShortcutsLabel: string;
    queueShortcuts: { apple: string; other: string };
    promoteQueuedEntry: string;
    editQueuedEntry: string;
    saveQueuedEntry: string;
    cancelQueuedEntryEdit: string;
    deleteQueuedEntry: string;
    reorderQueuedEntry: string;
    stopLabel: string;
    stopping: string;
    addContext: string;
    /** Noun label for the composer drawer's staged quotes/attachments — the
     *  collapsed badge, the drawer group's accessible name, and the collapse
     *  toggle's "收起{label}" interpolation. `addContext` stays the ＋ menu's
     *  ACTION label; reusing the verb phrase here made the collapsed drawer
     *  read like a button. */
    stagedContext: string;
    selectModel: string;
    dropToImport: string;
    addingAttachment: string;
    addFileOrDirectory: string;
    referenceFolder: string;
    /** The ＋ menu entry that opens the `/` Skill menu. */
    chooseSkill: string;
    /** Why that entry is unavailable: the catalog is empty. */
    noSkillsAvailable: string;
    /** The ＋ menu entry that opens the Goal dialog. */
    setGoal: string;
    /** Why that entry is unavailable: this Session already has an unfinished Goal. */
    goalAlreadySet: string;
    switchDisabledStreaming: string;
    switchDisabledRunning: string;
    switchDisabledPermission: string;
    /** Same three lock states as the model switcher, worded for the thinking-level menu beside it. */
    thinkingDisabledStreaming: string;
    thinkingDisabledRunning: string;
    thinkingDisabledPermission: string;
    orchestrationModeAriaLabel: string;
    planModeLabel: string;
    enablePlanMode: string;
    disablePlanMode: string;
    planModeOnTitle: string;
    swarmModeLabel: string;
    swarmModeOnTitle: string;
    graphModeLabel: string;
    graphModeOnTitle: string;
    /** Inline hint shown above the composer when no model connection exists yet. */
    noModelHint: string;
    /** Link-button on that hint that opens Settings · 模型. */
    noModelAction: string;
    /** Explanatory title on the disabled Send button in the no-model state. */
    noModelSendTitle: string;
  };
  model: {
    thinkingLevel: string;
    thinkingUnsupported: string;
    changeThinkingLevel: string;
    defaultLevel: string;
    level: Record<ThinkingLevel, string>;
    switching: string;
    model: string;
    switchAriaLabel: string;
    switchWarning: string;
    /** Secondary line on the cache warning row: activating the row dismisses it. */
    switchWarningDismiss: string;
    newChatAriaLabel: (label: string) => string;
    newChatTitle: (label: string) => string;
    configureAriaLabel: (label: string) => string;
    configureTitle: string;
  };
  permissions: {
    mode: Record<PermissionMode, { label: string; hint: string }>;
    modeAriaLabel: (label: string) => string;
  };
  sandboxBoundary: {
    title: string;
    access: Record<'read' | 'write', string>;
    scope: Record<'exact' | 'subtree', string>;
    network: string;
    enabled: string;
    reject: string;
    allowSession: string;
  };
  clientCapability: {
    title: string;
    browser: (origin: string) => string;
    computerUse: string;
    desktopMcp: (serverId: string, toolName: string) => string;
    sessionNotice: string;
    reject: string;
    allowSession: string;
  };
  questions: {
    otherAriaLabel: string;
    otherPlaceholder: string;
    stop: string;
    stopping: string;
    previous: string;
    submitting: string;
    submit: string;
    next: string;
  };
  forms: {
    keyboardHint: string;
    requester: (name: string) => string;
    requesterWithSource: (name: string, source: string) => string;
    required: string;
    optional: string;
    include: (label: string) => string;
    enabled: (label: string) => string;
    enterValue: string;
    enterNumber: string;
    constraintSeparator: string;
    lengthConstraint: (minimum: number | undefined, maximum: number | undefined) => string;
    numberConstraint: (minimum: number | undefined, maximum: number | undefined) => string;
    itemConstraint: (minimum: number | undefined, maximum: number | undefined) => string;
    formatConstraint: Record<'email' | 'uri' | 'date' | 'date-time', string>;
    invalid: string;
    cancel: string;
    decline: string;
    accept: string;
    submitting: string;
  };
  mentions: {
    noFiles: string;
    noFilesOrSessions: string;
    noSkills: string;
    noCommandsOrSkills: string;
    filesAriaLabel: string;
    filesAndSessionsAriaLabel: string;
    sessionsGroup: string;
    skillsAriaLabel: string;
    commandsAndSkillsAriaLabel: string;
    commandsGroup: string;
    skillsGroup: string;
    loading: string;
    sessionReferenceUnavailableTitle: string;
    sessionReferenceUnavailableDetail: string;
    sessionReferenceEmptyTitle: string;
    sessionReferenceEmptyDetail: string;
    sessionReferenceReadFailedTitle: string;
    sessionReferenceReadFailedDetail: string;
    sessionReferenceLimitDetail: string;
  };
  workspace: {
    choose: string;
    current: string;
    /** The picker's create action; the dialog that follows names the project. */
    newProject: string;
    /** Header of the New project dialog. */
    newProjectTitle: string;
    /** One line under the header: name first, folder next. */
    newProjectDescription: string;
    newProjectNameLabel: string;
    /** The dialog's submit, which opens the folder picker. */
    newProjectSubmit: string;
    manageProjects: string;
    noProject: string;
    relink: string;
    unavailable: string;
    chooseTitle: (branch?: string) => string;
    chooseAriaLabel: (label: string, branch?: string) => string;
  };
  messages: {
    you: string;
    assistant: string;
    processing: string;
    workingPhrases: readonly string[];
    processDetails: string;
    processDuration: (minutes: number, seconds: number) => string;
    turnStatusCompleted: (elapsed?: string) => string;
    turnStatusAborted: (elapsed?: string) => string;
    turnStatusFailed: (elapsed?: string) => string;
    providerRetryScheduled: (seconds: number, attempt: number, maxAttempts: number) => string;
    providerRetryStarted: (attempt: number, maxAttempts: number) => string;
    providerRetryWaiting: (attempt: number, maxAttempts: number) => string;
    providerRetryReason: Record<ProviderRetryReason, string>;
    failureDetailsUnavailable: string;
    safeResumePending: string;
    safeResume: string;
    thinking: string;
    truncated: string;
    copied: string;
    copying: string;
    copyFailed: string;
    copy: string;
    editMessage: string;
    editMessageDisabledRunning: string;
    editMessageDisabledAttachments: string;
    editMessageDisabledDirectoryReferences: string;
    editMessageDisabledQuotes: string;
    editMessageDisabledTransformedText: string;
    userAriaLabel: string;
    systemAriaLabel: string;
    assistantAriaLabel: string;
    answerActionsAriaLabel: (context: string) => string;
    answerActionAriaLabel: (action: string, context: string) => string;
    messageActionAriaLabel: (action: string, context: string) => string;
    sourceAriaLabel: string;
    derivativesAriaLabel: string;
    scheduledTaskTriggered: string;
    scheduledTaskTitle: (id: string) => string;
    legacyAutomationTriggered: string;
    legacyAutomationTitle: (id: string) => string;
    goalContinued: string;
    goalTitle: (id: string) => string;
    agentGraphTriggered: string;
    agentGraphTitle: (graphId: string) => string;
    thinkingTruncatedTitle: string;
    outputTruncatedTitle: string;
    removeAttachmentAriaLabel: (name: string) => string;
    quoteLabel: string;
    sessionSnapshotLabel(name: string): string;
    sessionSnapshotPending: string;
    sessionSnapshotCaptured(iso: string, truncated: boolean): string;
    quoteExpandAriaLabel: string;
    quoteCollapseAriaLabel: string;
    removeQuoteAriaLabel: string;
    systemNotes: {
      contextCompacting: string;
      contextCompactionUnobserved: string;
      contextCompacted: string;
      contextCompactionFailedOpen: string;
      contextProviderDropping: (used: number, prior: number) => string;
      contextWindowSuggestion: (tokens: number, declared: number | undefined) => string;
      contextWindowOverrun: (used: number, declared: number) => string;
      contextReportedWindowExceeded: (used: number, reported: number) => string;
      contextOverflowAfterCompaction: string;
      contextUsageLabel: string;
      contextUsageShare: (used: number, window: number) => string;
      contextUsageNoWindow: (used: number) => string;
      contextUsageUnavailable: string;
      contextUsageOpen: string;
      stepLimit: string;
    };
  };
  chat: {
    conversationAriaLabel: (name: string) => string;
    memory: string;
    memoryAriaLabel: string;
    memoryTitle: string;
    clearGoal: (condition: string, iteration: number, max: number, status: string) => string;
    clearGoalAriaLabel: (iteration: number, max: number) => string;
    goalProgress: (iteration: number, max: number) => string;
    goalRunningAriaLabel: string;
    goalWaitingAriaLabel: string;
    goalPausedAriaLabel: string;
    pauseGoalAriaLabel: (iteration: number, max: number) => string;
    resumeGoalAriaLabel: (iteration: number, max: number) => string;
    pauseGoal: (condition: string, iteration: number, max: number, status: string) => string;
    resumeGoal: (condition: string, iteration: number, max: number) => string;
    /** Wall-clock elapsed label for the goal chip, e.g. "12m". */
    goalElapsed: (elapsedMs: number) => string;
    /** Token usage label for the goal chip when a budget exists, e.g. "12k / 100k". */
    goalTokens: (spent: number, budget: number) => string;
    loadFailed: string;
    loading: string;
    retryLoad: string;
    loadEarlierHistory: string;
    quoteSelection: string;
    askInSidePanel: string;
    noMessages: string;
    branchBeforeInterrupt: string;
    sessionContextAriaLabel: string;
    sessionLineageAriaLabel: string;
    titlebarIdentityAriaLabel: string;
    openProjectFolderAction: string;
    projectInfo: string;
    copyProjectPath: string;
    openParentSession: (name: string) => string;
    sessionContextMore: (count: number) => string;
    revisionVersionsAriaLabel: string;
    revisionVersion: (current: number, total: number) => string;
    previousRevision: string;
    nextRevision: string;
  };
  sessions: {
    status: Record<SessionStatus, string>;
    blockedReason: Record<SessionBlockedReason, string>;
    listAriaLabel: string;
    showMore: string;
    showMoreAriaLabel: (count: number) => string;
    renameAriaLabel: string;
    /**
     * Title of the rename dialog when the subject is a project; a session's
     * reuses `renameAriaLabel`, which is the same phrase the sidebar and the
     * titlebar already use for it.
     */
    renameProjectTitle: string;
    /** The rename dialog's submit button. */
    renameSubmit: string;
    respondingAriaLabel: string;
    respondingTitle: string;
    staleTitle: string;
    staleAriaLabel: string;
    stale: string;
    unreadAriaLabel: string;
    actionsAriaLabel: (name: string) => string;
    pin: string;
    unpin: string;
    rename: string;
    archive: string;
    unarchive: string;
    delete: string;
    /** Row-menu submenu that re-files one task into another project. */
    moveToProject: string;
    /** The submenu's clearing choice: leave the task with no project. */
    moveToNoProject: string;
    pinned: string;
    /** Time-sort unpinned section title (SideNavSection). */
    recent: string;
    /** Project-sort section title, sibling of `pinned` (SideNavSection). */
    projects: string;
    groupByTime: string;
    groupByProject: string;
    groupingAriaLabel: string;
    projectActionsAriaLabel: (name: string) => string;
    projectNewTask: string;
    projectRename: string;
    projectArchive: string;
    projectRestore: string;
    projectRelink: string;
    projectUnavailable: string;
    archivedProjects: string;
    archivedProjectsAriaLabel: string;
    worktreeAriaLabel: string;
    promptRailAriaLabel: string;
    emptyPrompt: string;
    jumpToPrompt: (preview: string) => string;
    /** Said about a picked row that is not the open one. */
    pickedAriaLabel: string;
    /** The row menu's verbs when the picked set is more than this one row. */
    pinCount: (count: number) => string;
    unpinCount: (count: number) => string;
    archiveCount: (count: number) => string;
  };
}

const CONVERSATION_COPY = {
  'zh-CN': {
    empty: {
      ariaLabel: '开始任务',
      surfaceAriaLabel: '新任务对话',
      greeting: { morning: '早上好', noon: '中午好', afternoon: '下午好', evening: '晚上好' },
      greetingTail: { morning: '清醒的早晨适合理清思路', noon: '专注的午间适合一鼓作气', afternoon: '舒缓的下午适合慢慢推进', evening: '安静的夜晚适合深度思考' },
      headlineWithLabel: (greeting, label) => `${greeting} ${label}，今天想做点什么？`, headlineFallback: (greeting, tail) => `${greeting}，${tail}。`,
    },
    composer: {
      placeholder: '描述任务，@ 引用文件或会话，/ 选择技能…', textareaAriaLabel: '消息输入框', pastedQuoteLabel: '粘贴的文本', selectedSkillsAriaLabel: '已选择的 Skill', removeSkillAriaLabel: (name) => `移除 Skill：${name}`, awaitingPermission: '等待你确认权限…',
      sending: '正在发送…', importing: '正在导入…', sendLabel: '发送',
      queuedMessagesAriaLabel: (count) => `${count} 条待发送消息`,
      steeringPending: '调整方向 · 等待整批生效',
      followupPending: '下一轮 · 每轮一条',
      queueShortcutsLabel: '发送快捷键',
      queueShortcuts: { apple: 'Cmd+Enter：转向（Steering）\nEnter：下一轮（Follow-up）\nShift+Enter：换行', other: 'Ctrl+Enter：转向（Steering）\nEnter：下一轮（Follow-up）\nShift+Enter：换行' },
      promoteQueuedEntry: '调整方向', editQueuedEntry: '编辑', saveQueuedEntry: '保存', cancelQueuedEntryEdit: '取消编辑', deleteQueuedEntry: '删除', reorderQueuedEntry: '拖动排序',
      stopLabel: '停止', stopping: '停止中…',
      addContext: '添加上下文', stagedContext: '附加内容',
      selectModel: '选择模型', dropToImport: '松开以导入文件内容', addingAttachment: '正在添加附件', addFileOrDirectory: '添加文件', referenceFolder: '引用文件夹',
      chooseSkill: '选择技能', noSkillsAvailable: '当前没有可用技能',
      setGoal: '设定 Goal…', goalAlreadySet: '当前会话已有进行中的 Goal',
      switchDisabledStreaming: '当前任务正在流式输出，等结束后再切换模型。', switchDisabledRunning: '当前任务正在运行，等结束后再切换模型。', switchDisabledPermission: '当前有工具调用正在等待确认，处理后再切换模型。',
      thinkingDisabledStreaming: '当前任务正在流式输出，等结束后再切换思考级别。', thinkingDisabledRunning: '当前任务正在运行，等结束后再切换思考级别。', thinkingDisabledPermission: '当前有工具调用正在等待确认，处理后再切换思考级别。',
      orchestrationModeAriaLabel: '编排模式',
      planModeLabel: 'Plan', enablePlanMode: '开启 Plan Mode', disablePlanMode: '退出 Plan Mode',
      planModeOnTitle: 'Plan 模式已启用，点击关闭',
      swarmModeLabel: 'Swarm', swarmModeOnTitle: 'Swarm 模式已启用，点击关闭',
      graphModeLabel: 'Graph', graphModeOnTitle: 'Graph 模式已启用，点击关闭',
      noModelHint: '还没有可用的模型连接，无法发送。', noModelAction: '前往模型设置', noModelSendTitle: '先添加一个模型连接才能发送。',
    },
    model: {
      thinkingLevel: '思考级别', thinkingUnsupported: '当前模型不支持思考级别切换', changeThinkingLevel: '切换当前模型的思考级别', defaultLevel: '默认',
      // Short single-token labels — trigger + popout size to content.
      // Canonical per-chat ladder: 默认 (model default, overriding Settings) / 关 / 低 / 中 / 高 / 超高
      // (minimal/max when offered).
      level: { off: '关', minimal: '最少', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高' },
      switching: '切换中', model: '模型', switchAriaLabel: '切换当前任务模型',
      switchWarning: '切换模型可能需要重建服务商提示缓存，使下一次请求更慢或成本更高。',
      switchWarningDismiss: '选择即可关闭',
      newChatAriaLabel: (label) => `选择新任务模型，当前 ${label}`, newChatTitle: (label) => `新任务使用的模型：${label}`,
      configureAriaLabel: (label) => `配置模型连接，当前 ${label}`, configureTitle: '配置模型连接',
    },
    permissions: {
      mode: {
        explore: { label: '只读', hint: '只读搜索，不写文件、不上网；需要时先问你。' },
        ask: { label: '自动', hint: '保护层内自动执行，越权先问你。' },
        bypass: { label: '完全权限', hint: '直接访问文件和网络，仅限可信任务。' },
      },
      modeAriaLabel: (label) => `权限模式：${label}`,
    },
    sandboxBoundary: {
      title: '允许访问工作区以外的内容？',
      access: { read: '读取', write: '写入' },
      scope: { exact: '仅此路径', subtree: '目录及子目录' },
      network: '网络访问',
      enabled: '已启用',
      reject: '拒绝',
      allowSession: '本任务允许',
    },
    clientCapability: {
      title: '允许使用客户端能力？',
      browser: (origin) => `允许 Browser 操作 ${origin}`,
      computerUse: '允许 Computer Use 操作这台 Mac',
      desktopMcp: (serverId, toolName) => `允许调用 ${serverId} 的 ${toolName} 工具`,
      sessionNotice: '允许后，本任务中相同范围的后续操作将不再询问。',
      reject: '拒绝',
      allowSession: '本任务允许',
    },
    questions: { otherAriaLabel: '其他答案', otherPlaceholder: '输入你的答案', stop: '停止', stopping: '停止中…', previous: '上一题', submitting: '正在提交…', submit: '提交答案', next: '下一题' },
    forms: { keyboardHint: '1–9 选择 · ↑↓ 切换 · Enter 确认 · Esc 取消', requester: (name) => `由 ${name} 请求`, requesterWithSource: (name, source) => `由 ${name} 请求 · ${source}`, required: '必填', optional: '选填', include: (label) => `提供：${label}`, enabled: (label) => `启用：${label}`, enterValue: '输入内容', enterNumber: '输入数字', constraintSeparator: '；', lengthConstraint: (minimum, maximum) => minimum === undefined ? `最多 ${maximum} 个字符` : maximum === undefined ? `至少 ${minimum} 个字符` : `长度 ${minimum}–${maximum} 个字符`, numberConstraint: (minimum, maximum) => minimum === undefined ? `最大值 ${maximum}` : maximum === undefined ? `最小值 ${minimum}` : `范围 ${minimum}–${maximum}`, itemConstraint: (minimum, maximum) => minimum === undefined ? `最多选择 ${maximum} 项` : maximum === undefined ? `至少选择 ${minimum} 项` : `选择 ${minimum}–${maximum} 项`, formatConstraint: { email: '格式：email', uri: '格式：URI', date: '格式：date（YYYY-MM-DD）', 'date-time': '格式：date-time（RFC 3339）' }, invalid: '请提供符合要求的值。', cancel: '取消', decline: '拒绝', accept: '提交', submitting: '正在提交…' },
    mentions: { noFiles: '未找到文件', noFilesOrSessions: '未找到文件或会话', noSkills: '暂无技能', noCommandsOrSkills: '没有匹配的命令或技能', filesAriaLabel: '工作区文件', filesAndSessionsAriaLabel: '工作区文件和会话', sessionsGroup: '会话', skillsAriaLabel: '技能', commandsAndSkillsAriaLabel: '命令和技能', commandsGroup: '命令', skillsGroup: 'Skills', loading: '加载中…', sessionReferenceUnavailableTitle: '无法引用会话', sessionReferenceUnavailableDetail: '该会话已不可用，请刷新任务列表后重试。', sessionReferenceEmptyTitle: '会话没有可引用内容', sessionReferenceEmptyDetail: '只会引用用户和助手文本；工具调用等内部记录不会注入当前任务。', sessionReferenceReadFailedTitle: '读取会话失败', sessionReferenceReadFailedDetail: '无法读取该会话的快照，请稍后重试。', sessionReferenceLimitDetail: '引用总数最多为 16，请移除部分引用后重试。' },
    workspace: {
      choose: '选择项目', current: '当前项目', newProject: '新建项目', newProjectTitle: '新建项目', newProjectDescription: '先给项目起个名字，再选择它所在的文件夹。', newProjectNameLabel: '项目名称', newProjectSubmit: '选择文件夹', manageProjects: '管理项目', noProject: '无项目', relink: '重新定位', unavailable: '不可用',
      chooseTitle: (branch) => branch ? `选择项目 · ${branch}` : '选择项目',
      chooseAriaLabel: (label, branch) => branch ? `选择项目：${label}，当前分支 ${branch}` : `选择项目：${label}`,
    },
    messages: {
      you: '你', assistant: 'Maka', processing: '正在处理…', workingPhrases: ['正在琢磨…', '正在推敲…', '正在盘算…', '正在钻研…', '正在忙活…', '正在梳理…', '正在打磨…', '正在鼓捣…', '正在酝酿…', '正在攻坚…', '正在权衡…', '正在拾掇…'], processDetails: '执行过程', processDuration: (minutes, seconds) => `用时 ${minutes > 0 ? `${minutes} 分 ` : ''}${seconds} 秒`, turnStatusCompleted: (elapsed?: string) => ['已完成', elapsed].filter(Boolean).join(' · '), turnStatusAborted: (elapsed?: string) => ['已中止', elapsed].filter(Boolean).join(' · '), turnStatusFailed: (elapsed?: string) => ['失败', elapsed].filter(Boolean).join(' · '), providerRetryScheduled: (seconds, attempt, maxAttempts) => `${formatRetryDelay(seconds, { day: '天', hour: '小时', minute: '分', second: '秒' })}后重试（${attempt}/${maxAttempts}）`, providerRetryStarted: (attempt, maxAttempts) => `正在重试（${attempt}/${maxAttempts}）`, providerRetryWaiting: (attempt, maxAttempts) => `等待重试（${attempt}/${maxAttempts}）`, providerRetryReason: { stream_truncated: '响应中途断开', network: '网络中断', provider_capacity: '模型服务暂时满载', provider_unavailable: '模型服务暂时不可用', rate_limit: '触发模型速率限制', timeout: '请求超时', unknown: '模型请求失败' }, failureDetailsUnavailable: '无可用诊断详情。', safeResumePending: '正在检查…', safeResume: '继续这一轮', thinking: '深度思考', truncated: '已截断', copied: '已复制', copying: '复制中', copyFailed: '复制失败', copy: '复制', editMessage: '编辑并重发', editMessageDisabledRunning: '当前回答仍在进行中，结束后再编辑', editMessageDisabledAttachments: '包含附件的历史消息暂不支持编辑并重发', editMessageDisabledQuotes: '包含引用的历史消息暂不支持编辑并重发', editMessageDisabledTransformedText: '包含已展开上下文的历史消息暂不支持编辑并重发',
      editMessageDisabledDirectoryReferences: '包含文件夹引用的历史消息暂不支持编辑并重发',
      userAriaLabel: '你发送的消息', systemAriaLabel: '系统消息', assistantAriaLabel: 'Maka 的回答', answerActionsAriaLabel: (context) => `回答操作${context ? `：${context}` : ''}`, answerActionAriaLabel: (action, context) => `${action}回答${context ? `：${context}` : ''}`, messageActionAriaLabel: (action, context) => `${action}消息${context ? `：${context}` : ''}`, sourceAriaLabel: '本轮回答的来源', derivativesAriaLabel: '本轮回答的衍生', scheduledTaskTriggered: '定时任务触发', scheduledTaskTitle: (id) => `由定时任务触发 · ${id}`, legacyAutomationTriggered: '旧版自动化（仅历史）', legacyAutomationTitle: (id) => `由旧版自动化触发 · ${id} · 仅保留历史，不会再次执行`, goalContinued: 'Goal 自动继续', goalTitle: (id) => `由 Goal 继续执行 · ${id}`, agentGraphTriggered: 'Agent Graph 自动继续', agentGraphTitle: (graphId) => `由 Agent Graph 调度器触发 · ${graphId}`,
      thinkingTruncatedTitle: '部分 reasoning 已截断；显示的是最近的内容', outputTruncatedTitle: '助手输出已超过单次回合上限，超出部分未渲染。如需完整内容请重新生成或查看持久化的任务日志。', removeAttachmentAriaLabel: (name) => `移除 ${name}`, quoteLabel: '引用', sessionSnapshotLabel: (name) => `会话：${name}`, sessionSnapshotPending: '发送时截取快照', sessionSnapshotCaptured: (iso, truncated) => `快照时间 ${iso}${truncated ? ' · 内容已截断' : ''}`, quoteExpandAriaLabel: '展开引用全文', quoteCollapseAriaLabel: '收起引用', removeQuoteAriaLabel: '移除引用',
      systemNotes: {
        contextCompacting: '正在压缩上下文…',
        contextCompactionUnobserved: '上下文压缩状态暂不可用',
        contextCompacted: '已压缩较早的上下文。',
        contextCompactionFailedOpen: '上下文压缩失败。',
        contextProviderDropping: (used, prior) =>
          `追加内容后，供应商报告的输入 token 数没有增长，可能发生了上下文裁剪或改写（${used.toLocaleString('zh-CN')} tokens，与之前的 ${prior.toLocaleString('zh-CN')} 相比没有增长）。如果持续出现，请检查模型实际支持的上下文容量与连接设置是否一致。`,
        contextWindowSuggestion: (tokens, declared) =>
          declared === undefined
            ? `供应商拒绝了这次请求。该模型未声明上下文窗口；上次成功的用量约 ${tokens} tokens，可将窗口设为该值让 Maka 先行压缩。`
            : `供应商拒绝了这次请求，但用量（约 ${tokens} tokens）低于你声明的窗口（${declared}）。声明值可能大于供应商实际窗口，建议下调到 ${tokens}。`,
        contextWindowOverrun: (used, declared) =>
          `本次交换用了约 ${used} tokens，超过你声明的窗口（${declared}）：回复需要的空间比剩余的多。Maka 会在下一次请求前压缩；若希望回复保持完整，可调大窗口。`,
        contextReportedWindowExceeded: (used, reported) =>
          `本次交换用了约 ${used} tokens，已超过该模型上报的窗口（${reported}），但供应商没有拒绝。你未声明窗口，Maka 因此不会主动压缩。在连接设置里声明一个窗口即可让它先行压缩。`,
        contextOverflowAfterCompaction:
          '已经压缩过历史，供应商仍然说这次请求太大。剩下的部分还包含系统提示、工具定义、摘要和最近的原文，缩短这条消息是你能控制的那一半。',
        contextUsageLabel: '用量',
        contextUsageShare: (used, window) =>
          `上下文窗口：已用 ${Math.round((used / window) * 100)}%（${formatCompactTokenCount(used)} / ${formatCompactTokenCount(window)} token）`,
        contextUsageNoWindow: (used) =>
          `已用 ${formatCompactTokenCount(used)} token；上下文窗口上限未知`,
        contextUsageUnavailable: '暂无用量数据',
        contextUsageOpen: '打开用量追踪',
        stepLimit: '已达到本轮工具步骤上限，任务可能尚未完成。发送“继续”即可接着处理。',
      },
    },
    chat: {
      conversationAriaLabel: (name) => `对话：${name}`,
      memory: '记忆', memoryAriaLabel: '本地记忆已启用', memoryTitle: '本地 MEMORY.md 已加入 agent 系统提示。点击进入设置 · 记忆管理。',
      clearGoal: (condition, iteration, max, status) => `自主执行目标进行中：「${condition}」（第 ${iteration}/${max} 轮，${status}）。系统每轮后自动续行；点击可清除目标、停止续行。`, clearGoalAriaLabel: (iteration, max) => `清除自主执行目标（已进行 ${iteration}/${max} 轮）`, goalProgress: (iteration, max) => `目标 ${iteration} / ${max}`, goalRunningAriaLabel: '自主目标正在运行', goalWaitingAriaLabel: '自主目标正在等待条件变化',
      goalPausedAriaLabel: '自主目标已暂停', pauseGoalAriaLabel: (iteration, max) => `暂停自主执行目标（已进行 ${iteration}/${max} 轮）`, resumeGoalAriaLabel: (iteration, max) => `恢复自主执行目标（已进行 ${iteration}/${max} 轮）`, pauseGoal: (condition, iteration, max, status) => `暂停自主执行目标：「${condition}」（第 ${iteration}/${max} 轮，${status}）。暂停后立即停止自动续行，不再消耗令牌；可随时恢复。`, resumeGoal: (condition, iteration, max) => `恢复自主执行目标：「${condition}」（第 ${iteration}/${max} 轮）。恢复后立即继续自动续行。`, goalElapsed: (elapsedMs) => formatGoalElapsedUnits(elapsedMs, { second: ' 秒', minute: ' 分钟', hour: ' 小时', day: ' 天' }), goalTokens: (spent, budget) => `${formatCompactTokenCount(spent)} / ${formatCompactTokenCount(budget)}`,
      loadFailed: '任务载入失败', loading: '载入中…', retryLoad: '重试载入', loadEarlierHistory: '载入更早的记录', quoteSelection: '引用', askInSidePanel: '在侧栏追问', noMessages: '暂无消息',
      branchBeforeInterrupt: '从中断前分支', sessionContextAriaLabel: '任务上下文', sessionLineageAriaLabel: '任务来源', sessionContextMore: (count) => `更多任务上下文（${count}）`,
      titlebarIdentityAriaLabel: '当前任务', openProjectFolderAction: '打开项目文件夹', projectInfo: '项目信息', copyProjectPath: '复制路径',
      openParentSession: (name) => `返回父任务「${name}」`,
      revisionVersionsAriaLabel: '任务版本', revisionVersion: (current, total) => `版本 ${current} / ${total}`, previousRevision: '查看上一版本', nextRevision: '查看下一版本',
    },
    sessions: {
      status: { active: '可继续', running: '进行中', waiting_for_user: '等你确认', blocked: '需要处理', aborted: '已中止' },
      blockedReason: { NO_REAL_CONNECTION: '等待配置可用模型连接', auth: '需要重新登录', permission_required: '等待权限确认', tool_failed: '工具调用失败', unknown: '运行中断，可重试' },
      listAriaLabel: '任务列表', showMore: '显示更多', showMoreAriaLabel: (count) => `显示 ${count} 条更多任务`, renameAriaLabel: '重命名任务', renameProjectTitle: '重命名项目', renameSubmit: '保存', respondingAriaLabel: '正在响应', respondingTitle: '任务正在流式响应中', staleTitle: '此任务使用的模型连接已不可用，发送时会切换到默认连接', staleAriaLabel: '任务已过期', stale: '已过期', unreadAriaLabel: '未读消息', actionsAriaLabel: (name) => `${name} 任务操作`, pin: '置顶', unpin: '取消置顶', rename: '重命名', archive: '归档', unarchive: '取消归档', delete: '删除', moveToProject: '移动到项目', moveToNoProject: '移出项目', pinned: '置顶', recent: '最近', projects: '项目', groupByTime: '按时间', groupByProject: '按项目', groupingAriaLabel: '任务分组方式', projectActionsAriaLabel: (name) => `${name} 项目操作`, projectNewTask: '新建任务', projectRename: '重命名', projectArchive: '归档', projectRestore: '恢复', projectRelink: '重新定位', projectUnavailable: '项目目录不可用', archivedProjects: '已归档项目', archivedProjectsAriaLabel: '展开已归档项目', worktreeAriaLabel: 'Git 工作树', promptRailAriaLabel: '按提问跳转', emptyPrompt: '（空提问）', jumpToPrompt: (preview) => `跳到提问：${preview}`, pickedAriaLabel: '已选中', pinCount: (count) => `置顶 ${count} 项`, unpinCount: (count) => `取消置顶 ${count} 项`, archiveCount: (count) => `归档 ${count} 项`,
    },
  },
  'zh-TW': {
    empty: {
      ariaLabel: '開始任務',
      surfaceAriaLabel: '新任務對話',
      greeting: { morning: '早上好', noon: '中午好', afternoon: '下午好', evening: '晚上好' },
      greetingTail: { morning: '清醒的早晨適合理清思路', noon: '專注的午間適合一鼓作氣', afternoon: '舒緩的下午適合慢慢推進', evening: '安靜的夜晚適合深度思考' },
      headlineWithLabel: (greeting, label) => `${greeting} ${label}，今天想做點什麼？`, headlineFallback: (greeting, tail) => `${greeting}，${tail}。`,
    },
    composer: {
      placeholder: '描述任務，@ 引用檔案，/ 選擇技能…', textareaAriaLabel: '訊息輸入框', pastedQuoteLabel: '貼上的文本', selectedSkillsAriaLabel: '已選擇的 Skill', removeSkillAriaLabel: (name) => `移除 Skill：${name}`, awaitingPermission: '等待你確認權限…',
      sending: '正在傳送…', importing: '正在匯入…', sendLabel: '傳送',
      queuedMessagesAriaLabel: (count) => `${count} 條待發送訊息`,
      steeringPending: '調整方向 · 等待整批生效',
      followupPending: '下一輪 · 每輪一條',
      queueShortcutsLabel: '傳送快速鍵',
      queueShortcuts: { apple: 'Cmd+Enter：轉向（Steering）\nEnter：下一輪（Follow-up）\nShift+Enter：換行', other: 'Ctrl+Enter：轉向（Steering）\nEnter：下一輪（Follow-up）\nShift+Enter：換行' },
      promoteQueuedEntry: '調整方向', editQueuedEntry: '編輯', saveQueuedEntry: '儲存', cancelQueuedEntryEdit: '取消編輯', deleteQueuedEntry: '刪除', reorderQueuedEntry: '拖動排序',
      stopLabel: '停止', stopping: '停止中…',
      addContext: '新增上下文', stagedContext: '附加內容',
      selectModel: '選擇模型', dropToImport: '鬆開以匯入檔案內容', addingAttachment: '正在新增附件', addFileOrDirectory: '新增檔案或目錄', referenceFolder: '引用資料夾',
      chooseSkill: '選擇技能', noSkillsAvailable: '目前沒有可用技能',
      setGoal: '設定 Goal…', goalAlreadySet: '目前會話已有進行中的 Goal',
      switchDisabledStreaming: '目前任務正在流式輸出，等結束後再切換模型。', switchDisabledRunning: '目前任務正在執行，等結束後再切換模型。', switchDisabledPermission: '目前有工具呼叫正在等待確認，處理後再切換模型。',
      thinkingDisabledStreaming: '目前任務正在流式輸出，等結束後再切換思考級別。', thinkingDisabledRunning: '目前任務正在執行，等結束後再切換思考級別。', thinkingDisabledPermission: '目前有工具呼叫正在等待確認，處理後再切換思考級別。',
      orchestrationModeAriaLabel: '編排模式',
      planModeLabel: 'Plan', enablePlanMode: '開啟 Plan Mode', disablePlanMode: '退出 Plan Mode',
      planModeOnTitle: 'Plan 模式已啟用，點選關閉',
      swarmModeLabel: 'Swarm', swarmModeOnTitle: 'Swarm 模式已啟用，點選關閉',
      graphModeLabel: 'Graph', graphModeOnTitle: 'Graph 模式已啟用，點選關閉',
      noModelHint: '還沒有可用的模型連線，無法傳送。', noModelAction: '前往模型設定', noModelSendTitle: '先新增一個模型連線才能傳送。',
    },
    model: {
      thinkingLevel: '思考級別', thinkingUnsupported: '目前模型不支援思考級別切換', changeThinkingLevel: '切換目前模型的思考級別', defaultLevel: '預設',
      // Short single-token labels — trigger + popout size to content.
      // Canonical per-chat ladder: 預設 (model default, overriding Settings) / 關 / 低 / 中 / 高 / 超高
      // (minimal/max when offered).
      level: { off: '關', minimal: '最少', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高' },
      switching: '切換中', model: '模型', switchAriaLabel: '切換目前任務模型',
      switchWarning: '切換模型可能需要重建服務商提示快取，使下一次請求更慢或成本更高。',
      switchWarningDismiss: '選擇即可關閉',
      newChatAriaLabel: (label) => `選擇新任務模型，目前 ${label}`, newChatTitle: (label) => `新任務使用的模型：${label}`,
      configureAriaLabel: (label) => `設定模型連線，目前 ${label}`, configureTitle: '設定模型連線',
    },
    permissions: {
      mode: {
        explore: { label: '只讀', hint: '只讀搜尋，不寫檔案、不上網；需要時先問你。' },
        ask: { label: '自動', hint: '保護層內自動執行，越權先問你。' },
        bypass: { label: '完全權限', hint: '直接存取檔案和網路，僅限可信任務。' },
      },
      modeAriaLabel: (label) => `權限模式：${label}`,
    },
    sandboxBoundary: {
      title: '允許存取工作區以外的內容？',
      access: { read: '讀取', write: '寫入' },
      scope: { exact: '僅此路徑', subtree: '目錄及子目錄' },
      network: '網路存取',
      enabled: '已啟用',
      reject: '拒絕',
      allowSession: '本任務允許',
    },
    clientCapability: {
      title: '允許使用用戶端能力？',
      browser: (origin) => `允許 Browser 操作 ${origin}`,
      computerUse: '允許 Computer Use 操作這台 Mac',
      desktopMcp: (serverId, toolName) => `允許呼叫 ${serverId} 的 ${toolName} 工具`,
      sessionNotice: '允許後，本任務中相同範圍的後續操作將不再詢問。',
      reject: '拒絕',
      allowSession: '本任務允許',
    },
    questions: { otherAriaLabel: '其他答案', otherPlaceholder: '輸入你的答案', stop: '停止', stopping: '停止中…', previous: '上一題', submitting: '正在提交…', submit: '提交答案', next: '下一題' },
    forms: { keyboardHint: '1–9 選擇 · ↑↓ 切換 · Enter 確認 · Esc 取消', requester: (name) => `由 ${name} 請求`, requesterWithSource: (name, source) => `由 ${name} 請求 · ${source}`, required: '必填', optional: '選填', include: (label) => `提供：${label}`, enabled: (label) => `啟用：${label}`, enterValue: '輸入內容', enterNumber: '輸入數字', constraintSeparator: '；', lengthConstraint: (minimum, maximum) => minimum === undefined ? `最多 ${maximum} 個字元` : maximum === undefined ? `至少 ${minimum} 個字元` : `長度 ${minimum}–${maximum} 個字元`, numberConstraint: (minimum, maximum) => minimum === undefined ? `最大值 ${maximum}` : maximum === undefined ? `最小值 ${minimum}` : `範圍 ${minimum}–${maximum}`, itemConstraint: (minimum, maximum) => minimum === undefined ? `最多選取 ${maximum} 項` : maximum === undefined ? `至少選取 ${minimum} 項` : `選取 ${minimum}–${maximum} 項`, formatConstraint: { email: '格式：email', uri: '格式：URI', date: '格式：date（YYYY-MM-DD）', 'date-time': '格式：date-time（RFC 3339）' }, invalid: '請提供符合要求的值。', cancel: '取消', decline: '拒絕', accept: '提交', submitting: '正在提交…' },
    mentions: { noFiles: '未找到檔案', noFilesOrSessions: '未找到檔案或作業階段', noSkills: '暫無技能', noCommandsOrSkills: '沒有符合的命令或技能', filesAriaLabel: '工作區檔案', filesAndSessionsAriaLabel: '工作區檔案和作業階段', sessionsGroup: '作業階段', skillsAriaLabel: '技能', commandsAndSkillsAriaLabel: '命令和技能', commandsGroup: '命令', skillsGroup: 'Skills', loading: '載入中…', sessionReferenceUnavailableTitle: '無法引用作業階段', sessionReferenceUnavailableDetail: '這個作業階段已無法使用，請重新整理任務清單後再試一次。', sessionReferenceEmptyTitle: '沒有可引用的內容', sessionReferenceEmptyDetail: '只會引用使用者和助理的文字；工具呼叫等內部記錄不會注入目前任務。', sessionReferenceReadFailedTitle: '讀取作業階段失敗', sessionReferenceReadFailedDetail: '無法讀取這個作業階段的快照，請稍後再試。', sessionReferenceLimitDetail: '引用總數最多為 16，請移除部分引用後再試。' },
    workspace: {
      choose: '選擇專案', current: '目前專案', newProject: '新增專案', newProjectTitle: '新增專案', newProjectDescription: '先為專案命名，再選擇它所在的資料夾。', newProjectNameLabel: '專案名稱', newProjectSubmit: '選擇資料夾', manageProjects: '管理專案', noProject: '無專案', relink: '重新定位', unavailable: '不可用',
      chooseTitle: (branch) => branch ? `選擇專案 · ${branch}` : '選擇專案',
      chooseAriaLabel: (label, branch) => branch ? `選擇專案：${label}，目前分支 ${branch}` : `選擇專案：${label}`,
    },
    messages: {
      you: '你', assistant: 'Maka', processing: '正在處理…', workingPhrases: ['正在琢磨…', '正在推敲…', '正在盤算…', '正在鑽研…', '正在忙活…', '正在梳理…', '正在打磨…', '正在鼓搗…', '正在醞釀…', '正在攻堅…', '正在權衡…', '正在拾掇…'], processDetails: '執行過程', processDuration: (minutes, seconds) => `用時 ${minutes > 0 ? `${minutes} 分 ` : ''}${seconds} 秒`, turnStatusCompleted: (elapsed?: string) => ['已完成', elapsed].filter(Boolean).join(' · '), turnStatusAborted: (elapsed?: string) => ['已中止', elapsed].filter(Boolean).join(' · '), turnStatusFailed: (elapsed?: string) => ['失敗', elapsed].filter(Boolean).join(' · '), providerRetryScheduled: (seconds, attempt, maxAttempts) => `${formatRetryDelay(seconds, { day: '天', hour: '小時', minute: '分', second: '秒' })}後重試（${attempt}/${maxAttempts}）`, providerRetryStarted: (attempt, maxAttempts) => `正在重試（${attempt}/${maxAttempts}）`, providerRetryWaiting: (attempt, maxAttempts) => `等待重試（${attempt}/${maxAttempts}）`, providerRetryReason: { stream_truncated: '回應中途斷開', network: '網路中斷', provider_capacity: '模型服務暫時滿載', provider_unavailable: '模型服務暫時不可用', rate_limit: '觸發模型速率限制', timeout: '請求超時', unknown: '模型請求失敗' }, failureDetailsUnavailable: '無可用診斷詳情。', safeResumePending: '正在檢查…', safeResume: '繼續這一輪', thinking: '深度思考', truncated: '已截斷', copied: '已複製', copying: '複製中', copyFailed: '複製失敗', copy: '複製', editMessage: '編輯並重發', editMessageDisabledRunning: '目前回答仍在進行中，結束後再編輯', editMessageDisabledAttachments: '包含附件的歷史訊息暫不支援編輯並重發', editMessageDisabledQuotes: '包含引用的歷史訊息暫不支援編輯並重發', editMessageDisabledTransformedText: '包含已展開上下文的歷史訊息暫不支援編輯並重發',
      editMessageDisabledDirectoryReferences: '包含資料夾引用的歷史訊息暫不支援編輯並重發',
      userAriaLabel: '你傳送的訊息', systemAriaLabel: '系統訊息', assistantAriaLabel: 'Maka 的回答', answerActionsAriaLabel: (context) => `回答操作${context ? `：${context}` : ''}`, answerActionAriaLabel: (action, context) => `${action}回答${context ? `：${context}` : ''}`, messageActionAriaLabel: (action, context) => `${action}訊息${context ? `：${context}` : ''}`, sourceAriaLabel: '本輪迴答的來源', derivativesAriaLabel: '本輪迴答的衍生', scheduledTaskTriggered: '定時任務觸發', scheduledTaskTitle: (id) => `由定時任務觸發 · ${id}`, legacyAutomationTriggered: '舊版自動化（僅歷史）', legacyAutomationTitle: (id) => `由舊版自動化觸發 · ${id} · 僅保留歷史，不會再次執行`, goalContinued: 'Goal 自動繼續', goalTitle: (id) => `由 Goal 繼續執行 · ${id}`, agentGraphTriggered: 'Agent Graph 自動繼續', agentGraphTitle: (graphId) => `由 Agent Graph 排程器觸發 · ${graphId}`,
      thinkingTruncatedTitle: '部分 reasoning 已截斷；顯示的是最近的內容', outputTruncatedTitle: '助手輸出已超過單次回合上限，超出部分未渲染。如需完整內容請重新生成或檢視持久化的任務記錄。', removeAttachmentAriaLabel: (name) => `移除 ${name}`, quoteLabel: '引用', sessionSnapshotLabel: (name) => `作業階段：${name}`, sessionSnapshotPending: '傳送時擷取快照', sessionSnapshotCaptured: (iso, truncated) => `快照時間 ${iso}${truncated ? ' · 內容已截斷' : ''}`, quoteExpandAriaLabel: '展開引用全文', quoteCollapseAriaLabel: '收起引用', removeQuoteAriaLabel: '移除引用',
      systemNotes: {
        contextCompacting: '正在壓縮上下文…',
        contextCompactionUnobserved: '上下文壓縮狀態暫不可用',
        contextCompacted: '已壓縮較早的上下文。',
        contextCompactionFailedOpen: '上下文壓縮失敗。',
        contextProviderDropping: (used, prior) =>
          `追加內容後，供應商回報的輸入 token 數沒有成長，可能發生了上下文裁剪或改寫（${used.toLocaleString('zh-TW')} tokens，與之前的 ${prior.toLocaleString('zh-TW')} 相比沒有成長）。如果持續出現，請檢查模型實際支援的上下文容量與連線設定是否一致。`,
        contextWindowSuggestion: (tokens, declared) =>
          declared === undefined
            ? `供應商拒絕了這次請求。該模型未宣告上下文視窗；上次成功的用量約 ${tokens} tokens，可將視窗設為該值讓 Maka 先行壓縮。`
            : `供應商拒絕了這次請求，但用量（約 ${tokens} tokens）低於你宣告的視窗（${declared}）。宣告值可能大於供應商實際視窗，建議下調到 ${tokens}。`,
        contextWindowOverrun: (used, declared) =>
          `本次交換用了約 ${used} tokens，超過你宣告的視窗（${declared}）：回覆需要的空間比剩餘的多。Maka 會在下一次請求前壓縮；若希望回覆保持完整，可調大視窗。`,
        contextReportedWindowExceeded: (used, reported) =>
          `本次交換用了約 ${used} tokens，已超過該模型上報的視窗（${reported}），但供應商沒有拒絕。你未宣告視窗，Maka 因此不會主動壓縮。在連線設定裡宣告一個視窗即可讓它先行壓縮。`,
        contextOverflowAfterCompaction:
          '已經壓縮過歷史，供應商仍然說這次請求太大。剩下的部分還包含系統提示、工具定義、摘要和最近的原文，縮短這則訊息是你能控制的那一半。',
        contextUsageLabel: '用量',
        contextUsageShare: (used, window) =>
          `上下文視窗：已用 ${Math.round((used / window) * 100)}%（${formatCompactTokenCount(used)} / ${formatCompactTokenCount(window)} token）`,
        contextUsageNoWindow: (used) =>
          `已用 ${formatCompactTokenCount(used)} token；上下文視窗上限未知`,
        contextUsageUnavailable: '暫無用量資料',
        contextUsageOpen: '開啟用量追蹤',
        stepLimit: '已達到本輪工具步驟上限，任務可能尚未完成。傳送“繼續”即可接著處理。',
      },
    },
    chat: {
      conversationAriaLabel: (name) => `對話：${name}`,
      memory: '記憶', memoryAriaLabel: '本地記憶已啟用', memoryTitle: '本地 MEMORY.md 已加入 agent 系統提示。點選進入設定 · 記憶管理。',
      clearGoal: (condition, iteration, max, status) => `自主執行目標進行中：「${condition}」（第 ${iteration}/${max} 輪，${status}）。系統每輪後自動續行；點選可清除目標、停止續行。`, clearGoalAriaLabel: (iteration, max) => `清除自主執行目標（已進行 ${iteration}/${max} 輪）`, goalProgress: (iteration, max) => `目標 ${iteration} / ${max}`, goalRunningAriaLabel: '自主目標正在執行', goalWaitingAriaLabel: '自主目標正在等待條件變化',
      goalPausedAriaLabel: '自主目標已暫停', pauseGoalAriaLabel: (iteration, max) => `暫停自主執行目標（已進行 ${iteration}/${max} 輪）`, resumeGoalAriaLabel: (iteration, max) => `恢復自主執行目標（已進行 ${iteration}/${max} 輪）`, pauseGoal: (condition, iteration, max, status) => `暫停自主執行目標：「${condition}」（第 ${iteration}/${max} 輪，${status}）。暫停後立即停止自動續行，不再消耗權杖；可隨時恢復。`, resumeGoal: (condition, iteration, max) => `恢復自主執行目標：「${condition}」（第 ${iteration}/${max} 輪）。恢復後立即繼續自動續行。`, goalElapsed: (elapsedMs) => formatGoalElapsedUnits(elapsedMs, { second: ' 秒', minute: ' 分鐘', hour: ' 小時', day: ' 天' }), goalTokens: (spent, budget) => `${formatCompactTokenCount(spent)} / ${formatCompactTokenCount(budget)}`,
      loadFailed: '任務載入失敗', loading: '載入中…', retryLoad: '重試載入', loadEarlierHistory: '載入更早的記錄', quoteSelection: '引用', askInSidePanel: '在側欄追問', noMessages: '暫無訊息',
      branchBeforeInterrupt: '從中斷前分支', sessionContextAriaLabel: '任務上下文', sessionLineageAriaLabel: '任務來源', sessionContextMore: (count) => `更多工上下文（${count}）`,
      titlebarIdentityAriaLabel: '目前任務', openProjectFolderAction: '開啟專案資料夾', projectInfo: '專案資訊', copyProjectPath: '複製路徑',
      openParentSession: (name) => `返回父任務「${name}」`,
      revisionVersionsAriaLabel: '任務版本', revisionVersion: (current, total) => `版本 ${current} / ${total}`, previousRevision: '檢視上一版本', nextRevision: '檢視下一版本',
    },
    sessions: {
      status: { active: '可繼續', running: '進行中', waiting_for_user: '等你確認', blocked: '需要處理', aborted: '已中止' },
      blockedReason: { NO_REAL_CONNECTION: '等待設定可用模型連線', auth: '需要重新登入', permission_required: '等待權限確認', tool_failed: '工具呼叫失敗', unknown: '執行中斷，可重試' },
      listAriaLabel: '任務列表', showMore: '顯示更多', showMoreAriaLabel: (count) => `顯示 ${count} 條更多工`, renameAriaLabel: '重新命名任務', renameProjectTitle: '重新命名專案', renameSubmit: '儲存', respondingAriaLabel: '正在響應', respondingTitle: '任務正在流式響應中', staleTitle: '此任務使用的模型連線已不可用，傳送時會切換到預設連線', staleAriaLabel: '任務已過期', stale: '已過期', unreadAriaLabel: '未讀訊息', actionsAriaLabel: (name) => `${name} 任務操作`, pin: '置頂', unpin: '取消置頂', rename: '重新命名', archive: '歸檔', unarchive: '取消歸檔', delete: '刪除', moveToProject: '移動到專案', moveToNoProject: '移出專案', pinned: '置頂', recent: '最近', projects: '專案', groupByTime: '按時間', groupByProject: '按專案', groupingAriaLabel: '任務分組方式', projectActionsAriaLabel: (name) => `${name} 專案操作`, projectNewTask: '建立任務', projectRename: '重新命名', projectArchive: '歸檔', projectRestore: '恢復', projectRelink: '重新定位', projectUnavailable: '專案目錄不可用', archivedProjects: '已歸檔專案', archivedProjectsAriaLabel: '展開已歸檔專案', worktreeAriaLabel: 'Git 工作樹', promptRailAriaLabel: '按提問跳轉', emptyPrompt: '（空提問）', jumpToPrompt: (preview) => `跳到提問：${preview}`, pickedAriaLabel: '已選取', pinCount: (count) => `置頂 ${count} 項`, unpinCount: (count) => `取消置頂 ${count} 項`, archiveCount: (count) => `歸檔 ${count} 項`,
    },
  },
  en: {
    empty: {
      ariaLabel: 'Start a task',
      surfaceAriaLabel: 'New task conversation',
      greeting: { morning: 'Good morning', noon: 'Good afternoon', afternoon: 'Good afternoon', evening: 'Good evening' },
      greetingTail: { morning: 'A clear morning is good for untangling ideas', noon: 'A focused midday is good for a single big push', afternoon: 'A calm afternoon is good for steady progress', evening: 'A quiet evening is good for deep thinking' },
      headlineWithLabel: (greeting, label) => `${greeting} ${label} — what shall we tackle today?`, headlineFallback: (greeting, tail) => `${greeting} — ${tail}.`,
    },
    composer: {
      placeholder: 'Describe a task, @ to reference files or sessions, / for skills…', textareaAriaLabel: 'Message input', pastedQuoteLabel: 'Pasted text', selectedSkillsAriaLabel: 'Selected Skills', removeSkillAriaLabel: (name) => `Remove Skill: ${name}`, awaitingPermission: 'Waiting for your permission decision…',
      sending: 'Sending…', importing: 'Importing…', sendLabel: 'Send',
      queuedMessagesAriaLabel: (count) => `${count} queued message${count === 1 ? '' : 's'}`,
      steeringPending: 'Steering · Applied together',
      followupPending: 'Follow-up · One per turn',
      queueShortcutsLabel: 'Send shortcuts',
      queueShortcuts: { apple: 'Cmd+Enter: Steering\nEnter: Follow-up\nShift+Enter: New line', other: 'Ctrl+Enter: Steering\nEnter: Follow-up\nShift+Enter: New line' },
      promoteQueuedEntry: 'Steer', editQueuedEntry: 'Edit', saveQueuedEntry: 'Save', cancelQueuedEntryEdit: 'Cancel editing', deleteQueuedEntry: 'Delete', reorderQueuedEntry: 'Drag to reorder',
      stopLabel: 'Stop', stopping: 'Stopping…',
      addContext: 'Add context', stagedContext: 'staged items',
      selectModel: 'Choose model', dropToImport: 'Drop to import file contents', addingAttachment: 'Adding attachment', addFileOrDirectory: 'Add files', referenceFolder: 'Reference folder',
      chooseSkill: 'Choose skills', noSkillsAvailable: 'No skills available',
      setGoal: 'Set a goal…', goalAlreadySet: 'This session already has a goal in progress',
      switchDisabledStreaming: 'Wait for the current response to finish before switching models.', switchDisabledRunning: 'Wait for the current run to finish before switching models.', switchDisabledPermission: 'Resolve the pending tool permission before switching models.',
      thinkingDisabledStreaming: 'Wait for the current response to finish before changing the thinking level.', thinkingDisabledRunning: 'Wait for the current run to finish before changing the thinking level.', thinkingDisabledPermission: 'Resolve the pending tool permission before changing the thinking level.',
      orchestrationModeAriaLabel: 'Orchestration mode',
      planModeLabel: 'Plan', enablePlanMode: 'Enable Plan Mode', disablePlanMode: 'Disable Plan Mode',
      planModeOnTitle: 'Plan mode is on — click to turn off',
      swarmModeLabel: 'Swarm', swarmModeOnTitle: 'Swarm mode is on — click to turn off',
      graphModeLabel: 'Graph', graphModeOnTitle: 'Graph mode is on — click to turn off',
      noModelHint: 'No model connection yet, so sending is unavailable.', noModelAction: 'Go to model settings', noModelSendTitle: 'Add a model connection before sending.',
    },
    model: {
      thinkingLevel: 'Thinking level', thinkingUnsupported: 'This model does not support thinking-level changes', changeThinkingLevel: 'Change the current model thinking level', defaultLevel: 'Model default',
      level: { off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Maximum' },
      switching: 'Switching', model: 'Model', switchAriaLabel: 'Switch model for this task',
      switchWarning: 'Switching may rebuild the provider prompt cache, making the next request slower or more expensive.',
      switchWarningDismiss: 'Select to dismiss',
      newChatAriaLabel: (label) => `Choose a model for the new task, currently ${label}`, newChatTitle: (label) => `Model for the new task: ${label}`,
      configureAriaLabel: (label) => `Configure model connections, currently ${label}`, configureTitle: 'Configure model connections',
    },
    permissions: {
      mode: {
        explore: { label: 'Read only', hint: 'Read and search only; asks before write or network.' },
        ask: { label: 'Auto', hint: "Runs inside Maka's protection; asks before going further." },
        bypass: { label: 'Full access', hint: 'Direct file and network access. Trust-only tasks.' },
      },
      modeAriaLabel: (label) => `Permission mode: ${label}`,
    },
    sandboxBoundary: {
      title: 'Allow access outside the workspace?',
      access: { read: 'Read', write: 'Write' },
      scope: { exact: 'Exact path', subtree: 'Directory subtree' },
      network: 'Network access',
      enabled: 'Enabled',
      reject: 'Reject',
      allowSession: 'Allow for this task',
    },
    clientCapability: {
      title: 'Allow this client capability?',
      browser: (origin) => `Allow Browser to operate ${origin}`,
      computerUse: 'Allow Computer Use to operate this Mac',
      desktopMcp: (serverId, toolName) => `Allow ${toolName} from ${serverId}`,
      sessionNotice: 'Matching operations will be allowed for the rest of this task.',
      reject: 'Reject',
      allowSession: 'Allow for this task',
    },
    questions: { otherAriaLabel: 'Other answer', otherPlaceholder: 'Enter your answer', stop: 'Stop', stopping: 'Stopping…', previous: 'Previous', submitting: 'Submitting…', submit: 'Submit answers', next: 'Next' },
    forms: { keyboardHint: '1–9 select · ↑↓ navigate · Enter confirm · Esc cancel', requester: (name) => `Requested by ${name}`, requesterWithSource: (name, source) => `Requested by ${name} · ${source}`, required: 'Required', optional: 'Optional', include: (label) => `Provide ${label}`, enabled: (label) => `Enable ${label}`, enterValue: 'Enter a value', enterNumber: 'Enter a number', constraintSeparator: ' · ', lengthConstraint: (minimum, maximum) => minimum === undefined ? `At most ${maximum} characters` : maximum === undefined ? `At least ${minimum} characters` : `${minimum}–${maximum} characters`, numberConstraint: (minimum, maximum) => minimum === undefined ? `Maximum ${maximum}` : maximum === undefined ? `Minimum ${minimum}` : `Range ${minimum}–${maximum}`, itemConstraint: (minimum, maximum) => minimum === undefined ? `Select at most ${maximum}` : maximum === undefined ? `Select at least ${minimum}` : `Select ${minimum}–${maximum}`, formatConstraint: { email: 'Format: email', uri: 'Format: URI', date: 'Format: date (YYYY-MM-DD)', 'date-time': 'Format: date-time (RFC 3339)' }, invalid: 'Provide a value that meets the requirements.', cancel: 'Cancel', decline: 'Decline', accept: 'Submit', submitting: 'Submitting…' },
    mentions: { noFiles: 'No files found', noFilesOrSessions: 'No files or sessions found', noSkills: 'No skills available', noCommandsOrSkills: 'No matching commands or skills', filesAriaLabel: 'Workspace files', filesAndSessionsAriaLabel: 'Workspace files and sessions', sessionsGroup: 'Sessions', skillsAriaLabel: 'Skills', commandsAndSkillsAriaLabel: 'Commands and skills', commandsGroup: 'Commands', skillsGroup: 'Skills', loading: 'Loading…', sessionReferenceUnavailableTitle: 'Session reference unavailable', sessionReferenceUnavailableDetail: 'This session is no longer available. Refresh the task list and try again.', sessionReferenceEmptyTitle: 'No referenceable content', sessionReferenceEmptyDetail: 'Only user and assistant text is shared; tool calls and internal records stay out of the current task.', sessionReferenceReadFailedTitle: 'Could not read session', sessionReferenceReadFailedDetail: 'The session snapshot could not be read. Try again later.', sessionReferenceLimitDetail: 'A message can contain at most 16 quotes. Remove a quote and try again.' },
    workspace: {
      choose: 'Choose project', current: 'Current project', newProject: 'New project', newProjectTitle: 'New project', newProjectDescription: 'Name the project, then choose the folder it lives in.', newProjectNameLabel: 'Project name', newProjectSubmit: 'Choose folder', manageProjects: 'Manage projects', noProject: 'No project', relink: 'Relink', unavailable: 'Unavailable',
      chooseTitle: (branch) => branch ? `Choose project · ${branch}` : 'Choose project',
      chooseAriaLabel: (label, branch) => branch ? `Choose project: ${label}, current branch ${branch}` : `Choose project: ${label}`,
    },
    messages: {
      you: 'You', assistant: 'Maka', processing: 'Working…', workingPhrases: ['Pondering…', 'Tinkering…', 'Untangling…', 'Digging in…', 'Mulling…', 'Chewing on it…', 'Wrangling…', 'Piecing it together…'], processDetails: 'Execution process', processDuration: (minutes, seconds) => `Worked for ${minutes > 0 ? `${minutes}m ` : ''}${seconds}s`, turnStatusCompleted: (elapsed?: string) => ['Done', elapsed].filter(Boolean).join(' · '), turnStatusAborted: (elapsed?: string) => ['Stopped', elapsed].filter(Boolean).join(' · '), turnStatusFailed: (elapsed?: string) => ['Failed', elapsed].filter(Boolean).join(' · '), providerRetryScheduled: (seconds, attempt, maxAttempts) => `Retrying in ${formatRetryDelay(seconds, { day: 'd', hour: 'h', minute: 'm', second: 's' })} (${attempt}/${maxAttempts})`, providerRetryStarted: (attempt, maxAttempts) => `Retrying (${attempt}/${maxAttempts})`, providerRetryWaiting: (attempt, maxAttempts) => `Waiting to retry (${attempt}/${maxAttempts})`, providerRetryReason: { stream_truncated: 'Response stream ended before completion', network: 'Network interrupted', provider_capacity: 'The model service is temporarily at capacity', provider_unavailable: 'Model service temporarily unavailable', rate_limit: 'Model rate limit reached', timeout: 'Request timed out', unknown: 'Model request failed' }, failureDetailsUnavailable: 'No diagnostic details are available.', safeResumePending: 'Checking…', safeResume: 'Continue this turn', thinking: 'Thinking', truncated: 'Truncated', copied: 'Copied', copying: 'Copying', copyFailed: 'Copy failed', copy: 'Copy', editMessage: 'Edit & resend', editMessageDisabledRunning: 'Wait for this answer to finish before editing', editMessageDisabledAttachments: 'Edit & resend does not yet support messages with attachments', editMessageDisabledQuotes: 'Edit & resend does not yet support messages with quotes', editMessageDisabledTransformedText: 'Edit & resend does not yet support messages with expanded context',
      editMessageDisabledDirectoryReferences: 'Edit & resend does not yet support messages with folder references',
      userAriaLabel: 'Your message', systemAriaLabel: 'System message', assistantAriaLabel: "Maka's response", answerActionsAriaLabel: (context) => `Response actions${context ? `: ${context}` : ''}`, answerActionAriaLabel: (action, context) => `${action} response${context ? `: ${context}` : ''}`, messageActionAriaLabel: (action, context) => `${action} message${context ? `: ${context}` : ''}`, sourceAriaLabel: 'Source of this response', derivativesAriaLabel: 'Responses derived from this one', scheduledTaskTriggered: 'Triggered by scheduled task', scheduledTaskTitle: (id) => `Triggered by scheduled task · ${id}`, legacyAutomationTriggered: 'Legacy Automation (history only)', legacyAutomationTitle: (id) => `Triggered by legacy Automation · ${id} · Historical only; it will not run again`, goalContinued: 'Continued by Goal', goalTitle: (id) => `Continued by Goal · ${id}`, agentGraphTriggered: 'Continued by Agent Graph', agentGraphTitle: (graphId) => `Triggered by the Agent Graph scheduler · ${graphId}`,
      thinkingTruncatedTitle: 'Some reasoning was truncated; showing the most recent content', outputTruncatedTitle: 'The assistant output exceeded the per-turn limit. Regenerate it or inspect the persisted task log for the complete content.', removeAttachmentAriaLabel: (name) => `Remove ${name}`, quoteLabel: 'Quote', sessionSnapshotLabel: (name) => `Session: ${name}`, sessionSnapshotPending: 'snapshot captured when sent', sessionSnapshotCaptured: (iso, truncated) => `captured ${iso}${truncated ? ' · truncated' : ''}`, quoteExpandAriaLabel: 'Show the full quoted excerpt', quoteCollapseAriaLabel: 'Collapse the quoted excerpt', removeQuoteAriaLabel: 'Remove quote',
      systemNotes: {
        contextCompacting: 'Compacting context…',
        contextCompactionUnobserved: 'Context compaction status unavailable',
        contextCompacted: 'Earlier context compacted.',
        contextCompactionFailedOpen: 'Context compaction failed.',
        contextProviderDropping: (used, prior) =>
          `After content was appended, the provider-reported input token count did not grow; context may have been truncated or rewritten (${used.toLocaleString('en-US')} tokens versus ${prior.toLocaleString('en-US')} before). If this persists, check that the model's actual context capacity and the connection settings agree.`,
        contextWindowSuggestion: (tokens, declared) =>
          declared === undefined
            ? `The provider rejected this request. No context window is declared for this model; the last accepted usage was about ${tokens} tokens — set the window to that value so Maka compacts first.`
            : `The provider rejected this request at about ${tokens} tokens, below your declared window (${declared}). The declared value is likely larger than the provider's; consider lowering it to ${tokens}.`,
        contextWindowOverrun: (used, declared) =>
          `This exchange used about ${used} tokens against your declared window (${declared}): the reply needed more room than was left. Maka compacts before the next request; raise the window if the replies should stay whole.`,
        contextReportedWindowExceeded: (used, reported) =>
          `This exchange used about ${used} tokens, past the ${reported} this model reports, and the provider accepted it without complaint. Nothing is declared, so Maka does not compact on its own. Declare a context window in the connection settings to have it compact first.`,
        contextOverflowAfterCompaction:
          'History was compacted and the provider still called this request too large. What remains also carries the system prompt, the tool schemas, the summary and the recent tail; shortening this message is the part you control.',
        contextUsageLabel: 'Usage',
        contextUsageShare: (used, window) =>
          `Context window: ${Math.round((used / window) * 100)}% used (${formatCompactTokenCount(used)} / ${formatCompactTokenCount(window)} tokens).`,
        contextUsageNoWindow: (used) =>
          `This request used ${formatCompactTokenCount(used)} tokens; no context limit is available for this model.`,
        contextUsageUnavailable: 'No usage data is available for this request.',
        contextUsageOpen: 'Open usage trace',
        stepLimit: 'Reached the configured step limit. The task may be incomplete. Send “continue” to resume.',
      },
    },
    chat: {
      conversationAriaLabel: (name) => `Conversation: ${name}`,
      memory: 'Memory', memoryAriaLabel: 'Local memory enabled', memoryTitle: 'Local MEMORY.md is included in the agent system prompt. Click to manage it in Settings · Memory.',
      clearGoal: (condition, iteration, max, status) => `Autonomous goal in progress: “${condition}” (iteration ${iteration}/${max}, ${status}). Maka continues after each iteration; click to clear the goal and stop continuing.`, clearGoalAriaLabel: (iteration, max) => `Clear autonomous goal after ${iteration}/${max} iterations`, goalProgress: (iteration, max) => `Goal ${iteration} of ${max}`, goalRunningAriaLabel: 'Autonomous goal running', goalWaitingAriaLabel: 'Autonomous goal waiting for conditions to change',
      goalPausedAriaLabel: 'Autonomous goal paused', pauseGoalAriaLabel: (iteration, max) => `Pause autonomous goal after ${iteration}/${max} iterations`, resumeGoalAriaLabel: (iteration, max) => `Resume autonomous goal after ${iteration}/${max} iterations`, pauseGoal: (condition, iteration, max, status) => `Pause autonomous goal: “${condition}” (iteration ${iteration}/${max}, ${status}). Pausing stops autonomous continuation immediately — no more tokens burn; resume any time.`, resumeGoal: (condition, iteration, max) => `Resume autonomous goal: “${condition}” (iteration ${iteration}/${max}). Resuming continues autonomous iteration immediately.`, goalElapsed: (elapsedMs) => formatGoalElapsedUnits(elapsedMs, { second: 's', minute: 'm', hour: 'h', day: 'd' }), goalTokens: (spent, budget) => `${formatCompactTokenCount(spent)} / ${formatCompactTokenCount(budget)}`,
      loadFailed: 'Task failed to load', loading: 'Loading…', retryLoad: 'Retry', loadEarlierHistory: 'Load earlier history', quoteSelection: 'Quote', askInSidePanel: 'Ask in side panel', noMessages: 'No messages yet',
      branchBeforeInterrupt: 'Branched before interruption', sessionContextAriaLabel: 'Task context', sessionLineageAriaLabel: 'Task origin', sessionContextMore: (count) => `More task context (${count})`,
      titlebarIdentityAriaLabel: 'Current task', openProjectFolderAction: 'Open project folder', projectInfo: 'Project information', copyProjectPath: 'Copy path',
      openParentSession: (name) => `Return to parent task “${name}”`,
      revisionVersionsAriaLabel: 'Task versions', revisionVersion: (current, total) => `Version ${current} of ${total}`, previousRevision: 'View previous version', nextRevision: 'View next version',
    },
    sessions: {
      status: { active: 'Ready', running: 'Running', waiting_for_user: 'Waiting for you', blocked: 'Needs attention', aborted: 'Stopped' },
      blockedReason: { NO_REAL_CONNECTION: 'Waiting for an available model connection', auth: 'Sign in again', permission_required: 'Waiting for permission', tool_failed: 'Tool call failed', unknown: 'Run interrupted; retry available' },
      listAriaLabel: 'Task list', showMore: 'Show more', showMoreAriaLabel: (count) => `Show ${count} more tasks`, renameAriaLabel: 'Rename task', renameProjectTitle: 'Rename project', renameSubmit: 'Save', respondingAriaLabel: 'Responding', respondingTitle: 'This task is streaming a response', staleTitle: 'This task\'s model connection is unavailable; sending will switch to the default connection', staleAriaLabel: 'Stale task', stale: 'Stale', unreadAriaLabel: 'Unread messages', actionsAriaLabel: (name) => `${name} task actions`, pin: 'Pin', unpin: 'Unpin', rename: 'Rename', archive: 'Archive', unarchive: 'Unarchive', delete: 'Delete', moveToProject: 'Move to project', moveToNoProject: 'Remove from project', pinned: 'Pinned', recent: 'Recent', projects: 'Projects', groupByTime: 'By time', groupByProject: 'By project', groupingAriaLabel: 'Task grouping', projectActionsAriaLabel: (name) => `${name} project actions`, projectNewTask: 'New task', projectRename: 'Rename', projectArchive: 'Archive', projectRestore: 'Restore', projectRelink: 'Relocate', projectUnavailable: 'Project directory unavailable', archivedProjects: 'Archived projects', archivedProjectsAriaLabel: 'Expand archived projects', worktreeAriaLabel: 'Git worktree', promptRailAriaLabel: 'Jump by prompt', emptyPrompt: '(empty prompt)', jumpToPrompt: (preview) => `Jump to prompt: ${preview}`, pickedAriaLabel: 'Selected', pinCount: (count) => `Pin ${count} tasks`, unpinCount: (count) => `Unpin ${count} tasks`, archiveCount: (count) => `Archive ${count} tasks`,
    },
  },
} satisfies UiCatalog<ConversationCopy>;

export function getConversationCopy(locale: UiLocale): ConversationCopy {
  return CONVERSATION_COPY[locale];
}
