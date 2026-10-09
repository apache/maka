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

//! The changes panel (Maka Desktop's Workbar `review` tool): Desktop's
//! `workbar.review`, `workbar.launcher.review` and `reviewPanel` strings in
//! `apps/desktop/src/renderer/application/contracts/conversation-copy.ts`.

use super::{Locale, plural};

texts! {
    /// The panel's name: its header and the button that opens it.
    CHANGES = "Changes", "变更", "變更";
    /// What the panel shows, the header button's tooltip.
    CHANGES_HELP =
        "View changes in the current Git workspace",
        "查看当前 Git 工作区变化",
        "檢視目前 Git 工作區變化";
    /// The panel region's accessible name.
    PANEL_LABEL = "Git changes", "Git 变更", "Git 變更";
    /// The panel's edge (Desktop's `resizeWorkbar`).
    RESIZE_PANEL = "Resize task workbar", "调整任务工作栏宽度", "調整任務工作欄寬度";
    /// Closes the panel (Desktop's `collapseWorkbar`).
    CLOSE_PANEL = "Collapse task workbar", "收起任务工作栏", "收起任務工作欄";
    EMPTY = "No changes in the current Git workspace", "当前 Git 工作区没有变化", "目前 Git 工作區沒有變化";
    EMPTY_HELP =
        "Committed, staged, and modified files appear here.",
        "提交、暂存或修改文件后，变化会显示在这里。",
        "提交、暫存或修改檔案後，變化會顯示在這裡。";
    NOT_GIT_REPOSITORY =
        "This task directory is not a Git repository",
        "当前任务目录不是 Git 仓库",
        "目前任務目錄不是 Git 倉庫";
    WORKSPACE_UNAVAILABLE =
        "This task directory is unavailable",
        "当前任务目录已不可用",
        "目前任務目錄已不可用";
    UNBORN_REPOSITORY =
        "This Git repository has no commit to compare yet",
        "Git 仓库还没有可比较的提交",
        "Git 倉庫還沒有可比較的提交";
    GIT_FAILED = "Could not read Git workspace changes", "无法读取 Git 工作区变化", "無法讀取 Git 工作區變化";
    BASE_BRANCH = "Compare against", "对比分支", "對比分支";
    /// While the files' patches are read, after the files are listed:
    /// how many of how many are read.
    READING_CHANGES =
        "Reading changes {done}/{total}",
        "正在读取改动 {done}/{total}",
        "正在讀取改動 {done}/{total}";
    /// Under the header of a file whose diff is too large to hold.
    TOO_LARGE = "Diff too large to show", "差异过大，无法显示", "差異過大，無法顯示";
    /// A file Git counts no lines of, in its row's accessible name.
    BINARY = "Binary", "二进制", "二進位";
    RETRY = "Retry", "重试", "重試";
    HIDDEN_LINES_ONE = "{count} more line not shown", "另有 {count} 行未显示", "另有 {count} 行未顯示";
    HIDDEN_LINES_OTHER = "{count} more lines not shown", "另有 {count} 行未显示", "另有 {count} 行未顯示";
    CHANGED_FILES_ONE = "{count} changed file", "{count} 个文件有变更", "{count} 個檔案有變更";
    CHANGED_FILES_OTHER = "{count} changed files", "{count} 个文件有变更", "{count} 個檔案有變更";
    ADDED_LINES_ONE = "{count} line added", "新增 {count} 行", "新增 {count} 行";
    ADDED_LINES_OTHER = "{count} lines added", "新增 {count} 行", "新增 {count} 行";
    DELETED_LINES_ONE = "{count} line deleted", "删除 {count} 行", "刪除 {count} 行";
    DELETED_LINES_OTHER = "{count} lines deleted", "删除 {count} 行", "刪除 {count} 行";
    /// The diff's layout. Desktop's panel has no such choice; these are
    /// this client's words.
    LAYOUT = "Diff layout", "差异布局", "差異版面";
    UNIFIED = "Unified", "统一", "統一";
    SPLIT = "Split", "并排", "並排";
    /// The rest of a long file's diff, past the lines shown at first.
    SHOW_ALL = "Show all", "显示全部", "顯示全部";
    /// The panel in the conversation's place, and back: Desktop's words for
    /// a Workbar tool taking the window (`focusPreview`, `restorePreview`
    /// of its file and web previews).
    FOCUS_PANEL = "Focus changes", "聚焦变更", "聚焦變更";
    RESTORE_SPLIT = "Restore split view", "还原分栏", "還原分欄";
    /// The list of changed files, by its accessible name.
    FILES = "Changed files", "变更文件", "變更檔案";
    PREVIOUS_FILE = "Previous file", "上一个文件", "上一個檔案";
    NEXT_FILE = "Next file", "下一个文件", "下一個檔案";
    PREVIOUS_CHANGE = "Previous change", "上一处变更", "上一處變更";
    NEXT_CHANGE = "Next change", "下一处变更", "下一處變更";
    /// Unfolds every run of unchanged lines in the diff, and folds them
    /// again.
    SHOW_UNCHANGED = "Show unchanged lines", "展开未变更的行", "展開未變更的行";
    FOLD_UNCHANGED = "Fold unchanged lines", "折叠未变更的行", "摺疊未變更的行";
    /// A file's change, in its header and its row's accessible name.
    STATUS_ADDED = "Added", "新增", "新增";
    STATUS_MODIFIED = "Modified", "修改", "修改";
    STATUS_DELETED = "Deleted", "删除", "刪除";
    STATUS_RENAMED = "Renamed", "重命名", "重新命名";
    STATUS_COPIED = "Copied", "复制", "複製";
    STATUS_UNTRACKED = "Untracked", "未跟踪", "未追蹤";
    STATUS_CHANGED = "Changed", "变更", "變更";
    /// The scopes of the changes, Claude Code's words: every change of the
    /// branch, the ones not committed yet, and the branch's commits.
    ALL_CHANGES = "All changes", "全部改动", "全部改動";
    UNCOMMITTED_CHANGES = "Uncommitted changes", "未提交的改动", "未提交的改動";
    COMMITS = "Commits", "提交", "提交";
    /// The scopes and commits list, by its accessible name.
    SCOPES = "Changes to show", "要显示的改动", "要顯示的改動";
    /// The file tree's toggle in the panel's bar.
    SHOW_TREE = "Show file tree", "显示文件树", "顯示檔案樹";
    HIDE_TREE = "Hide file tree", "隐藏文件树", "隱藏檔案樹";
    /// The panel bar's "⋯" menu.
    MORE_ACTIONS = "More actions", "更多操作", "更多操作";
    /// The "⋯" menu's commands for every run of unchanged lines.
    EXPAND_ALL = "Expand all", "全部展开", "全部展開";
    COLLAPSE_ALL = "Collapse all", "全部折叠", "全部摺疊";
    /// A file's lines past what its diff carries, at the file's end.
    SHOW_MORE_LINES = "Show more lines", "显示更多行", "顯示更多行";
    /// The context strip over the composer: the button that opens the
    /// changes panel, by its accessible name.
    OPEN_CHANGES = "Open changes", "打开改动", "打開改動";
}

/// `count` in the template `one` or `other` asks for.
fn counted(locale: Locale, count: usize, one: super::Text, other: super::Text) -> String {
    plural(count as u64, one, other).fill(locale, &[("count", &count.to_string())])
}

/// Desktop's `hiddenLines`: lines of a file's diff past what it shows.
pub fn hidden_lines(locale: Locale, count: usize) -> String {
    counted(locale, count, HIDDEN_LINES_ONE, HIDDEN_LINES_OTHER)
}

/// How many of the listed files' patches are read.
pub fn reading_changes(locale: Locale, done: usize, total: usize) -> String {
    READING_CHANGES.fill(locale, &[("done", &done.to_string()), ("total", &total.to_string())])
}

/// Desktop's `changedFiles`.
pub fn changed_files(locale: Locale, count: usize) -> String {
    counted(locale, count, CHANGED_FILES_ONE, CHANGED_FILES_OTHER)
}

/// Desktop's `addedLines`.
pub fn added_lines(locale: Locale, count: usize) -> String {
    counted(locale, count, ADDED_LINES_ONE, ADDED_LINES_OTHER)
}

/// Desktop's `deletedLines`.
pub fn deleted_lines(locale: Locale, count: usize) -> String {
    counted(locale, count, DELETED_LINES_ONE, DELETED_LINES_OTHER)
}

/// A commit's line under its subject: its short hash, its author and when
/// it was made, as Claude Code lists them.
pub fn commit_meta(short_sha: &str, author: &str, when: &str) -> String {
    [short_sha, author, when]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" · ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_read_as_desktop_reads_them() {
        let (en, zh) = (Locale::English, Locale::SimplifiedChinese);
        assert_eq!(changed_files(en, 1), "1 changed file");
        assert_eq!(changed_files(zh, 3), "3 个文件有变更");
        assert_eq!(hidden_lines(en, 2), "2 more lines not shown");
        assert_eq!(added_lines(zh, 5), "新增 5 行");
        assert_eq!(deleted_lines(en, 1), "1 line deleted");
    }
}
