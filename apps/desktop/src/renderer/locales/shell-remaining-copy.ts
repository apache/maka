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

type WidenCopy<T> = T extends string
  ? string
  : T extends (...args: infer Args) => string
    ? (...args: Args) => string
    : { [K in keyof T]: WidenCopy<T[K]> };

const zhCopy = {
  scheduledTaskActions: {
    refreshFailed: "刷新计划失败",
    refreshFallback: "刷新定时任务失败，请稍后重试。",
    created: "已创建定时任务",
    createFailed: "创建计划失败",
    createFallback: "创建定时任务失败，请稍后重试。",
    createIncognitoBlocked: "隐身模式开启时不能创建定时任务。",
    saved: "已保存定时任务",
    saveFailed: "保存计划失败",
    saveFallback: "保存定时任务失败，请稍后重试。",
    enabled: "已启用任务",
    paused: "已暂停任务",
    updateFailed: "更新计划失败",
    updateFallback: "更新定时任务失败，请稍后重试。",
    triggered: "已触发定时任务",
    triggerFailed: "触发计划失败",
    triggerFallback: "触发定时任务失败，请稍后重试。",
    snoozed: "已延后 10 分钟",
    snoozeFailed: "延后计划失败",
    snoozeFallback: "延后定时任务失败，请稍后重试。",
    task: "定时任务",
    clearTitle: (name: string) => `清空 “${name}” 的执行记录`,
    clearDescription: "定时任务本身会保留；只清空最近执行记录和最近状态。",
    clear: "清空记录",
    cancel: "取消",
    cleared: "已清空执行记录",
    clearFailed: "清空记录失败",
    clearFallback: "清空定时任务记录失败，请稍后重试。",
    deleteTitle: (name: string) => `删除 “${name}”`,
    deleteDescription: "该任务和最近执行记录会被删除。该操作不可撤销。",
    delete: "删除",
    deleted: "已删除定时任务",
    deleteFailed: "删除计划失败",
    deleteFallback: "删除定时任务失败，请稍后重试。",
  },
  dailyReview: {
    yesterday: "昨天",
    today: "今天",
    followSettings: "跟随设置",
    unavailable: "每日回顾生成暂不可用",
    historyUnavailable: "每日回顾历史暂不可用",
    archiveMissing: "找不到每日回顾报告",
    settingsUnavailable: "每日回顾设置暂不可用",
  },
  connections: {
    refreshFailed: "刷新模型连接失败",
    refreshFallback: "模型连接暂时无法刷新，请稍后重试。",
  },
  tasks: { loadFailed: "待办载入失败，请重试。" },
  projects: { ungrouped: "未归属项目" },
  models: { unavailable: "当前不可用" },
  overlays: {
    loadingSettings: "正在加载设置",
    loadingSettingsProgress: "正在加载设置…",
  },
  notifications: {
    scheduledTask: "定时任务",
    viewScheduledTasks: "查看定时任务",
  },
  previousMainProcessInterruption: {
    title: "Maka 已恢复",
    description: "上次退出未完成。",
    copyDiagnostics: "复制报告",
  },
  conversationExport: {
    exported: (date: string) => `由 Maka 于 ${date} 导出。`,
    you: "你",
    toolCalls: "工具调用",
    intentSeparator: " — ",
  },
} as const;
const zhTwCopy = {
  scheduledTaskActions: {
    refreshFailed: "重新整理計劃失敗",
    refreshFallback: "重新整理定時任務失敗，請稍後重試。",
    created: "已建立定時任務",
    createFailed: "建立計劃失敗",
    createFallback: "建立定時任務失敗，請稍後重試。",
    createIncognitoBlocked: "隱身模式開啟時不能建立定時任務。",
    saved: "已儲存定時任務",
    saveFailed: "儲存計劃失敗",
    saveFallback: "儲存定時任務失敗，請稍後重試。",
    enabled: "已啟用任務",
    paused: "已暫停任務",
    updateFailed: "更新計劃失敗",
    updateFallback: "更新定時任務失敗，請稍後重試。",
    triggered: "已觸發定時任務",
    triggerFailed: "觸發計劃失敗",
    triggerFallback: "觸發定時任務失敗，請稍後重試。",
    snoozed: "已延後 10 分鐘",
    snoozeFailed: "延後計劃失敗",
    snoozeFallback: "延後定時任務失敗，請稍後重試。",
    task: "定時任務",
    clearTitle: (name: string) => `清空 “${name}” 的執行記錄`,
    clearDescription: "定時任務本身會保留；只清空最近執行記錄和最近狀態。",
    clear: "清空記錄",
    cancel: "取消",
    cleared: "已清空執行記錄",
    clearFailed: "清空記錄失敗",
    clearFallback: "清空定時任務記錄失敗，請稍後重試。",
    deleteTitle: (name: string) => `刪除 “${name}”`,
    deleteDescription: "該任務和最近執行記錄會被刪除。該操作不可撤銷。",
    delete: "刪除",
    deleted: "已刪除定時任務",
    deleteFailed: "刪除計劃失敗",
    deleteFallback: "刪除定時任務失敗，請稍後重試。",
  },
  dailyReview: {
    yesterday: "昨天",
    today: "今天",
    followSettings: "跟隨設定",
    unavailable: "每日回顧生成暫不可用",
    historyUnavailable: "每日回顧歷史暫不可用",
    archiveMissing: "找不到每日回顧報告",
    settingsUnavailable: "每日回顧設定暫不可用",
  },
  connections: {
    refreshFailed: "重新整理模型連線失敗",
    refreshFallback: "模型連線暫時無法重新整理，請稍後重試。",
  },
  tasks: { loadFailed: "待辦載入失敗，請重試。" },
  projects: { ungrouped: "未歸屬專案" },
  models: { unavailable: "目前不可用" },
  overlays: {
    loadingSettings: "正在載入設定",
    loadingSettingsProgress: "正在載入設定…",
  },
  notifications: {
    scheduledTask: "定時任務",
    viewScheduledTasks: "檢視定時任務",
  },
  previousMainProcessInterruption: {
    title: "Maka 已恢復",
    description: "上次退出未完成。",
    copyDiagnostics: "複製報告",
  },
  conversationExport: {
    exported: (date: string) => `由 Maka 於 ${date} 匯出。`,
    you: "你",
    toolCalls: "工具呼叫",
    intentSeparator: " — ",
  },
} as const;

export type ShellRemainingCopy = WidenCopy<typeof zhCopy>;

const enCopy: ShellRemainingCopy = {
  scheduledTaskActions: {
    refreshFailed: "Failed to refresh tasks",
    refreshFallback: "Scheduled tasks could not be refreshed. Try again later.",
    created: "Scheduled task created",
    createFailed: "Failed to create task",
    createFallback: "The scheduled task could not be created. Try again later.",
    createIncognitoBlocked:
      "Scheduled tasks cannot be created while incognito mode is active.",
    saved: "Scheduled task saved",
    saveFailed: "Failed to save task",
    saveFallback: "The scheduled task could not be saved. Try again later.",
    enabled: "Task enabled",
    paused: "Task paused",
    updateFailed: "Failed to update task",
    updateFallback: "The scheduled task could not be updated. Try again later.",
    triggered: "Scheduled task triggered",
    triggerFailed: "Failed to trigger task",
    triggerFallback:
      "The scheduled task could not be triggered. Try again later.",
    snoozed: "Snoozed for 10 minutes",
    snoozeFailed: "Failed to snooze task",
    snoozeFallback: "The scheduled task could not be snoozed. Try again later.",
    task: "Scheduled task",
    clearTitle: (name) => `Clear run history for “${name}”?`,
    clearDescription:
      "The scheduled task will remain. Only recent run history and status will be cleared.",
    clear: "Clear history",
    cancel: "Cancel",
    cleared: "Run history cleared",
    clearFailed: "Failed to clear history",
    clearFallback:
      "The scheduled-task history could not be cleared. Try again later.",
    deleteTitle: (name) => `Delete “${name}”?`,
    deleteDescription:
      "The task and its recent run history will be deleted. This cannot be undone.",
    delete: "Delete",
    deleted: "Scheduled task deleted",
    deleteFailed: "Failed to delete task",
    deleteFallback: "The scheduled task could not be deleted. Try again later.",
  },
  dailyReview: {
    yesterday: "Yesterday",
    today: "Today",
    followSettings: "Follow Settings",
    unavailable: "Daily Review generation is unavailable",
    historyUnavailable: "Daily Review history is unavailable",
    archiveMissing: "Daily Review report not found",
    settingsUnavailable: "Daily Review settings are unavailable",
  },
  connections: {
    refreshFailed: "Failed to refresh model connections",
    refreshFallback:
      "Model connections are temporarily unavailable. Try again later.",
  },
  tasks: { loadFailed: "Failed to load the to-do list. Try again." },
  projects: { ungrouped: "No project" },
  models: { unavailable: "Currently unavailable" },
  overlays: {
    loadingSettings: "Loading Settings",
    loadingSettingsProgress: "Loading Settings…",
  },
  notifications: {
    scheduledTask: "Scheduled task",
    viewScheduledTasks: "View scheduled tasks",
  },
  previousMainProcessInterruption: {
    title: "Maka recovered",
    description: "The previous shutdown was incomplete.",
    copyDiagnostics: "Copy report",
  },
  conversationExport: {
    exported: (date) => `Exported ${date} from Maka.`,
    you: "You",
    toolCalls: "Tool calls",
    intentSeparator: " — ",
  },
};

const COPY = {
  'zh-CN': zhCopy,
  'zh-TW': zhTwCopy,
  en: enCopy,
} satisfies UiCatalog<ShellRemainingCopy>;

export function getShellRemainingCopy(locale: UiLocale): ShellRemainingCopy {
  return COPY[locale];
}
