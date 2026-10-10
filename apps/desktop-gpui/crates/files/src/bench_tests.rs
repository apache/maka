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

//! How long colouring large code takes: an ignored test, run by hand in
//! the dev build (`cargo test -p files --locked bench -- --ignored
//! --nocapture`), each surface in a headless window with the app's theme.
//!
//! - The Files source view: the kit's editor showing 10,000 and 3,000
//!   lines of Rust, and the same as plain text, which tells the colouring
//!   apart from the editor's own work: the main thread's part (making the
//!   state and the first frame, then a frame once coloured) and the
//!   background parse.
//! - The kit's Diff with a 10,000-line new file, every line added: the
//!   first frame, the background preparation (syntax and word changes), a
//!   coloured frame.
//! - A reply's code block of 100, 1,000 and 3,000 lines growing by a line,
//!   as a streaming reply's commit grows it: the frame after the commit,
//!   tagged `rust` and untagged, whose difference is the highlighting.
//!
//! The test dispatcher runs background work on this thread, so its wall
//! time is the work's. The dev build compiles the grammars without
//! optimisation, so these are upper bounds of a release build's times.

use std::fmt::Write as _;
use std::time::{Duration, Instant};

use gpui_kit::base::{TextView, TextViewState};
use gpui_kit::component::Root;
use gpui_kit::component::diff::{Diff, DiffFile, DiffState};
use gpui_kit::component::input::{Editor, EditorState};
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{
    AppContext as _, Context, Entity, IntoElement, ParentElement as _, Render, Styled as _,
    TestAppContext, Window, WindowHandle, div, px, size,
};

/// The surface under measure.
#[derive(Default)]
struct Shown {
    editor: Option<Entity<EditorState>>,
    diff: Option<Entity<DiffState>>,
    text: Option<Entity<TextViewState>>,
}

impl Render for Shown {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .size_full()
            .children(self.editor.as_ref().map(|editor| Editor::new(editor).size_full()))
            .children(self.diff.as_ref().map(|diff| Diff::new(diff).size_full()))
            .children(self.text.as_ref().map(|text| TextView::new(text).w_full()))
    }
}

/// `lines` lines of ordinary Rust: functions, strings, comments, types,
/// and a macro, whose body the Rust grammar parses again as Rust.
fn rust_source(lines: usize) -> String {
    let mut source = String::new();
    for n in 0..lines {
        match n % 4 {
            0 => writeln!(source, "// Item {n}, documented."),
            1 => writeln!(source, "pub fn item_{n}(x: u32) -> String {{"),
            2 => writeln!(source, "    format!(\"item {n}: {{}}\", x + {n}) // done"),
            _ => writeln!(source, "}}"),
        }
        .ok();
    }
    source
}

fn frame(window: WindowHandle<Root>, cx: &mut TestAppContext) -> Duration {
    let started = Instant::now();
    cx.update_window(window.into(), |_, window, cx| window.render_frame(cx)).expect("window");
    started.elapsed()
}

/// The background work queued now, run to its end after `debounce`.
fn background(debounce: Duration, cx: &mut TestAppContext) -> Duration {
    let started = Instant::now();
    cx.executor().advance_clock(debounce);
    cx.run_until_parked();
    started.elapsed()
}

/// Shows what `show` makes in the window and times it with the frame.
fn show(
    window: WindowHandle<Root>,
    shown: &Entity<Shown>,
    cx: &mut TestAppContext,
    show: impl FnOnce(&mut Shown, &mut Window, &mut Context<Shown>),
) -> Duration {
    let started = Instant::now();
    cx.update_window(window.into(), |_, window, cx| {
        shown.update(cx, |shown, cx| {
            *shown = Shown::default();
            show(shown, window, cx);
            cx.notify();
        });
        window.render_frame(cx);
    })
    .expect("window");
    started.elapsed()
}

#[gpui_kit::test]
#[ignore = "a measurement, run by hand"]
fn bench_colouring_large_code(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    cx.update(|cx| {
        gpui_kit::init(cx);
        shared::theme::apply_kit_theme(cx);
    });
    let mut shown = None;
    let window = cx.open_window(size(px(900.), px(800.)), |window, cx| {
        let view = cx.new(|_| Shown::default());
        shown = Some(view.clone());
        Root::new(view, window, cx)
    });
    let shown = shown.expect("view");
    frame(window, cx);

    // The Files source view. Past 256 KiB the editor parses only in the
    // background; under it, it tries for 2 ms on the main thread first.
    for (language, lines) in [("rust", 10_000), ("text", 10_000), ("rust", 3_000), ("text", 3_000)]
    {
        let text = rust_source(lines);
        let first = show(window, &shown, cx, |shown, window, cx| {
            shown.editor = Some(cx.new(|cx| {
                let mut editor =
                    EditorState::new(window, cx).language(language).default_value(text.clone());
                editor.set_readonly(true, cx);
                editor
            }));
        });
        let parse = background(Duration::from_millis(200), cx);
        let after = frame(window, cx);
        println!(
            "editor, {lines} lines of {language} ({} KB): state and first frame {first:?}; \
             background {parse:?}; a frame after {after:?}",
            text.len() / 1024,
        );
    }

    // The Diff, every line added.
    let source = rust_source(10_000);
    let patch = format!(
        "--- /dev/null\n+++ b/src/big.rs\n@@ -0,0 +1,{} @@\n{}",
        source.lines().count(),
        source.lines().map(|line| format!("+{line}\n")).collect::<String>()
    );
    let files = DiffFile::parse(&patch).expect("a diff");
    let first = show(window, &shown, cx, |shown, _, cx| {
        shown.diff = Some(cx.new(|cx| DiffState::new(files, cx)));
    });
    let prepare = background(Duration::ZERO, cx);
    let after = frame(window, cx);
    println!(
        "diff, 10000 added lines: state and first frame {first:?}; background preparation \
         {prepare:?}; a coloured frame {after:?}"
    );

    // A reply's code block growing by a line, tagged and untagged. The
    // second commit is measured: the first moves the text view onto its
    // background parser's copy of the blocks, which highlights each again.
    for lines in [100, 1_000, 3_000] {
        let mut times = Vec::new();
        for fence in ["rust", ""] {
            let markdown = format!("Here it is.\n\n```{fence}\n{}", rust_source(lines));
            show(window, &shown, cx, |shown, _, cx| {
                shown.text = Some(cx.new(|cx| TextViewState::markdown(&markdown, cx)));
            });
            background(Duration::ZERO, cx);
            frame(window, cx);
            let state = shown.read_with(cx, |shown, _| shown.text.clone()).expect("text");
            let mut grown = Duration::ZERO;
            for _ in 0..2 {
                state.update(cx, |state, cx| state.push_str("    x + 1;\n", cx));
                background(Duration::ZERO, cx);
                grown = frame(window, cx);
            }
            times.push(grown);
        }
        println!(
            "code block, {lines} lines: a commit's frame {:?} tagged rust, {:?} untagged",
            times[0], times[1]
        );
    }
}
