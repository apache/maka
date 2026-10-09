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

//! Interface copy of the Scheduled tasks page: its tasks and runs, the
//! task detail and form, and the Daily review tab. Wording follows Maka
//! Desktop: packages/ui/src/scheduled-task-copy.ts,
//! packages/ui/src/daily-review-copy.ts, `moduleHubs.automations` in
//! packages/ui/src/shared-ui-copy.ts, `navigation.pendingTasks` in
//! packages/ui/src/shell-controls-copy.ts, and `scheduledTaskActions`,
//! `dailyReview`, and `notifications` in
//! apps/desktop/src/renderer/locales/shell-remaining-copy.ts and
//! `commandActions` in shell-copy.ts (Desktop's `zh-CN` / `zh-TW` are the
//! Simplified and Traditional columns). What Desktop never has to say (a
//! reminder waiting for Maka Desktop to deliver it) is this client's.
//! Same rules as the parent module.

use super::{Locale, Text, plural};

texts! {
    // The page's tabs (Desktop's automations hub).
    TAB_SCHEDULED_TASKS = "Scheduled tasks", "定时任务", "定時任務";
    TAB_DAILY_REVIEW = "Daily review", "每日回顾", "每日回顧";
    /// The accessible name of the tabs, with the one shown.
    HUB_CONTENT = "Scheduled task content: {module}", "定时任务内容：{module}", "定時任務內容：{module}";
    /// The page's meta beside its title, and the sidebar entry's label while
    /// tasks are active.
    ACTIVE_COUNT = "{count} active", "{count} 个进行中", "{count} 個進行中";
    SIDEBAR_ACTIVE = "Scheduled tasks, {count} active", "定时任务，{count} 条进行中", "定時任務，{count} 條進行中";

    // The header's actions.
    CREATE = "New scheduled task", "新建定时任务", "建立定時任務";
    PAGE_SETTINGS = "Scheduled task page settings", "定时任务页面设置", "定時任務頁面設定";
    REFRESH = "Refresh scheduled tasks", "刷新定时任务", "重新整理定時任務";
    REFRESHING = "Refreshing scheduled tasks", "正在刷新定时任务", "正在重新整理定時任務";
    KEEP_AWAKE = "Keep system awake", "保持系统唤醒", "保持系統喚醒";
    KEEP_AWAKE_FAILED = "Could not update Keep system awake", "无法更新保持系统唤醒", "無法更新保持系統喚醒";
    KEEP_AWAKE_FALLBACK =
        "Could not update the Keep system awake setting. Try again later.",
        "更新保持系统唤醒设置失败，请稍后重试。",
        "更新保持系統喚醒設定失敗，請稍後重試。";

    // The tasks tab's views and controls.
    VIEWS = "Scheduled task views", "定时任务视图", "定時任務檢視";
    VIEW_TASKS = "My scheduled tasks", "我的定时任务", "我的定時任務";
    VIEW_RUNS = "Run history", "执行记录", "執行記錄";
    SORT = "Sort", "排序", "排序";
    SORT_CREATED = "Newest created first", "按创建时间倒序", "按建立時間倒序";
    SORT_NEXT_RUN = "Next run first", "按下次触发升序", "按下次觸發升序";
    SORT_UPDATED = "Recently updated first", "按更新时间倒序", "按更新時間倒序";
    SEARCH = "Search scheduled tasks", "搜索定时任务", "搜尋定時任務";
    SEARCH_PLACEHOLDER =
        "Search titles, notes, delivery, or run history…",
        "搜索标题、备注、投递或执行记录…",
        "搜尋標題、備註、投遞或執行記錄…";
    FILTER = "Status", "状态", "狀態";
    /// A status filter's option with its count.
    FILTER_OPTION = "{label} {count}", "{label} {count}", "{label} {count}";
    FILTER_CURRENT = "Active", "进行中", "進行中";
    FILTER_ALL = "All", "全部", "全部";
    RANGE = "Range", "范围", "範圍";
    RANGE_DAY = "Today", "今天", "今天";
    RANGE_WEEK = "Last 7 days", "近 7 天", "近 7 天";
    RANGE_MONTH = "Last 30 days", "近 30 天", "近 30 天";
    RANGE_ALL = "All runs", "全部记录", "全部記錄";
    SEARCH_MATCHES_ONE = "{count} matching task", "找到 {count} 个匹配提醒", "找到 {count} 個符合提醒";
    SEARCH_MATCHES_OTHER = "{count} matching tasks", "找到 {count} 个匹配提醒", "找到 {count} 個符合提醒";
    CLEAR_SEARCH = "Clear search", "清除搜索", "清除搜尋";
    NO_SEARCH_TITLE = "No matching tasks", "没有匹配的提醒", "沒有符合的提醒";
    NO_FILTER_TITLE = "No tasks in this filter", "当前筛选没有提醒", "目前篩選沒有提醒";
    NO_SEARCH_BODY =
        "Change the search terms or status filter to find other tasks.",
        "调整搜索词，或切换状态筛选查看其他提醒。",
        "調整搜尋詞，或切換狀態篩選檢視其他提醒。";
    NO_FILTER_BODY =
        "Change the filter or create a new scheduled task.",
        "切换筛选查看其他状态，或创建新的定时任务。",
        "切換篩選檢視其他狀態，或建立新的定時任務。";
    EMPTY_TITLE = "No scheduled tasks yet", "还没有定时任务", "還沒有定時任務";
    EMPTY_BODY =
        "Create a task so Maka can continue this work at the right time.",
        "创建一个提醒，让 Maka 在指定时间继续这项工作。",
        "建立一個提醒，讓 Maka 在指定時間繼續這項工作。";
    LIST = "Scheduled task list", "定时任务列表", "定時任務列表";
    RUNS_LIST = "Scheduled task run history", "定时任务执行记录", "定時任務執行記錄";
    NO_RUNS_TITLE = "No run history", "暂无执行记录", "暫無執行記錄";
    NO_RUNS_BODY =
        "Triggered tasks, manual runs, and delivery failures appear here.",
        "提醒触发、手动执行或投递失败后，会在这里保留最近记录。",
        "提醒觸發、手動執行或投遞失敗後，會在這裡保留最近記錄。";
    SHOW_ALL_TIME = "All time", "显示全部时间", "顯示全部時間";
    /// Offline: nothing to list yet.
    OFFLINE =
        "Connect to the Runtime Host to see scheduled tasks.",
        "连接到 Runtime Host 后才能查看定时任务。",
        "連線至 Runtime Host 後才能檢視定時任務。";

    // A task's state.
    STATUS_ACTIVE = "Scheduled", "待触发", "待觸發";
    STATUS_PAUSED = "Paused", "已暂停", "已暫停";
    STATUS_COMPLETED = "Completed", "已完成", "已完成";
    STATUS_EXPIRED = "Expired", "已过期", "已過期";
    RUN_OK = "Triggered", "已触发", "已觸發";
    RUN_BLOCKED = "Blocked", "已阻止", "已阻止";
    RUN_FAILED = "Failed", "失败", "失敗";
    NEXT_RUN_AT = "Next run: {time}", "下次触发：{time}", "下次觸發：{time}";
    LAST_RUN_AT = "Last run {time}", "最近 {time}", "最近 {time}";
    UNSCHEDULED = "Not scheduled", "未安排", "未安排";

    // A reminder waiting for the delivery service Maka Desktop provides
    // (the Host's `waiting_for_provider` fire), which this client does not.
    WAITING_FOR_DESKTOP = "Waiting for Maka Desktop", "等待 Maka Desktop 投递", "等待 Maka Desktop 投遞";
    /// Not Desktop's: the same state in a task row's end lane.
    LANE_NEEDS_DESKTOP = "Needs Maka Desktop", "需 Maka Desktop", "需 Maka Desktop";
    NEEDS_DESKTOP =
        "Needs Maka Desktop to deliver reminders.",
        "需要 Maka Desktop 投递提醒。",
        "需要 Maka Desktop 投遞提醒。";
    /// The waiting notice's title, a phrase as the disconnected banner's
    /// is (review round 15).
    WAITING_NOTICE_TITLE = "Needs Maka Desktop", "需要 Maka Desktop", "需要 Maka Desktop";
    /// The waiting notice's line under its title: the subtitle says it
    /// waits, this says why (review round 12), without naming Maka
    /// Desktop a third time (review round 16).
    NEEDS_DESKTOP_FIRES =
        "It fires once connected to this Runtime Host.",
        "连上这个 Runtime Host 后才会触发。",
        "連上這個 Runtime Host 後才會觸發。";
    DESKTOP_DELIVERS =
        "Local notifications and bot messages are delivered by Maka Desktop while it is connected to this Runtime Host.",
        "本地提醒和机器人消息由连接到这个 Runtime Host 的 Maka Desktop 投递。",
        "本地提醒和機器人訊息由連線至這個 Runtime Host 的 Maka Desktop 投遞。";

    // How long until a task's next run.
    COUNTDOWN_OVERDUE = "Overdue", "已过期", "已過期";
    COUNTDOWN_SOON = "Soon", "马上", "馬上";
    COUNTDOWN_MINUTES_ONE = "in {count} minute", "{count} 分钟后", "{count} 分鐘後";
    COUNTDOWN_MINUTES_OTHER = "in {count} minutes", "{count} 分钟后", "{count} 分鐘後";
    COUNTDOWN_HOURS_ONE = "in {count} hour", "{count} 小时后", "{count} 小時後";
    COUNTDOWN_HOURS_OTHER = "in {count} hours", "{count} 小时后", "{count} 小時後";
    COUNTDOWN_TOMORROW = "Tomorrow", "明天", "明天";
    COUNTDOWN_DAYS = "in {count} days", "{count} 天后", "{count} 天後";
    COUNTDOWN_WEEKS_ONE = "in {count} week", "{count} 周后", "{count} 週後";
    COUNTDOWN_WEEKS_OTHER = "in {count} weeks", "{count} 周后", "{count} 週後";
    COUNTDOWN_MONTHS_ONE = "in {count} month", "{count} 个月后", "{count} 個月後";
    COUNTDOWN_MONTHS_OTHER = "in {count} months", "{count} 个月后", "{count} 個月後";

    // How a task repeats.
    RECURRENCE_ONCE = "One-time task", "一次性提醒", "一次性提醒";
    RECURRENCE_CRON = "Cron: {expression}", "Cron：{expression}", "Cron：{expression}";
    /// A task row's word before its cron expression, which follows in mono
    /// after a space (review round 12).
    RECURRENCE_CRON_WORD = "Cron", "Cron", "Cron";
    RECURRENCE_DAILY = "Daily", "每天", "每天";
    RECURRENCE_WEEKLY = "Weekly", "每周", "每週";
    RECURRENCE_MONTHLY = "Monthly", "每月", "每月";
    RECURRENCE_INTERVAL = "Every {seconds} seconds", "每 {seconds} 秒", "每 {seconds} 秒";

    // Where a task delivers.
    DELIVERY_LOCAL = "Local notification", "本地提醒", "本地提醒";
    DELIVERY_AGENT = "Run via the Agent", "交给 Agent 执行", "交給 Agent 執行";
    // Desktop's `botDisplayLabel`: the same names in every language.
    BOT_TELEGRAM = "Telegram", "Telegram", "Telegram";
    BOT_WECHAT = "微信", "微信", "微信";
    BOT_DISCORD = "Discord", "Discord", "Discord";
    BOT_DINGTALK = "钉钉", "钉钉", "钉钉";
    BOT_QQ = "QQ", "QQ", "QQ";
    BOT_SLACK = "Slack", "Slack", "Slack";

    // The task detail.
    DETAIL_ENABLED = "Enabled", "启用", "啟用";
    DETAIL_RECURRENCE = "Repeats", "重复", "重複";
    DETAIL_NEXT_RUN = "Next run", "下次触发", "下次觸發";
    DETAIL_LAST_RUN = "Last run", "最近触发", "最近觸發";
    DETAIL_DELIVERY = "Delivery", "投递", "投遞";
    DETAIL_CREATED = "Created", "创建于", "建立於";
    DETAIL_RUNS = "Run history", "执行记录", "執行記錄";
    DETAIL_NO_RUNS = "This task has not run yet.", "这个任务还没有执行记录。", "這個任務還沒有執行記錄。";
    AGENT_SOURCE = "Agent scheduled task", "Agent 定时任务", "Agent 定時任務";
    AGENT_SOURCE_HINT =
        "When due, Maka starts a new task using the execution settings captured at creation.",
        "到点后，Maka 会使用创建时的执行设置启动新任务。",
        "到點後，Maka 會使用建立時的執行設定啟動新任務。";
    EDIT = "Edit", "编辑", "編輯";
    DUPLICATE = "Duplicate", "复制", "複製";
    TRIGGER_NOW = "Trigger now", "立即触发", "立即觸發";
    TRIGGERING = "Triggering…", "触发中…", "觸發中…";
    SNOOZE = "Snooze 10 minutes", "延后 10 分钟", "延後 10 分鐘";
    SNOOZING = "Snoozing…", "延后中…", "延後中…";
    CLEAR_RUNS = "Clear history", "清空记录", "清空記錄";
    CLEARING = "Clearing…", "清空中…", "清空中…";
    DELETING = "Deleting…", "删除中…", "刪除中…";
    CLEAR_TITLE = "Clear run history for “{name}”?", "清空 “{name}” 的执行记录", "清空 “{name}” 的執行記錄";
    CLEAR_BODY =
        "The scheduled task will remain. Only recent run history and status will be cleared.",
        "定时任务本身会保留；只清空最近执行记录和最近状态。",
        "定時任務本身會保留；只清空最近執行記錄和最近狀態。";
    DELETE_TITLE = "Delete “{name}”?", "删除 “{name}”", "刪除 “{name}”";
    DELETE_BODY =
        "The task and its recent run history will be deleted. This cannot be undone.",
        "该任务和最近执行记录会被删除。该操作不可撤销。",
        "該任務和最近執行記錄會被刪除。該操作不可撤銷。";
    TASK_GONE = "This task is no longer listed.", "这个任务已不在列表中。", "這個任務已不在列表中。";

    // The form.
    FORM_CREATE_TITLE = "New scheduled task", "新建定时任务", "建立定時任務";
    FORM_EDIT_TITLE = "Edit scheduled task", "编辑定时任务", "編輯定時任務";
    USE_TEMPLATE = "Use template", "使用模板", "使用模板";
    FIELD_TITLE = "Title", "标题", "標題";
    FIELD_TIME = "Task time", "提醒时间", "提醒時間";
    FIELD_CLOCK = "Time", "时间", "時間";
    TIME_PLACEHOLDER = "HH:mm", "HH:mm", "HH:mm";
    FIELD_CHANNEL = "Method", "方式", "方式";
    FIELD_RECURRENCE = "Repeat", "重复", "重複";
    FIELD_PLATFORM = "Platform", "平台", "平臺";
    FIELD_CRON = "Cron", "Cron", "Cron";
    FIELD_CHAT_ID = "Chat ID", "Chat ID", "Chat ID";
    FIELD_NOTE = "Notes", "备注", "備註";
    TITLE_PLACEHOLDER =
        "For example: Review project progress tomorrow",
        "例如：明天复盘项目进度",
        "例如：明天復盤專案進度";
    GROUP_SCHEDULE = "Frequency", "频率", "頻率";
    GROUP_DELIVERY = "Delivery", "投递", "投遞";
    PRESETS = "Quick task times", "快速设置提醒时间", "快速設定提醒時間";
    PRESET_TEN_MINUTES = "In 10 minutes", "10 分钟后", "10 分鐘後";
    PRESET_ONE_HOUR = "In 1 hour", "1 小时后", "1 小時後";
    PRESET_TOMORROW = "Tomorrow at 9:00", "明天 9 点", "明天 9 點";
    PRESET_NEXT_MONDAY = "Next Monday at 9:00", "下周一 9 点", "下週一 9 點";
    REPEAT_NONE = "Does not repeat", "不重复", "不重複";
    REPEAT_CRON = "Cron", "Cron", "Cron";
    REPEAT_INTERVAL = "Fixed interval (created by Agent)", "固定间隔（由 Agent 创建）", "固定間隔（由 Agent 建立）";
    CHANNEL_BOT = "Bot chat", "机器人聊天", "機器人聊天";
    CRON_PLACEHOLDER = "For example 0 9 * * 1-5", "例如 0 9 * * 1-5", "例如 0 9 * * 1-5";
    CHAT_ID_PLACEHOLDER = "For example Telegram chat_id", "例如 Telegram chat_id", "例如 Telegram chat_id";
    DELIVERY_HELP =
        "Available delivery providers: {providers}. Other bot platforms are not shown as delivery targets.",
        "当前可投递到 {providers}；其它机器人平台不会出现在投递目标里。",
        "目前可投遞到 {providers}；其它機器人平臺不會出現在投遞目標裡。";
    NOTE_PLACEHOLDER = "Optional context for this task", "可选：补充需要提醒的上下文", "可選：補充需要提醒的上下文";
    SAVING = "Saving…", "保存中…", "儲存中…";
    CREATING = "Creating…", "创建中…", "建立中…";
    SAVE = "Save", "保存", "儲存";
    CREATE_BUTTON = "Create", "创建", "建立";
    DUPLICATE_SUFFIX = " copy", " 副本", " 副本";
    INVALID_TITLE = "Add a title before saving this task.", "填写标题后才能保存提醒。", "填寫標題後才能儲存提醒。";
    INVALID_TIME = "Choose a valid task time.", "选择有效的提醒时间。", "選擇有效的提醒時間。";
    PAST_TIME = "The task time must be in the future.", "提醒时间必须晚于当前时间。", "提醒時間必須晚於目前時間。";
    INVALID_CRON =
        "Cron expressions need five fields, for example 0 9 * * 1-5.",
        "Cron 需要 5 段表达式，例如 0 9 * * 1-5。",
        "Cron 需要 5 段表示式，例如 0 9 * * 1-5。";
    INVALID_CHAT_ID =
        "Enter a Chat ID when delivering to a bot chat.",
        "选择机器人聊天时需要填写 Chat ID。",
        "選擇機器人聊天時需要填寫 Chat ID。";

    // Desktop's four example templates: title, notes, and schedule label.
    TEMPLATE_DOWNLOADS = "Clean up Downloads", "每日下载文件夹清理", "每日下載資料夾清理";
    TEMPLATE_DOWNLOADS_NOTE =
        "Organize screenshots, installers, and temporary documents in Downloads by type, then list items that can be deleted.",
        "请帮我整理「下载」文件夹，把截图、安装包和临时文档按类型归档，并列出可删除项。",
        "請幫我整理「下載」資料夾，把截圖、安裝包和臨時文件按型別歸檔，並列出可刪除項。";
    TEMPLATE_DOWNLOADS_WHEN = "Daily at 18:30", "每天 18:30", "每天 18:30";
    TEMPLATE_MIDDAY = "Midday reset", "午间充电站", "午間充電站";
    TEMPLATE_MIDDAY_NOTE =
        "Review what I completed this morning and create a lightweight, actionable plan for the afternoon.",
        "午休时间到了，帮我回顾上午完成了什么，并给下午列一个轻量可执行计划。",
        "午休時間到了，幫我回顧上午完成了什麼，並給下午列一個輕量可執行計劃。";
    TEMPLATE_MIDDAY_WHEN = "Weekdays at 12:30", "工作日 12:30", "工作日 12:30";
    TEMPLATE_WEEKEND = "Weekend task review", "周末待办整理", "週末待辦整理";
    TEMPLATE_WEEKEND_NOTE =
        "Review completed and unfinished tasks from this week, outline next week, and flag the three highest priorities.",
        "梳理这周完成 / 未完成的待办，输出下周计划，并标记需要优先处理的 3 件事。",
        "梳理這週完成 / 未完成的待辦，輸出下週計劃，並標記需要優先處理的 3 件事。";
    TEMPLATE_WEEKEND_WHEN = "Sundays at 20:00", "每周日 20:00", "每週日 20:00";
    TEMPLATE_NEWS = "Daily news brief", "每日新闻摘要", "每日新聞摘要";
    TEMPLATE_NEWS_NOTE =
        "Summarize five important technology, AI, or Maka stories from today and add one sentence about the impact of each.",
        "总结今天科技 / AI / Maka 相关新闻 5 条，按重要性排序，并给出每条 1 句影响判断。",
        "總結今天科技 / AI / Maka 相關新聞 5 條，按重要性排序，並給出每條 1 句影響判斷。";
    TEMPLATE_NEWS_WHEN = "Daily at 09:30", "每天 09:30", "每天 09:30";

    // What an action says when it fails (`scheduledTaskActions`).
    REFRESH_FAILED = "Failed to refresh tasks", "刷新计划失败", "重新整理計劃失敗";
    REFRESH_FALLBACK =
        "Scheduled tasks could not be refreshed. Try again later.",
        "刷新定时任务失败，请稍后重试。",
        "重新整理定時任務失敗，請稍後重試。";
    CREATE_FAILED = "Failed to create task", "创建计划失败", "建立計劃失敗";
    CREATE_FALLBACK =
        "The scheduled task could not be created. Try again later.",
        "创建定时任务失败，请稍后重试。",
        "建立定時任務失敗，請稍後重試。";
    CREATE_INCOGNITO =
        "Scheduled tasks cannot be created while incognito mode is active.",
        "隐身模式开启时不能创建定时任务。",
        "隱身模式開啟時不能建立定時任務。";
    SAVE_FAILED = "Failed to save task", "保存计划失败", "儲存計劃失敗";
    SAVE_FALLBACK =
        "The scheduled task could not be saved. Try again later.",
        "保存定时任务失败，请稍后重试。",
        "儲存定時任務失敗，請稍後重試。";
    UPDATE_FAILED = "Failed to update task", "更新计划失败", "更新計劃失敗";
    UPDATE_FALLBACK =
        "The scheduled task could not be updated. Try again later.",
        "更新定时任务失败，请稍后重试。",
        "更新定時任務失敗，請稍後重試。";
    TRIGGER_FAILED = "Failed to trigger task", "触发计划失败", "觸發計劃失敗";
    TRIGGER_FALLBACK =
        "The scheduled task could not be triggered. Try again later.",
        "触发定时任务失败，请稍后重试。",
        "觸發定時任務失敗，請稍後重試。";
    SNOOZE_FAILED = "Failed to snooze task", "延后计划失败", "延後計劃失敗";
    SNOOZE_FALLBACK =
        "The scheduled task could not be snoozed. Try again later.",
        "延后定时任务失败，请稍后重试。",
        "延後定時任務失敗，請稍後重試。";
    CLEAR_FAILED = "Failed to clear history", "清空记录失败", "清空記錄失敗";
    CLEAR_FALLBACK =
        "The scheduled-task history could not be cleared. Try again later.",
        "清空定时任务记录失败，请稍后重试。",
        "清空定時任務記錄失敗，請稍後重試。";
    DELETE_FAILED = "Failed to delete task", "删除计划失败", "刪除計劃失敗";
    DELETE_FALLBACK =
        "The scheduled task could not be deleted. Try again later.",
        "删除定时任务失败，请稍后重试。",
        "刪除定時任務失敗，請稍後重試。";

    // The notification when a task fires (`notifications`).
    FIRED_TITLE = "Scheduled task", "定时任务", "定時任務";
    VIEW_SCHEDULED_TASKS = "View scheduled tasks", "查看定时任务", "檢視定時任務";

    // The Daily review tab.
    GENERATE_ANALYSIS = "Generate analysis", "生成分析", "生成分析";
    RETRY_ANALYSIS = "Generate again", "重新生成", "重新生成";
    VIEW_ANALYSIS = "View analysis", "查看分析", "檢視分析";
    BACK_TO_ACTIVITY = "Back to activity", "返回活动", "返回活動";
    /// Opens Settings at Daily review (the settings live there).
    REVIEW_SETTINGS = "Daily review settings", "每日回顾设置", "每日回顧設定";
    REVIEW_RANGE = "Time range", "时间范围", "時間範圍";
    REVIEW_RANGE_DAY = "Today", "今日", "今日";
    REVIEW_RANGE_WEEK = "Last 7 days", "最近 7 天", "最近 7 天";
    REVIEW_RANGE_MONTH = "Last 30 days", "最近 30 天", "最近 30 天";
    DATE_TODAY = "Today", "今天", "今天";
    DATE_YESTERDAY = "Yesterday", "昨天", "昨天";
    DATE_DAYS_AGO = "{count} days ago", "{count} 天前", "{count} 天前";
    DATE_RECENT_7 = "Last 7 days", "最近 7 天", "最近 7 天";
    DATE_RECENT_30 = "Last 30 days", "最近 30 天", "最近 30 天";
    DATE_SHIFTED = "{range} ({days} days earlier)", "{range}（往前 {days} 天）", "{range}（往前 {days} 天）";
    DATE_EARLIER = "View previous day", "查看更早一天", "檢視更早一天";
    DATE_LATER = "View next day", "查看更晚一天", "檢視更晚一天";
    OVERVIEW = "{label} overview", "{label}概览", "{label}概覽";
    REVIEW_REFRESH_FAILED = "Failed to refresh daily review: {error}", "每日回顾刷新失败：{error}", "每日回顧重新整理失敗：{error}";
    METRIC_TASKS = "Tasks", "任务", "任務";
    METRIC_REQUESTS = "Model calls", "模型调用", "請求";
    METRIC_TOKENS = "Tokens", "Token", "Token";
    METRIC_COST = "Cost", "费用", "費用";
    ACTIVE_TASKS = "Active tasks", "活跃任务", "活躍任務";
    EMPTY_TODAY = "Waiting for today's activity", "等待记录今天活动", "等待記錄今天活動";
    EMPTY_RANGE = "No activity for {label}", "{label}无活动", "{label}無活動";
    TASK_COUNT_ONE = "{count} task", "{count} 任务", "{count} 任務";
    TASK_COUNT_OTHER = "{count} tasks", "{count} 任务", "{count} 任務";
    REVIEW_ERROR_FALLBACK =
        "Daily review is temporarily unavailable. Try again later.",
        "每日回顾暂时不可用，请稍后重试。",
        "每日回顧暫時不可用，請稍後重試。";
    SECTION_SUMMARY = "Task summary", "任务摘要", "任務摘要";
    SECTION_GAPS = "Missed items", "遗漏提醒", "遺漏提醒";
    SECTION_USAGE = "Usage insights", "使用洞察", "使用洞察";
    SECTION_CODE = "Code suggestions", "代码建议", "程式碼建議";
    ARCHIVE_OK = "Generated", "已生成", "已生成";
    ARCHIVE_NO_MODEL = "Model unavailable", "缺少模型", "缺少模型";
    ARCHIVE_NO_DATA = "No data", "无数据", "無資料";
    ARCHIVE_FAILED = "Generation failed", "生成失败", "生成失敗";
    ARCHIVE_SKIPPED = "Skipped", "已跳过", "已跳過";
    ARCHIVE_RANGE_DAY = "1 day", "单日", "單日";
    ARCHIVE_RANGE_WEEK = "7 days", "7 天", "7 天";
    ARCHIVE_RANGE_MONTH = "30 days", "30 天", "30 天";
    DEFAULT_MODEL = "Default task model", "默认任务模型", "預設任務模型";
    NO_CONTENT = "This report has no generated content.", "这份报告没有生成正文内容。", "這份報告沒有生成正文內容。";
    NO_CONTENT_HELP = "Nothing archived for this day.", "这一天没有归档内容。", "這一天沒有歸檔內容。";
    EXPORT_COPY = "Copy", "复制", "複製";
    EXPORT_COPYING = "Copying…", "复制中…", "複製中…";
    EXPORT_APPEND = "Add to composer", "粘到输入框", "貼到輸入框";
    EXPORT_APPENDING = "Appending…", "追加中…", "追加中…";
    EXPORT_SAVE = "Save", "保存", "儲存";
    EXPORT_SAVING = "Saving…", "保存中…", "儲存中…";

    // What an export says (`commandActions`).
    REVIEW_COPIED = "{label} review copied", "已复制{label}回顾", "已複製{label}回顧";
    REVIEW_PASTED = "{label} review added to the composer", "已追加{label}回顾到输入框", "已追加{label}回顧到輸入框";
    REVIEW_SAVED = "{label} review saved", "已保存{label}回顾", "已儲存{label}回顧";
    REVIEW_SUMMARY = "{sessions} tasks · {requests} requests", "{sessions} 个任务 · {requests} 个请求", "{sessions} 個任務 · {requests} 個請求";
    SAVE_FAILED_TITLE = "Save failed", "保存失败", "儲存失敗";
    WRITE_FAILED = "The selected location could not be written", "无法写入选择的位置", "無法寫入選擇的位置";
}

/// The page's meta: how many tasks are active.
pub fn active_count(locale: Locale, count: usize) -> String {
    ACTIVE_COUNT.fill(locale, &[("count", &count.to_string())])
}

/// The sidebar entry while tasks are active (`pendingTasks`).
pub fn sidebar_active(locale: Locale, count: usize) -> String {
    SIDEBAR_ACTIVE.fill(locale, &[("count", &count.to_string())])
}

/// The accessible name of the page's tabs.
pub fn hub_content(locale: Locale, module: &str) -> String {
    HUB_CONTENT.fill(locale, &[("module", module)])
}

/// A status filter's option: its label and how many tasks it holds.
pub fn filter_option(locale: Locale, label: &str, count: usize) -> String {
    FILTER_OPTION.fill(locale, &[("label", label), ("count", &count.to_string())])
}

/// The search summary.
pub fn search_matches(locale: Locale, count: usize) -> String {
    plural(count as u64, SEARCH_MATCHES_ONE, SEARCH_MATCHES_OTHER)
        .fill(locale, &[("count", &count.to_string())])
}

pub fn next_run_at(locale: Locale, time: &str) -> String {
    NEXT_RUN_AT.fill(locale, &[("time", time)])
}

pub fn last_run_at(locale: Locale, time: &str) -> String {
    LAST_RUN_AT.fill(locale, &[("time", time)])
}

pub fn recurrence_cron(locale: Locale, expression: &str) -> String {
    RECURRENCE_CRON.fill(locale, &[("expression", expression)])
}

pub fn recurrence_interval(locale: Locale, seconds: u64) -> String {
    RECURRENCE_INTERVAL.fill(locale, &[("seconds", &seconds.to_string())])
}

/// A count of `unit`s ahead, in the countdown's words: `one` or `other`.
pub fn countdown(locale: Locale, count: u64, one: Text, other: Text) -> String {
    plural(count, one, other).fill(locale, &[("count", &count.to_string())])
}

pub fn clear_title(locale: Locale, name: &str) -> String {
    CLEAR_TITLE.fill(locale, &[("name", name)])
}

pub fn delete_title(locale: Locale, name: &str) -> String {
    DELETE_TITLE.fill(locale, &[("name", name)])
}

pub fn delivery_help(locale: Locale, providers: &str) -> String {
    DELIVERY_HELP.fill(locale, &[("providers", providers)])
}

pub fn days_ago(locale: Locale, count: u64) -> String {
    DATE_DAYS_AGO.fill(locale, &[("count", &count.to_string())])
}

pub fn shifted_range(locale: Locale, range: &str, days: u64) -> String {
    DATE_SHIFTED.fill(locale, &[("range", range), ("days", &days.to_string())])
}

pub fn overview(locale: Locale, label: &str) -> String {
    OVERVIEW.fill(locale, &[("label", label)])
}

pub fn review_refresh_failed(locale: Locale, error: &str) -> String {
    REVIEW_REFRESH_FAILED.fill(locale, &[("error", error)])
}

/// "No activity for last 7 days": English lowercases the range, as
/// Desktop does.
pub fn empty_range(locale: Locale, label: &str) -> String {
    let label = if locale == Locale::English { label.to_lowercase() } else { label.to_owned() };
    EMPTY_RANGE.fill(locale, &[("label", &label)])
}

pub fn task_count(locale: Locale, count: u64) -> String {
    plural(count, TASK_COUNT_ONE, TASK_COUNT_OTHER).fill(locale, &[("count", &count.to_string())])
}

pub fn review_copied(locale: Locale, label: &str) -> String {
    REVIEW_COPIED.fill(locale, &[("label", label)])
}

pub fn review_pasted(locale: Locale, label: &str) -> String {
    REVIEW_PASTED.fill(locale, &[("label", label)])
}

pub fn review_saved(locale: Locale, label: &str) -> String {
    REVIEW_SAVED.fill(locale, &[("label", label)])
}

pub fn review_summary(locale: Locale, sessions: u64, requests: u64) -> String {
    REVIEW_SUMMARY
        .fill(locale, &[("sessions", &sessions.to_string()), ("requests", &requests.to_string())])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counted_phrases_agree_with_their_count() {
        assert_eq!(search_matches(Locale::English, 1), "1 matching task");
        assert_eq!(search_matches(Locale::English, 2), "2 matching tasks");
        assert_eq!(search_matches(Locale::SimplifiedChinese, 2), "找到 2 个匹配提醒");
        assert_eq!(
            countdown(Locale::English, 1, COUNTDOWN_HOURS_ONE, COUNTDOWN_HOURS_OTHER),
            "in 1 hour"
        );
        assert_eq!(task_count(Locale::English, 1), "1 task");
        assert_eq!(review_summary(Locale::SimplifiedChinese, 0, 0), "0 个任务 · 0 个请求");
        assert_eq!(sidebar_active(Locale::SimplifiedChinese, 3), "定时任务，3 条进行中");
    }

    #[test]
    fn an_empty_range_lowercases_its_label_in_english_only() {
        assert_eq!(empty_range(Locale::English, "Last 7 days"), "No activity for last 7 days");
        assert_eq!(empty_range(Locale::SimplifiedChinese, "最近 7 天"), "最近 7 天无活动");
    }
}
