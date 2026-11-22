//! Presses on node views: one on an inline view's own area selects its
//! node, as one on a block's does; Shift and Mod keep their meaning there.
//!
//! The press points come from the editor's own geometry (where it draws
//! the view's one position, `coords_at_pos`), which its hit testing reads.

use std::sync::Arc;

use nsh_base::rich_editor::{
    model::Node,
    state::{EditorState, EditorStateConfig},
    view::{EditorSession, NodeView, NodeViewCx, NodeViews, rich_editor},
};
use nsh_core::{element::Root, platform::Os, prelude::*};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;
use serde_json::json;

use super::{keys, schema, see};

/// Renders inline `tag` nodes as a 60-point chip saying whether a node
/// selection holds them; nothing in it takes presses.
struct Chip;

impl NodeView for Chip {
    fn create(&self, cx: &NodeViewCx, _node: &Node) -> AnyElement {
        let selected = cx.selected();
        view()
            .w(px(60.0))
            .child(text(move || match selected.get() {
                true => "Chip selected",
                false => "Chip idle",
            }))
            .into_element()
    }
}

#[derive(Clone, PartialEq, Props)]
struct ChipsProps {
    session: Option<EditorSession>,
}

/// An editor and what the test reads: the selection, and where the editor
/// draws position 3 (the chip's), in its content box.
#[component]
fn Chips(props: ChipsProps) -> impl IntoElement {
    let session = props.session.clone().expect("a session");
    let read = {
        let session = session.clone();
        move || {
            let s = session.state().selection().clone();
            let at = session
                .coords_at_pos(3)
                .map(|b| format!("{} {}", b.origin.x.0, (b.origin.y + b.size.height / 2.0).0));
            (format!("{} {}-{}", s.json_id(), s.from(), s.to()), at)
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
        .child(text(move || format!("Sel {}", shown.get().0)))
        .child(text(move || match shown.get().1 {
            Some(at) => format!("At {at}"),
            None => "At none".into(),
        }))
        .child(text("Ready"))
}

/// A paragraph `ab`, a chip (at 3) and `cd`.
fn start() -> Headless {
    let schema = schema();
    let doc = schema
        .node_from_json(
            &json!({"type": "doc", "content": [{"type": "paragraph", "content": [
                {"type": "text", "text": "ab"},
                {"type": "tag"},
                {"type": "text", "text": "cd"}
            ]}]}),
        )
        .unwrap();
    let state = EditorState::create(EditorStateConfig::new(schema).doc(doc)).unwrap();
    let session = EditorSession::new(state, NodeViews::new().with("tag", Arc::new(Chip)));
    let mut config = EngineConfig {
        viewport: Size::new(px(800.0), px(900.0)),
        ..EngineConfig::new(Root::new::<Chips>(move || ChipsProps {
            session: Some(session.clone()),
        }))
    };
    config.environment.os = Os::Linux;
    let mut app = Headless::start(config).expect("the engine starts");
    app.wait_for("text:Ready").unwrap();
    app
}

/// A point inside the chip, in the paragraph's text (which starts at the
/// content box's origin): read once the editor laid it out.
fn on_chip(app: &mut Headless) -> Point<Points> {
    app.type_text("id:editor", "").unwrap();
    keys(app, &["end"]);
    app.wait_for("text:/^At [0-9]/").unwrap();
    let line = app
        .screen()
        .texts()
        .into_iter()
        .find(|t| t.starts_with("At "))
        .expect("the chip's place")
        .to_owned();
    let mut parts = line[3..].split(' ').map(|n| n.parse::<f32>().unwrap());
    let (x, y) = (parts.next().unwrap(), parts.next().unwrap());
    Point::new(px(x + 20.0), px(y))
}

#[test]
fn a_press_on_an_inline_views_own_area_selects_its_node() {
    let mut app = start();
    let at = on_chip(&mut app);
    see(&mut app, "Sel text 6-6");
    app.press_at("text:/^ab/", at).unwrap();
    see(&mut app, "Sel node 3-4");
    see(&mut app, "Chip selected");
}

#[test]
fn shift_and_mod_keep_their_meaning_on_an_inline_view() {
    let mut app = start();
    let at = on_chip(&mut app);
    // Shift extends the text selection from the caret at the end.
    app.hold_keys("shift", true).unwrap();
    app.press_at("text:/^ab/", at).unwrap();
    app.hold_keys("shift", false).unwrap();
    app.wait(std::time::Duration::from_millis(600)).unwrap();
    assert!(
        app.screen()
            .texts()
            .iter()
            .any(|t| t.starts_with("Sel text")),
        "{:?}",
        app.screen().texts()
    );
    see(&mut app, "Chip idle");
    // Mod places the caret, as on text.
    app.hold_keys("ctrl", true).unwrap();
    app.press_at("text:/^ab/", at).unwrap();
    app.hold_keys("ctrl", false).unwrap();
    app.wait(std::time::Duration::from_millis(600)).unwrap();
    assert!(
        app.screen()
            .texts()
            .iter()
            .any(|t| t.starts_with("Sel text")),
        "{:?}",
        app.screen().texts()
    );
    see(&mut app, "Chip idle");
}
