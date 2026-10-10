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

//! UI integration tests of the terminal view in a headless window, against
//! the scripted Host of [`crate::tests`]: keys, text, pastes and the IME
//! reach the program; the selection and the clipboard; the wheel; find;
//! the grid following the bounds and the zoom; the tabs' order and marks;
//! closing; the line each state shows; links under ⌘; the scrollbar; and
//! the cursor's blink.

use gpui_kit::component::Root;
use gpui_kit::component::scroll::ScrollbarHandle as _;
use gpui_kit::test::{ClickOptions, TestWindowExt as _};
use gpui_kit::{
    App, AppContext as _, ClipboardItem, Entity, EntityInputHandler as _, InputEvent as _,
    Modifiers, ModifiersChangedEvent, MouseMoveEvent, Pixels, Point, ScrollDelta, ScrollWheelEvent,
    TestAppContext, VisualTestContext, Window, WindowHandle, point, px, size,
};
use host_protocol::HostOperationErrorCode;
use serde_json::{Value, json};

use crate::tests::{
    Harness, OTHER, SESSION, ScriptedHost, acquire_result, get_result, operation_error, reference,
    settle, terminal_resource,
};
use crate::view::{BLINK_INTERVAL, BLINK_PAUSE, GridGeometry};
use crate::{CloseState, StartState, Terminal, TerminalView};

struct View {
    harness: Harness,
    view: Entity<TerminalView>,
    window: WindowHandle<Root>,
}

impl View {
    /// A window showing the terminal view of `SESSION`, whose terminals are
    /// `inventory`, attached once `script` has scripted the Host.
    fn open_with(
        inventory: Vec<Value>,
        script: impl FnOnce(&ScriptedHost),
        cx: &mut TestAppContext,
    ) -> Self {
        cx.update(|cx| {
            gpui_kit::init(cx);
            search::init(cx);
            crate::init(cx);
        });
        let harness = Harness::new(inventory, cx);
        script(&harness.transport);
        let terminals = harness.terminals.clone();
        let mut view = None;
        let window = cx.open_window(size(px(900.), px(600.)), |window, cx| {
            let terminal_view = cx.new(|cx| TerminalView::new(terminals, window, cx));
            view = Some(terminal_view.clone());
            Root::new(terminal_view, window, cx)
        });
        let this = Self { harness, view: view.expect("view"), window };
        this.harness.show(cx);
        this.frame(cx);
        this
    }

    fn open(inventory: Vec<Value>, cx: &mut TestAppContext) -> Self {
        Self::open_with(inventory, |_| {}, cx)
    }

    /// One running terminal, focused.
    fn focused(cx: &mut TestAppContext) -> Self {
        let this = Self::open(vec![terminal_resource(SESSION, "r1", "running")], cx);
        this.focus(cx);
        this
    }

    /// One running terminal, focused, in the active window (a test window
    /// is inactive until activated).
    fn active(cx: &mut TestAppContext) -> Self {
        let this = Self::open(vec![terminal_resource(SESSION, "r1", "running")], cx);
        this.with_window(cx, |window, _| window.activate_window());
        this.focus(cx);
        this
    }

    /// Draws a frame, lets what it set off settle, and draws again.
    fn frame(&self, cx: &mut TestAppContext) {
        self.with_window(cx, |_, _| {});
    }

    fn with_window<R>(
        &self,
        cx: &mut TestAppContext,
        f: impl FnOnce(&mut Window, &mut App) -> R,
    ) -> R {
        let result = cx
            .update_window(self.window.into(), |_, window, cx| {
                window.render_frame(cx);
                f(window, cx)
            })
            .expect("window");
        settle(cx);
        cx.update_window(self.window.into(), |_, window, cx| window.render_frame(cx))
            .expect("window");
        settle(cx);
        result
    }

    fn focus(&self, cx: &mut TestAppContext) {
        let view = self.view.clone();
        self.with_window(cx, |window, cx| view.update(cx, |view, cx| view.focus(window, cx)));
    }

    fn press(&self, keys: &str, cx: &mut TestAppContext) {
        for key in keys.split(' ') {
            self.with_window(cx, |window, cx| window.press(key, cx));
        }
    }

    fn terminal(&self, cx: &mut TestAppContext) -> Entity<Terminal> {
        self.view.read_with(cx, |view, cx| view.active_terminal(cx)).expect("a terminal")
    }

    fn output(&self, sequence: u64, data: &str, cx: &mut TestAppContext) {
        self.harness.output("r1", sequence, data, cx);
        self.frame(cx);
    }

    /// Everything typed into the PTYs so far.
    fn typed(&self) -> String {
        self.harness
            .controls()
            .into_iter()
            .filter_map(|(_, control)| control["input"].as_str().map(str::to_owned))
            .collect()
    }

    fn resizes(&self) -> Vec<(u64, u64)> {
        self.harness
            .controls()
            .into_iter()
            .filter(|(_, control)| control["kind"] == "resize")
            .map(|(_, control)| {
                (control["cols"].as_u64().expect("cols"), control["rows"].as_u64().expect("rows"))
            })
            .collect()
    }

    fn geometry(&self, cx: &mut TestAppContext) -> GridGeometry {
        self.view.read_with(cx, |view, _| view.geometry()).expect("painted")
    }

    /// The middle of the left half of the cell at `column`, `row`, from the
    /// grid's corner.
    fn offset(&self, column: usize, row: usize, cx: &mut TestAppContext) -> Point<Pixels> {
        let geometry = self.geometry(cx);
        point(
            geometry.cell.width * (column as f32 + 0.25),
            geometry.cell.height * (row as f32 + 0.5),
        )
    }

    fn click(&self, column: usize, row: usize, options: ClickOptions, cx: &mut TestAppContext) {
        let offset = self.offset(column, row, cx);
        self.with_window(cx, |window, cx| {
            window.click_with_options("terminal-grid", options.with_offset(offset), cx);
        });
    }

    fn clipboard(&self, cx: &mut TestAppContext) -> Option<String> {
        cx.read_from_clipboard().and_then(|item| item.text())
    }

    fn display_offset(&self, cx: &mut TestAppContext) -> usize {
        let terminal = self.terminal(cx);
        terminal.read_with(cx, |terminal, _| terminal.content().display_offset)
    }

    /// The line a state shows, by its key, when it shows.
    fn line(&self, key: &str, cx: &mut TestAppContext) -> Option<String> {
        let id = shared::domain_element_id("settings-status", key);
        self.with_window(cx, |window, _| {
            window.try_find(id).and_then(|line| line.label().map(str::to_owned))
        })
    }

    fn exists(&self, id: &'static str, cx: &mut TestAppContext) -> bool {
        self.with_window(cx, |window, _| window.try_find(id).is_some())
    }

    /// The pointer moves to the cell at `column`, `row` with `modifiers`.
    fn hover(&self, column: usize, row: usize, modifiers: Modifiers, cx: &mut TestAppContext) {
        let position = self.geometry(cx).origin + self.offset(column, row, cx);
        self.with_window(cx, |window, cx| {
            let event = MouseMoveEvent { position, pressed_button: None, modifiers };
            window.dispatch_event(event.to_platform_input(), cx);
        });
    }

    /// ⌘ (Control elsewhere) goes down or comes up, the pointer still.
    fn hold_command(&self, held: bool, cx: &mut TestAppContext) {
        let modifiers = if held { Modifiers::secondary_key() } else { Modifiers::default() };
        self.with_window(cx, |window, cx| {
            let event = ModifiersChangedEvent { modifiers, capslock: Default::default() };
            window.dispatch_event(event.to_platform_input(), cx);
        });
    }

    fn command_click(&self, column: usize, row: usize, cx: &mut TestAppContext) {
        let options = ClickOptions::new().with_modifiers(Modifiers::secondary_key());
        self.click(column, row, options, cx);
    }

    fn underlined(&self, cx: &mut TestAppContext) -> Option<String> {
        self.view.read_with(cx, |view, cx| view.underlined_link(cx)).map(|link| link.url)
    }

    /// Whether the cursor shows in this phase of its blink, and whether it
    /// blinks.
    fn blink(&self, cx: &mut TestAppContext) -> (bool, bool) {
        self.view.read_with(cx, |view, _| view.cursor_blink_state())
    }
}

fn lines(count: usize, special: (usize, &str)) -> String {
    (0..count)
        .map(|n| if n == special.0 { special.1.to_owned() } else { format!("line {n}") })
        .collect::<Vec<_>>()
        .join("\r\n")
}

#[gpui_kit::test]
fn text_and_keys_reach_the_program(cx: &mut TestAppContext) {
    let view = View::focused(cx);
    view.with_window(cx, |window, cx| window.input("ls", cx));
    view.press("enter escape up ctrl-c ctrl-r", cx);
    assert_eq!(view.typed(), "ls\r\x1b\x1b[A\x03\x12");
}

#[gpui_kit::test]
fn tab_goes_to_the_program_and_focus_stays(cx: &mut TestAppContext) {
    let view = View::focused(cx);
    view.press("tab shift-tab", cx);
    assert_eq!(view.typed(), "\t\x1b[Z");
    let focused = view.with_window(cx, |window, _| window.find("terminal-grid").focused());
    assert_eq!(focused, Some(true));
}

#[gpui_kit::test]
fn a_paste_is_bracketed_when_the_program_asks(cx: &mut TestAppContext) {
    let view = View::focused(cx);
    cx.write_to_clipboard(ClipboardItem::new_string("echo hi\n".into()));
    view.press("cmd-v", cx);
    assert_eq!(view.typed(), "echo hi\r");
    view.output(1, "\x1b[?2004h", cx);
    view.press("cmd-v", cx);
    assert_eq!(view.typed(), "echo hi\r\x1b[200~echo hi\n\x1b[201~");
}

#[gpui_kit::test]
fn the_pointer_selects_and_copy_takes_the_selection(cx: &mut TestAppContext) {
    let view = View::focused(cx);
    view.output(1, "hello world", cx);
    // To the left half of the sixth cell: the fifth is the last selected.
    let (from, to) = (view.offset(0, 0, cx), view.offset(5, 0, cx));
    let origin = view.geometry(cx).origin;
    view.with_window(cx, |window, cx| window.drag(origin + from, origin + to, cx));
    view.press("cmd-c", cx);
    assert_eq!(view.clipboard(cx).as_deref(), Some("hello"));

    view.click(7, 0, ClickOptions::new().with_count(2), cx);
    view.press("cmd-c", cx);
    assert_eq!(view.clipboard(cx).as_deref(), Some("world"), "a double click takes the word");

    view.click(2, 0, ClickOptions::new().with_count(3), cx);
    view.press("cmd-c", cx);
    assert_eq!(view.clipboard(cx).as_deref(), Some("hello world\n"), "a triple click the line");

    view.click(6, 0, ClickOptions::new(), cx);
    let shift = Modifiers { shift: true, ..Modifiers::default() };
    view.click(11, 0, ClickOptions::new().with_modifiers(shift), cx);
    view.press("cmd-c", cx);
    assert_eq!(view.clipboard(cx).as_deref(), Some("world"), "Shift-click extends it");

    // A click alone selects nothing, and ⌘C then leaves the clipboard be.
    cx.write_to_clipboard(ClipboardItem::new_string("kept".into()));
    view.click(3, 0, ClickOptions::new(), cx);
    view.press("cmd-c", cx);
    assert_eq!(view.clipboard(cx).as_deref(), Some("kept"));
    assert_eq!(view.typed(), "", "nothing of this reached the program");
}

#[gpui_kit::test]
fn select_all_takes_the_scrollback_too(cx: &mut TestAppContext) {
    let view = View::focused(cx);
    view.output(1, &lines(40, (0, "first")), cx);
    view.press("cmd-a cmd-c", cx);
    let copied = view.clipboard(cx).expect("copied");
    assert!(copied.starts_with("first\n"), "{copied:?}");
    assert!(copied.contains("line 39"), "{copied:?}");
}

#[gpui_kit::test]
fn the_wheel_scrolls_the_scrollback_and_moves_a_full_screen_program(cx: &mut TestAppContext) {
    let view = View::focused(cx);
    view.output(1, &lines(60, (0, "first")), cx);
    let wheel = |delta: ScrollDelta, view: &View, cx: &mut TestAppContext| {
        let position = view.geometry(cx).origin + view.offset(3, 3, cx);
        view.with_window(cx, |window, cx| {
            let event = ScrollWheelEvent { position, delta, ..ScrollWheelEvent::default() };
            window.dispatch_event(event.to_platform_input(), cx);
        });
    };
    wheel(ScrollDelta::Lines(gpui_kit::point(0., 3.)), &view, cx);
    assert_eq!(view.display_offset(cx), 3);
    // A trackpad's pixels add up into lines.
    let height = view.geometry(cx).cell.height;
    wheel(ScrollDelta::Pixels(point(px(0.), height * 1.5)), &view, cx);
    assert_eq!(view.display_offset(cx), 4);
    wheel(ScrollDelta::Pixels(point(px(0.), height * 1.5)), &view, cx);
    assert_eq!(view.display_offset(cx), 6);

    // New output while scrolled up keeps what shows in place.
    let shown = view.terminal(cx).read_with(cx, |terminal, _| terminal.content().text());
    view.output(2, "\r\nmore\r\nand more", cx);
    let still = view.terminal(cx).read_with(cx, |terminal, _| terminal.content().text());
    assert_eq!(shown, still);
    assert_eq!(view.display_offset(cx), 8);
    // ⌘End goes back to the bottom; ⌘Home to the top.
    view.press("cmd-home", cx);
    assert!(view.display_offset(cx) > 30);
    view.press("cmd-end", cx);
    assert_eq!(view.display_offset(cx), 0);
    view.press("shift-pageup", cx);
    assert!(view.display_offset(cx) > 10, "a page");

    // On a full-screen program's screen with alternate scroll, the wheel is
    // arrow keys.
    view.output(3, "\x1b[?1049h\x1b[?1007h", cx);
    wheel(ScrollDelta::Lines(gpui_kit::point(0., 2.)), &view, cx);
    assert_eq!(view.typed(), "\x1b[A\x1b[A");
    view.press("shift-pageup", cx);
    assert_eq!(view.typed(), "\x1b[A\x1b[A\x1b[5;2~", "no scrollback: the program pages");
}

#[gpui_kit::test]
fn find_opens_on_cmd_f_and_finds_in_the_scrollback(cx: &mut TestAppContext) {
    let snapshot = lines(60, (2, "a needle here"));
    let view = View::open_with(
        vec![terminal_resource(SESSION, "r1", "running")],
        |host| {
            host.reply(
                "runtime.resource.controller.acquire",
                Ok(acquire_result(&json!("c"), 1, 1, &snapshot, 80, 24)),
            )
        },
        cx,
    );
    view.focus(cx);
    view.press("cmd-f", cx);
    assert!(view.view.read_with(cx, |view, _| view.is_find_open()));
    view.with_window(cx, |window, cx| window.input("needle", cx));
    let bar = view.view.read_with(cx, |view, _| view.find_bar().cloned()).expect("bar");
    let (count, matches) = bar
        .read_with(cx, |bar, cx| (bar.count_text(cx).map(|t| t.to_string()), bar.matches().len()));
    assert_eq!((count.as_deref(), matches), (Some("1/1"), 1));
    // The match is in the scrollback: the view scrolled to it.
    let found = bar.read_with(cx, |bar, _| bar.matches()[0]);
    let offset = view.display_offset(cx) as i32;
    assert!(found.start.line.0 < 0, "in the scrollback: {found:?}");
    assert!(found.start.line.0 + offset >= 0, "on screen at offset {offset}");
    let painted = view.view.read_with(cx, |view, _| view.painted_matches());
    assert_eq!(painted, 1);

    // Escape in the bar closes it and gives the terminal focus back.
    view.press("escape", cx);
    assert!(!view.view.read_with(cx, |view, _| view.is_find_open()));
    let focused = view.with_window(cx, |window, _| window.find("terminal-grid").focused());
    assert_eq!(focused, Some(true));
    assert_eq!(view.typed(), "", "the query and Escape stayed out of the program");
}

#[gpui_kit::test]
fn the_grid_follows_the_bounds_and_the_zoom(cx: &mut TestAppContext) {
    let view = View::focused(cx);
    let first = *view.resizes().last().expect("a resize from the bounds");
    let geometry = view.geometry(cx);
    assert_eq!((geometry.columns as u64, geometry.rows as u64), first);
    cx.simulate_window_resize(view.window.into(), size(px(600.), px(400.)));
    view.frame(cx);
    let smaller = *view.resizes().last().expect("resized");
    assert!(smaller.0 < first.0 && smaller.1 < first.1, "{first:?} → {smaller:?}");
    // The application zoom (⌘+) makes the cells larger: fewer fit.
    cx.update(|cx| shared::theme::set_ui_font_size(20, cx));
    view.frame(cx);
    let zoomed = *view.resizes().last().expect("resized");
    assert!(zoomed.0 < smaller.0 && zoomed.1 < smaller.1, "{smaller:?} → {zoomed:?}");
    let cell = view.geometry(cx).cell;
    assert!(cell.width > geometry.cell.width && cell.height > geometry.cell.height);
}

#[gpui_kit::test]
fn an_osc_52_write_reaches_the_clipboard(cx: &mut TestAppContext) {
    let view = View::focused(cx);
    view.output(1, "\x1b]52;c;aGk=\x07", cx);
    assert_eq!(view.clipboard(cx).as_deref(), Some("hi"));
}

#[gpui_kit::test]
fn the_ime_composes_at_the_cursor_and_commits_to_the_program(cx: &mut TestAppContext) {
    let view = View::focused(cx);
    view.output(1, "$ ", cx);
    let handle = view.view.clone();
    let bounds = view.with_window(cx, |window, cx| {
        handle.update(cx, |view, cx| {
            view.replace_and_mark_text_in_range(None, "ni", None, window, cx);
            assert_eq!(view.marked_text_range(window, cx), Some(0..2));
            let element = gpui_kit::Bounds::default();
            view.bounds_for_range(0..0, element, window, cx)
        })
    });
    let geometry = view.geometry(cx);
    let cursor = geometry.cursor.expect("cursor");
    assert_eq!(bounds, Some(cursor), "the candidates open at the cursor");
    assert_eq!(cursor.origin, geometry.origin + point(geometry.cell.width * 2., px(0.)));
    assert_eq!(view.typed(), "", "nothing goes while it composes");
    view.with_window(cx, |window, cx| {
        handle.update(cx, |view, cx| view.replace_text_in_range(None, "你", window, cx))
    });
    assert_eq!(view.typed(), "你");
    assert!(!view.view.read_with(cx, |view, _| view.is_composing()));
}

#[gpui_kit::test]
fn tabs_keep_their_open_order_and_show_the_title_bell_and_exit(cx: &mut TestAppContext) {
    let view = View::open(
        vec![
            terminal_resource(SESSION, "r1", "running"),
            terminal_resource(SESSION, "r2", "running"),
        ],
        cx,
    );
    let tabs = |cx: &mut TestAppContext| view.view.read_with(cx, |view, cx| view.tabs(cx));
    let titles: Vec<String> = tabs(cx).iter().map(|tab| tab.title.to_string()).collect();
    assert_eq!(titles, ["Terminal", "Terminal 2"]);
    view.output(1, "\x1b]0;vim\x07\x07", cx);
    let first = &tabs(cx)[0];
    assert_eq!((first.title.as_ref(), first.bell), ("vim", true));
    view.focus(cx);
    view.with_window(cx, |window, cx| window.input("q", cx));
    assert!(!tabs(cx)[0].bell, "the bell mark goes with the next input");

    // A reread list in another order does not reorder the tabs.
    view.harness.transport.set_inventory(
        SESSION,
        vec![
            terminal_resource(SESSION, "r2", "running"),
            terminal_resource(SESSION, "r1", "running"),
        ],
    );
    view.harness.terminals.update(cx, |terminals, cx| terminals.reload(cx));
    view.frame(cx);
    let refs: Vec<String> = tabs(cx).iter().map(|tab| tab.resource_ref.to_string()).collect();
    assert_eq!(refs, [reference("r1"), reference("r2")]);

    // Another task has its own terminals; back again, the order holds.
    view.harness.transport.set_inventory(OTHER, vec![terminal_resource(OTHER, "o1", "running")]);
    view.harness.select(OTHER, cx);
    view.frame(cx);
    let refs: Vec<String> = tabs(cx).iter().map(|tab| tab.resource_ref.to_string()).collect();
    assert_eq!(refs, [reference("o1")]);
    view.harness.select(SESSION, cx);
    view.frame(cx);
    let refs: Vec<String> = tabs(cx).iter().map(|tab| tab.resource_ref.to_string()).collect();
    assert_eq!(refs, [reference("r1"), reference("r2")]);
}

#[gpui_kit::test]
fn closing_stops_the_process_and_the_tab_goes_when_the_host_confirms(cx: &mut TestAppContext) {
    let view = View::focused(cx);
    let stop = view.harness.transport.hold("runtime.resource.stop");
    let resource_ref = reference("r1").into();
    view.view.update(cx, |view, cx| view.close(&resource_ref, cx));
    view.frame(cx);
    assert_eq!(view.harness.transport.requests("runtime.resource.stop").len(), 1);
    let tabs = view.view.read_with(cx, |view, cx| view.tabs(cx));
    assert_eq!(tabs[0].close, CloseState::Closing, "the tab waits for the Host");
    stop.try_send(Ok(json!({}))).expect("stop");
    view.frame(cx);
    assert!(view.view.read_with(cx, |view, cx| view.tabs(cx)).is_empty());
}

#[gpui_kit::test]
fn each_state_shows_its_line(cx: &mut TestAppContext) {
    // No terminal: the empty line, with New terminal.
    let view = View::open(Vec::new(), cx);
    assert_eq!(view.line("terminal-empty", cx).as_deref(), Some("No terminals in this task"));
    assert!(view.exists("terminal-new", cx));
    // The list being read, then failing, with Retry.
    let list = view.harness.transport.hold("runtime.resource.query");
    view.harness.terminals.update(cx, |terminals, cx| terminals.reload(cx));
    view.frame(cx);
    assert_eq!(view.line("terminal-loading", cx).as_deref(), Some("Loading terminals…"));
    list.try_send(Err(workspace::HostRequestError::Transport("refused".into()))).expect("list");
    view.frame(cx);
    let failed = view.line("terminal-load-failed", cx).expect("failed");
    assert!(failed.starts_with("Couldn’t read this task’s terminals."), "{failed}");
    assert!(view.exists("terminal-reload", cx));

    // Starts refused or failed, each dismissed.
    view.harness.transport.reply(
        "runtime.resource.start",
        operation_error(
            HostOperationErrorCode::InternalFailure,
            "Runtime Resource operation failed",
        ),
    );
    view.view.update(cx, |view, cx| view.new_terminal(cx));
    view.frame(cx);
    assert_eq!(
        view.line("terminal-host-restarting", cx).as_deref(),
        Some("The Host couldn’t start a shell and is restarting.")
    );
    view.with_window(cx, |window, cx| window.click("terminal-dismiss-start", cx));
    assert_eq!(view.line("terminal-host-restarting", cx), None);
    view.harness.transport.reply(
        "runtime.resource.start",
        operation_error(HostOperationErrorCode::InvalidRequest, "no workspace"),
    );
    view.view.update(cx, |view, cx| view.new_terminal(cx));
    view.frame(cx);
    let failed = view.line("terminal-start-failed", cx).expect("start failed");
    assert!(failed.starts_with("Couldn’t start a terminal."), "{failed}");
}

#[gpui_kit::test]
fn the_limit_of_live_terminals_shows_before_a_start(cx: &mut TestAppContext) {
    let inventory =
        (0..8).map(|n| terminal_resource(SESSION, &format!("r{n}"), "running")).collect();
    let view = View::open(inventory, cx);
    view.view.update(cx, |view, cx| view.new_terminal(cx));
    view.frame(cx);
    assert_eq!(
        view.harness.terminals.read_with(cx, |terminals, _| terminals.start_state().clone()),
        StartState::LimitReached
    );
    let line = view.line("terminal-limit", cx).expect("the limit");
    assert!(line.contains("limit of 8"), "{line}");
    assert!(view.harness.transport.requests("runtime.resource.start").is_empty());
}

#[gpui_kit::test]
fn a_terminals_phases_each_show_their_line(cx: &mut TestAppContext) {
    // Attaching, while the controller is being taken.
    let view = View::open_with(
        vec![terminal_resource(SESSION, "r1", "running")],
        |host| {
            host.hold("runtime.resource.controller.acquire");
        },
        cx,
    );
    assert_eq!(view.line("terminal-attaching", cx).as_deref(), Some("Connecting…"));

    // Held by another window or app, with Retry.
    let view = View::open_with(
        vec![terminal_resource(SESSION, "r1", "running")],
        |host| {
            host.reply(
                "runtime.resource.controller.acquire",
                operation_error(
                    HostOperationErrorCode::OperationConflict,
                    "Runtime Resource already has a connected controller",
                ),
            )
        },
        cx,
    );
    assert_eq!(
        view.line("terminal-held-elsewhere", cx).as_deref(),
        Some("This terminal is open in another window or app.")
    );
    view.with_window(cx, |window, cx| window.click("terminal-retry", cx));
    assert_eq!(view.line("terminal-held-elsewhere", cx), None, "attached on Retry");

    // Failed, with the reason and Retry.
    let view = View::open_with(
        vec![terminal_resource(SESSION, "r1", "running")],
        |host| {
            host.reply(
                "runtime.resource.controller.acquire",
                operation_error(HostOperationErrorCode::InvalidRequest, "bad controller"),
            )
        },
        cx,
    );
    let failed = view.line("terminal-attach-failed", cx).expect("failed");
    assert!(failed.starts_with("Couldn’t open this terminal."), "{failed}");

    // Exited: the code, the picture kept dimmed, and Restart.
    let view = View::focused(cx);
    view.output(1, "bye", cx);
    view.harness.transport.reply(
        "runtime.resource.query",
        get_result(SESSION, Some(terminal_resource(SESSION, "r1", "completed"))),
    );
    view.harness.changed(&[(SESSION, "r1")], cx);
    view.frame(cx);
    assert_eq!(view.line("terminal-exited", cx).as_deref(), Some("Process exited (0)"));
    assert!(
        view.terminal(cx).read_with(cx, |terminal, _| terminal.content().text()).starts_with("bye")
    );
    view.harness.transport.reply(
        "runtime.resource.start",
        Ok(json!({"resource": terminal_resource(SESSION, "r2", "running")["result"]})),
    );
    view.with_window(cx, |window, cx| window.click("terminal-restart", cx));
    let tabs = view.view.read_with(cx, |view, cx| view.tabs(cx));
    let refs: Vec<String> = tabs.iter().map(|tab| tab.resource_ref.to_string()).collect();
    assert_eq!(refs, [reference("r2")], "the exited one goes, the new one takes its place");
    assert_eq!(
        view.view.read_with(cx, |view, cx| view.active_ref(cx)).as_deref(),
        Some(reference("r2").as_str())
    );
}

#[gpui_kit::test]
fn a_web_address_underlines_only_while_command_is_held_and_opens_on_command_click(
    cx: &mut TestAppContext,
) {
    let view = View::focused(cx);
    view.output(1, "see https://example.com/x now", cx);
    view.hover(8, 0, Modifiers::default(), cx);
    assert_eq!(view.underlined(cx), None, "not without ⌘");
    view.hover(9, 0, Modifiers::secondary_key(), cx);
    assert_eq!(view.underlined(cx).as_deref(), Some("https://example.com/x"));
    view.hold_command(false, cx);
    assert_eq!(view.underlined(cx), None, "⌘ released");
    view.hold_command(true, cx);
    assert_eq!(view.underlined(cx).as_deref(), Some("https://example.com/x"), "⌘ pressed again");
    view.hover(1, 0, Modifiers::secondary_key(), cx);
    assert_eq!(view.underlined(cx), None, "off the address");

    assert_eq!(cx.opened_url(), None);
    view.command_click(12, 0, cx);
    assert_eq!(cx.opened_url().as_deref(), Some("https://example.com/x"));
    assert_eq!(view.typed(), "", "nothing reached the program");
}

#[gpui_kit::test]
fn a_file_url_or_a_path_is_no_link(cx: &mut TestAppContext) {
    let view = View::focused(cx);
    view.output(1, "file:///etc/hosts\r\n/usr/local/bin/tool", cx);
    view.hover(4, 0, Modifiers::secondary_key(), cx);
    assert_eq!(view.underlined(cx), None);
    view.command_click(4, 0, cx);
    view.command_click(6, 1, cx);
    assert_eq!(cx.opened_url(), None);
}

#[gpui_kit::test]
fn an_osc_8_hyperlink_opens_its_target(cx: &mut TestAppContext) {
    let view = View::focused(cx);
    view.output(1, "read \x1b]8;;https://example.com/docs\x1b\\the docs\x1b]8;;\x1b\\.", cx);
    view.hover(6, 0, Modifiers::secondary_key(), cx);
    assert_eq!(view.underlined(cx).as_deref(), Some("https://example.com/docs"));
    view.command_click(10, 0, cx);
    assert_eq!(cx.opened_url().as_deref(), Some("https://example.com/docs"));
}

#[gpui_kit::test]
fn a_command_click_is_never_a_mouse_report(cx: &mut TestAppContext) {
    let view = View::focused(cx);
    // Click reports in SGR encoding.
    view.output(1, "\x1b[?1000h\x1b[?1006hhttps://a.io", cx);
    view.command_click(3, 0, cx);
    view.command_click(20, 2, cx);
    assert_eq!(view.typed(), "", "⌘-clicks, on a link or not, go nowhere");
    assert_eq!(cx.opened_url().as_deref(), Some("https://a.io/"));
    view.click(3, 0, ClickOptions::new(), cx);
    assert_eq!(view.typed(), "\x1b[<0;4;1M\x1b[<0;4;1m", "a plain click is reported");
}

#[gpui_kit::test]
fn the_scrollbar_tracks_the_scrollback_drags_and_hides_on_the_alternate_screen(
    cx: &mut TestAppContext,
) {
    let view = View::focused(cx);
    view.output(1, &lines(60, (0, "first")), cx);
    let scroll = view.view.read_with(cx, |view, _| view.scroll_handle().clone());
    let (history, line_height) = {
        let terminal = view.terminal(cx);
        let history = terminal.read_with(cx, |terminal, _| terminal.content().history_size);
        (history, view.geometry(cx).cell.height)
    };
    assert!(history > 10, "{history}");
    assert!(view.view.read_with(cx, |view, cx| view.has_scrollbar(cx)));
    // At the bottom the content is scrolled by the whole scrollback.
    assert_eq!(scroll.offset().y, -(line_height * history as f32));
    let viewport = scroll.viewport_bounds();
    let boxed = view.with_window(cx, |window, _| window.find("terminal-box").bounds());
    assert_eq!(viewport, boxed, "over the terminal's box");
    assert_eq!(scroll.content_size().height, viewport.size.height + line_height * history as f32);
    // The wheel moves it with the scrollback.
    let position = view.geometry(cx).origin + view.offset(3, 3, cx);
    view.with_window(cx, |window, cx| {
        let delta = ScrollDelta::Lines(point(0., 3.));
        let event = ScrollWheelEvent { position, delta, ..ScrollWheelEvent::default() };
        window.dispatch_event(event.to_platform_input(), cx);
    });
    assert_eq!(view.display_offset(cx), 3);
    assert_eq!(scroll.offset().y, -(line_height * (history - 3) as f32));

    // Dragging the thumb to the top of its track scrolls to the top.
    let content = scroll.content_size().height;
    let length = (viewport.size.height / content * viewport.size.height)
        .max(px(48.))
        .min(viewport.size.height);
    let extent = content - viewport.size.height;
    let travel = viewport.size.height - length;
    let start = viewport.top() + travel * (-scroll.offset().y / extent);
    let x = viewport.right() - px(7.);
    let from = point(x, start + length / 2.);
    let to = point(x, viewport.top() - px(20.));
    view.with_window(cx, |window, cx| window.drag(from, to, cx));
    assert_eq!(view.display_offset(cx), history, "at the top of the scrollback");
    assert_eq!(scroll.offset().y, px(0.));
    assert_eq!(view.typed(), "");

    // A full-screen program's screen has no scrollback and no scrollbar.
    view.output(2, "\x1b[?1049h", cx);
    assert!(!view.view.read_with(cx, |view, cx| view.has_scrollbar(cx)));
}

#[gpui_kit::test]
fn the_cursor_blinks_on_a_timer_and_holds_still_after_input(cx: &mut TestAppContext) {
    let view = View::active(cx);
    view.output(1, "$ ", cx);
    let (shown, blinking) = view.blink(cx);
    assert!(blinking, "the setting's default: on");
    let step = |delay, cx: &mut TestAppContext| {
        cx.executor().advance_clock(delay);
        cx.run_until_parked();
    };
    step(BLINK_INTERVAL, cx);
    assert_eq!(view.blink(cx).0, !shown);
    step(BLINK_INTERVAL, cx);
    assert_eq!(view.blink(cx).0, shown);
    // Typing shows it and holds it still for the pause.
    if shown {
        step(BLINK_INTERVAL, cx);
    }
    assert!(!view.blink(cx).0, "hidden before the keystroke");
    cx.update_window(view.window.into(), |_, window, cx| window.input("x", cx)).expect("window");
    cx.run_until_parked();
    assert!(view.blink(cx).0, "shown by the keystroke");
    step(BLINK_PAUSE - std::time::Duration::from_millis(50), cx);
    assert!(view.blink(cx).0, "held");
    step(std::time::Duration::from_millis(50), cx);
    assert!(!view.blink(cx).0, "blinking again");
    assert_eq!(view.typed(), "x");
}

#[gpui_kit::test]
fn the_cursor_does_not_blink_unfocused_inactive_or_with_reduced_motion(cx: &mut TestAppContext) {
    let view = View::active(cx);
    view.output(1, "$ ", cx);
    assert!(view.blink(cx).1);
    view.with_window(cx, |window, cx| window.blur(cx));
    assert_eq!(view.blink(cx), (true, false), "unfocused: shown, still (and hollow)");
    view.focus(cx);
    assert!(view.blink(cx).1);
    VisualTestContext::from_window(view.window.into(), cx).deactivate_window();
    view.frame(cx);
    assert_eq!(view.blink(cx), (true, false), "the window is inactive");
    view.with_window(cx, |window, _| window.activate_window());
    assert!(view.blink(cx).1);
    cx.update(|cx| cx.set_reduce_motion(true));
    view.output(2, "a", cx);
    assert_eq!(view.blink(cx), (true, false), "reduced motion");
}

#[gpui_kit::test]
fn the_blink_follows_the_setting_and_the_programs_cursor_style(cx: &mut TestAppContext) {
    let view = View::active(cx);
    view.output(1, "$ ", cx);
    assert!(view.blink(cx).1);
    view.view.update(cx, |view, cx| view.set_cursor_blink(false, cx));
    view.frame(cx);
    assert_eq!(view.blink(cx), (true, false), "the setting off");
    // DECSCUSR 5, a blinking bar: the program's choice wins.
    view.output(2, "\x1b[5 q", cx);
    assert!(view.blink(cx).1, "the program asked for a blink");
    view.view.update(cx, |view, cx| view.set_cursor_blink(true, cx));
    // DECSCUSR 2, a steady block, with the setting on.
    view.output(3, "\x1b[2 q", cx);
    assert!(!view.blink(cx).1, "the program asked for a steady cursor");
    // DECSCUSR 0: the default again, the setting's.
    view.output(4, "\x1b[0 q", cx);
    assert!(view.blink(cx).1);
}
