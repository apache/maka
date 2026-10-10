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

//! The task's files (the workbar's Files tool): the list, its filter, a
//! file's preview, its actions, and every line that says why something
//! could not be shown or done. Desktop's `ArtifactCopy`
//! (`apps/desktop/src/renderer/locales/artifact-copy.ts`) where it has the
//! words; this client's own where its Files face differs (no Finder; an
//! HTML page drawn by the kit's text view, without its scripts or styles).

use super::{Locale, plural};

texts! {
    /// The tool's name: its tab and its item in the [+] menu.
    FILES = "Files", "文件", "檔案";
    /// The list's accessible name.
    LIST = "Task files", "任务文件", "任務檔案";
    /// The filter field's placeholder and accessible name.
    FILTER = "Filter files", "筛选文件", "篩選檔案";
    /// The filter's count while it narrows the list.
    FILTER_COUNT = "{count} of {total}", "{count} / {total}", "{count} / {total}";
    /// No file's name holds the filter.
    NO_MATCHES = "No files match", "没有匹配的文件", "沒有符合的檔案";
    /// The list with nothing in it.
    EMPTY = "Files the agent makes appear here.", "Agent 生成的文件会显示在这里。", "Agent 產生的檔案會顯示在這裡。";
    LOADING = "Loading files…", "正在读取文件…", "正在讀取檔案…";
    LIST_FAILED = "Couldn’t list this task’s files.", "无法列出此任务的文件。", "無法列出此任務的檔案。";
    RETRY = "Retry", "重试", "重試";

    // A file's preview.
    /// The back button's name and tooltip.
    BACK = "Back to files", "返回文件列表", "返回檔案列表";
    /// The preview region's name.
    PREVIEW_NAMED = "Preview of {name}", "{name} 的预览", "{name} 的預覽";
    /// The "…" button's name.
    MORE_ACTIONS = "More actions for {name}", "{name} 的更多操作", "{name} 的更多操作";
    /// The Markdown toggle and its two sides.
    VIEW_MODE = "Show as", "显示方式", "顯示方式";
    RENDERED = "Rendered", "渲染", "渲染";
    SOURCE = "Source", "源码", "原始碼";
    /// Why an HTML page shows as source, beside Open in Default App, after
    /// Desktop's `renderLimited`.
    RENDER_LIMIT =
        "To stay responsive, pages over {size} show as source.",
        "为保证流畅，超过 {size} 的页面仅显示源码。",
        "為保證流暢，超過 {size} 的頁面僅顯示原始碼。";
    /// A text file read in part: how much shows.
    SHOWN_OF = "Showing {shown} of {total}", "已显示 {shown}，共 {total}", "已顯示 {shown}，共 {total}";
    SHOW_MORE = "Show more", "显示更多", "顯示更多";
    SHOW_ALL = "Show all", "显示全部", "顯示全部";
    /// The preview stopped at its ceiling.
    PREVIEW_CEILING =
        "The preview stops at {size}. Save a copy to see the whole file.",
        "预览最多显示 {size}。另存一份即可查看完整文件。",
        "預覽最多顯示 {size}。另存一份即可檢視完整檔案。";
    /// The image's accessible name, by what a click does.
    IMAGE_FIT = "Image, fitted to the panel. Click for actual size.", "图片，已适应面板。点按以显示实际大小。", "圖片，已符合面板大小。點按以顯示實際大小。";
    IMAGE_ACTUAL = "Image at actual size. Click to fit the panel.", "图片，实际大小。点按以适应面板。", "圖片，實際大小。點按以符合面板大小。";

    // Kinds, under a preview's name.
    KIND_FILE = "File", "文件", "檔案";
    KIND_DIFF = "Diff", "差异", "差異";
    KIND_HTML = "HTML", "HTML", "HTML";
    KIND_IMAGE = "Image", "图片", "圖片";
    KIND_PDF = "PDF", "PDF", "PDF";

    // Actions.
    COPY = "Copy", "复制", "複製";
    SAVE_AS = "Save As…", "另存为…", "另存新檔…";
    OPEN_DEFAULT = "Open in Default App", "用默认应用打开", "以預設應用程式開啟";
    /// The menu item, which asks first.
    DELETE_ITEM = "Delete…", "删除…", "刪除…";
    /// The confirmation's button.
    DELETE = "Delete", "删除", "刪除";
    CANCEL = "Cancel", "取消", "取消";
    DELETE_TITLE = "Delete “{name}”?", "删除“{name}”？", "刪除「{name}」？";
    DELETE_BODY =
        "It’s removed from this task’s files. This can’t be undone.",
        "它会从此任务的文件中移除，且无法恢复。",
        "它會從此任務的檔案中移除，且無法復原。";
    COPIED = "Copied {name}", "已复制 {name}", "已複製 {name}";
    SAVED = "Saved {name}", "已保存 {name}", "已儲存 {name}";
    COPY_FAILED = "Couldn’t copy {name}.", "无法复制 {name}。", "無法複製 {name}。";
    SAVE_FAILED = "Couldn’t save {name}.", "无法保存 {name}。", "無法儲存 {name}。";
    OPEN_FAILED = "Couldn’t open {name}.", "无法打开 {name}。", "無法開啟 {name}。";
    DELETE_FAILED = "Couldn’t delete {name}.", "无法删除 {name}。", "無法刪除 {name}。";

    // Why a preview or an action could not be done, each saying what a
    // person can do about it.
    WHY_NOT_FOUND =
        "This file is no longer in the task. Go back to the list to see what’s there now.",
        "此文件已不在任务中。返回列表查看现有文件。",
        "此檔案已不在任務中。返回列表檢視現有檔案。";
    WHY_TOO_LARGE =
        "This file is too large to preview. Save a copy to open it in another app.",
        "此文件太大，无法预览。另存一份即可用其他应用打开。",
        "此檔案太大，無法預覽。另存一份即可用其他應用程式開啟。";
    WHY_READ_FAILED =
        "The Runtime Host couldn’t read this file. Try again.",
        "Runtime Host 无法读取此文件。请重试。",
        "Runtime Host 無法讀取此檔案。請重試。";
    WHY_NOT_ALLOWED =
        "This file is outside the folder the Runtime Host may read, so it can’t be shown.",
        "此文件不在 Runtime Host 可读取的文件夹内，因此无法显示。",
        "此檔案不在 Runtime Host 可讀取的資料夾內，因此無法顯示。";
    WHY_UNSUPPORTED =
        "This image’s format can’t be shown here. Save a copy to open it in another app.",
        "此图片的格式无法在这里显示。另存一份即可用其他应用打开。",
        "此圖片的格式無法在這裡顯示。另存一份即可用其他應用程式開啟。";
    WHY_NOT_TEXT =
        "This file isn’t text, so it can’t be shown here. Save a copy to open it in another app.",
        "此文件不是文本，无法在这里显示。另存一份即可用其他应用打开。",
        "此檔案不是文字，無法在這裡顯示。另存一份即可用其他應用程式開啟。";
    WHY_PDF =
        "PDFs aren’t previewed here. Open it in the default app or save a copy.",
        "这里不预览 PDF。可以用默认应用打开，或另存一份。",
        "這裡不預覽 PDF。可以用預設應用程式開啟，或另存一份。";
    WHY_UNKNOWN_KIND =
        "This kind of file can’t be shown here. Save a copy to open it in another app.",
        "这类文件无法在这里显示。另存一份即可用其他应用打开。",
        "這類檔案無法在這裡顯示。另存一份即可用其他應用程式開啟。";
    WHY_UNEXPECTED =
        "The Runtime Host answered in a way this version of Maka doesn’t understand. Update Maka and try again.",
        "Runtime Host 的回应无法被此版本的 Maka 识别。请更新 Maka 后重试。",
        "Runtime Host 的回應無法被此版本的 Maka 辨識。請更新 Maka 後重試。";
    WHY_DISCONNECTED =
        "Couldn’t reach the Runtime Host. Check the connection and try again.",
        "无法连接 Runtime Host。请检查连接后重试。",
        "無法連線 Runtime Host。請檢查連線後重試。";
    WHY_CHANGED =
        "The file changed while it was being read. Try again.",
        "读取过程中文件发生了变化。请重试。",
        "讀取過程中檔案發生了變化。請重試。";
    WHY_HOST =
        "The Runtime Host refused: {message}",
        "Runtime Host 拒绝了请求：{message}",
        "Runtime Host 拒絕了請求：{message}";
    WHY_PROTECTED =
        "Maka keeps this file with the work that made it, so it can’t be deleted on its own.",
        "Maka 会将此文件与生成它的工作一起保留，因此不能单独删除。",
        "Maka 會將此檔案與產生它的工作一起保留，因此不能單獨刪除。";
    WHY_ALREADY_DELETED =
        "This file was already deleted.",
        "此文件已被删除。",
        "此檔案已被刪除。";
    WHY_COPY_TOO_LARGE =
        "This file is too large to copy. Save a copy instead.",
        "此文件太大，无法复制。请改为另存一份。",
        "此檔案太大，無法複製。請改為另存一份。";
    WHY_WRITE_FAILED =
        "The file couldn’t be written: {message}",
        "无法写入文件：{message}",
        "無法寫入檔案：{message}";
    WHY_NO_TEMP =
        "Maka has no folder to put a copy in. Save a copy instead.",
        "Maka 没有可用来存放副本的文件夹。请改为另存一份。",
        "Maka 沒有可用來存放副本的資料夾。請改為另存一份。";
    WHY_NOT_DRAWN =
        "This image can’t be shown here. Save a copy to open it in another app.",
        "此图片无法在这里显示。另存一份即可用其他应用打开。",
        "此圖片無法在這裡顯示。另存一份即可用其他應用程式開啟。";

    /// The count of files, the list's description.
    COUNT_ONE = "{count} file", "{count} 个文件", "{count} 個檔案";
    COUNT_OTHER = "{count} files", "{count} 个文件", "{count} 個檔案";
}

/// The filter's count: "2 of 5".
pub fn filter_count(locale: Locale, count: usize, total: usize) -> String {
    FILTER_COUNT.fill(locale, &[("count", &count.to_string()), ("total", &total.to_string())])
}

/// "Preview of report.md".
pub fn preview_named(locale: Locale, name: &str) -> String {
    PREVIEW_NAMED.fill(locale, &[("name", name)])
}

/// "More actions for report.md".
pub fn more_actions(locale: Locale, name: &str) -> String {
    MORE_ACTIONS.fill(locale, &[("name", name)])
}

/// "Showing 32 KB of 120 KB".
pub fn shown_of(locale: Locale, shown: &str, total: &str) -> String {
    SHOWN_OF.fill(locale, &[("shown", shown), ("total", total)])
}

/// Why an HTML page past `size` shows as source.
pub fn render_limit(locale: Locale, size: &str) -> String {
    RENDER_LIMIT.fill(locale, &[("size", size)])
}

/// The line at the preview's ceiling.
pub fn preview_ceiling(locale: Locale, size: &str) -> String {
    PREVIEW_CEILING.fill(locale, &[("size", size)])
}

/// The confirmation's title: `Delete “report.html”?`.
pub fn delete_title(locale: Locale, name: &str) -> String {
    DELETE_TITLE.fill(locale, &[("name", name)])
}

/// One of the actions' outcomes about `name` (`COPIED`, `SAVE_FAILED`, …).
pub fn about(text: super::Text, locale: Locale, name: &str) -> String {
    text.fill(locale, &[("name", name)])
}

/// The Host's refusal, in its own words.
pub fn why_host(locale: Locale, message: &str) -> String {
    WHY_HOST.fill(locale, &[("message", message)])
}

/// A write that failed, in the system's words.
pub fn why_write_failed(locale: Locale, message: &str) -> String {
    WHY_WRITE_FAILED.fill(locale, &[("message", message)])
}

/// "3 files".
pub fn count(locale: Locale, count: usize) -> String {
    plural(count as u64, COUNT_ONE, COUNT_OTHER).fill(locale, &[("count", &count.to_string())])
}
