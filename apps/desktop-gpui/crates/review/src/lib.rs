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

//! The selected task's workspace changes, as Maka Desktop's Workbar
//! `review` tool shows them, laid out as Claude Code's changes panel:
//! [`git`] reads the task folder's Git changes on this machine (the client
//! runs `git`, as Desktop's main process does; the Host is not asked),
//! [`turns`] works out what each turn of the task changed in each file it
//! edited through Maka's file tools, and [`ReviewPanel`] shows either,
//! beside the conversation or in the conversation's place while maximized.
//! [`ChangeSummary`] keeps what the context strip over the composer says of
//! the Git changes.

pub mod git;
mod panel;
mod refit;
mod shown;
mod summary;
mod sync;
mod tree;
pub mod turns;

use gpui_kit::{App, KeyBinding};

pub use panel::{
    DIFF_LINE_CAP, ReviewPanel, ReviewPanelEvent, ReviewTarget, SPLIT_DIFF_REMS, WIDE_LAYOUT_REMS,
};
pub use summary::{ChangeSummary, ChangeTotals};

/// Key context of the changes panel, while anything in it has focus.
pub const PANEL_CONTEXT: &str = "ReviewPanel";
/// Key context of the panel's file tree, while it has focus.
pub const FILES_CONTEXT: &str = "ReviewFiles";
/// Key context of the panel's list of scopes and commits, while it has
/// focus.
pub const SCOPES_CONTEXT: &str = "ReviewScopes";
/// The panel's keys that a text field in it (the base branch search) takes
/// as typing instead.
const PANEL_KEYS_CONTEXT: &str = "ReviewPanel && !Input";

gpui_kit::actions!(
    review,
    [
        /// Show the next changed file in the diff.
        NextFile,
        /// Show the previous changed file in the diff.
        PreviousFile,
        /// Move to the tree's next row.
        NextRow,
        /// Move to the tree's previous row.
        PreviousRow,
        /// Move to the tree's first row.
        FirstRow,
        /// Move to the tree's last row.
        LastRow,
        /// Fold the folder of the tree's row, or move to the folder above.
        FoldFolder,
        /// Unfold the tree's folder, or move into it.
        UnfoldFolder,
        /// Fold or unfold the tree's folder, or move into the diff from a
        /// file.
        OpenRow,
        /// Show the next scope or commit's changes.
        NextScope,
        /// Show the previous scope or commit's changes.
        PreviousScope,
        /// Scroll the diff to its next change.
        NextChange,
        /// Scroll the diff to its previous change.
        PreviousChange,
        /// Move keyboard focus into the diff.
        FocusDiff,
        /// Make the changes panel fill the plate in the conversation's
        /// place, or give the conversation its place back.
        ToggleMaximized,
        /// Give the conversation its place back, from a maximized panel.
        RestoreSplit,
    ]
);

/// Binds the panel's keys. Call once after `gpui_kit::init`.
///
/// In the file tree ↑ and ↓ move between its rows (Home and End to either
/// end), a file's row showing that file in the diff; ← folds a folder (or
/// goes up to it from inside), → unfolds one (or goes into it), and Enter
/// folds or unfolds a folder or moves into the diff from a file. In the
/// list of scopes and commits ↑ and ↓ show the one above or below, and
/// Enter moves into the diff. Anywhere in the panel `]` and `[` show the
/// next and previous file and `n` and `⇧N` scroll to the next and previous
/// change (the kit's tig example's keys); Esc gives a maximized panel's
/// place back. ⇧Esc maximizes or restores it from anywhere in the window
/// (the binding of editors' pane zoom).
pub fn init(cx: &mut App) {
    shared::menu::init(cx);
    cx.bind_keys([
        KeyBinding::new("up", PreviousRow, Some(FILES_CONTEXT)),
        KeyBinding::new("down", NextRow, Some(FILES_CONTEXT)),
        KeyBinding::new("home", FirstRow, Some(FILES_CONTEXT)),
        KeyBinding::new("end", LastRow, Some(FILES_CONTEXT)),
        KeyBinding::new("left", FoldFolder, Some(FILES_CONTEXT)),
        KeyBinding::new("right", UnfoldFolder, Some(FILES_CONTEXT)),
        KeyBinding::new("enter", OpenRow, Some(FILES_CONTEXT)),
        KeyBinding::new("up", PreviousScope, Some(SCOPES_CONTEXT)),
        KeyBinding::new("down", NextScope, Some(SCOPES_CONTEXT)),
        KeyBinding::new("enter", FocusDiff, Some(SCOPES_CONTEXT)),
        KeyBinding::new("]", NextFile, Some(PANEL_KEYS_CONTEXT)),
        KeyBinding::new("[", PreviousFile, Some(PANEL_KEYS_CONTEXT)),
        KeyBinding::new("n", NextChange, Some(PANEL_KEYS_CONTEXT)),
        KeyBinding::new("shift-n", PreviousChange, Some(PANEL_KEYS_CONTEXT)),
        KeyBinding::new("escape", RestoreSplit, Some(PANEL_CONTEXT)),
        KeyBinding::new("shift-escape", ToggleMaximized, None),
    ]);
}

#[cfg(test)]
mod bench_tests;
#[cfg(test)]
mod git_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod turns_tests;
