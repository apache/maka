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

//! Maka's own icon set, drawn in Paper on a 16px grid with a 1.5px round
//! stroke (see `docs/design/polish-2026-09-26.md`). The SVGs live in `assets/icons/maka/`
//! and use `currentColor`, so an icon takes the text colour it is rendered with.
//!
//! Use a [`MakaIcon`] wherever `gpui-kit` takes `impl Into<Icon>`; prefer it over
//! Lucide `IconName`s so every glyph in the app shares one stroke and grid.

use gpui_kit::SharedString;
use gpui_kit::component::IconNamed;

/// Path prefix the asset source serves Maka icons under.
pub const ICON_PREFIX: &str = "icons/maka/";

/// The Maka wordmark (460x120 view box, `currentColor` fill), for `gpui_kit::svg()`.
pub const MAKA_WORDMARK: &str = "brand/maka-wordmark.svg";
pub(crate) const MAKA_WORDMARK_SVG: &[u8] =
    include_bytes!("../../../assets/brand/maka-wordmark.svg");

macro_rules! maka_icons {
    ($($variant:ident => $file:literal),* $(,)?) => {
        /// One glyph from the Maka icon set.
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub enum MakaIcon { $($variant),* }

        impl MakaIcon {
            /// Every icon, in declaration order.
            pub const ALL: &[MakaIcon] = &[$(MakaIcon::$variant),*];

            /// The asset path this icon is served under.
            pub fn asset_path(self) -> &'static str {
                match self { $(MakaIcon::$variant => concat!("icons/maka/", $file, ".svg")),* }
            }

            pub(crate) fn bytes(self) -> &'static [u8] {
                match self { $(MakaIcon::$variant => include_bytes!(concat!("../../../assets/icons/maka/", $file, ".svg"))),* }
            }

            pub(crate) fn from_asset_path(path: &str) -> Option<MakaIcon> {
                MakaIcon::ALL.iter().copied().find(|icon| icon.asset_path() == path)
            }
        }
    };
}

maka_icons! {
    Archive => "archive",
    Attach => "attach",
    ChevronDown => "chevron-down",
    ChevronLeft => "chevron-left",
    ChevronRight => "chevron-right",
    Close => "close",
    Compose => "compose",
    Copy => "copy",
    // A file with a plus over a minus, for the changes panel, where Desktop
    // shows Lucide's `file-diff`: drawn on the set's grid and stroke.
    FileDiff => "file-diff",
    Flag => "flag",
    Folder => "folder",
    // An open folder, before a project's heading in the task list, where
    // Desktop shows Lucide's `folder-open`: drawn on the set's grid and stroke.
    FolderOpen => "folder-open",
    Host => "host",
    More => "more",
    Plus => "plus",
    Queue => "queue",
    Search => "search",
    Send => "send",
    Settings => "settings",
    Sidebar => "sidebar",
    StatusDone => "status-done",
    StatusFailed => "status-failed",
    StatusRunning => "status-running",
    StatusStopped => "status-stopped",
    StatusWaiting => "status-waiting",
    Stop => "stop",
    ToolEdit => "tool-edit",
    ToolPlug => "tool-plug",
    ToolRead => "tool-read",
    ToolSearch => "tool-search",
    ToolTerminal => "tool-terminal",
    ToolWeb => "tool-web",
}

impl IconNamed for MakaIcon {
    fn path(self) -> SharedString {
        self.asset_path().into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_icon_is_a_16px_svg_under_its_own_path() {
        for icon in MakaIcon::ALL {
            let text = std::str::from_utf8(icon.bytes()).expect("utf-8");
            assert!(text.starts_with("<svg"), "{icon:?} is an svg");
            assert!(text.contains("viewBox=\"0 0 16 16\""), "{icon:?} is on the 16px grid");
            assert_eq!(MakaIcon::from_asset_path(icon.asset_path()), Some(*icon));
        }
        assert!(
            std::str::from_utf8(MAKA_WORDMARK_SVG)
                .expect("utf-8")
                .contains("viewBox=\"0 0 460 120\"")
        );
    }
}
