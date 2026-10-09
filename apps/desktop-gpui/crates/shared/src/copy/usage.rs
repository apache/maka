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

//! Interface copy of the Usage page (settings-usage-copy.ts in
//! apps/desktop/src/renderer/locales/). Same rules as the parent module;
//! the strings are Maka Desktop's.

use super::{Locale, plural};

texts! {
    USAGE_STALE_TITLE = "Usage has changed", "统计已更新", "統計已更新";
    USAGE_STALE_BODY =
        "The previous complete result is still shown. Refresh to continue browsing.",
        "当前显示的是之前的完整结果。请刷新后继续浏览。",
        "目前顯示先前的完整結果。請重新整理後繼續瀏覽。";
    USAGE_LOAD_FAILED = "Unable to load Usage", "无法加载使用统计", "無法載入使用統計";
    USAGE_CAPACITY =
        "This complete result exceeds the display capacity. No partial result was loaded.",
        "统计结果超出显示容量，请求未返回任何部分数据。",
        "統計結果超出顯示容量，請求未傳回任何部分資料。";
    USAGE_RETAINED =
        "The last successfully loaded result is still shown; the new query has not taken effect.",
        "当前仍显示上次成功加载的结果，新查询尚未生效。",
        "目前仍顯示上次成功載入的結果，新查詢尚未生效。";
    USAGE_OFFLINE =
        "Connect to the Runtime Host to see usage.",
        "连接到 Runtime Host 后才能查看使用统计。",
        "連線至 Runtime Host 後才能檢視使用統計。";
    USAGE_RANGE = "Usage time range", "使用统计时间范围", "使用統計時間範圍";
    // Desktop says "24h" beside "7天"; here one unit word and one spacing
    // (a space between figure and unit) across the range.
    RANGE_24H = "24 hours", "24 小时", "24 小時";
    RANGE_7D = "7 days", "7 天", "7 天";
    RANGE_30D = "30 days", "30 天", "30 天";
    RANGE_ALL = "All", "全部", "全部";
    USAGE_REFRESH = "Refresh usage", "刷新使用统计", "重新整理使用統計";
    USAGE_SUMMARY = "Usage summary metrics", "使用统计汇总指标", "使用統計彙總指標";
    TOTAL_REQUESTS = "Model calls", "模型调用", "總請求";
    TOTAL_COST = "Total cost", "总费用", "總費用";
    COST_HELP =
        "Final billing is determined by the model provider",
        "以模型供应商最终结算为准",
        "以模型供應商最終結算為準";
    TOTAL_TOKENS = "Total tokens", "总 Token", "總 Token";
    TOKEN_DETAIL = "Input {input} / output {output}", "输入 {input} / 输出 {output}", "輸入 {input} / 輸出 {output}";
    CACHE_TOKENS = "Cache tokens", "缓存 Token", "快取 Token";
    CACHE_DETAIL =
        "New {miss} / hit {read} / created {creation}",
        "新 {miss} / 命中 {read} / 创建 {creation}",
        "新 {miss} / 命中 {read} / 建立 {creation}";
    COST_UNAVAILABLE = "Cost unavailable", "费用未知", "費用未知";
    INCOMPLETE_TITLE = "These numbers may be incomplete", "统计可能不完整", "統計可能不完整";
    INCOMPLETE_BODY =
        "Some records could not be read, are not folded in yet, or exceed the display limit, so real usage may be higher than shown.",
        "部分记录未能读取、尚未纳入统计或超出展示上限，实际用量可能高于此处显示。",
        "部分記錄可能無法讀取、尚未納入統計或超出顯示上限，實際用量可能高於此處顯示。";

    // The tabs.
    USAGE_VIEW = "Usage view", "使用统计视图", "使用統計檢視";
    TAB_ACTIVITY = "Activity log", "活动记录", "請求記錄";
    TAB_PROVIDERS = "Providers", "供应商统计", "供應商統計";
    TAB_MODELS = "Models", "模型统计", "模型統計";
    TAB_TOOLS = "Tools", "工具统计", "工具統計";
    TAB_PRICING = "Pricing", "定价配置", "定價設定";

    // The activity log's filters and pages.
    FILTER_PLACEHOLDER = "Filter by model or tool…", "按模型或工具筛选…", "按模型或工具篩選…";
    FILTER_LABEL =
        "Filter activity by model or tool",
        "按模型或工具筛选活动记录",
        "按模型或工具篩選請求記錄";
    STATUS_LABEL = "Filter by activity status", "活动状态筛选", "請求狀態篩選";
    STATUS_ALL = "All statuses", "全部状态", "全部狀態";
    DETAILS = "Detailed records", "详情记录", "詳情記錄";
    DETAILS_LABEL = "Show detailed usage records", "显示使用统计详情记录", "顯示使用統計詳情記錄";
    /// The model calls tile's line, so it has one as the other tiles do.
    MODELS_USED_ONE = "Across {count} model", "涉及 {count} 个模型", "涉及 {count} 個模型";
    MODELS_USED_OTHER = "Across {count} models", "涉及 {count} 个模型", "涉及 {count} 個模型";
    RECORDS_ONE = "{count} record", "共 {count} 条记录", "共 {count} 條記錄";
    RECORDS_OTHER = "{count} records", "共 {count} 条记录", "共 {count} 條記錄";
    CLEAR_FILTERS = "Clear filters", "清除筛选", "清除篩選";
    PAGINATION = "Activity pages", "活动记录分页", "請求記錄分頁";
    PREVIOUS_PAGE = "Go to previous page", "上一页", "上一頁";
    NEXT_PAGE = "Go to next page", "下一页", "下一頁";
    GO_TO_PAGE = "Go to page {page}", "转到第 {page} 页", "前往第 {page} 頁";
    PAGE_PROGRESS =
        "Loading page {loaded} of {target}",
        "正在加载第 {loaded} / {target} 页",
        "正在載入第 {loaded} / {target} 頁";
    SUMMARY_ONLY =
        "Only summary metrics are shown. Enable detailed records to inspect individual model calls and tool calls, filter by model, tool, or status, and investigate costs or failures.",
        "当前仅显示汇总指标。打开详情记录后，可以查看逐条模型调用和工具调用，按模型、工具或状态筛选，并用于排查费用与失败调用。",
        "目前僅顯示彙總指標。開啟詳情記錄後，可以檢視逐條模型請求和工具呼叫，按模型、工具或狀態篩選，並用於排查費用與失敗請求。";
    SHOW_DETAILS = "Show details", "显示明细", "顯示明細";
    FILTERED_EMPTY = "No activity matches these filters", "没有符合筛选条件的活动记录", "沒有符合篩選條件的請求記錄";
    FILTERED_EMPTY_HELP =
        "Adjust or clear the filters to see all activity records.",
        "调整或清除筛选条件后可查看全部活动记录。",
        "調整或清除篩選條件後可檢視全部請求記錄。";
    REQUEST_EMPTY = "No activity records", "暂无活动记录", "暫無請求記錄";

    // The tables.
    ACTIVITY_TABLE = "Usage activity log", "使用统计活动记录表", "使用統計請求記錄表";
    PROVIDERS_TABLE = "Usage by provider", "使用统计供应商统计表", "使用統計供應商統計表";
    MODELS_TABLE = "Usage by model", "使用统计模型统计表", "使用統計模型統計表";
    TOOLS_TABLE = "Usage by tool", "使用统计工具统计表", "使用統計工具統計表";
    PRICING_TABLE = "Usage pricing configuration", "使用统计定价配置表", "使用統計定價設定表";
    HEADER_TIME = "Time", "时间", "時間";
    HEADER_TYPE = "Type", "类型", "型別";
    HEADER_TARGET = "Target", "对象", "物件";
    HEADER_TASK = "Task", "任务", "任務";
    HEADER_TOKENS = "Tokens", "Token", "Token";
    HEADER_COST = "Cost", "费用", "費用";
    HEADER_LATENCY = "Latency", "延迟", "延遲";
    HEADER_STATUS = "Status", "状态", "狀態";
    HEADER_PROVIDER = "Provider", "供应商", "供應商";
    HEADER_MODEL = "Model", "模型", "模型";
    HEADER_TOOL = "Tool", "工具", "工具";
    HEADER_CALLS = "Calls", "调用", "請求";
    HEADER_TOOL_CALLS = "Calls", "调用", "呼叫";
    HEADER_SUCCESS = "Success", "成功", "成功";
    HEADER_ERRORS = "Errors", "错误", "錯誤";
    HEADER_AVERAGE = "Average duration", "平均耗时", "平均耗時";
    HEADER_INPUT_PRICE = "Input / 1M", "输入 / 1M", "輸入 / 1M";
    HEADER_OUTPUT_PRICE = "Output / 1M", "输出 / 1M", "輸出 / 1M";
    NO_PRICING = "No pricing overrides", "暂无定价覆盖配置", "暫無定價覆蓋設定";
    KIND_MODEL = "Model", "模型", "模型";
    KIND_TOOL = "Tool", "工具", "工具";
    UNKNOWN = "Unknown", "未知", "未知";
    UNTITLED_SESSION = "Untitled session", "未命名会话", "未命名會話";
    OPEN_SESSION = "Open session “{label}”", "打开会话「{label}」", "開啟 {label}";
    OUTCOME_SUCCESS = "Success", "成功", "成功";
    OUTCOME_ERROR = "Error", "错误", "錯誤";
    OUTCOME_ABORTED = "Aborted", "已中止", "已中止";
    PROVIDER_EMPTY = "No provider usage", "暂无供应商用量", "暫無供應商用量";
    PROVIDER_EMPTY_HELP =
        "After a model call, provider call counts, tokens, and costs appear here.",
        "完成一次模型调用后，这里会按供应商聚合调用数、Token 与费用。",
        "完成一次模型請求後，這裡會按供應商聚合請求數、Token 與費用。";
    MODEL_EMPTY = "No model usage", "暂无模型用量", "暫無模型用量";
    MODEL_EMPTY_HELP =
        "After a model call, call counts, tokens, and costs appear here by model.",
        "完成一次模型调用后，这里会按模型聚合调用数、Token 与费用。",
        "完成一次模型請求後，這裡會按模型聚合請求數、Token 與費用。";
    TOOL_EMPTY = "No tool calls", "暂无工具调用", "暫無工具呼叫";
    TOOL_EMPTY_HELP =
        "After an agent calls a tool, calls, successes, errors, and average duration appear here by tool.",
        "智能体调用工具后，这里会按工具聚合调用次数、成功、错误与平均耗时。",
        "智慧體呼叫工具後，這裡會按工具聚合呼叫次數、成功、錯誤與平均耗時。";
    PRICING_EMPTY_HELP =
        "Without pricing overrides, costs use the built-in model pricing table. Add custom prices here for specific models.",
        "未配置定价覆盖时，费用按内置模型定价表结算；在此可为特定模型登记自定义价格。",
        "未設定定價覆蓋時，費用按內建模型定價表結算；在此可為特定模型登記自訂價格。";
}

pub fn token_detail(locale: Locale, input: &str, output: &str) -> String {
    TOKEN_DETAIL.fill(locale, &[("input", input), ("output", output)])
}

pub fn cache_detail(locale: Locale, miss: &str, read: &str, creation: &str) -> String {
    CACHE_DETAIL.fill(locale, &[("miss", miss), ("read", read), ("creation", creation)])
}

pub fn models_used(locale: Locale, count: u64) -> String {
    plural(count, MODELS_USED_ONE, MODELS_USED_OTHER).fill(locale, &[("count", &count.to_string())])
}

pub fn records(locale: Locale, count: u64) -> String {
    plural(count, RECORDS_ONE, RECORDS_OTHER).fill(locale, &[("count", &count.to_string())])
}

pub fn go_to_page(locale: Locale, page: usize) -> String {
    GO_TO_PAGE.fill(locale, &[("page", &page.to_string())])
}

pub fn page_progress(locale: Locale, loaded: usize, target: usize) -> String {
    PAGE_PROGRESS.fill(locale, &[("loaded", &loaded.to_string()), ("target", &target.to_string())])
}

pub fn open_session(locale: Locale, label: &str) -> String {
    OPEN_SESSION.fill(locale, &[("label", label)])
}
