//! Lists edited as a person edits them: the starter kit's keys and
//! commands on nested lists, each step checked against the document Tiptap
//! leaves.

use serde_json::{Value, json};

use super::{ExtensionManager, kit::starter_kit};
use crate::rich_editor::{
    model::Node,
    state::{EditorState, EditorStateConfig, KeyEvent, TextSelection, Transaction},
};

struct Ed {
    manager: ExtensionManager,
    state: EditorState,
}

impl Ed {
    fn new(doc: Value) -> Self {
        let manager = ExtensionManager::with_core(vec![starter_kit()]).unwrap();
        let schema = manager.schema().clone();
        let doc = Node::from_json(&schema, &doc).unwrap();
        let state = EditorState::create(
            EditorStateConfig::new(schema)
                .doc(doc)
                .plugins(manager.plugins()),
        )
        .unwrap();
        Self { manager, state }
    }

    /// Puts the caret at the start of the first text `at`, or selects from
    /// there to the end of the first text `to`.
    fn select(&mut self, at: &str, to: Option<&str>) {
        let find = |needle: &str| -> usize {
            let mut found = None;
            self.state.doc().descendants(&mut |node, pos, _, _| {
                if found.is_none()
                    && node.is_text()
                    && let Some(i) = node.text().unwrap_or_default().find(needle)
                {
                    found = Some(pos + i);
                }
                found.is_none()
            });
            found.unwrap_or_else(|| panic!("no {needle:?}"))
        };
        let anchor = find(at);
        let head = to.map_or(anchor, |t| find(t) + t.len());
        let mut tr = self.state.tr();
        tr.set_selection(TextSelection::create(self.state.doc(), anchor, Some(head)));
        self.apply(tr);
    }

    fn apply(&mut self, tr: Transaction) {
        self.state = self.state.apply(tr).unwrap();
    }

    fn key(&mut self, key: &str, shift: bool) -> bool {
        let event = KeyEvent {
            shift,
            ..KeyEvent::new(key)
        };
        let mut out = None;
        let handled =
            self.state.plugins().iter().any(|plugin| {
                plugin.handle_key_down(&self.state, &event, &mut |tr| out = Some(tr))
            });
        if let Some(tr) = out {
            self.apply(tr);
        }
        handled
    }

    fn run(&mut self, name: &str, args: Value) -> bool {
        let command = self
            .manager
            .commands()
            .make(name, &args, self.state.schema())
            .unwrap();
        let mut out = None;
        let ok = command(&self.state, Some(&mut |tr| out = Some(tr)));
        if let Some(tr) = out {
            self.apply(tr);
        }
        ok
    }

    /// The document as an outline: `ul`/`ol` and `-` per item, indented.
    fn outline(&self) -> String {
        fn walk(node: &Node, depth: usize, out: &mut String) {
            for child in node.content().iter() {
                let pad = "  ".repeat(depth);
                match child.ty().name() {
                    "bulletList" | "orderedList" => {
                        let tag = if child.ty().name() == "bulletList" {
                            "ul"
                        } else {
                            "ol"
                        };
                        out.push_str(&format!("{pad}{tag}\n"));
                        walk(child, depth + 1, out);
                    }
                    "listItem" => {
                        out.push_str(&format!("{pad}-\n"));
                        walk(child, depth + 1, out);
                    }
                    _ => out.push_str(&format!("{pad}{}\n", child.text_content())),
                }
            }
        }
        let mut out = String::new();
        walk(self.state.doc(), 0, &mut out);
        out
    }
}

fn p(text: &str) -> Value {
    if text.is_empty() {
        return json!({ "type": "paragraph" });
    }
    json!({ "type": "paragraph", "content": [{ "type": "text", "text": text }] })
}

fn li(content: Vec<Value>) -> Value {
    json!({ "type": "listItem", "content": content })
}

fn list(ty: &str, items: Vec<Value>) -> Value {
    json!({ "type": ty, "content": items })
}

fn doc(content: Vec<Value>) -> Value {
    json!({ "type": "doc", "content": content })
}

// ul: one, two (with ul: two.a, two.b), three
fn three_items() -> Value {
    doc(vec![list(
        "bulletList",
        vec![
            li(vec![p("one")]),
            li(vec![
                p("two"),
                list("bulletList", vec![li(vec![p("twoA")]), li(vec![p("twoB")])]),
            ]),
            li(vec![p("three")]),
        ],
    )])
}

const NESTED_UL: &str = "ul\n  -\n    one\n  -\n    two\n    ul\n      -\n        twoA\n      -\n        twoB\n  -\n    three\n\n";

#[test]
fn a_list_changes_type_at_every_level() {
    // From a nested item, an outer one, and selections across levels.
    for (at, to) in [
        ("twoB", None),
        ("one", None),
        ("one", Some("three")),
        ("twoA", Some("three")),
    ] {
        let mut ed = Ed::new(three_items());
        ed.select(at, to);
        assert!(ed.run("toggleOrderedList", json!(null)));
        assert_eq!(ed.outline(), NESTED_UL.replace("ul", "ol"), "{at}..{to:?}");
        assert!(ed.run("toggleBulletList", json!(null)));
        assert_eq!(ed.outline(), NESTED_UL, "{at}..{to:?}");
    }
}

#[test]
fn turning_a_list_off_takes_the_selected_blocks_out_of_every_level() {
    let mut ed = Ed::new(three_items());
    ed.select("one", Some("three"));
    assert!(ed.run("toggleBulletList", json!(null)));
    assert_eq!(ed.outline(), "one\ntwo\ntwoA\ntwoB\nthree\n\n");
    // The selection is on the same text.
    let sel = ed.state.selection();
    assert_eq!(
        ed.state
            .doc()
            .text_between(sel.from(), sel.to(), Some("|"), None),
        "one|two|twoA|twoB|three"
    );
    // A nested item alone leaves the lists, the others stay.
    let mut ed = Ed::new(three_items());
    ed.select("twoA", None);
    assert!(ed.run("toggleBulletList", json!(null)));
    assert_eq!(
        ed.outline(),
        "ul\n  -\n    one\n  -\n    two\ntwoA\nul\n  -\n    twoB\n  -\n    three\n\n"
    );
}

#[test]
fn tab_and_shift_tab_move_every_selected_item_one_level() {
    let mut ed = Ed::new(three_items());
    ed.select("two", Some("three"));
    assert!(ed.key("Tab", false));
    assert_eq!(
        ed.outline(),
        "ul\n  -\n    one\n    ul\n      -\n        two\n        ul\n          -\n            twoA\n          -\n            twoB\n      -\n        three\n\n"
    );
    assert!(ed.key("Tab", true));
    assert_eq!(ed.outline(), NESTED_UL);
    // The first item of a list cannot go deeper.
    ed.select("twoA", None);
    assert!(!ed.run("sinkListItem", json!({ "name": "listItem" })));
}

#[test]
fn enter_in_empty_items_steps_out_a_level_at_a_time() {
    let mut ed = Ed::new(three_items());
    ed.select("twoB", None);
    let end = ed.state.selection().from() + 4;
    let mut tr = ed.state.tr();
    tr.set_selection(TextSelection::create(ed.state.doc(), end, None));
    ed.apply(tr);
    assert!(ed.key("Enter", false));
    assert!(ed.key("Enter", false));
    assert_eq!(
        ed.outline(),
        "ul\n  -\n    one\n  -\n    two\n    ul\n      -\n        twoA\n      -\n        twoB\n  -\n    \n  -\n    three\n\n"
    );
    assert!(ed.key("Enter", false));
    assert!(
        ed.outline().contains("twoB\n\nul\n  -\n    three"),
        "{}",
        ed.outline()
    );
}
