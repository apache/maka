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

//! The window's command table: every command with a place in the command
//! palette or the keyboard shortcuts sheet, with its words, its group, its
//! icon, the key context its binding applies in, and the Action that runs
//! it. The palette lists the window-wide ones that can run (with the
//! choices and tasks it adds when it opens); the sheet lists every one
//! that has a key binding. Both read the bindings from the keymap, so a
//! hint always shows the binding in force and the two cannot drift.

use ::conversation::{
    ScrollPageDown, ScrollPageUp, ScrollToBottom, ScrollToTop, TRANSCRIPT_CONTEXT,
};
use gpui_kit::Action;
use gpui_kit::assets::IconName as AssetIcon;
use gpui_kit::component::{Icon, IconName};
use session::{
    CollapseSessionGroup, ExpandSessionGroup, OpenSessionMenu, RenameSession, SESSION_LIST_CONTEXT,
    SelectNextSession, SelectPreviousSession,
};
use shared::copy::{
    self, Text, commands as words, conversation, extensions as pages, search as find_words,
    settings as settings_copy,
};
use shared::icons::MakaIcon;
use workspace::actions::{
    AddConnection, ArchiveTask, FindInConversation, FlagTask, FocusComposer, GoBack, GoForward,
    NewSession, OpenCommandPalette, OpenExtensions, OpenProjectSettings, OpenScheduledTasks,
    OpenSettings, Reconnect, SearchAllTasks, SendMessage, ShowKeyboardShortcuts, StopTurn,
    SwitchStateRoot, ToggleSidebar,
};

use crate::{Quit, TASK_VIEW_CONTEXT};

/// A group of commands, in the order the palette and the sheet list them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CommandGroup {
    Task,
    View,
    Settings,
    Host,
    /// Keys of the task list, while it has focus.
    TaskList,
    /// Keys of the transcript, while it has focus.
    Transcript,
}

impl CommandGroup {
    /// The group's heading.
    pub fn heading(self) -> Text {
        match self {
            Self::Task => words::GROUP_TASK,
            Self::View => words::GROUP_VIEW,
            Self::Settings => words::GROUP_SETTINGS,
            Self::Host => words::GROUP_HOST,
            Self::TaskList => words::GROUP_TASK_LIST,
            Self::Transcript => conversation::TRANSCRIPT,
        }
    }
}

/// One command of the table.
pub struct CommandSpec {
    /// A stable key: element ids and tests.
    pub id: &'static str,
    pub label: Text,
    pub group: CommandGroup,
    /// The key context the binding applies in; `None` for anywhere in the
    /// window.
    pub context: Option<&'static str>,
    /// Whether the palette offers it: the commands that act on the window
    /// or the task, wherever focus is, except the ones that open the
    /// palette's own neighbours; not the keys of a focused list.
    pub palette: bool,
    icon: fn() -> Icon,
    action: fn() -> Box<dyn Action>,
}

impl CommandSpec {
    /// The Action that runs the command.
    pub fn action(&self) -> Box<dyn Action> {
        (self.action)()
    }

    pub fn icon(&self) -> Icon {
        (self.icon)()
    }
}

impl std::fmt::Debug for CommandSpec {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CommandSpec").field("id", &self.id).finish_non_exhaustive()
    }
}

/// Every command, in the order the palette lists them within their group.
pub static COMMANDS: &[CommandSpec] = &[
    CommandSpec {
        id: "new-task",
        label: copy::NEW_TASK,
        group: CommandGroup::Task,
        context: None,
        palette: true,
        icon: || Icon::new(MakaIcon::Compose),
        action: || Box::new(NewSession),
    },
    CommandSpec {
        id: "focus-composer",
        label: words::FOCUS_COMPOSER,
        group: CommandGroup::Task,
        context: None,
        palette: true,
        icon: || Icon::new(AssetIcon::MessageSquare),
        action: || Box::new(FocusComposer),
    },
    CommandSpec {
        id: "send-message",
        label: words::SEND_MESSAGE,
        group: CommandGroup::Task,
        context: None,
        palette: true,
        icon: || Icon::new(MakaIcon::Send),
        action: || Box::new(SendMessage),
    },
    CommandSpec {
        id: "stop-turn",
        label: words::STOP_TURN,
        group: CommandGroup::Task,
        context: None,
        palette: true,
        icon: || Icon::new(MakaIcon::Stop),
        action: || Box::new(StopTurn),
    },
    CommandSpec {
        id: "find-in-conversation",
        label: find_words::FIND_IN_CONVERSATION,
        group: CommandGroup::Task,
        context: Some(TASK_VIEW_CONTEXT),
        palette: true,
        icon: || Icon::new(MakaIcon::Search),
        action: || Box::new(FindInConversation),
    },
    CommandSpec {
        id: "archive-task",
        label: words::ARCHIVE_TASK,
        group: CommandGroup::Task,
        context: None,
        palette: true,
        icon: || Icon::new(MakaIcon::Archive),
        action: || Box::new(ArchiveTask),
    },
    CommandSpec {
        id: "flag-task",
        label: words::FLAG_TASK,
        group: CommandGroup::Task,
        context: None,
        palette: true,
        icon: || Icon::new(MakaIcon::Flag),
        action: || Box::new(FlagTask),
    },
    CommandSpec {
        id: "toggle-sidebar",
        label: words::TOGGLE_SIDEBAR,
        group: CommandGroup::View,
        context: None,
        palette: true,
        icon: || Icon::new(MakaIcon::Sidebar),
        action: || Box::new(ToggleSidebar),
    },
    CommandSpec {
        id: "go-back",
        label: copy::GO_BACK,
        group: CommandGroup::View,
        context: None,
        palette: true,
        icon: || Icon::new(MakaIcon::ChevronLeft),
        action: || Box::new(GoBack),
    },
    CommandSpec {
        id: "go-forward",
        label: copy::GO_FORWARD,
        group: CommandGroup::View,
        context: None,
        palette: true,
        icon: || Icon::new(MakaIcon::ChevronRight),
        action: || Box::new(GoForward),
    },
    CommandSpec {
        id: "open-extensions",
        label: pages::OPEN_EXTENSIONS,
        group: CommandGroup::View,
        context: None,
        palette: true,
        icon: || Icon::new(AssetIcon::Blocks),
        action: || Box::new(OpenExtensions),
    },
    CommandSpec {
        id: "open-scheduled-tasks",
        label: pages::OPEN_SCHEDULED_TASKS,
        group: CommandGroup::View,
        context: None,
        palette: true,
        icon: || Icon::new(AssetIcon::Timer),
        action: || Box::new(OpenScheduledTasks),
    },
    CommandSpec {
        id: "search-all-tasks",
        label: find_words::SEARCH_ALL_TASKS,
        group: CommandGroup::View,
        context: None,
        palette: true,
        icon: || Icon::new(MakaIcon::Search),
        action: || Box::new(SearchAllTasks),
    },
    CommandSpec {
        id: "command-palette",
        label: words::OPEN_PALETTE,
        group: CommandGroup::View,
        context: None,
        palette: false,
        icon: || Icon::new(MakaIcon::Search),
        action: || Box::new(OpenCommandPalette),
    },
    CommandSpec {
        id: "keyboard-shortcuts",
        label: words::OPEN_KEYBOARD_SHORTCUTS,
        group: CommandGroup::View,
        context: None,
        palette: true,
        icon: || Icon::new(AssetIcon::Keyboard),
        action: || Box::new(ShowKeyboardShortcuts),
    },
    CommandSpec {
        id: "settings",
        label: copy::SETTINGS_ITEM,
        group: CommandGroup::Settings,
        context: None,
        palette: true,
        icon: || Icon::new(MakaIcon::Settings),
        action: || Box::new(OpenSettings),
    },
    CommandSpec {
        id: "add-connection",
        label: conversation::ADD_CONNECTION,
        group: CommandGroup::Settings,
        context: None,
        palette: true,
        icon: || Icon::new(MakaIcon::Plus),
        action: || Box::new(AddConnection),
    },
    CommandSpec {
        id: "manage-projects",
        label: copy::MANAGE_PROJECTS,
        group: CommandGroup::Settings,
        context: None,
        palette: true,
        icon: || Icon::new(MakaIcon::Folder),
        action: || Box::new(OpenProjectSettings),
    },
    CommandSpec {
        id: "reconnect",
        label: words::RECONNECT,
        group: CommandGroup::Host,
        context: None,
        palette: true,
        icon: || Icon::new(IconName::RotateCw),
        action: || Box::new(Reconnect),
    },
    CommandSpec {
        id: "switch-state-root",
        label: copy::SWITCH_STATE_ROOT,
        group: CommandGroup::Host,
        context: None,
        palette: true,
        icon: || Icon::new(AssetIcon::FolderSync),
        action: || Box::new(SwitchStateRoot),
    },
    CommandSpec {
        id: "quit",
        label: copy::MENU_QUIT,
        group: CommandGroup::Host,
        context: None,
        palette: true,
        icon: || Icon::new(AssetIcon::Power),
        action: || Box::new(Quit),
    },
    CommandSpec {
        id: "previous-task",
        label: words::PREVIOUS_TASK,
        group: CommandGroup::TaskList,
        context: Some(SESSION_LIST_CONTEXT),
        palette: false,
        icon: || Icon::new(IconName::ArrowUp),
        action: || Box::new(SelectPreviousSession),
    },
    CommandSpec {
        id: "next-task",
        label: words::NEXT_TASK,
        group: CommandGroup::TaskList,
        context: Some(SESSION_LIST_CONTEXT),
        palette: false,
        icon: || Icon::new(IconName::ArrowDown),
        action: || Box::new(SelectNextSession),
    },
    CommandSpec {
        id: "collapse-group",
        label: words::COLLAPSE_GROUP,
        group: CommandGroup::TaskList,
        context: Some(SESSION_LIST_CONTEXT),
        palette: false,
        icon: || Icon::new(MakaIcon::ChevronLeft),
        action: || Box::new(CollapseSessionGroup),
    },
    CommandSpec {
        id: "expand-group",
        label: words::EXPAND_GROUP,
        group: CommandGroup::TaskList,
        context: Some(SESSION_LIST_CONTEXT),
        palette: false,
        icon: || Icon::new(MakaIcon::ChevronRight),
        action: || Box::new(ExpandSessionGroup),
    },
    CommandSpec {
        id: "task-menu",
        label: words::TASK_MENU,
        group: CommandGroup::TaskList,
        context: Some(SESSION_LIST_CONTEXT),
        palette: false,
        icon: || Icon::new(MakaIcon::More),
        action: || Box::new(OpenSessionMenu),
    },
    CommandSpec {
        id: "rename-task",
        label: words::RENAME_TASK,
        group: CommandGroup::TaskList,
        context: Some(SESSION_LIST_CONTEXT),
        palette: false,
        icon: || Icon::new(AssetIcon::Pencil),
        action: || Box::new(RenameSession),
    },
    CommandSpec {
        id: "page-up",
        label: words::PAGE_UP,
        group: CommandGroup::Transcript,
        context: Some(TRANSCRIPT_CONTEXT),
        palette: false,
        icon: || Icon::new(IconName::ChevronUp),
        action: || Box::new(ScrollPageUp),
    },
    CommandSpec {
        id: "page-down",
        label: words::PAGE_DOWN,
        group: CommandGroup::Transcript,
        context: Some(TRANSCRIPT_CONTEXT),
        palette: false,
        icon: || Icon::new(MakaIcon::ChevronDown),
        action: || Box::new(ScrollPageDown),
    },
    CommandSpec {
        id: "transcript-top",
        label: words::SCROLL_TO_BEGINNING,
        group: CommandGroup::Transcript,
        context: Some(TRANSCRIPT_CONTEXT),
        palette: false,
        icon: || Icon::new(IconName::ArrowUp),
        action: || Box::new(ScrollToTop),
    },
    CommandSpec {
        id: "transcript-bottom",
        label: conversation::JUMP_TO_LATEST,
        group: CommandGroup::Transcript,
        context: Some(TRANSCRIPT_CONTEXT),
        palette: false,
        icon: || Icon::new(IconName::ArrowDown),
        action: || Box::new(ScrollToBottom),
    },
    // While the find bar shows, anywhere in the task view.
    CommandSpec {
        id: "next-match",
        label: find_words::NEXT_MATCH,
        group: CommandGroup::Transcript,
        context: Some(TASK_VIEW_CONTEXT),
        palette: false,
        icon: || Icon::new(MakaIcon::ChevronRight),
        action: || Box::new(search::SelectNextMatch),
    },
    CommandSpec {
        id: "previous-match",
        label: find_words::PREVIOUS_MATCH,
        group: CommandGroup::Transcript,
        context: Some(TASK_VIEW_CONTEXT),
        palette: false,
        icon: || Icon::new(MakaIcon::ChevronLeft),
        action: || Box::new(search::SelectPreviousMatch),
    },
];

/// The commands the palette may list, in table order.
pub fn palette_commands() -> impl Iterator<Item = &'static CommandSpec> {
    COMMANDS.iter().filter(|command| command.palette)
}

/// The command whose key is `id`.
pub fn command(id: &str) -> Option<&'static CommandSpec> {
    COMMANDS.iter().find(|command| command.id == id)
}

/// The settings heading, for the palette's section choices.
pub(crate) const SETTINGS_HEADING: Text = settings_copy::SETTINGS;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_are_unique_and_groups_are_contiguous() {
        let mut seen = std::collections::HashSet::new();
        for command in COMMANDS {
            assert!(seen.insert(command.id), "{} twice", command.id);
        }
        let groups: Vec<CommandGroup> = COMMANDS.iter().map(|command| command.group).collect();
        let mut runs = groups.clone();
        runs.dedup();
        let mut unique = runs.clone();
        unique.sort_by_key(|group| *group as u8);
        unique.dedup();
        assert_eq!(runs.len(), unique.len(), "each group is listed in one run");
    }
}
