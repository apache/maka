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

//! Interface copy: every string a person reads, in English, Simplified
//! Chinese, and Traditional Chinese.
//!
//! Each key is a [`Text`] constant named after its intent rather than its
//! words; views read it in the app's current [`Locale`] with
//! [`Text::get`], so switching the language redraws every window in the new
//! one. A sentence with a variable part is one template with `{name}`
//! placeholders, filled by a function here, never pieced together from
//! fragments. Counted phrases pick their form with [`plural`].
//!
//! Sentence case in English; native menu commands use title case (macOS
//! convention); the single ellipsis character, never three dots. Chinese
//! reuses Maka Desktop's terms (`apps/desktop/src/renderer/locales/*.ts`)
//! and full-width punctuation.
//!
//! The shell, the sidebar, the empty state, and the menus use this module
//! directly; a feature with more copy than that keeps it in its own
//! submodule ([`conversation`], [`settings`], [`models`], [`providers`],
//! [`commands`], [`extensions`], [`search`]).

use std::path::Path;

/// Declares the `Text` constants of one copy module and `TEXTS`, the list
/// of all of them by name, which the table test walks. Each entry is
/// `NAME = english, simplified_chinese, traditional_chinese;`, so a key
/// cannot exist without all three.
macro_rules! texts {
    ($($(#[$meta:meta])* $name:ident = $en:expr, $zh_cn:expr, $zh_tw:expr;)*) => {
        $($(#[$meta])* pub const $name: $crate::copy::Text = $crate::copy::Text::new($en, $zh_cn, $zh_tw);)*

        /// Every text of this module, by name.
        pub const TEXTS: &[(&str, $crate::copy::Text)] = &[$((stringify!($name), $name),)*];
    };
}

pub mod appearance;
pub mod automations;
pub mod bots;
pub mod commands;
pub mod conversation;
pub mod extensions;
pub mod files;
pub mod health;
pub mod host;
pub mod inspector;
pub mod memory;
pub mod models;
pub mod providers;
pub mod remote_hosts;
pub mod review;
pub mod search;
pub mod settings;
pub mod side_chat;
pub mod subagents;
pub mod system;
pub mod tasks;
pub mod terminal;
mod text;
pub mod usage;
pub mod web_search;
pub mod workbar;

pub use text::{Locale, Text, plural};

texts! {

    APP_NAME = "Maka", "Maka", "Maka";

    // The sidebar footer: which Host the window talks to, its state, and the
    // State Root as a badge. The Host has no display name of its own; the one
    // this client starts and reaches over a local socket is the local Host.
    // Chinese uses Maka Desktop's name for it, "本机 Runtime Host" (the
    // `hostEndpoint` and `thisRuntimeHost` strings of
    // apps/desktop/src/renderer/locales/peer-mesh-copy.ts), where Runtime
    // Host stays a product name rather than a half-translated "Host".
    HOST_LOCAL = "Local Host", "本机 Runtime Host", "本機 Runtime Host";
    // The sidebar footer is 256pt wide and must keep the data-folder badge
    // whole, so it shows the short form; the accessible name keeps the term.
    HOST_LOCAL_SHORT = "Local Host", "本机", "本機";
    /// The footer menu's first item, which opens settings.
    SETTINGS_ITEM = "Settings…", "设置…", "設定…";
    /// The footer menu's last item, which opens the State Root dialog. A
    /// person knows the State Root as the folder Maka keeps its data in.
    SWITCH_STATE_ROOT = "Switch data folder…", "切换数据文件夹…", "切換資料夾…";

    // Connection state, in the sidebar footer next to the Host name.
    STATUS_CONNECTING = "Connecting…", "正在连接…", "正在連線…";
    STATUS_STARTING = "Starting…", "正在启动…", "正在啟動…";
    STATUS_CONNECTED = "Connected", "已连接", "已連線";
    STATUS_RECONNECTING = "Reconnecting…", "正在重新连接…", "正在重新連線…";
    STATUS_DISCONNECTED = "Disconnected", "未连接", "未連線";

    // Disconnected strip. While the window starts a Host itself it shows
    // `HOST_STARTING`; when that fails, the reason and Retry, with the manual
    // command as a fallback.
    HOST_STARTING = "Starting Maka…", "正在启动 Maka…", "正在啟動 Maka…";
    DISCONNECTED_TITLE =
        "Not connected to the Runtime Host",
        "未连接到 Runtime Host",
        "未連線至 Runtime Host";
    DISCONNECTED_SUSPENDED =
        "Automatic retries stopped. Fix the problem, then retry.",
        "已停止自动重试。请先解决问题，再重试。",
        "已停止自動重試。請先解決問題，再重試。";
    DISCONNECTED_START_HINT =
        "Or start a Host yourself from the Maka checkout:",
        "也可以在 Maka 源码目录中自行启动 Host：",
        "也可以在 Maka 原始碼目錄中自行啟動 Host：";

    // The State Root dialog: first launch, and Switch data folder…. The
    // dialog calls the State Root the data folder, as the menus do.
    STATE_ROOT_TITLE = "Choose where Maka keeps its data", "选择 Maka 保存数据的位置", "選擇 Maka 儲存資料的位置";
    STATE_ROOT_HINT =
        "Tasks, settings, and model connections are stored in this folder. Maka creates it if it \
     doesn’t exist. You can change it later with Switch data folder….",
        "任务、设置和模型连接都保存在这个文件夹中。文件夹不存在时，Maka 会自动创建。之后可以通过「切换数据文件夹…」更换。",
        "任務、設定和模型連線都儲存在這個資料夾中。資料夾不存在時，Maka 會自動建立。之後可以透過「切換資料夾…」更換。";
    /// The accessible name of the chosen folder.
    STATE_ROOT_FOLDER = "Data folder", "数据文件夹", "資料夾";
    STATE_ROOT_CHOOSE = "Choose folder…", "选择文件夹…", "選擇資料夾…";
    STATE_ROOT_DESKTOP_REFUSED =
        "This folder holds Maka Desktop’s data. Choose a separate folder.",
        "这个文件夹存放着 Maka Desktop 的数据，请另选一个文件夹。",
        "這個資料夾存放著 Maka Desktop 的資料，請另選一個資料夾。";
    STATE_ROOT_SAVE_FAILED = "Couldn’t remember this folder:", "无法记住这个文件夹：", "無法記住這個資料夾：";
    CONTINUE = "Continue", "继续", "繼續";
    CANCEL = "Cancel", "取消", "取消";
    /// A dialog's close button (Astryx's `@astryx.dialog.close`).
    CLOSE = "Close", "关闭", "關閉";

    // Sidebar. The user-facing word for a session is "task", as in Maka Desktop.
    NEW_TASK = "New task", "新任务", "新任務";
    TASKS_EMPTY = "No tasks yet", "还没有任务", "還沒有任務";
    /// The task list with nothing loaded once the first connection failed.
    TASKS_OFFLINE = "Not connected to the Runtime Host", "未连接到 Runtime Host", "未連線到 Runtime Host";
    TASKS_LOAD_FAILED = "Couldn’t load tasks.", "无法加载任务。", "無法載入任務。";
    RETRY = "Retry", "重试", "重試";
    /// The default button of the platform folder dialog.
    FOLDER_CHOOSE_BUTTON = "Choose", "选择", "選擇";
    /// The project picker's command that asks for a folder and adds it as
    /// a project (Maka Desktop's `workspace.newProject`).
    NEW_PROJECT = "New project…", "新建项目…", "新增專案…";
    /// The project picker's name and tooltip, and its label while no
    /// project is chosen (Desktop's `workspace.choose`).
    CHOOSE_PROJECT = "Choose project", "选择项目", "選擇專案";
    /// The "+" on a project's heading in the task list (Desktop's
    /// `projectNewTask`, named for its project).
    NEW_TASK_IN = "New task in {project}", "在 {project} 中新建任务", "在 {project} 中建立任務";
    /// The project picker's command that opens Settings at Workspace,
    /// where the projects are.
    MANAGE_PROJECTS = "Manage projects…", "管理项目…", "管理專案…";
    /// Shown after a project whose folder is gone; it cannot take new tasks.
    PROJECT_MISSING = "Folder missing", "文件夹不存在", "資料夾不存在";
    PROJECT_REGISTER_FAILED =
        "Couldn’t add the folder as a project.",
        "无法将该文件夹添加为项目。",
        "無法將該資料夾新增為專案。";
    PROJECT_RENAME_FAILED = "Couldn’t rename the project.", "重命名项目失败。", "重新命名專案失敗。";
    PROJECT_ARCHIVE_FAILED = "Couldn’t archive the project.", "归档项目失败。", "歸檔專案失敗。";
    PROJECT_RESTORE_FAILED = "Couldn’t restore the project.", "恢复项目失败。", "恢復專案失敗。";
    PROJECT_RELINK_FAILED = "Couldn’t relink the project.", "重新定位项目失败。", "重新定位專案失敗。";
    NEW_TASK_FAILED = "Couldn’t create a task.", "新建任务失败。", "建立任務失敗。";
    /// Announced for a task whose turn runs; the row shows a spinner.
    TASK_RUNNING = "Running", "进行中", "進行中";
    /// What a task is called when its name is empty (see [`task_title`]).
    UNTITLED_TASK = "New task", "新任务", "新任務";

    // The sidebar toggle at the start of the main header: its tooltip and
    // accessible name, which say what a click does.
    SIDEBAR_HIDE = "Hide sidebar", "收起侧边栏", "收起側邊欄";
    SIDEBAR_SHOW = "Show sidebar", "展开侧边栏", "展開側邊欄";
    /// The accessible name of the handle on the sidebar's edge (Astryx's
    /// `@astryx.sideNav.resizeSidebar`, which Desktop's sidebar uses).
    RESIZE_SIDEBAR = "Resize sidebar", "调整侧边栏尺寸", "調整側邊欄大小";
    // Back and forward through the tasks this window showed, beside the toggle.
    GO_BACK = "Back", "后退", "後退";
    GO_FORWARD = "Forward", "前进", "前進";

    // Time groups of the task list, and the compact age of a row.
    GROUP_TODAY = "Today", "今天", "今天";
    GROUP_YESTERDAY = "Yesterday", "昨天", "昨天";
    GROUP_THIS_WEEK = "This week", "本周", "本週";
    GROUP_EARLIER = "Earlier", "更早", "更早";
    AGE_JUST_NOW = "just now", "刚刚", "剛剛";
    /// A sidebar row's age in its first minute: one short word for the
    /// row's 40px lane.
    AGE_NOW = "now", "刚刚", "剛剛";
    /// The row after a day group's first tasks that lists the rest.
    SHOW_MORE = "Show more", "显示更多", "顯示更多";

    // The switch above the task list that groups it (Maka's 按时间 /
    // 按项目).
    GROUP_BY_TIME = "By time", "按时间", "按時間";
    GROUP_BY_PROJECT = "By project", "按项目", "按專案";
    /// The accessible name of that switch.
    GROUPING_LABEL = "Group tasks", "任务分组方式", "任務分組方式";
    /// By project, the group of the tasks that run in no project, after the
    /// projects' groups (Desktop's `projects.ungrouped`).
    GROUP_NO_PROJECT = "No project", "未归属项目", "未歸屬專案";

    /// The collapsible group at the end of the list that holds archived tasks.
    GROUP_ARCHIVED = "Archived", "已归档", "已歸檔";

    // Commands on one task: its context menu (right-click, the "…" button, or
    // Shift-F10) and what they report.
    TASK_RENAME = "Rename", "重命名", "重新命名";
    /// The accessible name of the inline field that renames a task.
    TASK_NAME_FIELD = "Task name", "任务名称", "任務名稱";
    TASK_FLAG = "Flag", "标记", "標記";
    TASK_UNFLAG = "Unflag", "取消标记", "取消標記";
    /// Announced for a flagged task; the row shows a flag.
    TASK_FLAGGED = "Flagged", "已标记", "已標記";
    TASK_ARCHIVE = "Archive", "归档", "歸檔";
    TASK_UNARCHIVE = "Unarchive", "取消归档", "取消歸檔";
    TASK_COPY_ID = "Copy task ID", "复制任务 ID", "複製任務 ID";
    /// Offered only on archived tasks, as Maka Desktop does: archiving first
    /// makes the intent deliberate.
    TASK_DELETE = "Delete…", "删除…", "刪除…";

    // The folder button before the task's title in the main pane's header,
    // and its menu (Desktop's `TitlebarSessionIdentity`).
    PROJECT_INFO = "Project information", "项目信息", "專案資訊";
    OPEN_PROJECT_FOLDER = "Open project folder", "打开项目文件夹", "開啟專案資料夾";
    COPY_PROJECT_PATH = "Copy path", "复制路径", "複製路徑";
    DELETE = "Delete", "删除", "刪除";
    DELETE_TASK_BODY =
        "Its transcript is deleted too. This can’t be undone.",
        "其对话记录也会一并删除。该操作不可撤销。",
        "其對話記錄也會一併刪除。該操作不可撤銷。";
    TASK_RENAME_FAILED = "Couldn’t rename the task.", "重命名任务失败。", "重新命名任務失敗。";
    TASK_FLAG_FAILED = "Couldn’t change the task’s flag.", "更改任务标记失败。", "變更任務標記失敗。";
    TASK_ARCHIVE_FAILED = "Couldn’t archive the task.", "归档任务失败。", "歸檔任務失敗。";
    TASK_UNARCHIVE_FAILED = "Couldn’t unarchive the task.", "取消归档失败。", "取消歸檔失敗。";
    TASK_DELETE_FAILED = "Couldn’t delete the task.", "删除任务失败。", "刪除任務失敗。";
    TASK_CHANGED = "It changed in the meantime; try again.", "任务在此期间已发生变化，请重试。", "任務在此期間已變更，請重試。";

    // Empty state of the main pane.
    /// The empty state's display line, an invitation rather than a status.
    EMPTY_STATE_TITLE = "What should we work on?", "要做点什么？", "要做點什麼？";

    // Menus.
    MENU_QUIT = "Quit Maka", "退出 Maka", "結束 Maka";
    MENU_SETTINGS = "Settings…", "设置…", "設定…";
    MENU_TASK = "Task", "任务", "任務";
    MENU_NEW_TASK = "New Task", "新建任务", "建立任務";
    MENU_FOCUS_COMPOSER = "Focus Composer", "聚焦输入框", "聚焦輸入框";
    MENU_SEND = "Send Message", "发送消息", "傳送訊息";
    MENU_STOP = "Stop Turn", "停止本轮", "停止本輪";
    MENU_VIEW = "View", "显示", "顯示";
    MENU_COMMAND_PALETTE = "Command Palette…", "命令面板…", "命令面板…";
    MENU_KEYBOARD_SHORTCUTS = "Keyboard Shortcuts…", "键盘快捷键…", "鍵盤快捷鍵…";
    MENU_TOGGLE_SIDEBAR = "Toggle Sidebar", "切换侧边栏", "切換側邊欄";
    MENU_GO_BACK = "Back", "后退", "後退";
    MENU_GO_FORWARD = "Forward", "前进", "前進";
    MENU_ACTUAL_SIZE = "Actual Size", "实际大小", "實際大小";
    MENU_ZOOM_IN = "Zoom In", "放大", "放大";
    MENU_ZOOM_OUT = "Zoom Out", "缩小", "縮小";
    MENU_HOST = "Host", "Host", "Host";
    MENU_RECONNECT = "Reconnect to Host", "重新连接 Host", "重新連線 Host";
    MENU_ADD_CONNECTION = "Add Connection…", "添加连接…", "新增連線…";
    MENU_SWITCH_STATE_ROOT = "Switch Data Folder…", "切换数据文件夹…", "切換資料夾…";

    // Sentences with a variable part.
    /// The footer row's accessible name.
    FOOTER_LABEL =
        "Local Host, {status}, data folder {root}",
        "本机 Runtime Host，{status}，数据文件夹 {root}",
        "本機 Runtime Host，{status}，資料夾 {root}";
    /// A task row's "…" button.
    TASK_ACTIONS_LABEL = "Actions for {title}", "{title} 任务操作", "{title} 任務操作";
    /// The delete confirmation's title.
    DELETE_TASK_TITLE = "Delete “{title}”?", "删除「{title}」？", "刪除「{title}」？";
    /// The delete confirmation's line about linked subtasks.
    DELETE_TASK_SUBTASKS_ONE =
        "Its {count} subtask moves to the archive.",
        "其 {count} 个子任务将移入归档。",
        "其 {count} 個子任務將移入歸檔。";
    DELETE_TASK_SUBTASKS_OTHER =
        "Its {count} subtasks move to the archive.",
        "其 {count} 个子任务将移入归档。",
        "其 {count} 個子任務將移入歸檔。";
    /// The "Show more" row's accessible name.
    SHOW_MORE_LABEL_ONE =
        "Show {count} more task in {group}",
        "显示「{group}」中的另外 {count} 个任务",
        "顯示「{group}」中的另外 {count} 個任務";
    SHOW_MORE_LABEL_OTHER =
        "Show {count} more tasks in {group}",
        "显示「{group}」中的另外 {count} 个任务",
        "顯示「{group}」中的另外 {count} 個任務";
    /// The disconnected strip while it waits to retry.
    RETRY_IN = "Trying again in {seconds} s.", "{seconds} 秒后重试。", "{seconds} 秒後重試。";
    /// The copy button beside the serve command.
    COPY_COMMAND = "Copy command", "复制命令", "複製命令";

    // Relative time, as Maka's `formatRelativeTimestamp`
    // (packages/core/src/relative-time.ts) words it through
    // `Intl.RelativeTimeFormat` with `numeric: "auto"`.
    AGO_MINUTES_ONE = "{count} minute ago", "{count}分钟前", "{count} 分鐘前";
    AGO_MINUTES_OTHER = "{count} minutes ago", "{count}分钟前", "{count} 分鐘前";
    AGO_HOURS_ONE = "{count} hour ago", "{count}小时前", "{count} 小時前";
    AGO_HOURS_OTHER = "{count} hours ago", "{count}小时前", "{count} 小時前";
    AGO_YESTERDAY = "yesterday", "昨天", "昨天";
    /// Two days ago: Chinese has a word for it.
    AGO_TWO_DAYS = "2 days ago", "前天", "前天";
    AGO_DAYS = "{count} days ago", "{count}天前", "{count} 天前";
    /// Before and after noon, in a 12-hour time.
    TIME_AM = "AM", "上午", "上午";
    TIME_PM = "PM", "下午", "下午";

    // Joining pieces that are not sentences of their own.
    /// A label and its value, as an accessible name or a status line.
    LABELED = "{label}: {value}", "{label}：{value}", "{label}：{value}";
    /// Items of a list read inline.
    LIST_SEPARATOR = ", ", "、", "、";
    /// Parts of an accessible name, read as a pause.
    PART_SEPARATOR = ", ", "，", "，";
    /// Two short phrases of an accessible name.
    PHRASES = "{first}. {second}", "{first}。{second}", "{first}。{second}";
    /// Two complete sentences, one after the other.
    SENTENCES = "{first} {second}", "{first}{second}", "{first}{second}";
}

/// Every key of the copy table, by module and name: what the table test
/// walks.
pub fn all_texts() -> impl Iterator<Item = (&'static str, &'static str, Text)> {
    let module = |module: &'static str, texts: &'static [(&'static str, Text)]| {
        texts.iter().map(move |(name, text)| (module, *name, *text))
    };
    module("copy", TEXTS)
        .chain(module("appearance", appearance::TEXTS))
        .chain(module("conversation", conversation::TEXTS))
        .chain(module("settings", settings::TEXTS))
        .chain(module("commands", commands::TEXTS))
        .chain(module("extensions", extensions::TEXTS))
        .chain(module("host", host::TEXTS))
        .chain(module("automations", automations::TEXTS))
        .chain(module("models", models::TEXTS))
        .chain(module("subagents", subagents::TEXTS))
        .chain(module("memory", memory::TEXTS))
        .chain(module("web_search", web_search::TEXTS))
        .chain(module("system", system::TEXTS))
        .chain(module("tasks", tasks::TEXTS))
        .chain(module("usage", usage::TEXTS))
        .chain(module("health", health::TEXTS))
        .chain(module("bots", bots::TEXTS))
        .chain(module("remote_hosts", remote_hosts::TEXTS))
        .chain(module("review", review::TEXTS))
        .chain(module("search", search::TEXTS))
        .chain(module("terminal", terminal::TEXTS))
        .chain(module("workbar", workbar::TEXTS))
        .chain(module("files", files::TEXTS))
        .chain(module("inspector", inspector::TEXTS))
        .chain(module("side_chat", side_chat::TEXTS))
}

/// The accessible name of the footer row, which opens the footer menu.
pub fn footer_label(locale: Locale, status: &str, state_root: &str) -> String {
    FOOTER_LABEL.fill(locale, &[("status", status), ("root", state_root)])
}

/// The accessible name of a task row's "…" button.
pub fn task_actions_label(locale: Locale, title: &str) -> String {
    TASK_ACTIONS_LABEL.fill(locale, &[("title", title)])
}

/// The delete confirmation's title.
pub fn delete_task_title(locale: Locale, title: &str) -> String {
    DELETE_TASK_TITLE.fill(locale, &[("title", title)])
}

/// The delete confirmation's line about linked subtasks.
pub fn delete_task_subtasks(locale: Locale, count: u64) -> String {
    plural(count, DELETE_TASK_SUBTASKS_ONE, DELETE_TASK_SUBTASKS_OTHER)
        .fill(locale, &[("count", &count.to_string())])
}

/// The "Show more" row's accessible name: how many tasks it reveals, where.
pub fn show_more_label(locale: Locale, hidden: usize, group: &str) -> String {
    plural(hidden as u64, SHOW_MORE_LABEL_ONE, SHOW_MORE_LABEL_OTHER)
        .fill(locale, &[("count", &hidden.to_string()), ("group", group)])
}

/// The name and tooltip of the "+" that starts a task in `project`.
pub fn new_task_in(locale: Locale, project: &str) -> String {
    NEW_TASK_IN.fill(locale, &[("project", project)])
}

/// The disconnected strip's line while it waits `seconds` to retry.
pub fn retry_in(locale: Locale, seconds: u64) -> String {
    RETRY_IN.fill(locale, &[("seconds", &seconds.to_string())])
}

/// `label: value`, with the locale's colon.
pub fn labeled(locale: Locale, label: &str, value: &str) -> String {
    LABELED.fill(locale, &[("label", label), ("value", value)])
}

/// Parts of an accessible name joined with the locale's pause.
pub fn parts(locale: Locale, parts: &[&str]) -> String {
    parts.join(PART_SEPARATOR.in_locale(locale))
}

/// Items of an inline list joined with the locale's separator.
pub fn list(locale: Locale, items: &[&str]) -> String {
    items.join(LIST_SEPARATOR.in_locale(locale))
}

/// Two short phrases of an accessible name ("Thinking. Show reasoning").
pub fn phrases(locale: Locale, first: &str, second: &str) -> String {
    PHRASES.fill(locale, &[("first", first), ("second", second)])
}

/// Two complete sentences, spaced as the locale spaces them.
pub fn sentences(locale: Locale, first: &str, second: &str) -> String {
    SENTENCES.fill(locale, &[("first", first), ("second", second)])
}

/// A failed request: what failed, then the reason as its own sentence.
/// Reasons come from the Runtime Host or the system in English, starting
/// lowercase and ending without a period; they are capitalized and closed
/// so they read as a sentence after the translated one.
pub fn failure(locale: Locale, what: &str, reason: &str) -> String {
    let reason = reason.trim();
    let mut chars = reason.chars();
    let Some(first) = chars.next() else {
        return what.to_owned();
    };
    let end = if reason.ends_with(['.', '!', '?', '。', '！', '？']) { "" } else { "." };
    let reason = format!("{}{}{end}", first.to_uppercase(), chars.as_str());
    sentences(locale, what, &reason)
}

/// A task's stored name as the sidebar and the header show it. A name taken
/// from Markdown text can start with a heading marker (`# `, `## `, …):
/// that marker and the surrounding whitespace are dropped. Only a marker
/// CommonMark reads as a heading counts (one to six `#`, then whitespace or
/// the end), so `#hashtag` stays as it is. The stored name is not changed.
/// `None` when nothing is left, or when the name is still the one the Host
/// gives a task it creates ([`HOST_DEFAULT_TASK_NAME`]) and has not yet
/// replaced with one taken from the first message: the caller shows
/// [`UNTITLED_TASK`], in the interface language.
pub fn task_title_text(name: &str) -> Option<&str> {
    let name = name.trim();
    let rest = name.trim_start_matches('#');
    let hashes = name.len() - rest.len();
    let heading = (1..=6).contains(&hashes) && (rest.is_empty() || rest.starts_with([' ', '\t']));
    let title = if heading { rest.trim_start() } else { name };
    (!title.is_empty() && title != HOST_DEFAULT_TASK_NAME).then_some(title)
}

/// The name the Host gives a task it creates without one:
/// `DEFAULT_SESSION_NAME` in Maka's `packages/core/src/session-name.ts`.
/// It is English in every locale, so it is shown as [`UNTITLED_TASK`].
pub const HOST_DEFAULT_TASK_NAME: &str = "New Chat";

/// [`task_title_text`], or [`UNTITLED_TASK`] in `locale`.
pub fn task_title(locale: Locale, name: &str) -> &str {
    task_title_text(name).unwrap_or(UNTITLED_TASK.in_locale(locale))
}

/// The command that starts a development Host for the State Root at `root`,
/// as documented in `docs/dev-host.md`. Run it in the Maka checkout
/// (`$MAKA_REPO`, default `~/code/maka-pin`) with Node 24.18.
pub fn serve_command(root: &Path) -> String {
    format!(
        "node packages/cli/dist/dev-cli.js runtime-host serve --root \"{}\" --json",
        root.display()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const EN: Locale = Locale::English;
    const ZH: Locale = Locale::SimplifiedChinese;

    #[test]
    fn serve_command_names_the_state_root() {
        assert_eq!(
            serve_command(Path::new("/tmp/dev root")),
            "node packages/cli/dist/dev-cli.js runtime-host serve --root \"/tmp/dev root\" --json"
        );
    }

    #[test]
    fn a_task_title_drops_a_leading_heading_marker_and_whitespace() {
        for (name, title) in [
            ("# Title", "Title"),
            ("## Title", "Title"),
            ("  ###   Title  ", "Title"),
            ("#\tTitle", "Title"),
            ("# 了解Rust：一种安全且高效的编程语言", "了解Rust：一种安全且高效的编程语言"),
            ("  Plain title \n", "Plain title"),
            ("# Title # with a hash", "Title # with a hash"),
        ] {
            assert_eq!(task_title(EN, name), title, "{name:?}");
        }
    }

    #[test]
    fn a_hash_that_does_not_start_a_heading_stays() {
        for name in ["#hashtag", "#1 priority", "C# tips", "####### seven"] {
            assert_eq!(task_title(EN, name), name);
        }
    }

    #[test]
    fn a_task_title_with_nothing_left_reads_as_untitled_in_the_locale() {
        for name in ["#", "##", "###   ", "", "   ", "\n", "New Chat", " New Chat "] {
            assert_eq!(task_title(EN, name), UNTITLED_TASK.en(), "{name:?}");
            assert_eq!(task_title(ZH, name), UNTITLED_TASK.in_locale(ZH), "{name:?}");
        }
    }

    #[test]
    fn counted_phrases_agree_with_their_count() {
        assert_eq!(delete_task_subtasks(EN, 1), "Its 1 subtask moves to the archive.");
        assert_eq!(delete_task_subtasks(EN, 3), "Its 3 subtasks move to the archive.");
        assert_eq!(show_more_label(EN, 2, "Today"), "Show 2 more tasks in Today");
        assert!(delete_task_subtasks(ZH, 3).contains('3'));
    }

    #[test]
    fn failures_read_as_two_sentences() {
        let what = TASK_RENAME_FAILED.en();
        assert_eq!(failure(EN, what, ""), what);
        assert_eq!(
            failure(EN, what, "not connected to the Runtime Host"),
            "Couldn’t rename the task. Not connected to the Runtime Host."
        );
        let what = TASK_RENAME_FAILED.in_locale(ZH);
        assert_eq!(failure(ZH, what, "timed out"), format!("{what}Timed out."));
    }

    /// Every key exists in all three locales (the macro makes a key without
    /// one impossible), none is empty, the Chinese ones are translated, the
    /// placeholders agree, and the punctuation follows each language.
    #[test]
    fn every_key_is_translated_into_every_locale() {
        // Names and symbols that read the same in every language.
        const SAME_IN_EVERY_LOCALE: &[&str] = &[
            "APP_NAME",
            // This client's name, a product name in every locale.
            "ABOUT_CLIENT",
            "LIST_SEPARATOR",
            "PART_SEPARATOR",
            "LABELED",
            "SENTENCES",
            "FOOTER_SEPARATOR",
            "THINKING_PREVIEW_SEPARATOR",
            "PHRASES",
            "PROTOCOL_EPOCHS",
            "SHORTCUT_LABEL",
            // Terms Maka Desktop keeps in English in Chinese.
            "MENU_HOST",
            "GROUP_HOST",
            "ABOUT_HOST",
            "API_KEY",
            "BADGE_BETA",
            "CODE_MODE",
            "SHELL_GIT_BASH",
            // Palette names Desktop keeps as they are, and units.
            "PALETTE_ONEDARK",
            "PALETTE_CATPPUCCIN",
            "PALETTE_TOKYO_NIGHT",
            "PALETTE_NORD",
            "PROXY_LATENCY",
            "FONT_SIZE_UNIT",
            // The Scheduled tasks page: cron and bot terms Desktop keeps in
            // English, brand names, and a count after its label.
            "FILTER_OPTION",
            "RECURRENCE_CRON",
            "REPEAT_CRON",
            "FIELD_CRON",
            "RECURRENCE_CRON_WORD",
            "FIELD_CHAT_ID",
            "TIME_PLACEHOLDER",
            "METRIC_TOKENS",
            "BOT_TELEGRAM",
            "BOT_DISCORD",
            "BOT_QQ",
            "BOT_SLACK",
            // The Models page's brand-like names.
            "GROUP_API",
            "ACCOUNT_ID",
            "FAST_ON",
            "ROW_LABEL_STATUS",
            // The Usage page's range and token words Desktop keeps as they are.
            "RANGE_24H",
            "HEADER_TOKENS",
            // The license line, as Desktop writes it in every locale.
            "ABOUT_LICENSE",
            // Remote access: brand names, and the token and connection
            // terms Desktop keeps in English.
            "PROVIDER_TELEGRAM",
            "PROVIDER_DISCORD",
            "PROVIDER_QQ",
            "PROVIDER_SLACK",
            "PROVIDER_LARK",
            "LARK_OPTION",
            "CONNECTION_WEBHOOK",
            "TELEGRAM_TOKEN",
            "DISCORD_TOKEN",
            "SLACK_TOKEN",
            "SLACK_APP_TOKEN",
            "QQ_SECRET",
            "INVALID_USERS_SEPARATOR",
            // The Search page's name for Maka's messages: the product's.
            "ROLE_MAKA",
            // Quotation marks around a name.
            "QUOTED",
            // Runtime Host terms Desktop keeps in English in Chinese.
            "HOST_BLOCK_TITLE",
            "TRANSPORT_TLS",
            "TRANSPORT_SSH",
            "STATE_ROOT_ID",
            "PLATFORM_WINDOWS",
            // The Files face: a count of a count, and kinds Desktop keeps
            // in English.
            "FILTER_COUNT",
            "KIND_HTML",
            "KIND_PDF",
        ];
        let mut names = std::collections::HashSet::new();
        let mut count = 0;
        for (module, name, text) in all_texts() {
            count += 1;
            assert!(names.insert((module, name)), "{module}::{name} is declared twice");
            let english = text.en();
            for locale in Locale::ALL {
                let value = text.in_locale(locale);
                assert!(
                    !value.trim().is_empty() || name.ends_with("SEPARATOR"),
                    "{module}::{name} is empty in {locale:?}"
                );
                assert!(!value.contains("..."), "{module}::{name} uses three dots in {locale:?}");
                // This client has no WorkHub (phase 3 holds it back).
                assert!(!value.contains("WorkHub"), "{module}::{name} names WorkHub in {locale:?}");
                assert_eq!(
                    text.placeholders(locale),
                    text.placeholders(EN),
                    "{module}::{name} has different placeholders in {locale:?}"
                );
                if locale != EN && !SAME_IN_EVERY_LOCALE.contains(&name) {
                    assert!(
                        value.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c)),
                        "{module}::{name} is not translated into {locale:?}: {value:?}"
                    );
                    assert!(
                        !value.contains(". ") && !value.ends_with('.') || value.contains("{"),
                        "{module}::{name} ends a sentence with an English period in {locale:?}: {value:?}"
                    );
                }
            }
            assert!(
                !english.contains('\u{3002}'),
                "{module}::{name} has a Chinese period in English"
            );
        }
        assert!(count > 300, "the table walks every module ({count} keys)");
    }
}
