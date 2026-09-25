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

use maka_plugins::terminal_ui::app::Cx;

#[derive(Clone, Copy)]
pub(super) enum Copy {
    Title,
    Installed,
    Bundled,
    Managed,
    Empty,
    Browse,
    Starter,
    Next,
    Import,
    ImportHint,
    HostPath,
    Destination,
    Location,
    EditSource,
    Install,
    OpenInstalled,
    Enabled,
    Pinned,
    Save,
    ReviewUpdate,
    Current,
    Upstream,
    Truncated,
    LocalEdits,
    NoBaseline,
    Apply,
    DeleteReview,
    Delete,
    DeleteHint,
    DeleteConfirm,
    DeleteLocationReview,
    Back,
    Unavailable,
    Rejected,
    Changed,
    Duplicate,
    InvalidSkill,
    BlockedPath,
    Resume,
    RecoveryHint,
    Authorize,
}
impl Copy {
    pub(super) fn text(self, cx: &Cx) -> String {
        let (en, cn, tw) = match self {
            Self::Title => ("Skill library", "技能库", "技能庫"),
            Self::Installed => ("Installed", "已安装", "已安裝"),
            Self::Bundled => ("Bundled", "内置来源", "內建來源"),
            Self::Managed => ("Local sources", "本地来源", "本機來源"),
            Self::Empty => ("No skills available", "暂无可用技能", "尚無可用技能"),
            Self::Browse => ("Browse sources", "浏览来源", "瀏覽來源"),
            Self::Starter => ("Create starter", "创建示例技能", "建立範例技能"),
            Self::Next => ("Next", "下一页", "下一頁"),
            Self::Import => ("Import Markdown", "导入 Markdown", "匯入 Markdown"),
            Self::ImportHint => (
                "Copy one Markdown file into local sources. Sibling resources are not copied, and the original file is not synchronized. Install it separately from the source detail.",
                "将一个 Markdown 文件复制到本地来源。不会复制同目录资源，也不会同步原文件；导入后可在来源详情中安装。",
                "將一個 Markdown 檔案複製到本機來源。不會複製同目錄資源，也不會同步原檔案；匯入後可在來源詳情中安裝。",
            ),
            Self::HostPath => (
                "Absolute file path on the Host",
                "Host 上的绝对文件路径",
                "Host 上的絕對檔案路徑",
            ),
            Self::Destination => (
                "Maka skill library (shared by sessions in this profile)",
                "Maka 技能库（此配置档案的会话共享）",
                "Maka 技能庫（此設定檔的工作階段共用）",
            ),
            Self::Location => (
                "Managed local source directory",
                "受管本地来源目录",
                "受管本機來源目錄",
            ),
            Self::EditSource => (
                "Edit the managed source here to prepare an update; importing the original again does not refresh it.",
                "修改这里的受管来源可准备更新；再次导入原文件不会刷新它。",
                "修改這裡的受管來源可準備更新；再次匯入原檔案不會重新整理它。",
            ),
            Self::Install => ("Install", "安装", "安裝"),
            Self::OpenInstalled => ("Open installed skill", "打开已安装技能", "開啟已安裝技能"),
            Self::Enabled => ("Enabled", "启用", "啟用"),
            Self::Pinned => ("Pinned", "置顶", "置頂"),
            Self::Save => ("Save", "保存", "儲存"),
            Self::ReviewUpdate => ("Review update", "审核更新", "審核更新"),
            Self::Current => ("Current SKILL.md", "当前 SKILL.md", "目前 SKILL.md"),
            Self::Upstream => ("Source SKILL.md", "来源 SKILL.md", "來源 SKILL.md"),
            Self::Truncated => (
                "Preview is truncated (up to 80 lines per file).",
                "预览已截断（每个文件最多 80 行）。",
                "預覽已截斷（每個檔案最多 80 行）。",
            ),
            Self::LocalEdits => (
                "Local edits will be replaced in SKILL.md. Other installed resources are preserved.",
                "更新将替换 SKILL.md 中的本地修改，其他已安装资源将保留。",
                "更新將取代 SKILL.md 中的本機修改，其他已安裝資源將保留。",
            ),
            Self::NoBaseline => (
                "The managed baseline is missing or invalid. This update cannot be applied.",
                "受管基线缺失或无效，无法应用此更新。",
                "受管基準缺失或無效，無法套用此更新。",
            ),
            Self::Apply => ("Apply update", "应用更新", "套用更新"),
            Self::DeleteReview => ("Review deletion", "审核删除", "審核刪除"),
            Self::Delete => ("Delete skill directory", "删除技能目录", "刪除技能目錄"),
            Self::DeleteHint => (
                "Delete the entire installed directory, including all resources listed below. The managed source is retained.",
                "删除整个已安装目录，包括下列所有资源。受管来源将保留。",
                "刪除整個已安裝目錄，包括下列所有資源。受管來源將保留。",
            ),
            Self::DeleteConfirm => (
                "Permanently delete this reviewed skill directory and all its resources?",
                "永久删除审核过的技能目录及其全部资源？",
                "永久刪除審核過的技能目錄及其全部資源？",
            ),
            Self::DeleteLocationReview => (
                "Confirm the complete directory path on the deletion review page.",
                "请在删除审核页核对完整目录路径。",
                "請在刪除審核頁核對完整目錄路徑。",
            ),
            Self::Back => ("Back", "返回", "返回"),
            Self::Unavailable => (
                "This skill or source is unavailable. Refresh the library.",
                "此技能或来源不可用，请刷新技能库。",
                "此技能或來源無法使用，請重新整理技能庫。",
            ),
            Self::Rejected => (
                "The operation was rejected. Refresh and review the current files.",
                "操作被拒绝，请刷新并审核当前文件。",
                "操作遭拒，請重新整理並審核目前檔案。",
            ),
            Self::Changed => (
                "The reviewed files changed. Refresh and review again.",
                "审核过的文件已变化，请刷新后重新审核。",
                "審核過的檔案已變更，請重新整理後再次審核。",
            ),
            Self::Duplicate => (
                "A skill or source with this ID already exists.",
                "已存在同 ID 的技能或来源。",
                "已存在相同 ID 的技能或來源。",
            ),
            Self::InvalidSkill => (
                "The selected file is not a valid Skill Markdown document.",
                "所选文件不是有效的技能 Markdown 文档。",
                "所選檔案不是有效的技能 Markdown 文件。",
            ),
            Self::BlockedPath => (
                "The selected path cannot be read as a regular Markdown file.",
                "无法将所选路径作为普通 Markdown 文件读取。",
                "無法將所選路徑作為一般 Markdown 檔案讀取。",
            ),
            Self::Resume => (
                "Resume pending publication",
                "恢复待完成发布",
                "恢復待完成發佈",
            ),
            Self::RecoveryHint => (
                "A previous user-library publication needs explicit authorization to continue.",
                "先前的用户技能库发布需要明确授权才能继续。",
                "先前的使用者技能庫發佈需要明確授權才能繼續。",
            ),
            Self::Authorize => (
                "Allow Skills to manage the user library",
                "允许技能插件管理用户技能库",
                "允許技能外掛管理使用者技能庫",
            ),
        };
        cx.t(en, cn, tw)
    }
}
