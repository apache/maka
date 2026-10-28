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

#[test]
fn keyboard_conventions_follow_the_host_environment_when_the_editor_focuses() {
    use std::time::Duration;

    use nsh_core::platform::Renderer;

    // Explicit keystrokes avoid Headless's physical-OS interpretation of
    // `mod`; these exercise the actual table registered by the component.
    for (os, renderer, terminal_keyboard, apple_keyboard, command) in [
        (Os::MacOs, Renderer::Native, true, false, "ctrl"),
        (Os::MacOs, Renderer::Terminal, false, false, "ctrl"),
        (Os::MacOs, Renderer::Native, false, false, "cmd"),
        (Os::Linux, Renderer::Native, false, false, "ctrl"),
        (Os::Web, Renderer::Web, false, true, "cmd"),
        (Os::Web, Renderer::Web, false, false, "ctrl"),
    ] {
        let session = session(paragraphs(&["alpha beta"]));
        let mut config = EngineConfig {
            viewport: Size::new(px(800.0), px(900.0)),
            ..EngineConfig::new(Root::new::<Harness>(move || HarnessProps {
                session: Some(session.clone()),
            }))
        };
        config.environment.os = os;
        config.environment.renderer = renderer;
        config.environment.terminal_keyboard = terminal_keyboard;
        config.environment.apple_keyboard = apple_keyboard;
        config.environment.idiom = Idiom::Desktop;
        let mut app = Headless::start(config).expect("the engine starts");
        app.wait_for("text:Ready").unwrap();
        // On macOS with terminal keys the old table tries to register
        // Ctrl+Q here, which on_key_with correctly rejects as reserved.
        app.type_text("id:editor", "").unwrap();
        app.press_key(&format!("{command}+a")).unwrap();
        see(&mut app, "Sel 0-12");
        app.press_key(&format!("{command}+c")).unwrap();
        app.wait_until(
            "editor copied the selection",
            Duration::from_secs(2),
            |screen| screen.clipboard() == Some("alpha beta"),
        )
        .unwrap();
        let mut paste = PasteEvent::default();
        paste.text = "replacement".into();
        app.paste("id:editor", &paste).unwrap();
        see(&mut app, &doc("replacement"));
        app.press_key(if command == "cmd" {
            "alt+backspace"
        } else {
            "ctrl+backspace"
        })
        .unwrap();
        see(&mut app, &doc(""));
    }
}

#[test]
fn public_keymap_factories_follow_the_engine_keyboard_convention() {
    use nsh_base::rich_editor::{
        commands::{base_keymap, mac_base_keymap, pc_base_keymap},
        extensions::core_keymap::{core_keymap, mac_core_keymap, pc_core_keymap},
    };
    use nsh_core::platform::Renderer;

    fn names<T>(bindings: Vec<(String, T)>) -> Vec<String> {
        bindings.into_iter().map(|(name, _)| name).collect()
    }

    let check = |apple: bool| {
        assert_eq!(
            names(base_keymap()),
            names(if apple {
                mac_base_keymap()
            } else {
                pc_base_keymap()
            })
        );
        assert_eq!(
            names(core_keymap()),
            names(if apple {
                mac_core_keymap()
            } else {
                pc_core_keymap()
            })
        );
    };
    assert_eq!(try_os(), None);
    check(cfg!(any(target_os = "macos", target_os = "ios")));

    for (os, renderer, terminal_keyboard, apple_keyboard, expected_apple) in [
        (Os::MacOs, Renderer::Native, true, false, false),
        (Os::MacOs, Renderer::Terminal, false, false, false),
        (Os::MacOs, Renderer::Native, false, false, true),
        (Os::Linux, Renderer::Native, false, false, false),
        (Os::Web, Renderer::Web, false, true, true),
        (Os::Web, Renderer::Web, false, false, false),
    ] {
        let mut config = EngineConfig::new(Root::new::<Harness>(move || {
            assert_eq!(try_os(), Some(os));
            check(expected_apple);
            HarnessProps {
                session: Some(session(paragraphs(&["factory policy"]))),
            }
        }));
        config.viewport = Size::new(px(800.0), px(900.0));
        config.environment.os = os;
        config.environment.renderer = renderer;
        config.environment.terminal_keyboard = terminal_keyboard;
        config.environment.apple_keyboard = apple_keyboard;
        config.environment.idiom = Idiom::Desktop;
        let mut app = Headless::start(config).unwrap();
        app.wait_for("text:Ready").unwrap();
    }
}
