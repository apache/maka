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
fn a_mention_shows_its_text_and_is_one_position() {
    let mut app = start(json!({"type": "doc", "content": [
        {"type": "paragraph", "content": [
            {"type": "text", "text": "hi "},
            {"type": "mention", "attrs": {"id": "a", "label": "Alice"}},
            {"type": "text", "text": "!"},
        ]},
    ]}));
    // Its `render_text`, in the line with the text around it.
    see(&mut app, "hi @Alice!");
    focus_start(&mut app);
    // `hi ` is 1..4, the mention 4..5: the caret steps over it at once.
    keys(&mut app, &["right", "right", "right"]);
    see(&mut app, "Sel 4-4");
    keys(&mut app, &["right"]);
    see(&mut app, "Sel 5-5");
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
                        // A code block with a background and padding of its
                        // own.
                        classes.nodes = Some(std::collections::BTreeMap::from([(
                            "codeBlock".to_owned(),
                            "bg-muted px-4 py-2".to_owned(),
                        )]));
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
    let mut config = EngineConfig {
        viewport: Size::new(px(800.0), px(900.0)),
        ..EngineConfig::new(Root::new::<Features>(move || {
            let schema = feature_schema();
            let plugins = starter::plugins(&schema);
            let doc = schema.node_from_json(&doc).unwrap();
            let state =
                EditorState::create(EditorStateConfig::new(schema).doc(doc).plugins(plugins))
                    .unwrap();
            FeaturesProps {
                session: Some(EditorSession::new(state, NodeViews::new())),
                editable,
            }
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
fn only_the_block_an_input_method_composes_in_hides_its_placeholder() {
    let mut app = start_features(
        json!({"type": "doc", "content": [
            {"type": "heading", "attrs": {"level": 1}},
            {"type": "paragraph"},
        ]}),
        true,
    );
    app.type_text("id:editor", "").unwrap();
    keys(&mut app, &["ctrl+end"]);
    see(&mut app, "\u{200b}Title");
    see(&mut app, "\u{200b}Write here");
    compose(&mut app, true, "ni");
    see(&mut app, "ni");
    app.wait_for_gone("text:\u{200b}Write here", Duration::from_secs(5))
        .unwrap();
    see(&mut app, "\u{200b}Title");
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

#[derive(Clone, PartialEq, Props)]
struct GeometryLifetimeProps {
    session: Option<EditorSession>,
}

#[component]
fn GeometryLifetime(props: GeometryLifetimeProps) -> impl IntoElement {
    let session = props.session.clone().expect("a session");
    let shown = signal(true);
    let answer = signal(String::new());
    let query = session.clone();
    view()
        .child(
            view()
                .test_id("query-geometry")
                .h(px(24.0))
                .on_press(move || {
                    let caret = query.coords_at_pos(1);
                    let back = caret.and_then(|rect| {
                        query.pos_at_coords(
                            rect.origin + Point::new(px(0.0), rect.size.height / 2.0),
                        )
                    });
                    answer.set(format!(
                        "Live geometry {}",
                        caret.is_some()
                            && caret != Some(fallback_rect())
                            && back == Some(1)
                            && query.selection_rect() == caret
                    ));
                }),
        )
        .child(
            view()
                .test_id("toggle-geometry")
                .h(px(24.0))
                .on_press(move || {
                    answer.set(String::new());
                    shown.update(|visible| *visible = !*visible);
                }),
        )
        .child(text(move || format!("Geometry mounted {}", shown.get())))
        .child(text(move || answer.get()))
        .child(dynamic(move || {
            shown.get().then(|| {
                rich_editor()
                    .editor(session.clone())
                    .w(px(600.0))
                    .h(px(400.0))
            })
        }))
}

fn fallback_rect() -> Bounds<Points> {
    Bounds::new(
        Point::new(px(777.0), px(888.0)),
        Size::new(px(1.0), px(2.0)),
    )
}

struct FallbackGeometry;

impl nsh_base::rich_editor::view::ViewGeometry for FallbackGeometry {
    fn coords_at_pos(&self, _: usize) -> Option<Bounds<Points>> {
        Some(fallback_rect())
    }

    fn pos_at_coords(&self, _: Point<Points>) -> Option<usize> {
        Some(99)
    }

    fn selection_rect(&self) -> Option<Bounds<Points>> {
        Some(fallback_rect())
    }
}

#[test]
fn geometry_registration_follows_real_component_disposal_and_remount() {
    let session = session(paragraphs(&["hi"]));
    let fallback = session.attach_geometry(Arc::new(FallbackGeometry));
    let held = session.clone();
    let config = EngineConfig {
        viewport: Size::new(px(800.0), px(900.0)),
        ..EngineConfig::new(Root::new::<GeometryLifetime>(move || {
            GeometryLifetimeProps {
                session: Some(held.clone()),
            }
        }))
    };
    let mut app = Headless::start(config).unwrap();

    for _ in 0..2 {
        see(&mut app, "Geometry mounted true");
        // The component's geometry belongs to the engine, not this test thread.
        assert_eq!(session.coords_at_pos(1), None);
        assert_eq!(session.pos_at_coords(Point::default()), None);
        assert_eq!(session.selection_rect(), None);
        app.press("id:query-geometry").unwrap();
        see(&mut app, "Live geometry true");

        app.press("id:toggle-geometry").unwrap();
        see(&mut app, "Geometry mounted false");
        // Disposing the actual component unregisters its proxy, revealing the
        // previous view; a fresh component must register its own live geometry.
        assert_eq!(session.coords_at_pos(1), Some(fallback_rect()));
        assert_eq!(session.pos_at_coords(Point::default()), Some(99));
        assert_eq!(session.selection_rect(), Some(fallback_rect()));
        app.press("id:toggle-geometry").unwrap();
    }

    see(&mut app, "Geometry mounted true");
    app.press("id:toggle-geometry").unwrap();
    see(&mut app, "Geometry mounted false");
    session.unsubscribe(fallback);
    assert_eq!(session.coords_at_pos(1), None);
    assert_eq!(session.selection_rect(), None);
}

#[derive(Clone, PartialEq, Props)]
struct PaddedProps {
    session: Option<EditorSession>,
}

#[component]
fn Padded(props: PaddedProps) -> impl IntoElement {
    let session = props.session.clone().expect("a session");
    let sel = {
        let session = session.clone();
        move || {
            let state = session.state();
            let s = state.selection();
            format!("Sel {}-{} {}", s.from(), s.to(), session.is_focused())
        }
    };
    let shown = signal(sel());
    let (on_change, on_select, on_focus, on_blur) = (sel.clone(), sel.clone(), sel.clone(), sel);
    view()
        .child(
            view().test_id("editor").child(
                rich_editor()
                    .editor(session)
                    .w(px(300.0))
                    .min_h(px(140.0))
                    .p(px(12.0))
                    .border(px(2.0))
                    .on_change(move |_: &_| shown.set(on_change()))
                    .on_selection_change(move |_: &_| shown.set(on_select()))
                    .on_focus(move |_: &_| shown.set(on_focus()))
                    .on_blur(move |_: &_| shown.set(on_blur())),
            ),
        )
        .child(text(move || shown.get()))
        .child(text("Ready"))
}

#[test]
fn a_padded_root_keeps_the_sink_in_the_viewport_and_fills_its_height() {
    use nsh_core::ViewKind;

    let session = session(paragraphs(&["ab"]));
    let mounted = session.clone();
    let mut config = EngineConfig {
        viewport: Size::new(px(800.0), px(900.0)),
        ..EngineConfig::new(Root::new::<Padded>(move || PaddedProps {
            session: Some(mounted.clone()),
        }))
    };
    config.environment.os = Os::Linux;
    config.environment.idiom = Idiom::Desktop;
    let mut app = Headless::start(config).expect("the engine starts");
    app.wait_for("text:Ready").unwrap();

    let nodes = app.screen().layout_nodes();
    let scroll = nodes
        .iter()
        .find(|n| n.kind == ViewKind::Scroll)
        .expect("the editor's scroll view");
    let sink = nodes
        .iter()
        .find(|n| n.kind == ViewKind::Input)
        .expect("the editor's sink");
    let content = nodes
        .iter()
        .find(|n| n.parent == scroll.id)
        .expect("the editor's content box");

    let inside = |outer: Bounds<Points>, inner: Bounds<Points>| {
        let c = Point::new(
            inner.origin.x + inner.size.width * 0.5,
            inner.origin.y + inner.size.height * 0.5,
        );
        c.x >= outer.origin.x
            && c.x <= outer.origin.x + outer.size.width
            && c.y >= outer.origin.y
            && c.y <= outer.origin.y + outer.size.height
    };

    // Border (2) + padding (12) on `root` insets the scroll viewport and
    // the sink together, so pressing the sink's center (`nsh test` on a
    // native host) hits `content` instead of the root's padding.
    assert_eq!(scroll.bounds.origin, Point::new(px(14.0), px(14.0)));
    assert_eq!(scroll.bounds.size, Size::new(px(272.0), px(112.0)));
    assert_eq!(sink.bounds.origin.x, scroll.bounds.origin.x);
    assert!(sink.bounds.origin.y >= scroll.bounds.origin.y);
    assert_eq!(content.bounds, scroll.bounds);
    assert!(inside(content.bounds, sink.bounds));

    // Typing moves the sink right from the inset viewport's origin while
    // keeping it inside `content`.
    app.type_text("id:editor", "cd").unwrap();
    see(&mut app, "Sel 3-3 true");
    let nodes = app.screen().layout_nodes();
    let moved_sink = nodes
        .iter()
        .find(|n| n.kind == ViewKind::Input)
        .expect("the editor's sink");
    assert!(moved_sink.bounds.origin.x > scroll.bounds.origin.x);
    assert!(inside(content.bounds, moved_sink.bounds));

    // Pressing in the lower blank area of a `minHeight` editor hits
    // `content` and places the caret at the end of the document (`cdab`,
    // 1..5).
    keys(&mut app, &["home"]);
    see(&mut app, "Sel 1-1 true");
    app.press_at("text:cdab", Point::new(px(265.0), px(80.0)))
        .unwrap();
    see(&mut app, "Sel 5-5 true");
}

/// The selection's boxes drawn with text `text`: the views before it in
/// its box (the text is drawn over them).
fn selection_boxes(app: &Headless, text: &str) -> (Bounds<Points>, Vec<Bounds<Points>>) {
    let nodes = app.screen().layout_nodes();
    let i = nodes
        .iter()
        .position(|n| n.text.as_ref().is_some_and(|t| t.text.text == text))
        .unwrap_or_else(|| panic!("no text {text}"));
    let boxes = nodes[..i]
        .iter()
        .filter(|n| n.parent == nodes[i].parent && n.text.is_none())
        .map(|n| n.bounds)
        .collect();
    (nodes[i].bounds, boxes)
}

#[test]
fn selection_boxes_are_drawn_in_task_items_and_code_blocks() {
    let mut app = start_features(
        json!({"type": "doc", "content": [
            {"type": "todo", "content": [
                {"type": "paragraph", "content": [{"type": "text", "text": "buy milk"}]}
            ]},
            {"type": "codeBlock", "content": [{"type": "text", "text": "let x"}]},
        ]}),
        true,
    );
    app.type_text("id:editor", "").unwrap();
    keys(&mut app, &["ctrl+a"]);
    app.wait(Duration::from_millis(100)).unwrap();
    // A code block's own background would hide boxes drawn under the
    // blocks: each textblock draws its own under its text.
    for text in ["buy milk", "let x"] {
        let (text_box, boxes) = selection_boxes(&app, text);
        assert_eq!(boxes.len(), 1, "one selection box under {text}");
        let b = boxes[0];
        // From the text's start (after a task's checkbox, inside a code
        // block's padding), on its line, through its end.
        assert_eq!(b.origin, text_box.origin, "{text}");
        assert_eq!(b.size.height, text_box.size.height, "{text}");
        let glyph_end = text_point(&app, text, text.encode_utf16().count());
        assert!(b.size.width >= glyph_end.x - px(1.0), "{text}");
        assert!(b.size.width < text_box.size.width, "{text}");
    }
}

#[derive(Clone, PartialEq, Props)]
struct InlineImageProps {
    session: Option<EditorSession>,
}

/// An editor, a press that types at the start of the document, and a
/// press that shows how far apart the session puts the caret before and
/// after its inline image, and the position it finds just after the
/// image.
#[component]
fn InlineImage(props: InlineImageProps) -> impl IntoElement {
    let session = props.session.clone().expect("a session");
    let shown = signal(String::new());
    let (asked, typed) = (session.clone(), session.clone());
    view()
        .child(
            view()
                .test_id("editor")
                .w(px(600.0))
                .h(px(200.0))
                .child(rich_editor().editor(session)),
        )
        .child(
            view()
                .on_press(move || {
                    let mut tr = typed.state().tr();
                    tr.insert_text("x", Some(1), Some(1));
                    typed.dispatch(tr).unwrap();
                })
                .child(text("Type")),
        )
        .child(
            view()
                .on_press(move || {
                    let mut image = 0;
                    asked.state().doc().descendants(&mut |n, pos, _, _| {
                        if n.ty().name() == "image" {
                            image = pos;
                        }
                        true
                    });
                    let x = |pos| asked.coords_at_pos(pos).map_or(-1.0, |b| b.origin.x.0);
                    let back = asked.coords_at_pos(image + 1).and_then(|b| {
                        asked.pos_at_coords(b.origin + nsh_core::geometry::point(px(1.0), px(1.0)))
                    });
                    // The image's own box: where the caret before it is,
                    // as wide as the image.
                    let rect = asked
                        .node_rect(image)
                        .map(|b| ((b.origin.x.0 - x(image)).round(), b.size.width.0.round()));
                    shown.set(format!(
                        "Image {image} gap {} {:?} rect {:?}",
                        (x(image + 1) - x(image)).round(),
                        back.map(|p| p - image),
                        rect
                    ));
                })
                .child(text("Measure")),
        )
        .child(text(move || shown.get()))
        .child(text("Ready"))
}

/// An app over `doc`, with the editor and the presses of `InlineImage`.
fn inline_image_app(doc: serde_json::Value) -> Headless {
    let schema = feature_schema();
    let plugins = starter::plugins(&schema);
    let doc = schema.node_from_json(&doc).unwrap();
    let state =
        EditorState::create(EditorStateConfig::new(schema).doc(doc).plugins(plugins)).unwrap();
    let session = EditorSession::new(state, NodeViews::new());
    let mut config = EngineConfig {
        viewport: Size::new(px(800.0), px(900.0)),
        ..EngineConfig::new(Root::new::<InlineImage>(move || InlineImageProps {
            session: Some(session.clone()),
        }))
    };
    config.environment.os = Os::Linux;
    config.environment.idiom = Idiom::Desktop;
    let mut app = Headless::start(config).expect("the engine starts");
    app.wait_for("text:Ready").unwrap();
    app
}

fn image_80() -> serde_json::Value {
    json!({"type": "image", "attrs": {"src": "data:image/png;base64,", "width": 80, "height": 16}})
}

/// The caret on either side of an inline image is as far apart as the
/// image is wide: the image's attachment character stands for its view,
/// not for a character of the font.
#[test]
fn the_caret_steps_over_an_inline_images_width() {
    // `ab` is 1..3, the image 3..4, `cd` 4..6.
    let mut app = inline_image_app(
        json!({"type": "doc", "content": [{"type": "paragraph", "content": [
            {"type": "text", "text": "ab"},
            image_80(),
            {"type": "text", "text": "cd"},
        ]}]}),
    );
    app.press("text:Measure").unwrap();
    // 80 apart, and a point just after the image is after it.
    see(&mut app, "Image 3 gap 80 Some(1) rect Some((0.0, 80.0))");
    // Typing before it in its block moves it within the block.
    app.press("text:Type").unwrap();
    app.press("text:Measure").unwrap();
    see(&mut app, "Image 4 gap 80 Some(1) rect Some((0.0, 80.0))");
}

/// An edit in an earlier block moves an inline image's position; the
/// caret still steps over its width.
#[test]
fn the_caret_steps_over_an_inline_image_moved_by_an_edit_above() {
    let mut app = inline_image_app(json!({"type": "doc", "content": [
        {"type": "paragraph", "content": [{"type": "text", "text": "xy"}]},
        {"type": "paragraph", "content": [
            {"type": "text", "text": "ab"},
            image_80(),
            {"type": "text", "text": "cd"},
        ]},
    ]}));
    app.press("text:Measure").unwrap();
    see(&mut app, "Image 7 gap 80 Some(1) rect Some((0.0, 80.0))");
    app.press("text:Type").unwrap();
    app.press("text:Measure").unwrap();
    see(&mut app, "Image 8 gap 80 Some(1) rect Some((0.0, 80.0))");
}

#[derive(Clone, PartialEq, Props)]
struct SelectedBlockProps {
    session: Option<EditorSession>,
    /// The editor's height.
    height: f32,
    /// Where the `picture` starts.
    at: usize,
}

/// An editor with a bubble menu, a press that selects the block
/// `picture` (a node selection) and scrolls it into view, and a press
/// that shows whether the session's selection box is the picture's box.
#[component]
fn SelectedBlock(props: SelectedBlockProps) -> impl IntoElement {
    let session = props.session.clone().expect("a session");
    let shown = signal(String::new());
    let (select, asked) = (session.clone(), session.clone());
    let at = props.at;
    view()
        .child(
            view()
                .test_id("editor")
                .w(px(600.0))
                .h(px(props.height))
                .child(
                    rich_editor()
                        .editor(session)
                        .size_full()
                        .bubble_menu(view().test_id("bubble").w(px(60.0)).h(px(20.0))),
                ),
        )
        .child(
            view()
                .on_press(move || {
                    let mut tr = select.state().tr();
                    tr.set_selection(NodeSelection::create(tr.doc(), at));
                    tr.scroll_into_view();
                    select.dispatch(tr).unwrap();
                })
                .child(text("Select")),
        )
        .child(
            view()
                .on_press(move || {
                    let node = asked.node_rect(at);
                    shown.set(format!(
                        "Picture {:?} selection is it {}",
                        node.map(|b| (b.size.width.0, b.size.height.0)),
                        node.is_some() && asked.selection_rect() == node
                    ));
                })
                .child(text("Measure")),
        )
        .child(text(move || shown.get()))
        .child(text("Ready"))
}

/// The bounds of the view with test id `id`.
fn bounds_of(app: &Headless, id: &str) -> Bounds<Points> {
    app.screen()
        .layout_nodes()
        .into_iter()
        .find(|n| n.test_id.as_deref() == Some(id))
        .unwrap_or_else(|| panic!("no view {id}"))
        .bounds
}

/// A node selection of a block atom has no text and no caret: what is
/// placed by the selection (the session's `selection_rect`, the bubble
/// menu, the native input taking the keys) goes by the node's box, as
/// Tiptap's bubble menu goes by the node's DOM, not to the content's top
/// left corner.
/// An app of `SelectedBlock` over `paragraphs` one-letter paragraphs, a
/// 600 by 40 `picture` and a paragraph.
fn selected_block_app(paragraphs: usize, height: f32) -> Headless {
    let schema = feature_schema();
    let plugins = starter::plugins(&schema);
    let mut content: Vec<Value> = (0..paragraphs)
        .map(|_| json!({"type": "paragraph", "content": [{"type": "text", "text": "a"}]}))
        .collect();
    content.push(json!({"type": "picture", "attrs": {"width": 200, "height": 40}}));
    content.push(json!({"type": "paragraph", "content": [{"type": "text", "text": "d"}]}));
    let doc = schema
        .node_from_json(&json!({"type": "doc", "content": content}))
        .unwrap();
    let state =
        EditorState::create(EditorStateConfig::new(schema).doc(doc).plugins(plugins)).unwrap();
    let session = EditorSession::new(state, NodeViews::new());
    let mut config = EngineConfig {
        viewport: Size::new(px(800.0), px(900.0)),
        ..EngineConfig::new(Root::new::<SelectedBlock>(move || SelectedBlockProps {
            session: Some(session.clone()),
            height,
            at: paragraphs * 3,
        }))
    };
    config.environment.os = Os::Linux;
    config.environment.idiom = Idiom::Desktop;
    let mut app = Headless::start(config).expect("the engine starts");
    app.wait_for("text:Ready").unwrap();
    app
}

/// The view of the selected `picture`: as wide as the content, as high
/// as the image.
fn picture_bounds(app: &Headless) -> Bounds<Points> {
    app.screen()
        .layout_nodes()
        .into_iter()
        .find(|n| {
            n.text.is_none()
                && n.test_id.is_none()
                && n.bounds.size == Size::new(px(600.0), px(40.0))
        })
        .expect("the picture's view")
        .bounds
}

#[test]
fn a_selected_block_atom_places_the_bubble_menu_and_the_input_at_its_box() {
    // Three paragraphs are 0..9, the picture 9..10.
    let mut app = selected_block_app(3, 400.0);
    app.press("text:Select").unwrap();
    app.wait(Duration::from_millis(100)).unwrap();
    app.press("text:Measure").unwrap();
    // A block's box: as wide as the content, as high as the image.
    see(&mut app, "Picture Some((600.0, 40.0)) selection is it true");

    let editor = bounds_of(&app, "editor");
    let picture = picture_bounds(&app);
    assert!(
        picture.origin.y > editor.origin.y,
        "the picture is below the text"
    );
    // Above the picture by the default offset (8), centred on it.
    let bubble = bounds_of(&app, "bubble");
    assert_eq!(
        bubble.origin.y + bubble.size.height + px(8.0),
        picture.origin.y
    );
    assert_eq!(
        bubble.origin.x + bubble.size.width / 2.0,
        picture.origin.x + picture.size.width / 2.0
    );
    // The native input is on the picture, not at the editor's top, where
    // a browser would scroll the page as it focuses it.
    let input = app
        .screen()
        .layout_nodes()
        .into_iter()
        .find(|n| n.kind == nsh_core::ViewKind::Input)
        .expect("the editor's input")
        .bounds;
    assert!(
        input.origin.y >= picture.origin.y
            && input.origin.y <= picture.origin.y + picture.size.height,
        "the input at {:?}, the picture at {:?}",
        input.origin,
        picture
    );
}

/// Selecting a block atom out of view scrolls it into view whole, as
/// ProseMirror scrolls a node selection's DOM node: it has no caret to
/// scroll to.
#[test]
fn a_selected_block_atom_out_of_view_is_scrolled_into_view() {
    let mut app = selected_block_app(30, 120.0);
    let editor = bounds_of(&app, "editor");
    assert!(picture_bounds(&app).origin.y > editor.origin.y + editor.size.height);
    app.press("text:Select").unwrap();
    app.wait(Duration::from_millis(200)).unwrap();
    let picture = picture_bounds(&app);
    assert!(
        picture.origin.y >= editor.origin.y
            && picture.origin.y + picture.size.height <= editor.origin.y + editor.size.height,
        "the picture at {picture:?}, the editor at {editor:?}"
    );
}

#[test]
fn range_selection_boxes_update_only_overlapped_blocks_and_clear_on_collapse() {
    let mut app = start(paragraphs(&["alpha", "bravo", "charlie"]));
    focus_start(&mut app);
    keys(&mut app, &["shift+down"]);
    app.wait(Duration::from_millis(50)).unwrap();
    assert_eq!(selection_boxes(&app, "alpha").1.len(), 1);
    assert!(selection_boxes(&app, "charlie").1.is_empty());

    keys(&mut app, &["ctrl+a"]);
    app.wait(Duration::from_millis(50)).unwrap();
    for text in ["alpha", "bravo", "charlie"] {
        let (_, boxes) = selection_boxes(&app, text);
        assert_eq!(boxes.len(), 1, "selected box under {text}");
    }

    keys(&mut app, &["left"]);
    app.wait(Duration::from_millis(50)).unwrap();
    for text in ["alpha", "bravo", "charlie"] {
        let (_, boxes) = selection_boxes(&app, text);
        assert!(boxes.is_empty(), "cleared box under {text}");
    }
}
