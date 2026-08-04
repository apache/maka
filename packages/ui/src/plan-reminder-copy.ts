import type {
  PlanReminder,
  PlanReminderDeliveryTarget,
  PlanReminderRecurrence,
  PlanReminderStatus,
  UiCatalog,
  UiLocale,
} from '@maka/core';

type RunStatus = NonNullable<PlanReminder['lastRun']>['status'];

export type PlanReminderExampleTemplate = {
  id: string;
  title: string;
  note: string;
  scheduleLabel: string;
  recurrence: PlanReminderRecurrence;
  cronExpression: string;
  nextRun: { weekday?: number; hour: number; minute: number };
};

export interface PlanReminderCopy {
  templates: readonly PlanReminderExampleTemplate[];
  validation: {
    title: string;
    timeInvalid: string;
    timePast: string;
    cron: string;
    chatId: string;
  };
  status: Record<PlanReminderStatus, string>;
  duplicateSuffix: string;
  countdown: {
    overdue: string;
    soon: string;
    minutes: (count: number) => string;
    hours: (count: number) => string;
    tomorrow: string;
    days: (count: number) => string;
    weeks: (count: number) => string;
    months: (count: number) => string;
  };
  recurrence: {
    once: string;
    cron: (expression: string) => string;
    recurring: Record<Exclude<PlanReminderRecurrence, 'none' | 'cron'>, string>;
  };
  runStatus: Record<RunStatus, string>;
  delivery: {
    local: string;
    bot: (provider: string, chatId: string) => string;
    fallback: (target: string) => string;
  };
  form: {
    eyebrow: string;
    editTitle: string;
    createTitle: string;
    close: string;
    useTemplate: string;
    templatesAriaLabel: string;
    groupSchedule: string;
    groupDelivery: string;
    field: { title: string; time: string; at: string; channel: string; recurrence: string; delivery: string; platform: string; cron: string; chatId: string; note: string };
    timePlaceholder: string;
    titlePlaceholder: string;
    presetsAriaLabel: string;
    presets: ReadonlyArray<readonly ['ten-minutes' | 'one-hour' | 'tomorrow-morning' | 'next-monday', string]>;
    recurrenceOptions: ReadonlyArray<readonly [PlanReminderRecurrence, string]>;
    deliveryOptions: ReadonlyArray<readonly [PlanReminderDeliveryTarget['channel'], string]>;
    cronPlaceholder: string;
    chatIdPlaceholder: string;
    deliveryHelp: (providers: string) => string;
    notePlaceholder: string;
    cancel: string;
    saving: string;
    creating: string;
    save: string;
    create: string;
  };
  page: {
    title: string;
    subtitle: string;
    actionsAriaLabel: string;
    refreshing: string;
    refresh: string;
    create: string;
    keepAwake: string;
    pageSettings: string;
    keepAwakeErrorTitle: string;
    keepAwakeErrorFallback: string;
    viewsAriaLabel: string;
    tasks: string;
    runs: string;
    filtersAriaLabel: string;
    sort: string;
    sortOptions: ReadonlyArray<readonly ['created-desc' | 'next-run-asc' | 'updated-desc', string]>;
    searchLabel: string;
    searchPlaceholder: string;
    state: string;
    filterOption: (label: string, count: number) => string;
    active: string;
    all: string;
    runsFilterAriaLabel: string;
    range: string;
    rangeOptions: ReadonlyArray<readonly ['day' | 'week' | 'month' | 'all', string]>;
    searchMatches: (count: number) => string;
    clearSearch: string;
    noSearchTitle: string;
    noFilterTitle: string;
    noSearchBody: string;
    noFilterBody: string;
    emptyTitle: string;
    emptyBody: string;
    listAriaLabel: string;
    pause: string;
    enable: string;
    reminderActions: string;
    edit: string;
    duplicate: string;
    triggering: string;
    triggerNow: string;
    snoozing: string;
    snooze: string;
    clearing: string;
    clearRuns: string;
    deleting: string;
    delete: string;
    nextRun: (time: string) => string;
    recentRun: (time: string) => string;
    unscheduled: string;
    noRunsTitle: string;
    noRunsBody: string;
    runsAriaLabel: string;
  };
}

const PLAN_REMINDER_COPY = {
  zh: {
    templates: [
      { id: 'daily-download-cleanup', title: '每日下载文件夹清理', note: '请帮我整理「下载」文件夹，把截图、安装包和临时文档按类型归档，并列出可删除项。', scheduleLabel: '每天 18:30', recurrence: 'cron', cronExpression: '30 18 * * *', nextRun: { hour: 18, minute: 30 } },
      { id: 'midday-reset', title: '午间充电站', note: '午休时间到了，帮我回顾上午完成了什么，并给下午列一个轻量可执行计划。', scheduleLabel: '工作日 12:30', recurrence: 'cron', cronExpression: '30 12 * * 1-5', nextRun: { hour: 12, minute: 30 } },
      { id: 'weekend-todo-review', title: '周末待办整理', note: '梳理这周完成 / 未完成的待办，输出下周计划，并标记需要优先处理的 3 件事。', scheduleLabel: '每周日 20:00', recurrence: 'cron', cronExpression: '0 20 * * 0', nextRun: { weekday: 0, hour: 20, minute: 0 } },
      { id: 'daily-news-brief', title: '每日新闻摘要', note: '总结今天科技 / AI / Maka 相关新闻 5 条，按重要性排序，并给出每条 1 句影响判断。', scheduleLabel: '每天 09:30', recurrence: 'cron', cronExpression: '30 9 * * *', nextRun: { hour: 9, minute: 30 } },
    ],
    validation: { title: '填写标题后才能保存提醒。', timeInvalid: '选择有效的提醒时间。', timePast: '提醒时间必须晚于当前时间。', cron: 'Cron 需要 5 段表达式，例如 0 9 * * 1-5。', chatId: '选择机器人聊天时需要填写 Chat ID。' },
    status: { scheduled: '待触发', paused: '已暂停', completed: '已完成' },
    duplicateSuffix: ' 副本',
    countdown: { overdue: '已过期', soon: '马上', minutes: (count) => `${count} 分钟后`, hours: (count) => `${count} 小时后`, tomorrow: '明天', days: (count) => `${count} 天后`, weeks: (count) => `${count} 周后`, months: (count) => `${count} 个月后` },
    recurrence: { once: '一次性提醒', cron: (expression) => `Cron：${expression}`, recurring: { daily: '重复：每天', weekly: '重复：每周', monthly: '重复：每月' } },
    runStatus: { triggered: '已触发', blocked: '已阻止', failed: '失败' },
    delivery: { local: '本地提醒', bot: (provider, chatId) => `${provider} · ${chatId}`, fallback: (target) => `触发后投递到：${target}` },
    form: {
      eyebrow: '计划提示词', editTitle: '编辑提醒', createTitle: '新建提醒', close: '关闭计划提醒表单', useTemplate: '使用模板', templatesAriaLabel: '定时任务模板', groupSchedule: '频率', groupDelivery: '投递', field: { title: '标题', time: '提醒时间', at: '时间', channel: '方式', recurrence: '重复', delivery: '投递', platform: '平台', cron: 'Cron', chatId: 'Chat ID', note: '备注' }, timePlaceholder: 'YYYY-MM-DDTHH:mm', titlePlaceholder: '例如：明天复盘项目进度', presetsAriaLabel: '快速设置提醒时间', presets: [['ten-minutes', '10 分钟后'], ['one-hour', '1 小时后'], ['tomorrow-morning', '明天 9 点'], ['next-monday', '下周一 9 点']], recurrenceOptions: [['none', '不重复'], ['daily', '每天'], ['weekly', '每周'], ['monthly', '每月'], ['cron', 'Cron']], deliveryOptions: [['local', '本地提醒'], ['bot', '机器人聊天']], cronPlaceholder: '例如 0 9 * * 1-5', chatIdPlaceholder: '例如 Telegram chat_id', deliveryHelp: (providers) => `当前可投递到 ${providers}；其它机器人平台不会出现在投递目标里。`, notePlaceholder: '可选：补充需要提醒的上下文', cancel: '取消', saving: '保存中…', creating: '创建中…', save: '保存提醒', create: '创建提醒',
    },
    page: {
      title: '定时任务', subtitle: '创建和管理周期性任务，让 Maka 按计划执行提醒、复盘和投递。', actionsAriaLabel: '计划提醒操作', refreshing: '正在刷新定时任务', refresh: '刷新定时任务', create: '新建定时任务', keepAwake: '保持系统唤醒', pageSettings: '定时任务页面设置', keepAwakeErrorTitle: '无法更新保持系统唤醒', keepAwakeErrorFallback: '更新保持系统唤醒设置失败，请稍后重试。', viewsAriaLabel: '计划提醒视图', tasks: '我的定时任务', runs: '执行记录', filtersAriaLabel: '计划提醒筛选', sort: '排序', sortOptions: [['created-desc', '按创建时间倒序'], ['next-run-asc', '按下次触发升序'], ['updated-desc', '按更新时间倒序']], searchLabel: '搜索计划提醒', searchPlaceholder: '搜索标题、备注、投递或执行记录…', state: '状态', filterOption: (label, count) => `${label} ${count}`, active: '进行中', all: '全部', runsFilterAriaLabel: '执行记录筛选', range: '范围', rangeOptions: [['day', '今天'], ['week', '近 7 天'], ['month', '近 30 天'], ['all', '全部记录']], searchMatches: (count) => `找到 ${count} 个匹配提醒`, clearSearch: '清除搜索', noSearchTitle: '没有匹配的提醒', noFilterTitle: '当前筛选没有提醒', noSearchBody: '调整搜索词，或切换状态筛选查看其他提醒。', noFilterBody: '切换筛选查看其他状态，或创建新的计划提醒。', emptyTitle: '还没有定时任务', emptyBody: '创建一个提醒，让 Maka 在指定时间继续这项工作。', listAriaLabel: '计划提醒列表', pause: '暂停提醒', enable: '启用提醒', reminderActions: '提醒操作', edit: '编辑', duplicate: '复制', triggering: '触发中…', triggerNow: '立即触发', snoozing: '延后中…', snooze: '延后 10 分钟', clearing: '清空中…', clearRuns: '清空记录', deleting: '删除中…', delete: '删除', nextRun: (time) => `下次触发：${time}`, recentRun: (time) => `最近 ${time}`, unscheduled: '未安排', noRunsTitle: '暂无执行记录', noRunsBody: '提醒触发、手动执行或投递失败后，会在这里保留最近记录。', runsAriaLabel: '计划提醒执行记录',
    },
  },
  en: {
    templates: [
      { id: 'daily-download-cleanup', title: 'Clean up Downloads', note: 'Organize screenshots, installers, and temporary documents in Downloads by type, then list items that can be deleted.', scheduleLabel: 'Daily at 18:30', recurrence: 'cron', cronExpression: '30 18 * * *', nextRun: { hour: 18, minute: 30 } },
      { id: 'midday-reset', title: 'Midday reset', note: 'Review what I completed this morning and create a lightweight, actionable plan for the afternoon.', scheduleLabel: 'Weekdays at 12:30', recurrence: 'cron', cronExpression: '30 12 * * 1-5', nextRun: { hour: 12, minute: 30 } },
      { id: 'weekend-todo-review', title: 'Weekend task review', note: 'Review completed and unfinished tasks from this week, outline next week, and flag the three highest priorities.', scheduleLabel: 'Sundays at 20:00', recurrence: 'cron', cronExpression: '0 20 * * 0', nextRun: { weekday: 0, hour: 20, minute: 0 } },
      { id: 'daily-news-brief', title: 'Daily news brief', note: 'Summarize five important technology, AI, or Maka stories from today and add one sentence about the impact of each.', scheduleLabel: 'Daily at 09:30', recurrence: 'cron', cronExpression: '30 9 * * *', nextRun: { hour: 9, minute: 30 } },
    ],
    validation: { title: 'Add a title before saving this reminder.', timeInvalid: 'Choose a valid reminder time.', timePast: 'The reminder time must be in the future.', cron: 'Cron expressions need five fields, for example 0 9 * * 1-5.', chatId: 'Enter a Chat ID when delivering to a bot chat.' },
    status: { scheduled: 'Scheduled', paused: 'Paused', completed: 'Completed' },
    duplicateSuffix: ' copy',
    countdown: { overdue: 'Overdue', soon: 'Soon', minutes: (count) => `in ${count} ${count === 1 ? 'minute' : 'minutes'}`, hours: (count) => `in ${count} ${count === 1 ? 'hour' : 'hours'}`, tomorrow: 'Tomorrow', days: (count) => `in ${count} days`, weeks: (count) => `in ${count} ${count === 1 ? 'week' : 'weeks'}`, months: (count) => `in ${count} ${count === 1 ? 'month' : 'months'}` },
    recurrence: { once: 'One-time reminder', cron: (expression) => `Cron: ${expression}`, recurring: { daily: 'Repeats daily', weekly: 'Repeats weekly', monthly: 'Repeats monthly' } },
    runStatus: { triggered: 'Triggered', blocked: 'Blocked', failed: 'Failed' },
    delivery: { local: 'Local notification', bot: (provider, chatId) => `${provider} · ${chatId}`, fallback: (target) => `Deliver to: ${target}` },
    form: {
      eyebrow: 'Task prompt', editTitle: 'Edit reminder', createTitle: 'New reminder', close: 'Close reminder form', useTemplate: 'Use template', templatesAriaLabel: 'Scheduled task templates', groupSchedule: 'Frequency', groupDelivery: 'Delivery', field: { title: 'Title', time: 'Reminder time', at: 'Time', channel: 'Method', recurrence: 'Repeat', delivery: 'Delivery', platform: 'Platform', cron: 'Cron', chatId: 'Chat ID', note: 'Notes' }, timePlaceholder: 'YYYY-MM-DDTHH:mm', titlePlaceholder: 'For example: Review project progress tomorrow', presetsAriaLabel: 'Quick reminder times', presets: [['ten-minutes', 'In 10 minutes'], ['one-hour', 'In 1 hour'], ['tomorrow-morning', 'Tomorrow at 9:00'], ['next-monday', 'Next Monday at 9:00']], recurrenceOptions: [['none', 'Does not repeat'], ['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly'], ['cron', 'Cron']], deliveryOptions: [['local', 'Local notification'], ['bot', 'Bot chat']], cronPlaceholder: 'For example 0 9 * * 1-5', chatIdPlaceholder: 'For example Telegram chat_id', deliveryHelp: (providers) => `Available delivery providers: ${providers}. Other bot platforms are not shown as delivery targets.`, notePlaceholder: 'Optional context for this reminder', cancel: 'Cancel', saving: 'Saving…', creating: 'Creating…', save: 'Save reminder', create: 'Create reminder',
    },
    page: {
      title: 'Scheduled tasks', subtitle: 'Create and manage recurring tasks so Maka can run reminders, reviews, and deliveries on schedule.', actionsAriaLabel: 'Scheduled task actions', refreshing: 'Refreshing scheduled tasks', refresh: 'Refresh scheduled tasks', create: 'New scheduled task', keepAwake: 'Keep system awake', pageSettings: 'Scheduled task page settings', keepAwakeErrorTitle: 'Could not update Keep system awake', keepAwakeErrorFallback: 'Could not update the Keep system awake setting. Try again later.', viewsAriaLabel: 'Scheduled task views', tasks: 'My scheduled tasks', runs: 'Run history', filtersAriaLabel: 'Scheduled task filters', sort: 'Sort', sortOptions: [['created-desc', 'Newest created first'], ['next-run-asc', 'Next run first'], ['updated-desc', 'Recently updated first']], searchLabel: 'Search scheduled tasks', searchPlaceholder: 'Search titles, notes, delivery, or run history…', state: 'Status', filterOption: (label, count) => `${label} ${count}`, active: 'Active', all: 'All', runsFilterAriaLabel: 'Run history filters', range: 'Range', rangeOptions: [['day', 'Today'], ['week', 'Last 7 days'], ['month', 'Last 30 days'], ['all', 'All runs']], searchMatches: (count) => `${count} matching ${count === 1 ? 'reminder' : 'reminders'}`, clearSearch: 'Clear search', noSearchTitle: 'No matching reminders', noFilterTitle: 'No reminders in this filter', noSearchBody: 'Change the search terms or status filter to find other reminders.', noFilterBody: 'Change the filter or create a new scheduled task.', emptyTitle: 'No scheduled tasks yet', emptyBody: 'Create a reminder so Maka can continue this work at the right time.', listAriaLabel: 'Scheduled task list', pause: 'Pause reminder', enable: 'Enable reminder', reminderActions: 'Reminder actions', edit: 'Edit', duplicate: 'Duplicate', triggering: 'Triggering…', triggerNow: 'Trigger now', snoozing: 'Snoozing…', snooze: 'Snooze 10 minutes', clearing: 'Clearing…', clearRuns: 'Clear history', deleting: 'Deleting…', delete: 'Delete', nextRun: (time) => `Next run: ${time}`, recentRun: (time) => `Last run ${time}`, unscheduled: 'Not scheduled', noRunsTitle: 'No run history', noRunsBody: 'Triggered reminders, manual runs, and delivery failures appear here.', runsAriaLabel: 'Scheduled task run history',
    },
  },
} satisfies UiCatalog<PlanReminderCopy>;

export function getPlanReminderCopy(locale: UiLocale): PlanReminderCopy {
  return PLAN_REMINDER_COPY[locale];
}
