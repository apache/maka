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

//! Interface copy of the sidebar's pages: Extensions (its Skills tab, the
//! Skill detail and update review, the Add menu's local actions) and the
//! Scheduled tasks page's title. Wording follows Maka Desktop:
//! `navigation` in packages/ui/src/shell-controls-copy.ts, `moduleHubs` in
//! packages/ui/src/shared-ui-copy.ts, packages/ui/src/skills-copy.ts, and
//! `skillActions` in apps/desktop/src/renderer/locales/shell-copy.ts
//! (Desktop's `zh-CN` / `zh-TW` are the Simplified and Traditional columns).
//! Same rules as the parent module.

use super::{Locale, plural};

texts! {
    // The sidebar's entries and the pages' titles.
    EXTENSIONS = "Extensions", "扩展", "擴充套件";
    SCHEDULED_TASKS = "Scheduled tasks", "定时任务", "定時任務";
    /// The accessible name of the sidebar's entries under New task.
    MAIN_NAVIGATION = "Main navigation", "主导航", "主導航";
    /// Command palette commands that open the pages.
    OPEN_EXTENSIONS = "Open Extensions", "打开扩展", "開啟擴充套件";
    OPEN_SCHEDULED_TASKS = "Open Scheduled tasks", "打开定时任务", "開啟定時任務";

    // The Extensions page's header.
    SKILLS = "Skills", "技能", "技能";
    SEARCH_SKILLS = "Search skills", "搜索技能", "搜尋技能";
    CLEAR_SEARCH = "Clear search", "清空搜索", "清空搜尋";
    REFRESH = "Refresh", "刷新", "重新整理";
    REFRESHING = "Refreshing…", "刷新中…", "重新整理中…";
    ADD = "Add", "添加", "新增";
    /// Opens a file dialog, so it ends in an ellipsis (Desktop's item
    /// has none).
    IMPORT_LOCAL_SKILL = "Import local Skill…", "导入本地 Skill…", "匯入本地 Skill…";
    SKILL_LOCATIONS = "Skill locations…", "技能位置…", "技能位置…";
    /// The file dialog's default button.
    IMPORT = "Import", "导入", "匯入";
    SEARCH_MATCHES_ONE = "{count} match", "{count} 个匹配", "{count} 個符合";
    SEARCH_MATCHES_OTHER = "{count} matches", "{count} 个匹配", "{count} 個符合";

    // The Skills tab.
    INSTALLED = "Installed", "已安装", "已安裝";
    DISCOVER = "Discover", "发现", "探索";
    LOADING_SKILLS = "Loading skills…", "正在加载技能…", "正在載入技能…";
    EMPTY_TITLE = "Waiting for a Skill", "等待添加 Skill", "等待新增 Skill";
    EMPTY_BODY =
        "Place a folder containing SKILL.md in the workspace skills/ directory, then refresh to show it here.",
        "把一个含 SKILL.md 的文件夹放到工作区的 skills/ 目录下，刷新后会出现在这里。",
        "把一個含 SKILL.md 的資料夾放到工作區的 skills/ 目錄下，重新整理後會出現在這裡。";
    REFRESH_SKILLS = "Refresh skills", "刷新技能", "重新整理技能";
    EMPTY_SEARCH_TITLE = "No matching Skills", "没有匹配的 Skill", "沒有符合的 Skill";
    EMPTY_SEARCH_BODY =
        "Try another keyword or clear search to see all local skills.",
        "换一个关键词，或清空搜索查看全部本地技能。",
        "換一個關鍵詞，或清空搜尋檢視全部本地技能。";
    /// No project to read Skills for (Desktop has a project selected
    /// always; this client may not yet).
    NEEDS_FOLDER =
        "Skills belong to a project. Choose a folder in the sidebar first.",
        "技能按项目读取。请先在侧边栏中选择文件夹。",
        "技能按專案讀取。請先在側邊欄中選擇資料夾。";
    OFFLINE =
        "Connect to the Runtime Host to see Skills.",
        "连接到 Runtime Host 后才能查看技能。",
        "連線至 Runtime Host 後才能檢視技能。";
    /// Desktop's own description of a built-in Skill (`bundledDescription`).
    COMPUTER_USE_DESCRIPTION =
        "Inspect and operate local desktop app interfaces.",
        "查看并操作本机桌面应用的界面。",
        "檢視並操作本機桌面應用的介面。";
    BUILTIN_FALLBACK = "Skill included with the app.", "应用自带 Skill。", "應用自帶 Skill。";
    SOURCE_FALLBACK = "Local source-library Skill.", "本地来源库 Skill。", "本地來源庫 Skill。";
    INSTALL = "Install", "安装", "安裝";
    INSTALL_NAMED = "Install {name}", "安装 {name}", "安裝 {name}";

    // The categories of built-in and source Skills, keyed by Desktop's
    // `MANAGED_SKILL_CATEGORIES` (packages/runtime/src/managed-skill-sources.ts).
    CATEGORY_CONTENT = "Content creation", "内容创作", "內容創作";
    CATEGORY_DATA_AI = "Data & AI", "数据与 AI", "資料與 AI";
    CATEGORY_DESIGN = "Design & UI", "设计与 UI", "設計與 UI";
    CATEGORY_DEVOPS = "DevOps & deployment", "DevOps 与部署", "DevOps 與部署";
    CATEGORY_DOCUMENTS = "Documents & writing", "文档与写作", "文件與寫作";
    CATEGORY_PRODUCTIVITY = "Productivity", "效率工具", "效率工具";
    CATEGORY_RESEARCH = "Research & analysis", "研究与分析", "研究與分析";

    // A Skill's state, as its row and detail say it.
    STATUS_METADATA_ERROR = "Metadata error", "元数据异常", "後設資料異常";
    STATUS_SOURCE_MISSING = "Source missing", "来源缺失", "來源缺失";
    STATUS_UPDATE_AVAILABLE = "Update available", "可更新", "可更新";
    STATUS_LOCAL_MODIFIED = "Locally modified", "本地已修改", "本地已修改";
    STATUS_MANAGED = "Managed", "受管理", "受管理";
    STATUS_MODIFIED = "Modified", "已修改", "已修改";
    STATUS_BUILT_IN = "Built in", "内置", "內建";
    STATUS_LOCAL = "Local", "本地", "本地";
    STATUS_STATE_ERROR = "State error", "状态异常", "狀態異常";
    STATUS_DISABLED = "Disabled", "已停用", "已停用";
    CONTEXT_INVALID = "Invalid metadata", "元数据无效", "後設資料無效";
    CONTEXT_HOST_INCOMPATIBLE = "Host incompatible", "主机不兼容", "主機不相容";
    CONTEXT_SHADOWED = "Shadowed", "被高优先级覆盖", "被高優先順序覆蓋";
    CONTEXT_BUDGET = "Budget omitted", "因预算省略", "因預算省略";
    NEEDS_REVIEW = "Needs review", "待确认", "待確認";
    SCOPE_PROJECT = "Project", "项目", "專案";
    SCOPE_WORKSPACE = "Workspace", "工作区", "工作區";
    SCOPE_USER = "User", "用户", "使用者";
    SCOPE_CUSTOM = "Custom", "自定义", "自訂";
    /// A discovery source that could not be read, by its scope and source.
    DISCOVERY_SOURCE =
        "{scope}/{source} discovery source",
        "{scope}/{source} 发现源",
        "{scope}/{source} 發現源";
    DIAGNOSTIC_BLOCKED_PATH =
        "Path blocked by the safety policy",
        "路径被安全策略阻止",
        "路徑被安全策略阻止";
    DIAGNOSTIC_READ_FAILED = "Source could not be read", "来源不可读取", "來源不可讀取";

    // The Skill detail.
    DETAIL_ENABLED = "Enabled", "启用", "啟用";
    PIN_TO_CONTEXT = "Pin to the skill context", "固定到技能上下文", "固定到技能上下文";
    DETAIL_ID = "ID", "标识", "標識";
    DETAIL_PATH = "Path", "路径", "路徑";
    DETAIL_SCOPE = "Scope", "范围", "範圍";
    DETAIL_TOOLS = "Tools", "工具", "工具";
    OPEN_SKILL_MD = "Open SKILL.md", "打开 SKILL.md", "開啟 SKILL.md";
    OPENING = "Opening…", "打开中…", "開啟中…";
    VIEW_UPDATE = "View update", "查看更新", "檢視更新";
    VIEW_DIFF = "View diff", "查看差异", "檢視差異";
    REVIEWING = "Reviewing…", "审查中…", "審查中…";
    /// The delete confirmation's title.
    DELETE_SKILL_TITLE = "Delete {name}?", "确认删除 {name}", "確認刪除 {name}";
    DELETE_SKILL_BODY =
        "This removes the Skill files and cannot be undone.",
        "此操作会删除这个 Skill 的文件，且无法撤销。",
        "此操作會刪除這個 Skill 的檔案，且無法撤銷。";

    // The update review.
    REVIEW_TITLE = "Update review", "更新审查", "更新審查";
    REVIEW_MANAGED_SOURCE = "Managed source", "受管理来源", "受管理來源";
    REVIEW_HAS_BASELINE = "Baseline available", "已有基线", "已有基線";
    REVIEW_NO_BASELINE = "No baseline", "缺少基线", "缺少基線";
    REVIEW_LINES = "{current} → {source} lines", "{current} → {source} 行", "{current} → {source} 行";
    REVIEW_CHANGED_ONE = "{count} line differs", "{count} 行不同", "{count} 行不同";
    REVIEW_CHANGED_OTHER = "{count} lines differ", "{count} 行不同", "{count} 行不同";
    REVIEW_WARNING =
        "The workspace copy has local changes. Continuing will replace the current SKILL.md with the source version.",
        "工作区副本已有本地修改。继续更新会用来源库版本覆盖当前 SKILL.md。",
        "工作區副本已有本地修改。繼續更新會用來源庫版本覆蓋目前 SKILL.md。";
    REVIEW_CURRENT = "Current workspace", "当前工作区", "目前工作區";
    REVIEW_SOURCE = "Source version", "来源库版本", "來源庫版本";
    REVIEW_OVERWRITE = "Overwrite local changes", "覆盖本地修改", "覆蓋本地修改";
    REVIEW_UPDATE = "Update to source version", "更新到来源版本", "更新到來源版本";

    // Skill locations, in the Add menu.
    LOCATION_PROJECT_MAKA = "Project · Maka", "项目 · Maka", "專案 · Maka";
    LOCATION_PROJECT_AGENTS = "Project · Agents", "项目 · Agents", "專案 · Agents";
    LOCATION_WORKSPACE_LEGACY = "Workspace compatibility folder", "工作区兼容目录", "工作區相容目錄";
    LOCATION_USER_MAKA = "User · Maka", "用户 · Maka", "使用者 · Maka";
    LOCATION_USER_AGENTS = "User · Agents", "用户 · Agents", "使用者 · Agents";
    LOCATION_COUNT_ONE = "{count} Skill", "{count} 个 Skill", "{count} 個 Skill";
    LOCATION_COUNT_OTHER = "{count} Skills", "{count} 个 Skill", "{count} 個 Skill";
    LOCATION_MISSING = "Create and open", "创建并打开", "建立並開啟";
    LOCATION_BLOCKED = "Path blocked", "路径已被阻止", "路徑已被阻止";
    LOCATION_READ_FAILED = "Could not read", "无法读取", "無法讀取";

    // What a failed action says: its title, then why.
    REFRESH_SKILLS_FAILED = "Could not refresh Skills", "刷新技能失败", "重新整理技能失敗";
    REFRESH_SOURCES_FAILED = "Could not refresh Skill sources", "刷新来源库失败", "重新整理來源庫失敗";
    REFRESH_BUNDLED_FAILED = "Could not refresh built-in Skills", "刷新内置技能失败", "重新整理內建技能失敗";
    INSTALL_BUNDLED_FAILED = "Could not install built-in Skill", "无法安装内置 Skill", "無法安裝內建 Skill";
    INSTALL_FAILED = "Could not install Skill", "无法安装 Skill", "無法安裝 Skill";
    IMPORT_FAILED = "Could not import Skill source", "无法导入 Skill 来源", "無法匯入 Skill 來源";
    IMPORTED = "Skill source imported", "已导入 Skill 来源", "已匯入 Skill 來源";
    PREVIEW_FAILED = "Could not preview Skill update", "无法预览 Skill 更新", "無法預覽 Skill 更新";
    UPDATE_FAILED = "Could not update Skill", "无法更新 Skill", "無法更新 Skill";
    TOGGLE_FAILED = "Could not change Skill status", "无法切换 Skill", "無法切換 Skill";
    DELETE_FAILED = "Could not delete Skill", "无法删除 Skill", "無法刪除 Skill";
    OPEN_FAILED = "Could not open Skill", "无法打开 Skill", "無法開啟 Skill";
    OPEN_LOCATION_FAILED = "Could not open Skill location", "无法打开技能位置", "無法開啟技能位置";
    /// When the Host's refusal names nothing more specific.
    TRY_AGAIN_LATER = "Try again later.", "请稍后重试。", "請稍後重試。";
    /// Catalog reads that kept changing under the client.
    CATALOG_UNSTABLE =
        "The Skill catalog kept changing while it was read. Try again.",
        "读取期间技能目录一直在变化，请重试。",
        "讀取期間技能目錄一直在變化，請再試一次。";

    // Why an action failed (`installFailures`, `sourceFailures`,
    // `updateFailures`, `previewFailures`, `deleteFailures`,
    // `runtimeFailures`, `openFailures`, `openLocationFailures`).
    INSTALL_NOT_FOUND = "This Skill source was not found.", "没有找到这个 Skill 来源。", "沒有找到這個 Skill 來源。";
    INSTALL_ALREADY_EXISTS =
        "A Skill with the same name already exists in this workspace.",
        "当前工作区已经有同名 Skill。",
        "目前工作區已經有同名 Skill。";
    TARGET_BLOCKED = "The target path cannot be written.", "目标路径不允许写入。", "目標路徑不允許寫入。";
    WORKSPACE_WRITE_FAILED =
        "The workspace could not be written. Check file permissions.",
        "写入工作区失败，请检查文件权限。",
        "寫入工作區失敗，請檢查檔案權限。";
    SOURCE_INVALID = "Select a valid SKILL.md file.", "请选择有效的 SKILL.md 文件。", "請選擇有效的 SKILL.md 檔案。";
    SOURCE_ALREADY_EXISTS =
        "A Skill with the same name already exists in the source library.",
        "来源库里已经有同名 Skill。",
        "來源庫裡已經有同名 Skill。";
    SOURCE_BLOCKED = "This file path cannot be imported.", "该文件路径不允许导入。", "該檔案路徑不允許匯入。";
    SOURCE_WRITE_FAILED =
        "The source library could not be written. Check file permissions.",
        "写入来源库失败，请检查文件权限。",
        "寫入來源庫失敗，請檢查檔案權限。";
    NOT_MANAGED = "This Skill is not from a managed source.", "这个 Skill 不是受管理来源。", "這個 Skill 不是受管理來源。";
    SOURCE_MISSING =
        "The matching source was not found in the source library.",
        "来源库中找不到对应来源。",
        "來源庫中找不到對應來源。";
    UPDATE_LOCAL_MODIFIED =
        "The workspace copy was modified. Open the local and source files to compare them before updating.",
        "工作区副本已经被修改。请打开本地文件和来源文件手动比较后再更新。",
        "工作區副本已經被修改。請開啟本地檔案和來原始檔手動比較後再更新。";
    UPDATE_METADATA_ERROR =
        "The Skill metadata is invalid, so it cannot be updated safely.",
        "Skill 元数据异常，不能安全更新。",
        "Skill 後設資料異常，不能安全更新。";
    PREVIEW_METADATA_ERROR =
        "The Skill metadata is invalid, so it cannot be previewed safely.",
        "Skill 元数据异常，不能安全预览。",
        "Skill 後設資料異常，不能安全預覽。";
    SKILL_NOT_FOUND =
        "This Skill was not found in the current workspace.",
        "当前工作区找不到这个 Skill。",
        "目前工作區找不到這個 Skill。";
    DELETE_BLOCKED = "The Skill path cannot be deleted.", "Skill 路径不允许删除。", "Skill 路徑不允許刪除。";
    DELETE_BLOCKED_SCOPE =
        "Project Skills are managed by the repository. Delete it from the project instead.",
        "项目内的 Skill 由仓库管理，请直接在项目里删除。",
        "專案內的 Skill 由倉庫管理，請直接在專案裡刪除。";
    STATE_BLOCKED = "The Skill status path cannot be written.", "Skill 状态路径不允许写入。", "Skill 狀態路徑不允許寫入。";
    STATE_ERROR =
        "The Skill status file in this workspace is invalid and must be fixed first.",
        "当前工作区的 Skill 状态文件异常，需要先修复。",
        "目前工作區的 Skill 狀態檔案異常，需要先修復。";
    OPEN_MISSING = "The matching SKILL.md was not found.", "没有找到对应的 SKILL.md。", "沒有找到對應的 SKILL.md。";
    OPEN_BLOCKED =
        "The Skill path is outside the workspace skills folder, so opening was blocked.",
        "Skill 路径不在工作区 skills 目录内，已阻止打开。",
        "Skill 路徑不在工作區 skills 目錄內，已阻止開啟。";
    OPEN_NOT_FILE =
        "The target is not an openable SKILL.md file.",
        "目标不是一个可打开的 SKILL.md 文件。",
        "目標不是一個可開啟的 SKILL.md 檔案。";
    LOCATION_STALE = "Skill locations have changed. Try again.", "技能位置已变化，请重试。", "技能位置已變更，請再試一次。";
    LOCATION_DIR_MISSING = "The folder does not exist.", "目录不存在。", "目錄不存在。";
    LOCATION_DIR_BLOCKED =
        "The Skill location is outside the allowed paths, so opening was blocked.",
        "技能位置不在允许范围内，已阻止打开。",
        "技能位置不在允許範圍內，已阻止開啟。";
    LOCATION_DIR_READ_FAILED =
        "The Skill folder could not be read. Check file permissions.",
        "无法读取技能目录，请检查文件权限。",
        "無法讀取技能目錄，請檢查檔案權限。";
    LOCATION_CREATE_FAILED =
        "The Skill folder could not be created. Check file permissions.",
        "无法创建技能目录，请检查文件权限。",
        "無法建立技能目錄，請檢查檔案權限。";
}

/// The search summary: how many rows the query matched.
pub fn search_matches(locale: Locale, count: usize) -> String {
    plural(count as u64, SEARCH_MATCHES_ONE, SEARCH_MATCHES_OTHER)
        .fill(locale, &[("count", &count.to_string())])
}

/// A Skill location's count of Skills.
pub fn location_count(locale: Locale, count: usize) -> String {
    plural(count as u64, LOCATION_COUNT_ONE, LOCATION_COUNT_OTHER)
        .fill(locale, &[("count", &count.to_string())])
}

/// The update review's line counts, before and after.
pub fn review_lines(locale: Locale, current: u64, source: u64) -> String {
    REVIEW_LINES.fill(locale, &[("current", &current.to_string()), ("source", &source.to_string())])
}

/// The update review's count of lines that differ.
pub fn review_changed(locale: Locale, count: u64) -> String {
    plural(count, REVIEW_CHANGED_ONE, REVIEW_CHANGED_OTHER)
        .fill(locale, &[("count", &count.to_string())])
}

/// A Discover row's Install button, as it is announced.
pub fn install_named(locale: Locale, name: &str) -> String {
    INSTALL_NAMED.fill(locale, &[("name", name)])
}

/// The delete confirmation's title.
pub fn delete_skill_title(locale: Locale, name: &str) -> String {
    DELETE_SKILL_TITLE.fill(locale, &[("name", name)])
}

/// The label of a discovery source that could not be read.
pub fn discovery_source(locale: Locale, scope: &str, source: &str) -> String {
    DISCOVERY_SOURCE.fill(locale, &[("scope", scope), ("source", source)])
}

/// A category's label; one Desktop does not name reads as the Host gave it.
pub fn category_label(locale: Locale, category: &str) -> String {
    let text = match category {
        "内容创作" => CATEGORY_CONTENT,
        "数据与AI" => CATEGORY_DATA_AI,
        "设计与UI" => CATEGORY_DESIGN,
        "DevOps与部署" => CATEGORY_DEVOPS,
        "文档与写作" => CATEGORY_DOCUMENTS,
        "效率工具" => CATEGORY_PRODUCTIVITY,
        "研究与分析" => CATEGORY_RESEARCH,
        other => return other.to_owned(),
    };
    text.in_locale(locale).to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counted_phrases_agree_with_their_count() {
        assert_eq!(search_matches(Locale::English, 1), "1 match");
        assert_eq!(search_matches(Locale::English, 3), "3 matches");
        assert_eq!(location_count(Locale::English, 1), "1 Skill");
        assert_eq!(location_count(Locale::SimplifiedChinese, 2), "2 个 Skill");
        assert_eq!(review_changed(Locale::English, 2), "2 lines differ");
        assert_eq!(review_lines(Locale::English, 3, 4), "3 → 4 lines");
    }

    #[test]
    fn categories_read_in_the_locale_and_unknown_ones_as_given() {
        assert_eq!(category_label(Locale::English, "数据与AI"), "Data & AI");
        assert_eq!(category_label(Locale::SimplifiedChinese, "数据与AI"), "数据与 AI");
        assert_eq!(category_label(Locale::English, "Productivity"), "Productivity");
    }
}
