import type { TaskStatus, UiCatalog, UiLocale } from '@maka/core';

export interface SharedUiCopy {
  capabilityAudit: {
    ariaLabel: string;
    needsAuthorization: (count: number) => string;
    sourceErrors: (count: number) => string;
    failedAutomations: (count: number) => string;
    skippedAutomations: (count: number) => string;
  };
  markdown: {
    invalidInternalLink: string;
    unsafeLink: string;
    copyCode: string;
    copyingCode: string;
    copiedCode: string;
    copyCodeFailed: string;
  };
  modelPicker: {
    empty: string;
    searchPlaceholder: string;
    searchAriaLabel: string;
  };
  moduleHubs: {
    extensions: {
      title: string;
      description: string;
      selectorLabel: (module: string) => string;
      skills: string;
      mcp: string;
    };
    automations: {
      title: string;
      description: string;
      selectorLabel: (module: string) => string;
      planReminders: string;
      dailyReview: string;
    };
  };
  modules: {
    skills: string;
    loadingSkills: string;
    automations: string;
    loadingAutomations: string;
    dailyReview: string;
    loadingDailyReview: string;
    dailyReviewDescription: string;
    dailyReviewDisconnectedTitle: string;
    dailyReviewDisconnectedBody: string;
  };
  primitives: {
    loading: string;
    close: string;
  };
  taskLedger: {
    status: Record<TaskStatus, string>;
    ariaLabel: string;
    retry: string;
    loading: string;
    activeAriaLabel: string;
    empty: string;
    recent: string;
    recentAriaLabel: string;
    childAgent: (agentId?: string) => string;
    mainAgent: string;
  };
  toast: {
    notifications: string;
    closeNotification: string;
    confirm: string;
    cancel: string;
  };
  stream: {
    assistantChunkTruncated: string;
    assistantTailTruncated: string;
    thinkingHeadTruncated: string;
    thinkingChunkTruncated: string;
    toolChunkTruncated: string;
  };
  artifact: { unknownSize: string };
  providers: { minimaxChina: string; custom: string; claudeSubscription: string };
}

const SHARED_UI_COPY = {
  zh: {
    capabilityAudit: {
      ariaLabel: '能力风险提示',
      needsAuthorization: (count) => `${count} 个来源等待授权`,
      sourceErrors: (count) => `${count} 个来源异常`,
      failedAutomations: (count) => `${count} 个自动化上次失败`,
      skippedAutomations: (count) => `${count} 个自动化上次跳过`,
    },
    markdown: {
      invalidInternalLink: '内部链接无效',
      unsafeLink: '链接不安全',
      copyCode: '复制代码',
      copyingCode: '复制代码中',
      copiedCode: '已复制代码',
      copyCodeFailed: '复制代码失败',
    },
    modelPicker: {
      empty: '没有匹配的模型',
      searchPlaceholder: '搜索模型…',
      searchAriaLabel: '搜索模型',
    },
    moduleHubs: {
      extensions: {
        title: '扩展',
        description: '管理 Maka 可调用的技能与外部工具。',
        selectorLabel: (module) => `扩展内容：${module}`,
        skills: '技能',
        mcp: 'MCP',
      },
      automations: {
        title: '定时任务',
        description: '安排计划提醒，并回顾本机对话中的工作进展。',
        selectorLabel: (module) => `定时任务内容：${module}`,
        planReminders: '计划提醒',
        dailyReview: '每日回顾',
      },
    },
    modules: {
      skills: '技能',
      loadingSkills: '正在加载技能…',
      automations: '定时任务',
      loadingAutomations: '正在加载定时任务…',
      dailyReview: '每日回顾',
      loadingDailyReview: '正在加载每日回顾…',
      dailyReviewDescription: '自动汇总本机对话，生成摘要、遗漏提醒与深度分析；可在设置中开启定时执行。',
      dailyReviewDisconnectedTitle: '等待连接每日回顾数据',
      dailyReviewDisconnectedBody: '桌面端数据桥当前未连接。',
    },
    primitives: { loading: '加载中', close: '关闭' },
    taskLedger: {
      status: { pending: '待处理', in_progress: '进行中', blocked: '已阻塞', completed: '已完成', failed: '失败', cancelled: '已取消' },
      ariaLabel: '会话任务',
      retry: '重新载入任务',
      loading: '正在载入任务…',
      activeAriaLabel: '活跃会话任务',
      empty: '当前会话没有待推进任务',
      recent: '最近结束',
      recentAriaLabel: '最近结束的会话任务',
      childAgent: (agentId) => `子代理${agentId ? ` ${agentId}` : ''}`,
      mainAgent: '主代理',
    },
    toast: { notifications: '通知', closeNotification: '关闭通知', confirm: '确定', cancel: '取消' },
    stream: { assistantChunkTruncated: '\n[…单条 delta 已截断]\n', assistantTailTruncated: '\n\n[…后续已截断]', thinkingHeadTruncated: '[…已截断早期 reasoning]\n', thinkingChunkTruncated: '\n[…单条 delta 已截断]\n', toolChunkTruncated: '\n[…已截断]\n' },
    artifact: { unknownSize: '未知大小' },
    providers: { minimaxChina: 'MiniMax 中国站', custom: '自定义', claudeSubscription: 'Claude 订阅' },
  },
  en: {
    capabilityAudit: {
      ariaLabel: 'Capability risks',
      needsAuthorization: (count) => `${count} ${count === 1 ? 'source' : 'sources'} awaiting authorization`,
      sourceErrors: (count) => `${count} ${count === 1 ? 'source has' : 'sources have'} errors`,
      failedAutomations: (count) => `${count} ${count === 1 ? 'automation failed' : 'automations failed'} last run`,
      skippedAutomations: (count) => `${count} ${count === 1 ? 'automation was' : 'automations were'} skipped last run`,
    },
    markdown: {
      invalidInternalLink: 'Invalid internal link',
      unsafeLink: 'Unsafe link',
      copyCode: 'Copy code',
      copyingCode: 'Copying code',
      copiedCode: 'Code copied',
      copyCodeFailed: 'Failed to copy code',
    },
    modelPicker: {
      empty: 'No matching models',
      searchPlaceholder: 'Search models…',
      searchAriaLabel: 'Search models',
    },
    moduleHubs: {
      extensions: {
        title: 'Extensions',
        description: 'Manage the skills and external tools Maka can use.',
        selectorLabel: (module) => `Extension content: ${module}`,
        skills: 'Skills',
        mcp: 'MCP',
      },
      automations: {
        title: 'Scheduled tasks',
        description: 'Schedule reminders and review progress from local conversations.',
        selectorLabel: (module) => `Scheduled task content: ${module}`,
        planReminders: 'Plan reminders',
        dailyReview: 'Daily review',
      },
    },
    modules: {
      skills: 'Skills',
      loadingSkills: 'Loading skills…',
      automations: 'Scheduled tasks',
      loadingAutomations: 'Loading scheduled tasks…',
      dailyReview: 'Daily review',
      loadingDailyReview: 'Loading daily review…',
      dailyReviewDescription: 'Summarize local conversations into highlights, missed items, and deeper analysis. Scheduled runs can be enabled in Settings.',
      dailyReviewDisconnectedTitle: 'Waiting for daily review data',
      dailyReviewDisconnectedBody: 'The desktop data bridge is not connected.',
    },
    primitives: { loading: 'Loading', close: 'Close' },
    taskLedger: {
      status: { pending: 'Pending', in_progress: 'In progress', blocked: 'Blocked', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled' },
      ariaLabel: 'Conversation tasks',
      retry: 'Reload tasks',
      loading: 'Loading tasks…',
      activeAriaLabel: 'Active conversation tasks',
      empty: 'This conversation has no active tasks',
      recent: 'Recently finished',
      recentAriaLabel: 'Recently finished conversation tasks',
      childAgent: (agentId) => `Child agent${agentId ? ` ${agentId}` : ''}`,
      mainAgent: 'Main agent',
    },
    toast: { notifications: 'Notifications', closeNotification: 'Close notification', confirm: 'Confirm', cancel: 'Cancel' },
    stream: { assistantChunkTruncated: '\n[…single delta truncated]\n', assistantTailTruncated: '\n\n[…remaining output truncated]', thinkingHeadTruncated: '[…earlier reasoning truncated]\n', thinkingChunkTruncated: '\n[…single delta truncated]\n', toolChunkTruncated: '\n[…truncated]\n' },
    artifact: { unknownSize: 'Unknown size' },
    providers: { minimaxChina: 'MiniMax China', custom: 'Custom', claudeSubscription: 'Claude subscription' },
  },
} satisfies UiCatalog<SharedUiCopy>;

export function getSharedUiCopy(locale: UiLocale): SharedUiCopy {
  return SHARED_UI_COPY[locale];
}
