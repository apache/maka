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

//! Interface copy of the Subagents settings page: the approved presets and
//! the editor, in Maka Desktop's words
//! (apps/desktop/src/renderer/locales/settings-subagents-copy.ts).
//! Same rules as the parent module.

use super::{Locale, Text, plural};

/// The id field's label and placeholder: an identifier, the same in every
/// language (Desktop's `editor.id`, `editor.idPlaceholder`).
pub const SUBAGENT_ID: &str = "subagent_id";
pub const SUBAGENT_ID_PLACEHOLDER: &str = "fast-reader";

texts! {
    // The list.
    APPROVED = "Approved subagents", "已批准的子 Agent", "已批准的子 Agent";
    PRESET_COUNT_ONE = "{count} preset", "共 {count} 个配置", "共 {count} 個設定";
    PRESET_COUNT_OTHER = "{count} presets", "共 {count} 个配置", "共 {count} 個設定";
    ADD = "Add subagent", "添加子 Agent", "新增子 Agent";
    EMPTY_TITLE = "No subagent presets yet", "还没有子 Agent 配置", "還沒有子 Agent 設定";
    EMPTY_DESCRIPTION =
        "Add a preset so the main agent can delegate suitable work to a separate model.",
        "添加一个配置后，主 Agent 就能把合适的任务交给独立模型处理。",
        "新增一個設定後，主 Agent 就能把合適的任務交給獨立模型處理。";
    ROW_ENABLED = "Enabled", "启用", "啟用";
    /// A row's switch, named for its preset.
    ROW_ENABLED_LABEL = "Enabled: {name}", "启用：{name}", "啟用：{name}";
    CONFIGURE = "Configure “{name}”", "配置“{name}”", "設定“{name}”";
    FALLBACK_DESCRIPTION = "No usage guidance yet", "尚未填写适用场景", "尚未填寫適用場景";

    // Why the main agent cannot take a preset's route.
    MISSING_CONNECTION = "Connection missing", "连接不存在", "連線不存在";
    PROVIDER_RETIRED =
        "Sign-in retired · route to another connection",
        "登录方式已移除 · 请改用其他连接",
        "登入方式已移除 · 請改用其他連線";
    CONNECTION_DISABLED = "Connection disabled", "连接已停用", "連線已停用";
    MODEL_DISABLED = "Model not enabled", "模型未启用", "模型未啟用";

    // The editor.
    BACK_TO_LIST = "Back to subagents", "返回子 Agent 列表", "返回子 Agent 列表";
    CREATE_SUBTITLE =
        "Create a model preset that the main agent can select automatically.",
        "创建一个可由主 Agent 自动选择的模型配置。",
        "建立一個可由主 Agent 自動選擇的模型設定。";
    EDIT_SUBTITLE =
        "Change its usage guidance, capability boundary, and model route.",
        "修改适用场景、能力边界和模型路由。",
        "修改適用場景、能力邊界和模型路由。";
    GROUP_PURPOSE = "Purpose", "用途", "用途";
    GROUP_PURPOSE_HELP =
        "The main agent selects a preset primarily from the name and guidance here.",
        "主 Agent 主要根据这里的名称和适用场景挑选配置。",
        "主 Agent 主要根據這裡的名稱和適用場景挑選設定。";
    GROUP_ROUTE = "Capability and model", "能力与模型", "能力與模型";
    GROUP_ROUTE_HELP =
        "Fix what this subagent may do, and which model it runs on.",
        "固定这个子 Agent 能做什么，以及它运行在哪个模型上。",
        "固定這個子 Agent 能做什麼，以及它執行在哪個模型上。";
    DANGER_ZONE = "Remove subagent", "删除子 Agent", "刪除子 Agent";
    DANGER_ZONE_HELP = "This cannot be undone.", "此操作不可撤销。", "此操作不可撤銷。";
    DELETE = "Remove", "删除", "刪除";
    ENABLED = "Enabled", "启用", "啟用";
    ENABLED_HELP =
        "Turn this off to keep the preset without letting the main agent select it.",
        "关闭后配置仍会保留，但主 Agent 暂时不会选择它。",
        "關閉後設定仍會保留，但主 Agent 暫時不會選擇它。";
    NAME = "Display name", "显示名称", "顯示名稱";
    NAME_PLACEHOLDER = "Fast code reader", "快速代码阅读", "快速程式碼閱讀";
    ID_HELP =
        "Stable after creation. The main agent and task history use it to identify this preset.",
        "创建后保持不变，主 Agent 和历史任务会用它识别此配置。",
        "建立後保持不變，主 Agent 和歷史任務會用它識別此設定。";
    DESCRIPTION = "When to use", "适用场景", "適用場景";
    DESCRIPTION_PLACEHOLDER =
        "Fast, low-cost exploration of large repositories",
        "适合快速、低成本地阅读大型仓库",
        "適合快速、低成本地閱讀大型倉庫";
    PROFILE = "Capability profile", "能力 Profile", "能力 Profile";
    CONNECTION = "Model connection", "模型连接", "模型連線";
    MODEL = "Model", "模型", "模型";
    THINKING = "Thinking level", "思考级别", "思考級別";
    DEFAULT_THINKING = "Use model default", "跟随模型默认", "跟隨模型預設";
    IMPLEMENTATION_WARNING =
        "The Implementation profile can write files and run commands inside an isolated worktree.",
        "实现代码 Profile 可以写文件和执行命令，并会在隔离 worktree 中运行。",
        "實現程式碼 Profile 可以寫檔案和執行命令，並會在隔離 worktree 中執行。";
    NO_CONNECTION =
        "Enable a model connection on the Models page first.",
        "请先在“模型”页启用一个模型连接。",
        "請先在“模型”頁啟用一個模型連線。";
    NO_MODEL =
        "The selected connection has no enabled models.",
        "所选连接没有已启用的模型。",
        "所選連線沒有已啟用的模型。";
    REQUIRED_NAME = "Enter a display name.", "请输入显示名称。", "請輸入顯示名稱。";
    INVALID_ID =
        "Use only letters, numbers, dots, underscores, colons, and hyphens, up to {max} characters.",
        "只能使用字母、数字、点、下划线、冒号和连字符，最多 {max} 个字符。",
        "只能使用字母、數字、點、下劃線、冒號和連字元，最多 {max} 個字元。";
    DUPLICATE_ID =
        "That subagent_id already exists.",
        "这个 subagent_id 已经存在。",
        "這個 subagent_id 已經存在。";
    INVALID_CONNECTION =
        "Select an enabled model connection.",
        "请选择一个已启用的模型连接。",
        "請選擇一個已啟用的模型連線。";
    INVALID_MODEL = "Select an enabled model.", "请选择一个已启用的模型。", "請選擇一個已啟用的模型。";
    CANCEL = "Cancel", "取消", "取消";
    CREATE = "Create", "创建", "建立";
    SAVE = "Save", "保存", "儲存";
    SAVING = "Saving…", "保存中…", "儲存中…";

    // Removing a preset asks first.
    REMOVE_TITLE = "Remove “{name}”?", "删除“{name}”？", "刪除“{name}”？";
    REMOVE_DESCRIPTION =
        "The main agent will no longer see this preset. Existing child tasks are not deleted.",
        "主 Agent 将不再看到这个配置。已创建的子任务不会被删除。",
        "主 Agent 將不再看到這個設定。已建立的子任務不會被刪除。";
    REMOVE_CONFIRM = "Remove", "删除", "刪除";

    // A save the Host did not take.
    SAVE_FAILED = "Failed to save subagent presets", "保存子 Agent 配置失败", "儲存子 Agent 設定失敗";
    REJECTED =
        "The preset was not saved. Check that its name length and the preset count are within their limits.",
        "配置没有被保存。请确认名称长度和配置数量都在上限之内。",
        "設定沒有被儲存。請確認名稱長度和設定數量都在上限之內。";

    // The capability profiles.
    PROFILE_LOCAL_READ = "Code reading", "代码阅读", "程式碼閱讀";
    PROFILE_LOCAL_READ_HELP =
        "Read-only access to the current workspace for search, understanding, and summaries.",
        "只读访问当前工作区，适合搜索、理解和总结代码。",
        "只讀存取目前工作區，適合搜尋、理解和總結程式碼。";
    PROFILE_WEB_RESEARCH = "Web research", "网络研究", "網路研究";
    PROFILE_WEB_RESEARCH_HELP =
        "Web search only, for external sources and current information.",
        "只使用联网搜索，适合查找外部资料和最新信息。",
        "只使用聯網搜尋，適合查詢外部資料和最新資訊。";
    PROFILE_IMPLEMENTATION = "Implementation", "实现代码", "實現程式碼";
    PROFILE_IMPLEMENTATION_HELP =
        "Read and write files and run commands in an isolated worktree.",
        "可以读写文件并执行命令，在隔离 worktree 中完成改动。",
        "可以讀寫檔案並執行命令，在隔離 worktree 中完成改動。";

    // The thinking levels.
    THINKING_OFF = "Off", "关闭", "關閉";
    THINKING_MINIMAL = "Minimal", "最少", "最少";
    THINKING_LOW = "Low", "低", "低";
    THINKING_MEDIUM = "Medium", "中", "中";
    THINKING_HIGH = "High", "高", "高";
    THINKING_XHIGH = "Extra high", "超高", "超高";
    THINKING_MAX = "Maximum", "最大", "最大";
}

/// "3 presets", the line under the list's heading.
pub fn preset_count(locale: Locale, count: usize) -> String {
    let text = plural(count as u64, PRESET_COUNT_ONE, PRESET_COUNT_OTHER);
    text.fill(locale, &[("count", &count.to_string())])
}

/// A text with its one `{name}` filled.
pub fn named(locale: Locale, text: Text, name: &str) -> String {
    text.fill(locale, &[("name", name)])
}

/// The id's rule, with its longest length.
pub fn invalid_id(locale: Locale, max: usize) -> String {
    INVALID_ID.fill(locale, &[("max", &max.to_string())])
}

/// An option of the connection or model dropdown that cannot be chosen,
/// with why: "DeepSeek · Connection disabled".
pub fn unavailable(locale: Locale, name: &str, why: Text) -> String {
    format!("{name} · {}", why.in_locale(locale))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counted_and_named_phrases_read_as_desktops() {
        assert_eq!(preset_count(Locale::English, 1), "1 preset");
        assert_eq!(preset_count(Locale::English, 3), "3 presets");
        assert_eq!(preset_count(Locale::SimplifiedChinese, 3), "共 3 个配置");
        assert_eq!(named(Locale::English, CONFIGURE, "Reader"), "Configure “Reader”");
        assert_eq!(invalid_id(Locale::English, 128).matches("128").count(), 1);
        assert_eq!(
            unavailable(Locale::English, "old", MISSING_CONNECTION),
            "old · Connection missing"
        );
    }
}
