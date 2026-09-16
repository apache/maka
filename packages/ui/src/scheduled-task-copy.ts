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

import type { ScheduledTask, ScheduledTaskRunOutcome, ScheduledTaskStatus } from '@maka/core/scheduled-task';
import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';
import type {
  ScheduledTaskDelivery,
  ScheduledTaskRecurrence,
} from './module-panel-types.js';

type RunStatus = ScheduledTaskRunOutcome;

export type ScheduledTaskExampleTemplate = {
  id: string;
  title: string;
  note: string;
  scheduleLabel: string;
  recurrence: ScheduledTaskRecurrence;
  cronExpression: string;
  nextRun: { weekday?: number; hour: number; minute: number };
};

export interface ScheduledTaskCopy {
  templates: readonly ScheduledTaskExampleTemplate[];
  validation: {
    title: string;
    timeInvalid: string;
    timePast: string;
    cron: string;
    chatId: string;
  };
  status: Record<ScheduledTaskStatus, string>;
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
    recurring: Record<'daily' | 'weekly' | 'monthly', string>;
    interval: (seconds: number) => string;
  };
  runStatus: Record<RunStatus, string>;
  delivery: {
    local: string;
    bot: (provider: string, chatId: string) => string;
    fallback: (target: string) => string;
  };
  form: {
    editTitle: string;
    createTitle: string;
    useTemplate: string;
    field: { title: string; time: string; channel: string; recurrence: string; platform: string; cron: string; chatId: string; note: string };
    titlePlaceholder: string;
    groupSchedule: string;
    groupDelivery: string;
    presetsAriaLabel: string;
    presets: ReadonlyArray<readonly ['ten-minutes' | 'one-hour' | 'tomorrow-morning' | 'next-monday', string]>;
    recurrenceOptions: ReadonlyArray<readonly [ScheduledTaskRecurrence, string]>;
    deliveryOptions: ReadonlyArray<readonly [ScheduledTaskDelivery['channel'], string]>;
    agentRunOption: string;
    intervalOption: string;
    cronPlaceholder: string;
    chatIdPlaceholder: string;
    deliveryHelp: (providers: string) => string;
    notePlaceholder: string;
    saving: string;
    creating: string;
    save: string;
    create: string;
  };
  page: {
    title: string;
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
    /**
     * Announced when selecting a row opens the inspector. Names no placement:
     * the same content is a side panel on a wide window and a sheet below the
     * breakpoint, and the announcement is shared by both.
     */
    inspectorOpened: (title: string) => string;
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
    /** The run-range no-match's widen action: back to all time. */
    showAllTime: string;
    runsAriaLabel: string;
    activeCount: (count: number) => string;
  };
  /** The inspector panel: one selected task, its facts and its actions. */
  detail: {
    label: string;
    enabled: string;
    recurrence: string;
    nextRun: string;
    lastRun: string;
    delivery: string;
    created: string;
    runs: string;
    noRuns: string;
    /** Badge for tasks whose effect starts an agent session. */
    agentSource: string;
    agentSourceHint: string;
    /** Delivery column when the task runs as an agent session. */
    agentDelivery: string;
  };
}

const SCHEDULED_TASK_COPY = {
  'zh-CN': {
    templates: [
      { id: 'daily-download-cleanup', title: '每日下载文件夹清理', note: '请帮我整理「下载」文件夹，把截图、安装包和临时文档按类型归档，并列出可删除项。', scheduleLabel: '每天 18:30', recurrence: 'cron', cronExpression: '30 18 * * *', nextRun: { hour: 18, minute: 30 } },
      { id: 'midday-reset', title: '午间充电站', note: '午休时间到了，帮我回顾上午完成了什么，并给下午列一个轻量可执行计划。', scheduleLabel: '工作日 12:30', recurrence: 'cron', cronExpression: '30 12 * * 1-5', nextRun: { hour: 12, minute: 30 } },
      { id: 'weekend-todo-review', title: '周末待办整理', note: '梳理这周完成 / 未完成的待办，输出下周计划，并标记需要优先处理的 3 件事。', scheduleLabel: '每周日 20:00', recurrence: 'cron', cronExpression: '0 20 * * 0', nextRun: { weekday: 0, hour: 20, minute: 0 } },
      { id: 'daily-news-brief', title: '每日新闻摘要', note: '总结今天科技 / AI / Maka 相关新闻 5 条，按重要性排序，并给出每条 1 句影响判断。', scheduleLabel: '每天 09:30', recurrence: 'cron', cronExpression: '30 9 * * *', nextRun: { hour: 9, minute: 30 } },
    ],
    validation: { title: '填写标题后才能保存提醒。', timeInvalid: '选择有效的提醒时间。', timePast: '提醒时间必须晚于当前时间。', cron: 'Cron 需要 5 段表达式，例如 0 9 * * 1-5。', chatId: '选择机器人聊天时需要填写 Chat ID。' },
    status: { active: '待触发', paused: '已暂停', completed: '已完成', expired: '已过期' },
    duplicateSuffix: ' 副本',
    countdown: { overdue: '已过期', soon: '马上', minutes: (count) => `${count} 分钟后`, hours: (count) => `${count} 小时后`, tomorrow: '明天', days: (count) => `${count} 天后`, weeks: (count) => `${count} 周后`, months: (count) => `${count} 个月后` },
    recurrence: { once: '一次性提醒', cron: (expression) => `Cron：${expression}`, recurring: { daily: '每天', weekly: '每周', monthly: '每月' }, interval: (seconds) => `每 ${seconds} 秒` },
    runStatus: { ok: '已触发', blocked: '已阻止', failed: '失败' },
    delivery: { local: '本地提醒', bot: (provider, chatId) => `${provider} · ${chatId}`, fallback: (target) => `触发后投递到：${target}` },
    form: {
      editTitle: '编辑定时任务', createTitle: '新建定时任务', useTemplate: '使用模板', field: { title: '标题', time: '提醒时间', channel: '方式', recurrence: '重复', platform: '平台', cron: 'Cron', chatId: 'Chat ID', note: '备注' }, titlePlaceholder: '例如：明天复盘项目进度', groupSchedule: '频率', groupDelivery: '投递', presetsAriaLabel: '快速设置提醒时间', presets: [['ten-minutes', '10 分钟后'], ['one-hour', '1 小时后'], ['tomorrow-morning', '明天 9 点'], ['next-monday', '下周一 9 点']], recurrenceOptions: [['none', '不重复'], ['daily', '每天'], ['weekly', '每周'], ['monthly', '每月'], ['cron', 'Cron']], deliveryOptions: [['local', '本地提醒'], ['bot', '机器人聊天']], agentRunOption: '交给 Agent 执行', intervalOption: '固定间隔（由 Agent 创建）', cronPlaceholder: '例如 0 9 * * 1-5', chatIdPlaceholder: '例如 Telegram chat_id', deliveryHelp: (providers) => `当前可投递到 ${providers}；其它机器人平台不会出现在投递目标里。`, notePlaceholder: '可选：补充需要提醒的上下文', saving: '保存中…', creating: '创建中…', save: '保存', create: '创建',
    },
    page: {
      title: '定时任务', refreshing: '正在刷新定时任务', refresh: '刷新定时任务', create: '新建定时任务', keepAwake: '保持系统唤醒', pageSettings: '定时任务页面设置', keepAwakeErrorTitle: '无法更新保持系统唤醒', keepAwakeErrorFallback: '更新保持系统唤醒设置失败，请稍后重试。', viewsAriaLabel: '定时任务视图', tasks: '我的定时任务', runs: '执行记录', filtersAriaLabel: '定时任务筛选', sort: '排序', sortOptions: [['created-desc', '按创建时间倒序'], ['next-run-asc', '按下次触发升序'], ['updated-desc', '按更新时间倒序']], searchLabel: '搜索定时任务', searchPlaceholder: '搜索标题、备注、投递或执行记录…', state: '状态', filterOption: (label, count) => `${label} ${count}`, active: '进行中', all: '全部', range: '范围', rangeOptions: [['day', '今天'], ['week', '近 7 天'], ['month', '近 30 天'], ['all', '全部记录']], searchMatches: (count) => `找到 ${count} 个匹配提醒`, clearSearch: '清除搜索', noSearchTitle: '没有匹配的提醒', noFilterTitle: '当前筛选没有提醒', noSearchBody: '调整搜索词，或切换状态筛选查看其他提醒。', noFilterBody: '切换筛选查看其他状态，或创建新的定时任务。', emptyTitle: '还没有定时任务', emptyBody: '创建一个提醒，让 Maka 在指定时间继续这项工作。', listAriaLabel: '定时任务列表', inspectorOpened: (title) => `已打开「${title}」的任务详情`, edit: '编辑', duplicate: '复制', triggering: '触发中…', triggerNow: '立即触发', snoozing: '延后中…', snooze: '延后 10 分钟', clearing: '清空中…', clearRuns: '清空记录', deleting: '删除中…', delete: '删除', nextRun: (time) => `下次触发：${time}`, recentRun: (time) => `最近 ${time}`, unscheduled: '未安排', noRunsTitle: '暂无执行记录', noRunsBody: '提醒触发、手动执行或投递失败后，会在这里保留最近记录。', showAllTime: '显示全部时间', runsAriaLabel: '定时任务执行记录', activeCount: (count) => `${count} 个进行中`,
    },
    detail: {
      label: '任务详情',
      enabled: '启用',
      recurrence: '重复',
      nextRun: '下次触发',
      lastRun: '最近触发',
      delivery: '投递',
      created: '创建于',
      runs: '执行记录',
      noRuns: '这个任务还没有执行记录。',
      agentSource: 'Agent 定时任务',
      agentSourceHint: '到点后，Maka 会使用创建时的执行设置启动新任务。',
      agentDelivery: '交给 Agent 执行',
    },
  },
  'zh-TW': {
    templates: [
      { id: 'daily-download-cleanup', title: '每日下載資料夾清理', note: '請幫我整理「下載」資料夾，把截圖、安裝包和臨時文件按型別歸檔，並列出可刪除項。', scheduleLabel: '每天 18:30', recurrence: 'cron', cronExpression: '30 18 * * *', nextRun: { hour: 18, minute: 30 } },
      { id: 'midday-reset', title: '午間充電站', note: '午休時間到了，幫我回顧上午完成了什麼，並給下午列一個輕量可執行計劃。', scheduleLabel: '工作日 12:30', recurrence: 'cron', cronExpression: '30 12 * * 1-5', nextRun: { hour: 12, minute: 30 } },
      { id: 'weekend-todo-review', title: '週末待辦整理', note: '梳理這週完成 / 未完成的待辦，輸出下週計劃，並標記需要優先處理的 3 件事。', scheduleLabel: '每週日 20:00', recurrence: 'cron', cronExpression: '0 20 * * 0', nextRun: { weekday: 0, hour: 20, minute: 0 } },
      { id: 'daily-news-brief', title: '每日新聞摘要', note: '總結今天科技 / AI / Maka 相關新聞 5 條，按重要性排序，並給出每條 1 句影響判斷。', scheduleLabel: '每天 09:30', recurrence: 'cron', cronExpression: '30 9 * * *', nextRun: { hour: 9, minute: 30 } },
    ],
    validation: { title: '填寫標題後才能儲存提醒。', timeInvalid: '選擇有效的提醒時間。', timePast: '提醒時間必須晚於目前時間。', cron: 'Cron 需要 5 段表示式，例如 0 9 * * 1-5。', chatId: '選擇機器人聊天時需要填寫 Chat ID。' },
    status: { active: '待觸發', paused: '已暫停', completed: '已完成', expired: '已過期' },
    duplicateSuffix: ' 副本',
    countdown: { overdue: '已過期', soon: '馬上', minutes: (count) => `${count} 分鐘後`, hours: (count) => `${count} 小時後`, tomorrow: '明天', days: (count) => `${count} 天後`, weeks: (count) => `${count} 週後`, months: (count) => `${count} 個月後` },
    recurrence: { once: '一次性提醒', cron: (expression) => `Cron：${expression}`, recurring: { daily: '每天', weekly: '每週', monthly: '每月' }, interval: (seconds) => `每 ${seconds} 秒` },
    runStatus: { ok: '已觸發', blocked: '已阻止', failed: '失敗' },
    delivery: { local: '本地提醒', bot: (provider, chatId) => `${provider} · ${chatId}`, fallback: (target) => `觸發後投遞到：${target}` },
    form: {
      editTitle: '編輯定時任務', createTitle: '建立定時任務', useTemplate: '使用模板', field: { title: '標題', time: '提醒時間', channel: '方式', recurrence: '重複', platform: '平臺', cron: 'Cron', chatId: 'Chat ID', note: '備註' }, titlePlaceholder: '例如：明天復盤專案進度', groupSchedule: '頻率', groupDelivery: '投遞', presetsAriaLabel: '快速設定提醒時間', presets: [['ten-minutes', '10 分鐘後'], ['one-hour', '1 小時後'], ['tomorrow-morning', '明天 9 點'], ['next-monday', '下週一 9 點']], recurrenceOptions: [['none', '不重複'], ['daily', '每天'], ['weekly', '每週'], ['monthly', '每月'], ['cron', 'Cron']], deliveryOptions: [['local', '本地提醒'], ['bot', '機器人聊天']], agentRunOption: '交給 Agent 執行', intervalOption: '固定間隔（由 Agent 建立）', cronPlaceholder: '例如 0 9 * * 1-5', chatIdPlaceholder: '例如 Telegram chat_id', deliveryHelp: (providers) => `目前可投遞到 ${providers}；其它機器人平臺不會出現在投遞目標裡。`, notePlaceholder: '可選：補充需要提醒的上下文', saving: '儲存中…', creating: '建立中…', save: '儲存', create: '建立',
    },
    page: {
      title: '定時任務', refreshing: '正在重新整理定時任務', refresh: '重新整理定時任務', create: '建立定時任務', keepAwake: '保持系統喚醒', pageSettings: '定時任務頁面設定', keepAwakeErrorTitle: '無法更新保持系統喚醒', keepAwakeErrorFallback: '更新保持系統喚醒設定失敗，請稍後重試。', viewsAriaLabel: '定時任務檢視', tasks: '我的定時任務', runs: '執行記錄', filtersAriaLabel: '定時任務篩選', sort: '排序', sortOptions: [['created-desc', '按建立時間倒序'], ['next-run-asc', '按下次觸發升序'], ['updated-desc', '按更新時間倒序']], searchLabel: '搜尋定時任務', searchPlaceholder: '搜尋標題、備註、投遞或執行記錄…', state: '狀態', filterOption: (label, count) => `${label} ${count}`, active: '進行中', all: '全部', range: '範圍', rangeOptions: [['day', '今天'], ['week', '近 7 天'], ['month', '近 30 天'], ['all', '全部記錄']], searchMatches: (count) => `找到 ${count} 個符合提醒`, clearSearch: '清除搜尋', noSearchTitle: '沒有符合的提醒', noFilterTitle: '目前篩選沒有提醒', noSearchBody: '調整搜尋詞，或切換狀態篩選檢視其他提醒。', noFilterBody: '切換篩選檢視其他狀態，或建立新的定時任務。', emptyTitle: '還沒有定時任務', emptyBody: '建立一個提醒，讓 Maka 在指定時間繼續這項工作。', listAriaLabel: '定時任務列表', inspectorOpened: (title) => `已開啟「${title}」的任務詳情`, edit: '編輯', duplicate: '複製', triggering: '觸發中…', triggerNow: '立即觸發', snoozing: '延後中…', snooze: '延後 10 分鐘', clearing: '清空中…', clearRuns: '清空記錄', deleting: '刪除中…', delete: '刪除', nextRun: (time) => `下次觸發：${time}`, recentRun: (time) => `最近 ${time}`, unscheduled: '未安排', noRunsTitle: '暫無執行記錄', noRunsBody: '提醒觸發、手動執行或投遞失敗後，會在這裡保留最近記錄。', showAllTime: '顯示全部時間', runsAriaLabel: '定時任務執行記錄', activeCount: (count) => `${count} 個進行中`,
    },
    detail: {
      label: '任務詳情',
      enabled: '啟用',
      recurrence: '重複',
      nextRun: '下次觸發',
      lastRun: '最近觸發',
      delivery: '投遞',
      created: '建立於',
      runs: '執行記錄',
      noRuns: '這個任務還沒有執行記錄。',
      agentSource: 'Agent 定時任務',
      agentSourceHint: '到點後，Maka 會使用建立時的執行設定啟動新任務。',
      agentDelivery: '交給 Agent 執行',
    },
  },
  en: {
    templates: [
      { id: 'daily-download-cleanup', title: 'Clean up Downloads', note: 'Organize screenshots, installers, and temporary documents in Downloads by type, then list items that can be deleted.', scheduleLabel: 'Daily at 18:30', recurrence: 'cron', cronExpression: '30 18 * * *', nextRun: { hour: 18, minute: 30 } },
      { id: 'midday-reset', title: 'Midday reset', note: 'Review what I completed this morning and create a lightweight, actionable plan for the afternoon.', scheduleLabel: 'Weekdays at 12:30', recurrence: 'cron', cronExpression: '30 12 * * 1-5', nextRun: { hour: 12, minute: 30 } },
      { id: 'weekend-todo-review', title: 'Weekend task review', note: 'Review completed and unfinished tasks from this week, outline next week, and flag the three highest priorities.', scheduleLabel: 'Sundays at 20:00', recurrence: 'cron', cronExpression: '0 20 * * 0', nextRun: { weekday: 0, hour: 20, minute: 0 } },
      { id: 'daily-news-brief', title: 'Daily news brief', note: 'Summarize five important technology, AI, or Maka stories from today and add one sentence about the impact of each.', scheduleLabel: 'Daily at 09:30', recurrence: 'cron', cronExpression: '30 9 * * *', nextRun: { hour: 9, minute: 30 } },
    ],
    validation: { title: 'Add a title before saving this task.', timeInvalid: 'Choose a valid task time.', timePast: 'The task time must be in the future.', cron: 'Cron expressions need five fields, for example 0 9 * * 1-5.', chatId: 'Enter a Chat ID when delivering to a bot chat.' },
    status: { active: 'Scheduled', paused: 'Paused', completed: 'Completed', expired: 'Expired' },
    duplicateSuffix: ' copy',
    countdown: { overdue: 'Overdue', soon: 'Soon', minutes: (count) => `in ${count} ${count === 1 ? 'minute' : 'minutes'}`, hours: (count) => `in ${count} ${count === 1 ? 'hour' : 'hours'}`, tomorrow: 'Tomorrow', days: (count) => `in ${count} days`, weeks: (count) => `in ${count} ${count === 1 ? 'week' : 'weeks'}`, months: (count) => `in ${count} ${count === 1 ? 'month' : 'months'}` },
    recurrence: { once: 'One-time task', cron: (expression) => `Cron: ${expression}`, recurring: { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' }, interval: (seconds) => `Every ${seconds} seconds` },
    runStatus: { ok: 'Triggered', blocked: 'Blocked', failed: 'Failed' },
    delivery: { local: 'Local notification', bot: (provider, chatId) => `${provider} · ${chatId}`, fallback: (target) => `Deliver to: ${target}` },
    form: {
      editTitle: 'Edit scheduled task', createTitle: 'New scheduled task', useTemplate: 'Use template', field: { title: 'Title', time: 'Task time', channel: 'Method', recurrence: 'Repeat', platform: 'Platform', cron: 'Cron', chatId: 'Chat ID', note: 'Notes' }, titlePlaceholder: 'For example: Review project progress tomorrow', groupSchedule: 'Frequency', groupDelivery: 'Delivery', presetsAriaLabel: 'Quick task times', presets: [['ten-minutes', 'In 10 minutes'], ['one-hour', 'In 1 hour'], ['tomorrow-morning', 'Tomorrow at 9:00'], ['next-monday', 'Next Monday at 9:00']], recurrenceOptions: [['none', 'Does not repeat'], ['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly'], ['cron', 'Cron']], deliveryOptions: [['local', 'Local notification'], ['bot', 'Bot chat']], agentRunOption: 'Run via the Agent', intervalOption: 'Fixed interval (created by Agent)', cronPlaceholder: 'For example 0 9 * * 1-5', chatIdPlaceholder: 'For example Telegram chat_id', deliveryHelp: (providers) => `Available delivery providers: ${providers}. Other bot platforms are not shown as delivery targets.`, notePlaceholder: 'Optional context for this task', saving: 'Saving…', creating: 'Creating…', save: 'Save', create: 'Create',
    },
    page: {
      title: 'Scheduled tasks', refreshing: 'Refreshing scheduled tasks', refresh: 'Refresh scheduled tasks', create: 'New scheduled task', keepAwake: 'Keep system awake', pageSettings: 'Scheduled task page settings', keepAwakeErrorTitle: 'Could not update Keep system awake', keepAwakeErrorFallback: 'Could not update the Keep system awake setting. Try again later.', viewsAriaLabel: 'Scheduled task views', tasks: 'My scheduled tasks', runs: 'Run history', filtersAriaLabel: 'Scheduled task filters', sort: 'Sort', sortOptions: [['created-desc', 'Newest created first'], ['next-run-asc', 'Next run first'], ['updated-desc', 'Recently updated first']], searchLabel: 'Search scheduled tasks', searchPlaceholder: 'Search titles, notes, delivery, or run history…', state: 'Status', filterOption: (label, count) => `${label} ${count}`, active: 'Active', all: 'All', range: 'Range', rangeOptions: [['day', 'Today'], ['week', 'Last 7 days'], ['month', 'Last 30 days'], ['all', 'All runs']], searchMatches: (count) => `${count} matching ${count === 1 ? 'task' : 'tasks'}`, clearSearch: 'Clear search', noSearchTitle: 'No matching tasks', noFilterTitle: 'No tasks in this filter', noSearchBody: 'Change the search terms or status filter to find other tasks.', noFilterBody: 'Change the filter or create a new scheduled task.', emptyTitle: 'No scheduled tasks yet', emptyBody: 'Create a task so Maka can continue this work at the right time.', listAriaLabel: 'Scheduled task list', inspectorOpened: (title) => `Opened the task details for ${title}`, edit: 'Edit', duplicate: 'Duplicate', triggering: 'Triggering…', triggerNow: 'Trigger now', snoozing: 'Snoozing…', snooze: 'Snooze 10 minutes', clearing: 'Clearing…', clearRuns: 'Clear history', deleting: 'Deleting…', delete: 'Delete', nextRun: (time) => `Next run: ${time}`, recentRun: (time) => `Last run ${time}`, unscheduled: 'Not scheduled', noRunsTitle: 'No run history', noRunsBody: 'Triggered tasks, manual runs, and delivery failures appear here.', showAllTime: 'All time', runsAriaLabel: 'Scheduled task run history', activeCount: (count) => `${count} active`,
    },
    detail: {
      label: 'Task details',
      enabled: 'Enabled',
      recurrence: 'Repeats',
      nextRun: 'Next run',
      lastRun: 'Last run',
      delivery: 'Delivery',
      created: 'Created',
      runs: 'Run history',
      noRuns: 'This task has not run yet.',
      agentSource: 'Agent scheduled task',
      agentSourceHint:
        'When due, Maka starts a new task using the execution settings captured at creation.',
      agentDelivery: 'Run via the Agent',
    },
  },
} satisfies UiCatalog<ScheduledTaskCopy>;

export function getScheduledTaskCopy(locale: UiLocale): ScheduledTaskCopy {
  return SCHEDULED_TASK_COPY[locale];
}
