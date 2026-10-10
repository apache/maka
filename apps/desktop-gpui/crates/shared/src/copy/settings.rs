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

//! Interface copy of the settings feature: the settings surface's
//! navigation and pages, the preferences, and the words the Models page
//! shares with them (its own are in [`super::models`]).
//! Same rules as the parent module.
//!
//! The navigation's groups, the section names, and the one-line page
//! descriptions are Maka Desktop's
//! (apps/desktop/src/renderer/locales/settings-navigation-copy.ts), as are
//! the General and Appearance rows (settings-preferences-copy.ts) and "Back
//! to app" (settings-shared-copy.ts).
//!
//! The sentences for the Host's refusal reasons and failure classes follow
//! Maka Desktop's wording (`add` in
//! apps/desktop/src/renderer/features/connection-settings/settings-provider-copy.ts)
//! where it has one. Protocol values are mapped to these strings by the
//! settings crate, so this crate stays free of `host-protocol`.

use super::{Locale, Text, plural};

texts! {
    // The settings surface: "Back to app", the section search, and the
    // navigation's groups.
    SETTINGS = "Settings", "设置", "設定";
    BACK_TO_APP = "Back to app", "返回应用", "返回應用";
    /// The accessible name of the section list.
    SETTINGS_NAVIGATION = "Settings sections", "设置分组", "設定分組";
    SETTINGS_SEARCH = "Search", "搜索", "搜尋";
    SETTINGS_NO_MATCH = "No settings match.", "没有匹配的设置。", "沒有符合的設定。";
    GROUP_PREFERENCES = "Preferences", "偏好", "偏好";
    GROUP_CAPABILITIES = "Capabilities", "能力", "能力";
    GROUP_ACTIVITY = "Activity", "活动", "活動";
    GROUP_SYSTEM = "System", "系统", "系統";
    /// The badge after a section still in beta (Web Search). Desktop keeps
    /// the word in English in every locale.
    BADGE_BETA = "Beta", "Beta", "Beta";

    // The sections, each with the line under its page title.
    SECTION_GENERAL = "General", "通用", "通用";
    SECTION_GENERAL_HELP =
        "Display name and interface language, privacy and notifications, task defaults, and network proxy.",
        "显示名称与界面语言、隐私与通知、任务默认与网络代理。",
        "顯示名稱與介面語言、隱私與通知、任務預設與網路代理。";
    SECTION_APPEARANCE = "Appearance", "外观", "外觀";
    SECTION_APPEARANCE_HELP =
        "Interface theme and color palette.",
        "界面主题与调色板。",
        "介面主題與調色盤。";
    SECTION_WORKSPACE = "Workspace", "工作区", "工作區";
    SECTION_WORKSPACE_HELP =
        "Manage Runtime Host connections and projects on the default Host.",
        "管理 Runtime Host 连接，以及默认 Host 上的项目。",
        "管理 Runtime Host 連線，以及預設 Host 上的專案。";
    SECTION_MODELS = "Models", "模型", "模型";
    SECTION_MODELS_HELP =
        "Model connections, API keys, and OAuth subscriptions.",
        "模型连接、API key 与 OAuth 订阅管理。",
        "模型連線、API key 與 OAuth 訂閱管理。";
    SECTION_EXTERNAL_AGENTS = "External Agents", "外部 Agent", "外部 Agent";
    SECTION_EXTERNAL_AGENTS_HELP =
        "Configure and sign in to a locally installed Antigravity ACP agent.",
        "配置并登录本机安装的 Antigravity ACP。",
        "設定並登入本機安裝的 Antigravity ACP。";
    SECTION_SUBAGENTS = "Subagents", "子 Agent", "子 Agent";
    SECTION_SUBAGENTS_HELP =
        "Configure the subagents, capability boundaries, and models the main agent may select.",
        "配置主 Agent 可以自动选择的子 Agent、能力边界与模型。",
        "設定主 Agent 可以自動選擇的子 Agent、能力邊界與模型。";
    SECTION_MEMORY = "Memory", "记忆", "記憶";
    SECTION_MEMORY_HELP =
        "What Maka remembers, and the local MEMORY.md file.",
        "Maka 记住的内容，以及本地 MEMORY.md 文件。",
        "Maka 記住的內容，以及本地 MEMORY.md 檔案。";
    SECTION_BOT_CHAT = "Remote Access", "远程接入", "遠端串接";
    SECTION_BOT_CHAT_HELP =
        "Chat with Maka from other devices through Telegram, Feishu, or WeChat.",
        "通过 Telegram、飞书、微信等平台从其他设备与 Maka 对话。",
        "透過 Telegram、飛書、微信等平臺從其他裝置與 Maka 對話。";
    SECTION_SEARCH = "Web Search", "联网搜索", "聯網搜尋";
    SECTION_SEARCH_HELP =
        "Credentials and privacy boundaries for providers such as Tavily.",
        "联网搜索供应商（如 Tavily）凭据与隐私边界。",
        "聯網搜尋供應商（如 Tavily）憑據與隱私邊界。";
    SECTION_USAGE = "Usage", "使用统计", "使用統計";
    SECTION_USAGE_HELP =
        "Token, model, tool usage trends, and quota tracking.",
        "token、模型、工具使用走势与配额追踪。",
        "token、模型、工具使用走勢與配額追蹤。";
    SECTION_ARCHIVED_TASKS = "Archived tasks", "已归档任务", "已歸檔任務";
    SECTION_ARCHIVED_TASKS_HELP =
        "Restore or permanently delete archived tasks.",
        "恢复或彻底删除已归档的任务。",
        "恢復或徹底刪除已歸檔的任務。";
    SECTION_IMPORT_TASKS = "Import/export tasks", "导入/导出任务", "匯入/匯出任務";
    SECTION_IMPORT_TASKS_HELP =
        "Convert conversations from another local agent into Maka tasks, or move a task between two Maka installations.",
        "把本机其他 Agent 的对话记录转换成 Maka 任务，或在两个 Maka 之间搬运任务。",
        "把本機其他 Agent 的對話記錄轉換成 Maka 任務，或在兩個 Maka 之間搬運任務。";
    SECTION_DAILY_REVIEW = "Daily Review", "每日回顾", "每日回顧";
    SECTION_DAILY_REVIEW_HELP =
        "Analyze local tasks for summaries, reminders, and suggestions.",
        "每天分析本机任务，生成摘要、遗漏提醒和建议。",
        "每天分析本機任務，生成摘要、遺漏提醒和建議。";
    SECTION_DATA = "Data", "数据", "資料";
    SECTION_DATA_HELP =
        "Local workspace paths, backup, and restore.",
        "本地工作区路径、备份与恢复。",
        "本地工作區路徑、備份與恢復。";
    SECTION_PERMISSIONS = "Permissions & Capabilities", "权限与能力", "權限與能力";
    SECTION_PERMISSIONS_HELP =
        "System grants and runtime checks for Maka capabilities.",
        "系统权限授予状态与 Maka 能力运行时检查。",
        "系統權限授予狀態與 Maka 能力執行時檢查。";
    SECTION_HEALTH = "Health", "健康", "健康";
    SECTION_HEALTH_HELP =
        "Runtime connections, model probes, and local health status.",
        "运行时连接、模型探针与本地健康状态。",
        "執行時連線、模型探針與本地健康狀態。";
    SECTION_ABOUT = "About", "关于", "關於";
    SECTION_ABOUT_HELP =
        "Version and support.",
        "版本与支持。",
        "版本與支援。";
    /// Words a section used to go by, which the search still finds it by.
    SECTION_CONNECTIONS = "Connections", "模型连接", "模型連線";
    SECTION_PROJECTS = "Projects", "项目", "專案";

    // The row kit: what a placeholder is announced as while its value loads.
    SETTINGS_LOADING = "Loading settings", "正在加载设置", "正在載入設定";

    // Preferences: the footer menu's submenus, the General page's Identity
    // group, and the Appearance page's Theme group.
    LANGUAGE = "Language", "语言", "語言";
    APPEARANCE = "Appearance", "外观", "外觀";
    APPEARANCE_SYSTEM = "Follow system", "跟随系统", "跟隨系統";
    APPEARANCE_LIGHT = "Light", "浅色", "淺色";
    APPEARANCE_DARK = "Dark", "深色", "深色";
    IDENTITY = "Identity", "身份", "身份";
    IDENTITY_HELP =
        "How Maka addresses you, plus interface language and response tone.",
        "Maka 如何称呼你，以及界面语言和回答语气。",
        "Maka 如何稱呼你，以及介面語言和回答語氣。";
    INTERFACE_LANGUAGE = "Interface language", "界面语言", "介面語言";
    INTERFACE_LANGUAGE_HELP =
        "Choose the language used by Maka. Changes apply immediately and persist after restart.",
        "选择 Maka 界面的显示语言。切换后立即生效，重启后保持。",
        "選擇 Maka 介面的顯示語言。切換後立即生效，重新啟動後仍會保留。";
    /// The language choice that follows the system's.
    LANGUAGE_SYSTEM = "Follow system", "跟随系统", "自動（跟隨系統）";
    THEME = "Theme", "主题", "主題";
    THEME_HELP =
        "Follow the system appearance, or stay on light or dark.",
        "界面跟随系统，还是固定浅色或深色。",
        "介面跟隨系統，還是固定淺色或深色。";
    THEME_LIGHT_HELP = "Always use the light interface.", "始终使用浅色界面。", "始終使用淺色介面。";
    THEME_DARK_HELP = "Always use the dark interface.", "始终使用深色界面。", "始終使用深色介面。";
    THEME_SYSTEM_HELP =
        "Match the current system appearance.",
        "匹配系统当前的浅色或深色偏好。",
        "符合系統目前的淺色或深色偏好。";

    // The Connections section: the Host's model connections.
    CONNECTIONS_SEARCH = "Search connections", "搜索连接", "搜尋連線";
    /// The accessible name of the All / Enabled / Disabled filter.
    CONNECTIONS_FILTER = "Show connections", "筛选连接", "篩選連線";
    FILTER_ALL = "All", "全部", "全部";
    FILTER_ENABLED = "Enabled", "已启用", "已啟用";
    FILTER_DISABLED = "Disabled", "已停用", "已停用";
    /// The badge on the connection the catalog default names.
    DEFAULT_BADGE = "Default", "默认", "預設";
    CONNECTIONS_NO_MATCH = "No connections match.", "没有匹配的连接。", "沒有符合的連線。";
    CONNECTIONS_LOADING = "Loading connections…", "正在加载连接…", "正在載入連線…";
    CONNECTIONS_LOAD_FAILED = "Couldn’t load connections.", "载入模型连接失败。", "載入模型連線失敗。";
    RETRY = "Retry", "重试", "重試";
    SET_AS_DEFAULT = "Set as default", "设为默认", "設為預設";
    UPDATE_FAILED = "Couldn’t change the connection.", "更改连接失败。", "變更連線失敗。";
    SET_DEFAULT_FAILED = "Couldn’t make this the default connection.", "设为默认失败。", "設為預設失敗。";
    CONNECTION_CHANGED =
        "The connection changed in the meantime. Review it and try again.",
        "连接在此期间已发生变化，请检查后重试。",
        "連線在此期間已變更，請檢查後重試。";

    // The Workspace page: the Host's registered projects (folders tasks run
    // in).
    PROJECTS_HELP =
        "Folders your tasks run in. New tasks go into the project chosen \
     in the sidebar.",
        "任务运行所在的文件夹。新任务会进入侧边栏中选中的项目。",
        "任務執行所在的資料夾。新任務會進入側邊欄中選取的專案。";
    ADD_PROJECT = "Add project…", "添加项目…", "新增專案…";
    PROJECT_NAME = "Project name", "项目名称", "專案名稱";
    PROJECT_RENAME = "Rename", "重命名", "重新命名";
    PROJECT_ARCHIVE = "Archive", "归档", "歸檔";
    PROJECT_RESTORE = "Restore", "恢复", "恢復";
    PROJECT_RELINK = "Relink…", "重新定位…", "重新定位…";
    PROJECT_ARCHIVED = "Archived", "已归档", "已歸檔";
    PROJECTS_EMPTY =
        "No projects yet. Add a folder to run tasks in it.",
        "还没有项目。添加一个文件夹，即可在其中运行任务。",
        "還沒有專案。新增一個資料夾，即可在其中執行任務。";
    PROJECTS_LOADING = "Loading projects…", "正在加载项目…", "正在載入專案…";
    PROJECTS_LOAD_FAILED = "Couldn’t load projects.", "无法加载项目。", "無法載入專案。";
    PROJECTS_UNAVAILABLE =
        "This Runtime Host doesn’t keep projects.",
        "此 Runtime Host 不支持项目。",
        "此 Runtime Host 不支援專案。";

    // The General page's Task defaults group: the mode new tasks start in
    // (the Host's chat defaults). The mode names are the composer's.
    TASK_DEFAULTS = "Task defaults", "任务默认", "任務預設";
    TASK_DEFAULTS_HELP =
        "The model and permission mode a new task starts on. Configure thinking defaults per model in Model settings.",
        "新任务的起始模型与权限模式。每个模型的默认思考级别在模型设置中配置。",
        "新任務的起始模型與權限模式。每個模型的預設思考級別在模型設定中配置。";
    DEFAULT_PERMISSION = "Default permission mode", "默认权限模式", "預設權限模式";
    DEFAULT_PERMISSION_HELP =
        "Initial permission mode for new tasks; it can be changed at any time.",
        "新任务默认使用的权限模式；可在任务内随时切换。",
        "新任務預設使用的權限模式；可在任務內隨時切換。";
    PERMISSIONS_LOADING =
        "Reading the Runtime Host’s defaults…",
        "正在读取 Runtime Host 的默认设置…",
        "正在讀取 Runtime Host 的預設設定…";
    PERMISSIONS_LOAD_FAILED =
        "Couldn’t read the Runtime Host’s defaults.",
        "无法读取 Runtime Host 的默认设置。",
        "無法讀取 Runtime Host 的預設設定。";
    PERMISSIONS_OFFLINE =
        "Connect to the Runtime Host to change its defaults.",
        "连接到 Runtime Host 后才能更改默认设置。",
        "連線至 Runtime Host 後才能變更預設設定。";
    PERMISSION_SAVE_FAILED =
        "Couldn’t change the default permission mode.",
        "更改默认权限模式失败。",
        "變更預設權限模式失敗。";
    /// The question before Full access becomes the default (Desktop's
    /// `sessionSettingsActions` in apps/desktop/src/renderer/locales/shell-copy.ts).
    FULL_ACCESS_CONFIRM_TITLE = "Switch to full access?", "切换到完全权限？", "切換到完全權限？";
    FULL_ACCESS_CONFIRM_BODY =
        "Local tools will read and write your files and reach the network directly, outside Maka’s protection layer. Use only for tasks you fully trust, or ones already isolated by their environment.",
        // Shorter than Desktop's (…将直接读写你的文件…), which at the
        // dialog's 368 leaves 务。 alone on a third line (review round 16).
        "本地工具直接读写文件并访问网络，不经 Maka 的保护层。仅用于你完全信任、或已在外部隔离环境中运行的任务。",
        "本地工具直接讀寫檔案並存取網路，不經 Maka 的保護層。僅用於你完全信任、或已在外部隔離環境中執行的任務。";
    FULL_ACCESS_CONFIRM = "Turn on full access", "开启完全权限", "開啟完全權限";
    FULL_ACCESS_KEEP_AUTO = "Keep Auto", "保持自动", "保持自動";

    // The General page's Identity group, besides the interface language:
    // how Maka addresses you and the tone it answers in (Desktop's
    // `personalization`).
    DISPLAY_NAME = "Display name", "显示名称", "顯示名稱";
    DISPLAY_NAME_HELP =
        "Maka uses this name when addressing you. Leave it blank to use “you”.",
        "Maka 在聊天里会以这个名字称呼你。留空就用默认的“你”。",
        "Maka 在聊天裡會以這個名字稱呼你。留空就用預設的“你”。";
    DISPLAY_NAME_PLACEHOLDER = "For example: JK", "例如：JK", "例如：JK";
    DISPLAY_NAME_UNSET = "Not set — Maka will say “you”", "未设置，Maka 会称呼你“你”", "未設定，Maka 會稱呼你“你”";
    DISPLAY_NAME_CHANGE = "Change", "更改", "更改";
    DISPLAY_NAME_SET = "Set", "设置", "設定";
    /// Saves an edited value (Desktop's shared `save`).
    SAVE_CHANGE = "Save", "保存", "儲存";
    ASSISTANT_TONE = "Assistant tone", "助手语气偏好", "助手語氣偏好";
    ASSISTANT_TONE_HELP =
        "Up to 500 characters. This changes response style only; permission and safety rules still apply. Changes save automatically.",
        "最多 500 字，只影响回答的语气和风格。权限确认与安全规则不受影响；改动会自动保存。",
        "最多 500 字，只影響回答的語氣和風格。權限確認與安全規則不受影響；改動會自動儲存。";
    ASSISTANT_TONE_PLACEHOLDER =
        "For example: technically rigorous, concise, and no emoji.",
        "例如：技术严谨、偏简洁、不要 emoji。",
        "例如：技術嚴謹、偏簡潔、不要 emoji。";
    PERSONALIZATION_SAVE_FAILED = "Could not save.", "保存失败。", "儲存失敗。";

    // The General page's Privacy and notifications group.
    PRIVACY = "Privacy and notifications", "隐私与通知", "隱私與通知";
    PRIVACY_HELP =
        "What Maka may read and write locally, and when it notifies you.",
        "本地数据的读写范围，以及桌面通知时机。",
        "本地資料的讀寫範圍，以及桌面通知時機。";
    INCOGNITO = "Incognito mode", "隐身模式", "隱身模式";
    INCOGNITO_HELP =
        "Pause local memory, web search, and scheduled task triggers.",
        "开启后暂停本地记忆读写、联网搜索和定时任务触发。",
        "開啟後暫停本地記憶讀寫、聯網搜尋和定時任務觸發。";
    INCOGNITO_FAILED = "Could not change incognito mode.", "隐身模式切换失败。", "隱身模式切換失敗。";
    NOTIFICATIONS = "Send system notifications", "发送系统通知", "傳送系統通知";
    NOTIFICATIONS_HELP =
        "Notify when a response finishes, fails, or needs your answer while the window is in the background.",
        "窗口不在前台时，在回答完成、出错或等你回答时发送桌面通知。",
        "視窗不在前臺時，在回答完成、出錯或等你回答時傳送桌面通知。";
    WORKSPACE_INSTRUCTIONS = "Follow project instructions", "遵循项目指令", "遵循專案指令";
    WORKSPACE_INSTRUCTIONS_HELP =
        "Automatically read existing AGENTS.md, CLAUDE.md, or GEMINI.md files in each project. Manage the files in their respective projects.",
        "自动读取每个项目中已有的 AGENTS.md、CLAUDE.md 或 GEMINI.md；文件仍由各自项目管理。",
        "自動讀取每個專案中已有的 AGENTS.md、CLAUDE.md 或 GEMINI.md；檔案仍由各自專案管理。";
    WORKSPACE_INSTRUCTIONS_FAILED =
        "Could not change project instruction settings.",
        "项目指令设置切换失败。",
        "專案指令設定切換失敗。";

    // The system notification a finished, failed, or waiting task posts
    // while the window is in the background (Desktop's `RUN_NOTIFICATION_COPY`
    // in apps/desktop/src/main/notifications-policy.ts): the fallback title
    // and body when the task has no name and the Host sent no reason.
    RUN_COMPLETED_TITLE = "Response ready", "回答已生成", "回答已產生";
    RUN_COMPLETED_BODY =
        "Maka finished this response. Click to view it.",
        "Maka 已完成本轮回答，点击查看。",
        "Maka 已完成本次回答，按一下以檢視。";
    RUN_ERRORED_TITLE = "Conversation error", "任务出错", "任務發生錯誤";
    RUN_ERRORED_BODY =
        "This response did not finish. Click to view details.",
        "本轮回答未能完成，点击查看详情。",
        "本次回答未能完成，按一下以檢視詳細資料。";
    RUN_WAITING_TITLE = "Waiting for you", "等你回答", "等你回答";
    RUN_WAITING_BODY =
        "Maka needs your answer to continue. Click to view it.",
        "Maka 需要你的回答才能继续，点击查看。",
        "Maka 需要你的回答才能繼續，按一下以檢視。";

    // The Task defaults group, besides the permission mode. Desktop names
    // Code Mode in English in every locale. Its help also says when
    // WorkHub takes the change; this client has no WorkHub, so that
    // clause is left out.
    CODE_MODE = "Code Mode", "Code Mode", "Code Mode";
    CODE_MODE_HELP =
        "New tasks use code to compose and call tools. Existing tasks keep their mode.",
        "开启后，新任务通过代码编排和调用工具。已有任务保持不变。",
        "開啟後，新任務透過程式碼編排和呼叫工具。既有任務保持不變。";
    /// A switch whose change the Host did not take (Desktop's `updateFailed`).
    SETTING_NOT_APPLIED =
        "The setting was not applied. Try again later.",
        "设置未生效，请稍后重试。",
        "設定未生效，請稍後重試。";
    DEFAULT_MODEL = "Default model", "默认模型", "預設模型";
    DEFAULT_MODEL_HELP = "Model used by new tasks.", "新任务默认使用的模型。", "新任務預設使用的模型。";
    DEFAULT_MODEL_NOT_SET = "Not set", "未设置", "未設定";
    DEFAULT_MODEL_FAILED = "Could not save the default model.", "保存默认模型失败。", "儲存預設模型失敗。";
    DEFAULT_MODEL_NONE =
        "Add a model connection to choose a default model.",
        "添加模型连接后即可选择默认模型。",
        "新增模型連線後即可選擇預設模型。";

    // The Command environment group: the shell the Host's Bash tool runs.
    SHELL = "Command environment", "命令行环境", "命令列環境";
    SHELL_HELP =
        "Choose the shell the Runtime Host uses for Bash tools and terminal commands.",
        "选择 Runtime Host 执行 Bash 工具和终端命令时使用的 shell。",
        "選擇 Runtime Host 執行 Bash 工具和終端命令時使用的 shell。";
    SHELL_PREFERENCE = "Bash tool shell", "Bash 工具 shell", "Bash 工具 shell";
    SHELL_PREFERENCE_HELP =
        "Automatic keeps the PowerShell-first Windows default. Git Bash is an explicit override for the current Runtime Host.",
        "自动模式保持 Windows 的 PowerShell 优先规则；Git Bash 是仅对当前 Runtime Host 生效的显式覆盖。",
        "自動模式保持 Windows 的 PowerShell 優先規則；Git Bash 是僅對目前 Runtime Host 生效的顯式覆蓋。";
    SHELL_AUTO = "Automatic (recommended)", "自动（推荐）", "自動（推薦）";
    SHELL_GIT_BASH = "Git Bash", "Git Bash", "Git Bash";
    SHELL_EXECUTABLE = "Git Bash executable", "Git Bash 可执行文件", "Git Bash 執行檔";
    SHELL_EXECUTABLE_HELP =
        "Enter the absolute path to bash.exe on the Windows machine running the Runtime Host. The legacy System32 WSL Bash shim is also recognized; Maka verifies GNU Bash before saving.",
        "填写 Runtime Host 所在 Windows 机器上 bash.exe 的绝对路径。也支持该机器上的旧版 System32 WSL Bash；保存时会验证 GNU Bash。",
        "填寫 Runtime Host 所在 Windows 機器上 bash.exe 的絕對路徑。也支援該機器上的舊版 System32 WSL Bash；儲存時會驗證 GNU Bash。";
    SAVE_SHELL = "Save shell setting", "保存 shell 设置", "儲存 shell 設定";
    SAVING_SHELL = "Saving…", "正在保存…", "正在儲存…";
    SAVE_SHELL_FAILED = "Could not save shell setting.", "保存 shell 设置失败。", "儲存 shell 設定失敗。";
    SHELL_EXECUTABLE_REJECTED =
        "The current Runtime Host could not run that path as GNU Bash. Check that the Host runs Windows, the path exists, and the file is named bash.exe.",
        "当前 Runtime Host 无法把该路径作为 GNU Bash 运行。请检查 Host 是否为 Windows、路径是否存在，并确认文件名为 bash.exe。",
        "目前 Runtime Host 無法把該路徑作為 GNU Bash 執行。請檢查 Host 是否為 Windows、路徑是否存在，並確認檔名為 bash.exe。";

    // The Terminal group: how the workbar's terminals take keys and draw
    // their cursor, the client's own preferences.
    TERMINAL = "Terminal", "终端", "終端機";
    TERMINAL_OPTION_AS_META = "Option as Meta key", "将 Option 用作 Meta 键", "將 Option 用作 Meta 鍵";
    TERMINAL_OPTION_AS_META_HELP =
        "Option with a key sends Escape and the key, as Meta does, instead of typing a special character.",
        "按 Option 组合键时发送 Escape 加该键（同 Meta 键），而不是输入特殊字符。",
        "按 Option 組合鍵時傳送 Escape 加該鍵（同 Meta 鍵），而不是輸入特殊字元。";
    TERMINAL_CURSOR_BLINK = "Blinking cursor", "光标闪烁", "游標閃爍";

    // The Network group: the proxy AI model requests go through.
    NETWORK = "Network", "网络", "網路";
    NETWORK_HELP = "The network path AI model requests take.", "AI 模型请求走的网络通道。", "AI 模型請求走的網路通道。";
    PROXY = "Proxy server", "代理服务器", "代理伺服器";
    PROXY_HELP =
        "Configure a network proxy for AI model requests.",
        "为 AI 模型请求配置网络代理。",
        "為 AI 模型請求設定網路代理。";
    PROXY_PROTOCOL = "Proxy protocol", "代理协议", "代理協議";
    PROXY_HOST = "Server address", "服务器地址", "伺服器地址";
    PROXY_PORT = "Port", "端口", "埠";
    PROXY_AUTH = "Proxy authentication", "代理认证", "代理認證";
    PROXY_AUTH_HELP =
        "Enable this when a username and password are required.",
        "需要用户名和密码时开启。",
        "需要使用者名稱和密碼時開啟。";
    PROXY_USERNAME = "Username", "用户名", "使用者名稱";
    PROXY_PASSWORD = "Password", "密码", "密碼";
    PROXY_PASSWORD_SAVED =
        "Password saved; enter a new password to replace it",
        "密码已保存；输入新密码以替换",
        "密碼已儲存；輸入新密碼以替換";
    PROXY_BYPASS = "Proxy bypass list", "代理白名单", "代理白名單";
    PROXY_BYPASS_HELP_ONE =
        "These domains connect directly. Separate multiple domains with commas. {count} domain was added automatically. The proxy applies to AI model requests only.",
        "这些域名将绕过代理直连，多个用逗号分隔。已自动添加 {count} 个域名。代理仅作用于 AI 模型请求。",
        "這些域名將繞過代理直連，多個用逗號分隔。已自動新增 {count} 個域名。代理僅作用於 AI 模型請求。";
    PROXY_BYPASS_HELP_OTHER =
        "These domains connect directly. Separate multiple domains with commas. {count} domains were added automatically. The proxy applies to AI model requests only.",
        "这些域名将绕过代理直连，多个用逗号分隔。已自动添加 {count} 个域名。代理仅作用于 AI 模型请求。",
        "這些域名將繞過代理直連，多個用逗號分隔。已自動新增 {count} 個域名。代理僅作用於 AI 模型請求。";
    PROXY_TEST = "Test current configuration", "测试当前配置", "測試目前設定";
    PROXY_TESTING = "Testing…", "测试中…", "測試中…";
    PROXY_TEST_FAILED = "Proxy test failed.", "代理测试失败。", "代理測試失敗。";
    PROXY_TEST_ERROR = "Could not test proxy.", "代理测试出错。", "代理測試出錯。";
    PROXY_SAVE_FAILED = "Could not save network settings.", "保存网络设置失败。", "儲存網路設定失敗。";
    /// The port field takes a whole number from 1 to 65535.
    PROXY_PORT_INVALID =
        "Enter a port from 1 to 65535.",
        "请输入 1 到 65535 之间的端口。",
        "請輸入 1 到 65535 之間的埠。";
    // What a proxy test found (Desktop's `proxy` in
    // apps/desktop/src/renderer/locales/settings-test-result-copy.ts).
    PROXY_RESULT_REACHABLE = "The proxy is reachable", "代理配置有效", "代理設定有效";
    PROXY_RESULT_DISABLED =
        "Enable the proxy server before testing it.",
        "请先启用代理服务器，再进行测试。",
        "請先啟用代理伺服器，再進行測試。";
    PROXY_RESULT_CONFIGURATION_MISSING =
        "Enter a proxy host and port before testing it.",
        "请填写代理服务器地址和端口后再测试。",
        "請填寫代理伺服器地址和埠後再測試。";
    PROXY_RESULT_CREDENTIAL_MISSING =
        "Proxy authentication is enabled. Enter a proxy password before testing.",
        "代理认证已开启，请输入代理密码后再测试。",
        "代理認證已開啟，請輸入代理密碼後再測試。";
    PROXY_RESULT_TIMEOUT =
        "The proxy test timed out. Check whether the proxy service is reachable.",
        "代理测试超时，请检查代理服务是否可达。",
        "代理測試超時，請檢查代理服務是否可達。";
    PROXY_RESULT_HTTP_STATUS =
        "The proxy test returned HTTP {status}. Check the proxy service and test URL.",
        "代理测试返回 HTTP {status}，请检查代理服务或测试地址。",
        "代理測試回傳 HTTP {status}，請檢查代理服務或測試地址。";
    PROXY_RESULT_UNREACHABLE =
        "The proxy is unreachable. Check its host, port, and authentication settings.",
        "代理不可达，请检查服务器地址、端口和认证信息。",
        "代理不可達，請檢查伺服器地址、埠和認證資訊。";
    /// How long a proxy test took.
    PROXY_LATENCY = "{ms} ms", "{ms} ms", "{ms} ms";
    /// `proxy_target_mismatch`: the proxy changed under a password save.
    PROXY_TARGET_CHANGED =
        "The proxy changed while its password was being saved. Check the server and enter the password again.",
        "保存密码期间代理已发生变化。请检查服务器后重新输入密码。",
        "儲存密碼期間代理已變更。請檢查伺服器後重新輸入密碼。";
    /// `credential_stale` twice: the saved password kept changing.
    PROXY_PASSWORD_KEPT_CHANGING =
        "the saved proxy password kept changing",
        "已保存的代理密码一直在变化。",
        "已儲存的代理密碼一直在變化。";

    // Why the Runtime Host refused a settings change: a sentence for every
    // error code the settings operations declare (`QUERY_ERRORS`,
    // `MUTATION_ERRORS`, and `unauthorized`, which every operation allows).
    HOST_ERROR_NOT_READY =
        "the Runtime Host is still starting; try again in a moment",
        "Runtime Host 仍在启动，请稍后重试。",
        "Runtime Host 仍在啟動，請稍後重試。";
    HOST_ERROR_DRAINING =
        "the Runtime Host is shutting down; try again once it is back",
        "Runtime Host 正在关闭，请在其恢复后重试。",
        "Runtime Host 正在關閉，請在其恢復後重試。";
    HOST_ERROR_UNAVAILABLE =
        "this Runtime Host does not offer this setting",
        "此 Runtime Host 不提供该设置。",
        "此 Runtime Host 不提供該設定。";
    HOST_ERROR_INVALID =
        "the Runtime Host did not accept this value",
        "Runtime Host 未接受该值。",
        "Runtime Host 未接受該值。";
    HOST_ERROR_INTERNAL =
        "the Runtime Host ran into an internal error",
        "Runtime Host 发生内部错误。",
        "Runtime Host 發生內部錯誤。";
    HOST_ERROR_PERSISTENCE =
        "the Runtime Host could not write the change to disk",
        "Runtime Host 无法将更改写入磁盘。",
        "Runtime Host 無法將變更寫入磁碟。";
    HOST_ERROR_OUTCOME_UNKNOWN =
        "the Runtime Host could not confirm whether the change was saved; check the setting before changing it again",
        "Runtime Host 无法确认更改是否已保存，请先检查该设置再修改。",
        "Runtime Host 無法確認變更是否已儲存，請先檢查該設定再修改。";
    HOST_ERROR_UNAUTHORIZED =
        "this connection may not change this setting",
        "当前连接无权更改该设置。",
        "目前連線無權變更該設定。";
    HOST_ERROR_NOT_CONNECTED =
        "not connected to the Runtime Host",
        "未连接到 Runtime Host。",
        "未連線至 Runtime Host。";
    /// The Host has no connection a credential names (`connection_not_found`).
    HOST_ERROR_CONNECTION_GONE =
        "the connection no longer exists",
        "该连接已不存在。",
        "該連線已不存在。";
    /// The General page cannot read the Host's settings.
    GENERAL_LOAD_FAILED =
        "Couldn’t read the Runtime Host’s settings.",
        "载入设置失败。",
        "載入設定失敗。";

    // The Appearance page's Color palette group: Desktop's eleven palettes
    // in its two groups (`PALETTE_GROUPS` in appearance-settings-page.tsx).
    PALETTE = "Color palette", "调色板", "調色盤";
    PALETTE_HELP =
        "Accent and canvas colors. Changes apply immediately and are saved locally.",
        "强调色与画布色调；切换会立即生效并保存在本地。",
        "強調色與畫布色調；切換會立即生效並儲存在本地。";
    PALETTE_GROUP_EDITOR = "Editor themes", "编辑器主题", "編輯器主題";
    PALETTE_GROUP_PRODUCT = "Product colors", "产品色调", "產品色調";
    PALETTE_DEFAULT = "Default", "默认", "預設";
    PALETTE_DEFAULT_HELP = "Maka brand-blue accent", "Maka 品牌蓝强调色", "Maka 品牌藍強調色";
    PALETTE_ONEDARK = "One Dark", "One Dark", "One Dark";
    PALETTE_ONEDARK_HELP = "Classic dark editor theme", "编辑器经典深色", "編輯器經典深色";
    PALETTE_CATPPUCCIN = "Catppuccin Mocha", "Catppuccin Mocha", "Catppuccin Mocha";
    PALETTE_CATPPUCCIN_HELP = "Soft purple dark theme", "紫调柔和深色", "紫調柔和深色";
    PALETTE_TOKYO_NIGHT = "Tokyo Night", "Tokyo Night", "Tokyo Night";
    PALETTE_TOKYO_NIGHT_HELP = "Deep-blue editor theme", "深蓝主题", "深藍主題";
    PALETTE_NORD = "Nord", "Nord", "Nord";
    PALETTE_NORD_HELP = "Cool Nordic colors", "北欧冷色", "北歐冷色";
    PALETTE_CORAL = "Coral", "珊瑚", "珊瑚";
    PALETTE_CORAL_HELP = "Warm pink and coral accent", "暖粉 / 珊瑚强调色", "暖粉 / 珊瑚強調色";
    PALETTE_AZURE = "Azure", "湖蓝", "湖藍";
    PALETTE_AZURE_HELP = "Clean, calm blue accent", "湖蓝强调色，干净冷静", "湖藍強調色，乾淨冷靜";
    PALETTE_FOREST = "Forest", "森林", "森林";
    PALETTE_FOREST_HELP = "Deep moss and warm honey", "深苔绿与暖蜂蜜强调色", "深苔綠與暖蜂蜜強調色";
    PALETTE_DUSK = "Dusk", "暮光", "暮光";
    PALETTE_DUSK_HELP = "Deep violet on a cool canvas", "深紫罗兰与冷调画布", "深紫羅蘭與冷調畫布";
    PALETTE_SAND = "Sand", "沙金", "沙金";
    PALETTE_SAND_HELP = "Amber sand and warm ivory", "琥珀沙金与暖奶白", "琥珀沙金與暖奶白";
    PALETTE_MONO = "Monochrome", "极简灰", "極簡灰";
    PALETTE_MONO_HELP =
        "Pure grayscale without color distraction",
        "纯灰阶，无彩色干扰",
        "純灰階，無彩色干擾";

    // The Appearance page's Font size group. Desktop's line names the
    // terminal's size too, which this client has no terminal for.
    FONT_SIZE = "Font size", "字号", "字型大小";
    FONT_SIZE_HELP =
        "Text size across the interface. Changes apply immediately and are saved locally.",
        "界面的文字大小；调整会立即生效并保存在本地。",
        "介面的文字大小；調整會立即生效並儲存在本機。";
    UI_FONT_SIZE = "UI font size", "UI 字号", "UI 字型大小";
    UI_FONT_SIZE_HELP =
        "Base font size used across the interface",
        "调整界面使用的基准字号",
        "調整介面使用的基準字型大小";
    /// A font size in pixels, the stepper's unit.
    FONT_SIZE_UNIT = "px", "px", "px";
    /// The stepper's buttons: a pixel smaller, a pixel larger.
    FONT_SIZE_DECREASE = "Decrease font size", "减小字号", "減小字型大小";
    FONT_SIZE_INCREASE = "Increase font size", "增大字号", "增大字型大小";

    // The Appearance page's Sidebar group: what the sidebar becomes when the
    // window is too narrow for it, which collapsing it by hand (the toggle,
    // ⌘B) gives too. This client's own; Desktop has no such setting.
    SIDEBAR = "Sidebar", "侧栏", "側邊欄";
    NARROW_SIDEBAR = "When the window is narrow", "窗口变窄时", "視窗變窄時";
    NARROW_SIDEBAR_HELP =
        "Collapsing the sidebar yourself does the same.",
        "手动收起侧栏时也是这样。",
        "手動收起側邊欄時也是這樣。";
    NARROW_SIDEBAR_ICONS = "Collapse to icons", "收成图标栏", "收成圖示列";
    NARROW_SIDEBAR_HIDE = "Hide", "整个隐藏", "完全隱藏";

    // The About page.
    ABOUT_VERSION = "Version", "版本", "版本";
    /// The version row's name: the version is this client's, not Apache
    /// Maka's (the Host reports none).
    ABOUT_CLIENT = "Maka GPUI", "Maka GPUI", "Maka GPUI";
    ABOUT_HOST = "Runtime Host", "Runtime Host", "Runtime Host";
    ABOUT_PROTOCOL = "Protocol epoch", "协议 epoch", "協定 epoch";
    ABOUT_STATE_ROOT = "Data folder", "数据文件夹", "資料夾";
    ABOUT_MAKA_CHECKOUT = "Maka checkout", "Maka 源码目录", "Maka 原始碼目錄";
    ABOUT_UNKNOWN = "Unknown", "未知", "未知";

    ADD_CONNECTION_TITLE = "Add connection", "添加连接", "新增連線";

    // Fields of the form that adds a connection.
    PROVIDER = "Provider", "服务商", "服務商";
    NAME = "Name", "名称", "名稱";
    SERVICE_URL = "Service URL", "服务地址", "服務地址";
    API_KEY = "API key", "API Key", "API Key";
    API_KEY_PLACEHOLDER = "Enter or paste API key", "输入或粘贴 API Key", "輸入或貼上 API Key";
    OPTIONAL = "Optional", "可选", "可選";
    /// The mark after a required field's label (Desktop's
    /// `@astryx.field.required`).
    REQUIRED = "Required", "必填", "必填";

    // Models, once verified.
    MODELS = "Models", "模型", "模型";

    // Actions.
    CANCEL = "Cancel", "取消", "取消";
    SAVE = "Add connection", "添加连接", "新增連線";

    // Local checks before anything is sent.
    SERVICE_URL_MISSING = "This provider requires a service URL.", "该服务商需要填写服务地址。", "該服務商需要填寫服務地址。";
    NO_MODEL_SELECTED = "Enable at least one model.", "请至少启用一个模型。", "請至少啟用一個模型。";

    // Why onboarding was refused (`rejected`).
    REJECTED_PROVIDER_UNSUPPORTED =
        "The Runtime Host can’t add this provider with an API key.",
        "Runtime Host 无法通过 API Key 添加该服务商。",
        "Runtime Host 無法透過 API Key 新增該服務商。";
    REJECTED_CONNECTION_NOT_FOUND =
        "The connection changed while it was being added. Try again.",
        "添加期间连接已发生变化，请重试。",
        "新增期間連線已變更，請重試。";
    REJECTED_SLUG_TAKEN =
        "Another connection already uses this identifier. Choose a different one.",
        "已有其他连接使用此标识，请换一个。",
        "已有其他連線使用此標識，請換一個。";
    REJECTED_CATALOG_FULL =
        "The connection limit has been reached. Remove an unused connection first.",
        "连接数量已达上限，请先删除不再使用的连接。",
        "連線數量已達上限，請先刪除不再使用的連線。";
    REJECTED_MODELS_CHANGED =
        "The available models changed. Verify again and make a new selection.",
        "可用模型已发生变化，请重新验证后选择。",
        "可用模型已變更，請重新驗證後選擇。";
    REJECTED_UNKNOWN =
        "The Runtime Host refused to add this connection.",
        "Runtime Host 拒绝添加此连接。",
        "Runtime Host 拒絕新增此連線。";

    // Why talking to the provider failed (`failed`).
    FAILED_AUTH =
        "The key could not be verified. Check it and try again.",
        "密钥验证失败，请检查后重试。",
        "金鑰驗證失敗，請檢查後重試。";
    FAILED_TIMEOUT =
        "Verification timed out. Check the network or proxy and try again.",
        "验证超时，请检查网络或代理后重试。",
        "驗證逾時，請檢查網路或 Proxy 後重試。";
    FAILED_NETWORK =
        "Could not reach the model provider. Check the network, proxy, or service URL.",
        "无法连接模型服务，请检查网络、代理或服务地址。",
        "無法連線至模型服務，請檢查網路、Proxy 或服務地址。";
    FAILED_INVALID_RESPONSE =
        "The model provider returned an unrecognized response. Try again later.",
        "模型服务返回了无法识别的结果，请稍后重试。",
        "模型服務回傳無法辨識的結果，請稍後重試。";

    // Requests that failed outright.
    VERIFY_FAILED = "Couldn’t verify the connection.", "无法验证连接。", "無法驗證連線。";
    SAVE_FAILED = "Couldn’t add the connection.", "添加连接失败。", "新增連線失敗。";
    UNEXPECTED =
        "The Runtime Host answered in a way this app can’t read.",
        "Runtime Host 返回了本应用无法识别的响应。",
        "Runtime Host 回傳了本應用程式無法辨識的回應。";

    // Sentences with a variable part.
    /// A connection's enabled model count, its status in the list.
    MODEL_COUNT_NONE = "No models", "无模型", "無模型";
    MODEL_COUNT_ONE = "{count} model", "{count} 个模型", "{count} 個模型";
    MODEL_COUNT_OTHER = "{count} models", "{count} 个模型", "{count} 個模型";
    /// The protocol epoch this client speaks and the connected Host's.
    PROTOCOL_EPOCHS = "{client} (Host {host})", "{client}（Host {host}）", "{client}（Host {host}）";
    /// The Host needs a key it was not given (`credential_not_configured`).
    API_KEY_MISSING =
        "Enter the {provider} API key.",
        "请填写 {provider} API Key。",
        "請填寫 {provider} API Key。";
    /// Making a new connection the default kept meeting newer catalogs.
    DEFAULT_KEPT_CHANGING = "the connection catalog kept changing", "连接列表一直在变化。", "連線列表一直在變化。";
    /// Changing the default permission mode kept meeting newer policies.
    POLICY_KEPT_CHANGING =
        "the Runtime Host’s policy kept changing",
        "Runtime Host 的策略一直在变化。",
        "Runtime Host 的策略一直在變化。";
    /// The Host refused the new connection's model as the default.
    DEFAULT_REFUSED =
        "the Runtime Host did not accept {model} as the default",
        "Runtime Host 未接受将 {model} 设为默认模型。",
        "Runtime Host 未接受將 {model} 設為預設模型。";
}

/// The project whose folder is gone, as the sidebar says it.
pub const PROJECT_MISSING: Text = crate::copy::PROJECT_MISSING;

/// A connection's enabled model count, its status in the list.
pub fn model_count(locale: Locale, count: usize) -> String {
    if count == 0 {
        return MODEL_COUNT_NONE.in_locale(locale).to_owned();
    }
    plural(count as u64, MODEL_COUNT_ONE, MODEL_COUNT_OTHER)
        .fill(locale, &[("count", &count.to_string())])
}

/// The protocol epoch this client speaks and, once connected, the Host's.
pub fn protocol_epochs(locale: Locale, client: u32, host: Option<u32>) -> String {
    match host {
        Some(host) => PROTOCOL_EPOCHS
            .fill(locale, &[("client", &client.to_string()), ("host", &host.to_string())]),
        None => client.to_string(),
    }
}

/// The Host needs a key it was not given (`credential_not_configured`).
pub fn api_key_missing(locale: Locale, provider: &str) -> String {
    API_KEY_MISSING.fill(locale, &[("provider", provider)])
}

/// The Host refused `model` as the default.
pub fn default_refused(locale: Locale, model: &str) -> String {
    DEFAULT_REFUSED.fill(locale, &[("model", model)])
}

/// The bypass list's help line: what it does and how many domains the
/// Host bypasses on its own.
pub fn proxy_bypass_help(locale: Locale, automatic: usize) -> String {
    plural(automatic as u64, PROXY_BYPASS_HELP_ONE, PROXY_BYPASS_HELP_OTHER)
        .fill(locale, &[("count", &automatic.to_string())])
}

/// A proxy test that got an HTTP error status back.
pub fn proxy_http_status(locale: Locale, status: u16) -> String {
    PROXY_RESULT_HTTP_STATUS.fill(locale, &[("status", &status.to_string())])
}

/// How long a proxy test took.
pub fn proxy_latency(locale: Locale, milliseconds: u64) -> String {
    PROXY_LATENCY.fill(locale, &[("ms", &milliseconds.to_string())])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_counts_agree_with_their_count() {
        let en = Locale::English;
        assert_eq!(model_count(en, 0), "No models");
        assert_eq!(model_count(en, 1), "1 model");
        assert_eq!(model_count(en, 4), "4 models");
        assert_eq!(protocol_epochs(en, 3, Some(4)), "3 (Host 4)");
        assert_eq!(protocol_epochs(en, 3, None), "3");
    }
}
