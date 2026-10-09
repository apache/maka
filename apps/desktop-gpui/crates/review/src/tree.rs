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

//! The changed files as the panel's tree shows them: grouped by folder,
//! folders before files and each by name, a chain of folders that hold
//! one folder and no file compressed into one row (`src/main/java`), and
//! folders foldable. One row each, a file's with its icon, its name and
//! the lines it adds and deletes; the selected file's row filled, the
//! keyboard's row ringed.
//!
//! The tree's file order is the order the diff shows the files in, so
//! reading down the diff reads down the tree.

use std::collections::{BTreeMap, HashSet};
use std::rc::Rc;

use gpui_kit::assets::IconName as AssetIcon;
use gpui_kit::component::{Icon, StyledExt as _, ThemeStyled as _, h_flex};
use gpui_kit::{
    AnyElement, App, ClickEvent, FocusHandle, InteractiveElement as _, IntoElement, MouseButton,
    MouseDownEvent, ParentElement as _, Role, SharedString, StatefulInteractiveElement as _,
    Styled as _, TestSupportExt as _, WeakEntity, Window, div, prelude::FluentBuilder as _, rems,
};
use shared::copy::conversation::file_size;
use shared::copy::review as copy;
use shared::copy::{Locale, Text};
use shared::domain_element_id;
use shared::icons::MakaIcon;
use shared::theme::{ActiveMakaPalette as _, selectable_row, tabular_nums};

use crate::git::{FileStatus, ReviewFile};
use crate::panel::ReviewPanel;

/// A row's height: 28 px at the default rem.
pub(crate) const ROW_REMS: f32 = 1.75;
/// How far each level of the tree steps in: an icon's slot and its gap.
const INDENT_REMS: f32 = 1.;

/// What a row stands for: a folder by its path (the identity of its fold),
/// or a file by its path as Git lists it.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) enum TreeKey {
    Folder(SharedString),
    File(SharedString),
}

/// One changed file, without its diff text.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct TreeFile {
    pub(crate) path: SharedString,
    pub(crate) name: SharedString,
    /// The folder it is in, empty at the repository's root.
    pub(crate) folder: SharedString,
    pub(crate) status: FileStatus,
    pub(crate) additions: u32,
    pub(crate) deletions: u32,
    /// Git counts no lines of it.
    pub(crate) binary: bool,
    /// An untracked file too large to read: its size, in place of counts.
    pub(crate) unread_size: Option<u64>,
}

impl TreeFile {
    fn new(file: &ReviewFile) -> Self {
        let (folder, name) = match file.path.rsplit_once('/') {
            Some((folder, name)) => (folder, name),
            None => ("", file.path.as_str()),
        };
        Self {
            path: file.path.clone().into(),
            name: name.to_owned().into(),
            folder: folder.to_owned().into(),
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            binary: file.binary,
            unread_size: file.unread_size,
        }
    }
}

/// A row of the tree: a folder (its compressed label) or a file.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum TreeNode {
    Folder {
        /// The folder's path: its key.
        path: SharedString,
        /// The folders it stands for, `a/b/c` for a compressed chain.
        label: SharedString,
        depth: usize,
        /// The folders above it, outermost first.
        ancestors: Rc<[SharedString]>,
    },
    File {
        file: TreeFile,
        depth: usize,
        ancestors: Rc<[SharedString]>,
    },
}

impl TreeNode {
    pub(crate) fn key(&self) -> TreeKey {
        match self {
            Self::Folder { path, .. } => TreeKey::Folder(path.clone()),
            Self::File { file, .. } => TreeKey::File(file.path.clone()),
        }
    }

    fn ancestors(&self) -> &[SharedString] {
        match self {
            Self::Folder { ancestors, .. } | Self::File { ancestors, .. } => ancestors,
        }
    }

    /// The folder this row is in, if any.
    pub(crate) fn parent(&self) -> Option<&SharedString> {
        self.ancestors().last()
    }
}

/// The tree of one read's files.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct FileTree {
    nodes: Vec<TreeNode>,
}

/// A folder while the tree is built.
#[derive(Default)]
struct Folder {
    folders: BTreeMap<String, Folder>,
    files: Vec<TreeFile>,
}

impl FileTree {
    pub(crate) fn new(files: &[ReviewFile]) -> Self {
        let mut root = Folder::default();
        for file in files {
            let file = TreeFile::new(file);
            let mut folder = &mut root;
            if !file.folder.is_empty() {
                for part in file.folder.split('/') {
                    folder = folder.folders.entry(part.to_owned()).or_default();
                }
            }
            folder.files.push(file);
        }
        let mut nodes = Vec::new();
        emit(&root, "", 0, &Rc::from([]), &mut nodes);
        Self { nodes }
    }

    /// Every row, folded or not, in order.
    #[cfg(test)]
    pub(crate) fn nodes(&self) -> &[TreeNode] {
        &self.nodes
    }

    /// The files in the tree's order: the diff's.
    pub(crate) fn files(&self) -> impl Iterator<Item = &TreeFile> {
        self.nodes.iter().filter_map(|node| match node {
            TreeNode::File { file, .. } => Some(file),
            TreeNode::Folder { .. } => None,
        })
    }

    /// The rows a reader sees with the folders in `folded` folded.
    pub(crate) fn visible(&self, folded: &HashSet<SharedString>) -> Vec<TreeNode> {
        self.nodes
            .iter()
            .filter(|node| !node.ancestors().iter().any(|folder| folded.contains(folder)))
            .cloned()
            .collect()
    }

    /// The folders `path`'s row is in.
    pub(crate) fn ancestors_of(&self, key: &TreeKey) -> &[SharedString] {
        self.nodes.iter().find(|node| &node.key() == key).map_or(&[], TreeNode::ancestors)
    }
}

/// Adds `folder`'s rows at `depth`: its folders first, each chain of lone
/// folders as one row, then its files, each by name.
fn emit(
    folder: &Folder,
    prefix: &str,
    depth: usize,
    ancestors: &Rc<[SharedString]>,
    nodes: &mut Vec<TreeNode>,
) {
    for (name, mut child) in &folder.folders {
        let mut label = name.clone();
        let mut path = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
        while child.files.is_empty() && child.folders.len() == 1 {
            let Some((name, only)) = child.folders.iter().next() else { break };
            label = format!("{label}/{name}");
            path = format!("{path}/{name}");
            child = only;
        }
        let path: SharedString = path.into();
        nodes.push(TreeNode::Folder {
            path: path.clone(),
            label: label.into(),
            depth,
            ancestors: ancestors.clone(),
        });
        let inner: Rc<[SharedString]> = ancestors.iter().cloned().chain([path.clone()]).collect();
        emit(child, &path, depth + 1, &inner, nodes);
    }
    let mut files: Vec<&TreeFile> = folder.files.iter().collect();
    files.sort_by(|left, right| left.name.cmp(&right.name));
    for file in files {
        nodes.push(TreeNode::File { file: file.clone(), depth, ancestors: ancestors.clone() });
    }
}

/// A status in words.
pub(crate) fn status_word(status: FileStatus) -> Text {
    match status {
        FileStatus::Added => copy::STATUS_ADDED,
        FileStatus::Modified => copy::STATUS_MODIFIED,
        FileStatus::Deleted => copy::STATUS_DELETED,
        FileStatus::Renamed => copy::STATUS_RENAMED,
        FileStatus::Copied => copy::STATUS_COPIED,
        FileStatus::Untracked => copy::STATUS_UNTRACKED,
        _ => copy::STATUS_CHANGED,
    }
}

/// What a file's row and header say of its size: its line counts, or the
/// size of an untracked file too large to read, muted, across both lanes.
pub(crate) fn file_counts(file: &TreeFile, cx: &App) -> AnyElement {
    match file.unread_size {
        Some(bytes) => div()
            .flex_none()
            .min_w(rems(4.75))
            .text_right()
            .text_xs()
            .font_features(tabular_nums())
            .text_color(cx.maka().ink_muted)
            .child(file_size(Locale::current(cx), bytes))
            .into_any_element(),
        None => line_counts(file.additions, file.deletions, cx).into_any_element(),
    }
}

/// A file's counts as a screen reader names them: its lines added and
/// deleted, its size when too large to read, "binary" for a file Git
/// counts no lines of.
pub(crate) fn counts_label(file: &TreeFile, locale: Locale) -> String {
    match file.unread_size {
        Some(bytes) => file_size(locale, bytes),
        None if file.binary => copy::BINARY.in_locale(locale).to_owned(),
        None => {
            let added = copy::added_lines(locale, file.additions as usize);
            let deleted = copy::deleted_lines(locale, file.deletions as usize);
            shared::copy::parts(locale, &[&added, &deleted])
        }
    }
}

/// A file's row as a screen reader names it: its status, its path, and
/// its counts.
pub(crate) fn file_label(file: &TreeFile, locale: Locale) -> String {
    let status = status_word(file.status).in_locale(locale);
    shared::copy::parts(locale, &[status, &file.path, &counts_label(file, locale)])
}

/// The lines a file adds and deletes, `+N` in the success ink and `−N` in
/// the destructive one, each in its own lane so the figures of every row
/// line up; a zero leaves its lane empty.
pub(crate) fn line_counts(additions: u32, deletions: u32, cx: &App) -> impl IntoElement {
    let maka = cx.maka();
    let lane = |text: Option<String>| {
        div()
            .min_w(rems(2.25))
            .flex_none()
            .text_right()
            .when_some(text, |this, text| this.child(text))
    };
    h_flex()
        .flex_none()
        .gap_1()
        .text_xs()
        .font_features(tabular_nums())
        .child(lane((additions > 0).then(|| format!("+{additions}"))).text_color(maka.success))
        .child(lane((deletions > 0).then(|| format!("−{deletions}"))).text_color(maka.destructive))
}

/// What each row needs from the panel, shared by every row of a frame.
pub(crate) struct RowContext {
    pub(crate) rows: Rc<[TreeNode]>,
    pub(crate) folded: Rc<HashSet<SharedString>>,
    /// The file in view.
    pub(crate) selected: Option<SharedString>,
    /// The row the keyboard is on, ringed while the tree has keyboard
    /// focus from the keyboard.
    pub(crate) cursor: Option<TreeKey>,
    pub(crate) keyboard: bool,
    pub(crate) focus: FocusHandle,
    pub(crate) panel: WeakEntity<ReviewPanel>,
}

impl RowContext {
    /// Row `ix`: a click selects its file, or folds or unfolds its folder;
    /// pressing it keeps focus on the tree, the one Tab stop, rather than
    /// the row.
    pub(crate) fn render(&self, ix: usize, window: &mut Window, cx: &mut App) -> AnyElement {
        let node = &self.rows[ix];
        let maka = cx.maka();
        let key = node.key();
        let ringed = self.keyboard && self.cursor.as_ref() == Some(&key);
        let focus = self.focus.clone();
        let panel = self.panel.clone();
        let row = h_flex()
            .w_full()
            .h(rems(ROW_REMS))
            .pr_2()
            .gap_1p5()
            .rounded(shared::theme::RADIUS_CONTROL)
            .when(ringed, |this| this.focus_ring_style(window, cx))
            .on_mouse_down(MouseButton::Left, move |_: &MouseDownEvent, window, cx| {
                window.prevent_default();
                focus.focus(window, cx);
            });
        let row = match node {
            TreeNode::Folder { path, label, depth, .. } => {
                let folded = self.folded.contains(path);
                let chevron = if folded { MakaIcon::ChevronRight } else { MakaIcon::ChevronDown };
                let path = path.clone();
                row.id(domain_element_id("review-folder", &path))
                    .test_support()
                    .role(Role::TreeItem)
                    .aria_label(label.clone())
                    .aria_expanded(!folded)
                    .pl(rems(0.5 + *depth as f32 * INDENT_REMS))
                    .hover(|this| this.bg(maka.selected.opacity(0.5)))
                    .on_click(move |_: &ClickEvent, _, cx| {
                        panel.update(cx, |panel, cx| panel.toggle_folder(&path, cx)).ok();
                    })
                    .child(Icon::new(chevron).size_4().flex_none().text_color(maka.ink_muted))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_sm()
                            .text_color(maka.ink)
                            .child(label.clone()),
                    )
            }
            TreeNode::File { file, depth, .. } => {
                let selected = self.selected.as_ref() == Some(&file.path);
                let label = file_label(file, Locale::current(cx));
                let path = file.path.clone();
                row.id(domain_element_id("review-file", &file.path))
                    .test_support()
                    .role(Role::TreeItem)
                    .aria_label(label)
                    .aria_selected(selected)
                    .pl(rems(0.5 + *depth as f32 * INDENT_REMS))
                    .map(|this| selectable_row(this, selected, cx))
                    .on_click(move |_: &ClickEvent, _, cx| {
                        panel.update(cx, |panel, cx| panel.select_file(path.clone(), cx)).ok();
                    })
                    .child(
                        Icon::new(AssetIcon::File).size_4().flex_none().text_color(maka.ink_muted),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_sm()
                            .text_color(maka.ink)
                            .when(selected, |this| this.font_medium())
                            .when(file.status == FileStatus::Deleted, |this| {
                                this.line_through().text_color(maka.ink_muted)
                            })
                            .child(file.name.clone()),
                    )
                    .child(file_counts(file, cx))
            }
        };
        row.into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::ReviewFile;

    fn file(path: &str) -> ReviewFile {
        ReviewFile::listed(path, FileStatus::Modified, 1, 0)
    }

    fn outline(nodes: &[TreeNode]) -> Vec<String> {
        nodes
            .iter()
            .map(|node| match node {
                TreeNode::Folder { label, depth, .. } => format!("{}{label}/", "  ".repeat(*depth)),
                TreeNode::File { file, depth, .. } => {
                    format!("{}{}", "  ".repeat(*depth), file.name)
                }
            })
            .collect()
    }

    /// Folders before files, each by name; a chain of folders holding one
    /// folder and no file is one row; folding a folder hides what is in it.
    #[test]
    fn the_tree_groups_compresses_and_folds_folders() {
        let files: Vec<ReviewFile> = [
            "README.md",
            "bi/common/src/main/java/Stats.java",
            "bi/common/src/main/java/Util.java",
            "bi/common/pom.xml",
            "app/a.rs",
            "Cargo.toml",
        ]
        .into_iter()
        .map(file)
        .collect();
        let tree = FileTree::new(&files);
        assert_eq!(
            outline(tree.nodes()),
            [
                "app/",
                "  a.rs",
                "bi/common/",
                "  src/main/java/",
                "    Stats.java",
                "    Util.java",
                "  pom.xml",
                "Cargo.toml",
                "README.md",
            ]
        );
        let order: Vec<&str> = tree.files().map(|file| file.path.as_ref()).collect();
        assert_eq!(order[..2], ["app/a.rs", "bi/common/src/main/java/Stats.java"]);

        let folded: HashSet<SharedString> = ["bi/common/src/main/java".into()].into();
        assert_eq!(
            outline(&tree.visible(&folded)),
            [
                "app/",
                "  a.rs",
                "bi/common/",
                "  src/main/java/",
                "  pom.xml",
                "Cargo.toml",
                "README.md"
            ]
        );
        let folded: HashSet<SharedString> = ["bi/common".into()].into();
        assert_eq!(
            outline(&tree.visible(&folded)),
            ["app/", "  a.rs", "bi/common/", "Cargo.toml", "README.md"]
        );
        assert_eq!(
            tree.ancestors_of(&TreeKey::File("bi/common/src/main/java/Util.java".into())),
            [SharedString::from("bi/common"), "bi/common/src/main/java".into()]
        );
    }
}
