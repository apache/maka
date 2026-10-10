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

//! The workbar: the panel of tools beside the plate (Maka Desktop's task
//! workbar), its strip of tabs and its [+] menu. Desktop's `workbar`
//! strings in
//! `apps/desktop/src/renderer/application/contracts/conversation-copy.ts`.
//! Each tool's own words live with it ([`super::review`],
//! [`super::terminal`]).

use super::Locale;

texts! {
    /// The panel's accessible name (Desktop's `ariaLabel`).
    WORKBAR = "Task workbar", "任务工作栏", "任務工作欄";
    /// The strip of tabs (Desktop's `sectionsAriaLabel`).
    TABS = "Task workbar tabs", "任务工作栏标签", "任務工作欄標籤";
    /// The [+] button, which lists every tool (Desktop's `openTab`).
    ADD_PANEL = "Add panel", "添加面板", "新增面板";
    /// A tab's ×, by the tab's name (Desktop's `closeTab`).
    CLOSE_TAB = "Close {name}", "关闭 {name}", "關閉 {name}";
    /// The panel filling the plate in the conversation's place, and back.
    MAXIMIZE = "Maximize panel", "最大化面板", "最大化面板";
}

/// A tab's × button: "Close Changes", "Close vim".
pub fn close_tab(locale: Locale, name: &str) -> String {
    CLOSE_TAB.fill(locale, &[("name", name)])
}
