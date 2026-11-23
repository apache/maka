//! Tables in the view: each table's resize handles follow the table, when
//! a block before it grows and when the box it is in (a quote) moves with
//! no change of the table's own frame in it.

use nsh_base::rich_editor::extensions::{ExtensionManager, kit};
use nsh_testing::Screen;

use super::*;

fn cell(text: &str) -> Value {
    json!({"type": "tableCell", "content": [
        {"type": "paragraph", "content": [{"type": "text", "text": text}]}
    ]})
}

fn table(rows: &[&[&str]]) -> Value {
    let rows: Vec<Value> = rows
        .iter()
        .map(|row| json!({"type": "tableRow", "content": row.iter().map(|t| cell(t)).collect::<Vec<_>>()}))
        .collect();
    json!({"type": "table", "content": rows})
}

/// A paragraph, a table, and a quote holding another table.
fn table_session() -> EditorSession {
    let manager = ExtensionManager::with_core(vec![kit::starter_kit(), kit::table_kit()]).unwrap();
    let schema = manager.schema().clone();
    let doc = schema
        .node_from_json(&json!({"type": "doc", "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": "above"}]},
            table(&[&["a1", "a2"], &["b1", "b2"]]),
            {"type": "blockquote", "content": [table(&[&["q1", "q2"]])]},
        ]}))
        .unwrap();
    let state = EditorState::create(
        EditorStateConfig::new(schema)
            .doc(doc)
            .plugins(manager.plugins()),
    )
    .unwrap();
    EditorSession::new(state, NodeViews::new())
}

/// The editor, and `grow`, which wraps the first paragraph over more lines.
#[component]
fn Tables(props: HarnessProps) -> impl IntoElement {
    let session = props.session.clone().expect("a session");
    let grow = session.clone();
    let grown = signal(false);
    view()
        .child(
            view()
                .test_id("grow")
                .on_press(move || {
                    let state = grow.state();
                    let mut tr = state.tr();
                    tr.insert_text(&"wrapping words ".repeat(40), Some(1), Some(1));
                    grow.dispatch(tr).unwrap();
                    grown.set(true);
                })
                .child(text("Grow")),
        )
        .child(
            view()
                .test_id("editor")
                .w(px(600.0))
                .h(px(600.0))
                .child(rich_editor().editor(session).size_full()),
        )
        .child(text(move || if grown.get() { "Grown" } else { "Ready" }))
}

/// The resize handles' bands, as laid out, top to bottom: a column's is 6
/// points wide down its table, a row's 6 high across it.
fn bands(screen: &Screen) -> Vec<Bounds<Points>> {
    let mut out: Vec<Bounds<Points>> = screen
        .layout_nodes()
        .iter()
        .map(|n| n.bounds)
        .filter(|b| (b.size.width.0 == 6.0) != (b.size.height.0 == 6.0))
        .collect();
    out.sort_by(|a, b| {
        (a.origin.y.0, a.origin.x.0)
            .partial_cmp(&(b.origin.y.0, b.origin.x.0))
            .unwrap()
    });
    out
}

/// The top of the text reading `text`, as laid out.
fn top(screen: &Screen, text: &str) -> f32 {
    screen
        .layout_nodes()
        .iter()
        .find(|n| n.text.as_ref().is_some_and(|t| t.text.text == text))
        .map(|n| n.bounds.origin.y.0)
        .unwrap_or_else(|| panic!("no text reads {text:?}"))
}

#[test]
fn a_tables_handles_follow_it_and_the_quote_it_is_in() {
    let mut config = EngineConfig {
        viewport: Size::new(px(800.0), px(900.0)),
        ..EngineConfig::new(nsh_testing::windowed_root_with::<Tables>(|| HarnessProps {
            session: Some(table_session()),
        }))
    };
    config.environment.os = Os::Linux;
    config.environment.idiom = Idiom::Desktop;
    let mut app = Headless::start(config).expect("the engine starts");
    see(&mut app, "Ready");
    // Two columns and two rows of the first table, two columns and a row
    // of the quoted one.
    app.wait_until("the handles", Duration::from_secs(5), |s| {
        bands(s).len() == 7
    })
    .unwrap();
    let before = bands(app.screen());
    let (table, quoted) = (top(app.screen(), "a1"), top(app.screen(), "q1"));

    app.press("id:grow").unwrap();
    see(&mut app, "Grown");
    app.wait_until("the tables move", Duration::from_secs(5), |s| {
        top(s, "a1") > table
    })
    .unwrap();
    let moved = top(app.screen(), "a1") - table;
    assert_eq!(
        top(app.screen(), "q1") - quoted,
        moved,
        "the quote moves with the first table"
    );
    app.wait_until("the handles move", Duration::from_secs(5), |s| {
        let after = bands(s);
        after.len() == before.len()
            && after.iter().zip(&before).all(|(a, b)| {
                a.size == b.size && a.origin.x == b.origin.x && a.origin.y.0 - b.origin.y.0 == moved
            })
    })
    .unwrap_or_else(|e| {
        panic!(
            "{e}\nbefore {before:?}\nafter {:?}\nmoved {moved}",
            bands(app.screen())
        )
    });
}

/// The column grips' bands, as laid out (24 x 12 on the active table's top
/// border).
fn col_grips(screen: &Screen) -> Vec<Bounds<Points>> {
    let mut out: Vec<Bounds<Points>> = screen
        .layout_nodes()
        .iter()
        .map(|n| n.bounds)
        .filter(|b| b.size.width.0 == 24.0 && b.size.height.0 == 12.0)
        .collect();
    out.sort_by(|a, b| a.origin.x.0.partial_cmp(&b.origin.x.0).unwrap());
    out
}

#[test]
fn a_table_grip_press_selects_with_the_pointer_meta() {
    let session = table_session();
    let noted = super::selection::note_pointer(&session);
    let held = session.clone();
    let mut config = EngineConfig {
        viewport: Size::new(px(800.0), px(900.0)),
        ..EngineConfig::new(nsh_testing::windowed_root_with::<Tables>(move || {
            HarnessProps {
                session: Some(session.clone()),
            }
        }))
    };
    config.environment.os = Os::Linux;
    config.environment.idiom = Idiom::Desktop;
    let mut app = Headless::start(config).expect("the engine starts");
    see(&mut app, "Ready");

    // Pressing a cell activates its table so its column and row grips show.
    app.press_at("text:a1", Point::new(px(1.0), px(1.0)))
        .unwrap();
    app.wait_until("the column grips", Duration::from_secs(5), |s| {
        col_grips(s).len() == 2
    })
    .unwrap();
    assert_eq!(noted.lock().unwrap().last(), Some(&true));

    let grip = col_grips(app.screen())[0];
    let above = app
        .screen()
        .layout_nodes()
        .iter()
        .find(|n| n.text.as_ref().is_some_and(|t| t.text.text == "above"))
        .expect("the paragraph above the table")
        .bounds;
    let at = Point::new(
        grip.origin.x + grip.size.width * 0.5 - above.origin.x,
        grip.origin.y + grip.size.height * 0.5 - above.origin.y,
    );
    let before = noted.lock().unwrap().len();
    // Past the double-click window so the grip press lands as a single click.
    app.wait(Duration::from_millis(600)).unwrap();
    app.press_at("text:above", at).unwrap();
    app.wait_until("the column selection", Duration::from_secs(5), |_| {
        held.state().selection().json_id() == "cell"
    })
    .unwrap();
    let notes = noted.lock().unwrap();
    assert!(notes.len() > before);
    assert_eq!(notes.last(), Some(&true));
}
