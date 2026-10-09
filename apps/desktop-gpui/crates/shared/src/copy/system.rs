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

//! Interface copy of the settings pages outside the preferences: Daily
//! Review's settings (settings-daily-review-copy.ts in
//! apps/desktop/src/renderer/locales/), Data (settings-data-copy.ts, with
//! the data location group from settings-shared-copy.ts and the folder
//! failures from shell-copy.ts), and About (`about` in
//! settings-preferences-copy.ts). Same rules as the parent module; the
//! strings are Maka Desktop's.

texts! {
    // Daily Review: when the scheduled analysis runs and which model
    // writes it.
    REVIEW_SCHEDULE = "Schedule", "定时分析", "定時分析";
    REVIEW_SCHEDULE_HELP =
        "Analyze the previous complete local day automatically.",
        "按本地时间自动分析前一个完整自然日的活动。",
        "按本地時間自動分析前一個完整自然日的活動。";
    REVIEW_ENABLED = "Enable scheduled analysis", "启用定时分析", "啟用定時分析";
    REVIEW_ENABLED_HELP =
        "Generate an analysis of yesterday’s activity each day.",
        "每天生成一份昨日活动分析。",
        "每天生成一份昨日活動分析。";
    REVIEW_TIME = "Run time", "执行时间", "執行時間";
    REVIEW_TIME_HELP =
        "Uses your local time in 24-hour format.",
        "使用 24 小时制的本地时间。",
        "使用 24 小時制的本地時間。";
    REVIEW_TIME_INVALID =
        "Enter a 24-hour time, for example 08:00.",
        "请输入 24 小时制时间，例如 08:00。",
        "請輸入 24 小時制時間，例如 08:00。";
    REVIEW_ANALYSIS = "Analysis", "分析", "分析";
    REVIEW_ANALYSIS_HELP =
        "Choose the model used to generate the fixed report structure.",
        "选择用于生成固定结构报告的模型。",
        "選擇用於生成固定結構報告的模型。";
    REVIEW_MODEL = "Analysis model", "分析模型", "分析模型";
    REVIEW_MODEL_HELP =
        "Follows the current task default when unspecified.",
        "未指定时跟随当前任务的默认模型。",
        "未指定時跟隨目前任務的預設模型。";
    REVIEW_MODEL_DEFAULT = "Follow task default", "跟随任务默认", "跟隨任務預設";
    /// After a saved model no connection offers any more.
    REVIEW_MODEL_UNAVAILABLE = "Currently unavailable", "当前不可用", "目前不可用";
    REVIEW_LOAD_FAILED =
        "Failed to load Daily Review settings.",
        "读取每日回顾设置失败。",
        "讀取每日回顧設定失敗。";
    REVIEW_SAVE_FAILED =
        "Failed to save Daily Review settings.",
        "保存每日回顾设置失败。",
        "儲存每日回顧設定失敗。";
    /// The settings kept changing while a change was saved.
    REVIEW_KEPT_CHANGING =
        "the Daily Review settings kept changing",
        "每日回顾设置一直在变化。",
        "每日回顧設定一直在變化。";
    REVIEW_OFFLINE =
        "Connect to the Runtime Host to change Daily Review.",
        "连接到 Runtime Host 后才能更改每日回顾。",
        "連線至 Runtime Host 後才能變更每日回顧。";

    // Data: where the files live, and the configuration file.
    DATA_LOCATION = "Data location", "数据位置", "資料位置";
    DATA_LOCATION_HELP =
        "Tasks, settings, usage statistics, and credentials are stored as files in this location on your machine.",
        "任务、设置、使用统计与凭据都以文件形式存放在本机的这个位置。",
        "任務、設定、使用統計與憑據都以檔案形式存放在本機的這個位置。";
    DATA_WORKSPACE = "Workspace path", "工作区路径", "工作區路徑";
    DATA_WORKSPACE_HELP =
        "Tasks, settings, credentials, and skill files are stored in this directory.",
        "任务、设置、凭据和技能文件都存在这个目录下。",
        "任務、設定、憑據和技能檔案都存在這個目錄下。";
    DATA_OPEN_WORKSPACE = "Open workspace folder", "打开工作区文件夹", "開啟工作區資料夾";
    DATA_COPY_PATH = "Copy path", "复制路径", "複製路徑";
    DATA_PATH_COPIED = "Workspace path copied", "已复制工作区路径", "已複製工作區路徑";
    DATA_OPEN_FAILED = "Could not open workspace folder", "无法打开工作区目录", "無法開啟工作區目錄";
    DATA_FOLDER_MISSING = "The folder does not exist.", "目录不存在。", "目錄不存在。";
    DATA_NOT_A_FOLDER = "The target is not a folder.", "目标不是目录。", "目標不是目錄。";
    DATA_BACKUP = "Backup and restore", "备份与恢复", "備份與恢復";
    DATA_BACKUP_NOTICE =
        "Local data is stored in the workspace. To back it up, quit Maka and copy the entire directory. To restore it, replace the same path and restart. Model credentials should be tested again after a restore, and subscription accounts usually need to sign in again.",
        "本机数据保存在工作区。需要备份时先退出 Maka，再复制整个目录；恢复时替换同一路径后重启。模型连接凭据随工作区恢复后需要重新测试；订阅账号令牌通常需要重新登录。",
        "本機資料儲存在工作區。需要備份時先退出 Maka，再複製整個目錄；恢復時替換同一路徑後重啟。模型連線憑據隨工作區恢復後需要重新測試；訂閱帳號權杖通常需要重新登入。";
    DATA_CONFIG = "Configuration import and export", "配置导入导出", "設定匯入匯出";
    DATA_CONFIG_HELP =
        "Select the content to export into a JSON backup. You can import it after moving devices or reinstalling. Secrets are excluded by default.",
        "勾选要导出的内容，生成一个 JSON 备份文件；换机或重装时可再导入。默认不含密钥。",
        "勾選要匯出的內容，生成一個 JSON 備份檔案；換機或重灌時可再匯入。預設不含金鑰。";
    DATA_CATEGORIES = "Select export content", "选择导出内容", "選擇匯出內容";
    DATA_CONNECTIONS = "Model connections", "模型连接", "模型連線";
    DATA_CONNECTIONS_HELP =
        "Provider connections and default models (without secrets)",
        "供应商连接与默认模型（不含密钥）",
        "供應商連線與預設模型（不含金鑰）";
    DATA_SETTINGS = "App settings", "应用设置", "應用設定";
    DATA_SETTINGS_HELP =
        "General, search, bot, proxy, and other settings",
        "常规、搜索、机器人、代理等设置",
        "常規、搜尋、機器人、代理等設定";
    DATA_MEMORY = "Local memory", "本地记忆", "本地記憶";
    DATA_MEMORY_HELP =
        "Contents of the local MEMORY.md file",
        "本机 MEMORY.md 的内容",
        "本機 MEMORY.md 的內容";
    DATA_CREDENTIALS = "Credentials (API keys and tokens)", "凭据（API 密钥、令牌）", "憑據（API 金鑰、權杖）";
    DATA_CREDENTIALS_HELP =
        "Sensitive model keys and subscription tokens",
        "模型密钥与订阅令牌等敏感信息",
        "模型金鑰與訂閱權杖等敏感資訊";
    DATA_SENSITIVE_WARNING =
        "Secrets will be written to the export file as plain text. Anyone with this file can use them. Store it securely and do not share it.",
        "密钥将以明文写入导出文件。任何拿到该文件的人都能使用这些密钥，请妥善保管、不要分享。",
        "金鑰將以明文寫入匯出檔案。任何拿到該檔案的人都能使用這些金鑰，請妥善保管、不要分享。";
    DATA_CONFLICT =
        "How to handle connections with the same name during import",
        "导入时同名连接的处理方式",
        "匯入時同名連線的處理方式";
    DATA_SKIP = "Skip", "跳过", "跳過";
    DATA_OVERWRITE = "Overwrite", "覆盖", "覆蓋";
    DATA_EXPORT = "Export configuration…", "导出配置…", "匯出設定…";
    DATA_IMPORT = "Import configuration…", "导入配置…", "匯入設定…";
    /// The open panel's button.
    DATA_IMPORT_PROMPT = "Import", "导入", "匯入";
    DATA_OFFLINE =
        "Connect to the Runtime Host to import or export the configuration.",
        "连接到 Runtime Host 后才能导入或导出配置。",
        "連線至 Runtime Host 後才能匯入或匯出設定。";
    DATA_SELECT_CATEGORY = "Select at least one category", "请至少选择一个类别", "請至少選擇一個類別";
    DATA_EXPORTED = "Configuration exported", "已导出配置", "已匯出設定";
    DATA_EXPORTED_DETAIL = "Included: {items}", "包含：{items}", "包含：{items}";
    DATA_EXPORT_FAILED = "Export failed", "导出失败", "匯出失敗";
    DATA_IMPORTED = "Configuration imported", "已导入配置", "已匯入設定";
    DATA_IMPORT_FAILED = "Import failed", "导入失败", "匯入失敗";
    DATA_NOT_JSON = "The file is not valid JSON.", "文件不是有效的 JSON。", "檔案不是有效的 JSON。";
    DATA_MALFORMED = "The config bundle is malformed.", "配置文件结构无效。", "設定檔結構無效。";
    DATA_UNSUPPORTED_VERSION =
        "The config file version is unsupported.",
        "配置文件版本不受支持。",
        "設定檔版本不受支援。";
    DATA_UNKNOWN_ERROR = "Something went wrong. Try again.", "出现错误，请稍后重试。", "出現錯誤，請稍後重試。";
    DATA_SUMMARY_CONNECTIONS =
        "Connections: {created} created · {overwritten} overwritten · {skipped} skipped",
        "连接 新增{created}·覆盖{overwritten}·跳过{skipped}",
        "連線 新增{created}·覆蓋{overwritten}·跳過{skipped}";
    DATA_SUMMARY_SETTINGS = "Settings applied", "设置已应用", "設定已應用";
    DATA_SUMMARY_CREDENTIALS = "Credentials: {applied} applied", "凭据 {applied}", "憑據 {applied}";
    DATA_SUMMARY_CREDENTIALS_SKIPPED =
        "Credentials: {applied} applied ({skipped} skipped)",
        "凭据 {applied}（跳过 {skipped}）",
        "憑據 {applied}（跳過 {skipped}）";
    DATA_SUMMARY_MEMORY = "Memory applied", "记忆已应用", "記憶已應用";
    DATA_SUMMARY_EMPTY = "The file contains no importable data", "文件不含可导入的内容", "檔案不含可匯入的內容";

    // About: the license and the links under the version, and Support.
    ABOUT_LICENSE = "Apache Maka (incubating) · Apache License 2.0", "Apache Maka (incubating) · Apache License 2.0", "Apache Maka (incubating) · Apache License 2.0";
    ABOUT_SOURCE = "Source code", "源码", "原始碼";
    ABOUT_RELEASE_NOTES = "Release notes", "发布说明", "發行說明";
    ABOUT_SUPPORT = "Support", "支持", "支援";
    ABOUT_COPY_DIAGNOSTICS = "Copy diagnostics", "复制诊断信息", "複製診斷資訊";
    ABOUT_COPY = "Copy", "复制", "複製";
    ABOUT_COPY_HELP =
        "Copy version, platform, a home-redacted workspace path, and recent redacted logs. The report is written only to the clipboard and is never uploaded automatically.",
        "复制版本、平台、隐藏主目录后的工作区路径与近期脱敏日志；仅写入剪贴板，不会自动上传。",
        "複製版本、平臺、隱藏主目錄後的工作區路徑，以及近期脫敏的 Desktop 與 Runtime Host 記錄；僅寫入剪貼簿，不會自動上傳。";
    ABOUT_COPIED = "Diagnostics copied", "已复制诊断信息", "已複製診斷資訊";
    ABOUT_PASTE_HINT =
        "Review the content, then paste it into an issue report",
        "检查内容后，可直接粘贴到问题报告",
        "檢查內容後，可直接貼上到問題報告";
    ABOUT_REPORT_ISSUE = "Report an issue", "报告问题", "報告問題";
    ABOUT_REPORT_ISSUE_HELP =
        "Open a GitHub issue with your diagnostics attached — replies come faster.",
        "带上诊断信息去 GitHub Issues，回复更快。",
        "帶上診斷資訊去 GitHub Issues，回覆更快。";
    ABOUT_OPEN = "Open", "打开", "開啟";
    ABOUT_SHORTCUTS = "Keyboard shortcuts", "键盘快捷键", "鍵盤快捷鍵";
    ABOUT_SHORTCUTS_HELP = "Every shortcut Maka responds to.", "Maka 支持的全部快捷键一览。", "Maka 支援的全部快捷鍵一覽。";
    ABOUT_VIEW = "View", "查看", "檢視";
}
