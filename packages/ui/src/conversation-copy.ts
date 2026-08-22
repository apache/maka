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

import type { DeepResearchReportSectionKey } from '@maka/core/deep-research-run';
import type { ProviderRetryReason } from '@maka/core/events';
import type { PermissionMode } from '@maka/core/permission';
import type { SessionBlockedReason, SessionStatus } from '@maka/core/session';
import type { ThinkingLevel } from '@maka/core/model-thinking';
import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';
import {
  DEEP_RESEARCH_EVIDENCE_CHECKLIST,
  DEEP_RESEARCH_PROGRESS_CHECKPOINTS,
  DEEP_RESEARCH_REPORT_SECTIONS,
  DEEP_RESEARCH_SCOPE_OPTIONS,
  DEEP_RESEARCH_STARTER_PROMPTS,
  DEEP_RESEARCH_WORKFLOW_STEPS,
} from '@maka/core/explore-agent';

export type DayPeriod = 'morning' | 'noon' | 'afternoon' | 'evening';
type ResearchItem = Readonly<{ title: string; body: string }>;
type ResearchOption = Readonly<{ label: string; body: string }>;
type ResearchStarter = Readonly<{ label: string; prompt: string }>;

/** Compact token count for chip labels: 45,200 → "45k". */
function formatCompactTokenCount(count: number): string {
  if (count < 1_000) return `${count}`;
  const thousands = count / 1_000;
  return `${thousands >= 100 ? Math.round(thousands) : Math.round(thousands * 10) / 10}k`;
}

/** Wall-clock units for the goal chip's elapsed label, per locale (zh uses spaced words, en letters). */
interface GoalElapsedUnits {
  second: string;
  minute: string;
  hour: string;
  day: string;
}

/** One shared elapsed ladder so the zh/en goalElapsed entries cannot drift. */
function formatGoalElapsedUnits(elapsedMs: number, units: GoalElapsedUnits): string {
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
  deepResearchEmpty: {
    ariaLabel: string;
    eyebrow: string;
    title: string;
    intro: string;
    workflowAriaLabel: string;
    workflow: readonly ResearchItem[];
    reportAriaLabel: string;
    reportTitle: string;
    report: readonly ResearchItem[];
    scopeAriaLabel: string;
    scopeTitle: string;
    scope: readonly ResearchOption[];
    evidenceAriaLabel: string;
    evidenceTitle: string;
    evidence: readonly ResearchItem[];
    progressAriaLabel: string;
    progressTitle: string;
    progress: readonly ResearchItem[];
    startersAriaLabel: string;
    starters: readonly ResearchStarter[];
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
    steerLabel: string;
    stopLabel: string;
    stopping: string;
    streaming: string;
    processing: string;
    continuing: string;
    interruptHint: string;
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
  questions: {
    other: string;
    otherDescription: string;
    otherAriaLabel: string;
    otherPlaceholder: string;
    stop: string;
    stopping: string;
    previous: string;
    submitting: string;
    submit: string;
    next: string;
  };
  mentions: {
    noFiles: string;
    noSkills: string;
    noCommandsOrSkills: string;
    filesAriaLabel: string;
    skillsAriaLabel: string;
    commandsAndSkillsAriaLabel: string;
    commandsGroup: string;
    skillsGroup: string;
    loading: string;
  };
  workspace: {
    choose: string;
    current: string;
    addProject: string;
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
    continuing: string;
    /**
     * The live turn's rotating working phrases. One is shown at a time beside
     * the elapsed clock and swapped every `WORKING_PHRASE_INTERVAL_MS`.
     *
     * The zh pool is uniform in width on purpose — every entry is 「正在 + two
     * characters + …」 — so a swap changes glyphs without moving the elapsed
     * time that follows it. en is proportional anyway, so it only keeps the
     * entries short.
     */
    workingPhrases: readonly string[];
    providerRetryScheduled: (seconds: number, attempt: number, maxAttempts: number) => string;
    providerRetryStarted: (attempt: number, maxAttempts: number) => string;
    providerRetryReason: Record<ProviderRetryReason, string>;
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
    quoteExpandAriaLabel: string;
    quoteCollapseAriaLabel: string;
    removeQuoteAriaLabel: string;
    aborted: string;
    abortedByStop: string;
  };
  chat: {
    conversationAriaLabel: (name: string) => string;
    memory: string;
    memoryAriaLabel: string;
    memoryTitle: string;
    deepResearch: string;
    deepResearchAriaLabel: string;
    deepResearchTitle: string;
    deepResearchProgress: {
      ariaLabel: string;
      title: string;
      completedSummary: string;
      activeSummary: (stage: string, scope: string, round: number) => string;
      handoffTitle: string;
      handoffAction: string;
      checklistTitle: string;
      reportTitle: string;
      inspectedTitle: string;
      inspectedEmpty: string;
      executionTitle: string;
      executionSummary: (steps: number, artifacts: number) => string;
      workersLabel: string;
      noBlockers: string;
      sectionLabels: Record<DeepResearchReportSectionKey, string>;
    };
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
    quoteSelection: string;
    askInSidePanel: string;
    noMessages: string;
    branchBeforeInterrupt: string;
    sessionContextAriaLabel: string;
    sessionLineageAriaLabel: string;
    titlebarIdentityAriaLabel: string;
    openProjectFolder: (name: string) => string;
    /** Action phrase appended to the titlebar project crumb's accessible name. */
    openProjectFolderAction: string;
    /** Tooltip / accessible name for the parent crumb when a linked child is open. */
    openParentSession: (name: string) => string;
    /** Action phrase appended to the titlebar parent crumb's accessible name. */
    openParentSessionAction: string;
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
    pinned: string;
    /** Time-sort unpinned section title (SideNavSection). */
    recent: string;
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
  };
}

const CONVERSATION_COPY = {
  zh: {
    empty: {
      ariaLabel: '开始任务',
      surfaceAriaLabel: '新任务对话',
      greeting: { morning: '早上好', noon: '中午好', afternoon: '下午好', evening: '晚上好' },
      greetingTail: { morning: '清醒的早晨适合理清思路', noon: '专注的午间适合一鼓作气', afternoon: '舒缓的下午适合慢慢推进', evening: '安静的夜晚适合深度思考' },
      headlineWithLabel: (greeting, label) => `${greeting} ${label}，今天想做点什么？`, headlineFallback: (greeting, tail) => `${greeting}，${tail}。`,
    },
    deepResearchEmpty: {
      ariaLabel: '深度研究空任务', eyebrow: '深度研究 · 只读探索', title: '先把项目读透，再决定怎么改。', intro: '这个任务固定在只读权限：优先阅读、搜索和分析代码；需要动手实现时，先输出文件、风险和验证命令。',
      workflowAriaLabel: '深度研究流程', workflow: DEEP_RESEARCH_WORKFLOW_STEPS,
      reportAriaLabel: '深度研究输出结构', reportTitle: '输出必须能直接落地', report: DEEP_RESEARCH_REPORT_SECTIONS,
      scopeAriaLabel: '深度研究范围', scopeTitle: '默认按标准深度研究', scope: DEEP_RESEARCH_SCOPE_OPTIONS,
      evidenceAriaLabel: '深度研究证据清单', evidenceTitle: '每次研究都要留证据', evidence: DEEP_RESEARCH_EVIDENCE_CHECKLIST,
      progressAriaLabel: '深度研究检查点', progressTitle: '多步研究要按检查点推进', progress: DEEP_RESEARCH_PROGRESS_CHECKPOINTS,
      startersAriaLabel: '深度研究起手式', starters: DEEP_RESEARCH_STARTER_PROMPTS,
    },
    composer: {
      placeholder: '描述任务，@ 引用文件，/ 选择技能…', textareaAriaLabel: '消息输入框', pastedQuoteLabel: '粘贴的文本', selectedSkillsAriaLabel: '已选择的 Skill', removeSkillAriaLabel: (name) => `移除 Skill：${name}`, awaitingPermission: '等待你确认权限…',
      sending: '正在发送…', importing: '正在导入…', sendLabel: '发送', steerLabel: '插入消息', stopLabel: '停止', stopping: '停止中…',
      streaming: 'Maka 正在回答…', processing: 'Maka 正在处理…', continuing: 'Maka 继续中…',
      interruptHint: '或点停止中断', addContext: '添加上下文', stagedContext: '附加内容',
      selectModel: '选择模型', dropToImport: '松开以导入文件内容', addingAttachment: '正在添加附件', addFileOrDirectory: '添加文件或目录',
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
      thinkingLevel: '思考级别', thinkingUnsupported: '当前模型不支持思考级别切换', changeThinkingLevel: '切换当前模型的思考级别', defaultLevel: '模型默认',
      // Short single-token labels — trigger + popout size to content.
      // Canonical ladder: 默认 / 关 / 低 / 中 / 高 / 超高 (minimal/max when offered).
      level: { off: '关', minimal: '最少', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高' },
      switching: '切换中', model: '模型', switchAriaLabel: '切换当前任务模型',
      switchWarning: '切换模型可能需要重建服务商提示缓存，使下一次请求更慢或成本更高。',
      newChatAriaLabel: (label) => `选择新任务模型，当前 ${label}`, newChatTitle: (label) => `新任务使用的模型：${label}`,
      configureAriaLabel: (label) => `配置模型连接，当前 ${label}`, configureTitle: '配置模型连接',
    },
    permissions: {
      mode: {
        explore: { label: '只读', hint: '只读搜索，不写文件、不上网；需要时先问你。' },
        ask: { label: '自动', hint: '保护层内自动执行，越权先问你。' },
        execute: { label: '自动执行', hint: '常见工具直接执行；危险操作仍会确认。' },
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
    questions: { other: '其他', otherDescription: '输入一个不同的答案。', otherAriaLabel: '其他答案', otherPlaceholder: '输入你的答案', stop: '停止', stopping: '停止中…', previous: '上一题', submitting: '正在提交…', submit: '提交答案', next: '下一题' },
    mentions: { noFiles: '未找到文件', noSkills: '暂无技能', noCommandsOrSkills: '没有匹配的命令或技能', filesAriaLabel: '工作区文件', skillsAriaLabel: '技能', commandsAndSkillsAriaLabel: '命令和技能', commandsGroup: '命令', skillsGroup: 'Skills', loading: '加载中…' },
    workspace: {
      choose: '选择项目', current: '当前项目', addProject: '添加项目', noProject: '无项目', relink: '重新定位', unavailable: '不可用',
      chooseTitle: (branch) => branch ? `选择项目 · ${branch}` : '选择项目',
      chooseAriaLabel: (label, branch) => branch ? `选择项目：${label}，当前分支 ${branch}` : `选择项目：${label}`,
    },
    messages: {
      you: '你', assistant: 'Maka', processing: '正在处理…', continuing: '继续中…', workingPhrases: ['正在琢磨…', '正在推敲…', '正在盘算…', '正在钻研…', '正在忙活…', '正在梳理…', '正在打磨…', '正在鼓捣…', '正在酝酿…', '正在攻坚…', '正在权衡…', '正在拾掇…'], providerRetryScheduled: (seconds, attempt, maxAttempts) => `${seconds} 秒后重试（${attempt}/${maxAttempts}）`, providerRetryStarted: (attempt, maxAttempts) => `正在重试（${attempt}/${maxAttempts}）`, providerRetryReason: { network: '网络中断', provider_unavailable: '模型服务暂时不可用', rate_limit: '触发模型速率限制', timeout: '请求超时', unknown: '模型请求失败' }, safeResumePending: '正在验证…', safeResume: '安全恢复', thinking: '深度思考', truncated: '已截断', copied: '已复制', copying: '复制中', copyFailed: '复制失败', copy: '复制', editMessage: '编辑并重发', editMessageDisabledRunning: '当前回答仍在进行中，结束后再编辑', editMessageDisabledAttachments: '包含附件的历史消息暂不支持编辑并重发', editMessageDisabledQuotes: '包含引用的历史消息暂不支持编辑并重发', editMessageDisabledTransformedText: '通过显式技能发送的历史消息暂不支持编辑并重发',
      userAriaLabel: '你发送的消息', systemAriaLabel: '系统消息', assistantAriaLabel: 'Maka 的回答', answerActionsAriaLabel: (context) => `回答操作${context ? `：${context}` : ''}`, answerActionAriaLabel: (action, context) => `${action}回答${context ? `：${context}` : ''}`, messageActionAriaLabel: (action, context) => `${action}消息${context ? `：${context}` : ''}`, sourceAriaLabel: '本轮回答的来源', derivativesAriaLabel: '本轮回答的衍生', scheduledTaskTriggered: '定时任务触发', scheduledTaskTitle: (id) => `由定时任务触发 · ${id}`, legacyAutomationTriggered: '旧版自动化（仅历史）', legacyAutomationTitle: (id) => `由旧版自动化触发 · ${id} · 仅保留历史，不会再次执行`, goalContinued: 'Goal 自动继续', goalTitle: (id) => `由 Goal 继续执行 · ${id}`, agentGraphTriggered: 'Agent Graph 自动继续', agentGraphTitle: (graphId) => `由 Agent Graph 调度器触发 · ${graphId}`,
      thinkingTruncatedTitle: '部分 reasoning 已截断；显示的是最近的内容', outputTruncatedTitle: '助手输出已超过单次回合上限，超出部分未渲染。如需完整内容请重新生成或查看持久化的任务日志。', removeAttachmentAriaLabel: (name) => `移除 ${name}`, quoteLabel: '引用', quoteExpandAriaLabel: '展开引用全文', quoteCollapseAriaLabel: '收起引用', removeQuoteAriaLabel: '移除引用', aborted: '(已中断)', abortedByStop: '(已中断 · 由停止按钮触发)',
    },
    chat: {
      conversationAriaLabel: (name) => `对话：${name}`,
      memory: '记忆', memoryAriaLabel: '本地记忆已启用', memoryTitle: '本地 MEMORY.md 已加入 agent 系统提示。点击进入设置 · 记忆管理。', deepResearch: '深度研究', deepResearchAriaLabel: '深度研究，只读探索', deepResearchTitle: '深度研究任务使用只读探索边界：先阅读和分析，默认不改文件。',
      deepResearchProgress: {
        ariaLabel: '深度研究实时进度',
        title: '研究进度',
        completedSummary: '研究完成 · 原任务保持只读',
        activeSummary: (stage, scope, round) => `${stage} · ${scope} · 第 ${round} 轮`,
        handoffTitle: '新建普通任务并填入研究 handoff；不会自动发送，也不会改变原研究任务权限',
        handoffAction: '在新任务中继续实现',
        checklistTitle: '检查清单',
        reportTitle: '报告草稿',
        inspectedTitle: '已检查位置',
        inspectedEmpty: '等待记录文件、符号或来源。',
        executionTitle: '执行与阻塞',
        executionSummary: (steps, artifacts) => `${steps} 个研究步骤 · ${artifacts} 个持久化证据`,
        workersLabel: 'Workers',
        noBlockers: '当前无阻塞。',
        sectionLabels: {
          conclusion: '结论',
          source_evidence: '证据',
          borrow_diverge_risk_gate: '取舍与风险',
          implementation_recommendations: '实施建议',
          verification: '验证',
        },
      },
      clearGoal: (condition, iteration, max, status) => `自主执行目标进行中：「${condition}」（第 ${iteration}/${max} 轮，${status}）。系统每轮后自动续行；点击可清除目标、停止续行。`, clearGoalAriaLabel: (iteration, max) => `清除自主执行目标（已进行 ${iteration}/${max} 轮）`, goalProgress: (iteration, max) => `目标 ${iteration} / ${max}`, goalRunningAriaLabel: '自主目标正在运行', goalWaitingAriaLabel: '自主目标正在等待条件变化',
      goalPausedAriaLabel: '自主目标已暂停', pauseGoalAriaLabel: (iteration, max) => `暂停自主执行目标（已进行 ${iteration}/${max} 轮）`, resumeGoalAriaLabel: (iteration, max) => `恢复自主执行目标（已进行 ${iteration}/${max} 轮）`, pauseGoal: (condition, iteration, max, status) => `暂停自主执行目标：「${condition}」（第 ${iteration}/${max} 轮，${status}）。暂停后立即停止自动续行，不再消耗令牌；可随时恢复。`, resumeGoal: (condition, iteration, max) => `恢复自主执行目标：「${condition}」（第 ${iteration}/${max} 轮）。恢复后立即继续自动续行。`, goalElapsed: (elapsedMs) => formatGoalElapsedUnits(elapsedMs, { second: ' 秒', minute: ' 分钟', hour: ' 小时', day: ' 天' }), goalTokens: (spent, budget) => `${formatCompactTokenCount(spent)} / ${formatCompactTokenCount(budget)}`,
      loadFailed: '任务载入失败', loading: '载入中…', retryLoad: '重试载入', quoteSelection: '引用', askInSidePanel: '在侧栏追问', noMessages: '暂无消息',
      branchBeforeInterrupt: '从中断前分支', sessionContextAriaLabel: '任务上下文', sessionLineageAriaLabel: '任务来源', sessionContextMore: (count) => `更多任务上下文（${count}）`,
      titlebarIdentityAriaLabel: '当前任务', openProjectFolder: (name) => `在文件管理器中打开「${name}」`, openProjectFolderAction: '打开项目文件夹',
      openParentSession: (name) => `返回父任务「${name}」`, openParentSessionAction: '打开父任务',
      revisionVersionsAriaLabel: '任务版本', revisionVersion: (current, total) => `版本 ${current} / ${total}`, previousRevision: '查看上一版本', nextRevision: '查看下一版本',
    },
    sessions: {
      status: { active: '可继续', running: '进行中', waiting_for_user: '等你确认', blocked: '需要处理', aborted: '已中止' },
      blockedReason: { NO_REAL_CONNECTION: '等待配置可用模型连接', auth: '需要重新登录', permission_required: '等待权限确认', tool_failed: '工具调用失败', unknown: '运行中断，可重试' },
      listAriaLabel: '任务列表', showMore: '显示更多', showMoreAriaLabel: (count) => `显示 ${count} 条更多任务`, renameAriaLabel: '重命名任务', renameProjectTitle: '重命名项目', renameSubmit: '保存', respondingAriaLabel: '正在响应', respondingTitle: '任务正在流式响应中', staleTitle: '此任务使用的模型连接已不可用，发送时会切换到默认连接', staleAriaLabel: '任务已过期', stale: '已过期', unreadAriaLabel: '未读消息', actionsAriaLabel: (name) => `${name} 任务操作`, pin: '置顶', unpin: '取消置顶', rename: '重命名', archive: '归档', unarchive: '取消归档', delete: '删除', pinned: '置顶', recent: '最近', groupByTime: '按时间', groupByProject: '按项目', groupingAriaLabel: '任务分组方式', projectActionsAriaLabel: (name) => `${name} 项目操作`, projectNewTask: '新建任务', projectRename: '重命名', projectArchive: '归档', projectRestore: '恢复', projectRelink: '重新定位', projectUnavailable: '项目目录不可用', archivedProjects: '已归档项目', archivedProjectsAriaLabel: '展开已归档项目', worktreeAriaLabel: 'Git 工作树', promptRailAriaLabel: '按提问跳转', emptyPrompt: '（空提问）', jumpToPrompt: (preview) => `跳到提问：${preview}`,
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
    deepResearchEmpty: {
      ariaLabel: 'Empty Deep Research task', eyebrow: 'Deep Research · Read-only exploration', title: 'Understand the project before deciding what to change.', intro: 'This task stays read only: inspect, search, and analyze first. When implementation is needed, report the files, risks, and verification commands.',
      workflowAriaLabel: 'Deep Research workflow', workflow: [
        { title: 'Find the entry points', body: 'Read the directory layout, configuration, startup path, and test entry points to build a project map.' },
        { title: 'Trace the data flow', body: 'Follow key modules through IPC, storage, permissions, and runtime boundaries to the real implementation.' },
        { title: 'Compare references', body: 'Break each reusable idea into borrow / diverge / risk / gate.' },
        { title: 'Propose a mergeable plan', body: 'List files, risk boundaries, and verification commands without changing files in read-only mode.' },
      ],
      reportAriaLabel: 'Deep Research report structure', reportTitle: 'The report must be actionable', report: [
        { title: 'Lead with conclusions', body: 'Use three to five points to explain the current state, major gaps, and priorities.' },
        { title: 'Cite source evidence', body: 'Name files, functions, configuration, tests, and runtime paths instead of relying on impressions.' },
        { title: 'Break down what to borrow', body: 'Describe each idea as borrow / diverge / risk / gate.' },
        { title: 'Make it implementable', body: 'Give a small-step file plan, boundaries, and verification commands.' },
      ],
      scopeAriaLabel: 'Deep Research scope', scopeTitle: 'Standard depth by default', scope: [
        { label: 'Quick', body: 'Scan entry points, key files, and the likeliest data flow for a narrowly scoped question.' },
        { label: 'Standard', body: 'Trace the core path, related tests, and major risks before recommending changes.' },
        { label: 'Deep', body: 'Run multi-pass investigation across modules, references, and edge cases only when explicitly requested.' },
      ],
      evidenceAriaLabel: 'Deep Research evidence checklist', evidenceTitle: 'Leave evidence for every investigation', evidence: [
        { title: 'Project entry points', body: 'Check the README, package/config files, startup scripts, and directory layers to confirm how the project runs.' },
        { title: 'Core path', body: 'Trace UI entry points, IPC/services, storage, runtime calls, and error handling.' },
        { title: 'Boundaries', body: 'Check permissions, privacy mode, token/path exposure, retries, and user-visible feedback.' },
        { title: 'Verification evidence', body: 'Find tests, fixtures, smoke documentation, and reproducible commands; call out missing evidence.' },
      ],
      progressAriaLabel: 'Deep Research checkpoints', progressTitle: 'Advance multi-step research through checkpoints', progress: [
        { title: 'Build a checklist', body: 'When the scope has more than three related areas, list verifiable checks before tracing code.' },
        { title: 'Mark the current check', body: 'State what is being verified and move on only after collecting evidence.' },
        { title: 'Record blockers', body: 'Mark missing source, runtime, or test evidence as blocked instead of guessing.' },
        { title: 'Converge on a plan', body: 'Roll completed checks into borrow / diverge / risk / gate and actionable improvements.' },
      ],
      startersAriaLabel: 'Deep Research starters', starters: [
        { label: 'Research a reference project', prompt: 'Read this project without changing files. Map its structure, core modules, startup path, data flow, and tests; then list reusable design ideas, risks, and an implementation order for Maka.' },
        { label: 'Read a reference project end to end', prompt: 'Perform a deep, read-only study of this project. Map modules and trace core features, runtime, storage, permissions, UI, tests, and docs. Express each idea as borrow / diverge / risk / gate and recommend an implementation order for Maka.' },
        { label: 'Compare a feature implementation', prompt: 'Compare this feature in the reference project and Maka without changing files. Identify key files, runtime boundaries, UI entry points, persistence, tests, and the smallest mergeable improvement.' },
        { label: 'Audit security boundaries', prompt: 'Audit this feature read only: permissions, token and secret flow, IPC/renderer exposure, file paths, privacy mode, logs, and telemetry. Report blocking risks and corresponding contract tests.' },
      ],
    },
    composer: {
      placeholder: 'Describe a task, @ to reference files, / for skills…', textareaAriaLabel: 'Message input', pastedQuoteLabel: 'Pasted text', selectedSkillsAriaLabel: 'Selected Skills', removeSkillAriaLabel: (name) => `Remove Skill: ${name}`, awaitingPermission: 'Waiting for your permission decision…',
      sending: 'Sending…', importing: 'Importing…', sendLabel: 'Send', steerLabel: 'Steer', stopLabel: 'Stop', stopping: 'Stopping…',
      streaming: 'Maka is responding…', processing: 'Maka is working…', continuing: 'Maka is continuing…',
      interruptHint: 'or click Stop to interrupt', addContext: 'Add context', stagedContext: 'staged items',
      selectModel: 'Choose model', dropToImport: 'Drop to import file contents', addingAttachment: 'Adding attachment', addFileOrDirectory: 'Add file or directory',
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
      newChatAriaLabel: (label) => `Choose a model for the new task, currently ${label}`, newChatTitle: (label) => `Model for the new task: ${label}`,
      configureAriaLabel: (label) => `Configure model connections, currently ${label}`, configureTitle: 'Configure model connections',
    },
    permissions: {
      mode: {
        explore: { label: 'Read only', hint: 'Read and search only; asks before write or network.' },
        ask: { label: 'Auto', hint: "Runs inside Maka's protection; asks before going further." },
        execute: { label: 'Auto execute', hint: 'Common tools run; risky actions still confirm.' },
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
    questions: { other: 'Other', otherDescription: 'Enter a different answer.', otherAriaLabel: 'Other answer', otherPlaceholder: 'Enter your answer', stop: 'Stop', stopping: 'Stopping…', previous: 'Previous', submitting: 'Submitting…', submit: 'Submit answers', next: 'Next' },
    mentions: { noFiles: 'No files found', noSkills: 'No skills available', noCommandsOrSkills: 'No matching commands or skills', filesAriaLabel: 'Workspace files', skillsAriaLabel: 'Skills', commandsAndSkillsAriaLabel: 'Commands and skills', commandsGroup: 'Commands', skillsGroup: 'Skills', loading: 'Loading…' },
    workspace: {
      choose: 'Choose project', current: 'Current project', addProject: 'Add project', noProject: 'No project', relink: 'Relink', unavailable: 'Unavailable',
      chooseTitle: (branch) => branch ? `Choose project · ${branch}` : 'Choose project',
      chooseAriaLabel: (label, branch) => branch ? `Choose project: ${label}, current branch ${branch}` : `Choose project: ${label}`,
    },
    messages: {
      you: 'You', assistant: 'Maka', processing: 'Working…', continuing: 'Continuing…', workingPhrases: ['Pondering…', 'Tinkering…', 'Untangling…', 'Digging in…', 'Mulling…', 'Chewing on it…', 'Wrangling…', 'Piecing it together…'], providerRetryScheduled: (seconds, attempt, maxAttempts) => `Retrying in ${seconds}s (${attempt}/${maxAttempts})`, providerRetryStarted: (attempt, maxAttempts) => `Retrying (${attempt}/${maxAttempts})`, providerRetryReason: { network: 'Network interrupted', provider_unavailable: 'Model service temporarily unavailable', rate_limit: 'Model rate limit reached', timeout: 'Request timed out', unknown: 'Model request failed' }, safeResumePending: 'Checking…', safeResume: 'Safe recovery', thinking: 'Thinking', truncated: 'Truncated', copied: 'Copied', copying: 'Copying', copyFailed: 'Copy failed', copy: 'Copy', editMessage: 'Edit & resend', editMessageDisabledRunning: 'Wait for this answer to finish before editing', editMessageDisabledAttachments: 'Edit & resend does not yet support messages with attachments', editMessageDisabledQuotes: 'Edit & resend does not yet support messages with quotes', editMessageDisabledTransformedText: 'Edit & resend does not yet support messages sent with an explicit skill',
      userAriaLabel: 'Your message', systemAriaLabel: 'System message', assistantAriaLabel: "Maka's response", answerActionsAriaLabel: (context) => `Response actions${context ? `: ${context}` : ''}`, answerActionAriaLabel: (action, context) => `${action} response${context ? `: ${context}` : ''}`, messageActionAriaLabel: (action, context) => `${action} message${context ? `: ${context}` : ''}`, sourceAriaLabel: 'Source of this response', derivativesAriaLabel: 'Responses derived from this one', scheduledTaskTriggered: 'Triggered by scheduled task', scheduledTaskTitle: (id) => `Triggered by scheduled task · ${id}`, legacyAutomationTriggered: 'Legacy Automation (history only)', legacyAutomationTitle: (id) => `Triggered by legacy Automation · ${id} · Historical only; it will not run again`, goalContinued: 'Continued by Goal', goalTitle: (id) => `Continued by Goal · ${id}`, agentGraphTriggered: 'Continued by Agent Graph', agentGraphTitle: (graphId) => `Triggered by the Agent Graph scheduler · ${graphId}`,
      thinkingTruncatedTitle: 'Some reasoning was truncated; showing the most recent content', outputTruncatedTitle: 'The assistant output exceeded the per-turn limit. Regenerate it or inspect the persisted task log for the complete content.', removeAttachmentAriaLabel: (name) => `Remove ${name}`, quoteLabel: 'Quote', quoteExpandAriaLabel: 'Show the full quoted excerpt', quoteCollapseAriaLabel: 'Collapse the quoted excerpt', removeQuoteAriaLabel: 'Remove quote', aborted: '(Interrupted)', abortedByStop: '(Interrupted · Stop button)',
    },
    chat: {
      conversationAriaLabel: (name) => `Conversation: ${name}`,
      memory: 'Memory', memoryAriaLabel: 'Local memory enabled', memoryTitle: 'Local MEMORY.md is included in the agent system prompt. Click to manage it in Settings · Memory.', deepResearch: 'Deep Research', deepResearchAriaLabel: 'Deep Research, read-only exploration', deepResearchTitle: 'Deep Research uses a read-only boundary: inspect and analyze first, without changing files by default.',
      deepResearchProgress: {
        ariaLabel: 'Live Deep Research progress',
        title: 'Research progress',
        completedSummary: 'Research complete · Original task remains read-only',
        activeSummary: (stage, scope, round) => `${stage} · ${scope} · Round ${round}`,
        handoffTitle: 'Create a normal task with the research handoff. It will not send automatically or change the original research task permissions.',
        handoffAction: 'Continue implementation in a new task',
        checklistTitle: 'Checklist',
        reportTitle: 'Report draft',
        inspectedTitle: 'Inspected locations',
        inspectedEmpty: 'Waiting for recorded files, symbols, or sources.',
        executionTitle: 'Execution and blockers',
        executionSummary: (steps, artifacts) => `${steps} research steps · ${artifacts} persisted evidence items`,
        workersLabel: 'Workers',
        noBlockers: 'No current blockers.',
        sectionLabels: {
          conclusion: 'Conclusion',
          source_evidence: 'Evidence',
          borrow_diverge_risk_gate: 'Tradeoffs and risks',
          implementation_recommendations: 'Implementation recommendations',
          verification: 'Verification',
        },
      },
      clearGoal: (condition, iteration, max, status) => `Autonomous goal in progress: “${condition}” (iteration ${iteration}/${max}, ${status}). Maka continues after each iteration; click to clear the goal and stop continuing.`, clearGoalAriaLabel: (iteration, max) => `Clear autonomous goal after ${iteration}/${max} iterations`, goalProgress: (iteration, max) => `Goal ${iteration} of ${max}`, goalRunningAriaLabel: 'Autonomous goal running', goalWaitingAriaLabel: 'Autonomous goal waiting for conditions to change',
      goalPausedAriaLabel: 'Autonomous goal paused', pauseGoalAriaLabel: (iteration, max) => `Pause autonomous goal after ${iteration}/${max} iterations`, resumeGoalAriaLabel: (iteration, max) => `Resume autonomous goal after ${iteration}/${max} iterations`, pauseGoal: (condition, iteration, max, status) => `Pause autonomous goal: “${condition}” (iteration ${iteration}/${max}, ${status}). Pausing stops autonomous continuation immediately — no more tokens burn; resume any time.`, resumeGoal: (condition, iteration, max) => `Resume autonomous goal: “${condition}” (iteration ${iteration}/${max}). Resuming continues autonomous iteration immediately.`, goalElapsed: (elapsedMs) => formatGoalElapsedUnits(elapsedMs, { second: 's', minute: 'm', hour: 'h', day: 'd' }), goalTokens: (spent, budget) => `${formatCompactTokenCount(spent)} / ${formatCompactTokenCount(budget)}`,
      loadFailed: 'Task failed to load', loading: 'Loading…', retryLoad: 'Retry', quoteSelection: 'Quote', askInSidePanel: 'Ask in side panel', noMessages: 'No messages yet',
      branchBeforeInterrupt: 'Branched before interruption', sessionContextAriaLabel: 'Task context', sessionLineageAriaLabel: 'Task origin', sessionContextMore: (count) => `More task context (${count})`,
      titlebarIdentityAriaLabel: 'Current task', openProjectFolder: (name) => `Open “${name}” in the file manager`, openProjectFolderAction: 'Open project folder',
      openParentSession: (name) => `Return to parent task “${name}”`, openParentSessionAction: 'Open parent task',
      revisionVersionsAriaLabel: 'Task versions', revisionVersion: (current, total) => `Version ${current} of ${total}`, previousRevision: 'View previous version', nextRevision: 'View next version',
    },
    sessions: {
      status: { active: 'Ready', running: 'Running', waiting_for_user: 'Waiting for you', blocked: 'Needs attention', aborted: 'Stopped' },
      blockedReason: { NO_REAL_CONNECTION: 'Waiting for an available model connection', auth: 'Sign in again', permission_required: 'Waiting for permission', tool_failed: 'Tool call failed', unknown: 'Run interrupted; retry available' },
      listAriaLabel: 'Task list', showMore: 'Show more', showMoreAriaLabel: (count) => `Show ${count} more tasks`, renameAriaLabel: 'Rename task', renameProjectTitle: 'Rename project', renameSubmit: 'Save', respondingAriaLabel: 'Responding', respondingTitle: 'This task is streaming a response', staleTitle: 'This task\'s model connection is unavailable; sending will switch to the default connection', staleAriaLabel: 'Stale task', stale: 'Stale', unreadAriaLabel: 'Unread messages', actionsAriaLabel: (name) => `${name} task actions`, pin: 'Pin', unpin: 'Unpin', rename: 'Rename', archive: 'Archive', unarchive: 'Unarchive', delete: 'Delete', pinned: 'Pinned', recent: 'Recent', groupByTime: 'By time', groupByProject: 'By project', groupingAriaLabel: 'Task grouping', projectActionsAriaLabel: (name) => `${name} project actions`, projectNewTask: 'New task', projectRename: 'Rename', projectArchive: 'Archive', projectRestore: 'Restore', projectRelink: 'Relocate', projectUnavailable: 'Project directory unavailable', archivedProjects: 'Archived projects', archivedProjectsAriaLabel: 'Expand archived projects', worktreeAriaLabel: 'Git worktree', promptRailAriaLabel: 'Jump by prompt', emptyPrompt: '(empty prompt)', jumpToPrompt: (preview) => `Jump to prompt: ${preview}`,
    },
  },
} satisfies UiCatalog<ConversationCopy>;

export function getConversationCopy(locale: UiLocale): ConversationCopy {
  return CONVERSATION_COPY[locale];
}
