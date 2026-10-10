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

//! The task's trace (the workbar's Trace tool, Maka Desktop's Inspector):
//! the overview of the task's usage, time, cost and context window, the
//! timeline of its Turns and their steps, and the lines that say why
//! something is missing. Desktop's `workbar.inspector` and `inspector`
//! strings in
//! `apps/desktop/src/renderer/application/contracts/conversation-copy.ts`,
//! with its call-kind, permission, recovery and failure tables, in its own
//! words.
//!
//! Where this client differs, and why:
//!
//! - Desktop's Traditional Chinese reads the call-kind, permission, recovery
//!   and failure tables of its Simplified Chinese (`记忆提取` in a
//!   Traditional panel); here those words are Traditional (`記憶提取`).
//! - Desktop names the read failure in a banner title without a period;
//!   here it opens a sentence the reason follows, so it ends with one.
//! - A Turn's steps fold under it here (Desktop lists them always), so its
//!   row names what pressing it does: `SHOW_STEPS`, `HIDE_STEPS`.
//! - The reasons a read failed are this client's (Desktop shows a
//!   generalized message), worded as the Files tool's.
//! - This client has no WorkHub, so Desktop's `workhub_intent` and
//!   `workhub_recall` call kinds have no name here: they show as the kind
//!   itself, as Desktop shows a kind it has not named.

use super::{Locale, plural};

texts! {
    /// The tool's name: its tab and its item in the [+] menu (Desktop's
    /// `workbar.inspector`).
    TRACE = "Trace", "追踪", "追蹤";
    /// The face's accessible name (Desktop's `ariaLabel`).
    REGION = "Task trace", "任务追踪", "任務追蹤";

    // States of the whole face.
    /// The trace could not be read; the reason follows as its own sentence.
    LOAD_FAILED = "Could not read the trace.", "追踪读取失败。", "追蹤讀取失敗。";
    RETRY = "Retry", "重试", "重試";
    /// A task that has done nothing (Desktop's `empty` and `emptyHelp`).
    EMPTY = "Nothing to trace in this task yet", "这个任务还没有可追踪的活动", "這個任務還沒有可追蹤的活動";
    EMPTY_HELP = "No activity recorded for this task yet.", "任务尚无活动记录。", "任務尚無活動記錄。";
    LOADING_TRACE = "Loading timeline…", "正在读取时间线…", "正在讀取時間線…";
    LOADING_SUMMARY = "Estimating full-session usage…", "正在估算完整会话用量…", "正在估算完整會話用量…";
    SUMMARY_UNAVAILABLE =
        "Full-session usage is temporarily unavailable.",
        "完整会话用量暂时无法估算。",
        "完整會話用量暫時無法估算。";

    // Why a read failed.
    WHY_DISCONNECTED =
        "Couldn’t reach the Runtime Host. Check the connection and try again.",
        "无法连接 Runtime Host。请检查连接后重试。",
        "無法連線 Runtime Host。請檢查連線後重試。";
    WHY_HOST =
        "The Runtime Host refused: {message}",
        "Runtime Host 拒绝了请求：{message}",
        "Runtime Host 拒絕了請求：{message}";
    WHY_UNEXPECTED =
        "The Runtime Host answered in a way this version of Maka doesn’t understand. Update Maka and try again.",
        "Runtime Host 的回应无法被此版本的 Maka 识别。请更新 Maka 后重试。",
        "Runtime Host 的回應無法被此版本的 Maka 辨識。請更新 Maka 後重試。";

    // The overview: tokens, time, cost.
    TOKEN_USAGE = "Token usage", "Token 统计", "Token 統計";
    TOKEN_CACHED = "Cached input", "缓存输入", "快取輸入";
    TOKEN_UNCACHED = "Uncached input", "未命中输入", "未命中輸入";
    TOKEN_OUTPUT = "Output (incl. reasoning)", "输出（含思考）", "輸出（含思考）";
    TIME_BREAKDOWN = "Time breakdown", "耗时统计", "耗時統計";
    /// The time section's figure: a sum of per-call durations.
    RECORDED_TIME = "Recorded time", "记录时长", "記錄時長";
    MODEL_CALLS = "LLM calls × {count}", "LLM 调用 × {count}", "LLM 呼叫 × {count}";
    TOOL_RUNS = "Tool runs × {count}", "工具执行 × {count}", "工具執行 × {count}";
    ESTIMATED_COST = "Estimated cost", "估算成本", "估算成本";
    /// A cost nobody could price, never written `$0.00`.
    COST_UNKNOWN = "cost unknown", "费用未知", "費用未知";
    COST_HELP =
        "Estimated from recorded usage and pricing; missing or unpriced calls may be excluded.",
        "基于已记录用量和定价估算；缺失或未定价的调用可能未计入。",
        "基於已記錄用量和定價估算；缺失或未定價的呼叫可能未計入。";
    CACHE_HIT_RATE = "Cache hit rate", "缓存命中率", "快取命中率";

    // The overview: the context window and what filled it.
    CONTEXT_WINDOW = "Context window", "上下文窗口", "上下文視窗";
    SEGMENT_CACHE_HIT = "Cache hit", "缓存命中", "快取命中";
    SEGMENT_CACHE_MISS = "Cache miss", "缓存未命中", "快取未命中";
    SEGMENT_USED = "Used", "已占用", "已佔用";
    SEGMENT_FREE = "Remaining", "剩余", "剩餘";
    COMPOSITION = "Estimated composition", "构成估算", "構成估算";
    COMPOSITION_BASIS =
        "Estimated from request bytes, not provider-reported tokens",
        "按请求字节估算，非模型报告的 token",
        "按請求位元組估算，非模型報告的 token";
    PART_SYSTEM = "System instructions", "系统提示", "系統提示";
    PART_TOOLS = "Tool definitions", "工具定义", "工具定義";
    PART_MESSAGES = "Messages", "对话记录", "對話記錄";
    PART_OPTIONS = "Other options", "其他参数", "其他引數";
    BY_TOOL = "By tool", "按工具", "按工具";
    REMAINING_TOOLS_ONE = "{count} more tool", "其余 {count} 个工具", "其餘 {count} 個工具";
    REMAINING_TOOLS_OTHER = "{count} more tools", "其余 {count} 个工具", "其餘 {count} 個工具";
    UNNAMED_TOOLS = "Unnamed tools", "未命名的工具", "未命名的工具";
    UNRECORDED =
        "This call left no composition on record",
        "这次调用没有留下构成记录",
        "這次呼叫沒有留下構成記錄";

    // The timeline.
    TIMELINE = "Timeline", "时间轴", "時間軸";
    /// A Turn, named by when it started.
    TURN_LABEL = "Turn · {time}", "轮次 · {time}", "輪次 · {time}";
    SHOW_STEPS = "Show steps", "显示步骤", "顯示步驟";
    HIDE_STEPS = "Hide steps", "隐藏步骤", "隱藏步驟";
    LOAD_EARLIER = "Load earlier records", "加载更早记录", "載入更早記錄";
    HIDE_EARLIER = "Hide all earlier records", "隐藏所有更早记录", "隱藏所有更早記錄";
    LOADING_EARLIER = "Loading…", "正在加载…", "正在載入…";

    // The coverage notice: what the trace could not see.
    COVERAGE_PARTIAL =
        "Some calls could not be shown completely, so the numbers below only undercount",
        "部分调用未能完整显示，下面的数字只少不多",
        "部分呼叫未能完整顯示，下面的數字只少不多";
    COVERAGE_PARTIAL_DETAIL =
        "Some calls could not be shown completely, so the numbers below only undercount: {parts}",
        "部分调用未能完整显示，下面的数字只少不多：{parts}",
        "部分呼叫未能完整顯示，下面的數字只少不多：{parts}";
    COVERAGE_ABSENT =
        "This backend does not record per-call detail",
        "这个后端不记录每次调用的明细",
        "這個後端不記錄每次呼叫的明細";
    COVERAGE_ABSENT_DETAIL =
        "This backend does not record per-call detail: {parts}",
        "这个后端不记录每次调用的明细：{parts}",
        "這個後端不記錄每次呼叫的明細：{parts}";
    UNREADABLE_ONE = "{count} record could not be read", "{count} 条记录读不出来", "{count} 條記錄讀不出來";
    UNREADABLE_OTHER = "{count} records could not be read", "{count} 条记录读不出来", "{count} 條記錄讀不出來";
    OVERSIZED_ONE =
        "{count} run record too large to show online",
        "{count} 条运行记录过大，无法在线显示",
        "{count} 條執行記錄過大，無法線上顯示";
    OVERSIZED_OTHER =
        "{count} run records too large to show online",
        "{count} 条运行记录过大，无法在线显示",
        "{count} 條執行記錄過大，無法線上顯示";
    TURNS_MISSING_ONE = "{count} turn with no call record", "{count} 轮没有调用记录", "{count} 輪沒有呼叫記錄";
    TURNS_MISSING_OTHER = "{count} turns with no call record", "{count} 轮没有调用记录", "{count} 輪沒有呼叫記錄";
    TURNS_SHORT_ONE =
        "{count} turn with an incomplete call record",
        "{count} 轮的调用记录不全",
        "{count} 輪的呼叫記錄不全";
    TURNS_SHORT_OTHER =
        "{count} turns with an incomplete call record",
        "{count} 轮的调用记录不全",
        "{count} 輪的呼叫記錄不全";

    // Steps whose kind is their name.
    STEP_PERMISSION = "Permission", "权限", "權限";
    STEP_COMPACTION = "Context compaction", "上下文压缩", "上下文壓縮";
    STEP_ERROR = "Error", "错误", "錯誤";

    // Why a model was called, when not for the Turn itself.
    CALL_MEMORY_EXTRACTION = "Memory extraction", "记忆提取", "記憶提取";
    CALL_SEMANTIC_COMPACT = "Semantic compaction", "语义压缩", "語義壓縮";
    CALL_HISTORY_COMPACT = "History compaction", "历史压缩", "歷史壓縮";
    CALL_GOAL_EVALUATION = "Goal evaluation", "目标评估", "目標評估";
    CALL_SESSION_TITLE = "Task title", "生成任务标题", "生成任務標題";
    CALL_SESSION_RECAP = "Task recap", "任务回顾", "任務回顧";
    CALL_PROMPT_SUGGESTION = "Prompt suggestion", "下一步输入建议", "下一步輸入建議";
    CALL_DAILY_REVIEW = "Daily review", "每日回顾", "每日回顧";

    // How a permission request was answered.
    DECISION_ALLOW = "Allowed", "已允许", "已允許";
    DECISION_DENY = "Denied", "已拒绝", "已拒絕";

    // What a failed tool was recovered as (Desktop's English prints the raw
    // disposition).
    RECOVERED_AS = "recovered as {disposition}", "已恢复：{disposition}", "已恢復：{disposition}";
    RECOVERED_COMPLETED = "completed", "已完成", "已完成";
    RECOVERED_PARKED = "parked", "已搁置", "已擱置";
    /// Attempts beyond the first, in words.
    RETRIES_ONE = "{count} retry", "重试 {count} 次", "重試 {count} 次";
    RETRIES_OTHER = "{count} retries", "重试 {count} 次", "重試 {count} 次";

    // What ended a Turn badly.
    FAILURE_TOOL = "Tool failed", "工具失败", "工具失敗";
    FAILURE_MODEL_CALL = "Model call failed", "模型调用失败", "模型呼叫失敗";
    FAILURE_ABORTED = "Turn aborted", "本轮中止", "本輪中止";
    FAILURE_CANCELLED = "Turn cancelled", "本轮取消", "本輪取消";
    FAILURE_TURN = "Turn failed", "本轮失败", "本輪失敗";
    FAILURE_ERROR = "Run error", "运行出错", "執行出錯";

    // An unpriced call's pricing key, and copying it.
    UNPRICED_PRICING_KEY = "Unpriced pricing key", "未计价的定价键", "未計價的定價鍵";
    COPY_PRICING_KEY = "Copy pricing key", "复制定价键", "複製定價鍵";
    PRICING_KEY_COPIED = "Pricing key copied", "已复制定价键", "已複製定價鍵";
}

/// A Turn's name: "Turn · 9/28/2026, 3:04:05 PM".
pub fn turn_label(locale: Locale, time: &str) -> String {
    TURN_LABEL.fill(locale, &[("time", time)])
}

/// The time section's row for `count` model calls.
pub fn model_calls(locale: Locale, count: u64) -> String {
    MODEL_CALLS.fill(locale, &[("count", &count.to_string())])
}

/// The time section's row for `count` tool runs.
pub fn tool_runs(locale: Locale, count: u64) -> String {
    TOOL_RUNS.fill(locale, &[("count", &count.to_string())])
}

/// The folded row for `count` tools past the visible ones.
pub fn remaining_tools(locale: Locale, count: u64) -> String {
    plural(count, REMAINING_TOOLS_ONE, REMAINING_TOOLS_OTHER)
        .fill(locale, &[("count", &count.to_string())])
}

/// "1 retry", "重试 2 次".
pub fn retries(locale: Locale, count: u64) -> String {
    plural(count, RETRIES_ONE, RETRIES_OTHER).fill(locale, &[("count", &count.to_string())])
}

/// "recovered as parked", "已恢复：已搁置".
pub fn recovered_as(locale: Locale, disposition: &str) -> String {
    RECOVERED_AS.fill(locale, &[("disposition", disposition)])
}

/// The coverage notice: `absent` when the backend records no per-call
/// detail, else partial; `parts` (already in `locale`) follow the
/// language's own colon and list separator, or nothing when empty.
pub fn coverage(locale: Locale, absent: bool, parts: &[String]) -> String {
    let (bare, detail) = if absent {
        (COVERAGE_ABSENT, COVERAGE_ABSENT_DETAIL)
    } else {
        (COVERAGE_PARTIAL, COVERAGE_PARTIAL_DETAIL)
    };
    if parts.is_empty() {
        return bare.in_locale(locale).to_owned();
    }
    let parts: Vec<&str> = parts.iter().map(String::as_str).collect();
    detail.fill(locale, &[("parts", &super::list(locale, &parts))])
}

/// One part of the coverage notice: `count` records that could not be read.
pub fn unreadable(locale: Locale, count: u64) -> String {
    plural(count, UNREADABLE_ONE, UNREADABLE_OTHER).fill(locale, &[("count", &count.to_string())])
}

/// One part of the coverage notice: `count` runs too large to show.
pub fn oversized(locale: Locale, count: u64) -> String {
    plural(count, OVERSIZED_ONE, OVERSIZED_OTHER).fill(locale, &[("count", &count.to_string())])
}

/// One part of the coverage notice: `count` Turns with no call record.
pub fn turns_missing(locale: Locale, count: u64) -> String {
    plural(count, TURNS_MISSING_ONE, TURNS_MISSING_OTHER)
        .fill(locale, &[("count", &count.to_string())])
}

/// One part of the coverage notice: `count` Turns with an incomplete one.
pub fn turns_short(locale: Locale, count: u64) -> String {
    plural(count, TURNS_SHORT_ONE, TURNS_SHORT_OTHER).fill(locale, &[("count", &count.to_string())])
}

/// The Host's refusal, as the reason after [`LOAD_FAILED`].
pub fn why_host(locale: Locale, message: &str) -> String {
    WHY_HOST.fill(locale, &[("message", message)])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_coverage_notice_joins_its_parts_in_each_language() {
        let parts = |locale| vec![turns_missing(locale, 1), unreadable(locale, 2)];
        assert_eq!(
            coverage(Locale::English, false, &parts(Locale::English)),
            "Some calls could not be shown completely, so the numbers below only undercount: \
             1 turn with no call record, 2 records could not be read"
        );
        assert_eq!(
            coverage(Locale::SimplifiedChinese, true, &parts(Locale::SimplifiedChinese)),
            "这个后端不记录每次调用的明细：1 轮没有调用记录、2 条记录读不出来"
        );
        assert_eq!(
            coverage(Locale::TraditionalChinese, false, &[]),
            "部分呼叫未能完整顯示，下面的數字只少不多"
        );
    }

    #[test]
    fn counted_phrases_take_their_form() {
        assert_eq!(retries(Locale::English, 1), "1 retry");
        assert_eq!(retries(Locale::English, 3), "3 retries");
        assert_eq!(retries(Locale::SimplifiedChinese, 3), "重试 3 次");
        assert_eq!(remaining_tools(Locale::English, 1), "1 more tool");
        assert_eq!(oversized(Locale::English, 2), "2 run records too large to show online");
        assert_eq!(
            recovered_as(
                Locale::TraditionalChinese,
                RECOVERED_PARKED.in_locale(Locale::TraditionalChinese)
            ),
            "已恢復：已擱置"
        );
    }
}
