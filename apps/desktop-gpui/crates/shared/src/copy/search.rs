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

//! Finding text: the find bar over the conversation (⌘F), and the Search
//! page over every task (⇧⌘F). Same rules as the parent module.

texts! {
    /// The command that opens the bar, its name, and the query's
    /// placeholder.
    FIND_IN_CONVERSATION = "Find in conversation", "在对话中查找", "在對話中尋找";
    /// The count when a query matches nothing.
    NO_RESULTS = "No results", "无结果", "無結果";
    /// The option buttons: their tooltips and accessible names.
    MATCH_CASE = "Match case", "区分大小写", "區分大小寫";
    MATCH_WHOLE_WORD = "Match whole word", "全字匹配", "全字匹配";
    PREVIOUS_MATCH = "Previous match", "上一个", "上一個";
    NEXT_MATCH = "Next match", "下一个", "下一個";
    /// Under the count while the rest of the task's history is read, so
    /// the count may still grow.
    READING_EARLIER_MESSAGES =
        "Reading earlier messages…",
        "正在读取更早的消息…",
        "正在讀取更早的訊息…";

    // The Search page (⇧⌘F): what was said in every task, through the
    // Host's search.
    /// The page's title, in the plate and the window's title.
    SEARCH = "Search", "搜索", "搜尋";
    /// The command that opens the page, the page's field (its placeholder
    /// and name), and the sidebar's search button.
    SEARCH_ALL_TASKS = "Search all tasks", "搜索所有任务", "搜尋所有任務";
    /// Above the tasks whose titles match the query.
    TASKS = "Tasks", "任务", "任務";
    /// Above the facts the Host's memory holds that match the query.
    FROM_MEMORY = "From memory", "来自记忆", "來自記憶";
    /// Who wrote a passage's message: the person, Maka (as Desktop's
    /// conversation export names the two), or a Tool call.
    ROLE_YOU = "You", "你", "你";
    ROLE_MAKA = "Maka", "Maka", "Maka";
    ROLE_TOOL = "Tool", "工具", "工具";
    /// Under the empty field.
    SEARCH_HINT =
        "Find what was said in every task, archived ones included.",
        "查找所有任务中说过的内容，包括已归档的任务。",
        "尋找所有任務中說過的內容，包括已歸檔的任務。";
    /// Under the field while a search runs; the last results stay, dimmed.
    SEARCHING = "Searching…", "正在搜索…", "正在搜尋…";
    /// After a passage the Host cut to fit its limits.
    SHORTENED = "Shortened", "已截断", "已截斷";
    /// Under the field when the Host searched only its most recent tasks
    /// (recall reads at most 200).
    SCAN_CAPPED =
        "Only the {count} most recently active tasks were searched.",
        "只搜索了最近活跃的 {count} 个任务。",
        "只搜尋了最近活躍的 {count} 個任務。";
    /// Why a search shows nothing: the Host refused it (`incognito_active`,
    /// `invalid_query`, `not_found`, `aborted`, or a reason this client
    /// does not know), or the request did not reach it.
    FAILED_INCOGNITO =
        "Search is off in incognito mode. Turn incognito mode off in Settings to search your tasks.",
        "隐身模式下无法搜索。在设置中关闭隐身模式后即可搜索任务。",
        "隱身模式下無法搜尋。在設定中關閉隱身模式後即可搜尋任務。";
    FAILED_INVALID =
        "This search can’t be run. Use shorter words, and leave out anything that looks like a key or password.",
        "无法执行这次搜索。请使用更短的词语，并去掉看起来像密钥或密码的内容。",
        "無法執行這次搜尋。請使用更短的詞語，並去掉看起來像金鑰或密碼的內容。";
    FAILED_NOT_FOUND = "The tasks to search weren’t found.", "找不到要搜索的任务。", "找不到要搜尋的任務。";
    FAILED_ABORTED = "The search stopped before it finished.", "搜索在完成前停止了。", "搜尋在完成前停止了。";
    FAILED_UNKNOWN = "Couldn’t search your tasks.", "无法搜索任务。", "無法搜尋任務。";
    FAILED_NOT_CONNECTED =
        "Not connected to the Runtime Host. The search runs again once it connects.",
        "未连接到 Runtime Host。连接后会重新搜索。",
        "未連線到 Runtime Host。連線後會重新搜尋。";
    FAILED_UNREACHABLE =
        "Couldn’t reach the Runtime Host’s search.",
        "无法使用 Runtime Host 的搜索。",
        "無法使用 Runtime Host 的搜尋。";
    /// The button after a failure that searching again can mend.
    SEARCH_AGAIN = "Search again", "重新搜索", "重新搜尋";
}
