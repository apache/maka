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
mod touch;
mod typing;
mod view_features;

use std::{sync::Arc, time::Duration};

use nsh_base::rich_editor::{
    extensions::{markdown::markdown, starter, suggestion::mention_node},
    model::{Node, NodeSpec, Schema},
    state::{EditorState, EditorStateConfig},
    view::{EditorSession, NodeView, NodeViewCx, NodeViews, rich_editor},
};
use nsh_core::{
    PasteEvent, PayloadValue, Size,
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

/// The starter schema with a block atom `stock` and Tiptap's `mention`.
fn schema() -> Schema {
    let mut spec = starter::schema_spec();
    let mut stock = NodeSpec::default();
    stock.group = Some("block".into());
    stock.atom = true;
    let mut symbol = nsh_base::rich_editor::model::AttrSpec::default();
    symbol.default = Some(json!(""));
    stock.attrs = vec![("symbol".into(), symbol)];
    spec.nodes.push(("stock".into(), stock));
    spec.nodes.push(mention_node("mention", "@"));
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
    start_on(doc, Os::Linux, false)
}

/// [`start`] on `os`; in a browser, on an Apple platform or not
/// (`apple_keyboard`).
fn start_on(doc: Value, os: Os, apple_keyboard: bool) -> Headless {
    start_with(doc, os, apple_keyboard, Idiom::Desktop)
}

/// [`start_on`] in `idiom` (a phone: touch selection).
fn start_with(doc: Value, os: Os, apple_keyboard: bool, idiom: Idiom) -> Headless {
    let mut config = EngineConfig {
        viewport: Size::new(px(800.0), px(900.0)),
        // Made in the engine, so its keymaps are the platform's the engine
        // says, not the machine's.
        ..EngineConfig::new(Root::new::<Harness>(move || HarnessProps {
            session: Some(session(doc.clone())),
        }))
    };
    config.environment.os = os;
    config.environment.apple_keyboard = apple_keyboard;
    config.environment.idiom = idiom;
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

/// An input method's composition in the editor's sink: started or
/// changed (`composing`) with `text`, or ended. The headless driver has
/// no composition step and does not expose an input's node id, so the
/// event goes to every node; only the sink listens to it.
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

/// The sink's text changed to `text`, as platforms report it while an
/// input method composes (the uncommitted text in it). Sent to every node,
/// as [`compose`] is.
fn sink_text(app: &mut Headless, text: &str) {
    for id in 1..4096 {
        app.engine().control().dispatch_event(
            id,
            EventKind::ChangeText,
            EventPayload::Text {
                text: text.to_owned(),
                count: 0,
            },
        );
    }
    app.wait(Duration::from_millis(50)).unwrap();
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
fn a_browser_on_a_mac_takes_apples_keys() {
    let mut app = start_on(paragraphs(&["one two"]), Os::Web, true);
    app.type_text("id:editor", "").unwrap();
    keys(&mut app, &["cmd+right"]);
    see(&mut app, "Sel 8-8");
    keys(&mut app, &["alt+left"]);
    see(&mut app, "Sel 5-5");
    keys(&mut app, &["cmd+left"]);
    see(&mut app, "Sel 1-1");
    keys(&mut app, &["cmd+a", "cmd+b"]);
    see(&mut app, "Bold 1");
    keys(&mut app, &["cmd+z"]);
    see(&mut app, "Bold 0");
}

#[test]
fn a_browser_elsewhere_takes_pc_keys() {
    let mut app = start_on(paragraphs(&["word"]), Os::Web, false);
    app.type_text("id:editor", "").unwrap();
    keys(&mut app, &["ctrl+a", "ctrl+b"]);
    see(&mut app, "Bold 1");
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

/// A paragraph with a link mark that has a title.
fn linked_doc() -> Value {
    json!({"type": "doc", "content": [{"type": "paragraph", "content": [
        {"type": "text", "text": "go "},
        {"type": "text", "text": "the site", "marks": [{"type": "link", "attrs": {
            "href": "https://example.com/site", "title": "The site"
        }}]},
        {"type": "text", "text": " now"}
    ]}]})
}

/// The built-in link mark shows where it goes while the pointer rests on
/// it, as `TextView`'s links do, and stays the editor's text: a press on
/// it places the caret, typing in it goes into the link.
#[test]
fn a_link_marks_hint_shows_its_destination_and_leaves_editing_alone() {
    let mut app = start(linked_doc());
    // A link of its text once its hint watches it (the frame after).
    app.wait_until("link hover listener", Duration::from_secs(5), |screen| {
        screen.layout_nodes().iter().any(|node| {
            node.text.as_ref().is_some_and(|text| {
                text.text
                    .links
                    .iter()
                    .any(|link| link.events.contains(EventKind::MouseEnter))
            })
        })
    })
    .unwrap();
    app.wait_for("text:the site").unwrap();
    app.hover("text:the site").unwrap();
    app.wait(Duration::from_millis(600)).unwrap();
    // The head and the rest of the URL, under the mark's title.
    see(&mut app, "https://example.com");
    assert!(app.shows("/site"), "the path, after the host");
    assert!(app.shows("The site"), "the title, above the URL");
    // A press on the link is the editor's: the caret goes before its
    // first character (no link plugin here opens it).
    // Headless span bounds are the paragraph's bounds, and its approximate
    // TextLine fills that width. Place the pointer after "go " in that line.
    let paragraph = app
        .screen()
        .layout_nodes()
        .into_iter()
        .find_map(|node| node.text.filter(|text| text.text.text == "go the site now"))
        .unwrap();
    let advance = paragraph.content.size.width.0 / paragraph.text.text.chars().count() as f32;
    app.press_at(
        "text:go the site now",
        Point::new(px(3.0 * advance + 1.0), px(1.0)),
    )
    .unwrap();
    see(&mut app, "Sel 4-4");
    see(&mut app, &doc("go the site now"));
    // Typing inside the link goes into it.
    keys(&mut app, &["right", "right"]);
    app.type_text("id:editor", "x").unwrap();
    see(&mut app, &doc("go thxe site now"));
    see(
        &mut app,
        r#"Tree doc(paragraph("go ", link("thxe site"), " now"))"#,
    );
}

/// The same document on a phone: no hint (a touch screen's long press is
/// the platform's).
#[test]
fn a_link_mark_shows_no_hint_on_a_phone() {
    let mut config = EngineConfig {
        viewport: Size::new(px(390.0), px(844.0)),
        ..EngineConfig::new(Root::new::<Harness>(|| HarnessProps {
            session: Some(session(linked_doc())),
        }))
    };
    config.environment.os = Os::Ios;
    config.environment.idiom = Idiom::Phone;
    let mut app = Headless::start(config).expect("the engine starts");
    app.wait_for("text:Ready").unwrap();
    see(&mut app, &doc("go the site now"));
    // No hint watches the mark there, so it is no link of its text: the
    // pointer is over the paragraph.
    assert!(
        app.hover("text:go the site now").is_err(),
        "a phone has no mouse"
    );
    app.wait(Duration::from_millis(600)).unwrap();
    // `shows` compares texts as written (no selector).
    assert!(!app.shows("https://example.com"));
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

#[test]
fn a_terminals_markers_are_in_flow_their_numbers_right_aligned() {
    let mut config = EngineConfig {
        viewport: Size::new(px(800.0), px(900.0)),
        ..EngineConfig::new(Root::new::<Harness>(|| HarnessProps {
            session: Some(session(json!({"type": "doc", "content": [
                {"type": "bulletList", "content": [item("one", None)]},
                {"type": "orderedList", "attrs": {"start": 9}, "content": [item("nine", None), item("ten", None)]},
            ]}))),
        }))
    };
    config.environment.os = Os::Linux;
    config.environment.idiom = Idiom::Terminal;
    let mut app = Headless::start(config).expect("the engine starts");
    app.wait_for("text:Ready").unwrap();
    // A space after each marker, and the numbers right-aligned to the
    // widest of their list, so the items' text starts in one column.
    let texts = app.screen().texts();
    for marker in ["• ", " 9. ", "10. "] {
        assert!(texts.contains(&marker), "{marker:?} in {texts:?}");
    }
}

#[test]
fn a_terminals_quote_has_a_bar_and_its_rule_is_a_row_of_lines() {
    let started = |idiom: Idiom| {
        let mut config = EngineConfig {
            viewport: Size::new(px(800.0), px(900.0)),
            ..EngineConfig::new(Root::new::<Harness>(|| HarnessProps {
                session: Some(session(json!({"type": "doc", "content": [
                    {"type": "blockquote", "content": [
                        {"type": "paragraph", "content": [{"type": "text", "text": "Quoted"}]},
                    ]},
                    {"type": "horizontalRule"},
                    {"type": "paragraph", "content": [{"type": "text", "text": "After"}]},
                ]}))),
            }))
        };
        config.environment.os = Os::Linux;
        config.environment.idiom = idiom;
        let mut app = Headless::start(config).expect("the engine starts");
        app.wait_for("text:Ready").unwrap();
        app.screen()
            .texts()
            .into_iter()
            .map(str::to_owned)
            .collect::<Vec<_>>()
    };
    let rule = |t: &String| !t.is_empty() && t.chars().all(|c| c == '─');
    let texts = started(Idiom::Terminal);
    assert!(texts.iter().any(|t| t == "▎"), "no quote bar in {texts:?}");
    assert!(texts.iter().any(rule), "no rule in {texts:?}");
    // Elsewhere the app's border and hairline draw them.
    let texts = started(Idiom::Desktop);
    assert!(!texts.iter().any(|t| t == "▎" || rule(t)), "{texts:?}");
}

#[test]
fn a_terminal_draws_no_caret_of_its_own() {
    let started = |idiom: Idiom| {
        let mut config = EngineConfig {
            viewport: Size::new(px(800.0), px(900.0)),
            ..EngineConfig::new(Root::new::<Harness>(|| HarnessProps {
                session: Some(session(json!({"type": "doc", "content": [
                    {"type": "paragraph", "content": [{"type": "text", "text": "Hi"}]},
                ]}))),
            }))
        };
        config.environment.os = Os::Linux;
        config.environment.idiom = idiom;
        let mut app = Headless::start(config).expect("the engine starts");
        app.wait_for("text:Ready").unwrap();
        app.screen()
            .texts()
            .into_iter()
            .map(str::to_owned)
            .collect::<Vec<_>>()
    };
    // The terminal's cursor is the caret, at the sink: the text is all
    // there is, no cell over a character.
    let texts = started(Idiom::Terminal);
    assert!(texts.iter().any(|t| t == "Hi"), "{texts:?}");
    assert!(!texts.iter().any(|t| t == "H"), "a caret cell in {texts:?}");
}
