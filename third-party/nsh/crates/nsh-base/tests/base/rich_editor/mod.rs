//! `RichEditor`: typing goes through input rules into the document, Enter
//! splits a block and Backspace joins them back (the base keymap), Mod-b
//! toggles bold (the starter's keymap), a press places the caret, Markdown
//! pastes as blocks, a node view renders an atom, undo takes typing
//! back, and lists' items show their markers.

mod commands;
mod extensions;
mod marks_clipboard_history;
mod selection;
mod structure;
mod tiptap;
mod typing;
mod view_features;

use std::sync::Arc;

use nsh_base::rich_editor::{
    extensions::{markdown::markdown, starter},
    model::{Node, NodeSpec, Schema},
    state::{EditorState, EditorStateConfig},
    view::{EditorSession, NodeView, NodeViewCx, NodeViews, rich_editor},
};
use nsh_core::{
    PasteEvent, Size,
    element::Root,
    platform::{Idiom, Os},
    prelude::*,
};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;
use serde_json::{Value, json};

/// Renders `stock` nodes as a card of their symbol.
struct StockCard;

impl NodeView for StockCard {
    fn create(&self, _cx: &NodeViewCx, node: &Node) -> AnyElement {
        let symbol = node
            .attrs()
            .get("symbol")
            .and_then(Value::as_str)
            .unwrap_or("?");
        view().child(text(format!("Stock {symbol}"))).into_element()
    }
}

/// The starter schema with a block atom `stock`.
fn schema() -> Schema {
    let mut spec = starter::schema_spec();
    let mut stock = NodeSpec::default();
    stock.group = Some("block".into());
    stock.atom = true;
    let mut symbol = nsh_base::rich_editor::model::AttrSpec::default();
    symbol.default = Some(json!(""));
    stock.attrs = vec![("symbol".into(), symbol)];
    spec.nodes.push(("stock".into(), stock));
    Schema::new(spec).unwrap()
}

fn session(doc: Value) -> EditorSession {
    let schema = schema();
    let mut plugins = markdown(Default::default());
    plugins.extend(starter::plugins(&schema));
    let doc = schema.node_from_json(&doc).unwrap();
    let state =
        EditorState::create(EditorStateConfig::new(schema).doc(doc).plugins(plugins)).unwrap();
    EditorSession::new(state, NodeViews::new().with("stock", Arc::new(StockCard)))
}

#[derive(Clone, PartialEq, Props)]
struct HarnessProps {
    session: Option<EditorSession>,
}

/// What the document reads as: blocks' text separated by `|`.
fn doc_text(doc: &Node) -> String {
    doc.text_between(0, doc.content().size(), Some("|"), Some("@"))
}

/// An editor of 600 × 400 (in a view `editor`), and what the app heard:
/// the document's text, its blocks' types, how many bold texts, the
/// selection.
#[component]
fn Harness(props: HarnessProps) -> impl IntoElement {
    let session = props.session.clone().expect("a session");
    let read = {
        let session = session.clone();
        move || {
            let state = session.state();
            let doc = state.doc().clone();
            let types: Vec<String> = doc
                .content()
                .iter()
                .map(|n| n.ty().name().to_owned())
                .collect();
            let mut bold = 0;
            doc.descendants(&mut |n, _, _, _| {
                if n.marks().iter().any(|m| m.ty().name() == "bold") {
                    bold += 1;
                }
                true
            });
            let s = state.selection();
            (
                doc_text(&doc),
                doc.to_string(),
                types.join(","),
                bold,
                format!("{}-{}", s.from(), s.to()),
            )
        }
    };
    let shown = signal(read());
    let (on_change, on_select) = (read.clone(), read);
    view()
        .child(
            view().test_id("editor").w(px(600.0)).h(px(400.0)).child(
                rich_editor()
                    .editor(session)
                    .size_full()
                    .on_change(move |_: &_| shown.set(on_change()))
                    .on_selection_change(move |_: &_| shown.set(on_select())),
            ),
        )
        .child(text(move || format!("Doc {:?}", shown.get().0)))
        .child(text(move || format!("Tree {}", shown.get().1)))
        .child(text(move || format!("Types {}", shown.get().2)))
        .child(text(move || format!("Bold {}", shown.get().3)))
        .child(text(move || format!("Sel {}", shown.get().4)))
        .child(text("Ready"))
}

fn start(doc: Value) -> Headless {
    let session = session(doc);
    let mut config = EngineConfig {
        viewport: Size::new(px(800.0), px(900.0)),
        ..EngineConfig::new(Root::new::<Harness>(move || HarnessProps {
            session: Some(session.clone()),
        }))
    };
    config.environment.os = Os::Linux;
    config.environment.idiom = Idiom::Desktop;
    let mut app = Headless::start(config).expect("the engine starts");
    app.wait_for("text:Ready").unwrap();
    app
}

fn paragraphs(texts: &[&str]) -> Value {
    let content: Vec<Value> = texts
        .iter()
        .map(|t| match t.is_empty() {
            true => json!({"type": "paragraph"}),
            false => json!({"type": "paragraph", "content": [{"type": "text", "text": t}]}),
        })
        .collect();
    json!({"type": "doc", "content": content})
}

fn see(app: &mut Headless, text: &str) {
    app.wait_for(&format!("text:{text}")).unwrap();
}

fn doc(text: &str) -> String {
    format!("Doc {text:?}")
}

fn keys(app: &mut Headless, list: &[&str]) {
    for k in list {
        app.press_key(k).unwrap();
    }
}

#[test]
fn typing_inserts_text_into_the_document() {
    let mut app = start(paragraphs(&[""]));
    app.type_text("id:editor", "Hello").unwrap();
    see(&mut app, &doc("Hello"));
    see(&mut app, "Sel 6-6");
    see(&mut app, "Hello");
}

#[test]
fn enter_splits_a_block_and_backspace_joins_it_back() {
    let mut app = start(paragraphs(&["abcd"]));
    app.type_text("id:editor", "").unwrap();
    keys(&mut app, &["right", "right", "enter"]);
    see(&mut app, &doc("ab|cd"));
    see(&mut app, "Types paragraph,paragraph");
    keys(&mut app, &["backspace"]);
    see(&mut app, &doc("abcd"));
    see(&mut app, "Sel 3-3");
}

#[test]
fn mod_b_toggles_bold() {
    let mut app = start(paragraphs(&["word"]));
    app.type_text("id:editor", "").unwrap();
    keys(&mut app, &["mod+a", "mod+b"]);
    see(&mut app, "Bold 1");
    keys(&mut app, &["mod+b"]);
    see(&mut app, "Bold 0");
}

#[test]
fn a_press_places_the_caret() {
    let mut app = start(paragraphs(&["first", "second"]));
    app.type_text("id:editor", "").unwrap();
    keys(&mut app, &["ctrl+end"]);
    see(&mut app, "Sel 14-14");
    app.press_at("text:first", Point::new(px(1.0), px(1.0)))
        .unwrap();
    see(&mut app, "Sel 1-1");
}

#[test]
fn markdown_pastes_as_blocks() {
    let mut app = start(paragraphs(&[""]));
    let mut paste = PasteEvent::default();
    paste.text = "# Title\n\n- item".into();
    app.paste("id:editor", &paste).unwrap();
    see(&mut app, "Types heading,bulletList,paragraph");
    see(&mut app, &doc("Title|item|"));
}

#[test]
fn a_node_view_renders_an_atom() {
    let mut app = start(json!({"type": "doc", "content": [
        {"type": "paragraph", "content": [{"type": "text", "text": "before"}]},
        {"type": "stock", "attrs": {"symbol": "AAPL"}}
    ]}));
    see(&mut app, "Stock AAPL");
    see(&mut app, "Types paragraph,stock");
    // Moving right past the paragraph's end selects the atom.
    app.type_text("id:editor", "").unwrap();
    keys(&mut app, &["end", "right"]);
    see(&mut app, "Sel 8-9");
}

#[test]
fn undo_takes_typing_back() {
    let mut app = start(paragraphs(&["x"]));
    app.type_text("id:editor", "abc").unwrap();
    see(&mut app, &doc("abcx"));
    keys(&mut app, &["mod+z"]);
    see(&mut app, &doc("x"));
    keys(&mut app, &["mod+shift+z"]);
    see(&mut app, &doc("abcx"));
}

fn item(text: &str, nested: Option<Value>) -> Value {
    let mut content =
        vec![json!({"type": "paragraph", "content": [{"type": "text", "text": text}]})];
    content.extend(nested);
    json!({"type": "listItem", "content": content})
}

#[test]
fn list_items_show_their_markers() {
    let nested = json!({"type": "bulletList", "content": [item("inner", None)]});
    let mut app = start(json!({"type": "doc", "content": [
        {"type": "bulletList", "content": [item("one", Some(nested)), item("two", None)]},
        {"type": "orderedList", "attrs": {"start": 3}, "content": [item("three", None), item("four", None)]},
    ]}));
    see(&mut app, "•");
    see(&mut app, "◦");
    see(&mut app, "3.");
    see(&mut app, "4.");
    // The markers are the view's: the document's text has none.
    see(&mut app, &doc("one|inner|two|three|four"));
}
