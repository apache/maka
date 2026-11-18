//! `Terminal`'s input methods: what one composes is drawn at the cursor,
//! which is hidden while it lasts, and the hidden input that takes the
//! keyboard sits on the cursor's cell, where the platform opens the
//! candidates. A program that hides the cursor still composes where it is.
//! The program gets what a composition commits, once, at its end, in each
//! platform's order of events, and nothing of one cancelled.

use std::{
    sync::atomic::{AtomicU32, Ordering},
    time::Duration,
};

use nsh_base::{TerminalEmulator, TerminalEmulatorFactory, VtEmulator, terminal};
use nsh_core::{
    EventKind, EventPayload, NodeId, PayloadValue, Size, ViewKind,
    element::{Root, measure_text},
    prelude::*,
};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

/// A cell's width, as the harness measured it.
static CELL: AtomicU32 = AtomicU32::new(0);

#[derive(Clone, PartialEq, Props)]
struct HarnessProps {
    /// What the program wrote before the terminal was laid out.
    output: String,
}

/// A terminal 400 wide and five rows of 18 high, whose emulator has
/// `output` already, and under it what the terminal sent the program
/// (`Sent [..]`, each `Data` event's text).
#[component]
fn Harness(props: HarnessProps) -> impl IntoElement {
    let output = props.output.clone();
    let cell = measure_text("13px monospace", "0000000000") / 10.0;
    CELL.store(cell.0.to_bits(), Ordering::Relaxed);
    provide_context(TerminalEmulatorFactory::new(move |size, scrollback| {
        let mut vt = VtEmulator::new(size, scrollback);
        vt.feed(output.as_bytes());
        Box::new(vt)
    }));
    let sent = signal(Vec::<String>::new());
    view()
        .child(
            view().w(px(400.0)).h(px(18.0 * 5.0)).child(
                terminal()
                    .font_family("monospace")
                    .accessibility_label("Shell")
                    .flex_1()
                    .on_data(move |data: &SharedString| {
                        sent.update(|s| s.push(data.to_string()));
                    }),
            ),
        )
        .child(text(move || format!("Sent {:?}", sent.get())))
}

fn start(output: &str) -> Headless {
    let output = output.to_owned();
    let config = EngineConfig {
        viewport: Size::new(px(400.0), px(400.0)),
        ..EngineConfig::new(Root::new::<Harness>(move || HarnessProps {
            output: output.clone(),
        }))
    };
    let mut app = Headless::start(config).expect("the engine starts");
    app.wait_for("text:$ abc").unwrap();
    app
}

/// An input method's composition changing in the hidden input, as the
/// platform reports it. The driver has no composition step and does not
/// expose the input's node id, so the event goes to every node; only the
/// input listens to it.
fn compose(app: &mut Headless, composing: bool, text: &str) {
    for id in 1..4096 {
        app.engine().control().dispatch_event(
            id,
            EventKind::CompositionChange,
            EventPayload::Map(vec![
                ("composing", PayloadValue::Bool(composing)),
                ("text", PayloadValue::Str(text.to_owned())),
            ]),
        );
    }
    app.wait(Duration::from_millis(50)).unwrap();
}

/// Where the hidden input is, in the root's points.
fn input_at(app: &Headless) -> Point<Points> {
    let input = app
        .screen()
        .layout_nodes()
        .into_iter()
        .find(|n| n.kind == ViewKind::Input)
        .expect("the hidden input");
    input.bounds.origin
}

/// The hidden input, reporting a platform's events in the order it gives
/// them: its edits (`onChange`, the whole text with an edit count) and an
/// input method's composition.
struct Sink {
    id: NodeId,
    count: u32,
}

impl Sink {
    fn of(app: &Headless) -> Self {
        let id = app
            .screen()
            .layout_nodes()
            .into_iter()
            .find(|n| n.kind == ViewKind::Input)
            .expect("the hidden input")
            .id;
        Sink { id, count: 0 }
    }

    /// The input's text is now `text`.
    fn change(&mut self, app: &mut Headless, text: &str) {
        self.count += 1;
        app.engine().control().dispatch_event(
            self.id,
            EventKind::ChangeText,
            EventPayload::Text {
                text: text.to_owned(),
                count: self.count,
            },
        );
        app.wait(Duration::from_millis(20)).unwrap();
    }

    /// The composition started or changed to `text`, or ended.
    fn compose(&self, app: &mut Headless, composing: bool, text: &str) {
        app.engine().control().dispatch_event(
            self.id,
            EventKind::CompositionChange,
            EventPayload::Map(vec![
                ("composing", PayloadValue::Bool(composing)),
                ("text", PayloadValue::Str(text.to_owned())),
            ]),
        );
        app.wait(Duration::from_millis(20)).unwrap();
    }
}

/// What the terminal sent the program so far.
fn sent(app: &mut Headless) -> String {
    app.wait(Duration::from_millis(30)).unwrap();
    app.screen()
        .texts()
        .into_iter()
        .find_map(|t| t.strip_prefix("Sent "))
        .expect("the harness's record")
        .to_owned()
}

fn cell() -> f32 {
    f32::from_bits(CELL.load(Ordering::Relaxed))
}

#[test]
fn a_composition_is_drawn_at_the_cursor_and_the_input_sits_on_its_cell() {
    let mut app = start("$ abc");
    // The cursor is after `$ abc`: column 5 of the first row.
    let at = input_at(&app);
    // Layout places views on whole points.
    assert!(
        (at.x.0 - 5.0 * cell()).abs() < 0.5,
        "{at:?}, a cell {}",
        cell()
    );
    assert_eq!(at.y.0, 0.0);
    compose(&mut app, true, "ni hao");
    app.wait_for("text:ni hao").unwrap();
    compose(&mut app, false, "");
    app.wait_for_gone("text:ni hao", Duration::from_secs(2))
        .unwrap();
}

#[test]
fn the_input_follows_the_cursor_and_a_hidden_cursor_still_has_a_place() {
    let mut app = start("$ abc\r\n> \x1b[?25l");
    let at = input_at(&app);
    assert!((at.x.0 - 2.0 * cell()).abs() < 0.5, "{at:?}");
    assert_eq!(at.y.0, 18.0, "the second row");
    compose(&mut app, true, "ka");
    app.wait_for("text:ka").unwrap();
}

/// `list` as the harness records it.
fn record(list: &[&str]) -> String {
    format!("{list:?}")
}

#[test]
fn an_ios_composition_sends_only_what_it_commits() {
    // UIKit keeps the marked text in the field's text: each start or
    // change of the composition, then the text holding it; the commit's
    // text, then the end.
    let mut app = start("$ abc");
    let mut sink = Sink::of(&app);
    sink.compose(&mut app, true, "n");
    sink.change(&mut app, "n");
    sink.compose(&mut app, true, "ni");
    sink.change(&mut app, "ni");
    // Drawn at the cursor, not sent.
    app.wait_for("text:ni").unwrap();
    assert_eq!(sent(&mut app), record(&[]));
    sink.change(&mut app, "你");
    sink.compose(&mut app, false, "");
    assert_eq!(sent(&mut app), record(&["你"]));
    app.wait_for_gone("text:ni", Duration::from_secs(2))
        .unwrap();
    // Typing goes on from the committed text.
    sink.change(&mut app, "你a");
    assert_eq!(sent(&mut app), record(&["你", "a"]));
}

#[test]
fn an_ios_commit_of_the_marked_text_unchanged_is_sent_once() {
    let mut app = start("$ abc");
    let mut sink = Sink::of(&app);
    sink.compose(&mut app, true, "ni");
    sink.change(&mut app, "ni");
    // Return commits the letters: the same text again, then the end.
    sink.change(&mut app, "ni");
    assert_eq!(sent(&mut app), record(&[]));
    sink.compose(&mut app, false, "");
    assert_eq!(sent(&mut app), record(&["ni"]));
}

#[test]
fn an_ios_cancelled_composition_sends_nothing() {
    let mut app = start("$ abc");
    let mut sink = Sink::of(&app);
    sink.change(&mut app, "a");
    sink.compose(&mut app, true, "ka");
    sink.change(&mut app, "aka");
    // The marked text removed, then the end.
    sink.change(&mut app, "a");
    sink.compose(&mut app, false, "");
    assert_eq!(sent(&mut app), record(&["a"]));
    app.wait_for_gone("text:ka", Duration::from_secs(2))
        .unwrap();
    sink.change(&mut app, "ab");
    assert_eq!(sent(&mut app), record(&["a", "b"]));
}

#[test]
fn a_desktop_composition_sends_its_commit_once_and_a_cancel_nothing() {
    // Windows, GPUI, AppKit and GTK keep the composition out of the text
    // they report: no change while it composes; the commit's change, then
    // the end.
    let mut app = start("$ abc");
    let mut sink = Sink::of(&app);
    sink.change(&mut app, "a");
    sink.compose(&mut app, true, "n");
    sink.compose(&mut app, true, "ni");
    app.wait_for("text:ni").unwrap();
    sink.change(&mut app, "a你");
    sink.compose(&mut app, false, "");
    assert_eq!(sent(&mut app), record(&["a", "你"]));
    // Escape cancels: the end alone.
    sink.compose(&mut app, true, "hao");
    sink.compose(&mut app, false, "");
    assert_eq!(sent(&mut app), record(&["a", "你"]));
}

#[test]
fn an_android_composition_sends_each_committed_part_once() {
    // Android's composing span is in the text, as on iOS; a Japanese
    // input method commits 日本 while it goes on composing ご.
    let mut app = start("$ abc");
    let mut sink = Sink::of(&app);
    sink.compose(&mut app, true, "にほんご");
    sink.change(&mut app, "にほんご");
    sink.compose(&mut app, true, "ご");
    sink.change(&mut app, "日本ご");
    // What part is committed is not reported: all of it waits for the end.
    assert_eq!(sent(&mut app), record(&[]));
    sink.change(&mut app, "日本語");
    sink.compose(&mut app, false, "");
    assert_eq!(sent(&mut app), record(&["日本語"]));
}

#[test]
fn a_cancel_that_removes_text_matching_what_was_sent_sends_nothing() {
    let mut app = start("$ abc");
    let mut sink = Sink::of(&app);
    sink.change(&mut app, "abc");
    sink.compose(&mut app, true, "c");
    sink.change(&mut app, "abcc");
    // Cancelled: the marked `c` removed, then the end.
    sink.change(&mut app, "abc");
    sink.compose(&mut app, false, "");
    assert_eq!(sent(&mut app), record(&["abc"]));
}

#[test]
fn an_empty_composition_holds_back_what_changes_during_it() {
    let mut app = start("$ abc");
    let mut sink = Sink::of(&app);
    sink.change(&mut app, "a");
    sink.compose(&mut app, true, "");
    sink.change(&mut app, "ax");
    assert_eq!(sent(&mut app), record(&["a"]));
    sink.compose(&mut app, false, "");
    assert_eq!(sent(&mut app), record(&["a", "x"]));
}

/// The terminal's cursor views on the first row at column `col`: a cell
/// wide and a row high.
fn cursors_at(app: &Headless, col: f32) -> usize {
    app.screen()
        .layout_nodes()
        .into_iter()
        .filter(|n| {
            n.kind == ViewKind::View
                && (n.bounds.origin.x.0 - col * cell()).abs() < 0.5
                && n.bounds.origin.y.0 == 0.0
                && (n.bounds.size.width.0 - cell()).abs() < 0.5
                && n.bounds.size.height.0 == 18.0
        })
        .count()
}

#[test]
fn the_cursor_is_hidden_while_a_composition_lasts() {
    let mut app = start("$ abc");
    let sink = Sink::of(&app);
    app.wait(Duration::from_millis(30)).unwrap();
    // After `$ abc`: column 5.
    assert_eq!(cursors_at(&app, 5.0), 1);
    // A composition without text yet hides it as well.
    sink.compose(&mut app, true, "");
    app.wait(Duration::from_millis(30)).unwrap();
    assert_eq!(cursors_at(&app, 5.0), 0);
    sink.compose(&mut app, true, "ni hao");
    app.wait_for("text:ni hao").unwrap();
    assert_eq!(cursors_at(&app, 5.0), 0);
    assert_eq!(cursors_at(&app, 5.0 + 6.0), 0, "not after the composition");
    sink.compose(&mut app, false, "");
    app.wait_for_gone("text:ni hao", Duration::from_secs(2))
        .unwrap();
    assert_eq!(cursors_at(&app, 5.0), 1);
}

#[test]
fn typing_sends_each_character_and_a_composition_without_a_commit_nothing() {
    let mut app = start("$ abc");
    app.type_text("label:Shell", "ls").unwrap();
    assert_eq!(sent(&mut app), record(&["l", "s"]));
    // The driver's composition, ended with nothing committed.
    app.compose("label:Shell", "ni").unwrap();
    app.wait_for("text:ni").unwrap();
    app.compose("label:Shell", "").unwrap();
    assert_eq!(sent(&mut app), record(&["l", "s"]));
    app.type_text("label:Shell", " -a").unwrap();
    assert_eq!(sent(&mut app), record(&["l", "s", " ", "-", "a"]));
}
