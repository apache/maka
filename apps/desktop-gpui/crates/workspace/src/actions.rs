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

//! Window-wide commands. Each is one Action so its button, menu item, and key
//! binding dispatch the same thing; the shell handles them on its root
//! element and calls the owning entity's method.

use gpui_kit::SharedString;

gpui_kit::actions!(
    maka,
    [
        /// Create a session in the selected project.
        NewSession,
        /// Move keyboard focus to the message composer.
        FocusComposer,
        /// Send the composer's message to the selected session.
        SendMessage,
        /// Stop the selected session's running turn.
        StopTurn,
        /// Connect to the Runtime Host now instead of waiting to retry.
        Reconnect,
        /// Hide the sidebar, or show it again.
        ToggleSidebar,
        /// Show the task the window showed before the current one.
        GoBack,
        /// Show the task the window showed after the current one, after
        /// going back.
        GoForward,
        /// Open the settings dialog.
        OpenSettings,
        /// Open the settings dialog at Connections, with the form that adds
        /// a model connection.
        AddConnection,
        /// Open the settings dialog at Projects.
        OpenProjectSettings,
        /// Choose another State Root and reconnect the window to it.
        SwitchStateRoot,
        /// Open the command palette: every command and task, searchable.
        OpenCommandPalette,
        /// Archive the selected task, or unarchive it when it is archived.
        ArchiveTask,
        /// Flag the selected task, or unflag it when it is flagged.
        FlagTask,
        /// Show the keyboard shortcuts, grouped, in a dialog.
        ShowKeyboardShortcuts,
        /// Show the Extensions page on the plate.
        OpenExtensions,
        /// Show the Scheduled tasks page on the plate.
        OpenScheduledTasks,
        /// Open the selected task's changes panel, or close it (Desktop's
        /// Workbar `review` tool).
        ToggleReview,
        /// Draw every window a pixel larger: the UI font size, up to its
        /// largest (View › Zoom In).
        ZoomIn,
        /// Draw every window a pixel smaller: the UI font size, down to its
        /// smallest (View › Zoom Out).
        ZoomOut,
        /// Draw every window at the default UI font size again (View ›
        /// Actual Size).
        ResetZoom,
        /// Move focus to the search or filter field of what shows, its
        /// text selected. Bound in the key context of each surface that has
        /// one (settings, the Extensions and Scheduled tasks pages), not
        /// for the whole window.
        FocusSearch,
    ]
);

/// Talk to another Runtime Host in this window: the local one (`local`) or
/// a remote one by its profile id. The window builds its content again for
/// that Host; the footer menu's Host items dispatch it.
#[derive(Clone, Debug, PartialEq, gpui_kit::Action)]
#[action(namespace = maka, no_json)]
pub struct SwitchHost {
    profile_id: SharedString,
}

impl SwitchHost {
    pub fn new(profile_id: impl Into<SharedString>) -> Self {
        Self { profile_id: profile_id.into() }
    }

    /// `local` or a remote profile's id.
    pub fn profile_id(&self) -> &SharedString {
        &self.profile_id
    }
}
