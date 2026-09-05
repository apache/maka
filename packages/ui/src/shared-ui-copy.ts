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

import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';

export interface SharedUiCopy {
  capabilityAudit: {
    ariaLabel: string;
    needsAuthorization: (count: number) => string;
    sourceErrors: (count: number) => string;
    failedScheduledTasks: (count: number) => string;
    skippedScheduledTasks: (count: number) => string;
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
    knowledgeCutoff: (date: string) => string;
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
      scheduledTasks: string;
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
  'zh-CN': {
    capabilityAudit: {
      ariaLabel: '能力风险提示',
      needsAuthorization: (count) => `${count} 个来源等待授权`,
      sourceErrors: (count) => `${count} 个来源异常`,
      failedScheduledTasks: (count) => `${count} 个定时任务上次失败`,
      skippedScheduledTasks: (count) => `${count} 个定时任务上次跳过`,
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
      knowledgeCutoff: (date) => `知识截止：${date}`,
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
        description: '安排定时运行，并回顾本机任务的工作进展。',
        selectorLabel: (module) => `定时任务内容：${module}`,
        scheduledTasks: '定时任务',
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
      dailyReviewDescription: '自动汇总本机任务，生成摘要、遗漏提醒与深度分析；可在设置中开启定时执行。',
      dailyReviewDisconnectedTitle: '等待连接每日回顾数据',
      dailyReviewDisconnectedBody: '桌面端数据桥当前未连接。',
    },
    primitives: { loading: '加载中', close: '关闭', resizeHandle: '调整宽度' },
    toast: { notifications: '通知', closeNotification: '关闭通知', confirm: '确定', cancel: '取消' },
    stream: { assistantChunkTruncated: '\n[…单条 delta 已截断]\n', assistantTailTruncated: '\n\n[…后续已截断]', thinkingHeadTruncated: '[…已截断早期 reasoning]\n', thinkingChunkTruncated: '\n[…单条 delta 已截断]\n', toolChunkTruncated: '\n[…已截断]\n' },
    artifact: { unknownSize: '未知大小' },
    providers: { minimaxChina: 'MiniMax 中国站', custom: '自定义', claudeSubscription: 'Claude 订阅' },
  },
  'zh-TW': {
    capabilityAudit: {
      ariaLabel: '能力風險提示',
      needsAuthorization: (count) => `${count} 個來源等待授權`,
      sourceErrors: (count) => `${count} 個來源異常`,
      failedScheduledTasks: (count) => `${count} 個定時任務上次失敗`,
      skippedScheduledTasks: (count) => `${count} 個定時任務上次跳過`,
    },
    markdown: {
      invalidInternalLink: '內部連結無效',
      unsafeLink: '連結不安全',
      taskList: '任務列表',
      table: '表格',
      checkbox: '核取方塊',
      code: '程式碼',
      opensInNewTab: '（在新標籤頁中開啟）',
      copyCode: '複製程式碼',
      copiedCode: '已複製程式碼',
      mermaidDiagram: 'Mermaid 圖表',
      mermaidRendering: '正在渲染 Mermaid 圖表…',
      mermaidRenderFailed: '無法渲染 Mermaid 圖表，已顯示原始碼。',
      mermaidTooLarge: 'Mermaid 圖表原始碼過大，已顯示原始碼。',
      mermaidDeferred: '為避免佔用過多資源，此圖表不會自動渲染。',
      mermaidRender: '渲染圖表',
      mermaidViewSource: '檢視 Mermaid 原始碼',
      mermaidToolbar: 'Mermaid 圖表工具欄',
      mermaidViewport: 'Mermaid 圖表視窗，可拖動平移，按加號或減號縮放',
      mermaidZoomIn: '放大圖表',
      mermaidZoomOut: '縮小圖表',
      mermaidResetView: '適應視窗',
      mermaidExpandView: '全屏檢視圖表',
      mermaidCollapseView: '退出全屏圖表',
      mermaidZoomLevel: (percent) => `縮放比例 ${percent}%`,
    },
    formControls: {
      selectPlaceholder: '選擇…',
      clear: '清除{label}',
      required: '必填',
      optional: '可選',
    },
    modelPicker: {
      searchPlaceholder: '搜尋模型…',
      knowledgeCutoff: (date) => `知識截止：${date}`,
    },
    moduleHubs: {
      extensions: {
        title: '擴充套件',
        description: '管理 Maka 可呼叫的技能與外部工具。',
        selectorLabel: (module) => `擴充套件內容：${module}`,
        skills: '技能',
        mcp: 'MCP',
      },
      automations: {
        title: '定時任務',
        description: '安排定時執行，並回顧本機任務的工作進展。',
        selectorLabel: (module) => `定時任務內容：${module}`,
        scheduledTasks: '定時任務',
        dailyReview: '每日回顧',
      },
    },
    modules: {
      skills: '技能',
      loadingSkills: '正在載入技能…',
      automations: '定時任務',
      loadingAutomations: '正在載入定時任務…',
      dailyReview: '每日回顧',
      loadingDailyReview: '正在載入每日回顧…',
      dailyReviewDescription: '自動彙總本機任務，生成摘要、遺漏提醒與深度分析；可在設定中開啟定時執行。',
      dailyReviewDisconnectedTitle: '等待連線每日回顧資料',
      dailyReviewDisconnectedBody: '桌面端資料橋目前未連線。',
    },
    primitives: { loading: '載入中', close: '關閉', resizeHandle: '調整寬度' },
    toast: { notifications: '通知', closeNotification: '關閉通知', confirm: '確定', cancel: '取消' },
    stream: { assistantChunkTruncated: '\n[…單條 delta 已截斷]\n', assistantTailTruncated: '\n\n[…後續已截斷]', thinkingHeadTruncated: '[…已截斷早期 reasoning]\n', thinkingChunkTruncated: '\n[…單條 delta 已截斷]\n', toolChunkTruncated: '\n[…已截斷]\n' },
    artifact: { unknownSize: '未知大小' },
    providers: { minimaxChina: 'MiniMax 中國站', custom: '自訂', claudeSubscription: 'Claude 訂閱' },
  },
  en: {
    capabilityAudit: {
      ariaLabel: 'Capability risks',
      needsAuthorization: (count) => `${count} ${count === 1 ? 'source' : 'sources'} awaiting authorization`,
      sourceErrors: (count) => `${count} ${count === 1 ? 'source has' : 'sources have'} errors`,
      failedScheduledTasks: (count) => `${count} scheduled ${count === 1 ? 'task failed' : 'tasks failed'} last run`,
      skippedScheduledTasks: (count) => `${count} scheduled ${count === 1 ? 'task was' : 'tasks were'} skipped last run`,
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
      knowledgeCutoff: (date) => `Knowledge cutoff: ${date}`,
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
        description: 'Schedule recurring runs and review progress across local tasks.',
        selectorLabel: (module) => `Scheduled task content: ${module}`,
        scheduledTasks: 'Scheduled tasks',
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
      dailyReviewDescription: 'Summarize local tasks into highlights, missed items, and deeper analysis. Scheduled runs can be enabled in Settings.',
      dailyReviewDisconnectedTitle: 'Waiting for daily review data',
      dailyReviewDisconnectedBody: 'The desktop data bridge is not connected.',
    },
    primitives: { loading: 'Loading', close: 'Close', resizeHandle: 'Resize handle' },
    toast: { notifications: 'Notifications', closeNotification: 'Close notification', confirm: 'Confirm', cancel: 'Cancel' },
    stream: { assistantChunkTruncated: '\n[…single delta truncated]\n', assistantTailTruncated: '\n\n[…remaining output truncated]', thinkingHeadTruncated: '[…earlier reasoning truncated]\n', thinkingChunkTruncated: '\n[…single delta truncated]\n', toolChunkTruncated: '\n[…truncated]\n' },
    artifact: { unknownSize: 'Unknown size' },
    providers: { minimaxChina: 'MiniMax China', custom: 'Custom', claudeSubscription: 'Claude subscription' },
  },
} satisfies UiCatalog<SharedUiCopy>;

export function getSharedUiCopy(locale: UiLocale): SharedUiCopy {
  return SHARED_UI_COPY[locale];
}
