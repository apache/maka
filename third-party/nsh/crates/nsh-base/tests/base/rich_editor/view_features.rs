//! The view's ProseMirror and Tiptap features: the gap cursor (arrows reach
//! it, typing and Enter open a textblock there), exitable marks,
//! placeholders by type, task items' checkboxes and the default image.
//!
//! Positions: in `ab` + two `stock` atoms, `ab` is 1..3, the atoms 4..5 and
//! 5..6, the gap between them 5.

use nsh_base::rich_editor::model::{AttrSpec, NodeSpec};

use super::*;

fn focus_start(app: &mut Headless) {
    app.type_text("id:editor", "").unwrap();
    keys(app, &["ctrl+home"]);
    see(app, "Sel 1-1");
}

fn two_atoms() -> Value {
    json!({"type": "doc", "content": [
        {"type": "paragraph", "content": [{"type": "text", "text": "ab"}]},
        {"type": "stock", "attrs": {"symbol": "A"}},
        {"type": "stock", "attrs": {"symbol": "B"}},
    ]})
}

#[test]
fn arrows_reach_the_gap_between_atoms() {
    let mut app = start(two_atoms());
    focus_start(&mut app);
    keys(&mut app, &["end", "right"]);
    see(&mut app, "Sel 4-5");
    keys(&mut app, &["right"]);
    see(&mut app, "Sel 5-5");
    // On past the last atom: into the trailing paragraph (Tiptap's
    // trailing node), 6..8.
    keys(&mut app, &["right", "right"]);
    see(&mut app, "Sel 7-7");
    keys(&mut app, &["left"]);
    see(&mut app, "Sel 5-6");
}

#[test]
fn typing_at_a_gap_cursor_opens_a_paragraph() {
    let mut app = start(two_atoms());
    focus_start(&mut app);
    keys(&mut app, &["end", "right", "right"]);
    see(&mut app, "Sel 5-5");
    app.type_text("id:editor", "z").unwrap();
    see(&mut app, "Types paragraph,stock,paragraph,stock,paragraph");
    see(&mut app, &doc("ab|@|z|@|"));
}

#[test]
fn enter_at_a_gap_cursor_opens_a_paragraph() {
    let mut app = start(two_atoms());
    focus_start(&mut app);
    keys(&mut app, &["end", "right", "right"]);
    see(&mut app, "Sel 5-5");
    keys(&mut app, &["enter"]);
    see(&mut app, "Types paragraph,stock,paragraph,stock,paragraph");
    see(&mut app, "Sel 6-6");
}

/// A schema whose marks are all exitable and with a `todo` task item and
/// a `picture` image leaf.
fn feature_schema() -> Schema {
    let mut spec = starter::schema_spec();
    for (_, mark) in &mut spec.marks {
        mark.exitable = true;
    }
    let mut todo = NodeSpec::default();
    todo.group = Some("block".into());
    todo.content = Some("paragraph".into());
    let mut checked = AttrSpec::default();
    checked.default = Some(json!(false));
    todo.attrs = vec![("checked".into(), checked)];
    todo.extra.insert("render".into(), json!("task"));
    spec.nodes.push(("todo".into(), todo));
    let mut picture = NodeSpec::default();
    picture.group = Some("block".into());
    picture.atom = true;
    let mut src = AttrSpec::default();
    src.default = Some(json!(""));
    let mut size = AttrSpec::default();
    size.default = Some(json!(40));
    picture.attrs = vec![
        ("src".into(), src.clone()),
        ("alt".into(), src),
        ("width".into(), size.clone()),
        ("height".into(), size),
    ];
    picture.extra.insert("render".into(), json!("image"));
    spec.nodes.push(("picture".into(), picture));
    Schema::new(spec).unwrap()
}

#[derive(Clone, PartialEq, Props)]
struct FeaturesProps {
    session: Option<EditorSession>,
    editable: bool,
}

/// An editor with placeholders, showing the document's JSON and its count
/// of text nodes.
#[component]
fn Features(props: FeaturesProps) -> impl IntoElement {
    let session = props.session.clone().expect("a session");
    let read = {
        let session = session.clone();
        move || {
            let doc = session.state().doc().clone();
            let mut texts = 0;
            doc.descendants(&mut |n, _, _, _| {
                texts += usize::from(n.is_text());
                true
            });
            (doc.to_json().to_string(), texts, doc_text(&doc))
        }
    };
    let shown = signal(read());
    // What the session answers about the view, asked on the engine thread
    // after each change.
    let answers = signal(String::new());
    let asked = session.clone();
    let ask = move || {
        let caret = asked.coords_at_pos(asked.state().selection().head());
        let back = caret.and_then(|b| {
            asked.pos_at_coords(b.origin + nsh_core::geometry::point(px(0.0), b.size.height / 2.0))
        });
        format!(
            "Geometry {} {:?} {}",
            caret.is_some(),
            back,
            asked.is_focused()
        )
    };
    view()
        .child(
            view().test_id("editor").w(px(600.0)).h(px(400.0)).child(
                rich_editor()
                    .editor(session)
                    .editable(props.editable)
                    .placeholder("Write here")
                    .placeholders(std::collections::BTreeMap::from([(
                        "heading".to_owned(),
                        "Title".to_owned(),
                    )]))
                    .show_only_current(false)
                    // Room before the blocks for the task checkbox.
                    .classes({
                        let mut classes = nsh_base::rich_editor::view::RichEditorClasses::default();
                        classes.content = Some("pl-8".into());
                        classes.task_checkbox = Some("w-4 h-4".into());
                        classes
                    })
                    .size_full()
                    .on_change(move |_: &_| {
                        shown.set(read());
                        answers.set(ask());
                    }),
            ),
        )
        .child(text(move || format!("Json {}", shown.get().0)))
        .child(text(move || format!("Texts {}", shown.get().1)))
        .child(text(move || format!("Doc {:?}", shown.get().2)))
        .child(text(move || answers.get()))
        .child(text("Ready"))
}

fn start_features(doc: Value, editable: bool) -> Headless {
    let schema = feature_schema();
    let plugins = starter::plugins(&schema);
    let doc = schema.node_from_json(&doc).unwrap();
    let state =
        EditorState::create(EditorStateConfig::new(schema).doc(doc).plugins(plugins)).unwrap();
    let session = EditorSession::new(state, NodeViews::new());
    let mut config = EngineConfig {
        viewport: Size::new(px(800.0), px(900.0)),
        ..EngineConfig::new(Root::new::<Features>(move || FeaturesProps {
            session: Some(session.clone()),
            editable,
        }))
    };
    config.environment.os = Os::Linux;
    config.environment.idiom = Idiom::Desktop;
    let mut app = Headless::start(config).expect("the engine starts");
    app.wait_for("text:Ready").unwrap();
    app
}

#[test]
fn arrow_right_leaves_an_exitable_mark_at_the_block_end() {
    let mut app = start_features(
        json!({"type": "doc", "content": [{"type": "paragraph", "content": [
            {"type": "text", "text": "ab", "marks": [{"type": "bold"}]}
        ]}]}),
        true,
    );
    app.type_text("id:editor", "").unwrap();
    keys(&mut app, &["ctrl+end", "right"]);
    app.type_text("id:editor", "c").unwrap();
    see(&mut app, &doc("abc"));
    // "ab" bold and "c" plain: two texts.
    see(&mut app, "Texts 2");
}

#[test]
fn placeholders_follow_the_block_type() {
    let mut app = start_features(
        json!({"type": "doc", "content": [
            {"type": "heading", "attrs": {"level": 1}},
            {"type": "paragraph"},
        ]}),
        true,
    );
    see(&mut app, "\u{200b}Title");
    see(&mut app, "\u{200b}Write here");
}

#[test]
fn placeholders_hide_while_read_only() {
    let mut app = start_features(
        json!({"type": "doc", "content": [{"type": "paragraph"}]}),
        false,
    );
    app.wait(std::time::Duration::from_millis(100)).unwrap();
    assert!(!app.shows("\u{200b}Write here"));
}

#[test]
fn a_task_checkbox_toggles_checked() {
    let mut app = start_features(
        json!({"type": "doc", "content": [{"type": "todo", "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": "buy"}]}
        ]}]}),
        true,
    );
    app.press("role:checkbox").unwrap();
    see_json(&mut app, "\"checked\":true");
}

fn see_json(app: &mut Headless, fragment: &str) {
    let selector = format!("text:/{}/", regex_escape(fragment));
    app.wait_for(&selector).unwrap();
}

fn regex_escape(s: &str) -> String {
    s.chars()
        .flat_map(|c| {
            let special = "\\.+*?()|[]{}^$/".contains(c);
            special.then_some('\\').into_iter().chain([c])
        })
        .collect()
}

#[test]
fn an_image_node_renders_an_image() {
    let mut app = start_features(
        json!({"type": "doc", "content": [
            {"type": "paragraph"},
            {"type": "picture", "attrs": {"src": "https://example.com/a.png", "alt": "A cat"}},
        ]}),
        true,
    );
    app.wait_for("label:A cat").unwrap();
}

#[test]
fn the_session_answers_where_its_view_shows_it() {
    let mut app = start_features(
        json!({"type": "doc", "content": [{"type": "paragraph", "content": [
            {"type": "text", "text": "ab"}
        ]}]}),
        true,
    );
    app.press("text:ab").unwrap();
    app.type_text("id:editor", "c").unwrap();
    // The caret's box, the position back at its left edge, and the focus.
    app.wait_for("text:/^Geometry true Some\\(\\d\\) true$/")
        .unwrap();
}
