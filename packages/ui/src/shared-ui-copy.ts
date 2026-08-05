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
    taskList: string;
    table: string;
    checkbox: string;
    code: string;
    opensInNewTab: string;
    copyCode: string;
    copiedCode: string;
    mermaidDiagram: string;
    mermaidRendering: string;
    mermaidRenderFailed: string;
    mermaidTooLarge: string;
    mermaidDeferred: string;
    mermaidRender: string;
    mermaidViewSource: string;
    mermaidToolbar: string;
    mermaidViewport: string;
    mermaidZoomIn: string;
    mermaidZoomOut: string;
    mermaidResetView: string;
    mermaidExpandView: string;
    mermaidCollapseView: string;
    mermaidZoomLevel: (percent: number) => string;
  };
  formControls: {
    selectPlaceholder: string;
    clear: string;
    required: string;
    optional: string;
  };
  modelPicker: {
    searchPlaceholder: string;
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
    resizeHandle: string;
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
  /**
   * Copy that exists only to fill Astryx's own message catalog, which ships no
   * `zh`. Grouped by the component that renders it so a slice adopting a new
   * Astryx surface can see at a glance whether its strings are already covered.
   * `astryxMessageOverrides` is the only consumer — nothing here is rendered by
   * Maka's own components.
   */
  astryx: {
    appShell: { mobileNavigation: string };
    banner: { collapse: string; expand: string };
    breadcrumbs: { label: string };
    calendar: {
      dayInRange: string;
      dayRangeEnd: string;
      dayRangeStart: string;
      dayRangeStartAndEnd: string;
      daySelected: string;
      nextMonth: string;
      previousMonth: string;
      rangeCompleteAnnounce: string;
      rangeStartAnnounce: string;
    };
    chat: {
      composerPlaceholder: string;
      composerDrawerLabel: string;
      composerInputLabel: string;
      messageAriaLabel: string;
      pastedTextExpand: string;
      statusDelivered: string;
      statusFailed: string;
      statusRead: string;
      statusSending: string;
      statusSent: string;
      drawerCollapse: string;
      drawerExpand: string;
      newMessages: string;
      scrollToBottom: string;
      send: string;
      stop: string;
      toolCallsError: string;
      toolCallsGroupLabel: string;
      triggerSuggestions: string;
    };
    commandPalette: {
      emptyBootstrap: string;
      emptySearch: string;
      inputPlaceholder: string;
      label: string;
      noResultsFor: string;
      resultCount: string;
    };
    dateTime: {
      closeCalendar: string;
      openCalendar: string;
      dialogLabel: string;
      datePlaceholder: string;
      timePlaceholder: string;
      timeSuffix: string;
    };
    inputStatus: { error: string; success: string; warning: string };
    lightbox: { mediaViewer: string; previous: string; next: string };
    menus: { dropdown: string; more: string };
    multiSelector: { clearAll: string; selectAll: string };
    /** Selector and MultiSelector render the same two search affordances. */
    search: { options: string; placeholder: string };
    sideNav: {
      label: string;
      resizeSidebar: string;
      collapseSidebar: string;
      expandSidebar: string;
      itemCollapse: string;
      itemExpand: string;
    };
    tabList: { label: string };
    table: {
      label: string;
      noData: string;
      filterAll: string;
      filterApply: string;
      filterReset: string;
      filterByColumn: string;
    };
    thumbnail: { fallbackName: string; open: string; remove: string };
    token: { remove: string };
  };
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
      taskList: '任务列表',
      table: '表格',
      checkbox: '复选框',
      code: '代码',
      opensInNewTab: '（在新标签页中打开）',
      copyCode: '复制代码',
      copiedCode: '已复制代码',
      mermaidDiagram: 'Mermaid 图表',
      mermaidRendering: '正在渲染 Mermaid 图表…',
      mermaidRenderFailed: '无法渲染 Mermaid 图表，已显示源码。',
      mermaidTooLarge: 'Mermaid 图表源码过大，已显示源码。',
      mermaidDeferred: '为避免占用过多资源，此图表不会自动渲染。',
      mermaidRender: '渲染图表',
      mermaidViewSource: '查看 Mermaid 源码',
      mermaidToolbar: 'Mermaid 图表工具栏',
      mermaidViewport: 'Mermaid 图表视窗，可拖动平移，按加号或减号缩放',
      mermaidZoomIn: '放大图表',
      mermaidZoomOut: '缩小图表',
      mermaidResetView: '适应视窗',
      mermaidExpandView: '全屏查看图表',
      mermaidCollapseView: '退出全屏图表',
      mermaidZoomLevel: (percent) => `缩放比例 ${percent}%`,
    },
    formControls: {
      selectPlaceholder: '选择…',
      clear: '清除{label}',
      required: '必填',
      optional: '可选',
    },
    modelPicker: {
      searchPlaceholder: '搜索模型…',
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
    primitives: { loading: '加载中', close: '关闭', resizeHandle: '调整宽度' },
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
    astryx: {
      appShell: { mobileNavigation: '移动端导航' },
      banner: { collapse: '收起', expand: '展开' },
      breadcrumbs: { label: '面包屑导航' },
      calendar: {
        dayInRange: '{date}，在所选范围内',
        dayRangeEnd: '{date}，范围结束',
        dayRangeStart: '{date}，范围开始',
        dayRangeStartAndEnd: '{date}，范围开始与结束',
        daySelected: '{date}，已选择',
        nextMonth: '下个月',
        previousMonth: '上个月',
        rangeCompleteAnnounce: '已选择范围：{start} 至 {end}。',
        rangeStartAnnounce: '开始日期 {date}。请选择结束日期。',
      },
      chat: {
        composerPlaceholder: '输入消息…',
        composerDrawerLabel: '附加内容',
        composerInputLabel: '消息输入框',
        messageAriaLabel: '消息：{status}',
        pastedTextExpand: '展开',
        statusDelivered: '已送达',
        statusFailed: '发送失败',
        statusRead: '已读',
        statusSending: '发送中',
        statusSent: '已发送',
        drawerCollapse: '收起{label}',
        drawerExpand: '展开{label}',
        newMessages: '跳到最新消息',
        scrollToBottom: '滚动到底部',
        send: '发送',
        stop: '停止',
        toolCallsError: '错误：{message}',
        toolCallsGroupLabel: '{count} 次工具调用',
        triggerSuggestions: '建议',
      },
      commandPalette: {
        emptyBootstrap: '输入以搜索',
        emptySearch: '无结果',
        inputPlaceholder: '搜索…',
        label: '命令面板',
        noResultsFor: '没有与「{query}」匹配的结果',
        resultCount: '{count, number} 条结果',
      },
      dateTime: {
        closeCalendar: '关闭日历',
        openCalendar: '打开日历',
        dialogLabel: '选择日期',
        datePlaceholder: '选择日期',
        timePlaceholder: '选择时间',
        timeSuffix: '{label}时间',
      },
      inputStatus: { error: '错误详情', success: '成功详情', warning: '警告详情' },
      lightbox: { mediaViewer: '媒体查看器', previous: '上一张', next: '下一张' },
      menus: { dropdown: '菜单', more: '更多选项' },
      multiSelector: { clearAll: '清除全部{label}', selectAll: '全选' },
      search: { options: '搜索选项', placeholder: '搜索…' },
      sideNav: {
        label: '侧边导航',
        resizeSidebar: '调整侧边栏宽度',
        collapseSidebar: '收起侧边栏',
        expandSidebar: '展开侧边栏',
        itemCollapse: '收起{label}',
        itemExpand: '展开{label}',
      },
      tabList: { label: '标签页' },
      table: {
        label: '表格',
        noData: '暂无数据',
        filterAll: '全部',
        filterApply: '应用',
        filterReset: '重置',
        filterByColumn: '筛选{header}',
      },
      thumbnail: { fallbackName: '缩略图', open: '打开{accessibleName}', remove: '移除{accessibleName}' },
      token: { remove: '移除{label}' },
    },
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
      taskList: 'Task list',
      table: 'Table',
      checkbox: 'Checkbox',
      code: 'Code',
      opensInNewTab: '(opens in new tab)',
      copyCode: 'Copy code',
      copiedCode: 'Code copied',
      mermaidDiagram: 'Mermaid diagram',
      mermaidRendering: 'Rendering Mermaid diagram…',
      mermaidRenderFailed: 'Could not render the Mermaid diagram. Showing source.',
      mermaidTooLarge: 'Mermaid diagram source is too large. Showing source.',
      mermaidDeferred: 'This diagram was not rendered automatically to limit resource usage.',
      mermaidRender: 'Render diagram',
      mermaidViewSource: 'View Mermaid source',
      mermaidToolbar: 'Mermaid diagram toolbar',
      mermaidViewport: 'Mermaid diagram viewport. Drag to pan; press plus or minus to zoom.',
      mermaidZoomIn: 'Zoom in on diagram',
      mermaidZoomOut: 'Zoom out on diagram',
      mermaidResetView: 'Fit diagram to viewport',
      mermaidExpandView: 'View diagram fullscreen',
      mermaidCollapseView: 'Exit diagram fullscreen',
      mermaidZoomLevel: (percent) => `Zoom level ${percent}%`,
    },
    formControls: {
      selectPlaceholder: 'Select…',
      clear: 'Clear {label}',
      required: 'Required',
      optional: 'Optional',
    },
    modelPicker: {
      searchPlaceholder: 'Search models…',
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
    primitives: { loading: 'Loading', close: 'Close', resizeHandle: 'Resize handle' },
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
    // Never applied — `astryxMessageOverrides` returns undefined for `en`, so
    // Astryx resolves its own shipped catalog. Mirrored verbatim from that
    // catalog so the two columns stay diffable when Astryx changes a default.
    astryx: {
      appShell: { mobileNavigation: 'Mobile navigation' },
      banner: { collapse: 'Collapse', expand: 'Expand' },
      breadcrumbs: { label: 'Breadcrumb' },
      calendar: {
        dayInRange: '{date}, in range',
        dayRangeEnd: '{date}, range end',
        dayRangeStart: '{date}, range start',
        dayRangeStartAndEnd: '{date}, range start and range end',
        daySelected: '{date}, selected',
        nextMonth: 'Next month',
        previousMonth: 'Previous month',
        rangeCompleteAnnounce: 'Selected range: {start} to {end}.',
        rangeStartAnnounce: 'Start date {date}. Select an end date.',
      },
      chat: {
        composerPlaceholder: 'Type a message…',
        composerDrawerLabel: 'Items',
        composerInputLabel: 'Message input',
        messageAriaLabel: 'Message {status}',
        pastedTextExpand: 'Expand',
        statusDelivered: 'Delivered',
        statusFailed: 'Failed',
        statusRead: 'Read',
        statusSending: 'Sending',
        statusSent: 'Sent',
        drawerCollapse: 'Collapse {label}',
        drawerExpand: 'Expand {label}',
        newMessages: 'New messages',
        scrollToBottom: 'Scroll to bottom',
        send: 'Send',
        stop: 'Stop',
        toolCallsError: 'Error: {message}',
        toolCallsGroupLabel: '{count} tool calls',
        triggerSuggestions: 'Suggestions',
      },
      commandPalette: {
        emptyBootstrap: 'Type to search',
        emptySearch: 'No results',
        inputPlaceholder: 'Search…',
        label: 'Command palette',
        noResultsFor: 'No results for {query}',
        resultCount: '{count, number} {count, plural, one {result} other {results}}',
      },
      dateTime: {
        closeCalendar: 'Close calendar',
        openCalendar: 'Open calendar',
        dialogLabel: 'Choose date',
        datePlaceholder: 'Select a date',
        timePlaceholder: 'Select a time',
        timeSuffix: '{label} time',
      },
      inputStatus: { error: 'Error details', success: 'Success details', warning: 'Warning details' },
      lightbox: { mediaViewer: 'Media viewer', previous: 'Previous', next: 'Next' },
      menus: { dropdown: 'Menu', more: 'More options' },
      multiSelector: { clearAll: 'Clear all {label}', selectAll: 'Select all' },
      search: { options: 'Search options', placeholder: 'Search…' },
      sideNav: {
        label: 'Side navigation',
        resizeSidebar: 'Resize sidebar',
        collapseSidebar: 'Collapse sidebar',
        expandSidebar: 'Expand sidebar',
        itemCollapse: 'Collapse {label}',
        itemExpand: 'Expand {label}',
      },
      tabList: { label: 'Tabs' },
      table: {
        label: 'Table',
        noData: 'No data',
        filterAll: 'All',
        filterApply: 'Apply',
        filterReset: 'Reset',
        filterByColumn: 'Filter {header}',
      },
      thumbnail: { fallbackName: 'Thumbnail', open: 'Open {accessibleName}', remove: 'Remove {accessibleName}' },
      token: { remove: 'Remove {label}' },
    },
  },
} satisfies UiCatalog<SharedUiCopy>;

export function getSharedUiCopy(locale: UiLocale): SharedUiCopy {
  return SHARED_UI_COPY[locale];
}
