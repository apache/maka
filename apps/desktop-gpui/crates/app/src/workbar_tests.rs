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

//! UI integration tests of the workbar in the window: its [+] menu, its
//! tabs and their ×, the strip overflowing, Ctrl+`, its tabs through
//! placement changes and maximize, terminals following the selected task,
//! their controllers held only while their face shows, the app's keys
//! around a focused terminal, and the Terminal settings taking effect; the
//! Files face from [+] and ⌘P, its Escape, and its list read again when a
//! turn settles; the Trace face from [+], read and refreshed only while it
//! shows.

// The changes' read checks the task folder on the blocking pool, which the
// settle loop waits on.
#![allow(clippy::disallowed_methods)]

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_lite::FutureExt as _;
use futures_lite::future::Boxed;
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{Context, TestAppContext, px, size};
use review::git::{GitError, GitOutput, GitRunner};
use serde_json::json;
use settings::AppPreferences;

use crate::tests::{EPOCH, Harness, ScriptedHost, artifact, frame, session, settle, terminal_ref};

/// Git that fails at once: the changes' face shows its failure, and no
/// read waits on a subprocess.
struct NoGit;

impl GitRunner for NoGit {
    fn run(&self, _: &Path, _: &[String]) -> Boxed<Result<GitOutput, GitError>> {
        async { Err(GitError::Failed("fatal: nothing here".to_owned())) }.boxed()
    }
}

struct Bench {
    harness: Harness,
}

impl Bench {
    /// The window with tasks `ids`, the first selected; each task's
    /// terminals as `terminals` lists them.
    fn open(ids: &[&str], terminals: &[(&str, &[&str])], cx: &mut TestAppContext) -> Self {
        let transport =
            ScriptedHost::new(ids.iter().map(|id| session(id, id, "/work/a", "active")).collect());
        for (task, names) in terminals {
            transport.set_terminals(task, names);
        }
        cx.executor().allow_parking();
        let harness = Harness::with_transport(transport, cx);
        harness.workbench.update(cx, |workbench, cx| {
            workbench.review_panel().update(cx, |panel, _| panel.set_git_runner(Arc::new(NoGit)));
        });
        let bench = Self { harness };
        bench.select(ids[0], cx);
        bench
    }

    fn select(&self, id: &str, cx: &mut TestAppContext) {
        self.harness.workbench.update(cx, |workbench, cx| {
            let catalog = workbench.sidebar().read(cx).catalog().clone();
            catalog.update(cx, |catalog, cx| catalog.select(Some(id), cx));
        });
        self.frame(cx);
    }

    /// Draws a frame and lets what it set off (the changes' read among it)
    /// run to its end.
    fn frame(&self, cx: &mut TestAppContext) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            self.harness.with_window(cx, |_, _| {});
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
        self.harness.with_window(cx, |_, _| {});
    }

    /// The × of a tab that does not show appears under the pointer.
    fn close_tab(&self, key: &str, cx: &mut TestAppContext) {
        let wrapper = shared::domain_element_id("workbar-tab", key);
        self.harness.with_window(cx, |window, cx| window.hover(wrapper, cx));
        self.frame(cx);
        self.click(close(key), cx);
    }

    /// Changes the preferences, as a switch in Settings does.
    fn set_preferences(
        &self,
        change: impl FnOnce(&mut AppPreferences, &mut Context<AppPreferences>),
        cx: &mut TestAppContext,
    ) {
        cx.update(|cx| AppPreferences::global(cx).update(cx, change));
        self.frame(cx);
    }

    fn press(&self, keys: &str, cx: &mut TestAppContext) {
        for key in keys.split(' ') {
            self.harness.with_window(cx, |window, cx| window.press(key, cx));
            self.frame(cx);
        }
    }

    fn click(&self, id: impl Into<gpui_kit::ElementId>, cx: &mut TestAppContext) {
        let id = id.into();
        self.harness.with_window(cx, |window, cx| window.click(id, cx));
        self.frame(cx);
    }

    fn exists(&self, id: impl Into<gpui_kit::ElementId>, cx: &mut TestAppContext) -> bool {
        let id = id.into();
        self.harness.with_window(cx, |window, _| window.try_find(id).is_some())
    }

    fn focused(&self, id: &'static str, cx: &mut TestAppContext) -> bool {
        self.harness.with_window(cx, |window, _| {
            window.try_find(id).and_then(|element| element.focused()) == Some(true)
        })
    }

    /// The strip's tabs: key, name and whether it shows.
    fn tabs(&self, cx: &mut TestAppContext) -> Vec<(String, String, bool)> {
        self.harness.workbench.read_with(cx, |workbench, cx| workbench.strip_tabs(cx))
    }

    fn open_workbar(&self, cx: &mut TestAppContext) -> bool {
        self.harness.workbench.read_with(cx, |workbench, cx| workbench.workbar_shown(cx))
    }

    fn starts(&self) -> usize {
        self.harness.transport.requests("runtime.resource.start").len()
    }

    /// Everything typed into terminals so far.
    fn typed(&self) -> String {
        self.harness
            .transport
            .requests("runtime.resource.controller.control")
            .iter()
            .filter_map(|input| input["control"]["input"].as_str().map(str::to_owned))
            .collect()
    }

    /// The rows of each resize sent.
    fn resizes(&self) -> Vec<u64> {
        self.harness
            .transport
            .requests("runtime.resource.controller.control")
            .iter()
            .filter(|input| input["control"]["kind"] == "resize")
            .map(|input| input["control"]["rows"].as_u64().expect("rows"))
            .collect()
    }

    fn menu_item(&self, key: &str, cx: &mut TestAppContext) -> Option<bool> {
        let id = shared::domain_element_id("menu-item", key);
        self.harness.with_window(cx, |window, _| {
            window.try_find(id).map(|item| item.checked() == Some(true))
        })
    }

    /// Output of terminal `name` of task `session`.
    fn output(
        &mut self,
        task: &str,
        name: &str,
        sequence: u64,
        data: &str,
        cx: &mut TestAppContext,
    ) {
        self.harness.push(
            frame(json!({
                "kind": "subscription.runtime_resource_pty_data", "hostEpoch": EPOCH,
                "subscriptionId": format!("sub-{task}"), "sessionId": task,
                "ref": terminal_ref(name), "ptySequence": sequence, "data": data
            })),
            cx,
        );
        self.frame(cx);
    }
}

fn tab(key: &str) -> gpui_kit::ElementId {
    shared::domain_element_id("workbar-tab-button", key)
}

fn close(key: &str) -> gpui_kit::ElementId {
    shared::domain_element_id("workbar-tab-close", key)
}

#[gpui_kit::test]
fn the_add_menu_opens_changes_and_terminals_and_marks_the_open_ones(cx: &mut TestAppContext) {
    let bench = Bench::open(&["s1"], &[], cx);
    bench.click("review-toggle", cx);
    assert_eq!(bench.tabs(cx), [("changes".into(), "Changes".into(), true)]);

    bench.click("workbar-add", cx);
    assert_eq!(bench.menu_item("workbar-tool-changes", cx), Some(true), "Changes is open");
    assert_eq!(bench.menu_item("workbar-tool-terminal", cx), Some(false));
    bench.click(shared::domain_element_id("menu-item", "workbar-tool-terminal"), cx);
    assert_eq!(bench.starts(), 1);
    let started = terminal_ref("started-1");
    assert_eq!(
        bench.tabs(cx),
        [("changes".into(), "Changes".into(), false), (started.clone(), "Terminal".into(), true)],
        "the new terminal shows, after Changes"
    );
    assert!(bench.exists("terminal-face", cx));
    assert!(bench.focused("terminal-grid", cx), "and has the focus");

    // Terminal always adds one; both are marked open now.
    bench.click("workbar-add", cx);
    assert_eq!(bench.menu_item("workbar-tool-changes", cx), Some(true));
    assert_eq!(bench.menu_item("workbar-tool-terminal", cx), Some(true));
    bench.click(shared::domain_element_id("menu-item", "workbar-tool-terminal"), cx);
    assert_eq!(bench.starts(), 2);
    assert_eq!(bench.tabs(cx).len(), 3);
    // Unmarking Changes closes its face.
    bench.click("workbar-add", cx);
    bench.click(shared::domain_element_id("menu-item", "workbar-tool-changes"), cx);
    let keys: Vec<String> = bench.tabs(cx).into_iter().map(|(key, _, _)| key).collect();
    assert_eq!(keys, [started, terminal_ref("started-2")]);
    bench.click("workbar-add", cx);
    assert_eq!(bench.menu_item("workbar-tool-changes", cx), Some(false));
}

#[gpui_kit::test]
fn a_tabs_close_button_closes_its_face_and_the_last_one_hides_the_panel(cx: &mut TestAppContext) {
    let bench = Bench::open(&["s1"], &[("s1", &["r1"])], cx);
    bench.click("review-toggle", cx);
    let r1 = terminal_ref("r1");
    assert_eq!(bench.tabs(cx).len(), 2, "Changes and the task's terminal");
    // The shown tab's ×: Changes closes and the terminal shows.
    bench.click(close("changes"), cx);
    assert_eq!(bench.tabs(cx), [(r1.clone(), "Terminal".into(), true)]);
    assert!(bench.open_workbar(cx));
    // The terminal's ×: its shell stops, without asking, and the tab goes
    // when the Host confirms; it was the last, so the panel hides.
    let stop = bench.harness.transport.hold("runtime.resource.stop");
    bench.click(close(&r1), cx);
    assert_eq!(bench.harness.transport.requests("runtime.resource.stop").len(), 1);
    assert!(bench.exists(shared::domain_element_id("workbar-tab-closing", &r1), cx));
    stop.try_send(Ok(json!({}))).expect("stop");
    bench.frame(cx);
    assert!(bench.tabs(cx).is_empty());
    assert!(!bench.open_workbar(cx), "the last face closed hides the panel");
}

#[gpui_kit::test]
fn inactive_tabs_drop_their_labels_when_the_strip_overflows(cx: &mut TestAppContext) {
    let names = ["a1", "a2", "a3", "a4", "a5", "a6", "a7"];
    let bench = Bench::open(&["s1"], &[("s1", &names)], cx);
    bench.click("review-toggle", cx);
    bench.frame(cx);
    let label = |key: &str| shared::domain_element_id("workbar-tab-label", key);
    // Changes shows: every other tab is bare, its name kept for assistive
    // technology and a tooltip.
    assert!(bench.exists(label("changes"), cx));
    for name in names {
        assert!(!bench.exists(label(&terminal_ref(name)), cx), "{name} drops its label");
    }
    let spoken = bench.harness.with_window(cx, |window, _| {
        window.find(tab(&terminal_ref("a2"))).label().map(str::to_owned)
    });
    assert_eq!(spoken.as_deref(), Some("Terminal 2"));
    // The active one keeps its label.
    bench.click(tab(&terminal_ref("a3")), cx);
    assert!(bench.exists(label(&terminal_ref("a3")), cx));
    assert!(!bench.exists(label("changes"), cx));
    // With room again every label returns: no horizontal scrolling.
    bench.close_tab("changes", cx);
    for name in &names[3..] {
        bench.close_tab(&terminal_ref(name), cx);
    }
    bench.frame(cx);
    for name in &names[..3] {
        assert!(bench.exists(label(&terminal_ref(name)), cx), "{name} has its label");
    }
}

#[gpui_kit::test]
fn ctrl_backtick_shows_starts_focuses_and_hides_the_terminal(cx: &mut TestAppContext) {
    let bench = Bench::open(&["s1"], &[], cx);
    assert!(!bench.open_workbar(cx));
    // From the composer: the panel opens on a new terminal, focused.
    bench.press("ctrl-`", cx);
    assert!(bench.open_workbar(cx));
    assert_eq!(bench.starts(), 1, "the task had none: one starts");
    let started = terminal_ref("started-1");
    assert_eq!(
        bench.tabs(cx),
        [("changes".into(), "Changes".into(), false), (started.clone(), "Terminal".into(), true)]
    );
    assert!(bench.focused("terminal-grid", cx));
    // With the terminal focused: the panel hides, its terminal kept.
    bench.press("ctrl-`", cx);
    assert!(!bench.open_workbar(cx));
    assert!(bench.harness.transport.requests("runtime.resource.stop").is_empty());
    // Again: the same terminal, focused; nothing new starts.
    bench.press("ctrl-`", cx);
    assert!(bench.open_workbar(cx));
    assert_eq!(bench.starts(), 1);
    assert!(bench.focused("terminal-grid", cx));
    // On Changes, with the focus elsewhere: back to the terminal.
    bench.click(tab("changes"), cx);
    bench.harness.with_window(cx, |window, cx| {
        window.dispatch_action(Box::new(workspace::actions::FocusComposer), cx);
    });
    bench.press("ctrl-`", cx);
    assert_eq!(bench.tabs(cx)[1], (started, "Terminal".into(), true));
    assert!(bench.focused("terminal-grid", cx));
}

#[gpui_kit::test]
fn tabs_survive_placement_changes_and_maximize(cx: &mut TestAppContext) {
    let bench = Bench::open(&["s1"], &[("s1", &["r1"])], cx);
    bench.press("ctrl-`", cx);
    let r1 = terminal_ref("r1");
    let tabs = bench.tabs(cx);
    assert_eq!(tabs.len(), 2);
    let acquires = || bench.harness.transport.requests("runtime.resource.controller.acquire").len();
    let attached = acquires();
    assert_eq!(attached, 1);
    bench.click("workbar-maximize", cx);
    assert!(bench.harness.workbench.read_with(cx, |workbench, cx| workbench.workbar_maximized(cx)));
    assert_eq!(bench.tabs(cx), tabs, "maximized, the same tabs");
    assert!(bench.exists("terminal-grid", cx));
    bench.press("shift-escape", cx);
    assert!(
        !bench.harness.workbench.read_with(cx, |workbench, cx| workbench.workbar_maximized(cx))
    );
    // Below the plate in a narrow window, and back beside it.
    cx.simulate_window_resize(bench.harness.window.into(), size(px(860.), px(700.)));
    bench.frame(cx);
    assert_eq!(bench.tabs(cx), tabs);
    cx.simulate_window_resize(bench.harness.window.into(), size(px(1400.), px(800.)));
    bench.frame(cx);
    assert_eq!(bench.tabs(cx), tabs);
    assert_eq!(acquires(), attached, "the terminal stayed attached throughout");
    assert!(bench.harness.transport.requests("runtime.resource.controller.release").is_empty());
    assert_eq!(bench.tabs(cx)[1].0, r1);
}

#[gpui_kit::test]
fn switching_tasks_swaps_terminals_and_returning_attaches_again(cx: &mut TestAppContext) {
    let bench = Bench::open(&["s1", "s2"], &[("s1", &["r1"]), ("s2", &["o1", "o2"])], cx);
    bench.press("ctrl-`", cx);
    let keys = |bench: &Bench, cx: &mut TestAppContext| -> Vec<String> {
        bench.tabs(cx).into_iter().map(|(key, _, _)| key).collect()
    };
    assert_eq!(keys(&bench, cx), ["changes".to_owned(), terminal_ref("r1")]);
    bench.select("s2", cx);
    assert!(!bench.open_workbar(cx), "each task its own workbar");
    let released = bench.harness.transport.requests("runtime.resource.controller.release");
    assert_eq!(released.len(), 1, "r1's controller is let go; its shell runs on");
    bench.press("ctrl-`", cx);
    assert_eq!(keys(&bench, cx), ["changes".to_owned(), terminal_ref("o1"), terminal_ref("o2")]);
    assert_eq!(bench.starts(), 0, "s2 had terminals: none starts");
    bench.select("s1", cx);
    assert_eq!(keys(&bench, cx), ["changes".to_owned(), terminal_ref("r1")]);
    let acquired: Vec<String> = bench
        .harness
        .transport
        .requests("runtime.resource.controller.acquire")
        .iter()
        .map(|input| input["ref"].as_str().expect("ref").to_owned())
        .collect();
    assert_eq!(
        acquired.iter().filter(|name| **name == terminal_ref("r1")).count(),
        2,
        "attached again"
    );
}

/// The terminals hold their controllers only while their face shows: on
/// another face their output still streams in for their tabs, and back on
/// their face they are taken again, each with its snapshot.
#[gpui_kit::test]
fn the_terminals_hold_their_controllers_only_while_their_face_shows(cx: &mut TestAppContext) {
    let mut bench = Bench::open(&["s1"], &[("s1", &["r1", "r2"])], cx);
    let count = |bench: &Bench, operation: &str| bench.harness.transport.requests(operation).len();
    let interest = |bench: &Bench| {
        let sets = bench.harness.transport.requests("subscription.pty_interest.set");
        sets.last().map(|input| input["refs"].clone())
    };
    let both = json!([terminal_ref("r1"), terminal_ref("r2")]);
    bench.press("ctrl-`", cx);
    assert_eq!(count(&bench, "runtime.resource.controller.acquire"), 2);
    assert_eq!(interest(&bench).as_ref(), Some(&both));

    // Changes takes the panel: both seats go, the output still comes.
    bench.click(tab("changes"), cx);
    assert_eq!(count(&bench, "runtime.resource.controller.release"), 2);
    assert_eq!(interest(&bench).as_ref(), Some(&both));
    bench.output("s1", "r2", 1, "\x07", cx);
    let bell = bench
        .harness
        .workbench
        .read_with(cx, |workbench, cx| workbench.terminal_view().read(cx).tabs(cx)[1].bell);
    assert!(bell, "r2's bell reaches its tab");

    // Back to a terminal: both are taken again, and typing reaches it.
    bench.click(tab(&terminal_ref("r1")), cx);
    assert_eq!(count(&bench, "runtime.resource.controller.acquire"), 4);
    assert_eq!(count(&bench, "runtime.resource.controller.release"), 2);
    bench.output("s1", "r1", 1, "$ ", cx);
    bench.press("l s enter", cx);
    assert_eq!(bench.typed(), "ls\r");
}

#[gpui_kit::test]
fn a_focused_terminal_gets_its_keys_and_the_apps_shortcuts_still_work(cx: &mut TestAppContext) {
    let mut bench = Bench::open(&["s1"], &[("s1", &["r1"])], cx);
    bench.press("ctrl-`", cx);
    bench.output("s1", "r1", 1, "$ ", cx);
    bench.press("escape up ctrl-c tab enter", cx);
    assert_eq!(bench.typed(), "\x1b\x1b[A\x03\t\r");
    assert!(bench.focused("terminal-grid", cx), "Tab kept the focus in the terminal");
    // ⌘K is the palette's, not a clear.
    bench.press("cmd-k", cx);
    assert!(bench.exists("command-palette", cx));
    bench.press("escape", cx);
    assert_eq!(bench.typed(), "\x1b\x1b[A\x03\t\r", "the palette's keys stayed out of it");
}

#[gpui_kit::test]
fn the_terminal_settings_take_effect_in_the_terminal(cx: &mut TestAppContext) {
    let mut bench = Bench::open(&["s1"], &[("s1", &["r1"])], cx);
    bench.press("ctrl-`", cx);
    bench.output("s1", "r1", 1, "$ ", cx);
    // Option as Meta off: ⌥B is Option's character, not Meta-B.
    bench.press("alt-b", cx);
    assert!(!bench.typed().contains("\x1bb"), "{:?}", bench.typed());
    bench.set_preferences(|preferences, cx| preferences.set_terminal_option_as_meta(true, cx), cx);
    bench.press("alt-b", cx);
    assert!(bench.typed().ends_with("\x1bb"), "Meta-B: {:?}", bench.typed());
    bench.set_preferences(|preferences, cx| preferences.set_terminal_option_as_meta(false, cx), cx);
    bench.press("alt-b", cx);
    assert!(bench.typed().ends_with("\x1bb") && bench.typed().matches("\x1bb").count() == 1);

    // Blinking cursor: the terminal's cursor blinks by default, and not
    // once the setting is off.
    let blinking = |cx: &mut TestAppContext| {
        bench.harness.workbench.read_with(cx, |workbench, cx| {
            let terminal = workbench.terminal_view().read(cx).active_terminal(cx).expect("r1");
            terminal.read(cx).content().cursor.blinking
        })
    };
    assert!(blinking(cx));
    bench.set_preferences(|preferences, cx| preferences.set_terminal_cursor_blink(false, cx), cx);
    assert!(!blinking(cx));
}

#[gpui_kit::test]
fn zooming_recomputes_a_terminals_grid(cx: &mut TestAppContext) {
    let bench = Bench::open(&["s1"], &[("s1", &["r1"])], cx);
    cx.simulate_window_resize(bench.harness.window.into(), size(px(1600.), px(900.)));
    bench.press("ctrl-`", cx);
    let before = *bench.resizes().last().expect("the grid from the bounds");
    bench.press("cmd-=", cx);
    let after = *bench.resizes().last().expect("resized");
    // The panel's width zooms with the cells; its height is the window's.
    assert!(after < before, "larger cells, fewer rows: {before} → {after}");
}

/// The Files face: between Changes and Terminal in [+], opened there and
/// with ⌘P, its tab remembered for the task, and its list read as it
/// shows.
#[gpui_kit::test]
fn files_open_from_the_add_menu_and_cmd_p_between_changes_and_terminal(cx: &mut TestAppContext) {
    let bench = Bench::open(&["s1", "s2"], &[], cx);
    bench.harness.transport.set_artifacts("s1", vec![artifact("s1", "a1", "brief.md")]);
    bench.click("review-toggle", cx);
    bench.click("workbar-add", cx);
    assert_eq!(bench.menu_item("workbar-tool-files", cx), Some(false));
    let tops = bench.harness.with_window(cx, |window, _| {
        ["workbar-tool-changes", "workbar-tool-files", "workbar-tool-terminal"]
            .map(|key| window.find(shared::domain_element_id("menu-item", key)).bounds().top())
    });
    assert!(tops[0] < tops[1] && tops[1] < tops[2], "Files between Changes and Terminal");
    bench.click(shared::domain_element_id("menu-item", "workbar-tool-files"), cx);
    assert_eq!(
        bench.tabs(cx),
        [("changes".into(), "Changes".into(), false), ("files".into(), "Files".into(), true)]
    );
    assert!(bench.exists(shared::domain_element_id("files-row", "a1"), cx), "read as it shows");
    assert!(bench.focused("files-list", cx));
    let open = |cx: &mut TestAppContext| {
        cx.update(|cx| AppPreferences::global(cx).read(cx).is_files_face_open("s1"))
    };
    assert!(open(cx), "the task remembers its Files face");

    // ⌘P while the files show hides the panel; again shows them, focused.
    bench.press("cmd-p", cx);
    assert!(!bench.open_workbar(cx));
    bench.press("cmd-p", cx);
    assert!(bench.open_workbar(cx));
    assert_eq!(bench.tabs(cx)[1], ("files".into(), "Files".into(), true));
    assert!(bench.focused("files-list", cx));
    // On Changes, ⌘P comes back to the files.
    bench.click(tab("changes"), cx);
    bench.press("cmd-p", cx);
    assert_eq!(bench.tabs(cx)[1], ("files".into(), "Files".into(), true));
    // Another task has its own files; its face is not open.
    bench.select("s2", cx);
    assert_eq!(bench.tabs(cx), [("changes".into(), "Changes".into(), true)]);
    bench.press("cmd-p", cx);
    assert!(bench.exists("files-empty", cx), "s2 has none");
    // Unmarking it in [+] closes the face.
    bench.click("workbar-add", cx);
    bench.click(shared::domain_element_id("menu-item", "workbar-tool-files"), cx);
    assert_eq!(bench.tabs(cx), [("changes".into(), "Changes".into(), true)]);
    assert!(!cx.update(|cx| AppPreferences::global(cx).read(cx).is_files_face_open("s2")));
}

#[gpui_kit::test]
fn escape_in_the_file_list_gives_the_composer_its_place_back(cx: &mut TestAppContext) {
    let bench = Bench::open(&["s1"], &[], cx);
    bench.press("cmd-p", cx);
    assert!(bench.open_workbar(cx));
    assert!(bench.focused("files-list", cx));
    bench.press("escape", cx);
    assert!(!bench.open_workbar(cx));
    let draft = bench.harness.draft_id(cx);
    let focused = bench.harness.with_window(cx, |window, _| window.find(draft).focused());
    assert_eq!(focused, Some(true));
}

#[gpui_kit::test]
fn a_settled_turn_reads_the_files_again(cx: &mut TestAppContext) {
    let mut bench = Bench::open(&["s1"], &[], cx);
    bench.press("cmd-p", cx);
    let lists = |bench: &Bench| {
        bench
            .harness
            .transport
            .requests("artifact.query")
            .iter()
            .filter(|input| input["kind"] == "list_start")
            .count()
    };
    let before = lists(&bench);
    bench.harness.project("s1", crate::tests::root("t1", "r1", "running"), cx);
    bench.frame(cx);
    assert_eq!(lists(&bench), before);
    bench.harness.transport.set_artifacts("s1", vec![artifact("s1", "a1", "late.md")]);
    bench.harness.project("s1", crate::tests::root("t1", "r1", "completed"), cx);
    bench.frame(cx);
    assert_eq!(lists(&bench), before + 1);
    assert!(bench.exists(shared::domain_element_id("files-row", "a1"), cx));
}

/// The Trace face: after Files in [+], with no shortcut, opened there and
/// remembered for the task; read as it shows; a usage change of the task
/// refreshes its summary while it shows and not once it is hidden behind
/// another tab; Escape in it gives the composer its place back.
#[gpui_kit::test]
fn the_trace_opens_from_the_add_menu_after_files(cx: &mut TestAppContext) {
    let mut bench = Bench::open(&["s1", "s2"], &[], cx);
    bench.click("review-toggle", cx);
    bench.click("workbar-add", cx);
    assert_eq!(bench.menu_item("workbar-tool-inspector", cx), Some(false));
    let tops = bench.harness.with_window(cx, |window, _| {
        ["workbar-tool-files", "workbar-tool-inspector", "workbar-tool-terminal"]
            .map(|key| window.find(shared::domain_element_id("menu-item", key)).bounds().top())
    });
    assert!(tops[0] < tops[1] && tops[1] < tops[2], "Trace between Files and Terminal");
    bench.click(shared::domain_element_id("menu-item", "workbar-tool-inspector"), cx);
    assert_eq!(
        bench.tabs(cx),
        [("changes".into(), "Changes".into(), false), ("inspector".into(), "Trace".into(), true)]
    );
    assert!(bench.exists("inspector-face", cx));
    assert!(bench.exists("inspector-empty", cx), "s1 has not run");
    assert!(bench.focused("inspector-face", cx));
    let summaries = |bench: &Bench| bench.harness.transport.requests("usage.query").len();
    assert_eq!(summaries(&bench), 1, "read as it shows");
    assert!(cx.update(|cx| AppPreferences::global(cx).read(cx).is_inspector_face_open("s1")));

    bench.harness.domain_changed("s1", "usage", cx);
    cx.executor().advance_clock(inspector::REFRESH_DEBOUNCE * 2);
    bench.frame(cx);
    assert_eq!(summaries(&bench), 2, "the task's usage changed while the face shows");

    // Behind the Changes tab the face is hidden: nothing refreshes.
    bench.click(tab("changes"), cx);
    bench.harness.domain_changed("s1", "usage", cx);
    cx.executor().advance_clock(inspector::REFRESH_DEBOUNCE * 2);
    bench.frame(cx);
    assert_eq!(summaries(&bench), 2);

    // Escape in the face hides the panel and focuses the composer.
    bench.click(tab("inspector"), cx);
    bench.press("escape", cx);
    assert!(!bench.open_workbar(cx));

    // Unmarking it in [+] closes the face; another task's is not open.
    bench.click("review-toggle", cx);
    bench.click("workbar-add", cx);
    assert_eq!(bench.menu_item("workbar-tool-inspector", cx), Some(true));
    bench.click(shared::domain_element_id("menu-item", "workbar-tool-inspector"), cx);
    assert_eq!(bench.tabs(cx), [("changes".into(), "Changes".into(), true)]);
    bench.select("s2", cx);
    assert!(!cx.update(|cx| AppPreferences::global(cx).read(cx).is_inspector_face_open("s2")));
}
