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

import type { ChatConfigurationReason } from '@maka/core/connection-readiness';
import type { SessionSendProjection } from '@maka/core/session-send-projection';

import type { ModelCallKind } from '@maka/core/model-call-attempt';

import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';

export interface DesktopConversationCopy {
  actions: {
    stopFailedTitle: string;
    stopFailedFallback: string;
    refreshSessionsFailedTitle: string;
    refreshSessionsFailedFallback: string;
    conversationErrorTitle: string;
    conversationErrorFallback: string;
    regenerateStartedTitle: string;
    regenerateStartedDescription: string;
    branchCreatedTitle: string;
    branchCreatedDescription: (name: string) => string;
    revisionStartedTitle: string;
    revisionStartedDescription: string;
    revisionReadyTitle: string;
    revisionReadyDescription: string;
    revisionUnavailableTitle: string;
    revisionAttachmentsUnsupported: string;
    revisionTransformedTextUnsupported: string;
    revisionDraftAttachmentConflict: string;
    revisionCommandUnsupported: string;
    revisionAlreadyActive: string;
    revisionCancelLabel: string;
    revisionBannerTitle: string;
    revisionBannerDetail: string;
    revisionUnchanged: string;
    operationFailedTitle: string;
    operationFailedFallback: string;
    attachmentFailedTitle: string;
    imageAttachmentNotDirectTitle: string;
    imageAttachmentNotDirectDescription: string;
    tryAgain: string;
    modelReboundTitle: string;
    modelReboundDescription: (modelId?: string) => string;
    messageReadFailedTitle: string;
    partialHistoryTitle: string;
    returnLatest: string;
    scrollMainToBottom: string;
  };
  attachments: { tooMany: string; tooLarge: string; duplicate: string };
  model: {
    fakeBackendLabel: string;
    setupTitle: string;
    connectionMissingTitle: string;
    configurationFallback: string;
    configurationReason: Record<ChatConfigurationReason, string>;
  };
  footer: {
    labels: Record<'regenerate' | 'branch' | 'copy' | 'info', string>;
    pending: string;
    regenerateRunning: string;
    regenerateAgain: string;
    regenerate: string;
    requestRegenerate: string;
    branchRunning: string;
    branchAborted: string;
    branch: string;
    copy: string;
    copyEmpty: string;
  };
  lineage: {
    regeneratedFrom: string;
    regeneratedFromTooltip: string;
    regeneratedTo: string;
    regeneratedToTooltip: string;
  };
  workbar: {
    ariaLabel: string;
    sectionsAriaLabel: string;
    review: string;
    terminal: string;
    terminalNumbered(index: number): string;
    tasks: string;
    todoLoadFailed: string;
    workBoard: string;
    browser: string;
    files: string;
    inspector: string;
    sideChat: string;
    sideChatNumbered(index: number): string;
    openTab: string;
    openTools: string;
    closeTab(label: string): string;
    tabMenu(label: string): string;
    moveLeft: string;
    moveRight: string;
    moveToRight: string;
    moveToBottom: string;
    pinTab: string;
    pinTabHint: string;
    close: string;
    closeOthers: string;
    closeToRight: string;
    launcher: {
      review: string;
      terminal: string;
      tasks: string;
      workBoard: string;
      browser: string;
      files: string;
      inspector: string;
      sideChat: string;
    };
  };
  workBoardPanel: {
    inbox: string;
    project: string;
    noProject: string;
    createPlaceholder: string;
    create: string;
    empty: string;
    loading: string;
    loadMore: string;
    retry: string;
    loadFailed: string;
    actionFailed: string;
    complete: string;
    reopen: string;
    rename: string;
    renameSave: string;
    moveToInbox: string;
    moveToProject: string;
    archive: string;
    unarchive: string;
    delete: string;
    archived: string;
  };
  reviewPanel: {
    ariaLabel: string;
    empty: string;
    /** The panel-empty (tier 2) sentence under `empty`. */
    emptyHelp: string;
    notGitRepository: string;
    workspaceUnavailable: string;
    unbornRepository: string;
    gitFailed: string;
    invalidBaseBranch: string;
    truncated: string;
    showMore(remaining: number): string;
    hiddenLines(count: number): string;
    changedFiles(count: number): string;
    addedLines(count: number): string;
    deletedLines(count: number): string;
    added(count: number): string;
    deleted(count: number): string;
    loadFailed: string;
    retry: string;
  };
  terminalPanel: {
    ariaLabel: string;
    empty: string;
    /** The panel-empty (tier 2) sentence under `empty`. */
    emptyHelp: string;
    loadFailed: string;
    retry: string;
    refresh: string;
    readOnly: string;
    runCount(count: number): string;
    newTerminal: string;
    commandPlaceholder: string;
    commandLabel: string;
    runCommand: string;
    stopTerminal: string;
    startFailed: string;
    writeFailed: string;
    stopFailed: string;
  };
  inspector: {
    ariaLabel: string;
    /** Copy action and success copy for an unpriced model call's exact Pricing key. */
    copyPricingKey: string;
    pricingKeyCopied: string;
    unpricedPricingKey: string;
    /** Toast title when the clipboard write is denied or unavailable. */
    copyFailed: string;
    copyFailedDetail: string;
    loadFailed: string;
    retry: string;
    empty: string;
    /** The panel-empty (tier 2) sentence under `empty`. */
    emptyHelp: string;
    costUnavailable: string;
    costEstimateHelp: string;
    loadEarlier: string;
    hideEarlier: string;
    loadingEarlier: string;
    loadingTrace: string;
    loadingSummary: string;
    summaryUnavailable: string;
    /** Label for the complete Session cost estimate. */
    totals: {
      cost: string;
    };
    /**
     * The session-wide metered-token split, read like a bill: what the
     * provider's cache served, what was paid as uncached input, what was paid
     * as output. Names the bands of the token track, in the track's order.
     */
    tokenUsage: {
      title: string;
      segment: { cacheRead: string; cacheMiss: string; output: string };
    };
    /**
     * Where the session's recorded time went. Names the bands of the duration
     * track; each row also states how many times its kind ran.
     */
    durationUsage: {
      title: string;
      /** Label under the ring's total figure. */
      center: string;
      segment: {
        model: (count: number) => string;
        tool: (count: number) => string;
      };
    };
    /**
     * The coverage notice, composed with its own breakdown: the separators
     * belong to the language, not to the layout, so a Chinese sentence gets
     * `：` and `、` where an English one gets `:` and `,`.
     */
    coveragePartial: (parts: readonly string[]) => string;
    coverageAbsent: (parts: readonly string[]) => string;
    /** Each states its own count, so English can say "1 turn" and not "1 turns". */
    unreadable: (count: number) => string;
    oversizedRuns: (count: number) => string;
    turnsMissing: (count: number) => string;
    turnsShort: (count: number) => string;
    /**
     * Names a step whose kind IS its identity — a compaction, an error, a
     * permission prompt with no tool attached. Rows that carry a real
     * identifier (a model id, a tool name) print that instead.
     */
    stepKind: { permission: string; compaction: string; error: string };
    /** Why a model was called, when the reason was not the turn itself. */
    callKind: (kind: string) => string;
    /** How a permission request was answered. */
    permissionDecision: (decision: string) => string;
    /** What a tool that failed was recovered as. */
    recoveredAs: (disposition: string) => string;
    /** Attempts beyond the first, in words rather than as `×N`. */
    retries: (count: number) => string;
    /**
     * What ended the turn badly, in words. The trace's codes are engineering
     * vocabulary (`tool_failed`, `turn_aborted`); this is the sentence a
     * reader gets, with a plain fallback for a code nobody has named yet.
     */
    turnFailure: (code: string) => string;
    /** Stable display name of one turn, qualified by its recorded start time. */
    turnLabel: (startedAt: string) => string;
    /** Summary above the raw timeline. */
    overview: {
      context: string;
      /** Names the bands of the context bar, in the bar's own order. */
      segment: {
        cacheRead: string;
        fresh: string;
        used: string;
        free: string;
      };
      /** The three figures a reader opens this tab for, as headline stats. */
      cacheHit: string;
      /** Heading over the causal record. */
      timelineTab: string;
      /**
       * What filled the context, under the bar that says how full it is.
       *
       * Kept verbally separate from the bar on purpose: these are estimates
       * over serialized bytes and do not sum to the provider-reported prompt
       * (#2323), so the heading says estimate and every figure carries a `≈`.
       */
      composition: {
        title: string;
        /** States the unit and its authority, once, under the heading. */
        basis: string;
        part: {
          system_instructions: string;
          tool_definitions: string;
          messages: string;
          other: string;
        };
        /** Heading over the per-tool rows. */
        tools: string;
        /** The tools below the visible rows, folded into one. */
        remainingTools: (count: number) => string;
        /** Tool schemas the payload never named. */
        unlabelled: string;
        /** The metered call carried no capture — a gap, not an empty prompt. */
        unrecorded: string;
      };
    };
  };
  quoteCompanion: {
    /** Prefix for the companion fork's session name (followed by the excerpt). */
    namePrefix: string;
    permissionStreaming: string;
    scrollToBottom: string;
    compactSuccessTitle: string;
    compactSuccessDescription: string;
    compactStartedTitle: string;
    compactStartedDescription: string;
    compactUnchangedTitle: string;
    compactUnchangedDescription: string;
    compactErrorTitle: string;
    compactErrorFallback: string;
    workspaceUnavailableTitle: string;
    workspaceUnavailableDescription: string;
    closeConfirmation: {
      title(count: number): string;
      description(count: number): string;
      dontAskAgain: string;
      cancel: string;
      confirm: string;
    };
    errors: {
      /** Reading the source boundary or creating the companion fork failed. */
      forkSetupFailed: string;
      /** The source or one of its linked child runs is still active. */
      forkSourceBusy: string;
      /** The retained source context cannot be represented safely. */
      forkUnsupported: string;
      /** `sessions.send` was rejected without throwing (e.g. an unresolved skill). */
      sendRejected: string;
      /** `sessions.send` threw / the turn could not be started. */
      sendFailed: string;
      /** The run ended but the persisted transcript could not be refreshed. */
      settlementFailed: string;
      /** Responding to a permission / question prompt failed. */
      respondFailed: string;
    };
  };
  health: {
    blocked: Record<
      Extract<SessionSendProjection, { kind: 'blocked' }>['reason'],
      {
        label: string;
        tooltip: (connection: string, model: string) => string;
        actionLabel?: string;
        settingsTooltip?: (connection: string, model: string) => string;
      }
    >;
    connectionChoicesLoading: { tooltip: string; actionLabel: string };
    reauth: { label: string; tooltip: string };
    testError: { label: string; tooltip: string };
  };
  turnError: {
    unknown: string;
    contextOverflow: string;
    timeout: string;
    auth: string;
    providerBilling: string;
    providerCapacity: string;
    rateLimit: string;
    network: string;
    provider: string;
    stepCap: string;
    tool: string;
    permission: string;
    restarted: string;
    sandboxBoundaryClosed: string;
    executionState: Record<'erroredTool' | 'toolRan' | 'partialOutput', string>;
  };
}

/**
 * The trace's own enums, in words.
 *
 * Every one of these reaches the panel as a raw identifier — `history_compact`,
 * `parked`, `tool_failed` — because the projection records facts, not prose.
 * Turning them into a sentence is a copy decision, so it happens here, once.
 *
 * The call-kind tables are typed against the core union, so a kind added to the
 * runtime fails this file at compile time instead of reaching a locale panel
 * as `daily_review`. The table also labels decode-only historical kinds such as
 * `semantic_compact`; the Runtime no longer emits them.
 */
type CallKindCopy = Record<Exclude<ModelCallKind, 'main'>, string>;

const ZH_CALL_KIND: CallKindCopy = {
  memory_extraction: '记忆提取',
  semantic_compact: '语义压缩',
  history_compact: '历史压缩',
  goal_evaluation: '目标评估',
  session_title: '生成任务标题',
  session_recap: '任务回顾',
  daily_review: '每日回顾',
};

const EN_CALL_KIND: CallKindCopy = {
  memory_extraction: 'Memory extraction',
  semantic_compact: 'Semantic compaction',
  history_compact: 'History compaction',
  goal_evaluation: 'Goal evaluation',
  session_title: 'Task title',
  session_recap: 'Task recap',
  daily_review: 'Daily review',
};

const KO_CALL_KIND: CallKindCopy = {
  memory_extraction: '메모리 추출',
  semantic_compact: '시맨틱 압축',
  history_compact: '기록 압축',
  goal_evaluation: '목표 평가',
  session_title: '작업 제목',
  session_recap: '작업 요약',
  daily_review: '일일 검토',
};

const ZH_PERMISSION_DECISION: Record<string, string> = { allow: '已允许', deny: '已拒绝' };
const EN_PERMISSION_DECISION: Record<string, string> = { allow: 'Allowed', deny: 'Denied' };
const KO_PERMISSION_DECISION: Record<string, string> = { allow: '허용됨', deny: '거부됨' };

const ZH_RECOVERED: Record<string, string> = { completed: '已完成', parked: '已搁置' };

// `turn_failed` and `error` are the codes the projection falls back to when it
// cannot attribute the failure to a step; both reach this panel, so both are
// named rather than left to the generic wording.
const ZH_TURN_FAILURE: Record<string, string> = {
  tool_failed: '工具失败',
  model_call_failed: '模型调用失败',
  turn_aborted: '本轮中止',
  turn_cancelled: '本轮取消',
  turn_failed: '本轮失败',
  error: '运行出错',
};

const EN_TURN_FAILURE: Record<string, string> = {
  tool_failed: 'Tool failed',
  model_call_failed: 'Model call failed',
  turn_aborted: 'Turn aborted',
  turn_cancelled: 'Turn cancelled',
  turn_failed: 'Turn failed',
  error: 'Run error',
};

const KO_TURN_FAILURE: Record<string, string> = {
  tool_failed: '도구 실패',
  model_call_failed: '모델 호출 실패',
  turn_aborted: '턴 중단됨',
  turn_cancelled: '턴 취소됨',
  turn_failed: '턴 실패',
  error: '실행 오류',
};

/** Trailing breakdown for the coverage notice, in each language's punctuation. */
function zhDetail(parts: readonly string[]): string {
  return parts.length > 0 ? `：${parts.join('、')}` : '';
}

function enDetail(parts: readonly string[]): string {
  return parts.length > 0 ? `: ${parts.join(', ')}` : '';
}

function koDetail(parts: readonly string[]): string {
  return parts.length > 0 ? `: ${parts.join(', ')}` : '';
}

const COPY = {
  'zh-CN': {
    actions: { stopFailedTitle: '停止失败', stopFailedFallback: '任务操作失败，请稍后重试。', refreshSessionsFailedTitle: '刷新任务列表失败', refreshSessionsFailedFallback: '刷新任务列表失败，请稍后重试。', conversationErrorTitle: '任务出错', conversationErrorFallback: '任务运行失败，请稍后重试。', regenerateStartedTitle: '已发起重新生成', regenerateStartedDescription: '正在生成新的一轮回答', branchCreatedTitle: '已创建分支', branchCreatedDescription: (name) => `新任务 ${name}`, revisionStartedTitle: '已创建修改版草稿', revisionStartedDescription: '原任务仍会保留；修改后发送将在新版本中继续', revisionReadyTitle: '可以修改并重发了', revisionReadyDescription: '已回到该消息之前；编辑后发送即可', revisionUnavailableTitle: '暂时无法编辑这条消息', revisionAttachmentsUnsupported: '包含附件的历史消息暂不支持编辑并重发，请复制文字后新建消息。', revisionTransformedTextUnsupported: '通过显式技能发送的历史消息暂不支持编辑并重发，请复制文字后重新选择技能。', revisionDraftAttachmentConflict: 'Composer 中已有待发送附件，请先发送或移除附件，再编辑历史消息。', revisionCommandUnsupported: '修改消息时不能执行 /compact、/side 或编排命令，请取消修改后再试。', revisionAlreadyActive: '已有一条消息正在修改，请先发送或取消当前修改。', revisionCancelLabel: '取消', revisionBannerTitle: '正在修改已发送消息', revisionBannerDetail: '· 发送后创建新版本', revisionUnchanged: '内容没有变化。如需重新回答，请使用“重新生成”。', operationFailedTitle: '操作失败', operationFailedFallback: '任务操作失败，请稍后重试。', attachmentFailedTitle: '添加附件失败', imageAttachmentNotDirectTitle: '图片已作为附件添加', imageAttachmentNotDirectDescription: '当前模型不会直接接收图片。图片已作为附件提供给模型。', tryAgain: '请稍后重试。', modelReboundTitle: '已切换到可用模型', modelReboundDescription: (modelId) => `原任务使用的连接已不可用${modelId ? ` · ${modelId}` : ''}`, messageReadFailedTitle: '读取任务失败', partialHistoryTitle: '正在查看较早的消息', returnLatest: '返回最新消息', scrollMainToBottom: '滚动主对话到底部' },
    attachments: { tooMany: '附件数量超过 8 个', tooLarge: '附件大小超过 50MB', duplicate: '附件来源重复，请勿重复添加同一文件。' },
    model: {
      fakeBackendLabel: '本地模拟连接',
      setupTitle: '等待配置真实模型',
      connectionMissingTitle: '连接已删除',
      configurationFallback: '模型连接暂时无法用于发送，请到 设置 · 模型 检查后重试。',
      configurationReason: {
        missing_default_connection: '等待配置默认模型。请到 设置 · 模型 添加一个可用模型连接后再发送。',
        connection_missing: '该任务依赖的模型连接已删除，请到 设置 · 模型 重新选择或重建连接。',
        connection_disabled: '当前模型连接已禁用。请到 设置 · 模型 启用或选择其他默认模型。',
        missing_api_key: '当前模型连接还没有可用凭据。请到 设置 · 模型 补齐 API key 或重新登录后再发送。',
        missing_model: '当前模型连接还没有可用模型。请到 设置 · 模型 选择默认模型后再发送。',
        empty_model_list: '当前模型连接没有启用模型。请到 设置 · 模型 添加或启用模型后再发送。',
        model_not_enabled: '当前任务选择的模型未启用。请到 设置 · 模型 重新选择可用模型后再发送。',
        model_not_chat_capable: '当前任务选择的模型不能用于聊天。请到 设置 · 模型 重新选择支持聊天的模型后再发送。',
        fake_backend: '当前任务来自旧的本地模拟连接。请到 设置 · 模型 添加真实模型后新建任务。',
        provider_retired: '当前任务绑定的连接，其登录方式已从 Maka 移除，无法用于发送。请到 设置 · 模型 改用其他连接后新建任务。',
      },
    },
    footer: { labels: { regenerate: '重新生成', branch: '分支', copy: '复制', info: '详情' }, pending: '正在处理…', regenerateRunning: '当前回答仍在进行中，结束后再重新生成', regenerateAgain: '已重新生成过，再次点击将创建新的并行回答', regenerate: '让模型重新生成本轮回答', requestRegenerate: '请求所有者批准重新生成本轮回答', branchRunning: '当前回答仍在进行中，结束后再分支', branchAborted: '从中断前的上下文分支出新任务', branch: '基于此回答的上下文分支出新任务', copy: '复制回答到剪贴板', copyEmpty: '此回答尚无可复制的内容' },
    lineage: { regeneratedFrom: '重新生成自旧回答', regeneratedFromTooltip: '这是重新生成的并行回答，点击查看被保留的旧回答', regeneratedTo: '已重新生成 → 新回答', regeneratedToTooltip: '点击跳转到重新生成的新回答' },
    workbar: {
      ariaLabel: '任务工作栏',
      sectionsAriaLabel: '任务工作栏标签',
      review: '变更',
      terminal: '终端',
      terminalNumbered: (index) => `终端 ${index}`,
      tasks: '待办',
      todoLoadFailed: '待办载入失败，请重试。',
      workBoard: '工作看板',
      browser: '浏览器',
      files: '生成文件',
      inspector: '追踪',
      sideChat: '侧边对话',
      sideChatNumbered: (index) => `侧边对话 ${index}`,
      openTab: '打开工作栏标签',
      openTools: '打开工具',
      closeTab: (label) => `关闭${label}`,
      tabMenu: (label) => `${label}标签菜单`,
      moveLeft: '向左移动',
      moveRight: '向右移动',
      moveToRight: '移动到右侧面板',
      moveToBottom: '移动到底部面板',
      pinTab: '固定标签',
      pinTabHint: '预览标签，双击或在内容中操作即可固定',
      close: '关闭',
      closeOthers: '关闭其他标签',
      closeToRight: '关闭右侧标签',
      launcher: {
        review: '查看当前 Git 工作区变化',
        terminal: '查看当前任务的终端运行和实时输出',
        tasks: '查看和维护这个任务的待办台账',
        workBoard: '记录和管理暂缓事项',
        browser: '打开内置浏览器并保留当前页面',
        files: '浏览当前任务生成的文件',
        inspector: '检查任务调用、工具与耗时记录',
        sideChat: '在不打断主任务的情况下追问和只读探索',
      },
    },
    workBoardPanel: {
      inbox: 'Inbox',
      project: '当前项目',
      noProject: '未选择项目',
      createPlaceholder: '记录稍后处理的事项…',
      create: '添加',
      empty: '暂无暂缓事项',
      loading: '正在加载工作看板…',
      loadMore: '加载更多',
      retry: '重试',
      loadFailed: '工作看板加载失败',
      actionFailed: '操作失败',
      complete: '完成',
      reopen: '重开',
      rename: '改名',
      renameSave: '保存',
      moveToInbox: '移到 Inbox',
      moveToProject: '移到项目',
      archive: '归档',
      unarchive: '恢复',
      delete: '删除',
      archived: '已归档',
    },
    reviewPanel: {
      ariaLabel: 'Git 变更',
      empty: '当前 Git 工作区没有变化',
      emptyHelp: '提交、暂存或修改文件后，变化会显示在这里。',
      notGitRepository: '当前任务目录不是 Git 仓库',
      workspaceUnavailable: '当前任务目录已不可用',
      unbornRepository: 'Git 仓库还没有可比较的提交',
      gitFailed: '无法读取 Git 工作区变化',
      invalidBaseBranch: '选择的比较分支已不可用',
      truncated: '变化过多，仅显示前一部分文件',
      showMore: (remaining) => `再显示 ${Math.min(20, remaining)} 个文件`,
      hiddenLines: (count) => `另有 ${count} 行未显示`,
      changedFiles: (count) => `${count} 个文件有变更`,
      addedLines: (count) => `新增 ${count} 行`,
      deletedLines: (count) => `删除 ${count} 行`,
      added: (count) => `新增 ${count}`,
      deleted: (count) => `删除 ${count}`,
      loadFailed: '无法读取 Git 变化',
      retry: '重试',
    },
    terminalPanel: {
      ariaLabel: '任务终端',
      empty: '当前任务还没有终端运行',
      emptyHelp: '任务启动终端后会显示在这里。',
      loadFailed: '无法读取终端运行',
      retry: '重试',
      refresh: '刷新终端',
      readOnly: '显示代理和你在当前任务中启动的终端运行',
      runCount: (count) => `${count} 个终端运行`,
      newTerminal: '新建终端',
      commandPlaceholder: '输入命令并回车',
      commandLabel: '终端命令',
      runCommand: '运行命令',
      stopTerminal: '停止当前终端',
      startFailed: '无法启动终端',
      writeFailed: '无法发送终端输入',
      stopFailed: '无法停止终端',
    },
    inspector: {
      ariaLabel: '任务追踪',
      copyPricingKey: '复制定价键',
      pricingKeyCopied: '已复制定价键',
      unpricedPricingKey: '未计价的定价键',
      copyFailed: '复制失败',
      copyFailedDetail: '剪贴板不可用或被系统拒绝。',
      loadFailed: '追踪读取失败',
      retry: '重试',
      empty: '这个任务还没有可追踪的活动',
      emptyHelp: '任务尚无活动记录。',
      costUnavailable: '费用未知',
      costEstimateHelp: '基于已记录用量和定价估算；缺失或未定价的调用可能未计入。',
      loadEarlier: '加载更早记录',
      hideEarlier: '隐藏所有更早记录',
      loadingEarlier: '正在加载…',
      loadingTrace: '正在读取时间线…',
      loadingSummary: '正在估算完整会话用量…',
      summaryUnavailable: '完整会话用量暂时无法估算。',
      totals: {
        cost: '估算成本',
      },
      tokenUsage: {
        title: 'Token 统计',
        segment: {
          cacheRead: '缓存输入',
          cacheMiss: '未命中输入',
          output: '输出（含思考）',
        },
      },
      durationUsage: {
        title: '耗时统计',
        center: '记录时长',
        segment: {
          model: (count) => `LLM 调用 × ${count}`,
          tool: (count) => `工具执行 × ${count}`,
        },
      },
      coveragePartial: (parts) => `部分调用未能完整显示，下面的数字只少不多${zhDetail(parts)}`,
      coverageAbsent: (parts) => `这个后端不记录每次调用的明细${zhDetail(parts)}`,
      unreadable: (count) => `${count} 条记录读不出来`,
      oversizedRuns: (count) => `${count} 条运行记录过大，无法在线显示`,
      turnsMissing: (count) => `${count} 轮没有调用记录`,
      turnsShort: (count) => `${count} 轮的调用记录不全`,
      stepKind: { permission: '权限', compaction: '上下文压缩', error: '错误' },
      callKind: (kind) => ZH_CALL_KIND[kind as keyof CallKindCopy] ?? kind,
      permissionDecision: (decision) => ZH_PERMISSION_DECISION[decision] ?? decision,
      recoveredAs: (disposition) => `已恢复：${ZH_RECOVERED[disposition] ?? disposition}`,
      retries: (count) => `重试 ${count} 次`,
      turnFailure: (code) => ZH_TURN_FAILURE[code] ?? '本轮失败',
      turnLabel: (startedAt) => `轮次 · ${startedAt}`,
      overview: {
        context: '上下文窗口',
        segment: {
          cacheRead: '缓存命中',
          fresh: '缓存未命中',
          used: '已占用',
          free: '剩余',
        },
        cacheHit: '缓存命中率',
        timelineTab: '时间轴',
        composition: {
          title: '构成估算',
          basis: '按请求字节估算，非模型报告的 token',
          part: {
            system_instructions: '系统提示',
            tool_definitions: '工具定义',
            messages: '对话记录',
            other: '其他参数',
          },
          tools: '按工具',
          remainingTools: (count) => `其余 ${count} 个工具`,
          unlabelled: '未命名的工具',
          unrecorded: '这次调用没有留下构成记录',
        },
      },
    },
    quoteCompanion: {
      namePrefix: '侧聊：',
      permissionStreaming: '侧边对话运行中暂时不能更改权限',
      scrollToBottom: '滚动侧边对话到底部',
      compactSuccessTitle: '上下文已压缩',
      compactSuccessDescription: '较早的上下文已替换为检查点摘要。',
      compactStartedTitle: '正在压缩上下文',
      compactStartedDescription: '正在将较早的上下文整理为检查点摘要。',
      compactUnchangedTitle: '无需压缩',
      compactUnchangedDescription: '任务已使用最新的检查点。',
      compactErrorTitle: '压缩失败',
      compactErrorFallback: '任务暂时无法压缩，请稍后重试。',
      workspaceUnavailableTitle: '工作目录不可用',
      workspaceUnavailableDescription: '工作目录不存在或无法访问。请选择有效目录创建新任务。',
      closeConfirmation: {
        title: (count) => count > 1 ? `关闭 ${count} 个侧边对话？` : '关闭侧边对话？',
        description: (count) =>
          count > 1
            ? `这 ${count} 个临时侧边对话会被永久删除，之后无法恢复。`
            : '这个临时侧边对话会被永久删除，之后无法恢复。',
        dontAskAgain: '以后不再询问',
        cancel: '取消',
        confirm: '关闭侧边对话',
      },
      errors: {
        forkSetupFailed: '无法创建侧边对话，请稍后重试。',
        forkSourceBusy: '主对话或子任务仍在运行，请等待完成后重试。',
        forkUnsupported: '当前对话上下文暂不支持创建侧边对话。',
        sendRejected: '追问未能开始，请稍后重试。',
        sendFailed: '追问失败，请稍后重试。',
        settlementFailed: '运行已结束，但消息加载失败。请重试或重新打开侧边对话。',
        respondFailed: '响应失败，请稍后重试。',
      },
    },
    health: {
      blocked: {
        fake_backend: { label: '任务已过期 · 请先配置真实模型', tooltip: () => '原任务使用旧的本地模拟连接，需要先到 设置 · 模型 添加并启用一个真实模型才能发送。' },
        provider_retired: { label: '登录方式已停用', tooltip: (name) => `任务绑定的连接 "${name}" 使用的登录方式已从 Maka 移除，发送会失败。请到 设置 · 模型 改用其他连接。` },
        missing_default_connection: { label: '未配置可用模型', tooltip: () => '当前任务没有可用的模型连接，发送会失败。请到 设置 · 模型 添加并启用一个模型。' },
        legacy_connection_identity: { label: '需要选择模型连接', tooltip: () => '此任务来自旧版本，请选择要使用的连接和模型。', actionLabel: '选择连接和模型', settingsTooltip: () => '当前没有可用连接，请先到 设置 · 模型 添加或启用连接。' },
        connection_missing: { label: '原连接已删除', tooltip: () => '请选择新的连接和模型后继续。', actionLabel: '选择连接和模型', settingsTooltip: () => '当前没有可用连接，请先到 设置 · 模型 添加或启用连接。' },
        connection_identity_mismatch: { label: '连接身份不匹配', tooltip: () => '请重新选择要使用的连接和模型。', actionLabel: '选择连接和模型', settingsTooltip: () => '当前没有可用连接，请先到 设置 · 模型 添加或启用连接。' },
        connection_disabled: { label: '连接已禁用', tooltip: (name) => `任务绑定的连接 "${name}" 已禁用，发送会失败。请到 设置 · 模型 启用它或选择其他连接。` },
        missing_api_key: { label: '连接缺少密钥', tooltip: (name) => `连接 "${name}" 未填写 API key 或未完成登录，发送会失败。请到 设置 · 模型 补齐凭据。` },
        missing_model: { label: '连接未选择模型', tooltip: (name) => `连接 "${name}" 没有默认模型，发送会失败。请到 设置 · 模型 选择一个模型。` },
        empty_model_list: { label: '连接没有启用模型', tooltip: (name) => `连接 "${name}" 没有启用任何模型，发送会失败。请到 设置 · 模型 先添加模型。` },
        model_not_enabled: { label: '任务模型未启用', tooltip: (name, model) => `模型 "${model}" 不在连接 "${name}" 的启用列表中，发送会失败。请到 设置 · 模型 重新选择。` },
        model_not_chat_capable: { label: '任务模型不支持聊天', tooltip: (name, model) => `模型 "${model}" 不能用于聊天，发送会失败。请到 设置 · 模型 选择支持聊天的模型。` },
      },
      connectionChoicesLoading: { tooltip: '连接列表尚未加载完成。', actionLabel: '重新加载连接' },
      reauth: { label: '上次连接测试鉴权失败', tooltip: '最近一次连接测试返回鉴权失败（401 / 403），密钥可能已过期或被吊销。这不会拦截发送，但若发送失败请到 设置 · 模型 重新登录。' },
      testError: { label: '上次连接测试失败', tooltip: '最近一次连接测试因网络 / 超时 / 5xx 失败。这不会拦截发送，但若问题持续请到 设置 · 模型 检查 Base URL / 代理。' },
    },
    turnError: { unknown: '出错了，原因不明。重新发消息重试。', contextOverflow: '上下文超出模型窗口限制，减少附件或开启新任务。', timeout: '模型请求超时，重新发消息重试。', auth: '模型鉴权失败，请到设置里重新连接或登录。', providerBilling: '模型服务计费受限，请检查账号余额或订阅状态。', providerCapacity: '模型服务暂时满载，等几分钟重试，或换一个模型。', rateLimit: '模型请求太频繁被限流了，等一会儿再发消息重试。', network: '网络连接失败，检查网络后重新发消息。', provider: '模型服务返回错误，稍后重试或换一个模型。', stepCap: '达到工具调用步数上限，任务可能没做完。发消息让它继续。', tool: '工具调用失败，看一下上面的工具结果再决定要不要重试。', permission: '这一轮在等权限确认时结束了，重新发消息会再问一次。', restarted: '本地应用重启，上一轮没有完成', sandboxBoundaryClosed: '本地应用重启时，等待确认的「允许访问工作区以外的内容」请求已按拒绝关闭。重新发消息可以再决定一次。', executionState: { erroredTool: '这一轮有工具执行出错，先看它的结果，再决定要不要重发。', toolRan: '这一轮已经执行过工具，可能已经产生实际改动，重发前先看工具结果。', partialOutput: '这一轮已经产生了部分回答，重发前可以先看看。' } },
  },
  'zh-TW': {
    actions: { stopFailedTitle: '停止失敗', stopFailedFallback: '任務操作失敗，請稍後重試。', refreshSessionsFailedTitle: '重新整理任務列表失敗', refreshSessionsFailedFallback: '重新整理任務列表失敗，請稍後重試。', conversationErrorTitle: '任務出錯', conversationErrorFallback: '任務執行失敗，請稍後重試。', regenerateStartedTitle: '已發起重新生成', regenerateStartedDescription: '正在生成新的一輪迴答', branchCreatedTitle: '已建立分支', branchCreatedDescription: (name) => `新任務 ${name}`, revisionStartedTitle: '已建立修改版草稿', revisionStartedDescription: '原任務仍會保留；修改後傳送將在新版本中繼續', revisionReadyTitle: '可以修改並重發了', revisionReadyDescription: '已回到該訊息之前；編輯後傳送即可', revisionUnavailableTitle: '暫時無法編輯這條訊息', revisionAttachmentsUnsupported: '包含附件的歷史訊息暫不支援編輯並重發，請複製文字後建立訊息。', revisionTransformedTextUnsupported: '透過顯式技能傳送的歷史訊息暫不支援編輯並重發，請複製文字後重新選擇技能。', revisionDraftAttachmentConflict: 'Composer 中已有待發送附件，請先發送或移除附件，再編輯歷史訊息。', revisionCommandUnsupported: '修改訊息時不能執行 /compact、/side 或編排命令，請取消修改後再試。', revisionAlreadyActive: '已有一條訊息正在修改，請先發送或取消目前修改。', revisionCancelLabel: '取消', revisionBannerTitle: '正在修改已傳送訊息', revisionBannerDetail: '· 傳送後建立新版本', revisionUnchanged: '內容沒有變化。如需重新回答，請使用“重新生成”。', operationFailedTitle: '操作失敗', operationFailedFallback: '任務操作失敗，請稍後重試。', attachmentFailedTitle: '新增附件失敗', imageAttachmentNotDirectTitle: '圖片已作為附件新增', imageAttachmentNotDirectDescription: '目前模型不會直接接收圖片。圖片已作為附件提供給模型。', tryAgain: '請稍後重試。', modelReboundTitle: '已切換到可用模型', modelReboundDescription: (modelId) => `原任務使用的連線已不可用${modelId ? ` · ${modelId}` : ''}`, messageReadFailedTitle: '讀取任務失敗', partialHistoryTitle: '正在檢視較早的訊息', returnLatest: '返回最新訊息', scrollMainToBottom: '滾動主對話到底部' },
    attachments: { tooMany: '附件數量超過 8 個', tooLarge: '附件大小超過 50MB', duplicate: '附件來源重複，請勿重複新增同一檔案。' },
    model: {
      fakeBackendLabel: '本地模擬連線',
      setupTitle: '等待設定真實模型',
      connectionMissingTitle: '連線已刪除',
      configurationFallback: '模型連線暫時無法用於傳送，請到 設定 · 模型 檢查後重試。',
      configurationReason: {
        missing_default_connection: '等待設定預設模型。請到 設定 · 模型 新增一個可用模型連線後再發送。',
        connection_missing: '該任務依賴的模型連線已刪除，請到 設定 · 模型 重新選擇或重建連線。',
        connection_disabled: '目前模型連線已停用。請到 設定 · 模型 啟用或選擇其他預設模型。',
        missing_api_key: '目前模型連線還沒有可用憑據。請到 設定 · 模型 補齊 API key 或重新登入後再發送。',
        missing_model: '目前模型連線還沒有可用模型。請到 設定 · 模型 選擇預設模型後再發送。',
        empty_model_list: '目前模型連線沒有啟用模型。請到 設定 · 模型 新增或啟用模型後再發送。',
        model_not_enabled: '目前任務選擇的模型未啟用。請到 設定 · 模型 重新選擇可用模型後再發送。',
        model_not_chat_capable: '目前任務選擇的模型不能用於聊天。請到 設定 · 模型 重新選擇支援聊天的模型後再發送。',
        fake_backend: '目前任務來自舊的本地模擬連線。請到 設定 · 模型 新增真實模型後建立任務。',
        provider_retired: '目前任務繫結的連線，其登入方式已從 Maka 移除，無法用於傳送。請到 設定 · 模型 改用其他連線後建立任務。',
      },
    },
    footer: { labels: { regenerate: '重新生成', branch: '分支', copy: '複製', info: '詳情' }, pending: '正在處理…', regenerateRunning: '目前回答仍在進行中，結束後再重新生成', regenerateAgain: '已重新生成過，再次點選將建立新的並行回答', requestRegenerate: '請求擁有者核准重新生成本輪回答', regenerate: '讓模型重新生成本輪迴答', branchRunning: '目前回答仍在進行中，結束後再分支', branchAborted: '從中斷前的上下文分支出新任務', branch: '基於此回答的上下文分支出新任務', copy: '複製回答到剪貼簿', copyEmpty: '此回答尚無可複製的內容' },
    lineage: { regeneratedFrom: '重新生成自舊回答', regeneratedFromTooltip: '這是重新生成的並行回答，點選檢視被保留的舊回答', regeneratedTo: '已重新生成 → 新回答', regeneratedToTooltip: '點選跳轉到重新生成的新回答' },
    workbar: {
      ariaLabel: '任務工作欄',
      sectionsAriaLabel: '任務工作欄標籤',
      review: '變更',
      terminal: '終端',
      terminalNumbered: (index) => `終端 ${index}`,
      tasks: '待辦',
      todoLoadFailed: '待辦載入失敗，請重試。',
      workBoard: '工作看板',
      browser: '瀏覽器',
      files: '生成檔案',
      inspector: '追蹤',
      sideChat: '側邊對話',
      sideChatNumbered: (index) => `側邊對話 ${index}`,
      openTab: '開啟工作欄標籤',
      openTools: '開啟工具',
      closeTab: (label) => `關閉${label}`,
      tabMenu: (label) => `${label}標籤選單`,
      moveLeft: '向左移動',
      moveRight: '向右移動',
      moveToRight: '移動到右側面板',
      moveToBottom: '移動到底部面板',
      pinTab: '固定標籤',
      pinTabHint: '預覽標籤，雙擊或在內容中操作即可固定',
      close: '關閉',
      closeOthers: '關閉其他標籤',
      closeToRight: '關閉右側標籤',
      launcher: {
        review: '檢視目前 Git 工作區變化',
        terminal: '檢視目前任務的終端執行和即時輸出',
        tasks: '檢視和維護這個任務的待辦臺賬',
        workBoard: '記錄和管理暫緩事項',
        browser: '開啟內建瀏覽器並保留目前頁面',
        files: '瀏覽目前任務生成的檔案',
        inspector: '檢查任務呼叫、工具與耗時記錄',
        sideChat: '在不打斷主任務的情況下追問和只讀探索',
      },
    },
    workBoardPanel: {
      inbox: 'Inbox',
      project: '目前專案',
      noProject: '未選擇專案',
      createPlaceholder: '記錄稍後處理的事項…',
      create: '新增',
      empty: '暫無暫緩事項',
      loading: '正在載入工作看板…',
      loadMore: '載入更多',
      retry: '重試',
      loadFailed: '工作看板載入失敗',
      actionFailed: '操作失敗',
      complete: '完成',
      reopen: '重開',
      rename: '改名',
      renameSave: '儲存',
      moveToInbox: '移到 Inbox',
      moveToProject: '移到專案',
      archive: '歸檔',
      unarchive: '恢復',
      delete: '刪除',
      archived: '已歸檔',
    },
    reviewPanel: {
      ariaLabel: 'Git 變更',
      empty: '目前 Git 工作區沒有變化',
      emptyHelp: '提交、暫存或修改檔案後，變化會顯示在這裡。',
      notGitRepository: '目前任務目錄不是 Git 倉庫',
      workspaceUnavailable: '目前任務目錄已不可用',
      unbornRepository: 'Git 倉庫還沒有可比較的提交',
      gitFailed: '無法讀取 Git 工作區變化',
      invalidBaseBranch: '選擇的比較分支已不可用',
      truncated: '變化過多，僅顯示前一部分檔案',
      showMore: (remaining) => `再顯示 ${Math.min(20, remaining)} 個檔案`,
      hiddenLines: (count) => `另有 ${count} 行未顯示`,
      changedFiles: (count) => `${count} 個檔案有變更`,
      addedLines: (count) => `新增 ${count} 行`,
      deletedLines: (count) => `刪除 ${count} 行`,
      added: (count) => `新增 ${count}`,
      deleted: (count) => `刪除 ${count}`,
      loadFailed: '無法讀取 Git 變化',
      retry: '重試',
    },
    terminalPanel: {
      ariaLabel: '任務終端',
      empty: '目前任務還沒有終端執行',
      emptyHelp: '任務啟動終端後會顯示在這裡。',
      loadFailed: '無法讀取終端執行',
      retry: '重試',
      refresh: '重新整理終端',
      readOnly: '顯示代理和你在目前任務中啟動的終端執行',
      runCount: (count) => `${count} 個終端執行`,
      newTerminal: '建立終端',
      commandPlaceholder: '輸入命令並回車',
      commandLabel: '終端命令',
      runCommand: '執行命令',
      stopTerminal: '停止目前終端',
      startFailed: '無法啟動終端',
      writeFailed: '無法傳送終端輸入',
      stopFailed: '無法停止終端',
    },
    inspector: {
      ariaLabel: '任務追蹤',
      copyPricingKey: '複製定價鍵',
      pricingKeyCopied: '已複製定價鍵',
      unpricedPricingKey: '未計價的定價鍵',
      copyFailed: '複製失敗',
      copyFailedDetail: '剪貼簿不可用或被系統拒絕。',
      loadFailed: '追蹤讀取失敗',
      retry: '重試',
      empty: '這個任務還沒有可追蹤的活動',
      emptyHelp: '任務尚無活動記錄。',
      costUnavailable: '費用未知',
      costEstimateHelp: '基於已記錄用量和定價估算；缺失或未定價的呼叫可能未計入。',
      loadEarlier: '載入更早記錄',
      hideEarlier: '隱藏所有更早記錄',
      loadingEarlier: '正在載入…',
      loadingTrace: '正在讀取時間線…',
      loadingSummary: '正在估算完整會話用量…',
      summaryUnavailable: '完整會話用量暫時無法估算。',
      totals: {
        cost: '估算成本',
      },
      tokenUsage: {
        title: 'Token 統計',
        segment: {
          cacheRead: '快取輸入',
          cacheMiss: '未命中輸入',
          output: '輸出（含思考）',
        },
      },
      durationUsage: {
        title: '耗時統計',
        center: '記錄時長',
        segment: {
          model: (count) => `LLM 呼叫 × ${count}`,
          tool: (count) => `工具執行 × ${count}`,
        },
      },
      coveragePartial: (parts) => `部分呼叫未能完整顯示，下面的數字只少不多${zhDetail(parts)}`,
      coverageAbsent: (parts) => `這個後端不記錄每次呼叫的明細${zhDetail(parts)}`,
      unreadable: (count) => `${count} 條記錄讀不出來`,
      oversizedRuns: (count) => `${count} 條執行記錄過大，無法線上顯示`,
      turnsMissing: (count) => `${count} 輪沒有呼叫記錄`,
      turnsShort: (count) => `${count} 輪的呼叫記錄不全`,
      stepKind: { permission: '權限', compaction: '上下文壓縮', error: '錯誤' },
      callKind: (kind) => ZH_CALL_KIND[kind as keyof CallKindCopy] ?? kind,
      permissionDecision: (decision) => ZH_PERMISSION_DECISION[decision] ?? decision,
      recoveredAs: (disposition) => `已恢復：${ZH_RECOVERED[disposition] ?? disposition}`,
      retries: (count) => `重試 ${count} 次`,
      turnFailure: (code) => ZH_TURN_FAILURE[code] ?? '本輪失敗',
      turnLabel: (startedAt) => `輪次 · ${startedAt}`,
      overview: {
        context: '上下文視窗',
        segment: {
          cacheRead: '快取命中',
          fresh: '快取未命中',
          used: '已佔用',
          free: '剩餘',
        },
        cacheHit: '快取命中率',
        timelineTab: '時間軸',
        composition: {
          title: '構成估算',
          basis: '按請求位元組估算，非模型報告的 token',
          part: {
            system_instructions: '系統提示',
            tool_definitions: '工具定義',
            messages: '對話記錄',
            other: '其他引數',
          },
          tools: '按工具',
          remainingTools: (count) => `其餘 ${count} 個工具`,
          unlabelled: '未命名的工具',
          unrecorded: '這次呼叫沒有留下構成記錄',
        },
      },
    },
    quoteCompanion: {
      compactStartedTitle: '正在壓縮上下文', compactStartedDescription: '正在將較早的上下文整理為檢查點摘要。', compactSuccessTitle: '上下文已壓縮', compactSuccessDescription: '較早的上下文已替換為檢查點摘要。', compactUnchangedTitle: '無需壓縮', compactUnchangedDescription: '任務已使用最新的檢查點。', compactErrorTitle: '壓縮失敗', compactErrorFallback: '任務暫時無法壓縮，請稍後重試。', workspaceUnavailableTitle: '工作目錄無法使用', workspaceUnavailableDescription: '工作目錄不存在或無法存取。請選擇有效目錄建立新任務。',
      namePrefix: '側聊：',
      permissionStreaming: '側邊對話執行中暫時不能更改權限',
      scrollToBottom: '滾動側邊對話到底部',
      closeConfirmation: {
        title: (count) => count > 1 ? `關閉 ${count} 個側邊對話？` : '關閉側邊對話？',
        description: (count) =>
          count > 1
            ? `這 ${count} 個臨時側邊對話會被永久刪除，之後無法恢復。`
            : '這個臨時側邊對話會被永久刪除，之後無法恢復。',
        dontAskAgain: '以後不再詢問',
        cancel: '取消',
        confirm: '關閉側邊對話',
      },
      errors: {
        forkSetupFailed: '無法建立側邊對話，請稍後重試。',
        forkSourceBusy: '主對話或子任務仍在執行，請等待完成後重試。',
        forkUnsupported: '目前對話上下文暫不支援建立側邊對話。',
        sendRejected: '追問未能開始，請稍後重試。',
        sendFailed: '追問失敗，請稍後重試。',
        settlementFailed: '執行已結束，但訊息載入失敗。請重試或重新開啟側邊對話。',
        respondFailed: '回應失敗，請稍後重試。',
      },
    },
    health: {
      blocked: {
        fake_backend: { label: '任務已過期 · 請先設定真實模型', tooltip: () => '原任務使用舊的本地模擬連線，需要先到 設定 · 模型 新增並啟用一個真實模型才能傳送。' },
        provider_retired: { label: '登入方式已停用', tooltip: (name) => `任務繫結的連線 "${name}" 使用的登入方式已從 Maka 移除，傳送會失敗。請到 設定 · 模型 改用其他連線。` },
        missing_default_connection: { label: '未設定可用模型', tooltip: () => '目前任務沒有可用的模型連線，傳送會失敗。請到 設定 · 模型 新增並啟用一個模型。' },
        legacy_connection_identity: { label: '需要選擇模型連線', tooltip: () => '此任務來自舊版本，請選擇要使用的連線和模型。', actionLabel: '選擇連線和模型', settingsTooltip: () => '目前沒有可用連線，請先到 設定 · 模型 新增或啟用連線。' },
        connection_missing: { label: '連線已刪除', tooltip: () => '此任務依賴的模型連線已被刪除，傳送會失敗。請到 設定 · 模型 檢查連線設定。' },
        connection_identity_mismatch: { label: '連線身分不符', tooltip: () => '請重新選擇要使用的連線和模型。', actionLabel: '選擇連線和模型', settingsTooltip: () => '目前沒有可用連線，請先到 設定 · 模型 新增或啟用連線。' },
        connection_disabled: { label: '連線已停用', tooltip: (name) => `任務繫結的連線 "${name}" 已停用，傳送會失敗。請到 設定 · 模型 啟用它或選擇其他連線。` },
        missing_api_key: { label: '連線缺少金鑰', tooltip: (name) => `連線 "${name}" 未填寫 API key 或未完成登入，傳送會失敗。請到 設定 · 模型 補齊憑據。` },
        missing_model: { label: '連線未選擇模型', tooltip: (name) => `連線 "${name}" 沒有預設模型，傳送會失敗。請到 設定 · 模型 選擇一個模型。` },
        empty_model_list: { label: '連線沒有啟用模型', tooltip: (name) => `連線 "${name}" 沒有啟用任何模型，傳送會失敗。請到 設定 · 模型 先新增模型。` },
        model_not_enabled: { label: '任務模型未啟用', tooltip: (name, model) => `模型 "${model}" 不在連線 "${name}" 的啟用列表中，傳送會失敗。請到 設定 · 模型 重新選擇。` },
        model_not_chat_capable: { label: '任務模型不支援聊天', tooltip: (name, model) => `模型 "${model}" 不能用於聊天，傳送會失敗。請到 設定 · 模型 選擇支援聊天的模型。` },
      },
      connectionChoicesLoading: { tooltip: '連線清單尚未載入完成。', actionLabel: '重新載入連線' },
      reauth: { label: '上次連線測試鑑權失敗', tooltip: '最近一次連線測試回傳鑑權失敗（401 / 403），金鑰可能已過期或被吊銷。這不會攔截發送，但若傳送失敗請到 設定 · 模型 重新登入。' },
      testError: { label: '上次連線測試失敗', tooltip: '最近一次連線測試因網路 / 超時 / 5xx 失敗。這不會攔截發送，但若問題持續請到 設定 · 模型 檢查 Base URL / 代理。' },
    },
    turnError: { unknown: '出錯了，原因不明。重新傳送訊息重試。', contextOverflow: '上下文超出模型視窗限制，減少附件或開啟新任務。', timeout: '模型請求逾時，重新傳送訊息重試。', auth: '模型鑑權失敗，請到設定裡重新連線或登入。', providerBilling: '模型服務計費受限，請檢查帳號餘額或訂閱狀態。', providerCapacity: '模型服務暫時滿載，請等待幾分鐘或切換模型。', rateLimit: '模型請求太頻繁而受到速率限制，請稍候再傳送訊息重試。', network: '網路連線失敗，檢查網路後重新傳送訊息。', provider: '模型服務回傳錯誤，稍後重試或切換模型。', stepCap: '達到工具呼叫步數上限，任務可能尚未完成。傳送訊息讓它繼續。', tool: '工具呼叫失敗，先看上面的工具結果再決定是否重試。', permission: '這一輪在等待權限確認時結束，重新傳送訊息會再詢問一次。', restarted: '本機應用程式重啟，上一輪沒有完成', sandboxBoundaryClosed: '本機應用程式重啟時，等待確認的「允許存取工作區以外的內容」請求已按拒絕關閉。重新傳送訊息可以再次決定。', executionState: { erroredTool: '這一輪有工具執行出錯，先看它的結果，再決定是否重發。', toolRan: '這一輪已經執行過工具，可能已經產生實際變更，重發前先看工具結果。', partialOutput: '這一輪已經產生部分回答，重發前可以先看看。' } },
  },
  en: {
    actions: { stopFailedTitle: 'Failed to stop', stopFailedFallback: 'The task action failed. Try again later.', refreshSessionsFailedTitle: 'Failed to refresh tasks', refreshSessionsFailedFallback: 'The task list could not be refreshed. Try again later.', conversationErrorTitle: 'Task error', conversationErrorFallback: 'The task run failed. Try again later.', regenerateStartedTitle: 'Regeneration started', regenerateStartedDescription: 'Generating a new response', branchCreatedTitle: 'Branch created', branchCreatedDescription: (name) => `New task: ${name}`, revisionStartedTitle: 'Edit draft ready', revisionStartedDescription: 'The original task is kept; sending creates a new version', revisionReadyTitle: 'Ready to edit and resend', revisionReadyDescription: 'Rewound to before that message; edit and send when ready', revisionUnavailableTitle: 'This message cannot be edited yet', revisionAttachmentsUnsupported: 'Edit & resend does not yet support historical attachments. Copy the text into a new message instead.', revisionTransformedTextUnsupported: 'Edit & resend does not yet support messages sent with an explicit skill. Copy the text and select the skill again instead.', revisionDraftAttachmentConflict: 'The composer already has pending attachments. Send or remove them before editing a sent message.', revisionCommandUnsupported: 'You cannot run /compact, /side, or orchestration commands while editing a sent message. Cancel the edit first.', revisionAlreadyActive: 'Another message is already being edited. Send or cancel that edit first.', revisionCancelLabel: 'Cancel', revisionBannerTitle: 'Editing sent message', revisionBannerDetail: '· New version on send', revisionUnchanged: 'Nothing changed. Use Regenerate if you only want a new answer.', operationFailedTitle: 'Action failed', operationFailedFallback: 'The task action failed. Try again later.', attachmentFailedTitle: 'Failed to add attachment', imageAttachmentNotDirectTitle: 'Image added as an attachment', imageAttachmentNotDirectDescription: 'The current model does not receive images directly. The image has been provided as an attachment.', tryAgain: 'Try again later.', modelReboundTitle: 'Switched to an available model', modelReboundDescription: (modelId) => `The previous connection is unavailable${modelId ? ` · ${modelId}` : ''}`, messageReadFailedTitle: 'Failed to load task', partialHistoryTitle: 'Viewing earlier messages', returnLatest: 'Return to latest', scrollMainToBottom: 'Scroll main conversation to bottom' },
    attachments: { tooMany: 'You can attach at most 8 files', tooLarge: 'Attachments must be 50 MB or smaller', duplicate: 'This attachment was already added.' },
    model: {
      fakeBackendLabel: 'Local simulation',
      setupTitle: 'Configure a real model',
      connectionMissingTitle: 'Connection deleted',
      configurationFallback: 'This model connection cannot send right now. Check it in Settings · Models and try again.',
      configurationReason: {
        missing_default_connection: 'Set a default model in Settings · Models before sending.',
        connection_missing: 'The model connection used by this task was deleted. Select or create one in Settings · Models.',
        connection_disabled: 'The current model connection is disabled. Enable it or choose another default in Settings · Models.',
        missing_api_key: 'The current model connection has no usable credentials. Add an API key or sign in again under Settings · Models.',
        missing_model: 'The current connection has no usable model. Select a default model in Settings · Models.',
        empty_model_list: 'The current connection has no enabled models. Add or enable one in Settings · Models.',
        model_not_enabled: 'The model selected for this task is disabled. Choose an enabled model in Settings · Models.',
        model_not_chat_capable: 'The model selected for this task cannot chat. Choose a chat-capable model in Settings · Models.',
        fake_backend: 'This task used the retired local simulation. Add a real model in Settings · Models, then start a new task.',
        provider_retired: 'The sign-in this task\u2019s connection uses was removed from Maka, so it cannot send. Switch to another connection in Settings · Models, then start a new task.',
      },
    },
    footer: { labels: { regenerate: 'Regenerate', branch: 'Branch', copy: 'Copy', info: 'Details' }, pending: 'Working…', regenerateRunning: 'Wait for the current response to finish before regenerating', regenerateAgain: 'A regenerated response already exists; click again to create another parallel response', regenerate: 'Generate another response to this turn', requestRegenerate: 'Ask the Owner to approve regenerating this response', branchRunning: 'Wait for the current response to finish before branching', branchAborted: 'Branch from the context before the interruption', branch: 'Branch a new task from this response', copy: 'Copy response to clipboard', copyEmpty: 'This response has no content to copy' },
    lineage: { regeneratedFrom: 'Regenerated from previous response', regeneratedFromTooltip: 'This is a parallel regenerated response; click to view the retained previous response', regeneratedTo: 'Regenerated → New response', regeneratedToTooltip: 'Jump to the regenerated response' },
    workbar: {
      ariaLabel: 'Task workbar',
      sectionsAriaLabel: 'Task workbar tabs',
      review: 'Changes',
      terminal: 'Terminal',
      terminalNumbered: (index) => `Terminal ${index}`,
      tasks: 'To-do',
      todoLoadFailed: 'Failed to load the to-do list. Try again.',
      workBoard: 'Work board',
      browser: 'Browser',
      files: 'Generated files',
      inspector: 'Trace',
      sideChat: 'Side chat',
      sideChatNumbered: (index) => `Side chat ${index}`,
      openTab: 'Open workbar tab',
      openTools: 'Open tools',
      closeTab: (label) => `Close ${label}`,
      tabMenu: (label) => `${label} tab menu`,
      moveLeft: 'Move left',
      moveRight: 'Move right',
      moveToRight: 'Move to right panel',
      moveToBottom: 'Move to bottom panel',
      pinTab: 'Pin tab',
      pinTabHint: 'Preview tab. Double-click or interact with its content to pin it',
      close: 'Close',
      closeOthers: 'Close other tabs',
      closeToRight: 'Close tabs to the right',
      launcher: {
        review: 'View changes in the current Git workspace',
        terminal: 'Inspect terminal runs and live output for this task',
        tasks: "View and maintain this task's to-do ledger",
        workBoard: 'Capture and manage deferred work',
        browser: 'Open the embedded browser and keep the current page',
        files: 'Browse files generated by this task',
        inspector: 'Inspect model calls, tools, and timing',
        sideChat: 'Ask and explore read-only without interrupting the main task',
      },
    },
    workBoardPanel: {
      inbox: 'Inbox',
      project: 'Current project',
      noProject: 'No project selected',
      createPlaceholder: 'Capture something for later…',
      create: 'Add',
      empty: 'No deferred work',
      loading: 'Loading work board…',
      loadMore: 'Load more',
      retry: 'Retry',
      loadFailed: 'Failed to load work board',
      actionFailed: 'Action failed',
      complete: 'Complete',
      reopen: 'Reopen',
      rename: 'Rename',
      renameSave: 'Save',
      moveToInbox: 'Move to Inbox',
      moveToProject: 'Move to project',
      archive: 'Archive',
      unarchive: 'Restore',
      delete: 'Delete',
      archived: 'Archived',
    },
    reviewPanel: {
      ariaLabel: 'Git changes',
      empty: 'No changes in the current Git workspace',
      emptyHelp: 'Committed, staged, and modified files appear here.',
      notGitRepository: 'This task directory is not a Git repository',
      workspaceUnavailable: 'This task directory is unavailable',
      unbornRepository: 'This Git repository has no commit to compare yet',
      gitFailed: 'Could not read Git workspace changes',
      invalidBaseBranch: 'The selected comparison branch is unavailable',
      truncated: 'Too many changes; showing the first files only',
      showMore: (remaining) =>
        `Show ${Math.min(20, remaining)} more file${Math.min(20, remaining) === 1 ? '' : 's'}`,
      hiddenLines: (count) =>
        `${count} more line${count === 1 ? '' : 's'} not shown`,
      changedFiles: (count) => `${count} changed file${count === 1 ? '' : 's'}`,
      addedLines: (count) => `${count} line${count === 1 ? '' : 's'} added`,
      deletedLines: (count) => `${count} line${count === 1 ? '' : 's'} deleted`,
      added: (count) => `${count} added`,
      deleted: (count) => `${count} deleted`,
      loadFailed: 'Could not read Git changes',
      retry: 'Retry',
    },
    terminalPanel: {
      ariaLabel: 'Task terminal',
      empty: 'No terminal runs in this task yet',
      emptyHelp: "This task's terminal appears here once it starts.",
      loadFailed: 'Could not read terminal runs',
      retry: 'Retry',
      refresh: 'Refresh terminal',
      readOnly: 'Shows terminal runs started by the agent or you in this task',
      runCount: (count) => `${count} terminal run${count === 1 ? '' : 's'}`,
      newTerminal: 'New terminal',
      commandPlaceholder: 'Enter a command and press Enter',
      commandLabel: 'Terminal command',
      runCommand: 'Run command',
      stopTerminal: 'Stop current terminal',
      startFailed: 'Could not start terminal',
      writeFailed: 'Could not send terminal input',
      stopFailed: 'Could not stop terminal',
    },
    inspector: {
      ariaLabel: 'Task trace',
      copyPricingKey: 'Copy pricing key',
      pricingKeyCopied: 'Pricing key copied',
      unpricedPricingKey: 'Unpriced pricing key',
      copyFailed: 'Copy failed',
      copyFailedDetail: 'The clipboard is unavailable or access was denied by the system.',
      loadFailed: 'Could not read the trace',
      retry: 'Retry',
      empty: 'Nothing to trace in this task yet',
      emptyHelp: 'No activity recorded for this task yet.',
      costUnavailable: 'cost unknown',
      costEstimateHelp: 'Estimated from recorded usage and pricing; missing or unpriced calls may be excluded.',
      loadEarlier: 'Load earlier records',
      hideEarlier: 'Hide all earlier records',
      loadingEarlier: 'Loading…',
      loadingTrace: 'Loading timeline…',
      loadingSummary: 'Estimating full-session usage…',
      summaryUnavailable: 'Full-session usage is temporarily unavailable.',
      totals: {
        cost: 'Estimated cost',
      },
      tokenUsage: {
        title: 'Token usage',
        segment: {
          cacheRead: 'Cached input',
          cacheMiss: 'Uncached input',
          output: 'Output (incl. reasoning)',
        },
      },
      durationUsage: {
        title: 'Time breakdown',
        center: 'Recorded Time',
        segment: {
          model: (count) => `LLM Calls × ${count}`,
          tool: (count) => `Tool Runs × ${count}`,
        },
      },
      coveragePartial: (parts) =>
        `Some calls could not be shown completely, so the numbers below only undercount${enDetail(parts)}`,
      coverageAbsent: (parts) => `This backend does not record per-call detail${enDetail(parts)}`,
      unreadable: (count) => `${count} record${count === 1 ? '' : 's'} could not be read`,
      oversizedRuns: (count) =>
        `${count} run record${count === 1 ? '' : 's'} too large to show online`,
      turnsMissing: (count) => `${count} turn${count === 1 ? '' : 's'} with no call record`,
      turnsShort: (count) =>
        `${count} turn${count === 1 ? '' : 's'} with an incomplete call record`,
      stepKind: { permission: 'Permission', compaction: 'Context compaction', error: 'Error' },
      callKind: (kind) => EN_CALL_KIND[kind as keyof CallKindCopy] ?? kind,
      permissionDecision: (decision) => EN_PERMISSION_DECISION[decision] ?? decision,
      recoveredAs: (disposition) => `recovered as ${disposition}`,
      retries: (count) => `${count} retr${count === 1 ? 'y' : 'ies'}`,
      turnFailure: (code) => EN_TURN_FAILURE[code] ?? 'Turn failed',
      turnLabel: (startedAt) => `Turn · ${startedAt}`,
      overview: {
        context: 'Context window',
        segment: {
          cacheRead: 'Cache hit',
          fresh: 'Cache miss',
          used: 'Used',
          free: 'Remaining',
        },
        cacheHit: 'Cache hit rate',
        timelineTab: 'Timeline',
        composition: {
          title: 'Estimated composition',
          basis: 'Estimated from request bytes, not provider-reported tokens',
          part: {
            system_instructions: 'System instructions',
            tool_definitions: 'Tool definitions',
            messages: 'Messages',
            other: 'Other options',
          },
          tools: 'By tool',
          remainingTools: (count) => `${count} more tool${count === 1 ? '' : 's'}`,
          unlabelled: 'Unnamed tools',
          unrecorded: 'This call left no composition on record',
        },
      },
    },
    quoteCompanion: {
      namePrefix: 'Side: ',
      permissionStreaming: 'Permissions cannot change while the side chat is running',
      scrollToBottom: 'Scroll side conversation to bottom',
      compactSuccessTitle: 'Context compacted',
      compactSuccessDescription: 'Older context was replaced with a checkpoint summary.',
      compactStartedTitle: 'Compacting context',
      compactStartedDescription: 'Summarizing older context into a checkpoint.',
      compactUnchangedTitle: 'Nothing to compact',
      compactUnchangedDescription: 'The task already uses the latest checkpoint.',
      compactErrorTitle: 'Compaction failed',
      compactErrorFallback: 'The task could not be compacted. Try again later.',
      workspaceUnavailableTitle: 'Working directory unavailable',
      workspaceUnavailableDescription:
        'The working directory does not exist or cannot be accessed. Select a valid folder for a new task.',
      closeConfirmation: {
        title: (count) => count > 1 ? `Close ${count} side chats?` : 'Close side chat?',
        description: (count) =>
          count > 1
            ? `These ${count} temporary side chats will be permanently deleted and cannot be recovered.`
            : 'This temporary side chat will be permanently deleted and cannot be recovered.',
        dontAskAgain: 'Don’t ask again',
        cancel: 'Cancel',
        confirm: 'Close side chat',
      },
      errors: {
        forkSetupFailed: 'Could not open the side chat. Please try again.',
        forkSourceBusy:
          'The main conversation or a linked task is still running. Try again when it finishes.',
        forkUnsupported: 'This conversation context cannot be opened as a side chat yet.',
        sendRejected: 'The companion could not start. Please try again.',
        sendFailed: 'The companion request failed. Please try again.',
        settlementFailed: 'The run ended, but its messages could not be loaded. Retry or reopen the side chat.',
        respondFailed: 'The response failed. Please try again.',
      },
    },
    health: {
      blocked: {
        fake_backend: { label: 'Stale task · Configure a real model', tooltip: () => 'This task used the retired local simulation. Add and enable a real model in Settings · Models before sending.' },
        provider_retired: { label: 'Sign-in retired', tooltip: (name) => `The sign-in that connection "${name}" uses was removed from Maka, so sending fails. Switch to another connection in Settings · Models.` },
        missing_default_connection: { label: 'No model configured', tooltip: () => 'This task has no available model connection. Add and enable one in Settings · Models.' },
        legacy_connection_identity: { label: 'Choose a model connection', tooltip: () => 'This task comes from an older version. Choose the connection and model to use.', actionLabel: 'Choose connection and model', settingsTooltip: () => 'No connections are currently available. Add or enable one in Settings · Models first.' },
        connection_missing: { label: 'Original connection deleted', tooltip: () => 'Choose a new connection and model to continue.', actionLabel: 'Choose connection and model', settingsTooltip: () => 'No connections are currently available. Add or enable one in Settings · Models first.' },
        connection_identity_mismatch: { label: 'Connection identity mismatch', tooltip: () => 'Choose the connection and model to use again.', actionLabel: 'Choose connection and model', settingsTooltip: () => 'No connections are currently available. Add or enable one in Settings · Models first.' },
        connection_disabled: { label: 'Connection disabled', tooltip: (name) => `Connection "${name}" is disabled. Enable it or choose another connection in Settings · Models.` },
        missing_api_key: { label: 'Connection credentials missing', tooltip: (name) => `Connection "${name}" has no API key or completed sign-in. Add credentials in Settings · Models.` },
        missing_model: { label: 'No model selected', tooltip: (name) => `Connection "${name}" has no default model. Select one in Settings · Models.` },
        empty_model_list: { label: 'No models enabled', tooltip: (name) => `Connection "${name}" has no enabled models. Add one in Settings · Models.` },
        model_not_enabled: { label: 'Task model disabled', tooltip: (name, model) => `Model "${model}" is not enabled for connection "${name}". Choose another model in Settings · Models.` },
        model_not_chat_capable: { label: 'Task model cannot chat', tooltip: (_name, model) => `Model "${model}" cannot be used for chat. Choose a chat-capable model in Settings · Models.` },
      },
      connectionChoicesLoading: { tooltip: 'The connection list has not loaded yet.', actionLabel: 'Reload connections' },
      reauth: { label: 'Last connection test failed authentication', tooltip: 'The latest test returned 401 / 403. Sending is not blocked, but sign in again under Settings · Models if it fails.' },
      testError: { label: 'Last connection test failed', tooltip: 'The latest test failed because of a network, timeout, or 5xx error. Sending is not blocked; check Base URL or proxy settings if it persists.' },
    },
    turnError: { unknown: 'Something went wrong, cause unknown. Send a message to retry.', contextOverflow: 'Context exceeded the model window. Reduce attachments or start a new task.', timeout: 'The model request timed out. Send a message to retry.', auth: 'Model authentication failed. Reconnect or sign in again from Settings.', providerBilling: 'Model billing is restricted. Check the account balance or subscription.', providerCapacity: 'The model service is temporarily at capacity. Wait a few minutes, or switch models.', rateLimit: 'Requests were rate-limited. Wait a moment, then send a message to retry.', network: 'The network connection failed. Check the network, then send a message again.', provider: 'The model service returned an error. Retry later, or switch models.', stepCap: 'The tool-step limit was reached, so the task may be incomplete. Send a message to continue.', tool: 'A tool call failed. Check the tool result above before deciding whether to retry.', permission: 'This turn ended while waiting for permission. Send a message and it will ask again.', restarted: 'The app restarted before the previous turn completed', sandboxBoundaryClosed: 'The app restarted, so the pending request to reach outside the workspace was closed as denied. Send a message to decide again.', executionState: { erroredTool: 'A tool errored during this turn. Read its result before deciding whether to send another message.', toolRan: 'Tools already ran during this turn and may have made real changes. Read their results before sending another message.', partialOutput: 'This turn produced part of an answer. Worth reading before you send another message.' } },
  },
  ko: {
  ...{
    actions: {
      stopFailedTitle: "중지하지 못했습니다.",
      stopFailedFallback: "작업 작업이 실패했습니다. 나중에 다시 시도하세요.",
      refreshSessionsFailedTitle: "작업을 새로 고치지 못했습니다.",
      refreshSessionsFailedFallback: "작업 목록을 새로 고칠 수 없습니다. 나중에 다시 시도하세요.",
      conversationErrorTitle: "작업 오류",
      conversationErrorFallback: "작업 실행이 실패했습니다. 나중에 다시 시도하세요.",
      regenerateStartedTitle: "재생이 시작되었습니다",
      regenerateStartedDescription: "새로운 응답 생성",
      branchCreatedTitle: "지점이 생성되었습니다.",
      branchCreatedDescription: name => `새 작업: ${name}`,
      revisionStartedTitle: "초안 수정 준비됨",
      revisionStartedDescription: "원래 작업은 유지됩니다. 보내면 새 버전이 생성됩니다.",
      revisionReadyTitle: "편집하고 다시 보낼 준비가 되었습니다.",
      revisionReadyDescription: "해당 메시지 이전으로 되감기합니다. 준비가 되면 편집하고 보내세요",
      revisionUnavailableTitle: "이 메시지는 아직 편집할 수 없습니다.",
      revisionAttachmentsUnsupported: "편집 및 재전송은 아직 기록 첨부 파일을 지원하지 않습니다. 대신 텍스트를 새 메시지에 복사하세요.",
      revisionTransformedTextUnsupported: "편집 및 재전송은 아직 명시적인 기술로 전송된 메시지를 지원하지 않습니다. 대신 텍스트를 복사하고 스킬을 다시 선택하세요.",
      revisionDraftAttachmentConflict: "작성자에게 이미 보류 중인 첨부 파일이 있습니다. 보낸 메시지를 편집하기 전에 보내거나 제거하세요.",
      revisionCommandUnsupported: "보낸 메시지를 편집하는 동안에는 /compact, /side 또는 Orchestration 명령을 실행할 수 없습니다. 먼저 편집을 취소하세요.",
      revisionAlreadyActive: "다른 메시지가 이미 편집 중입니다. 먼저 해당 수정사항을 보내거나 취소하세요.",
      revisionCancelLabel: "취소",
      revisionBannerTitle: "보낸 메시지 편집 중",
      revisionBannerDetail: "· 전송 시 새 버전",
      revisionUnchanged: "아무것도 바뀌지 않았습니다. 새로운 답변만 원할 경우 재생성을 사용하세요.",
      operationFailedTitle: "작업 실패",
      operationFailedFallback: "작업 작업이 실패했습니다. 나중에 다시 시도하세요.",
      attachmentFailedTitle: "첨부파일을 추가하지 못했습니다.",
      imageAttachmentNotDirectTitle: "첨부파일로 추가된 이미지",
      imageAttachmentNotDirectDescription: "현재 모델은 이미지를 직접 수신하지 않습니다. 이미지는 첨부파일로 제공되었습니다.",
      tryAgain: "나중에 다시 시도하세요.",
      modelReboundTitle: "사용 가능한 모델로 전환됨",
      modelReboundDescription: modelId => `이전 연결을 사용할 수 없습니다${modelId ? `· ${modelId}` : ''}`,
      messageReadFailedTitle: "작업을 로드하지 못했습니다.",
      partialHistoryTitle: "이전 메시지 보기",
      returnLatest: "최신으로 돌아가기",
      scrollMainToBottom: "기본 대화를 맨 아래로 스크롤"
    },
    attachments: {
      tooMany: "최대 8개의 파일을 첨부할 수 있습니다.",
      tooLarge: "첨부파일은 50MB 이하여야 합니다.",
      duplicate: "이 첨부파일은 이미 추가되었습니다."
    },
    model: {
      fakeBackendLabel: "로컬 시뮬레이션",
      setupTitle: "실제 모델 구성",
      connectionMissingTitle: "연결이 삭제되었습니다.",
      configurationFallback: "이 모델 연결은 지금은 보낼 수 없습니다. 설정·모델에서 확인하고 다시 시도해 보세요.",
      configurationReason: {
        missing_default_connection: "보내기 전에 설정 · 모델에서 기본 모델을 설정하세요.",
        connection_missing: "이 작업에서 사용된 모델 연결이 삭제되었습니다. 설정 · 모델에서 선택하거나 생성하세요.",
        connection_disabled: "현재 모델 연결이 비활성화되었습니다. 활성화하거나 설정 · 모델에서 다른 기본값을 선택하십시오.",
        missing_api_key: "현재 모델 연결에는 사용 가능한 자격 증명이 없습니다. API 키를 추가하거나 설정 · 모델에서 다시 로그인하세요.",
        missing_model: "현재 연결에는 사용 가능한 모델이 없습니다. 설정 · 모델에서 기본 모델을 선택하세요.",
        empty_model_list: "현재 연결에는 활성화된 모델이 없습니다. 설정 · 모델에서 추가하거나 활성화하세요.",
        model_not_enabled: "이 작업을 위해 선택한 모델이 비활성화되었습니다. 설정 · 모델에서 활성화된 모델을 선택하세요.",
        model_not_chat_capable: "이 작업을 위해 선택한 모델은 채팅을 할 수 없습니다. 설정 · 모델에서 채팅 가능 모델을 선택하세요.",
        fake_backend: "이 작업에서는 폐기된 로컬 시뮬레이션을 사용했습니다. 설정·모델에서 실제 모델을 추가한 후 새 작업을 시작하세요.",
        provider_retired: "이 작업의 연결에 사용되는 로그인이 Maka에서 제거되었으므로 전송할 수 없습니다. 설정 · 모델에서 다른 연결로 전환한 다음 새 작업을 시작하세요."
      }
    },
    footer: {
      labels: {
        regenerate: "재생성",
        branch: "나뭇가지",
        copy: "복사",
        info: "세부"
      },
      pending: "일하고 있는…",
      regenerateRunning: "재생성하기 전에 현재 응답이 완료될 때까지 기다립니다.",
      regenerateAgain: "재생성된 응답이 이미 존재합니다. 또 다른 병렬 응답을 생성하려면 다시 클릭하세요.",
      regenerate: "이번 턴에 또 다른 응답을 생성합니다.",
      requestRegenerate: "소유자에게 이 응답 재생성을 승인해 달라고 요청합니다.",
      branchRunning: "분기하기 전에 현재 응답이 완료될 때까지 기다립니다.",
      branchAborted: "중단 전 컨텍스트에서 분기",
      branch: "이 응답에서 새 작업을 분기합니다.",
      copy: "응답을 클립보드에 복사",
      copyEmpty: "이 응답에는 복사할 콘텐츠가 없습니다."
    },
    lineage: {
      regeneratedFrom: "이전 응답에서 재생성됨",
      regeneratedFromTooltip: "이는 병렬로 재생성된 응답입니다. 보관된 이전 응답을 보려면 클릭하세요.",
      regeneratedTo: "재생성 → 새로운 응답",
      regeneratedToTooltip: "재생성된 응답으로 이동"
    },
    workbar: {
      ariaLabel: "작업 작업 표시줄",
      sectionsAriaLabel: "작업 작업 표시줄 탭",
      review: "변경 사항",
      terminal: "단말기",
      terminalNumbered: index => `터미널 ${index}`,
      tasks: "할 일",
      todoLoadFailed: "할 일 목록을 로드하지 못했습니다. 다시 시도해 보세요.",
      workBoard: "작업판",
      browser: "브라우저",
      files: "생성된 파일",
      inspector: "추적하다",
      sideChat: "사이드 채팅",
      sideChatNumbered: index => `사이드 채팅 ${index}`,
      openTab: "작업 표시줄 탭 열기",
      openTools: "도구 열기",
      closeTab: label => `${label} 닫기`,
      tabMenu: label => `${label} 탭 메뉴`,
      moveLeft: "왼쪽으로 이동",
      moveRight: "오른쪽으로 이동",
      moveToRight: "오른쪽 패널로 이동",
      moveToBottom: "하단 패널로 이동",
      pinTab: "핀 탭",
      pinTabHint: "미리보기 탭. 콘텐츠를 두 번 클릭하거나 상호작용하여 고정하세요.",
      close: "닫다",
      closeOthers: "다른 탭 닫기",
      closeToRight: "오른쪽 탭 닫기",
      launcher: {
        review: "현재 Git 작업공간의 변경사항 보기",
        terminal: "이 작업에 대한 터미널 실행 및 실시간 출력을 검사합니다.",
        tasks: "이 작업의 할 일 원장을 보고 유지합니다.",
        workBoard: "지연된 작업 캡처 및 관리",
        browser: "내장된 브라우저를 열고 현재 페이지를 유지합니다.",
        files: "이 작업으로 생성된 파일 찾아보기",
        inspector: "모델 호출, 도구, 타이밍 검사",
        sideChat: "주요 작업을 중단하지 않고 읽기 전용으로 질문하고 탐색하세요."
      }
    },
    workBoardPanel: {
      inbox: "받은편지함",
      project: "현재 프로젝트",
      noProject: "선택한 프로젝트가 없습니다.",
      createPlaceholder: "나중을 위해 무언가를 캡처하세요...",
      create: "추가하다",
      empty: "연기된 작업 없음",
      loading: "작업 보드 로드 중…",
      loadMore: "더 로드하기",
      retry: "다시 해 보다",
      loadFailed: "작업 보드를 로드하지 못했습니다.",
      actionFailed: "작업 실패",
      complete: "완벽한",
      reopen: "다시 열다",
      rename: "이름 바꾸기",
      renameSave: "구하다",
      moveToInbox: "받은편지함으로 이동",
      moveToProject: "프로젝트로 이동",
      archive: "보관소",
      unarchive: "복원하다",
      delete: "삭제",
      archived: "보관됨"
    },
    reviewPanel: {
      ariaLabel: "힘내 변경",
      empty: "현재 Git 작업공간에는 변경사항이 없습니다.",
      emptyHelp: "커밋되고, 준비되고, 수정된 파일이 여기에 표시됩니다.",
      notGitRepository: "이 작업 디렉터리는 Git 저장소가 아닙니다.",
      workspaceUnavailable: "이 작업 디렉터리를 사용할 수 없습니다.",
      unbornRepository: "이 Git 저장소에는 아직 비교할 커밋이 없습니다.",
      gitFailed: "Git 작업공간 변경사항을 읽을 수 없습니다.",
      invalidBaseBranch: "선택한 비교 분기를 사용할 수 없습니다.",
      truncated: "변경사항이 너무 많습니다. 첫 번째 파일만 표시",
      showMore: remaining => `${Math.min(20, remaining)}개의 파일 더 표시`,
      hiddenLines: count => `${count}개의 추가 줄이 표시되지 않음`,
      changedFiles: count => `${count}개의 파일이 변경됨`,
      addedLines: count => `${count}줄 추가됨`,
      deletedLines: count => `${count}줄 삭제됨`,
      added: count => `${count} 추가됨`,
      deleted: count => `${count} 삭제됨`,
      loadFailed: "Git 변경 사항을 읽을 수 없습니다.",
      retry: "다시 해 보다"
    },
    terminalPanel: {
      ariaLabel: "태스크 터미널",
      empty: "이 작업에서는 아직 실행되는 터미널이 없습니다.",
      emptyHelp: "이 작업의 터미널은 시작되면 여기에 표시됩니다.",
      loadFailed: "터미널 실행을 읽을 수 없습니다.",
      retry: "다시 해 보다",
      refresh: "터미널 새로 고침",
      readOnly: "이 작업에서 에이전트 또는 사용자가 시작한 터미널 실행을 표시합니다.",
      runCount: count => `${count}개의 터미널 실행`,
      newTerminal: "새로운 터미널",
      commandPlaceholder: "명령을 입력하고 Enter를 누르세요",
      commandLabel: "터미널 명령",
      runCommand: "명령 실행",
      stopTerminal: "현재 터미널 중지",
      startFailed: "터미널을 시작할 수 없습니다",
      writeFailed: "터미널 입력을 보낼 수 없습니다.",
      stopFailed: "터미널을 중지할 수 없습니다."
    },
    inspector: {
      ariaLabel: "태스크 추적",
      copyPricingKey: "가격 키 복사",
      pricingKeyCopied: "가격 키가 복사되었습니다.",
      unpricedPricingKey: "가격이 책정되지 않은 가격 책정 키",
      copyFailed: "복사 실패",
      copyFailedDetail: "클립보드를 사용할 수 없거나 시스템에서 액세스를 거부했습니다.",
      loadFailed: "추적을 읽을 수 없습니다.",
      retry: "다시 해 보다",
      empty: "이 작업에서는 아직 추적할 항목이 없습니다.",
      emptyHelp: "이 작업에 대해 아직 기록된 활동이 없습니다.",
      costUnavailable: "비용을 알 수 없음",
      costEstimateHelp: "기록된 사용량 및 가격을 바탕으로 추정됩니다. 누락되거나 가격이 책정되지 않은 통화는 제외될 수 있습니다.",
      loadEarlier: "이전 레코드 로드",
      hideEarlier: "이전 기록 모두 숨기기",
      loadingEarlier: "로드 중…",
      loadingTrace: "타임라인 로드 중…",
      loadingSummary: "전체 세션 사용량 추정 중…",
      summaryUnavailable: "전체 세션을 일시적으로 사용할 수 없습니다.",
      totals: {
        cost: "예상 비용"
      },
      tokenUsage: {
        title: "토큰 사용량",
        segment: {
          cacheRead: "캐시된 입력",
          cacheMiss: "캐시되지 않은 입력",
          output: "출력(추론 포함)"
        }
      },
      durationUsage: {
        title: "시간 분석",
        center: "기록된 시간",
        segment: {
          model: count => `LLM 호출 × ${count}`,
          tool: count => `도구 실행 × ${count}`
        }
      },
      coveragePartial: parts => `일부 호출을 완전히 표시할 수 없어 아래 숫자는 ${koDetail(parts)}보다 적게 집계됩니다.`,
      coverageAbsent: parts => `이 백엔드는 호출별 세부 정보를 기록하지 않습니다${koDetail(parts)}`,
      unreadable: count => `${count}개 레코드를 읽을 수 없습니다.`,
      oversizedRuns: count => `${count}개 실행 기록이 너무 커서 온라인으로 표시할 수 없습니다.`,
      turnsMissing: count => `호출 기록이 없는 턴 ${count}개`,
      turnsShort: count => `호출 기록이 불완전한 턴 ${count}개`,
      stepKind: {
        permission: "허가",
        compaction: "컨텍스트 압축",
        error: "오류"
      },
      callKind: kind => KO_CALL_KIND[kind as keyof CallKindCopy] ?? kind,
      permissionDecision: decision => KO_PERMISSION_DECISION[decision] ?? decision,
      recoveredAs: disposition => `${disposition}로 복구됨`,
      retries: count => `${count}회 재시도`,
      turnFailure: code => KO_TURN_FAILURE[code] ?? '턴 실패',
      turnLabel: startedAt => `턴 · ${startedAt}`,
      overview: {
        context: "컨텍스트 창",
        segment: {
          cacheRead: "캐시 적중",
          fresh: "캐시 미스",
          used: "사용된",
          free: "남은"
        },
        cacheHit: "캐시 적중률",
        timelineTab: "타임라인",
        composition: {
          title: "예상 구성",
          basis: "공급자가 보고한 토큰이 아닌 요청 바이트에서 추정됩니다.",
          part: {
            system_instructions: "시스템 지침",
            tool_definitions: "도구 정의",
            messages: "메시지",
            other: "기타 옵션"
          },
          tools: "도구별",
          remainingTools: count => `${count}개의 추가 도구`,
          unlabelled: "이름이 없는 도구",
          unrecorded: "이 통화에는 기록이 남지 않았습니다."
        }
      }
    },
    quoteCompanion: {
      namePrefix: "옆:",
      permissionStreaming: "사이드 채팅이 실행되는 동안에는 권한을 변경할 수 없습니다.",
      scrollToBottom: "사이드 대화를 맨 아래로 스크롤",
      compactSuccessTitle: "컨텍스트가 압축되었습니다",
      compactSuccessDescription: "이전 컨텍스트가 체크포인트 요약으로 대체되었습니다.",
      compactStartedTitle: "컨텍스트 압축 중",
      compactStartedDescription: "이전 컨텍스트를 체크포인트로 요약하는 중입니다.",
      compactUnchangedTitle: "압축할 내용이 없습니다",
      compactUnchangedDescription: "이 작업은 이미 최신 체크포인트를 사용하고 있습니다.",
      compactErrorTitle: "압축하지 못했습니다",
      compactErrorFallback: "작업의 컨텍스트를 압축하지 못했습니다. 나중에 다시 시도하세요.",
      workspaceUnavailableTitle: "작업 디렉터리를 사용할 수 없습니다",
      workspaceUnavailableDescription: "작업 디렉터리가 없거나 접근할 수 없습니다. 새 작업에 사용할 폴더를 선택하세요.",
      closeConfirmation: {
        title: count => count > 1 ? `${count} 사이드 채팅을 종료하시겠습니까?` : "사이드 채팅을 닫으시겠어요?",
        description: count => count > 1 ? `이러한 ${count} 임시 사이드 채팅은 영구적으로 삭제되며 복구할 수 없습니다.` : "이 임시 사이드 채팅은 영구적으로 삭제되며 복구할 수 없습니다.",
        dontAskAgain: "다시 묻지 마세요",
        cancel: "취소",
        confirm: "사이드 채팅 닫기"
      },
      errors: {
        forkSetupFailed: "사이드 채팅을 열 수 없습니다. 다시 시도해 주세요.",
        forkSourceBusy: "기본 대화 또는 연결된 작업이 아직 실행 중입니다. 완료되면 다시 시도하세요.",
        forkUnsupported: "이 대화 컨텍스트는 아직 사이드 채팅으로 열 수 없습니다.",
        sendRejected: "동반자를 시작할 수 없습니다. 다시 시도해 주세요.",
        sendFailed: "컴패니언 요청이 실패했습니다. 다시 시도해 주세요.",
        settlementFailed: "실행이 종료되었지만 해당 메시지를 로드할 수 없습니다. 사이드 채팅을 다시 시도하거나 다시 열어보세요.",
        respondFailed: "응답이 실패했습니다. 다시 시도해 주세요."
      }
    },
    health: {
      blocked: {
        fake_backend: {
          label: "오래된 작업 · 실제 모델 구성",
          tooltip: () => "이 작업에서는 폐기된 로컬 시뮬레이션을 사용했습니다. 보내기 전에 설정 · 모델에서 실제 모델을 추가하고 활성화하세요."
        },
        provider_retired: {
          label: "로그인이 중단됨",
          tooltip: name => `"${name}" 연결이 사용하는 로그인이 Maka에서 제거되었으므로 전송에 실패합니다. 설정 · 모델에서 다른 연결로 전환하십시오.`
        },
        missing_default_connection: {
          label: "구성된 모델이 없습니다.",
          tooltip: () => "이 작업에는 사용 가능한 모델 연결이 없습니다. 설정 · 모델에서 하나를 추가하고 활성화하세요."
        },
        legacy_connection_identity: {
          label: "모델 연결 선택",
          tooltip: () => "이 작업은 이전 버전에서 가져온 것입니다. 사용할 연결과 모델을 선택하세요.",
          actionLabel: "연결 및 모델 선택",
          settingsTooltip: () => "현재 사용 가능한 연결이 없습니다. 먼저 설정 · 모델에서 하나를 추가하거나 활성화하세요."
        },
        connection_missing: {
          label: "원래 연결이 삭제되었습니다.",
          tooltip: () => "계속하려면 새 연결과 모델을 선택하세요.",
          actionLabel: "연결 및 모델 선택",
          settingsTooltip: () => "현재 사용 가능한 연결이 없습니다. 먼저 설정 · 모델에서 하나를 추가하거나 활성화하세요."
        },
        connection_identity_mismatch: {
          label: "연결 ID 불일치",
          tooltip: () => "다시 사용할 연결과 모델을 선택하세요.",
          actionLabel: "연결 및 모델 선택",
          settingsTooltip: () => "현재 사용 가능한 연결이 없습니다. 먼저 설정 · 모델에서 하나를 추가하거나 활성화하세요."
        },
        connection_disabled: {
          label: "연결이 비활성화되었습니다.",
          tooltip: name => `연결 "${name}"이 비활성화되었습니다. 활성화하거나 설정 · 모델에서 다른 연결을 선택하십시오.`
        },
        missing_api_key: {
          label: "연결 자격 증명이 누락되었습니다.",
          tooltip: name => `연결 "${name}"에 API 키가 없거나 로그인이 완료되었습니다. 설정 · 모델에서 자격 증명을 추가합니다.`
        },
        missing_model: {
          label: "선택한 모델이 없습니다.",
          tooltip: name => `연결 "${name}"에는 기본 모델이 없습니다. 설정 · 모델에서 하나를 선택하세요.`
        },
        empty_model_list: {
          label: "활성화된 모델이 없습니다.",
          tooltip: name => `연결 "${name}"에는 활성화된 모델이 없습니다. 설정 · 모델에서 하나를 추가하세요.`
        },
        model_not_enabled: {
          label: "작업 모델이 비활성화되었습니다.",
          tooltip: (name, model) => `모델 "${model}"은 "${name}" 연결에 대해 활성화되지 않습니다. 설정 · 모델에서 다른 모델을 선택하십시오.`
        },
        model_not_chat_capable: {
          label: "작업 모델은 채팅할 수 없습니다.",
          tooltip: (_name, model) => `모델 "${model}"은(는) 채팅에 사용할 수 없습니다. 설정 · 모델에서 채팅 가능 모델을 선택하세요.`
        }
      },
      connectionChoicesLoading: {
        tooltip: "연결 목록이 아직 로드되지 않았습니다.",
        actionLabel: "연결 다시 로드"
      },
      reauth: {
        label: "마지막 연결 테스트 실패 인증",
        tooltip: "최신 테스트에서는 401/403이 반환되었습니다. 전송이 차단되지는 않지만 실패할 경우 설정 · 모델에서 다시 로그인하세요."
      },
      testError: {
        label: "마지막 연결 테스트 실패",
        tooltip: "네트워크, 시간 초과 또는 5xx 오류로 인해 최근 테스트가 실패했습니다. 전송이 차단되지 않습니다. 지속되는 경우 기본 URL 또는 프록시 설정을 확인하세요."
      }
    },
    turnError: {
      unknown: "문제가 발생했습니다. 원인을 알 수 없습니다. 다시 시도하려면 메시지를 보내세요.",
      contextOverflow: "컨텍스트가 모델 창을 초과했습니다. 첨부 파일을 줄이거나 새 작업을 시작하세요.",
      timeout: "모델 요청 시간이 초과되었습니다. 다시 시도하려면 메시지를 보내세요.",
      auth: "모델 인증에 실패했습니다. 설정에서 다시 연결하거나 로그인하세요.",
      providerBilling: "모델 과금이 제한됩니다. 계정 잔액이나 구독을 확인하세요.",
      providerCapacity: "모델 서비스가 일시적으로 중단되었습니다. 몇 분 정도 기다리거나 모델을 전환하십시오.",
      rateLimit: "요청 속도가 제한되었습니다. 잠시 기다린 후 메시지를 보내 다시 시도하세요.",
      network: "네트워크 연결에 실패했습니다. 네트워크를 확인한 후 메시지를 다시 보내세요.",
      provider: "모델 서비스에서 오류를 반환했습니다. 나중에 다시 시도하거나 모델을 전환하세요.",
      stepCap: "도구 단계 제한에 도달했으므로 작업이 완료되지 않았을 수 있습니다. 계속하려면 메시지를 보내세요.",
      tool: "도구 호출이 실패했습니다. 재시도 여부를 결정하기 전에 위의 도구 결과를 확인하세요.",
      permission: "이번 턴은 허가를 기다리는 동안 종료되었습니다. 메시지를 보내면 다시 물어볼 것입니다.",
      restarted: "이전 차례가 완료되기 전에 앱이 다시 시작되었습니다.",
      sandboxBoundaryClosed: "앱이 다시 시작되었으므로 작업 영역 외부에 도달하기 위해 보류 중인 요청이 거부되어 종료되었습니다. 다시 결정하려면 메시지를 보내세요.",
      executionState: {
        erroredTool: "이번 턴에 도구에 오류가 발생했습니다. 다른 메시지를 보낼지 여부를 결정하기 전에 결과를 읽어보세요.",
        toolRan: "이번 차례에 도구가 이미 실행되었으며 실질적인 변경이 이루어졌을 수도 있습니다. 다른 메시지를 보내기 전에 결과를 읽어보세요.",
        partialOutput: "이번 차례에서는 답변의 일부가 나왔습니다. 다른 메시지를 보내기 전에 읽어볼 가치가 있습니다."
      }
    }
  },
  actions: {
    ...{
      stopFailedTitle: "중지하지 못했습니다.",
      stopFailedFallback: "작업 작업이 실패했습니다. 나중에 다시 시도하세요.",
      refreshSessionsFailedTitle: "작업을 새로 고치지 못했습니다.",
      refreshSessionsFailedFallback: "작업 목록을 새로 고칠 수 없습니다. 나중에 다시 시도하세요.",
      conversationErrorTitle: "작업 오류",
      conversationErrorFallback: "작업 실행이 실패했습니다. 나중에 다시 시도하세요.",
      regenerateStartedTitle: "재생이 시작되었습니다",
      regenerateStartedDescription: "새로운 응답 생성",
      branchCreatedTitle: "지점이 생성되었습니다.",
      branchCreatedDescription: name => `새 작업: ${name}`,
      revisionStartedTitle: "초안 수정 준비됨",
      revisionStartedDescription: "원래 작업은 유지됩니다. 보내면 새 버전이 생성됩니다.",
      revisionReadyTitle: "편집하고 다시 보낼 준비가 되었습니다.",
      revisionReadyDescription: "해당 메시지 이전으로 되감기합니다. 준비가 되면 편집하고 보내세요",
      revisionUnavailableTitle: "이 메시지는 아직 편집할 수 없습니다.",
      revisionAttachmentsUnsupported: "편집 및 재전송은 아직 기록 첨부 파일을 지원하지 않습니다. 대신 텍스트를 새 메시지에 복사하세요.",
      revisionTransformedTextUnsupported: "편집 및 재전송은 아직 명시적인 기술로 전송된 메시지를 지원하지 않습니다. 대신 텍스트를 복사하고 스킬을 다시 선택하세요.",
      revisionDraftAttachmentConflict: "작성자에게 이미 보류 중인 첨부 파일이 있습니다. 보낸 메시지를 편집하기 전에 보내거나 제거하세요.",
      revisionCommandUnsupported: "보낸 메시지를 편집하는 동안에는 /compact, /side 또는 Orchestration 명령을 실행할 수 없습니다. 먼저 편집을 취소하세요.",
      revisionAlreadyActive: "다른 메시지가 이미 편집 중입니다. 먼저 해당 수정사항을 보내거나 취소하세요.",
      revisionCancelLabel: "취소",
      revisionBannerTitle: "보낸 메시지 편집 중",
      revisionBannerDetail: "· 전송 시 새 버전",
      revisionUnchanged: "아무것도 바뀌지 않았습니다. 새로운 답변만 원할 경우 재생성을 사용하세요.",
      operationFailedTitle: "작업 실패",
      operationFailedFallback: "작업 작업이 실패했습니다. 나중에 다시 시도하세요.",
      attachmentFailedTitle: "첨부파일을 추가하지 못했습니다.",
      imageAttachmentNotDirectTitle: "첨부파일로 추가된 이미지",
      imageAttachmentNotDirectDescription: "현재 모델은 이미지를 직접 수신하지 않습니다. 이미지는 첨부파일로 제공되었습니다.",
      tryAgain: "나중에 다시 시도하세요.",
      modelReboundTitle: "사용 가능한 모델로 전환됨",
      modelReboundDescription: modelId => `이전 연결을 사용할 수 없습니다${modelId ? `· ${modelId}` : ''}`,
      messageReadFailedTitle: "작업을 로드하지 못했습니다.",
      partialHistoryTitle: "이전 메시지 보기",
      returnLatest: "최신으로 돌아가기",
      scrollMainToBottom: "기본 대화를 맨 아래로 스크롤"
    },
    conversationErrorTitle: '대화 오류',
    conversationErrorFallback: '작업 실행에 실패했습니다. 나중에 다시 시도하세요.',
    regenerateStartedTitle: '재생성 시작됨',
    regenerateStartedDescription: '새 응답을 생성하는 중입니다',
    branchCreatedTitle: '분기 생성됨',
    branchCreatedDescription: name => '새 작업: ' + name,
    returnLatest: '최신 항목으로 돌아가기',
    scrollMainToBottom: '주 대화를 아래로 스크롤'
  },
  footer: {
    ...{
      labels: {
        regenerate: "재생성",
        branch: "나뭇가지",
        copy: "복사",
        info: "세부"
      },
      pending: "일하고 있는…",
      regenerateRunning: "재생성하기 전에 현재 응답이 완료될 때까지 기다립니다.",
      regenerateAgain: "재생성된 응답이 이미 존재합니다. 또 다른 병렬 응답을 생성하려면 다시 클릭하세요.",
      regenerate: "이번 턴에 또 다른 응답을 생성합니다.",
      branchRunning: "분기하기 전에 현재 응답이 완료될 때까지 기다립니다.",
      branchAborted: "중단 전 컨텍스트에서 분기",
      branch: "이 응답에서 새 작업을 분기합니다.",
      copy: "응답을 클립보드에 복사",
      copyEmpty: "이 응답에는 복사할 콘텐츠가 없습니다."
    },
    labels: {
      regenerate: '재생성',
      branch: '분기',
      copy: '복사',
      info: '세부 정보'
    },
    pending: '작업 중…',
    requestRegenerate: '소유자에게 이 응답 재생성을 승인해 달라고 요청합니다.'
  },
  workbar: {
    ...{
      ariaLabel: "작업 작업 표시줄",
      sectionsAriaLabel: "작업 작업 표시줄 탭",
      review: "변경 사항",
      terminal: "단말기",
      terminalNumbered: index => `터미널 ${index}`,
      tasks: "할 일",
      todoLoadFailed: "할 일 목록을 로드하지 못했습니다. 다시 시도해 보세요.",
      workBoard: "작업판",
      browser: "브라우저",
      files: "생성된 파일",
      inspector: "추적하다",
      sideChat: "사이드 채팅",
      sideChatNumbered: index => `사이드 채팅 ${index}`,
      openTab: "작업 표시줄 탭 열기",
      openTools: "도구 열기",
      closeTab: label => `${label} 닫기`,
      tabMenu: label => `${label} 탭 메뉴`,
      moveLeft: "왼쪽으로 이동",
      moveRight: "오른쪽으로 이동",
      moveToRight: "오른쪽 패널로 이동",
      moveToBottom: "하단 패널로 이동",
      pinTab: "핀 탭",
      pinTabHint: "미리보기 탭. 콘텐츠를 두 번 클릭하거나 상호작용하여 고정하세요.",
      close: "닫다",
      closeOthers: "다른 탭 닫기",
      closeToRight: "오른쪽 탭 닫기",
      launcher: {
        review: "현재 Git 작업공간의 변경사항 보기",
        terminal: "이 작업에 대한 터미널 실행 및 실시간 출력을 검사합니다.",
        tasks: "이 작업의 할 일 원장을 보고 유지합니다.",
        workBoard: "지연된 작업 캡처 및 관리",
        browser: "내장된 브라우저를 열고 현재 페이지를 유지합니다.",
        files: "이 작업으로 생성된 파일 찾아보기",
        inspector: "모델 호출, 도구, 타이밍 검사",
        sideChat: "주요 작업을 중단하지 않고 읽기 전용으로 질문하고 탐색하세요."
      }
    },
    ariaLabel: '작업 워크바',
    review: '변경 사항',
    terminal: '터미널',
    tasks: '할 일',
    browser: '브라우저',
    files: '생성된 파일',
    inspector: '추적',
    sideChat: '사이드 채팅'
  }
}
} satisfies UiCatalog<DesktopConversationCopy>;

export function getDesktopConversationCopy(locale: UiLocale): DesktopConversationCopy {
  return COPY[locale];
}

export type InspectorCopy = DesktopConversationCopy['inspector'];

/**
 * The name a step falls back to when it has no identifier of its own. A model
 * call and a tool call always carry one, so they never reach here.
 *
 * It lives beside the words rather than in the panel so fallback labels stay
 * part of the locale's vocabulary instead of being reconstructed by the view.
 */
export function inspectorStepKindLabel(copy: InspectorCopy, kind: string): string {
  if (kind === 'permission') return copy.stepKind.permission;
  if (kind === 'compaction') return copy.stepKind.compaction;
  if (kind === 'error') return copy.stepKind.error;
  return kind;
}
