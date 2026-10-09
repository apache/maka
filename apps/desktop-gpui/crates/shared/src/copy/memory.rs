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

//! Interface copy of the Memory settings page, in Maka Desktop's words
//! (apps/desktop/src/renderer/locales/settings-memory-copy.ts, and the
//! group headings of settings-shared-copy.ts). Same rules as the parent
//! module.

use super::{Locale, Text, plural};

texts! {
    // The switches. Desktop gives this group no heading (it would repeat
    // the page's); the page here has more groups under it, so it takes
    // Desktop's name for the same data (settings-data-copy.ts `memory`).
    SOURCES_TITLE = "Local memory", "本地记忆", "本地記憶";
    SOURCES_HELP =
        "Maka remembers information you confirm in chat and uses it in later answers.",
        "Maka 会在任务中记住你确认过的信息，用于之后的回答。",
        "Maka 會在任務中記住你確認過的資訊，用於之後的回答。";
    LOCAL_FILE = "Local MEMORY.md", "本地 MEMORY.md", "本地 MEMORY.md";
    LOCAL_FILE_HELP =
        "A transparent Markdown file stored in the current local workspace. Content is never extracted from chats automatically.",
        "透明 Markdown 文件，保存在当前本机工作区。这里的内容不会自动从聊天里抽取。",
        "透明 Markdown 檔案，儲存在目前本機工作區。這裡的內容不會自動從聊天裡抽取。";
    ENABLE_LOCAL_FILE = "Enable local MEMORY.md", "启用本地 MEMORY.md", "啟用本地 MEMORY.md";
    AGENT_READABLE = "Available to model context", "模型上下文可读取", "模型上下文可讀取";
    AGENT_READABLE_HELP =
        "Off by default. When enabled, local memory is given to the model along with your message; incognito mode still withholds it.",
        "默认关闭。开启后，发送消息时会把本地记忆一并提供给模型；隐身模式下仍然不提供。",
        "預設關閉。開啟後，傳送訊息時會把本地記憶一併提供給模型；隱身模式下仍然不提供。";
    ENABLE_AGENT_READ =
        "Allow model context to read local memory",
        "允许模型上下文读取本地记忆",
        "允許模型上下文讀取本地記憶";
    STATUS_OK = "Local file ready", "本地文件已就绪", "本地檔案已就緒";
    STATUS_DISABLED = "Off", "已关闭", "已關閉";
    STATUS_SAFE_MODE = "Safe mode", "安全模式", "安全模式";
    STATUS_INCOGNITO = "Disabled in incognito", "隐身禁用", "隱身停用";
    STATUS_ERROR = "Read failed", "读取失败", "讀取失敗";
    TOGGLE_FAILED = "Failed to update local memory", "更新本地记忆开关失败", "更新本地記憶開關失敗";
    AGENT_READ_FAILED =
        "Failed to update model read access",
        "更新模型读取权限失败",
        "更新模型讀取權限失敗";
    LOAD_FAILED = "Failed to load local memory", "载入本地记忆失败", "載入本地記憶失敗";

    // What Maka remembers.
    ENTRIES = "What Maka remembers", "已记住的内容", "已記住的內容";
    ENTRIES_HELP =
        "Filter entries, add one manually, or archive what is no longer needed.",
        "可以筛选、手动添加，或把不再需要的条目归档。",
        "可以篩選、手動新增，或把不再需要的條目歸檔。";
    MANUAL_ADD = "Add memory manually", "手动添加记忆", "手動新增記憶";
    MANUAL_ADD_HELP =
        "Written to the local MEMORY.md immediately.",
        "填写后立即写入本机 MEMORY.md。",
        "填寫後立即寫入本機 MEMORY.md。";
    ENTRY_TITLE = "Memory title", "记忆标题", "記憶標題";
    ENTRY_TITLE_PLACEHOLDER = "Title", "标题", "標題";
    ENTRY_CONTENT = "Memory content", "记忆内容", "記憶內容";
    ENTRY_CONTENT_PLACEHOLDER = "Content", "内容", "內容";
    ADD_ENTRY = "Add memory", "添加记忆", "新增記憶";
    ADDING = "Adding…", "添加中…", "新增中…";
    CANCEL = "Cancel", "取消", "取消";
    EMPTY_TITLE = "Title is required", "标题不能为空", "標題不能為空";
    EMPTY_TITLE_DETAIL = "Give this memory a short title.", "给这条记忆起一个短标题。", "給這條記憶起一個短標題。";
    EMPTY_CONTENT = "Content is required", "内容不能为空", "內容不能為空";
    EMPTY_CONTENT_DETAIL =
        "Enter the preference or fact to retain.",
        "写下要保留的偏好或事实。",
        "寫下要保留的偏好或事實。";
    ADDED = "Memory added", "已添加记忆", "已新增記憶";
    ADDED_DETAIL = "Written to MEMORY.md.", "已写入 MEMORY.md。", "已寫入 MEMORY.md。";
    FILTER_LABEL = "Filter local memory", "筛选本地记忆", "篩選本地記憶";
    FILTER_PLACEHOLDER =
        "Filter title, content, ID, or tags",
        "筛选标题、内容、ID 或标签",
        "篩選標題、內容、ID 或標籤";
    CLEAR = "Clear", "清除", "清除";
    COUNT_ENTRIES_ONE = "{count} memory", "{count} 条记忆", "{count} 則記憶";
    COUNT_ENTRIES_OTHER = "{count} memories", "{count} 条记忆", "{count} 則記憶";
    COUNT_MATCHES = "{filtered} / {total} matching", "{filtered} / {total} 条匹配", "{filtered} / {total} 則符合";
    FILTER_EMPTY = "No matching memory entries", "没有匹配的记忆条目", "沒有符合的記憶條目";
    FILTER_EMPTY_HELP =
        "Filtering does not modify MEMORY.md. Clear the filter to show all entries.",
        "筛选不会修改 MEMORY.md；清除筛选后会恢复显示全部条目。",
        "篩選不會修改 MEMORY.md；清除篩選後會恢復顯示全部條目。";
    ACTIVE_MEMORIES = "Active memories", "生效记忆", "生效記憶";
    ARCHIVED_MEMORIES = "Archived memories", "已归档记忆", "已歸檔記憶";
    NO_ENTRY = "No entries yet.", "暂无条目。", "暫無條目。";
    NO_MATCH_ENTRY = "No matching entries.", "无匹配条目。", "無符合條目。";
    WAITING_ENTRY = "Ready to add a memory entry", "等待添加记忆条目", "等待新增記憶條目";
    WAITING_ENTRY_HELP =
        "Confirm a memory in chat, or use “Add memory manually” above.",
        "在任务里确认记忆，或点上方的「手动添加记忆」。",
        "在任務裡確認記憶，或點上方的「手動新增記憶」。";
    ORIGIN_MANUAL = "Manual entry", "手动记录", "手動記錄";
    ORIGIN_EXTRACTED = "Confirmed extraction", "确认提取", "確認提取";
    ORIGIN_UNKNOWN = "Handwritten entry", "手写条目", "手寫條目";
    UPDATED = "Updated {time}", "更新 {time}", "更新 {time}";
    ENTRY_ACTIVE = "Active", "生效", "生效";
    ENTRY_ARCHIVED = "Archived", "已归档", "已歸檔";
    ARCHIVE_ACTION = "Archive", "归档", "歸檔";
    RESTORE_ACTION = "Restore", "恢复", "恢復";
    COPY_REFERENCE = "Copy reference", "复制引用", "複製引用";
    ARCHIVED = "Memory archived", "已归档记忆", "已歸檔記憶";
    RESTORED = "Memory restored", "已恢复记忆", "已恢復記憶";
    ARCHIVE_FAILED = "Failed to archive memory", "归档记忆失败", "歸檔記憶失敗";
    ENTRY_RESTORE_FAILED = "Failed to restore memory", "恢复记忆失败", "恢復記憶失敗";
    ENTRY_REFERENCE_COPIED = "Memory reference copied", "已复制记忆引用", "已複製記憶引用";

    // The file and its backups.
    DOCUMENT = "Memory file and backups", "记忆文件与备份", "記憶檔案與備份";
    DOCUMENT_HELP =
        "Memory lives in a local MEMORY.md; edit the raw file or restore a backup here.",
        "记忆保存在本机 MEMORY.md 里；这里可以直接编辑原文或恢复备份。",
        "記憶儲存在本機 MEMORY.md 裡；這裡可以直接編輯原文或恢復備份。";
    SHOW_DETAILS = "Show details", "展开详情", "展開詳情";
    HIDE_DETAILS = "Hide details", "收起详情", "收起詳情";
    WAITING_BACKUP =
        "Waiting to create a previous-version backup",
        "等待生成上一版备份",
        "等待生成上一版備份";
    DIRTY = "Unsaved changes", "有未保存修改", "有未儲存修改";
    SAVED_DRAFT = "Draft saved", "草稿已保存", "草稿已儲存";
    BACKUP_CANDIDATES = "Backup candidates", "备份候选", "備份候選";
    BACKUP_HELP =
        "Previous-version actions use the latest candidate. Only metadata is shown here, never backup contents.",
        "上一版操作会使用最近的候选；这里只显示 metadata，不展示备份正文。",
        "上一版操作會使用最近的候選；這裡只顯示 metadata，不展示備份正文。";
    OPEN = "Open", "打开", "開啟";
    RESTORE = "Restore", "恢复", "恢復";
    RESTORING = "Restoring…", "恢复中…", "恢復中…";
    BACKUP_SAVE = "Before save", "保存前备份", "儲存前備份";
    BACKUP_RESET = "Before reset", "重置前备份", "重置前備份";
    BACKUP_RESTORE = "Before restore", "恢复前备份", "恢復前備份";
    ACTIVE_ENTRIES_ONE = "{count} active entry", "{count} 条生效", "{count} 則生效";
    ACTIVE_ENTRIES_OTHER = "{count} active entries", "{count} 条生效", "{count} 則生效";
    ARCHIVED_ENTRIES_ONE = "{count} archived entry", "{count} 条已归档", "{count} 則已歸檔";
    ARCHIVED_ENTRIES_OTHER = "{count} archived entries", "{count} 条已归档", "{count} 則已歸檔";
    BACKUP_OVERSIZE = "Backup is too large to preview entries", "备份过大，无法预览条目", "備份過大，無法預覽條目";
    /// A backup's line: its kind, what it holds, and when.
    OPEN_BACKUP_LABEL = "Open backup candidate {label}", "打开备份候选 {label}", "開啟備份候選 {label}";
    RESTORE_BACKUP_LABEL = "Restore backup candidate {label}", "恢复备份候选 {label}", "還原備份候選 {label}";
    FILE_CONTENT = "MEMORY.md content", "MEMORY.md 内容", "MEMORY.md 內容";
    FILE_ACTIONS = "MEMORY.md file actions", "MEMORY.md 文件操作", "MEMORY.md 檔案操作";
    SAVE = "Save", "保存", "儲存";
    SAVING = "Saving…", "保存中…", "儲存中…";
    SAVED = "Saved", "已保存", "已儲存";
    OPEN_FILE = "Open MEMORY.md", "打开 MEMORY.md", "開啟 MEMORY.md";
    RELOAD = "Reload", "重新载入", "重新載入";
    LOADING = "Loading…", "载入中…", "載入中…";
    OPEN_FOLDER = "Open containing folder", "打开所在目录", "開啟所在目錄";
    COPY_PATH = "Copy path", "复制路径", "複製路徑";
    RESET_BACKUP = "Reset and back up", "重置并备份", "重置並備份";
    RESETTING = "Resetting…", "重置中…", "重置中…";
    SAVED_FILE = "MEMORY.md saved", "已保存 MEMORY.md", "已儲存 MEMORY.md";
    SAVED_REDACTED = "Saved with sensitive fields redacted", "已保存并遮蔽敏感字段", "已儲存並遮蔽敏感欄位";
    SAVE_SUMMARY =
        "{entries}; the previous version was backed up.",
        "当前 {entries}；已保留上一版备份。",
        "目前 {entries}；已保留上一版備份。";
    SAVE_FAILED = "Failed to save MEMORY.md", "保存 MEMORY.md 失败", "儲存 MEMORY.md 失敗";
    SAVE_BLOCKED = "Save blocked", "保存被拦截", "儲存被攔截";
    SAFE_MODE = "MEMORY.md is too large and entered safe mode.", "MEMORY.md 内容过大，已进入安全模式。", "MEMORY.md 內容過大，已進入安全模式。";
    RESET_DONE = "MEMORY.md reset", "已重置 MEMORY.md", "已重置 MEMORY.md";
    RESET_DONE_DETAIL = "The previous version was saved as a backup.", "上一版已保存为备份文件。", "上一版已儲存為備份檔案。";
    RESET_FAILED = "Failed to reset MEMORY.md", "重置 MEMORY.md 失败", "重置 MEMORY.md 失敗";
    RELOADED = "MEMORY.md reloaded", "已重新载入 MEMORY.md", "已重新載入 MEMORY.md";
    RELOAD_DISCARDED = "Unsaved draft changes were discarded.", "未保存的草稿修改已丢弃。", "未儲存的草稿修改已丟棄。";
    RESTORE_CANDIDATE_TITLE = "Restore this MEMORY.md backup?", "恢复这个 MEMORY.md 备份？", "恢復這個 MEMORY.md 備份？";
    RESTORE_CANDIDATE_DESCRIPTION =
        "The current MEMORY.md will be backed up before the selected backup replaces it. Restore: {label}",
        "会先备份当前 MEMORY.md，再用选中的备份覆盖当前文件。将恢复：{label}",
        "會先備份目前的 MEMORY.md，再以選取的備份覆蓋目前檔案。將還原：{label}";
    CONFIRM_RESTORE = "Restore", "恢复", "恢復";
    RESTORED_CANDIDATE = "MEMORY.md backup candidate restored", "已恢复 MEMORY.md 备份候选", "已恢復 MEMORY.md 備份候選";
    RESTORED_DETAIL =
        "The file from before the restore was saved as restore.bak.",
        "恢复前的当前文件已保存为 restore.bak。",
        "恢復前的目前檔案已儲存為 restore.bak。";
    RESTORE_FAILED = "Failed to restore backup", "恢复备份失败", "恢復備份失敗";
    OPEN_FAILED = "Open failed", "打开失败", "開啟失敗";
    PATH_COPIED = "Path copied", "已复制路径", "已複製路徑";

    // Why an operation did not go through (Desktop's `results`).
    RESULT_FILE_NOT_FOUND = "The memory file was not found.", "找不到记忆文件。", "找不到記憶檔案。";
    RESULT_NOT_REGULAR_FILE =
        "The memory path is not an allowed regular file.",
        "记忆路径不是允许打开的常规文件。",
        "記憶路徑不是允許開啟的一般檔案。";
    RESULT_DISABLED = "Local memory is disabled.", "本地记忆已关闭。", "本機記憶已關閉。";
    RESULT_INCOGNITO = "Unavailable in incognito mode.", "隐身模式下不可用。", "隱身模式下無法使用。";
    RESULT_OVERSIZE =
        "MEMORY.md exceeds the safety limit. Remove older content first.",
        "MEMORY.md 超出安全上限，请先删减旧内容。",
        "MEMORY.md 超出安全上限，請先刪減舊內容。";
    RESULT_REVISION_CONFLICT =
        "Memory was just changed by another operation. Try again.",
        "记忆内容刚被其他操作修改，请重试。",
        "記憶內容剛被其他操作修改，請重試。";
    RESULT_BACKUP_REVISION_CONFLICT =
        "The backup was just changed by another operation. Try again.",
        "备份内容刚被其他操作修改，请重试。",
        "備份內容剛被其他操作修改，請重試。";
    RESULT_INVALID_STATE =
        "The Runtime Host returned an invalid memory state.",
        "Runtime Host 返回了无效的记忆状态。",
        "Runtime Host 回傳了無效的記憶狀態。";
    RESULT_INVALID_CONTENT =
        "MEMORY.md content is invalid. Check its format and try again.",
        "MEMORY.md 内容无效，请检查格式后重试。",
        "MEMORY.md 內容無效，請檢查格式後重試。";
    RESULT_INVALID_SCOPE =
        "The memory operation has an invalid scope.",
        "当前记忆操作的作用域无效。",
        "目前記憶操作的作用域無效。";
    RESULT_NOT_FOUND = "The memory entry was not found.", "找不到对应的记忆条目。", "找不到對應的記憶條目。";
    RESULT_NOT_PENDING =
        "The memory entry is not pending review.",
        "对应的记忆条目不在待确认状态。",
        "對應的記憶條目不在待確認狀態。";
    RESULT_UPLOAD_NOT_FOUND =
        "The memory upload session does not exist or has expired.",
        "记忆上传会话不存在或已过期。",
        "記憶上傳工作階段不存在或已過期。";
    RESULT_UPLOAD_INCOMPLETE =
        "The memory content has not finished uploading.",
        "记忆内容尚未上传完整。",
        "記憶內容尚未上傳完整。";
    RESULT_UPLOAD_CONFLICT =
        "Another memory upload is in progress. Try again.",
        "另一个记忆上传正在进行，请重试。",
        "另一個記憶上傳正在進行，請重試。";
    RESULT_BACKUP_NOT_FOUND = "The backup file was not found.", "找不到对应的备份文件。", "找不到對應的備份檔案。";

    // The model-context preview.
    PROMPT_PREVIEW = "Model context preview", "模型上下文预览", "模型上下文預覽";
    PROMPT_PREVIEW_HELP =
        "What will be given to the model when you send. Archived entries are excluded and suspected secrets are redacted.",
        "这里是发送时会提供给模型的内容；已归档条目不在其中，疑似密钥会遮蔽。",
        "這裡是傳送時會提供給模型的內容；已歸檔條目不在其中，疑似金鑰會遮蔽。";
    WILL_INJECT = "Included when sending", "发送时会提供", "傳送時會提供";
    WILL_NOT_INJECT = "Not currently included", "当前不会提供", "目前不會提供";
    COPY_CONTEXT = "Copy context", "复制上下文", "複製上下文";
    SAFE_MODE_PREVIEW =
        "MEMORY.md is too large, so no model-context preview is generated.",
        "MEMORY.md 过大，当前不会生成模型上下文预览。",
        "MEMORY.md 過大，目前不會生成模型上下文預覽。";
    EMPTY_PROMPT_PREVIEW =
        "No active memories will be given to the model.",
        "没有生效记忆会提供给模型。",
        "沒有生效記憶會提供給模型。";
    PROMPT_COPIED = "Model context preview copied", "已复制模型上下文预览", "已複製模型上下文預覽";
    PREVIEW_TRUNCATION_MARKER =
        "[Local memory truncated to the length limit]",
        "[本地记忆已按长度截断]",
        "[本地記憶已按長度截斷]";
    PREVIEW_TRUNCATED =
        "Preview truncated at the {limit}-character limit",
        "预览已按 {limit} 字符上限截断",
        "預覽已依 {limit} 字元上限截斷";
    PREVIEW_USAGE = "Preview {length} / {limit} characters", "预览 {length} / {limit} 字符", "預覽 {length} / {limit} 字元";
    PREVIEW_LIMIT = "Prompt limit: {limit} characters", "prompt 上限 {limit} 字符", "prompt 上限 {limit} 字元";
    PROMPT_BLOCKED_DISABLED = "Local memory is disabled.", "本地记忆已关闭。", "本地記憶已關閉。";
    PROMPT_BLOCKED_INCOGNITO =
        "Local memory is never added in incognito mode.",
        "隐身模式下不会提供本地记忆。",
        "隱身模式下不會提供本地記憶。";
    PROMPT_BLOCKED_SAFE_MODE =
        "MEMORY.md is too large and will not be added.",
        "MEMORY.md 过大，当前不会提供。",
        "MEMORY.md 過大，目前不會提供。";
    PROMPT_BLOCKED_AGENT_READ =
        "Model context access is disabled.",
        "模型上下文读取未开启。",
        "模型上下文讀取未開啟。";
}

fn count_text(locale: Locale, count: u64, one: Text, other: Text) -> String {
    plural(count, one, other).fill(locale, &[("count", &count.to_string())])
}

/// "2 memories", beside a list's title.
pub fn entry_count(locale: Locale, count: usize) -> String {
    count_text(locale, count as u64, COUNT_ENTRIES_ONE, COUNT_ENTRIES_OTHER)
}

/// "1 / 3 matching", beside the filter.
pub fn match_count(locale: Locale, filtered: usize, total: usize) -> String {
    COUNT_MATCHES
        .fill(locale, &[("filtered", &filtered.to_string()), ("total", &total.to_string())])
}

/// What a bundle or a backup holds: "2 active entries / 1 archived entry",
/// or only the active count when nothing is archived (Desktop's
/// `backupSummary`).
pub fn entries_summary(locale: Locale, active: u64, archived: u64) -> String {
    let active = count_text(locale, active, ACTIVE_ENTRIES_ONE, ACTIVE_ENTRIES_OTHER);
    if archived == 0 {
        return active;
    }
    let archived = count_text(locale, archived, ARCHIVED_ENTRIES_ONE, ARCHIVED_ENTRIES_OTHER);
    format!("{active} / {archived}")
}

/// The line after a save: what MEMORY.md now holds, and that the previous
/// version was kept (Desktop's `saveSummary`).
pub fn save_summary(locale: Locale, active: u64, archived: u64) -> String {
    SAVE_SUMMARY.fill(locale, &[("entries", &entries_summary(locale, active, archived))])
}

/// A text with its one `{label}` filled.
pub fn labeled(locale: Locale, text: Text, label: &str) -> String {
    text.fill(locale, &[("label", label)])
}

/// "Updated 5 minutes ago".
pub fn updated(locale: Locale, time: &str) -> String {
    UPDATED.fill(locale, &[("time", time)])
}

/// An entry's button, named for what it does to which entry: "Archive:
/// Preference · Manual entry".
pub fn entry_action(locale: Locale, action: Text, identity: &str) -> String {
    super::labeled(locale, action.in_locale(locale), identity)
}

/// `count` with thousands separators, as `toLocaleString` writes it in
/// each of the three locales ("12,000").
pub fn grouped(count: usize) -> String {
    let digits = count.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (ix, digit) in digits.chars().enumerate() {
        if ix > 0 && (digits.len() - ix).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

/// The budget line of the preview: its length against the limit, the
/// limit it was cut at, or the limit alone when there is no preview.
pub fn preview_budget(
    locale: Locale,
    length: Option<usize>,
    truncated: bool,
    limit: usize,
) -> String {
    let limit = grouped(limit);
    match length {
        Some(_) if truncated => PREVIEW_TRUNCATED.fill(locale, &[("limit", &limit)]),
        Some(length) => {
            PREVIEW_USAGE.fill(locale, &[("length", &grouped(length)), ("limit", &limit)])
        }
        None => PREVIEW_LIMIT.fill(locale, &[("limit", &limit)]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EN: Locale = Locale::English;

    #[test]
    fn the_counted_lines_read_as_desktops() {
        assert_eq!(entry_count(EN, 1), "1 memory");
        assert_eq!(entry_count(EN, 2), "2 memories");
        assert_eq!(match_count(EN, 1, 3), "1 / 3 matching");
        assert_eq!(entries_summary(EN, 2, 0), "2 active entries");
        assert_eq!(entries_summary(EN, 1, 1), "1 active entry / 1 archived entry");
        assert_eq!(
            save_summary(Locale::SimplifiedChinese, 2, 1),
            "当前 2 条生效 / 1 条已归档；已保留上一版备份。"
        );
        assert_eq!(save_summary(EN, 2, 0), "2 active entries; the previous version was backed up.");
        assert_eq!(grouped(12_000), "12,000");
        assert_eq!(grouped(999), "999");
        assert_eq!(grouped(1_234_567), "1,234,567");
        assert_eq!(
            preview_budget(EN, Some(1_234), false, 12_000),
            "Preview 1,234 / 12,000 characters"
        );
        assert_eq!(
            preview_budget(EN, Some(12_000), true, 12_000),
            "Preview truncated at the 12,000-character limit"
        );
        assert_eq!(preview_budget(EN, None, false, 12_000), "Prompt limit: 12,000 characters");
    }
}
