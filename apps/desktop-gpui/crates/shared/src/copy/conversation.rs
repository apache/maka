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

//! Interface copy of the conversation feature: the transcript pane, its
//! prompts, the composer, and the turn commands. Same rules as the parent
//! module.
//!
//! Protocol values are mapped to these strings by the conversation crate,
//! so this crate stays free of `host-protocol`.

use super::{Locale, plural};

texts! {
    // Empty, loading, and failure states of the pane.
    NO_SESSION_TITLE = "No session selected", "未选择任务", "未選擇任務";
    NO_SESSION_BODY =
        "Select a session in the sidebar, or create a new one.",
        "在侧边栏中选择一个任务，或新建一个任务。",
        "在側邊欄中選擇一個任務，或建立新任務。";
    EMPTY_TITLE = "No messages yet", "暂无消息", "暫無訊息";
    EMPTY_BODY = "Send a message below to start.", "在下方发送消息即可开始。", "在下方傳送訊息即可開始。";
    LOADING = "Loading conversation…", "正在加载对话…", "正在載入對話…";
    WAITING_FOR_HOST = "Waiting for the Runtime Host…", "正在等待 Runtime Host…", "正在等待 Runtime Host…";
    REOPENING = "Reconnecting to this session…", "正在重新连接此任务…", "正在重新連線此任務…";
    OPEN_FAILED = "Couldn’t open this session.", "无法打开此任务。", "無法開啟此任務。";
    SESSION_REMOVED = "This session was removed.", "此任务已被移除。", "此任務已被移除。";
    ACCESS_REVOKED = "This session is no longer available.", "此任务已不可用。", "此任務已無法使用。";
    JUMP_TO_LATEST = "Jump to latest", "跳到最新消息", "跳到最新訊息";
    // Older history, in a row above the first message.
    OLDER_HISTORY_LOADING = "Loading earlier messages", "正在加载更早的消息", "正在載入更早的訊息";
    OLDER_HISTORY_FAILED = "Couldn’t load earlier messages.", "无法加载更早的消息。", "無法載入更早的訊息。";
    /// Above the first message once earlier ones were loaded back to it.
    TASK_BEGINNING = "Beginning of task", "任务开始", "任務開始";
    /// The transcript region, for assistive technology.
    TRANSCRIPT = "Conversation", "对话", "對話";

    // Turn footer. Always text, next to any icon or color.
    TURN_RUNNING = "Working…", "正在处理…", "正在處理…";
    TURN_WAITING = "Waiting for your answer", "等待你的回答", "等待你的回答";
    TURN_FINISHED = "Finished", "已完成", "已完成";
    TURN_FAILED = "Failed", "失败", "失敗";
    TURN_CANCELLED = "Stopped", "已中止", "已中止";
    /// The copy button after a finished turn's footer, and what it says
    /// for a moment once it has copied.
    COPY_REPLY = "Copy reply", "复制回复", "複製回覆";
    REPLY_COPIED = "Copied", "已复制", "已複製";

    // Assistant text.
    TEXT_INTERRUPTED = "Stopped before the reply finished.", "回答完成前已中止。", "回答完成前已中止。";

    // Reasoning, a collapsed row before the step's text (Maka Desktop's
    // `thinking` and `thinkingTruncatedTitle`).
    THINKING = "Thought", "已深度思考", "已深度思考";
    THINKING_STREAMING = "Thinking…", "深度思考中…", "深度思考中…";
    THINKING_TRUNCATED =
        "Some reasoning was truncated; showing the most recent content.",
        "部分 reasoning 已截断；显示的是最近的内容。",
        "部分 reasoning 已截斷；顯示的是最近的內容。";
    SHOW_REASONING = "Show reasoning", "展开思考过程", "展開思考過程";
    HIDE_REASONING = "Hide reasoning", "收起思考过程", "收起思考過程";
    /// Between the collapsed label and the reasoning's first line.
    THINKING_PREVIEW_SEPARATOR = "— ", "：", "：";

    // Tool card.
    TOOL_RUNNING = "Running", "运行中", "執行中";
    TOOL_DONE = "Done", "已完成", "已完成";
    TOOL_FAILED = "Failed", "失败", "失敗";
    TOOL_STOPPED = "Stopped", "已中止", "已中止";
    TOOL_WAITING = "Waiting for your answer", "等待你的回答", "等待你的回答";
    TOOL_INPUT = "Input", "输入", "輸入";
    TOOL_OUTPUT = "Output", "输出", "輸出";
    TOOL_NO_OUTPUT = "No output yet", "尚无输出", "尚無輸出";
    /// A finished call whose result has not arrived: the Host sends Tool
    /// results with the turn's record, once the turn ends.
    TOOL_OUTPUT_AT_TURN_END =
        "Output appears when the turn ends",
        "本轮结束后显示输出",
        "本輪結束後顯示輸出";
    /// A finished call that returned nothing to show (Maka Desktop's `noOutput`).
    TOOL_OUTPUT_NONE = "No output", "无输出", "無輸出";
    /// An empty value or list inside a Tool's output (Maka Desktop's `empty`).
    TOOL_OUTPUT_EMPTY = "(empty)", "（空）", "（空）";
    /// Lines of a Tool's diff past what its card shows (Maka Desktop's
    /// tool result `hiddenLines`).
    TOOL_DIFF_HIDDEN_LINES_ONE = "… {count} line hidden", "… 已隐藏 {count} 行", "… 已隱藏 {count} 行";
    TOOL_DIFF_HIDDEN_LINES_OTHER = "… {count} lines hidden", "… 已隐藏 {count} 行", "… 已隱藏 {count} 行";
    SHOW_DETAILS = "Show input and output", "展开输入和输出", "展開輸入和輸出";
    HIDE_DETAILS = "Hide input and output", "收起输入和输出", "收起輸入和輸出";

    // Prompts.
    ALLOW = "Allow", "允许", "允許";
    DENY = "Deny", "拒绝", "拒絕";
    ANSWER = "Answer", "回答", "回答";
    ALLOWED = "Allowed", "已允许", "已允許";
    ALLOWED_FOR_TURN = "Allowed for this turn", "本轮已允许", "本輪已允許";
    DENIED = "Denied", "已拒绝", "已拒絕";
    ANSWERED = "Answered", "已回答", "已回答";
    NO_LONGER_WAITING = "No longer waiting for an answer", "已不再等待回答", "已不再等待回答";
    UNSUPPORTED_PROMPT =
        "This kind of prompt can’t be answered here yet. Open the session in Maka to answer it.",
        "这类请求暂时无法在此回答。请在 Maka 中打开此任务来回答。",
        "這類請求暫時無法在此回答。請在 Maka 中開啟此任務來回答。";
    QUESTION_TITLE = "The assistant has a question", "助手有一个问题", "助理有一個問題";
    SANDBOX_TITLE = "Allow access outside the workspace?", "允许访问工作区以外的内容？", "允許存取工作區以外的內容？";
    SANDBOX_NETWORK = "Use the network", "使用网络", "使用網路";
    SANDBOX_CONFLICT =
        "Allowed, but not applied: it conflicts with this session’s sandbox",
        "已允许，但未生效：与此任务的沙箱冲突",
        "已允許，但未生效：與此任務的沙箱衝突";
    ANSWER_FAILED = "Couldn’t send the answer.", "无法发送回答。", "無法傳送回答。";

    // Why an interaction closed without an answer (`INTERACTION_CLOSURE_REASONS`).
    CLOSED = "Closed", "已关闭", "已關閉";
    CLOSED_TURN_STOPPED = "Closed because the turn stopped", "因本轮中止而关闭", "因本輪中止而關閉";
    CLOSED_TURN_ENDED = "Closed because the turn ended", "因本轮结束而关闭", "因本輪結束而關閉";
    CLOSED_WITHDRAWN = "Withdrawn by the assistant", "助手已撤回", "助理已撤回";
    CLOSED_TIMED_OUT = "Timed out", "已超时", "已逾時";
    CLOSED_HOST_RESTARTED =
        "Closed because the Runtime Host restarted",
        "因 Runtime Host 重启而关闭",
        "因 Runtime Host 重新啟動而關閉";
    CLOSED_MODEL_DISCONNECTED = "Closed because the model disconnected", "因模型连接断开而关闭", "因模型連線中斷而關閉";

    // Composer.
    COMPOSER_PLACEHOLDER = "Ask anything…", "有什么可以帮你？", "有什麼可以幫你？";
    /// The draft's placeholder while a turn runs: a message sent now waits for it.
    COMPOSER_PLACEHOLDER_QUEUE = "Queue a follow-up…", "加入下一轮队列…", "加入下一輪佇列…";
    /// The composer's note while the window has no Host to send to.
    COMPOSER_OFFLINE = "Not connected to the Runtime Host. You can send once it reconnects.", "未连接到 Runtime Host，连上后即可发送。", "未連線到 Runtime Host，連上後即可傳送。";
    SEND = "Send", "发送", "傳送";
    /// The Send button's name while a turn runs: the message waits for it.
    SEND_QUEUED = "Queue after the current turn", "加入下一轮队列", "加入下一輪佇列";
    STOP = "Stop", "停止", "停止";
    /// The draft's accessible name; the placeholder is not a label.
    COMPOSER_LABEL = "Message", "消息输入框", "訊息輸入框";
    /// The model picker's accessible name and tooltip.
    MODEL = "Model", "模型", "模型";
    /// The model picker's tooltip while a turn runs, when it is disabled.
    MODEL_BUSY = "Switch models when the current turn ends", "本轮结束后再切换模型", "本輪結束後再切換模型";
    MODELS_LOADING = "Loading models…", "正在加载模型…", "正在載入模型…";
    MODELS_FAILED = "Couldn’t load the models", "无法加载模型", "無法載入模型";
    MODELS_NONE = "No models enabled", "没有已启用的模型", "沒有已啟用的模型";
    MODEL_SWITCH_FAILED = "Couldn’t switch the model.", "切换模型失败。", "切換模型失敗。";
    /// The model menu's last item; it opens Settings at Connections, on the form.
    ADD_CONNECTION = "Add connection…", "添加连接…", "新增連線…";
    /// The thinking level picker's accessible name and tooltip (Maka
    /// Desktop's `model.thinkingLevel`), and its levels as Desktop names
    /// them (`model.defaultLevel`, `model.level`).
    THINKING_LEVEL = "Thinking level", "思考级别", "思考級別";
    THINKING_LEVEL_DEFAULT = "Model default", "默认", "預設";
    THINKING_LEVEL_OFF = "Off", "关", "關";
    THINKING_LEVEL_MINIMAL = "Minimal", "最少", "最少";
    THINKING_LEVEL_LOW = "Low", "低", "低";
    THINKING_LEVEL_MEDIUM = "Medium", "中", "中";
    THINKING_LEVEL_HIGH = "High", "高", "高";
    THINKING_LEVEL_XHIGH = "Extra high", "超高", "超高";
    THINKING_LEVEL_MAX = "Maximum", "最高", "最高";
    /// The thinking level picker's tooltip while a turn runs, when it is
    /// disabled (Desktop's `thinkingDisabledRunning`).
    THINKING_LEVEL_BUSY =
        "Wait for the current run to finish before changing the thinking level.",
        "当前任务正在运行，等结束后再切换思考级别。",
        "目前任務正在執行，等結束後再切換思考級別。";
    THINKING_LEVEL_FAILED = "Couldn’t change the thinking level.", "切换思考级别失败。", "切換思考級別失敗。";
    /// The permission mode picker's accessible name and tooltip.
    PERMISSION_MODE = "Permission mode", "权限模式", "權限模式";
    PERMISSION_MODE_FAILED = "Couldn’t change the permission mode.", "切换权限模式失败。", "切換權限模式失敗。";
    // Permission modes (`PERMISSION_MODES`) and their one-line descriptions,
    // worded as Maka Desktop does (`permissions.mode` in packages/ui/src/conversation-copy.ts).
    PERMISSION_READ_ONLY = "Read only", "只读", "只讀";
    PERMISSION_READ_ONLY_HINT =
        "Read and search only; asks before write or network.",
        "只读搜索，不写文件、不上网；需要时先问你。",
        "只讀搜尋，不寫檔案、不上網；需要時先問你。";
    PERMISSION_AUTO = "Auto", "自动", "自動";
    PERMISSION_AUTO_HINT =
        "Runs inside Maka’s protection; asks before going further.",
        "保护层内自动执行，越权先问你。",
        "保護層內自動執行，越權先問你。";
    PERMISSION_FULL_ACCESS = "Full access", "完全权限", "完全權限";
    PERMISSION_FULL_ACCESS_HINT =
        "Direct file and network access. Trust-only tasks.",
        "直接访问文件和网络，仅限可信任务。",
        "直接存取檔案和網路，僅限可信任務。";

    // Attachments: the composer's "+", paste and drop, and the chips under
    // the draft.
    ATTACH = "Attach files…", "添加附件…", "新增附件…";
    /// The platform file dialog's default button.
    ATTACH_BUTTON = "Attach", "添加", "新增";
    ATTACH_TOO_MANY = "Attach up to 8 files to one message.", "一次最多添加 8 个附件。", "一次最多新增 8 個附件。";
    /// A folder pasted or dropped on the composer.
    ATTACH_FOLDER = "Folders can’t be attached.", "文件夹不能作为附件添加。", "資料夾無法作為附件加入。";
    /// A reason after `attach_failed`.
    ATTACH_TOO_LARGE_REASON = "it is larger than 50 MB", "文件超过 50 MB。", "檔案超過 50 MB。";
    ATTACH_UNEXPECTED =
        "the Runtime Host answered in a way this app can’t read",
        "Runtime Host 返回了本应用无法识别的响应。",
        "Runtime Host 回傳了本應用程式無法辨識的回應。";

    // Commands.
    SEND_FAILED = "Couldn’t send the message.", "无法发送消息。", "無法傳送訊息。";
    SEND_BLOCKED =
        "The message wasn’t sent because its skills couldn’t load.",
        "技能加载失败，消息未发送。",
        "技能載入失敗，訊息未傳送。";
    SEND_UNEXPECTED =
        "The Runtime Host answered in a way this app can’t read.",
        "Runtime Host 返回了本应用无法识别的响应。",
        "Runtime Host 回傳了本應用程式無法辨識的回應。";
    STOP_FAILED = "Couldn’t stop the turn.", "无法停止本轮。", "無法停止本輪。";
    SEND_BUSY = "Wait until the last message is sent.", "请等上一条消息发送完成。", "請等上一條訊息傳送完成。";
    NOTHING_RUNNING = "No turn is running.", "当前没有正在运行的轮次。", "目前沒有正在執行的輪次。";
    OTHER_SESSION = "That session is no longer selected.", "已不再选中该任务。", "已不再選取該任務。";
    NOT_READY = "The conversation isn’t loaded yet.", "对话尚未加载完成。", "對話尚未載入完成。";
    // The message queue above the composer (Maka Desktop's pending plate).
    QUEUE_STEERING_TITLE = "Steering the current turn", "正在调整本轮方向", "正在調整本輪方向";
    QUEUE_FOLLOWUP_TITLE = "Queued after the current turn", "已加入下一轮队列", "已加入下一輪佇列";
    QUEUE_PROMOTE = "Send now", "立即发送", "立即傳送";
    QUEUE_PROMOTE_HINT =
        "Steer the running turn with this message",
        "用这条消息调整当前这一轮的方向",
        "用這條訊息調整目前這一輪的方向";
    QUEUE_EDIT = "Edit", "编辑", "編輯";
    QUEUE_SAVE = "Save", "保存", "儲存";
    QUEUE_REMOVE = "Remove from queue", "移出队列", "移出佇列";
    /// A steering message the running turn has taken.
    QUEUE_SENDING = "Sending…", "正在发送…", "正在傳送…";
    /// The edit field's accessible name.
    QUEUE_EDIT_FIELD = "Queued message", "待发送消息", "待發送訊息";
    QUEUE_BUSY =
        "Wait for the last change to the queue to finish.",
        "请等待上一次队列修改完成。",
        "請等待上一次佇列修改完成。";
    QUEUE_PROMOTE_FAILED = "Couldn’t send the message now.", "无法立即发送这条消息。", "無法立即傳送這條訊息。";
    QUEUE_RETRACT_FAILED =
        "Couldn’t remove the message from the queue.",
        "无法将消息移出队列。",
        "無法將訊息移出佇列。";
    QUEUE_EDIT_FAILED = "Couldn’t save the edited message.", "无法保存修改后的消息。", "無法儲存修改後的訊息。";
    CONFIGURE_BUSY = "Wait for the current change to finish.", "请等待当前修改完成。", "請等待目前修改完成。";
    CONFIGURE_CONFLICT =
        "This task changed while it was being updated. Try again.",
        "更新期间任务已发生变化，请重试。",
        "更新期間任務已變更，請重試。";
    CONFIGURE_MISSING = "This task no longer exists.", "此任务已不存在。", "此任務已不存在。";
    CONFIGURE_LEGACY =
        "The Runtime Host answered with a task this app can’t read.",
        "Runtime Host 返回的任务本应用无法识别。",
        "Runtime Host 回傳的任務本應用程式無法辨識。";

    // Turn footer line: its parts joined by the separator.
    FOOTER_SEPARATOR = " · ", " · ", " · ";

    // Sentences with a variable part.
    ATTACH_FAILED = "Couldn’t attach “{name}”.", "无法添加附件「{name}」。", "無法新增附件「{name}」。";
    ATTACH_TOO_LARGE = "“{name}” is larger than 50 MB.", "「{name}」超过 50 MB。", "「{name}」超過 50 MB。";
    ATTACH_UNREADABLE = "Couldn’t read “{name}”.", "无法读取「{name}」。", "無法讀取「{name}」。";
    /// A chip's remove button.
    REMOVE_ATTACHMENT = "Remove {name}", "移除 {name}", "移除 {name}";
    /// A file under 1 KB on its chip.
    FILE_SIZE_BYTES = "{count} bytes", "{count} 字节", "{count} 位元組";
    /// The message queue's accessible name.
    QUEUED_MESSAGES_ONE = "{count} queued message", "{count} 条待发送消息", "{count} 條待發送訊息";
    QUEUED_MESSAGES_OTHER = "{count} queued messages", "{count} 条待发送消息", "{count} 條待發送訊息";
    /// The permission card's title: the Tool and the decision.
    PERMISSION_TITLE = "Allow {tool}?", "允许使用 {tool}？", "允許使用 {tool}？";
    /// A Tool whose name the Host did not send.
    TOOL_UNNAMED = "Tool", "工具", "工具";
    /// A permission for a command, with the folder it runs in.
    PERMISSION_COMMAND_IN =
        "{command}\n(in {cwd})",
        "{command}\n（位于 {cwd}）",
        "{command}\n（位於 {cwd}）";
    /// A permission for a search: the operation, the pattern, and where.
    PERMISSION_SEARCH =
        "{operation} {pattern} in {root}",
        "{operation} {pattern}（位于 {root}）",
        "{operation} {pattern}（位於 {root}）";
    // One access a sandbox boundary request asks for.
    SANDBOX_READ = "Read {path}", "读取 {path}", "讀取 {path}";
    SANDBOX_WRITE = "Write {path}", "写入 {path}", "寫入 {path}";
    /// An access mode this client does not know, by its wire literal.
    SANDBOX_OTHER = "{access} access to {path}", "对 {path} 的 {access} 访问", "對 {path} 的 {access} 存取";
    /// A grant that covers a folder's contents too.
    SANDBOX_SUBTREE = "{grant} and everything in it", "{grant} 及其中的所有内容", "{grant} 及其中的所有內容";
    // The running turn's elapsed clock after its working phrase, in the
    // units of Maka Desktop's `processDuration` without its "Worked for"
    // (packages/ui/src/conversation-copy.ts): "52 秒", "1 分 5 秒".
    TURN_ELAPSED_SECONDS = "{seconds}s", "{seconds} 秒", "{seconds} 秒";
    TURN_ELAPSED_MINUTES = "{minutes}m {seconds}s", "{minutes} 分 {seconds} 秒", "{minutes} 分 {seconds} 秒";
    // A provider request the Runtime retries, on the running turn's line
    // (Desktop's `providerRetryScheduled`, `providerRetryStarted`, and
    // `providerRetryWaiting`). `{max}` counts the first request too.
    RETRY_SCHEDULED =
        "Retrying in {delay} ({attempt}/{max})",
        "{delay}后重试（{attempt}/{max}）",
        "{delay}後重試（{attempt}/{max}）";
    RETRY_STARTED = "Retrying ({attempt}/{max})", "正在重试（{attempt}/{max}）", "正在重試（{attempt}/{max}）";
    RETRY_WAITING =
        "Waiting to retry ({attempt}/{max})",
        "等待重试（{attempt}/{max}）",
        "等待重試（{attempt}/{max}）";
    // The wait before a retry, unit by unit (Desktop's `formatRetryDelay`).
    RETRY_DELAY_DAYS = "{count}d", "{count}天", "{count}天";
    RETRY_DELAY_HOURS = "{count}h", "{count}小时", "{count}小時";
    RETRY_DELAY_MINUTES = "{count}m", "{count}分", "{count}分";
    RETRY_DELAY_SECONDS = "{count}s", "{count}秒", "{count}秒";
    // Why the Runtime retries (Desktop's `providerRetryReason`).
    RETRY_REASON_STREAM_TRUNCATED = "Response stream ended before completion", "响应中途断开", "回應中途斷開";
    RETRY_REASON_NETWORK = "Network interrupted", "网络中断", "網路中斷";
    RETRY_REASON_PROVIDER_CAPACITY =
        "The model service is temporarily at capacity",
        "模型服务暂时满载",
        "模型服務暫時滿載";
    RETRY_REASON_PROVIDER_UNAVAILABLE =
        "Model service temporarily unavailable",
        "模型服务暂时不可用",
        "模型服務暫時不可用";
    RETRY_REASON_RATE_LIMIT = "Model rate limit reached", "触发模型速率限制", "觸發模型速率限制";
    RETRY_REASON_TIMEOUT = "Request timed out", "请求超时", "請求超時";
    RETRY_REASON_UNKNOWN = "Model request failed", "模型请求失败", "模型請求失敗";
}

/// Maka Desktop's `workingPhrases` (packages/ui/src/conversation-copy.ts):
/// what a running turn's status line says while it waits, one phrase per
/// interval. They express that the turn is alive, not stages or progress.
/// Each language has its own list and its own length, so they are not
/// [`super::Text`]s.
const WORKING_PHRASES_EN: &[&str] = &[
    "Pondering…",
    "Tinkering…",
    "Untangling…",
    "Digging in…",
    "Mulling…",
    "Chewing on it…",
    "Wrangling…",
    "Piecing it together…",
];
const WORKING_PHRASES_ZH_CN: &[&str] = &[
    "正在琢磨…",
    "正在推敲…",
    "正在盘算…",
    "正在钻研…",
    "正在忙活…",
    "正在梳理…",
    "正在打磨…",
    "正在鼓捣…",
    "正在酝酿…",
    "正在攻坚…",
    "正在权衡…",
    "正在拾掇…",
];
const WORKING_PHRASES_ZH_TW: &[&str] = &[
    "正在琢磨…",
    "正在推敲…",
    "正在盤算…",
    "正在鑽研…",
    "正在忙活…",
    "正在梳理…",
    "正在打磨…",
    "正在鼓搗…",
    "正在醞釀…",
    "正在攻堅…",
    "正在權衡…",
    "正在拾掇…",
];

/// The working phrase of a running turn's `step`th interval: the locale's
/// list from its first phrase, starting over after its last.
pub fn working_phrase(locale: Locale, step: u64) -> &'static str {
    let phrases = match locale {
        Locale::English => WORKING_PHRASES_EN,
        Locale::SimplifiedChinese => WORKING_PHRASES_ZH_CN,
        Locale::TraditionalChinese => WORKING_PHRASES_ZH_TW,
    };
    phrases[(step % phrases.len() as u64) as usize]
}

/// A retry that waits: "Retrying in 3s (2/5)" ("3秒后重试（2/5）"), with
/// `seconds` at least 1 (Desktop's `providerRetryScheduled`).
pub fn retry_scheduled(locale: Locale, seconds: u64, attempt: u64, max: u64) -> String {
    let delay = retry_delay(locale, seconds);
    RETRY_SCHEDULED.fill(
        locale,
        &[("delay", &delay), ("attempt", &attempt.to_string()), ("max", &max.to_string())],
    )
}

/// A retry under way: "Retrying (2/5)".
pub fn retry_started(locale: Locale, attempt: u64, max: u64) -> String {
    RETRY_STARTED.fill(locale, &[("attempt", &attempt.to_string()), ("max", &max.to_string())])
}

/// A retry that waits, without the wait: "Waiting to retry (2/5)".
pub fn retry_waiting(locale: Locale, attempt: u64, max: u64) -> String {
    RETRY_WAITING.fill(locale, &[("attempt", &attempt.to_string()), ("max", &max.to_string())])
}

/// A wait of `seconds` (at least 1) in days, hours, minutes, and seconds,
/// leaving out the units that are zero: "1h 5s" ("1小时 5秒").
fn retry_delay(locale: Locale, seconds: u64) -> String {
    let seconds = seconds.max(1);
    let units = [
        (seconds / 86_400, RETRY_DELAY_DAYS),
        (seconds % 86_400 / 3_600, RETRY_DELAY_HOURS),
        (seconds % 3_600 / 60, RETRY_DELAY_MINUTES),
        (seconds % 60, RETRY_DELAY_SECONDS),
    ];
    let parts: Vec<String> = units
        .into_iter()
        .filter(|(count, _)| *count > 0)
        .map(|(count, unit)| unit.fill(locale, &[("count", &count.to_string())]))
        .collect();
    parts.join(" ")
}

/// How long a running turn has run, in whole seconds: "52s", "1m 5s"
/// ("52 秒", "1 分 5 秒"). Seconds truncate, so the clock never runs ahead
/// of the time it reports (Desktop's `formatTurnDuration`).
pub fn turn_elapsed(locale: Locale, elapsed_ms: u64) -> String {
    let seconds = elapsed_ms / 1000;
    if seconds < 60 {
        TURN_ELAPSED_SECONDS.fill(locale, &[("seconds", &seconds.to_string())])
    } else {
        TURN_ELAPSED_MINUTES.fill(
            locale,
            &[("minutes", &(seconds / 60).to_string()), ("seconds", &(seconds % 60).to_string())],
        )
    }
}

/// An upload that failed, before its reason.
pub fn attach_failed(locale: Locale, name: &str) -> String {
    ATTACH_FAILED.fill(locale, &[("name", name)])
}

/// A picked file over the size limit.
pub fn attach_too_large(locale: Locale, name: &str) -> String {
    ATTACH_TOO_LARGE.fill(locale, &[("name", name)])
}

/// A picked file that could not be read.
pub fn attach_unreadable(locale: Locale, name: &str) -> String {
    ATTACH_UNREADABLE.fill(locale, &[("name", name)])
}

/// A chip's remove button.
pub fn remove_attachment(locale: Locale, name: &str) -> String {
    REMOVE_ATTACHMENT.fill(locale, &[("name", name)])
}

/// A file's size on its chip: bytes, then KB and MB (1024-based, as Finder
/// shows sizes under 1 MB rounded). The units are the same in every locale.
pub fn file_size(locale: Locale, bytes: u64) -> String {
    const KB: f64 = 1024.;
    let value = bytes as f64;
    if bytes < 1024 {
        FILE_SIZE_BYTES.fill(locale, &[("count", &bytes.to_string())])
    } else if value < KB * KB {
        format!("{:.0} KB", (value / KB).max(1.))
    } else {
        format!("{:.1} MB", value / (KB * KB))
    }
}

/// The note under a Tool's diff cut to what its card shows.
pub fn tool_diff_hidden_lines(locale: Locale, count: usize) -> String {
    plural(count as u64, TOOL_DIFF_HIDDEN_LINES_ONE, TOOL_DIFF_HIDDEN_LINES_OTHER)
        .fill(locale, &[("count", &count.to_string())])
}

/// The message queue's accessible name.
pub fn queued_messages(locale: Locale, count: usize) -> String {
    plural(count as u64, QUEUED_MESSAGES_ONE, QUEUED_MESSAGES_OTHER)
        .fill(locale, &[("count", &count.to_string())])
}

/// The permission card's title: the Tool and the decision.
pub fn permission_title(locale: Locale, tool: &str) -> String {
    PERMISSION_TITLE.fill(locale, &[("tool", tool)])
}

/// One access a sandbox boundary request asks for. An access mode this
/// client does not know is named by its wire literal rather than guessed.
pub fn sandbox_grant(locale: Locale, access: &str, path: &str, subtree: bool) -> String {
    let grant = match access {
        "read" => SANDBOX_READ.fill(locale, &[("path", path)]),
        "write" => SANDBOX_WRITE.fill(locale, &[("path", path)]),
        other => SANDBOX_OTHER.fill(locale, &[("access", other), ("path", path)]),
    };
    if subtree { SANDBOX_SUBTREE.fill(locale, &[("grant", &grant)]) } else { grant }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EN: Locale = Locale::English;

    #[test]
    fn file_sizes_round_like_finder() {
        assert_eq!(file_size(EN, 12), "12 bytes");
        assert_eq!(file_size(EN, 1536), "2 KB");
        assert_eq!(file_size(EN, 5 * 1024 * 1024 + 100 * 1024), "5.1 MB");
        assert_eq!(file_size(Locale::SimplifiedChinese, 1536), "2 KB");
    }

    #[test]
    fn sandbox_grants_name_the_access_and_its_scope() {
        assert_eq!(sandbox_grant(EN, "read", "/etc/hosts", false), "Read /etc/hosts");
        assert_eq!(
            sandbox_grant(EN, "write", "/tmp/out", true),
            "Write /tmp/out and everything in it"
        );
        assert_eq!(sandbox_grant(EN, "execute", "/bin", false), "execute access to /bin");
    }

    #[test]
    fn the_running_clock_counts_whole_seconds_then_minutes() {
        let zh = Locale::SimplifiedChinese;
        assert_eq!(turn_elapsed(EN, 0), "0s");
        assert_eq!(turn_elapsed(EN, 59_999), "59s", "never ahead of the time");
        assert_eq!(turn_elapsed(EN, 65_000), "1m 5s");
        assert_eq!(turn_elapsed(zh, 52_000), "52 秒");
        assert_eq!(turn_elapsed(zh, 65_000), "1 分 5 秒");
        assert_eq!(turn_elapsed(Locale::TraditionalChinese, 3_600_000), "60 分 0 秒");
    }

    #[test]
    fn a_retry_names_its_wait_attempt_and_limit() {
        let zh = Locale::SimplifiedChinese;
        assert_eq!(retry_scheduled(EN, 3, 2, 5), "Retrying in 3s (2/5)");
        assert_eq!(retry_scheduled(zh, 3, 2, 5), "3秒后重试（2/5）");
        assert_eq!(retry_scheduled(EN, 3_605, 2, 5), "Retrying in 1h 5s (2/5)");
        assert_eq!(retry_scheduled(zh, 90_061, 2, 5), "1天 1小时 1分 1秒后重试（2/5）");
        assert_eq!(retry_scheduled(EN, 0, 2, 5), "Retrying in 1s (2/5)", "never zero");
        assert_eq!(retry_started(Locale::TraditionalChinese, 3, 5), "正在重試（3/5）");
        assert_eq!(retry_waiting(EN, 2, 5), "Waiting to retry (2/5)");
    }

    #[test]
    fn working_phrases_cycle_through_each_language_s_own_list() {
        assert_eq!(working_phrase(EN, 0), "Pondering…");
        assert_eq!(working_phrase(EN, 1), "Tinkering…");
        assert_eq!(working_phrase(EN, 8), "Pondering…", "eight in English");
        assert_eq!(working_phrase(Locale::SimplifiedChinese, 8), "正在酝酿…");
        assert_eq!(working_phrase(Locale::SimplifiedChinese, 12), "正在琢磨…");
        assert_eq!(working_phrase(Locale::TraditionalChinese, 2), "正在盤算…");
        for locale in Locale::ALL {
            for step in 0..12 {
                assert!(working_phrase(locale, step).ends_with('…'), "{locale:?} {step}");
            }
        }
    }

    #[test]
    fn queued_message_counts_agree() {
        assert_eq!(queued_messages(EN, 1), "1 queued message");
        assert_eq!(queued_messages(EN, 3), "3 queued messages");
    }
}
