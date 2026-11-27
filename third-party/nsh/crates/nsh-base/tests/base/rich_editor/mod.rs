//! `RichEditor`: typing goes through input rules into the document, Enter
//! splits a block and Backspace joins them back (the base keymap), Mod-b
//! toggles bold (the starter's keymap), a press places the caret, Markdown
//! pastes as blocks, a node view renders an atom, undo takes typing
//! back, and lists' items show their markers.

mod code_highlight;
mod commands;
mod composition;
mod content_size;
mod extensions;
mod layout_hits;
mod marks_clipboard_history;
mod node_view_presses;
mod selection;
mod sizing;
mod structure;
mod tables;
mod tiptap;
mod touch;
mod typing;
mod view_features;

use std::{sync::Arc, time::Duration};

use nsh_base::rich_editor::{
    extensions::{markdown::markdown, starter, suggestion::mention_node},
    model::{Node, NodeSpec, Schema},
    state::{EditorState, EditorStateConfig, NodeSelection},
    view::{EditorSession, NodeView, NodeViewCx, NodeViews, rich_editor},
};
use nsh_core::{
    PasteEvent, PayloadValue, Size,
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

/// Renders inline `tag` nodes as their position and whether a node
/// selection holds them; a press selects the node.
struct TagView;

impl NodeView for TagView {
    fn create(&self, cx: &NodeViewCx, _node: &Node) -> AnyElement {
        let (get_pos, selected) = (cx.get_pos(), cx.selected());
        let (press_pos, session) = (cx.get_pos(), cx.session.clone());
        view()
            .test_id("tag")
            .on_press(move || {
                let Some(pos) = press_pos() else { return };
                let state = session.state();
                let mut tr = state.tr();
                tr.set_selection(NodeSelection::create(state.doc(), pos));
                session.dispatch(tr).unwrap();
            })
            .child(text(move || {
                let selected = selected.get();
                format!("Tag {:?} {selected}", get_pos())
            }))
            .into_element()
    }
}

/// The starter schema with a block atom `stock`, an inline atom `tag` and
/// Tiptap's `mention`.
fn schema() -> Schema {
    let mut spec = starter::schema_spec();
    let mut stock = NodeSpec::default();
    stock.group = Some("block".into());
    stock.atom = true;
    let mut symbol = nsh_base::rich_editor::model::AttrSpec::default();
    symbol.default = Some(json!(""));
    stock.attrs = vec![("symbol".into(), symbol)];
    spec.nodes.push(("stock".into(), stock));
    let mut tag = NodeSpec::default();
    tag.group = Some("inline".into());
    tag.inline = true;
    tag.atom = true;
    spec.nodes.push(("tag".into(), tag));
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
    EditorSession::new(
        state,
        NodeViews::new()
            .with("stock", Arc::new(StockCard))
            .with("tag", Arc::new(TagView)),
    )
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
    start_session(move || session(doc.clone()), os, apple_keyboard, idiom)
}

/// [`start_with`] on the session `make` makes.
fn start_session(
    make: impl Fn() -> EditorSession + Send + Sync + 'static,
    os: Os,
    apple_keyboard: bool,
    idiom: Idiom,
) -> Headless {
    let mut config = EngineConfig {
        viewport: Size::new(px(800.0), px(900.0)),
        // Made in the engine, so its keymaps are the platform's the engine
        // says, not the machine's.
        ..EngineConfig::new(nsh_testing::windowed_root_with::<Harness>(move || {
            HarnessProps {
                session: Some(make()),
            }
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

/// The platform moved the sink's own caret to UTF-16 offset `at` of its
/// text, without a key (an input method that types a pair of brackets and
/// puts its caret between them). Sent to every node, as [`compose`] is.
fn sink_caret(app: &mut Headless, at: u32) {
    for id in 1..4096 {
        app.engine().control().dispatch_event(
            id,
            EventKind::SelectionChange,
            EventPayload::Map(vec![
                ("start", PayloadValue::Number(f64::from(at))),
                ("end", PayloadValue::Number(f64::from(at))),
            ]),
        );
    }
    app.wait(Duration::from_millis(50)).unwrap();
}

/// What AppKit reports as an input method types `text` with its caret at
/// UTF-16 offset `at`: the caret first, then the text, in one turn.
fn sink_caret_then_text(app: &mut Headless, at: u32, text: &str) {
    for id in 1..4096 {
        app.engine().control().dispatch_event(
            id,
            EventKind::SelectionChange,
            EventPayload::Map(vec![
                ("start", PayloadValue::Number(f64::from(at))),
                ("end", PayloadValue::Number(f64::from(at))),
            ]),
        );
    }
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
fn the_caret_follows_an_input_method_that_moves_it_between_a_pair() {
    let mut app = start(paragraphs(&["你好"]));
    app.type_text("id:editor", "").unwrap();
    keys(&mut app, &["end"]);
    see(&mut app, "Sel 3-3");
    // The input method types both halves, then puts its caret between them.
    sink_text(&mut app, "（）");
    see(&mut app, &doc("你好（）"));
    see(&mut app, "Sel 5-5");
    sink_caret(&mut app, 1);
    see(&mut app, "Sel 4-4");
    // What it types next goes in there, with the caret after it.
    sink_text(&mut app, "（中）");
    see(&mut app, &doc("你好（中）"));
    see(&mut app, "Sel 5-5");
    sink_caret(&mut app, 2);
    sink_text(&mut app, "（中文）");
    see(&mut app, &doc("你好（中文）"));
    see(&mut app, "Sel 6-6");
    // A Backspace between them deletes before the caret.
    sink_text(&mut app, "（中）");
    see(&mut app, &doc("你好（中）"));
    see(&mut app, "Sel 5-5");
}

#[test]
fn a_caret_reported_before_its_text_is_read_against_that_text() {
    let mut app = start(paragraphs(&[""]));
    app.type_text("id:editor", "").unwrap();
    sink_text(&mut app, "（）");
    sink_caret(&mut app, 1);
    see(&mut app, "Sel 2-2");
    // AppKit: the caret the insertion leaves, then the insertion's text.
    sink_caret_then_text(&mut app, 2, "（中）");
    see(&mut app, &doc("（中）"));
    see(&mut app, "Sel 3-3");
    sink_caret_then_text(&mut app, 3, "（中文）");
    see(&mut app, &doc("（中文）"));
    see(&mut app, "Sel 4-4");
}

#[test]
fn a_caret_reported_a_turn_before_its_text_waits_for_it() {
    let mut app = start(paragraphs(&[""]));
    app.type_text("id:editor", "").unwrap();
    sink_text(&mut app, "（）");
    sink_caret(&mut app, 1);
    see(&mut app, "Sel 2-2");
    // The insertion's caret, then its text in a later turn.
    for id in 1..4096 {
        app.engine().control().dispatch_event(
            id,
            EventKind::SelectionChange,
            EventPayload::Map(vec![
                ("start", PayloadValue::Number(2.0)),
                ("end", PayloadValue::Number(2.0)),
            ]),
        );
    }
    app.wait(Duration::from_millis(10)).unwrap();
    sink_text(&mut app, "（中）");
    see(&mut app, &doc("（中）"));
    see(&mut app, "Sel 3-3");
}

#[test]
fn a_sink_caret_past_what_the_sink_holds_is_left_alone() {
    let mut app = start(paragraphs(&["ab"]));
    app.type_text("id:editor", "").unwrap();
    keys(&mut app, &["end"]);
    // Reported before the text it belongs to.
    sink_caret(&mut app, 1);
    sink_text(&mut app, "c");
    see(&mut app, &doc("abc"));
    see(&mut app, "Sel 4-4");
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

/// The editor is one stop of Tab, its input, which takes the keys: the
/// content box takes the pointer only, so Tab and Shift+Tab never stop on
/// it (it has no role, and its keys would go nowhere).
#[test]
fn tab_stops_once_at_the_editor_and_its_keys_reach_it() {
    let mut app = start(paragraphs(&["ab", "cd"]));
    see(&mut app, "Sel 1-1");
    keys(&mut app, &["tab", "ctrl+end"]);
    see(&mut app, "Sel 7-7");
    // The input is the only stop: Shift+Tab comes around to it.
    keys(&mut app, &["shift+tab", "ctrl+home"]);
    see(&mut app, "Sel 1-1");
}

/// A press in the content box gives the editor the keyboard, though the
/// box is no stop of Tab.
#[test]
fn a_press_gives_the_editor_its_keys() {
    let mut app = start(paragraphs(&["first", "second"]));
    see(&mut app, "Sel 1-1");
    app.press_at("text:second", Point::new(px(1.0), px(1.0)))
        .unwrap();
    see(&mut app, "Sel 8-8");
    keys(&mut app, &["end"]);
    see(&mut app, "Sel 14-14");
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
    // Headless span bounds are the paragraph's bounds. Place the pointer
    // after "go " in its line.
    let paragraph = app
        .screen()
        .layout_nodes()
        .into_iter()
        .find_map(|node| node.text.filter(|text| text.text.text == "go the site now"))
        .unwrap();
    // The editor hit tests with the text engine's layout: the headless
    // engine's characters are each as wide.
    let advance = char_advance(&paragraph.text);
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
        ..EngineConfig::new(nsh_testing::windowed_root_with::<Harness>(|| {
            HarnessProps {
                session: Some(session(linked_doc())),
            }
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
fn an_inline_node_view_follows_its_position_and_selection() {
    let mut app = start(json!({"type": "doc", "content": [
        {"type": "paragraph", "content": [{"type": "text", "text": "ab"}]},
        {"type": "paragraph", "content": [{"type": "text", "text": "x"}, {"type": "tag"}]}
    ]}));
    see(&mut app, "Tag Some(6) false");
    // Typing in the block before moves the tag without drawing it again.
    app.type_text("id:editor", "c").unwrap();
    see(&mut app, &doc("cab|x@"));
    app.press("id:tag").unwrap();
    see(&mut app, "Sel 7-8");
    see(&mut app, "Tag Some(7) true");
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
        ..EngineConfig::new(nsh_testing::windowed_root_with::<Harness>(|| {
            HarnessProps {
                session: Some(session(json!({"type": "doc", "content": [
                    {"type": "bulletList", "content": [item("one", None)]},
                    {"type": "orderedList", "attrs": {"start": 9}, "content": [item("nine", None), item("ten", None)]},
                ]}))),
            }
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
            ..EngineConfig::new(nsh_testing::windowed_root_with::<Harness>(|| {
                HarnessProps {
                    session: Some(session(json!({"type": "doc", "content": [
                        {"type": "blockquote", "content": [
                            {"type": "paragraph", "content": [{"type": "text", "text": "Quoted"}]},
                        ]},
                        {"type": "horizontalRule"},
                        {"type": "paragraph", "content": [{"type": "text", "text": "After"}]},
                    ]}))),
                }
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
            ..EngineConfig::new(nsh_testing::windowed_root_with::<Harness>(|| {
                HarnessProps {
                    session: Some(session(json!({"type": "doc", "content": [
                        {"type": "paragraph", "content": [{"type": "text", "text": "Hi"}]},
                    ]}))),
                }
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

/// How wide each character of `text` is to the headless text engine
/// (`ApproxTextEngine`: all alike).
fn char_advance(text: &nsh_core::AttributedText) -> f32 {
    use nsh_core::TextEngine as _;
    let engine = nsh_core::ApproxTextEngine;
    let width = engine.measure(&engine.prepare(text), None).width;
    width.0 / text.text.chars().count().max(1) as f32
}

/// The middle of character `i` of the paragraph showing `line`, in its
/// text's box.
fn char_point(app: &Headless, line: &str, i: usize) -> Point<Points> {
    let paragraph = app
        .screen()
        .layout_nodes()
        .into_iter()
        .find_map(|node| node.text.filter(|text| text.text.text == line))
        .unwrap();
    let advance = char_advance(&paragraph.text);
    Point::new(
        px(advance * (i as f32 + 0.5)),
        px(paragraph.content.size.height.0 / 2.0),
    )
}

/// An editor whose node and mark parts have typed styles
/// (`StyleRefinement`, as a Rust app types them), each later part over the
/// one before: paragraphs red; headings green but those of level 2 blue
/// (`heading[level=2]` comes after `heading`); italic text red, bold text
/// blue (bold ranks after italic); mentions and `chip`s (an inline node
/// view) red but those with the attribute blue.
#[component]
fn TypedStyles(props: HarnessProps) -> impl IntoElement {
    use nsh_base::rich_editor::view::{PartStyles, RichEditorStyles};
    use nsh_core::element::StyleRefinement;

    let color = |c: u32| StyleRefinement::default().text_color(rgb(c)).into();
    let mut styles = RichEditorStyles::default();
    styles.nodes = Some(PartStyles(
        [
            ("paragraph".to_owned(), color(0xff0000)),
            ("heading".to_owned(), color(0x00ff00)),
            ("heading[level=2]".to_owned(), color(0x0000ff)),
            ("mention".to_owned(), color(0xff0000)),
            ("mention[label=Alice]".to_owned(), color(0x0000ff)),
            ("chip".to_owned(), color(0xff0000)),
            ("chip[kind=x]".to_owned(), color(0x0000ff)),
        ]
        .into(),
    ));
    styles.marks = Some(PartStyles(
        [
            ("italic".to_owned(), color(0xff0000)),
            ("bold".to_owned(), color(0x0000ff)),
        ]
        .into(),
    ));
    view()
        .child(
            view().test_id("editor").w(px(600.0)).h(px(400.0)).child(
                rich_editor()
                    .editor(props.session.clone().expect("a session"))
                    .styles(styles)
                    .size_full(),
            ),
        )
        .child(text("Ready"))
}

/// A session of `doc` in the starter schema with Tiptap's `mention` and an
/// inline atom `chip` with a `kind`, drawn by [`TagView`].
fn typed_session(doc: Value) -> EditorSession {
    use nsh_base::rich_editor::model::AttrSpec;

    let mut spec = starter::schema_spec();
    let mut chip = NodeSpec::default();
    chip.group = Some("inline".into());
    chip.inline = true;
    chip.atom = true;
    let mut kind = AttrSpec::default();
    kind.default = Some(json!(""));
    chip.attrs = vec![("kind".into(), kind)];
    spec.nodes.push(("chip".into(), chip));
    spec.nodes.push(mention_node("mention", "@"));
    let schema = Schema::new(spec).unwrap();
    let plugins = starter::plugins(&schema);
    let doc = schema.node_from_json(&doc).unwrap();
    let state =
        EditorState::create(EditorStateConfig::new(schema).doc(doc).plugins(plugins)).unwrap();
    EditorSession::new(state, NodeViews::new().with("chip", Arc::new(TagView)))
}

#[test]
fn typed_node_and_mark_styles_reach_their_text_the_later_winning() {
    let doc = json!({"type": "doc", "content": [
        {"type": "heading", "attrs": {"level": 1}, "content": [{"type": "text", "text": "Top"}]},
        {"type": "heading", "attrs": {"level": 2}, "content": [{"type": "text", "text": "Sub"}]},
        {"type": "paragraph", "content": [
            {"type": "text", "text": "plain "},
            {"type": "text", "text": "loud", "marks": [{"type": "bold"}]},
            {"type": "text", "text": " both", "marks": [{"type": "bold"}, {"type": "italic"}]},
            {"type": "text", "text": " "},
            {"type": "mention", "attrs": {"id": "a", "label": "Alice"}},
            {"type": "text", "text": " "},
            {"type": "chip", "attrs": {"kind": "x"}},
        ]},
    ]});
    let mut config = EngineConfig {
        viewport: Size::new(px(800.0), px(900.0)),
        ..EngineConfig::new(nsh_testing::windowed_root_with::<TypedStyles>(move || {
            HarnessProps {
                session: Some(typed_session(doc.clone())),
            }
        }))
    };
    config.environment.os = Os::Linux;
    config.environment.idiom = Idiom::Desktop;
    let mut app = Headless::start(config).expect("the engine starts");
    see(&mut app, "Ready");
    let color = |selector: &str| app.screen().span_style(selector).unwrap().color;
    let (red, green, blue) = (
        nsh_core::Color(0xff00_00ff),
        nsh_core::Color(0x00ff_00ff),
        nsh_core::Color(0x0000_ffff),
    );
    assert_eq!(color("id:editor >> text:plain"), red);
    assert_eq!(color("id:editor >> text:loud"), blue);
    assert_eq!(color("id:editor >> text:both"), blue);
    assert_eq!(color("id:editor >> text:Top"), green);
    assert_eq!(color("id:editor >> text:Sub"), blue);
    assert_eq!(color("id:editor >> text:@Alice"), blue);
    assert_eq!(color("id:tag >> text:/^Tag/"), blue);
}
