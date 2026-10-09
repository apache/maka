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

//! Interface copy of the Health page (settings-health-copy.ts in
//! apps/desktop/src/renderer/locales/). Same rules as the parent module;
//! the strings are Maka Desktop's.

use super::{Locale, plural};

texts! {
    HEALTH_LOADING = "Loading health snapshot", "正在加载健康快照", "正在載入健康快照";
    HEALTH_READ_FAILED = "Could not read health snapshot", "无法读取健康快照", "無法讀取健康快照";
    HEALTH_READ_AGAIN = "Read again", "重新读取", "重新讀取";
    HEALTH_OFFLINE =
        "Connect to the Runtime Host to read its health.",
        "连接到 Runtime Host 后才能读取健康状态。",
        "連線至 Runtime Host 後才能讀取健康狀態。";
    HEALTH_SUBTITLE = "How each capability is currently doing.", "各项能力当前的运行状况检查。", "各項能力目前的執行狀況檢查。";
    HEALTH_LAST_READ = "Last read: {time}", "最近一次读取：{time}", "最近一次讀取：{time}";
    HEALTH_REFRESH = "Refresh", "刷新", "重新整理";
    HEALTH_SUMMARY = "Filter health signals by status", "按状态筛选健康信号", "按狀態篩選健康訊號";
    HEALTH_FILTER_SELECTED =
        "{label}, {count}; filter selected. Press again to show all signals",
        "{label} {count} 项，当前筛选；再次按下显示全部",
        "{label} {count} 項，目前篩選；再次按下顯示全部";
    HEALTH_FILTER =
        "Show only {label} health signals, {count}",
        "仅显示{label}健康信号，共 {count} 项",
        "僅顯示{label}健康訊號，共 {count} 項";
    HEALTH_BLOCKS_SEND_ONE =
        "Across all health signals, {count} of {total} blocks sending",
        "全部健康信号中，{count}/{total} 条会阻塞发送",
        "全部健康訊號中，{count}/{total} 條會阻塞傳送";
    HEALTH_BLOCKS_SEND_OTHER =
        "Across all health signals, {count} of {total} block sending",
        "全部健康信号中，{count}/{total} 条会阻塞发送",
        "全部健康訊號中，{count}/{total} 條會阻塞傳送";
    HEALTH_FOOTNOTE =
        "This page does not run tests, repairs, or permission changes. It only summarizes recorded health signals. Open the relevant settings page or retry the related feature to address an issue.",
        "本页不直接执行测试、修复或权限变更；它只汇总当前已记录的健康信号。需要处理问题时，请进入对应设置页或重新触发相关功能。",
        "本頁不直接執行測試、修復或權限變更；它只彙總目前已記錄的健康訊號。需要處理問題時，請進入對應設定頁或重新觸發相關功能。";
    HEALTH_EMPTY =
        "No model connections to check yet.",
        "还没有可检查的模型连接。",
        "還沒有可檢查的模型連線。";

    // The layers this client fills.
    LAYER_CONFIGURATION = "Configuration", "配置", "設定";
    LAYER_CONFIGURATION_HELP =
        "Whether required settings are complete.",
        "是否填齐了设置页里的必填项。",
        "設定頁中的必填項目是否完整。";
    LAYER_VALIDATION = "Validation", "验证", "驗證";
    LAYER_VALIDATION_HELP =
        "Credential and endpoint connectivity results. A passing validation does not prove the send path works.",
        "凭据 / 端点的连通性测试结果，仅代表验证通过，不等于发送通路可用。",
        "憑證與端點的連線測試結果；驗證通過不代表傳送路徑可用。";
    LAYER_RUNTIME = "Runtime probe", "运行态探测", "執行狀態探測";
    LAYER_RUNTIME_HELP =
        "The latest real send, stream, or event-receipt observation.",
        "最近一次真实运行（发送 / 流式 / 接收事件）的探测结果。",
        "最近一次實際傳送、串流或事件接收的探測結果。";

    // Statuses, scopes, and sources.
    STATUS_OK = "Healthy", "正常", "正常";
    STATUS_INFO = "Info", "提示", "提示";
    STATUS_WARNING = "Warning", "警告", "警告";
    STATUS_ERROR = "Error", "错误", "錯誤";
    STATUS_UNKNOWN = "Unknown", "未知", "未知";
    SCOPE_CONNECTION = "LLM connection", "LLM 连接", "LLM 連線";
    SOURCE_LABEL = "Source: {source}", "来源：{source}", "來源：{source}";
    SOURCE_CONNECTION_TEST = "Connection test", "连接测试", "連線測試";
    SOURCE_RUNTIME_PROBE = "Runtime probe", "运行态探测", "執行態探測";
    SOURCE_SETTINGS = "Settings", "设置", "設定";
    BLOCKS_SEND = "Blocks sending", "阻塞发送", "阻塞傳送";
    RUNTIME_LABEL = "{name} runtime", "{name} 运行态", "{name} 執行狀態";

    // What a signal says.
    MESSAGE_DISABLED = "Connection is disabled.", "连接已关闭。", "連線已關閉。";
    MESSAGE_AWAITING_DEFAULT = "Select a default model.", "等待选择默认模型。", "等待選擇預設模型。";
    MESSAGE_VALIDATION_PASSED =
        "Credentials and endpoint validation passed.",
        "凭据与端点验证已通过。",
        "憑證與端點驗證已通過。";
    MESSAGE_NEEDS_REAUTH =
        "The connection needs authentication repair.",
        "连接需要重新修复认证。",
        "連線需要重新完成驗證。";
    MESSAGE_VALIDATION_FAILED =
        "The latest connection validation failed.",
        "上次连接验证失败。",
        "上次連線驗證失敗。";
    MESSAGE_NO_MODELS =
        "No models are enabled on this connection.",
        "没有启用任何模型。",
        "尚未啟用任何模型。";
    MESSAGE_NOT_DEFAULT =
        "Not the workspace default model source.",
        "不是工作区的默认模型来源。",
        "不是工作區的預設模型來源。";
    MESSAGE_AWAITING_VALIDATION =
        "Waiting to validate the connection.",
        "等待验证连接。",
        "等待驗證連線。";
    MESSAGE_PROBE_PENDING =
        "Waiting for a send-path runtime probe.",
        "等待完成发送运行态探测。",
        "等待完成傳送執行狀態探測。";
    MESSAGE_SEND_COMPLETED = "The latest send completed.", "最近一次发送已完成。", "最近一次傳送已完成。";
    MESSAGE_SEND_ABORTED =
        "The latest send was stopped by the user.",
        "最近一次发送已由用户停止。",
        "最近一次傳送已由使用者停止。";
    MESSAGE_SEND_FAILED = "The latest send failed.", "最近一次发送失败。", "最近一次傳送失敗。";

    // Details under a signal.
    DETAIL_VALIDATION_SCOPE =
        "This validates the connection only; it does not prove send, streaming, or interruption paths have run successfully.",
        "这是连接验证结果，不代表发送、流式输出或中断通路已经运行通过。",
        "這是連線驗證結果，不代表傳送、串流輸出或中斷路徑已實際執行成功。";
    DETAIL_NO_MODELS =
        "Enable at least one model in this connection’s detail view under Settings · Models.",
        "在 设置 · 模型 的连接详情里启用至少一个模型后才能使用该连接。",
        "請在「設定・模型」的連線詳細資料中啟用至少一個模型，才能使用此連線。";
    DETAIL_NOT_DEFAULT =
        "Models on this connection stay usable when selected explicitly in a task; the default model for new chats lives in Settings · General.",
        "在任务中显式选择该连接的模型即可正常使用;新对话的默认模型在 设置 · 通用 配置。",
        "在任務中明確選擇此連線的模型即可使用；新對話的預設模型可在「設定・一般」中設定。";
    DETAIL_PROBE_LAYERS =
        "Credential validation and real send, streaming, and interruption paths are two separate health layers.",
        "凭据验证与真实发送、流式输出、中断通路是两层健康信号。",
        "憑證驗證與實際傳送、串流輸出、中斷路徑是兩層不同的健康訊號。";
    DETAIL_PROBE_MODEL = "Model={model}", "模型={model}", "模型={model}";
    DETAIL_PROBE_LATENCY = "Latency={ms}ms", "延迟={ms}ms", "延遲={ms}ms";
    DETAIL_PROBE_ERROR = "Error type={error}", "错误类型={error}", "錯誤類型={error}";
    DETAIL_TEST_MESSAGE =
        "The connection test status is temporarily unavailable. Test again.",
        "连接测试状态暂时无法显示，请重新测试。",
        "連線測試狀態暫時無法顯示，請重新測試。";
    TEST_AUTH = "Authentication failed", "鉴权失败", "驗證失敗";
    TEST_TIMEOUT = "Request timed out", "请求超时", "請求逾時";
    TEST_PROVIDER = "Model service returned an error", "模型服务返回错误", "模型服務傳回錯誤";
    TEST_NETWORK = "Network error", "网络错误", "網路錯誤";
    TEST_UNKNOWN = "Connection test failed", "连接测试失败", "連線測試失敗";
    RUNTIME_UNKNOWN_ERROR = "Unknown error", "未知错误", "未知錯誤";
}

/// "Last read: 3 minutes ago".
pub fn last_read(locale: Locale, time: &str) -> String {
    HEALTH_LAST_READ.fill(locale, &[("time", time)])
}

/// A status filter's accessible name.
pub fn filter_label(locale: Locale, label: &str, count: usize, selected: bool) -> String {
    let label =
        if selected || locale != Locale::English { label.to_owned() } else { label.to_lowercase() };
    let text = if selected { HEALTH_FILTER_SELECTED } else { HEALTH_FILTER };
    text.fill(locale, &[("label", &label), ("count", &count.to_string())])
}

/// How many signals block sending, of all.
pub fn blocks_send(locale: Locale, count: usize, total: usize) -> String {
    plural(count as u64, HEALTH_BLOCKS_SEND_ONE, HEALTH_BLOCKS_SEND_OTHER)
        .fill(locale, &[("count", &count.to_string()), ("total", &total.to_string())])
}

pub fn source(locale: Locale, source: &str) -> String {
    SOURCE_LABEL.fill(locale, &[("source", source)])
}

pub fn runtime_label(locale: Locale, name: &str) -> String {
    RUNTIME_LABEL.fill(locale, &[("name", name)])
}

/// A runtime probe's result: the model, the latency, and why it failed.
pub fn probe_result(locale: Locale, model: &str, latency_ms: &str, error: Option<&str>) -> String {
    let mut parts = vec![
        DETAIL_PROBE_MODEL.fill(locale, &[("model", model)]),
        DETAIL_PROBE_LATENCY.fill(locale, &[("ms", latency_ms)]),
    ];
    if let Some(error) = error {
        parts.push(DETAIL_PROBE_ERROR.fill(locale, &[("error", error)]));
    }
    parts.join(" · ")
}
