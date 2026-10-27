//! `Editor`'s go to definition and code actions: Mod held over a word asks
//! the app, whose answer underlines it (a hand over it) until Mod is
//! released, the pointer leaves it or the text changes; stale answers are
//! dropped; a Mod-click on the link asks with trigger `press` and keeps the
//! caret; F12 asks at the caret; Mod+. asks for code actions at the
//! selection.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use nsh_base::editor::{
    Editor, EditorApi, EditorCodeActionRequest, EditorCommand, EditorDefinitionRequest,
    EditorDefinitionTrigger, EditorPosition, EditorRange, EditorSelection, editor,
};
use nsh_core::{
    Cursor, EventKind, EventPayload, HoverEvent, MountItem, NodeId, PressEvent, Size,
    element::Root,
    keymap::Modifiers,
    platform::{Idiom, Os},
    prelude::*,
};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

/// The text: `alpha` and `beta` on row 0, `gamma` on row 1.
const TEXT: &str = "alpha beta\ngamma";

#[derive(Clone, PartialEq, Props)]
struct HarnessProps {
    /// Hover requests are answered at once with their word (else by the
    /// buttons).
    answer: bool,
}

fn position(p: EditorPosition) -> String {
    format!("{}:{}", p.line, p.column)
}

fn range(r: EditorRange) -> String {
    format!("{}-{}", position(r.start), position(r.end))
}

/// An editor of 600 × 400, and what the app heard: the last definition
/// request and how many, the last code action request, the selections.
#[component]
fn Harness(props: HarnessProps) -> impl IntoElement {
    let requests = signal(0u32);
    let last = signal(String::from("-"));
    let ids = signal((0u32, 0u32));
    let first_range = signal(EditorRange::default());
    let last_range = signal(EditorRange::default());
    let actions = signal(String::from("-"));
    let selections = signal(String::from("-"));
    let ed = component_ref::<Editor>();
    let api = move |f: &dyn Fn(&EditorApi)| {
        if let Some(api) = ed.api::<EditorApi>() {
            f(&api);
        }
    };
    let answer = props.answer;
    let button = move |id: &str, f: Box<dyn Fn(&EditorApi)>| {
        view()
            .test_id(id)
            .w(px(20.0))
            .h(px(20.0))
            .on_press(move || api(&*f))
    };
    let el = editor()
        .default_value(TEXT)
        .folding(false)
        .on_definition_request(move |e: &EditorDefinitionRequest| {
            requests.update(|n| *n += 1);
            let trigger = match e.trigger {
                EditorDefinitionTrigger::Hover => "hover",
                EditorDefinitionTrigger::Press => "press",
                EditorDefinitionTrigger::Key => "key",
            };
            last.set(format!(
                "{} {trigger} at {} [{}]",
                e.id,
                e.offset,
                range(e.range)
            ));
            if e.trigger == EditorDefinitionTrigger::Hover {
                ids.update(|(first, last)| {
                    if *first == 0 {
                        *first = e.id;
                        first_range.set(e.range);
                    }
                    *last = e.id;
                });
                last_range.set(e.range);
                if answer {
                    let (id, range) = (e.id, e.range);
                    api(&move |a| a.present_definition_link(id, range));
                }
            }
        })
        .on_code_action_request(move |e: &EditorCodeActionRequest| {
            actions.set(format!(
                "{} at {} {}",
                range(e.range),
                position(e.position),
                if e.bounds.is_some() {
                    "placed"
                } else {
                    "unplaced"
                }
            ))
        })
        .on_selection_change(move |s: &Vec<EditorSelection>| {
            let text: Vec<String> = s
                .iter()
                .map(|s| format!("{}>{}", position(s.anchor), position(s.head)))
                .collect();
            selections.set(text.join(","));
        })
        .component_ref(&ed)
        .size_full();
    view()
        .child(view().test_id("editor").w(px(600.0)).h(px(400.0)).child(el))
        .child(text(move || format!("Definitions {}", requests.get())))
        .child(text(move || format!("Definition {}", last.get())))
        .child(text(move || format!("Actions {}", actions.get())))
        .child(text(move || format!("Selections {}", selections.get())))
        .child(
            view()
                .flex_row()
                .child(button(
                    "present-first",
                    Box::new(move |a| {
                        a.present_definition_link(
                            ids.get_untracked().0,
                            first_range.get_untracked(),
                        )
                    }),
                ))
                .child(button(
                    "present-last",
                    Box::new(move |a| {
                        a.present_definition_link(ids.get_untracked().1, last_range.get_untracked())
                    }),
                ))
                .child(button("hide", Box::new(|a| a.hide_definition_link())))
                .child(button(
                    "go",
                    Box::new(|a| a.run(EditorCommand::GoToDefinition)),
                ))
                .child(button(
                    "actions",
                    Box::new(|a| a.run(EditorCommand::ShowCodeActions)),
                )),
        )
}

/// The cursors of the views that had the text's (the rows): whether each
/// had it, and its cursor now.
#[derive(Clone, Default)]
struct Cursors(Arc<Mutex<HashMap<NodeId, (bool, Cursor)>>>);

impl Cursors {
    /// How many of the rows' views show a hand.
    fn hands(&self) -> usize {
        self.0
            .lock()
            .unwrap()
            .values()
            .filter(|(text, c)| *text && *c == Cursor::Pointer)
            .count()
    }

    fn set(&self, id: NodeId, cursor: Cursor) {
        let mut all = self.0.lock().unwrap();
        let entry = all.entry(id).or_insert((false, cursor));
        entry.0 |= cursor == Cursor::Text;
        entry.1 = cursor;
    }
}

/// The harness of `props` on a Linux desktop's headless surface (`mod` is
/// Control), shown, with the cursors it sets followed.
fn start(answer: bool) -> (Headless, Cursors) {
    let props = HarnessProps { answer };
    let mut config = EngineConfig {
        viewport: Size::new(px(800.0), px(900.0)),
        ..EngineConfig::new(Root::new::<Harness>(move || props.clone()))
    };
    config.environment.os = Os::Linux;
    config.environment.idiom = Idiom::Desktop;
    let mut app = Headless::start(config).expect("the engine starts");
    let cursors = Cursors::default();
    let seen = cursors.clone();
    app.observe(move |_, batch| {
        for item in &batch.items {
            if let MountItem::ViewStyle { id, style } = item {
                seen.set(*id, style.cursor);
            }
        }
    });
    app.wait_for("text:Definitions 0").unwrap();
    (app, cursors)
}

fn see(app: &mut Headless, text: &str) {
    app.wait_for(&format!("text:{text}")).unwrap();
}

fn hands(app: &mut Headless, cursors: &Cursors, n: usize) {
    let cursors = cursors.clone();
    app.wait_until(
        &format!("{n} hand cursors"),
        Duration::from_secs(5),
        move |_| cursors.hands() == n,
    )
    .unwrap();
}

/// Control held (Mod on Linux), or nothing.
fn modifiers(ctrl: bool) -> Modifiers {
    Modifiers {
        ctrl,
        ..Modifiers::default()
    }
}

/// The view of the rows (what the mouse hovers and presses).
fn rows(app: &Headless) -> NodeId {
    app.screen()
        .press_target("text:alpha beta")
        .unwrap()
        .expect("the rows show")
}

/// The mouse at (`x`, `y`) of the rows: `alpha` starts at (0, 0), `gamma`
/// at (0, 20), each character wider than a point.
fn hover(app: &mut Headless, x: f32, y: f32, ctrl: bool) {
    let rows = rows(app);
    let at = Point::new(px(x), px(y));
    app.engine().control().dispatch_event(
        rows,
        EventKind::HoverMove,
        EventPayload::Hover(HoverEvent {
            position: at,
            page_position: at,
            modifiers: modifiers(ctrl),
        }),
    );
}

/// A click at (`x`, `y`) of the rows.
fn click(app: &mut Headless, x: f32, y: f32, ctrl: bool) {
    let rows = rows(app);
    let at = Point::new(px(x), px(y));
    let payload = EventPayload::Press(PressEvent {
        position: at,
        page_position: at,
        modifiers: modifiers(ctrl),
        clicks: 1,
    });
    let control = app.engine().control();
    for kind in [EventKind::PressDown, EventKind::PressUp, EventKind::Press] {
        control.dispatch_event(rows, kind, payload.clone());
    }
}

fn settle(app: &mut Headless) {
    app.wait(Duration::from_millis(100)).unwrap();
}

#[test]
fn mod_over_a_word_asks_and_the_answer_underlines_it_until_mod_is_released() {
    let (mut app, cursors) = start(true);
    // Without Mod the pointer asks nothing.
    hover(&mut app, 1.0, 5.0, false);
    settle(&mut app);
    assert!(app.shows("Definitions 0"));
    hover(&mut app, 1.0, 5.0, true);
    see(&mut app, "Definition 1 hover at 0 [0:0-0:5]");
    hands(&mut app, &cursors, 1);
    // Inside the link nothing more is asked.
    hover(&mut app, 2.0, 6.0, true);
    settle(&mut app);
    assert!(app.shows("Definitions 1"));
    // Mod released where the pointer rests: the link goes.
    hover(&mut app, 2.0, 6.0, false);
    hands(&mut app, &cursors, 0);
    // Held again: asked again.
    hover(&mut app, 2.0, 6.0, true);
    see(&mut app, "Definition 2 hover at 0 [0:0-0:5]");
    hands(&mut app, &cursors, 1);
}

#[test]
fn the_link_follows_the_pointer_and_goes_when_it_leaves() {
    let (mut app, cursors) = start(true);
    hover(&mut app, 1.0, 5.0, true);
    see(&mut app, "Definition 1 hover at 0 [0:0-0:5]");
    hands(&mut app, &cursors, 1);
    // Another word: asked about at once.
    hover(&mut app, 1.0, 25.0, true);
    see(&mut app, "Definition 2 hover at 11 [1:0-1:5]");
    hands(&mut app, &cursors, 1);
    // Past the line's end there is no word.
    hover(&mut app, 500.0, 25.0, true);
    hands(&mut app, &cursors, 0);
    hover(&mut app, 1.0, 25.0, true);
    see(&mut app, "Definition 3 hover at 11 [1:0-1:5]");
    hands(&mut app, &cursors, 1);
    // The mouse leaves the rows.
    let rows = rows(&app);
    app.engine()
        .control()
        .dispatch_event(rows, EventKind::HoverOut, EventPayload::None);
    hands(&mut app, &cursors, 0);
}

#[test]
fn stale_answers_are_dropped_and_an_edit_hides_the_link() {
    let (mut app, cursors) = start(false);
    hover(&mut app, 1.0, 5.0, true);
    see(&mut app, "Definition 1 hover at 0 [0:0-0:5]");
    hover(&mut app, 1.0, 25.0, true);
    see(&mut app, "Definition 2 hover at 11 [1:0-1:5]");
    // The answer to the first request comes after the second was made.
    app.press("id:present-first").unwrap();
    settle(&mut app);
    assert_eq!(cursors.hands(), 0);
    app.press("id:present-last").unwrap();
    hands(&mut app, &cursors, 1);
    app.press("id:hide").unwrap();
    hands(&mut app, &cursors, 0);
    // Hiding dropped the request: its answer underlines nothing now.
    app.press("id:present-last").unwrap();
    settle(&mut app);
    assert_eq!(cursors.hands(), 0);
    // Asked again, answered, then the text changes.
    hover(&mut app, 500.0, 25.0, true);
    hover(&mut app, 1.0, 25.0, true);
    see(&mut app, "Definition 3 hover at 11 [1:0-1:5]");
    app.press("id:present-last").unwrap();
    hands(&mut app, &cursors, 1);
    app.type_text("id:editor", "x").unwrap();
    hands(&mut app, &cursors, 0);
    app.press("id:present-last").unwrap();
    settle(&mut app);
    assert_eq!(cursors.hands(), 0);
}

#[test]
fn a_mod_click_on_the_link_asks_and_keeps_the_caret() {
    let (mut app, cursors) = start(true);
    app.type_text("id:editor", "").unwrap();
    app.press_key("ctrl+end").unwrap();
    see(&mut app, "Selections 1:5>1:5");
    hover(&mut app, 1.0, 5.0, true);
    hands(&mut app, &cursors, 1);
    click(&mut app, 1.0, 5.0, true);
    see(&mut app, "Definition 2 press at 0 [0:0-0:5]");
    settle(&mut app);
    assert!(app.shows("Selections 1:5>1:5"));
    // Off the link a Mod-click places the caret, then asks.
    hover(&mut app, 500.0, 5.0, true);
    hands(&mut app, &cursors, 0);
    click(&mut app, 1.0, 25.0, true);
    see(&mut app, "Selections 1:0>1:0");
    see(&mut app, "Definition 3 press at 11 [1:0-1:5]");
    // A click without Mod asks nothing.
    click(&mut app, 1.0, 5.0, false);
    see(&mut app, "Selections 0:0>0:0");
    settle(&mut app);
    assert!(app.shows("Definitions 3"));
}

#[test]
fn f12_asks_at_the_caret() {
    let (mut app, _) = start(true);
    app.type_text("id:editor", "").unwrap();
    // At the end of `alpha`: its word.
    app.press_key("ctrl+right").unwrap();
    see(&mut app, "Selections 0:5>0:5");
    app.press_key("f12").unwrap();
    see(&mut app, "Definition 1 key at 5 [0:0-0:5]");
    // The command does the same.
    app.press("id:go").unwrap();
    see(&mut app, "Definition 2 key at 5 [0:0-0:5]");
}

#[test]
fn mod_period_asks_for_code_actions_at_the_selection() {
    let (mut app, _) = start(true);
    app.type_text("id:editor", "").unwrap();
    app.press_key("ctrl+shift+right").unwrap();
    see(&mut app, "Selections 0:0>0:5");
    app.press_key("ctrl+.").unwrap();
    see(&mut app, "Actions 0:0-0:5 at 0:5 placed");
    // A selection made backwards is reported start first, the caret where
    // it is.
    app.press_key("ctrl+end").unwrap();
    app.press_key("ctrl+shift+left").unwrap();
    see(&mut app, "Selections 1:5>1:0");
    app.press("id:actions").unwrap();
    see(&mut app, "Actions 1:0-1:5 at 1:0 placed");
}
