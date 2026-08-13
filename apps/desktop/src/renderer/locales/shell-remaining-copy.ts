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
  tasks: { loadFailed: "任务载入失败，请重试。" },
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
  conversationExport: {
    exported: (date: string) => `由 Maka 于 ${date} 导出。`,
    you: "你",
    toolCalls: "工具调用",
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
  tasks: { loadFailed: "Failed to load tasks. Try again." },
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
  conversationExport: {
    exported: (date) => `Exported ${date} from Maka.`,
    you: "You",
    toolCalls: "Tool calls",
    intentSeparator: " — ",
  },
};

const COPY = { zh: zhCopy, en: enCopy } satisfies UiCatalog<ShellRemainingCopy>;

export function getShellRemainingCopy(locale: UiLocale): ShellRemainingCopy {
  return COPY[locale];
}
