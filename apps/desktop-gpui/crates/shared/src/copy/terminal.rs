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

//! The task's terminals (the workbar's Terminal tool): its tabs, the lines
//! that say where a terminal stands, and its find. Desktop's
//! `workbar.terminal` and `terminalPanel` strings in
//! `apps/desktop/src/renderer/application/contracts/conversation-copy.ts`
//! where it has them; this client's own words for the states Desktop does
//! not show.

use super::Locale;

texts! {
    /// The tool's name: its item in the [+] menu, and an untitled
    /// terminal's tab.
    TERMINAL = "Terminal", "终端", "終端機";
    /// An untitled terminal's tab after the first (Desktop's
    /// `terminalNumbered`).
    TERMINAL_NUMBERED = "Terminal {index}", "终端 {index}", "終端機 {index}";
    /// The [+] menu's Terminal item, which always adds one.
    NEW_TERMINAL = "New terminal", "新建终端", "新增終端機";
    /// A terminal tab's ×, and its accessible name: stops the shell.
    CLOSE_TERMINAL = "Close terminal", "关闭终端", "關閉終端機";
    /// An exited terminal's button: a new terminal in its place.
    RESTART = "Restart", "重新启动", "重新啟動";
    RETRY = "Retry", "重试", "重試";
    /// Forgets a start that was refused or failed.
    DISMISS = "Dismiss", "忽略", "忽略";
    /// The terminal region's accessible name (Desktop's `ariaLabel`).
    REGION = "Task terminal", "任务终端", "任務終端機";
    /// The find bar's name over a terminal.
    FIND_IN_TERMINAL = "Find in terminal", "在终端中查找", "在終端機中尋找";

    // Marks on a terminal's tab, by their accessible names.
    /// The program rang the bell since the terminal was last typed in.
    BELL = "Bell", "响铃", "響鈴";
    /// The shell ended.
    EXITED = "Exited", "已退出", "已結束";
    /// The stop is on its way to the Host; the tab goes when it confirms.
    CLOSING = "Closing…", "正在关闭…", "正在關閉…";
    /// The stop failed; the tab's button tries again.
    CLOSE_FAILED = "Couldn’t close the terminal.", "无法关闭终端。", "無法關閉終端機。";
    RETRY_CLOSE = "Close again", "再次关闭", "再次關閉";

    // The lines that say where the task's terminals stand.
    LOADING = "Loading terminals…", "正在读取终端…", "正在讀取終端機…";
    LOAD_FAILED = "Couldn’t read this task’s terminals.", "无法读取此任务的终端。", "無法讀取此任務的終端機。";
    /// No terminal yet, and none starting.
    EMPTY = "No terminals in this task", "此任务还没有终端", "此任務還沒有終端機";
    STARTING = "Starting a terminal…", "正在新建终端…", "正在新增終端機…";
    /// The window's terminals are at what the Host runs at once.
    LIMIT_REACHED =
        "This window’s terminals are at the Host’s limit of 8. Close one to start another.",
        "此窗口的终端已达到 Host 的上限（8 个），关闭一个后才能再新建。",
        "此視窗的終端機已達到 Host 的上限（8 個），關閉一個後才能再新增。";
    HOST_RESTARTING =
        "The Host couldn’t start a shell and is restarting.",
        "Host 无法启动 Shell，正在重新启动。",
        "Host 無法啟動 Shell，正在重新啟動。";
    START_FAILED = "Couldn’t start a terminal.", "无法新建终端。", "無法新增終端機。";
    /// Taking the terminal's controller and its screen so far.
    ATTACHING = "Connecting…", "正在连接…", "正在連線…";
    HELD_ELSEWHERE =
        "This terminal is open in another window or app.",
        "这个终端已在其他窗口或应用中打开。",
        "這個終端機已在其他視窗或應用程式中開啟。";
    ATTACH_FAILED = "Couldn’t open this terminal.", "无法打开这个终端。", "無法開啟這個終端機。";
    EXITED_WITH_CODE = "Process exited ({code})", "进程已退出（{code}）", "程序已結束（{code}）";
    EXITED_LINE = "Process exited", "进程已退出", "程序已結束";
}

/// An untitled terminal's name: "Terminal" for the first of the task's
/// terminals, then "Terminal 2" and on, by position.
pub fn untitled(locale: Locale, position: usize) -> String {
    if position <= 1 {
        TERMINAL.in_locale(locale).to_owned()
    } else {
        TERMINAL_NUMBERED.fill(locale, &[("index", &position.to_string())])
    }
}

/// The line under an exited terminal: its exit code when the Host knows it.
pub fn exited_line(locale: Locale, exit_code: Option<i64>) -> String {
    match exit_code {
        Some(code) => EXITED_WITH_CODE.fill(locale, &[("code", &code.to_string())]),
        None => EXITED_LINE.in_locale(locale).to_owned(),
    }
}
