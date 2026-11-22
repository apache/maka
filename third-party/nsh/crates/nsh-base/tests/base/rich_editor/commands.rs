//! Tiptap's commands and queries over a session: named commands from the
//! registry, `isActive` over ranges, attributes, parents and the session's
//! events.

use std::sync::Mutex;

use nsh_base::rich_editor::{
    commands::{CommandRegistry, find_parent_node},
    view::{SessionEvent, SessionEventKind},
};

use super::*;

fn run(session: &EditorSession, name: &str, args: Value) -> bool {
    let schema = session.state().schema().clone();
    let command = CommandRegistry::builtin()
        .make(name, &args, &schema)
        .unwrap();
    session.run(&command)
}

fn first_name(session: &EditorSession, names: &[&str]) -> String {
    let schema = session.state().schema().clone();
    names
        .iter()
        .find(|n| schema.node_type(n).is_some())
        .expect("one of the names")
        .to_string()
}

#[test]
fn named_commands_toggle_lists_and_headings() {
    let s = session(paragraphs(&["Hello", "World"]));
    let list = first_name(&s, &["bulletList", "bulletList"]);
    let item = first_name(&s, &["listItem", "listItem"]);
    assert!(run(
        &s,
        "setTextSelection",
        json!({"position": {"from": 2, "to": 9}})
    ));
    assert!(run(
        &s,
        "toggleList",
        json!({"listName": list, "itemName": item})
    ));
    // The list, and the trailing paragraph after it.
    assert_eq!(s.state().doc().child_count(), 2);
    assert!(s.is_active(Some(&list), None));
    assert!(run(
        &s,
        "toggleList",
        json!({"listName": list, "itemName": item})
    ));
    assert_eq!(s.state().doc().child(0).ty().name(), "paragraph");
    assert!(run(
        &s,
        "setNode",
        json!({"name": "heading", "attrs": {"level": 2}})
    ));
    assert!(s.is_active(
        Some("heading"),
        Some([("level".to_owned(), json!(2))].into())
    ));
    assert_eq!(s.get_attributes("heading").get("level"), Some(&json!(2)));
    let state = s.state();
    let parent = find_parent_node(state.selection(), &|n| n.ty().name() == "heading").unwrap();
    assert_eq!(parent.pos, 0);
}

#[test]
fn marks_are_active_over_the_whole_range_only() {
    let s = session(paragraphs(&["Hello world"]));
    assert!(run(
        &s,
        "setTextSelection",
        json!({"position": {"from": 1, "to": 6}})
    ));
    assert!(run(&s, "toggleMark", json!({"name": "bold"})));
    assert!(s.is_active(Some("bold"), None));
    assert!(run(
        &s,
        "setTextSelection",
        json!({"position": {"from": 1, "to": 9}})
    ));
    assert!(!s.is_active(Some("bold"), None));
    assert!(run(&s, "setTextSelection", json!({"position": 3})));
    assert!(run(
        &s,
        "unsetMark",
        json!({"name": "bold", "extendEmptyMarkRange": true})
    ));
    let bold = s.state().schema().mark_type("bold").unwrap();
    assert!(!s.state().doc().range_has_mark(1, 12, &bold));
}

#[test]
fn events_are_posted_after_changes() {
    let s = session(paragraphs(&["ab"]));
    let heard = Arc::new(Mutex::new(Vec::new()));
    let h = heard.clone();
    s.on(
        SessionEventKind::Delete,
        Arc::new(move |e: &SessionEvent| h.lock().unwrap().push(e.payload.clone())),
    );
    assert!(run(&s, "deleteRange", json!({"from": 1, "to": 2})));
    let heard = heard.lock().unwrap().clone();
    assert_eq!(
        heard,
        vec![json!({"from": 1, "to": 2, "newFrom": 1, "newTo": 1})]
    );
}
