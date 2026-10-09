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

//! Interface copy of the Web Search settings page, in Maka Desktop's words
//! (apps/desktop/src/renderer/locales/settings-web-search-copy.ts, and the
//! group headings of settings-shared-copy.ts). Same rules as the parent
//! module.

use super::{Locale, plural};

/// The Tavily source, a brand, the same in every language.
pub const PROVIDER_TAVILY: &str = "Tavily";
/// The key field's placeholder before a key is saved.
pub const KEY_PLACEHOLDER: &str = "tvly-xxxxxxxx";
/// Where a Tavily key is applied for, after [`SAVED_KEY_HELP`].
pub const TAVILY_URL: &str = "https://tavily.com";
pub const TAVILY_SITE: &str = "tavily.com";

texts! {
    // The Search provider group.
    SEARCH_PROVIDER = "Search provider", "搜索服务商", "搜尋服務商";
    SEARCH_PROVIDER_HELP =
        "The provider and credentials web search uses.",
        "联网搜索使用的服务商与凭据。",
        "聯網搜尋使用的服務商與憑據。";
    PROVIDER = "Search source", "搜索来源", "搜尋來源";
    PROVIDER_HELP =
        "Reuse the current model provider when it supports hosted search, or explicitly use Tavily.",
        "优先复用当前模型的服务端搜索；不支持时可显式改用 Tavily。",
        "優先複用目前模型的服務端搜尋；不支援時可顯式改用 Tavily。";
    PROVIDER_MODEL = "Current model", "当前模型", "目前模型";
    ENABLED = "Enable web search", "启用联网搜索", "啟用聯網搜尋";
    ENABLED_HELP =
        "When enabled, Maka can call the selected search source for current external information.",
        "启用后，Maka 可以在需要最新外部信息时调用所选搜索来源。",
        "啟用後，Maka 可以在需要最新外部資訊時呼叫所選搜尋來源。";
    STATUS_LABEL = "Web search credential status", "联网搜索凭据状态", "聯網搜尋憑據狀態";
    LAST_TEST = "Last tested {time}", "最近测试 {time}", "最近測試 {time}";

    // What the status says.
    STATUS_VALID = "Verified", "已验证", "已驗證";
    STATUS_INVALID_CREDENTIALS = "Invalid key", "密钥无效", "金鑰無效";
    STATUS_RATE_LIMITED = "Rate limited", "服务限流", "服務限流";
    STATUS_TIMEOUT = "Test timed out", "测试超时", "測試超時";
    STATUS_NETWORK_ERROR = "Network error", "网络异常", "網路異常";
    STATUS_NOT_CONFIGURED = "Needs setup", "等待配置", "等待設定";
    STATUS_UNTESTED = "Not tested", "未测试", "未測試";
    STATUS_VALID_ENABLED = "Verified · enabled", "已验证 · 已启用", "已驗證 · 已啟用";
    STATUS_VALID_DISABLED = "Verified · disabled", "已验证 · 未启用", "已驗證 · 未啟用";
    STATUS_UNKNOWN_ENABLED = "Not tested · enabled", "未测试 · 已启用", "未測試 · 已啟用";
    STATUS_MODEL_ENABLED =
        "Enabled · checked per task model",
        "已启用 · 按任务模型判定",
        "已啟用 · 按任務模型判定";
    STATUS_MODEL_DISABLED =
        "Current model source · disabled",
        "当前模型来源 · 未启用",
        "目前模型來源 · 未啟用";

    // Where the credential comes from.
    SOURCE_MODEL = "Source: current model connection", "来源：当前模型连接", "來源：目前模型連線";
    SOURCE_SAVED = "Source: key saved on this device", "来源：本机已保存密钥", "來源：本機已儲存金鑰";
    SOURCE_NONE = "Source: not configured", "来源：未配置", "來源：未設定";

    // The Tavily key.
    KEY = "Tavily key", "Tavily 密钥", "Tavily 金鑰";
    SAVED_KEY_HELP =
        "The key is stored only on this machine. Apply at:",
        "密钥只保存在本机。申请地址：",
        "金鑰只儲存在本機。申請地址：";
    STORED_PLACEHOLDER =
        "Saved (enter a new key to replace)",
        "已保存（输入新密钥可替换）",
        "已儲存（輸入新金鑰可替換）";
    ACTIONS = "Credential actions", "凭据操作", "憑據操作";
    SAVING = "Saving…", "保存中…", "儲存中…";
    SAVE_KEY = "Save key", "保存密钥", "儲存金鑰";
    TESTING = "Testing…", "测试中…", "測試中…";
    TEST_KEY = "Test credentials", "测试凭据", "測試憑據";
    CLEARING = "Clearing…", "清空中…", "清空中…";
    CLEAR_KEY = "Clear key", "清空密钥", "清空金鑰";
    KEY_SAVED = "Tavily key saved", "已保存 Tavily 密钥", "已儲存 Tavily 金鑰";
    KEY_SAVED_DETAIL =
        "Select Test credentials to verify it with a real request.",
        "可点击「测试」做一次真实请求验证。",
        "可點選「測試」做一次真實請求驗證。";
    CREDENTIALS_CLEARED = "Tavily credentials cleared", "已清空 Tavily 凭据", "已清空 Tavily 憑據";
    CREDENTIALS_CLEARED_DETAIL =
        "Web search was disabled automatically.",
        "联网搜索已自动关闭。",
        "聯網搜尋已自動關閉。";
    CREDENTIAL_VALID = "Tavily credentials work", "Tavily 凭据可用", "Tavily 憑據可用";
    RESULT_COUNT_ONE = "Returned {count} result.", "返回 {count} 条结果。", "返回 {count} 條結果。";
    RESULT_COUNT_OTHER = "Returned {count} results.", "返回 {count} 条结果。", "返回 {count} 條結果。";
    TEST_FAILED = "Web search test failed", "联网搜索测试失败", "聯網搜尋測試失敗";
    TEST_ERROR = "Web search test error", "联网搜索测试出错", "聯網搜尋測試出錯";
    SAVE_FAILED = "Failed to save web search settings", "保存联网搜索设置失败", "儲存聯網搜尋設定失敗";
    MODEL_CREDENTIAL = "Primary-model native search", "主模型原生搜索", "主模型原生搜尋";
    MODEL_CREDENTIAL_HELP =
        "At the start of each turn, Maka uses the current connection and exact model to decide whether to inject native web_search into the same model request. It stores no second search key and sends no separate model call from Settings.",
        "Maka 会在每个任务回合开始时，根据当前连接与精确模型决定是否把原生 web_search 注入同一次模型请求。不保存第二份搜索密钥，也不会从设置页另发一次模型调用。",
        "Maka 會在每個任務回合開始時，根據目前連線與精確模型決定是否把原生 web_search 注入同一次模型請求。不儲存第二份搜尋金鑰，也不會從設定頁另發一次模型呼叫。";

    // The Search behavior group: a real query.
    SEARCH_BEHAVIOR = "Search behavior", "搜索行为", "搜尋行為";
    SEARCH_BEHAVIOR_HELP =
        "When a search runs, and how many results it returns.",
        "什么时候发起搜索，以及每次取回多少结果。",
        "什麼時候發起搜尋，以及每次取回多少結果。";
    TEST_SEARCH = "Test search", "测试搜索", "測試搜尋";
    TEST_SEARCH_HELP =
        "Send a real query to confirm the selected web search source is configured and working. Results appear here only and are not written to the task.",
        "发一条真实查询，确认所选联网搜索来源是否配置可用。结果只显示在这里，不写入任务。",
        "發一條真實查詢，確認所選聯網搜尋來源是否設定可用。結果只顯示在這裡，不寫入任務。";
    QUERY_PLACEHOLDER =
        "For example: AI product launches this week",
        "例如：本周 AI 产品发布动态",
        "例如：本週 AI 產品釋出動態";
    SEARCH = "Search", "搜索", "搜尋";
    SEARCHING = "Searching…", "搜索中…", "搜尋中…";
    NO_KEY_REASON =
        "Configure the selected search source first",
        "先配置所选搜索来源",
        "先設定所選搜尋來源";
    DISABLED_REASON = "Enable web search first", "先启用联网搜索", "先啟用聯網搜尋";
    NO_QUERY_REASON = "Enter a query before searching", "输入查询后再搜索", "輸入查詢後再搜尋";
    QUERY_FAILED = "Query failed: {error}", "查询失败：{error}", "查詢失敗：{error}";
    NO_RESULTS = "No results.", "没有结果。", "沒有結果。";
    RESULTS_LABEL = "Web search live query results", "联网搜索真实查询结果", "聯網搜尋真實查詢結果";

    // Why the source refused a search.
    ERROR_INVALID_QUERY = "Enter a valid search query.", "请输入有效的搜索内容。", "請輸入有效的搜尋內容。";
    ERROR_INCOGNITO =
        "Web search is unavailable in incognito mode.",
        "无痕模式下无法使用联网搜索。",
        "無痕模式下無法使用聯網搜尋。";
    ERROR_NOT_CONFIGURED =
        "The selected search source is not configured.",
        "所选搜索来源尚未配置完成。",
        "所選搜尋來源尚未設定完成。";
    ERROR_INVALID_CREDENTIALS =
        "The search provider rejected the current credential. Update it and try again.",
        "搜索来源拒绝了当前凭据，请更新后重试。",
        "搜尋來源拒絕了目前憑據，請更新後重試。";
    ERROR_RATE_LIMITED =
        "The search provider is receiving too many requests. Try again later.",
        "搜索请求过于频繁，请稍后重试。",
        "搜尋請求過於頻繁，請稍後重試。";
    ERROR_NETWORK =
        "The network request failed. Check your connection and try again.",
        "网络请求失败，请检查网络后重试。",
        "網路請求失敗，請檢查網路後重試。";
    ERROR_TIMEOUT = "The search request timed out. Try again.", "搜索请求超时，请重试。", "搜尋請求超時，請重試。";
    ERROR_UNSUPPORTED_PROVIDER =
        "The current model does not support hosted search, or Maka has not implemented its protocol yet. Select Tavily to continue.",
        "当前模型不支持服务端搜索，或 Maka 尚未实现它的协议；可改用 Tavily。",
        "目前模型不支援服務端搜尋，或 Maka 尚未實現它的協議；可改用 Tavily。";
    ERROR_EXPERIMENTAL_DISABLED =
        "The experimental web search feature is currently disabled.",
        "联网搜索实验功能当前已关闭。",
        "聯網搜尋實驗功能目前已關閉。";
}

/// "Returned 3 results.", after a test that worked.
pub fn result_count(locale: Locale, count: usize) -> String {
    let text = plural(count as u64, RESULT_COUNT_ONE, RESULT_COUNT_OTHER);
    text.fill(locale, &[("count", &count.to_string())])
}

/// "Last tested 5 minutes ago".
pub fn last_test(locale: Locale, time: &str) -> String {
    LAST_TEST.fill(locale, &[("time", time)])
}

/// "Query failed: …", above the results.
pub fn query_failed(locale: Locale, error: &str) -> String {
    QUERY_FAILED.fill(locale, &[("error", error)])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_counted_and_filled_lines_read_as_desktops() {
        assert_eq!(result_count(Locale::English, 1), "Returned 1 result.");
        assert_eq!(result_count(Locale::English, 5), "Returned 5 results.");
        assert_eq!(result_count(Locale::SimplifiedChinese, 5), "返回 5 条结果。");
        assert_eq!(query_failed(Locale::English, "Timed out."), "Query failed: Timed out.");
        assert_eq!(last_test(Locale::TraditionalChinese, "剛剛"), "最近測試 剛剛");
    }
}
