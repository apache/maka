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

//! UI integration tests of the changes panel in the window: its button and
//! shortcut, following the selected task, reading again when a turn ends
//! or the window comes back, its width, and where it goes in a narrow
//! window. Git is a fake that counts reads; the tasks' folders are made
//! under `target/tmp` so the read gets as far as Git.

// The settle loop waits on the read's file checks on the blocking pool;
// setup makes the tasks' folders.
#![allow(clippy::disallowed_methods)]

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use futures_lite::FutureExt as _;
use futures_lite::future::Boxed;
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{Pixels, TestAppContext, VisualTestContext, px, size};
use review::git::{GitError, GitOutput, GitRunner};
use settings::AppPreferences;

use crate::SidebarForm;
use crate::tests::{Harness, root, session, settle};

/// Fails every command, counting the reads (each starts with the current
/// branch).
#[derive(Default)]
struct CountingGit(AtomicUsize);

impl GitRunner for CountingGit {
    fn run(&self, _: &Path, args: &[String]) -> Boxed<Result<GitOutput, GitError>> {
        if args.first().is_some_and(|arg| arg == "branch") {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
        async { Err(GitError::Failed("fatal: nothing here".to_owned())) }.boxed()
    }
}

/// A folder that looks like a repository to the read, for task `id`: one
/// of its own, as the tests run side by side in one process.
fn task_folder(id: &str) -> PathBuf {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let n = NEXT.fetch_add(1, Ordering::SeqCst);
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/tmp")
        .join(format!("app-review-{}-{n}-{id}", std::process::id()));
    std::fs::create_dir_all(dir.join(".git")).expect("folder");
    dir
}

struct Panel {
    harness: Harness,
    git: Arc<CountingGit>,
    folders: Vec<PathBuf>,
}

impl Panel {
    /// The window with tasks `ids` (the first selected), each in its own
    /// folder, and the counting Git.
    fn open(ids: &[&str], window_width: f32, cx: &mut TestAppContext) -> Self {
        cx.executor().allow_parking();
        let folders: Vec<PathBuf> = ids.iter().map(|id| task_folder(id)).collect();
        let sessions = ids
            .iter()
            .zip(&folders)
            .map(|(id, folder)| session(id, id, &folder.to_string_lossy(), "active"))
            .collect();
        let harness = Harness::open(sessions, cx);
        cx.simulate_window_resize(harness.window.into(), size(px(window_width), px(800.)));
        settle(cx);
        let git = Arc::new(CountingGit::default());
        let runner = git.clone();
        harness.workbench.update(cx, |workbench, cx| {
            workbench.review_panel().update(cx, |panel, _| panel.set_git_runner(runner));
        });
        Self { harness, git, folders }
    }

    fn reads(&self) -> usize {
        self.git.0.load(Ordering::SeqCst)
    }

    /// Runs any read to its end.
    fn settle(&self, cx: &mut TestAppContext) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            settle(cx);
            let loading = self
                .harness
                .workbench
                .read_with(cx, |workbench, cx| workbench.review_panel().read(cx).is_loading());
            if !loading || Instant::now() > deadline {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn shown(&self, cx: &mut TestAppContext) -> bool {
        self.harness.with_window(cx, |window, _| window.try_find("review-pane").is_some())
    }

    fn target(&self, cx: &mut TestAppContext) -> Option<String> {
        self.harness.workbench.read_with(cx, |workbench, cx| {
            let panel = workbench.review_panel().read(cx);
            panel.target().map(|target| target.session_id().to_string())
        })
    }

    fn select(&self, id: &str, cx: &mut TestAppContext) {
        self.harness.workbench.update(cx, |workbench, cx| {
            let catalog = workbench.sidebar().read(cx).catalog().clone();
            catalog.update(cx, |catalog, cx| catalog.select(Some(id), cx));
        });
        self.settle(cx);
    }

    fn bounds(&self, id: &'static str, cx: &mut TestAppContext) -> gpui_kit::Bounds<Pixels> {
        self.harness.with_window(cx, |window, _| window.find(id).bounds())
    }
}

impl Drop for Panel {
    fn drop(&mut self) {
        for folder in &self.folders {
            std::fs::remove_dir_all(folder).ok();
        }
    }
}

/// The header's button and ⌃⇧G open and close the selected task's panel,
/// which the preferences remember for the task; opening it reads.
#[gpui_kit::test]
fn the_button_and_its_shortcut_toggle_the_changes_panel(cx: &mut TestAppContext) {
    let panel = Panel::open(&["s1"], 1600., cx);
    assert!(!panel.shown(cx), "closed at first");
    let label = panel
        .harness
        .with_window(cx, |window, _| window.find("review-toggle").label().map(str::to_owned));
    assert_eq!(label.as_deref(), Some(shared::copy::review::CHANGES.en()));

    panel.harness.with_window(cx, |window, cx| window.click("review-toggle", cx));
    panel.settle(cx);
    assert!(panel.shown(cx));
    assert_eq!(panel.reads(), 1, "opening reads the task's changes");
    let open = cx.update(|cx| AppPreferences::current(cx).review_open);
    assert!(open.contains("s1"), "{open:?}");

    panel.harness.with_window(cx, |window, cx| window.press("ctrl-shift-g", cx));
    panel.settle(cx);
    assert!(!panel.shown(cx), "the shortcut closes it");
    assert!(cx.update(|cx| AppPreferences::current(cx).review_open.is_empty()));
    panel.harness.with_window(cx, |window, cx| window.press("ctrl-shift-g", cx));
    panel.settle(cx);
    assert!(panel.shown(cx), "and opens it");

    // The panel's own close button closes it too.
    panel.harness.with_window(cx, |window, cx| window.click("review-close", cx));
    panel.settle(cx);
    assert!(!panel.shown(cx));
}

/// The panel follows the selected task, and is open or closed per task.
#[gpui_kit::test]
fn the_changes_panel_follows_the_selected_task(cx: &mut TestAppContext) {
    let panel = Panel::open(&["s1", "s2"], 1600., cx);
    panel.select("s1", cx);
    panel.harness.with_window(cx, |window, cx| window.press("ctrl-shift-g", cx));
    panel.settle(cx);
    assert!(panel.shown(cx));
    assert_eq!(panel.target(cx).as_deref(), Some("s1"));

    panel.select("s2", cx);
    assert_eq!(panel.target(cx).as_deref(), Some("s2"), "it follows the task");
    assert!(!panel.shown(cx), "closed for the task that never opened it");
    let reads = panel.reads();
    panel.harness.with_window(cx, |window, cx| window.press("ctrl-shift-g", cx));
    panel.settle(cx);
    assert_eq!(panel.reads(), reads + 1, "the second task's changes are read");

    panel.select("s1", cx);
    assert!(panel.shown(cx), "the first task's panel is still open");
    assert_eq!(panel.target(cx).as_deref(), Some("s1"));
    assert_eq!(panel.reads(), reads + 2, "and read again");
}

/// While it shows, the panel reads again when a turn of the task ends and
/// when the window comes back to the front.
#[gpui_kit::test]
fn the_changes_panel_reads_again_when_a_turn_ends(cx: &mut TestAppContext) {
    let mut panel = Panel::open(&["s1"], 1600., cx);
    panel.harness.with_window(cx, |window, cx| window.press("ctrl-shift-g", cx));
    panel.settle(cx);
    let reads = panel.reads();

    panel.harness.project("s1", root("t1", "r1", "running"), cx);
    panel.settle(cx);
    assert_eq!(panel.reads(), reads, "a running turn reads nothing");
    panel.harness.project("s1", root("t1", "r1", "completed"), cx);
    panel.settle(cx);
    assert_eq!(panel.reads(), reads + 1, "its end reads again");

    let mut visual = VisualTestContext::from_window(panel.harness.window.into(), cx);
    visual.deactivate_window();
    visual.update(|window, _| window.activate_window());
    panel.settle(cx);
    assert_eq!(panel.reads(), reads + 2, "the window back in front reads again");
}

/// Beside the plate the panel takes Desktop's 480 px, its edge moves it,
/// and the preferences keep the width.
#[gpui_kit::test]
fn the_changes_panel_sits_beside_the_plate_at_its_width(cx: &mut TestAppContext) {
    let panel = Panel::open(&["s1"], 1600., cx);
    panel.harness.with_window(cx, |window, cx| window.press("ctrl-shift-g", cx));
    panel.settle(cx);
    let (main, pane) = (panel.bounds("main-pane", cx), panel.bounds("review-pane", cx));
    assert_eq!(pane.size.width, px(480.));
    assert_eq!(pane.left(), main.right() + px(8.), "the canvas margin between the plates");
    assert_eq!(pane.top(), main.top());

    panel.harness.with_window(cx, |window, cx| {
        let start = window.find("review-resize").bounds().center();
        window.drag(start, gpui_kit::point(start.x + px(80.), start.y), cx);
    });
    cx.executor().advance_clock(Duration::from_millis(300));
    settle(cx);
    assert_eq!(panel.bounds("review-pane", cx).size.width, px(400.));
    assert_eq!(cx.update(|cx| AppPreferences::current(cx).review_width), 400);
}

/// A window too narrow to keep the composer's column beside the panel puts
/// the panel below the plate, as Desktop's Workbar goes below the
/// conversation; the sidebar collapses at its own breakpoint as before.
#[gpui_kit::test]
fn a_narrow_window_puts_the_changes_panel_below(cx: &mut TestAppContext) {
    let panel = Panel::open(&["s1"], 1200., cx);
    panel.harness.with_window(cx, |window, cx| window.press("ctrl-shift-g", cx));
    panel.settle(cx);
    let form = |cx: &mut TestAppContext| {
        panel.harness.workbench.read_with(cx, |workbench, _| workbench.sidebar_form())
    };
    assert_eq!(form(cx), SidebarForm::Expanded, "1200 px keeps the sidebar");
    let (main, pane) = (panel.bounds("main-pane", cx), panel.bounds("review-pane", cx));
    assert_eq!(pane.top(), main.bottom() + px(8.), "below the plate");
    assert_eq!((pane.left(), pane.size.width), (main.left(), main.size.width));
    assert!(pane.size.height <= px(360.));
    assert!(main.size.width >= px(784.), "the plate keeps the composer's width");

    cx.simulate_window_resize(panel.harness.window.into(), size(px(1000.), px(800.)));
    panel.settle(cx);
    assert_ne!(form(cx), SidebarForm::Expanded, "the sidebar collapses at its breakpoint");
    let (main, pane) = (panel.bounds("main-pane", cx), panel.bounds("review-pane", cx));
    assert!(pane.top() > main.top(), "still below");
}

/// The panel's edge drags past Desktop's old 600 px, up to what leaves the
/// conversation its 400 px; there the composer still fits its controls on
/// one row inside the plate.
#[gpui_kit::test]
fn the_changes_panel_drags_wide_until_the_conversation_keeps_its_least(cx: &mut TestAppContext) {
    let panel = Panel::open(&["s1"], 1600., cx);
    panel.harness.with_window(cx, |window, cx| window.press("ctrl-shift-g", cx));
    panel.settle(cx);
    let drag = |by: f32, cx: &mut TestAppContext| {
        panel.harness.with_window(cx, |window, cx| {
            let start = window.find("review-resize").bounds().center();
            window.drag(start, gpui_kit::point(start.x - px(by), start.y), cx);
        });
        cx.executor().advance_clock(Duration::from_millis(300));
        settle(cx);
    };
    drag(300., cx);
    assert_eq!(panel.bounds("review-pane", cx).size.width, px(780.), "past 600");
    drag(1000., cx);
    // 1600 less the 256 px sidebar, the 8 px margins and gap, and 400.
    assert_eq!(panel.bounds("review-pane", cx).size.width, px(920.));
    let main = panel.bounds("main-pane", cx);
    assert_eq!(main.size.width, px(400.), "the conversation keeps its least");
    assert_eq!(cx.update(|cx| AppPreferences::current(cx).review_width), 920);
    let (composer, send) = (panel.bounds("composer", cx), panel.bounds("send-message", cx));
    assert!(main.left() < composer.left() && composer.right() < main.right(), "{composer:?}");
    assert!(composer.left() < send.left() && send.right() < composer.right(), "{send:?}");
    assert!(send.top() > composer.top(), "the send button stays on the dock's row");
}

/// The panel's button and ⇧Esc maximize the panel into the plate in the
/// conversation's place, the sidebar staying; the button, ⇧Esc and Esc
/// restore it, with the draft as it was. Each task remembers it.
#[gpui_kit::test]
fn the_changes_panel_maximizes_in_the_conversations_place(cx: &mut TestAppContext) {
    let panel = Panel::open(&["s1", "s2"], 1600., cx);
    panel.select("s1", cx);
    panel.harness.with_window(cx, |window, cx| window.press("ctrl-shift-g", cx));
    panel.settle(cx);
    let workbench = panel.harness.workbench.clone();
    panel.harness.with_window(cx, |window, cx| {
        let composer = workbench.read(cx).composer().clone();
        let draft = composer.read(cx).draft().clone();
        draft.update(cx, |draft, cx| draft.set_value("half a thought", window, cx));
    });
    let maximized = |cx: &mut TestAppContext| {
        workbench.read_with(cx, |workbench, cx| workbench.review_maximized(cx))
    };
    let composer_shown = |cx: &mut TestAppContext| {
        panel.harness.with_window(cx, |window, _| window.try_find("composer").is_some())
    };
    let sidebar = panel.bounds("main-pane", cx).left();

    panel.harness.with_window(cx, |window, cx| window.click("review-maximize", cx));
    panel.settle(cx);
    assert!(maximized(cx));
    let (main, pane) = (panel.bounds("main-pane", cx), panel.bounds("review-pane", cx));
    assert_eq!(main.left(), sidebar, "the sidebar stays");
    assert_eq!((pane.left(), pane.size.width), (main.left(), main.size.width), "the plate's width");
    assert_eq!(pane.bottom(), main.bottom());
    assert!(!composer_shown(cx), "the composer leaves the plate");
    assert!(!panel.harness.with_window(cx, |window, _| window.try_find("review-resize").is_some()));
    let remembered = cx.update(|cx| AppPreferences::current(cx).review_maximized);
    assert!(remembered.contains("s1"), "{remembered:?}");

    panel.harness.with_window(cx, |window, cx| window.press("escape", cx));
    panel.settle(cx);
    assert!(!maximized(cx), "Esc restores it");
    assert!(composer_shown(cx));
    let draft = panel.harness.workbench.read_with(cx, |workbench, cx| {
        workbench.composer().read(cx).draft().read(cx).value().to_string()
    });
    assert_eq!(draft, "half a thought", "the draft kept");

    panel.harness.with_window(cx, |window, cx| window.press("shift-escape", cx));
    panel.settle(cx);
    assert!(maximized(cx), "⇧Esc maximizes it");
    panel.select("s2", cx);
    assert!(!maximized(cx), "the other task's panel is closed");
    assert!(composer_shown(cx));
    panel.harness.with_window(cx, |window, cx| window.press("ctrl-shift-g", cx));
    panel.settle(cx);
    assert!(!maximized(cx), "and opens beside the conversation");
    panel.select("s1", cx);
    assert!(maximized(cx), "the first task's panel is still maximized");
    panel.harness.with_window(cx, |window, cx| window.click("review-maximize", cx));
    panel.settle(cx);
    assert!(!maximized(cx), "its button restores it");
    panel.harness.with_window(cx, |window, cx| window.press("shift-escape", cx));
    panel.harness.with_window(cx, |window, cx| window.press("shift-escape", cx));
    panel.settle(cx);
    assert!(!maximized(cx), "⇧Esc twice restores it");

    // ⌘L, which needs the composer, restores it; closing the maximized
    // panel with focus in it gives the composer the focus.
    panel.harness.with_window(cx, |window, cx| window.press("shift-escape", cx));
    panel.settle(cx);
    assert!(maximized(cx));
    panel.harness.with_window(cx, |window, cx| window.press("secondary-l", cx));
    panel.settle(cx);
    assert!(!maximized(cx), "Focus Composer restores it");
    let draft = panel.harness.draft_id(cx);
    panel.harness.with_window(cx, |window, cx| window.press("shift-escape", cx));
    panel.settle(cx);
    let focused = panel.harness.with_window(cx, |window, _| window.find("review-panel").focused());
    assert_eq!(focused, Some(true), "maximizing moves the focus into the panel");
    panel.harness.with_window(cx, |window, cx| window.click("review-close", cx));
    panel.settle(cx);
    assert!(!panel.shown(cx));
    let focused = panel.harness.with_window(cx, |window, _| window.find(draft).focused());
    assert_eq!(focused, Some(true), "the composer takes the focus");
}
