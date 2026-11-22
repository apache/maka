//! Composition transitions are observable without manufacturing an editor
//! transaction. Observers see settled state and can remove the view.

use super::*;

#[derive(Clone, PartialEq, Props)]
struct CompositionProps {
    session: Option<EditorSession>,
    close_on_end: bool,
}

#[component]
fn CompositionProbe(props: CompositionProps) -> impl IntoElement {
    let editor = props.session.clone().expect("a session");
    let shown = signal(true);
    let transitions = signal(Vec::<bool>::new());
    let settled = signal(true);
    let observed = signal(String::new());
    let close_on_end = props.close_on_end;
    view()
        .child(when(
            move || shown.get(),
            move || {
                let read = editor.clone();
                view()
                    .test_id("composition-editor")
                    .w(px(400.0))
                    .h(px(120.0))
                    .child(
                        rich_editor()
                            .editor(editor.clone())
                            .size_full()
                            .on_composition_change(move |composing: &bool| {
                                settled.set(read.composing() == *composing);
                                observed.set(doc_text(read.state().doc()));
                                transitions.update(|seen| seen.push(*composing));
                                if !composing && close_on_end {
                                    shown.set(false);
                                }
                            }),
                    )
            },
        ))
        // Rendered witnesses make event completion observable to the
        // headless driver even when the document/layout never changes.
        .child(text(move || format!("Transitions {:?}", transitions.get())))
        .child(text(move || format!("Settled {}", settled.get())))
        .child(text(move || format!("Observed {}", observed.get())))
        .child(text(move || if shown.get() { "Open" } else { "Closed" }))
}

fn start_composition(close_on_end: bool) -> (Headless, EditorSession) {
    let editor = session(paragraphs(&["Seed"]));
    let shown = editor.clone();
    let mut app = Headless::start(EngineConfig::new(Root::new::<CompositionProbe>(
        move || CompositionProps {
            session: Some(shown.clone()),
            close_on_end,
        },
    )))
    .unwrap();
    app.wait_for("text:Transitions []").unwrap();
    app.type_text("id:composition-editor", "").unwrap();
    (app, editor)
}

#[test]
fn start_repeated_updates_and_cancel_report_only_transitions_without_transactions() {
    let (mut app, editor) = start_composition(false);
    let state = editor.state();
    compose(&mut app, true, "");
    see(&mut app, "Transitions [true]");
    see(&mut app, "Settled true");
    assert!(editor.composing());
    for text in ["に", "にほ", "にほ"] {
        compose(&mut app, true, text);
    }
    see(&mut app, "Transitions [true]");
    assert_eq!(editor.state().revision(), state.revision());
    assert!(editor.state().doc().ptr_eq(state.doc()));
    compose(&mut app, false, "");
    see(&mut app, "Transitions [true, false]");
    see(&mut app, "Observed Seed");
    see(&mut app, "Settled true");
    assert!(!editor.composing());
    assert_eq!(
        editor.state().revision(),
        state.revision(),
        "cancel creates no transaction"
    );
    assert!(editor.state().doc().ptr_eq(state.doc()));
    compose(&mut app, false, "");
    see(&mut app, "Transitions [true, false]");
}

#[test]
fn an_end_observer_sees_the_committed_text_and_composition_state() {
    let (mut app, editor) = start_composition(false);
    let state = editor.state();
    compose(&mut app, true, "にほん");
    // The platform holds changed input text while composition is active;
    // ending it publishes the commit before the end observer runs.
    sink_text(&mut app, "日本");
    assert_eq!(editor.state().revision(), state.revision());
    compose(&mut app, false, "");
    see(&mut app, "Transitions [true, false]");
    see(&mut app, "Settled true");
    let committed = doc_text(editor.state().doc());
    assert!(committed.contains("日本"), "{committed}");
    see(&mut app, &format!("Observed {committed}"));
    assert!(editor.state().revision() > state.revision());
    assert!(!editor.composing());
    keys(&mut app, &["mod+z"]);
    assert_eq!(
        doc_text(editor.state().doc()),
        "Seed",
        "one undo removes the composition commit"
    );
}

#[test]
fn a_cancel_observer_can_remove_the_editor_after_its_state_settles() {
    let (mut app, editor) = start_composition(true);
    let state = editor.state();
    compose(&mut app, true, "");
    see(&mut app, "Transitions [true]");
    compose(&mut app, false, "");
    see(&mut app, "Closed");
    see(&mut app, "Transitions [true, false]");
    see(&mut app, "Settled true");
    app.wait_for_gone("id:composition-editor", Duration::from_secs(5))
        .unwrap();
    assert!(!editor.composing());
    assert_eq!(editor.state().revision(), state.revision());
    assert!(editor.state().doc().ptr_eq(state.doc()));
}

#[test]
fn the_generated_js_event_payload_names_the_composing_state() {
    let mut registry = nsh_core::element::Registry::new();
    registry.register::<nsh_base::rich_editor::view::RichEditor>();
    let declarations = nsh_core::element::declarations(&registry, &[]);
    assert!(
        declarations.contains("onCompositionChange?: (event: { composing: boolean }) => void;"),
        "{declarations}"
    );
}
