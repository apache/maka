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

//! The changes panel in a window, on a fake Git runner, or on `git` in a
//! repository the test makes under `target/tmp`.

// The settle loop waits on the blocking pool (the read's file checks);
// setup writes files.
#![allow(clippy::disallowed_methods)]

use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use gpui_kit::component::Root;
use gpui_kit::component::diff::{DiffLinePosition, DiffMode, DiffSide};
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{
    AppContext as _, Bounds, Context, ElementId, Entity, IntoElement, ParentElement as _, Pixels,
    Render, Role, ScrollDelta, Styled as _, TestAppContext, Window, WindowHandle, div, point, px,
    size,
};
use shared::copy::review as copy;
use shared::domain_element_id;

use crate::git::{FailureReason, ReviewScope, SystemGit};
use crate::git_tests::{
    FakeGit, branch_answers, fake_repository, listed, modified, patch_command, run, scratch,
};
use crate::{ChangeTotals, ReviewPanel, ReviewPanelEvent, ReviewTarget};

struct Shell(Entity<ReviewPanel>);

impl Render for Shell {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size_full().child(self.0.clone())
    }
}

struct Harness {
    panel: Entity<ReviewPanel>,
    window: WindowHandle<Root>,
    git: Arc<FakeGit>,
    events: Rc<RefCell<Vec<ReviewPanelEvent>>>,
    root: PathBuf,
}

impl Harness {
    /// The panel alone in a window `width` by 800 px, on `git`, showing
    /// task `s1`'s changes.
    fn open(git: FakeGit, width: f32, cx: &mut TestAppContext) -> Self {
        cx.executor().allow_parking();
        cx.update(|cx| {
            gpui_kit::init(cx);
            crate::init(cx);
            cx.set_reduce_motion(true);
        });
        let git = Arc::new(git);
        let runner = git.clone();
        let mut panel = None;
        let window = cx.open_window(size(px(width), px(800.)), |window, cx| {
            let view = cx.new(|cx| ReviewPanel::new(runner, window, cx));
            panel = Some(view.clone());
            let shell = cx.new(|_| Shell(view));
            Root::new(shell, window, cx)
        });
        let panel = panel.expect("panel");
        let events = Rc::new(RefCell::new(Vec::new()));
        let recorded = events.clone();
        cx.update(|cx| {
            cx.subscribe(&panel, move |_, event: &ReviewPanelEvent, _| {
                recorded.borrow_mut().push(event.clone());
            })
            .detach();
        });
        let root = fake_repository(&format!("panel-{}", NEXT.fetch_add(1, SeqCst)));
        Self { panel, window, git, events, root }
    }

    /// The panel on `git` itself, showing the repository at `repo`.
    fn on_repository(repo: &std::path::Path, width: f32, cx: &mut TestAppContext) -> Self {
        let harness = Self::open(FakeGit::default(), width, cx);
        harness.panel.update(cx, |panel, _| panel.set_git_runner(Arc::new(SystemGit)));
        harness.show(ReviewTarget::local("s1", repo), None, cx);
        harness
    }

    /// Follows `target` with `base` and reads it.
    fn show(&self, target: ReviewTarget, base: Option<&str>, cx: &mut TestAppContext) {
        let base = base.map(str::to_owned);
        let panel = self.panel.clone();
        cx.update_window(self.window.into(), |_, window, cx| {
            panel.update(cx, |panel, cx| {
                panel.set_target(Some(target), base, window, cx);
                panel.refresh(window, cx);
            });
        })
        .expect("window");
        self.settle(cx);
    }

    /// Shows the fake repository's changes for task `s1`.
    fn show_changes(&self, cx: &mut TestAppContext) {
        self.show(ReviewTarget::local("s1", &self.root), None, cx);
    }

    /// Reads again.
    fn refresh(&self, cx: &mut TestAppContext) {
        let panel = self.panel.clone();
        cx.update_window(self.window.into(), |_, window, cx| {
            panel.update(cx, |panel, cx| panel.refresh(window, cx));
        })
        .expect("window");
        self.settle(cx);
    }

    /// Runs any read to its end (its file checks run on the blocking pool)
    /// and draws until the layout the panel measures has settled.
    fn settle(&self, cx: &mut TestAppContext) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            cx.run_until_parked();
            if !self.panel.read_with(cx, |panel, _| panel.is_loading()) || Instant::now() > deadline
            {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        for _ in 0..4 {
            self.with_window(cx, |_, _| {});
        }
    }

    fn with_window<R>(
        &self,
        cx: &mut TestAppContext,
        f: impl FnOnce(&mut Window, &mut gpui_kit::App) -> R,
    ) -> R {
        let result = cx
            .update_window(self.window.into(), |_, window, cx| {
                window.render_frame(cx);
                f(window, cx)
            })
            .expect("window");
        cx.run_until_parked();
        result
    }

    fn click(&self, id: impl Into<ElementId>, cx: &mut TestAppContext) {
        let id = id.into();
        self.with_window(cx, |window, cx| window.click(id, cx));
        self.settle(cx);
    }

    fn press(&self, key: &str, cx: &mut TestAppContext) {
        self.with_window(cx, |window, cx| window.press(key, cx));
        self.settle(cx);
    }

    fn resize(&self, width: f32, cx: &mut TestAppContext) {
        cx.simulate_window_resize(self.window.into(), size(px(width), px(800.)));
        self.settle(cx);
    }

    /// Chooses the "⋯" menu's item `key`.
    fn choose(&self, key: &str, cx: &mut TestAppContext) {
        self.click("review-more", cx);
        self.click(domain_element_id("menu-item", key), cx);
    }

    /// The failure line's words, if one shows.
    fn failure(&self, cx: &mut TestAppContext) -> Option<String> {
        let id = domain_element_id("settings-status", "review-failure");
        self.with_window(cx, |window, _| {
            window.try_find(id).and_then(|element| element.label().map(str::to_owned))
        })
    }

    fn exists(&self, id: impl Into<ElementId>, cx: &mut TestAppContext) -> bool {
        let id = id.into();
        self.with_window(cx, |window, _| window.try_find(id).is_some())
    }

    fn label(&self, id: impl Into<ElementId>, cx: &mut TestAppContext) -> Option<String> {
        let id = id.into();
        self.with_window(cx, |window, _| window.find(id).label().map(str::to_owned))
    }

    fn bounds(&self, id: impl Into<ElementId>, cx: &mut TestAppContext) -> Bounds<Pixels> {
        let id = id.into();
        self.with_window(cx, |window, _| window.find(id).bounds())
    }

    fn reason(&self, cx: &mut TestAppContext) -> Option<FailureReason> {
        self.panel.read_with(cx, |panel, _| match panel.result() {
            Some(Err(failure)) => Some(failure.reason),
            _ => None,
        })
    }

    fn selected(&self, cx: &mut TestAppContext) -> Option<String> {
        self.panel.read_with(cx, |panel, _| panel.selected_file().map(ToString::to_string))
    }

    /// The paths of the files the Diff holds, in order.
    fn diff_files(&self, cx: &mut TestAppContext) -> Vec<String> {
        self.panel.read_with(cx, |panel, cx| {
            panel.diff().read(cx).files().iter().map(|file| file.path().to_string()).collect()
        })
    }

    /// The files the tree lists, with their line counts, by their rows'
    /// accessible names ("Modified, a.txt, 2 lines added, 0 lines deleted").
    fn tree_rows(&self, cx: &mut TestAppContext) -> Vec<String> {
        self.with_window(cx, |window, _| {
            window
                .within("review-files")
                .find_all_by_role(Role::TreeItem)
                .into_iter()
                .filter_map(|row| row.label().map(str::to_owned))
                .collect()
        })
    }

    fn mode(&self, cx: &mut TestAppContext) -> DiffMode {
        self.panel.read_with(cx, |panel, cx| panel.mode(cx))
    }

    /// The text of the source lines the Diff draws.
    fn drawn_lines(&self, cx: &mut TestAppContext) -> Vec<String> {
        self.with_window(cx, |window, _| {
            window
                .find_all("source")
                .into_iter()
                .filter_map(|line| line.label().map(str::to_owned))
                .collect()
        })
    }

    /// Turns the wheel over the Diff `times` times, 100 px down each (up,
    /// for a negative count).
    fn scroll_diff(&self, times: isize, cx: &mut TestAppContext) {
        let step = if times < 0 { px(100.) } else { px(-100.) };
        for _ in 0..times.unsigned_abs() {
            self.with_window(cx, |window, cx| {
                window.scroll("diff-body", ScrollDelta::Pixels(point(px(0.), step)), cx);
            });
        }
        self.settle(cx);
    }

    /// How far below the diff's top the header of the file at `path` is.
    fn header_offset(&self, path: &str, cx: &mut TestAppContext) -> Option<Pixels> {
        let diff = self.bounds("review-diff", cx);
        let id = domain_element_id("review-file-header", path);
        self.with_window(cx, |window, _| window.try_find(id).map(|header| header.bounds().top()))
            .map(|top| top - diff.top())
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.root).ok();
    }
}

static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
use std::sync::atomic::Ordering::SeqCst;

/// A repository on `feature` against `origin/main` whose changes are
/// `files`: each a name status entry and its diff.
fn repository(files: &[(String, String)]) -> FakeGit {
    let git = FakeGit::default();
    branch_answers(&git);
    listed(&git, files);
    git
}

/// `count` modified files, `f000` on.
fn changed(count: usize) -> FakeGit {
    let files: Vec<(String, String)> =
        (0..count).map(|ix| modified(&format!("f{ix:03}"))).collect();
    repository(&files)
}

/// A new file `path` of `lines` lines, `line 1` on.
fn added(path: &str, lines: usize) -> (String, String) {
    let body: String = (1..=lines).map(|n| format!("+line {n}\n")).collect();
    (
        format!("A\0{path}\0"),
        format!(
            "diff --git a/{path} b/{path}\nnew file mode 100644\n--- /dev/null\n+++ b/{path}\n@@ -0,0 +1,{lines} @@\n{body}"
        ),
    )
}

/// A modified file `path` whose diff carries `context` unchanged lines on
/// each side of its one change, the old line `old` becoming `new`.
fn with_context(path: &str, context: usize) -> (String, String) {
    let before: String = (1..=context).map(|n| format!(" above {n}\n")).collect();
    let after: String = (1..=context).map(|n| format!(" below {n}\n")).collect();
    let lines = 2 * context + 1;
    (
        format!("M\0{path}\0"),
        format!(
            "diff --git a/{path} b/{path}\n--- a/{path}\n+++ b/{path}\n@@ -1,{lines} +1,{lines} @@\n{before}-old\n+new\n{after}"
        ),
    )
}

#[gpui_kit::test]
fn a_task_on_another_host_has_no_folder_here(cx: &mut TestAppContext) {
    let harness = Harness::open(FakeGit::default(), 520., cx);
    harness.show(ReviewTarget::remote("s1"), None, cx);
    assert_eq!(harness.reason(cx), Some(FailureReason::WorkspaceUnavailable));
    assert_eq!(harness.failure(cx).as_deref(), Some(copy::WORKSPACE_UNAVAILABLE.en()));
    assert!(harness.git.commands().is_empty(), "nothing is run for a Host elsewhere");
    assert_eq!(
        harness.events.borrow().last(),
        Some(&ReviewPanelEvent::ChangesRead { session_id: "s1".into(), totals: None }),
        "the strip learns there is nothing to count"
    );
}

#[gpui_kit::test]
fn a_folder_outside_a_repository_says_so(cx: &mut TestAppContext) {
    let harness = Harness::open(FakeGit::default(), 520., cx);
    let outside = std::env::temp_dir().join(format!("review-panel-outside-{}", std::process::id()));
    std::fs::create_dir_all(&outside).expect("folder");
    harness.show(ReviewTarget::local("s1", &outside), None, cx);
    assert_eq!(harness.failure(cx).as_deref(), Some(copy::NOT_GIT_REPOSITORY.en()));
    std::fs::remove_dir_all(&outside).ok();
}

/// A failed read says so, keeps the branches in the bar, and reads again
/// on Retry.
#[gpui_kit::test]
fn a_git_failure_offers_retry(cx: &mut TestAppContext) {
    let git = FakeGit::default();
    branch_answers(&git);
    git.fail("merge-base refs/remotes/origin/main HEAD", "fatal: no merge base");
    let harness = Harness::open(git, 520., cx);
    harness.show_changes(cx);
    assert_eq!(harness.failure(cx).as_deref(), Some(copy::GIT_FAILED.en()));
    assert!(harness.exists("review-branches", cx), "the picker stays");
    let runs = harness.git.commands().len();
    harness.click("review-retry", cx);
    assert!(harness.git.commands().len() > runs, "Retry reads again");
}

/// A remembered base branch that is gone is forgotten (the owner is told)
/// and the read made again against the resolved one.
#[gpui_kit::test]
fn a_gone_base_branch_is_dropped(cx: &mut TestAppContext) {
    let harness = Harness::open(changed(1), 520., cx);
    harness.show(ReviewTarget::local("s1", &harness.root), Some("refs/heads/gone"), cx);
    assert_eq!(
        harness.events.borrow().first(),
        Some(&ReviewPanelEvent::BaseBranchChanged { session_id: "s1".into(), base_branch: None })
    );
    let base = harness.panel.read_with(cx, |panel, _| match panel.result() {
        Some(Ok(snapshot)) => snapshot.base_branch.clone(),
        _ => None,
    });
    assert_eq!(base.as_deref(), Some("refs/remotes/origin/main"));
}

/// The bar: the tree's toggle, the base branch → the current branch and
/// the "⋯" menu; maximize and close are the workbar's strip's; no
/// Unified/Split segmented control.
#[gpui_kit::test]
fn the_bar_holds_the_branches_and_the_menu_and_no_segmented_control(cx: &mut TestAppContext) {
    let harness = Harness::open(changed(2), 1000., cx);
    harness.show_changes(cx);
    for id in ["review-tree-toggle", "review-base-branch", "review-more"] {
        assert!(harness.exists(id, cx), "{id}");
    }
    for id in ["review-maximize", "review-close", "review-layout", "review-unified", "review-split"]
    {
        assert!(!harness.exists(id, cx), "{id} is gone");
    }
    assert_eq!(harness.label("review-current-branch", cx).as_deref(), Some("feature"));
    let (base, current) =
        (harness.bounds("review-base-branch", cx), harness.bounds("review-current-branch", cx));
    assert!(base.right() <= current.left(), "base → current");
    assert_eq!(
        harness.events.borrow().last(),
        Some(&ReviewPanelEvent::ChangesRead {
            session_id: "s1".into(),
            totals: Some(ChangeTotals {
                current_branch: Some("feature".to_owned()),
                counted: true,
                files: 2,
                additions: 2,
                deletions: 2,
            }),
        }),
        "a read of All changes tells the owner what the strip shows"
    );
}

/// Every file the read finds is in the tree and, one after another, in
/// the one Diff; the first shows at once, and End in the tree reaches the
/// 45th, scrolling the diff to it. A read that changes nothing keeps the
/// selection.
#[gpui_kit::test]
fn every_changed_file_is_in_the_tree_and_the_continuous_diff(cx: &mut TestAppContext) {
    let harness = Harness::open(changed(45), 1000., cx);
    harness.show_changes(cx);
    assert_eq!(harness.panel.read_with(cx, |panel, _| panel.file_count()), 45);
    let files = harness.diff_files(cx);
    assert_eq!(files.len(), 45, "every file in one Diff");
    assert_eq!((files[0].as_str(), files[44].as_str()), ("f000", "f044"));
    assert_eq!(harness.selected(cx).as_deref(), Some("f000"), "the first file shows at once");
    assert!(!harness.exists(domain_element_id("review-file", "f044"), cx), "below the fold");

    harness.click(domain_element_id("review-file", "f000"), cx);
    harness.press("end", cx);
    assert_eq!(harness.selected(cx).as_deref(), Some("f044"));
    assert!(harness.exists(domain_element_id("review-file", "f044"), cx), "scrolled into view");
    assert!(harness.header_offset("f044", cx).is_some(), "the diff shows it");

    harness.click(domain_element_id("review-file", "f043"), cx);
    assert_eq!(harness.selected(cx).as_deref(), Some("f043"));
    harness.refresh(cx);
    assert_eq!(harness.selected(cx).as_deref(), Some("f043"), "kept across a read");
}

/// The tree groups the files by folder, compresses a chain of lone folders
/// into one row, and folds a folder by a click, ← and →.
#[gpui_kit::test]
fn the_tree_groups_compresses_and_folds_folders(cx: &mut TestAppContext) {
    let files: Vec<(String, String)> = ["src/main/java/A.java", "src/main/java/B.java", "top.rs"]
        .into_iter()
        .map(modified)
        .collect();
    let harness = Harness::open(repository(&files), 1000., cx);
    harness.show_changes(cx);
    let folder = domain_element_id("review-folder", "src/main/java");
    assert_eq!(harness.label(folder.clone(), cx).as_deref(), Some("src/main/java"), "one row");
    assert!(!harness.exists(domain_element_id("review-folder", "src"), cx));
    let a = domain_element_id("review-file", "src/main/java/A.java");
    let (row, file) = (harness.bounds(folder.clone(), cx), harness.bounds(a.clone(), cx));
    assert!(row.bottom() <= file.top(), "the folder over its files");
    assert_eq!(
        harness.diff_files(cx),
        ["src/main/java/A.java", "src/main/java/B.java", "top.rs"],
        "the diff in the tree's order"
    );

    harness.click(folder.clone(), cx);
    assert!(!harness.exists(a.clone(), cx), "folded");
    assert!(harness.panel.read_with(cx, |panel, _| panel.is_folder_folded("src/main/java")));
    harness.click(folder.clone(), cx);
    assert!(harness.exists(a.clone(), cx), "unfolded");

    harness.click(a.clone(), cx);
    harness.press("left", cx);
    harness.press("left", cx);
    assert!(!harness.exists(a.clone(), cx), "← goes up to the folder and folds it");
    harness.press("right", cx);
    assert!(harness.exists(a.clone(), cx), "→ unfolds it");
    harness.press("down", cx);
    harness.press("down", cx);
    assert_eq!(harness.selected(cx).as_deref(), Some("src/main/java/B.java"), "↓ through files");
}

/// Twelve files of forty lines: a click in the tree scrolls the diff to the
/// file's header; scrolling the diff moves the tree's highlight to the file
/// at its top, up and down.
#[gpui_kit::test]
fn the_tree_and_the_diff_follow_each_other(cx: &mut TestAppContext) {
    let files: Vec<(String, String)> = (0..12).map(|ix| added(&format!("f{ix:03}"), 40)).collect();
    let harness = Harness::open(repository(&files), 1000., cx);
    harness.show_changes(cx);
    assert_eq!(harness.selected(cx).as_deref(), Some("f000"));

    harness.click(domain_element_id("review-file", "f008"), cx);
    assert_eq!(harness.selected(cx).as_deref(), Some("f008"));
    let offset = harness.header_offset("f008", cx).expect("its header shows");
    assert!(offset >= px(0.) && offset < px(12.), "at the diff's top: {offset:?}");

    harness.scroll_diff(-3, cx);
    assert_eq!(harness.selected(cx).as_deref(), Some("f007"), "up into the file before");
    harness.scroll_diff(30, cx);
    let selected = harness.selected(cx).expect("a file");
    assert!(selected.as_str() > "f009", "down three files and more: {selected}");
    let row = domain_element_id("review-file", selected.as_str());
    assert_eq!(
        harness.with_window(cx, |window, _| window.find(row).selected()),
        Some(true),
        "its row is the selected one"
    );

    // The last file is short of a screen: chosen, it stays chosen though
    // the file before it fills the top.
    harness.click(domain_element_id("review-file", "f011"), cx);
    assert_eq!(harness.selected(cx).as_deref(), Some("f011"));
    harness.settle(cx);
    assert_eq!(harness.selected(cx).as_deref(), Some("f011"));
}

/// The narrow layout's tree above the diff, its toggle hiding the tree and
/// the commits in either layout.
#[gpui_kit::test]
fn the_toggle_hides_the_tree_and_the_commits(cx: &mut TestAppContext) {
    let harness = Harness::open(changed(45), 700., cx);
    harness.show_changes(cx);
    let (left, diff) = (harness.bounds("review-left", cx), harness.bounds("review-diff", cx));
    let area = harness.bounds("review-area", cx);
    assert!(left.bottom() <= diff.top(), "{left:?} above {diff:?}");
    assert!(left.size.height <= area.size.height * 0.4 + px(1.), "{left:?} in {area:?}");
    harness.click("review-tree-toggle", cx);
    assert!(!harness.exists("review-left", cx));
    let diff_box = harness.bounds("review-diff-box", cx);
    assert_eq!(diff_box.top(), area.top() + px(8.), "the diff's box takes its place");
    harness.click("review-tree-toggle", cx);
    assert!(harness.exists("review-scopes", cx));

    harness.resize(1000., cx);
    let (left, diff) = (harness.bounds("review-left", cx), harness.bounds("review-diff", cx));
    assert!(left.right() <= diff.left(), "beside it");
    assert_eq!(left.size.width, px(260.));
    harness.click("review-tree-toggle", cx);
    assert!(!harness.exists("review-left", cx));
}

/// `]` and `[` move between files in the tree's order, scrolling the diff;
/// `n` and `⇧N` between changes, here two far apart in one file.
#[gpui_kit::test]
fn keys_move_between_files_and_changes(cx: &mut TestAppContext) {
    let first: String = (1..=60).map(|n| format!("+first {n}\n")).collect();
    let far = "M\0far\0".to_owned();
    let far_diff = format!(
        "diff --git a/far b/far\n--- a/far\n+++ b/far\n@@ -1,0 +1,60 @@\n{first}@@ -400 +460 @@\n-old\n+second\n"
    );
    let mut files = vec![(far, far_diff)];
    files.extend((0..2).map(|ix| modified(&format!("f{ix:03}"))));
    let harness = Harness::open(repository(&files), 1000., cx);
    harness.show_changes(cx);
    assert_eq!(harness.selected(cx).as_deref(), Some("f000"), "the tree's order: by name");
    harness.click(domain_element_id("review-file", "far"), cx);
    let second = |harness: &Harness, cx: &mut TestAppContext| {
        harness.drawn_lines(cx).iter().any(|line| line == "second")
    };
    assert!(!second(&harness, cx), "the second change is below the fold");
    harness.press("n", cx);
    harness.press("n", cx);
    assert!(second(&harness, cx), "n scrolls to the next change");
    harness.press("shift-n", cx);
    assert!(!second(&harness, cx), "⇧N back to the one before");

    harness.click(domain_element_id("review-file", "f000"), cx);
    harness.press("]", cx);
    assert_eq!(harness.selected(cx).as_deref(), Some("f001"));
    harness.press("]", cx);
    assert_eq!(harness.selected(cx).as_deref(), Some("far"));
    harness.press("]", cx);
    assert_eq!(harness.selected(cx).as_deref(), Some("far"), "no file after the last");
    harness.press("[", cx);
    assert_eq!(harness.selected(cx).as_deref(), Some("f001"));
    assert!(harness.header_offset("f001", cx).is_some(), "the diff shows it");
    harness.press("up", cx);
    assert_eq!(harness.selected(cx).as_deref(), Some("f000"), "↑ in the tree");
}

/// A file's diff shows its first 3,000 lines; under the last a note says
/// how many more there are, and its Show all brings the rest.
#[gpui_kit::test]
fn a_long_diff_shows_three_thousand_lines_then_all(cx: &mut TestAppContext) {
    let harness = Harness::open(repository(&[added("big", 3500)]), 520., cx);
    harness.show_changes(cx);
    let additions = |cx: &mut TestAppContext| {
        harness.panel.read_with(cx, |panel, cx| panel.diff().read(cx).files()[0].additions())
    };
    // Five header lines and 2,995 of the 3,500 kept: 505 left out.
    assert_eq!(additions(cx), 2995);
    harness.panel.update(cx, |panel, cx| {
        panel.diff().update(cx, |diff, cx| {
            diff.scroll_to_line(DiffLinePosition::new("big", DiffSide::Modified, 2995), cx);
        })
    });
    harness.settle(cx);
    let note = domain_element_id("review-cut", "big");
    let label = harness.with_window(cx, |window, _| {
        window.try_find(note.clone()).and_then(|note| note.label().map(str::to_owned))
    });
    assert_eq!(label.as_deref(), Some("505 more lines not shown"));
    harness.click("review-show-all", cx);
    assert_eq!(additions(cx), 3500);
    assert!(!harness.exists(note, cx), "nothing left out");
    assert!(
        harness.drawn_lines(cx).iter().any(|line| line == "line 2995"),
        "the line last in view stays in view"
    );
}

/// The Diff scrolls to its end: after its files are first put in it, and
/// again after the panel changes width, when the kit's list has dropped
/// the heights of the rows it has not drawn (`crate::refit`).
#[gpui_kit::test]
fn the_diff_scrolls_to_its_end_after_its_width_changes(cx: &mut TestAppContext) {
    let harness = Harness::open(repository(&[added("long", 300)]), 520., cx);
    harness.show_changes(cx);
    assert!(harness.drawn_lines(cx).iter().any(|line| line == "line 1"), "from its top");
    harness.scroll_diff(120, cx);
    assert_eq!(harness.drawn_lines(cx).last().map(String::as_str), Some("line 300"));

    harness.resize(640., cx);
    harness.panel.update(cx, |panel, cx| {
        panel.diff().update(cx, |diff, cx| {
            diff.scroll_to_line(DiffLinePosition::new("long", DiffSide::Modified, 1), cx);
        })
    });
    harness.settle(cx);
    harness.resize(600., cx);
    harness.scroll_diff(120, cx);
    assert_eq!(harness.drawn_lines(cx).last().map(String::as_str), Some("line 300"));
}

/// The diff opens split where its column is at least 900 px wide and
/// unified where it is not, until the person picks one in the "⋯" menu,
/// which then holds.
#[gpui_kit::test]
fn a_wide_diff_column_opens_split_until_the_person_picks(cx: &mut TestAppContext) {
    let harness = Harness::open(changed(1), 1400., cx);
    harness.show_changes(cx);
    assert_eq!(harness.mode(cx), DiffMode::Split, "1,400 px leaves the diff over 900");
    harness.resize(1000., cx);
    assert_eq!(harness.mode(cx), DiffMode::Unified, "and 1,000 under it");
    harness.choose("split", cx);
    assert_eq!(harness.mode(cx), DiffMode::Split);
    harness.resize(900., cx);
    assert_eq!(harness.mode(cx), DiffMode::Split, "the pick holds");
    harness.choose("unified", cx);
    harness.resize(1400., cx);
    assert_eq!(harness.mode(cx), DiffMode::Unified);
}

/// The "⋯" menu switches the layout, and unfolds every run of unchanged
/// lines and folds them again.
#[gpui_kit::test]
fn the_menu_switches_the_layout_and_folds_unchanged_lines(cx: &mut TestAppContext) {
    let harness = Harness::open(repository(&[with_context("ctx", 20)]), 520., cx);
    harness.show_changes(cx);
    assert_eq!(harness.mode(cx), DiffMode::Unified);
    harness.choose("split", cx);
    assert_eq!(harness.mode(cx), DiffMode::Split);
    harness.choose("unified", cx);
    assert_eq!(harness.mode(cx), DiffMode::Unified);

    let drawn = |name: &str, cx: &mut TestAppContext| {
        harness.drawn_lines(cx).iter().any(|line| line == name)
    };
    assert!(drawn("above 18", cx), "three lines of context show");
    assert!(!drawn("above 10", cx), "the rest is folded");
    harness.choose("expand-all", cx);
    assert!(drawn("above 10", cx), "unfolded");
    harness.choose("collapse-all", cx);
    assert!(!drawn("above 10", cx), "folded again");
}

/// Esc asks the owner for the restore only while the panel is maximized.
#[gpui_kit::test]
fn esc_asks_the_owner_to_restore_a_maximized_panel(cx: &mut TestAppContext) {
    let harness = Harness::open(changed(2), 520., cx);
    harness.show_changes(cx);
    harness.panel.update(cx, |panel, cx| panel.set_maximized(true, cx));
    harness.click(domain_element_id("review-file", "f000"), cx);
    harness.press("escape", cx);
    assert_eq!(harness.events.borrow().last(), Some(&ReviewPanelEvent::MaximizeRequested(false)));

    harness.panel.update(cx, |panel, cx| panel.set_maximized(false, cx));
    let before = harness.events.borrow().len();
    harness.press("escape", cx);
    assert_eq!(harness.events.borrow().len(), before, "not maximized: Esc is not the panel's");
}

/// A real branch two commits past `main`, with an uncommitted edit and an
/// untracked file.
fn branch_repository(name: &str) -> PathBuf {
    let repo = scratch(name);
    run(&repo, &["init", "-q", "-b", "main"]);
    std::fs::write(repo.join("a.txt"), "one\n").expect("write");
    run(&repo, &["add", "."]);
    run(&repo, &["commit", "-q", "-m", "start"]);
    run(&repo, &["checkout", "-q", "-b", "feature"]);
    std::fs::write(repo.join("a.txt"), "one\ntwo\n").expect("write");
    run(&repo, &["commit", "-q", "-am", "Add a second line"]);
    std::fs::create_dir_all(repo.join("src/deep")).expect("folder");
    std::fs::write(repo.join("src/deep/b.txt"), "b\nb\n").expect("write");
    run(&repo, &["add", "."]);
    run(&repo, &["commit", "-q", "-m", "Add b"]);
    std::fs::write(repo.join("a.txt"), "one\ntwo\nthree\n").expect("write");
    std::fs::write(repo.join("new.txt"), "fresh\n").expect("write");
    repo
}

/// The commits section lists All changes, Uncommitted changes and the
/// branch's commits; each shows its own files and counts in the tree and
/// the diff.
#[gpui_kit::test]
fn the_scopes_show_all_uncommitted_and_each_commit(cx: &mut TestAppContext) {
    let repo = branch_repository("panel-scopes");
    let harness = Harness::on_repository(&repo, 1000., cx);
    assert_eq!(harness.label("review-commits-heading", cx).as_deref(), Some("Commits 2"));
    assert_eq!(harness.label("review-current-branch", cx).as_deref(), Some("feature"));
    let all = domain_element_id("review-scope", "all");
    assert_eq!(harness.with_window(cx, |window, _| window.find(all).selected()), Some(true));
    assert_eq!(
        harness.tree_rows(cx),
        [
            "src/deep",
            "Added, src/deep/b.txt, 2 lines added, 0 lines deleted",
            "Modified, a.txt, 2 lines added, 0 lines deleted",
            "Untracked, new.txt, 1 line added, 0 lines deleted",
        ]
    );
    assert_eq!(harness.diff_files(cx), ["src/deep/b.txt", "a.txt", "new.txt"]);

    harness.click(domain_element_id("review-scope", "uncommitted"), cx);
    assert_eq!(
        harness.panel.read_with(cx, |panel, _| panel.scope().clone()),
        ReviewScope::Uncommitted
    );
    assert_eq!(
        harness.tree_rows(cx),
        [
            "Modified, a.txt, 1 line added, 0 lines deleted",
            "Untracked, new.txt, 1 line added, 0 lines deleted",
        ]
    );

    let commits = harness.panel.read_with(cx, |panel, _| match panel.result() {
        Some(Ok(snapshot)) => snapshot.commits.clone(),
        _ => Vec::new(),
    });
    let subjects: Vec<&str> = commits.iter().map(|commit| commit.subject.as_str()).collect();
    assert_eq!(subjects, ["Add b", "Add a second line"]);
    let label = harness.label(domain_element_id("review-commit", &commits[0].sha), cx);
    let label = label.expect("a label");
    assert!(label.starts_with("Add b, ") && label.contains(&commits[0].short_sha), "{label}");
    harness.press("down", cx);
    assert_eq!(
        harness.panel.read_with(cx, |panel, _| panel.scope().clone()),
        ReviewScope::Commit(commits[0].sha.clone()),
        "↓ in the list shows the next one"
    );
    assert_eq!(
        harness.tree_rows(cx),
        ["src/deep", "Added, src/deep/b.txt, 2 lines added, 0 lines deleted"]
    );
    harness.click(domain_element_id("review-commit", &commits[1].sha), cx);
    assert_eq!(harness.tree_rows(cx), ["Modified, a.txt, 1 line added, 0 lines deleted"]);
    assert_eq!(harness.diff_files(cx), ["a.txt"]);

    harness.click(domain_element_id("review-scope", "all"), cx);
    assert_eq!(harness.diff_files(cx).len(), 3, "back to all of them");
    std::fs::remove_dir_all(&repo).ok();
}

/// A change in the middle of a long file: its diff carries twenty lines
/// around it, and "Show more lines" under its last line (past the folded
/// run of those lines, once unfolded) reads the file's whole text, which
/// the Diff folds for the reader to unfold.
#[gpui_kit::test]
fn show_more_lines_reads_the_whole_file(cx: &mut TestAppContext) {
    let repo = scratch("panel-more");
    run(&repo, &["init", "-q", "-b", "main"]);
    let lines: Vec<String> = (1..=80).map(|n| format!("line {n}")).collect();
    std::fs::write(repo.join("long.txt"), lines.join("\n") + "\n").expect("write");
    run(&repo, &["add", "."]);
    run(&repo, &["commit", "-q", "-m", "start"]);
    let mut changed = lines.clone();
    changed[39] = "line forty".to_owned();
    std::fs::write(repo.join("long.txt"), changed.join("\n") + "\n").expect("write");
    let harness = Harness::on_repository(&repo, 520., cx);
    let first = DiffLinePosition::new("long.txt", DiffSide::Modified, 1);
    let reveal = |harness: &Harness, cx: &mut TestAppContext| {
        harness.panel.update(cx, |panel, cx| {
            panel.diff().update(cx, |diff, cx| diff.scroll_to_line(first.clone(), cx));
        });
        harness.settle(cx);
        harness.drawn_lines(cx).iter().any(|line| line == "line 1")
    };
    assert!(!reveal(&harness, cx), "line 1 is not in the diff");
    harness.choose("expand-all", cx);
    harness.scroll_diff(30, cx);
    let more = domain_element_id("review-show-more", "long.txt");
    assert!(harness.exists(more.clone(), cx), "at the file's end");
    harness.click(more.clone(), cx);
    harness.settle(cx);
    assert!(!harness.exists(more, cx), "the whole file is there");
    assert!(reveal(&harness, cx), "line 1 unfolds");
    std::fs::remove_dir_all(&repo).ok();
}

/// The strip's summary: a Host elsewhere has nothing to count; the panel's
/// read of the same task stands in for the summary's own, another task's
/// does not; without Git it reads nothing.
#[gpui_kit::test]
fn the_summary_counts_the_task_it_follows(cx: &mut TestAppContext) {
    let summary = cx.new(|_| crate::ChangeSummary::new());
    let counted = ChangeTotals {
        current_branch: Some("feature".to_owned()),
        counted: true,
        files: 1,
        additions: 3,
        deletions: 1,
    };
    summary.update(cx, |summary, cx| {
        summary.set_target(Some(ReviewTarget::local("s1", "/nowhere")), None, cx);
        summary.refresh(cx);
        assert!(!summary.is_loading(), "no Git, no read");
        summary.accept(&"s2".into(), Some(counted.clone()), cx);
        assert_eq!(summary.totals(), None, "another task's counts");
        summary.accept(&"s1".into(), Some(counted.clone()), cx);
        assert_eq!(summary.totals(), Some(&counted));
        assert!(counted.has_changes());

        summary.set_git_runner(Arc::new(changed(1)));
        summary.set_target(Some(ReviewTarget::remote("s1")), None, cx);
        summary.accept(&"s1".into(), Some(counted.clone()), cx);
        summary.refresh(cx);
        assert_eq!(summary.totals(), None, "a Host elsewhere: nothing to count");
        assert!(!summary.is_loading());
    });
}

/// A remembered base branch that is gone: the summary counts against the
/// resolved one rather than show no counts until the panel next reads.
#[gpui_kit::test]
fn the_summary_drops_a_gone_base_branch(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let root = fake_repository(&format!("summary-{}", NEXT.fetch_add(1, SeqCst)));
    let summary = cx.new(|_| crate::ChangeSummary::new());
    summary.update(cx, |summary, cx| {
        summary.set_git_runner(Arc::new(changed(2)));
        let target = ReviewTarget::local("s1", &root);
        summary.set_target(Some(target), Some("refs/heads/gone".to_owned()), cx);
        summary.refresh(cx);
    });
    let deadline = Instant::now() + Duration::from_secs(10);
    while summary.read_with(cx, |summary, _| summary.is_loading()) && Instant::now() < deadline {
        cx.run_until_parked();
        std::thread::sleep(Duration::from_millis(5));
    }
    let totals = summary.read_with(cx, |summary, _| summary.totals().cloned()).expect("totals");
    assert_eq!((totals.files, totals.additions, totals.deletions), (2, 2, 2));
    assert_eq!(totals.current_branch.as_deref(), Some("feature"));
    std::fs::remove_dir_all(&root).ok();
}

/// A real branch past `main` that changes `count` files in nine folders,
/// `dir0/f000.txt` on: each file's first line changed and a line added.
fn many_files_repository(name: &str, count: usize) -> PathBuf {
    let repo = scratch(name);
    run(&repo, &["init", "-q", "-b", "main"]);
    let path = |ix: usize| format!("dir{}/f{ix:03}.txt", ix / 50);
    for ix in 0..count {
        let file = repo.join(path(ix));
        std::fs::create_dir_all(file.parent().expect("a folder")).expect("folder");
        std::fs::write(file, format!("line 1 of {ix}\nline 2\n")).expect("write");
    }
    run(&repo, &["add", "."]);
    run(&repo, &["commit", "-q", "-m", "start"]);
    run(&repo, &["checkout", "-q", "-b", "feature"]);
    for ix in 0..count {
        std::fs::write(repo.join(path(ix)), format!("changed {ix}\nline 2\nline 3\n"))
            .expect("write");
    }
    run(&repo, &["commit", "-q", "-am", "Change every file"]);
    repo
}

/// Records the commands of the system's `git`.
#[derive(Default)]
struct Recording(std::sync::Mutex<Vec<String>>);

impl crate::git::GitRunner for Recording {
    fn run(
        &self,
        root: &std::path::Path,
        args: &[String],
    ) -> futures_lite::future::Boxed<Result<crate::git::GitOutput, crate::git::GitError>> {
        self.0.lock().expect("commands").push(args.join(" "));
        SystemGit.run(root, args)
    }
}

/// The reading notice's words, if it shows.
fn reading_notice(harness: &Harness, cx: &mut TestAppContext) -> Option<String> {
    let id = domain_element_id("settings-status", "review-reading");
    harness.with_window(cx, |window, _| {
        window.try_find(id).and_then(|element| element.label().map(str::to_owned))
    })
}

/// A scope of 450 files lists every one with Git's totals and no notice,
/// and the 450th file's diff is reached from the tree; a read that changes
/// nothing keeps the Diff where it was. The context strip counts the same
/// totals with `--numstat` alone: no patch is read for it.
#[gpui_kit::test]
fn four_hundred_and_fifty_files_all_show_and_the_strip_counts_them(cx: &mut TestAppContext) {
    let repo = many_files_repository("panel-450", 450);
    let harness = Harness::on_repository(&repo, 1000., cx);
    assert_eq!(harness.panel.read_with(cx, |panel, _| panel.file_count()), 450);
    assert_eq!(harness.diff_files(cx).len(), 450, "every file in the Diff");
    assert_eq!(reading_notice(&harness, cx), None, "the patches are read");
    assert!(harness.failure(cx).is_none());
    let truncated = domain_element_id("settings-status", "review-truncated");
    assert!(!harness.exists(truncated, cx), "no notice of files left out");
    let totals = harness.panel.read_with(cx, |panel, _| match panel.result() {
        Some(Ok(snapshot)) => (snapshot.files.len(), snapshot.additions, snapshot.deletions),
        _ => (0, 0, 0),
    });
    assert_eq!(totals, (450, 900, 450));
    let last = "dir8/f449.txt";
    let row = domain_element_id("review-file", last);
    assert!(!harness.exists(row.clone(), cx), "below the tree's fold");
    harness.click(domain_element_id("review-file", "dir0/f000.txt"), cx);
    harness.press("end", cx);
    assert_eq!(harness.selected(cx).as_deref(), Some(last));
    harness.click(row.clone(), cx);
    assert_eq!(harness.selected(cx).as_deref(), Some(last));
    let offset = harness.header_offset(last, cx).expect("the diff shows the 450th file");
    assert_eq!(
        harness.label(domain_element_id("review-header-counts", last), cx).as_deref(),
        Some("2 lines added, 1 line deleted")
    );
    harness.refresh(cx);
    assert_eq!(harness.header_offset(last, cx), Some(offset), "a read changing nothing");

    let recording = Arc::new(Recording::default());
    let summary = cx.new(|_| crate::ChangeSummary::new());
    summary.update(cx, |summary, cx| {
        summary.set_git_runner(recording.clone());
        summary.set_target(Some(ReviewTarget::local("s1", &repo)), None, cx);
        summary.refresh(cx);
    });
    let deadline = Instant::now() + Duration::from_secs(20);
    while summary.read_with(cx, |summary, _| summary.is_loading()) && Instant::now() < deadline {
        cx.run_until_parked();
        std::thread::sleep(Duration::from_millis(5));
    }
    let counted = summary.read_with(cx, |summary, _| summary.totals().cloned()).expect("totals");
    assert_eq!((counted.files, counted.additions, counted.deletions), totals);
    let commands = recording.0.lock().expect("commands").clone();
    assert!(commands.iter().any(|command| command.starts_with("diff --numstat")));
    assert!(
        commands.iter().all(|command| !command.contains("--unified")),
        "no patch is read for the strip: {commands:?}"
    );
    std::fs::remove_dir_all(&repo).ok();
}

/// A file whose patch alone passes the cap shows its header, its counts
/// and a notice in place of its lines, folded; the files beside it show.
#[gpui_kit::test]
fn a_file_too_large_shows_its_header_counts_and_a_notice(cx: &mut TestAppContext) {
    let files: Vec<(String, String)> = ["a", "big", "c"].into_iter().map(modified).collect();
    let git = repository(&files);
    let cut = || Ok(crate::git::GitOutput::truncated(modified("big").1));
    git.reply(&patch_command(&["a", "big", "c"]), cut())
        .reply(&patch_command(&["big", "c"]), cut())
        .reply(&patch_command(&["big"]), cut());
    let harness = Harness::open(git, 1000., cx);
    harness.show_changes(cx);
    assert_eq!(harness.diff_files(cx), ["a", "big", "c"]);
    assert!(harness.header_offset("big", cx).is_some(), "its header");
    assert_eq!(
        harness.label(domain_element_id("review-header-counts", "big"), cx).as_deref(),
        Some("1 line added, 1 line deleted"),
        "its counts, from Git's listing"
    );
    let note = domain_element_id("review-too-large-note", "big");
    assert_eq!(harness.label(note, cx).as_deref(), Some(copy::TOO_LARGE.en()));
    let collapsed = |path: &str, cx: &mut TestAppContext| {
        harness.panel.read_with(cx, |panel, cx| panel.diff().read(cx).is_file_collapsed(path))
    };
    assert!(collapsed("big", cx) && !collapsed("a", cx));
    harness.click(domain_element_id("review-file", "c"), cx);
    assert!(harness.drawn_lines(cx).iter().any(|line| line == "b"), "the others show");
    assert!(harness.failure(cx).is_none(), "the review stands");
}

/// A file too large to show has no lines to unfold: its header's chevron
/// leaves it folded, the notice under it.
#[gpui_kit::test]
fn a_file_too_large_stays_folded(cx: &mut TestAppContext) {
    let git = repository(&[modified("big")]);
    git.reply(&patch_command(&["big"]), Ok(crate::git::GitOutput::truncated(modified("big").1)));
    let harness = Harness::open(git, 1000., cx);
    harness.show_changes(cx);
    let collapsed = |cx: &mut TestAppContext| {
        harness.panel.read_with(cx, |panel, cx| panel.diff().read(cx).is_file_collapsed("big"))
    };
    assert!(collapsed(cx));
    harness.click("collapse-file", cx);
    assert!(collapsed(cx), "still folded");
    assert!(harness.exists(domain_element_id("review-too-large-note", "big"), cx));
}

/// An untracked file past the limit shows its header with its size and
/// the notice; a binary file shows as one, its bytes in no patch.
#[gpui_kit::test]
fn large_untracked_and_binary_files_show_as_such(cx: &mut TestAppContext) {
    let repo = scratch("panel-large-binary");
    run(&repo, &["init", "-q", "-b", "main"]);
    std::fs::write(repo.join("logo.png"), [0u8, 1, 2, 3, 4]).expect("write");
    std::fs::write(repo.join("a.txt"), "a\n").expect("write");
    run(&repo, &["add", "."]);
    run(&repo, &["commit", "-q", "-m", "start"]);
    std::fs::write(repo.join("logo.png"), [0u8, 9, 8, 7]).expect("write");
    std::fs::write(repo.join("a.txt"), "a\nb\n").expect("write");
    let size = crate::git::FILE_MAX_PATCH_BYTES as u64 + 1;
    std::fs::File::create(repo.join("dump.log")).and_then(|file| file.set_len(size)).expect("dump");
    let harness = Harness::on_repository(&repo, 1000., cx);
    assert_eq!(harness.diff_files(cx), ["a.txt", "dump.log", "logo.png"]);
    let size_text = shared::copy::conversation::file_size(shared::copy::Locale::English, size);
    assert_eq!(
        harness.label(domain_element_id("review-header-counts", "dump.log"), cx),
        Some(size_text.clone()),
        "its size in place of counts"
    );
    let note = domain_element_id("review-too-large-note", "dump.log");
    assert_eq!(harness.label(note, cx).as_deref(), Some(copy::TOO_LARGE.en()));
    assert!(harness.tree_rows(cx).contains(&format!("Untracked, dump.log, {size_text}")));

    let logo = harness.panel.read_with(cx, |panel, cx| {
        let diff = panel.diff().read(cx);
        diff.files().iter().find(|file| file.path() == "logo.png").map(|file| file.is_binary())
    });
    assert_eq!(logo, Some(true), "the Diff shows a binary file");
    assert!(harness.tree_rows(cx).contains(&"Modified, logo.png, Binary".to_owned()));
    std::fs::remove_dir_all(&repo).ok();
}

/// Holds the patch commands of a fake Git until opened.
struct Gated {
    git: Arc<FakeGit>,
    open: Arc<std::sync::atomic::AtomicBool>,
}

impl crate::git::GitRunner for Gated {
    fn run(
        &self,
        root: &std::path::Path,
        args: &[String],
    ) -> futures_lite::future::Boxed<Result<crate::git::GitOutput, crate::git::GitError>> {
        use futures_lite::FutureExt as _;
        let answer = self.git.run(root, args);
        let held = args.iter().any(|arg| arg == "--unified=20");
        let open = self.open.clone();
        async move {
            while held && !open.load(SeqCst) {
                async_io::Timer::after(Duration::from_millis(5)).await;
            }
            answer.await
        }
        .boxed()
    }
}

/// The tree and the totals show as soon as the files are listed, the panel
/// saying it reads their patches; the notice goes once the Diff has them.
#[gpui_kit::test]
fn the_reading_notice_shows_while_patches_are_read(cx: &mut TestAppContext) {
    let harness = Harness::open(FakeGit::default(), 1000., cx);
    let open = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let gated = Gated { git: Arc::new(changed(3)), open: open.clone() };
    harness.panel.update(cx, |panel, _| panel.set_git_runner(Arc::new(gated)));
    let panel = harness.panel.clone();
    let target = ReviewTarget::local("s1", &harness.root);
    cx.update_window(harness.window.into(), |_, window, cx| {
        panel.update(cx, |panel, cx| {
            panel.set_target(Some(target), None, window, cx);
            panel.refresh(window, cx);
        });
    })
    .expect("window");
    let deadline = Instant::now() + Duration::from_secs(10);
    while harness.panel.read_with(cx, |panel, _| panel.file_count()) == 0 {
        assert!(Instant::now() < deadline, "the files are listed");
        cx.run_until_parked();
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(reading_notice(&harness, cx).as_deref(), Some("Reading changes 0/3"));
    assert_eq!(harness.tree_rows(cx).len(), 3, "the tree at once");
    assert!(harness.diff_files(cx).is_empty(), "the Diff waits for the patches");
    assert!(
        harness.events.borrow().iter().any(|event| matches!(
            event,
            ReviewPanelEvent::ChangesRead { totals: Some(totals), .. } if totals.files == 3
        )),
        "the totals at once"
    );
    open.store(true, SeqCst);
    harness.settle(cx);
    assert_eq!(reading_notice(&harness, cx), None);
    assert_eq!(harness.diff_files(cx).len(), 3);
}

/// With 1,200 files the keys, the tree and the diff keep to each other.
#[gpui_kit::test]
fn twelve_hundred_files_keep_keys_and_sync(cx: &mut TestAppContext) {
    let files: Vec<(String, String)> = (0..1200).map(|ix| added(&format!("f{ix:04}"), 6)).collect();
    let harness = Harness::open(repository(&files), 1000., cx);
    harness.show_changes(cx);
    assert_eq!(harness.diff_files(cx).len(), 1200);
    assert_eq!(harness.git.patch_commands().len(), 5, "batches of 256");
    harness.click(domain_element_id("review-file", "f0000"), cx);
    harness.press("end", cx);
    assert_eq!(harness.selected(cx).as_deref(), Some("f1199"));
    harness.press("[", cx);
    harness.press("[", cx);
    assert_eq!(harness.selected(cx).as_deref(), Some("f1197"));
    assert!(harness.header_offset("f1197", cx).is_some(), "the diff shows it");
    harness.panel.update(cx, |panel, cx| panel.select_file("f0600", cx));
    harness.settle(cx);
    let offset = harness.header_offset("f0600", cx).expect("its header shows");
    assert!(offset >= px(0.) && offset < px(12.), "at the diff's top: {offset:?}");
    harness.scroll_diff(-3, cx);
    let selected = harness.selected(cx).expect("a file");
    assert!(selected.as_str() < "f0600", "the tree follows the diff up: {selected}");
    let row = domain_element_id("review-file", selected.as_str());
    assert_eq!(harness.with_window(cx, |window, _| window.find(row).selected()), Some(true));
}

/// 250 commits are all listed, in a list that draws only the rows in
/// view: ↓ walks the scopes into the commits, and the last is reached by
/// scrolling the list.
#[gpui_kit::test]
fn two_hundred_and_fifty_commits_are_all_listed(cx: &mut TestAppContext) {
    let git = changed(1);
    let sha = |n: usize| format!("{n:040x}");
    let log: String = (0..250)
        .map(|n| format!("{}\u{1f}{n:07x}\u{1f}Ann\u{1f}1700000000\u{1f}Commit {n}\0", sha(n)))
        .collect();
    let newest = format!("{0}^ {0}", sha(0));
    git.answer(crate::git_tests::LOG, &log)
        .answer("diff --name-status -z --find-renames HEAD", "")
        .answer("diff --numstat -z --find-renames HEAD", "")
        .answer(&format!("diff --name-status -z --find-renames {newest}"), "")
        .answer(&format!("diff --numstat -z --find-renames {newest}"), "");
    let harness = Harness::open(git, 1000., cx);
    harness.show_changes(cx);
    assert_eq!(harness.label("review-commits-heading", cx).as_deref(), Some("Commits 250"));
    let scope =
        |cx: &mut TestAppContext| harness.panel.read_with(cx, |panel, _| panel.scope().clone());
    let drawn = |cx: &mut TestAppContext| {
        harness.with_window(cx, |window, _| {
            window.within("review-scopes").find_all_by_role(Role::ListItem).len()
        })
    };
    assert!(drawn(cx) < 40, "only the rows in view: {}", drawn(cx));

    harness.click(domain_element_id("review-scope", "all"), cx);
    harness.press("down", cx);
    assert_eq!(scope(cx), ReviewScope::Uncommitted, "↓ in the list");
    harness.press("down", cx);
    assert_eq!(scope(cx), ReviewScope::Commit(sha(0)), "into the commits");
    assert_eq!(harness.label("review-commits-heading", cx).as_deref(), Some("Commits 250"));

    let last = domain_element_id("review-commit", &sha(249));
    assert!(!harness.exists(last.clone(), cx));
    for _ in 0..150 {
        harness.with_window(cx, |window, cx| {
            let delta = ScrollDelta::Pixels(point(px(0.), px(-100.)));
            window.scroll("review-scopes", delta, cx);
        });
    }
    harness.settle(cx);
    let label = harness.with_window(cx, |window, _| {
        window.try_find(last.clone()).and_then(|row| row.label().map(str::to_owned))
    });
    assert!(label.is_some_and(|label| label.starts_with("Commit 249")), "the 250th commit");
    assert!(drawn(cx) < 40, "still only the rows in view");
}

impl Harness {
    /// Hands the panel's turn changes the edits of a transcript of `rows`,
    /// as the window does when the transcript moves on, and works them out.
    fn feed(&self, rows: &[serde_json::Value], cx: &mut TestAppContext) {
        let transcript = crate::turns_tests::transcript(rows);
        let key = transcript_model::edits::EditsKey::of(&transcript);
        let edits = transcript_model::edits::session_edits(&transcript);
        let turns = self.panel.read_with(cx, |panel, _| panel.turn_changes().clone());
        turns.update(cx, |turns, cx| turns.set_edits(key, edits, cx));
        self.settle(cx);
    }

    fn shown_turn(&self, cx: &mut TestAppContext) -> Option<String> {
        self.panel.read_with(cx, |panel, _| panel.shown_turn().map(ToString::to_string))
    }

    /// The scopes list's choosable rows, by their accessible names, in
    /// order.
    fn scope_rows(&self, cx: &mut TestAppContext) -> Vec<String> {
        self.with_window(cx, |window, _| {
            window
                .within("review-scopes")
                .find_all_by_role(Role::ListItem)
                .into_iter()
                .filter_map(|row| row.label().map(str::to_owned))
                .collect()
        })
    }
}

/// In a folder that is no repository, the panel lists the task's turns that
/// edited files instead of saying so, shows the newest one's files in the
/// tree and their net diffs, and names the turn in its bar.
#[gpui_kit::test]
fn a_folder_outside_a_repository_shows_its_turns(cx: &mut TestAppContext) {
    use crate::turns_tests::{Folder, first_turn};
    let folder = Folder::outside("panel-turns");
    let rows = first_turn(&folder);
    let harness = Harness::open(FakeGit::default(), 1000., cx);
    harness.show(ReviewTarget::local("s1", &folder.0), None, cx);
    assert_eq!(harness.failure(cx).as_deref(), Some(copy::NOT_GIT_REPOSITORY.en()), "no turns yet");

    harness.feed(&rows, cx);
    assert_eq!(harness.failure(cx), None);
    assert_eq!(harness.shown_turn(cx).as_deref(), Some("t1"));
    assert_eq!(harness.label("review-turn-label", cx).as_deref(), Some("Build the report"));
    assert!(!harness.exists("review-commits-heading", cx), "no Git scopes");
    assert!(!harness.exists(domain_element_id("review-scope", "all"), cx));
    assert_eq!(harness.label("review-turns-heading", cx).as_deref(), Some("Edits by turn 1"));
    let rows = harness.scope_rows(cx);
    let [turn] = rows.as_slice() else { panic!("one turn: {rows:?}") };
    assert!(
        turn.starts_with("Build the report, 4 files, 6 lines added, 3 lines deleted, "),
        "{turn}"
    );
    assert_eq!(
        harness.with_window(cx, |window, _| {
            window.find(domain_element_id("review-turn", "t1")).selected()
        }),
        Some(true)
    );
    assert_eq!(
        harness.tree_rows(cx),
        [
            "Modified, data.txt, 1 line added, 1 line deleted",
            "Added, notes.md, 3 lines added, 0 lines deleted",
            "Deleted, old.txt",
            "Modified, report.py, 2 lines added, 2 lines deleted",
        ]
    );
    assert_eq!(harness.diff_files(cx), ["data.txt", "notes.md", "old.txt", "report.py"]);
    let report = harness.panel.read_with(cx, |panel, cx| {
        let diff = panel.diff().read(cx);
        let file = diff.files().iter().find(|file| file.path().as_ref() == "report.py").cloned();
        file.map(|file| (file.additions(), file.deletions()))
    });
    assert_eq!(report, Some((2, 2)), "the two Edits are one net diff");
    assert!(!harness.exists(domain_element_id("review-step-mark", "report.py"), cx));
}

/// A turn that edited a file itself and then through a code cell: its scope
/// shows both, the cell's created file and `report.py`'s two edits, one by
/// the model and one by the cell, as one net diff.
#[gpui_kit::test]
fn a_turns_scope_shows_its_own_and_its_code_cells_edits(cx: &mut TestAppContext) {
    use crate::turns_tests::{Folder, mixed_turn};
    let folder = Folder::outside("panel-code-cell");
    let rows = mixed_turn(&folder);
    let harness = Harness::open(FakeGit::default(), 1000., cx);
    harness.show(ReviewTarget::local("s1", &folder.0), None, cx);
    harness.feed(&rows, cx);
    assert_eq!(harness.shown_turn(cx).as_deref(), Some("t1"));
    let rows = harness.scope_rows(cx);
    let [turn] = rows.as_slice() else { panic!("one turn: {rows:?}") };
    assert!(
        turn.starts_with("Build the report, 2 files, 5 lines added, 2 lines deleted, "),
        "{turn}"
    );
    assert_eq!(
        harness.tree_rows(cx),
        [
            "Added, notes.md, 3 lines added, 0 lines deleted",
            "Modified, report.py, 2 lines added, 2 lines deleted",
        ]
    );
    assert_eq!(harness.diff_files(cx), ["notes.md", "report.py"]);
    let counts = harness.panel.read_with(cx, |panel, cx| {
        let diff = panel.diff().read(cx);
        diff.files()
            .iter()
            .map(|file| (file.path().to_string(), file.additions(), file.deletions()))
            .collect::<Vec<_>>()
    });
    assert_eq!(counts, [("notes.md".to_owned(), 3, 0), ("report.py".to_owned(), 2, 2)]);
    assert!(!harness.exists(domain_element_id("review-step-mark", "report.py"), cx));
}

/// In a repository the turns sit between Uncommitted changes and the
/// commits; choosing one shows it, and All changes shows the branch again.
#[gpui_kit::test]
fn turn_scopes_sit_beside_the_git_scopes(cx: &mut TestAppContext) {
    use crate::turns_tests::{Folder, first_turn};
    // The turn edited files in the repository: they are untracked there.
    let folder = Folder(branch_repository("panel-turn-scopes"));
    let repo = folder.0.clone();
    let rows = first_turn(&folder);
    let harness = Harness::on_repository(&repo, 1000., cx);
    harness.feed(&rows, cx);
    assert_eq!(harness.shown_turn(cx), None, "Git's All changes stay shown");
    let names: Vec<String> = harness
        .scope_rows(cx)
        .into_iter()
        .map(|row| row.split(", ").next().unwrap_or_default().to_owned())
        .collect();
    assert_eq!(
        names,
        ["All changes", "Uncommitted changes", "Build the report", "Add b", "Add a second line"]
    );
    assert_eq!(harness.label("review-turns-heading", cx).as_deref(), Some("Edits by turn 1"));
    assert_eq!(harness.label("review-commits-heading", cx).as_deref(), Some("Commits 2"));

    harness.click(domain_element_id("review-turn", "t1"), cx);
    assert_eq!(harness.shown_turn(cx).as_deref(), Some("t1"));
    assert!(!harness.exists("review-current-branch", cx), "the bar names the turn");
    assert_eq!(harness.label("review-turn-label", cx).as_deref(), Some("Build the report"));
    assert_eq!(harness.diff_files(cx), ["data.txt", "notes.md", "old.txt", "report.py"]);

    harness.press("up", cx);
    assert_eq!(harness.shown_turn(cx), None, "↑ goes back to Uncommitted changes");
    assert_eq!(
        harness.panel.read_with(cx, |panel, _| panel.scope().clone()),
        ReviewScope::Uncommitted
    );
    assert_eq!(
        harness.diff_files(cx),
        ["a.txt", "data.txt", "new.txt", "notes.md", "report.py"],
        "Git's uncommitted changes, the turn's files untracked among them"
    );
    harness.press("down", cx);
    assert_eq!(harness.shown_turn(cx).as_deref(), Some("t1"), "↓ into the turns");
    harness.click(domain_element_id("review-scope", "all"), cx);
    assert_eq!(harness.shown_turn(cx), None);
    assert_eq!(harness.label("review-current-branch", cx).as_deref(), Some("feature"));
    assert_eq!(harness.diff_files(cx).first().map(String::as_str), Some("src/deep/b.txt"));
}

/// The card's "View changes" and its file rows: the panel shows the turn,
/// scrolled to the file asked for.
#[gpui_kit::test]
fn a_turn_opens_at_the_file_asked_for(cx: &mut TestAppContext) {
    use crate::turns_tests::{Folder, first_turn};
    let folder = Folder::outside("panel-turn-file");
    let rows = first_turn(&folder);
    let harness = Harness::open(FakeGit::default(), 1000., cx);
    harness.show(ReviewTarget::local("s1", &folder.0), None, cx);
    harness.feed(&rows, cx);
    harness.panel.update(cx, |panel, cx| panel.show_turn("t1", Some("report.py".into()), cx));
    harness.settle(cx);
    assert_eq!(harness.selected(cx).as_deref(), Some("report.py"));
    let row = domain_element_id("review-file", "report.py");
    assert_eq!(harness.with_window(cx, |window, _| window.find(row).selected()), Some(true));
    let diff = harness.bounds("review-diff", cx);
    let offset = harness.header_offset("report.py", cx).expect("its header shows");
    assert!(offset >= px(0.) && offset < diff.size.height, "in view: {offset:?}");
}

/// A file changed since the turn shows its edits one after another, each
/// header saying which it is and its own lines; the tree row sums them.
#[gpui_kit::test]
fn a_stepwise_file_marks_each_edit(cx: &mut TestAppContext) {
    use crate::turns_tests::{Folder, REPORT_AFTER, first_turn};
    let folder = Folder::outside("panel-steps");
    let rows = first_turn(&folder);
    folder.write("report.py", &REPORT_AFTER.replace("a10", "z10"));
    let harness = Harness::open(FakeGit::default(), 1000., cx);
    harness.show(ReviewTarget::local("s1", &folder.0), None, cx);
    harness.feed(&rows, cx);
    assert_eq!(
        harness.diff_files(cx),
        ["data.txt", "notes.md", "old.txt", "report.py (1/2)", "report.py (2/2)"]
    );
    assert!(
        harness.tree_rows(cx).contains(
            &"Modified, report.py, 2 lines added, 2 lines deleted, Step by step".to_owned()
        )
    );
    harness.panel.update(cx, |panel, cx| panel.select_file("report.py", cx));
    harness.settle(cx);
    let mark = |n: usize| domain_element_id("review-step-mark", &format!("report.py ({n}/2)"));
    assert_eq!(harness.label(mark(1), cx).as_deref(), Some("Step 1 of 2"));
    assert_eq!(harness.label(mark(2), cx).as_deref(), Some("Step 2 of 2"));
    let counts = domain_element_id("review-header-counts", "report.py (1/2)");
    assert_eq!(harness.label(counts, cx).as_deref(), Some("1 line added, 1 line deleted"));
}

mod geometry;
