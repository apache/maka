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

//! The workbar's Side chat: a side conversation about the selected task,
//! in a fork of it. Maka Desktop's `quoteCompanion` and `workbar` strings in
//! `apps/desktop/src/renderer/application/contracts/conversation-copy.ts`
//! and `sideChatUnavailable*` in
//! `apps/desktop/src/renderer/locales/shell-copy.ts`.

use super::Locale;

texts! {
    /// The tool and its first tab (Desktop's `workbar.sideChat`).
    SIDE_CHAT = "Side chat", "侧边对话", "側邊對話";
    /// A task's second and later side chats (Desktop's `sideChatNumbered`).
    SIDE_CHAT_NUMBERED = "Side chat {index}", "侧边对话 {index}", "側邊對話 {index}";
    /// The command that opens one (Desktop's `action:side-chat`).
    OPEN_SIDE_CHAT = "Open side chat", "打开侧边对话", "打開側邊對話";
    /// What a side chat is for (Desktop's `workbar.launcher.sideChat`).
    DESCRIPTION = "Ask and explore read-only without interrupting the main task",
        "在不打断主任务的情况下追问和只读探索",
        "在不打斷主任務的情況下追問和只讀探索";
    /// A task with no message yet has nothing to fork (Desktop's
    /// `sideChatUnavailableTitle`).
    UNAVAILABLE = "Side chat is not available yet", "暂时无法打开侧边对话", "暫時無法開啟側邊對話";
    /// Why (Desktop's `sideChatUnavailableDescription`, less its `/side`,
    /// which this client has no command for).
    UNAVAILABLE_BODY = "Send a message in the main task first.",
        "请先在主任务中发送一条消息。",
        "請先在主任務中傳送一條訊息。";
    /// The side chat's model chip: the fork runs its task's model, which
    /// it does not switch (Desktop shows the model as a read-only chip).
    MODEL_INHERITED = "Uses the task’s model", "使用主任务的模型", "使用主任務的模型";
    /// Closing a side chat that has a conversation (Desktop's
    /// `closeConfirmation`).
    CLOSE_TITLE = "Close side chat?", "关闭侧边对话？", "關閉側邊對話？";
    CLOSE_BODY = "This temporary side chat will be permanently deleted and cannot be recovered.",
        "这个临时侧边对话会被永久删除，之后无法恢复。",
        "這個臨時側邊對話會被永久刪除，之後無法恢復。";
    DONT_ASK_AGAIN = "Don’t ask again", "以后不再询问", "以後不再詢問";
    CLOSE_CONFIRM = "Close side chat", "关闭侧边对话", "關閉側邊對話";
    /// Reading the task's turns or creating the fork failed (Desktop's
    /// `errors.forkSetupFailed`).
    FORK_SETUP_FAILED = "Could not open the side chat. Please try again.",
        "无法创建侧边对话，请稍后重试。",
        "無法建立側邊對話，請稍後重試。";
    /// The Host answered `session_busy` (Desktop's `forkSourceBusy`).
    FORK_SOURCE_BUSY = "The main conversation or a linked task is still running. Try again when it finishes.",
        "主对话或子任务仍在运行，请等待完成后重试。",
        "主對話或子任務仍在執行，請等待完成後重試。";
    /// The Host answered `operation_unavailable` (Desktop's
    /// `forkUnsupported`).
    FORK_UNSUPPORTED = "This conversation context cannot be opened as a side chat yet.",
        "当前对话上下文暂不支持创建侧边对话。",
        "目前對話上下文暫不支援建立側邊對話。";
    /// The permission mode picked before the fork existed could not be
    /// set on it, so nothing was sent (Desktop's `respondFailed`).
    RESPOND_FAILED = "The response failed. Please try again.",
        "响应失败，请稍后重试。",
        "回應失敗，請稍後重試。";
    /// The transcript's context menu item that stages the selection as a
    /// quote in the task's side chat (Desktop's `askInSidePanel`, after
    /// its workbar tab's name).
    ASK_IN_SIDE_CHAT = "Ask in side chat", "在侧边对话追问", "在側邊對話追問";
}

/// A tab's name: "Side chat" for the first of a task, then "Side chat 2".
pub fn numbered(locale: Locale, ordinal: usize) -> String {
    if ordinal <= 1 {
        SIDE_CHAT.in_locale(locale).to_owned()
    } else {
        SIDE_CHAT_NUMBERED.fill(locale, &[("index", &ordinal.to_string())])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_side_chat_has_no_number() {
        assert_eq!(numbered(Locale::English, 1), "Side chat");
        assert_eq!(numbered(Locale::English, 2), "Side chat 2");
        assert_eq!(numbered(Locale::SimplifiedChinese, 3), "侧边对话 3");
    }
}
