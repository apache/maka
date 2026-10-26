//! `Editor`'s completion: typing a word asks the app, whose answer shows
//! as a list that filters as typing goes on; the keys move in it, accept
//! and close it; a trigger character asks with an empty query; stale
//! answers are dropped; and a pause in typing asks for an inline
//! completion, which Tab inserts.

use std::time::Duration;

use nsh_base::editor::{
    Editor, EditorApi, EditorCommand, EditorCompletionAcceptEvent, EditorCompletionItem,
    EditorCompletionKind, EditorCompletionRequest, EditorCompletionTrigger, EditorEdit,
    EditorInlineCompletionRequest, EditorPosition, EditorRange, editor,
};
use nsh_core::{
    Size,
    element::Root,
    platform::{Idiom, Os},
    prelude::*,
};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

#[derive(Clone, PartialEq, Props)]
struct HarnessProps {
    /// The first text.
    text: String,
    /// Requests are answered at once with the items (else by the
    /// `answer` button).
    answer: bool,
    /// The inline completion answering every inline request.
    inline: Option<String>,
}

fn props(text: &str) -> HarnessProps {
    HarnessProps {
        text: text.into(),
        answer: true,
        inline: None,
    }
}

/// What the app suggests: four words, the first with a kind, a detail and
/// documentation.
fn items() -> Vec<EditorCompletionItem> {
    let mut print = EditorCompletionItem::new("print");
    print.kind = Some(EditorCompletionKind::Function);
    print.detail = Some("(value)".into());
    print.documentation = Some("Prints a value.".into());
    ["println", "private", "process"]
        .into_iter()
        .map(EditorCompletionItem::new)
        .fold(vec![print], |mut all, item| {
            all.push(item);
            all
        })
}

/// An editor of 600 × 400 with completion on (`.` triggers it), and what
/// the app heard: the last request, how many, the item accepted, the
/// last inline request.
#[component]
fn Harness(props: HarnessProps) -> impl IntoElement {
    let value = signal(props.text.clone());
    let requests = signal(0u32);
    let last = signal(String::from("-"));
    let last_id = signal(0u32);
    let accepted = signal(String::from("-"));
    let inline = signal(String::from("-"));
    let ed = component_ref::<Editor>();
    let api = move |f: &dyn Fn(&EditorApi)| {
        if let Some(api) = ed.api::<EditorApi>() {
            f(&api);
        }
    };
    let answer = props.answer;
    let ghost = props.inline.clone();
    let button = move |id: &str, f: Box<dyn Fn(&EditorApi)>| {
        view()
            .test_id(id)
            .w(px(20.0))
            .h(px(20.0))
            .on_press(move || api(&*f))
    };
    let el = editor()
        .default_value(props.text.clone())
        .completion(true)
        .completion_trigger_characters(vec![SharedString::from(".")])
        .inline_completion_delay(50.0)
        .on_change(move |text: &SharedString| value.set(text.to_string()))
        .on_completion_request(move |e: &EditorCompletionRequest| {
            requests.update(|n| *n += 1);
            last_id.set(e.id);
            let trigger = match e.trigger {
                EditorCompletionTrigger::Typing => "typing",
                EditorCompletionTrigger::Character => "character",
                EditorCompletionTrigger::Invoked => "invoked",
            };
            last.set(format!(
                "{} [{}] {trigger} at {} from {}",
                e.id, e.query, e.offset, e.query_start
            ));
            if answer {
                let id = e.id;
                api(&move |a| a.present_completions(id, items(), None));
            }
        })
        .on_completion_accept(move |e: &EditorCompletionAcceptEvent| {
            accepted.set(e.item.label.to_string())
        })
        .on_inline_completion_request(move |e: &EditorInlineCompletionRequest| {
            inline.set(format!("{} at {}", e.id, e.offset));
            if let Some(text) = ghost.clone() {
                let id = e.id;
                api(&move |a| a.present_inline_completion(id, text.clone()));
            }
        })
        .component_ref(&ed)
        .size_full();
    view()
        .child(view().test_id("editor").w(px(600.0)).h(px(400.0)).child(el))
        .child(text(move || format!("Value {:?}", value.get())))
        .child(text(move || format!("Requests {}", requests.get())))
        .child(text(move || format!("Request {}", last.get())))
        .child(text(move || format!("Accepted {}", accepted.get())))
        .child(text(move || format!("Inline {}", inline.get())))
        .child(
            view()
                .flex_row()
                .child(button(
                    "answer",
                    Box::new(move |a| {
                        a.present_completions(last_id.get_untracked(), items(), None)
                    }),
                ))
                .child(button(
                    "show",
                    Box::new(|a| a.run(EditorCommand::ShowCompletions)),
                ))
                .child(button(
                    "edit",
                    Box::new(|a| {
                        let at = |a, b| {
                            EditorRange::new(EditorPosition::new(0, a), EditorPosition::new(0, b))
                        };
                        a.edit(vec![
                            EditorEdit::new(at(6, 6), "big "),
                            EditorEdit::new(at(0, 5), "goodbye"),
                            // Overlaps the one before: dropped.
                            EditorEdit::new(at(1, 3), "x"),
                        ])
                    }),
                )),
        )
}

/// The harness of `props` on a Linux desktop's headless surface, shown.
fn start(props: HarnessProps) -> Headless {
    let mut config = EngineConfig {
        viewport: Size::new(px(800.0), px(900.0)),
        ..EngineConfig::new(Root::new::<Harness>(move || props.clone()))
    };
    config.environment.os = Os::Linux;
    config.environment.idiom = Idiom::Desktop;
    let mut app = Headless::start(config).expect("the engine starts");
    app.wait_for("text:Requests 0").unwrap();
    app
}

fn see(app: &mut Headless, text: &str) {
    app.wait_for(&format!("text:{text}")).unwrap();
}

fn gone(app: &mut Headless, text: &str) {
    app.wait_for_gone(&format!("text:{text}"), Duration::from_secs(5))
        .unwrap();
}

fn value(text: &str) -> String {
    format!("Value {text:?}")
}

fn typed(app: &mut Headless, text: &str) {
    app.type_text("id:editor", text).unwrap();
}

#[test]
fn typing_a_word_asks_once_and_the_list_filters_as_typing_goes_on() {
    let mut app = start(props(""));
    typed(&mut app, "pr");
    // The first character asked; the second refined the list in place.
    see(&mut app, "Request 1 [p] typing at 1 from 0");
    see(&mut app, "Requests 1");
    for label in ["print", "println", "private", "process"] {
        see(&mut app, label);
    }
    // The first item's kind, detail and documentation (it is selected).
    see(&mut app, "fn");
    see(&mut app, "(value)");
    see(&mut app, "Prints a value.");
    typed(&mut app, "in");
    gone(&mut app, "private");
    assert!(!app.shows("process"));
    assert!(app.shows("Requests 1"));
    // Enter accepts the selected item, replacing the query.
    app.press_key("enter").unwrap();
    see(&mut app, &value("print"));
    see(&mut app, "Accepted print");
    gone(&mut app, "println");
    // Accepting asked nothing more.
    assert!(app.shows("Requests 1"));
}

#[test]
fn arrows_move_the_selection_around_the_ends_and_tab_accepts() {
    let mut app = start(props("x "));
    // Focused first: the editor's keys are bound while it has the focus.
    typed(&mut app, "");
    app.press_key("ctrl+end").unwrap();
    typed(&mut app, "pr");
    see(&mut app, "process");
    app.press_key("down").unwrap();
    app.press_key("up").unwrap();
    // Up from the first wraps to the last.
    app.press_key("up").unwrap();
    app.press_key("tab").unwrap();
    see(&mut app, &value("x process"));
    see(&mut app, "Accepted process");
    // One undo step takes the insertion back to what was typed.
    app.press_key("ctrl+z").unwrap();
    see(&mut app, &value("x pr"));
}

#[test]
fn escape_closes_the_list_and_a_non_word_character_ends_the_session() {
    let mut app = start(props(""));
    typed(&mut app, "pr");
    see(&mut app, "process");
    app.press_key("escape").unwrap();
    gone(&mut app, "process");
    see(&mut app, &value("pr"));
    // Typing on at the word's end asks again, for the whole word.
    typed(&mut app, "o");
    see(&mut app, "Request 2 [pro] typing at 3 from 0");
    see(&mut app, "process");
    typed(&mut app, " ");
    gone(&mut app, "process");
    see(&mut app, &value("pro "));
}

#[test]
fn a_trigger_character_asks_with_an_empty_query() {
    let mut app = start(props("a"));
    typed(&mut app, "");
    app.press_key("end").unwrap();
    typed(&mut app, ".");
    see(&mut app, "Request 1 [] character at 2 from 2");
    // An empty query shows every item.
    for label in ["print", "println", "private", "process"] {
        see(&mut app, label);
    }
    // Pressing an item accepts it.
    app.press("text:private").unwrap();
    see(&mut app, &value("a.private"));
    see(&mut app, "Accepted private");
}

#[test]
fn an_answer_to_a_session_that_ended_is_dropped() {
    let mut app = start(HarnessProps {
        answer: false,
        ..props("")
    });
    typed(&mut app, "pr");
    see(&mut app, "Requests 1");
    // A space ends the word, and the session with it, before the answer.
    typed(&mut app, " ");
    app.press("id:answer").unwrap();
    app.wait(Duration::from_millis(50)).unwrap();
    assert!(!app.shows("process"));
    // Asked by the command after the space: an empty query, and the
    // answer shows every item.
    app.press("id:show").unwrap();
    see(&mut app, "Request 2 [] invoked at 3 from 3");
    app.press("id:answer").unwrap();
    see(&mut app, "process");
    see(&mut app, "print");
}

#[test]
fn a_pause_in_typing_asks_for_an_inline_completion_which_tab_inserts() {
    let mut app = start(HarnessProps {
        answer: false,
        inline: Some("ln!()".into()),
        ..props("")
    });
    typed(&mut app, "print");
    // No answer, no list: the pause asks for an inline completion.
    // (A pause between the keystrokes may have asked earlier.)
    app.wait_for(r"text:/^Inline \d+ at 5$/").unwrap();
    see(&mut app, "ln!()");
    app.press_key("tab").unwrap();
    see(&mut app, &value("println!()"));
    gone(&mut app, "ln!()");
}

#[test]
fn edit_replaces_ranges_in_one_undo_step_and_carries_the_carets() {
    let mut app = start(props("hello world"));
    typed(&mut app, "");
    app.press_key("ctrl+end").unwrap();
    typed(&mut app, "!");
    see(&mut app, &value("hello world!"));
    app.press("id:edit").unwrap();
    see(&mut app, &value("goodbye big world!"));
    // The caret went along with the text after it.
    typed(&mut app, "?");
    see(&mut app, &value("goodbye big world!?"));
    app.press_key("ctrl+z").unwrap();
    see(&mut app, &value("goodbye big world!"));
    // One step takes every replacement back.
    app.press_key("ctrl+z").unwrap();
    see(&mut app, &value("hello world!"));
}
