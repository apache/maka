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

//! Interface copy of the settings pages that manage tasks: Archived tasks
//! (settings-tasks-copy.ts in apps/desktop/src/renderer/locales/) and
//! Import/export tasks (external-session-import-copy.ts). Same rules as the
//! parent module; the strings are Maka Desktop's. Deleting one task asks in
//! the sidebar's words ([`super::DELETE_TASK_BODY`]).

use super::{Locale, plural};

texts! {
    // Archived tasks.
    ARCHIVED_LIST = "Archived tasks", "已归档任务", "已歸檔任務";
    ARCHIVED_NO_PROJECT = "No project", "无项目", "無專案";
    /// A subtask whose parent task was deleted, which stays a row of its own.
    ARCHIVED_DELETED_PARENT = "Parent task deleted", "原父任务已删除", "原父任務已刪除";
    ARCHIVED_SEARCH = "Search archived tasks", "搜索已归档任务", "搜尋已歸檔任務";
    ARCHIVED_PURGE_ALL = "Clear all", "清空全部", "清空全部";
    ARCHIVED_PURGE_MATCHES_ONE = "Delete this {count}", "删除这 {count} 条", "刪除這 {count} 條";
    ARCHIVED_PURGE_MATCHES_OTHER = "Delete these {count}", "删除这 {count} 条", "刪除這 {count} 條";
    ARCHIVED_PURGE_ALL_TITLE_ONE =
        "Clear the {count} archived task?",
        "清空全部 {count} 条已归档任务？",
        "清空全部 {count} 條已歸檔任務？";
    ARCHIVED_PURGE_ALL_TITLE_OTHER =
        "Clear all {count} archived tasks?",
        "清空全部 {count} 条已归档任务？",
        "清空全部 {count} 條已歸檔任務？";
    ARCHIVED_PURGE_MATCHES_TITLE_ONE =
        "Delete the {count} task you searched for?",
        "删除搜索到的 {count} 条任务？",
        "刪除搜尋到的 {count} 條任務？";
    ARCHIVED_PURGE_MATCHES_TITLE_OTHER =
        "Delete the {count} tasks you searched for?",
        "删除搜索到的 {count} 条任务？",
        "刪除搜尋到的 {count} 條任務？";
    ARCHIVED_PURGE_BODY =
        "The tasks and all of their messages are removed permanently. This cannot be undone.",
        "这些任务及其全部消息会被永久删除，无法撤销。",
        "這些任務及其全部訊息會被永久刪除，無法撤銷。";
    ARCHIVED_PURGE_SUBTASKS =
        "Any ordinary subtasks are kept and moved to Archived.",
        "其中的普通子任务不会被删除，将保留并移入归档。",
        "其中的普通子任務不會被刪除，將保留並移入歸檔。";
    ARCHIVED_PURGE_CONFIRM = "Delete permanently", "永久删除", "永久刪除";
    ARCHIVED_PURGED_ONE = "Deleted {count} task", "已删除 {count} 条任务", "已刪除 {count} 條任務";
    ARCHIVED_PURGED_OTHER = "Deleted {count} tasks", "已删除 {count} 条任务", "已刪除 {count} 條任務";
    ARCHIVED_PURGED_SUBTASKS_ONE =
        "{count} subtask moved to Archived",
        "{count} 个子任务已移入归档",
        "{count} 個子任務已移入歸檔";
    ARCHIVED_PURGED_SUBTASKS_OTHER =
        "{count} subtasks moved to Archived",
        "{count} 个子任务已移入归档",
        "{count} 個子任務已移入歸檔";
    ARCHIVED_KEPT_RESTORED_ONE =
        "{count} more was restored meanwhile and kept.",
        "另有 {count} 条在此期间被恢复，已保留。",
        "另有 {count} 條在此期間被恢復，已保留。";
    ARCHIVED_KEPT_RESTORED_OTHER =
        "{count} more were restored meanwhile and kept.",
        "另有 {count} 条在此期间被恢复，已保留。",
        "另有 {count} 條在此期間被恢復，已保留。";
    ARCHIVED_PURGE_FAILED = "Could not delete the tasks", "删除任务失败", "刪除任務失敗";
    ARCHIVED_PURGE_REMAINING_ONE =
        "{count} task is still there. Try again.",
        "{count} 条仍在，请重试。",
        "{count} 條仍在，請重試。";
    ARCHIVED_PURGE_REMAINING_OTHER =
        "{count} tasks are still there. Try again.",
        "{count} 条仍在，请重试。",
        "{count} 條仍在，請重試。";
    ARCHIVED_PURGE_UNVERIFIED =
        "The tasks were deleted, but the list could not be read back to confirm. Reopen this page to check.",
        "任务已删除，但无法读取列表确认结果。请重新打开本页查看。",
        "任務已刪除，但無法讀取列表確認結果。請重新開啟本頁檢視。";
    ARCHIVED_NO_MATCH = "No matching tasks", "没有匹配的任务", "沒有符合的任務";
    ARCHIVED_NO_MATCH_HELP = "Try a different search.", "换个关键词试试。", "換個關鍵詞試試。";
    ARCHIVED_UNARCHIVE = "Unarchive", "取消归档", "取消歸檔";
    ARCHIVED_UNARCHIVE_TASK = "Unarchive {name}", "取消归档「{name}」", "取消歸檔「{name}」";
    ARCHIVED_DELETE = "Delete", "彻底删除", "徹底刪除";
    ARCHIVED_DELETE_TASK = "Delete {name}", "彻底删除「{name}」", "徹底刪除「{name}」";
    ARCHIVED_EMPTY = "Nothing archived", "没有已归档的任务", "沒有已歸檔的任務";
    ARCHIVED_EMPTY_HELP =
        "Archive a task from the rail to restore or permanently delete it here.",
        "在侧栏里归档一个任务后，可以在这里恢复或彻底删除它。",
        "在側欄裡歸檔一個任務後，可以在這裡恢復或徹底刪除它。";
    ARCHIVED_LOADING = "Loading archived tasks…", "正在加载已归档任务…", "正在載入已歸檔任務…";
    ARCHIVED_LOAD_FAILED = "Couldn’t load the tasks.", "无法加载任务。", "無法載入任務。";
    ARCHIVED_OFFLINE =
        "Connect to the Runtime Host to see archived tasks.",
        "连接到 Runtime Host 后才能查看已归档任务。",
        "連線至 Runtime Host 後才能檢視已歸檔任務。";
    /// A task restored between the question and the deletion, and so kept.
    ARCHIVED_DELETE_RESTORED =
        "{name} was restored, so it was kept",
        "{name} 已被恢复，未删除",
        "{name} 已被恢復，未刪除";
    ARCHIVED_DELETED = "Deleted {name}", "已删除 {name}", "已刪除 {name}";

    // Import/export tasks: the mode, the sources, and a Maka session file.
    TRANSFER_MODE = "Import or export", "导入或导出", "匯入或匯出";
    TRANSFER_IMPORT = "Import tasks", "导入任务", "匯入任務";
    TRANSFER_EXPORT = "Export tasks", "导出任务", "匯出任務";
    SOURCE = "Source", "来源", "來源";
    SOURCE_BUNDLE = "Maka session file", "Maka 会话文件", "Maka 工作階段檔案";
    BUNDLE_IMPORT_HELP =
        "Pick a .maka-session file another Maka exported. The files the task produced and the subagent conversations under it come with it; model keys are not in the file and have to be configured here.",
        "选择另一个 Maka 导出的 .maka-session 文件。任务产生的文件和子 Agent 对话会一起带过来；模型密钥不在文件里，需要在本机重新配置。",
        "選擇另一個 Maka 匯出的 .maka-session 檔案。任務產生的檔案與子 Agent 對話會一起帶過來；模型金鑰不在檔案裡，需要在本機重新設定。";
    BUNDLE_CHOOSE = "Choose a file…", "选择文件…", "選擇檔案…";
    BUNDLE_IMPORTED_ONE = "Imported {count} task", "已导入 {count} 个任务", "已匯入 {count} 個任務";
    BUNDLE_IMPORTED_OTHER = "Imported {count} tasks", "已导入 {count} 个任务", "已匯入 {count} 個任務";
    EXPORT_TITLE = "Export a task", "导出任务", "匯出任務";
    EXPORT_HELP =
        "Write a task to a .maka-session file to import on another machine, or in another build of Maka. The subagent conversations under it are carried with it.",
        "把一个任务写成 .maka-session 文件，在另一台机器或另一个版本的 Maka 里导入。它下面的子 Agent 对话会一起导出。",
        "把一個任務寫成 .maka-session 檔案，在另一台機器或另一個版本的 Maka 匯入。它底下的子 Agent 對話會一起匯出。";
    EXPORT = "Export", "导出", "匯出";
    EXPORT_TASK = "Export {name}", "导出「{name}」", "匯出「{name}」";
    EXPORT_CARRIES_ONE =
        "Carries {count} subagent conversation",
        "含 {count} 个子 Agent 对话",
        "含 {count} 個子 Agent 對話";
    EXPORT_CARRIES_OTHER =
        "Carries {count} subagent conversations",
        "含 {count} 个子 Agent 对话",
        "含 {count} 個子 Agent 對話";
    EXPORT_CONFIRM_ONE =
        "Export with {count} subagent conversation?",
        "连同 {count} 个子 Agent 对话一起导出？",
        "連同 {count} 個子 Agent 對話一起匯出？";
    EXPORT_CONFIRM_OTHER =
        "Export with {count} subagent conversations?",
        "连同 {count} 个子 Agent 对话一起导出？",
        "連同 {count} 個子 Agent 對話一起匯出？";
    EXPORT_CONFIRM_BODY =
        "The file holds this task and every subagent conversation under it. A subagent conversation is the result of a tool call this task made, so leaving one behind leaves a hole in the record.",
        "文件里会包含这个任务和它下面的全部子 Agent 对话。子 Agent 的对话是这个任务某次工具调用的结果，单独留下会让记录不完整。",
        "檔案裡會包含這個任務和它底下的全部子 Agent 對話。子 Agent 的對話是這個任務某次工具呼叫的結果，單獨留下會讓紀錄不完整。";
    EXPORT_EMPTY = "No task to export yet.", "还没有可以导出的任务。", "還沒有可以匯出的任務。";
    EXPORTED_ONE = "Exported {count} task", "已导出 {count} 个任务", "已匯出 {count} 個任務";
    EXPORTED_OTHER = "Exported {count} tasks", "已导出 {count} 个任务", "已匯出 {count} 個任務";
    BUNDLE_BUSY = "That task is running. Let it finish first.", "这个任务正在运行，先等它结束再导出。", "這個任務正在執行，先等它結束再匯出。";
    BUNDLE_SUBTREE_CHANGED =
        "The subagent conversations under this task changed after you confirmed. Export again to confirm what is there now.",
        "这个任务下面的子 Agent 对话在你确认之后变了。再导出一次，确认新的内容。",
        "這個任務底下的子 Agent 對話在你確認之後變了。再匯出一次，確認新的內容。";
    BUNDLE_CONFLICT =
        "The destination is taken, or this workspace already has that task.",
        "目标已存在，或这个工作区已经有同一个任务。",
        "目標已存在，或這個工作區已經有同一個任務。";
    BUNDLE_UNREADABLE =
        "The file could not be read, or it came from a Maka this build does not know.",
        "文件无法读取，或它来自这个版本不认识的 Maka。",
        "檔案無法讀取，或它來自這個版本不認識的 Maka。";
    BUNDLE_FAILED = "That did not work.", "操作失败。", "操作失敗。";

    // Import/export tasks: another agent's conversations.
    INCLUDE_ARCHIVED = "Include archived conversations", "包含已归档的对话", "包含已歸檔的對話";
    IMPORT_SEARCH = "Search", "搜索", "搜尋";
    IMPORT_SEARCH_HELP =
        "Matches the conversation title and the project path. Empty shows everything.",
        "匹配对话标题与项目路径。留空显示全部。",
        "符合對話標題與專案路徑。留空顯示全部。";
    IMPORT_SEARCH_PLACEHOLDER = "Part of a title or path", "标题或路径的一部分", "標題或路徑的一部分";
    IMPORT_SEARCH_EMPTY =
        "No conversation has “{term}” in its title or path.",
        "没有标题或路径包含「{term}」的对话。",
        "沒有標題或路徑包含「{term}」的對話。";
    IMPORT_LOADING = "Reading external conversations…", "正在读取外部对话…", "正在讀取外部對話…";
    IMPORT_LIST = "Conversations available to import", "可导入的对话", "可匯入的對話";
    IMPORT_EMPTY = "No conversations to import", "没有可导入的对话", "沒有可匯入的對話";
    IMPORT_EMPTY_HELP =
        "No matching root conversations were found in this source.",
        "当前来源中没有找到符合条件的根对话。",
        "目前來源中沒有找到符合條件的根對話。";
    IMPORT_UNAVAILABLE = "No supported Agent detected", "没有检测到支持的 Agent", "沒有檢測到支援的 Agent";
    IMPORT_UNAVAILABLE_HELP =
        "Once Codex, Claude Code, or OpenCode has been used on this machine, its conversations appear here. Maka only reads those files and never modifies them.",
        "在本机使用过 Codex、Claude Code 或 OpenCode 后，它们的对话会出现在这里。Maka 只读取这些文件，不会修改。",
        "在本機使用過 Codex、Claude Code 或 OpenCode 後，它們的對話會出現在這裡。Maka 只讀取這些檔案，不會修改。";
    IMPORT_LOAD_FAILED = "Could not read external conversations", "无法读取外部对话", "無法讀取外部對話";
    IMPORT_ARCHIVED = "Archived", "已归档", "已歸檔";
    IMPORT_LOAD_MORE = "Load more", "加载更多", "載入更多";
    IMPORT_LOADING_MORE = "Loading…", "正在加载…", "正在載入…";
    IMPORT_DUPLICATE_NOTE =
        "Importing the same conversation again creates an independent task.",
        "再次导入同一个对话会创建一个独立的任务。",
        "再次匯入同一個對話會建立一個獨立的任務。";
    IMPORTED_ONCE = "Imported once", "已导入 1 次", "已匯入 1 次";
    IMPORTED_TIMES = "Imported {count} times", "已导入 {count} 次", "已匯入 {count} 次";
    OPEN_IMPORTED = "Open latest imported task", "打开最近导入的任务", "開啟最近匯入的任務";
    OPEN_IMPORTED_FOR =
        "Open the latest task imported from {name}",
        "打开「{name}」最近导入的任务",
        "開啟「{name}」最近匯入的任務";
    IMPORT = "Import", "导入", "匯入";
    IMPORT_AGAIN = "Import again", "再次导入", "再次匯入";
    IMPORT_TASK = "Import {name}", "导入「{name}」", "匯入「{name}」";
    IMPORT_TASK_AGAIN = "Import {name} again", "再次导入「{name}」", "再次匯入「{name}」";
    IMPORTING = "Importing…", "正在导入…", "正在匯入…";
    IMPORTING_TASK = "Importing {name}", "正在导入「{name}」", "正在匯入「{name}」";
    IMPORT_IN_PROGRESS = "Import in progress", "正在导入", "正在匯入";
    IMPORT_IN_PROGRESS_HELP =
        "Importing “{name}”. Maka opens the task as soon as it lands.",
        "正在导入「{name}」，完成后会直接打开这个任务。",
        "正在匯入「{name}」，完成後會直接開啟這個任務。";
    IMPORT_FAILED = "Import failed", "导入失败", "匯入失敗";
    IMPORT_FAILED_FALLBACK =
        "This conversation could not be converted or saved. Check the source and try again.",
        "该对话无法转换或保存。请检查来源后重试。",
        "該對話無法轉換或儲存。請檢查來源後重試。";
    IMPORT_NO_MODEL =
        "No usable model connection to attach the imported task to. Configure and enable a model in Settings · Models, then import again.",
        "没有可用的模型连接，无法为导入的任务选择模型。请先在 设置 · 模型 中配置并启用一个模型后再导入。",
        "沒有可用的模型連線，無法為匯入的任務選擇模型。請先在 設定 · 模型 中設定並啟用一個模型後再匯入。";
    IMPORT_UNREADABLE =
        "This conversation could not be read or converted — it may be too large, malformed, or temporarily unreadable. Check the source and try again.",
        "无法读取或转换该对话，它可能过大、已损坏或暂时无法读取。请检查来源后重试。",
        "無法讀取或轉換該對話，它可能過大、已損毀或暫時無法讀取。請檢查來源後重試。";
    IMPORT_LIMIT_BYTES =
        "This conversation exceeds the import limit: {what} allows at most {max} bytes. Reduce the source conversation; retrying it unchanged will not help.",
        "该对话超过导入限制：{what}最多 {max} 字节。请缩小源对话；直接重试不会改变此限制。",
        "該對話超過匯入限制：{what}最多 {max} 位元組。請縮小來源對話；直接重試不會改變此限制。";
    IMPORT_LIMIT_COUNT =
        "This conversation exceeds the import limit: {what} allows at most {max}. Reduce the source conversation; retrying it unchanged will not help.",
        "该对话超过导入限制：{what}最多 {max} 条。请缩小源对话；直接重试不会改变此限制。",
        "該對話超過匯入限制：{what}最多 {max} 筆。請縮小來源對話；直接重試不會改變此限制。";
    LIMIT_TRANSCRIPT_BYTES = "source file size", "源文件大小", "來源檔案大小";
    LIMIT_RECORD_BYTES = "single record size", "单条记录大小", "單筆記錄大小";
    LIMIT_RECORDS = "record count", "记录数量", "記錄數量";
    LIMIT_CONVERTED_BYTES = "converted content size", "转换后内容大小", "轉換後內容大小";
    LIMIT_MESSAGES = "message count", "消息数量", "訊息數量";
    IMPORT_UNKNOWN_OUTCOME = "Check the import result", "需要确认导入结果", "需要確認匯入結果";
    IMPORT_UNKNOWN_OUTCOME_HELP =
        "Maka could not confirm the outcome of these imports: {names}. Check the task list or import again; importing again creates an independent task.",
        "以下对话的导入结果无法确认：{names}。可以先在任务列表中查找，也可以再次导入；再次导入会创建独立任务。",
        "以下對話的匯入結果無法確認：{names}。可以先在任務列表中查詢，也可以再次匯入；再次匯入會建立獨立任務。";
    SELECT_ALL = "Select all or none", "全选或全不选", "全選或全部取消選取";
    SELECTED_COUNT = "{selected} / {listed} selected", "已选 {selected} / {listed}", "已選 {selected} / {listed}";
    SELECT_ROW = "Select {name}", "选择 {name}", "選取 {name}";
    IMPORT_SELECTED = "Import selected", "导入所选", "匯入所選項目";
    BATCH_PROGRESS = "Importing {done} / {total}", "正在导入 {done} / {total}", "正在匯入 {done} / {total}";
    BATCH_DONE = "Imported {count} conversations", "已导入 {count} 个对话", "已匯入 {count} 個對話";
    BATCH_DUPLICATED =
        "{count} of them had been imported before and now exist twice.",
        "其中 {count} 个之前已导入过，现在各有两份。",
        "其中 {count} 個先前已匯入，現在各有兩份。";
    BATCH_FAILED = "{count} more could not be imported.", "另有 {count} 个没能导入。", "另有 {count} 個無法匯入。";
    BATCH_NOTHING = "No conversation was imported.", "没有对话被导入。", "沒有匯入任何對話。";
    /// A name inside a sentence, quoted as the locale quotes one.
    QUOTED = "“{name}”", "「{name}」", "「{name}」";
}

fn counted(locale: Locale, count: usize, one: super::Text, other: super::Text) -> String {
    plural(count as u64, one, other).fill(locale, &[("count", &count.to_string())])
}

/// "Delete these N": the button while a search narrows the list.
pub fn purge_matches(locale: Locale, count: usize) -> String {
    counted(locale, count, ARCHIVED_PURGE_MATCHES_ONE, ARCHIVED_PURGE_MATCHES_OTHER)
}

/// The question before a sweep: all archived tasks, or the ones searched for.
pub fn purge_title(locale: Locale, count: usize, searching: bool) -> String {
    if searching {
        counted(locale, count, ARCHIVED_PURGE_MATCHES_TITLE_ONE, ARCHIVED_PURGE_MATCHES_TITLE_OTHER)
    } else {
        counted(locale, count, ARCHIVED_PURGE_ALL_TITLE_ONE, ARCHIVED_PURGE_ALL_TITLE_OTHER)
    }
}

pub fn purged(locale: Locale, count: usize) -> String {
    counted(locale, count, ARCHIVED_PURGED_ONE, ARCHIVED_PURGED_OTHER)
}

pub fn purged_subtasks(locale: Locale, count: usize) -> String {
    counted(locale, count, ARCHIVED_PURGED_SUBTASKS_ONE, ARCHIVED_PURGED_SUBTASKS_OTHER)
}

pub fn kept_restored(locale: Locale, count: usize) -> String {
    counted(locale, count, ARCHIVED_KEPT_RESTORED_ONE, ARCHIVED_KEPT_RESTORED_OTHER)
}

pub fn purge_remaining(locale: Locale, count: usize) -> String {
    counted(locale, count, ARCHIVED_PURGE_REMAINING_ONE, ARCHIVED_PURGE_REMAINING_OTHER)
}

pub fn unarchive_task(locale: Locale, name: &str) -> String {
    ARCHIVED_UNARCHIVE_TASK.fill(locale, &[("name", name)])
}

pub fn delete_task(locale: Locale, name: &str) -> String {
    ARCHIVED_DELETE_TASK.fill(locale, &[("name", name)])
}

pub fn delete_restored(locale: Locale, name: &str) -> String {
    ARCHIVED_DELETE_RESTORED.fill(locale, &[("name", name)])
}

pub fn deleted(locale: Locale, name: &str) -> String {
    ARCHIVED_DELETED.fill(locale, &[("name", name)])
}

/// The names a row or a report quotes, joined as the locale lists them.
pub fn quoted_list(locale: Locale, names: &[String]) -> String {
    let quoted: Vec<String> =
        names.iter().map(|name| QUOTED.fill(locale, &[("name", name)])).collect();
    let separator = if locale == Locale::English { ", " } else { "、" };
    quoted.join(separator)
}

pub fn bundle_imported(locale: Locale, count: u64) -> String {
    counted(locale, count as usize, BUNDLE_IMPORTED_ONE, BUNDLE_IMPORTED_OTHER)
}

pub fn exported(locale: Locale, count: u64) -> String {
    counted(locale, count as usize, EXPORTED_ONE, EXPORTED_OTHER)
}

pub fn export_carries(locale: Locale, count: usize) -> String {
    counted(locale, count, EXPORT_CARRIES_ONE, EXPORT_CARRIES_OTHER)
}

pub fn export_confirm(locale: Locale, count: usize) -> String {
    counted(locale, count, EXPORT_CONFIRM_ONE, EXPORT_CONFIRM_OTHER)
}

pub fn export_task(locale: Locale, name: &str) -> String {
    EXPORT_TASK.fill(locale, &[("name", name)])
}

pub fn imported_count(locale: Locale, count: u64) -> String {
    if count == 1 {
        return IMPORTED_ONCE.in_locale(locale).to_owned();
    }
    IMPORTED_TIMES.fill(locale, &[("count", &count.to_string())])
}

pub fn named(text: super::Text, locale: Locale, name: &str) -> String {
    text.fill(locale, &[("name", name)])
}

pub fn search_empty(locale: Locale, term: &str) -> String {
    IMPORT_SEARCH_EMPTY.fill(locale, &[("term", term)])
}

pub fn selected_count(locale: Locale, selected: usize, listed: usize) -> String {
    SELECTED_COUNT
        .fill(locale, &[("selected", &selected.to_string()), ("listed", &listed.to_string())])
}

pub fn batch_progress(locale: Locale, done: usize, total: usize) -> String {
    BATCH_PROGRESS.fill(locale, &[("done", &done.to_string()), ("total", &total.to_string())])
}

pub fn batch_counted(text: super::Text, locale: Locale, count: usize) -> String {
    text.fill(locale, &[("count", &count.to_string())])
}

/// The limit a conversation went over, with its maximum grouped by
/// thousands as `toLocaleString` groups it.
pub fn import_limit(locale: Locale, kind: &str, max: u64) -> String {
    let (what, bytes) = match kind {
        "transcript_bytes" => (LIMIT_TRANSCRIPT_BYTES, true),
        "record_bytes" => (LIMIT_RECORD_BYTES, true),
        "records" => (LIMIT_RECORDS, false),
        "converted_bytes" => (LIMIT_CONVERTED_BYTES, true),
        _ => (LIMIT_MESSAGES, false),
    };
    let digits = max.to_string();
    let mut grouped = String::new();
    for (ix, digit) in digits.chars().enumerate() {
        if ix > 0 && (digits.len() - ix).is_multiple_of(3) {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    let text = if bytes { IMPORT_LIMIT_BYTES } else { IMPORT_LIMIT_COUNT };
    text.fill(locale, &[("what", what.in_locale(locale)), ("max", &grouped)])
}

pub fn unknown_outcome(locale: Locale, names: &[String]) -> String {
    IMPORT_UNKNOWN_OUTCOME_HELP.fill(locale, &[("names", &quoted_list(locale, names))])
}
