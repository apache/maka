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

//! UI integration tests of the context strip over the composer: what it
//! says of an existing task's repository, its chip opening the changes
//! panel, its name opening the project menu, its forms without a
//! repository and without changes, and its absence from the new task's
//! draft. Git is a script that counts reads; the tasks' folders are made
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
use gpui_kit::{Action as _, Bounds, ElementId, Pixels, TestAppContext, px, size};
use review::git::{GitError, GitOutput, GitRunner};
use workspace::actions::NewSession;

use crate::tests::{Harness, root, session, settle};

/// A branch `feature` of a repository with `main`, whose one change is
/// `changes` (or none), or no `git` at all; counts its reads (each starts
/// with the current branch).
struct ScriptedGit {
    reads: AtomicUsize,
    changes: Option<&'static str>,
    missing: bool,
}

/// `a.rs`: three lines added, one deleted.
const CHANGE: &str = "diff --git a/a.rs b/a.rs\n--- a/a.rs\n+++ b/a.rs\n@@ -1,2 +1,4 @@\n-old\n+one\n+two\n+three\n keep\n";

impl ScriptedGit {
    fn new(changes: Option<&'static str>) -> Arc<Self> {
        Arc::new(Self { reads: AtomicUsize::new(0), changes, missing: false })
    }

    fn missing() -> Arc<Self> {
        Arc::new(Self { reads: AtomicUsize::new(0), changes: None, missing: true })
    }

    fn reads(&self) -> usize {
        self.reads.load(Ordering::SeqCst)
    }

    fn answer(&self, command: &str) -> Result<GitOutput, GitError> {
        if self.missing {
            return Err(GitError::Missing);
        }
        let changes = self.changes.unwrap_or_default();
        let stdout = match command {
            "branch --show-current" => "feature\n",
            "rev-parse --verify --quiet HEAD" | "rev-parse --verify --quiet refs/heads/main" => {
                "c0ffee\n"
            }
            "for-each-ref --format=%(refname) refs/heads refs/remotes" => {
                "refs/heads/feature\nrefs/heads/main\n"
            }
            "merge-base refs/heads/main HEAD" => "base\n",
            "diff --name-status -z --find-renames base" if !changes.is_empty() => "M\0a.rs\0",
            "diff --numstat -z --find-renames base" if !changes.is_empty() => "3\t1\ta.rs\0",
            command
                if command.starts_with("log ")
                    || command.starts_with("diff --name-status")
                    || command.starts_with("diff --numstat")
                    || command.starts_with("ls-files") =>
            {
                ""
            }
            command if command.starts_with("diff --no-ext-diff") => changes,
            _ => return Err(GitError::Failed(format!("fatal: {command}"))),
        };
        Ok(GitOutput::new(stdout))
    }
}

impl GitRunner for ScriptedGit {
    fn run(&self, _: &Path, args: &[String]) -> Boxed<Result<GitOutput, GitError>> {
        if args.first().is_some_and(|arg| arg == "branch") {
            self.reads.fetch_add(1, Ordering::SeqCst);
        }
        let answer = self.answer(&args.join(" "));
        async move { answer }.boxed()
    }
}

/// A folder that looks like a repository to the read, for task `id`.
fn task_folder(id: &str) -> PathBuf {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let n = NEXT.fetch_add(1, Ordering::SeqCst);
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/tmp")
        .join(format!("app-strip-{}-{n}-{id}", std::process::id()));
    std::fs::create_dir_all(dir.join(".git")).expect("folder");
    dir
}

struct Strip {
    harness: Harness,
    /// The strip's Git, and the changes panel's.
    git: Arc<ScriptedGit>,
    panel_git: Arc<ScriptedGit>,
    folder: PathBuf,
}

impl Strip {
    /// The window with task `s1` in its own folder (or in `path`), the
    /// strip and the panel each on `git` as scripted.
    fn open(git: Arc<ScriptedGit>, path: Option<&str>, cx: &mut TestAppContext) -> Self {
        Self::named(git, path, "s1", cx)
    }

    /// [`Self::open`] with the task's folder named after `name`.
    fn named(
        git: Arc<ScriptedGit>,
        path: Option<&str>,
        name: &str,
        cx: &mut TestAppContext,
    ) -> Self {
        cx.executor().allow_parking();
        let folder = task_folder(name);
        let path = path.map_or_else(|| folder.to_string_lossy().into_owned(), str::to_owned);
        let harness = Harness::open(vec![session("s1", "Alpha", &path, "active")], cx);
        cx.simulate_window_resize(harness.window.into(), size(px(1600.), px(800.)));
        let panel_git = ScriptedGit::new(git.changes);
        let (strip_runner, panel_runner) = (git.clone(), panel_git.clone());
        harness.workbench.update(cx, |workbench, cx| {
            workbench.review_panel().update(cx, |panel, _| panel.set_git_runner(panel_runner));
            workbench.read_changes_with(strip_runner, cx);
        });
        let strip = Self { harness, git, panel_git, folder };
        strip.settle(cx);
        strip
    }

    /// Runs any read to its end.
    fn settle(&self, cx: &mut TestAppContext) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            settle(cx);
            let loading = self.harness.workbench.read_with(cx, |workbench, cx| {
                workbench.change_summary().read(cx).is_loading()
                    || workbench.review_panel().read(cx).is_loading()
            });
            if !loading || Instant::now() > deadline {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn exists(&self, id: impl Into<ElementId>, cx: &mut TestAppContext) -> bool {
        let id = id.into();
        self.harness.with_window(cx, |window, _| window.try_find(id).is_some())
    }

    fn label(&self, id: impl Into<ElementId>, cx: &mut TestAppContext) -> Option<String> {
        let id = id.into();
        self.harness.with_window(cx, |window, _| window.find(id).label().map(str::to_owned))
    }

    fn bounds(&self, id: impl Into<ElementId>, cx: &mut TestAppContext) -> Bounds<Pixels> {
        let id = id.into();
        self.harness.with_window(cx, |window, _| window.find(id).bounds())
    }

    fn click(&self, id: impl Into<ElementId>, cx: &mut TestAppContext) {
        let id = id.into();
        self.harness.with_window(cx, |window, cx| window.click(id, cx));
        self.settle(cx);
    }

    fn folder_name(&self) -> String {
        self.folder.file_name().expect("a name").to_string_lossy().into_owned()
    }

    fn panel_shown(&self, cx: &mut TestAppContext) -> bool {
        self.exists("review-pane", cx)
    }
}

impl Drop for Strip {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.folder).ok();
    }
}

/// In an existing task the strip, the composer's width directly above it,
/// shows the folder's name, the branch and the changes' lines; the chip
/// opens the changes panel and gives it the focus, and again only the
/// focus; the name opens the project menu above it.
#[gpui_kit::test]
fn the_strip_shows_the_task_its_branch_and_its_changes(cx: &mut TestAppContext) {
    let strip = Strip::open(ScriptedGit::new(Some(CHANGE)), None, cx);
    assert_eq!(strip.label("context-strip-project", cx), Some(strip.folder_name()));
    assert_eq!(strip.label("context-strip-branch", cx).as_deref(), Some("feature"));
    assert_eq!(
        strip.label("context-strip-changes", cx).as_deref(),
        Some("Open changes, 3 lines added, 1 line deleted")
    );
    let (bar, composer) = (strip.bounds("context-strip", cx), strip.bounds("composer", cx));
    assert_eq!((bar.left(), bar.right()), (composer.left(), composer.right()), "its width");
    assert_eq!(composer.top() - bar.bottom(), px(8.), "directly above it");
    assert_eq!(bar.size.height, px(32.), "one line");
    let (name, branch, chip) = (
        strip.bounds("context-strip-project", cx),
        strip.bounds("context-strip-branch", cx),
        strip.bounds("context-strip-changes", cx),
    );
    assert!(name.right() <= branch.left() && branch.right() < chip.left(), "name, branch, chip");
    assert!(chip.right() <= bar.right());

    assert!(!strip.panel_shown(cx));
    strip.click("context-strip-changes", cx);
    assert!(strip.panel_shown(cx), "the chip opens the changes panel");
    let focused = strip.harness.with_window(cx, |window, _| window.find("review-files").focused());
    assert_eq!(focused, Some(true), "and gives its tree the focus");
    strip.harness.with_window(cx, |window, cx| window.blur(cx));
    strip.click("context-strip-changes", cx);
    assert!(strip.panel_shown(cx), "open, it stays open");
    let focused = strip.harness.with_window(cx, |window, _| window.find("review-files").focused());
    assert_eq!(focused, Some(true), "and takes the focus");

    strip.click("context-strip-project", cx);
    let open = strip.harness.workbench.read_with(cx, |workbench, _| workbench.strip_menu_open());
    assert!(open, "the name opens the project menu");
    let item = shared::domain_element_id("menu-item", "copy-project-path");
    let (menu, name) = (strip.bounds(item, cx), strip.bounds("context-strip-project", cx));
    assert!(menu.bottom() <= name.top(), "above the name: {menu:?} {name:?}");
    assert!(!strip.harness.workbench.read_with(cx, |workbench, _| workbench.project_menu_open()));
}

/// No `git`, no repository, or a folder that is not on this machine: the
/// name alone, at the strip's one line.
#[gpui_kit::test]
fn without_a_repository_the_strip_shows_the_name_alone(cx: &mut TestAppContext) {
    let strip = Strip::open(ScriptedGit::missing(), None, cx);
    assert!(strip.git.reads() > 0, "it asked");
    assert_eq!(strip.label("context-strip-project", cx), Some(strip.folder_name()));
    assert!(!strip.exists("context-strip-branch", cx));
    assert!(!strip.exists("context-strip-changes", cx));
    assert_eq!(strip.bounds("context-strip", cx).size.height, px(32.), "the same height");

    let gone = Strip::open(ScriptedGit::new(Some(CHANGE)), Some("/work/gone"), cx);
    assert_eq!(gone.label("context-strip-project", cx).as_deref(), Some("gone"));
    assert!(!gone.exists("context-strip-branch", cx));
    assert!(!gone.exists("context-strip-changes", cx));
}

/// A repository without changes: the name and the branch, no chip.
#[gpui_kit::test]
fn without_changes_the_strip_has_no_chip(cx: &mut TestAppContext) {
    let strip = Strip::open(ScriptedGit::new(None), None, cx);
    assert_eq!(strip.label("context-strip-branch", cx).as_deref(), Some("feature"));
    assert!(!strip.exists("context-strip-changes", cx));
}

/// The new task's draft keeps its project picker in the composer and has
/// no strip.
#[gpui_kit::test]
fn the_draft_has_no_strip(cx: &mut TestAppContext) {
    let strip = Strip::open(ScriptedGit::new(Some(CHANGE)), None, cx);
    assert!(strip.exists("context-strip", cx));
    strip
        .harness
        .with_window(cx, |window, cx| window.dispatch_action(NewSession.boxed_clone(), cx));
    strip.settle(cx);
    assert!(strip.harness.drafting(cx));
    assert!(!strip.exists("context-strip", cx));
    assert!(strip.exists("composer", cx));
}

/// The strip reads again when the panel would: a turn of the task ending,
/// the window coming back to the front; while the panel shows All changes
/// it reads nothing itself and takes the panel's counts.
#[gpui_kit::test]
fn the_strip_reads_when_the_panel_would(cx: &mut TestAppContext) {
    let mut strip = Strip::open(ScriptedGit::new(Some(CHANGE)), None, cx);
    let reads = strip.git.reads();
    strip.harness.project("s1", root("t1", "r1", "running"), cx);
    strip.settle(cx);
    strip.harness.project("s1", root("t1", "r1", "completed"), cx);
    strip.settle(cx);
    assert_eq!(strip.git.reads(), reads + 1, "a turn's end reads again");

    strip.click("context-strip-changes", cx);
    let (reads, panel_reads) = (strip.git.reads(), strip.panel_git.reads());
    assert_eq!(panel_reads, 1, "the panel read its changes");
    let mut visual = gpui_kit::VisualTestContext::from_window(strip.harness.window.into(), cx);
    visual.deactivate_window();
    visual.update(|window, _| window.activate_window());
    strip.settle(cx);
    assert_eq!(strip.panel_git.reads(), panel_reads + 1, "the panel reads again");
    assert_eq!(strip.git.reads(), reads, "and the strip takes its counts");
    assert!(strip.exists("context-strip-changes", cx));
}

/// A folder name longer than the strip: the name gives up its width first,
/// the branch and the chip keep theirs, on the one line.
#[gpui_kit::test]
fn a_long_name_truncates_first(cx: &mut TestAppContext) {
    let long = "a-folder-name-far-longer-than-the-composer-is-wide-".repeat(4);
    let strip = Strip::named(ScriptedGit::new(Some(CHANGE)), None, &long, cx);
    let bar = strip.bounds("context-strip", cx);
    let (name, branch, chip) = (
        strip.bounds("context-strip-project", cx),
        strip.bounds("context-strip-branch", cx),
        strip.bounds("context-strip-changes", cx),
    );
    assert_eq!(bar.size.height, px(32.), "one line");
    assert!(name.left() >= bar.left() && name.right() <= branch.left(), "{name:?} {branch:?}");
    assert!(branch.size.width > px(40.), "the branch keeps its width: {branch:?}");
    assert!(branch.right() < chip.left() && chip.right() <= bar.right(), "{chip:?} in {bar:?}");
}
