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

//! The application's asset source: the `gpui-kit` default icon bundle, the
//! Lucide icons this app uses beyond it, and the files in `assets/` at the
//! repository root (origins and licenses in `assets/README.md`).
//!
//! Register [`AppAssets`] once, on the application. Everything is embedded
//! in the binary, so loading an asset never touches the filesystem.

use std::borrow::Cow;

use gpui_kit::{AssetSource, Result, SharedString};

use crate::icons::{MAKA_WORDMARK, MAKA_WORDMARK_SVG, MakaIcon};

// Lucide icons outside the `gpui-kit` default bundle, for the few meanings
// Maka's own set (`crate::icons::MakaIcon`, preferred everywhere) has no
// glyph for. An icon a view uses through `gpui_kit::assets::IconName` must be
// listed here, or it renders as nothing.
gpui_kit::assets::icon_assets!(
    ExtraIcons,
    [
        Languages,
        FolderSync,
        ShieldCheck,
        Pencil,
        Trash,
        FolderPlus,
        Link2,
        Brain,
        MessageSquare,
        Power,
        Keyboard,
        FileImage,
        // The settings sections Maka Desktop draws with Lucide glyphs.
        Workflow,
        ChartColumn,
        ListTodo,
        Upload,
        CalendarDays,
        Database,
        Activity,
        // The sidebar's pages and the Skills page, as Desktop draws them.
        Blocks,
        Timer,
        Download,
        FolderOpen,
        // Attachment chips, one glyph per kind (Desktop's
        // `ATTACHMENT_KIND_ICON`).
        FileText,
        FileType,
        FileCode,
        Paperclip,
        // A model's parameters on the Models page (Desktop's wrench).
        Wrench,
        // Archived tasks' Restore, the scheduled tasks' empty state, and
        // the Usage page's refresh, as Desktop draws them.
        ArchiveRestore,
        Clock,
        RefreshCw,
        // The changes panel's empty state (Desktop's `GitBranch`), its
        // focus and restore (Desktop's Workbar previews' `Maximize2` and
        // `Minimize2`), and the unchanged lines it unfolds and folds.
        GitBranch,
        Maximize2,
        Minimize2,
        UnfoldVertical,
        FoldVertical,
        // The changes panel's file tree toggle, as Claude Code draws it.
        ListTree
    ]
);

/// The Maka app icon (1024 px square PNG with the platform icon margin), for
/// `gpui_kit::img`.
pub const MAKA_ICON: &str = "images/maka-icon.png";
const MAKA_ICON_PNG: &[u8] = include_bytes!("../../../assets/maka-icon.png");

/// Serves the app's own files first, then the extra icons, then the default
/// `gpui-kit` bundle.
#[derive(Debug, Clone, Copy, Default)]
pub struct AppAssets;

impl AssetSource for AppAssets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        if path == MAKA_ICON {
            return Ok(Some(Cow::Borrowed(MAKA_ICON_PNG)));
        }
        if path == MAKA_WORDMARK {
            return Ok(Some(Cow::Borrowed(MAKA_WORDMARK_SVG)));
        }
        if let Some(icon) = MakaIcon::from_asset_path(path) {
            return Ok(Some(Cow::Borrowed(icon.bytes())));
        }
        if let Some(data) = ExtraIcons.load(path)? {
            return Ok(Some(data));
        }
        gpui_kit::assets::Assets.load(path)
    }

    fn list(&self, path: &str) -> Result<Vec<SharedString>> {
        let mut paths = gpui_kit::assets::Assets.list(path)?;
        paths.extend(ExtraIcons.list(path)?);
        if MAKA_ICON.starts_with(path) {
            paths.push(MAKA_ICON.into());
        }
        if MAKA_WORDMARK.starts_with(path) {
            paths.push(MAKA_WORDMARK.into());
        }
        paths.extend(
            MakaIcon::ALL
                .iter()
                .map(|icon| icon.asset_path())
                .filter(|asset| asset.starts_with(path))
                .map(SharedString::from),
        );
        Ok(paths)
    }
}

#[cfg(test)]
mod tests {
    use gpui_kit::assets::IconName;

    use super::*;

    #[test]
    fn the_app_icon_and_every_icon_in_use_load() {
        let icon = AppAssets.load(MAKA_ICON).expect("load").expect("the app icon");
        assert!(icon.starts_with(b"\x89PNG"), "a PNG");
        for name in [
            IconName::Folder,
            IconName::ChevronDown,
            IconName::Languages,
            IconName::Palette,
            IconName::FolderSync,
            IconName::ShieldCheck,
            IconName::Settings,
            IconName::Info,
            IconName::Search,
            IconName::MessageSquare,
            IconName::Power,
            IconName::Keyboard,
            IconName::PanelLeft,
            IconName::Blocks,
            IconName::Timer,
            IconName::Download,
            IconName::FolderOpen,
            IconName::FileImage,
            IconName::FileText,
            IconName::FileType,
            IconName::FileCode,
            IconName::Paperclip,
            IconName::Wrench,
            IconName::Cpu,
            IconName::Trash,
        ] {
            let path = name.path();
            assert!(AppAssets.load(&path).expect("load").is_some(), "{path}");
        }
        assert!(AppAssets.list("images/").expect("list").iter().any(|path| path == MAKA_ICON));
    }

    /// Every Lucide icon a view names through `gpui_kit::assets::IconName`
    /// (under any alias) is served: one left out renders as nothing and
    /// logs "could not find asset".
    #[test]
    #[allow(clippy::disallowed_methods)] // reads the workspace's sources
    fn every_lucide_icon_the_sources_name_loads() {
        let crates = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let mut sources = Vec::new();
        let mut pending = vec![crates];
        while let Some(dir) = pending.pop() {
            for entry in std::fs::read_dir(&dir).expect("read dir").flatten() {
                let path = entry.path();
                if path.is_dir() {
                    pending.push(path);
                } else if path.extension().is_some_and(|ext| ext == "rs") {
                    sources.push(std::fs::read_to_string(&path).expect("source"));
                }
            }
        }
        let names: std::collections::BTreeSet<String> = sources
            .iter()
            .flat_map(|source| {
                let mut prefixes = vec!["gpui_kit::assets::IconName::".to_owned()];
                for line in source.lines() {
                    if let Some(alias) = line
                        .trim()
                        .strip_prefix("use gpui_kit::assets::IconName as ")
                        .and_then(|rest| rest.strip_suffix(';'))
                    {
                        prefixes.push(format!("{alias}::"));
                    }
                }
                prefixes
                    .into_iter()
                    .flat_map(|prefix| {
                        source
                            .match_indices(prefix.as_str())
                            .map(|(at, _)| {
                                source[at + prefix.len()..]
                                    .chars()
                                    .take_while(char::is_ascii_alphanumeric)
                                    .collect::<String>()
                            })
                            .collect::<Vec<_>>()
                    })
                    .collect::<Vec<_>>()
            })
            .filter(|name| name.starts_with(|c: char| c.is_ascii_uppercase()))
            .collect();
        assert!(names.contains("ArchiveRestore"), "the scan finds the sources' icons");
        for name in names {
            let icon = IconName::ALL
                .iter()
                .find(|icon| format!("{icon:?}") == name)
                .unwrap_or_else(|| panic!("no Lucide icon {name}"));
            let path = icon.path();
            assert!(
                AppAssets.load(&path).expect("load").is_some(),
                "{name} ({path}) is not served"
            );
        }
    }
}
