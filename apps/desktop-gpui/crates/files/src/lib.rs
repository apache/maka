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

//! The task's files: the Artifacts the Runtime Host keeps for a Session,
//! as Maka Desktop's Files tool shows them
//! (`apps/desktop/src/renderer/features/workbar/tools/artifacts/`), read
//! through `artifact.query` and removed with `artifact.delete`.
//!
//! - [`policy`] decides what a person sees and may delete (Desktop's
//!   source policy), the list's keys, safe names, formats and languages.
//! - [`read`] sends the reads: the list page by page, the revision, a
//!   file whole or in chunks, and the delete.
//! - [`ArtifactList`] keeps the selected task's list, polled while the
//!   face shows, as Desktop's is, since no Session domain announces it.
//! - [`ArtifactPreview`] reads one file and draws it by kind.
//! - [`FilesView`] is the workbar's Files face: the list with its filter,
//!   the preview, and its actions. Its keys bind in [`FILES_CONTEXT`]
//!   ([`init`]).
//! - [`Desk`] is where a copy is saved and how one reaches the default app;
//!   [`install_temp_files`] sets up the copies' directory at launch.

mod desk;
mod list;
pub mod policy;
mod preview;
pub mod read;
mod view;

use gpui_kit::{App, KeyBinding};

pub use desk::{ChooseSavePath, Desk, OpenFile, install_temp_files};
pub use list::{ArtifactList, ArtifactListEvent, ListLoad, POLL_INTERVAL};
pub use preview::{ArtifactPreview, Body, ImageBody, PreviewEvent, TextBody};
pub use view::{FilesView, FilesViewEvent, Notice};

/// Key context of the Files face, while anything in it has focus.
pub const FILES_CONTEXT: &str = "FilesFace";
/// Key context of the file list, while it has focus.
pub const LIST_CONTEXT: &str = "FilesList";
/// Key context of a previewed image, while it has focus.
pub const IMAGE_CONTEXT: &str = "FilesImage";

gpui_kit::actions!(
    files,
    [
        /// Move to the list's previous file, wrapping to the last.
        SelectPrevious,
        /// Move to the list's next file, wrapping to the first.
        SelectNext,
        /// Move to the list's first file.
        SelectFirst,
        /// Move to the list's last file.
        SelectLast,
        /// Open the selected file in the preview.
        OpenSelected,
        /// Back from a preview to the list; from the list, give the panel
        /// back.
        Back,
        /// Show the previewed image at its actual size, or fitted again.
        ToggleImageSize,
    ]
);

/// Binds the face's keys. Call once after `gpui_kit::init`.
///
/// In the list ↑ and ↓ move the selection, Home and End jump to the ends,
/// Enter and Space open the selected file; on an image Enter and Space
/// toggle its size; anywhere in the face Escape goes back.
pub fn init(cx: &mut App) {
    shared::menu::init(cx);
    let list = Some(LIST_CONTEXT);
    let image = Some(IMAGE_CONTEXT);
    cx.bind_keys([
        KeyBinding::new("up", SelectPrevious, list),
        KeyBinding::new("down", SelectNext, list),
        KeyBinding::new("home", SelectFirst, list),
        KeyBinding::new("end", SelectLast, list),
        KeyBinding::new("enter", OpenSelected, list),
        KeyBinding::new("space", OpenSelected, list),
        KeyBinding::new("enter", ToggleImageSize, image),
        KeyBinding::new("space", ToggleImageSize, image),
        KeyBinding::new("escape", Back, Some(FILES_CONTEXT)),
    ]);
}

#[cfg(test)]
mod bench_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod view_tests;
