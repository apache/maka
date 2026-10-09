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

//! Interface copy of the command palette: its search field, its group
//! headings, and the commands it lists in sentence case (the menu bar's
//! title-case names are in the parent module). Wording follows Maka
//! Desktop's palette (`commandPalette` in
//! apps/desktop/src/renderer/locales/shell-copy.ts). Same rules as the
//! parent module.

texts! {
    // The palette itself.
    /// Its accessible name.
    PALETTE = "Command palette", "命令面板", "命令面板";
    PALETTE_PLACEHOLDER =
        "Search commands, settings, or tasks…",
        "搜索命令、设置项或任务…",
        "搜尋命令、設定項或任務…";
    PALETTE_EMPTY = "No matching commands", "没有匹配的命令", "沒有符合的命令";
    /// The sidebar's search button: its tooltip and accessible name.
    SEARCH = "Search commands and tasks", "搜索命令和任务", "搜尋命令和任務";

    // Group headings, in the order the palette lists them.
    GROUP_TASK = "Task", "任务", "任務";
    GROUP_VIEW = "View", "视图", "檢視";
    GROUP_SETTINGS = "Settings", "设置", "設定";
    GROUP_HOST = "Host", "Host", "Host";
    GROUP_MODEL = "Switch model", "切换模型", "切換模型";
    GROUP_PERMISSION_MODE = "Permission mode", "权限模式", "權限模式";
    GROUP_APPEARANCE = "Appearance", "外观", "外觀";
    GROUP_LANGUAGE = "Language", "语言", "語言";
    /// Keys of the task list, in the keyboard shortcuts sheet.
    GROUP_TASK_LIST = "Task list", "任务列表", "任務列表";
    /// The tasks of the catalog, by title.
    GROUP_OPEN_TASK = "Open task", "打开任务", "開啟任務";

    // Commands.
    FOCUS_COMPOSER = "Focus composer", "聚焦输入框", "聚焦輸入框";
    SEND_MESSAGE = "Send message", "发送消息", "傳送訊息";
    STOP_TURN = "Stop turn", "停止本轮", "停止本輪";
    ARCHIVE_TASK = "Archive task", "归档任务", "歸檔任務";
    UNARCHIVE_TASK = "Unarchive task", "取消归档任务", "取消歸檔任務";
    FLAG_TASK = "Flag task", "标记任务", "標記任務";
    UNFLAG_TASK = "Unflag task", "取消标记任务", "取消標記任務";
    TOGGLE_SIDEBAR = "Toggle sidebar", "切换侧边栏", "切換側邊欄";
    RECONNECT = "Reconnect to Host", "重新连接 Host", "重新連線 Host";
    /// The shortcuts sheet's title.
    KEYBOARD_SHORTCUTS = "Keyboard shortcuts", "键盘快捷键", "鍵盤快捷鍵";
    // The commands that open the palette and the sheet: each opens a
    // dialog, so its name ends in an ellipsis.
    OPEN_KEYBOARD_SHORTCUTS = "Keyboard shortcuts…", "键盘快捷键…", "鍵盤快捷鍵…";
    OPEN_PALETTE = "Command palette…", "命令面板…", "命令面板…";
    // Keys that act on what has focus: the sheet lists them.
    PREVIOUS_TASK = "Previous task", "上一个任务", "上一個任務";
    NEXT_TASK = "Next task", "下一个任务", "下一個任務";
    COLLAPSE_GROUP = "Collapse group", "折叠分组", "摺疊群組";
    EXPAND_GROUP = "Expand group", "展开分组", "展開群組";
    TASK_MENU = "Show task actions", "显示任务操作", "顯示任務操作";
    RENAME_TASK = "Rename task", "重命名任务", "重新命名任務";
    PAGE_UP = "Scroll up a page", "向上翻页", "向上翻頁";
    PAGE_DOWN = "Scroll down a page", "向下翻页", "向下翻頁";
    SCROLL_TO_BEGINNING = "Scroll to the beginning", "滚动到开头", "捲動到開頭";
    /// The sheet's accessible line for one command: its name and keys.
    SHORTCUT_LABEL = "{command}: {keys}", "{command}：{keys}", "{command}：{keys}";
}
